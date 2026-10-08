/* eslint-disable no-console */
/**
 * [AB.12] EL REPARTO DEL SOBRANTE DE RED — con su prueba NEGATIVA.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 * `criticalStock()` y `summary()` (pantallas /almacen/autoabasto y /compras/existencia) calculan
 * cuánto del faltante de una sucursal se cubre con el sobrante de OTRAS (`transfer_in`). Antes
 * cada sucursal se quedaba con el sobrante ENTERO: si sobraban 10 cajas y a tres sucursales les
 * faltaban 10, las tres salían «Traspaso» por 10. Medido en prod el 2026-10-07:
 *     1,819 de 4,157 productos prometidos de más
 *     600,838 unidades prometidas contra 445,017 que existen
 *
 * Ahora cada sucursal recibe su parte PROPORCIONAL — `faltante × min(1, sobrante ÷ Σ faltantes)`,
 * el mismo reparto que `transferPlan()` ya aplicaba al stock del CEDIS (RA-PRO.29.1).
 *
 * ⚠️ Las fórmulas de abajo son COPIA de `networkSurplus()` y `transferIn()` en
 * `libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts`. Si se
 * cambia una, se cambia la otra.
 *
 * Los cuatro bloques:
 *   1. NEGATIVO sintético — tres sucursales compiten por 10 cajas: la fórmula vieja promete 30 y
 *      la nueva 10. Corre siempre, sin depender de los datos.
 *   2. Conservación sobre los datos REALES — por producto, Σ traspaso = min(sobrante, Σ faltantes).
 *   3. Por renglón — traspaso + compra = faltante (nada se pierde ni se inventa).
 *   4. NEGATIVO real — la fórmula vieja SÍ promete de más sobre estos mismos datos (si no, el
 *      bloque 2 no estaría probando nada y se declara NO MEDIDO).
 *
 * Sólo LEE.
 */
const path = require('path');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* dotenv opcional: el runner puede traer el env ya cargado */ }

let ok = 0; let fail = 0; let nm = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const ND = (msg) => { nm++; console.log(`  · NO MEDIDO — ${msg}`); };

const OH = '(COALESCE(s.quantity,0) - COALESCE(s.reserved_quantity,0))';
const IT = 'COALESCE(rpl.transit_eff_cajas, rpl.transit_cajas, 0) * COALESCE(rpl.bf, 1)';
// Base por defecto de la mesa (`target_basis` ausente → 'max').
const SUG = `GREATEST(0, rp.max_stock - ${OH} - ${IT})`;
const SURH = `GREATEST(0, ${OH} - rp.max_stock)`;

/** Copia de transferIn(): la parte proporcional. */
const tinNuevo = (sug, surH) => `(CASE WHEN ${surH} > 0 OR COALESCE(sbp.need_total, 0) <= 0 THEN 0
  ELSE ${sug} * LEAST(1.0, COALESCE(sbp.surplus_total, 0) / sbp.need_total) END)`;
/** La fórmula de ANTES: el sobrante entero para cada sucursal. */
const tinViejo = (sug, surH) => `LEAST(${sug}, GREATEST(0, COALESCE(sbp.surplus_total,0) - ${surH}))`;

/** Renglones de la red completa con su traspaso nuevo y viejo. */
function renglones() {
  return `
    WITH sbp AS (
      SELECT rp.product_id,
             SUM(${SURH}) AS surplus_total,
             SUM(CASE WHEN ${SURH} > 0 THEN 0 ELSE ${SUG} END) AS need_total
        FROM commercial.reorder_policy rp
        LEFT JOIN commercial.stock s ON s.tenant_id = rp.tenant_id AND s.warehouse_id = rp.warehouse_id AND s.product_id = rp.product_id
        LEFT JOIN analytics.replenishment_plan rpl ON rpl.tenant_id = rp.tenant_id AND rpl.warehouse_id = rp.warehouse_id AND rpl.product_id = rp.product_id
       WHERE rp.tenant_id = $1
       GROUP BY rp.product_id)
    SELECT rp.product_id, sbp.surplus_total, sbp.need_total,
           ${SUG} AS sug, ${tinNuevo(SUG, SURH)} AS tin, ${tinViejo(SUG, SURH)} AS tin_viejo
      FROM commercial.reorder_policy rp
      LEFT JOIN commercial.stock s ON s.tenant_id = rp.tenant_id AND s.warehouse_id = rp.warehouse_id AND s.product_id = rp.product_id
      LEFT JOIN analytics.replenishment_plan rpl ON rpl.tenant_id = rp.tenant_id AND rpl.warehouse_id = rp.warehouse_id AND rpl.product_id = rp.product_id
      JOIN sbp ON sbp.product_id = rp.product_id
     WHERE rp.tenant_id = $1`;
}

(async () => {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) { console.log('NO MEDIDO — sin DATABASE_URL_NEW/DATABASE_URL'); process.exit(0); }
  const c = new Client({
    connectionString: cs,
    ssl: /localhost|127\.0\.0\.1|pg-prod|192\.168\./.test(cs) ? false : { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query(`SET statement_timeout = '120s'`);

  // ── 1) NEGATIVO sintético: tres sucursales piden 10, la red tiene 10 ─────────────────────
  console.log('\n1) NEGATIVO sintético — tres sucursales compiten por 10 cajas');
  const sint = (await c.query(`
    WITH sbp AS (SELECT 10::numeric AS surplus_total, 30::numeric AS need_total),
         f AS (SELECT 10::numeric AS sug, 0::numeric AS surh FROM generate_series(1, 3))
    SELECT SUM(${tinNuevo('f.sug', 'f.surh')}) AS nuevo, SUM(${tinViejo('f.sug', 'f.surh')}) AS viejo
      FROM f, sbp`)).rows[0];
  A(Number(sint.viejo) === 30, `la fórmula vieja promete 30 cajas de 10 (dio ${sint.viejo}) — el defecto se reproduce`);
  A(Math.abs(Number(sint.nuevo) - 10) < 1e-9, `la nueva reparte exactamente las 10 que hay (dio ${Number(sint.nuevo)})`);

  // El tenant con más políticas: así el test sirve en cualquier entorno sin UUID clavado.
  const t = (await c.query(`
    SELECT tenant_id::text AS id, count(*)::int AS n
      FROM commercial.reorder_policy GROUP BY 1 ORDER BY n DESC LIMIT 1`)).rows[0];
  if (!t || !t.n) {
    ND('commercial.reorder_policy está vacía — sin datos reales no hay reparto que medir (bloques 2-4)');
    console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
    await c.end(); process.exit(fail ? 1 : 0);
  }
  console.log(`\ntenant ${t.id} · ${t.n.toLocaleString('es-MX')} políticas de reorden`);

  // ── 2) Conservación por producto ─────────────────────────────────────────────────────────
  console.log('\n2) por producto, Σ traspaso = min(sobrante, Σ faltantes) — sobre los datos REALES');
  const p = (await c.query(`
    WITH r AS (${renglones()}),
         p AS (SELECT product_id, MAX(surplus_total) pool, MAX(need_total) need, SUM(tin) tin, SUM(tin_viejo) tin_viejo
                 FROM r GROUP BY product_id)
    SELECT count(*)::int AS productos,
           count(*) FILTER (WHERE tin > 0)::int AS con_traspaso,
           count(*) FILTER (WHERE tin > pool + 0.001)::int AS de_mas,
           count(*) FILTER (WHERE abs(tin - LEAST(pool, need)) > 0.001)::int AS no_conserva,
           count(*) FILTER (WHERE tin_viejo > pool + 0.001)::int AS de_mas_viejo,
           ROUND(SUM(tin))::bigint AS prometido, ROUND(SUM(LEAST(pool, need)))::bigint AS repartible,
           ROUND(SUM(tin_viejo))::bigint AS prometido_viejo
      FROM p`, [t.id])).rows[0];
  console.log(`  ${p.con_traspaso} productos con traspaso · prometido ${Number(p.prometido).toLocaleString('es-MX')} · repartible ${Number(p.repartible).toLocaleString('es-MX')}`);
  if (!p.con_traspaso) {
    ND('ningún producto tiene sobrante y faltante a la vez — no hay reparto que comprobar');
  } else {
    A(p.de_mas === 0, `ningún producto promete más de lo que sobra en la red (${p.de_mas} de más)`);
    A(p.no_conserva === 0, `Σ traspaso = min(sobrante, Σ faltantes) en todos (${p.no_conserva} fuera)`);
  }

  // ── 3) Por renglón ───────────────────────────────────────────────────────────────────────
  console.log('\n3) por renglón — traspaso + compra = faltante, y el traspaso nunca pasa el faltante');
  const r = (await c.query(`
    WITH r AS (${renglones()})
    SELECT count(*) FILTER (WHERE tin > sug + 0.001 OR tin < -0.001)::int AS fuera
      FROM r`, [t.id])).rows[0];
  A(r.fuera === 0, `0 ≤ traspaso ≤ faltante en todos los renglones (${r.fuera} fuera); la compra es el residuo`);

  // ── 4) NEGATIVO real ─────────────────────────────────────────────────────────────────────
  console.log('\n4) NEGATIVO real — la fórmula vieja sobre estos mismos datos');
  if (!p.de_mas_viejo) {
    ND('ninguna sucursal compite hoy por el mismo sobrante — el bloque 2 pasaría también con la fórmula vieja');
  } else {
    A(p.de_mas_viejo > 0, `la fórmula vieja promete de más en ${p.de_mas_viejo} productos (${Number(p.prometido_viejo).toLocaleString('es-MX')} unidades) — el bloque 2 SÍ distingue`);
  }

  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e.message); process.exit(1); });
