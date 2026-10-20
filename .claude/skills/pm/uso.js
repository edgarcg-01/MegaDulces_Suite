#!/usr/bin/env node
// ¿Alguien usa esto? Llamadas reales a la API por ruta, desde analytics.ui_usage (pg-prod, SÓLO LECTURA).
//   node .claude/skills/pm/uso.js <fragmento-de-ruta> [días=30]
//   ej: node .claude/skills/pm/uso.js sales-documents
// ui_usage la llena el interceptor de la API (usage-metrics.interceptor.ts): cuenta HITS por
// (día, método, ruta, rol). No dice QUIÉN (persona), sí qué ROL. Una ruta sin filas = nadie la llamó.
const path = require('path');
const raiz = path.resolve(__dirname, '..', '..', '..');
require(path.join(raiz, 'node_modules/dotenv')).config({ path: path.join(raiz, '.env'), quiet: true });
const { Client } = require(path.join(raiz, 'node_modules/pg'));

const [frag, dias = '30'] = process.argv.slice(2);
if (!frag) { console.error('uso: node uso.js <fragmento-de-ruta> [días]'); process.exit(2); }
(async () => {
  const c = new Client({ connectionString: process.env.PROD_DB_URL, statement_timeout: 20000 });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== '7688376744939610156') { console.error(`⛔ No es pg-prod (${id}).`); process.exit(3); }
    const cob = (await c.query('SELECT min(fecha) AS desde, max(fecha) AS hasta FROM analytics.ui_usage')).rows[0];
    const r = await c.query(
      `SELECT metodo, ruta, sum(hits)::int AS hits, count(DISTINCT fecha)::int AS dias_con_uso,
              max(fecha)::date AS ultimo, string_agg(DISTINCT role_name, ', ') AS roles, sum(errores)::int AS errores
         FROM analytics.ui_usage
        WHERE ruta ILIKE '%' || $1 || '%' AND fecha >= current_date - $2::int
        GROUP BY 1, 2 ORDER BY 3 DESC`, [frag, dias]);
    console.log(`ui_usage cubre ${cob.desde?.toISOString?.().slice(0, 10)} → ${cob.hasta?.toISOString?.().slice(0, 10)} · ruta ~ "${frag}" · últimos ${dias} días`);
    if (!r.rows.length) console.log('SIN LLAMADAS en la ventana (nadie usó esa ruta por la API).');
    else console.table(r.rows.map((x) => ({ ...x, ultimo: x.ultimo.toISOString().slice(0, 10) })));
    await c.query('ROLLBACK');
  } finally { await c.end(); }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
