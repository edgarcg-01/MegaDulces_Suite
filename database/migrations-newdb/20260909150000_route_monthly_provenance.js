/**
 * `analytics.route_monthly_provenance` — DECLARA la procedencia del gold `sales_by_route_monthly`.
 *
 * Por qué existe (Fase VP / ADR-056, deuda "D" del análisis de la capa): el gold de venta-ruta lo
 * escriben CINCO importers con la MISMA llave `(tenant, warehouse, route_code, month)` y un
 * `GREATEST` **por métrica e independiente**. Para Canindo (`WIN-50N`) DOS universos chocan en esa
 * llave: `import-route-push-monthly` (runner `.249 / mart.ventas`) e `import-canindo-routes-monthly`
 * (réplica `kepler_md_06`). Medido 2026-09-09 contra prod, el `GREATEST` ya descartó al perdedor en
 * 4 llaves (hasta −$300,611 en WIN-503 2026-08) SIN declararlo. Hoy el número es correcto —push gana
 * siempre porque la réplica purga historia y es un subconjunto degradado—, pero el modo de falla es
 * real: si el agente push de una van se atora, branch puede ganar UNA métrica y **degradar la fila en
 * silencio**, sin que nadie vea el cambio de universo (poblado ≠ fresco; el máximo tapa el swap).
 *
 * Esta tabla es la ÚNICA forma de meter esa comparación a prod: las dos fuentes (runner `.249`,
 * réplica `:5433`) NO son alcanzables desde Railway, así que una VISTA pura no puede verlas. Es
 * metadata de OBSERVABILIDAD (clase `cron_runs` / `db_health_alerts` / `finance.findings`), NO una
 * copia de un hecho Kepler: la puebla el reconciler read-only `reconcile-route-provenance.js` (on-prem,
 * donde sí se alcanzan ambas) y la leen la vista `v_route_monthly_provenance` (humanos) + el sensor
 * `route_provenance` de `db-health` (dispara si branch gana una métrica = push atorado, o si el
 * reconciler dejó de correr). No cambia ninguna cifra publicada — sólo la vuelve auditable.
 *
 * Sin RLS (como los ~59 hermanos de `analytics.*`): `tenant_id` explícito; el reconciler escribe con
 * superuser y el sensor lee con el pool de la app — un `FORCE RLS` acá sólo abriría el modo de falla
 * "0 filas en silencio" que la fase combate. @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.route_monthly_provenance (
      tenant_id        uuid        NOT NULL,
      warehouse_id     uuid        NOT NULL,
      route_code       text        NOT NULL,
      month            date        NOT NULL,
      revenue_push     numeric,
      revenue_branch   numeric,
      tickets_push     integer,
      tickets_branch   integer,
      units_push       numeric,
      units_branch     numeric,
      -- por qué gana el gold, medido por revenue: 'push' | 'branch' | 'push_only' | 'branch_only' | 'tie'
      source_winner    text        NOT NULL,
      -- lo que el GREATEST tiró (revenue del perdedor cuando ambos universos ofrecen): cuánto tapa el máximo
      discarded_revenue numeric    NOT NULL DEFAULT 0,
      -- true = branch ESTRICTAMENTE mayor que push en alguna métrica ⇒ push atorado, la fila pudo degradarse
      stall            boolean     NOT NULL DEFAULT false,
      reconciled_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, warehouse_id, route_code, month)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_rmp_stall ON analytics.route_monthly_provenance (stall) WHERE stall`);

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_monthly_provenance AS
      SELECT p.tenant_id, w.code AS warehouse_code, w.name AS warehouse_name,
             p.route_code, to_char(p.month,'YYYY-MM') AS month,
             p.revenue_push, p.revenue_branch, p.tickets_push, p.tickets_branch,
             p.source_winner, p.discarded_revenue, p.stall, p.reconciled_at
        FROM analytics.route_monthly_provenance p
        JOIN commercial.warehouses w ON w.id = p.warehouse_id
       ORDER BY p.stall DESC, p.discarded_revenue DESC, p.route_code, p.month`);
  await knex.raw(`GRANT SELECT ON analytics.route_monthly_provenance TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_monthly_provenance TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE analytics.route_monthly_provenance IS
    'VP/ADR-056: procedencia declarada del gold sales_by_route_monthly (push vs branch por llave). Metadata de observabilidad poblada por reconcile-route-provenance.js on-prem — las 2 fuentes no son alcanzables desde prod, por eso no es vista. stall=true ⇒ push atorado.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_monthly_provenance CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.route_monthly_provenance CASCADE`);
};
