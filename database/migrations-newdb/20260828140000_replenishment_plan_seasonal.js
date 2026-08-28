/**
 * RA-PRO.41 — El pedido aprende de la historia: 4 columnas derivadas en el fact del pedido.
 *
 *   season_ratio  numeric — razón estacional del horizonte: idx(próximos 30d) / idx(últimos 30d).
 *                  Jerárquico SKU→categoría→global con shrinkage n/(n+1), índices normalizados POR AÑO
 *                  (mata la deriva de crecimiento 2026>2025), banda muerta 0.85–1.15 → 1, cap [0.5, 2.0].
 *                  Backtest ene–ago 2026: bias de enero +39.6% → −4.7% (post-navidad), WMAPE 0.72 → 0.47.
 *   season_src    text    — nivel que aportó la señal: sku | cat | global (NULL = sin historia).
 *   safety_pct_q  numeric — colchón por CUANTILES de sumas rodantes de 4 semanas (26 sem, red),
 *                  robusto a la intermitencia (77% de los pares SKU×almacén venden <1/3 de los días,
 *                  donde el CV clásico no discrimina — 89% caía en clase Z). Por clase ABC:
 *                  A p90 cap 0.50 · B p80 cap 0.35 · C p70 cap 0.25. NULL si <8 semanas con venta.
 *   lead_days     numeric — lead time proveedor DERIVADO del ODS: mediana del lag OC(X-A-35)→
 *                  entrada(X-A-40) en las OCs capturadas antes de recibir (~16%; el 84% se captura
 *                  el mismo día y no aporta señal). n≥5 por proveedor; fallback mediana global (~4d).
 *
 * Todo se deriva de históricos en import-replenishment-plan (cero captura manual, ADR-016 el motor
 * decide). El motor multiplica la demanda por season_ratio y usa safety_pct_q como colchón default
 * cuando no hay override manual del proveedor.
 */
exports.up = async function up(knex) {
  const add = async (col, type) => {
    if (await knex.schema.withSchema('analytics').hasColumn('replenishment_plan', col)) return;
    await knex.schema.withSchema('analytics').alterTable('replenishment_plan', (t) => {
      if (type === 'numeric') t.decimal(col, null);
      else t.text(col);
    });
  };
  await add('season_ratio', 'numeric');
  await add('season_src', 'text');
  await add('safety_pct_q', 'numeric');
  await add('lead_days', 'numeric');
};

exports.down = async function down() {
  // aditiva — no se revierte (las columnas quedan; el importer las repuebla)
};
