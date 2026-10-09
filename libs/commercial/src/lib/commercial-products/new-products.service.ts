import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  CRITERIO_RECOMPRA,
  Cohorte,
  Existencia,
  Movimiento,
  NewProductKind,
  NewProductRow,
  NewProductSource,
  PlazaRow,
  Resumen,
  armarProducto,
  construirCohortes,
  construirResumen,
  esKindValido,
  ocultarCosto,
  ocultarCostoPlazas,
} from './new-products';

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
  criterio: typeof CRITERIO_RECOMPRA;
  resumen: Resumen | null;
  cohortes: Cohorte[];
  filas: NewProductRow[];
}

export interface NewProductDetail {
  frescura: Frescura;
  costo_visible: boolean;
  producto: NewProductRow;
  plazas: PlazaRow[];
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
  r.kind                                     AS clasificacion,
  r.note                                     AS nota,
  r.updated_by_username                      AS clasificado_por,
  m.calculado_at`;

/**
 * `[NP.2]` **Productos nuevos** — la etiqueta "Nuevo", su seguimiento a 30/60/90 días y la
 * recomendación de recompra, global y por sucursal.
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
 */
@Injectable()
export class NewProductsService {
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
  private async enVivo(trx: Knex.Transaction, prods: Array<{ product_id: string; sku: string }>, corte: string, hoy: string) {
    if (!prods.length) return { vivo: [] as Movimiento[], existencia: [] as Existencia[] };
    const ids = prods.map((p) => p.product_id);
    // La función trabaja por SKU (entra por los índices del ODS); aquí se vuelve a producto.
    const porSku = new Map<string, string[]>();
    for (const p of prods) porSku.set(p.sku, [...(porSku.get(p.sku) ?? []), p.product_id]);
    const crudo = (await trx.raw(`
      SELECT sku, tipo, plaza, to_char(fecha, 'YYYY-MM-DD') AS fecha, folio, unidad, cantidad, importe
        FROM analytics.fn_new_products_movimientos(public.current_tenant_id(), ?::text[], ?::date, ?::date)`,
    [[...porSku.keys()], corte, hoy])).rows as Array<Omit<Movimiento, 'product_id'> & { sku: string }>;
    const vivo: Movimiento[] = crudo.flatMap(({ sku, ...m }) =>
      (porSku.get(sku) ?? []).map((product_id) => ({ ...m, product_id })));
    // ⚠️ El rótulo y el peldaño mayor salen de la ficha de ESA plaza: el factor de caja puede
    // cambiar de una sucursal a otra, y Wincaja no tiene ficha de Kepler (se declara aparte).
    const existencia = (await trx.raw(`
      SELECT s.product_id, s.warehouse_code AS plaza, s.qty_stock_units AS cantidad,
             s.display_box_factor AS factor,
             -- unit_source dice en qué unidad viene la cantidad ('kepler' = la base de su ficha;
             -- 'wincaja' / 'wincaja_multipack' = la de Wincaja). source NO sirve: vale 'kepler_ods'.
             CASE WHEN s.unit_source LIKE 'wincaja%' THEN 'wincaja' ELSE s.unit_source END AS fuente,
             l.u1_label AS unidad, l.unidad_caja AS unidad_mayor, l.factor_caja AS factor_mayor
        FROM analytics.v_erp_stock_on_hand s
        LEFT JOIN commercial.warehouses w ON w.id = s.warehouse_id
        LEFT JOIN analytics.v_kepler_unit_ladder l
          ON s.unit_source = 'kepler' AND l.sucursal = w.kepler_code AND l.sku = btrim(s.sku)
       WHERE s.tenant_id = public.current_tenant_id() AND s.product_id = ANY(?::uuid[])
         -- [NP.13] Sólo Kepler: la existencia de las plazas que siguen en Wincaja no entra.
         AND s.unit_source = 'kepler'`,
    [ids])).rows as Existencia[];
    return { vivo, existencia };
  }

  async list(opts: { puedeVerCosto: boolean }): Promise<NewProductsResponse> {
    const vacio = (frescura: Frescura | null): NewProductsResponse => ({
      calculado: false, frescura, costo_visible: opts.puedeVerCosto, criterio: CRITERIO_RECOMPRA,
      resumen: null, cohortes: [], filas: [],
    });
    return this.tk.run(async (trx) => {
      if (!(await this.poblada(trx))) return vacio(null);
      const hoy = await this.hoy(trx);
      const rows = (await trx.raw(`
        SELECT ${COLUMNAS}
          FROM analytics.mv_new_products m
          LEFT JOIN catalog.new_product_reviews r
            ON r.tenant_id = m.tenant_id AND r.product_id = m.product_id AND r.deleted_at IS NULL
         WHERE m.tenant_id = public.current_tenant_id()`)).rows as Array<NewProductSource & { calculado_at: Date | string }>;
      if (!rows.length) {
        return { ...vacio({ historia_al: null, corte: null, en_vivo_al: new Date().toISOString(), hoy }), calculado: true };
      }
      const corte = rows[0].corte;
      const { vivo, existencia } = await this.enVivo(trx, rows, corte, hoy);
      const vivoPor = agrupar(vivo);
      const exPor = agrupar(existencia);
      const nombres = await this.nombresPlaza(trx);

      let filas = rows.map((r) => armarProducto(r, hoy, vivoPor.get(r.product_id) ?? [],
        exPor.get(r.product_id) ?? [], { conCosto: opts.puedeVerCosto, nombres }).fila);
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
        criterio: CRITERIO_RECOMPRA,
        resumen: construirResumen(filas),
        cohortes: construirCohortes(filas),
        filas,
      };
    });
  }

  /** El comportamiento de UN producto en cada sucursal. */
  async detail(productId: string, opts: { puedeVerCosto: boolean }): Promise<NewProductDetail> {
    if (!UUID_RE.test(productId || '')) throw new BadRequestException('Producto inválido');
    return this.tk.run(async (trx) => {
      if (!(await this.poblada(trx))) throw new NotFoundException('Las cifras todavía no se calculan');
      const hoy = await this.hoy(trx);
      const row = (await trx.raw(`
        SELECT ${COLUMNAS}
          FROM analytics.mv_new_products m
          LEFT JOIN catalog.new_product_reviews r
            ON r.tenant_id = m.tenant_id AND r.product_id = m.product_id AND r.deleted_at IS NULL
         WHERE m.tenant_id = public.current_tenant_id() AND m.product_id = ?`,
      [productId])).rows[0] as (NewProductSource & { calculado_at: Date | string }) | undefined;
      if (!row) throw new NotFoundException('El producto no está en seguimiento de productos nuevos');

      const { vivo, existencia } = await this.enVivo(trx, [row], row.corte, hoy);
      const nombres = await this.nombresPlaza(trx);

      const armado = armarProducto(row, hoy, vivo, existencia, { conCosto: opts.puedeVerCosto, nombres });
      return {
        frescura: {
          historia_al: row.calculado_at ? new Date(row.calculado_at).toISOString() : null,
          corte: row.corte, en_vivo_al: new Date().toISOString(), hoy,
        },
        costo_visible: opts.puedeVerCosto,
        producto: opts.puedeVerCosto ? armado.fila : ocultarCosto([armado.fila])[0],
        plazas: (opts.puedeVerCosto ? armado.plazas : ocultarCostoPlazas(armado.plazas)).sort(ordenPlazas),
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

/** Lo que pide acción primero: recomprar, revisar, no recomprar, esperar, pronto; dentro, lo más reciente. */
const ORDEN_VEREDICTO = { recomprar: 0, revisar: 1, no_recomprar: 2, esperar: 3, pronto: 4 } as const;
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
