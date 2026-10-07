/**
 * RA-PRO.36 — Índice de Aceleración de Demanda (IAD) por SKU para la matriz de compra.
 *
 * Requerimiento Jefe Frank: un indicador por producto en escala −2..+2 que diga si el RITMO de
 * demanda se está acelerando, estable o desacelerando (2da derivada, no solo tendencia), para
 * anticipar compra y evitar faltantes/sobreinventario.
 *
 * Método (fijado): Welch-Z autocontenido + compuesto estacional.
 *   z_short    = (μ_recent − μ_prior) / √(σ²_rec/n_rec + σ²_prev/n_prev)   (30d vs días 31-60)
 *   z_seasonal = mismo Welch-Z entre 60d actuales vs mismos 60d del año anterior
 *   iad        = clamp( 0.6·z_short + 0.4·z_seasonal , −2, +2 )   (sin base estacional → 100% z_short)
 * μ/σ sobre DÍAS CON OPERACIÓN (días con venta) del bloque. Guard de spike (cap diario) para no
 * reaccionar a mayoreo/liquidación puntual.
 *
 * Grano = (tenant, product) — señal a nivel SKU (red), se muestra una vez por producto en la matriz.
 * v1 = SOLO SEÑAL (informativa): NO ajusta el sugerido (ADR-016/030 motor decide/humano aprueba).
 * Sin RLS (patrón analytics.*, tenant_id explícito). Lo refresca el runner nightly. Reversible.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('demand_acceleration'))) {
    await knex.raw(`
      CREATE TABLE analytics.demand_acceleration (
        tenant_id     uuid NOT NULL,
        product_id    uuid NOT NULL,            -- canónico
        sku           text,
        nombre        text,
        -- bloque reciente (últimos 30d) y anterior (días 31-60): media/desv/n sobre días con venta
        mu_recent     numeric,
        sd_recent     numeric,
        n_recent      int,
        mu_prior      numeric,
        sd_prior      numeric,
        n_prior       int,
        z_short       numeric,                  -- Welch-Z 30v30, clamp −2..+2
        -- bloque estacional: 60d actuales vs mismos 60d del año anterior
        mu_cur60      numeric,
        mu_yoy60      numeric,
        z_seasonal    numeric,                  -- Welch-Z YoY, clamp −2..+2 (NULL si sin base)
        has_seasonal  boolean NOT NULL DEFAULT false,
        iad           numeric,                  -- compuesto final −2..+2 (NULL si status != ok)
        band          text,                     -- accel_extra|accel|accel_leve|estable|desacel_leve|desacel|desacel_extra
        status        text NOT NULL DEFAULT 'ok', -- ok|insufficient_history|insufficient_sales|no_prior
        computed_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, product_id)
      )`);
    await knex.raw(`CREATE INDEX ix_daccel_tenant_band ON analytics.demand_acceleration (tenant_id, band)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.demand_acceleration TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.demand_acceleration IS 'RA-PRO.36 — IAD por SKU (−2..+2) para la matriz de compra. Welch-Z 30v30 + estacional YoY. Lo refresca el runner nightly.'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.demand_acceleration`);
};
