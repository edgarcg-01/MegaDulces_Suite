'use strict';
/**
 * `[WH.4b]` — La venta histórica materializada pasa de MATVISTA a **TABLA llenada por sucursal**.
 *
 * ── Por qué se cambia algo que se acababa de aplicar ─────────────────────────────────────────
 * `[WH.4]` creó `analytics.mv_wincaja_hist_sales` y su `REFRESH` **murió dos veces seguidas**, las
 * dos con `FATAL: terminating connection due to administrator command`.
 *
 * Diagnosticado antes de reintentar, y **no era culpa del refresco**:
 *   · el pod de `pg-prod` se **redesplegó con una imagen nueva** cada vez
 *     (`trade-prod-pg:99cda14a`, luego `:1f39831c`) — ReplicaSet nuevo, `RESTARTS 0`, sin `OOMKilled`;
 *   · **no hay `livenessProbe`** (sólo readiness), así que no es inanición de sonda;
 *   · `statement_timeout`, `idle_session_timeout` e `idle_in_transaction_session_timeout` = **0**;
 *   · el contenedor no tiene `limits.memory`, sólo `requests` → no hay OOM del cgroup.
 *
 * **Medido: 8 ReplicaSets de `pg-prod` en 4 h 20 min** — un despliegue cada ~30-40 minutos. Una
 * operación ATÓMICA de varios minutos no entra de forma confiable en esa ventana, y `REFRESH
 * MATERIALIZED VIEW` es todo-o-nada: cada muerte tira el trabajo completo.
 *
 * ⭐ **La lección no es "reintentar hasta tener suerte", es que el objeto estaba mal elegido.**
 * El corpus de Wincaja está **CERRADO** (dejó de ser fuente viva al migrar cada sucursal a Kepler),
 * así que esto se llena **una sola vez y nunca más**: la atomicidad de una matvista no compra nada
 * que valga varios minutos de exposición. Una tabla llenada **por sucursal** son nueve
 * transacciones de 1–37 s (medido: Zamora 1.0 s · La Piedad 36.5 s), cada una muy por debajo de
 * la ventana entre despliegues, y si una muere se repite **sólo esa sucursal**.
 *
 * Mismo grano, mismas columnas, mismos índices: lo único que cambia es cómo se llena.
 *
 * ⚠️ `articulo` sigue siendo el código de Wincaja, **sin casar contra `catalog.products`**. Ese
 * puente es `[WH.3b]` y es el riesgo que queda abierto.
 *
 * Sin RLS (patrón `analytics.*`: tenant explícito).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  // La matvista nunca llegó a tener datos (`relispopulated = false`), así que no se pierde nada.
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wincaja_hist_sales`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.wincaja_hist_sales (
      tenant_id   uuid        NOT NULL,
      sucursal    text        NOT NULL,
      sale_date   date        NOT NULL,
      articulo    text        NOT NULL,
      clase       text        NOT NULL,
      tickets     integer     NOT NULL,
      cantidad    numeric,
      valor_venta numeric,
      valor_costo numeric,
      iva         numeric,
      ieps        numeric,
      -- Cuándo se derivó ESTA sucursal. Es el latido del llenado por partes: permite ver qué
      -- plaza quedó a medias si una transacción muere, sin tener que adivinarlo.
      cargado_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, sale_date, articulo, clase)
    )`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_wincaja_hist_articulo
    ON analytics.wincaja_hist_sales (tenant_id, articulo, sucursal, sale_date)
    WHERE clase = 'venta_cliente'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_wincaja_hist_fecha
    ON analytics.wincaja_hist_sales (tenant_id, sucursal, sale_date)`);

  await knex.raw(`COMMENT ON TABLE analytics.wincaja_hist_sales IS
    'WH.4b - Venta historica de Wincaja 2017-2025 agregada a (sucursal, dia, articulo, clase), DERIVADA de analytics.v_wincaja_hist_sales (FDW al espejo, cero copia del crudo). Es TABLA y no matvista porque el REFRESH atomico murio dos veces: pg-prod se redespliega cada ~30-40 min (8 ReplicaSets en 4h20m) y todo-o-nada no entra en esa ventana. El corpus esta CERRADO, asi que se llena por sucursal UNA vez y nunca mas; si una plaza muere se repite solo esa. Lo excluido por cordura o fecha se ve en analytics.v_wincaja_hist_descartado. articulo es el codigo de Wincaja, sin casar aun contra catalog.products (WH.3b).'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.wincaja_hist_sales`);
};
