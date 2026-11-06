import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { KpiUmbral } from '@megadulces/contracts';
import {
  CRITERIO_LANZAMIENTO,
  Cohorte,
  Existencia,
  CompraNetaInfo,
  Movimiento,
  NewProductKind,
  NewProductRow,
  NewProductSource,
  PlazaRow,
  RenglonCompra,
  Resumen,
  Veredicto,
  armarProducto,
  compraPorDocumento,
  compraSinImpuestos,
  conHitos,
  construirCohortes,
  construirResumen,
  esKindValido,
  ocultarCosto,
  ocultarCostoPlazas,
} from './new-products';
import { COMPRA_RENGLONES_SQL, EXISTENCIA_KEPLER_SQL, LEER_UMBRALES_HITOS_SQL } from './new-products.sql';

/**
 * `[NP.6]` Qué se sabe de los umbrales de los cortes 30/60/90. Separa «no hay umbral» de «no se pudo leer el
 * registro» (ADR-056: no es lo mismo). Los cortes NO se guardan: se derivan de la historia (`[NP.6]` sin tabla).
 */
export interface HitosInfo {
  /** `false` = `analytics.kpi_thresholds` no existe o no se pudo leer. */
  umbrales_disponibles: boolean;
  /** Umbrales registrados para los hitos (`compras.productos_nuevos.*`). 0 = sin meta. */
  umbrales: number;
}

/**
 * `[NP.18]` Cómo quedó la compra sin impuestos. `medida = false` = no se pudieron leer los renglones de compra:
 * la inversión va con lo que Kepler escribió (puede traer impuestos en las entradas con tasa negativa) y se dice.
 */
export interface CompraInfo extends CompraNetaInfo {
  medida: boolean;
}

/** Cuándo es cada pedazo del dato: la historia cierra de noche, lo de hoy es en vivo. */
export interface Frescura {
  /** Cuándo se calculó la historia (el último refresco nocturno). */
  historia_al: string | null;
  /** Primer día que viene en vivo (lo anterior es historia). */
  corte: string | null;
  /** Cuándo se leyó lo de hoy: el momento de esta consulta. */
  en_vivo_al: string;
  hoy: string;
}

export interface NewProductsResponse {
  /** `false` = la matvista existe pero el lote nocturno todavía no la ha poblado. */
  calculado: boolean;
  frescura: Frescura | null;
  /** `false` = el usuario no tiene permiso de costo: la inversión viene en NULL a propósito. */
  costo_visible: boolean;
  criterio: typeof CRITERIO_LANZAMIENTO;
  resumen: Resumen | null;
  cohortes: Cohorte[];
  filas: NewProductRow[];
  /** `[NP.6]` NULL = la lista no se calculó (matvista sin poblar). */
  hitos_info: HitosInfo | null;
  /** `[NP.18]` NULL = la lista no se calculó. */
  compra_info: CompraInfo | null;
}

export interface NewProductDetail {
  frescura: Frescura;
  costo_visible: boolean;
  producto: NewProductRow;
  plazas: PlazaRow[];
  hitos_info: HitosInfo;
  compra_info: CompraInfo;
}

/** Lo que queda guardado al clasificar: `clasificacion = null` = se quitó. */
export interface NewProductClassification {
  product_id: string;
  clasificacion: NewProductKind | null;
  nota: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOY = "(now() AT TIME ZONE 'America/Mexico_City')::date";

/** Las columnas de la matvista que la lógica necesita, con la clasificación de Compras unida. */
const COLUMNAS = `
  m.product_id, m.sku, m.nombre, m.marca, m.proveedor,
  to_char(m.alta_suite, 'YYYY-MM-DD')        AS alta_suite,
  m.alta_en_lote,
  to_char(m.primera_recepcion, 'YYYY-MM-DD') AS primera_recepcion,
  to_char(m.primera_venta, 'YYYY-MM-DD')     AS primera_venta,
  to_char(m.lanzamiento, 'YYYY-MM-DD')       AS lanzamiento,
  to_char(m.historia_desde, 'YYYY-MM-DD')    AS historia_desde,
  m.fuentes, m.sin_movimiento, m.no_medible, m.exclusion_auto, m.posible_recodificacion,
  to_char(m.corte, 'YYYY-MM-DD')             AS corte,
  m.venta_dia, m.venta_por_plaza, m.venta_unidades, m.entradas,
  m.margen_plaza, m.compra_base,
  m.llegada, m.venta_unidades_hito, m.reparto, m.kardex_plaza, m.escalera_plaza,
  r.kind                                     AS clasificacion,
  r.note                                     AS nota,
  r.updated_by_username                      AS clasificado_por,
  m.calculado_at`;

/**
 * `[NP.2]` **Productos nuevos** — la etiqueta "Nuevo", su seguimiento a 30/60/90 días y la
 * juicio del lanzamiento (`[NP.20]`: se queda · revisar · sacar), global y por sucursal.
 *
 * Tres lecturas, siempre para TODOS los productos a la vez (nunca una por producto):
 *   1. `analytics.mv_new_products` — la historia cerrada (refresco nocturno).
 *   2. `analytics.fn_new_products_movimientos(tenant, skus, corte, hoy)` — la venta y las entradas
 *      de hoy, del ODS en vivo: la MISMA función con la que la matvista armó su historia, así
 *      que las reglas y la unidad del renglón son las mismas.
 *   3. `analytics.v_erp_stock_on_hand` — la existencia de este momento, con el rótulo de la ficha
 *      de Kepler de CADA plaza (`analytics.v_kepler_unit_ladder`, grano sucursal × SKU): Kepler
 *      guarda el inventario en la unidad base de esa ficha.
 * La matvista no tiene RLS (Postgres no la soporta en matvistas): el tenant se filtra EXPLÍCITO con
 * `public.current_tenant_id()`, que `tk.run` deja puesto.
 *
 * Las decisiones viven en `new-products.ts`, puras y probadas. Aquí sólo se lee y se arma.
 *
 * `[NP.6]` Los cortes 30/60/90 se DERIVAN de la historia (sin tabla ni cron, decisión de David 2026-11-04) y se
 * juzgan contra `analytics.kpi_thresholds`. `[NP.18]` La compra se netea aquí con `costoSinImpuestos`. Las dos
 * lecturas son OPCIONALES: si fallan, la pantalla sigue y lo DECLARA (`hitos_info`, `compra_info`).
 */
@Injectable()
export class NewProductsService {
  private readonly logger = new Logger(NewProductsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Una matvista sin poblar REVIENTA al leerla: se pregunta antes y se declara. */
  private async poblada(trx: Knex.Transaction): Promise<boolean> {
    const r = await trx.raw(`SELECT c.relispopulated AS p FROM pg_class c
                              WHERE c.oid = to_regclass('analytics.mv_new_products')`);
    return r.rows[0]?.p === true;
  }

  private async hoy(trx: Knex.Transaction): Promise<string> {
    return (await trx.raw(`SELECT to_char(${HOY}, 'YYYY-MM-DD') AS hoy`)).rows[0].hoy as string;
  }

  /** Código de plaza → nombre de la sucursal (para decir cuál se mueve mejor). */
  private async nombresPlaza(trx: Knex.Transaction): Promise<Map<string, string>> {
    const r = await trx.raw(`
      SELECT code, name FROM commercial.warehouses
       WHERE tenant_id = public.current_tenant_id() AND deleted_at IS NULL`);
    return new Map<string, string>(r.rows.map((w: { code: string; name: string }) => [w.code, w.name]));
  }

  /** Lo de hoy (ODS en vivo) y la existencia actual de estos productos. */
  private async enVivo(trx: Knex.Transaction, prods: Array<Pick<NewProductSource, 'product_id' | 'sku' | 'escalera_plaza'>>, corte: string, hoy: string) {
    if (!prods.length) return { vivo: [] as Movimiento[], existencia: [] as Existencia[] };
    const ids = prods.map((p) => p.product_id);
    // La función trabaja por SKU (entra por los índices del ODS); aquí se vuelve a producto.
    const porSku = new Map<string, string[]>();
    for (const p of prods) porSku.set(p.sku, [...(porSku.get(p.sku) ?? []), p.product_id]);
    const crudo = (await trx.raw(`
      SELECT sku, tipo, plaza, to_char(fecha, 'YYYY-MM-DD') AS fecha, folio, unidad, cantidad, importe, importe_neto
        FROM analytics.fn_new_products_movimientos(public.current_tenant_id(), ?::text[], ?::date, ?::date)`,
    [[...porSku.keys()], corte, hoy])).rows as Array<Omit<Movimiento, 'product_id'> & { sku: string }>;
    const vivo: Movimiento[] = crudo.flatMap(({ sku, ...m }) =>
      (porSku.get(sku) ?? []).map((product_id) => ({ ...m, product_id })));
    // [NP.17] Directo de kdil, con las reglas de la rama Kepler de v_erp_stock_on_hand (ver
    // new-products.sql.ts): la vista calcula el factor de caja de todo el catálogo y costaba 1-2 s.
    // El rótulo base sale de la ficha de ESA plaza que ya trae la matvista (escalera_plaza.u1):
    // Kepler guarda el inventario en esa unidad, y la ficha puede cambiar de una sucursal a otra.
    const fichas = new Map(prods.map((p) => [p.product_id, p.escalera_plaza ?? {}]));
    const existencia = ((await trx.raw(EXISTENCIA_KEPLER_SQL, [[...porSku.keys()], ids])).rows as Array<Existencia & { sucursal: string }>)
      .map(({ sucursal, ...e }) => ({ ...e, unidad: fichas.get(e.product_id)?.[sucursal]?.u1 ?? null }));
    return { vivo, existencia };
  }

  /**
   * Lee la matvista + lo de hoy + la existencia y arma TODOS los productos. NULL = la matvista no está poblada.
   */
  private async armarTodos(trx: Knex.Transaction, conCosto: boolean): Promise<{
    hoy: string; rows: Array<NewProductSource & { calculado_at: Date | string }>; filas: NewProductRow[]; compra: CompraInfo;
  } | null> {
    if (!(await this.poblada(trx))) return null;
    const hoy = await this.hoy(trx);
    const crudas = (await trx.raw(`
      SELECT ${COLUMNAS}
        FROM analytics.mv_new_products m
        LEFT JOIN catalog.new_product_reviews r
          ON r.tenant_id = m.tenant_id AND r.product_id = m.product_id AND r.deleted_at IS NULL
       WHERE m.tenant_id = public.current_tenant_id()`)).rows as Array<NewProductSource & { calculado_at: Date | string }>;
    const vacia: CompraInfo = { medida: true, documentos: 0, descontados: 0, sin_documento: 0, no_cuadra: 0 };
    if (!crudas.length) return { hoy, rows: crudas, filas: [], compra: vacia };
    const en = await this.enVivo(trx, crudas, crudas[0].corte, hoy);
    // [NP.18] La compra sin impuestos, antes de armar: la inversión, los hitos y la cohorte la usan.
    const { rows, vivo, compra } = await this.netearCompras(trx, crudas, en.vivo);
    const vivoPor = agrupar(vivo);
    const exPor = agrupar(en.existencia);
    const nombres = await this.nombresPlaza(trx);
    const filas = rows.map((r) => armarProducto(r, hoy, vivoPor.get(r.product_id) ?? [],
      exPor.get(r.product_id) ?? [], { conCosto, nombres }).fila);
    return { hoy, rows, filas, compra };
  }

  /**
   * `[NP.18]` (sin migración) Lee los renglones de compra de los documentos que traen la historia y lo de hoy
   * (`COMPRA_RENGLONES_SQL`, por documento) y les quita el impuesto con `costoSinImpuestos`. Lectura OPCIONAL en
   * su SAVEPOINT: si falla, la inversión queda con lo que escribió Kepler y `compra_info.medida = false` lo dice.
   */
  private async netearCompras<T extends NewProductSource>(trx: Knex.Transaction, rows: T[], vivo: Movimiento[]): Promise<{
    rows: T[]; vivo: Movimiento[]; compra: CompraInfo;
  }> {
    const info: CompraInfo = { medida: true, documentos: 0, descontados: 0, sin_documento: 0, no_cuadra: 0 };
    const docs = new Map<string, [string, string]>();
    const fechas: string[] = [];
    for (const r of rows) for (const e of r.entradas ?? []) if (e.folio) { docs.set(`${e.p}|${e.folio}`, [e.p, e.folio]); fechas.push(e.f.slice(0, 10)); }
    for (const m of vivo) if (m.tipo === 'entrada' && m.folio) { docs.set(`${m.plaza}|${m.folio}`, [m.plaza, m.folio]); fechas.push(m.fecha.slice(0, 10)); }
    if (!docs.size) return { rows, vivo, compra: info };
    const pares = [...docs.values()];
    let renglones: RenglonCompra[];
    try {
      renglones = await trx.transaction(async (sp) => (await sp.raw(COMPRA_RENGLONES_SQL,
        [pares.map((p) => p[0]), pares.map((p) => p[1]), fechas.reduce((x, y) => (y < x ? y : x)), fechas.reduce((x, y) => (y > x ? y : x)),
          [...new Set(rows.map((r) => r.sku))]])).rows as RenglonCompra[]);
    } catch (e) {
      this.logger.warn(`[NP.18] Los renglones de compra no se pudieron leer (la inversión va como la escribió Kepler): ${(e as Error).message}`);
      return { rows, vivo, compra: { ...info, medida: false } };
    }
    const mapa = compraPorDocumento(renglones);
    const vivoPor = agrupar(vivo);
    const ids = new Set(rows.map((r) => r.product_id));
    const salida: Movimiento[] = vivo.filter((m) => !ids.has(m.product_id));
    const netas = rows.map((r) => {
      const x = compraSinImpuestos(r, vivoPor.get(r.product_id) ?? [], mapa, info);
      salida.push(...x.vivo);
      return x.fuente;
    });
    return { rows: netas, vivo: salida, compra: info };
  }

  /**
   * `[NP.6]` Los umbrales de los cortes. OPCIONAL: la lectura va en su SAVEPOINT, así que una tabla que no existe
   * o un permiso que falta no tumba la pantalla; se declara en `HitosInfo` y el semáforo dice «sin meta» por la
   * razón correcta.
   */
  private async leerUmbrales(trx: Knex.Transaction): Promise<{ umbrales: KpiUmbral[] | null; info: HitosInfo }> {
    const hay = (await trx.raw(`SELECT to_regclass('analytics.kpi_thresholds') IS NOT NULL AS umbrales`)).rows[0] as { umbrales: boolean };
    let umbrales: KpiUmbral[] | null = null;
    if (hay.umbrales) {
      try {
        umbrales = await trx.transaction(async (sp) => (await sp.raw(LEER_UMBRALES_HITOS_SQL)).rows as KpiUmbral[]);
      } catch (e) {
        this.logger.warn(`[NP.6] los umbrales de los hitos no se pudieron leer (se declara, la pantalla sigue): ${(e as Error).message}`);
      }
    }
    return { umbrales, info: { umbrales_disponibles: umbrales !== null, umbrales: umbrales?.length ?? 0 } };
  }

  async list(opts: { puedeVerCosto: boolean }): Promise<NewProductsResponse> {
    const vacio = (frescura: Frescura | null): NewProductsResponse => ({
      calculado: false, frescura, costo_visible: opts.puedeVerCosto, criterio: CRITERIO_LANZAMIENTO,
      resumen: null, cohortes: [], filas: [], hitos_info: null, compra_info: null,
    });
    return this.tk.run(async (trx) => {
      const armado = await this.armarTodos(trx, opts.puedeVerCosto);
      if (!armado) return vacio(null);
      const { hoy, rows } = armado;
      if (!rows.length) {
        return { ...vacio({ historia_al: null, corte: null, en_vivo_al: new Date().toISOString(), hoy }), calculado: true };
      }
      const corte = rows[0].corte;
      // [NP.6] Los cortes salen de la historia; el semáforo los juzga contra la meta de Compras.
      const { umbrales, info } = await this.leerUmbrales(trx);
      let filas = armado.filas.map((f) => conHitos(f, umbrales));
      // Se oculta ANTES de agregar: así la cohorte tampoco deja ver la inversión sumada.
      if (!opts.puedeVerCosto) filas = ocultarCosto(filas);
      filas.sort(ordenFilas);

      return {
        calculado: true,
        frescura: {
          historia_al: rows[0].calculado_at ? new Date(rows[0].calculado_at).toISOString() : null,
          corte, en_vivo_al: new Date().toISOString(), hoy,
        },
        costo_visible: opts.puedeVerCosto,
        criterio: CRITERIO_LANZAMIENTO,
        resumen: construirResumen(filas),
        cohortes: construirCohortes(filas),
        filas,
        hitos_info: info,
        compra_info: armado.compra,
      };
    });
  }

  /** El comportamiento de UN producto en cada sucursal. */
  async detail(productId: string, opts: { puedeVerCosto: boolean }): Promise<NewProductDetail> {
    if (!UUID_RE.test(productId || '')) throw new BadRequestException('Producto inválido');
    return this.tk.run(async (trx) => {
      if (!(await this.poblada(trx))) throw new NotFoundException('Las cifras todavía no se calculan');
      const hoy = await this.hoy(trx);
      const cruda = (await trx.raw(`
        SELECT ${COLUMNAS}
          FROM analytics.mv_new_products m
          LEFT JOIN catalog.new_product_reviews r
            ON r.tenant_id = m.tenant_id AND r.product_id = m.product_id AND r.deleted_at IS NULL
         WHERE m.tenant_id = public.current_tenant_id() AND m.product_id = ?`,
      [productId])).rows[0] as (NewProductSource & { calculado_at: Date | string }) | undefined;
      if (!cruda) throw new NotFoundException('El producto no está en seguimiento de productos nuevos');

      const en = await this.enVivo(trx, [cruda], cruda.corte, hoy);
      const { rows: [row], vivo, compra } = await this.netearCompras(trx, [cruda], en.vivo);
      const nombres = await this.nombresPlaza(trx);

      const armado = armarProducto(row, hoy, vivo, en.existencia, { conCosto: opts.puedeVerCosto, nombres });
      const { umbrales, info } = await this.leerUmbrales(trx);
      const fila = conHitos(armado.fila, umbrales);
      return {
        frescura: {
          historia_al: row.calculado_at ? new Date(row.calculado_at).toISOString() : null,
          corte: row.corte, en_vivo_al: new Date().toISOString(), hoy,
        },
        costo_visible: opts.puedeVerCosto,
        producto: opts.puedeVerCosto ? fila : ocultarCosto([fila])[0],
        plazas: (opts.puedeVerCosto ? armado.plazas : ocultarCostoPlazas(armado.plazas)).sort(ordenPlazas),
        hitos_info: info,
        compra_info: compra,
      };
    });
  }

  /**
   * Compras confirma qué es cada código. `kind = null` quita la clasificación (soft-delete): el
   * producto vuelve a "por confirmar" y queda el rastro de quién decidió qué.
   */
  async classify(productId: string, body: { kind?: string | null; note?: string | null }): Promise<NewProductClassification> {
    if (!UUID_RE.test(productId || '')) throw new BadRequestException('Producto inválido');
    const kind = body?.kind ?? null;
    if (kind !== null && !esKindValido(kind)) {
      throw new BadRequestException('Clasificación inválida: nuevo, recodificacion, promocion o no_mercancia');
    }
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    const ctx = this.tenantCtx.get();
    const userId = ctx?.userId && UUID_RE.test(ctx.userId) ? ctx.userId : null;
    const username = ctx?.username ?? null;

    return this.tk.run(async (trx) => {
      const existe = await trx.raw(
        `SELECT 1 FROM catalog.products WHERE id = ? AND tenant_id = public.current_tenant_id() AND deleted_at IS NULL`,
        [productId]);
      if (!existe.rows.length) throw new NotFoundException('Producto no encontrado');

      if (kind === null) {
        await trx.raw(`
          UPDATE catalog.new_product_reviews
             SET deleted_at = now(), deleted_by = ?, updated_at = now(), updated_by = ?, updated_by_username = ?
           WHERE tenant_id = public.current_tenant_id() AND product_id = ? AND deleted_at IS NULL`,
        [userId, userId, username, productId]);
        return { product_id: productId, clasificacion: null, nota: null };
      }

      await trx.raw(`
        INSERT INTO catalog.new_product_reviews
          (tenant_id, product_id, kind, note, created_by, created_by_username, updated_by, updated_by_username)
        VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, product_id) WHERE deleted_at IS NULL DO UPDATE
           SET kind = EXCLUDED.kind, note = EXCLUDED.note, updated_at = now(),
               updated_by = EXCLUDED.updated_by, updated_by_username = EXCLUDED.updated_by_username`,
      [productId, kind, note, userId, username, userId, username]);
      return { product_id: productId, clasificacion: kind as NewProductKind, nota: note };
    });
  }
}

function agrupar<T extends { product_id: string }>(lista: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of lista) {
    const l = m.get(x.product_id);
    if (l) l.push(x);
    else m.set(x.product_id, [x]);
  }
  return m;
}

/**
 * Lo que pide atención primero: sacar, revisar, agotado (no se puede juzgar), se queda, pronto; dentro,
 * lo más reciente. `[NP.20]` Antes encabezaba «recomprar»: la compra ya no la decide esta pantalla.
 */
const ORDEN_VEREDICTO: Record<Veredicto, number> = { sacar: 0, revisar: 1, agotado: 2, se_queda: 3, pronto: 4 };
function ordenFilas(a: NewProductRow, b: NewProductRow): number {
  const va = a.recomendacion ? ORDEN_VEREDICTO[a.recomendacion.veredicto] : 9;
  const vb = b.recomendacion ? ORDEN_VEREDICTO[b.recomendacion.veredicto] : 9;
  if (va !== vb) return va - vb;
  return (b.lanzamiento ?? '').localeCompare(a.lanzamiento ?? '');
}
function ordenPlazas(a: PlazaRow, b: PlazaRow): number {
  const va = ORDEN_VEREDICTO[a.recomendacion.veredicto];
  const vb = ORDEN_VEREDICTO[b.recomendacion.veredicto];
  if (va !== vb) return va - vb;
  return b.venta_total - a.venta_total;
}
