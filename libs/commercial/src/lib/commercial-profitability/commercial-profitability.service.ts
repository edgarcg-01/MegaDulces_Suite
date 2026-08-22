import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Motor de Rentabilidad (Fase MR) — la cascada de margen sobre venta REAL.
 *
 * Fuente de la venta: `analytics.product_sales_stats` (sell-out consolidado de
 * Kepler/Wincaja). NO `commercial.order_lines` — esa tabla tiene 18 filas: la
 * venta de Mega Dulces no pasa por la plataforma.
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

const WINDOWS: Record<MarginWindow, { rev: string; units: string; days: number }> = {
  '30d': { rev: 'revenue_30d', units: 'units_30d', days: 30 },
  '90d': { rev: 'revenue_90d', units: 'units_90d', days: 90 },
  '365d': { rev: 'revenue_365d', units: 'units_365d', days: 365 },
};

/** Bandas de salud del margen. Disjuntas y ordenadas: cada SKU cae en una sola. */
export const MARGIN_BANDS = [
  { key: 'negativo', label: 'Bajo costo', tone: 'bad' },
  { key: 'critico', label: '0-10%', tone: 'bad' },
  { key: 'bajo', label: '10-15%', tone: 'warn' },
  { key: 'meta', label: '15-25%', tone: 'ok' },
  { key: 'alto', label: '25%+', tone: 'ok' },
] as const;

export type MarginBand = (typeof MARGIN_BANDS)[number]['key'];

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
};

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
   * Base común: venta real ⋈ costo, filtrada por tenant. Separar lo que tiene
   * costo de lo que no es lo que evita calcular el margen sobre un denominador
   * que incluye SKUs sin costo — saldría inflado.
   */
  private baseSql(trx: any, w: { rev: string; units: string }) {
    return trx
      .from({ s: 'analytics.product_sales_stats' })
      .join({ p: 'catalog.products' }, function (this: any) {
        this.on('p.id', '=', 's.product_id').andOn('p.tenant_id', '=', 's.tenant_id');
      })
      .whereRaw('s.tenant_id = public.current_tenant_id()')
      .whereNull('p.deleted_at')
      .whereRaw(`s.${w.rev} > 0`);
  }

  /** `CASE` que asigna banda. Espejo de `MARGIN_BANDS` — si cambia una, cambia el otro. */
  private bandCase(w: { rev: string; units: string }) {
    const m = `((s.${w.rev} - p.cost_base * s.${w.units}) / NULLIF(s.${w.rev}, 0) * 100)`;
    return `CASE
      WHEN ${m} < 0  THEN 'negativo'
      WHEN ${m} < 10 THEN 'critico'
      WHEN ${m} < 15 THEN 'bajo'
      WHEN ${m} < 25 THEN 'meta'
      ELSE 'alto' END`;
  }

  /** Ajustes del periodo agrupados por categoría, con el detalle de sus palancas. */
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
    return {
      amount: (cat: string) => byCat.get(cat)?.monto ?? 0,
      docs: (cat: string) => byCat.get(cat)?.docs ?? 0,
    };
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
      const [tot] = await this.baseSql(trx, w).select(
        trx.raw(`COALESCE(SUM(s.${w.rev}), 0)::numeric AS revenue_all`),
        trx.raw(`COALESCE(SUM(s.${w.rev}) FILTER (WHERE p.cost_base > 0), 0)::numeric AS revenue`),
        trx.raw(`COALESCE(SUM(p.cost_base * s.${w.units}) FILTER (WHERE p.cost_base > 0), 0)::numeric AS cost`),
        trx.raw(`COALESCE(SUM(s.${w.units}), 0)::numeric AS units`),
        trx.raw('COUNT(*)::int AS skus_all'),
        trx.raw('COUNT(*) FILTER (WHERE p.cost_base > 0)::int AS skus'),
      );

      const revenue = Number(tot.revenue) || 0;
      const cost = Number(tot.cost) || 0;
      const revenueAll = Number(tot.revenue_all) || 0;
      const marginAmount = revenue - cost;
      const marginPct = revenue > 0 ? (marginAmount / revenue) * 100 : null;

      const bandRows = await this.baseSql(trx, w)
        .where('p.cost_base', '>', 0)
        .select(
          trx.raw(`${this.bandCase(w)} AS band`),
          trx.raw('COUNT(*)::int AS skus'),
          trx.raw(`COALESCE(SUM(s.${w.rev}), 0)::numeric AS revenue`),
          trx.raw(`COALESCE(SUM(s.${w.rev} - p.cost_base * s.${w.units}), 0)::numeric AS margin_amount`),
        )
        .groupByRaw('1');

      const byBand = new Map(bandRows.map((r: any) => [r.band, r]));
      const bands = MARGIN_BANDS.map((b) => {
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

      const [inv] = await trx
        .from({ st: 'commercial.stock' })
        .join({ p: 'catalog.products' }, function (this: any) {
          this.on('p.id', '=', 'st.product_id').andOn('p.tenant_id', '=', 'st.tenant_id');
        })
        .whereNull('p.deleted_at')
        .where('p.cost_base', '>', 0)
        .select(trx.raw('COALESCE(SUM(st.quantity * p.cost_base), 0)::numeric AS inventory_value'));

      const inventoryValue = Number(inv?.inventory_value) || 0;
      const dailyCost = w.days > 0 ? cost / w.days : 0;

      const [promo] = await trx('analytics.erp_promotions')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereRaw('valid_from <= CURRENT_DATE AND valid_to >= CURRENT_DATE')
        .select(
          trx.raw('COUNT(DISTINCT product_id)::int AS skus'),
          trx.raw('AVG(benefit)::numeric AS avg_benefit'),
        );

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
        inventory_value: inventoryValue,
        inventory_days: dailyCost > 0 ? inventoryValue / dailyCost : null,
        bands,
        levers,
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
          avg_benefit_pct: promo?.avg_benefit == null ? null : Number(promo.avg_benefit),
        },
        coverage: {
          revenue_with_cost: revenue,
          revenue_total: revenueAll,
          revenue_pct: revenueAll > 0 ? (revenue / revenueAll) * 100 : null,
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
        let q = this.baseSql(trx, w)
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
          .where('p.cost_base', '>', 0);

        if (opts.supplierId) q = q.where('p.supplier_id', opts.supplierId);
        if (opts.brandId) q = q.where('p.brand_id', opts.brandId);
        if (opts.categoryId) q = q.where('p.category_id', opts.categoryId);
        if (opts.band) q = q.whereRaw(`${this.bandCase(w)} = ?`, [opts.band]);
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
            trx.raw(`COALESCE(SUM(s.${w.rev}), 0)::numeric AS revenue`),
            trx.raw(`COALESCE(SUM(p.cost_base * s.${w.units}), 0)::numeric AS cost`),
            trx.raw(`COALESCE(SUM(s.${w.rev} - p.cost_base * s.${w.units}), 0)::numeric AS margin_amount`),
            trx.raw(
              `(SUM(s.${w.rev} - p.cost_base * s.${w.units}) / NULLIF(SUM(s.${w.rev}), 0) * 100)::numeric AS margin_pct`,
            ),
            trx.raw(
              `(SUM(s.${w.rev}) * ${target / 100} - SUM(s.${w.rev} - p.cost_base * s.${w.units}))::numeric AS gap_amount`,
            ),
            trx.raw(`COALESCE(SUM(s.${w.units}), 0)::numeric AS units`),
            trx.raw('COUNT(*)::int AS skus'),
            trx.raw('COALESCE(SUM(stk.qty * p.cost_base), 0)::numeric AS inventory_value'),
            // Promoción vigente = descuento al cliente ya atribuido a SKU.
            trx.raw('MAX(promo.benefit)::numeric AS promo_pct'),
            ...(level === 'sku'
              ? [
                  'p.sku as sku',
                  trx.raw('MAX(b.nombre) AS brand_name'),
                  trx.raw('MAX(sup.name) AS supplier_name'),
                  trx.raw('MAX(s.abc_class) AS abc_class'),
                ]
              : []),
          )
          .groupByRaw(level === 'sku' ? `${dim.id}, ${dim.name}, p.sku` : `${dim.id}, ${dim.name}`);

      const sortExpr = SORT_SQL[opts.sort ?? ''] ?? 'revenue';
      const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';

      const rows = await grouped()
        .orderByRaw(`${sortExpr} ${dir} NULLS LAST, name ASC`)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [{ total }] = await trx.from(grouped().as('g')).count<{ total: string }[]>('* as total');

      const [sum] = await build().select(
        trx.raw(`COALESCE(SUM(s.${w.rev}), 0)::numeric AS revenue`),
        trx.raw(`COALESCE(SUM(s.${w.rev} - p.cost_base * s.${w.units}), 0)::numeric AS margin_amount`),
      );
      const sumRev = Number(sum?.revenue) || 0;
      const sumMargin = Number(sum?.margin_amount) || 0;

      return {
        level,
        window: opts.window ?? '30d',
        target,
        data: rows.map((r: any) => {
          const marginPct = r.margin_pct === null ? null : Number(r.margin_pct);
          const revenue = Number(r.revenue) || 0;
          const marginAmount = Number(r.margin_amount) || 0;
          const invValue = Number(r.inventory_value) || 0;
          const dailyCost = w.days > 0 ? Number(r.cost) / w.days : 0;
          return {
            id: r.id,
            name: r.name,
            sku: r.sku ?? null,
            brand_name: r.brand_name ?? null,
            supplier_name: r.supplier_name ?? null,
            abc_class: r.abc_class ?? null,
            revenue,
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
            /** Margen × rotación: la contribución que de verdad genera al año. */
            annual_contribution: w.days > 0 ? (marginAmount / w.days) * 365 : null,
            gmroi: invValue > 0 && w.days > 0 ? ((marginAmount / w.days) * 365) / invValue : null,
            promo_pct: r.promo_pct == null ? null : Number(r.promo_pct),
          };
        }),
        totals: {
          revenue: sumRev,
          margin_amount: sumMargin,
          margin_pct: sumRev > 0 ? (sumMargin / sumRev) * 100 : null,
          gap_amount: sumRev > 0 ? sumRev * (target / 100) - sumMargin : null,
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

      const [base] = await this.baseSql(trx, w)
        .where('p.supplier_id', supplierId)
        .where('p.cost_base', '>', 0)
        .select(
          trx.raw(`COALESCE(SUM(s.${w.rev}), 0)::numeric AS revenue`),
          trx.raw(`COALESCE(SUM(p.cost_base * s.${w.units}), 0)::numeric AS cost`),
          trx.raw(`COALESCE(SUM(s.${w.rev} - p.cost_base * s.${w.units}), 0)::numeric AS margin_amount`),
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
        promotions: {
          skus_con_promo: Number(promo?.skus) || 0,
          avg_benefit_pct: promo?.avg_benefit == null ? null : Number(promo.avg_benefit),
          max_benefit_pct: promo?.max_benefit == null ? null : Number(promo.max_benefit),
          note: 'Promoción vigente por SKU (kdpv_descuxq). `benefit` se lee como % — confirmar antes de restarlo del margen.',
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
