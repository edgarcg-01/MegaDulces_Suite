'use strict';
/**
 * [IC.CEDIS] Smoke del guard de la fuente del CEDIS (`importers/lib/cedis-source-guard.js`).
 *
 * Lo que protege: los dos importers que alimentan el CEDIS desde Wincaja corren en
 * `run-prod-feeds.js`, y el de stock hace un MERGE con **DELETE de lo que no venga de
 * Irapuato**. Pasado el cutover a Kepler, eso **borra del CEDIS lo que Kepler cargue**.
 *
 * ⭐ Las dos puertas se prueban EN NEGATIVO — se rompen a propósito y se verifica el rojo.
 * La de cutover se ejerce dentro de una transacción con **ROLLBACK garantizado**: es la única
 * forma de comprobar que la puerta cierra sin esperar al día de la migración.
 *
 *   node database/tests/test-newdb-cedis-source-guard.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');
const { checkCedisSource } = require('../importers/lib/cedis-source-guard');

const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CEDIS_CODE = process.env.CEDIS_WAREHOUSE_CODE || '00';
const BRANCH = process.env.WINCAJA_CEDIS_BRANCH || '00';

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.CEDIS] guard de la fuente del CEDIS ===\n');

  try {
    // ── 1. El guard responde y trae veredicto + motivo ────────────────────────
    const base = await checkCedisSource(db, { tenant: TENANT, cedisCode: CEDIS_CODE, wincajaBranch: BRANCH });
    t('devuelve un veredicto con forma {ok, reason, detail}',
      typeof base.ok === 'boolean' && 'reason' in base && typeof base.detail === 'string',
      JSON.stringify(base));
    t('cuando NO pasa, SIEMPRE dice por qué (nunca un false mudo)',
      base.ok === true || (typeof base.reason === 'string' && base.reason.length > 0),
      JSON.stringify(base));
    console.log(`     estado real hoy → ok=${base.ok} reason=${base.reason || '—'}`);
    console.log(`     ${base.detail}`);

    // ── 2. PUERTA B (frescura), en negativo y en positivo ─────────────────────
    const rancio = await checkCedisSource(db, { tenant: TENANT, cedisCode: CEDIS_CODE, wincajaBranch: BRANCH, maxAgeDays: -1 });
    t('PRUEBA NEGATIVA frescura: con tope imposible (-1) la puerta CIERRA',
      rancio.ok === false && rancio.reason === 'source_stale', JSON.stringify(rancio));

    const laxo = await checkCedisSource(db, { tenant: TENANT, cedisCode: CEDIS_CODE, wincajaBranch: BRANCH, maxAgeDays: 100000 });
    t('con tope enorme la frescura ya NO es el motivo (el umbral manda de verdad)',
      laxo.reason !== 'source_stale', JSON.stringify(laxo));

    // ── 3. Fuente inexistente → se DECLARA, no se cuela ───────────────────────
    const fantasma = await checkCedisSource(db, { tenant: TENANT, cedisCode: CEDIS_CODE, wincajaBranch: '__NO_EXISTE__', maxAgeDays: 100000 });
    t('PRUEBA NEGATIVA: una rama Wincaja inexistente cierra con source_empty',
      fantasma.ok === false && fantasma.reason === 'source_empty', JSON.stringify(fantasma));

    // ── 4. PUERTA A (cutover) — se ejerce y SE DESHACE ────────────────────────
    // La puerta que de verdad importa el día de la migración. Se prueba marcando el
    // kepler_code dentro de una transacción que SIEMPRE hace rollback.
    let cutover = null, previo = null, restaurado = null, conSqlReal = false;
    await db.transaction(async (trx) => {
      previo = (await trx.raw(
        `SELECT kepler_code FROM commercial.warehouses WHERE tenant_id=? AND code=? AND deleted_at IS NULL`,
        [TENANT, CEDIS_CODE])).rows[0];
      await trx.raw(
        `UPDATE commercial.warehouses SET kepler_code='00' WHERE tenant_id=? AND code=? AND deleted_at IS NULL`,
        [TENANT, CEDIS_CODE]);
      conSqlReal = true;
      cutover = await checkCedisSource(trx, { tenant: TENANT, cedisCode: CEDIS_CODE, wincajaBranch: BRANCH, maxAgeDays: 100000 });
      throw new Error('__ROLLBACK_INTENCIONAL__');
    }).catch((e) => {
      const m = String(e.message);
      if (m.includes('__ROLLBACK_INTENCIONAL__')) return;
      // Conexión de sólo lectura (lo normal contra prod): no se puede EJERCER la puerta con SQL
      // real. Se cae a un doble MÍNIMO — y se DECLARA, porque un doble no valida SQL
      // (feedback_doubles_never_validate_sql): acá sólo prueba la PRECEDENCIA de la lógica.
      if (!/read-only|permission denied/i.test(m)) throw e;
      console.log('     ⓘ conexión de sólo lectura → la puerta de cutover se prueba con doble (precedencia), NO con SQL real');
    });

    if (!conSqlReal) {
      const doble = {
        raw: async (sql, binds) => (/FROM commercial\.warehouses/i.test(sql)
          ? { rows: [{ kepler_code: '00', wincaja_source_branch: '00' }] }
          : db.raw(sql, binds)),
      };
      cutover = await checkCedisSource(doble, { tenant: TENANT, cedisCode: CEDIS_CODE, wincajaBranch: BRANCH, maxAgeDays: 100000 });
    }

    t(`PRUEBA NEGATIVA cutover: con kepler_code puesto, la puerta CIERRA${conSqlReal ? '' : ' [doble: precedencia, no SQL]'}`,
      cutover && cutover.ok === false && cutover.reason === 'cutover_done',
      JSON.stringify(cutover));
    t('la puerta de cutover gana AUNQUE la fuente esté fresca (precedencia correcta)',
      cutover && cutover.reason === 'cutover_done', JSON.stringify(cutover));

    if (conSqlReal) {
      restaurado = (await db.raw(
        `SELECT kepler_code FROM commercial.warehouses WHERE tenant_id=? AND code=? AND deleted_at IS NULL`,
        [TENANT, CEDIS_CODE])).rows[0];
      t('el rollback dejó `kepler_code` EXACTAMENTE como estaba (la prueba no muta prod)',
        String(restaurado && restaurado.kepler_code) === String(previo && previo.kepler_code),
        `antes=${previo && previo.kepler_code} después=${restaurado && restaurado.kepler_code}`);
    } else {
      console.log('  ⓘ NO MEDIDO: el rollback del cutover (la conexión no escribe — nada que deshacer)');
    }

    // ── 5. Almacén inexistente ────────────────────────────────────────────────
    const sinWh = await checkCedisSource(db, { tenant: TENANT, cedisCode: '__NO_EXISTE__', wincajaBranch: BRANCH });
    t('PRUEBA NEGATIVA: almacén inexistente cierra con warehouse_missing',
      sinWh.ok === false && sinWh.reason === 'warehouse_missing', JSON.stringify(sinWh));
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
