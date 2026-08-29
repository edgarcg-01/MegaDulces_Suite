import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Motor de Rentabilidad (Fase MR) — la cascada de margen sobre venta REAL.
 *
 * Fuente de la venta Y del costo: `analytics.sales_daily` (sell-out consolidado
 * de Kepler/Wincaja). NO `commercial.order_lines` — esa tabla tiene 18 filas: la
 * venta de Mega Dulces no pasa por la plataforma.
 *
 * **El costo sale del fact, NO de `catalog.products.cost_base`.**
 * `sales_daily.cost` es el costo que registró el PdV en la transacción, en la
 * MISMA unidad en que cobró. `cost_base` es costo de catálogo y en buena parte
 * del catálogo viene por CAJA — multiplicarlo por unidades vendidas por PIEZA
 * mezcla unidades. Medido: 30 SKUs aportaban $1.76M de COGS (10.4% del total)
 * sobre $123k de venta, y movían el margen publicado de 10.3% a 13.05%
 * (8.6 pp de aire). Es el riesgo #1 del plan de fase (§2.3) y la regla dura de
 * `analytics.v_product_box_factor`: ningún componente entra sin unidad resuelta.
 * `cost_base` se sigue usando para valuar inventario (regla canónica del
 * proyecto) y se contrasta contra el costo del fact para marcar el conflicto.
 *
 * **Las palancas se leen por `categoria`, no por doctype.**
 * `analytics.erp_purchase_adjustments` ya trae la causa clasificada desde el
 * motivo `c24` (RE.10 — la misma clasificación que usa `/compras/descuentos`).
 * Sumar por doctype metería `factura_duplicada` ($6.7M de error de captura)
 * dentro del margen negociado e inflaría el resultado:
 *
 *   comerciales (SÍ son margen):    descuento_comercial · apoyo_marca ·
 *                                   pronto_pago · saldo_favor
 *   operacionales (NO son margen):  faltante · mal_estado · no_solicitado ·
 *                                   devolucion_otra · diferencia_monto · cambiada
 *   error de captura (NO):          factura_duplicada
 *
 * El descuento al cliente sale de `analytics.erp_promotions` (vista viva sobre
 * `kepler_ods.kdpv_*`), que sí está atribuida a SKU + almacén + periodo.
 *
 * `analytics.*` no tiene RLS → todos los queries filtran `tenant_id` explícito.
 */

export type MarginWindow = '30d' | '90d' | '365d';
export type MarginLevel = 'supplier' | 'brand' | 'category' | 'sku';

const WINDOWS: Record<MarginWindow, { days: number }> = {
  '30d': { days: 30 },
  '90d': { days: 90 },
  '365d': { days: 365 },
};

export type MarginBand = 'negativo' | 'critico' | 'bajo' | 'meta' | 'alto';

/**
 * Bandas de salud, DERIVADAS del objetivo. Antes estaban clavadas en 10/15/25
 * mientras el objetivo era editable: con objetivo 20% el KPI coloreaba contra 20
 * y las bandas contra 15 — dos verdades en la misma pantalla.
 * Un solo origen para el TS y para el `CASE` de SQL.
 */
export function marginBands(target: number) {
  const r = (n: number) => Math.round(n * 10) / 10;
  const low = r(target * (2 / 3));
  const high = r(target * (5 / 3));
  return [
    { key: 'negativo' as MarginBand, label: 'Bajo costo', tone: 'bad', from: null, to: 0 },
    { key: 'critico' as MarginBand, label: `0–${low}%`, tone: 'bad', from: 0, to: low },
    { key: 'bajo' as MarginBand, label: `${low}–${target}%`, tone: 'warn', from: low, to: target },
    { key: 'meta' as MarginBand, label: `${target}–${high}%`, tone: 'ok', from: target, to: high },
    { key: 'alto' as MarginBand, label: `${high}%+`, tone: 'ok', from: high, to: null },
  ];
}

/**
 * Umbral de conflicto entre el costo de catálogo y el que cobró el PdV. Fuera de
 * [1/1.5, 1.5] la diferencia ya no es drift de costo: es otra unidad (caja vs
 * pieza). No corrige el catálogo — lo marca para que nadie valúe a ciegas.
 */
const COST_CONFLICT_RATIO = 1.5;

/**
 * Palancas COMERCIALES: las únicas categorías de ajuste que son margen.
 * Espejo del mapa `GRUPO` de `purchase-adjustments.service.ts` (RE.10) — si allá
 * se reclasifica una categoría, acá también.
 */
export const LEVER_CATS = [
  { cat: 'descuento_comercial', label: 'Descuento comercial del proveedor', owner: 'Compras' },
  { cat: 'apoyo_marca', label: 'Apoyo de marca / promocional', owner: 'Compras + Marketing' },
  { cat: 'pronto_pago', label: 'Pronto pago (nota de crédito)', owner: 'Compras + Finanzas' },
  { cat: 'saldo_favor', label: 'Bonificación / saldo a favor', owner: 'Compras' },
] as const;

/** Ajustes que NO son margen: algo salió mal en la operación. Se muestran aparte. */
const OPERATIONAL_CATS = ['faltante', 'mal_estado', 'no_solicitado', 'devolucion_otra', 'diferencia_monto', 'cambiada'];
/** Ni esto: es error de captura. Meterlo al margen lo inflaría. */
const ERROR_CATS = ['factura_duplicada'];

/** Columnas ordenables. Whitelist: `sort` viene del query string y va a orderByRaw. */
const SORT_SQL: Record<string, string> = {
  revenue: 'revenue',
  cost: 'cost',
  margin_amount: 'margin_amount',
  margin_pct: 'margin_pct',
  units: 'units',
  skus: 'skus',
  gap_pp: 'margin_pct',
  gap_amount: 'gap_amount',
  inventory_value: 'inventory_value',
  name: 'name',
  margin_unit: 'margin_unit',
};

/** Columnas que sólo existen a nivel producto: ordenar por ellas en un agregado reventaría el SQL. */
const SKU_ONLY_SORT = new Set(['margin_unit']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BreakdownOpts {
  window?: MarginWindow;
  level?: MarginLevel;
  target?: number;
  search?: string;
  band?: MarginBand;
  supplierId?: string;
  brandId?: string;
  categoryId?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

@Injectable()
export class CommercialProfitabilityService {
  constructor(private readonly tk: TenantKnexService) {}

  private win(w?: MarginWindow) {
    return WINDOWS[w as MarginWindow] ?? WINDOWS['30d'];
  }

  private target(t?: number) {
    const n = Number(t);
    return Number.isFinite(n) && n > 0 && n < 100 ? n : 15;
  }

  /**
   * Venta y costo del periodo, agregados por producto desde el fact.
   * `revenue_costed` (la venta que SÍ trae costo) es el denominador honesto del
   * margen: usar la venta total mezclaría renglones que no se pueden juzgar.
   */
  private salesAgg(trx: any, days: number) {
    return trx.raw(`(
      SELECT sd.product_id,
             SUM(sd.revenue)                                    AS revenue,
             SUM(sd.revenue) FILTER (WHERE sd.cost IS NOT NULL) AS revenue_costed,
             SUM(sd.cost)                                       AS cost,
             SUM(sd.units)                                      AS units,
             SUM(sd.units)   FILTER (WHERE sd.cost IS NOT NULL) AS units_costed,
             -- 'piece' | 'weight': lo que permite rotular "por unidad" vs "por kilo"
             -- sin inventar la unidad. catalog.products.unit_sale miente en 5,906
             -- de 8,708 productos, así que NO se usa para esto.
             MAX(sd.unit_kind)                                  AS unit_kind
        FROM analytics.sales_daily sd
       WHERE sd.tenant_id = public.current_tenant_id()
         AND sd.sale_date >= CURRENT_DATE - INTERVAL '${days} days'
       GROUP BY sd.product_id
    ) AS s`);
  }

  /** Base común: venta+costo del fact ⋈ producto. `catalog.products` va por RLS forzado. */
  private baseSql(trx: any, days: number) {
    return trx
      .from(this.salesAgg(trx, days))
      .join({ p: 'catalog.products' }, 'p.id', 's.product_id')
      .whereNull('p.deleted_at')
      .whereRaw('s.revenue > 0');
  }

  /** Margen del periodo: sobre la venta con costo, nunca sobre la venta total. */
  private static readonly MARGIN = '(s.revenue_costed - s.cost)';
  private static readonly MARGIN_PCT = `((s.revenue_costed - s.cost) / NULLIF(s.revenue_costed, 0) * 100)`;

  /**
   * `cost_base` contra el costo que cobró el PdV. Fuera de banda = el catálogo
   * está en otra unidad; se marca y se suprime el GMROI de esa fila en vez de
   * publicar un número que no resiste revisión.
   */
  private static readonly COST_CONFLICT = `(
    p.cost_base > 0 AND s.units_costed > 0 AND s.cost > 0 AND (
      p.cost_base / NULLIF(s.cost / NULLIF(s.units_costed, 0), 0) >= ${COST_CONFLICT_RATIO} OR
      p.cost_base / NULLIF(s.cost / NULLIF(s.units_costed, 0), 0) <= ${1 / COST_CONFLICT_RATIO}
    ))`;

  /** `CASE` que asigna banda. Se genera de `marginBands()` — un solo origen. */
  private bandCase(target: number) {
    const m = CommercialProfitabilityService.MARGIN_PCT;
    const cuts = marginBands(target)
      .filter((b) => b.to !== null)
      .map((b) => `WHEN ${m} < ${b.to} THEN '${b.key}'`)
      .join('\n      ');
    return `CASE\n      ${cuts}\n      ELSE 'alto' END`;
  }

  /**
   * El margen más simple y el más útil en el mostrador: **cuánto se gana en UNA
   * unidad vendida.** Sale del mismo fact, así que precio y costo se miden sobre
   * la misma cantidad y en la misma unidad — no hay nada que normalizar.
   *
   * `unit_kind` es lo único que se puede rotular sin inventar: `weight` se cobra
   * por kilo y `piece` por la unidad en que factura el PdV (paquete o pieza según
   * el SKU). `catalog.products.unit_sale` NO sirve para esto: dice `PZA` donde
   * Kepler dice `PAQ` en 5,906 de 8,708 productos.
   *
   * Sólo aplica a nivel producto: promediar el precio de un paquete con el de un
   * kilo no significa nada. En los agregados devuelve nulos a propósito.
   */
  private unitMargin(r: any) {
    const price = r.price_unit == null ? null : Number(r.price_unit);
    const cost = r.cost_unit == null ? null : Number(r.cost_unit);
    const bf = r.box_factor == null ? null : Number(r.box_factor);
    const marginUnit = price !== null && cost !== null ? price - cost : null;
    // La equivalencia por caja sólo se publica con el factor canónico limpio: en
    // granel `c84` son kilos por bulto y la "caja" sería una mentira impresa.
    const showBox = bf !== null && bf > 1 && r.box_factor_suspect !== true;
    return {
      unit_kind: (r.unit_kind ?? null) as 'piece' | 'weight' | null,
      price_unit: price,
      cost_unit: cost,
      /** Lo que deja UNA unidad vendida. */
      margin_unit: marginUnit,
      margin_unit_pct: marginUnit !== null && price ? (marginUnit / price) * 100 : null,
      box_factor: showBox ? bf : null,
      /** Lo que deja una caja completa, cuando la equivalencia es confiable. */
      margin_box: showBox && marginUnit !== null ? marginUnit * bf : null,
    };
  }

  /**
   * Ajustes del periodo agrupados por categoría, con el detalle de sus palancas.
   *
   * Devuelve además `source_empty`: la fuente no tiene NI UNA fila para el tenant.
   * Sin ese dato la pantalla dibujaba una cascada de ceros indistinguible de
   * "este mes no hubo descuentos", cuando en realidad el feed no está cargado.
   */
  private async adjustmentsByCategory(trx: any, days: number, supplierCode?: string) {
    let q = trx('analytics.erp_purchase_adjustments')
      .whereRaw('tenant_id = public.current_tenant_id()')
      .whereRaw(`adjustment_date >= CURRENT_DATE - INTERVAL '${days} days'`);
    if (supplierCode) q = q.where('proveedor_code', supplierCode);
    const rows = await q
      .select('categoria', trx.raw('COALESCE(SUM(monto), 0)::numeric AS monto'), trx.raw('COUNT(*)::int AS docs'))
      .groupBy('categoria');
    const byCat = new Map<string, { monto: number; docs: number }>(
      rows.map((r: any) => [r.categoria ?? 'sin_motivo', { monto: Number(r.monto) || 0, docs: Number(r.docs) || 0 }]),
    );
    const [any] = await trx('analytics.erp_purchase_adjustments')
      .whereRaw('tenant_id = public.current_tenant_id()')
      .limit(1)
      .select(trx.raw('1 AS ok'));
    return {
      amount: (cat: string) => byCat.get(cat)?.monto ?? 0,
      docs: (cat: string) => byCat.get(cat)?.docs ?? 0,
      source_empty: !any,
    };
  }

  /**
   * Hasta qué día llega el fact. La cascada mezcla ventanas si no se dice.
   * Se castea a `text` en SQL: `pg` convierte un `date` a `Date` de JS y
   * `String(...)` daría "Wed Aug 26 2026 …" en vez de la fecha.
   */
  private async dataAsOf(trx: any) {
    const [r] = await trx('analytics.sales_daily')
      .whereRaw('tenant_id = public.current_tenant_id()')
      .select(trx.raw('MAX(sale_date)::date::text AS d'));
    return r?.d ?? null;
  }

  /**
   * Compras del periodo. Es la BASE de los descuentos de proveedor: un descuento
   * se gana sobre lo que se COMPRA, no sobre lo que se vende. Sin esto, sumar el
   * monto del descuento como puntos sobre la venta da un margen imposible
   * (se midio: bruto 20.5% -> "negociado" 32.4%).
   * Excluye las copias CEDIS ya marcadas (`dup_of_folio`) para no contar doble.
   */
  private async purchases(trx: any, days: number, supplierCode?: string) {
    let q = trx('analytics.erp_goods_receipts')
      .whereRaw('tenant_id = public.current_tenant_id()')
      .whereRaw(`receipt_date >= CURRENT_DATE - INTERVAL '${days} days'`)
      .whereNull('dup_of_folio');
    if (supplierCode) q = q.where('proveedor_code', supplierCode);
    const [r] = await q.select(trx.raw('COALESCE(SUM(monto), 0)::numeric AS monto'));
    return Number(r?.monto) || 0;
  }

  /** Descuento efectivamente tomado al pagar (`c84`) en la ventana. */
  private async payDiscount(trx: any, days: number, supplierCode?: string) {
    let q = trx('analytics.erp_supplier_payments')
      .whereRaw('tenant_id = public.current_tenant_id()')
      .whereRaw(`pago_date >= CURRENT_DATE - INTERVAL '${days} days'`);
    if (supplierCode) q = q.where('proveedor_code', supplierCode);
    const [r] = await q.select(
      trx.raw('COALESCE(SUM(descuento), 0)::numeric AS descuento'),
      trx.raw('COUNT(*) FILTER (WHERE descuento > 0)::int AS con_descuento'),
      trx.raw('COUNT(*)::int AS pagos'),
    );
    return {
      amount: Number(r?.descuento) || 0,
      con_descuento: Number(r?.con_descuento) || 0,
      pagos: Number(r?.pagos) || 0,
    };
  }

  /**
   * Convierte cada palanca a su EFECTO EN MARGEN.
   *
   * Un descuento de proveedor se gana sobre la COMPRA; el margen se mide sobre la
   * VENTA. Sumar el monto crudo como puntos de venta da un numero imposible.
   * La traduccion honesta es una tasa: `tasa = descuento / compras` y el efecto
   * en margen es `COGS x tasa` — solo la parte de esa compra que ya se vendio.
   */
  private buildLevers(
    adj: { amount: (c: string) => number; docs: (c: string) => number },
    pay: { amount: number; con_descuento: number },
    purchases: number,
    cogs: number,
    revenue: number,
  ) {
    const effect = (amount: number) => (purchases > 0 ? cogs * (amount / purchases) : 0);
    const pp = (amount: number) => (revenue > 0 ? (effect(amount) / revenue) * 100 : null);
    const one = (key: string, label: string, owner: string, source: string, amount: number, docs: number) => ({
      key,
      label,
      owner,
      source,
      /** Lo negociado en bruto, sobre compras. */
      amount,
      docs,
      /** Tasa sobre compras: lo comparable entre proveedores. */
      rate: purchases > 0 ? (amount / purchases) * 100 : null,
      /** Lo que de eso ya se convirtio en margen (parte vendida). */
      margin_effect: effect(amount),
      pp: pp(amount),
    });

    const levers = [
      ...LEVER_CATS.map((l) => one(l.cat, l.label, l.owner, `erp_purchase_adjustments.categoria = '${l.cat}'`, adj.amount(l.cat), adj.docs(l.cat))),
      one('descuento_pago', 'Descuento tomado al pagar', 'Compras + Finanzas', 'erp_supplier_payments.descuento (c84)', pay.amount, pay.con_descuento),
    ];
    const commercialTotal = levers.reduce((a, l) => a + l.amount, 0);
    const marginEffectTotal = levers.reduce((a, l) => a + l.margin_effect, 0);
    return { levers, commercialTotal, marginEffectTotal };
  }

  /** Resumen: la respuesta a "dónde estamos" antes de cualquier drill-down. */
  async overview(opts: { window?: MarginWindow; target?: number } = {}) {
    const w = this.win(opts.window);
    const target = this.target(opts.target);

    return this.tk.run(async (trx) => {
      const [tot] = await this.baseSql(trx, w.days).select(
        trx.raw('COALESCE(SUM(s.revenue), 0)::numeric AS revenue_all'),
        trx.raw('COALESCE(SUM(s.revenue_costed), 0)::numeric AS revenue'),
        trx.raw('COALESCE(SUM(s.cost), 0)::numeric AS cost'),
        trx.raw('COALESCE(SUM(s.units), 0)::numeric AS units'),
        trx.raw('COUNT(*)::int AS skus_all'),
        trx.raw('COUNT(*) FILTER (WHERE s.revenue_costed > 0)::int AS skus'),
      );

      const revenue = Number(tot.revenue) || 0;
      const cost = Number(tot.cost) || 0;
      const revenueAll = Number(tot.revenue_all) || 0;
      const marginAmount = revenue - cost;
      const marginPct = revenue > 0 ? (marginAmount / revenue) * 100 : null;

      // Canales que alimentan la ventana: la otra mitad de "sobre qué medimos".
      const channels = await trx('analytics.sales_daily')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereRaw(`sale_date >= CURRENT_DATE - INTERVAL '${w.days} days'`)
        .groupBy('channel')
        .orderByRaw('2 DESC')
        .select('channel', trx.raw('COALESCE(SUM(revenue), 0)::numeric AS revenue'));

      const bandRows = await this.baseSql(trx, w.days)
        .whereRaw('s.revenue_costed > 0')
        .select(
          trx.raw(`${this.bandCase(target)} AS band`),
          trx.raw('COUNT(*)::int AS skus'),
          trx.raw('COALESCE(SUM(s.revenue), 0)::numeric AS revenue'),
          trx.raw(`COALESCE(SUM(${CommercialProfitabilityService.MARGIN}), 0)::numeric AS margin_amount`),
        )
        .groupByRaw('1');

      const byBand = new Map(bandRows.map((r: any) => [r.band, r]));
      const bands = marginBands(target).map((b) => {
        const r: any = byBand.get(b.key);
        return {
          key: b.key,
          label: b.label,
          tone: b.tone,
          skus: r ? Number(r.skus) : 0,
          revenue: r ? Number(r.revenue) : 0,
          margin_amount: r ? Number(r.margin_amount) : 0,
        };
      });

      // ── Palancas globales: la cascada completa, no solo el bruto ──────────
      const adj = await this.adjustmentsByCategory(trx, w.days);
      const pay = await this.payDiscount(trx, w.days);

      const purchases = await this.purchases(trx, w.days, undefined);
      const { levers, commercialTotal, marginEffectTotal } = this.buildLevers(adj, pay, purchases, cost, revenue);
      const negotiatedAmount = marginAmount + marginEffectTotal;
      const negotiatedPct = revenue > 0 ? (negotiatedAmount / revenue) * 100 : null;

      /**
       * Inventario valuado a `cost_base` — la regla canónica del proyecto para
       * valuación/ABC/capital parado. Se parte en tres para que el KPI y la
       * columna de la tabla CUADREN: la tabla sólo ve productos con venta en la
       * ventana, así que el stock muerto se reporta aparte en vez de aparecer
       * como un descuadre de $23M contra la suma de los renglones.
       * `unverified` = valuado con un costo que contradice al del PdV.
       */
      const [inv] = await trx
        .from({ st: 'commercial.stock' })
        .join({ p: 'catalog.products' }, function (this: any) {
          this.on('p.id', '=', 'st.product_id').andOn('p.tenant_id', '=', 'st.tenant_id');
        })
        .leftJoin(this.salesAgg(trx, w.days), 's.product_id', 'p.id')
        .whereNull('p.deleted_at')
        .where('p.cost_base', '>', 0)
        .select(
          trx.raw('COALESCE(SUM(st.quantity * p.cost_base), 0)::numeric AS total'),
          trx.raw(`COALESCE(SUM(st.quantity * p.cost_base) FILTER (WHERE s.revenue > 0), 0)::numeric AS in_scope`),
          trx.raw(`COALESCE(SUM(st.quantity * p.cost_base) FILTER (WHERE s.revenue IS NULL OR s.revenue <= 0), 0)::numeric AS no_sales`),
          trx.raw(`COALESCE(SUM(st.quantity * p.cost_base) FILTER (WHERE ${CommercialProfitabilityService.COST_CONFLICT}), 0)::numeric AS unverified`),
        );

      const inventoryValue = Number(inv?.total) || 0;
      const dailyCost = w.days > 0 ? cost / w.days : 0;

      // Calidad del costo de catálogo: cuánta venta se apoya en un costo que
      // contradice al del PdV. No corrige el catálogo — lo hace visible.
      const [cq] = await this.baseSql(trx, w.days).select(
        trx.raw(`COUNT(*) FILTER (WHERE ${CommercialProfitabilityService.COST_CONFLICT})::int AS skus`),
        trx.raw(`COALESCE(SUM(s.revenue) FILTER (WHERE ${CommercialProfitabilityService.COST_CONFLICT}), 0)::numeric AS revenue`),
      );

      const [promo] = await trx('analytics.erp_promotions')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereRaw('valid_from <= CURRENT_DATE AND valid_to >= CURRENT_DATE')
        .select(
          trx.raw('COUNT(DISTINCT product_id)::int AS skus'),
          trx.raw('AVG(benefit)::numeric AS avg_benefit'),
        );

      const asOf = await this.dataAsOf(trx);

      return {
        window: opts.window ?? '30d',
        target,
        revenue,
        cost,
        margin_amount: marginAmount,
        margin_pct: marginPct,
        /** Margen tras incorporar las palancas negociadas con el proveedor. */
        margin_negotiated_amount: negotiatedAmount,
        margin_negotiated_pct: negotiatedPct,
        gap_pp: marginPct === null ? null : marginPct - target,
        gap_amount: marginPct === null ? null : revenue * (target / 100) - marginAmount,
        /** Brecha que queda DESPUÉS de las palancas: lo que de verdad falta resolver. */
        gap_pp_negotiated: negotiatedPct === null ? null : negotiatedPct - target,
        units: Number(tot.units) || 0,
        skus: Number(tot.skus) || 0,
        /** Hasta qué día llega el fact. Compras/pagos/promos usan CURRENT_DATE. */
        data_as_of: asOf,
        inventory_value: inventoryValue,
        inventory_days: dailyCost > 0 ? inventoryValue / dailyCost : null,
        /** Desglose que hace cuadrar el KPI con la suma de la tabla. */
        inventory: {
          total: inventoryValue,
          in_scope: Number(inv?.in_scope) || 0,
          no_sales: Number(inv?.no_sales) || 0,
          unverified: Number(inv?.unverified) || 0,
        },
        /** Costo de catálogo que contradice al del PdV: no se valúa a ciegas. */
        cost_quality: {
          conflict_skus: Number(cq?.skus) || 0,
          conflict_revenue: Number(cq?.revenue) || 0,
          note: 'El costo de catálogo de estos SKUs está en otra unidad que la venta (caja vs pieza). El margen sale del costo del PdV; el inventario de estos SKUs no es confiable.',
        },
        bands,
        levers,
        /** La fuente de ajustes no tiene una sola fila: la cascada no es cero, es ciega. */
        levers_source_empty: adj.source_empty,
        /** Base de los descuentos: lo que se compro en la ventana. */
        purchases,
        /** Lo negociado en bruto vs lo que de eso ya es margen (parte vendida). */
        levers_amount_total: commercialTotal,
        levers_margin_effect: marginEffectTotal,
        non_margin: {
          operacional: {
            amount: OPERATIONAL_CATS.reduce((a, c) => a + adj.amount(c), 0),
            docs: OPERATIONAL_CATS.reduce((a, c) => a + adj.docs(c), 0),
            note: 'Fallas de servicio del proveedor (faltante, mal estado, devolución). No es margen.',
          },
          error_captura: {
            amount: ERROR_CATS.reduce((a, c) => a + adj.amount(c), 0),
            docs: ERROR_CATS.reduce((a, c) => a + adj.docs(c), 0),
            note: 'Facturas duplicadas. No es margen: es un error a corregir en /compras/descuentos.',
          },
        },
        promotions: {
          skus_con_promo: Number(promo?.skus) || 0,
          /**
           * `benefit` sólo toma 4 valores enteros (2,3,4,5) en las 793 filas
           * vivas: no se ha confirmado que sea un %. Se publica como valor crudo
           * y la UI lo rotula "sin confirmar" en vez de imprimir "−4.0%".
           */
          avg_benefit: promo?.avg_benefit == null ? null : Number(promo.avg_benefit),
          benefit_unit: 'unconfirmed' as const,
        },
        coverage: {
          revenue_with_cost: revenue,
          revenue_total: revenueAll,
          revenue_pct: revenueAll > 0 ? (revenue / revenueAll) * 100 : null,
          /** Canales que alimentan la ventana: sobre qué universo se mide. */
          channels: channels.map((c: any) => ({ channel: c.channel, revenue: Number(c.revenue) || 0 })),
          skus_with_cost: Number(tot.skus) || 0,
          skus_total: Number(tot.skus_all) || 0,
        },
      };
    });
  }

  /**
   * Desglose por nivel. Mismo cálculo en los cuatro: si el total de proveedor no
   * cuadra con la suma de sus SKUs, el tablero pierde credibilidad a la primera
   * revisión.
   */
  async breakdown(opts: BreakdownOpts = {}) {
    const w = this.win(opts.window);
    const target = this.target(opts.target);
    // Default SKU: el producto es la unidad que se mira, los agregados son el resumen.
    const level: MarginLevel = (['supplier', 'brand', 'category', 'sku'] as const).includes(
      opts.level as MarginLevel,
    )
      ? (opts.level as MarginLevel)
      : 'sku';

    for (const [k, v] of Object.entries({
      supplier_id: opts.supplierId,
      brand_id: opts.brandId,
      category_id: opts.categoryId,
    })) {
      if (v && !UUID_REGEX.test(v)) throw new BadRequestException(`${k} inválido`);
    }

    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(opts.pageSize) || 50));
    const search = (opts.search || '').trim();

    const DIM: Record<MarginLevel, { id: string; name: string }> = {
      supplier: { id: 'sup.id', name: 'sup.name' },
      brand: { id: 'b.id', name: 'b.nombre' },
      category: { id: 'cat.id', name: 'cat.name' },
      sku: { id: 'p.id', name: 'p.nombre' },
    };

    return this.tk.run(async (trx) => {
      const build = () => {
        let q = this.baseSql(trx, w.days)
          .leftJoin({ sup: 'catalog.suppliers' }, function (this: any) {
            this.on('sup.id', '=', 'p.supplier_id').andOn('sup.tenant_id', '=', 'p.tenant_id');
          })
          .leftJoin({ b: 'catalog.brands' }, function (this: any) {
            this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
          })
          .leftJoin({ cat: 'catalog.categories' }, function (this: any) {
            this.on('cat.id', '=', 'p.category_id').andOn('cat.tenant_id', '=', 'p.tenant_id');
          })
          // Pre-agregados como tablas derivadas, NO subconsultas por fila.
          // Medido en prod a nivel SKU: 53,507 ms -> 403 ms (99% menos). Una
          // subconsulta correlacionada se ejecuta una vez POR PRODUCTO.
          .leftJoin(
            trx.raw(
              `(SELECT product_id, SUM(quantity) AS qty FROM commercial.stock
                 WHERE tenant_id = public.current_tenant_id() GROUP BY product_id) AS stk`,
            ),
            'stk.product_id',
            'p.id',
          )
          .leftJoin(
            trx.raw(
              `(SELECT product_id, MAX(benefit) AS benefit FROM analytics.erp_promotions
                 WHERE tenant_id = public.current_tenant_id()
                   AND valid_from <= CURRENT_DATE AND valid_to >= CURRENT_DATE
                 GROUP BY product_id) AS promo`,
            ),
            'promo.product_id',
            'p.id',
          )
          // `product_sales_stats` ya sólo aporta la clase ABC; venta y costo
          // salen del fact.
          .leftJoin(
            trx.raw(
              `(SELECT product_id, abc_class FROM analytics.product_sales_stats
                 WHERE tenant_id = public.current_tenant_id()) AS abc`,
            ),
            'abc.product_id',
            'p.id',
          )
          // Factor de caja CANÓNICO. Nunca derivarlo acá: `is_master_suspect`
          // marca los que un humano tiene que revisar (granel donde c84 son kilos).
          .leftJoin({ bf: 'analytics.v_product_box_factor' }, function (this: any) {
            this.on('bf.product_id', '=', 'p.id').andOn('bf.tenant_id', '=', 'p.tenant_id');
          });
        // Sin filtro por `cost_base`: el costo ya no sale del catálogo. Filtrarlo
        // aquí dejaba al desglose midiendo un universo distinto al del resumen.

        if (opts.supplierId) q = q.where('p.supplier_id', opts.supplierId);
        if (opts.brandId) q = q.where('p.brand_id', opts.brandId);
        if (opts.categoryId) q = q.where('p.category_id', opts.categoryId);
        if (opts.band) q = q.whereRaw(`${this.bandCase(target)} = ?`, [opts.band]);
        if (search) {
          const t = `%${search}%`;
          q = q.where((bq: any) =>
            bq
              .where('p.nombre', 'ilike', t)
              .orWhere('p.sku', 'ilike', t)
              .orWhere('b.nombre', 'ilike', t)
              .orWhere('sup.name', 'ilike', t)
              .orWhere('cat.name', 'ilike', t),
          );
        }
        return q;
      };

      const dim = DIM[level];
      const grouped = () =>
        build()
          .select(
            trx.raw(`${dim.id} AS id`),
            trx.raw(`COALESCE(${dim.name}, '(sin asignar)') AS name`),
            trx.raw('COALESCE(SUM(s.revenue), 0)::numeric AS revenue'),
            trx.raw('COALESCE(SUM(s.revenue_costed), 0)::numeric AS revenue_costed'),
            trx.raw('COALESCE(SUM(s.cost), 0)::numeric AS cost'),
            trx.raw(`COALESCE(SUM(${CommercialProfitabilityService.MARGIN}), 0)::numeric AS margin_amount`),
            trx.raw(
              `(SUM(${CommercialProfitabilityService.MARGIN}) / NULLIF(SUM(s.revenue_costed), 0) * 100)::numeric AS margin_pct`,
            ),
            trx.raw(
              `(SUM(s.revenue_costed) * ${target / 100} - SUM(${CommercialProfitabilityService.MARGIN}))::numeric AS gap_amount`,
            ),
            trx.raw('COALESCE(SUM(s.units), 0)::numeric AS units'),
            trx.raw('COUNT(*)::int AS skus'),
            trx.raw('COALESCE(SUM(stk.qty * p.cost_base), 0)::numeric AS inventory_value'),
            // Cuántos SKUs del renglón valúan con un costo que el PdV contradice.
            trx.raw(`COUNT(*) FILTER (WHERE ${CommercialProfitabilityService.COST_CONFLICT})::int AS cost_conflict_skus`),
            // Promoción vigente del SKU. Valor CRUDO: la unidad no está confirmada.
            trx.raw('MAX(promo.benefit)::numeric AS promo_benefit'),
            ...(level === 'sku'
              ? [
                  'p.sku as sku',
                  trx.raw('MAX(b.nombre) AS brand_name'),
                  trx.raw('MAX(sup.name) AS supplier_name'),
                  trx.raw('MAX(abc.abc_class) AS abc_class'),
                  // ── Margen UNITARIO: cuánto se le gana a una unidad vendida ──
                  // Sólo tiene sentido a nivel producto: promediar el precio de un
                  // paquete con el de un kilo no significa nada.
                  trx.raw('MAX(s.unit_kind) AS unit_kind'),
                  // Precio y costo sobre el MISMO denominador (la venta con
                  // costo). Si el precio se midiera sobre todas las unidades, el
                  // % unitario no cuadraría con el % de la fila: dos porcentajes
                  // distintos del mismo renglón matan la confianza en la tabla.
                  trx.raw('(SUM(s.revenue_costed) / NULLIF(SUM(s.units_costed), 0))::numeric AS price_unit'),
                  trx.raw('(SUM(s.cost) / NULLIF(SUM(s.units_costed), 0))::numeric AS cost_unit'),
                  trx.raw(
                    `(SUM(${CommercialProfitabilityService.MARGIN}) / NULLIF(SUM(s.units_costed), 0))::numeric AS margin_unit`,
                  ),
                  trx.raw('MAX(bf.box_factor)::numeric AS box_factor'),
                  trx.raw('bool_or(bf.is_master_suspect) AS box_factor_suspect'),
                ]
              : []),
          )
          .groupByRaw(level === 'sku' ? `${dim.id}, ${dim.name}, p.sku` : `${dim.id}, ${dim.name}`);

      const sortKey = opts.sort ?? '';
      const sortExpr =
        SKU_ONLY_SORT.has(sortKey) && level !== 'sku' ? 'revenue' : SORT_SQL[sortKey] ?? 'revenue';
      const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';

      const rows = await grouped()
        .orderByRaw(`${sortExpr} ${dir} NULLS LAST, name ASC`)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [{ total }] = await trx.from(grouped().as('g')).count<{ total: string }[]>('* as total');

      const [sum] = await build().select(
        trx.raw('COALESCE(SUM(s.revenue), 0)::numeric AS revenue'),
        trx.raw('COALESCE(SUM(s.revenue_costed), 0)::numeric AS revenue_costed'),
        trx.raw(`COALESCE(SUM(${CommercialProfitabilityService.MARGIN}), 0)::numeric AS margin_amount`),
        trx.raw('COALESCE(SUM(stk.qty * p.cost_base), 0)::numeric AS inventory_value'),
      );
      const sumRev = Number(sum?.revenue) || 0;
      const sumRevCosted = Number(sum?.revenue_costed) || 0;
      const sumMargin = Number(sum?.margin_amount) || 0;

      return {
        level,
        window: opts.window ?? '30d',
        target,
        data: rows.map((r: any) => {
          const marginPct = r.margin_pct === null ? null : Number(r.margin_pct);
          const revenue = Number(r.revenue) || 0;
          const revenueCosted = Number(r.revenue_costed) || 0;
          const marginAmount = Number(r.margin_amount) || 0;
          const invValue = Number(r.inventory_value) || 0;
          const dailyCost = w.days > 0 ? Number(r.cost) / w.days : 0;
          const conflictSkus = Number(r.cost_conflict_skus) || 0;
          return {
            id: r.id,
            name: r.name,
            sku: r.sku ?? null,
            brand_name: r.brand_name ?? null,
            supplier_name: r.supplier_name ?? null,
            abc_class: r.abc_class ?? null,
            revenue,
            /** La parte de la venta que trae costo: el denominador del margen. */
            revenue_costed: revenueCosted,
            coverage_pct: revenue > 0 ? (revenueCosted / revenue) * 100 : null,
            cost: Number(r.cost) || 0,
            margin_amount: marginAmount,
            margin_pct: marginPct,
            gap_pp: marginPct === null ? null : marginPct - target,
            /** Pesos que faltaron para el objetivo. Ordena por tamaño del problema, no por %. */
            gap_amount: r.gap_amount === null ? null : Number(r.gap_amount),
            units: Number(r.units) || 0,
            skus: Number(r.skus) || 0,
            inventory_value: invValue,
            inventory_days: dailyCost > 0 ? invValue / dailyCost : null,
            /**
             * Inventario y GMROI se valúan con `cost_base`. Si ese costo
             * contradice al del PdV, la valuación no es confiable: se marca y el
             * GMROI se suprime en vez de imprimir un número inventado.
             */
            cost_conflict_skus: conflictSkus,
            /** Margen × rotación: la contribución que de verdad genera al año. */
            annual_contribution: w.days > 0 ? (marginAmount / w.days) * 365 : null,
            gmroi:
              invValue > 0 && w.days > 0 && conflictSkus === 0
                ? ((marginAmount / w.days) * 365) / invValue
                : null,
            /** Beneficio de promoción vigente, CRUDO. Unidad sin confirmar. */
            promo_benefit: r.promo_benefit == null ? null : Number(r.promo_benefit),
            ...this.unitMargin(r),
          };
        }),
        totals: {
          revenue: sumRev,
          revenue_costed: sumRevCosted,
          margin_amount: sumMargin,
          margin_pct: sumRevCosted > 0 ? (sumMargin / sumRevCosted) * 100 : null,
          gap_amount: sumRevCosted > 0 ? sumRevCosted * (target / 100) - sumMargin : null,
          /** Cuadra contra `overview.inventory.in_scope` cuando no hay filtros. */
          inventory_value: Number(sum?.inventory_value) || 0,
        },
        pagination: {
          page,
          pageSize,
          total: Number(total) || 0,
          pageCount: Math.ceil((Number(total) || 0) / pageSize) || 0,
        },
      };
    });
  }

  /**
   * Palancas negociadas de un proveedor, separadas por CATEGORÍA real.
   *
   * Se separan tres cosas que sumadas a ciegas dan un número falso:
   *   comercial      → sube el margen negociado
   *   operacional    → no es margen, es una falla de servicio del proveedor
   *   error captura  → no es margen, es una factura duplicada
   */
  async supplierLevers(supplierId: string, opts: { window?: MarginWindow; target?: number } = {}) {
    if (!UUID_REGEX.test(supplierId)) throw new BadRequestException('supplier_id inválido');
    const w = this.win(opts.window);
    const target = this.target(opts.target);

    return this.tk.run(async (trx) => {
      const sup = await trx('catalog.suppliers')
        .where({ id: supplierId })
        .first('id', 'code', 'name', 'credit_days', 'lead_time_days', 'min_order_boxes');
      if (!sup) throw new BadRequestException('proveedor no encontrado');

      const [base] = await this.baseSql(trx, w.days)
        .where('p.supplier_id', supplierId)
        .select(
          trx.raw('COALESCE(SUM(s.revenue), 0)::numeric AS revenue_all'),
          trx.raw('COALESCE(SUM(s.revenue_costed), 0)::numeric AS revenue'),
          trx.raw('COALESCE(SUM(s.cost), 0)::numeric AS cost'),
          trx.raw(`COALESCE(SUM(${CommercialProfitabilityService.MARGIN}), 0)::numeric AS margin_amount`),
          trx.raw('COUNT(*)::int AS skus'),
        );

      const revenue = Number(base?.revenue) || 0;
      const marginAmount = Number(base?.margin_amount) || 0;
      const marginPct = revenue > 0 ? (marginAmount / revenue) * 100 : null;
      const adj = await this.adjustmentsByCategory(trx, w.days, sup.code);
      const pay = await this.payDiscount(trx, w.days, sup.code);

      const purchases = await this.purchases(trx, w.days, sup.code);
      const { levers, commercialTotal, marginEffectTotal } = this.buildLevers(
        adj, pay, purchases, Number(base?.cost) || 0, revenue,
      );
      const negotiatedAmount = marginAmount + marginEffectTotal;

      const policy = await trx('commercial.supplier_discount_policy')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .where('proveedor_code', sup.code)
        .first('expected_discount_rate', 'discount_days', 'discount_type', 'source');

      const [promo] = await trx
        .from({ e: 'analytics.erp_promotions' })
        .join({ p: 'catalog.products' }, function (this: any) {
          this.on('p.id', '=', 'e.product_id').andOn('p.tenant_id', '=', 'e.tenant_id');
        })
        .whereRaw('e.tenant_id = public.current_tenant_id()')
        .where('p.supplier_id', supplierId)
        .whereRaw('e.valid_from <= CURRENT_DATE AND e.valid_to >= CURRENT_DATE')
        .select(
          trx.raw('COUNT(DISTINCT e.product_id)::int AS skus'),
          trx.raw('AVG(e.benefit)::numeric AS avg_benefit'),
          trx.raw('MAX(e.benefit)::numeric AS max_benefit'),
        );

      return {
        supplier: {
          id: sup.id,
          code: sup.code,
          name: sup.name,
          credit_days: sup.credit_days,
          lead_time_days: sup.lead_time_days,
        },
        window: opts.window ?? '30d',
        target,
        revenue,
        skus: Number(base?.skus) || 0,
        margin_gross_amount: marginAmount,
        margin_gross_pct: marginPct,
        margin_negotiated_amount: negotiatedAmount,
        margin_negotiated_pct: revenue > 0 ? (negotiatedAmount / revenue) * 100 : null,
        gap_pp: marginPct === null ? null : marginPct - target,
        purchases,
        levers,
        levers_amount_total: commercialTotal,
        levers_margin_effect: marginEffectTotal,
        non_margin: {
          operacional: {
            amount: OPERATIONAL_CATS.reduce((a, c) => a + adj.amount(c), 0),
            docs: OPERATIONAL_CATS.reduce((a, c) => a + adj.docs(c), 0),
            note: 'Fallas de servicio del proveedor (faltante, mal estado, devolución). No es margen.',
          },
          error_captura: {
            amount: ERROR_CATS.reduce((a, c) => a + adj.amount(c), 0),
            docs: ERROR_CATS.reduce((a, c) => a + adj.docs(c), 0),
            note: 'Facturas duplicadas. No es margen: es un error a corregir en /compras/descuentos.',
          },
        },
        /**
         * Riesgo de doble conteo: si el proveedor da pronto pago por AMBOS canales
         * (nota X-D-55 y `c84` al pagar), puede ser el MISMO descuento contado dos
         * veces. `/compras/descuentos` marca ese caso igual, como canal "ambos".
         */
        overlap_warning: adj.amount('pronto_pago') > 0 && pay.amount > 0,
        /** La fuente de ajustes está vacía: la cascada es ciega, no cero. */
        levers_source_empty: adj.source_empty,
        promotions: {
          skus_con_promo: Number(promo?.skus) || 0,
          avg_benefit: promo?.avg_benefit == null ? null : Number(promo.avg_benefit),
          max_benefit: promo?.max_benefit == null ? null : Number(promo.max_benefit),
          benefit_unit: 'unconfirmed' as const,
          note: 'Promoción vigente por SKU (kdpv_descuxq). `benefit` sólo toma los valores 2/3/4/5: la unidad NO está confirmada, no se publica como porcentaje ni se resta del margen.',
        },
        policy: policy
          ? {
              expected_discount_rate:
                policy.expected_discount_rate === null ? null : Number(policy.expected_discount_rate),
              discount_days: policy.discount_days,
              discount_type: policy.discount_type,
              source: policy.source,
              expected_amount:
                policy.expected_discount_rate === null
                  ? null
                  : (Number(base?.cost) || 0) * (Number(policy.expected_discount_rate) / 100),
              /** Lo efectivamente cobrado, para contrastar con lo pactado (fuga). */
              taken_amount: commercialTotal,
            }
          : null,
        /** Lo único que hoy no tiene fuente. Lo demás existe y ya está arriba. */
        not_attributed: [{ key: 'costo_logistico', reason: 'logistics.shipment_expenses está vacía (0 filas)' }],
      };
    });
  }
}
