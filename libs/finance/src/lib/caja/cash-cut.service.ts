import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { denomKeyDeValor, SUCURSAL_CAJA_GENERAL, diaDeFecha, type JornadasPendientes } from '@megadulces/contracts';
import { fondoSugerido } from './cash-opening.engine';
import { traducirErrorDeCaja } from './caja-errores';
import { hoyMx, jornadasSinCorte } from './caja-jornadas.query';
import {
  calcularCorte, puedeAutorizar, puedeCerrar, puedeCancelarse, motivoCancelacionValido,
  buildFolioCorte, TEXTO_NO_AUTORIZA, TEXTO_NO_CIERRA,
  proyectarCiego, puedeRecontar, TEXTO_NO_RECUENTA, avisoLibroVacio,
  filasDenominacion, DenominacionFueraDeCatalogo, veredictoDe,
  decidirConteoDelCierre, esperadoCambio, textoConteoDistinto, textoEsperadoCambio, puedeAbrirCorte,
  type ConteoDenominacion, type ConteoSellado, type MovimientoDelCorte, type TotalesCorte,
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
// `[CGP-L.4]` La constante del cajón vive en un solo lugar (`caja-jornadas.query.ts`): la usan
// también el sensor y la consulta de jornadas pendientes, y dos copias del mismo '00' divergen.
function aplicarAlcanceCaja(qb: any, sucursal: string): any {
  return sucursal === SUCURSAL_CAJA_GENERAL ? qb.whereRaw('true') : qb.where('sucursal', sucursal);
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
export interface CerrarCorteInput {
  conteo?: ConteoDenominacion[];
  morralla?: number;
  nota?: string;
  /**
   * `[CGP-L.2]` El esperado que la persona VIO al cerrar. Si el esperado cambió desde que se contó
   * (un movimiento tardío), `cerrar()` responde 409 en vez de firmar otro número; quien ya vio el
   * nuevo lo confirma mandándolo acá.
   */
  esperado_visto?: number;
  /**
   * `[CGP-V.9]` «Conté y no hay efectivo»: sella un conteo en cero. Sin esto una reja vacía es «no
   * se contó». Con piezas o morralla en el cuerpo es una contradicción y se rechaza con frase.
   */
  cero_declarado?: boolean;
}

/** `[CGP-V.9]` Declarar cero con piezas en la reja: o se cuenta, o se declara cero, no las dos. */
function rechazarCeroContradictorio(input: CerrarCorteInput): void {
  if (input.cero_declarado !== true) return;
  const piezas = (input.conteo ?? []).some((d) => d && Number(d.piezas) > 0);
  if (piezas || Number(input.morralla || 0) > 0) {
    throw new BadRequestException(
      'Marcaste que no hay efectivo, pero la reja trae piezas. O se cuenta lo que hay, o se declara que no hay nada.',
    );
  }
}

interface Usuario { id?: string; username?: string }

/**
 * `[CG.128]` Una fila de la cola de reclasificación: el movimiento, lo que TIENE y lo que la
 * póliza de Kepler dice que debería tener, con su respaldo.
 */
export interface PorReclasificar {
  cash_ledger_id: string;
  folio: string;
  fecha: string | Date;
  tipo: string;
  monto: string | number;
  sucursal: string;
  beneficiario: string | null;
  glosa: string | null;
  de_cuenta: string | null;
  de_concepto: string | null;
  a_cuenta: string;
  a_concepto: string;
  cuenta_nombre: string | null;
  concepto_nombre: string | null;
  /** Cuántos renglones de póliza sostienen la propuesta. */
  respaldo: number | null;
}

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
  /** `[CG.158]` Lo que no se puede leer se registra con su motivo real, no se devuelve en silencio. */
  private readonly logger = new Logger(CashCutService.name);

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
  /**
   * ⭐⭐ `[CG.160]` **EL ÚNICO lugar que define QUÉ MOVIMIENTOS SON DE UN CORTE.**
   *
   * Lo que se SUMA (`movimientosSueltos`) y lo que se ATA (`cerrar`) tienen que ser el mismo
   * conjunto, y hasta hoy eso era cierto sólo en el eje FECHA (`[CG.115]`) y falso en el de la
   * PLAZA: el cierre acotaba a `sucursal = '00'` mientras el conteo veía todas las plazas por
   * `aplicarAlcanceCaja`. Dos funciones hermanas midiendo universos distintos, y ninguna capaz de
   * contradecir a la otra porque nadie las comparó.
   *
   * Costaba, medido al centavo sobre `CC-2026-00001`: un **faltante inventado de $39,486.00**
   * donde el arqueo real daba un sobrante de $251.05 (ver el bloque de `cerrar()`).
   *
   * ⛔ Por eso el predicado vive acá y NO se copia: un invariante que depende de que dos lugares
   * digan lo mismo se rompe en cuanto alguien toca uno. Acá no pueden divergir.
   */
  private sueltosDe(
    trx: Knex.Transaction, tenantId: string, sucursal: string, dia: string | null,
  ): Knex.QueryBuilder {
    return trx('finance.cash_ledger')
      .where({ tenant_id: tenantId })
      .where((b: Knex.QueryBuilder) => aplicarAlcanceCaja(b, sucursal))
      .modify((q: Knex.QueryBuilder) => { if (dia) q.where('fecha', dia); })
      .whereNull('corte_id').whereNull('deleted_at');
  }

  private async movimientosSueltos(
    trx: Knex.Transaction, tenantId: string, sucursal: string, dia: string | null,
  ): Promise<MovimientoDelCorte[]> {
    const rows = await this.sueltosDe(trx, tenantId, sucursal, dia)
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
   * ⚠️ `String(unDate).slice(0,10)` da `"Mon Oct 12"`. Y `toISOString()` sólo funcionaba de casualidad:
   * node-pg arma un `date` como medianoche LOCAL del proceso (no UTC, como decía esta nota), así que
   * con el servidor en UTC o en México da el día correcto y al este de UTC da el ANTERIOR — medido
   * con el parser de pg en tres zonas (`[CGP-L.5]`). `diaDeFecha` lee los componentes locales: da el
   * día que se guardó en cualquier zona. Acá decide **qué movimientos entran a un corte de dinero**.
   */
  private diaDe(fecha: string | Date | null | undefined): string | null {
    return diaDeFecha(fecha);
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
    /**
     * ⛔⛔ `[CG.157]` **EL CONTEO Y EL NETO MEDÍAN UNIVERSOS DISTINTOS.**
     *
     * El neto llevaba `CASE WHEN estado = 'cancelado' THEN 0` y el `count(*) FILTER (...)` **no
     * filtraba `estado`**. Así que un movimiento cancelado inflaba el conteo y no aportaba un peso
     * al neto: la pantalla decía «39 movimientos sueltos» sobre un dinero de 37.
     *
     * Lo encontró una auditoría de otra sesión creando dos movimientos de prueba y cancelándolos:
     * **el contador subió de 37 a 39 sin que el dinero se moviera.** Verificado por mi lado contra
     * prod el 2026-10-14: `71` contra `70` anteriores a hoy — la diferencia es el gasto de \$20
     * `CG-2026-00003`, una prueba E2E cancelada el 8-oct que lleva seis días contándose como
     * pendiente de cortar.
     *
     * ⭐ El filtro va en el **`WHERE`**, no en cada agregado, y por eso se retira el `CASE`: con el
     * `CASE` había **dos** definiciones de «qué cuenta» en la misma consulta, y `desde`/`hasta`
     * seguían una tercera —incluían cancelados— así que la ventana de fechas podía arrancar en un
     * movimiento que no existe. Una sola condición, un solo universo.
     *
     * ⚠️ Y el criterio correcto es excluirlos: esto responde *«¿qué quedó sin cortar?»*, y un
     * movimiento cancelado no espera corte. Es el mismo criterio que `calcularCorte()` ya aplica
     * —descarta los cancelados y los reporta aparte— así que acá se alinea en vez de inventar otro.
     */
    const neto = `sum(CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END)`;
    const [r] = await trx('finance.cash_ledger')
      .where({ tenant_id: tenantId })
      .where((b: Knex.QueryBuilder) => aplicarAlcanceCaja(b, sucursal))
      .whereNull('corte_id').whereNull('deleted_at')
      .whereNot('estado', 'cancelado')
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
    /**
     * ⛔⛔ `[CG.158]` **`to_regclass` da FALSO VERDE y la línea de abajo explota con un 500.**
     *
     * Medido en prod el 2026-10-14: `app_runtime` —el rol con el que corre la API, 5 conexiones
     * vivas— **no tiene `USAGE` sobre el schema `caja_general_ods`**, aunque sí tenga el `SELECT`
     * de la tabla. `to_regclass()` consulta el CATÁLOGO y no necesita `USAGE`, así que la guarda
     * pasa; el `SELECT` siguiente muere con `42501 permission denied for schema`. Resultado:
     * `GET /cortes/fondo-sugerido` → **500 reproducible**.
     *
     * La reparación de fondo es el `GRANT` (migración `20261014100953`). Esto es la defensa, y
     * tiene UNA regla: ⛔ **el motivo que se publica tiene que ser el verdadero.** Devolver `null`
     * a secas haría que la pantalla dijera *«no hay arqueo de custodia»* cuando lo que pasa es que
     * no se puede mirar — el defecto de `[CP.8.39]`, donde un `catch` reportó «la tabla no existe»
     * sobre un `42501` y degradó en silencio con una razón falsa durante días.
     */
    const num = (c: string) => `coalesce(nullif(btrim(${c}::text),'')::numeric, 0)`;
    let r: Record<string, unknown> | undefined;
    try {
      [r] = await trx('caja_general_ods.arqueo_movimientos')
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
    } catch (e) {
      const code = (e as { code?: string })?.code;
      // `42501` = sin permiso · `42P01` = no existe. Son dos cosas distintas y las dos se
      // registran con su nombre: la primera la arregla Sistemas con un GRANT, la segunda significa
      // que este destino no tiene el espejo de Control.
      if (code === '42501' || code === '42P01') {
        this.logger.warn(
          code === '42501'
            ? 'No se puede leer el espejo de Control (sin USAGE sobre caja_general_ods): el fondo sugerido queda sin medir, NO en cero.'
            : 'El espejo de Control no existe en este destino: el fondo sugerido queda sin medir.',
        );
        return null;
      }
      throw e;
    }
    if (!r) return null;
    void tenantId; // el espejo de Control no está particionado por tenant: es una sola caja.
    return {
      folio: String(r.folio), fecha: String(r.fecha),
      efectivo: Number(r.efectivo), billetes: Number(r.billetes), monedas: Number(r.monedas),
    };
  }

  /**
   * `[CGP-L.4]` Las jornadas del cajón con movimientos y SIN corte, de la más vieja a la más nueva:
   * lo que la pantalla ofrece cerrar, en orden. Es la MISMA consulta que usa el sensor del corte
   * abierto (`[CGP-L.10]`), con 0 h de margen: todo día que ya pasó.
   *
   * Sólo el cajón de la 00 tiene jornadas: es la Caja General (`[CG.98]`). Otra sucursal lo DECLARA
   * con `alcance`, en vez de responder una lista vacía que se leería como "todo al día".
   */
  async jornadasPendientes(sucursal: string): Promise<JornadasPendientes> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const hoy = await hoyMx(trx);
      if (sucursal !== SUCURSAL_CAJA_GENERAL) {
        return { sucursal, hoy, inicio_libro: null, jornadas: [], alcance: 'solo_cajon' as const };
      }
      const r = await jornadasSinCorte(trx, tenantId, 0);
      return { sucursal, hoy, inicio_libro: r.inicio, jornadas: r.jornadas, alcance: 'cajon' as const };
    });
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
        // ⛔ `[CG.153]` `diaDe()` y NO `String(fecha).slice(0,10)`. `fecha` es una columna `date`
        // y el driver la entrega como objeto `Date`, así que el `String()` daba **«Mon Oct 12»**
        // — en inglés, sin año, y a texto VISIBLE: *"Es con lo que quedó el corte CC-2026-00001
        // del Mon Oct 12"*. El helper correcto vivía 140 líneas más arriba, escrito para esto.
        //
        // ⚠️ Es la misma familia que `[CG.144]` («Mon Oct 19» en la semana de la deuda), que
        // además **no da `NaN` al parsearse**: JS completa el año y devuelve 2001.
        fecha: this.diaDe(previo.fecha) ?? '',
        contado: previo.contado === null || previo.contado === undefined ? null : Number(previo.contado),
        denominaciones: dens,
      });
    });
  }

  /**
   * `[CGP-L.6]` Una regla de la base violada llega como frase, no como un 500 con el SQL adentro.
   * La traducción va por NOMBRE de la regla (`caja-errores.ts`); lo que no reconoce se relanza tal
   * cual, para que siga siendo un 500 ruidoso y alguien lo mire.
   */
  private conFrase<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: unknown) => traducirErrorDeCaja(e));
  }

  async abrir(input: AbrirCorteInput, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.conFrase(this.tk.run(async (trx) => {
      const abierto = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal: input.sucursal, estado: 'borrador' }).first();
      if (abierto) {
        throw new BadRequestException(
          `La sucursal ${input.sucursal} ya tiene el corte ${abierto.folio} abierto. Cerralo antes de abrir otro.`);
      }

      /**
       * ⛔ `[CGP-L.4]` **LA FECHA SE MIRA.** La pantalla abría siempre el de HOY y esto aceptaba
       * cualquier fecha. Ponerse al día con jornadas atrasadas exige abrir fechas pasadas, y eso
       * trae lo que no tiene vuelta atrás: una fecha que todavía no pasa, o un día ANTERIOR a un
       * corte que ya existe (el posterior heredó su fondo sin ese día; un corte firmado no se
       * corrige). Primero se valida que sea fecha: consultar con "ayer" sería un error de la base.
       */
      const hoy = await hoyMx(trx);
      const formato = puedeAbrirCorte({ fecha: String(input.fecha ?? ''), hoy, mismoDia: null, posterior: null });
      if (!formato.ok) throw new BadRequestException(formato.texto);
      const mismoDia = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal: input.sucursal, fecha: input.fecha }).first('folio');
      const posterior = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, sucursal: input.sucursal })
        .where('fecha', '>', input.fecha)
        .orderBy('fecha', 'desc')
        .first('folio', trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS fecha`));
      const gate = puedeAbrirCorte({
        fecha: input.fecha, hoy,
        mismoDia: mismoDia ? { folio: mismoDia.folio } : null,
        posterior: posterior ? { folio: posterior.folio, fecha: posterior.fecha } : null,
      });
      if (!gate.ok) throw new BadRequestException(gate.texto);

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
          // `[CGP-L.4]` El fondo hereda del último cierre ANTERIOR a esta fecha. La regla de orden de
          // arriba ya impide que exista uno posterior; esto lo deja dicho en la consulta misma.
          .where('fecha', '<', input.fecha)
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
      // `[CG.155]` Por la única puerta. Acá se mandaba `d.denom_key` **crudo**: si quien abre la
      // caja no lo trae, el insert viola `NOT NULL` y la apertura devuelve 500 — el mismo defecto
      // que tiró `contar` y después `cerrar`, esperando su turno en el tercer camino.
      await this.guardarDenominaciones(trx, tenantId, c.id, 'apertura', input.apertura);
      return c;
    }));
  }

  /**
   * ⛔⛔ `[CG.155]` **EL ÚNICO camino que escribe el desglose por denominación.**
   *
   * Medido en producción el 2026-10-14, con el arqueo caído por segunda vez en dos días:
   * `POST /cortes/:id/cerrar` devolvía **500** (`null value in column "denom_key"`) después de que
   * `[CG.152]` ya hubiera arreglado el mismo defecto en `contar`. **La tabla había pasado de 0 a 6
   * filas**, o sea que el primer arreglo funcionó — y el segundo camino siguió roto.
   *
   * ⭐ Eran **TRES** caminos escribiendo la misma tabla (`abrir`, `sellarConteo`, `cerrar`) y la
   * migración que agregó `denom_key NOT NULL` actualizó uno. Arreglar el segundo a mano habría
   * dejado el tercero esperando su turno: **mientras haya tres implementaciones de la misma
   * escritura, el arreglo de una no es el arreglo del defecto.** Por eso esto no es un parche —
   * es la única puerta, y los tres llamadores pasan por acá.
   *
   * Dos reglas que la base exige y que sólo un camino cumplía:
   *
   * 1. `denom_key` es parte de la PK `(tenant_id, cut_id, momento, denom_key)` porque
   *    `denominacion` sola NO identifica: el billete de 20 y la moneda de 20 valen lo mismo y son
   *    dos renglones distintos (lo fuerza `cut_denom_par_chk`). Si quien cuenta manda la llave se
   *    respeta; si no, se deriva del catálogo, que ante un 20 sin llave **asume billete**.
   * 2. ⚠️ El borrado va **acotado por `momento`**. Sin eso, guardar el cierre borra en silencio el
   *    desglose de la APERTURA — con el que se sabe si había para dar cambio. Es el mismo defecto
   *    que `[CG.152]` cerró en un camino y que `cerrar` conservaba intacto.
   */
  private async guardarDenominaciones(
    trx: Knex.Transaction,
    tenantId: string,
    cutId: string,
    momento: 'apertura' | 'cierre',
    conteo: ConteoDenominacion[] | null | undefined,
  ) {
    await trx('finance.cash_ledger_cut_denominations')
      .where({ tenant_id: tenantId, cut_id: cutId, momento })
      .del();
    let filas;
    try {
      filas = filasDenominacion(tenantId, cutId, momento, conteo, denomKeyDeValor);
    } catch (e) {
      // `DenominacionFueraDeCatalogo` es culpa de lo que se mandó, no del servidor: sale como 400
      // con su frase, no como 500 con la traza. Misma regla que `[CG.154]`.
      if (e instanceof DenominacionFueraDeCatalogo) throw new BadRequestException(e.message);
      throw e;
    }
    if (!filas.length) return;
    await trx('finance.cash_ledger_cut_denominations').insert(filas);
  }

  /**
   * ⭐⭐ `[CG.156]` **Sellar el conteo es guardar el VEREDICTO, no sólo lo contado.**
   *
   * Acá se escribía únicamente `contado` y `morralla`. La revelación —`esperado`, `diferencia`,
   * el veredicto— se calculaba en memoria y viajaba **sólo** en la respuesta de `POST /contar`.
   * Ningún `GET` la devolvía. Medido en prod sobre `CC-2026-00001`, el único corte que existió en
   * la vida del módulo: `contado = 3,653.50`, **`esperado` y `diferencia` en NULL**.
   *
   * ⛔ La consecuencia no era cosmética: al recargar, la pantalla no tenía cómo saber que el corte
   * ya estaba contado y volvía a ofrecer «Guardar conteo», que el servidor rechaza con *«este
   * corte ya tiene un conteo sellado»*. **El corte quedaba sin poder cerrarse, ni recontarse, ni
   * volver a verse.** La ceguera del primer conteo es deliberada; esta amnesia no.
   *
   * ⚠️ Se guardan también los tres totales (`total_ingresos/gastos/depositos`): son las piernas
   * con las que se armó el `esperado`, y sin ellas un `esperado` guardado es un número que nadie
   * puede defender después. El `cut_cerrado_completo_chk` sólo los exige al cerrar, así que
   * escribirlos en borrador es compatible — verificado contra los 8 CHECK de la tabla en prod.
   */
  private async sellarConteo(trx: Knex.Transaction, tenantId: string, id: string, t: TotalesCorte, input: CerrarCorteInput) {
    await trx('finance.cash_ledger_cuts').where({ id }).update({
      contado: t.contado,
      morralla: input.morralla ?? 0,
      total_ingresos: t.ingresos,
      total_gastos: t.gastos,
      total_depositos: t.depositos,
      esperado: t.esperado,
      diferencia: t.diferencia,
      updated_at: trx.fn.now(),
    });
    /**
     * ⛔⛔ `[CG.152]` **DOS DEFECTOS DEL MISMO CAMBIO, y el segundo sólo se ve al arreglar el
     * primero.** La migración `20261006123000` agregó `denom_key` (NOT NULL, y parte de la PK
     * junto con `momento`) y actualizó el camino de APERTURA — este, el del conteo, quedó igual.
     *
     * 1. **El insert no mandaba `denom_key`** → `23502` en cada conteo. Medido en prod el
     *    2026-10-14: `POST /cortes/:id/contar` devolvía 500 y la tabla está **en cero filas**,
     *    o sea que el arqueo nunca pudo cerrarse desde que la columna existe.
     *
     * 2. ⚠️ **El `del()` no filtraba por `momento`**, así que borraba también el desglose de
     *    APERTURA. Hoy no se perdió nada porque el insert fallaba y la transacción se revertía
     *    entera — pero arreglar sólo el insert habría convertido un error visible en **pérdida
     *    silenciosa** del desglose con el que arrancó la caja. Por eso van juntos.
     *
     * ⚠️ `denominacion` sola NO identifica: el billete de $20 y la moneda de $20 valen lo mismo
     * y son dos renglones distintos (lo fuerza `cut_denom_par_chk` en la base). Si quien cuenta
     * manda la llave, se respeta; si no, se deriva del catálogo compartido, que ante un $20 sin
     * llave **asume billete y lo declara**. El total contado no cambia —las dos valen 20—; lo
     * que se pierde es el desglose por familia.
     */
    // `[CG.155]` Por la única puerta. Acá vivía la TERCERA copia de esta escritura; dejarla habría
    // repetido el defecto que tiró producción dos días seguidos.
    await this.guardarDenominaciones(trx, tenantId, id, 'cierre', input.conteo);
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
    return this.conFrase(this.tk.run(async (trx) => {
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');
      if (c.estado !== 'borrador') throw new BadRequestException(TEXTO_NO_CIERRA['no_es_borrador']);
      // Sellar dos veces sin motivo sería recontar por la puerta de atrás.
      // `[CGP-V.9]` `!= null` y no `> 0`: un cero sellado también es un conteo, y con `> 0` se podía
      // volver a sellar por la puerta de atrás, sin reconteo ni motivo.
      if (c.contado != null || c.conteo_previo != null) {
        throw new BadRequestException(
          'Este corte ya tiene un conteo sellado. Para cambiarlo hay que recontar, y el reconteo pide motivo.',
        );
      }

      const movs = await this.movimientosSueltos(trx, tenantId, c.sucursal, this.diaDe(c.fecha));
      // [CG.96] Las dos piernas del cajero desde que abrio ESTE corte. Mismo origen que usa
      // `saldo()`; sin esto el esperado ignora la boveda y pide contar lo que esta en la maquina.
      const cajero = await this.conciliacionCajero(trx, tenantId, c.sucursal, c.fecha ?? null);
      rechazarCeroContradictorio(input);
      const totales = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo: input.conteo, morralla: input.morralla ?? 0, ceroDeclarado: input.cero_declarado === true,
      });
      if (totales.veredicto === 'sin_contar') throw new BadRequestException(TEXTO_NO_CIERRA['sin_conteo']);

      await this.sellarConteo(trx, tenantId, id, totales, input);
      // Recién acá se revela: el conteo ya está escrito y no se puede retocar en silencio.
      return { corte_id: id, sellado_por: u.username ?? u.id, totales, puede_recontar: totales.veredicto !== 'cuadra' };
    }));
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
    return this.conFrase(this.tk.run(async (trx) => {
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');
      // `[CGP-L.3]` Un reconteo sin conteo previo no existe. Antes pasaba el gate (un corte sin contar
      // no "cuadra") y lo frenaba recién la base, con un error crudo.
      if (c.estado === 'borrador' && c.contado == null) {
        throw new BadRequestException(TEXTO_NO_RECUENTA['sin_conteo_previo']);
      }

      const movs = await this.movimientosSueltos(trx, tenantId, c.sucursal, this.diaDe(c.fecha));
      // [CG.96] Las dos piernas del cajero desde que abrio ESTE corte. Mismo origen que usa
      // `saldo()`; sin esto el esperado ignora la boveda y pide contar lo que esta en la maquina.
      const cajero = await this.conciliacionCajero(trx, tenantId, c.sucursal, c.fecha ?? null);
      // `[CGP-L.3]` Sólo el desglose de CIERRE: el de apertura (el fondo contado al abrir) no es el
      // conteo que se reemplaza, y sumarlo inflaba el "primer conteo" que queda de constancia.
      const previos = await trx('finance.cash_ledger_cut_denominations')
        .where({ tenant_id: tenantId, cut_id: id, momento: 'cierre' })
        .select('denom_key', 'denominacion', 'piezas');
      const totalesPrevios = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo: previos as ConteoDenominacion[], morralla: Number(c.morralla ?? 0),
        // `[CGP-V.9]` Un primer conteo sellado en cero fue un conteo, no «sin contar».
        ceroDeclarado: c.contado != null && Number(c.contado) === 0,
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

      rechazarCeroContradictorio(input);
      const totales = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo: input.conteo, morralla: input.morralla ?? 0, ceroDeclarado: input.cero_declarado === true,
      });
      if (totales.veredicto === 'sin_contar') throw new BadRequestException(TEXTO_NO_CIERRA['sin_conteo']);
      await this.sellarConteo(trx, tenantId, id, totales, input);

      return { corte_id: id, totales, conteo_previo_contado: Number(c.contado ?? 0), puede_recontar: false };
    }));
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
    return this.conFrase(this.tk.run(async (trx) => {
      // `forUpdate` sobre el CORTE: dos cierres simultáneos del mismo corte se serializan acá.
      const c = await trx('finance.cash_ledger_cuts')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!c) throw new NotFoundException('Corte no encontrado');
      if (c.estado !== 'borrador') throw new BadRequestException(TEXTO_NO_CIERRA['no_es_borrador']);

      /**
       * ⛔ `[CGP-L.1]` **CON QUÉ CONTEO SE CIERRA, decidido ANTES de escribir nada.**
       *
       * Un conteo sellado no se cambia al cerrar. `[CG.159]` reusaba el sellado sólo si el cuerpo
       * venía vacío, y si traía OTRA cifra la usaba y reescribía el desglose sellado: contar, ver el
       * esperado, teclear otra cosa y cerrar saltaba el arqueo ciego sin recontar y sin motivo.
       * Desde `[CGP-D.3]` la base lo frena con un error crudo; acá se decide antes de atar un solo
       * movimiento, y la persona recibe qué está sellado, qué tecleó y cómo se corrige.
       */
      const sellado = c.contado != null ? await this.leerSellado(trx, tenantId, id, c.morralla) : null;
      const decision = decidirConteoDelCierre(sellado, { conteo: input.conteo, morralla: input.morralla });
      if (decision.usar === 'rechazo') {
        throw new BadRequestException(textoConteoDistinto(decision.sellado, decision.tecleado));
      }
      const conteo = decision.usar === 'sellado' && sellado ? sellado.conteo : input.conteo;
      const morralla = decision.usar === 'sellado' && sellado ? sellado.morralla : (input.morralla ?? 0);
      if (decision.usar === 'sellado') {
        this.logger.log(`cierre del corte ${id}: se usa el conteo ya sellado (${conteo?.length ?? 0} renglones).`);
      }

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
      /**
       * ⛔⛔ `[CG.160]` **ACÁ DECÍA `.where({ tenant_id, sucursal: c.sucursal })`, Y ESA ES LA
       * OTRA MITAD DEL INVARIANTE — la del EJE SUCURSAL.**
       *
       * `[CG.115]` arregló el eje FECHA ("el conjunto atado y el sumado son el mismo por
       * construcción") y dejó el de la plaza al revés: `contar()`, `recontar()` y `saldo()` leen
       * por `movimientosSueltos()`, que aplica `aplicarAlcanceCaja` —el cajón de oficinas es UNO
       * y ve todas las plazas, `[CG.98]`—, mientras **cerrar() ataba y sumaba sólo la `00`**.
       *
       * O sea que el conteo se selló contra un universo y el cierre lo iba a juzgar contra otro.
       * Es el espejo de ADR-059 aplicado a dos funciones hermanas: ninguna podía contradecir a la
       * otra porque nadie las comparó.
       *
       * ⭐ Medido en prod el 2026-10-14 sobre `CC-2026-00001` (12-oct), al centavo:
       *
       *     gastos de la 00 .................. $18,973.00
       *     gastos de 01/05/06/07/08 ......... $39,737.05   <- quedaban fuera
       *
       *     esperado que iba a firmar ....  $43,139.50  ->  diferencia  −$39,486.00  (faltante)
       *     esperado real ................   $3,402.45  ->  diferencia     +$251.05  (sobrante)
       *
       * El faltante de casi cuarenta mil pesos **no existe**: es exactamente la nómina y los
       * gastos que otras plazas pagaron desde este mismo cajón, que `cash_ledger.sucursal`
       * etiqueta con la plaza del DOCUMENTO y no con dónde estaba el efectivo. Cerrar sin esto
       * dejaba firmado, y sin vuelta atrás, un arqueo que acusa a Carmen de un faltante inventado.
       *
       * ⚠️ El día que una plaza tenga su propio cajón, `aplicarAlcanceCaja` ya la acota a lo suyo
       * — es la misma advertencia que lleva esa función desde `[CG.98]`.
       */
      const base = () => this.sueltosDe(trx, tenantId, c.sucursal, dia);

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

      // El conteo y la morralla salen de la decisión de `[CGP-L.1]`, arriba: el sellado cuando lo hay
      // (`[CG.159]`: la pantalla después de recargar manda el cuerpo vacío), el del cuerpo sólo en un
      // corte que nunca se contó.
      // `[CGP-V.9]` Un conteo sellado en cero se firma como cero; sin sellar, el cuerpo lo declara.
      if (decision.usar !== 'sellado') rechazarCeroContradictorio(input);
      const ceroDeclarado = decision.usar === 'sellado'
        ? Number(c.contado) === 0
        : input.cero_declarado === true;
      const t = calcularCorte({
        fondoInicial: fondo(c), movimientos: movs, cajeroSinCapturar: cajero,
        conteo, morralla, ceroDeclarado,
      });

      const gate = puedeCerrar(c, u.id, t);
      if (!gate.ok) throw new BadRequestException(TEXTO_NO_CIERRA[gate.motivo!]);

      /**
       * ⛔ `[CGP-L.2]` **LO QUE SE FIRMA ES LO QUE SE REVELÓ.** El esperado se recalcula con el
       * universo de ESTE momento; si entró un movimiento de la jornada después de contar, antes se
       * firmaba el número nuevo sin decirlo. Ahora es un 409 con las dos cifras, y quien ya vio el
       * nuevo lo confirma con `esperado_visto`. Lanzarlo acá revierte también lo que se acaba de atar.
       */
      const cambio = esperadoCambio(c.esperado == null ? null : Number(c.esperado), t.esperado, input.esperado_visto);
      if (cambio.cambio && cambio.contra != null) {
        // Con DATOS y no sólo texto: la pantalla los necesita para ofrecer "confirmar el esperado
        // nuevo y cerrar" sin recalcular nada por su cuenta (dos cálculos de lo mismo divergen).
        throw new ConflictException({
          message: textoEsperadoCambio(cambio.contra, t.esperado),
          motivo: 'esperado_cambio',
          esperado_mostrado: cambio.contra,
          esperado_actual: t.esperado,
        });
      }

      const [cerrado] = await trx('finance.cash_ledger_cuts').where({ id }).update({
        estado: 'cerrado',
        closed_by: u.id, closed_by_username: u.username ?? null, closed_at: trx.fn.now(),
        total_ingresos: t.ingresos, total_gastos: t.gastos, total_depositos: t.depositos,
        esperado: t.esperado, contado: t.contado, diferencia: t.diferencia,
        /**
         * ⛔ `[CG.160]` **`morralla`, NO `input.morralla ?? 0`.** Con el respaldo de `[CG.159]` el
         * cuerpo puede venir vacío, y entonces esto PISABA con `0` la morralla sellada — mientras
         * `calcularCorte()` acababa de usar la verdadera. El corte quedaba firmado con un
         * `contado` que incluye la morralla y una columna `morralla` que dice que no hubo: dos
         * campos del mismo hecho contradiciéndose, y la contradicción no la ve ningún CHECK.
         *
         * Es el mismo defecto que el `guardarDenominaciones` de doce líneas abajo ya tenía
         * anotado, esperando en la columna de al lado.
         */
        morralla: morralla ?? 0, nota: input.nota ?? c.nota, updated_at: trx.fn.now(),
      }).returning('*');

      // `[CG.155]` Por la única puerta. Acá vivía la tercera copia de esta escritura —sin
      // `denom_key`, sin `momento` y con el borrado SIN acotar— y es la que tiró producción el
      // 2026-10-14 con un 500 en `/cerrar`, un día después de arreglar la copia de `contar`.
      //
      // ⚠️ `conteo`, NO `input.conteo`: con el respaldo de `[CG.159]` el cuerpo puede venir vacío,
      // y entonces esto REESCRIBIRÍA el desglose sellado con nada — borrando en silencio el conteo
      // que acaba de usarse para calcular el cierre. Es la misma clase de borrado sin acotar que
      // `[CG.155]` cerró; reaparece por otra puerta en cuanto el origen del conteo deja de ser uno.
      await this.guardarDenominaciones(trx, tenantId, id, 'cierre', conteo);

      return { ...cerrado, totales: t };
    }));
  }

  async autorizar(id: string, user: Usuario) {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.conFrase(this.tk.run(async (trx) => {
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
    }));
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
    if (sucursal !== SUCURSAL_CAJA_GENERAL) return null;
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

  /**
   * ⭐⭐ `[CG.156]` **Lo que ya se selló se puede volver a leer. Lo que no, sigue ciego.**
   *
   * El servidor nunca publicaba que un corte YA tenía conteo: `saldo()` mandaba `ya_reconto`
   * —que responde *«¿ya recontó?»*, no *«¿ya contó?»*— y `contado` no viajaba en ningún endpoint.
   * Así que al recargar, la pantalla sólo podía ofrecer «Guardar conteo», que el servidor rechaza.
   *
   * ⛔ **Esto NO afloja el conteo ciego.** La distinción es exacta y es toda la lógica de acá:
   *
   *   · corte **sin** sellar → `null`. No hay nada que leer, y el `esperado` sigue oculto detrás
   *     del candado `revela` de `saldo()`. Ver la diferencia mientras se teclea convierte el
   *     arqueo en una transcripción del esperado — lo que `[CG.19]` revirtió a propósito.
   *   · corte **ya** sellado → el veredicto completo. El conteo está escrito y no se puede
   *     retocar en silencio: cambiarlo exige `recontar()`, que pide motivo y deja rastro. Negarlo
   *     acá no protege nada, sólo esconde una revelación que **ya ocurrió**.
   *
   * ⚠️ `esperado` y `diferencia` pueden venir en `null` aunque haya `contado`: son los cortes
   * sellados ANTES de `[CG.156]`, cuando el veredicto no se guardaba. Se declara con
   * `veredicto: 'sin_medir'` en vez de recalcularlos — recalcular hoy daría el juicio de HOY sobre
   * un conteo de ayer, que es otra cosa y nadie podría distinguirla.
   */
  private conteoSellado(
    c: { contado?: unknown; esperado?: unknown; diferencia?: unknown; fondo_inicial?: unknown; conteo_previo?: unknown } | null | undefined,
    desglose?: ConteoSellado | null,
  ) {
    if (!c) return null;
    const contado = c.contado == null ? null : Number(c.contado);
    // `[CGP-V.9]` Sólo `null` es «nadie contó». Un cero sellado se publica: si no, la pantalla volvía
    // a ofrecer «Guardar conteo» sobre un corte que ya tiene conteo, y el servidor lo rechazaba.
    if (contado == null) return null;
    const esperado = c.esperado == null ? null : Number(c.esperado);
    const diferencia = c.diferencia == null ? null : Number(c.diferencia);
    return {
      contado,
      esperado,
      diferencia,
      // Un corte sellado antes de que el veredicto se guardara: se DECLARA, no se recalcula.
      veredicto: esperado == null || diferencia == null
        ? ('sin_medir' as const)
        : veredictoDe({ huboConteo: true, fondoSinMedir: c.fondo_inicial == null, diferencia }),
      ya_reconto: c.conteo_previo != null,
      /**
       * `[CGP-V.2]` Lo que se selló, pieza por pieza. Sin esto la pantalla sólo tenía el total: al
       * reabrir el diálogo la reja salía en blanco junto a un «Contado» con cifra, y quedaba abierta
       * para teclear otra cosa. Con el desglose la reja muestra lo sellado, de sólo lectura.
       * Opcional: el resumen de la jornada (`arqueoDia`) no lo pide.
       */
      ...(desglose ? { desglose: desglose.conteo, morralla: desglose.morralla } : {}),
    };
  }

  /**
   * El conteo sellado de un corte, pieza por pieza: el desglose del CIERRE (el de apertura ya pasó)
   * y la morralla, que vive en el corte. Lo leen `cerrar()`, para decidir qué se firma, y `saldo()`,
   * para que la pantalla lo muestre. Una sola lectura para las dos, así no pueden divergir.
   */
  private async leerSellado(trx: Knex.Transaction, tenantId: string, cutId: string, morralla: unknown): Promise<ConteoSellado> {
    const filas = await trx('finance.cash_ledger_cut_denominations')
      .where({ tenant_id: tenantId, cut_id: cutId, momento: 'cierre' })
      .orderBy('denominacion', 'desc')
      .select('denom_key', 'denominacion', 'piezas');
    return {
      conteo: filas.map((d: { denom_key: string; denominacion: string | number; piezas: string | number }) => ({
        denom_key: d.denom_key, denominacion: Number(d.denominacion), piezas: Number(d.piezas),
      })),
      morralla: Number(morralla ?? 0),
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
      // `[CGP-V.2]` El desglose sólo cuando hay conteo: sin sellar no hay nada que mostrar.
      const desglose = abierto?.contado != null
        ? await this.leerSellado(trx, tenantId, abierto.id, abierto.morralla) : null;
      return {
        sucursal,
        corte_abierto: abierto
          ? {
            id: abierto.id, folio: abierto.folio, fondo_inicial: fondo(abierto),
            // `[CGP-L.4]` Qué jornada es: con cortes atrasados, el diálogo de cierre tiene que decirlo.
            fecha: this.diaDe(abierto.fecha),
            // Que ya se recontó NO es secreto: no revela el esperado y la pantalla necesita
            // saberlo para apagar el botón antes de que el usuario lo intente.
            ya_reconto: abierto.conteo_previo != null,
            /**
             * `[CG.156]` ⭐ El conteo YA sellado, para que recargar no borre la revelación.
             * `null` mientras nadie contó — y ahí el `esperado` sigue oculto por `revela`.
             */
            conteo_sellado: this.conteoSellado(abierto, desglose),
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
      // `[CG.139]` Lee del reparto, no de la tabla: ahí vive `en_boveda`, y es la MISMA expresión
      // que usa `movimientosSueltos()`. La vista ya excluye lo borrado (por eso se va el
      // `whereNull('deleted_at')`, que sobre la vista sería una columna inexistente).
      const [libro] = await trx('analytics.v_caja_reparto_movimiento')
        .where({ tenant_id: tenantId })
        // `[CG.98]` La caja general es UNA: en oficinas se ven todas las plazas.
        .where((b: any) => aplicarAlcanceCaja(b, sucursal))
        .whereRaw(`created_at >= (?::date) AT TIME ZONE 'America/Mexico_City'`, [dia])
        .whereRaw(`created_at <  ((?::date) + 1) AT TIME ZONE 'America/Mexico_City'`, [dia])
        .select(
          trx.raw(`count(*) FILTER (WHERE estado <> 'cancelado')::int AS movimientos`),
          trx.raw(`count(*) FILTER (WHERE estado = 'cancelado')::int AS cancelados`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='ingreso'),0)::numeric AS ingresos`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='gasto'),0)::numeric AS gastos`),
          trx.raw(`coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='deposito'),0)::numeric AS depositos`),
          /**
           * ⭐⭐ `[CG.139]` **LO QUE SE FUE A LA MÁQUINA, QUE NO ES CAJA GENERAL.**
           *
           * Edgar: *"se asocia a un movimiento de CAOS, pero el dinero que entró a CAOS y el
           * dinero que entró a caja chica es diferente. Se engloban en movimiento pero se separan
           * en dinero"*.
           *
           * Por eso se suma `en_boveda` y **no** se cuentan movimientos enteros: un cobro de ruta
           * es UN movimiento y DOS destinos. Medido en prod: los tres cobros de hoy suman $49,457
           * y de ahí **$49,400 se los tragó la máquina y $57 quedaron en el cajón** — la máquina
           * no maneja monedas, todos sus montos son múltiplos de 20.
           *
           * El reparto sale de `analytics.v_caja_reparto_movimiento` (`[CG.139]`), que es la
           * única definición: antes el `CASE` estaba escrito a mano en `movimientosSueltos()` y
           * cualquier consulta nueva lo reescribía — así es como aparecen dos cifras distintas
           * del mismo hecho.
           */
          trx.raw(`coalesce(sum(en_boveda) FILTER (WHERE estado <> 'cancelado' AND tipo='ingreso'),0)::numeric AS ingresos_en_boveda`),
          trx.raw(`coalesce(sum(en_boveda) FILTER (WHERE estado <> 'cancelado' AND tipo='gasto'),0)::numeric AS gastos_en_boveda`),
          // Cuántos movimientos se partieron de verdad entre las dos cajas. Se publica para que
          // «se separan en dinero» sea algo que la pantalla pueda decir, no una regla implícita.
          trx.raw(`count(*) FILTER (WHERE estado <> 'cancelado' AND en_boveda > 0)::int AS tocaron_boveda`),
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
      const ingresosEnBoveda = Number(libro?.ingresos_en_boveda ?? 0);
      const gastosEnBoveda = Number(libro?.gastos_en_boveda ?? 0);

      /**
       * ⭐⭐ `[CG.139]` **UN MOVIMIENTO, DOS CAJAS: el dinero se separa aunque el movimiento sea
       * uno solo.**
       *
       * Edgar: *"si entró a CAOS no se considera en caja general"*, y después, corrigiéndome el
       * modelo: *"se asocia a un movimiento de CAOS, pero el dinero que entró a CAOS y el dinero
       * que entró a caja chica es diferente. Se engloban en movimiento pero se separan en
       * dinero"*.
       *
       * Medido en prod el 2026-10-13, sucursal `00`:
       *
       *     de los $290,525 publicados como ingreso de caja general,
       *     $203,662 se los quedó la máquina   ·   $86,863 llegaron al cajón
       *
       * Y el reparto no es por movimiento sino por peso: los depósitos que un vendedor hizo en el
       * cajero van 100% a la bóveda, pero un cobro de ruta se **parte** — medido sobre los tres
       * del 10 al 12 de octubre, $49,400 de billetes adentro de la máquina y **$57 de morralla**
       * en el cajón, porque el aparato no acepta monedas (todos sus montos son múltiplos de 20).
       *
       * ⛔ Por eso NO sirve una columna que diga «este movimiento es de tal caja», que fue mi
       * primer intento: clasificarlo entero se come los $57 o publica los $49,400. El reparto se
       * mide en dinero, y vive en `analytics.v_caja_reparto_movimiento`.
       *
       * ⚠️ **Se descuenta de los DOS lados, siempre.** Lo que la máquina recibió sale junto con el
       * ingreso y lo que dispensó junto con el gasto. Quitar una pierna sin la otra fabrica un
       * faltante del tamaño exacto de lo que se quitó — el error simétrico que `[CG.95]` ya pagó.
       *
       * ⭐ **El esperado y el saldo no se mueven un centavo**: ya excluían la bóveda desde
       * `[CG.96]`, por la vía de las dos piernas de la máquina, que no dependen de que alguien
       * enlace. Lo que cambia es que el cuadro deja de **afirmar** un movimiento que no ocurrió
       * en caja general.
       */
      const ingresosCajon = Number((ingresos - ingresosEnBoveda).toFixed(2));
      const gastosCajon = Number((gastos - gastosEnBoveda).toFixed(2));

      // ── 2. El cajero (CAOS): la jornada COMPLETA, con los seis tipos ─────────────────────
      // ⚠️ CAOS no tiene columna de sucursal: es un único dispositivo, en oficinas. Para cualquier
      // otra sucursal se devuelve `null` y se DICE por qué, en vez de mostrar ceros que se leerían
      // como "el cajero no se movió".
      const hayCaos = (await trx.raw(`SELECT to_regclass('analytics.caos_cash_movements') AS t`))
        .rows?.[0]?.t;
      let cajero: Record<string, unknown> | null = null;
      if (hayCaos && sucursal === SUCURSAL_CAJA_GENERAL) {
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
        // `[CG.156]` Las cuatro de abajo son nuevas: sin ellas `conteoSellado()` devuelve `null`
        // SIEMPRE y en silencio — un `SELECT` recortado no falla, miente.
        .first('id', 'folio', 'fecha', 'fondo_inicial', 'fondo_origen',
               'contado', 'esperado', 'diferencia', 'conteo_previo');

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
      } else if (sucursal !== SUCURSAL_CAJA_GENERAL) {
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
          /**
           * ⭐ `[CG.139]` El reparto de ESTE renglón entre las dos cajas. Hace falta por renglón
           * —y no sólo en el total— porque el selector de la lista cambia **qué dinero** se
           * muestra, no qué filas: un cobro de ruta sale en las tres vistas, con la cifra que le
           * toca a cada caja. Sale de la misma vista que el total, así que no pueden discrepar.
           */
          trx.raw(`(SELECT r.en_boveda FROM analytics.v_caja_reparto_movimiento r
                     WHERE r.cash_ledger_id = finance.cash_ledger.id) AS en_boveda`),
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

      /**
       * ⛔ `[CG.141.2]` **Las dos mitades del cajón se calculan UNA vez y viajan juntas.**
       *
       * Antes se calculaban en línea, cada una en su propiedad, las dos con el mismo
       * `cajero ? … : null`. Funcionaba, pero el contrato las declaraba nullables **por separado**
       * y la pantalla pinta `a_la_boveda!` bajo la guarda de `en_el_cajon != null` — o sea que el
       * día que una se volviera `null` por su cuenta, la pantalla dibujaba **$0.00 sin avisar**
       * (lo marcó la sesión de frontend auditando su lado).
       *
       * ⭐ El acoplamiento es real —las dos salen del MISMO feed del cajero— así que ahora lo dice
       * el dato: `cajon` es un solo objeto nullable. Y de paso se calculan una sola vez: este
       * archivo ya declara dos renglones más arriba que *"una resta que viaja dos veces es una
       * resta que puede llegar distinta"*.
       *
       * ⚠️ Los campos planos se CONSERVAN con su forma exacta mientras la pantalla desplegada
       * migra — el mismo criterio con el que `coverage()` conserva su `ingresos`. Se retiran
       * cuando el front consuma `cajon`, no antes: quitarlos ahora deja el bloque en blanco sin
       * ningún error.
       */
      const cajon = cajero
        ? {
          en_el_cajon: Number((ingresosCajon - gastosCajon - depositos
            + (Number(cajero['dispensado'] ?? 0) - gastosEnBoveda)
            - (Number(cajero['depositado'] ?? 0) - ingresosEnBoveda)).toFixed(2)),
          a_la_boveda: Number(((Number(cajero['depositado'] ?? 0) - ingresosEnBoveda)
            - (Number(cajero['dispensado'] ?? 0) - gastosEnBoveda)).toFixed(2)),
        }
        : null;

      return {
        fecha: dia,
        sucursal,
        // `[CG.91]` La lista, no sólo el conteo.
        movimientos_del_dia: movimientosDelDia.map((m: any) => ({
          id: m.id, folio: m.folio, hora: m.hora, tipo: m.tipo,
          monto: Number(m.monto), beneficiario: m.beneficiario,
          // `[CG.139]` Las dos mitades del mismo renglón. `en_cajon` se deriva acá y no se trae
          // aparte: una resta que viaja dos veces es una resta que puede llegar distinta.
          en_boveda: Number(m.en_boveda ?? 0),
          en_cajon: Number((Number(m.monto) - Number(m.en_boveda ?? 0)).toFixed(2)),
          documento: m.documento || null, concepto: m.kepler_concepto_nombre ?? null,
          cuenta: m.kepler_cuenta ?? null, estado: m.estado,
          origen: m.origen_tipo ?? null, quien: m.created_by_username ?? null,
        })),
        caja_general: {
          movimientos: Number(libro?.movimientos ?? 0),
          cancelados: Number(libro?.cancelados ?? 0),
          // `[CG.139]` Sólo la parte de cada movimiento que pasó por el CAJÓN. Lo que se quedó la
          // máquina viaja aparte, en `se_fue_a_boveda`, y no suma acá.
          ingresos: ingresosCajon, gastos: gastosCajon, depositos,
          // Lo que el día le dejó a la caja chica según el libro. Sin fondo inicial: eso compone el
          // `esperado` del corte y vive gateado en `saldo()` (CG.19, arqueo ciego).
          neto: Number((ingresosCajon - gastosCajon - depositos).toFixed(2)),
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
          // ⚠️ `[CG.141.2]` Sale de `cajon`, que es donde vive el cálculo. Se conserva plano para
          // no romper la pantalla desplegada mientras migra; no se recalcula acá.
          en_el_cajon: cajon?.en_el_cajon ?? null,
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
          /**
           * `[CG.97]` Lo que de la jornada se fue a la bóveda, neto. Positivo = la bóveda creció.
           *
           * ⭐ `[CG.139]` **Sólo el efectivo que CRUZÓ el cajón.** Antes era `depositado −
           * dispensado` a secas, o sea el movimiento entero de la máquina — y ahí adentro estaban
           * los $186,402 que un vendedor le entregó directo, que nunca pasaron por el cajón. Un
           * renglón que dice «de eso, a la bóveda» tiene que hablar de *eso*: del movimiento del
           * libro de arriba. Las dos piernas se descuentan de su propio lado.
           */
          // ⚠️ `[CG.141.2]` Igual que su mitad: sale de `cajon`, no se recalcula.
          a_la_boveda: cajon?.a_la_boveda ?? null,

          /**
           * `[CG.139]` La parte de la jornada que se quedó la máquina, y por eso **no está** en
           * `ingresos` ni en `gastos`. Se publica para que lo excluido sea un número y no un hueco.
           *
           * ⚠️ `movimientos` cuenta cuántos **tocaron** la bóveda, no cuántos «son de CAOS»: un
           * cobro de ruta toca las dos cajas y se cuenta acá igual, con su parte.
           */
          se_fue_a_boveda: {
            ingresos: ingresosEnBoveda, gastos: gastosEnBoveda,
            movimientos: Number(libro?.tocaron_boveda ?? 0),
          },
          /**
           * `[CG.141.2]` Las dos mitades del cajón, ACOPLADAS como vienen: o están las dos o no
           * está ninguna. `null` = no hay cajero (cualquier sucursal que no sea OFICINAS, o el
           * feed caído), que es distinto de «quedó en cero».
           */
          cajon,
        },
        cajero,
        corte_abierto: corte
          ? {
            // `[CG.153]` Mismo defecto que arriba: el contrato declara `fecha: string` con
            // sentido de fecha y el API estaba mandando «Mon Oct 12». Hoy ningún componente la
            // pinta — por eso no costó nada todavía, no porque esté bien.
            id: corte.id, folio: corte.folio, fecha: this.diaDe(corte.fecha) ?? '',
            // `[CG.90.1]` Si el fondo se midió o no. La pantalla ofrece declararlo SOLO cuando
            // falta; sin este campo el botón saldría siempre, incluso con el fondo ya puesto.
            // ⚠️ `fondo()` devuelve `null` cuando no se midió — NO `0`, que sería "arrancó vacía".
            fondo_inicial: fondo(corte), fondo_origen: corte.fondo_origen ?? null,
            /**
             * `[CG.156]` ⭐ El conteo YA sellado. Sin esto, el cierre de jornada no podía decir si
             * el corte del día estaba contado — y la pantalla volvía a ofrecer sellarlo.
             */
            conteo_sellado: this.conteoSellado(corte),
          }
          : null,
        no_medido,
        limites,
      };
    });
  }

  /** Cancela un movimiento. No se borra: se marca, con motivo y autor. */
  /**
   * `[CG.128]` **A quién contradice el árbitro.** No corrige: lista.
   *
   * ⚠️ Sólo movimientos **sin sellar**. Los que ya entraron a un corte quedan fuera a propósito:
   * no se pueden reclasificar, así que ofrecerlos sería ofrecer un botón que va a fallar.
   */
  async porReclasificar(): Promise<{ filas: PorReclasificar[]; total: number; monto: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const filas = await trx('analytics.v_caja_por_reclasificar')
        .where({ tenant_id: tenantId })
        .orderBy([{ column: 'fecha', order: 'asc' }, { column: 'folio', order: 'asc' }])
        .limit(500)
        .select('*');
      return {
        filas,
        total: filas.length,
        monto: filas.reduce((a: number, f: { monto: string | number }) => a + Number(f.monto || 0), 0),
      };
    });
  }

  /**
   * ⭐⭐ `[CG.128]` **Corregir la cuenta de un movimiento, con rastro.**
   *
   * Edgar: *"necesitamos corregir esos ingresos y no dejar que vuelva a pasar"*. La segunda mitad
   * la cierra `[CG.127]` (el autollenado del ingreso ya propone la cuenta del árbitro); ésta es la
   * primera: **hasta hoy no existía ninguna forma de corregir un movimiento guardado.** Se podía
   * editar una REGLA y se podía CANCELAR el movimiento, pero cambiarle la cuenta no — por eso los
   * 25 ingresos seguían mal.
   *
   * ⛔ **Lo sellado NO se toca.** Un corte firmado describe un hecho; reescribirlo por detrás
   * dejaría un cuadre que alguien firmó describiendo otra cosa. Mismo criterio que
   * `cancelarMovimiento`, y mismo molde de bloqueo: se toma el MOVIMIENTO, nunca el corte —
   * `cerrar()` toma el corte primero y tomarlo acá sería el orden inverso (deadlock).
   *
   * ⭐ La cuenta nueva **no la elige quien corrige**: la dice el árbitro
   * (`analytics.v_caja_contracuenta_cobro`, la póliza del propio Kepler). Dejar escribirla a mano
   * sería repetir el problema que esto viene a cerrar, con un clic menos.
   */
  async reclasificar(id: string, motivo: string, user: Usuario): Promise<Record<string, unknown>> {
    const u = this.requireUser(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const m0 = String(motivo ?? '').trim();
    if (m0.length < 12) {
      throw new BadRequestException(
        'Explicá por qué se reclasifica, con al menos 12 caracteres. Una corrección sin razón '
        + 'escrita es indistinguible de un ajuste para que cuadre.');
    }
    return this.tk.run(async (trx) => {
      const m = await trx('finance.cash_ledger')
        .where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!m) throw new NotFoundException('Movimiento no encontrado');
      if (m.estado === 'cancelado') {
        throw new BadRequestException('Este movimiento está cancelado: no hay nada que reclasificar.');
      }
      if (m.corte_id) {
        throw new BadRequestException(
          'Este movimiento ya entró a un corte: no se reclasifica sin mover un cuadre que alguien '
          + 'firmó. Registrá un movimiento que lo corrija.');
      }

      const a = await trx('analytics.v_caja_contracuenta_cobro')
        .where({ tenant_id: tenantId, sucursal: m.sucursal })
        .first('cuenta', 'concepto', 'renglones');
      if (!a?.cuenta || !a?.concepto) {
        // ⛔ Sin árbitro no se inventa una cuenta: se declara y no se toca nada.
        throw new BadRequestException(
          `No hay cuenta derivada de la póliza para la sucursal ${m.sucursal}: no se reclasifica a ciegas.`);
      }
      if (String(m.kepler_cuenta) === String(a.cuenta) && String(m.kepler_concepto) === String(a.concepto)) {
        throw new BadRequestException('Este movimiento ya tiene la cuenta que dice la póliza.');
      }

      // El nombre del par NUEVO sale del catálogo vivo, igual que en `create()`: sin esto el
      // snapshot quedaría con el nombre de la cuenta VIEJA y la pantalla mentiría.
      const nombres = await this.resolverNombres(trx, tenantId, m.sucursal, a.cuenta, a.concepto);

      // ⭐ La bitácora va ANTES del UPDATE: si el UPDATE falla, la trx revierte las dos; si fuera
      // al revés, un fallo entre medio dejaría el cambio hecho y sin explicación.
      await trx('finance.cash_ledger_reclasificaciones').insert({
        tenant_id: tenantId, cash_ledger_id: id,
        de_cuenta: m.kepler_cuenta ?? null, de_concepto: m.kepler_concepto ?? null,
        a_cuenta: String(a.cuenta), a_concepto: String(a.concepto),
        origen: 'arbitro', respaldo: Number(a.renglones ?? 0) || null,
        motivo: m0, corte_id: m.corte_id ?? null,
        hecho_por: u.id, hecho_por_username: u.username ?? null,
      });

      const [out] = await trx('finance.cash_ledger').where({ id }).update({
        kepler_cuenta: String(a.cuenta), kepler_concepto: String(a.concepto),
        kepler_cuenta_nombre: nombres.cuenta_nombre, kepler_concepto_nombre: nombres.concepto_nombre,
        updated_by: u.id, updated_at: trx.fn.now(),
      }).returning('*');
      return out;
    });
  }

  /** Los nombres del par, del catálogo vivo. `null` si el catálogo no los tiene: nunca inventados. */
  private async resolverNombres(trx: Knex.Transaction, tenantId: string, sucursal: string, cuenta: string, concepto: string) {
    const k = await trx('analytics.v_kepler_conceptos')
      .where({ tenant_id: tenantId, sucursal, cuenta, concepto })
      .first('concepto_nombre');
    const acc = await trx('finance.kepler_accounts')
      .where({ tenant_id: tenantId, cuenta }).first('cuenta_nombre');
    return {
      concepto_nombre: (k?.concepto_nombre ?? null) as string | null,
      cuenta_nombre: (acc?.cuenta_nombre ?? null) as string | null,
    };
  }

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
