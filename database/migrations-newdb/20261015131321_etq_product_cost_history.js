'use strict';
/**
 * `[ETQ-CAMBIOS.11]` La HISTORIA del costo de cada producto, para poder decir «costo anterior».
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Compras pidió que «Cambios de precio» traiga las columnas de su reporte en PDF (proveedor, UXC,
 * costo anterior y actual con impuesto, precio de punto de venta, mayoreo, tipo de cambio). Todas
 * tienen fuente salvo UNA: **Kepler no guarda la historia del costo de la ficha** (`kdii.c77` sólo
 * tiene el valor de hoy; ver `historial-costos.ts` y VERDAD_ABSOLUTA §4.2). Sin historia no hay
 * «anterior». Decisión de Edgar (2026-10-15): guardar una foto del costo desde hoy.
 *
 * ── Qué es ───────────────────────────────────────────────────────────────────────────────────
 *  · Una tabla de HISTORIA de eventos (snapshot/histórico es de las pocas tablas reales que la regla
 *    de cero importers permite): **sólo se escribe una fila cuando el costo CAMBIA** respecto de la
 *    última que se guardó para ese (plaza, SKU, unidad). Sin eso serían ~260,000 filas por noche;
 *    así son las del primer día (la siembra) más los cambios reales.
 *  · Se guarda el costo **SIN impuesto**, tal como lo tiene la ficha (`v_kepler_standard_cost`). El
 *    «con impuesto» se calcula al leer con la tasa observada de hoy: la tasa no es lo que cambia entre
 *    dos costos del mismo producto, y guardarla multiplicaría las filas si Kepler recalcula.
 *  · `valid_from` es el DÍA en que el cron VIO el costo nuevo, **no** el día en que Compras lo editó:
 *    el cron corre de noche, así que el error es de hasta un día. Se declara en la pantalla.
 *
 * ── Lo que NO es ─────────────────────────────────────────────────────────────────────────────
 * No reconstruye el pasado: la primera foto es de hoy, así que el «costo anterior» de un cambio de
 * costo anterior a hoy no existe y se muestra «sin dato», nunca un cero.
 *
 * Aditiva e idempotente. RLS forzado + grants a `app_runtime` (el cron corre en el worker).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('analytics').hasTable('product_cost_history'))) {
    await knex.raw(`
      CREATE TABLE analytics.product_cost_history (
        tenant_id           uuid          NOT NULL,
        sucursal            text          NOT NULL,
        sku                 text          NOT NULL,
        unidad              text          NOT NULL,
        costo_sin_impuesto  numeric(14,4) NOT NULL,
        valid_from          date          NOT NULL,
        created_at          timestamptz   NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, sku, unidad, valid_from),
        CONSTRAINT product_cost_history_costo_chk CHECK (costo_sin_impuesto > 0),
        CONSTRAINT product_cost_history_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE CASCADE
      )`);
  }
  await knex.raw(`ALTER TABLE analytics.product_cost_history ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE analytics.product_cost_history FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON analytics.product_cost_history`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON analytics.product_cost_history
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.product_cost_history TO app_runtime`);
  await knex.raw(`
    COMMENT ON TABLE analytics.product_cost_history IS
      '[ETQ-CAMBIOS.11] Historia del costo estandar (sin impuesto) por plaza, SKU y unidad. Una fila SOLO cuando '
      'el costo cambia; valid_from = dia en que el cron lo vio, no el de la edicion. Kepler no guarda esta '
      'historia: la primera foto es del dia que se desplego, no hay pasado que reconstruir.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.product_cost_history`);
};
