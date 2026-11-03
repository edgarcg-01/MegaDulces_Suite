/* eslint-disable no-console */
/**
 * `[NP.7.0.5]` La tabla `catalog.product_sheets` contra una base REAL: que la migración corre, que cada
 * CHECK y cada índice único rechaza lo que debe (con el código exacto de Postgres), y que la RLS no deja
 * ver fichas de otro tenant con el rol de la app.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_NP7_ALTA_DESDE_FOTOS.md` §7.1 y la fila NP.7.0.5.
 *
 * Todo en UNA transacción que se revierte al final. Si la base no trae la tabla, se aplica el `up()`
 * de la migración dentro de la transacción (y se revierte con ella).
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). Con el `.env` de la
 * máquina de Francisco (prod en sólo lectura) sale NO MEDIDO: la ejerce el job `pruebas-db` del CI.
 *
 *   node database/tests/test-newdb-np7-product-sheets.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-np7-product-sheets');
const { noMedido, correr } = require('./_lib/no-medido');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const mig = require('../migrations-newdb/20261102224652_np7_product_sheets.js');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTRO_TENANT = '11111111-2222-3333-4444-555555555555';
const ALTA = ['presolicitud', 'borrador', 'analizada', 'aprobada', 'tecleada_en_kepler', 'ligada', 'conciliada', 'con_diferencias', 'descartada'];
const LEV = ['en_captura', 'fotos_tomadas', 'analizada', 'publicada', 'por_revisar', 'recapturar', 'historica'];

let ok = 0;
let ko = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};

/** Ejecuta `fn` en un SAVEPOINT y devuelve el código de error de Postgres (o null si no falló). */
async function codigoDe(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  try {
    await fn();
    await trx.raw('RELEASE SAVEPOINT sp');
    return null;
  } catch (e) {
    await trx.raw('ROLLBACK TO SAVEPOINT sp');
    return e.code || e.message;
  }
}

const fila = (p) => ({ tenant_id: TENANT, photos: JSON.stringify([]), sheet: JSON.stringify({}), ...p });

correr(async () => {
  console.log('\n[NP.7.0.5] catalog.product_sheets — CHECKs, unicidad y RLS contra base real\n');
  const trx = await knex.transaction();
  try {
    const roOnly = (await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on';
    if (roOnly) noMedido('la conexión es de sólo lectura: no se puede crear ni escribir la tabla');
    const tenant = await trx('identity.tenants').where({ id: TENANT }).first('id');
    if (!tenant) noMedido(`no existe el tenant ${TENANT} en identity.tenants (base sin sembrar)`);

    const existia = await trx.schema.withSchema('catalog').hasTable('product_sheets');
    if (!existia) await mig.up(trx);
    check(`la tabla existe (${existia ? 'ya migrada' : 'up() aplicado en la transacción'})`, await trx.schema.withSchema('catalog').hasTable('product_sheets'));
    check('up() es idempotente (segunda corrida sin error)', (await codigoDe(trx, () => mig.up(trx))) === null);

    const T = trx.withSchema('catalog');
    // 1 · una fila por origen y estado entra
    for (const [i, st] of ALTA.entries()) {
      const c = await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'alta', status: st, ean: `990000000${String(i).padStart(4, '0')}` })));
      check(`alta · ${st} entra`, c === null, c);
    }
    for (const [i, st] of LEV.entries()) {
      const extra = st === 'historica' ? { superseded_at: new Date().toISOString() } : {};
      const c = await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'levantamiento', status: st, sku: `NP7T${i}`, branch_code: '01', ...extra })));
      check(`levantamiento · ${st} entra`, c === null, c);
    }

    // 2 · pruebas negativas, con el código exacto
    check('⭐ estado de levantamiento con origin=alta (publicada) → 23514',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'alta', status: 'publicada', ean: '9911' })))) === '23514');
    check('estado de alta con origin=levantamiento (aprobada) → 23514',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'levantamiento', status: 'aprobada', sku: 'X1', branch_code: '01' })))) === '23514');
    check('origin inventado → 23514',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'importer', status: 'borrador' })))) === '23514');
    check('levantamiento sin sucursal → 23514',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'levantamiento', status: 'en_captura', sku: 'X2' })))) === '23514');
    check('histórica sin superseded_at → 23514',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'levantamiento', status: 'historica', sku: 'X3', branch_code: '01' })))) === '23514');
    check('photos que no es arreglo → 23514',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'alta', status: 'borrador', ean: '9912', photos: JSON.stringify({}) })))) === '23514');
    check('autorizador de margen con motivo vacío → 23514',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'alta', status: 'borrador', ean: '9913', margin_authorized_by: TENANT, margin_authorization_reason: '   ' })))) === '23514');
    check('control: autorizador de margen CON motivo entra',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'alta', status: 'borrador', ean: '9914', margin_authorized_by: TENANT, margin_authorization_reason: 'lanzamiento' })))) === null);

    // 3 · unicidad
    check('⭐ dos altas vivas con el mismo EAN → 23505',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'alta', status: 'borrador', ean: '9900000000000' })))) === '23505');
    check('control: un alta descartada no estorba a una nueva con el mismo EAN',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'alta', status: 'borrador', ean: '9900000000008' })))) === null);
    check('⭐ dos fichas de levantamiento vigentes del mismo SKU → 23505',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'levantamiento', status: 'en_captura', sku: 'NP7T0', branch_code: '02' })))) === '23505');
    check('control: una histórica + una vigente del mismo SKU entran',
      (await codigoDe(trx, () => T.table('product_sheets').insert(fila({ origin: 'levantamiento', status: 'en_captura', sku: 'NP7T6', branch_code: '01' })))) === null);

    // 4 · RLS con el rol de la app (el superusuario se la salta)
    const rls = await codigoDe(trx, async () => {
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
      const propio = Number((await trx.raw('SELECT count(*) AS n FROM catalog.product_sheets')).rows[0].n);
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO_TENANT]);
      const ajeno = Number((await trx.raw('SELECT count(*) AS n FROM catalog.product_sheets')).rows[0].n);
      const borrar = await codigoDe(trx, () => trx.raw('DELETE FROM catalog.product_sheets'));
      await trx.raw('RESET ROLE');
      check('control RLS: el tenant propio ve sus fichas', propio > 0, propio);
      check('⭐ RLS: otro tenant ve CERO fichas', ajeno === 0, ajeno);
      check('sin DELETE para app_runtime (42501)', borrar === '42501', borrar);
    });
    check('la prueba de RLS corrió (rol app_runtime disponible)', rls === null, rls);

    // 5 · down() se niega con datos
    const down = await codigoDe(trx, () => mig.down(trx));
    check('down() se niega a borrar con fichas', typeof down === 'string' && /down rechazado/.test(down), down);
  } finally {
    await trx.rollback().catch(() => undefined);
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗\n`);
  process.exit(ko ? 1 : 0);
});
