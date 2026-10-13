import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { fondoSugerido } from './cash-opening.engine';
import {
  calcularCorte, puedeAutorizar, puedeCerrar, puedeCancelarse, motivoCancelacionValido,
  buildFolioCorte, TEXTO_NO_AUTORIZA, TEXTO_NO_CIERRA,
  proyectarCiego, puedeRecontar, TEXTO_NO_RECUENTA, avisoLibroVacio,
  type ConteoDenominacion, type MovimientoDelCorte,
} from './cash-cut.engine';

/**
 * ⛔ `[CG.42]` El fondo inicial tal como está en la base, **sin aplastar el `null`**.
 *
 * `[CG.39]` volvió `fondo_inicial` nullable justo para separar dos hechos distintos —`NULL` = no se
 * midió con qué arrancó la caja; `0` = se contó y estaba vacía— y arregló el camino de ESCRITURA.
 * El de LECTURA seguía haciendo `Number(c.fondo_inicial)`, y **`Number(null)` es `0`**: la
 * distinción recién creada se perdía en las seis líneas que la leen, así que el `esperado` volvía a
 * calcularse como si la caja hubiera arrancado vacía y el arqueo seguía inventando un sobrante del
 * tamaño exacto del fondo de cambio.
 *
 * *Un arreglo que vive sólo del lado de la escritura no es un arreglo: es un dato que nadie usa.*
 */
/**
 * ⭐⭐ `[CG.98]` **LA CAJA GENERAL ES UNA SOLA, NO UNA POR PLAZA.**
 *
 * Edgar, al ver que el cuadre no cerraba: *"resuélvelo entonces"*.
 *
 * El arqueo filtraba por `sucursal`, y eso suponía un cajón por plaza. Medido en prod el
 * 2026-10-12, es falso:
 *
 *   · las **10 nóminas de hoy son de CUATRO sucursales** (05, 06, 07, 08) y las cuatro usan la
 *     caja `0011`;
 *   · suman **$32,237.00** contra **$32,220.00** dispensados por el cajero de OFICINAS — $17 de
 *     morralla. Una sola bóveda pagó nóminas de cuatro plazas;
 *   · y en TODO el libro (27 movimientos, 6 sucursales) **no hay más caja que `0011`**.
 *
 * O sea: `cash_ledger.sucursal` es la plaza del DOCUMENTO contable, no dónde estaba el efectivo.
 * Filtrar por ella partía un cajón físico en seis pedazos y ninguno cuadraba: el efectivo salía
 * de un pedazo y el gasto se anotaba en otro.
 *
 * El cajero vive en OFICINAS (`00`), así que el corte de esa sucursal es el de LA caja y ve todos
 * los movimientos. Cualquier otra plaza sigue acotada a lo suyo — el día que una tenga su propio
 * cajón, esto no la va a mezclar con el de oficinas.
 *
 * ⚠️ Si algún día aparece una segunda caja en el libro (otra `clave_banco`), esto deja de alcanzar
 * y hay que acotar por caja de verdad. Hoy no existe: medido, 27 de 27 movimientos son `0011` o
 * captura manual desde esta misma pantalla.
 */
const SUCURSAL_DEL_CAJERO = '00';
function aplicarAlcanceCaja(qb: any, sucursal: string): any {
  return sucursal === SUCURSAL_DEL_CAJERO ? qb.whereRaw('true') : qb.where('sucursal', sucursal);
}

function fondo(c: { fondo_inicial?: number | string | null } | null | undefined): number | null {
  const v = c?.fondo_inicial;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * CG.15 — Corte de caja con doble llave, saldo y cancelación (ADR-070).
 *
 * Los SELECT y los UPDATE. La cuenta y el veredicto viven en `cash-cut.engine.ts` (puro, con
 * 26 pruebas). Acá sólo se traen filas, se llama al motor y se escribe.
 *
 * ⛔ La doble llave está en la DB (`cut_doble_llave_chk`). Lo de acá NO es la defensa: es para
 * devolver un 403 con su explicación en vez de dejar que el usuario choque con un 23514 de
 * Postgres. Si alguien borra este chequeo, el candado sigue puesto.
 */

export interface AbrirCorteInput {
  fecha: string;
  sucursal: string;
  /**
   * `[CG.39]` Con cuánto arranca. **`undefined` = no se midió** y se guarda `NULL`; `0` es un
   * hecho distinto —se contó y estaba vacía—. Antes los dos terminaban en el mismo cero.
   */
  fondo_inicial?: number | null;
  fondo_origen?: 'cierre_anterior' | 'contado' | 'sin_medir';
  /** El desglose del arranque, por llave. Sin esto se sabe cuánto hay, no si hay con qué dar cambio. */
  apertura?: Array<{ denom_key: string; denominacion: number; piezas: number }>;
  nota?: string;
}
export interface CerrarCorteInput { conteo?: ConteoDenominacion[]; morralla?: number; nota?: string }

interface Usuario { id?: string; username?: string }

/**
 * `[CG.26]` Los tipos de movimiento del cajero (CAOS / AST700), **medidos**, no supuestos.
 *
 * Al 2026-09-29 el feed trae SEIS y la conciliación miraba DOS:
 *
 *   | id | etiqueta              | movs |        monto | ¿se contaba? |
 *   |----|-----------------------|------|--------------|--------------|
 *   |  0 | Deposito              |  675 | $16,495,700  | sí           |
 *   |  4 | Dispensar             |  324 | $16,461,720  | sí           |
 *   |  8 | Dotar                 |   11 |  $1,500,120  | ⛔ NO         |
 *   |  5 | Vaciar Stocks         |    6 |  $2,350,370  | ⛔ NO         |
 *   |  7 | Cambio                |    4 |         $0   | ⛔ NO         |
 *   | 13 | Contenido Modificado  |    1 |        $20   | ⛔ NO         |
 *
 * ⛔ `Dotar` y `Vaciar Stocks` mueven efectivo REAL de la bóveda (la cargan desde afuera / la
 * vacían hacia afuera). Ignorarlos son **$3,850,510** que el cuadre no podía explicar. El último
 * fue el **2026-09-08**, así que no es historia vieja.
 *
 * ⚠️ Van en piernas SEPARADAS de depósito/dispensación a propósito: no son caja chica. Sumarlas
 * ahí haría que «caja chica conciliada» diera un número inventado.
 */
const CAOS = { DEPOSITO: 0, DISPENSAR: 4, VACIAR: 5, CAMBIO: 7, DOTAR: 8, CONTENIDO: 13 } as const;
const TIPOS_CONOCIDOS = Object.values(CAOS);

@Injectable()
export class CashCutService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private requireUser(u: Usuario): { id: string; username?: string } {
    if (!u?.id) throw new BadRequestException('No se pudo identificar al usuario.');
    return { id: u.id, username: u.username };
  }

  /** Consecutivo atómico del corte, dentro de la trx. Mismo patrón que el folio del libro. */
  private async nextFolio(trx: any, tenantId: string, year: number): Promise<string> {
    const r = await trx.raw(
      `INSERT INTO finance.cash_ledger_sequences (tenant_id, year, tipo, current_value)
       VALUES (?, ?, 'corte', 1)
       ON CONFLICT (tenant_id, year, tipo) DO UPDATE
         SET current_value = finance.cash_ledger_sequences.current_value + 1, updated_at = now()
       RETURNING current_value`, [tenantId, year]);
    return buildFolioCorte(year, r.rows[0].current_value);
  }

  /**
   * Movimientos que entran a un corte: los de la sucursal que todavía no tienen corte.
   *
   * CG.19 Capa 1 — trae `origen_tipo` para que el motor sepa qué parte del `esperado` viene de un
   * hecho de Kepler y qué parte la tecleó una persona. **No cambia la aritmética**: cambia lo que
   * el corte puede DECIR de sí mismo (`cobertura_ingreso`).
   */
  private async movimientosSueltos(
    trx: Knex.Transaction, tenantId: string, sucursal: string, dia: string | null,
  ): Promise<MovimientoDelCorte[]> {
    const rows = await trx('finance.cash_ledger')
      .where({ tenant_id: tenantId })
      .where((b: any) => aplicarAlcanceCaja(b, sucursal))
      /**
       * ⛔⛔ `[CG.115]` **ACÁ NO HABÍA NINGÚN FILTRO DE FECHA, y por eso el saldo salía en
       * −$206,008.34.** Medido en prod el 2026-10-13 sobre el corte `CC-2026-00001`, que es del
       * **12-oct**:
       *
       *     sueltos que barría  ->  32 movimientos, del 25-sep al 10-dic, neto −$156,275.84
       *     sueltos de SU día   ->  23 movimientos, del 12-oct,           neto  +$53,134.95
       *
       * O sea que un corte de un día se tragaba **$130,000 del 25-sep**, los **$86,575.79 que se
       * capturaron HOY 13-oct** (un día que todavía no cierra) y hasta un movimiento fechado
       * **10-dic-2026**. El esperado dejaba de ser "cuánto debería haber en el cajón al cerrar
       * hoy" y pasaba a ser "la suma de todo lo que alguna vez quedó sin cortar": un número que
       * no se puede ir a contar, porque ese efectivo ni existe ni existió junto.
       *
       * ⚠️ Y el signo engañaba doble: el barrido lo volvía **negativo**, y un negativo grande se
       * lee como "la caja debe dinero" cuando lo que pasaba es que estaba sumando jornadas ajenas.
       *
       * ⭐ Los sueltos de otros días **NO se descartan en silencio** — eso sería el defecto
       * simétrico. Se cuentan aparte en `sueltosFuera()` y la pantalla los declara: siguen vivos,
       * esperando el corte de SU jornada.
       */
      .modify((q: Knex.QueryBuilder) => { if (dia) q.where('fecha', dia); })
      .whereNull('corte_id').whereNull('deleted_at')
      .select('tipo', 'monto', 'estado', 'origen_tipo')
      /**
       * `[CG.95]` Cuánto de cada movimiento nunca pasó por el cajón. DOS vías, y hacen falta las
       * dos — medido: con sólo la segunda se perdían $21,790 de un ingreso cuyo origen entero es
       * el cajero, y con sólo la primera se perdían los billetes de los cobros de ruta.
       *
       *   (a) el movimiento ENTERO es un movimiento del cajero (`origen_tipo='caos'`);
       *   (b) parte de él se enlazó a un depósito/retiro del cajero (`caos_cash_links`).
       *
       * ⚠️ `monto_enlazado` es lo que contó la MÁQUINA (sólo billetes). La morralla queda afuera
       * y por eso llega al cajón — que es exactamente la distinción que esto viene a hacer.
       */
      .select(trx.raw(`CASE WHEN origen_tipo = 'caos' THEN monto ELSE coalesce((
           SELECT sum(k.monto_enlazado) FROM finance.caos_cash_links k
            WHERE k.cash_ledger_id = finance.cash_ledger.id AND k.deleted_at IS NULL), 0)
         END AS en_boveda`));
    return rows.map((r: any) => ({
      ...r, anclado: r.origen_tipo === 'cobro', en_boveda: Number(r.en_boveda ?? 0),
    }));
  }

  /**
   * `[CG.115]` **La jornada de un corte, como string `YYYY-MM-DD`.**
   *
   * ⚠️ `String(unDate).slice(0,10)` da `"Mon Oct 12"` y `unDate.toISOString()` es lo único que
   * devuelve el día que se guardó: una columna `date` de pg llega como `Date` a la medianoche
   * **UTC**, y renderizarla en hora de México la corre un día para atrás. Es el mismo defecto que
   * `[LC.16]`, y acá decidiría **qué movimientos entran a un corte de dinero**.
   */
  private diaDe(fecha: string | Date | null | undefined): string | null {
    if (fecha == null) return null;
    return fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha).slice(0, 10);
  }

  /**
   * ⭐ `[CG.115]` **Lo que queda suelto FUERA de esta jornada — contado, no escondido.**
   *
   * Acotar el barrido sin esto sería cambiar un defecto por otro: los $130,000 del 25-sep
   * desaparecerían de la pantalla en vez de desaparecer del esperado, y nadie volvería a verlos.
   *
   * Se parte en **anteriores** y **posteriores** porque no son el mismo hecho: lo anterior es una
   * jornada que nunca se cerró (hay que cerrarla), lo posterior es captura de un día que todavía
   * no toca — o una fecha mal tecleada, como el movimiento de prod fechado **10-dic-2026**.
   */
  private async sueltosFuera(trx: Knex.Transaction, tenantId: string, sucursal: string, dia: string | null) {
    if (!dia) return null;
    const neto = `sum(CASE WHEN estado = 'cancelado' THEN 0
                           WHEN tipo = 'ingreso' THEN monto ELSE -monto END)`;
    const [r] = await trx('finance.cash_ledger')
      .where({ tenant_id: tenantId })
      .where((b: Knex.QueryBuilder) => aplicarAlcanceCaja(b, sucursal))
      .whereNull('corte_id').whereNull('deleted_at')
      .whereRaw('fecha <> ?::date', [dia])
      .select(
        trx.raw(`count(*) FILTER (WHERE fecha < ?::date)::int AS n_antes`, [dia]),
        trx.raw(`coalesce(${neto} FILTER (WHERE fecha < ?::date), 0)::numeric AS neto_antes`, [dia]),
        trx.raw(`count(*) FILTER (WHERE fecha > ?::date)::int AS n_despues`, [dia]),
        trx.raw(`coalesce(${neto} FILTER (WHERE fecha > ?::date), 0)::numeric AS neto_despues`, [dia]),
        trx.raw(`to_char(min(fecha),'YYYY-MM-DD') AS desde`),
        trx.raw(`to_char(max(fecha),'YYYY-MM-DD') AS hasta`),
      );
    const anteriores = { movimientos: Number(r?.n_antes ?? 0), neto: Number(r?.neto_antes ?? 0) };
    const posteriores = { movimientos: Number(r?.n_despues ?? 0), neto: Number(r?.neto_despues ?? 0) };
    if (!anteriores.movimientos && !posteriores.movimientos) return null;
    return { dia, anteriores, posteriores, desde: r?.desde ?? null, hasta: r?.hasta ?? null };
  }

  /**
   * `[CG.39]` Con qué se propone que arranque la caja de esa sucursal: **el conteo con el que
   * quedó su último corte cerrado**, con folio y fecha para que se vea de dónde salió.
   *
   * Sin corte anterior devuelve `monto: null` y `origen: 'sin_medir'` — nunca un cero. Un cero
   * afirma *"la caja arrancó vacía"*, que con fondo para dar cambio es imposible.
   */
  /**
   * `[CG.99]` El `contado` del último corte SELLADO de esa caja, o `null` si no hay ninguno.
   *
   * Es la mitad de `sugerirFondo()` que el panel del día necesita: sólo el número, sin el
   * desglose por denominación. Se separa para no repetir la consulta ni obligar a `arqueoDia` a
   * abrir otra transacción — vive en la misma `trx` que ya tiene.
   *
   * ⚠️ Sólo `cerrado` o `autorizado`. Heredar de un borrador sería propagar un conteo que nadie
   * selló.
   */
  private async sugerirFondoInterno(trx: any, tenantId: string, sucursal: string): Promise<number | null> {
    const previo = await trx('finance.cash_ledger_cuts')
      .where({ tenant_id: tenantId, sucursal })
      .whereIn('estado', ['cerrado', 'autorizado'])
      .whereNotNull('contado')
      .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'closed_at', order: 'desc' }])
      .first('contado');
    return previo ? Number(previo.contado) : null;
  }

  /**
   * ⭐ `[CG.125]` **El efectivo del último arqueo de custodia de Control** — el dato que la empresa
   * ya lleva y que la pantalla estaba pidiendo que alguien volviera a teclear.
   *
   * ⚠️ Las columnas de `caja_general_ods` son **`text`**: `sum(totalefectivo)` revienta con `""` y
   * `btrim(numeric)` no existe. Todo pasa por `nullif(btrim(x::text),'')::numeric`.
   *
   * ⚠️ `null` si no se puede leer (el espejo de Control puede no estar en este entorno). Un cero
   * acá sería «la caja arrancó vacía», que es un hecho distinto y falso.
   */
  private async fondoDeControl(trx: Knex.Transaction, tenantId: string) {
    const existe = await trx.raw(`SELECT to_regclass('caja_general_ods.arqueo_movimientos') AS t`);
    if (!existe.rows?.[0]?.t) return null;
    const num = (c: string) => `coalesce(nullif(btrim(${c}::text),'')::numeric, 0)`;
    const [r] = await trx('caja_general_ods.arqueo_movimientos')
      .whereRaw('NOT cancelado')
      .whereRaw(`${num('dolares')} <> 0`)
      .orderBy([{ column: 'movimientofecha', order: 'desc' }, { column: 'movimientohora', order: 'desc' }])
      .limit(1)
      .select(
        'folio',
        trx.raw(`to_char(movimientofecha,'YYYY-MM-DD') AS fecha`),
        trx.raw(`${num('totalefectivo')} AS efectivo`),
        trx.raw(`${num('totalbilletes')} AS billetes`),
        trx.raw(`${num('totalmonedas')} AS monedas`),
      );
    if (!r) return null;
    void tenantId; // el espejo de Control no está particionado por tenant: es una sola caja.
    return {
      folio: String(r.folio), fecha: String(r.fecha),
      efectivo: Number(r.efectivo), billetes: Number(r.billetes), monedas: Number(r.monedas),
    };
  }

  async sugerirFondo(sucursal: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const previo = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal })
        // Cerrado o autorizado: los dos tienen conteo. ⚠️ NO se filtra 'cancelado' — el CHECK de
        // la tabla sólo admite borrador|cerrado|autorizado, así que ese filtro sería ruido que
        // sugiere un estado que no existe.
        .whereNot('estado', 'borrador')
        .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'folio', order: 'desc' }])
        .first();
      /**
       * ⭐⭐ `[CG.125]` **ANTES DE PEDIRLO, PREGUNTARLE A CONTROL.**
       *
       * Edgar, con la pantalla delante: *"pide se declare con cuánto arrancó la caja, pero no es
       * necesario porque nosotros ya llevamos ese seguimiento"*. Tiene razón, y pedirlo a mano
       * rompe la regla principal del proyecto: **lo que ya existe en una fuente no se captura**.
       *
       * El fondo del cajón es el **efectivo del último arqueo de custodia** de Control, que la
       * empresa lleva desde 2013. Acá sólo se devolvía `sin_medir` porque no hay cortes cerrados
       * en la Suite todavía — se miraba la fuente nueva y no la que de verdad tiene el dato.
       *
       * ⚠️ Y el arqueo se discrimina por **`dolares <> 0`**, no por "trae varias piernas": los
       * cobros con tarjeta también traen dos (`A23634`: efectivo $866 + tarjeta $16,420) y no son
       * arqueos. Medido: con el criterio correcto quedan **901 arqueos en 616 días**; el último es
       * `A23641` del 2026-10-10 12:58 con **$3,327.50** de efectivo. Ver `VERDAD_ABSOLUTA.md` §28.2.
       */
      if (!previo) return fondoSugerido(null, await this.fondoDeControl(trx, tenantId));

      const filas = await trx('finance.cash_ledger_cut_denominations')
        .where({ tenant_id: tenantId, cut_id: previo.id })
        // El desglose del CIERRE es lo que se hereda: la apertura del corte anterior ya pasó.
        .where((q: any) => q.where('momento', 'cierre').orWhereNull('momento'))
        .select('denom_key', 'piezas');

      const dens: Record<string, number> = {};
      for (const f of filas) if (f.denom_key) dens[String(f.denom_key)] = Number(f.piezas);

      return fondoSugerido({
        folio: previo.folio,
        fecha: String(previo.fecha).slice(0, 10),
        contado: previo.contado === null || previo.contado === undefined ? null : Number(previo.contado),
        denominaciones: dens,
      });
    });
  }

  async abrir(input: AbrirCorteInput, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const abierto = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal: input.sucursal, estado: 'borrador' }).first();
      if (abierto) {
        throw new BadRequestException(
          `La sucursal ${input.sucursal} ya tiene el corte ${abierto.folio} abierto. Cerralo antes de abrir otro.`);
      }

      /**
       * ⛔ `[CG.39]` ACÁ ESTABA `fondo_inicial: input.fondo_inicial ?? 0`.
       *
       * Ese `?? 0` no era un default inocuo: **afirmaba que la caja arrancó vacía**. Con el fondo
       * para dar cambio —que existe, y es la razón por la que la persona puede devolver $170 de
       * un billete de $500— cada peso de ese fondo se iba del `esperado` y reaparecía como
       * sobrante en el arqueo. Un faltante y un sobrante del mismo tamaño, todos los días.
       *
       * Ahora `null` viaja como `null` y la columna lo acepta: NO SE MIDIÓ es un hecho distinto
       * de "se contó y estaba vacía", y el CHECK de la tabla no deja guardar un monto sin decir
       * de dónde salió.
       */
      let monto = input.fondo_inicial === undefined ? null : input.fondo_inicial;
      let origen = monto === null ? 'sin_medir' : (input.fondo_origen ?? 'contado');

      /**
       * ⭐ `[CG.90]` **EL FONDO DE HOY ES LO QUE SE CONTÓ AYER. No hace falta preguntarlo.**
       *
       * Edgar, 2026-10-12, con el diálogo a la vista: *"aquí ya tenemos fondo inicial, ya no es
       * necesario que lo pidamos"*. Tiene razón, y el diseño ya lo sabía: el CHECK de esta misma
       * tabla acepta `fondo_origen = 'cierre_anterior'` desde que se creó — **nadie lo cableó**.
       * El valor estaba previsto y el camino para llenarlo no existía.
       *
       * El efectivo no se evapora de un día para el otro: lo que quedó contado al sellar la
       * jornada anterior ES con lo que arranca la siguiente. Pedirlo de nuevo es pedirle a una
       * persona que teclee un número que el sistema ya tiene — y cada vez que se teclea se puede
       * teclear mal, justo en el campo del que cuelga todo el arqueo.
       *
       * ⚠️ Sólo hereda de un corte **CERRADO o AUTORIZADO** y con `contado` real. Un borrador no
       * sirve: su conteo todavía no pasó por el sello, y heredar de algo sin sellar es propagar
       * una cifra que nadie confirmó.
       *
       * ⚠️ Y sigue sin inventar: si no hay corte anterior —hoy en prod hay **CERO**, medido— el
       * fondo queda `null` con `fondo_origen='sin_medir'`, que es un hecho distinto de "arrancó en
       * cero". Ese `?? 0` ya costó una vez un faltante y un sobrante del mismo tamaño todos los
       * días (ver `[CG.39]` arriba). Acá no se repone.
       *
       * ⚠️ Lo explícito gana: si quien abre TECLEA un fondo, se respeta el suyo y se marca
       * `'contado'`. La herencia sólo llena el hueco.
       */
      if (monto === null) {
        const prev = await trx('finance.cash_ledger_cuts')
          .where({ tenant_id: tenantId, sucursal: input.sucursal })
          .whereIn('estado', ['cerrado', 'autorizado'])
          .whereNotNull('contado')
          .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'closed_at', order: 'desc' }])
          .first('folio', 'contado', 'fecha');
        if (prev && Number(prev.contado) >= 0) {
          monto = Number(prev.contado);
          origen = 'cierre_anterior';
        }
      }

      const folio = await this.nextFolio(trx, tenantId, Number(String(input.fecha).slice(0, 4)));
      const [c] = await trx('finance.cash_ledger_cuts').insert({
        tenant_id: tenantId, folio, fecha: input.fecha, sucursal: input.sucursal,
        fondo_inicial: monto, fondo_origen: origen, nota: input.nota ?? null,
        created_by: u.id, created_by_username: u.username ?? null,
      }).returning('*');

      // El desglose de la APERTURA: lo que permite saber si hay con qué dar cambio, no sólo
      // cuánto hay. Va en la misma tabla que el cierre, separado por `momento`.
      const ap = (input.apertura ?? []).filter((d) => Number(d.piezas) > 0);
      if (ap.length) {
        await trx('finance.cash_ledger_cut_denominations').insert(ap.map((d) => ({
          tenant_id: tenantId, cut_id: c.id, momento: 'apertura',
          denom_key: d.denom_key, denominacion: d.denominacion, piezas: d.piezas,
        })));
      }
      return c;
    });
  }

  /** Guarda el conteo (denominaciones + morralla + total) sobre el corte, dentro de la trx. */
  private async sellarConteo(trx: any, tenantId: string, id: string, t: { contado: number }, input: CerrarCorteInput) {
    await trx('finance.cash_ledger_cuts').where({ id }).update({
      contado: t.contado, morralla: input.morralla ?? 0, updated_at: trx.fn.now(),
    });
    await trx('finance.cash_ledger_cut_denominations').where({ tenant_id: tenantId, cut_id: id }).del();
    const piezas = (input.conteo ?? []).filter((d) => Number(d.piezas) > 0);
    if (piezas.length) {
      await trx('finance.cash_ledger_cut_denominations').insert(
        piezas.map((d) => ({ tenant_id: tenantId, cut_id: id, denominacion: d.denominacion, piezas: d.piezas })));
    }
  }

  /**
   * ⭐ CG.19 Capa 1b — **SELLAR Y REVELAR.** Era `previa()` y hacía lo contrario.
   *
   * El docstring viejo decía: *"el capturista ve la diferencia mientras cuenta"*. Ese era el
   * requisito y **se revierte a propósito**: ver la diferencia converger a cero mientras se teclea
   * convierte el arqueo en una transcripción del esperado. Se contaba hasta que diera.
   *
   * ⛔ **Y por eso esto GUARDA antes de revelar.** Un conteo que se revela sin sellarse no es
   * ciego: bastaba con mirar el resultado, corregir el conteo y volver a preguntar. El conteo se
   * escribe primero, y recién entonces se dice qué dio. Cambiarlo después exige `recontar()`, que
   * deja rastro.
   *
   * ⚠️ El endpoint tenía **cero llamadores** (verificado en `apps/view` y `libs/finance`): se
   * reusa en vez de inventar otro, y se le cambia el nombre porque `previa` ya no describe lo que
   * hace — un endpoint que miente es peor que uno que no existe.
   */
  async contar(id: string, input: CerrarCorteInput, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');
      if (c.estado !== 'borrador') throw new BadRequestException(TEXTO_NO_CIERRA['no_es_borrador']);
      // Sellar dos veces sin motivo sería recontar por la puerta de atrás.
      if (Number(c.contado ?? 0) > 0 || c.conteo_previo != null) {
        throw new BadRequestException(
          'Este corte ya tiene un conteo sellado. Para cambiarlo hay que recontar, y el reconteo pide motivo.',
        );
      }

      const movs = await this.movimientosSueltos(trx, tenantId, c.sucursal, this.diaDe(c.fecha));
      // [CG.96] Las dos piernas del cajero desde que abrio ESTE corte. Mismo origen que usa
      // `saldo()`; sin esto el esperado ignora la boveda y pide contar lo que esta en la maquina.
      const cajero = await this.conciliacionCajero(trx, tenantId, c.sucursal, c.fecha ?? null);
      const totales = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo: input.conteo, morralla: input.morralla ?? 0,
      });
      if (totales.veredicto === 'sin_contar') throw new BadRequestException(TEXTO_NO_CIERRA['sin_conteo']);

      await this.sellarConteo(trx, tenantId, id, totales, input);
      // Recién acá se revela: el conteo ya está escrito y no se puede retocar en silencio.
      return { corte_id: id, sellado_por: u.username ?? u.id, totales, puede_recontar: totales.veredicto !== 'cuadra' };
    });
  }

  /**
   * ⛔ **UNA sola vez, con motivo, y el primer conteo NO se borra.**
   *
   * Un reconteo ilimitado es un ajuste con otro nombre: se cuenta hasta que dé. El primero pasa a
   * `conteo_previo` con su razón escrita, y los dos quedan a la vista — que es todo el punto.
   */
  async recontar(id: string, input: CerrarCorteInput & { motivo?: string }, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');

      const movs = await this.movimientosSueltos(trx, tenantId, c.sucursal, this.diaDe(c.fecha));
      // [CG.96] Las dos piernas del cajero desde que abrio ESTE corte. Mismo origen que usa
      // `saldo()`; sin esto el esperado ignora la boveda y pide contar lo que esta en la maquina.
      const cajero = await this.conciliacionCajero(trx, tenantId, c.sucursal, c.fecha ?? null);
      const previos = await trx('finance.cash_ledger_cut_denominations')
        .where({ tenant_id: tenantId, cut_id: id }).select('denominacion', 'piezas');
      const totalesPrevios = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo: previos as ConteoDenominacion[], morralla: Number(c.morralla ?? 0),
      });

      const gate = puedeRecontar(c, totalesPrevios, input.motivo);
      if (!gate.ok) throw new BadRequestException(TEXTO_NO_RECUENTA[gate.motivo!]);

      // El primero se guarda ENTERO antes de que el segundo lo pise.
      await trx('finance.cash_ledger_cuts').where({ id }).update({
        conteo_previo: JSON.stringify({
          denominaciones: previos, morralla: Number(c.morralla ?? 0),
          contado: Number(c.contado ?? 0), sellado_at: c.updated_at, recontado_por: u.username ?? u.id,
        }),
        reconteo_motivo: String(input.motivo).trim(),
        updated_at: trx.fn.now(),
      });

      const totales = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo: input.conteo, morralla: input.morralla ?? 0,
      });
      if (totales.veredicto === 'sin_contar') throw new BadRequestException(TEXTO_NO_CIERRA['sin_conteo']);
      await this.sellarConteo(trx, tenantId, id, totales, input);

      return { corte_id: id, totales, conteo_previo_contado: Number(c.contado ?? 0), puede_recontar: false };
    });
  }

  /**
   * ⭐ ATAR PRIMERO, SUMAR DESPUÉS — y el orden no es preferencia, es la corrección de una carrera.
   *
   * Antes esto leía los movimientos sueltos, congelaba los totales y RECIÉN AL FINAL los ataba.
   * En READ COMMITTED el `UPDATE ... WHERE corte_id IS NULL` **re-evalúa su predicado al momento de
   * ejecutarse**, así que un `create()` que commiteara entre la lectura y la escritura quedaba
   * **atado al corte pero fuera de los totales firmados**: el corte declaraba contener movimientos
   * que no había sumado. Y no lo atrapaba nadie — `cut_cerrado_completo_chk` sólo exige `NOT NULL`
   * (ver la nota en `cash-cut.engine.ts`), así que la DB no repite la cuenta.
   *
   * Invirtiendo el orden el conjunto atado y el sumado son **el mismo por construcción**, sin
   * necesidad de SERIALIZABLE: lo que entre después simplemente queda suelto para el corte
   * siguiente, que es el comportamiento correcto.
   */
  async cerrar(id: string, input: CerrarCorteInput, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // `forUpdate` sobre el CORTE: dos cierres simultáneos del mismo corte se serializan acá.
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');
      if (c.estado !== 'borrador') throw new BadRequestException(TEXTO_NO_CIERRA['no_es_borrador']);

      /**
       * ⛔⛔ `[CG.115]` **EL `.where('fecha', dia)` ES LA MITAD QUE FALTABA.** `movimientosSueltos`
       * acota lo que se SUMA; esto acota lo que se ATA. Sin las dos, el invariante de arriba
       * ("el conjunto atado y el sumado son el mismo por construcción") se rompe al revés: el
       * corte ataría 32 movimientos y firmaría el total de 23.
       *
       * Y atar de más no es sólo un número torcido: un movimiento atado a un corte **ya no está
       * suelto**, así que los $130,000 del 25-sep quedarían sellados dentro del arqueo del 12-oct
       * y su propia jornada ya no podría cuadrarse nunca.
       */
      const dia = this.diaDe(c.fecha);
      const base = () => trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, sucursal: c.sucursal })
        .modify((q: Knex.QueryBuilder) => { if (dia) q.where('fecha', dia); })
        .whereNull('corte_id').whereNull('deleted_at');

      // ⛔ Un movimiento CANCELADO entra al corte (se audita que se canceló) pero CONSERVA su
      // estado. Antes el UPDATE le pisaba `estado` a `'en_corte'`, y eso lo resucitaba: volvía a
      // contar en `finance.v_cash_ledger_balance` (que descuenta por `estado='cancelado'`) y dejaba
      // de poder cancelarse. Un movimiento cancelado no se des-cancela al cerrar la caja.
      await base().where('estado', 'cancelado').update({ corte_id: id, updated_at: trx.fn.now() });
      await base().whereNot('estado', 'cancelado')
        .update({ corte_id: id, estado: 'en_corte', updated_at: trx.fn.now() });

      // Ahora sí: se suma EXACTAMENTE lo que quedó atado. Si el gate falla, la trx revierte las dos
      // cosas juntas.
      const filas = await trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, corte_id: id })
        .whereNull('deleted_at')
        .select('tipo', 'monto', 'estado', 'origen_tipo');
      // `anclado` viaja al motor para que el corte FIRMADO deje constancia de cuánto de su
      // esperado venía de Kepler. Es el dato que distingue un corte auditable de uno que sólo
      // repite lo que el capturista tecleó (regla M4).
      const movs: MovimientoDelCorte[] = filas.map((r: any) => ({ ...r, anclado: r.origen_tipo === 'cobro' }));
      // `[CG.96]` Las dos piernas del cajero desde que abrió ESTE corte. Sin esto el esperado
      // ignora la bóveda y pide contar efectivo que está dentro de la máquina.
      const cajero = await this.conciliacionCajero(trx, tenantId, c.sucursal, c.fecha ?? null);

      const t = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo: input.conteo, morralla: input.morralla ?? 0,
      });

      const gate = puedeCerrar(c, u.id, t);
      if (!gate.ok) throw new BadRequestException(TEXTO_NO_CIERRA[gate.motivo!]);

      const [cerrado] = await trx('finance.cash_ledger_cuts').where({ id }).update({
        estado: 'cerrado',
        closed_by: u.id, closed_by_username: u.username ?? null, closed_at: trx.fn.now(),
        total_ingresos: t.ingresos, total_gastos: t.gastos, total_depositos: t.depositos,
        esperado: t.esperado, contado: t.contado, diferencia: t.diferencia,
        morralla: input.morralla ?? 0, nota: input.nota ?? c.nota, updated_at: trx.fn.now(),
      }).returning('*');

      const piezas = (input.conteo ?? []).filter((d) => Number(d.piezas) > 0);
      if (piezas.length) {
        await trx('finance.cash_ledger_cut_denominations').where({ tenant_id: tenantId, cut_id: id }).del();
        await trx('finance.cash_ledger_cut_denominations').insert(
          piezas.map((d) => ({ tenant_id: tenantId, cut_id: id, denominacion: d.denominacion, piezas: d.piezas })));
      }

      return { ...cerrado, totales: t };
    });
  }

  async autorizar(id: string, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // ⛔ `[CG.42]` `forUpdate`, igual que `cerrar()`. Sin el bloqueo, dos autorizaciones
      // simultáneas del mismo corte **pasan las dos** por `puedeAutorizar` —las dos leen
      // `estado='cerrado'`— y las dos escriben: gana la última y `authorized_by` termina diciendo
      // que lo autorizó alguien que no fue necesariamente quien lo autorizó primero.
      //
      // ⭐ No es un detalle de bitácora: `authorized_by` ES el control. Es la mitad de la regla de
      // dos personas que el CHECK `cut_doble_llave_chk` y `puedeAutorizar` existen para sostener,
      // y un control cuya evidencia se puede pisar no es un control.
      //
      // Mismo orden de bloqueo que `cerrar()` (corte primero): no introduce inversión ni deadlock.
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');

      const gate = puedeAutorizar(c, u.id);
      if (!gate.ok) {
        // 403 y no 400: no es que el dato esté mal, es que esta persona no puede.
        throw new ForbiddenException(TEXTO_NO_AUTORIZA[gate.motivo!]);
      }
      const [aut] = await trx('finance.cash_ledger_cuts').where({ id }).update({
        estado: 'autorizado',
        authorized_by: u.id, authorized_by_username: u.username ?? null, authorized_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      }).returning('*');
      return aut;
    });
  }

  async listar(q: { from?: string; to?: string; sucursal?: string; estado?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return this.tk.run(async (trx) => {
      let qb = trx('finance.cash_ledger_cuts').where('tenant_id', tenantId);
      if (q.from) qb = qb.where('fecha', '>=', q.from);
      if (q.to) qb = qb.where('fecha', '<=', q.to);
      if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
      if (q.estado) qb = qb.where('estado', q.estado);
      const rows = await qb.orderBy('fecha', 'desc').orderBy('folio', 'desc').limit(limit);
      return { rows, limit };
    });
  }

  /**
   * Saldo actual de la caja: fondo del corte abierto + efecto de sus movimientos.
   * Se DERIVA (vista con ventana), no se guarda — ver §CG.15 de la fase.
   *
   * ⛔ **CG.19 Capa 1b — ACÁ ESTABA LA FUGA DEL ARQUEO CIEGO.** Este endpoint devolvía
   * `totales` completo (con `esperado`) y la pantalla lo pintaba en el diálogo de cierre mientras
   * la persona teclea el conteo. Contar viendo el esperado no es contar: es transcribir.
   *
   * Ahora sólo lo ve quien **autoriza** (`FINANCE_CAJA_AUTORIZAR`), que es la segunda llave del
   * corte — la misma persona que ya no puede ser la que cerró. Quien captura cuenta a ciegas y lo
   * ve al guardar.
   *
   * ⚠️ `saldo` también se recorta: es literalmente `t.esperado` con otro nombre. Dejarlo hubiera
   * sido tapar el campo y publicarlo en el de al lado — que es como se rompen estos candados.
   */
  /**
   * CS.3.11 — Conciliación con el CAJERO (CAOS) para el corte de OFICINAS (sucursal 00, el único con
   * cajero). Desde que abrió el corte, cuánto se DEPOSITÓ en el cajero (salió de caja chica a la
   * bóveda) y cuánto se DISPENSÓ (entró a caja chica). Modelo «cajas separadas»: la caja chica es
   * efectivo suelto, el cajero es la bóveda. `null` si no es oficinas, no hay corte, o no está el feed.
   * ⚠️ CAOS no tiene columna sucursal (un solo dispositivo en oficinas): el filtro es sólo por período.
   * ⚠️ `abs(total)`: una dispensación puede venir con `total` negativo — acá interesa la MAGNITUD movida.
   */
  private async conciliacionCajero(trx: any, tenantId: string, sucursal: string, fecha: string | Date | null) {
    if (sucursal !== '00') return null;
    const existe = await trx.raw(`SELECT to_regclass('analytics.caos_cash_movements') AS t`);
    if (!existe.rows?.[0]?.t) return null; // el feed del cajero puede no estar en este entorno

    /**
     * ⛔⛔ `[CG.101]` **ACÁ DECÍA `occurred_at >= corte.created_at`, Y ESA VENTANA SIEMPRE ESTÁ
     * VACÍA.** Medido en prod el 2026-10-13 contra el corte `CC-2026-00001`:
     *
     *     ventana del código (occurred_at >= created_at) ->  $0 depositado · $0 dispensado · 0 movs
     *     el día completo 12-oct                          ->  $111,750     · $58,690      · 14 movs
     *
     * La causa es el flujo real, no la aritmética: **el corte se abre al CERRAR la jornada**. La
     * pantalla llama a `abrir()` y a `cerrar()` en el mismo gesto ("Cerrar jornada y rendir
     * cuentas"), así que `created_at` quedó a las 18:00 y los 14 movimientos de la bóveda de ese
     * día habían ocurrido ANTES. La ventana arrancaba después de todo lo que tenía que medir.
     *
     * ⭐ Y esto deja a `[CG.96]` sin poder dispararse: el motor calcula bien las dos piernas, pero
     * recibía ceros. O sea que la corrección estaba escrita y **nunca llegó a correr** — el
     * esperado seguía ignorando la bóveda y pedía contar en el cajón lo que estaba en la máquina.
     *
     * La ventana correcta es **la jornada**, el mismo grano con el que el libro fecha sus
     * movimientos (`cash_ledger.fecha`) y con el que el feed fecha los suyos (`accounting_date`).
     * No la hora en que alguien alcanzó a crear la fila del corte.
     *
     * ⚠️ `fecha == null` significa **hoy** — es el panel del día cuando todavía no hay corte
     * abierto. Antes eso devolvía `null` entero y el panel no podía decir nada de la bóveda.
     */
    const dia: string = fecha == null
      ? (await trx.raw(
          `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date,'YYYY-MM-DD') AS d`)).rows[0].d
      // ⚠️ `String(unDate).slice(0,10)` da "Mon Oct 12 2026" — el mismo defecto que `[LC.16]`.
      // Una columna `date` de pg llega como `Date` a la medianoche local, así que `toISOString()`
      // es lo único que devuelve el día que se guardó.
      : (fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha).slice(0, 10));

    const [r] = await trx('analytics.caos_cash_movements')
      .where('tenant_id', tenantId)
      .whereRaw(`accounting_date = ?::date`, [dia])
      .select(
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.DEPOSITO}), 0)::numeric AS depositado`),
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.DISPENSAR}), 0)::numeric AS dispensado`),
        // ⛔ Lo que ANTES no se contaba. `Dotar` mete efectivo a la bóveda y `Vaciar Stocks` lo
        // saca, y los dos quedaban fuera del cuadre: medido, $1,500,120 + $2,350,370 = $3.85M
        // invisibles. No son caja chica (entran/salen por fuera), pero un cuadre que los ignora
        // no puede explicar por qué la bóveda cambió — y el último fue el 2026-09-08, no en 2024.
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.DOTAR}), 0)::numeric AS dotado`),
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = ${CAOS.VACIAR}), 0)::numeric AS vaciado`),
        trx.raw(`count(*) FILTER (WHERE type_id NOT IN (${TIPOS_CONOCIDOS.join(',')}))::int AS otros_movs`),
        trx.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id NOT IN (${TIPOS_CONOCIDOS.join(',')})), 0)::numeric AS otros_monto`),
        trx.raw(`count(*)::int AS movimientos`),
      );
    return {
      depositado: Number(r?.depositado ?? 0),
      dispensado: Number(r?.dispensado ?? 0),
      // Las dos piernas que no son caja chica, expuestas APARTE en vez de sumadas: mezclarlas con
      // el depósito/dispensación haría que la caja chica conciliada diera cualquier cosa.
      dotado: Number(r?.dotado ?? 0),
      vaciado: Number(r?.vaciado ?? 0),
      // ⚠️ Un tipo de CAOS que no conocemos NO se suma a ninguna pierna: se DECLARA. Si mañana el
      // cajero emite un tipo nuevo, acá aparece con su monto en vez de desaparecer en silencio.
      otros: { movimientos: Number(r?.otros_movs ?? 0), monto: Number(r?.otros_monto ?? 0) },
      movimientos: Number(r?.movimientos ?? 0),
      // La jornada que se midió. Se publica para que la pantalla pueda decir DE QUÉ DÍA habla,
      // en vez de mostrar dos cifras de la bóveda sin fecha.
      dia,
    };
  }

  async saldo(sucursal: string, revela = false) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const abierto = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal, estado: 'borrador' }).first();
      /**
       * `[CG.115]` Sin corte abierto, la jornada es **hoy** — el mismo día con el que el panel ya
       * mide la bóveda tres líneas más abajo. Antes acá no había jornada ninguna y el "saldo de la
       * caja" que se pinta en la barra era la suma de todo lo que alguna vez quedó sin cortar.
       */
      const dia = this.diaDe(abierto?.fecha) ?? (await trx.raw(
        `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date,'YYYY-MM-DD') AS d`)).rows[0].d;
      const movs = await this.movimientosSueltos(trx, tenantId, sucursal, dia);
      const fuera = await this.sueltosFuera(trx, tenantId, sucursal, dia);
      const cajero = await this.conciliacionCajero(trx, tenantId, sucursal, abierto?.fecha ?? null);
      const t = calcularCorte({ fondoInicial: fondo(abierto), movimientos: movs, cajeroSinCapturar: cajero });
      return {
        sucursal,
        corte_abierto: abierto
          ? {
            id: abierto.id, folio: abierto.folio, fondo_inicial: fondo(abierto),
            // Que ya se recontó NO es secreto: no revela el esperado y la pantalla necesita
            // saberlo para apagar el botón antes de que el usuario lo intente.
            ya_reconto: abierto.conteo_previo != null,
          }
          : null,
        // Sin corte abierto el "saldo" no tiene punto de partida: se declara, no se dibuja en 0.
        saldo: revela ? (abierto ? t.esperado : null) : null,
        // Se DICE que está oculto. Un `null` por candado y un `null` por "no hay corte" son cosas
        // distintas y no pueden leerse igual (ADR-056).
        saldo_oculto: !revela,
        sin_corte_abierto: !abierto,
        movimientos_sueltos: t.movimientos,
        // La jornada que se midió, para que "N movimientos sueltos" diga DE QUÉ DÍA habla.
        dia,
        /**
         * ⭐ `[CG.115]` Lo que quedó suelto de OTROS días. `null` cuando no hay nada fuera — y eso
         * es distinto de cero movimientos en el día: acá `null` significa "no hay pendientes de
         * otras jornadas", no "no se midió".
         */
        sueltos_fuera: fuera,
        totales: proyectarCiego(t, revela),
        // CS.3.11 — el movimiento del cajero (CAOS) en el período del corte, para conciliar la caja
        // chica contra la bóveda. Los montos son hechos del cajero (no gateados); la caja chica
        // conciliada la calcula el front sólo cuando `saldo` (esperado) se revela.
        cajero,
      };
    });
  }

  /**
   * ⭐ `[CG.26]` — **EL ARQUEO DE FIN DE JORNADA: ¿cuadró el día en caja general y en el cajero?**
   *
   * Pedido de Edgar (2026-09-29): *"un arqueo diario al finalizar la jornada para ver que todo
   * cuadró en caja general y CAOS"*.
   *
   * ── Por qué NO alcanzaba con lo que ya había ───────────────────────────────────────────────
   * El arqueo existente (`saldo`) es **del corte**, no del día: su ventana es
   * `occurred_at >= corte.created_at` **sin tope superior**, así que un corte abierto una semana
   * concilia una semana. Y sobre todo **exige que alguien haya abierto un corte**, y en prod hay
   * CERO cortes — o sea que hoy no existe forma de cerrar un día.
   *
   * Éste no depende de que haya corte. Si lo hay lo muestra; si no, el día igual se puede cuadrar.
   *
   * ── La jornada la declara el cajero, no nuestro calendario ────────────────────────────────
   * El día es `accounting_date` de CAOS, **no** `occurred_at`. Medido: viene poblado en
   * **1,021 de 1,021** filas y difiere del día natural de México en **1**. Esa fila es
   * precisamente un movimiento pasada la medianoche que pertenece a la jornada anterior — que es
   * lo que "fin de jornada" significa. `shift_id` NO sirve: está **100 % en NULL**.
   *
   * ── Qué se puede afirmar y qué no ─────────────────────────────────────────────────────────
   * ⛔ **CAOS no publica su contenido.** No hay columna de saldo, stacker ni denominación
   * (verificado: cero columnas que matcheen saldo/balance/bag/stacker/denom). Del cajero se
   * cuadra el **FLUJO** (lo que entró contra lo que salió), nunca "cuánto hay adentro".
   *
   * ⛔ **Y el flujo acumulado NO es el efectivo de la máquina.** Medido desde que arranca el feed:
   * entra $17,995,820 − sale $18,812,090 = **−$816,270**. Negativo, porque el cajero ya tenía
   * efectivo antes del 2026-05-27 y ese saldo inicial **no lo sabemos**. Por eso el neto se
   * publica como *movimiento del día* y el acumulado no se publica como saldo.
   *
   * ⚠️ **El cuadre contra Kepler no es de hoy, y no por culpa del feed.** El feed está al día (su
   * última captura es de hoy), pero el ERP tarda una **mediana de 3 días** en capturar el
   * documento: el efectivo de hoy aparece en Kepler recién dentro de unos días. Por eso la cola
   * del ERP no se usa acá para decir si el día cuadró.
   */
  async arqueoDelDia(fecha: string | undefined, sucursal: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const dia = String(
        fecha || (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text d`)).rows[0].d,
      ).slice(0, 10);

      /**
       * ── 1. Caja general: lo que NUESTRO libro registró en esa jornada ────────────────────
       *
       * ⛔⛔ `[CG.82]` **ACÁ SE FILTRABA POR `fecha`, Y `fecha` ES LA DEL DOCUMENTO DE KEPLER,
       * NO EL DÍA EN QUE SE REGISTRÓ EL EFECTIVO.** Lo encontró Edgar al pedir que se verificara
       * que el cierre muestra *"los ingresos y egresos que se van registrando"*. No los mostraba.
       *
       * La `fecha` de un movimiento nace del documento: la bandeja propone
       * `fecha: ymd(r.fecha_valor)` (`cash-ledger.service.ts`), y el ERP captura con una **mediana
       * de 3 días de rezago** — cifra que este mismo archivo ya publicaba en `limites`. O sea que
       * lo normal es registrar hoy algo fechado hace tres días, y eso caía en una jornada que ya
       * se cerró.
       *
       * Medido en prod el 2026-10-12, sobre las 5 filas vivas de `finance.cash_ledger`:
       *   · **2 de 5** tienen fecha de documento distinta del día en que se registraron;
       *   · una está fechada **2026-12-10** y se registró el **2026-09-28** — ese gasto de
       *     $1,060 aparecía en el cierre de un día de DICIEMBRE y en ninguno antes.
       *
       * ⭐ Y lo que vuelve esto inequívoco, no una preferencia: **el otro lado del cuadre ya está
       * en el reloj físico.** El cajero se agrupa por `caos_cash_movements.accounting_date`, que
       * en **455 de 456** movimientos de 60 días coincide con el día en que el efectivo se movió.
       * Un cuadre cuyos dos lados usan relojes distintos no cuadra nada: compara el dinero que
       * salió hoy del cajero contra los documentos que están fechados hoy, que son otra cosa.
       *
       * Un arqueo responde "¿qué se movió en el cajón hoy?". El efectivo sale cuando la persona lo
       * entrega, no cuando Kepler fecha el papel.
       *
       * ⚠️ El rango va con `>=` / `<` sobre `created_at` y NO con un cast a `::date`: envolver la
       * columna en una expresión la saca de cualquier índice. Es el mismo defecto que en `[LC.9]`
       * convirtió un `to_char(fecha)` en un seq scan de 167k filas.
       */
      const [libro] = await trx('finance.cash_ledger')
        .where({ tenant_id: tenantId })
        // `[CG.98]` La caja general es UNA: en oficinas se ven todas las plazas.
        .where((b: any) => aplicarAlcanceCaja(b, sucursal))
        .whereRaw(`created_at >= (?::date) AT TIME ZONE 'America/Mexico_City'`, [dia])
        .whereRaw(`created_at <  ((?::date) + 1) AT TIME ZONE 'America/Mexico_City'`, [dia])
        .whereNull('deleted_at')
        .select(
          trx.raw(`count(*) FILTER (WHERE estado <> 'cancelado')::int AS movimientos`),
          trx.raw(`count(*) FILTER (WHERE estado = 'cancelado')::int AS cancelados`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='ingreso'),0)::numeric AS ingresos`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='gasto'),0)::numeric AS gastos`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='deposito'),0)::numeric AS depositos`),
          // `[CG.82]` Cuántos de los de HOY traen el papel fechado otro día. No es un error ni algo
          // que alguien pueda arreglar hoy: es el rezago del ERP, y se publica para que nadie lea
          // esta jornada como si fuera un corte contable. Se cuenta, no se esconde.
          trx.raw(`count(*) FILTER (WHERE estado <> 'cancelado'
                     AND fecha <> (created_at AT TIME ZONE 'America/Mexico_City')::date)::int
                   AS fechados_otro_dia`),
        );
      const ingresos = Number(libro?.ingresos ?? 0);
      const gastos = Number(libro?.gastos ?? 0);
      const depositos = Number(libro?.depositos ?? 0);

      // ── 2. El cajero (CAOS): la jornada COMPLETA, con los seis tipos ─────────────────────
      // ⚠️ CAOS no tiene columna de sucursal: es un único dispositivo, en oficinas. Para cualquier
      // otra sucursal se devuelve `null` y se DICE por qué, en vez de mostrar ceros que se leerían
      // como "el cajero no se movió".
      const hayCaos = (await trx.raw(`SELECT to_regclass('analytics.caos_cash_movements') AS t`))
        .rows?.[0]?.t;
      let cajero: Record<string, unknown> | null = null;
      if (hayCaos && sucursal === '00') {
        const porTipo = await trx('analytics.caos_cash_movements')
          .where({ tenant_id: tenantId, accounting_date: dia })
          .groupBy('type_id', 'type_label')
          .orderBy('type_id')
          .select(
            'type_id',
            trx.raw(`coalesce(type_label, '(tipo ' || type_id || ' sin etiqueta)') AS etiqueta`),
            trx.raw(`count(*)::int AS movimientos`),
            trx.raw(`coalesce(sum(abs(total)), 0)::numeric AS monto`),
            trx.raw(`(type_id NOT IN (${TIPOS_CONOCIDOS.join(',')})) AS desconocido`),
          );
        const suma = (ids: readonly number[]) => porTipo
          .filter((t: { type_id: number }) => ids.includes(Number(t.type_id)))
          .reduce((a: number, t: { monto: string }) => a + Number(t.monto), 0);
        // Entra a la bóveda: lo depositado (viene de caja chica) + lo dotado (viene de afuera).
        const entra = suma([CAOS.DEPOSITO, CAOS.DOTAR]);
        // Sale de la bóveda: lo dispensado (va a caja chica) + lo vaciado (se lo llevan afuera).
        const sale = suma([CAOS.DISPENSAR, CAOS.VACIAR]);
        const desconocidos = porTipo.filter((t: { desconocido: boolean }) => t.desconocido);
        const [ult] = await trx('analytics.caos_cash_movements')
          .where({ tenant_id: tenantId })
          .max({ al: 'occurred_at' });
        cajero = {
          por_tipo: porTipo.map((t: Record<string, unknown>) => ({
            type_id: Number(t['type_id']), etiqueta: t['etiqueta'],
            movimientos: Number(t['movimientos']), monto: Number(t['monto']),
            desconocido: !!t['desconocido'],
          })),
          entra, sale,
          // El movimiento NETO del día. NO es "lo que hay en el cajero": ver el encabezado.
          neto: Number((entra - sale).toFixed(2)),
          // Las cuatro piernas por separado, porque significan cosas distintas.
          depositado: suma([CAOS.DEPOSITO]), dispensado: suma([CAOS.DISPENSAR]),
          dotado: suma([CAOS.DOTAR]), vaciado: suma([CAOS.VACIAR]),
          movimientos: porTipo.reduce((a: number, t: { movimientos: number }) => a + Number(t.movimientos), 0),
          // Un tipo que no conocemos se DECLARA con su monto; nunca se reparte a una pierna.
          tipos_desconocidos: desconocidos.map((t: Record<string, unknown>) => ({
            type_id: Number(t['type_id']), etiqueta: t['etiqueta'], monto: Number(t['monto']),
          })),
          ultimo_movimiento: (ult as { al?: string } | undefined)?.al ?? null,
        };
      }

      const corte = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal, estado: 'borrador' })
        .first('id', 'folio', 'fecha');

      // ── 3. Lo que NO se puede afirmar, dicho con nombre (ADR-056) ────────────────────────
      //
      // ⭐ `[CG.29]` Van en DOS listas, y la distinción es de jerarquía, no de estilo:
      //
      //   · `no_medido` — lo que ESTA jornada no pudo afirmar y **alguien puede cambiar hoy**
      //     (no hay corte abierto, el feed del cajero no está, apareció un tipo desconocido).
      //   · `limites`   — lo que este cuadre **nunca** va a cubrir, por cómo son las fuentes.
      //     Es permanente: sale todos los días, para siempre.
      //
      // Mezclarlas fue un error mío: la pantalla pintaba tres avisos naranjas iguales, dos de
      // ellos inmutables. Un aviso que aparece siempre y que nadie puede resolver deja de leerse,
      // y se lleva puesto al que sí importaba.
      const no_medido: string[] = [];
      const limites: string[] = [];

      if (!hayCaos) {
        no_medido.push('El feed del cajero (CAOS) no está en este entorno: del día sólo se puede cuadrar la caja general.');
      } else if (sucursal !== '00') {
        limites.push(`El cajero (CAOS) es un único dispositivo en oficinas: la sucursal ${sucursal} no tiene cajero que cuadrar.`);
      } else {
        limites.push('Del cajero se cuadra el FLUJO del día, no su contenido: CAOS no publica cuánto efectivo tiene adentro.');
      }
      /**
       * ⛔⛔ `[CG.31]` **El libro en cero mientras la bóveda se movió.** Va PRIMERO porque es más
       * grave que todo lo demás de esta lista.
       *
       * La pantalla ponía las dos columnas lado a lado —«Caja general $0.00 · 0 movimientos» y
       * «Cajero (CAOS) 6 movimientos, entra $71,150 / sale $95,500»— y el único aviso decía
       * *«todavía no rendiste cuentas»*. **Eso no es falta de rendición: son dos afirmaciones
       * incompatibles sobre el mismo día**, presentadas como dos columnas de un informe normal.
       *
       * Una contradicción que no se nombra se lee como una tabla más. Si la máquina contó dinero
       * y el libro no tiene nada, lo que falta no es una firma: falta capturar.
       *
       * ⚠️ Sólo cuando el libro está EN CERO. Si tiene movimientos y no cuadran contra el cajero,
       * ésa es otra pregunta (un descuadre, no un vacío) y la contesta el cuadre, no un aviso.
       */
      const avisoVacio = avisoLibroVacio(
        Number(libro?.movimientos ?? 0),
        Number((cajero?.['movimientos'] as number) ?? 0),
        Number(cajero?.['entra'] ?? 0) + Number(cajero?.['sale'] ?? 0));
      if (avisoVacio) no_medido.push(avisoVacio);
      if (!corte) {
        // ⭐ Éste es el único que la persona puede resolver, y es justamente el que separa
        // «el movimiento registrado» de «un arqueo firmado». Va arriba y solo.
        no_medido.push('Todavía no rendiste cuentas de esta jornada: esto es el movimiento REGISTRADO, no un arqueo firmado contra un conteo físico.');
      }
      limites.push('La cola de Kepler no entra en este cuadre: el ERP tarda una mediana de 3 días en capturar el documento, así que el efectivo de hoy todavía no está allá.');
      // `[CG.82]` La jornada se arma por el día en que se REGISTRÓ el efectivo, no por la fecha del
      // documento: es el único reloj en el que el otro lado del cuadre (el cajero) también está.
      // Se dice sólo cuando hay alguno, para que no sea un aviso permanente que nadie lee.
      const fueraDeFecha = Number(libro?.fechados_otro_dia ?? 0);
      if (fueraDeFecha > 0) {
        limites.push(`Esta jornada es lo REGISTRADO hoy:  de esos movimientos traen el documento de Kepler fechado otro día. El efectivo se movió hoy; el papel es de antes.`);
      }
      if (cajero && (cajero['tipos_desconocidos'] as unknown[]).length > 0) {
        no_medido.push('El cajero reportó un tipo de movimiento que no conocemos: está listado aparte y NO se sumó a ninguna pierna.');
      }

      /**
       * ⭐ `[CG.91]` **EL HISTORIAL DE LO QUE LLEVO HECHO. Lo pidió Edgar dos veces.**
       *
       * La primera: *"necesito que agreguemos un historial de movimientos para que el usuario vea
       * qué movimientos ya hizo"*. Lo que se entregó fue un filtro («los míos») y un reporte del
       * día en texto — **ninguna de las dos es la lista**. La segunda, con la pantalla a la vista:
       * *"ni siquiera me muestra un historial de lo que llevo hecho, como te lo pedí"*.
       *
       * Tenía razón: este bloque decía **"7 movimiento(s) registrado(s)"** y ahí terminaba. Un
       * contador no es un historial. Quien captura necesita ver QUÉ capturó —para reconocer lo
       * suyo, para detectar lo que falta y para no capturar dos veces lo mismo—, y el total de
       * arriba no se puede revisar contra nada si no están los renglones que lo forman.
       *
       * ⚠️ Mismo reloj que el resto de la jornada (`created_at` físico, `[CG.82]`), no la fecha del
       * documento: si una mitad del cuadro se agrupa por un reloj y la lista por otro, los
       * renglones no suman el total que tienen arriba y el cuadro deja de poder revisarse.
       *
       * ⚠️ Los cancelados VAN, marcados. Esconderlos haría que la lista no explique su propio
       * contador —que los cuenta aparte— y que un error de captura desaparezca de la vista justo
       * cuando hay que explicarlo.
       */
      const movimientosDelDia = await trx('finance.cash_ledger')
        .where({ tenant_id: tenantId })
        // `[CG.98]` Mismo alcance que el cuadro de arriba: si la lista mostrara otro universo que
        // el total, el pie no sumaría lo que el cuadro dice y nada se podría revisar.
        .where((b: any) => aplicarAlcanceCaja(b, sucursal))
        .whereRaw(`created_at >= (?::date) AT TIME ZONE 'America/Mexico_City'`, [dia])
        .whereRaw(`created_at <  ((?::date) + 1) AT TIME ZONE 'America/Mexico_City'`, [dia])
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(200)
        .select(
          'id', 'folio', 'tipo', 'monto', 'beneficiario', 'glosa', 'estado',
          'kepler_cuenta', 'kepler_concepto', 'kepler_concepto_nombre',
          'created_by_username', 'origen_tipo',
          trx.raw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS hora`),
          /**
           * ⛔⛔ `[CG.91.2]` **ACÁ SE PARTÍA LA GLOSA, Y LA GLOSA ES TEXTO LIBRE.**
           *
           * Era `split_part(glosa, ' · ', 1)`. Edgar lo vio al primer vistazo: la columna
           * «Documento» decía `X-D-26 0000161` en SEIS filas seguidas, cinco de ellas depósitos
           * de ruta que no tienen documento de Kepler.
           *
           * Y la columna no mentía: el dato está mal en la base. Los 5 ingresos de ruta quedaron
           * con `glosa = 'X-D-26 0000161 · GUILLERMO LOPEZ GUTIERREZ'` —un gasto ajeno, los cinco
           * iguales— porque el campo «Qué pasó» era editable y venía arrastrado de la captura
           * anterior. `[CG.94]` cierra esa puerta; esto arregla lo otro: **derivar un dato duro de
           * un campo que una persona puede escribir mal es construir sobre arena.**
           *
           * El `origen_ref` sí es duro: lo arma el servidor al anclar, y el índice único lo
           * protege. `07|X-D-26|0000091|0011` → `X-D-26 0000091`; `AST700-19758|1564` → el retiro
           * del cajero. Si no hay origen, no hay documento — y se dice, no se inventa uno.
           */
          trx.raw(`CASE
                     WHEN origen_tipo = 'caos' THEN 'CAOS #' || split_part(origen_ref, '|', 2)
                     WHEN origen_ref IS NOT NULL AND split_part(origen_ref, '|', 3) <> ''
                       THEN split_part(origen_ref, '|', 2) || ' ' || split_part(origen_ref, '|', 3)
                     ELSE NULL
                   END AS documento`),
        );

      return {
        fecha: dia,
        sucursal,
        // `[CG.91]` La lista, no sólo el conteo.
        movimientos_del_dia: movimientosDelDia.map((m: any) => ({
          id: m.id, folio: m.folio, hora: m.hora, tipo: m.tipo,
          monto: Number(m.monto), beneficiario: m.beneficiario,
          documento: m.documento || null, concepto: m.kepler_concepto_nombre ?? null,
          cuenta: m.kepler_cuenta ?? null, estado: m.estado,
          origen: m.origen_tipo ?? null, quien: m.created_by_username ?? null,
        })),
        caja_general: {
          movimientos: Number(libro?.movimientos ?? 0),
          cancelados: Number(libro?.cancelados ?? 0),
          ingresos, gastos, depositos,
          // Lo que el día le dejó a la caja chica según el libro. Sin fondo inicial: eso compone el
          // `esperado` del corte y vive gateado en `saldo()` (CG.19, arqueo ciego).
          neto: Number((ingresos - gastos - depositos).toFixed(2)),
          // `[CG.82]` De los de hoy, cuántos traen el papel fechado otro día (el rezago del ERP).
          // Viaja como NÚMERO y no sólo como frase: la frase se lee una vez, el número se compara.
          fechados_otro_dia: fueraDeFecha,
          /**
           * ⭐⭐ `[CG.97]` **CUÁNTO DE ESTE MOVIMIENTO QUEDÓ DE VERDAD EN EL CAJÓN.**
           *
           * Edgar, mirando este mismo bloque: *"ponemos que a caja general entró 103 mil, pero eso
           * no ingresó; ingresó sólo monedas y lo de CAOS se queda en CAOS"*.
           *
           * `neto` es correcto como MOVIMIENTO DEL DÍA —el dinero entró y se registró— pero se
           * lee como «esto hay en la caja», y no lo hay: de los $111,845 de hoy, la máquina se
           * tragó $111,750 en billetes. Al cajón llegaron $95 de morralla.
           *
           * El modelo es el que ya declara `conciliacionCajero`: **cajas separadas**. Un depósito
           * al cajero saca efectivo del cajón; una dispensación lo mete. Las dos piernas las mide
           * la MÁQUINA, que es el testigo duro — no hace falta enlazar nada.
           *
           *     en_el_cajon = ingresos − gastos − depósitos + dispensado − depositado
           *
           * ⚠️ `null` cuando no hay cajero (cualquier sucursal que no sea OFICINAS, o el feed
           * caído). Ahí no se puede repartir, y un cero diría «nada quedó en el cajón», que es
           * una afirmación distinta de «no se puede saber».
           */
          en_el_cajon: cajero
            ? Number((ingresos - gastos - depositos
              + Number(cajero['dispensado'] ?? 0) - Number(cajero['depositado'] ?? 0)).toFixed(2))
            : null,
          /**
           * ⭐ `[CG.99]` **CON QUÉ ARRANCÓ EL CAJÓN, para que el movimiento se vuelva un SALDO.**
           *
           * Edgar: *"entonces para eso mostremos su saldo inicial, o hay que considerarlo"*.
           * Tenía razón: `en_el_cajon` solo es un MOVIMIENTO y puede salir negativo de forma
           * legítima —un gasto de hoy pagado con efectivo que el cajero dispensó anteayer sale del
           * cajón hoy y entró hace dos días—. Publicado a secas se lee como «hay −$4,925», que es
           * imposible y asusta.
           *
           * Con el fondo, la resta se vuelve una suma que se puede ir a contar:
           *
           *     hay en el cajón = fondo inicial + lo que el día le dejó
           *
           * Sale del corte abierto si lo hay; si no, del último corte SELLADO (la misma fuente que
           * `sugerirFondo`, que ya existía y nadie consumía desde acá).
           *
           * ⚠️ `null` = **no se midió**, y es un hecho distinto de cero. Hoy en prod no hay ningún
           * corte, así que es `null` de verdad: la pantalla lo dice y ofrece declararlo una vez.
           */
          fondo_inicial: corte ? fondo(corte) : (await this.sugerirFondoInterno(trx, tenantId, sucursal)),
          /** `[CG.97]` Lo que de la jornada se fue a la bóveda, neto. Positivo = la bóveda creció. */
          a_la_boveda: cajero
            ? Number((Number(cajero['depositado'] ?? 0) - Number(cajero['dispensado'] ?? 0)).toFixed(2))
            : null,
        },
        cajero,
        corte_abierto: corte
          ? {
            id: corte.id, folio: corte.folio, fecha: String(corte.fecha).slice(0, 10),
            // `[CG.90.1]` Si el fondo se midió o no. La pantalla ofrece declararlo SOLO cuando
            // falta; sin este campo el botón saldría siempre, incluso con el fondo ya puesto.
            // ⚠️ `fondo()` devuelve `null` cuando no se midió — NO `0`, que sería "arrancó vacía".
            fondo_inicial: fondo(corte), fondo_origen: corte.fondo_origen ?? null,
          }
          : null,
        no_medido,
        limites,
      };
    });
  }

  /** Cancela un movimiento. No se borra: se marca, con motivo y autor. */
  async cancelarMovimiento(id: string, motivo: string, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    if (!motivoCancelacionValido(motivo)) {
      throw new BadRequestException('Explicá por qué se cancela, con al menos 5 caracteres.');
    }
    return this.tk.run(async (trx) => {
      // ⛔ `[CG.42]` `forUpdate` sobre el MOVIMIENTO, y es lo que hace cierto al freno de abajo.
      //
      // `puedeCancelarse` decide mirando el estado del corte. Leerlo sin bloqueo es un
      // *time-of-check / time-of-use*: entre el `SELECT` del corte y el `UPDATE` del movimiento,
      // `cerrar()` puede cerrar ese corte. Resultado: se cancela un movimiento que ya entró a un
      // cuadre **firmado**, que es exactamente lo que el mensaje de error de abajo promete que no
      // puede pasar. El freno existía; lo que faltaba era que mirara un dato que no se mueve.
      //
      // ⭐ Bloquear el MOVIMIENTO alcanza, y además evita el deadlock que traería bloquear el
      // corte: `cerrar()` toma el corte y DESPUÉS actualiza los movimientos, así que tomar acá el
      // corte sería el orden inverso. Con el movimiento bloqueado:
      //   · si cancelar llega primero → `cerrar()` espera y después lo adjunta ya cancelado (su
      //     rama `where('estado','cancelado')` lo contempla, conservando el estado);
      //   · si `cerrar()` llega primero → este `SELECT` **espera** y, al soltarse el lock, Postgres
      //     re-lee la fila viva (EvalPlanQual en READ COMMITTED): ve `corte_id` ya puesto, lee el
      //     corte en `cerrado` y `puedeCancelarse` lo rechaza. Que es lo correcto.
      const m = await trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!m) throw new NotFoundException('Movimiento no encontrado');

      let estadoCorte: string | null = null;
      if (m.corte_id) {
        const c = await trx('finance.cash_ledger_cuts').where({ tenant_id: tenantId, id: m.corte_id }).first();
        estadoCorte = c?.estado ?? null;
      }
      if (!puedeCancelarse(m, estadoCorte)) {
        throw new BadRequestException(
          m.estado === 'cancelado'
            ? 'Este movimiento ya está cancelado.'
            : 'Este movimiento ya entró a un corte cerrado: no se puede cancelar sin mover un cuadre que alguien firmó. Registrá un movimiento que lo corrija.');
      }
      const [cancelado] = await trx('finance.cash_ledger').where({ id }).update({
        estado: 'cancelado', cancel_reason: motivo.trim(),
        cancelled_by: u.id, cancelled_by_username: u.username ?? null,
        cancelled_at: trx.fn.now(), updated_at: trx.fn.now(),
      }).returning('*');
      return cancelado;
    });
  }
}
