import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { KpExcelService, ExcelArticuloMes } from './kp-excel.service';

export interface VentaSuc  { suc: string; total: number; docs: number; }
export interface TrendItem  { suc: string; mes: string; total: number; }
export interface Articulo   { cod: string; desc: string; cant: number; imp: number; }

export interface ConcentradaItem {
  sucursal: string;
  clave:    string;
  desc:     string;
  unidad:   string;
  meses:    Record<string, number>; // 'YYYY-MM' → importe
  total:    number;
  fuente:   'postgresql' | 'excel' | 'ambos';
  discrepancias?: Record<string, { pg: number; excel: number }>;
}

export interface ProductoCatalog {
  codigo:       string;  // 5 dígitos con 0s a la izquierda
  nombre:       string;
  iva_raw:      number;  // valor original de c18 (ej: -16, 0)
  ieps_raw:     number;  // valor original de c19 (ej: -8, 0)
  iva:          number;  // porcentaje absoluto (ej: 0.16)
  ieps:         number;  // porcentaje absoluto (ej: 0.08)
  costo:        number;
  margen:       number | null;
  precio_venta:   number | null;  // c90 tal como lo guarda Kepler
  precio_final:   number;         // c90 si existe; si no, calculado por fórmula
  precio_sin_iva: number;
  precio_con_iva: number;
  existencia_ph:  number | null;  // existencia disponible en PH (sucursal 01)
  proveedor:      string;
  u_base:         string;         // unidad base (c11)
  u2_nom:         string;         // unidad 2 (c80) y su factor (c81)
  u2_factor:      number | null;
  u3_nom:         string;         // unidad 3 (c83) y su factor (c84)
  u3_factor:      number | null;
  p_u1:           number;         // precio con IVA por unidad: c90 / c91 / c92
  p_u2:           number | null;
  p_u3:           number | null;
}

/** Una unidad de venta con su precio, para el verificador. */
export interface UnidadPrecio {
  u:              string;
  precio_con_iva: number;
  precio_sin_iva: number;
  factor:         number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kepler guarda casi todo como texto, incluidos costos y cantidades, y hay celdas
// vacías o con basura. Castear directo revienta con
// «invalid input syntax for type numeric». Estos helpers castean con guarda.
// Se usa la clase POSIX [[:space:]] en vez de \s porque el regex viaja dentro de
// una cadena de JS y el escape se pierde.
// ─────────────────────────────────────────────────────────────────────────────
const RE_NUM = "'^[[:space:]]*-?[0-9]+([.][0-9]*)?[[:space:]]*$'";

/** Castea a numeric; 0 si el valor no es un número. */
const NUMC = (col: string) =>
  `CASE WHEN ${col}::text ~ ${RE_NUM} THEN ${col}::numeric ELSE 0 END`;

/** Castea a numeric; NULL si el valor no es un número (para distinguir «no hay dato»). */
const NUMC_NULL = (col: string) =>
  `CASE WHEN ${col}::text ~ ${RE_NUM} THEN ${col}::numeric ELSE NULL END`;

/** Redondeo a 2 decimales, para que no se filtren artefactos de punto flotante. */
const redondea = (n: number) => parseFloat((Number(n) || 0).toFixed(2));

// Mapeo actualizado con columnas reales de kp.kdm2
// c8=clave, c9=cantidad, c10=descripcion, c13=importe, c32=fecha, c6=documento
const COL_MAP = {
  sucursal:     ['sucursal', 'cod_sucursal', 'suc', 'branch', 'num_suc', 'no_sucursal', 'c1'],
  importe:      ['c13', 'importe', 'monto', 'total', 'venta', 'valor', 'precio_total', 'amount', 'c12', 'c62'],
  fecha:        ['c32', 'fecha', 'fecha_doc', 'fec', 'date', 'fecha_venta', 'fec_mov'],
  documento:    ['c6', 'documento', 'doc', 'folio', 'num_doc', 'factura', 'num_factura', 'ndoc'],
  clave:        ['c8', 'clave', 'clave_producto', 'articulo', 'cod', 'sku', 'codigo', 'prod'],
  descripcion:  ['c10', 'descripcion', 'desc', 'nombre', 'nombre_producto', 'description', 'nom_prod'],
  cantidad:     ['c9', 'cantidad', 'cant', 'qty', 'unidades', 'piezas', 'num_piezas'],
};

@Injectable()
export class KpService implements OnModuleInit {
  private readonly logger = new Logger(KpService.name);
  private cols: Record<keyof typeof COL_MAP, string> = {} as any;
  private ready = false;

  constructor(
    @Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex,
    private readonly kpExcelService: KpExcelService,
  ) {}

  onModuleInit() {
    this.discoverSchema().catch(e =>
      this.logger.error('Error al descubrir esquema kp.kdm2: ' + e.message),
    );
  }

  private async discoverSchema() {
    const rows = await this.query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'kp' AND table_name = 'kdm2'
      ORDER BY ordinal_position
    `);

    const available = rows.map(r => r.column_name.toLowerCase());
    this.logger.log(`kp.kdm2 — ${available.length} columnas: ${available.join(', ')}`);

    for (const [field, candidates] of Object.entries(COL_MAP)) {
      const match = candidates.find(c => available.includes(c));
      if (match) {
        this.cols[field as keyof typeof COL_MAP] = match;
        this.logger.log(`  ✓ ${field.padEnd(12)} → ${match}`);
      } else {
        this.logger.warn(`  ✗ ${field.padEnd(12)} — no encontrado`);
      }
    }
    this.ready = true;
  }

  async getSchema() {
    try {
      const rows = await this.query<{ column_name: string; data_type: string; nullable: string }>(`
        SELECT column_name, data_type, is_nullable AS nullable
        FROM information_schema.columns
        WHERE table_schema = 'kp' AND table_name = 'kdm2'
        ORDER BY ordinal_position
      `);

      let muestra: any[] = [];
      try {
        muestra = await this.query('SELECT * FROM kp.kdm2 LIMIT 3');
      } catch (e: any) {
        muestra = [{ error: e.message }];
      }

      return {
        tabla:    'kp.kdm2',
        listo:    this.ready,
        columnas: rows,
        mapeadas: this.cols,
        muestra,
      };
    } catch (e: any) {
      return {
        tabla:    'kp.kdm2',
        listo:    false,
        error:    e.message,
        columnas: [],
        mapeadas: this.cols,
        muestra:  [],
      };
    }
  }

  async getVentasSuc(): Promise<VentaSuc[]> {
    const { sucursal, importe, documento } = this.cols;
    if (!sucursal || !importe) return this.fallbackVentasSuc();

    const docExpr = documento
      ? `COUNT(DISTINCT ${documento}) AS docs`
      : `COUNT(*) AS docs`;

    try {
      return this.query<VentaSuc>(`
        SELECT
          ${sucursal}                          AS suc,
          ROUND(SUM(${importe}::numeric), 2)  AS total,
          ${docExpr}
        FROM kp.kdm2
        WHERE EXTRACT(YEAR FROM ${this.cols.fecha ?? 'c32'}::timestamp) = EXTRACT(YEAR FROM CURRENT_DATE)
        GROUP BY ${sucursal}
        ORDER BY total DESC
      `);
    } catch (e: any) {
      this.logger.error('getVentasSuc error: ' + e.message);
      return this.fallbackVentasSuc();
    }
  }

  async getTrend(): Promise<TrendItem[]> {
    const { sucursal, importe, fecha } = this.cols;
    if (!sucursal || !importe || !fecha) return this.fallbackTrend();

    try {
      return this.query<TrendItem>(`
        SELECT
          ${sucursal}                              AS suc,
          TO_CHAR(${fecha}::timestamp, 'YYYY-MM') AS mes,
          ROUND(SUM(${importe}::numeric), 2)       AS total
        FROM kp.kdm2
        WHERE EXTRACT(YEAR FROM ${fecha}::timestamp) = EXTRACT(YEAR FROM CURRENT_DATE)
        GROUP BY ${sucursal}, TO_CHAR(${fecha}::timestamp, 'YYYY-MM')
        ORDER BY suc, mes
      `);
    } catch (e: any) {
      this.logger.error('getTrend error: ' + e.message);
      return this.fallbackTrend();
    }
  }

  async getArticulos(): Promise<Articulo[]> {
    const { clave, descripcion, cantidad, importe, fecha } = this.cols;
    if (!clave || !importe) return this.fallbackArticulos();

    const cantExpr = cantidad
      ? `SUM(${cantidad}::numeric) AS cant`
      : `COUNT(*) AS cant`;
    const descExpr = descripcion
      ? `MAX(${descripcion}) AS desc`
      : `${clave} AS desc`;
    const groupDesc = descripcion ? `, ${descripcion}` : '';

    try {
      return this.query<Articulo>(`
        SELECT
          ${clave}                                AS cod,
          ${descExpr},
          ${cantExpr},
          ROUND(SUM(${importe}::numeric), 0)      AS imp
        FROM kp.kdm2
        WHERE EXTRACT(YEAR FROM ${fecha ?? 'c32'}::timestamp) = EXTRACT(YEAR FROM CURRENT_DATE)
        GROUP BY ${clave}${groupDesc}
        ORDER BY imp DESC
        LIMIT 20
      `);
    } catch (e: any) {
      this.logger.error('getArticulos error: ' + e.message);
      return this.fallbackArticulos();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KP Concentrada: merge PostgreSQL + Excel con deduplicación
  // ─────────────────────────────────────────────────────────────────────────

  async getConcentrada(): Promise<ConcentradaItem[]> {
    const [pgItems, excelItems] = await Promise.all([
      this.buildPgConcentrada(),
      this.kpExcelService.readAll(),
    ]);

    return this.mergeAndDeduplicate(pgItems, excelItems);
  }

  /**
   * Construye los items de PostgreSQL con la misma estructura de ConcentradaItem.
   * Agrupa por sucursal + clave + mes.
   */
  private async buildPgConcentrada(): Promise<ConcentradaItem[]> {
    const { sucursal, clave, descripcion, importe, fecha } = this.cols;
    if (!sucursal || !clave || !importe || !fecha) return [];

    try {
      const rows = await this.query<{
        suc: string; cod: string; desc: string; mes: string; imp: number;
      }>(`
        SELECT
          ${sucursal}                              AS suc,
          ${clave}                                 AS cod,
          MAX(${descripcion ?? clave})             AS desc,
          TO_CHAR(${fecha}::timestamp, 'YYYY-MM') AS mes,
          ROUND(SUM(${importe}::numeric), 2)       AS imp
        FROM kp.kdm2
        WHERE EXTRACT(YEAR FROM ${fecha}::timestamp) = EXTRACT(YEAR FROM CURRENT_DATE)
        GROUP BY ${sucursal}, ${clave}, TO_CHAR(${fecha}::timestamp, 'YYYY-MM')
        ORDER BY suc, cod, mes
      `);

      // Agrupa por sucursal+clave → ConcentradaItem
      const map = new Map<string, ConcentradaItem>();
      for (const r of rows) {
        const key = `${r.suc}__${r.cod}`;
        if (!map.has(key)) {
          map.set(key, {
            sucursal: r.suc,
            clave:    r.cod,
            desc:     r.desc ?? r.cod,
            unidad:   '',
            meses:    {},
            total:    0,
            fuente:   'postgresql',
          });
        }
        const item = map.get(key)!;
        item.meses[r.mes] = r.imp;
        item.total += r.imp;
      }

      return Array.from(map.values());
    } catch (e: any) {
      this.logger.error('buildPgConcentrada error: ' + e.message);
      return [];
    }
  }

  /**
   * Merge + deduplicación.
   * Clave única: sucursal + clave (por artículo, todos los meses juntos).
   * Regla:
   *   - PostgreSQL es fuente autoritativa.
   *   - Excel aporta sucursales/claves que NO están en PostgreSQL.
   *   - Si existe en ambas, usa PG y registra discrepancias mes a mes.
   */
  private mergeAndDeduplicate(
    pgItems:    ConcentradaItem[],
    excelItems: ExcelArticuloMes[],
  ): ConcentradaItem[] {
    // Índice de sucursales cubiertas por PostgreSQL
    const pgSucursales = new Set(pgItems.map(i => i.sucursal));

    // Índice de PG por clave de artículo: sucursal__clave
    const pgIndex = new Map<string, ConcentradaItem>();
    for (const item of pgItems) {
      pgIndex.set(`${item.sucursal}__${item.clave}`, item);
    }

    const result: ConcentradaItem[] = [...pgItems];

    for (const ex of excelItems) {
      const key = `${ex.sucursal}__${ex.clave}`;
      const pgItem = pgIndex.get(key);

      if (pgItem) {
        // Existe en ambas: validar y registrar discrepancias
        pgItem.fuente = 'ambos';
        pgItem.unidad = pgItem.unidad || ex.unidad;

        const discrepancias: Record<string, { pg: number; excel: number }> = {};
        for (const [mes, excelImp] of Object.entries(ex.meses)) {
          const pgImp = pgItem.meses[mes] ?? 0;
          const diff = Math.abs(pgImp - excelImp);
          const pct = pgImp > 0 ? diff / pgImp : 1;
          if (pct > 0.01) { // más de 1% de diferencia
            discrepancias[mes] = { pg: pgImp, excel: excelImp };
          }
        }
        if (Object.keys(discrepancias).length > 0) {
          pgItem.discrepancias = discrepancias;
          this.logger.warn(
            `KP Concentrada: discrepancia en ${ex.sucursal}/${ex.clave} — ` +
            `meses: ${Object.keys(discrepancias).join(', ')}`,
          );
        }

      } else if (!pgSucursales.has(ex.sucursal) || ex.sucursal === 'GLOBAL') {
        // Sucursal no cubierta por PG → agregar desde Excel
        result.push({
          sucursal:  ex.sucursal,
          clave:     ex.clave,
          desc:      ex.desc,
          unidad:    ex.unidad,
          meses:     ex.meses,
          total:     ex.total,
          fuente:    'excel',
        });
      }
      // Si la sucursal SÍ está en PG pero el artículo no existe:
      // también se agrega (puede haber artículos en Excel que no se vendieron en KP)
      else {
        result.push({
          sucursal:  ex.sucursal,
          clave:     ex.clave,
          desc:      ex.desc,
          unidad:    ex.unidad,
          meses:     ex.meses,
          total:     ex.total,
          fuente:    'excel',
        });
      }
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Catálogo de productos desde kp.kdii (precios, impuestos, margen)
  // c1=código, c2=nombre, c18=IVA%, c19=IEPS%, c77=costo, c87=margen
  // ─────────────────────────────────────────────────────────────────────────

  async getProductos(): Promise<{ total: number; generado: string; productos: ProductoCatalog[] }> {
    try {
      const rows = await this.query<any>(`
        SELECT
          LPAD(TRIM(c1::text), 5, '0')  AS codigo,
          TRIM(c2::text)                AS nombre,
          ${NUMC('c18')}                AS iva_raw,
          ${NUMC('c19')}                AS ieps_raw,
          ${NUMC('c77')}                AS costo,
          ${NUMC_NULL('c87')}           AS margen,
          ${NUMC_NULL('c90')}           AS precio_venta,
          ${NUMC_NULL('c91')}           AS precio_u2,
          ${NUMC_NULL('c92')}           AS precio_u3,
          kl.existencia                 AS existencia_ph,
          kg.prov                       AS proveedor,
          TRIM(c11::text)               AS u_base,
          TRIM(c80::text)               AS u2_nom,
          ${NUMC_NULL('c81')}           AS u2_factor,
          TRIM(c83::text)               AS u3_nom,
          ${NUMC_NULL('c84')}           AS u3_factor
        FROM kp.kdii
        -- Existencia disponible en PH (sucursal 01) desde kp.kdil: c8 - c9.
        -- Pre-agregada con JOIN en vez de subconsulta correlacionada, que era lenta.
        LEFT JOIN (
          SELECT LPAD(TRIM(c3::text), 5, '0') AS cod,
                 SUM(${NUMC('c8')} - ${NUMC('c9')}) AS existencia
          FROM kp.kdil
          WHERE TRIM(c1::text) = '01'
          GROUP BY LPAD(TRIM(c3::text), 5, '0')
        ) kl ON kl.cod = LPAD(TRIM(kdii.c1::text), 5, '0')
        -- Proveedor / línea: kp.kdig (c1 = código, c2 = nombre)
        LEFT JOIN (
          SELECT TRIM(c1::text) AS lc, MAX(TRIM(c2::text)) AS prov
          FROM kp.kdig GROUP BY TRIM(c1::text)
        ) kg ON kg.lc = TRIM(kdii.c3::text)
        WHERE kdii.c1 IS NOT NULL
          AND kdii.c1::text ~ '^[0-9]'
        ORDER BY kdii.c1
      `);

      const productos: ProductoCatalog[] = rows.map(r => {
        const iva   = Math.abs(Number(r.iva_raw))  / 100;
        const ieps  = Math.abs(Number(r.ieps_raw)) / 100;
        const costo = Number(r.costo) || 0;
        const margen = r.margen != null ? Number(r.margen) : null;

        // c90 es el precio que Kepler ya trae calculado y es el autoritativo.
        // La fórmula sólo entra como respaldo cuando c90 no sirve.
        const pvKepler = r.precio_venta != null ? Number(r.precio_venta) : null;
        const factorMargen = margen && margen > 0 ? 1 + margen / 100 : 1;
        const precioCalculado = redondea(costo * factorMargen * (1 + ieps) * (1 + iva));
        const precioConIva = pvKepler && pvKepler > 0 ? pvKepler : precioCalculado;

        return {
          codigo:  r.codigo,
          nombre:  r.nombre || '',
          iva_raw: Number(r.iva_raw),
          ieps_raw: Number(r.ieps_raw),
          iva, ieps, costo, margen,
          precio_venta:   pvKepler,
          precio_final:   precioConIva,
          precio_sin_iva: redondea(costo * factorMargen),
          precio_con_iva: precioConIva,
          existencia_ph:  r.existencia_ph != null ? Number(r.existencia_ph) : null,
          proveedor:      r.proveedor || '',
          u_base:         r.u_base || '',
          u2_nom:         r.u2_nom || '',
          u2_factor:      r.u2_factor != null ? Number(r.u2_factor) : null,
          u3_nom:         r.u3_nom || '',
          u3_factor:      r.u3_factor != null ? Number(r.u3_factor) : null,
          p_u1:           precioConIva,
          p_u2:           r.precio_u2 != null ? Number(r.precio_u2) : null,
          p_u3:           r.precio_u3 != null ? Number(r.precio_u3) : null,
        };
      });

      this.logger.log(`getProductos: ${productos.length} productos de kp.kdii`);
      return { total: productos.length, generado: new Date().toISOString(), productos };
    } catch (e: any) {
      // El error se reporta, no se esconde: devolver un arreglo vacío en silencio
      // hacía creer que el catálogo estaba vacío.
      this.logger.error(`getProductos error: ${e.message} | detail: ${e.detail ?? ''} | code: ${e.code ?? ''}`);
      return {
        total: 0, generado: new Date().toISOString(), productos: [],
        error: e.message, detail: e.detail ?? '', hint: e.hint ?? '', code: e.code ?? '',
      } as any;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Explorador: catálogo + existencia por sucursal + movimientos del año
  // ─────────────────────────────────────────────────────────────────────────

  // ── Cache del explorador ──────────────────────────────────────────────────
  //
  // Es el único endpoint con problema real de rendimiento: incluso optimizado
  // tarda ~8 s y devuelve 5.5 MB. El catálogo, en cambio, responde en 411 ms y
  // no se cachea: no hay nada que resolver ahí.
  //
  // Se usa vigencia por tiempo y no invalidación por sync_control, aunque
  // parezca más elegante: el pipeline escribe cada pocos minutos, así que la
  // marca de sincronización cambia constantemente y el cache nunca acertaría.
  // Para movimientos acumulados del año, 15 minutos de desfase no cambian
  // ninguna decisión.
  private cacheExplorador: { datos: any; calculado: number } | null = null;
  private static readonly VIGENCIA_EXPLORADOR_MS = 15 * 60 * 1000;

  /** Fuerza el recálculo en la próxima llamada. */
  limpiarCacheExplorador() { this.cacheExplorador = null; }

  async getExplorador(refrescar = false) {
    const c = this.cacheExplorador;
    if (!refrescar && c && Date.now() - c.calculado < KpService.VIGENCIA_EXPLORADOR_MS) {
      const edadSeg = Math.round((Date.now() - c.calculado) / 1000);
      this.logger.log(`getExplorador: desde cache (${edadSeg} s de antigüedad)`);
      return { ...c.datos, cache: true, cache_edad_seg: edadSeg };
    }

    const t0 = Date.now();
    const datos = await this.calcularExplorador();
    const ms = Date.now() - t0;

    // Sólo se guarda si salió bien: no tiene sentido cachear un error 15 min.
    if (!datos.error && datos.total > 0) {
      this.cacheExplorador = { datos, calculado: Date.now() };
    }
    this.logger.log(`getExplorador: calculado en ${ms} ms`);
    return { ...datos, cache: false, calculado_en_ms: ms };
  }

  private async calcularExplorador() {
    try {
      // 1) Base del catálogo, deduplicada por código
      const base = await this.getProductos();
      const map: Record<string, any> = {};
      for (const p of base.productos || []) {
        if (map[p.codigo]) continue;
        map[p.codigo] = {
          codigo: p.codigo, nombre: p.nombre, proveedor: p.proveedor || '',
          costo: p.costo, iva: p.iva, ieps: p.ieps,
          precio_sin_iva: p.precio_sin_iva, precio_con_iva: p.precio_con_iva,
          u_base: p.u_base || '', u2_nom: p.u2_nom || '', u2_factor: p.u2_factor,
          u3_nom: p.u3_nom || '', u3_factor: p.u3_factor,
          p_u1: p.p_u1 ?? p.precio_con_iva, p_u2: p.p_u2 ?? null, p_u3: p.p_u3 ?? null,
          exist: {}, mov: {},
        };
      }

      // 2) Existencia por sucursal (kdil): c1 = sucursal, c3 = código, disponible = c8 − c9
      const exRows = await this.query<any>(`
        SELECT TRIM(c1::text) AS suc,
               LPAD(TRIM(c3::text), 5, '0') AS cod,
               SUM(${NUMC('c8')} - ${NUMC('c9')}) AS ex
        FROM kp.kdil
        GROUP BY TRIM(c1::text), LPAD(TRIM(c3::text), 5, '0')
      `);
      for (const r of exRows) {
        const m = map[r.cod];
        if (m) m.exist[r.suc] = Math.round((Number(r.ex) || 0) * 100) / 100;
      }

      // 3) Movimientos del año por producto, sucursal, mes y naturaleza
      //    c8 = producto, c9 = cantidad, c32 = fecha, c3 = naturaleza (A entrada / D salida)
      //
      // Esta es la consulta cara de todo el sistema: kdm2 pesa 1.6 GB y casi
      // 3 millones de filas son del año en curso. Dos detalles la volvían el
      // doble de lenta (medido el 20/08/2026: 18.5 s → 7.8 s):
      //
      //   · EXTRACT(YEAR FROM c32) impide usar índice y forzaba recorrer toda
      //     la tabla. Un rango de fechas sí es indexable.
      //   · c32 YA es timestamp, así que el regex que lo validaba como texto
      //     sobraba: casteaba 3 millones de valores para nada.
      //   · work_mem del servidor es de 4 MB, así que ordenar para agrupar se
      //     desbordaba a disco (41 MB de external merge). Se sube sólo para
      //     esta consulta con SET LOCAL, que se revierte al cerrar la
      //     transacción y no afecta al resto del servidor.
      const movRows = await this.queryConMemoria<any>(`
        SELECT LPAD(TRIM(c8::text), 5, '0') AS cod,
               TRIM(sucursal::text)         AS suc,
               TO_CHAR(c32, 'YYYY-MM')      AS mes,
               UPPER(TRIM(c3::text))        AS nat,
               SUM(${NUMC('c9')})           AS qty
        FROM kp.kdm2
        WHERE c8 IS NOT NULL
          AND c32 >= date_trunc('year', CURRENT_DATE)
          AND c32 <  date_trunc('year', CURRENT_DATE) + INTERVAL '1 year'
        GROUP BY 1, 2, 3, 4
      `, '256MB');
      for (const r of movRows) {
        const m = map[r.cod];
        if (!m || !r.suc || !r.mes) continue;
        m.mov[r.suc] ??= {};
        m.mov[r.suc][r.mes] ??= { a: 0, d: 0 };
        const q = Number(r.qty) || 0;
        if (r.nat === 'A') m.mov[r.suc][r.mes].a += q;
        else if (r.nat === 'D') m.mov[r.suc][r.mes].d += q;
      }

      const productos = Object.values(map);
      this.logger.log(`getExplorador: ${productos.length} productos | mov rows: ${movRows.length}`);
      return { total: productos.length, generado: new Date().toISOString(), productos };
    } catch (e: any) {
      this.logger.error('getExplorador error: ' + e.message);
      return { total: 0, generado: new Date().toISOString(), error: e.message, productos: [] };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Verificador de precios
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Arma la lista de unidades con precio, de la base a la mayor, sin repetir.
   * c90/c11 = unidad base, c91/c80 = unidad 2, c92/c83 = unidad 3.
   */
  private armarUnidades(r: any): UnidadPrecio[] {
    const iva  = Math.abs(Number(r.iva_raw))  / 100;
    const ieps = Math.abs(Number(r.ieps_raw)) / 100;
    const div  = (1 + iva) * (1 + ieps);

    const unidades: UnidadPrecio[] = [];
    const agregar = (nom: any, pv: any, factor: any) => {
      const u = String(nom || '').trim().toUpperCase();
      const p = pv != null ? Number(pv) : null;
      if (!u || p === null || p <= 0) return;
      if (unidades.some(x => x.u === u)) return;
      unidades.push({
        u,
        precio_con_iva: redondea(p),
        precio_sin_iva: redondea(p / (div || 1)),
        factor: Number(factor) || 1,
      });
    };

    agregar(r.u1, r.pv1, 1);
    agregar(r.u2, r.pv2, r.f2);
    agregar(r.u3, r.pv3, r.f3);

    // Respaldo por fórmula si Kepler no tiene ningún precio de venta cargado
    if (!unidades.length) {
      const margen = r.margen != null ? Number(r.margen) : null;
      const mf = margen && margen > 0 ? 1 + margen / 100 : 1;
      const conIva = redondea(Number(r.costo) * mf * div);
      if (conIva > 0) agregar(r.u1 || 'PZA', conIva, 1);
    }
    return unidades;
  }

  /** Columnas que necesita el verificador, iguales para uno o para todos. */
  private static readonly COLS_PRECIO = `
    LPAD(TRIM(c1::text), 5, '0') AS codigo,
    TRIM(c7::text)  AS bc1,
    TRIM(c82::text) AS bc2,
    TRIM(c93::text) AS bc3,
    TRIM(c95::text) AS bc4,
    TRIM(c96::text) AS bc5,
    TRIM(c2::text)  AS nombre,
    TRIM(c11::text) AS u1, ${NUMC_NULL('c90')} AS pv1,
    TRIM(c80::text) AS u2, ${NUMC_NULL('c91')} AS pv2, ${NUMC_NULL('c81')} AS f2,
    TRIM(c83::text) AS u3, ${NUMC_NULL('c92')} AS pv3, ${NUMC_NULL('c84')} AS f3,
    ${NUMC_NULL('c77')} AS costo,
    ${NUMC_NULL('c87')} AS margen,
    ${NUMC_NULL('c18')} AS iva_raw,
    ${NUMC_NULL('c19')} AS ieps_raw`;

  /** Un producto por clave interna o por código de barras. */
  async getPrecio(q: string) {
    // Sólo alfanumérico: los códigos y los EAN lo son. Además va parametrizado.
    const code = String(q || '').replace(/[^0-9A-Za-z]/g, '');
    if (!code) return { ok: false, error: 'Sin código' };

    try {
      const rows = await this.query<any>(`
        SELECT ${KpService.COLS_PRECIO}
        FROM kp.kdii
        WHERE TRIM(c1::text) = $1
           OR LPAD(TRIM(c1::text), 5, '0') = LPAD($1, 5, '0')
           OR TRIM(c7::text)  = $1
           OR TRIM(c82::text) = $1
           OR TRIM(c93::text) = $1
           OR TRIM(c95::text) = $1
           OR TRIM(c96::text) = $1
        ORDER BY c1
        LIMIT 1
      `, [code]);

      if (!rows.length) return { ok: false, code, error: 'Producto no encontrado' };

      const r = rows[0];
      const unidades = this.armarUnidades(r);
      const base = unidades[0] || null;

      return {
        ok: true,
        codigo: r.codigo,
        nombre: r.nombre || '',
        unidad: base ? base.u : (r.u1 || ''),
        precio_con_iva: base ? base.precio_con_iva : null,
        precio_sin_iva: base ? base.precio_sin_iva : null,
        unidades,
        iva_pct:  Math.round(Math.abs(Number(r.iva_raw))),
        ieps_pct: Math.round(Math.abs(Number(r.ieps_raw))),
      };
    } catch (e: any) {
      this.logger.error('getPrecio error: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Todo el catálogo con precios por unidad: alimenta al verificador offline.
   *
   * `sucursal` ('00'..'05') acota los precios a esa plaza. **Conviene siempre
   * pasarla.** Sin ella, kdii trae una fila por sucursal y el código se queda
   * con la primera que aparece, que Postgres devuelve en orden arbitrario: 385
   * códigos tienen precio distinto entre plazas, así que el precio mostrado
   * cambiaría solo cada vez que una sucursal se re-sincroniza.
   */
  async getPreciosTodos(sucursal?: string) {
    // Sólo se aceptan códigos de dos dígitos; cualquier otra cosa se ignora.
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : null;

    try {
      const rows = await this.query<any>(`
        SELECT ${KpService.COLS_PRECIO}
        FROM kp.kdii
        WHERE c1 IS NOT NULL AND c1::text ~ '^[0-9]'
          ${suc ? 'AND sucursal = $1' : ''}
        ORDER BY c1
      `, suc ? [suc] : undefined);

      const vistos = new Set<string>();
      const items: any[] = [];

      for (const r of rows) {
        if (vistos.has(r.codigo)) continue;
        vistos.add(r.codigo);

        const unidades = this.armarUnidades(r);
        if (!unidades.length) continue;  // sin precio no sirve para el verificador

        // Códigos de barras. Kepler no tiene una columna de código de barras:
        // tiene cinco casillas y el capturista usa la que encuentra libre, así
        // que hay que leerlas todas.
        //   c7, c82  códigos internos, a veces con el EAN encima
        //   c93      EAN principal del fabricante (LA ROSA MAZAPAN /30)
        //   c95      EAN de varias líneas de Mondelez (Trident, Tang)
        //   c96      segundo EAN de presentaciones multipieza (NESTLE
        //            FRESKAS 9P: su 7501059281172 sólo vive aquí, salvo en
        //            Zamora, donde quedó en c82 — el mismo producto tiene las
        //            casillas en distinto orden según la sucursal)
        //
        // Se descartan los que sólo repiten la clave del producto: no aportan
        // nada como llave de búsqueda y ensucian el archivo del verificador.
        const bcs = [...new Set(
          [r.bc1, r.bc2, r.bc3, r.bc4, r.bc5]
            .map(b => String(b || '').trim())
            .filter(b => b && b !== r.codigo)
        )];

        items.push({
          c: r.codigo,
          b: bcs,
          n: r.nombre || '',
          u: unidades.map(x => ({ u: x.u, p: x.precio_con_iva, s: x.precio_sin_iva })),
        });
      }

      this.logger.log(`getPreciosTodos: ${items.length} productos${suc ? ' (sucursal ' + suc + ')' : ' (TODAS, precio no determinista)'}`);
      return {
        total: items.length,
        sucursal: suc,
        generado: new Date().toISOString(),
        productos: items,
      };
    } catch (e: any) {
      this.logger.error('getPreciosTodos error: ' + e.message);
      return { total: 0, generado: new Date().toISOString(), error: e.message, productos: [] };
    }
  }

  private fallbackVentasSuc(): VentaSuc[] {
    this.logger.warn('KP getVentasSuc: usando datos del artifact (fallback)');
    return [
      { suc:'03', total:53641778.65, docs:54659 },
      { suc:'02', total:22192138.85, docs:41048 },
      { suc:'05', total:8703422.91,  docs:5665  },
      { suc:'04', total:5175837.37,  docs:17279 },
      { suc:'01', total:1417605.68,  docs:882   },
      { suc:'00', total:228676.04,   docs:3     },
    ];
  }

  private fallbackTrend(): TrendItem[] {
    this.logger.warn('KP getTrend: usando datos del artifact (fallback)');
    return [
      { suc:'03', mes:'2026-01', total:8759628.65  },
      { suc:'03', mes:'2026-02', total:9863677.66  },
      { suc:'03', mes:'2026-03', total:8700238.32  },
      { suc:'03', mes:'2026-04', total:8814102.45  },
      { suc:'03', mes:'2026-05', total:8443016.06  },
      { suc:'03', mes:'2026-06', total:9051264.56  },
      { suc:'02', mes:'2026-01', total:3653094.15  },
      { suc:'02', mes:'2026-02', total:3814234.71  },
      { suc:'02', mes:'2026-03', total:3457756.70  },
      { suc:'02', mes:'2026-04', total:3744778.39  },
      { suc:'02', mes:'2026-05', total:3961598.86  },
      { suc:'02', mes:'2026-06', total:3547523.99  },
    ];
  }

  private fallbackArticulos(): Articulo[] {
    this.logger.warn('KP getArticulos: usando datos del artifact (fallback)');
    return [
      { cod:'17083', desc:'ALTOS CAM CHICA COLOR 1KG CLASICA',      cant:569617, imp:863687 },
      { cod:'17084', desc:'ALTOS CAM MEDIANA COLOR 1KG CLASICA',    cant:479602, imp:844121 },
      { cod:'70001', desc:'LA ROSA MAZAPAN /30',                     cant:579658, imp:697214 },
      { cod:'70068', desc:'LA ROSA JAPONES TUBO 60G 12P NISHIYAMA', cant:399296, imp:679831 },
      { cod:'59108', desc:'AGUA MEMBERS MARK (500ML) / 1',          cant:50842,  imp:645087 },
    ];
  }

  private async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const r = await this.db.raw(sql, params ?? []);
    return r.rows as T[];
  }

  /**
   * Ejecuta una consulta con más memoria de trabajo de la que tiene el
   * servidor por omisión (4 MB), para que agrupar millones de filas no se
   * desborde a disco.
   *
   * Va dentro de una transacción con SET LOCAL: al terminar, la conexión
   * vuelve a su configuración normal sola. `knex.transaction()` hace commit
   * si el callback resuelve y rollback si lanza — mismo efecto que el
   * BEGIN/COMMIT/ROLLBACK manual del original, sin manejar la conexión a mano.
   */
  private async queryConMemoria<T = any>(sql: string, memoria: string, params?: any[]): Promise<T[]> {
    return this.db.transaction(async (trx) => {
      // El valor no viene de fuera, es una constante del código.
      await trx.raw(`SET LOCAL work_mem = '${memoria}'`);
      const r = await trx.raw(sql, params ?? []);
      return r.rows as T[];
    });
  }
}
