/* eslint-disable no-console */
/**
 * [SD.1] CANDADO del doble linaje de ventas — el imperativo vs el ODS-derivado.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────────
 * `analytics.sales_daily` (3.76 GB, poblada por importer) y `analytics.mv_sales_blended` (matview
 * derivada del ODS) son el MISMO hecho de venta por dos caminos. 65 servicios leen la tabla; la Fase
 * SD los va a migrar al linaje ODS. Antes de mover un lector hay que probar que el twin ODS es
 * INTERCAMBIABLE con la tabla — y que el target NO se equivoca de vista.
 *
 * ── EL ERROR QUE ESTE CANDADO CONGELA (SD.0, medido en PROD 2026-09-14) ───────────────────────
 * El diseño de SD nombraba `mv_kepler_sales_daily` como target. Es INCOMPLETO: sólo trae las ramas
 * fijas (source_branch 01-07). Le faltan los 6 almacenes `kind='truck'` (RUTA-21..28 Kepler +
 * RUTA-3xx/5xx Wincaja) que entran por push→mart (`route_push_lines`) con `kepler_code=null` (no
 * replican a `kepler_ods`). Migrar un lector a `mv_kepler_sales_daily` tiraría **$3.62M/mes de venta
 * de ruta Kepler (~12%)** en silencio. El twin correcto es `mv_sales_blended`, que SÍ trae la ruta.
 *
 * ── LAS CUATRO PREGUNTAS ──────────────────────────────────────────────────────────────────────
 *  1. ¿Existen y están pobladas las dos piernas? (si no → NO MEDIDO, no ✔)
 *  2. ¿El twin ODS (`mv_sales_blended`) empata con la tabla en meses cerrados? (intercambiable)
 *  3. ¿El twin trae la venta de RUTA idéntica a la tabla? (la pierna que el target viejo perdía)
 *  4. ¿`mv_kepler_sales_daily` es estructuralmente ciego a la ruta? (prueba NEGATIVA: nunca un truck)
 *
 * ── UMBRALES CALIBRADOS, no elegidos (medido en PROD 2026-09-14) ──────────────────────────────
 * Total tabla↔blended: jul-2026 Δ 0.012% · ago-2026 Δ 0.191%. Umbral 0.5% (baseline + holgura del
 * asentamiento de mes reciente: la rama 02 llega a 1.95% en ago y baja a 0.30% en jul al asentarse).
 * La ruta empata EXACTA ($0) → umbral $1. La venta de truck en la tabla: ~$4.4M/mes → material.
 *
 *   node database/tests/test-newdb-sales-lineage-parity.js   (cae a FLEET_DB_URL del .env si no hay env)
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';

// Resolución de URL: el runner exporta DATABASE_URL_NEW; standalone cae a FLEET_DB_URL del .env
// (read-only, con assert de prod) para no exponer la credencial en el shell (el footgun de la trampa).
function resolveUrl() {
  if (process.env.DATABASE_URL_NEW) return process.env.DATABASE_URL_NEW;
  if (process.env.DST_URL) return process.env.DST_URL;
  try {
    const fs = require('fs'); const path = require('path');
    const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
    const m = env.match(/^FLEET_DB_URL=(.*)$/m);
    if (m) {
      const url = m[1].trim();
      const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');
      if (classify(url).kind !== 'prod') throw new Error('FLEET_DB_URL del .env no clasifica como prod');
      console.log('  ⓘ sin DATABASE_URL_NEW: uso FLEET_DB_URL del .env (prod, read-only)');
      return url;
    }
  } catch (e) { throw new Error('falta la URL de la DB destino (DATABASE_URL_NEW) y no pude leer FLEET_DB_URL: ' + e.message); }
  throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW');
}

const UMBRAL_TOTAL_PCT = Number(process.env.SD1_UMBRAL_TOTAL_PCT) || 0.5;   // calibrado: jul 0.012% · ago 0.191% (2026-09-14)
const UMBRAL_RUTA_$ = 1;        // la ruta empata al peso
const RUTA_MATERIAL_$ = 1_000_000; // la venta de truck/mes es material (~$4.4M)
// [SD.4b] tickets: mv_sales_blended cuenta folios desde el ODS. Calibrado 2026-09-14 (post --apply):
// ago 0.32% · jul 0.01%. El ~1-2% de holgura es el sobre-conteo por unidad de sales_daily (documentado).
const UMBRAL_TICKETS_PCT = Number(process.env.SD1_UMBRAL_TICKETS_PCT) || 2;

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const URL = resolveUrl();
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== DOBLE LINAJE DE VENTAS · sales_daily (importer) vs mv_sales_blended (ODS) ===\n');

  // ── 1. ¿existen y están pobladas? ──────────────────────────────────────────────────────────
  console.log('1 · EXISTENCIA Y POBLACIÓN');
  const objs = await q(
    `SELECT c.relname, c.relkind, c.relispopulated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='analytics' AND c.relname IN ('sales_daily','mv_sales_blended','mv_kepler_sales_daily')`);
  const tiene = (n) => objs.some((o) => o.relname === n && (o.relkind === 'r' || o.relkind === 'v' || o.relispopulated));
  check('analytics.sales_daily existe', tiene('sales_daily'));
  check('analytics.mv_sales_blended existe y está poblada', tiene('mv_sales_blended'));
  check('analytics.mv_kepler_sales_daily existe', tiene('mv_kepler_sales_daily'));

  // meses CERRADOS con dato en las dos piernas (los 2 más recientes)
  const meses = tiene('mv_sales_blended') ? await q(`
    SELECT to_char(date_trunc('month', sale_date), 'YYYY-MM') mes
      FROM analytics.mv_sales_blended
     WHERE tenant_id=$1 AND sale_date < date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City'))
     GROUP BY 1 ORDER BY 1 DESC LIMIT 2`, [T]) : [];
  if (!meses.length) { noMedido('paridad de meses cerrados', 'mv_sales_blended sin meses cerrados con dato'); }

  // ── 2. el twin ODS empata con la tabla (intercambiable) ──────────────────────────────────────
  console.log('\n2 · INTERCAMBIABILIDAD (tabla ↔ mv_sales_blended, meses cerrados)');
  for (const { mes } of meses) {
    const r = (await q(`
      SELECT
        (SELECT COALESCE(sum(revenue),0) FROM analytics.sales_daily
          WHERE tenant_id=$1 AND to_char(sale_date,'YYYY-MM')=$2)::numeric AS tabla,
        (SELECT COALESCE(sum(revenue),0) FROM analytics.mv_sales_blended
          WHERE tenant_id=$1 AND to_char(sale_date,'YYYY-MM')=$2)::numeric AS blended`, [T, mes]))[0];
    const tabla = Number(r.tabla), blended = Number(r.blended);
    const pct = tabla ? Math.abs(tabla - blended) / tabla * 100 : 999;
    check(`${mes}: |tabla − blended| ≤ ${UMBRAL_TOTAL_PCT}% (Δ ${pct.toFixed(3)}%)`, pct <= UMBRAL_TOTAL_PCT,
      `tabla $${Math.round(tabla).toLocaleString()} blended $${Math.round(blended).toLocaleString()}`);
  }

  // ── 3. el twin trae la RUTA idéntica (la pierna que el target viejo perdía) ───────────────────
  console.log('\n3 · COBERTURA DE RUTA en el twin (los almacenes kind=truck empatan al peso)');
  if (!meses.length) { noMedido('cobertura de ruta', 'sin meses cerrados'); }
  for (const { mes } of meses) {
    const r = (await q(`
      WITH trucks AS (SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND kind='truck')
      SELECT
        (SELECT COALESCE(sum(revenue),0) FROM analytics.sales_daily s
           WHERE s.tenant_id=$1 AND to_char(s.sale_date,'YYYY-MM')=$2 AND s.warehouse_id IN (SELECT id FROM trucks))::numeric AS t_ruta,
        (SELECT COALESCE(sum(revenue),0) FROM analytics.mv_sales_blended b
           WHERE b.tenant_id=$1 AND to_char(b.sale_date,'YYYY-MM')=$2 AND b.warehouse_id IN (SELECT id FROM trucks))::numeric AS b_ruta`, [T, mes]))[0];
    const tr = Number(r.t_ruta), br = Number(r.b_ruta);
    check(`${mes}: ruta(truck) blended == tabla (Δ $${Math.round(Math.abs(tr - br)).toLocaleString()})`, Math.abs(tr - br) <= UMBRAL_RUTA_$,
      `tabla $${Math.round(tr).toLocaleString()} blended $${Math.round(br).toLocaleString()}`);
    check(`${mes}: la venta de ruta es material (> $${(RUTA_MATERIAL_$ / 1e6).toFixed(0)}M) → migrar mal la perdería`, tr > RUTA_MATERIAL_$,
      `ruta tabla $${Math.round(tr).toLocaleString()}`);
  }

  // ── 4. PRUEBA NEGATIVA: mv_kepler_sales_daily es ciego a la ruta ──────────────────────────────
  // El target viejo. Su source_branch es SÓLO ramas fijas (00-07): estructuralmente no puede
  // representar un truck. Si mañana aparece un truck acá, o el hueco desaparece, este bloque avisa.
  console.log('\n4 · PRUEBA NEGATIVA · mv_kepler_sales_daily NO puede ver la ruta (target equivocado)');
  const brs = (await q(`SELECT DISTINCT source_branch FROM analytics.mv_kepler_sales_daily WHERE tenant_id=$1`, [T])).map((r) => r.source_branch);
  const soloRamasFijas = brs.every((b) => /^0[0-7]$/.test(String(b)));
  check('mv_kepler_sales_daily sólo tiene ramas fijas 00-07 (ningún truck)', soloRamasFijas,
    `source_branch = ${brs.join(',')}`);
  // y existe venta de truck material que por lo tanto le es invisible
  const truckRev = Number((await q(`
    SELECT COALESCE(sum(s.revenue),0)::numeric r FROM analytics.sales_daily s
      JOIN commercial.warehouses w ON w.id=s.warehouse_id
     WHERE s.tenant_id=$1 AND w.kind='truck' AND s.sale_date >= date_trunc('month',(now() AT TIME ZONE 'America/Mexico_City')) - interval '1 month'`, [T]))[0].r);
  check('hay venta de truck material invisible a mv_kepler (migrar ahí la perdería)', truckRev > RUTA_MATERIAL_$,
    `truck 30d≈ $${Math.round(truckRev).toLocaleString()}`);

  // ── 5. paridad de TICKETS/folios (SD.4b: el blend cuenta folios desde el ODS, no 0) ─────────────
  // Antes de SD.4b las piernas Kepler/Wincaja hardcodeaban 0 → 20× corto. Ahora cuentan folios desde
  // v_kepler_ticket_count (kdm1) + v_wincaja_ticket_count (v_sales_lines). Es la última dependencia que
  // sales_daily le imponía al Command Center. Si un destino no aplicó SD.4b, tickets=0 → NO MEDIDO.
  console.log('\n5 · TICKETS/FOLIOS (mv_sales_blended cuenta folios del ODS — SD.4b)');
  for (const { mes } of meses) {
    const r = (await q(`SELECT
      (SELECT COALESCE(sum(tickets),0) FROM analytics.sales_daily     WHERE tenant_id=$1 AND to_char(sale_date,'YYYY-MM')=$2)::bigint sd,
      (SELECT COALESCE(sum(tickets),0) FROM analytics.mv_sales_blended WHERE tenant_id=$1 AND to_char(sale_date,'YYYY-MM')=$2)::bigint mb`, [T, mes]))[0];
    const sd = Number(r.sd), mb = Number(r.mb);
    if (mb === 0) { noMedido(`paridad de tickets ${mes}`, 'mv_sales_blended.tickets = 0 (SD.4b no aplicado en este destino)'); continue; }
    const off = sd ? Math.abs(sd - mb) / sd * 100 : 999;
    check(`${mes}: |tickets tabla − blended| ≤ ${UMBRAL_TICKETS_PCT}% (Δ ${off.toFixed(2)}%)`, off <= UMBRAL_TICKETS_PCT,
      `sd=${sd.toLocaleString()} mb=${mb.toLocaleString()}`);
  }
  if (!meses.length) noMedido('paridad de tickets', 'sin meses cerrados');

  await c.end();
  const resumen = `${ok} OK · ${fail} falla(s)` + (nm ? ` · ${nm} NO MEDIDO(S)` : '');
  console.log(`\n  ${resumen}\n`);
  if (nm) console.log('  ⓘ "NO MEDIDO" no es "pasó": en este destino no había con qué comprobarlo.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
