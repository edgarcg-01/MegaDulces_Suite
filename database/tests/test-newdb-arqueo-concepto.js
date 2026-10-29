/**
 * SM.49 — El concepto del retiro (por qué salió el dinero de la caja).
 *
 * Tres bloques:
 *   1. Schema — la columna `concepto`, su CHECK y el CHECK del motivo ampliado.
 *   2. Las compuertas, con PRUEBA NEGATIVA y CONTROL POSITIVO: un candado que rechaza
 *      TODO se ve igual de verde que uno que discrimina. Incluye la regresión de SM.47
 *      (el conteo sin caja sigue exigiendo motivo).
 *   3. El camino de escritura REAL (`BlindCountService.submit`, regla 13).
 *
 * Todo corre dentro de transacciones que se revierten: no deja filas.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const WH_TEST = 'ZZ-SM49';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const enTrx = (fn) => knex.transaction(async (trx) => { await fn(trx); throw new Error(RB); })
  .catch((e) => { if (!e.message.includes(RB)) throw e; });
const rechaza = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

let sec = 0;
const ins = (trx, { tipo = 'retiro', caja = '1', concepto = null, motivo = null }) => trx.raw(
  `INSERT INTO reconciliation.blind_counts
     (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, secuencia, concepto, motivo, denominations, total_contado)
   VALUES (?, ?, ?, '2026-01-02', 'SM49', ?, ?, ?, ?, '{}'::jsonb, 100)`,
  [T, WH_TEST, caja, tipo, tipo === 'retiro' || tipo === 'sin_caja' ? ++sec : 1, concepto, motivo]);

/** El servicio REAL; solo se sustituye la infraestructura (ver test-newdb-arqueo-sin-caja.js). */
function cargarServicio() {
  const path = require('path');
  const Module = require('module');
  const fs = require('fs');
  const raiz = path.resolve(__dirname, '..', '..');
  const stubs = {
    '@megadulces/platform-core': path.join(__dirname, '.stub-sm49-platform-core.js'),
    '@megadulces/contracts': path.join(__dirname, '.stub-sm49-contracts.js'),
  };
  const reales = { '@megadulces/contracts/http/arqueo-cajas': path.join(raiz, 'libs/contracts/src/http/arqueo-cajas.contract.ts') };
  fs.writeFileSync(stubs['@megadulces/platform-core'], 'module.exports = { TenantKnexService: class {}, TenantContextService: class {} };');
  fs.writeFileSync(stubs['@megadulces/contracts'], `module.exports = {
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/money/denominations.ts'))}),
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/ports/recon-notifier.port.ts'))}),
  };`);
  // Se borran SOLO los stubs: `reales` apunta a archivos del repo.
  process.on('exit', () => { for (const f of Object.values(stubs)) { try { fs.unlinkSync(f); } catch { /* ya no esta */ } } });
  const mapa = { ...stubs, ...reales };
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return mapa[req] || orig.call(this, req, ...rest); };
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: {
      module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0',
    },
  });
  return require(path.join(raiz, 'libs/reconciliation/src/lib/blind-count.service.ts')).BlindCountService;
}

(async () => {
  try {
    console.log('\n[1] Schema');
    const def = async (name) => (await knex.raw(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid='reconciliation.blind_counts'::regclass AND conname=?`, [name])).rows[0]?.d || '';
    const col = (await knex.raw(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='reconciliation' AND table_name='blind_counts' AND column_name='concepto'`)).rows;
    ok(col.length === 1, 'existe la columna concepto');
    ok(/pago_proveedor/.test(await def('blind_counts_concepto_check')), 'existe el CHECK de concepto con la lista');
    ok(/otro/.test(await def('blind_counts_motivo_check')), 'el CHECK del motivo admite el retiro «otro»');

    console.log('\n[2] Las compuertas (prueba negativa + control positivo)');
    await enTrx(async (trx) => { ok(await rechaza(() => ins(trx, { concepto: 'cambio_feria' }), /concepto_check/), 'NEGATIVA: concepto fuera de la lista es RECHAZADO'); });
    await enTrx(async (trx) => { ok(await rechaza(() => ins(trx, { tipo: 'cierre', concepto: 'pago_proveedor' }), /concepto_check/), 'NEGATIVA: un cierre CON concepto es RECHAZADO'); });
    await enTrx(async (trx) => { ok(await rechaza(() => ins(trx, { concepto: 'otro' }), /motivo_check/), 'NEGATIVA: retiro «otro» SIN motivo es RECHAZADO'); });
    await enTrx(async (trx) => { ok(await rechaza(() => ins(trx, { concepto: 'pago_proveedor', motivo: 'x' }), /motivo_check/), 'NEGATIVA: retiro con concepto que no es «otro» CON motivo es RECHAZADO'); });
    await enTrx(async (trx) => { ok(await rechaza(() => ins(trx, { tipo: 'sin_caja', caja: 'SIN_CAJA' }), /motivo_check/), 'REGRESIÓN SM.47: el conteo sin caja sigue exigiendo motivo'); });
    await enTrx(async (trx) => {
      await ins(trx, { concepto: 'retiro_caja' });
      await ins(trx, { concepto: 'pago_proveedor' });
      await ins(trx, { concepto: 'pago_nomina' });
      await ins(trx, { concepto: 'otro', motivo: 'se pagó el gas' });
      await ins(trx, {});   // retiro anterior a SM.49: sin concepto
      const n = (await trx.raw(`SELECT count(*)::int n FROM reconciliation.blind_counts WHERE warehouse_code = ?`, [WH_TEST])).rows[0].n;
      ok(n === 5, `CONTROL POSITIVO: retiro de caja, proveedor, nómina, «otro» con motivo y uno sin concepto entran (${n})`);
    });

    console.log('\n[3] El camino de escritura real (BlindCountService.submit)');
    let Svc = null;
    try { Svc = cargarServicio(); } catch (e) { noMedido(`no se pudo cargar BlindCountService (${e.message.split('\n')[0]})`); }
    if (Svc) {
      await enTrx(async (trx) => {
        const svc = new Svc({ run: (fn) => fn(trx) }, { requireTenantId: () => T }, {}, undefined);
        const base = { warehouse_code: WH_TEST, caja: '3', business_date: '2026-01-03', cajero_code: 'SM49', tipo: 'retiro', denominations: { 500: 4 } };
        const a = await svc.submit({ ...base, concepto: 'otro', motivo: 'se pagó el gas' }, 'sm49');
        const b = await svc.submit({ ...base, concepto: 'retiro_caja' }, 'sm49');
        ok(a.secuencia === 1 && b.secuencia === 2, `dos retiros con concepto conviven como 1 y 2 (${a.secuencia}, ${b.secuencia})`);
        const rows = (await trx.raw(`SELECT concepto, motivo FROM reconciliation.blind_counts WHERE warehouse_code = ? ORDER BY secuencia`, [WH_TEST])).rows;
        ok(rows.map((r) => `${r.concepto}/${r.motivo || ''}`).join('|') === 'otro/se pagó el gas|retiro_caja/', 'concepto y motivo se guardan');
        ok(await rechaza(() => svc.submit({ ...base, concepto: 'otro' }, 'sm49'), /retiro/i), 'NEGATIVA: el servicio rechaza «otro» sin motivo');
      });
    }
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nSM.49 concepto del retiro → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
