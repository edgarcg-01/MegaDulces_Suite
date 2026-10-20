import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, ageHuman } from '@megadulces/platform-core';
import { SUCURSAL_CAJA_GENERAL } from '@megadulces/contracts';
import type {
  CruceArqueoDia, CruceArqueoLadoSuite, CruceArqueosResponse,
} from '@megadulces/contracts';

/**
 * `[CG.105]` — **El expediente diario de Caja General y el historial de cortes.**
 *
 * Edgar, 2026-10-13: *"necesito que generes un historial de cortes diario, y un expediente de
 * movimientos diario donde se muestre el ticket"* · *"lo revisan todas las mañanas que el corte
 * sí coincida con lo que existe en la caja"*.
 *
 * Lectura pura sobre dos vistas (`analytics.v_caja_control_*`) que derivan de
 * `caja_general_ods.arqueo_movimientos` — 30,199 renglones desde 2013-09-13, carril vivo. Cero
 * tablas propias, cero importer: la historia que se revisa cada mañana ya estaba en prod.
 *
 * ⚠️ Estas vistas NO llevan `tenant_id`: el origen es el back-end de un Access de una sola
 * empresa. Se usa `TenantKnexService` igual, por la conexión y para no abrir un segundo camino
 * de acceso a la base — pero acá no hay RLS que aislar y se dice en voz alta en vez de dejar
 * creer que lo hay.
 */
@Injectable()
export class CajaControlService {
  constructor(private readonly tk: TenantKnexService) {}

  /** `[CG.158]` Lo que no se puede leer se registra con su motivo real, no en silencio. */
  private readonly logger = new Logger(CajaControlService.name);

  /** Tope duro: una pantalla que pide "todo" no es una pantalla, es una descarga. */
  private readonly TOPE = 400;

  /**
   * El historial: un renglón por día, con el corte de ESE día.
   *
   * ⛔ `tiene_corte = false` significa que **ese día nadie contó la caja**, y es un hecho
   * distinto de "contó y dio cero". Por eso los totales llegan `null` y no 0 (ADR-056): la
   * pantalla tiene que poder decir las dos cosas distinto, que es justo lo que se revisa en la
   * mañana. Medido en prod: el 12-oct y el 9-oct tienen movimientos y **cero conteos**.
   */
  async cortes(q: { desde?: string; hasta?: string; limit?: number }) {
    const limit = Math.min(Number(q.limit) || 60, this.TOPE);
    return this.tk.run(async (trx) => {
      let qb = trx('analytics.v_caja_control_cortes');
      if (q.desde) qb = qb.where('fecha', '>=', q.desde);
      if (q.hasta) qb = qb.where('fecha', '<=', q.hasta);
      const rows: Array<Record<string, unknown>> = await qb.orderBy('fecha', 'desc').limit(limit);

      /**
       * ⭐ `[CGA-A.47]` **Las observaciones del conteo del corte.** La vista agrupa por la fecha en
       * que se CAPTURÓ, y Control a veces recaptura un cierre al día siguiente: el 2026-10-20 la
       * pantalla decía «la caja se contó el 20/10» sobre A23678, cuya nota dice «CORTE 19/10/2026»
       * — nadie contó ese día. La nota es lo único que lo dice, así que viaja con el renglón y la
       * pantalla la muestra. Una lectura por folio, sin tocar la vista.
       */
      const folios = rows.map((r) => r['corte_folio']).filter((f): f is string => typeof f === 'string' && !!f);
      if (folios.length) {
        const obs: { folio: string; observaciones: string | null }[] = await trx('analytics.v_caja_control_movimientos')
          .whereIn('folio', folios).select('folio', 'observaciones');
        const porFolio = new Map(obs.map((o) => [o.folio, (o.observaciones ?? '').trim() || null]));
        for (const r of rows) r['corte_observaciones'] = porFolio.get(String(r['corte_folio'])) ?? null;
      }
      return {
        rows, limit, fuente: 'analytics.v_caja_control_cortes',
        frescura: await this.frescura(trx),
      };
    });
  }


  /**
   * ⭐⭐ `[CGS.2]` — **El arqueo de la Suite contra el de Control, pieza por pieza.**
   *
   * Pedido de Edgar (2026-10-20): *«el supervisor necesita mejor visibilidad… una pestaña extra
   * que diga Arqueos, donde muestre más desglosados los cortes»*.
   *
   * ── Por qué hacía falta, medido ─────────────────────────────────────────────────────────────
   *
   * El mismo cajón se cuenta en DOS sistemas y **ninguna pantalla los pone lado a lado**: el
   * Expediente lee sólo Control, la pestaña Captura lee sólo la Suite. Por eso un desfase de
   * **$19,811.50** vivió ocho días sin que nadie lo viera — para encontrarlo hubo que cruzar a
   * mano dos tablas que el producto nunca cruza.
   *
   *     dia      Suite        Control      diferencia
   *     12-oct    3,653.50          —         (Control no tiene cierre ese dia)
   *     13-oct   57,571.00          —
   *     14-oct   24,960.00   14,128.50     +10,831.50
   *     15-oct   11,820.00   57,571.00     −45,751.00
   *     16-oct   32,198.50   32,198.50           0.00   ✔
   *     17-oct      618.50      618.50           0.00   ✔
   *     19-oct   88,272.50   87,772.50        +500.00
   *
   * ⭐ **El total solo no alcanza, y el 19-oct lo prueba:** $500 de diferencia que parecen un
   * descuadre y son **un billete mal clasificado** — la Suite anotó un $1,000 donde Control anotó
   * un $500, con las otras ocho denominaciones idénticas pieza por pieza. Por eso esto devuelve el
   * desglose y no sólo el delta (regla `Q.3`: señalar la fila, no el agregado).
   *
   * ── Cuál es el arqueo de CIERRE, y por qué no es ambiguo ────────────────────────────────────
   *
   * Control registra **varios arqueos por día** —hasta 10— y casi todos son el conteo de UN sobre:
   * su `observaciones` lo nombra (`NOM MORELIA`, `BONOS MKT`, `gnf PH`, `r22`, `PAL ALMA JAIME`).
   * El del cierre es el único que trae la **custodia completa**: dólares, cheques y tarjeta.
   *
   * ⚠️ El discriminante es `total_dolares <> 0`, y **se declara como heurística, no como ley**:
   * funciona del 14-oct en adelante (un cierre por día, verificado contra los 7 cortes) pero el
   * 1-oct hay TRES arqueos con dólares y el 6-oct dos. Para esos días `cierre` sale con
   * `ambiguo: true` y la pantalla tiene que decirlo en vez de elegir uno.
   *
   * ── ⛔ Lo que esto NO hace ──────────────────────────────────────────────────────────────────
   *
   * **No decide quién tiene razón.** Publica las dos cifras y su diferencia; cuál arbitra el
   * conteo es una decisión de negocio sobre cortes firmados, y mientras no esté tomada, afirmarla
   * acá sería inventar un árbitro (ADR-059). La pantalla declara la diferencia, no la resuelve.
   */
  async cruce(q: { desde?: string; hasta?: string; limit?: number }): Promise<CruceArqueosResponse> {
    const limit = Math.min(Number(q.limit) || 60, this.TOPE);
    return this.tk.run(async (trx) => {
      /**
       * El mapeo entre las dos rejas. ⚠️ **No es simétrico y eso se declara:** Control tiene
       * `m100` (moneda de $100) y centavos de 20/10/5 que la reja de la Suite no ofrece, y la
       * Suite agrupa todo lo menor a 50¢ en `morralla`. Una denominación sin par se publica con
       * `solo_en: 'control'` en vez de desaparecer — que es como se pierde dinero de vista.
       */
      const MAPA: Array<{ suite: string | null; control: string; valor: number }> = [
        { suite: '1000', control: 'b1000', valor: 1000 },
        { suite: '500', control: 'b500', valor: 500 },
        { suite: '200', control: 'b200', valor: 200 },
        { suite: '100', control: 'b100', valor: 100 },
        { suite: '50', control: 'b50', valor: 50 },
        { suite: '20', control: 'b20', valor: 20 },
        { suite: null, control: 'm100', valor: 100 },
        { suite: '20m', control: 'm20', valor: 20 },
        { suite: '10', control: 'm10', valor: 10 },
        { suite: '5', control: 'm5', valor: 5 },
        { suite: '2', control: 'm2', valor: 2 },
        { suite: '1', control: 'm1', valor: 1 },
        { suite: '0.5', control: 'm50c', valor: 0.5 },
        { suite: null, control: 'm20c', valor: 0.2 },
        { suite: null, control: 'm10c', valor: 0.1 },
        { suite: null, control: 'm5c', valor: 0.05 },
      ];

      let qc = trx('analytics.v_caja_control_cortes as v').where('v.tiene_corte', true);
      if (q.desde) qc = qc.where('v.fecha', '>=', q.desde);
      if (q.hasta) qc = qc.where('v.fecha', '<=', q.hasta);
      const ctrl = await qc.orderBy('v.fecha', 'desc').limit(limit);

      /**
       * ⛔ Los cortes de la Suite se traen en UNA consulta, no una por día. Con 60 días serían 60
       * viajes en serie sobre la pantalla que el supervisor abre cada mañana — el mismo error que
       * `me-cycles` documenta haber retirado por costar 9 segundos.
       *
       * ⭐⭐ **Y se traen POR VENTANA, no por los días de Control.** Antes se pedían con
       * `whereIn('fecha', dias)`, o sea que un corte de la Suite en un día que Control no cerró
       * **no existía para esta pantalla**. Medido el 2026-10-20 sobre prod: el 12-oct
       * ($3,653.50) y el 13-oct ($57,571.00) desaparecían — dos de los siete cortes, y uno de
       * ellos el más grande del periodo. Una pantalla de cuadre que esconde un arqueo entero es
       * peor que no tenerla: se lee como que ese día no pasó nada.
       */
      const dias = ctrl.map((r: { fecha: Date | string }) => this.soloFecha(r.fecha));
      const desde = q.desde ?? (dias.length ? dias[dias.length - 1] : null);
      const hasta = q.hasta ?? (dias.length ? dias[0] : null);
      const cortes = desde && hasta
        ? await trx('finance.cash_ledger_cuts')
          .where('sucursal', SUCURSAL_CAJA_GENERAL)
          .where('fecha', '>=', desde).where('fecha', '<=', hasta)
          .select('id', 'folio', 'fecha', 'estado', 'contado', 'morralla', 'esperado',
            'diferencia', 'authorized_at', 'closed_by_username')
        : [];
      const porDia = new Map<string, Record<string, unknown>>();
      for (const c of cortes) porDia.set(this.soloFecha(c.fecha as Date), c);

      const dens = cortes.length
        ? await trx('finance.cash_ledger_cut_denominations')
          .whereIn('cut_id', cortes.map((c: { id: string }) => c.id))
          .where('momento', 'cierre')
          .select('cut_id', 'denom_key', 'piezas')
        : [];
      const porCorte = new Map<string, Map<string, number>>();
      for (const d of dens) {
        const m = porCorte.get(d.cut_id as string) ?? new Map<string, number>();
        m.set(String(d.denom_key), Number(d.piezas));
        porCorte.set(d.cut_id as string, m);
      }

      const rows: CruceArqueoDia[] = ctrl.map((v: Record<string, unknown>) => {
        const dia = this.soloFecha(v.fecha as Date);
        const c = porDia.get(dia);
        const reja = c ? (porCorte.get(c.id as string) ?? new Map<string, number>()) : new Map<string, number>();
        const num = (x: unknown) => (x === null || x === undefined ? 0 : Number(x));

        const desglose = MAPA.map((m) => {
          const control = num(v[m.control]);
          const suite = m.suite ? (reja.get(m.suite) ?? 0) : null;
          const difPiezas = suite === null ? null : suite - control;
          return {
            /**
             * ⛔ `clave` y `tipo` NO son adorno: sin ellos la reja tiene **dos piezas distintas
             * con el mismo rótulo**. $20 es billete (`b20`) y también moneda (`m20`), y $100
             * igual (`b100`/`m100`). Una pantalla que las etiquete sólo por su valor muestra
             * «$20» dos veces en la misma tabla, con cifras distintas y sin forma de saber cuál
             * es cuál — y si además las agrupa por valor, las funde.
             */
            clave: m.control,
            tipo: m.control.startsWith('b') ? ('billete' as const) : ('moneda' as const),
            valor: m.valor,
            control,
            suite,
            dif_piezas: difPiezas,
            dif_importe: difPiezas === null ? null : Math.round(difPiezas * m.valor * 100) / 100,
            // ⚠️ Lo que la reja de la Suite no puede contar se DICE, no se calla.
            solo_en: m.suite ? null : 'control',
          };
        }).filter((d) => d.control !== 0 || (d.suite ?? 0) !== 0);

        const efeControl = num(v.total_efectivo);
        const contado = c?.contado === null || c?.contado === undefined ? null : Number(c.contado);
        return {
          fecha: dia,
          control: {
            folio: (v.corte_folio ?? null) as string | null, efectivo: efeControl as number | null,
            cuadra_ticket: (v.corte_cuadra_ticket ?? null) as boolean | null,
            hora: (v.corte_hora ?? null) as string | null,
          },
          suite: c ? this.ladoSuite(c) : null,
          /**
           * ⛔ CUATRO estados, no dos (ADR-056). Ni `sin_corte` ni `sin_arqueo` son «difieren en
           * todo»: son un conteo que falta de un lado, y pintarlos como un descuadre del tamaño
           * del arqueo entero mandaría a buscar efectivo que nadie perdió.
           */
          cruce: c == null || contado === null
            ? { estado: 'sin_corte' as const, diferencia: null as number | null }
            : Math.abs(contado - efeControl) < 0.005
              ? { estado: 'cuadran' as const, diferencia: 0 as number | null }
              : { estado: 'difieren' as const, diferencia: Math.round((contado - efeControl) * 100) / 100 as number | null },
          desglose,
        };
      });

      /**
       * ⭐⭐ **El lado espejo: cortes de la Suite que Control nunca cerró.** Sin esto la pantalla
       * recorre sólo los días de Control y un corte sellado acá se vuelve invisible — medido en
       * prod el 2026-10-20: el 12 y el 13-oct, $61,224.50 entre los dos.
       *
       * ⛔ Van con `control.efectivo = null`, **nunca 0**: cero afirmaría que Control contó la
       * caja y no encontró nada, que es exactamente lo contrario de lo que pasó.
       */
      const conArqueo = new Set(rows.map((r) => r.fecha));
      const soloSuite: CruceArqueoDia[] = cortes
        .filter((c: { fecha: Date | string }) => !conArqueo.has(this.soloFecha(c.fecha)))
        .map((c: Record<string, unknown>) => {
          const reja = porCorte.get(c.id as string) ?? new Map<string, number>();
          const desglose = MAPA.map((m) => ({
            clave: m.control,
            tipo: m.control.startsWith('b') ? ('billete' as const) : ('moneda' as const),
            valor: m.valor,
            control: null as number | null,
            suite: m.suite ? (reja.get(m.suite) ?? 0) : null,
            dif_piezas: null as number | null,
            dif_importe: null as number | null,
            solo_en: m.suite ? null : 'control',
          })).filter((d) => (d.suite ?? 0) !== 0);
          return {
            fecha: this.soloFecha(c.fecha as Date),
            control: {
              folio: null as string | null, efectivo: null as number | null,
              cuadra_ticket: null as boolean | null, hora: null as string | null,
            },
            suite: this.ladoSuite(c),
            cruce: { estado: 'sin_arqueo' as const, diferencia: null as number | null },
            desglose,
          };
        });

      const todas = [...rows, ...soloSuite].sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));

      return {
        rows: todas, limit, fuente: 'analytics.v_caja_control_cortes + finance.cash_ledger_cuts',
        frescura: await this.frescura(trx),
      };
    });
  }

  /**
   * `[CGS.2]` El lado Suite de un renglón, en UN solo lugar. Lo arman los dos caminos —el día que
   * Control cerró y el que no— y escribirlo dos veces es cómo uno se queda viejo sin que nadie lo
   * note: el `autorizado` o el `cerro` dejarían de salir en la mitad de las filas y la pantalla
   * diría «—» con cara de dato ausente.
   */
  private ladoSuite(c: Record<string, unknown>): CruceArqueoLadoSuite {
    return {
      folio: c.folio as string,
      estado: c.estado as string,
      contado: c.contado === null || c.contado === undefined ? null : Number(c.contado),
      esperado: c.esperado === null || c.esperado === undefined ? null : Number(c.esperado),
      diferencia: c.diferencia === null || c.diferencia === undefined ? null : Number(c.diferencia),
      autorizado: c.authorized_at != null,
      cerro: (c.closed_by_username ?? null) as string | null,
    };
  }

  /**
   * `[CGS.2]` Una columna `date` de pg llega como `Date` a la medianoche LOCAL del proceso, así que
   * `toISOString()` da el día anterior al este de UTC. Es el defecto que `[CGP-L.5]` midió en Tokio
   * y `[CGP-L.12]` volvió a encontrar vivo: acá se arma el día con los getters locales.
   */
  private soloFecha(f: Date | string): string {
    if (typeof f === 'string') return f.slice(0, 10);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }
  /**
   * ⭐ `[CG.105]` **La edad del dato, declarada.** Sin esto la pantalla se lee como "al día" aunque
   * el carril lleve días parado — el defecto que la Fase OBS midió costando seis días de precios
   * viejos, uno 54 % bajo costo.
   *
   * El eslabón es `caja_general_ods._ship_watermark`: `wm` es hasta dónde llegó el dato de negocio
   * y `updated_at` cuándo corrió el carril por última vez. Se publica **`wm`**, no `updated_at`:
   * un carril que corre cada minuto y no trae nada nuevo reportaría frescura perfecta sobre datos
   * viejos. *Que el proceso corra no es que el dato llegue.*
   *
   * ⚠️ Tres estados, no dos (ADR-056). Si la tabla no está o no tiene fila, el veredicto es
   * `unknown` — **no** `fresh`: no poder medir no es estar al día.
   */
  private async frescura(trx: any) {
    const SRC = '0 T Movimientos';
    let at: string | null = null;
    /**
     * ⛔ `[CG.158]` **Acá el `catch` publicaba un motivo FALSO, y por eso nadie lo vio.**
     *
     * Decía *«el carril puede no existir en este entorno»*. Medido en prod el 2026-10-14: el
     * carril existe y está **sano** —`_ship_watermark` de `0 T Movimientos` marca `2026-10-13
     * 17:19` y corrió hace 4 minutos—, pero `app_runtime` **no tiene `USAGE` sobre el schema**
     * `caja_general_ods`, así que la lectura muere con `42501` y esta pantalla viene reportando
     * `unknown` desde siempre.
     *
     * ⚠️ El historial SÍ se ve, porque sale de `analytics.v_caja_control_cortes` (2,069 filas como
     * `app_runtime`). **Que una pantalla cargue no prueba que sus fuentes se lean** — y un `catch`
     * que inventa la razón convierte un permiso faltante en «no se pudo medir», que nadie va a ir
     * a arreglar. Es el defecto de `[CP.8.39]`, que tuvo un puente muerto por lo mismo.
     *
     * El arreglo de fondo es el `GRANT` (migración `20261014100953`); esto hace que, si vuelve a
     * pasar, el motivo quede escrito.
     */
    let motivo: string | null = null;
    try {
      const r = await trx('caja_general_ods._ship_watermark')
        .where('src_table', SRC).first('wm', 'updated_at');
      at = r?.wm ? new Date(r.wm).toISOString() : null;
      if (!r) motivo = 'el carril no ha registrado su marca todavía';
    } catch (e) {
      at = null;
      const code = (e as { code?: string })?.code;
      motivo = code === '42501'
        ? 'sin permiso para leer el espejo de Control (falta USAGE sobre caja_general_ods)'
        : code === '42P01'
          ? 'el espejo de Control no existe en este destino'
          : 'no se pudo leer la marca del carril';
      this.logger.warn(`frescura de Control sin medir: ${motivo}`);
    }
    const horas = at ? (Date.now() - new Date(at).getTime()) / 3_600_000 : null;
    // 30 h: el arqueo de Control se captura en días hábiles, así que un fin de semana normal
    // no puede disparar la alarma. Una alarma que grita en falso enseña a ignorar el tablero.
    const status: 'fresh' | 'stale' | 'unknown' =
      horas === null ? 'unknown' : (horas <= 30 ? 'fresh' : 'stale');
    /**
     * ⛔ `[CGA-A.47]` Acá se escribía la edad a mano CON «hace» adelante («hace 3 h»), y la píldora
     * compartida antepone su propio «hace»: la pantalla decía **«Arqueos de Control hace hace 3 h»**
     * (medido en vivo, 2026-10-20). El contrato es el de `ageHuman` de platform-core («3 h»).
     */
    const edad = at ? ageHuman(Date.now() - new Date(at).getTime()) : null;
    const input = {
      key: 'caja_general_ods', label: 'Arqueos de Control',
      at, age_human: edad, status, stale: status !== 'fresh',
      // `[CG.158]` POR QUÉ no se pudo medir. Sin esto, «sin medir» por falta de permiso y «sin
      // medir» porque el carril nunca corrió se leen igual, y sólo una de las dos tiene arreglo.
      motivo,
    };
    return { data_as_of: at, status, stale: status !== 'fresh', age_human: edad, motivo, inputs: [input] };
  }

  /**
   * El expediente de un día: todos sus movimientos, cada uno con su ticket.
   *
   * ⭐ El TICKET es el desglose por denominación tal como se contó. Medido antes de publicarlo:
   * las piezas reconstruyen el efectivo declarado en **23,652 de 23,652** renglones vivos, cero
   * excepciones — por eso `cuadra_ticket` viaja por fila: cuando un renglón no cuadre será un
   * hecho nuevo, no el ruido de un decode flojo.
   *
   * ⛔ Los totales del día NO suman las cuatro piernas que no son efectivo. Medido: los dólares
   * toman 9 valores en todo 2026 y el actual se repite 205 veces; `totalcredito` vale $20,782.00
   * exactos 383 veces desde el 2025-10-06. Son saldos PARADOS que se vuelven a declarar en cada
   * conteo — sumarlos por día publica dinero que no existe. Por eso cada fila trae `naturaleza`
   * y acá sólo se suma lo que es flujo.
   */
  async expediente(fecha: string) {
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.v_caja_control_movimientos')
        .where('fecha', fecha)
        .orderBy('hora', 'asc')
        .limit(this.TOPE);

      const vivos = rows.filter((r: any) => !r.cancelado);
      const num = (x: unknown) => Number(x ?? 0);
      const suma = (pred: (r: any) => boolean, campo: string) =>
        Math.round(vivos.filter(pred).reduce((a: number, r: any) => a + num(r[campo]), 0) * 100) / 100;
      const esMov = (r: any) => r.naturaleza === 'movimiento';

      // El último conteo del día ES el corte: si hubo tres, vale el de más tarde.
      const conteos = vivos.filter((r: any) => r.naturaleza === 'conteo');
      const corte = conteos.length ? conteos[conteos.length - 1] : null;

      return {
        fecha,
        rows,
        resumen: {
          movimientos: vivos.length,
          cancelados: rows.length - vivos.length,
          conteos: conteos.length,
          /** Sólo flujo. Un conteo es una foto del mismo dinero, no un movimiento más. */
          efectivo_movido: suma(esMov, 'total_efectivo'),
          tickets_que_no_cuadran: vivos.filter((r: any) => r.cuadra_ticket === false).length,
        },
        /** `null` = ese día nadie contó la caja. NO es cero. */
        corte,
        fuente: 'analytics.v_caja_control_movimientos',
      };
    });
  }
}
