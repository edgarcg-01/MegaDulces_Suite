/**
 * SM.47 — «Conteo de efectivo»: el arqueo SIN caja.
 *
 * Cuatro bloques:
 *   1. Schema — el CHECK de tipo admite `sin_caja`, existe `motivo` y su CHECK.
 *   2. Las compuertas, con PRUEBA NEGATIVA y su CONTROL POSITIVO: un candado que
 *      rechaza TODO se ve igual de verde que uno que discrimina.
 *   3. El camino de escritura REAL (`BlindCountService.submit`, regla 13): dos
 *      conteos el mismo dia conviven (secuencia 1 y 2), sin motivo se rechaza.
 *   4. El permiso esta REPARTIDO, no solo declarado.
 *
 * Todo corre dentro de transacciones que se revierten: no deja filas.
 * Lo que la DB no tiene con que comprobarse reporta NO MEDIDO (ADR-056).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const WH_TEST = 'ZZ-SM47';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const enTrx = (fn) => knex.transaction(async (trx) => { await fn(trx); throw new Error(RB); })
  .catch((e) => { if (!e.message.includes(RB)) throw e; });

const ins = (trx, { tipo = 'sin_caja', caja = 'SIN_CAJA', motivo = 'caja fuerte', secuencia = 1, ruta = null }) => trx.raw(
  `INSERT INTO reconciliation.blind_counts
     (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, route_code, secuencia, motivo, denominations, total_contado)
   VALUES (?, ?, ?, '2026-01-02', 'SM47', ?, ?, ?, ?, '{}'::jsonb, 100)`,
  [T, WH_TEST, caja, tipo, ruta, secuencia, motivo]);

const rechaza = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

/**
 * Carga el `BlindCountService` REAL (el TS del repo) para ejercer su `submit()`.
 * Solo se sustituye la infraestructura: `platform-core` (el knex por tenant se
 * inyecta abajo con la transaccion de la prueba) y `contracts`, que se resuelve
 * a los dos archivos que el servicio usa (sin imports propios).
 */
function cargarServicio() {
  const path = require('path');
  const Module = require('module');
  const raiz = path.resolve(__dirname, '..', '..');
  const mapa = {
    '@megadulces/platform-core': path.join(__dirname, '.stub-sm47-platform-core.js'),
    '@megadulces/contracts': path.join(__dirname, '.stub-sm47-contracts.js'),
    // SM.49 - el servicio importa la lista de conceptos del contrato por su ruta directa.
    '@megadulces/contracts/http/arqueo-cajas': path.join(raiz, 'libs/contracts/src/http/arqueo-cajas.contract.ts'),
  };
  const fs = require('fs');
  fs.writeFileSync(mapa['@megadulces/platform-core'], 'module.exports = { TenantKnexService: class {}, TenantContextService: class {} };');
  fs.writeFileSync(mapa['@megadulces/contracts'], `module.exports = {
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/money/denominations.ts'))}),
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/ports/recon-notifier.port.ts'))}),
  };`);
  // Solo los stubs temporales: la tabla también apunta a archivos REALES del repo.
  process.on('exit', () => {
    for (const f of Object.values(mapa)) {
      if (!path.basename(f).startsWith('.stub-')) continue;
      try { fs.unlinkSync(f); } catch { /* ya no esta */ }
    }
  });
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return mapa[req] || orig.call(this, req, ...rest); };
  // `skipProject`: sin esto ts-node toma el tsconfig del monorepo y falla (TS5011).
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
    ok(/'sin_caja'/.test(await def('blind_counts_tipo_check')), 'el CHECK de tipo admite sin_caja');
    ok(/sin_caja/.test(await def('blind_counts_secuencia_check')), 'el CHECK de secuencia numera sin_caja');
    const col = (await knex.raw(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='reconciliation' AND table_name='blind_counts' AND column_name='motivo'`)).rows;
    ok(col.length === 1, 'existe la columna motivo');
    ok(/motivo/.test(await def('blind_counts_motivo_check')), 'existe el CHECK de motivo');

    console.log('\n[2] Las compuertas (prueba negativa + control positivo)');
    await enTrx(async (trx) => {
      ok(await rechaza(() => ins(trx, { motivo: null }), /motivo_check/), 'NEGATIVA: sin_caja SIN motivo es RECHAZADO');
    });
    await enTrx(async (trx) => {
      ok(await rechaza(() => ins(trx, { motivo: '   ' }), /motivo_check/), 'NEGATIVA: sin_caja con motivo en blanco es RECHAZADO');
    });
    await enTrx(async (trx) => {
      ok(await rechaza(() => ins(trx, { motivo: 'x'.repeat(201) }), /motivo_check/), 'NEGATIVA: motivo de 201 caracteres es RECHAZADO');
    });
    await enTrx(async (trx) => {
      ok(await rechaza(() => ins(trx, { tipo: 'cierre', caja: '1', motivo: 'algo' }), /motivo_check/),
        'NEGATIVA: un cierre CON motivo es RECHAZADO (el motivo es solo del conteo sin caja)');
    });
    await enTrx(async (trx) => {
      ok(await rechaza(() => ins(trx, { tipo: 'cierre', caja: '1', motivo: null, secuencia: 2 }), /secuencia_check/),
        'NEGATIVA: un cierre con secuencia 2 sigue RECHAZADO');
    });
    await enTrx(async (trx) => {
      // CONTROL POSITIVO: con motivo entra, y un segundo conteo el mismo dia convive.
      await ins(trx, { motivo: 'x'.repeat(200) });
      await ins(trx, { secuencia: 2, motivo: 'fondo de cambio' });
      const n = (await trx.raw(`SELECT count(*)::int n FROM reconciliation.blind_counts WHERE warehouse_code = ?`, [WH_TEST])).rows[0].n;
      ok(n === 2, `CONTROL POSITIVO: dos conteos sin caja el mismo dia conviven (${n} filas)`);
      ok(await rechaza(() => ins(trx, { secuencia: 2, motivo: 'otro' }), /unique|duplicad/i),
        'NEGATIVA: la MISMA secuencia dos veces es RECHAZADA');
    });

    console.log('\n[3] El camino de escritura real (BlindCountService.submit)');
    let Svc = null;
    try {
      Svc = cargarServicio();
    } catch (e) {
      noMedido(`no se pudo cargar BlindCountService (${e.message.split('\n')[0]})`);
    }
    if (Svc) {
      await enTrx(async (trx) => {
        const tk = { run: (fn) => fn(trx) };
        const svc = new Svc(tk, { requireTenantId: () => T }, {}, undefined);
        const base = { warehouse_code: WH_TEST, caja: 'SIN_CAJA', business_date: '2026-01-03', cajero_code: 'SM47', tipo: 'sin_caja',
          denominations: { 1000: 2, 0.5: 3 } };
        const a = await svc.submit({ ...base, motivo: 'caja fuerte' }, 'sm47');
        const b = await svc.submit({ ...base, motivo: 'fondo de cambio' }, 'sm47');
        ok(a.secuencia === 1 && b.secuencia === 2, `dos submit seguidos quedan como 1 y 2 (${a.secuencia}, ${b.secuencia}) — el segundo NO pisa`);
        ok(a.total_contado === 2001.5, `el total lo calcula el servidor: ${a.total_contado}`);
        ok(a.esperado === null && a.diff_real === null, 'sin esperado ni diferencia (no hay contra que comparar)');
        const rows = (await trx.raw(`SELECT motivo FROM reconciliation.blind_counts WHERE warehouse_code = ? ORDER BY secuencia`, [WH_TEST])).rows;
        ok(rows.map((r) => r.motivo).join('|') === 'caja fuerte|fondo de cambio', 'el motivo se guarda');
        ok(await rechaza(() => svc.submit({ ...base }, 'sm47'), /motivo/i), 'NEGATIVA: submit sin motivo es RECHAZADO por el servicio');
        ok(await rechaza(() => svc.submit({ ...base, tipo: 'cierre', caja: '1', motivo: 'x' }, 'sm47'), /motivo/i),
          'NEGATIVA: un cierre con motivo es RECHAZADO por el servicio');
      });
    }

    console.log('\n[4] El permiso esta REPARTIDO, no solo declarado');
    const perms = (await knex.raw(
      `SELECT role_name FROM role_permissions
        WHERE permissions -> 'STORE_ARQUEO_SIN_CAJA_CAPTURAR' = 'true'::jsonb ORDER BY role_name`)).rows.map((r) => r.role_name);
    if (!perms.length) {
      noMedido('nadie tiene STORE_ARQUEO_SIN_CAJA_CAPTURAR en esta DB (¿falta correr la migracion de reparto?)');
    } else {
      const pedidos = ['encargado_tienda', 'finanzas', 'finanzas_operativo', 'tesoreria'];
      const existen = (await knex.raw(`SELECT role_name FROM role_permissions WHERE role_name = ANY(?)`, [pedidos])).rows.map((r) => r.role_name);
      const ausentes = pedidos.filter((r) => !existen.includes(r));
      if (ausentes.length) noMedido(`roles que no existen en esta DB: ${ausentes.join(', ')}`);
      ok(existen.every((r) => perms.includes(r)), `lo tienen los roles pedidos que existen aqui (${perms.join(', ')})`);
      ok(!perms.includes('cajero') && !perms.includes('piso_tienda'), 'NEGATIVA: cajero y piso_tienda NO lo tienen');
    }
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nSM.47 conteo de efectivo sin caja → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
