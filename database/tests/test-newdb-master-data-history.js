/* eslint-disable no-console */
/**
 * [VP.3.1] CANDADO — el cambio de un dato maestro deja rastro (ADR-056).
 *
 * ── LO QUE ESTE TEST EXISTE PARA QUE NO VUELVA ───────────────────────────────────────────
 * Medido el 2026-09-05: **cero** historial para precio, costo, punto de reorden, precio de etiqueta
 * y factor de caja. Los ~11 importers que escriben esas tablas hacen UPSERT ciego; **cero** setean
 * `updated_by` (existe en 3 de 4 y MIENTE) y **cero** conservan el valor anterior.
 * `import-computed-reorder.js` e `import-network-reorder.js` pisan **9 columnas de política de
 * golpe**: si un punto de reorden pasa de 40 a 12 y dispara una requisición equivocada, no había
 * forma de saber que era 40.
 *
 * ── LO QUE CANDADEA, Y POR QUÉ CADA UNO ──────────────────────────────────────────────────
 *  1. Los 4 triggers EXISTEN y vigilan exactamente las columnas declaradas. Una columna que se cae
 *     de la lista es un hueco MUDO: nada falla, la historia sale incompleta.
 *  2. El diff trae `antes` y `despues` de verdad — no basta con que haya fila.
 *  3. Un UPDATE **no-op** no deja rastro (los importers hacen miles) y tocar una columna no vigilada
 *     tampoco: si ensuciaran, los cambios de verdad quedarían enterrados.
 *  4. El `tenant_id` sale de LA FILA, no de la sesión. Los importers corren como `postgres` sin
 *     `app.tenant_id`; colgarlo de un GUC habría tumbado los feeds la primera noche.
 *  5. `app_runtime` puede INSERT y SELECT pero **NO** UPDATE/DELETE: una historia que se puede
 *     editar no es una historia.
 *  6. La historia participa de la transacción — no es un side-effect que sobreviva a un ROLLBACK.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-master-data-history.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

/** Espejo de `VIGILADAS` en la migración 20260907130000. Si divergen, la historia miente por omisión. */
const VIGILADAS = {
  'commercial.product_prices': ['price', 'tax_rate', 'min_qty'],
  'commercial.product_label_prices': [
    'piece_price', 'wholesale_piece_price', 'pack_price', 'wholesale_pack_price',
    'box_price', 'box_size', 'barcode',
  ],
  'commercial.reorder_policy': [
    'min_stock', 'reorder_point', 'max_stock', 'lead_time_days', 'safety_stock',
    'service_level', 'abc_class', 'xyz_class',
  ],
  'catalog.products': [
    'nombre', 'barcode', 'factor_sale', 'factor_purchase',
    'cost_base', 'cost_with_tax', 'cost_per_case',
  ],
};

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar a la base — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== VP.3.1 · el cambio de un dato maestro deja rastro ===\n');

  const existe = (await q(`SELECT to_regclass('analytics.master_data_history') IS NOT NULL AS ok`))[0];
  if (!existe.ok) noMedido('falta la migración 20260907130000 en este destino');
  ck('analytics.master_data_history existe', true);

  // ── 1. Los triggers vigilan EXACTAMENTE lo declarado ──────────────────────────────────
  console.log('\n1 · COBERTURA (una columna que se cae de la lista es un hueco mudo)');
  for (const [tabla, cols] of Object.entries(VIGILADAS)) {
    const [schema, name] = tabla.split('.');
    const t = await q(`
      SELECT p.proname, t.tgargs, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname = $1 AND cl.relname = $2 AND t.tgname = 'trg_master_data_history'`,
    [schema, name]);
    if (!t.length) {
      const hay = (await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [tabla]))[0].ok;
      ck(`${tabla}: trigger presente`, false, hay ? 'la tabla existe pero SIN trigger' : 'la tabla no existe en este destino');
      continue;
    }
    ck(`${tabla}: trigger presente`, true);
    const def = t[0].def;
    const faltan = cols.filter((col) => !def.includes(`'${col}'`));
    ck(`${tabla}: vigila las ${cols.length} columnas declaradas`, faltan.length === 0,
      faltan.length ? `no vigila: ${faltan.join(', ')}` : '');
    ck(`${tabla}: dispara en UPDATE y DELETE`, /UPDATE/.test(def) && /DELETE/.test(def));
  }

  // ── 2. El comportamiento, contra la DB real y dentro de una transacción ───────────────
  console.log('\n2 · COMPORTAMIENTO');
  const before = (await q(`SELECT count(*)::int n FROM analytics.master_data_history`))[0].n;
  const row = (await q(`SELECT id, tenant_id, price FROM commercial.product_prices ORDER BY id LIMIT 1`))[0];
  if (!row) noMedido('sin filas en commercial.product_prices con qué ejercitar el trigger');

  await c.query('BEGIN');
  try {
    await c.query(`UPDATE commercial.product_prices SET price = price + 1.23 WHERE id=$1`, [row.id]);
    const h = await q(
      `SELECT * FROM analytics.master_data_history
        WHERE tabla='commercial.product_prices' AND pk=$1 ORDER BY id DESC LIMIT 1`, [String(row.id)]);
    ck('un UPDATE de precio deja UNA fila de historia', h.length === 1);
    if (h.length) {
      ck('registra el valor ANTERIOR', Number(h[0].diff.price.antes) === Number(row.price),
        `antes=${h[0].diff?.price?.antes} esperado=${row.price}`);
      ck('registra el valor NUEVO',
        Math.abs(Number(h[0].diff.price.despues) - (Number(row.price) + 1.23)) < 0.001);
      ck('registra el rol de DB que escribió (app_runtime vs postgres)', !!h[0].db_role);
      ck('el tenant sale de la FILA, no de la sesión', h[0].tenant_id === row.tenant_id);
      ck('op = UPDATE', h[0].op === 'UPDATE');
      ck('sólo el campo que cambió entra al diff', Object.keys(h[0].diff).join(',') === 'price',
        Object.keys(h[0].diff).join(','));
    }

    const n1 = (await q(`SELECT count(*)::int n FROM analytics.master_data_history`))[0].n;
    await c.query(`UPDATE commercial.product_prices SET price = price WHERE id=$1`, [row.id]);
    const n2 = (await q(`SELECT count(*)::int n FROM analytics.master_data_history`))[0].n;
    ck('un UPDATE no-op NO deja fila', n1 === n2, `${n1} → ${n2}`);

    await c.query(`UPDATE commercial.product_prices SET updated_at = now() WHERE id=$1`, [row.id]);
    const n3 = (await q(`SELECT count(*)::int n FROM analytics.master_data_history`))[0].n;
    ck('tocar una columna NO vigilada tampoco', n2 === n3, `${n2} → ${n3}`);

    await c.query(`SET LOCAL app.actor = 'importer:prueba'`);
    await c.query(`UPDATE commercial.product_prices SET price = price + 2 WHERE id=$1`, [row.id]);
    const a = (await q(`SELECT actor FROM analytics.master_data_history ORDER BY id DESC LIMIT 1`))[0];
    ck('si el escritor declara app.actor, queda registrado', a.actor === 'importer:prueba', `actor=${a.actor}`);
  } finally {
    await c.query('ROLLBACK');
  }
  const after = (await q(`SELECT count(*)::int n FROM analytics.master_data_history`))[0].n;
  ck('la historia participa de la transacción (ROLLBACK la revierte)', after === before, `${before} → ${after}`);

  // ── 3. No se puede reescribir ─────────────────────────────────────────────────────────
  console.log('\n3 · INMUTABILIDAD');
  const g = (await q(`
    SELECT privilege_type FROM information_schema.table_privileges
     WHERE table_schema='analytics' AND table_name='master_data_history' AND grantee='app_runtime'`))
    .map((r) => r.privilege_type).sort();
  ck('app_runtime tiene INSERT+SELECT y NADA más', g.join(',') === 'INSERT,SELECT', g.join(','));

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
