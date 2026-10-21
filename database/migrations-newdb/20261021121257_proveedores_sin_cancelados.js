'use strict';
/**
 * `[CSU.11]` — **Del lado proveedor, un documento CANCELADO en Kepler deja de contar.** Tres vistas
 * leían la cabecera `kdm1` sin mirar `c43` (el estatus de cancelación).
 *
 * ── Medido en prod el 2026-10-21 (sólo lectura: la vista tal cual vs con el filtro) ───────────
 *
 *   · `analytics.expense_documents` (gastos X-A-10 y entradas X-A-20): **1,021 documentos
 *     cancelados, $3,177,101.13**. Kepler deja su `c16` en 0, pero 263 traen importe por el agregado
 *     contable (`expense_doc_accounting`). Alimenta Comprobaciones (`monto_pendiente`), los pagables
 *     de Caja (`buscarPagables` ofrecía un gasto cancelado como pagable), materialidad y MAAT. La
 *     vista no expone el estatus, así que ningún consumidor podía filtrarlo por su cuenta.
 *   · `analytics.mv_supplier_prompt_discount` (pronto pago): **101 pagos cancelados con
 *     $1,450,384.26 de descuento** (`c84`) que no existió. Inflaba la tasa observada de 8+
 *     proveedores (CF004 7.39 % → 6.20 %, CT008 7.09 % → 6.09 %) y el «nos ahorró».
 *   · `analytics.erp_purchase_adjustment_lines` (ajustes X-D-40/55, líneas de `kdm2`): **0 hoy**.
 *     Se filtra igual: sus importes salen de la LÍNEA, que no se pone en 0 al cancelar.
 *
 * Los pagos a entradas (`kdm5` X-D → X-A, $13.3 M de aplicaciones canceladas) NO los suma ninguna
 * vista ni función de prod (medido en el catálogo); los cubre `analytics.kepler_kdm5_vigente`.
 *
 * ── Cómo ───────────────────────────────────────────────────────────────────────────────────
 *
 * La definición se toma VIVA (`pg_get_viewdef`) y sólo se le agrega
 * `AND btrim(COALESCE(<alias>.c43, '')) <> 'C'` después de un ancla que se exige ÚNICA. Las vistas
 * se verifican: filas después = filas antes − documentos cancelados (contados por otro camino).
 * La matview no admite `CREATE OR REPLACE`: se recrea con sus índices, permisos y comentario, y
 * `WITH DATA` — **tarda ~25 s y toma candado: aplicar FUERA de horario.**
 *
 * Idempotente: un objeto que ya filtra `c43` se salta. El guardián del catálogo es
 * `check:kdm5-vigente:db` (sección «cabeceras kdm1 con dinero»).
 *
 * @param { import("knex").Knex } knex
 */

const VISTAS = [
  { nombre: 'analytics.expense_documents', alias: 'd', ancla: 'AND btrim(d.c1) = d.sucursal',
    cancelados: `SELECT count(*) AS n FROM kepler_ods.kdm1 d
                  WHERE d.c2 = 'X' AND d.c3 = 'A' AND btrim(d.c4::text) IN ('10', '20') AND btrim(d.c5::text) = '1'
                    AND btrim(d.c1) = d.sucursal AND btrim(COALESCE(d.c43, '')) = 'C'` },
  { nombre: 'analytics.erp_purchase_adjustment_lines', alias: 'aj', ancla: 'AND btrim(aj.c1) = aj.sucursal',
    cancelados: `SELECT count(*) AS n FROM kepler_ods.kdm1 aj
                   JOIN kepler_ods.kdm2 l ON l.sucursal = aj.sucursal AND l.c1 = aj.c1 AND l.c2 = aj.c2 AND l.c3 = aj.c3 AND l.c4 = aj.c4 AND l.c6 = aj.c6
                  WHERE aj.c2 = 'X' AND aj.c3 = 'D' AND btrim(aj.c4::text) IN ('40', '55') AND btrim(aj.c1) = aj.sucursal
                    AND btrim(COALESCE(aj.c43, '')) = 'C'` },
];
const MV = { nombre: 'analytics.mv_supplier_prompt_discount', alias: 'm', ancla: "WHERE btrim(m.c2) = 'X'::text AND" };

const filtro = (alias) => `btrim(COALESCE(${alias}.c43, ''::text)) <> 'C'::text`;

function agregarFiltro(def, ancla, texto, despues) {
  const i = def.indexOf(ancla);
  if (i < 0 || def.indexOf(ancla, i + 1) >= 0) throw new Error(`[CSU.11] el ancla «${ancla}» no aparece exactamente una vez: la definición cambió, revisar`);
  const p = i + ancla.length;
  return despues ? def.slice(0, p) + ` ${texto} AND` + def.slice(p) : def.slice(0, p) + ` AND ${texto}` + def.slice(p);
}

const existe = async (knex, n) => !!(await knex.raw('SELECT to_regclass(?) AS x', [n])).rows[0].x;
const definicion = async (knex, n) => (await knex.raw('SELECT pg_get_viewdef(to_regclass(?), true) AS d', [n])).rows[0].d.trim().replace(/;\s*$/, '');
const contar = async (knex, sql) => Number((await knex.raw(sql)).rows[0].n);

exports.up = async function up(knex) {
  if (!(await existe(knex, 'kepler_ods.kdm1'))) return; // dev sin ODS
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '300s'`);

  for (const v of VISTAS) {
    if (!(await existe(knex, v.nombre))) { console.log(`  [CSU.11] ${v.nombre}: no existe — se salta`); continue; }
    const def = await definicion(knex, v.nombre);
    if (def.includes(`${v.alias}.c43`)) { console.log(`  [CSU.11] ${v.nombre}: ya filtra cancelados — se salta`); continue; }
    const nuevo = agregarFiltro(def, v.ancla, filtro(v.alias), false);
    const antes = await contar(knex, `SELECT count(*) AS n FROM ${v.nombre}`);
    const cancelados = await contar(knex, v.cancelados);
    const opc = (await knex.raw('SELECT reloptions FROM pg_class WHERE oid = to_regclass(?)', [v.nombre])).rows[0].reloptions;
    await knex.raw(`CREATE OR REPLACE VIEW ${v.nombre}${opc && opc.length ? ` WITH (${opc.join(', ')})` : ''} AS ${nuevo}`);
    const despues = await contar(knex, `SELECT count(*) AS n FROM ${v.nombre}`);
    if (antes - despues !== cancelados) {
      throw new Error(`[CSU.11] ${v.nombre}: quitó ${antes - despues} filas y hay ${cancelados} de documentos cancelados — no cuadra.`);
    }
    console.log(`  [CSU.11] ${v.nombre}: ${antes} → ${despues} filas (fuera ${cancelados} de documentos cancelados)`);
  }

  if (await existe(knex, MV.nombre)) {
    const def = await definicion(knex, MV.nombre);
    if (def.includes(`${MV.alias}.c43`)) { console.log(`  [CSU.11] ${MV.nombre}: ya filtra cancelados — se salta`); return; }
    const nuevo = agregarFiltro(def, MV.ancla, filtro(MV.alias), true);
    const tot = async () => (await knex.raw(`SELECT count(*)::int prov, coalesce(sum(n_observaciones), 0)::int obs, coalesce(sum(descuento_12m), 0) descuento FROM ${MV.nombre}`)).rows[0];
    const comentario = (await knex.raw(`SELECT obj_description(to_regclass(?), 'pg_class') AS c`, [MV.nombre])).rows[0].c || '';
    // Una matview creada WITH NO DATA (dev) no se puede leer: sin conteo previo, se declara.
    const poblada = (await knex.raw(`SELECT relispopulated AS p FROM pg_class WHERE oid = to_regclass(?)`, [MV.nombre])).rows[0].p;
    const antes = poblada ? await tot() : null;
    await knex.raw(`DROP MATERIALIZED VIEW ${MV.nombre}`);
    await knex.raw(`CREATE MATERIALIZED VIEW ${MV.nombre} AS ${nuevo} WITH DATA`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS mv_supplier_prompt_discount_pk ON ${MV.nombre} (proveedor_code)`);
    await knex.raw(`GRANT SELECT ON ${MV.nombre} TO app_runtime`);
    await knex.raw(`GRANT SELECT ON ${MV.nombre} TO PUBLIC`);
    await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${MV.nombre} TO dev_ro'; END IF; END $$`);
    const nota = ' [CSU.11] Excluye pagos CANCELADOS en Kepler (kdm1.c43 = C): conservaban su descuento c84.';
    // ⛔ COMMENT ON no admite parámetros ligados: el texto va inlineado, con las comillas escapadas.
    await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV.nombre} IS '${(comentario.replace(nota, '') + nota).replace(/'/g, "''")}'`);
    const despues = await tot();
    if (!antes) { console.log(`  [CSU.11] ${MV.nombre}: no estaba poblada (sin conteo previo: NO MEDIDO) · ahora ${despues.obs} observaciones`); return; }
    if (despues.obs > antes.obs) throw new Error(`[CSU.11] ${MV.nombre}: subieron las observaciones (${antes.obs} → ${despues.obs}); sólo podían bajar.`);
    console.log(`  [CSU.11] ${MV.nombre}: observaciones ${antes.obs} → ${despues.obs} · descuento ${antes.descuento} → ${despues.descuento}`);
  }
};

/** Deshace EXACTAMENTE el filtro agregado (vuelve a la definición sin c43). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '300s'`);
  for (const v of VISTAS) {
    if (!(await existe(knex, v.nombre))) continue;
    const def = await definicion(knex, v.nombre);
    const quitar = ` AND ${filtro(v.alias)}`;
    if (!def.includes(quitar)) continue;
    await knex.raw(`CREATE OR REPLACE VIEW ${v.nombre} AS ${def.split(quitar).join('')}`);
  }
  if (await existe(knex, MV.nombre)) {
    const def = await definicion(knex, MV.nombre);
    const quitar = ` ${filtro(MV.alias)} AND`;
    if (!def.includes(quitar)) return;
    const comentario = (await knex.raw(`SELECT obj_description(to_regclass(?), 'pg_class') AS c`, [MV.nombre])).rows[0].c || '';
    await knex.raw(`DROP MATERIALIZED VIEW ${MV.nombre}`);
    await knex.raw(`CREATE MATERIALIZED VIEW ${MV.nombre} AS ${def.split(quitar).join('')} WITH DATA`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS mv_supplier_prompt_discount_pk ON ${MV.nombre} (proveedor_code)`);
    await knex.raw(`GRANT SELECT ON ${MV.nombre} TO app_runtime`);
    await knex.raw(`GRANT SELECT ON ${MV.nombre} TO PUBLIC`);
    await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${MV.nombre} TO dev_ro'; END IF; END $$`);
    await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV.nombre} IS '${comentario.replace(' [CSU.11] Excluye pagos CANCELADOS en Kepler (kdm1.c43 = C): conservaban su descuento c84.', '').replace(/'/g, "''")}'`);
  }
};

exports._agregarFiltro = agregarFiltro;
