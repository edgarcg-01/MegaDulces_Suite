/* eslint-disable no-console */
/**
 * `[MX.2.4]` — Resolver una incidencia de movimientos CON su motivo, contra la base real.
 *
 * `POST /commercial/movements/exceptions/resolve` ESCRIBE en `commercial.stock_movement_audits`
 * (decisión D8: la misma fila que la marca «auditado» del Diario). Regla 13: una escritura no está
 * probada hasta que se ejerció contra una base real con el payload de la pantalla. Esto carga el
 * `CommercialMovementsService` REAL (el TS del repo, no una copia) y lo corre sobre la transacción
 * de la prueba:
 *
 *   ✓ CONTROL POSITIVO — el payload exacto de `/almacen/incidencias` resuelve, y la fila guarda
 *     motivo, nota y quién (sin esto, un servicio que rechace todo se vería igual de verde).
 *   ✓ la bandeja la saca de pendientes y la cuenta en `resueltas`; el detalle la lee.
 *   ✓ resolver dos veces ACTUALIZA (una fila, el motivo nuevo), no duplica.
 *   ✗ motivo inventado, «otro» sin nota, documento que no existe, tipo que no es traspaso ni ajuste:
 *     se RECHAZAN y no escriben nada.
 *   ✓ una marca del Diario SIN motivo NO cuenta como resuelta (la incidencia sigue pendiente).
 *   ✓ reabrir la devuelve a la bandeja.
 *
 * Todo en UNA transacción que se revierte: no deja filas. Almacén y documento sintéticos `TEST-MX24`.
 */
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const FOLIO = 'TEST-MX24-0001';
const DIA = '2026-01-15';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const rechaza = async (fn, re) => { try { await fn(); return 'pasó'; } catch (e) { return re.test(e.message) ? true : e.message; } };

/**
 * El servicio REAL. Sólo se sustituye la infraestructura: `platform-core` (el knex por tenant se
 * inyecta con la transacción de la prueba) y `contracts`, que se resuelve a los dos archivos que el
 * servicio usa.
 */
function cargarServicio() {
  const fs = require('fs');
  const Module = require('module');
  const raiz = path.resolve(__dirname, '..', '..');
  const mapa = {
    '@megadulces/platform-core': path.join(__dirname, '.stub-mx24-platform-core.js'),
    '@megadulces/contracts': path.join(__dirname, '.stub-mx24-contracts.js'),
  };
  fs.writeFileSync(mapa['@megadulces/platform-core'], 'module.exports = { TenantKnexService: class {}, TenantContextService: class {} };');
  fs.writeFileSync(mapa['@megadulces/contracts'], `module.exports = {
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/money/veredicto-cuadre.ts'))}),
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/work/excepciones-movimientos.contract.ts'))}),
  };`);
  process.on('exit', () => { for (const f of Object.values(mapa)) { try { fs.unlinkSync(f); } catch { /* ya no está */ } } });
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
  return require(path.join(raiz, 'libs/commercial/src/lib/commercial-movements/commercial-movements.service.ts')).CommercialMovementsService;
}

(async () => {
  try {
    const col = await knex.raw(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='commercial' AND table_name='stock_movement_audits' AND column_name='resolution_reason'`);
    if (!col.rows.length) {
      noMedido('commercial.stock_movement_audits no tiene resolution_reason (falta la migración 20261029091330)');
      return;
    }
    const Svc = cargarServicio();
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const [wh] = await trx('commercial.warehouses').insert({ tenant_id: T, code: 'TEST-MX24', name: 'Prueba MX.2.4' }).returning('id');
      const whId = wh.id || wh;
      // un ajuste de inventario (siempre va a la bandeja, D3) con un renglón
      await trx('analytics.stock_movements').insert({
        id: 990000000000001, tenant_id: T, warehouse_id: whId, doc_date: DIA, genero: 'S', naturaleza: 'D',
        doc_type: 'InvOut1', doc_code: 'InvOut1', movement_kind: 'out', movement_label: 'Ajuste', folio: FOLIO,
        signed_qty: -12, qty: 12, amount: 345.6, source_branch: 'TEST', sku: 'TEST-SKU',
      });
      const svc = new Svc({ run: (fn) => fn(trx) }, { requireTenantId: () => T, get: () => ({ username: 'prueba-mx24' }) });
      const filas = () => trx('commercial.stock_movement_audits').where({ tenant_id: T, warehouse_id: whId, folio: FOLIO });
      const bandeja = (excepcion) => svc.exceptions({ from: DIA, to: DIA, warehouse_id: whId, excepcion, page: 1, pageSize: 50 });

      console.log('\n[1] Antes de resolver: está en la bandeja');
      const b0 = await bandeja();
      ok(b0.rows.some((r) => r.documento.folio === FOLIO), 'el ajuste sintético aparece como incidencia pendiente');
      ok(b0.rows.find((r) => r.documento.folio === FOLIO)?.donde.includes('-12 piezas'), 'y dice DÓNDE: el producto y las piezas');

      console.log('\n[2] Rechazos (y no escriben nada)');
      const doc = { warehouse_id: whId, doc_code: 'InvOut1', doc_serie: '', folio: FOLIO };
      ok(await rechaza(() => svc.resolveException({ ...doc, motivo: 'porque_si', nota: null }), /motivo/) === true, 'motivo inventado se RECHAZA');
      ok(await rechaza(() => svc.resolveException({ ...doc, motivo: 'otro', nota: '  ' }), /nota/) === true, '«otro» sin nota se RECHAZA');
      ok(await rechaza(() => svc.resolveException({ ...doc, folio: 'NO-EXISTE', motivo: 'ajuste_justificado' }), /no está en el diario/) === true, 'un documento que no existe se RECHAZA');
      ok(await rechaza(() => svc.resolveException({ ...doc, doc_code: 'EntryOr1', motivo: 'ajuste_justificado' }), /traspasos y ajustes/) === true, 'un tipo que no es traspaso ni ajuste se RECHAZA');
      ok((await filas()).length === 0, 'ninguno de los rechazos escribió una fila');

      console.log('\n[3] CONTROL POSITIVO: el payload de la pantalla');
      const r1 = await svc.resolveException({ ...doc, motivo: 'ajuste_justificado', nota: 'Conteo de cierre de mes' });
      ok(r1.motivo === 'ajuste_justificado' && r1.por === 'prueba-mx24', `resuelve y devuelve motivo y quién (${JSON.stringify(r1)})`);
      const f1 = await filas();
      ok(f1.length === 1 && f1[0].resolution_reason === 'ajuste_justificado' && f1[0].note === 'Conteo de cierre de mes', 'la fila guarda motivo y nota');
      const b1 = await bandeja();
      ok(!b1.rows.some((r) => r.documento.folio === FOLIO) && b1.totals.resueltas >= 1, 'sale de pendientes y cuenta en resueltas');
      ok((await bandeja('resueltas')).rows.some((r) => r.documento.folio === FOLIO), 'el filtro «resueltas» la muestra');
      const d1 = await svc.exceptionDetail(doc);
      ok(d1.resolucion?.motivo === 'ajuste_justificado' && d1.renglones[0]?.delta === -12, 'el detalle lee la resolución y el renglón (-12)');

      console.log('\n[4] Resolver otra vez actualiza, no duplica');
      await svc.resolveException({ ...doc, motivo: 'error_de_captura', nota: null });
      const f2 = await filas();
      ok(f2.length === 1 && f2[0].resolution_reason === 'error_de_captura' && f2[0].note === null, 'una sola fila, con el motivo nuevo');

      console.log('\n[5] Una marca del Diario SIN motivo no es una resolución');
      await svc.reopenException(doc);
      ok((await filas()).length === 0, 'reabrir quita la fila');
      await svc.setAudit({ ...doc, audited: true, note: 'visto' });
      const b2 = await bandeja();
      const it = b2.rows.find((r) => r.documento.folio === FOLIO);
      ok(!!it && it.resolucion && it.resolucion.motivo === null, 'marcada «auditado» sin motivo: sigue pendiente y se ve la marca');
      throw new Error(RB);
    }).catch((e) => { if (!e.message.includes(RB)) throw e; });
    const quedo = await knex('commercial.stock_movement_audits').where({ tenant_id: T, folio: FOLIO });
    ok(quedo.length === 0, 'ROLLBACK: no quedó ninguna fila');
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nMX.2.4 resolver incidencias con motivo → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
