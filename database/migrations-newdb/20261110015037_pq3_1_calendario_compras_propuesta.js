'use strict';
/**
 * `[PQ.3.1]` — Calendario de compras: lo que Kepler PROPONE de cada proveedor (ciclo, última ronda
 * de pedido, próxima fecha), como VISTA `derive-no-copy`. Plan:
 * `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` (anexo C).
 *
 * Sustituye la brújula de Compras (la hoja «2026» de su Excel, fuera del repo): un bloque por día
 * con los proveedores a los que toca pedirles. Aquí sólo va la PROPUESTA que sale del ERP; el ciclo
 * lo define la gerencia de compras (DC8) en una tabla propia (PQ.3.2). Esta vista no frena, no
 * etiqueta y no cambia ninguna cantidad sugerida (DC3).
 *
 * ── La regla ────────────────────────────────────────────────────────────────────────────────
 *  · Una RONDA es un pedido del comprador: las OC vivas del mismo proveedor que salen dentro de
 *    4 días desde la PRIMERA de la ronda (una por sucursal, en días seguidos). Un día que cae más
 *    lejos del INICIO abre ronda nueva. ⛔ No se compara con el día anterior: encadenar así juntaba
 *    en UNA ronda de 313 días a un proveedor con 366 OC en el año (revisión independiente,
 *    2026-11-10).
 *  · Ciclo propuesto = mediana entre inicios de ronda, con 4+ rondas. Si la mediana no pasa de
 *    5 días (4 + 1) las rondas van pegadas: se le pide cada pocos días y la mediana es el piso de
 *    la regla, no un ciclo → `compra_continua`, sin ciclo ni fecha (ADR-056).
 *  · Fuera las claves de sucursal propia (`TI000`–`TI008`): son traspasos internos, no proveedores
 *    (misma regla que `trip-closure.service.ts`).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-10) ────────────────────────────────────────
 *  · Fuente: `analytics.erp_purchase_orders`, el decode canónico de la OC de Kepler (X-A-35,
 *    `sucursal = c1`). Cancelada = `estatus 'C'` (mismo criterio que la bandeja de OC, PQ.29).
 *  · Testigo independiente: la hoja 2026 de Compras (73 proveedores casados 1:1 con 4+
 *    apariciones). Ventana de la ronda, acotada desde su inicio (dentro de ±30 % · ±50 % · razón):
 *        0 d (días distintos) ... 30 % · 47 % · 0.54
 *        2 d .................... 37 % · 64 % · 0.71
 *        4 d .................... 42 % · 74 % · 0.82   ← ésta (4 proveedores en compra continua)
 *        6 d .................... 48 % · 77 % · 0.91      (pero 12 en el piso de la regla)
 *        ciclo de ENTREGAS por almacén (la agenda PQ.4) ... 31 % · 62 % · 0.59
 *  · Universo: 338 claves con OC viva en 365 días (sin las 9 `TI`). La clave casa con
 *    `catalog.suppliers` por `(tenant_id, code)`, único también con las borradas: 25 claves tienen
 *    sólo una ficha BORRADA (la consolidación del 2026-07-20 dejó viva otra ficha con otra clave, y
 *    Kepler sigue pidiendo con la vieja). La vista NO adivina por nombre: lo declara en
 *    `supplier_record`.
 *  · Costo: ~100–300 ms. La primera versión, con CTEs unidos entre sí, tardaba 106 s (el planner
 *    estimaba 1 fila por CTE): por eso la recursión recorre un ARREGLO de días por proveedor, sin
 *    juntas dentro.
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────────────────────
 *  · No mira compras de tienda en Wincaja (`WIN_C`): NO MEDIDAS para el calendario.
 *  · No liga la clave de Kepler al proveedor de los productos en Pedido: en 62 de las 314 claves con
 *    ficha viva no coinciden (medido); eso lo resuelve la pantalla (PQ.3.5), no esta vista.
 *  · No materializa nada (regla 2).
 *
 * ⚠️ Es la PRIMERA vista que depende de `analytics.erp_purchase_orders` (pg_depend, 2026-11-10). Una
 *    migración futura que la reconstruya con `DROP VIEW` sin CASCADE va a fallar aquí (ruidoso, sin
 *    perder datos): esa migración tiene que soltar y recrear también ésta.
 *
 * El tenant se filtra DENTRO de la vista (`public.current_tenant_id()`): la fuente no tiene RLS y
 * hardcodea el tenant del ODS. Sin `app.tenant_id`, 0 filas (falla cerrado).
 *
 * Idempotente (`CREATE OR REPLACE`). Sin la réplica de Kepler (base del CI) es no-op y lo dice.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'commercial.v_purchase_calendar_proposal';
const FUENTE = 'analytics.erp_purchase_orders';
/** Una ronda junta las OC hasta esta distancia en días desde su PRIMERA OC. */
const JUNTA_DIAS = 4;
/** Con al menos estas rondas (3 intervalos) hay ciclo propuesto. */
const MIN_RONDAS = 4;
const VENTANA_DIAS = 365;
/** «Hoy» en la hora de México (TZ del negocio). */
const HOY = `(now() AT TIME ZONE 'America/Mexico_City')::date`;
/** Claves de proveedor que son sucursales propias (traspaso interno). */
const SUCURSAL_PROPIA = `'^TI[0-9]+$'`;

/**
 * El cuerpo de la vista sobre cualquier relación con las columnas de `analytics.erp_purchase_orders`
 * que usa (tenant_id, proveedor_code, proveedor_nombre, doc_date, sucursal, folio, estatus). La
 * prueba le pasa datos sintéticos; la migración, la fuente real.
 */
function cuerpo(fuente) {
  // Sin juntas entre CTEs grandes: la recursión recorre un ARREGLO de días por proveedor.
  return `
    WITH RECURSIVE oc AS (
      SELECT f.tenant_id, f.proveedor_code AS supplier_code, f.proveedor_nombre, f.doc_date, f.sucursal, f.folio
        FROM ${fuente} f
       WHERE f.tenant_id = public.current_tenant_id()
         AND f.estatus <> 'C'
         AND f.proveedor_code IS NOT NULL
         AND f.proveedor_code !~ ${SUCURSAL_PROPIA}
         AND f.doc_date > ${HOY} - ${VENTANA_DIAS}
         AND f.doc_date <= ${HOY}
    ),
    por_prov AS (
      SELECT tenant_id, supplier_code,
             array_agg(DISTINCT doc_date ORDER BY doc_date) AS dias,
             max(doc_date) AS last_order_date,
             (array_agg(proveedor_nombre ORDER BY doc_date DESC, folio DESC))[1] AS supplier_name,
             array_agg(DISTINCT sucursal ORDER BY sucursal) AS branches_12m,
             jsonb_agg(jsonb_build_object('sucursal', sucursal, 'folio', folio, 'fecha', doc_date)
                       ORDER BY sucursal, doc_date, folio) AS ocs
        FROM oc
       GROUP BY tenant_id, supplier_code
    ),
    recorrido AS (
      -- Un día abre ronda si cae a más de ${JUNTA_DIAS} días del INICIO de la ronda en curso.
      SELECT tenant_id, supplier_code, dias, 1 AS i, dias[1] AS inicio
        FROM por_prov
      UNION ALL
      SELECT tenant_id, supplier_code, dias, i + 1,
             CASE WHEN dias[i + 1] - inicio > ${JUNTA_DIAS} THEN dias[i + 1] ELSE inicio END
        FROM recorrido
       WHERE i < cardinality(dias)
    ),
    inicios AS (
      SELECT tenant_id, supplier_code, array_agg(DISTINCT inicio ORDER BY inicio) AS starts
        FROM recorrido
       GROUP BY tenant_id, supplier_code
    ),
    resumen AS (
      SELECT p.tenant_id, p.supplier_code, p.supplier_name, p.branches_12m, p.last_order_date, p.ocs,
             cardinality(p.dias) AS order_days_12m,
             cardinality(s.starts) AS rounds_12m,
             s.starts[cardinality(s.starts)] AS last_round_date,
             (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gap)
                FROM (SELECT x - lag(x) OVER (ORDER BY x) AS gap FROM unnest(s.starts) AS x) g
               WHERE g.gap IS NOT NULL) AS mediana
        FROM por_prov p
        JOIN inicios s ON s.tenant_id = p.tenant_id AND s.supplier_code = p.supplier_code
    ),
    clasificado AS (
      SELECT r.*,
             CASE WHEN r.rounds_12m >= ${MIN_RONDAS} AND round(r.mediana::numeric) > ${JUNTA_DIAS + 1} THEN 'propuesto'
                  WHEN r.rounds_12m >= ${MIN_RONDAS} THEN 'compra_continua'
                  WHEN r.rounds_12m >= 2 THEN 'pocas_compras'
                  ELSE 'una_compra' END AS proposal_status
        FROM resumen r
    )
    SELECT c.tenant_id,
           c.supplier_code,
           c.supplier_name,
           s.id AS supplier_id,
           CASE WHEN s.id IS NULL THEN 'sin_ficha'
                WHEN s.deleted_at IS NULL THEN 'ficha_viva'
                ELSE 'ficha_borrada' END AS supplier_record,
           c.proposal_status,
           c.rounds_12m,
           c.order_days_12m,
           round(c.mediana::numeric, 1) AS cycle_days_median,
           CASE WHEN c.proposal_status = 'propuesto' THEN round(c.mediana::numeric)::int END AS cycle_days_proposed,
           c.last_order_date,
           c.last_round_date,
           CASE WHEN c.proposal_status = 'propuesto'
                THEN c.last_round_date + round(c.mediana::numeric)::int END AS next_date_proposed,
           (SELECT jsonb_agg(e.v ORDER BY e.n)
              FROM jsonb_array_elements(c.ocs) WITH ORDINALITY AS e(v, n)
             WHERE (e.v->>'fecha')::date >= c.last_round_date) AS last_round_orders,
           c.branches_12m
      FROM clasificado c
      -- (tenant_id, code) es único en catalog.suppliers, también con las borradas: a lo sumo una.
      LEFT JOIN catalog.suppliers s ON s.tenant_id = c.tenant_id AND s.code = c.supplier_code`;
}

exports.SQL = { cuerpo, JUNTA_DIAS, MIN_RONDAS, VENTANA_DIAS, HOY, SUCURSAL_PROPIA };

exports.up = async function up(knex) {
  const { rows: [src] } = await knex.raw(
    `SELECT to_regclass('${FUENTE}') AS fuente, to_regclass('catalog.suppliers') AS sup`);
  if (!src.fuente || !src.sup) {
    console.log(`  [PQ.3.1] ${FUENTE} o catalog.suppliers ausente — no-op (base sin réplica de Kepler).`);
    return;
  }
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${cuerpo(FUENTE)}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[PQ.3.1] Propuesta del ERP para el calendario de compras, por clave de proveedor de Kepler (sin sucursales propias TI): rondas de OC vivas en 365 d (una ronda = OC dentro de ${JUNTA_DIAS} d desde su primera), ciclo propuesto (mediana entre rondas, con ${MIN_RONDAS}+ rondas; compra_continua si las rondas van pegadas), ultima ronda por sucursal y proxima fecha. Propuesta, no decision: el ciclo lo define la gerencia de compras (PQ.3.2). Filtra tenant por app.tenant_id.'`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  // dev_ro existe en prod, no necesariamente en la base del CI.
  const { rows: [ro] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') AS hay`);
  if (ro.hay) await knex.raw(`GRANT SELECT ON ${VISTA} TO dev_ro`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista no guarda datos. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
