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
 *   [MX.2.6] ✓ dos ajustes del mismo día y tienda son UNA incidencia con neto, y se resuelven juntos;
 *     ✓ un ajuste que llega DESPUÉS de resolver el día lo devuelve a pendientes;
 *     ✗ si un folio del grupo no existe se rechaza TODO (todo o nada).
 *
 * Todo en UNA transacción que se revierte: no deja filas. Almacén y documento sintéticos `TEST-MX24`.
 */
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const FOLIO = 'TEST-MX24-0001';
const FOLIO2 = 'TEST-MX24-0002';
const FOLIO3 = 'TEST-MX24-0003';
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
      // dos ajustes de inventario el MISMO día (siempre van a la bandeja, D3): uno sale, otro entra
      const renglon = (id, doc_code, folio, signed, amount, sku) => ({
        id, tenant_id: T, warehouse_id: whId, doc_date: DIA, genero: doc_code === 'InvIn1' ? 'E' : 'S', naturaleza: 'D',
        doc_type: doc_code, doc_code, movement_kind: signed < 0 ? 'out' : 'in', movement_label: 'Ajuste', folio,
        signed_qty: signed, qty: Math.abs(signed), amount, source_branch: 'TEST', sku,
      });
      await trx('analytics.stock_movements').insert([
        renglon(990000000000001, 'InvOut1', FOLIO, -12, 345.6, 'TEST-SKU'),
        renglon(990000000000002, 'InvIn1', FOLIO2, 5, 100, 'TEST-SKU-2'),
      ]);
      const svc = new Svc({ run: (fn) => fn(trx) }, { requireTenantId: () => T, get: () => ({ username: 'prueba-mx24' }) });
      const filas = () => trx('commercial.stock_movement_audits').where({ tenant_id: T, warehouse_id: whId, folio: FOLIO });
      const filasDia = () => trx('commercial.stock_movement_audits').where({ tenant_id: T, warehouse_id: whId }).whereIn('folio', [FOLIO, FOLIO2, FOLIO3]);
      const delDia = (b) => b.rows.find((r) => r.documentos.some((d) => d.folio === FOLIO));
      const bandeja = (excepcion) => svc.exceptions({ from: DIA, to: DIA, warehouse_id: whId, excepcion, page: 1, pageSize: 50 });

      console.log('\n[1] Antes de resolver: los dos ajustes del día son UNA incidencia');
      const b0 = await bandeja();
      const i0 = delDia(b0);
      ok(!!i0 && b0.rows.filter((r) => r.tipo === 'ajuste').length === 1 && i0.documentos.length === 2, 'una sola incidencia con los dos folios');
      ok(Math.abs((i0?.ajuste?.neto_importe ?? 0) - (100 - 345.6)) < 0.001 && i0?.ajuste?.neto_piezas === -7, 'con su neto: -7 piezas, -$245.60 (' + JSON.stringify(i0?.ajuste) + ')');
      ok(/Entraron 1 producto .* y salieron 1 .*; neto −\$246\. Lo más pesado: .* -12 piezas/.test(i0?.donde || ''), 'y dice DÓNDE (' + i0?.donde + ')');

      console.log('\n[2] Rechazos (y no escriben nada)');
      const doc = { warehouse_id: whId, doc_code: 'InvOut1', doc_serie: '', folio: FOLIO };
      ok(await rechaza(() => svc.resolveException({ ...doc, motivo: 'porque_si', nota: null }), /motivo/) === true, 'motivo inventado se RECHAZA');
      ok(await rechaza(() => svc.resolveException({ ...doc, motivo: 'otro', nota: '  ' }), /nota/) === true, '«otro» sin nota se RECHAZA');
      ok(await rechaza(() => svc.resolveException({ ...doc, folio: 'NO-EXISTE', motivo: 'ajuste_justificado' }), /no está en el diario/) === true, 'un documento que no existe se RECHAZA');
      ok(await rechaza(() => svc.resolveException({ ...doc, doc_code: 'EntryOr1', motivo: 'ajuste_justificado' }), /traspasos y ajustes/) === true, 'un tipo que no es traspaso ni ajuste se RECHAZA');
      ok((await filas()).length === 0, 'ninguno de los rechazos escribió una fila');

      console.log('\n[3] CONTROL POSITIVO: el payload de la pantalla');
      // la pantalla manda el primero en el cuerpo y TODOS en `documentos` (almacen-movimientos.service.ts)
      const docs = i0.documentos;
      const r1 = await svc.resolveException({ ...docs[0], documentos: docs, motivo: 'ajuste_justificado', nota: 'Conteo de cierre de mes' });
      ok(r1.motivo === 'ajuste_justificado' && r1.por === 'prueba-mx24', `resuelve y devuelve motivo y quién (${JSON.stringify(r1)})`);
      const f1 = await filas();
      ok(f1.length === 1 && f1[0].resolution_reason === 'ajuste_justificado' && f1[0].note === 'Conteo de cierre de mes', 'la fila guarda motivo y nota');
      ok((await filasDia()).filter((f) => f.resolution_reason === 'ajuste_justificado').length === 2, 'los DOS folios del día quedaron resueltos');
      const b1 = await bandeja();
      ok(!delDia(b1) && b1.totals.resueltas >= 1, 'sale de pendientes y cuenta en resueltas');
      ok(!!delDia(await bandeja('resueltas')), 'el filtro «resueltas» la muestra');
      const d1 = await svc.exceptionDetail(doc);
      ok(d1.resolucion?.motivo === 'ajuste_justificado' && d1.documentos.length === 2 && d1.renglones[0]?.delta === -12,
        'el detalle (abierto desde un folio) trae el día completo, la resolución y el renglón (-12)');

      console.log('\n[3b] Un ajuste que llega DESPUÉS de resolver el día lo reabre');
      await trx('analytics.stock_movements').insert(renglon(990000000000003, 'InvOut1', FOLIO3, -1, 10, 'TEST-SKU-3'));
      const b1b = await bandeja();
      ok(!!delDia(b1b) && delDia(b1b).documentos.length === 3 && delDia(b1b).resolucion === null, 'vuelve a pendientes con los tres folios');
      await svc.resolveException({ ...docs[0], documentos: delDia(b1b).documentos, motivo: 'ajuste_justificado', nota: 'Conteo de cierre de mes' });
      ok(!delDia(await bandeja()), 'resuelto otra vez con los tres, sale');
      const malos = [...delDia(await bandeja('resueltas')).documentos, { ...docs[0], folio: 'NO-EXISTE' }];
      ok(await rechaza(() => svc.resolveException({ ...docs[0], documentos: malos, motivo: 'error_de_captura' }), /NO-EXISTE/) === true,
        'NEGATIVA: si un folio del grupo no existe, se rechaza TODO…');
      ok((await filasDia()).every((f) => f.resolution_reason === 'ajuste_justificado'), '…y no cambió ninguno (todo o nada)');

      console.log('\n[4] Resolver otra vez actualiza, no duplica');
      await svc.resolveException({ ...doc, motivo: 'error_de_captura', nota: null });
      const f2 = await filas();
      ok(f2.length === 1 && f2[0].resolution_reason === 'error_de_captura' && f2[0].note === null, 'una sola fila, con el motivo nuevo');

      console.log('\n[5] Una marca del Diario SIN motivo no es una resolución');
      const todos = delDia(await bandeja('resueltas')).documentos;
      await svc.reopenException({ ...todos[0], documentos: todos });
      ok((await filasDia()).length === 0, 'reabrir quita las filas de todos los folios del día');
      await svc.setAudit({ ...doc, audited: true, note: 'visto' });
      const it = delDia(await bandeja());
      ok(!!it && it.resolucion && it.resolucion.motivo === null, 'marcada «auditado» sin motivo: sigue pendiente y se ve la marca');
      throw new Error(RB);
    }).catch((e) => { if (!e.message.includes(RB)) throw e; });
    const quedo = await knex('commercial.stock_movement_audits').where({ tenant_id: T }).whereIn('folio', [FOLIO, FOLIO2, FOLIO3]);
    ok(quedo.length === 0, 'ROLLBACK: no quedó ninguna fila');
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nMX.2.4/2.6 resolver incidencias con motivo (y ajustes del día) → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
