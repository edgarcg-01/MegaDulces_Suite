/* eslint-disable no-console */
/**
 * DIAG (read-only) — ¿cuánto guarda Kepler de una solicitud de gasto, y cuánto usamos?
 *
 * `analytics.expense_requests` expone 8 columnas de `kdm1` (c6 folio, c9 fecha, c16 importe,
 * c48 solicitante, c32 beneficiario, c24 concepto, c43 estado, c67 usuario). Esto barre TODAS
 * las cN de X-A-15 (solicitud) y X-A-10 (el gasto que la aplica) para ver qué más trae dato,
 * y si `kdm2` tiene renglones. ★ = Kepler lo guarda y NO lo estamos usando.
 *
 * Copia las filas del doctype a una TEMP TABLE: son pocas y evita rescanear kdm1 por columna.
 * Uso:  node database/importers/_diag-xa15-kepler-fields.js [NOMBRE_VAR_URL]
 *       (default FLEET_DB_URL = prod; el kepler_ods vive ahí)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const URL_VAR = process.argv[2] || 'FLEET_DB_URL';
const DOCS = [
  { tag: 'x15', name: 'X-A-15-1 · SOLICITUD de gasto (XA1501)', c4: '15' },
  { tag: 'x10', name: 'X-A-10-1 · GASTO que la aplica (XA1001)', c4: '10' },
];
// Lo que la vista analytics.expense_requests ya expone.
const USADAS = new Set(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c9', 'c16', 'c24', 'c32', 'c43', 'c48', 'c67']);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

(async () => {
  const cs = process.env[URL_VAR];
  if (!cs) { console.error(`Falta ${URL_VAR} en .env`); process.exit(1); }
  const pg = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  try { const u = new URL(cs); console.log(`base: ${u.hostname}:${u.port || 5432}${u.pathname}  (via ${URL_VAR})\n`); } catch { /* noop */ }

  const cols = async (t) => (await pg.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='kepler_ods' AND table_name=$1 ORDER BY ordinal_position`, [t])).rows.map((r) => r.column_name);
  const k1 = await cols('kdm1');
  const k2 = await cols('kdm2');
  if (!k1.length) { console.log('kepler_ods.kdm1 no existe acá.'); await pg.end(); return; }
  const cn1 = k1.filter((c) => /^c\d+$/.test(c));
  const cn2 = k2.filter((c) => /^c\d+$/.test(c));
  console.log(`kepler_ods.kdm1: ${k1.length} columnas (${cn1.length} cN) · kdm2: ${k2.length} (${cn2.length} cN)`);

  for (const d of DOCS) {
    await pg.query(`CREATE TEMP TABLE _${d.tag} AS
      SELECT * FROM kepler_ods.kdm1
       WHERE c2='X' AND c3='A' AND btrim(c4::text)=$1 AND btrim(c5::text)='1'
         AND btrim(c1::text)=sucursal::text`, [d.c4]);
    const { rows: [n] } = await pg.query(
      `SELECT count(*)::int n, min(c9::text) d1, max(c9::text) d2, count(DISTINCT sucursal)::int suc FROM _${d.tag}`);
    console.log(`\n${'='.repeat(100)}\n${d.name} — ${n.n.toLocaleString('es-MX')} docs · ${n.suc} sucursales · ${n.d1} → ${n.d2}\n${'='.repeat(100)}`);
    if (!n.n) continue;

    const sel = cn1.map((c) => `count(nullif(btrim(${c}::text),''))::int AS ${c}`).join(', ');
    const { rows: [fill] } = await pg.query(`SELECT ${sel} FROM _${d.tag}`);
    const vivos = cn1.filter((c) => fill[c] > 0).sort((a, b) => fill[b] - fill[a]);
    console.log(`con dato: ${vivos.length}/${cn1.length} columnas · ★ = Kepler lo guarda y NO lo usamos\n`);
    console.log(`  ${pad('col', 7)}${pad('%', 6)}${pad('distintos', 11)}muestras (valor más común primero)`);
    console.log(`  ${'-'.repeat(96)}`);
    for (const c of vivos) {
      const { rows: dv } = await pg.query(
        `SELECT btrim(${c}::text) v, count(*)::int k FROM _${d.tag}
          WHERE nullif(btrim(${c}::text),'') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 3`);
      const { rows: [u] } = await pg.query(`SELECT count(DISTINCT btrim(${c}::text))::int u FROM _${d.tag}`);
      const muestras = dv.map((r) => `${r.v.slice(0, 24)}${r.v.length > 24 ? '…' : ''}`).join(' | ');
      console.log(`  ${USADAS.has(c) ? '·' : '★'} ${pad(c, 5)}${pad(((100 * fill[c]) / n.n).toFixed(0) + '%', 6)}${pad(u.u, 11)}${muestras}`);
    }
  }

  // Renglones de la solicitud
  if (cn2.length) {
    const { rows: [l] } = await pg.query(`
      SELECT count(*)::int n, count(DISTINCT (l.sucursal, btrim(l.c6::text)))::int docs
        FROM kepler_ods.kdm2 l
       WHERE l.c2='X' AND l.c3='A' AND btrim(l.c4::text)='15'`);
    console.log(`\n${'='.repeat(100)}\nRENGLONES kdm2 de X-A-15: ${l.n.toLocaleString('es-MX')} en ${l.docs.toLocaleString('es-MX')} documentos`);
    if (l.n) {
      await pg.query(`CREATE TEMP TABLE _l15 AS SELECT * FROM kepler_ods.kdm2 WHERE c2='X' AND c3='A' AND btrim(c4::text)='15'`);
      const sel2 = cn2.map((c) => `count(nullif(btrim(${c}::text),''))::int AS ${c}`).join(', ');
      const { rows: [f2] } = await pg.query(`SELECT ${sel2} FROM _l15`);
      const vivos2 = cn2.filter((c) => f2[c] > 0).sort((a, b) => f2[b] - f2[a]);
      console.log(`  ${pad('col', 7)}${pad('%', 6)}${pad('distintos', 11)}muestras`);
      console.log(`  ${'-'.repeat(96)}`);
      for (const c of vivos2) {
        const { rows: dv } = await pg.query(
          `SELECT btrim(${c}::text) v, count(*)::int k FROM _l15
            WHERE nullif(btrim(${c}::text),'') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 3`);
        const { rows: [u] } = await pg.query(`SELECT count(DISTINCT btrim(${c}::text))::int u FROM _l15`);
        console.log(`  ★ ${pad(c, 5)}${pad(((100 * f2[c]) / l.n).toFixed(0) + '%', 6)}${pad(u.u, 11)}${dv.map((r) => r.v.slice(0, 24)).join(' | ')}`);
      }
    }
  }

  await pg.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
