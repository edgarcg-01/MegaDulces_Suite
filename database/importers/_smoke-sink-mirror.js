/* eslint-disable no-console */
/**
 * Smoke del ESPEJO del sink (FEEDS_MIRROR_URL): una lectura del origen → dos destinos.
 *
 * Corre en modo pg con primario = la MISMA réplica de pruebas, así que NO toca prod.
 * Verifica lo que puede romper:
 *   1. el changeset llega al espejo (raw-upsert auto-crea la tabla),
 *   2. es idempotente (segunda pasada no duplica),
 *   3. un espejo caído NO tumba el feed primario,
 *   4. el proceso TERMINA solo — el Client del espejo va unref'd (si colgara, este
 *      script no volvería nunca: es el bug clásico de los feeds on-prem).
 *
 * La URL sale de MIRROR_TEST_URL o, si no está, de FEEDS_MIRROR_URL (la que ya usan los feeds).
 * No hay default hardcodeado a propósito: no metemos credenciales al repo.
 *
 * Uso: MIRROR_TEST_URL=<url de la réplica> node database/importers/_smoke-sink-mirror.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Client } = require('pg');

const URL_ = process.env.MIRROR_TEST_URL || process.env.FEEDS_MIRROR_URL;
if (!URL_) {
  console.error('Falta MIRROR_TEST_URL (o FEEDS_MIRROR_URL en .env) apuntando a la réplica de pruebas.');
  process.exit(2);
}
if (/proxy\.rlwy\.net|railway/i.test(URL_)) {
  console.error('ABORT: la URL apunta a Railway/prod. Este smoke escribe y borra tablas — solo contra la réplica.');
  process.exit(2);
}
const TABLE = 'zz_sink_mirror_smoke';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const META = {
  table: TABLE,
  pk: ['sucursal', 'c1'],
  columns: [{ name: 'sucursal', type: 'text' }, { name: 'c1', type: 'text' }, { name: 'c2', type: 'text' }],
};

let ok = 0; let fail = 0;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

(async () => {
  process.env.FEEDS_SINK = 'pg';
  process.env.FEEDS_MIRROR_URL = URL_;
  const sink = require('./lib/sink');

  const db = new Client({ connectionString: URL_ });
  await db.connect();
  await db.query(`DROP TABLE IF EXISTS kepler_ods.${TABLE}`);

  console.log('1) primario + espejo apuntando a la réplica');
  const r1 = await sink.ship('raw-upsert', {
    rows: [{ sucursal: '00', c1: 'A', c2: 'uno' }, { sucursal: '00', c1: 'B', c2: 'dos' }],
    tenantId: TENANT, client: db, meta: META,
  });
  t('ship devolvió ok', r1 && r1.ok === true, JSON.stringify(r1));
  const n1 = Number((await db.query(`SELECT count(*) n FROM kepler_ods.${TABLE}`)).rows[0].n);
  t('2 filas en el destino', n1 === 2, `n=${n1}`);

  console.log('2) idempotencia (misma pasada otra vez, un valor cambiado)');
  await sink.ship('raw-upsert', {
    rows: [{ sucursal: '00', c1: 'A', c2: 'UNO' }, { sucursal: '00', c1: 'B', c2: 'dos' }],
    tenantId: TENANT, client: db, meta: META,
  });
  const n2 = Number((await db.query(`SELECT count(*) n FROM kepler_ods.${TABLE}`)).rows[0].n);
  t('sigue en 2 filas (UPSERT, no duplica)', n2 === 2, `n=${n2}`);
  const v = (await db.query(`SELECT c2 FROM kepler_ods.${TABLE} WHERE c1='A'`)).rows[0].c2;
  t('el UPDATE se aplicó', v === 'UNO', `c2=${v}`);

  console.log('3) espejo caído no tumba el primario');
  delete require.cache[require.resolve('./lib/sink')];
  process.env.FEEDS_MIRROR_URL = 'postgresql://nadie:nada@192.0.2.1:5432/no_existe?connect_timeout=2';
  const sink2 = require('./lib/sink');
  let threw = null;
  try {
    await sink2.ship('raw-upsert', { rows: [{ sucursal: '00', c1: 'C', c2: 'tres' }], tenantId: TENANT, client: db, meta: META });
  } catch (e) { threw = e.message; }
  t('ship NO lanzó con espejo caído', threw === null, String(threw));
  const n3 = Number((await db.query(`SELECT count(*) n FROM kepler_ods.${TABLE}`)).rows[0].n);
  t('el primario sí escribió (3 filas)', n3 === 3, `n=${n3}`);

  console.log('4) guard: espejo apuntando a prod se ignora');
  delete require.cache[require.resolve('./lib/sink')];
  process.env.FEEDS_MIRROR_URL = 'postgresql://x:y@trolley.proxy.rlwy.net:39023/railway';
  const sink3 = require('./lib/sink');
  t('mirrorUrl() vacío para un host Railway', sink3.mirrorUrl() === '');

  await db.query(`DROP TABLE IF EXISTS kepler_ods.${TABLE}`);
  await db.end();
  console.log(`\n=== ${ok} OK / ${fail} fallos ===`);
  console.log('(si ves esta línea y el proceso termina, el Client del espejo no cuelga el proceso)');
  process.exitCode = fail ? 1 : 0;
})();
