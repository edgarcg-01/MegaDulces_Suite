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
 * Fuente de verdad = `public.knex_migrations` de PROD, resuelta por `PROD_DB_URL` y **verificada
 * por identidad de clúster** antes de creerle nada ([CT.7]; hasta el 2026-09-24 leía
 * `FLEET_DB_URL`, que apunta a Railway, y era ciego a 13 migraciones aplicadas). ⛔ La REAL es `public.*`
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

  // ⛔⛔ [CT.7 2026-09-24] ESTE CANDADO LEÍA `FLEET_DB_URL` A SECAS, Y ESA VARIABLE APUNTA A
  // RAILWAY — la prod VIEJA, de la que nos mudamos el 2026-09-22.
  //
  // Medido ese día, contando las dos listas:
  //     prod real (md:5434/railway) .... 850 migraciones
  //     Railway (FLEET_DB_URL) ......... 836
  //     aplicadas en prod y AUSENTES de Railway ....... 13
  //
  // O sea que el candado era **ciego a 13 migraciones que SÍ están aplicadas en prod** — entre
  // ellas `erp_receivable_doc_lateral`, las dos de `kdpv_prod_util` y `mv_caja_sin_columnas`.
  // Editar cualquiera de esas pasaba la compuerta en verde, y el cambio no llegaba a prod pero
  // sí a un `migrate:latest` fresco: exactamente la falla que este archivo existe para impedir.
  //
  // Es el MISMO defecto que `[VL.18]` corrigió en `apply-one-migration-prod.js`, en otro archivo.
  // Cuando prod se muda, no alcanza con cambiar el runbook: hay que barrer quién lee la variable
  // vieja. Acá se reusa el candado de identidad de aquel, no se inventa otro.
  const url = process.env.DATABASE_URL_NEW_PROD || process.env.PROD_DB_URL
    || (process.env.DATABASE_URL_NEW && process.env.NODE_ENV === 'production' ? process.env.DATABASE_URL_NEW : null)
    || process.env.FLEET_DB_URL;
  if (!url) {
    console.error('Falta la URL de prod. Definí PROD_DB_URL en .env (192.168.0.222:5434/railway).');
    process.exit(1);
  }
  const local = /localhost|127\.0\.0\.1|192\.168\./.test(url);
  const c = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await c.connect();
  let aplicadas;
  try {
    // ── Compuerta de IDENTIDAD, antes de creerle una sola fila ──────────────────
    // Un candado que lee la base equivocada es PEOR que no tener candado: se ve verde.
    // El identificador es el mismo que usa `apply-one-migration-prod.js` (misma fuente).
    const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
    const { rows: [id] } = await c.query(
      'select (select system_identifier from pg_control_system())::text as id, current_database() as db',
    );
    if (id.id !== PROD_CLUSTER_ID) {
      console.error('\n⛔ DESTINO EQUIVOCADO — este candado NO puede dar un veredicto.');
      console.error(`   clúster conectado : ${id.id} (base "${id.db}")`);
      console.error(`   clúster de prod   : ${PROD_CLUSTER_ID}`);
      console.error('   Casi seguro es el `FLEET_DB_URL` viejo del .env, que apunta a Railway.');
      console.error('   Definí PROD_DB_URL en tu .env. NO se reporta verde: no se midió.');
      process.exit(1);
    }
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
