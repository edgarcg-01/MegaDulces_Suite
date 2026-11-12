/**
 * `[MKT.7]` La pestaña «Promos ERP» (`/mkt/erp-promos`) y la herramienta `thot_active_promotions`.
 *
 * ── El defecto que corrige (medido en prod, sólo lectura, 2026-11-11) ──────────────────────
 * Leían `analytics.erp_promotions`, una vista clavada en `kdpv_*.sucursal = '03'` (8 Esquinas)
 * desde FKJ (2026-08-20), con la idea de que «las promos se replican entre sucursales». Ya no:
 * la 03 tenía **0** reglas vigentes y las demás tiendas **328** (Zamora Centro 187, Morelia
 * Abastos 126, …). La pestaña decía «No hay promociones activas en el ERP» con 328 vigentes.
 *
 * La vista correcta ya existía: `analytics.v_erp_discount_rules` (`[COT.1.0]`, la del motor de
 * precio de cotizaciones) — los cuatro `kdpv_*`, todas las tiendas por `c1`, deduplicada por
 * (tienda, SKU, presentación) y SÓLO vigentes (`c7 <= hoy <= c8`). Se reusa; no se crea otra.
 *
 * ── Lo que la pantalla decía mal además ──────────────────────────────────────────────────
 * `c6` de los descuentos es un **PORCENTAJE** (verificado 113 vs 2 contra ventas en
 * `v_label_promotions`), y la pantalla lo pintaba como «$50 desc.». Ahora el renglón dice qué
 * clase de beneficio es (`benefit_kind`) y en qué presentación aplica (`unit`).
 */

/** Mecanismo de `v_erp_discount_rules` → el `promo_type` que ya hablaban la pantalla y Thot. */
export const MECANISMO_A_PROMO_TYPE: Record<string, string> = {
  descuento_cantidad: 'descuento_qty',
  gratis_cantidad: 'gratis_qty',
  descuento_monto: 'descuento_monto',
  gratis_monto: 'gratis_monto',
};

export interface ErpPromoRow {
  sku: string;
  product_name: string;
  promo_type: string;
  /** Presentación a la que aplica la regla (PAQ, CJA, PZA…): el umbral se cuenta en ella. */
  unit: string | null;
  threshold: number | null;
  /** `false` en los mecanismos por MONTO: su umbral no tiene testigo (ver `v_erp_discount_rules`). */
  threshold_verified: boolean;
  /** `pct` = porcentaje de descuento · `free_qty` = cantidad que se regala. */
  benefit_kind: 'pct' | 'free_qty';
  benefit: number | null;
  free_product_name: string | null;
  free_unit: string | null;
  valid_from: string | null;
  valid_to: string | null;
  /** Nombre de la tienda (o su código si no está en la dimensión). Se conserva el nombre del campo. */
  warehouse_code: string | null;
}

/** El SQL, aparte, para que la prueba pueda afirmar de QUÉ lee sin una base. `?` = tenant. */
export const ERP_PROMOTIONS_SQL = `
SELECT r.sku,
       COALESCE(p.nombre, r.raw_name)              AS product_name,
       r.mecanismo,
       r.unidad                                    AS unit,
       r.umbral                                    AS threshold,
       r.umbral_verificado                         AS threshold_verified,
       r.pct,
       r.free_qty,
       COALESCE(fp.nombre, r.free_sku)             AS free_product_name,
       r.free_unidad                               AS free_unit,
       r.valid_from,
       r.valid_to,
       COALESCE(w.name, r.tienda)                  AS warehouse_code
  FROM analytics.v_erp_discount_rules r
  JOIN catalog.products p
    ON p.tenant_id = ? AND btrim(p.sku) = r.sku
  LEFT JOIN catalog.products fp
    ON fp.tenant_id = p.tenant_id AND btrim(fp.sku) = r.free_sku
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id = p.tenant_id AND w.deleted_at IS NULL
   AND (w.code = r.tienda OR w.kepler_code = r.tienda)
 ORDER BY r.valid_to ASC, r.sku ASC, r.tienda ASC
 LIMIT 1000`;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const fecha = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** Renglón crudo de `ERP_PROMOTIONS_SQL` → contrato de la pantalla. Los `numeric` llegan como string. */
export function toErpPromoRow(r: Record<string, unknown>): ErpPromoRow {
  const mecanismo = String(r['mecanismo'] ?? '');
  const esGratis = mecanismo.startsWith('gratis');
  return {
    sku: String(r['sku'] ?? ''),
    product_name: String(r['product_name'] ?? ''),
    promo_type: MECANISMO_A_PROMO_TYPE[mecanismo] ?? mecanismo,
    unit: (r['unit'] as string | null) ?? null,
    threshold: num(r['threshold']),
    threshold_verified: r['threshold_verified'] === true,
    benefit_kind: esGratis ? 'free_qty' : 'pct',
    benefit: num(esGratis ? r['free_qty'] : r['pct']),
    free_product_name: esGratis ? ((r['free_product_name'] as string | null) ?? null) : null,
    free_unit: esGratis ? ((r['free_unit'] as string | null) ?? null) : null,
    valid_from: fecha(r['valid_from']),
    valid_to: fecha(r['valid_to']),
    warehouse_code: (r['warehouse_code'] as string | null) ?? null,
  };
}
