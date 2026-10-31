import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, applySmartSearch, branchName, cajaColaDelLibroSql } from '@megadulces/platform-core';
import { evalInput, composeFreshness, FRESHNESS_UNKNOWN } from '@megadulces/platform-core';
import { SUCURSAL_CAJA_GENERAL, diaDeFecha, diaMxDeInstante, type Freshness } from '@megadulces/contracts';
import { casarPorImporte, canonBank, escapaLike, estadoDiaCuadre, CUADRE_TOLERANCIA_PESOS, type MovCuadre, type ResultadoCuadre } from './caja-cuadre.engine';
import { fechaDeVentaDeclarada, leerVentaDeRuta } from './caja-ruta.engine';
import {
  casarLibroConKepler, cobroDeRutaComoKepler, indexaLibro, juntaCuadres, llaveKeplerDelLibro, marcaEnLibro, resumeEnLibro,
  type CobroDeRuta, type ParLibro, type RenglonLibro,
} from './caja-kepler-libro.engine';
import { frescuraCaja, primerCorteDelLibro } from './caja-relevo';

/**
 * Fase CG.3 — Caja General (control venta diaria → depósito bancario + arqueo).
 *
 * Read-only sobre analytics.caja_* (espejo del sistema Access de Finanzas "Base
 * Movimientos" + arqueo "BMovimientosCajas", cargado por import-caja-general.js).
 * analytics.* NO tiene RLS → filtro tenant EXPLÍCITO dentro de tk.run().
 *
 * Tolerancias de conciliación (heredadas de CB/CC, ver bancos-shared):
 *   · MATCH_EPS   = ±$5     → casar un movimiento contra el banco, y que el DÍA cuadre.
 *   · CUADRE_EPS  = ±$1,000 → cuadre de TOTALES (absorbe el redondeo de ~30 días).
 * El descuadre venta→depósito NO usa tolerancia: el hueco es la señal.
 *
 * ⭐ `MATCH_EPS` pasó de ±$1 a ±$5 el 2026-09-17, a pedido de Finanzas. MEDIDO antes de
 * cambiarlo, con el mismo algoritmo greedy, sobre 1-jul→17-sep (67 días con movimientos):
 *
 *            casados            huérfanos Control     huérfanos banco
 *   ±$1      7,030  $76.38M     382  $11.36M          332  $9.28M
 *   ±$5      7,048  $77.64M     364  $10.10M          314  $8.03M
 *   Δ        +18    +$1.26M     −18  −$1.26M          −18  −$1.26M
 *
 * O sea: **18 movimientos más casan y salen $1.26M de la columna de huérfanos** — ~$70k
 * promedio cada uno, movimientos grandes que diferían por menos de cinco pesos. Ampliar una
 * tolerancia BAJA el descuadre reportado, así que el número de antes queda escrito acá: sin
 * eso, la cifra de la pantalla cambia y nadie sabe cuánto fue el cambio y cuánto la realidad.
 *
 * ⛔ Y era UNA tolerancia escrita TRES veces a mano (`MATCH_EPS`, el `AMT_TOL` del matcher en
 * centavos, y el `EPS` del cuadre por día). Las tres se derivan de ésta ahora: mover una sola
 * dejaba la pantalla diciendo "±$1" mientras el matcher usaba otra cosa.
 */
// `[CGA-A.44]` El valor vive en el motor: la cola de captura casa con el mismo.
/**
 * `[CGA-A.39]` Un documento de Kepler de Caja General, como lo devuelve `docsKeplerPorLlave`.
 *
 * ⚠️ `importe` y `signo` se declaran `string | number` a propósito: node-pg entrega `numeric`
 * como TEXTO. Tiparlos de número invitaría a sumarlos sin convertirlos, que es como se fabrica
 * un total equivocado que se lee igual que uno correcto.
 */
type DocKeplerCG = {
  sucursal: string;
  clave_banco: string;
  folio: string;
  fecha: unknown;
  concepto: string | null;
  beneficiario: string | null;
  doc_tipo: string;
  importe: string | number;
  signo: number | string;
};

const MATCH_EPS = CUADRE_TOLERANCIA_PESOS;
const CUADRE_EPS = 1000;
/**
 * `[CGA-A.68]` Tope de la lista de «General» (el espejo del Control). Medido el 2026-10-30: TODOS los
 * meses de 2026 lo rebasan (567 a 1,696 movimientos), así que la respuesta lleva `has_more` y la
 * pantalla dice cuántos de cuántos.
 */
const GENERAL_TOPE = 500;
const TENDERS = ['efectivo', 'morralla', 'cheques', 'tarjeta', 'caja_chica', 'sobregiro'];

export interface CajaQuery {
  month?: string;        // 'YYYY-MM'
  from?: string;         // 'YYYY-MM-DD'
  to?: string;           // 'YYYY-MM-DD'
  instance?: string;     // SI | NO
  banco?: string;        // banco_name
  almacen?: string;
  tipo?: string;         // arqueos: Arqueo/Retiro/Corte/…
  search?: string;
  limit?: number;
}

/**
 * Normaliza a `YYYY-MM-DD` una fecha que puede venir como Date o como texto.
 *
 * node-postgres parsea las columnas `date` a **objeto Date**, así que el
 * `String(f).slice(0, 10)` que había acá producía `"Wed Jan 28"` — el prefijo del
 * toString() de JS. Ese texto viajaba en `por_dia[].fecha`, el frontend lo mandaba
 * como `?from=`, y Postgres tiraba 22007 (invalid input syntax for type date). El
 * desglose del día quedaba vacío y el catch del componente lo pintaba como "sin
 * movimientos", así que el error no se veía por ningún lado.
 *
 * Se arma con las partes LOCALES y no con `toISOString()`: pg construye el Date en
 * la zona del proceso, y pasar por UTC recorre el día hacia atrás en México — el
 * mismo flip que ya se corrigió antes en esta pantalla.
 */
function ymd(f: unknown): string {
  // `[CGP-L.5]` El helper compartido: componentes locales para un `date`, y nada de `String(Date)`.
  return diaDeFecha(f) ?? '';
}

@Injectable()
export class CajaGeneralService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private readonly logger = new Logger(CajaGeneralService.name);

  /**
   * `[CGA-A.35]` Los **cobros de camioneta** que la tesorería de Kepler no trae: viven en
   * `analytics.route_collections` (almacén compuesto `01-003`, `06-002`…), en la forma de un
   * renglón de `kepler_bank_movements` para que el Cuadre los trate igual. Agrupados por
   * (almacén, folio, fecha), como la cola `finance.v_caja_movimientos_pendientes`.
   *
   * Medido el 2026-10-20: desde el 12-oct son 58 cobros, $1,048,334.34, que la pantalla no
   * mostraba ni como casados ni como faltantes. Y 0 de 134 cobros de octubre están también en
   * `kepler_bank_movements` con la misma fecha e importe: sumarlos no cuenta nada dos veces.
   *
   * ⚠️ La tabla se lee EN VIVO por FDW (`[CGA-A.22]`). Si esa lectura falla, el Cuadre no se cae:
   * la lectura va en un SAVEPOINT y vuelve `disponible: false`, que la pantalla declara. Un
   * cuadre sin camionetas presentado como completo sería peor que uno que dice que le faltan.
   */
  private async cobrosDeRuta(trx: Knex.Transaction, tenantId: string, from: string, to: string) {
    await trx.raw('SAVEPOINT cga_a35_ruta');
    try {
      const rows = await trx('analytics.route_collections')
        .where('tenant_id', tenantId).andWhere('cuenta', '0011')
        .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
        .groupBy('almacen', 'cobro_folio', 'fecha')
        .select('almacen', 'cobro_folio', 'fecha',
          trx.raw('SUM(importe)::numeric AS importe'),
          trx.raw(`string_agg(DISTINCT truck, ' · ') AS truck`),
          trx.raw(`string_agg(DISTINCT COALESCE(referencia, folio_corte), ' · ') AS concepto`));
      await trx.raw('RELEASE SAVEPOINT cga_a35_ruta');
      return { rows: (rows as CobroDeRuta[]).map(cobroDeRutaComoKepler), disponible: true };
    } catch (e) {
      await trx.raw('ROLLBACK TO SAVEPOINT cga_a35_ruta').catch(() => undefined);
      this.logger.warn(`[CGA-A.35] cobros de camioneta no disponibles: ${(e as Error).message}`);
      return { rows: [] as ReturnType<typeof cobroDeRutaComoKepler>[], disponible: false };
    }
  }

  /**
   * ⭐ `[CGA-A.66]` **Lo que la cola de Captura todavía tiene, por día** — la cola CANÓNICA
   * (`cajaColaDelLibroSql`, la misma de la bandeja, la campana y «Mi trabajo»), sobre la Caja
   * General de Kepler (`0011`), que es la que el Cuadre compara.
   *
   * Sirve para partir el rojo del Cuadre en dos cosas que se pintaban igual. Medido el 2026-10-30
   * (12 al 30-oct): de 13 días en rojo, en 7 la diferencia contra Kepler era **exactamente** lo que
   * la cola tenía de ese día (21, 27, 28 y 29-oct al centavo) — trabajo por hacer, no dinero que
   * no cuadra. Un rojo que significa dos cosas no le dice a nadie qué hacer.
   *
   * ⚠️ En SAVEPOINT: si la vista no se puede leer, el Cuadre no se cae y devuelve
   * `disponible: false`; la pantalla lo declara y ningún día se da por «sólo falta capturar».
   */
  private async colaPorDia(trx: Knex.Transaction, tenantId: string, from: string, to: string) {
    const porDia = new Map<string, { n: number; ingreso: number; gasto: number }>();
    await trx.raw('SAVEPOINT cga_a66_cola');
    try {
      const rows: Array<{ fecha: unknown; n: number | string; ingreso: string | number; gasto: string | number }> =
        await trx({ v: 'finance.v_caja_movimientos_pendientes' })
          .where('v.tenant_id', tenantId).andWhere('v.clave_banco', '0011')
          .andWhere('v.fecha_valor', '>=', from).andWhere('v.fecha_valor', '<=', to)
          .whereRaw(cajaColaDelLibroSql('v'))
          .groupBy('v.fecha_valor')
          .select(trx.raw('v.fecha_valor AS fecha'), trx.raw('COUNT(*)::int AS n'),
            trx.raw(`COALESCE(SUM(abs(v.monto)) FILTER (WHERE v.tipo = 'ingreso'), 0)::numeric AS ingreso`),
            trx.raw(`COALESCE(SUM(abs(v.monto)) FILTER (WHERE v.tipo <> 'ingreso'), 0)::numeric AS gasto`));
      await trx.raw('RELEASE SAVEPOINT cga_a66_cola');
      for (const r of rows) porDia.set(ymd(r.fecha), { n: Number(r.n) || 0, ingreso: Number(r.ingreso) || 0, gasto: Number(r.gasto) || 0 });
      return { porDia, disponible: true };
    } catch (e) {
      await trx.raw('ROLLBACK TO SAVEPOINT cga_a66_cola').catch(() => undefined);
      this.logger.warn(`[CGA-A.66] cola por día no disponible: ${(e as Error).message}`);
      return { porDia, disponible: false };
    }
  }

  /**
   * `[CGA-A.39]` Desde qué día la caja vive en el libro nuevo: la fecha del PRIMER corte. Antes
   * de ese día el Cuadre usa el Control; desde ese día, el libro. `null` = no hay libro todavía y
   * todo sigue siendo Control. Sale de los datos por la misma razón que `facets.relevo`.
   */
  private libroDesde(trx: Knex.Transaction, tenantId: string): Promise<string | null> {
    // `[CGA-A.43]` Una sola definición del borde, compartida con la bandeja (`caja-relevo.ts`).
    return primerCorteDelLibro(trx, tenantId);
  }

  /**
   * `[CGA-A.39]` Los movimientos del libro de un rango, por la FECHA DEL DOCUMENTO (decisión de
   * Edgar, 2026-10-20: es la que usa Kepler; medido, 214 de 222 vinculados caen el mismo día que
   * su documento). Sin cancelados ni borrados. `deposito` sale del lado del gasto: es efectivo
   * que se va de la caja (hoy hay 0, pero un tipo que no se acomoda en ningún lado desaparece).
   */
  private async movimientosDelLibro(trx: Knex.Transaction, tenantId: string, from: string, to: string) {
    const rows: Array<{ folio: string; tipo: string; fecha: unknown; monto: string | number; glosa: string | null; beneficiario: string | null;
      kepler_cuenta: string | null; origen_tipo: string | null; origen_ref: string | null; declared_doc_ref: string | null }> =
      await trx('finance.cash_ledger')
        .where('tenant_id', tenantId).whereNull('deleted_at').whereNot('estado', 'cancelado')
        .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
        .select('folio', 'tipo', 'fecha', 'monto', 'glosa', 'beneficiario', 'kepler_cuenta', 'origen_tipo', 'origen_ref', 'declared_doc_ref');
    return rows.map((r) => ({ ...r, dir: (r.tipo === 'ingreso' ? 'in' : 'out') as 'in' | 'out', ref: llaveKeplerDelLibro(r) }));
  }

  /**
   * `[CGA-A.39]` Documentos de Kepler por LLAVE (`sucursal|doc|folio|clave`), de la tesorería y de
   * las camionetas. Sirve para casar un movimiento del libro con su documento cuando éste cae en
   * OTRO día que el que se está viendo. La de camionetas va en SAVEPOINT por la misma razón que
   * `cobrosDeRuta`: si el FDW falla, ese par sale «solo libro» en vez de tumbar el Cuadre.
   */
  /**
   * ⚠️ El tipo de retorno va DECLARADO, no inferido. Sin él TypeScript unía tres caminos
   * (`[]`, `tes`, y el spread con `cobroDeRutaComoKepler`) y terminaba en `unknown[]`: el
   * `.map((r) => ...)` de la línea ~854 fallaba con **TS18046: 'r' is of type 'unknown'** y
   * tiraba el build de `main` entero (10 errores, `Running target build ... failed`).
   *
   * ⛔ El `return []` es el que empuja la inferencia: un `never[]` unido a un objeto no estrecha,
   * ensancha. Declarar el contrato de salida cuesta una línea y lo cierra.
   */
  private async docsKeplerPorLlave(trx: Knex.Transaction, tenantId: string, keys: string[]): Promise<DocKeplerCG[]> {
    if (!keys.length) return [];
    const tes: DocKeplerCG[] =
      await trx('analytics.kepler_bank_movements')
        .where('tenant_id', tenantId).andWhere('account_label', 'CG')
        .whereRaw(`sucursal || '|' || doc_tipo || '|' || folio || '|' || clave_banco = ANY(?)`, [keys])
        .select('sucursal', 'clave_banco', 'folio', 'fecha_valor as fecha', 'concepto', 'beneficiario', 'doc_tipo', 'importe', 'signo');
    await trx.raw('SAVEPOINT cga_a37_llaves');
    try {
      const rc: CobroDeRuta[] = await trx('analytics.route_collections')
        .where('tenant_id', tenantId)
        .whereRaw(`almacen || '|U-A-5|' || cobro_folio || '|' || cuenta = ANY(?)`, [keys])
        .groupBy('almacen', 'cobro_folio', 'fecha')
        .select('almacen', 'cobro_folio', 'fecha', trx.raw('SUM(importe)::numeric AS importe'),
          trx.raw(`string_agg(DISTINCT truck, ' · ') AS truck`), trx.raw(`string_agg(DISTINCT COALESCE(referencia, folio_corte), ' · ') AS concepto`));
      await trx.raw('RELEASE SAVEPOINT cga_a37_llaves');
      return [...tes, ...rc.map(cobroDeRutaComoKepler)];
    } catch (e) {
      await trx.raw('ROLLBACK TO SAVEPOINT cga_a37_llaves').catch(() => undefined);
      this.logger.warn(`[CGA-A.39] cobros de camioneta por llave no disponibles: ${(e as Error).message}`);
      return tes;
    }
  }

  /**
   * [CG.8] La frescura del ESPEJO. Esta pantalla publica $154M de movimientos copiados del
   * Access `Control` y hasta hoy NO decía de cuándo son.
   *
   * No es un detalle: el carril que lo alimenta (`import-caja-general.js`) exige Windows +
   * PowerShell + ACE + `Z:`, y desde que VL.4b (2026-09-11) mudó los feeds a `md` (Linux)
   * sólo corre en el modo `finance`, que se lanza A MANO desde `.249`. O sea que el espejo
   * puede llevar días congelado mientras la pantalla se ve igual de segura.
   *
   * Dos eslabones, y gana el PEOR (`composeFreshness`): de nada sirve que el histórico esté
   * al día si el arqueo vivo lleva una semana parado.
   *   · `computed_at` de los movimientos = cuándo ESCRIBIÓ el importer (entrega, no "corrió").
   *   · `arqueo_date` de los arqueos      = el dato vivo, el que el sensor `caja_general` mide.
   *
   * Tolerancia 30 h = la del sensor en `db-health` (feed diario: warn al saltarse una corrida).
   * Si la medición falla devuelve `unknown` con `stale: true` — NO silencio, que fue la falla
   * exacta que VP.0 encontró en la etiquetera.
   */
  async frescura(): Promise<Freshness> {
    const tenantId = this.tenantCtx.requireTenantId();
    try {
      return await this.tk.run(async (trx) => {
        const mov = await trx('analytics.caja_general_movimientos')
          .where('tenant_id', tenantId).max('computed_at as at').first();
        const arq = await trx('analytics.caja_arqueos')
          .where('tenant_id', tenantId).max('arqueo_date as at').first();
        return composeFreshness([
          evalInput('caja_general_import', 'Copia del .mdb (Control)', mov?.at ?? null, 30),
          evalInput('caja_arqueo', 'Arqueo de caja 20', arq?.at ?? null, 30),
        ]);
      });
    } catch {
      // Una medición que falla NO puede verse como un dato al día.
      return FRESHNESS_UNKNOWN;
    }
  }

  /** Deriva [from,to] (date) desde month o from/to; default = mes en curso. */
  private range(q: CajaQuery): [string, string] {
    if (q.from && q.to) return [q.from, q.to];
    // `[CGP-L.5]` El mes en curso en MÉXICO: con `toISOString` el último día después de las 18:00 ya era el siguiente.
    const m = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : (diaMxDeInstante(new Date()) ?? '').slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(y, mo, 0).getDate();
    return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`];
  }

  private inst(q: CajaQuery) { return (q.instance || 'SI').toUpperCase(); }

  /**
   * Nombre legible de la sucursal del lado WORKBOOK / Control. Ese lado usa el espacio de
   * códigos de Finanzas ('10' Padre Hidalgo, '20' Comisionistas, '42' La Piedad, …), que NO
   * es el de Kepler (ver platform-core/constants/branches.ts). Se resuelve contra
   * `analytics.caja_sucursales_catalog` (el catálogo de almacenes de Finanzas ya en la DB).
   * Devuelve "Nombre (código)" para no perder la traza; código desconocido o basura de captura
   * ('OTROS', '-', '´30') se devuelve tal cual. La pantalla mostraba sólo el número.
   */
  private async finanzasSucursalNamer(trx: any, tenantId: string, inst: string): Promise<(code: unknown) => string | null> {
    const rows = await trx('analytics.caja_sucursales_catalog')
      .where({ tenant_id: tenantId, source_instance: inst }).select('almacen', 'nombre_corto', 'nombre');
    const map = new Map<string, string>();
    for (const r of rows as any[]) { const nm = r.nombre_corto || r.nombre; if (nm) map.set(String(r.almacen).trim(), nm); }
    return (code) => {
      const c = String(code ?? '').trim();
      if (!c) return null;
      const nm = map.get(c);
      return nm ? `${nm} (${c})` : c;
    };
  }

  /**
   * Nombre legible de la sucursal del lado KEPLER (`kdm1.c1`, '00'–'07'). Kepler '00' es
   * OFICINAS (docs/ERP_KEPLER.md §2.3): ahí se captura la tesorería central; el catálogo
   * compartido todavía la nombra CEDIS, así que se corrige acá para esta pantalla.
   */
  private keplerSucursal(code: unknown): string | null {
    const c = String(code ?? '').trim();
    if (!c) return null;
    const nm = c === SUCURSAL_CAJA_GENERAL ? 'Oficinas' : branchName(c);
    return nm === c ? c : `${nm} (${c})`;
  }

  /**
   * CG.2 — CAJA GENERAL VIVA (analytics.caja_general_movimientos, ex-`Doctos`): el hub de
   * efectivo real de Comisionistas. Ingresos (ventas de ruta que entran) vs gastos
   * (remisiones a proveedor / comisiones / gastos por sucursal), por cuenta. Devuelve KPIs
   * + por-mes + por-cuenta + movimientos (filtrables por tipo/búsqueda). Reemplaza la data
   * muerta del Base Movimientos (caja_ventas_diarias/caja_depositos, abandonado Q1-2026).
   */
  async general(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: any) => Number(x) || 0;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return this.tk.run(async (trx) => {
      const T = 'analytics.caja_general_movimientos';
      const inRange = () => trx(T).where('tenant_id', tenantId).whereBetween('fecha', [from, to]);
      /**
       * ⛔ `[CGA-A.68]` **Los totales y «Por cuenta» no seguían al filtro.** El tipo y la búsqueda se
       * aplicaban sólo a la lista: con «Gasto» elegido, el mosaico de Ingresos seguía publicando el
       * mes entero. Un total que no corresponde a lo filtrado es otra forma de mentir. Ahora las
       * tres lecturas parten del mismo universo; `por_mes` no, porque es la serie de todos los meses.
       */
      const filtrado = () => {
        let b = inRange();
        if (q.tipo) b = b.where('tipo', q.tipo);
        if (q.search) {
          // `%` y `_` del usuario se escapan: sin esto, buscar "100%" traía el libro COMPLETO y la
          // persona creía que había filtrado. No es inyección (el valor va parametrizado) — es una
          // mentira silenciosa en pantalla, que es peor porque nadie la reporta.
          const s = `%${escapaLike(q.search)}%`;
          b = b.whereRaw(
            `(cuenta_nombre ILIKE ? ESCAPE '\\' OR nombre_cliente ILIKE ? ESCAPE '\\' OR concepto ILIKE ? ESCAPE '\\')`,
            [s, s, s]);
        }
        return b;
      };

      // `numeric` llega como texto por node-pg: el tipo lo dice para que nadie lo sume sin `n()`.
      const tot = (await filtrado()
        .select(trx.raw('COALESCE(SUM(ingreso),0)::numeric AS ingreso'),
          trx.raw('COALESCE(SUM(gasto),0)::numeric AS gasto'), trx.raw('COUNT(*)::int AS n')).first()) as
        { ingreso: string | number; gasto: string | number; n: number } | undefined;
      /**
       * ⛔⛔ `[CG.75]` **ACÁ VIVÍA LA CONSULTA DEL "SALDO", Y SE FUE ENTERA.**
       *
       * Buscaba «el último renglón del período con `saldo <> 0`» y eso alimentaba el KPI
       * «Saldo caja». La columna **no es un saldo**: es el importe del propio renglón (medido en
       * prod: corrido global 0/79 · corrido por cuenta 0/103 · importe del renglón **409/409**).
       *
       * ⭐ Acá vivía también un comentario de doce líneas explicando cómo se había arreglado que
       * el KPI tomara el saldo *de otro período* — una corrección real, cuidadosa y medida, sobre
       * un número que **no existía**. *Afinar la puntería de una medición no la vuelve la
       * medición correcta, y un comentario largo sobre un valor falso lo hace ver más confiable.*
       *
       * Se borra la consulta y no sólo su uso: una lectura de prod por petición para alimentar
       * un campo que ahora va en `null` es costo puro, y la próxima persona la vería y supondría
       * que el dato existe.
       */
      const porMes = await trx(T).where('tenant_id', tenantId)
        .select(trx.raw(`to_char(fecha,'YYYY-MM') AS mes`), trx.raw('SUM(ingreso)::numeric AS ingreso'),
          trx.raw('SUM(gasto)::numeric AS gasto'), trx.raw('COUNT(*)::int AS n'))
        .groupByRaw(`to_char(fecha,'YYYY-MM')`).orderByRaw(`to_char(fecha,'YYYY-MM')`);

      const porCuenta = await filtrado()
        .select('cuenta', 'cuenta_nombre', trx.raw('SUM(ingreso)::numeric AS ingreso'),
          trx.raw('SUM(gasto)::numeric AS gasto'), trx.raw('COUNT(*)::int AS n'))
        .groupBy('cuenta', 'cuenta_nombre').orderByRaw('SUM(ingreso)+SUM(gasto) DESC').limit(40);

      const movs = await filtrado()
        .select('mov_id', 'tipo_dto', 'tipo', 'fecha', 'hora', 'usuario', 'cuenta', 'cuenta_nombre',
          'nombre_cliente', 'concepto', 'ingreso', 'gasto', 'saldo', 'denom')
        // Cronológico real por (fecha, hora); mov_id es texto → no sirve como orden temporal.
        .orderByRaw(`fecha DESC, hora DESC NULLS LAST`).limit(GENERAL_TOPE);

      const freshness = await this.frescura();

      return {
        period: { from, to },
        // [CG.8] De cuándo son estos números. Un `generated_at` diría cuándo respondió el
        // servidor, que es otra cosa: contesta en 200 ms sobre datos de hace seis días.
        freshness,
        // `[CGA-A.68]` La lista se topa en `GENERAL_TOPE` y `totals.n` es el universo filtrado: con
        // esto la pantalla dice «500 de 1,393» en vez de una nota fija que no dice si recortó.
        has_more: n(tot?.n) > movs.length,
        totals: {
          ingreso: r2(n(tot?.ingreso)), gasto: r2(n(tot?.gasto)), neto: r2(n(tot?.ingreso) - n(tot?.gasto)),
          n: n(tot?.n),
          /**
           * ⛔⛔ `[CG.75]` **ACÁ SE PUBLICABA UN SALDO QUE NO EXISTE.**
           *
           * Esto era `r2(n(sal?.saldo))`: el último renglón del período con `saldo <> 0`. La
           * pantalla lo mostraba como KPI «Saldo caja» con el subtítulo «actual», y en prosa como
           * *«Saldo actual: $16,473.40 (al 07/10/26)»*.
           *
           * ⭐ **La columna `saldo` NO es un saldo: es el importe del propio renglón.** Medido
           * contra producción, tres hipótesis:
           *
           *   corrido global     → cuadran   0 de  79 pares
           *   corrido por cuenta → cuadran   0 de 103 pares
           *   importe del renglón→ cuadran 409 de 409 filas  (100%, 30 días)
           *
           * O sea que el número publicado como «el efectivo que hay en la caja» era **el monto de
           * una operación suelta**, elegida por ser la última del período que traía cifra. Hay un
           * comentario largo más arriba explicando cómo se arregló *qué* operación elegía —se
           * corrigió el filtro de período— y nadie cuestionó que fuera un saldo. *Afinar la
           * puntería de una medición no la vuelve la medición correcta.*
           *
           * El origen tampoco lo tiene por otro lado: los «arqueos» de la caja 20 son depósitos a
           * bancos (banco + cuenta + beneficiario en las observaciones; el mayor del 05/10 fue
           * $1,320,253), y el último `Fondo Caja` declarado es de 2026-05-26 y vale $0.
           *
           * Entonces se DECLARA, no se dibuja (ADR-056): `null` con su motivo. El flujo del
           * período —ingreso, gasto, neto— sí es real y se sigue publicando; lo que no existe es
           * el stock.
           *
           * ⚠️ Quien quiera el saldo de verdad tiene que CONTAR: es lo que hace el corte de
           * `finance.cash_ledger_cuts` con su fondo inicial y su arqueo ciego.
           */
          saldo: null as number | null,
          saldo_fecha: null as string | null,
          saldo_motivo: 'no_se_lleva' as const,
        },
        por_mes: (porMes as any[]).map((r) => ({ mes: r.mes, ingreso: r2(n(r.ingreso)), gasto: r2(n(r.gasto)), n: n(r.n) })),
        por_cuenta: (porCuenta as any[]).map((r) => ({ cuenta: r.cuenta, cuenta_nombre: r.cuenta_nombre, ingreso: r2(n(r.ingreso)), gasto: r2(n(r.gasto)), n: n(r.n) })),
        movimientos: (movs as any[]).map((r) => ({
          uid: `${r.tipo_dto}-${r.mov_id}`, ...r,
          ingreso: n(r.ingreso), gasto: n(r.gasto), saldo: n(r.saldo),
        })),
      };
    });
  }

  /**
   * CG.5 — CUADRE de la caja general (Comisionistas). Es un hub de efectivo pass-through:
   * la venta de ruta ENTRA (ingreso) y SALE a pagar proveedores/comisiones/gastos + depósito
   * al banco (gasto). El cuadre = ¿entra lo mismo que sale?  neto = ingreso − gasto (el efectivo
   * que quedó/faltó en caja). Como el saldo de libro no se lleva (SaldoD=0), el arqueo físico
   * (BMovimientosCajas caja 20, el MAYOR conteo del día) va como TESTIGO del efectivo real.
   * Desglosa el gasto en depósito-al-banco (cuentas 1990/40000000) vs el resto (remisiones/gastos).
   */
  async cajaCuadre(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: any) => Number(x) || 0;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const DEP_ACCTS = ['1990', '40000000'];
    return this.tk.run(async (trx) => {
      const dias = await trx('analytics.caja_general_movimientos')
        .where('tenant_id', tenantId).whereBetween('fecha', [from, to])
        .select('fecha',
          trx.raw('SUM(ingreso)::numeric AS ingreso'),
          trx.raw('SUM(gasto)::numeric AS gasto'),
          trx.raw(`SUM(CASE WHEN cuenta IN ('1990','40000000') THEN gasto ELSE 0 END)::numeric AS deposito`),
          trx.raw('COUNT(*)::int AS n'))
        .groupBy('fecha').orderBy('fecha');

      // Arqueo físico por día (caja 20, el MAYOR conteo del día = mejor testigo del efectivo).
      const arq = await trx('analytics.caja_arqueos')
        .where({ tenant_id: tenantId, source_caja: '20', tipo: 'Arqueo' }).whereBetween('arqueo_date', [from, to])
        .select('arqueo_date', trx.raw('MAX(total_efectivo)::numeric AS efectivo'), trx.raw('COUNT(*)::int AS n'))
        .groupBy('arqueo_date');
      const arqByDay = new Map<string, { efectivo: number; n: number }>();
      for (const a of arq as any[]) arqByDay.set(ymd(a.arqueo_date), { efectivo: n(a.efectivo), n: n(a.n) });

      // CG.8 — Ingreso por ORIGEN (de dónde viene el efectivo): sucursal (POS) / ruta / lo demás.
      // Heurística sobre cuenta + nombre_cliente (texto libre).
      //
      // ⛔ **El `ELSE` decía `'ruta'`.** O sea: todo lo que no dijera "suc" y no cayera en la lista
      // de cuentas se PUBLICABA como venta de ruta, con su monto, en un KPI. Eso no es "ruta": es
      // "no se pudo determinar". Un default disfrazado de medición es justo lo que ADR-056
      // prohíbe, y acá importa el doble porque CG.19 va a aplicar dinero contra el saldo de una
      // ruta — el día que ese número decida algo, un `ELSE` no puede ser la fuente.
      // Ahora `sin_clasificar` es un balde propio y se ve.
      //
      // ⛔ **Y NO se agrega acá un regex de ruta** (`R.D`, `RV`, …), aunque haría subir el balde
      // `ruta`. Esa expresión ya vive en TRES lugares con DOS formas distintas (ver la cabecera de
      // `20260918260000_finance_route_customer_map.js`); una cuarta copia empeora justo lo que la
      // Capa 0 vino a arreglar. `ruta` se queda con lo que el texto DICE ("RUTA"); lo demás se
      // declara. Cuando `finance.route_customer_map` esté confirmado, este balde sale de ahí.
      //
      // ⚠️ Al escribir esto metí `R\.?[DV]` en un `trx.raw` y lo corregí antes de compilar: para
      // knex el `?` es un marcador de parámetro (regla M1, ya se pagó una columna entera en NULL).
      // Que la regla esté escrita no impide romperla; por eso el balde es literal y sin `?`.
      const orig = await trx('analytics.caja_general_movimientos')
        .where('tenant_id', tenantId).where('tipo_dto', 1).whereBetween('fecha', [from, to])
        .select(trx.raw(`CASE
          WHEN cuenta IN ('41000010','41000006','41000008','41000011')
               OR nombre_cliente ILIKE '%prestamo%' OR nombre_cliente ILIKE '%pagare%'
               OR nombre_cliente ILIKE '%nomina%' OR nombre_cliente ILIKE '%directivo%' THEN 'otros'
          WHEN nombre_cliente ILIKE '%suc%' THEN 'sucursal'
          WHEN nombre_cliente ILIKE '%ruta%' THEN 'ruta'
          ELSE 'sin_clasificar' END AS origen`),
          trx.raw('COUNT(*)::int AS n'), trx.raw('SUM(ingreso)::numeric AS monto'))
        .groupByRaw('1');
      const og: Record<string, { n: number; monto: number }> = {
        sucursal: { n: 0, monto: 0 }, ruta: { n: 0, monto: 0 },
        otros: { n: 0, monto: 0 }, sin_clasificar: { n: 0, monto: 0 },
      };
      for (const r of orig as any[]) if (og[r.origen]) og[r.origen] = { n: n(r.n), monto: r2(n(r.monto)) };

      // Testigo POS: efectivo contado en los cortes de caja (Kepler) del periodo. La parte
      // 'sucursal' del ingreso DEBERÍA acercarse a esto (ambos efectivo) — Δ = timing/merma/no-POS.
      const pos: any = await trx('analytics.cash_cuts').where('tenant_id', tenantId)
        .whereBetween('business_date', [from, to])
        .select(trx.raw('COALESCE(SUM(efectivo_contado),0)::numeric AS efectivo'), trx.raw('COUNT(*)::int AS n')).first();

      const por_dia = (dias as any[]).map((d) => {
        const key = ymd(d.fecha);
        const a = arqByDay.get(key);
        return {
          fecha: key, ingreso: r2(n(d.ingreso)), gasto: r2(n(d.gasto)), deposito: r2(n(d.deposito)),
          neto: r2(n(d.ingreso) - n(d.gasto)), n: n(d.n),
          arqueo_efectivo: a ? r2(a.efectivo) : null, arqueo_n: a ? a.n : 0,
        };
      });

      const ingreso = r2(por_dia.reduce((s, d) => s + d.ingreso, 0));
      const gasto = r2(por_dia.reduce((s, d) => s + d.gasto, 0));
      const deposito = r2(por_dia.reduce((s, d) => s + d.deposito, 0));
      const neto = r2(ingreso - gasto);
      // pass-through sano si el neto es chico vs el flujo (todo lo que entró salió). Tolerancia 2%.
      const cuadra = ingreso > 0 ? Math.abs(neto) <= ingreso * 0.02 : Math.abs(neto) < 1000;

      return {
        period: { from, to },
        totals: {
          ingreso, gasto, deposito, remisiones_gastos: r2(gasto - deposito), neto,
          cuadra, dias: por_dia.length,
        },
        ingreso_origen: og,
        pos_efectivo: { efectivo: r2(n(pos?.efectivo)), n: n(pos?.n) },
        por_dia,
      };
    });
  }

  /**
   * CG.10 / `[CGA-A.40]` — El Cuadre POR DÍA: la caja contra Kepler.
   *
   * La caja es el Control (el Access) hasta el día anterior al primer corte del libro, y desde ese
   * día el libro nuevo, por la fecha del documento (`[CGA-A.39]`). Del otro lado, la Caja General
   * de Kepler: tesorería (`account_label='CG'`) más los cobros de camioneta.
   *
   * ⛔ `[CGA-A.40]` **Aquí había una tercera fuente, el Workbook** (la hoja CAJA GENERAL del Sheet,
   * `finance.bank_movements kind='cash'`): la copia a mano del Control, que servía para cazar
   * errores de captura. Se quitó por decisión de Edgar (2026-10-20): se detuvo el 10-oct junto con
   * el Control (medido: su último día es el 10-oct) y del 12 en adelante no existe. Ojo, NO es el
   * «Workbook» de la pestaña Conciliación: aquél es el estado de cuenta del BANCO y sigue vivo.
   *
   * El nombre del endpoint (`conciliacion-workbook`) se conserva para no romper la pantalla
   * desplegada mientras convive con esta versión; ya no lee el Workbook.
   */
  async conciliacionWorkbook(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: unknown) => Number(x) || 0;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const key = ymd;
    return this.tk.run(async (trx) => {
      // Lado .mdb (Doctos) por día.
      const mdb = await trx('analytics.caja_general_movimientos')
        .where('tenant_id', tenantId).whereBetween('fecha', [from, to])
        .select('fecha', trx.raw('SUM(ingreso)::numeric AS ingreso'), trx.raw('SUM(gasto)::numeric AS gasto'), trx.raw('COUNT(*)::int AS n'))
        .groupBy('fecha');
      // CG.11 — Kepler tesorería, la CAJA GENERAL del ERP (account_label='CG').
      // signo>0=ingreso, signo<0=gasto; importe es magnitud positiva.
      const kp = await trx('analytics.kepler_bank_movements')
        // CONCENTRADOR: la CAJA GENERAL del ERP (clave 0011) se registra por sucursal (00-06);
        // kepler_bank_movements ya trae anti-réplica (cada doc una vez, por su dueño) → sin filtro
        // de sucursal para no perder los movimientos de las sucursales (antes solo veía suc 00).
        .where('tenant_id', tenantId).andWhere('account_label', 'CG')
        .andWhere('fecha_valor', '>=', from).andWhere('fecha_valor', '<=', to)
        .select(trx.raw('fecha_valor AS fecha'),
          trx.raw(`COALESCE(SUM(importe) FILTER (WHERE signo>0),0)::numeric AS ingreso`),
          trx.raw(`COALESCE(SUM(importe) FILTER (WHERE signo<0),0)::numeric AS gasto`),
          trx.raw('COUNT(*)::int AS n'))
        .groupBy('fecha_valor');
      // `[CGA-A.35]` Los cobros de camioneta también son Caja General de Kepler (ingresos).
      const ruta = await this.cobrosDeRuta(trx, tenantId, from, to);

      /**
       * ⭐ `[CGA-A.39]` Desde el primer corte del libro, la columna de la caja es el LIBRO (por la
       * fecha del documento), no el Control: el Control se detuvo el 10-oct, y sin esto el Cuadre
       * posterior no tenía contra qué cuadrar. Cada día es de una sola fuente (`caja_fuente`).
       */
      const desde = await this.libroDesde(trx, tenantId);
      const lib: Array<{ fecha: unknown; ingreso: string | number; gasto: string | number; n: number }> = desde && to >= desde
        ? await trx('finance.cash_ledger')
          .where('tenant_id', tenantId).whereNull('deleted_at').whereNot('estado', 'cancelado')
          .andWhere('fecha', '>=', from > desde ? from : desde).andWhere('fecha', '<=', to)
          .groupBy('fecha')
          .select('fecha',
            trx.raw(`COALESCE(SUM(monto) FILTER (WHERE tipo = 'ingreso'), 0)::numeric AS ingreso`),
            // `deposito` del lado del gasto: es efectivo que sale de la caja (hoy hay 0).
            trx.raw(`COALESCE(SUM(monto) FILTER (WHERE tipo <> 'ingreso'), 0)::numeric AS gasto`),
            trx.raw('COUNT(*)::int AS n'))
        : [];
      const blank = (k: string) => ({ fecha: k, caja_fuente: 'control' as 'control' | 'libro', mdb_ingreso: 0, mdb_gasto: 0, mdb_n: 0, kp_ingreso: 0, kp_gasto: 0, kp_n: 0 });
      const byDay = new Map<string, ReturnType<typeof blank>>();
      for (const r of mdb) { if (desde && key(r.fecha) >= desde) continue; const d = blank(key(r.fecha)); d.mdb_ingreso = n(r.ingreso); d.mdb_gasto = n(r.gasto); d.mdb_n = n(r.n); byDay.set(d.fecha, d); }
      for (const r of lib) { const d = blank(key(r.fecha)); d.caja_fuente = 'libro'; d.mdb_ingreso = n(r.ingreso); d.mdb_gasto = n(r.gasto); d.mdb_n = n(r.n); byDay.set(d.fecha, d); }
      for (const r of kp) { const k = key(r.fecha); const d = byDay.get(k) || blank(k); d.kp_ingreso = n(r.ingreso); d.kp_gasto = n(r.gasto); d.kp_n = n(r.n); byDay.set(k, d); }
      for (const r of ruta.rows) { const k = key(r.fecha); const d = byDay.get(k) || blank(k); d.kp_ingreso += n(r.importe); d.kp_n += 1; byDay.set(k, d); }

      /**
       * `[CGA-A.40]` La tolerancia del día contra Kepler es la que la pantalla ya usaba para esa
       * columna (`roundTol`): 10 centavos por movimiento, porque el Control capturaba redondeado
       * a 50 centavos y Kepler no. Con piso de ±$5 (`MATCH_EPS`), la misma con que casan los
       * movimientos. Ahora vive acá, en un solo lugar, y la pantalla la pinta en vez de recalcularla.
       */
      const tolDia = (d: { mdb_n: number; kp_n: number }) => Math.max(MATCH_EPS, 0.10 * Math.max(d.mdb_n, d.kp_n));
      // `[CGA-A.66]` Lo que la cola tiene de cada día. Sólo existe desde el primer corte del libro.
      const cola = await this.colaPorDia(trx, tenantId, from, to);
      const sinCola = { n: 0, ingreso: 0, gasto: 0 };
      const por_dia = Array.from(byDay.values()).map((d) => {
        // Un día sin caja pero posterior al relevo es del libro: Kepler movió y el libro no tiene
        // nada — eso se ve, no se esconde.
        const fuente = d.caja_fuente === 'libro' || (desde && d.fecha >= desde) ? 'libro' as const : 'control' as const;
        const dki = r2(d.mdb_ingreso - d.kp_ingreso), dkg = r2(d.mdb_gasto - d.kp_gasto);
        const tol = r2(tolDia(d));
        const sin_kepler = d.kp_n === 0;
        const cuadra = !sin_kepler && Math.abs(dki) <= tol && Math.abs(dkg) <= tol;
        // ⭐ `[CGA-A.66]` Cuadra · sólo falta capturar lo que está en la cola · no cuadra (motor puro).
        const c = cola.porDia.get(d.fecha) ?? sinCola;
        const { estado, resto_ingreso, resto_gasto } = estadoDiaCuadre({ delta_ingreso: dki, delta_gasto: dkg, tol, kp_n: d.kp_n, cola: c });
        return {
          fecha: d.fecha, caja_fuente: fuente, mdb_ingreso: r2(d.mdb_ingreso), mdb_gasto: r2(d.mdb_gasto), mdb_n: d.mdb_n,
          kp_ingreso: r2(d.kp_ingreso), kp_gasto: r2(d.kp_gasto), kp_n: d.kp_n,
          delta_kep_ingreso: dki, delta_kep_gasto: dkg, tol,
          // Sin Kepler ese día no hay contra qué medir: se DECLARA (`sin_kepler`), no se pinta rojo.
          sin_kepler,
          cuadra,
          estado,
          cola_n: c.n, cola_ingreso: r2(c.ingreso), cola_gasto: r2(c.gasto),
          resto_ingreso, resto_gasto,
        };
      }).sort((a, b) => b.fecha.localeCompare(a.fecha));

      const sum = (k: 'mdb_ingreso' | 'mdb_gasto' | 'kp_ingreso' | 'kp_gasto' | 'cola_ingreso' | 'cola_gasto' | 'cola_n') => r2(por_dia.reduce((s, d) => s + d[k], 0));
      const tot = { mdb_ingreso: sum('mdb_ingreso'), mdb_gasto: sum('mdb_gasto'), kp_ingreso: sum('kp_ingreso'), kp_gasto: sum('kp_gasto') };
      const enEstado = (e: string) => por_dia.filter((d) => d.estado === e).length;
      return {
        period: { from, to },
        // `[CGA-A.66]` La edad de Kepler y de la cola: el mismo carril que la bandeja de Captura.
        datos_al: await frescuraCaja(trx, tenantId),
        totals: {
          ...tot,
          delta_kep_ingreso: r2(tot.mdb_ingreso - tot.kp_ingreso), delta_kep_gasto: r2(tot.mdb_gasto - tot.kp_gasto),
          dias: por_dia.length,
          dias_con_kepler: por_dia.filter((d) => !d.sin_kepler).length,
          // ⚠️ Se queda como estaba (todo lo que no cuadra, falte capturar o no) para el frontend
          // anterior al despliegue; el que parte el rojo lee los dos de abajo.
          dias_descuadre: por_dia.filter((d) => !d.sin_kepler && !d.cuadra).length,
          dias_por_capturar: enEstado('por_capturar'),
          dias_no_cuadra: enEstado('no_cuadra'),
          // `[CGA-A.66]` La cola del rango, para decir cuánto trabajo explica el ámbar.
          cola: { disponible: cola.disponible, n: sum('cola_n'), ingreso: sum('cola_ingreso'), gasto: sum('cola_gasto') },
          libro_desde: desde,
          dias_libro: por_dia.filter((d) => d.caja_fuente === 'libro').length,
          kep_disponible: kp.length > 0 || ruta.rows.length > 0,
          // `[CGA-A.35]` false = la lectura de camionetas falló: la columna Kepler está incompleta.
          ruta_disponible: ruta.disponible,
        },
        por_dia,
        // El TOTAL DEL MES acumula el redondeo de ~30 días: con la tolerancia del día marcaría
        // descuadre aunque cada día cuadre. `CUADRE_EPS` es la de totales, la del Cuadre de Bancos.
        eps: MATCH_EPS, eps_total: CUADRE_EPS,
      };
    });
  }

  /**
   * CG.10 — Movimientos del lado MANUAL (workbook, finance.bank_movements kind='cash')
   * para el desglose por día del "Vs Workbook". Espejo del `/general` pero del lado
   * manual, para comparar movimiento a movimiento contra el .mdb en el día expandido.
   */
  async workbookMovimientos(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: any) => Number(x) || 0;
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.bank_movements as bm')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .where('bm.tenant_id', tenantId).whereRaw(`coalesce(ba.kind,'bank')='cash'`).whereNull('bm.deleted_at')
        .whereBetween('bm.movement_date', [from, to])
        .orderBy([{ column: 'bm.movement_date', order: 'desc' }, { column: 'bm.id', order: 'desc' }])
        .limit(500)
        .select('bm.id', 'bm.movement_date as fecha', 'bm.concept', 'bm.sucursal', 'bm.raw_code',
          'bm.amount_in', 'bm.amount_out');
      const suc = await this.finanzasSucursalNamer(trx, tenantId, this.inst(q));
      return {
        movimientos: (rows as any[]).map((r) => ({
          id: r.id, fecha: r.fecha, concepto: r.concept, sucursal: suc(r.sucursal), codigo: r.raw_code,
          ingreso: n(r.amount_in), gasto: n(r.amount_out),
        })),
      };
    });
  }

  /**
   * CG.11 — Movimientos del lado KEPLER (tesorería, CAJA GENERAL account_label='CG')
   * para el desglose por día del "Vs Workbook". 3ª columna del drill: qué registró el
   * ERP ese día vs la caja operativa (.mdb) y la copia manual (workbook).
   */
  async keplerMovimientos(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: any) => Number(x) || 0;
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.kepler_bank_movements')
        // CONCENTRADOR: la CAJA GENERAL del ERP (clave 0011) se registra por sucursal (00-06);
        // kepler_bank_movements ya trae anti-réplica (cada doc una vez, por su dueño) → sin filtro
        // de sucursal para no perder los movimientos de las sucursales (antes solo veía suc 00).
        .where('tenant_id', tenantId).andWhere('account_label', 'CG')
        .andWhere('fecha_valor', '>=', from).andWhere('fecha_valor', '<=', to)
        .orderBy([{ column: 'fecha_valor', order: 'desc' }, { column: 'folio', order: 'desc' }])
        .limit(500)
        .select('sucursal', 'folio', 'fecha_valor as fecha', 'concepto', 'beneficiario', 'doc_tipo', 'importe', 'signo');
      // `[CGA-A.35]` Más los cobros de camioneta, y el mismo orden y tope sobre la unión.
      const ruta = await this.cobrosDeRuta(trx, tenantId, from, to);
      const todos = [...(rows as Array<{ fecha: unknown; folio: string; sucursal: string; concepto: string | null; beneficiario: string | null; doc_tipo: string; importe: number | string; signo: number | string }>), ...ruta.rows]
        .sort((a, b) => ymd(b.fecha).localeCompare(ymd(a.fecha)) || String(b.folio).localeCompare(String(a.folio)))
        .slice(0, 500);
      return {
        ruta_disponible: ruta.disponible,
        // id compuesto por sucursal+folio: con el concentrador el folio se repite entre sucursales.
        // `sucursal` es la sucursal Kepler con nombre (antes viajaba el beneficiario en ese campo);
        // el beneficiario se conserva como concepto cuando el pago no trae concepto (X-D-26 casi nunca).
        movimientos: todos.map((r) => ({
          id: `${r.sucursal}-${r.folio}`, fecha: r.fecha, concepto: r.concepto || r.beneficiario || null, sucursal: this.keplerSucursal(r.sucursal), codigo: r.doc_tipo,
          ingreso: n(r.signo) > 0 ? n(r.importe) : 0, gasto: n(r.signo) < 0 ? n(r.importe) : 0,
        })),
      };
    });
  }

  /**
   * CG.12 — Drill "¿dónde está el descuadre?" de la caja — ESPEJO del de Bancos
   * (finance-bank.contpaqiAccountDetail). Para UN día, enfrenta movimiento a movimiento
   * la caja operativa (.mdb) contra las OTRAS dos fuentes por separado — Manual (workbook)
   * y Kepler (ERP) — casando greedy por importe ±MATCH_EPS dentro de cada dirección (ingreso/gasto),
   * y devuelve los HUÉRFANOS de cada lado (los movimientos que faltan/sobran). La suma de
   * huérfanos explica el Δ, igual que en Bancos.
   */
  async conciliacionDia(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: any) => Number(x) || 0;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    // Etiqueta uniforme de un movimiento (para render idéntico en el frontend). `source` + `key`
    // (PK completa codificada) habilitan el click → detalle completo del movimiento (movementDetail).
    // Cumple `MovCuadre` (key/importe/fecha), que es lo que el motor necesita para ordenar.
    // `[CGA-A.39]` `libro` = un movimiento del libro nuevo (desde el relevo); `ref` = su llave de Kepler.
    type Lbl = MovCuadre & { id: string; source: 'control' | 'workbook' | 'kepler' | 'libro'; concepto: string | null; extra: string | null; ref?: string | null };

    /**
     * ⭐ El casamiento vive ahora en `caja-cuadre.engine.ts`, con pruebas. Acá había un greedy
     * que consumía del otro lado **en el orden en que Postgres hubiera devuelto las filas** — y
     * ninguno de los tres `SELECT` de abajo tiene `ORDER BY`. Dos cargas del mismo día podían
     * publicar huérfanos distintos, o sea **un descuadre distinto sin que cambiara un dato**.
     *
     * ⚠️ La garantía de orden vive en el MOTOR (`ordenCanonico`), no en el SQL: no hace falta
     * agregar `ORDER BY` a los SELECT, y agregarlo no alcanzaría (el orden también depende del
     * otro lado y de cómo se consume). Si alguien "arregla" esto poniendo un ORDER BY y sacando
     * el motor, vuelve el problema.
     *
     * MEDIDO en `platform_test` (jul→sep 2026, 3,746 movimientos del Control con importe):
     * **965 (25.8%, $1,519,632.85) tienen más de un candidato a ±$5 el mismo día y dirección.**
     * Ése es exactamente el conjunto donde el orden —hasta hoy indefinido— decidía la respuesta.
     */
    const adapta = (res: ResultadoCuadre<Lbl> & { pares: ParLibro<Lbl>[] }) => ({
      caja_total: res.caja_total, other_total: res.otro_total, delta: res.delta,
      matched_count: res.casados_n, matched_amount: res.casados_monto,
      // `[CGA-A.39]` `identidad` = el par salió de la LLAVE del libro, no de un parecido de importe.
      pairs: res.pares.map((p) => ({ caja: p.caja, other: p.otro, ambiguo: p.ambiguo, candidatos: p.candidatos, delta: p.delta, identidad: p.identidad === true })),
      caja_only: res.caja_solos, other_only: res.otro_solos,
      caja_only_amount: res.caja_solos_monto, other_only_amount: res.otro_solos_monto,
      // Lo que el casamiento NO sabe, dicho: cuántos pudieron haber casado con otra cosa y
      // cuántos existen sólo gracias a la tolerancia.
      ambiguos_n: res.ambiguos_n, inexactos_n: res.inexactos_n, tolerancia: res.tolerancia,
    });

    return this.tk.run(async (trx) => {
      const mdbTodo = await trx('analytics.caja_general_movimientos')
        .where('tenant_id', tenantId).whereBetween('fecha', [from, to])
        .select('tipo_dto', 'mov_id', 'fecha', 'concepto', 'cuenta_nombre', 'nombre_cliente', 'ingreso', 'gasto');
      /**
       * ⭐ `[CGA-A.39]` **El lado de la caja cambia de fuente en el relevo.** Hasta el día anterior
       * al primer corte del libro, la caja es el Control (el Access); desde ese día, el libro nuevo
       * (`finance.cash_ledger`), por la fecha del documento. Cada día es de UNA sola fuente: si el
       * Control volviera a recibir movimientos de después del relevo no se sumarían al libro — se
       * verían en «General», no aquí, para no contar dos veces el mismo efectivo.
       */
      const desde = await this.libroDesde(trx, tenantId);
      const mdb = mdbTodo.filter((r: { fecha: unknown }) => !desde || ymd(r.fecha) < desde);
      const libro = desde && to >= desde ? await this.movimientosDelLibro(trx, tenantId, from > desde ? from : desde, to) : [];
      const kep = await trx('analytics.kepler_bank_movements')
        // CONCENTRADOR: la CAJA GENERAL del ERP (clave 0011) se registra por sucursal (00-06);
        // kepler_bank_movements ya trae anti-réplica (cada doc una vez, por su dueño) → sin filtro
        // de sucursal para no perder los movimientos de las sucursales (antes solo veía suc 00).
        .where('tenant_id', tenantId).andWhere('account_label', 'CG')
        .andWhere('fecha_valor', '>=', from).andWhere('fecha_valor', '<=', to)
        .select('sucursal', 'clave_banco', 'folio', 'fecha_valor as fecha', 'concepto', 'beneficiario', 'doc_tipo', 'importe', 'signo');
      // `[CGA-A.35]` Los cobros de camioneta son Caja General de Kepler aunque no vivan en la
      // tesorería: sin ellos, el día publicaba como «solo Control» lo que la ruta sí registró.
      const ruta = await this.cobrosDeRuta(trx, tenantId, from, to);
      kep.push(...ruta.rows);

      /**
       * ⛔ Acá decía `const key = (f: any) => String(f).slice(0, 10)`, y eso **no devuelve una
       * fecha**: pg entrega un `date` como objeto `Date`, y `String(new Date(...)).slice(0,10)`
       * da **`"Sat Oct 03"`**. Estaba a la vista en la columna FECHA del detalle del día y nadie
       * lo leyó como un defecto — parecía un formato feo, no un dato roto.
       *
       * Rompía tres cosas a la vez:
       *   1. la fecha que se imprime (`dmy()` no puede formatear "Sat Oct 03");
       *   2. **el orden de las filas**: el `.sort()` de abajo hace `a.fecha.localeCompare(b.fecha)`
       *      sobre ese texto, o sea alfabético por día de la semana — `Fri < Mon < Sat < Tue`;
       *   3. cualquier consumidor que intente parsearla (el resolvedor de ruta de `[CG.20]`
       *      recibía `"Sat Oct 03"` y devolvía null en TODAS las filas, que es como se encontró).
       *
       * `ymd` ya vive en este archivo —y dos métodos más abajo ya se usa como `const key = ymd`—
       * y arma la fecha con las partes LOCALES, no por UTC. Es el mismo defecto de `[LC.16]`.
       */
      const key = ymd;

      /**
       * ⭐ [CG.20] CUARTA FUENTE: **la venta que registró el Kepler de la propia camioneta.**
       *
       * El Cuadre tenía tres columnas y para la venta de ruta la de Kepler sale casi siempre
       * vacía. Medido el 2026-10-06 contra prod: la tesorería de Kepler (el cobro `U-A-5` a la
       * cuenta CAJA GENERAL) **sólo llega al día de venta 1 de octubre y sólo para Padre
       * Hidalgo**; Canindo tiene CERO cobros de octubre, así que sus tres movimientos del 03-oct
       * —$25,728.50, $22,891.50 y $19,909.00— se publicaban con un guion. Ese guion era honesto
       * pero inútil: decía "la tesorería no lo registró", no "esta venta no existe".
       *
       * Y sí existe: la camioneta la registró en SU Kepler el mismo día. Los tres casan con
       * $25,728.75 / $22,891.56 / $19,908.71 — **tres, seis y veintinueve centavos**.
       *
       * ⛔ Y no se casa por importe: se casa por IDENTIDAD. El texto del capturista declara la
       * ruta y el día (`Ventas Canindo 01/10 RD 501`), así que la llave es (ruta, día de venta) y
       * no "dos números parecidos". Por eso esta fuente NO pasa por `casarPorImporte` y no puede
       * salir `ambiguo`: o el texto declara una ruta del registro y hay venta ese día, o no.
       *
       * ⚠️ La ruta declarada se valida contra `analytics.v_route_zone`. Sin eso, el
       * `Ventas Canindo 02/10 RD501` que está en producción —y cuyo importe es el de la ruta
       * **502**— se postearía a la 501 sin que nada avise. Un número que no es ruta se rechaza.
       */
      const declarado = (mdb as any[]).map((r) => {
        if (n(r.ingreso) <= 0) return null;   // la venta de ruta ENTRA; un gasto nunca es una venta
        const d = leerVentaDeRuta(r.nombre_cliente);
        if (!d) return null;
        const dia = fechaDeVentaDeclarada(r.nombre_cliente, key(r.fecha));
        return dia ? { mov: `${r.tipo_dto}|${r.mov_id}`, ruta: d.ruta, dia } : null;
      }).filter(Boolean) as { mov: string; ruta: string; dia: string }[];

      const rutaPorMov = new Map<string, { ruta: string; dia: string }>();
      const ventaRuta = new Map<string, { venta: number; tickets: number }>();
      const rutasInvalidas = new Set<string>();
      if (declarado.length) {
        const registro = new Set((await trx('analytics.v_route_zone')
          .where('tenant_id', tenantId).select('route_code')).map((r: any) => String(r.route_code)));
        const pares = declarado.filter((d) => {
          if (registro.has(d.ruta)) return true;
          rutasInvalidas.add(d.ruta);
          return false;
        });
        for (const d of pares) rutaPorMov.set(d.mov, { ruta: d.ruta, dia: d.dia });
        if (pares.length) {
          const rutas = [...new Set(pares.map((d) => d.ruta))];
          const dias = pares.map((d) => d.dia).sort();
          const ventas = await trx('analytics.v_rd_route_daily')
            .where('tenant_id', tenantId).whereIn('route_code', rutas)
            .whereBetween('business_date', [dias[0], dias[dias.length - 1]])
            .select('route_code', 'business_date', 'venta', 'tickets');
          for (const v of ventas as any[]) {
            ventaRuta.set(`${v.route_code}|${key(v.business_date)}`, { venta: r2(n(v.venta)), tickets: n(v.tickets) });
          }
        }
      }

      const mdbSide = (dir: 'ingreso' | 'gasto') => (mdb as any[]).filter((r) => n(r[dir]) > 0).map((r) => ({
        amt: n(r[dir]), lbl: { id: String(r.mov_id), source: 'control' as const, key: `${r.tipo_dto}|${r.mov_id}`, fecha: key(r.fecha), importe: r2(n(r[dir])), concepto: r.concepto || null, extra: r.cuenta_nombre || r.nombre_cliente || null } }));
      const kepSide = (sign: 1 | -1) => (kep as any[]).filter((r) => (n(r.signo) > 0 ? 1 : -1) === sign).map((r) => ({
        amt: n(r.importe), lbl: { id: String(r.folio), source: 'kepler' as const, key: `${r.sucursal}|${r.doc_tipo}|${r.folio}|${r.clave_banco}`, fecha: key(r.fecha), importe: r2(n(r.importe)), concepto: r.concepto || null, extra: [this.keplerSucursal(r.sucursal), r.doc_tipo, r.beneficiario].filter(Boolean).join(' · ') || null } }));

      /**
       * ⭐ [CG.20.1] LA LLAVE ESTÁ DE LOS DOS LADOS, y hasta hoy no se usaba de ninguno.
       *
       * El cobro de Kepler trae en su `concepto` la ruta y el día — `VENTA RD 27 01-10-2026`,
       * con beneficiario `R.D. 27 PH Martinez Patlan Mariano`. O sea que la identidad
       * (ruta, día de venta) está escrita en el ERP igual que en la caja. Casarlos por importe
       * ±$5, teniendo eso, era tirar la llave y adivinar.
       *
       * Acá se indexa el lado Kepler por esa identidad. En `rows` tiene PRECEDENCIA sobre el
       * casamiento por importe: un par por identidad no puede ser ambiguo, y el de importe sí
       * (medido: 25.8% de los movimientos tienen más de un candidato a esa distancia).
       *
       * ⚠️ Si dos cobros declaran la misma (ruta, día) —pasa cuando un día se cobra en dos
       * partidas— la identidad deja de ser única y **no se usa**: esa fila vuelve al casamiento
       * por importe, que al menos declara su ambigüedad. Una llave que colapsa es peor que
       * ninguna, porque no avisa.
       */
      const kepIdentCount = new Map<string, number>();
      const kepIdent = new Map<string, Lbl>();
      for (const sign of [1, -1] as const) {
        for (const x of kepSide(sign)) {
          const dia = fechaDeVentaDeclarada(x.lbl.concepto, x.lbl.fecha);
          const d = leerVentaDeRuta(x.lbl.concepto);
          if (!dia || !d) continue;
          const id = `${sign > 0 ? 'in' : 'out'}|${d.ruta}|${dia}`;
          kepIdentCount.set(id, (kepIdentCount.get(id) ?? 0) + 1);
          kepIdent.set(id, x.lbl);
        }
      }
      for (const [id, n2] of kepIdentCount) if (n2 > 1) kepIdent.delete(id);

      // `[CGA-A.39]` El lado del LIBRO, con la misma forma que el del Control y su llave de Kepler.
      const libSide = (dir: 'in' | 'out') => libro.filter((r) => r.dir === dir).map((r) => ({
        amt: n(r.monto), lbl: { id: r.folio, source: 'libro' as const, key: `libro|${r.folio}`, fecha: key(r.fecha), importe: r2(n(r.monto)),
          concepto: r.glosa || null, extra: [r.folio, r.beneficiario].filter(Boolean).join(' · ') || null, ref: r.ref } as Lbl }));
      const ctlIn = mdbSide('ingreso'), ctlGas = mdbSide('gasto');
      const libIn = libSide('in'), libGas = libSide('out');
      const mdbIn = [...ctlIn, ...libIn], mdbGas = [...ctlGas, ...libGas];
      // `[CGA-A.40]` Ya no se casa contra el Workbook de caja (la copia a mano del Control): se quitó.

      // Documentos de Kepler que el libro nombra y que caen en OTRO día: se casan igual, por llave.
      const enDia = new Set(kep.map((r: { sucursal: string; doc_tipo: string; folio: string; clave_banco: string }) => `${r.sucursal}|${r.doc_tipo}|${r.folio}|${r.clave_banco}`));
      const refsFuera = [...new Set(libro.map((r) => r.ref).filter((k): k is string => !!k && !enDia.has(k)))];
      const fuera = new Map((await this.docsKeplerPorLlave(trx, tenantId, refsFuera)).map((r) => {
        const k = `${r.sucursal}|${r.doc_tipo}|${r.folio}|${r.clave_banco}`;
        return [k, { id: String(r.folio), source: 'kepler' as const, key: k, fecha: key(r.fecha), importe: r2(n(r.importe)), concepto: r.concepto || null,
          extra: [this.keplerSucursal(r.sucursal), r.doc_tipo, r.beneficiario, `doc del ${key(r.fecha)}`].filter(Boolean).join(' · ') || null } as Lbl] as const;
      }));
      const cuadraDir = (ctl: { lbl: Lbl }[], lib: { lbl: Lbl }[], sign: 1 | -1) => {
        const k = kepSide(sign).map((x) => x.lbl);
        const kCtl = desde ? k.filter((x) => x.fecha < desde) : k;
        const kLib = desde ? k.filter((x) => x.fecha >= desde) : [];
        return adapta(juntaCuadres(
          casarPorImporte(ctl.map((x) => x.lbl), kCtl, MATCH_EPS),
          casarLibroConKepler(lib.map((x) => x.lbl), kLib, MATCH_EPS, fuera),
        ));
      };
      const vsKep0 = { ingresos: cuadraDir(ctlIn, libIn, 1), gastos: cuadraDir(ctlGas, libGas, -1) };

      /**
       * ⭐ `[CGA-A.35]` **«Solo Kepler» no quiere decir «falta capturar».** El Control dejó de
       * capturarse el 10-oct y el libro nuevo (`finance.cash_ledger`) tomó la caja desde el 12:
       * medido, de 202 documentos «solo Kepler» del 12 al 20-oct, **165 ya estaban en el libro**.
       * Cada huérfano de Kepler lleva ahora `en_libro` — el folio que lo capturó, buscado por LLAVE
       * (`origen_ref`, o `declared_doc_ref` si vino de CAOS: la regla `[CGA-A.10]` de la bandeja) —
       * y los totales separan lo ya capturado de lo que de verdad falta.
       */
      const solosKey = [...vsKep0.ingresos.other_only, ...vsKep0.gastos.other_only].map((o) => o.key);
      const libroRows: RenglonLibro[] = solosKey.length
        ? await trx('finance.cash_ledger')
          .where('tenant_id', tenantId).whereNull('deleted_at').whereNot('estado', 'cancelado')
          .where((w: Knex.QueryBuilder) => w.whereIn('origen_ref', solosKey).orWhereIn('declared_doc_ref', solosKey))
          .select('folio', 'estado', 'origen_tipo', 'origen_ref', 'declared_doc_ref')
        : [];
      const idxLibro = indexaLibro(libroRows);
      const conLibro = (side: typeof vsKep0.ingresos) => ({ ...side, other_only: marcaEnLibro(side.other_only, idxLibro) });
      const vs_kepler = { ingresos: conLibro(vsKep0.ingresos), gastos: conLibro(vsKep0.gastos) };
      const keplerLibro = resumeEnLibro([...vs_kepler.ingresos.other_only, ...vs_kepler.gastos.other_only]);

      // Índice `key del Control` → par casado, por lado y dirección (ver el comentario en `rows`).
      const indexa = (pares: { caja: Lbl; other: Lbl; ambiguo: boolean; delta: number; identidad?: boolean }[]) =>
        new Map(pares.map((p) => [p.caja.key, p]));
      const idxKepIn = indexa(vs_kepler.ingresos.pairs), idxKepOut = indexa(vs_kepler.gastos.pairs);

      /**
       * Modelo de fila único: UN movimiento del Control por renglón, con lo que casó en cada
       * fuente. Es el mismo shape que el detalle del Cuadre de Bancos (un movimiento del
       * banco + banderas/importes de Kepler y ContPAQi), y sale de unir los cuatro matchings
       * —que corren por separado porque cada uno casa dentro de su dirección— sobre la lista
       * de movimientos del Control, que es la misma para ambas fuentes.
       */
      const rows = [
        ...mdbIn.map((m) => ({ m, dir: 'in' as const })),
        ...mdbGas.map((m) => ({ m, dir: 'out' as const })),
      ].map(({ m, dir }) => {
        // Enlazar por `key` (tipo_dto|mov_id), NO por `id`: mov_id es el IdDocto y sólo es único
        // POR tipo_dto. Dos movimientos del día con el mismo mov_id compartían el mismo par.
        // Índice en vez de `pairs.find()`: era O(n²) sobre miles de filas (~28M comparaciones en
        // un mes), y esta pantalla tiene presupuesto de 1 s.
        const kep2 = (dir === 'in' ? idxKepIn : idxKepOut).get(m.lbl.key) ?? null;
        // [CG.20] La cuarta vía. `rt` = lo que el texto declara; `vt` = lo que la camioneta
        // registró. Que `rt` exista y `vt` no es un hallazgo, no un hueco de render: significa
        // que entró el efectivo de una venta que la ruta no reportó (medido: la 504 el 02-oct,
        // $28,678 en la caja contra cero venta en su Kepler). Por eso viaja `ruta_motivo`.
        const rt = rutaPorMov.get(m.lbl.key) ?? null;
        const vt = rt ? (ventaRuta.get(`${rt.ruta}|${rt.dia}`) ?? null) : null;
        // [CG.20.1] El cobro de Kepler que declara ESTA MISMA (ruta, día). Gana sobre el par por
        // importe: es una identidad, no un parecido.
        const kepId = rt ? (kepIdent.get(`${dir}|${rt.ruta}|${rt.dia}`) ?? null) : null;

        /**
         * Qué va en la celda de Kepler, por orden de fuerza de la evidencia:
         *   1. el cobro del ERP casado por IDENTIDAD (ruta + día declarados de los dos lados);
         *   2. el cobro casado por importe ±$5, como siempre (con su `~` si fue ambiguo);
         *   3. la venta que registró el Kepler DE LA CAMIONETA, cuando la tesorería no la tiene
         *      — que es el caso de Canindo en octubre, medido: cero cobros del mes;
         *   4. nada, y si el texto declaraba una venta de ruta, el motivo de por qué nada.
         * Las cuatro viven en la MISMA columna porque las cuatro son Kepler; lo que cambia es de
         * qué documento salen, y eso lo dice `kepler_origen` y lo abre el clic.
         */
        const kepLbl = kepId ?? (kep2 ? kep2.other : null);
        const porIdentidad = !!kepId;
        // `[CGA-A.39]` Un movimiento del LIBRO casado por su documento: certeza, como la identidad,
        // pero OTRO método — no es una venta de ruta declarada, y no debe contarse como tal.
        const porLlave = !kepId && !!kep2?.identidad;
        const usaRuta = !kepLbl && !!vt;
        const kImporte = kepLbl ? kepLbl.importe : (usaRuta ? (vt as { venta: number }).venta : null);
        return {
          id: m.lbl.id, key: m.lbl.key, fecha: m.lbl.fecha, dir, importe: m.lbl.importe,
          concepto: m.lbl.concepto, extra: m.lbl.extra,
          // `[CGA-A.39]` De qué fuente es ESTE renglón de la caja: el Control o el libro nuevo.
          source: m.lbl.source,
          kepler: !!kepLbl || usaRuta,
          kepler_importe: kImporte,
          // La referencia dice de QUÉ documento salió. Con el cobro, el que ya se imprimía
          // (sucursal · doc · beneficiario); con la venta de la camioneta, ruta y día.
          kepler_ref: kepLbl ? kepLbl.extra : (usaRuta ? `Ruta ${rt?.ruta} · venta del ${rt?.dia}` : null),
          // La llave que abre el detalle. `ruta|<n>|<dia>` es una fuente propia en movementDetail:
          // no hay un folio de tesorería que abrir porque ese cobro no existe.
          kepler_key: kepLbl ? kepLbl.key : (usaRuta ? `${rt?.ruta}|${rt?.dia}` : null),
          kepler_source: kepLbl ? ('kepler' as const) : (usaRuta ? ('ruta' as const) : null),
          /**
           * De dónde salió el número y con qué método. Son tres cosas distintas y la pantalla
           * las pinta distinto:
           *   `identidad`  el cobro del ERP que declara la misma ruta y el mismo día — certeza;
           *   `importe`    el casamiento de siempre, ±$5, que puede ser ambiguo;
           *   `ruta`       no hay cobro en tesorería: es la venta del Kepler de la camioneta.
           */
          //   `llave`      `[CGA-A.39]` el documento que el propio movimiento del libro trae — certeza.
          kepler_origen: porIdentidad ? ('identidad' as const) : porLlave ? ('llave' as const) : (kepLbl ? ('importe' as const) : (usaRuta ? ('ruta' as const) : null)),
          // ⭐ Cuánto vale ESTE casamiento. `ambiguo` = había más de un candidato a la misma
          // distancia de importe, o sea que pudo haber casado con otro movimiento; `delta` ≠ 0 =
          // existe sólo porque la tolerancia de ±$5 lo permitió. Sin esto, un par forzado y un par
          // que salió de 40 iguales se pintaban idénticos, y la pantalla insinuaba una certeza
          // que el método no tiene (M3: ligar por importe+fecha es un atributo débil).
          // Un par por identidad NO puede ser ambiguo: la llave es única o no se usa.
          kepler_ambiguo: porIdentidad ? false : !!kep2?.ambiguo,
          kepler_delta: kImporte == null ? null : r2(m.lbl.importe - kImporte),
          // El texto declaró una venta de ruta y esa ruta no reportó venta: entró efectivo que
          // ningún Kepler registra. Es un hallazgo, no un hueco de render.
          kepler_motivo: rt && !kepLbl && !vt ? `la ruta ${rt.ruta} no reportó venta el ${rt.dia}` : null,
        };
        // Desempate final por `key`: sin él, dos movimientos del mismo día y mismo importe
        // quedaban en orden indefinido — el mismo defecto que este commit vino a matar.
      }).sort((a, b) => a.fecha.localeCompare(b.fecha) || b.importe - a.importe || a.key.localeCompare(b.key));

      const sumaLados = (v: typeof vs_kepler, k: 'ambiguos_n' | 'inexactos_n') => v.ingresos[k] + v.gastos[k];
      const totals = {
        control_n: rows.length,
        control_monto: r2(rows.reduce((s, r) => s + r.importe, 0)),
        en_kepler: rows.filter((r) => r.kepler).length,
        kepler_only_n: vs_kepler.ingresos.other_only.length + vs_kepler.gastos.other_only.length,
        kepler_only_monto: r2(vs_kepler.ingresos.other_only_amount + vs_kepler.gastos.other_only_amount),
        // `[CGA-A.35]` De esos «solo Kepler»: cuántos ya capturó el libro nuevo y cuántos faltan.
        kepler_only_en_libro_n: keplerLibro.en_libro_n, kepler_only_en_libro_monto: keplerLibro.en_libro_monto,
        kepler_only_pendiente_n: keplerLibro.pendiente_n, kepler_only_pendiente_monto: keplerLibro.pendiente_monto,
        // false = la lectura de camionetas falló y el lado Kepler está incompleto (no «no hubo»).
        ruta_cobros_disponible: ruta.disponible,
        // Cuánto de lo que se ve casado es una decisión del algoritmo y no un hecho.
        kepler_ambiguos_n: sumaLados(vs_kepler, 'ambiguos_n'), kepler_inexactos_n: sumaLados(vs_kepler, 'inexactos_n'),
        // ⚠️ Un lado vacío NO es "todo descuadrado": es una fuente que no tiene datos en el
        // periodo. Se declara, igual que en `conciliacion()` (ADR-056).
        kepler_disponible: (kep as any[]).length > 0,
        tolerancia: MATCH_EPS,
        // [CG.20] La cuarta vía se mide aparte porque su universo es otro: sólo aplica a los
        // movimientos que DECLARAN una venta de ruta, no a los 11 del día. Publicar
        // "3 de 11 en Ruta" leería como cobertura mala cuando 8 de esos 11 no son ventas de ruta.
        ruta_declarados: rows.filter((r) => r.kepler_origen === 'identidad' || r.kepler_origen === 'ruta' || r.kepler_motivo).length,
        ruta_casados: rows.filter((r) => r.kepler_origen === 'identidad' || r.kepler_origen === 'ruta').length,
        ruta_sin_venta: rows.filter((r) => !!r.kepler_motivo).length,
        // Cuántos de los pares con Kepler salieron de una IDENTIDAD y no de un parecido de importe.
        kepler_por_identidad: rows.filter((r) => r.kepler_origen === 'identidad').length,
        // `[CGA-A.39]` De qué fuente es la caja en este rango, y cuántos del libro casaron por su documento.
        caja_fuente: (libro.length && mdb.length ? 'mixto' : libro.length || (desde && from >= desde) ? 'libro' : 'control') as 'control' | 'libro' | 'mixto',
        libro_desde: desde,
        libro_n: libro.length,
        kepler_por_llave: rows.filter((r) => r.kepler_origen === 'llave').length,
        // Un número que el texto llama ruta y el registro operativo no conoce. Se cuenta, porque
        // si esto sube es que alguien está tecleando una ruta que no existe.
        ruta_no_reconocidas: [...rutasInvalidas],
      };

      return { period: { from, to }, vs_kepler, rows, totals };
    });
  }

  /**
   * CG.18 — Detalle COMPLETO de un movimiento del Cuadre (click en el drill de las 3 vías).
   * Devuelve TODOS los campos del registro crudo de la fuente como pares {label,value}
   * ordenados (render genérico). `key` = PK codificada que arma conciliacionDia (partes '|').
   */
  async movementDetail(source: string, key: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const money = (v: any) => (v == null || v === '' ? null : Number(v));
    if (!key) throw new BadRequestException('key requerido');
    return this.tk.run(async (trx) => {
      if (source === 'control') {
        const [tipo_dto, mov_id] = String(key).split('|');
        const r: any = await trx('analytics.caja_general_movimientos').where({ tenant_id: tenantId, tipo_dto, mov_id }).first();
        if (!r) throw new BadRequestException('movimiento no encontrado');
        return { source, title: `Control · ${r.tipo || r.tipo_dto} ${r.mov_id}`, fields: [
          { label: 'Fecha', value: ymd(r.fecha) }, { label: 'Hora', value: r.hora },
          { label: 'Tipo', value: r.tipo }, { label: 'Documento', value: `${r.tipo_dto}-${r.mov_id}` },
          { label: 'Cuenta', value: `${r.cuenta_nombre || ''} (#${r.cuenta})` }, { label: 'Cliente', value: r.nombre_cliente },
          { label: 'Concepto', value: r.concepto }, { label: 'Usuario', value: r.usuario },
          { label: 'Ingreso', value: money(r.ingreso) }, { label: 'Gasto', value: money(r.gasto) },
          { label: 'Depósito', value: money(r.deposito) }, { label: 'Efectivo', value: money(r.efectivo) },
          { label: 'Saldo', value: money(r.saldo) }, { label: 'Corte', value: r.corte },
          { label: 'Dólar', value: money(r.dolar) }, { label: 'Tipo cambio', value: money(r.tipo_cambio) },
        ] };
      }
      if (source === 'workbook') {
        const r: any = await trx('finance.bank_movements as bm')
          .leftJoin('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
          .where('bm.id', key).andWhere('bm.tenant_id', tenantId)
          .first('bm.*', trx.raw('ba.alias as cuenta_alias'), trx.raw('mc.name as categoria'));
        if (!r) throw new BadRequestException('movimiento no encontrado');
        const suc = await this.finanzasSucursalNamer(trx, tenantId, 'SI');
        return { source, title: `Workbook · ${r.cuenta_alias || ''} ${ymd(r.movement_date)}`, fields: [
          { label: 'Fecha', value: ymd(r.movement_date) }, { label: 'Cuenta', value: r.cuenta_alias },
          { label: 'Tipo (M)', value: r.raw_type }, { label: 'Código (C)', value: r.raw_code },
          { label: 'Sucursal', value: suc(r.sucursal) }, { label: 'Concepto', value: r.concept },
          { label: 'Categoría', value: r.categoria }, { label: 'Clasificado por', value: r.classified_by },
          { label: 'Ingreso', value: money(r.amount_in) }, { label: 'Gasto', value: money(r.amount_out) },
          { label: 'Saldo', value: money(r.running_balance) }, { label: 'Origen sync', value: r.sync_source },
          { label: 'Archivo', value: r.source_file }, { label: 'Conciliación', value: r.recon_status },
        ] };
      }
      // `[CGA-A.39]` Un movimiento del LIBRO nuevo (la caja desde el relevo). key = `libro|<folio>`.
      if (source === 'libro') {
        const folio = String(key).replace(/^libro\|/, '');
        const r: { folio: string; tipo: string; estado: string; fecha: unknown; created_at: unknown; monto: unknown; glosa: string | null; beneficiario: string | null;
          kepler_cuenta: string | null; kepler_concepto: string | null; origen_tipo: string | null; origen_ref: string | null; declared_doc_ref: string | null;
          created_by_username: string | null; corte: string | null } | undefined = await trx('finance.cash_ledger as l')
          .leftJoin('finance.cash_ledger_cuts as c', 'c.id', 'l.corte_id')
          .where('l.tenant_id', tenantId).andWhere('l.folio', folio)
          .first('l.folio', 'l.tipo', 'l.estado', 'l.fecha', 'l.created_at', 'l.monto', 'l.glosa', 'l.beneficiario', 'l.kepler_cuenta', 'l.kepler_concepto',
            'l.origen_tipo', 'l.origen_ref', 'l.declared_doc_ref', 'l.created_by_username', 'c.folio as corte');
        if (!r) throw new BadRequestException('movimiento no encontrado');
        return { source, title: `Libro · ${r.folio}`, fields: [
          { label: 'Folio', value: r.folio }, { label: 'Tipo', value: r.tipo }, { label: 'Estado', value: r.estado },
          { label: 'Fecha del documento', value: ymd(r.fecha) }, { label: 'Capturado', value: r.created_at ? String(r.created_at) : null },
          { label: 'Capturó', value: r.created_by_username }, { label: 'Importe', value: money(r.monto) },
          { label: 'Glosa', value: r.glosa }, { label: 'Beneficiario', value: r.beneficiario },
          { label: 'Cuenta Kepler', value: r.kepler_cuenta }, { label: 'Concepto Kepler', value: r.kepler_concepto },
          { label: 'Origen', value: r.origen_tipo }, { label: 'Vínculo', value: r.origen_ref }, { label: 'Documento declarado', value: r.declared_doc_ref },
          { label: 'Corte', value: r.corte },
        ] };
      }
      if (source === 'kepler') {
        const [sucursal, doc_tipo, folio, clave_banco] = String(key).split('|');
        const r: any = await trx('analytics.kepler_bank_movements').where({ tenant_id: tenantId, sucursal, doc_tipo, folio, clave_banco }).first();
        if (!r) {
          // `[CGA-A.35]` Un cobro de camioneta (almacén compuesto `01-003`) no vive en la tesorería
          // sino en `route_collections`; el Cuadre ya lo ofrece, así que el clic tiene que abrirlo.
          const rc = await trx('analytics.route_collections')
            .where({ tenant_id: tenantId, almacen: sucursal, cobro_folio: folio, cuenta: clave_banco })
            .orderBy('fecha').select('truck', 'fecha', 'folio_corte', 'referencia', 'importe', 'doc_tipo');
          if (!rc.length) throw new BadRequestException('movimiento no encontrado');
          const total = rc.reduce((s: number, x: { importe: unknown }) => s + (Number(x.importe) || 0), 0);
          return { source, title: `Kepler · cobro de camioneta ${doc_tipo} ${folio}`, fields: [
            { label: 'Fecha', value: ymd(rc[0].fecha) }, { label: 'Documento', value: `${doc_tipo} ${folio}` },
            { label: 'Almacén', value: sucursal }, { label: 'Unidad', value: rc[0].truck }, { label: 'Clave banco', value: clave_banco },
            { label: 'Importe', value: money(total) }, { label: 'Renglones del corte', value: rc.length },
            { label: 'Cortes', value: [...new Set(rc.map((x: { folio_corte: string | null }) => x.folio_corte).filter(Boolean))].join(' · ') || null },
            { label: 'Referencia', value: [...new Set(rc.map((x: { referencia: string | null }) => x.referencia).filter(Boolean))].join(' · ') || null },
            { label: 'Fuente', value: 'analytics.route_collections (Kepler de la camioneta)' },
          ] };
        }
        return { source, title: `Kepler · ${r.doc_tipo} ${r.folio}`, fields: [
          { label: 'Fecha valor', value: ymd(r.fecha_valor) }, { label: 'Fecha captura', value: ymd(r.fecha_captura) },
          { label: 'Documento', value: `${r.doc_tipo} ${r.folio}` }, { label: 'Sucursal', value: this.keplerSucursal(r.sucursal) },
          { label: 'Clave banco', value: r.clave_banco }, { label: 'Banco', value: r.banco_nombre },
          { label: 'Cuenta contable', value: r.cuenta_contable }, { label: 'Cuenta (label)', value: r.account_label },
          { label: 'Flujo', value: r.flujo }, { label: 'Importe', value: money(r.importe) }, { label: 'Signo', value: r.signo },
          { label: 'Concepto', value: r.concepto }, { label: 'Método', value: r.metodo }, { label: 'Beneficiario', value: r.beneficiario },
          { label: 'Traspaso', value: r.es_traspaso ? `sí (contra ${r.contra_clave || '—'}${r.pierna ? ', ' + r.pierna : ''})` : 'no' },
        ] };
      }
      /**
       * [CG.20.1] La venta del Kepler DE LA CAMIONETA. Es una fuente propia y no un cobro de
       * tesorería: no tiene folio ni cuenta contable porque ese documento **no existe** —
       * medido, Canindo no tiene un solo cobro de octubre. Lo que sí existe, y es lo que se
       * abre acá, es la venta del día de esa ruta con su procedencia declarada.
       */
      if (source === 'ruta') {
        const [route_code, dia] = String(key).split('|');
        if (!route_code || !dia) throw new BadRequestException('key de ruta inválida');
        const r: any = await trx('analytics.v_rd_route_daily')
          .where({ tenant_id: tenantId, route_code, business_date: dia }).first();
        if (!r) throw new BadRequestException('la ruta no reportó venta ese día');
        const z: any = await trx('analytics.v_route_zone')
          .where({ tenant_id: tenantId, route_code }).first();
        return {
          source, title: `Venta en ruta · ${z?.route_name || `Ruta ${route_code}`} · ${dia}`,
          fields: [
            { label: 'Ruta', value: route_code },
            { label: 'Nombre', value: z?.route_name ?? null },
            { label: 'Plaza', value: z?.parent_name ?? null },
            { label: 'Día de venta', value: dia },
            { label: 'Venta (con impuestos)', value: money(r.venta) },
            { label: 'Subtotal', value: money(r.subtotal) },
            { label: 'Tickets', value: r.tickets ?? null },
            { label: 'Líneas', value: r.lineas ?? null },
            // ADR-056: el número viaja con qué lo calculó. `subtotal_origen`/`venta_origen`
            // distinguen el tramo del push del de Wincaja, y no son lo mismo.
            { label: 'Origen del dato', value: r.source ?? null },
            { label: 'Origen del subtotal', value: r.subtotal_origen ?? null },
            { label: 'Origen de la venta', value: r.venta_origen ?? null },
            { label: 'Costo', value: r.costo == null ? null : money(r.costo) },
            { label: 'Estado del costo', value: r.costo_status ?? null },
            { label: 'Documento de tesorería', value: 'no existe — este cobro no se registró en Kepler' },
          ],
        };
      }
      throw new BadRequestException('source inválido (control|workbook|kepler|ruta|libro)');
    });
  }

  /** KPIs del periodo: venta vs depositado por forma de pago + descuadre. */
  async overview(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    return this.tk.run(async (trx) => {
      const tenderSel = TENDERS.flatMap((t) => [
        trx.raw(`coalesce(sum(${t}),0)::numeric AS ${t}`),
        trx.raw(`coalesce(sum(${t}_deposito),0)::numeric AS ${t}_dep`),
      ]);
      const [vd] = await trx('analytics.caja_ventas_diarias')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('venta_date', [from, to]).where('eliminado', false)
        .select(
          trx.raw('count(*)::int AS dias'),
          trx.raw('count(distinct almacen)::int AS sucursales'),
          trx.raw('coalesce(sum(venta_total),0)::numeric AS venta_total'),
          ...tenderSel);
      const [dep] = await trx('analytics.caja_depositos')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false)
        .select(
          trx.raw('count(*)::int AS n'),
          trx.raw('coalesce(sum(total_deposito),0)::numeric AS total'),
          trx.raw('coalesce(sum(total_deposito_real),0)::numeric AS total_real'),
          trx.raw('coalesce(sum(comision),0)::numeric AS comision'));

      const tenders = TENDERS.map((t) => ({
        tender: t, vendido: Number(vd[t]), depositado: Number(vd[`${t}_dep`]),
        descuadre: Number(vd[t]) - Number(vd[`${t}_dep`]),
      }));
      const vendido = tenders.reduce((s, r) => s + r.vendido, 0);
      const depositado = tenders.reduce((s, r) => s + r.depositado, 0);
      return {
        period: { from, to, instance: inst },
        venta_total: Number(vd.venta_total), dias: Number(vd.dias), sucursales: Number(vd.sucursales),
        vendido, depositado, descuadre: vendido - depositado,
        depositos: { n: Number(dep.n), total: Number(dep.total), total_real: Number(dep.total_real), comision: Number(dep.comision) },
        tenders,
      };
    });
  }

  /** Tabla por sucursal: venta vs depositado, descuadre, %. */
  async porSucursal(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    return this.tk.run(async (trx) => {
      const depSum = TENDERS.map((t) => `${t}_deposito`).join('+');
      const rows = await trx('analytics.caja_ventas_diarias as vd')
        .leftJoin('analytics.caja_sucursales_catalog as sc', function () {
          this.on('sc.tenant_id', 'vd.tenant_id').andOn('sc.source_instance', 'vd.source_instance').andOn('sc.almacen', 'vd.almacen');
        })
        .where({ 'vd.tenant_id': tenantId, 'vd.source_instance': inst }).whereBetween('vd.venta_date', [from, to]).where('vd.eliminado', false)
        .groupBy('vd.almacen', 'sc.empresa', 'sc.nombre')
        .select('vd.almacen', 'sc.empresa', 'sc.nombre',
          trx.raw('count(*)::int AS dias'),
          trx.raw('coalesce(sum(vd.venta_total),0)::numeric AS venta'),
          trx.raw(`coalesce(sum(${depSum}),0)::numeric AS depositado`),
          trx.raw('max(vd.venta_date) AS ultima'))
        .orderByRaw('venta desc');
      return rows.map((r: any) => {
        const venta = Number(r.venta); const depositado = Number(r.depositado);
        return {
          almacen: r.almacen, empresa: r.empresa, nombre: r.nombre, dias: Number(r.dias),
          venta, depositado, descuadre: venta - depositado,
          pct_depositado: venta ? Math.round((depositado / venta) * 100) : 0, ultima: r.ultima,
        };
      });
    });
  }

  /** Ledger de depósitos + KPIs + desglose por banco. */
  async depositos(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    const limit = Math.min(3000, Math.max(1, Number(q.limit) || 500));
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('analytics.caja_depositos')
          .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false);
        if (q.banco) b.where('banco_name', q.banco);
        if (q.almacen) b.where('almacen', q.almacen);
        if (q.search && q.search.trim()) applySmartSearch(b, q.search.trim(), { columns: ['banco_name', 'observaciones', 'banco_cuenta'] });
        return b;
      };
      const rows = await base()
        .select('deposito_id', 'control', 'almacen', 'banco_code', 'banco_name', 'banco_cuenta',
          'deposito_date', 'deposito_date_real', 'tipo_pago', 'total_deposito', 'total_deposito_real', 'comision', 'iva', 'observaciones')
        .orderBy([{ column: 'deposito_date', order: 'desc' }, { column: 'deposito_id', order: 'desc' }]).limit(limit);
      const [tot] = await base().select(
        trx.raw('count(*)::int AS n'),
        trx.raw('coalesce(sum(total_deposito),0)::numeric AS total'),
        trx.raw('coalesce(sum(total_deposito_real),0)::numeric AS total_real'),
        trx.raw('coalesce(sum(comision),0)::numeric AS comision'));
      const byBank = await base().select('banco_name').count({ n: '*' }).sum({ total_real: 'total_deposito_real' }).groupBy('banco_name').orderBy('total_real', 'desc');
      return {
        rows,
        totals: { n: Number(tot.n), total: Number(tot.total), total_real: Number(tot.total_real), comision: Number(tot.comision) },
        by_bank: byBank.map((r: any) => ({ banco: r.banco_name, n: Number(r.n), total_real: Number(r.total_real) })),
      };
    });
  }

  /** Arqueos de caja (Sistema A) — conteo por denominación. */
  async arqueos(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const limit = Math.min(3000, Math.max(1, Number(q.limit) || 500));
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('analytics.caja_arqueos').where({ tenant_id: tenantId }).whereBetween('arqueo_date', [from, to]);
        if (q.tipo) b.where('tipo', q.tipo);
        if (q.almacen) b.where('source_caja', q.almacen);
        if (q.search && q.search.trim()) applySmartSearch(b, q.search.trim(), { columns: ['folio', 'observaciones', 'capturo'] });
        return b;
      };
      const rows = await base()
        .select('mov_id', 'source_caja', 'folio', 'tipo', 'almacen', 'caja', 'arqueo_date', 'capturo',
          'total_billetes', 'total_monedas', 'total_efectivo', 'total_cheques', 'total_tarjeta', 'mov_total', 'denom', 'revisado', 'cancelado', 'observaciones')
        .orderBy([{ column: 'arqueo_date', order: 'desc' }, { column: 'mov_id', order: 'desc' }]).limit(limit);
      const byTipo = await base().select('tipo').count({ n: '*' }).sum({ monto: 'mov_total' }).groupBy('tipo').orderBy('n', 'desc');
      return { rows, by_tipo: byTipo.map((r: any) => ({ tipo: r.tipo, n: Number(r.n), monto: Number(r.monto) })) };
    });
  }

  /**
   * Conciliación 3 vías por banco: Caja ↔ Workbook (estado de cuenta/CB) ↔ Kepler
   * (tesorería). Alineadas por NOMBRE de banco canónico (caja no trae nº de cuenta;
   * el denominador común de las tres es el banco). Universos NO idénticos → el delta
   * es informativo (el banco/Kepler reciben también transferencias de clientes,
   * cobranza, etc.; caja es solo el depósito de tiendas). Cuadre TOTALES ±$1,000.
   *   · Caja     = analytics.caja_depositos (total_deposito_real).
   *   · Workbook = finance.bank_movements.amount_in (Google Sheet cargado por CB.23).
   *   · Kepler   = analytics.kepler_bank_movements entrada (signo>0, sin traspasos).
   */
  async conciliacion(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    // Nombre de banco → clave canónica común a las 4 fuentes. Antes acá vivía una SEGUNDA copia
    // de esta función que no coincidía con la del método de clase (ver `canonBank`).
    const canon = canonBank;
    return this.tk.run(async (trx) => {
      const caja = await trx('analytics.caja_depositos')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false)
        .groupBy('banco_name').select('banco_name').count({ n: '*' }).sum({ real: 'total_deposito_real' });
      let cb: any[] = [];
      try {
        cb = await trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .where('bm.tenant_id', tenantId).where('bm.amount_in', '>', 0).whereBetween('bm.movement_date', [from, to])
          .groupBy('ba.bank').select('ba.bank').count({ n: '*' }).sum({ monto: 'bm.amount_in' });
      } catch { cb = []; }
      let kep: any[] = [];
      try {
        kep = await trx('analytics.kepler_bank_movements')
          .where('tenant_id', tenantId).where('signo', '>', 0).where('es_traspaso', false).whereBetween('fecha_valor', [from, to])
          .groupBy('banco_nombre').select('banco_nombre').count({ n: '*' }).sum({ monto: 'importe' });
      } catch { kep = []; }
      // ContPAQi (fiscal/libros): ingreso = flujo 'deposito' en 102xxx; mapea cuenta→banco
      // via crosswalk CB (bank_accounts.contpaqi_cuenta). Es la 4ª vía = el extremo fiscal.
      const cpqCuentaBank = new Map<string, string>();
      try {
        const bax = await trx('finance.bank_accounts').where('tenant_id', tenantId).whereNotNull('contpaqi_cuenta').select('bank', 'contpaqi_cuenta');
        bax.forEach((r: any) => cpqCuentaBank.set(String(r.contpaqi_cuenta), canon(r.bank)));
      } catch { /* sin crosswalk */ }
      let cpq: any[] = [];
      try {
        cpq = await trx('analytics.contpaqi_bank_movements')
          .where('tenant_id', tenantId).where('flujo', 'deposito').whereBetween('fecha', [from, to])
          .groupBy('cuenta').select('cuenta').count({ n: '*' }).sum({ monto: 'importe' });
      } catch { cpq = []; }

      // Acumula las 4 fuentes por clave canónica.
      const M = new Map<string, { banco: string; caja: number; caja_n: number; wb: number; wb_n: number; kep: number; kep_n: number; cpq: number; cpq_n: number }>();
      const get = (k: string, label: string) => { if (!M.has(k)) M.set(k, { banco: label, caja: 0, caja_n: 0, wb: 0, wb_n: 0, kep: 0, kep_n: 0, cpq: 0, cpq_n: 0 }); return M.get(k)!; };
      caja.forEach((r: any) => { const g = get(canon(r.banco_name), canon(r.banco_name)); g.caja += Number(r.real); g.caja_n += Number(r.n); });
      cb.forEach((r: any) => { const g = get(canon(r.bank), canon(r.bank)); g.wb += Number(r.monto); g.wb_n += Number(r.n); });
      kep.forEach((r: any) => { const g = get(canon(r.banco_nombre), canon(r.banco_nombre)); g.kep += Number(r.monto); g.kep_n += Number(r.n); });
      cpq.forEach((r: any) => { const bank = cpqCuentaBank.get(String(r.cuenta)); if (!bank) return; const g = get(bank, bank); g.cpq += Number(r.monto); g.cpq_n += Number(r.n); });

      const por_banco = Array.from(M.values()).map((g) => ({
        banco: g.banco, caja: g.caja, caja_n: g.caja_n, wb: g.wb, wb_n: g.wb_n, kep: g.kep, kep_n: g.kep_n, cpq: g.cpq, cpq_n: g.cpq_n,
        delta_caja_wb: g.caja - g.wb, delta_caja_kep: g.caja - g.kep, delta_wb_kep: g.wb - g.kep, delta_caja_cpq: g.caja - g.cpq, delta_wb_cpq: g.wb - g.cpq,
        cuadra_caja_wb: g.wb > 0 && Math.abs(g.caja - g.wb) <= CUADRE_EPS,
        cuadra_wb_kep: g.wb > 0 && g.kep > 0 && Math.abs(g.wb - g.kep) <= CUADRE_EPS,
        cuadra_wb_cpq: g.wb > 0 && g.cpq > 0 && Math.abs(g.wb - g.cpq) <= CUADRE_EPS,
      })).sort((a, b) => Math.max(b.caja, b.wb, b.kep, b.cpq) - Math.max(a.caja, a.wb, a.kep, a.cpq));

      const sum = (arr: any[], k: string) => arr.reduce((s: number, r: any) => s + Number(r[k] || 0), 0);
      return {
        period: { from, to, instance: inst },
        totals: {
          caja: sum(caja, 'real'), wb: sum(cb, 'monto'), kep: sum(kep, 'monto'), cpq: sum(cpq, 'monto'),
          // ⛔ `caja_disponible` faltaba, y es la fuente SUJETO de esta pantalla. Las otras tres
          // declaraban si tenían datos; la caja no. Y es la que se apagó: `caja_depositos` dejó de
          // alimentarse en ene-2026, así que para cualquier mes posterior esto publicaba
          // `caja: 0` contra `wb: $X` — un descuadre del 100% que NO es un descuadre, es una
          // fuente parada. Cero medido y cero por falta de datos no pueden verse igual (ADR-056).
          caja_disponible: caja.length > 0,
          wb_disponible: cb.length > 0, kep_disponible: kep.length > 0, cpq_disponible: cpq.length > 0,
        },
        por_banco, cuadre_eps: CUADRE_EPS,
      };
    });
  }

  /**
   * CG.8 — Conciliación de INGRESOS a nivel movimiento: depósito de Caja ↔ ingreso del
   * banco (workbook/CB), casados por monto (±MATCH_EPS) + fecha (±3d) dentro del mismo banco.
   * Resuelve el "memo de ingresos" de Bancos y detecta fuga:
   *   · matched     = depósito de Caja que SÍ aparece en el banco.
   *   · caja_only   = depósito registrado en Caja SIN ingreso en banco (fuga/rezago).
   *   · bank_only   = ingreso del banco SIN depósito de Caja (cobranza/transferencia directa).
   * Usa el crosswalk confirmado (account_label) cuando existe; si no, cae a banco canónico.
   */
  async conciliacionDetalle(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    const filterBank = q.banco ? this.canonBank(q.banco) : null;
    return this.tk.run(async (trx) => {
      // crosswalk confirmado: banco_code → account_label
      const xw = await trx('finance.caja_bank_crosswalk').where({ tenant_id: tenantId, source_instance: inst }).whereNotNull('account_label').select('banco_code', 'account_label');
      const codeToLabel = new Map(xw.map((r: any) => [String(r.banco_code), String(r.account_label)]));
      // CB account_label → banco canónico
      const ba = await trx('finance.bank_accounts').where('tenant_id', tenantId).select('bank', 'account_label');
      const labelBank = new Map(ba.map((r: any) => [String(r.account_label), this.canonBank(r.bank)]));

      const cajaRows = await trx('analytics.caja_depositos')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false).where('total_deposito_real', '>', 0)
        .select('deposito_id', 'banco_code', 'banco_name', 'almacen', 'deposito_date', 'total_deposito_real');
      let bankRows: any[] = [];
      try {
        bankRows = await trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .where('bm.tenant_id', tenantId).where('bm.amount_in', '>', 0).whereBetween('bm.movement_date', [from, to])
          .whereNull('bm.deleted_at')
          .select('bm.id', 'ba.bank', 'ba.account_label', 'bm.movement_date', 'bm.amount_in', 'bm.concept');
      } catch { bankRows = []; }

      // indexa ingresos de banco por (canonBank, monto redondeado)
      const bank = bankRows.map((b) => ({ id: b.id, canon: this.canonBank(b.bank), label: String(b.account_label), date: b.movement_date, amt: Number(b.amount_in), concept: b.concept, used: false }));
      const byKey = new Map<string, any[]>();
      for (const b of bank) { const k = `${b.canon}|${Math.round(b.amt)}`; (byKey.get(k) || byKey.set(k, []).get(k))!.push(b); }

      const dayDiff = (a: any, b: any) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 864e5);
      /**
       * ⛔ ACÁ NO HABÍA TOLERANCIA, aunque el comentario de arriba decía "±$1".
       *
       * El índice es un balde por PESO ENTERO (`canon|round(monto)`) y la búsqueda pedía el
       * balde exacto. Eso no es ±$1: es "que redondeen al mismo peso". $100.49 y $100.51 **no
       * casaban** (redondean a 100 y a 101, dos centavos de diferencia) mientras $100.01 y
       * $100.99 sí — un peso de diferencia. Y un balde no se puede "ampliar": subir la
       * tolerancia no cambiaba nada acá, así que la pantalla iba a rotular ±$5 con un matcher
       * que no toleraba un centavo.
       *
       * Ahora se barren los baldes vecinos (±MATCH_EPS pesos) y se filtra por la diferencia
       * REAL de importe. El desempate sigue siendo la fecha más cercana.
       */
      const cercanos = (m: Map<string, any[]>, canon: string, amt: number) => {
        const base = Math.round(amt); const out: any[] = [];
        for (let d = -Math.ceil(MATCH_EPS); d <= Math.ceil(MATCH_EPS); d++) out.push(...(m.get(`${canon}|${base + d}`) || []));
        return out;
      };
      const matched: any[] = []; const cajaOnly: any[] = [];
      for (const c of cajaRows) {
        const canon = labelBank.get(codeToLabel.get(String(c.banco_code)) || '') || this.canonBank(c.banco_name);
        if (filterBank && canon !== filterBank) continue;
        const amt = Number(c.total_deposito_real);
        const cands = cercanos(byKey, canon, amt)
          .filter((b) => !b.used && Math.abs(b.amt - amt) <= MATCH_EPS && dayDiff(b.date, c.deposito_date) <= 3)
          .sort((x, y) => dayDiff(x.date, c.deposito_date) - dayDiff(y.date, c.deposito_date) || Math.abs(x.amt - amt) - Math.abs(y.amt - amt));
        if (cands.length) {
          cands[0].used = true;
          matched.push({ canon, caja_id: c.deposito_id, banco: c.banco_name, almacen: c.almacen, fecha: c.deposito_date, monto: amt, bank_id: cands[0].id, bank_fecha: cands[0].date });
        } else {
          cajaOnly.push({ canon, caja_id: c.deposito_id, banco: c.banco_name, almacen: c.almacen, fecha: c.deposito_date, monto: amt });
        }
      }
      const bankOnly = bank.filter((b) => !b.used && (!filterBank || b.canon === filterBank)).map((b) => ({ canon: b.canon, bank_id: b.id, label: b.label, fecha: b.date, monto: b.amt, concept: b.concept, via_cobranza: false }));

      // CG.9 — 2º pase: atribuir el "banco sin Caja" a COBRANZA (cobros Kepler UA0501),
      // por monto (±MATCH_EPS) + fecha (±5d). El cobro no trae banco → match sin banco. Lo que
      // no case queda como residual (transferencia directa / financiero / inter-cuenta).
      let cob: any[] = [];
      try {
        cob = await trx('analytics.erp_collections')
          .where('tenant_id', tenantId).whereBetween('cobro_date', [from, to]).where('monto', '>', 0)
          .select('cobro_date', 'monto');
      } catch { cob = []; }
      // Mismo defecto del balde exacto que arriba, y misma corrección: se barren los vecinos
      // y se filtra por la diferencia real de importe.
      const cobByAmt = new Map<number, any[]>();
      for (const x of cob) { const k = Math.round(Number(x.monto)); (cobByAmt.get(k) || cobByAmt.set(k, []).get(k))!.push({ amt: Number(x.monto), date: x.cobro_date, used: false }); }
      for (const b of bankOnly) {
        const base = Math.round(b.monto); const pool: any[] = [];
        for (let d = -Math.ceil(MATCH_EPS); d <= Math.ceil(MATCH_EPS); d++) pool.push(...(cobByAmt.get(base + d) || []));
        const cands = pool
          .filter((x) => !x.used && Math.abs(x.amt - b.monto) <= MATCH_EPS && dayDiff(x.date, b.fecha) <= 5)
          .sort((x, y) => dayDiff(x.date, b.fecha) - dayDiff(y.date, b.fecha) || Math.abs(x.amt - b.monto) - Math.abs(y.amt - b.monto));
        if (cands.length) { cands[0].used = true; b.via_cobranza = true; }
      }
      const cobranza = bankOnly.filter((b) => b.via_cobranza);
      const residual = bankOnly.filter((b) => !b.via_cobranza);

      const sum = (arr: any[]) => arr.reduce((s, r) => s + (r.monto || 0), 0);
      return {
        period: { from, to, instance: inst, banco: filterBank },
        totals: {
          matched_n: matched.length, matched: sum(matched),
          caja_only_n: cajaOnly.length, caja_only: sum(cajaOnly),
          cobranza_n: cobranza.length, cobranza: sum(cobranza),
          residual_n: residual.length, residual: sum(residual),
          bank_only_n: bankOnly.length, bank_only: sum(bankOnly),
        },
        matched: matched.sort((a, b) => b.monto - a.monto).slice(0, 500),
        caja_only: cajaOnly.sort((a, b) => b.monto - a.monto).slice(0, 500),
        bank_only: residual.sort((a, b) => b.monto - a.monto).slice(0, 500),
        match_eps: MATCH_EPS,
      };
    });
  }

  /**
   * ⛔ **Había DOS de estas en este archivo y no eran iguales.** Ésta (método de clase, usada por
   * `conciliacionDetalle` y `crosswalk`) no conocía `SCOTIABANK` ni `BANREGIO`; la copia local de
   * `conciliacion()` sí. El mismo banco se agrupaba distinto según por qué pestaña entraras.
   * Ahora las dos llaman a `canonBank` del motor — una sola definición, con pruebas.
   */
  private canonBank(s: string): string { return canonBank(s); }

  /**
   * CG.7 — Enlace de cuentas: sugiere el `account_label` (cuenta CB/Kepler) para cada
   * cuenta interna de Caja (`banco_cuenta`), DERIVADO vía Kepler (match de depósitos por
   * monto+fecha, restringido al mismo banco canónico). El match es disperso → sugerencia
   * + confirmación manual. Devuelve estado actual (finance.caja_bank_crosswalk) + sugerencia.
   */
  async crosswalk() {
    const tenantId = this.tenantCtx.requireTenantId();
    const inst = 'SI';
    return this.tk.run(async (trx) => {
      // CB accounts → banco canónico + labels por banco
      const ba = await trx('finance.bank_accounts').where('tenant_id', tenantId).select('bank', 'account_label');
      const labelBank: Record<string, string> = {};
      const bankLabels: Record<string, string[]> = {};
      for (const r of ba) { const cb = this.canonBank(r.bank); labelBank[String(r.account_label)] = cb; (bankLabels[cb] = bankLabels[cb] || []).push(String(r.account_label)); }

      // cuentas de Caja = banco_code (=BancoDepositado, 1:1 con banco_name; NO banco_cuenta,
      // que es un campo reusado/inconsistente) + volumen + label ya confirmado
      const accounts = await trx('analytics.caja_depositos as d')
        .leftJoin('finance.caja_bank_crosswalk as x', function () {
          this.on('x.tenant_id', 'd.tenant_id').andOn('x.source_instance', trx.raw('?', [inst])).andOn('x.banco_code', 'd.banco_code');
        })
        .where({ 'd.tenant_id': tenantId, 'd.source_instance': inst }).whereNotNull('d.banco_code')
        .groupBy('d.banco_code', 'x.account_label', 'x.confirmed_by', 'x.confirmed_at')
        .select('d.banco_code as code', trx.raw('max(d.banco_name) as banco_name'),
          'x.account_label as current_label', 'x.confirmed_by', 'x.confirmed_at',
          trx.raw('count(*)::int as deposits'), trx.raw('coalesce(sum(d.total_deposito_real),0)::numeric as monto'));

      // match Kepler por monto+fecha (candidatos por cuenta)
      const m = await trx.raw(
        `with cj as (select banco_code, deposito_date, round(total_deposito_real)::bigint amt
                       from analytics.caja_depositos
                      where tenant_id=? and source_instance=? and eliminado=false and total_deposito_real>100 and banco_code is not null),
              kp as (select account_label, fecha_valor, round(importe)::bigint amt
                       from analytics.kepler_bank_movements
                      where tenant_id=? and signo>0 and es_traspaso=false)
         select cj.banco_code as code, kp.account_label as label, count(*)::int as n
           from cj join kp on cj.amt=kp.amt and kp.fecha_valor between cj.deposito_date-7 and cj.deposito_date+7
          group by cj.banco_code, kp.account_label`, [tenantId, inst, tenantId]);
      const mrows = (m.rows || m) as any[];
      const byCode: Record<string, { label: string; n: number }[]> = {};
      for (const r of mrows) { (byCode[String(r.code)] = byCode[String(r.code)] || []).push({ label: String(r.label), n: Number(r.n) }); }

      return accounts.map((a: any) => {
        const cb = this.canonBank(a.banco_name);
        const opts = bankLabels[cb] || [];
        const cands = (byCode[String(a.code)] || []).filter((x) => labelBank[x.label] === cb).sort((x, y) => y.n - x.n);
        const sug = cands[0] || null;
        // Sugerencia: (1) match Kepler; (2) si el banco tiene UNA sola cuenta CB → determinista.
        const suggested_label = sug?.label || (opts.length === 1 ? opts[0] : null);
        const suggested_reason = sug ? 'kepler' : (opts.length === 1 ? 'unica_cuenta' : null);
        return {
          banco_code: a.code, banco_name: a.banco_name, canon_bank: cb,
          deposits: Number(a.deposits), monto: Number(a.monto),
          current_label: a.current_label || null, confirmed_by: a.confirmed_by || null, confirmed_at: a.confirmed_at || null,
          suggested_label, suggested_matches: sug?.n || 0, suggested_reason,
          alternatives: cands.slice(1, 4), cb_options: opts,
        };
      }).sort((x: any, y: any) => y.monto - x.monto);
    });
  }

  /** CG.7 — Persiste el enlace confirmado (UPSERT por banco_code). label null = desenlazar. */
  async crosswalkSet(bancoCode: string, label: string | null, matches: number, username?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await trx('finance.caja_bank_crosswalk')
        .insert({
          tenant_id: tenantId, source_instance: 'SI', banco_code: String(bancoCode),
          account_label: label || null, match_count: matches || 0, source: 'manual',
          confirmed_by: username || null, confirmed_at: trx.fn.now(), updated_at: trx.fn.now(),
        })
        .onConflict(['tenant_id', 'source_instance', 'banco_code'])
        .merge(['account_label', 'match_count', 'source', 'confirmed_by', 'confirmed_at', 'updated_at']);
      return { banco_code: bancoCode, account_label: label || null };
    });
  }

  /** Facetas para filtros. */
  async facets() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const mesesVd = (await trx('analytics.caja_ventas_diarias').where('tenant_id', tenantId).whereNotNull('venta_date')
        .select(trx.raw(`distinct to_char(venta_date,'YYYY-MM') AS m`))).map((r: any) => r.m);
      // CG.2 — incluir meses de la caja general VIVA (Doctos), que llega más allá del Base Movimientos muerto.
      const mesesCg = (await trx('analytics.caja_general_movimientos').where('tenant_id', tenantId).whereNotNull('fecha')
        .select(trx.raw(`distinct to_char(fecha,'YYYY-MM') AS m`))).map((r: any) => r.m);
      const meses = Array.from(new Set(mesesVd.concat(mesesCg))).sort((a: string, b: string) => b.localeCompare(a));
      const bancos = (await trx('analytics.caja_depositos').where('tenant_id', tenantId).whereNotNull('banco_name').distinct('banco_name').orderBy('banco_name')).map((r: any) => r.banco_name);
      const empresas = (await trx('analytics.caja_sucursales_catalog').where('tenant_id', tenantId).whereNotNull('empresa').distinct('empresa').orderBy('empresa')).map((r: any) => r.empresa);
      const cajas = (await trx('analytics.caja_arqueos').where('tenant_id', tenantId).distinct('source_caja').orderBy('source_caja')).map((r: any) => r.source_caja);

      /**
       * `[CGA-A.38]` **El relevo Control → libro nuevo, derivado y no escrito a mano.** El Access
       * Control dejó de capturar movimientos el 10-oct 12:39 y la caja se opera desde el 12-oct en
       * `finance.cash_ledger` (su primer corte abre con el fondo del arqueo `A23641`). La pantalla
       * lo dice para que nadie busque aquí lo de después.
       *
       * Sale de los datos a propósito: si Control volviera a recibir movimientos, `control_ultimo`
       * pasaría al libro y el aviso se apagaría solo. Una fecha fija en el código seguiría
       * afirmando el relevo aunque dejara de ser cierto.
       */
      const ult: { fecha: unknown; hora: string | null } | undefined = await trx('analytics.caja_general_movimientos')
        .where('tenant_id', tenantId).whereNotNull('fecha')
        .orderByRaw('fecha DESC, hora DESC NULLS LAST').first('fecha', 'hora');
      const primerCorte: { fecha: unknown; folio: string } | undefined = await trx('finance.cash_ledger_cuts')
        .where('tenant_id', tenantId).orderBy([{ column: 'fecha', order: 'asc' }, { column: 'folio', order: 'asc' }])
        .first('fecha', 'folio');
      // `[CGA-A.69]` El aviso decía «los arqueos sí se siguen capturando en el Access» y el último
      // es del 22-oct (Control se jubiló ese día). Se publica la fecha y la pantalla la dice.
      const arqUlt = (await trx('analytics.caja_arqueos')
        .where('tenant_id', tenantId).max('arqueo_date as at').first()) as { at: unknown } | undefined;
      const relevo = {
        control_ultimo_fecha: ult ? ymd(ult.fecha) : null,
        control_ultimo_hora: ult?.hora ?? null,
        libro_desde: primerCorte ? ymd(primerCorte.fecha) : null,
        libro_primer_corte: primerCorte?.folio ?? null,
        arqueo_access_ultimo: arqUlt?.at ? ymd(arqUlt.at) : null,
      };
      return { meses, bancos, empresas, cajas, relevo };
    });
  }
}
