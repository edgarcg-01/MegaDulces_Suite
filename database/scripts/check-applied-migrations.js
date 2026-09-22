'use strict';
/**
 * CANDADO — una migración YA APLICADA en prod no se puede EDITAR.
 *
 * Nace de un patrón que ya cobró cuatro veces (#122, #128, #133, #138): un PR "mejora" una
 * feature agregándole columnas/lógica al `up()` de una migración que **ya corrió en prod**.
 * Knex la ve en `public.knex_migrations` y la **salta** → el cambio NUNCA llega a prod, pero SÍ
 * a un `migrate:latest` fresco → el backend consulta columnas que no existen = runtime break, y
 * prod diverge de fresh sin que nada avise.
 *
 * La regla: agregar es una migración NUEVA (timestamp nuevo, `hasColumn`/`hasTable` idempotente),
 * nunca editar una vieja. Este check lo hace imposible de mergear en silencio.
 *
 *   node database/scripts/check-applied-migrations.js            # vs origin/main (default)
 *   node database/scripts/check-applied-migrations.js --base HEAD~5
 *
 * Fuente de verdad = `public.knex_migrations` de PROD (FLEET_DB_URL). ⛔ La REAL es `public.*`
 * (la del search_path está vacía — GOTCHAS). Sólo lectura, nunca imprime la cadena de conexión.
 * Exit 1 si algún archivo de `database/migrations-newdb/` MODIFICADO (M) o RENOMBRADO/BORRADO ya
 * figura aplicado. Archivos NUEVOS (A) pasan: todavía no corrieron.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { execSync } = require('child_process');
const { Client } = require('pg');

const DIR = 'database/migrations-newdb/';

(async () => {
  const baseArg = process.argv.indexOf('--base');
  const base = baseArg >= 0 ? process.argv[baseArg + 1] : 'origin/main';

  // Archivos de migración tocados que NO son alta pura (A). M=modificado, R=renombrado, D=borrado.
  let lines = [];
  try {
    lines = execSync(`git diff --name-status ${base} -- ${DIR}`, { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    console.error(`No se pudo comparar contra ${base}: ${e.message}`);
    process.exit(1);
  }
  const tocados = lines
    .map((l) => l.split('\t'))
    .filter(([st]) => st[0] !== 'A')              // A = archivo nuevo → OK
    .map((parts) => path.basename(parts[parts.length - 1]))
    .filter((f) => f.endsWith('.js'));

  if (!tocados.length) {
    console.log(`✓ Ningún archivo de ${DIR} modificado respecto de ${base}.`);
    return;
  }

  const url = process.env.FLEET_DB_URL;
  if (!url) { console.error('Falta FLEET_DB_URL en .env'); process.exit(1); }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  let aplicadas;
  try {
    const { rows } = await c.query('SELECT name FROM public.knex_migrations');
    aplicadas = new Set(rows.map((r) => r.name));
  } finally { await c.end(); }

  const ofensores = tocados.filter((f) => aplicadas.has(f));
  if (ofensores.length) {
    console.error(`\n⛔ ${ofensores.length} migración(es) YA APLICADA(S) en prod fueron MODIFICADAS:`);
    for (const f of ofensores) console.error(`   ✗ ${f}`);
    console.error('\nEditar el up() de una migración aplicada NO la re-corre (knex la salta) → el');
    console.error('cambio no llega a prod. Movelo a una migración NUEVA con guardas idempotentes.');
    process.exit(1);
  }
  console.log(`✓ ${tocados.length} migración(es) modificada(s) y NINGUNA está aplicada en prod. OK.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
