/* eslint-disable no-console */
/**
 * [VP.5.4] CANDADO — un solo ledger de migraciones (GOTCHAS §29).
 *
 * ── LO QUE ESTE TEST EXISTE PARA QUE NO VUELVA ───────────────────────────────────────────
 * El `search_path` de la base arranca en `identity`. Un cliente knex que corra migraciones **sin**
 * `schemaName` escribe su ledger en `identity.knex_migrations`, que el knexfile real
 * (`schemaName: 'public'`) no lee. Queda el peor de los dos mundos: el DDL aplicado y el CLI
 * listando esas migraciones como **pendientes**, listas para re-correrse.
 *
 * Medido en prod el 2026-09-07: **5 migraciones** vivieron semanas en la tabla fantasma. Una de
 * ellas (`sellout_monto_neto_descuento`) hace `DROP MATERIALIZED VIEW mv_kepler_sales_daily CASCADE`
 * y recrea la cadena `WITH NO DATA`; re-correrla habría dejado el sell-out sin rollup hasta el
 * refresh de las 06:20. Lo único que lo evitó fue su guard por columna — no el proceso.
 *
 * ── POR QUÉ ES UN CANDADO Y NO SÓLO UN ARREGLO ───────────────────────────────────────────
 * El código de este repo ya está bien: las 10 configuraciones llevan `schemaName`. El escritor que
 * llenaba la tabla fantasma está **fuera del repo** y no se puede arreglar desde acá. Contra eso,
 * este test es el detector: si la tabla reaparece, se sabe **al día siguiente** en vez de dentro de
 * semanas, cuando ya hay cinco fantasmas y una dropea una matvista.
 *
 * ── LOS TRES CANDADOS ────────────────────────────────────────────────────────────────────
 *  1. Existe UN solo `knex_migrations`, y está en `public`.
 *  2. Si aparece otro, se nombra CUÁNTAS filas tiene y cuáles NO están en el bueno — porque esas
 *     son las que se van a re-correr, y es la única parte urgente.
 *  3. Toda config de migraciones del repo declara `schemaName` (lo estático, que sí se puede
 *     prevenir): una nueva sin él reintroduce el problema el día que alguien la use.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-knex-ledger-unico.js
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

/** Recorre el repo buscando bloques `migrations: { … }` y devuelve los que NO declaran schemaName. */
function configsSinSchema() {
  const RAIZ = path.join(__dirname, '..', '..');
  const sin = [];
  const visitar = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', '.git', '.nx'].includes(e.name)) continue;
        visitar(p);
      } else if (e.name.endsWith('.js') || e.name.endsWith('.ts')) {
        let s;
        try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const m of s.matchAll(/migrations\s*:\s*\{/g)) {
          let i = m.index + m[0].length; let d = 1;
          while (i < s.length && d) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; }
          const blq = s.slice(m.index, i);
          if (!/tableName|knex_migrations/.test(blq)) continue;
          if (!/schemaName/.test(blq)) sin.push(path.relative(RAIZ, p).replace(/\\/g, '/'));
        }
      }
    }
  };
  for (const d of ['database', 'libs', 'apps', 'services', 'scripts', 'ops']) visitar(path.join(RAIZ, d));
  return sin;
}

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar a la base — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== VP.5.4 · un solo ledger de migraciones (GOTCHAS §29) ===\n');

  // ── 1-2. En la base ────────────────────────────────────────────────────────────────────
  const tablas = await q(`
    SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'knex_migrations' AND c.relkind = 'r' ORDER BY 1`);
  const schemas = tablas.map((t) => t.schema);
  console.log(`  ⓘ knex_migrations encontrado en: ${schemas.join(', ') || '(ninguno)'}`);

  ck('existe el ledger en public', schemas.includes('public'));
  ck('existe UN SOLO ledger (ninguna copia fantasma)', schemas.length === 1,
    schemas.length > 1 ? `hay ${schemas.length}: ${schemas.join(', ')}` : 'no hay ninguno');

  for (const s of schemas.filter((x) => x !== 'public')) {
    const n = Number((await q(`SELECT count(*)::int n FROM ${s}.knex_migrations`))[0].n);
    // Lo urgente no es que la tabla exista: es cuáles de sus filas NO están en el ledger bueno,
    // porque ésas son las que el próximo `migrate:latest` va a re-correr.
    const huer = await q(`
      SELECT i.name FROM ${s}.knex_migrations i
       WHERE NOT EXISTS (SELECT 1 FROM public.knex_migrations p WHERE p.name = i.name)
       ORDER BY i.name`);
    ck(`${s}.knex_migrations: sus ${n} fila(s) están TODAS en public (no se van a re-correr)`,
      huer.length === 0,
      huer.length ? `se re-correrían: ${huer.map((r) => r.name).join(', ')}` : '');
  }

  // ── 3. En el código (lo que sí se puede prevenir) ──────────────────────────────────────
  const sin = configsSinSchema();
  ck('toda config de migraciones del repo declara schemaName', sin.length === 0,
    sin.length ? `sin schemaName: ${[...new Set(sin)].join(', ')}` : '');

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  if (fail) {
    console.log('  Si apareció un ledger fantasma: reconciliá sus filas a public.knex_migrations y');
    console.log('  retirá la tabla (migración 20260907160000). Y buscá al escritor: es un knex sin');
    console.log('  `schemaName`, probablemente fuera de este repo (otra máquina o un comando ad-hoc).\n');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
