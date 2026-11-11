/* eslint-disable no-console */
/**
 * `[MX.2.8]` — Existencia en negativo: la sección de Prevención, contra la base real.
 *
 * `POST /commercial/movements/negative-stock/resolve` ESCRIBE en `commercial.negative_stock_reviews`.
 * Regla 13: una escritura no está probada hasta que se ejerció contra una base real con el payload de
 * la pantalla. Esto carga el `NegativeStockService` REAL (el TS del repo) y lo corre sobre la
 * transacción de la prueba, con renglones SINTÉTICOS de Kepler (`kdil`, `kdm2`) en una sucursal
 * inventada `97`:
 *
 *   ✓ la vista ve lo negativo y NO lo positivo (control: un SKU con existencia +2 no aparece);
 *   ✓ un vale de entrada sin orden de entrada → «entrada sin aplicar» y en cuánto quedaría;
 *     un vale que SÍ tiene su orden de entrada no cuenta (control negativo del EXCEPT);
 *   ✓ sin movimiento en 30 días → rezago, fuera de la lista por defecto (D9), dentro con `causas=rezago`;
 *   ✗ motivo inventado, «faltante» sin nota, SKU que no está en negativo: se RECHAZAN sin escribir;
 *   ✓ CONTROL POSITIVO: el payload de la pantalla resuelve, guarda la existencia de HOY (no la del
 *     payload) y la saca de pendientes; resolver otra vez actualiza, no duplica;
 *   ✓ si Kepler queda MÁS negativo, vuelve a pendientes («se hundió»); reabrir la devuelve;
 *   ✓ alcance (D10): quien sólo ve otra sucursal no ve la 97 ni puede resolverla.
 *
 * Todo en UNA transacción que se revierte: no deja filas.
 */
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const SUC = '97';
const SKU_NEG = 'TEST-NEG-1';     // −5, sin vale, movimiento reciente → salió sin existencia
const SKU_VALE = 'TEST-NEG-2';    // −3, vale de 4 sin aplicar → entrada sin aplicar, quedaría +1
const SKU_POS = 'TEST-NEG-3';     // +2 → NO es incidencia (control)
const SKU_VIEJO = 'TEST-NEG-4';   // −7, sin movimiento desde hace 90 días → rezago

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const rechaza = async (fn, re) => { try { await fn(); return 'pasó'; } catch (e) { return re.test(e.message) ? true : e.message; } };

/** El servicio REAL; sólo se sustituye la infraestructura de `platform-core` y se resuelve `contracts`. */
function cargarServicio() {
  const fs = require('fs');
  const Module = require('module');
  const raiz = path.resolve(__dirname, '..', '..');
  const mapa = {
    '@megadulces/platform-core': path.join(__dirname, '.stub-mx28-platform-core.js'),
    '@megadulces/contracts': path.join(__dirname, '.stub-mx28-contracts.js'),
  };
  fs.writeFileSync(mapa['@megadulces/platform-core'], `module.exports = {
    TenantKnexService: class {}, TenantContextService: class {}, ScopeService: class {},
    ...require(${JSON.stringify(path.join(raiz, 'libs/platform-core/src/lib/scope/scope.types.ts'))}),
    ...require(${JSON.stringify(path.join(raiz, 'libs/platform-core/src/lib/date/mx-date.ts'))}),
  };`);
  fs.writeFileSync(mapa['@megadulces/contracts'], `module.exports = require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/work/existencia-negativa.contract.ts'))});`);
  process.on('exit', () => { for (const f of Object.values(mapa)) { try { fs.unlinkSync(f); } catch { /* ya no está */ } } });
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return mapa[req] || orig.call(this, req, ...rest); };
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: {
      module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0',
    },
  });
  return require(path.join(raiz, 'libs/commercial/src/lib/commercial-movements/negative-stock.service.ts')).NegativeStockService;
}

(async () => {
  try {
    const obj = await knex.raw(`SELECT to_regclass('analytics.v_kepler_negative_stock') AS v,
                                       to_regclass('analytics.v_kepler_unapplied_receipts') AS r,
                                       to_regclass('commercial.negative_stock_reviews') AS t`);
    const o = obj.rows[0];
    if (!o.v || !o.r || !o.t) {
      noMedido(`faltan objetos de la migración 20261103112931 (vista ${!!o.v}, vales ${!!o.r}, tabla ${!!o.t})`);
      return;
    }
    const Svc = cargarServicio();
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const hoy = (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
      const [wh] = await trx('commercial.warehouses').insert({ tenant_id: T, code: SUC, name: 'Prueba MX.2.8', kepler_code: SUC }).returning('id');
      const whId = wh.id || wh;

      const kdil = (sku, entra, sale, dias) => ({
        sucursal: SUC, c1: SUC, c2: 1, c3: sku, c4: 0, c8: entra, c9: sale,
        c6: trx.raw(`now() - (? || ' days')::interval`, [String(dias)]), c7: trx.raw(`now() - (? || ' days')::interval`, [String(dias)]),
      });
      await trx('kepler_ods.kdil').insert([
        kdil(SKU_NEG, 10, 15, 1), kdil(SKU_VALE, 10, 13, 2), kdil(SKU_POS, 10, 8, 1), kdil(SKU_VIEJO, 3, 10, 90),
      ]);
      const linea = (c4, folio, sku, qty, extra = {}) => ({
        sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4, c5: 1, c6: folio, c7: 1, c8: sku, c9: qty,
        c32: trx.raw(`now() - interval '2 days'`), ...extra,
      });
      await trx('kepler_ods.kdm2').insert([
        linea(37, 'TV00001', SKU_VALE, 4),                                         // vale SIN aplicar
        linea(37, 'TV00002', SKU_NEG, 9),                                          // vale aplicado…
        linea(40, 'TO00002', SKU_NEG, 9, { c19: 'A', c20: 37, c22: 'TV00002' }),   // …por su orden de entrada
      ]);

      const ctx = { requireTenantId: () => T, get: () => ({ username: 'prueba-mx28' }) };
      const alcance = (dim) => ({ current: async () => ({ dims: { warehouse: dim } }) });
      const svc = new Svc({ run: (a, b) => (typeof a === 'function' ? a : b)(trx) }, ctx, alcance({ mode: 'all', values: [] }));
      const deLa97 = (r) => r.rows.filter((x) => x.warehouse_id === whId);
      const lista = (q = {}) => svc.list({ warehouse_ids: [whId], pageSize: 200, ...q });
      const filas = () => trx('commercial.negative_stock_reviews').where({ tenant_id: T, warehouse_id: whId });

      console.log('\n[1] Qué ve la bandeja');
      const b0 = await lista();
      const neg = deLa97(b0).find((x) => x.sku === SKU_NEG);
      const vale = deLa97(b0).find((x) => x.sku === SKU_VALE);
      ok(!!neg && neg.existencia === -5 && neg.causa === 'salio_sin_existencia', `−5 sin vale pendiente → salió sin existencia (${neg?.causa})`);
      ok(!!neg && neg.vale === null, 'CONTROL del EXCEPT: el vale que SÍ tiene orden de entrada no cuenta');
      ok(!!vale && vale.causa === 'entrada_sin_aplicar' && vale.quedaria === 1 && /TV00001/.test(vale.donde), `vale sin aplicar → causa y «queda en 1» (${vale?.donde})`);
      ok(!deLa97(b0).some((x) => x.sku === SKU_POS), 'CONTROL: el SKU con existencia +2 NO aparece');
      ok(!deLa97(b0).some((x) => x.sku === SKU_VIEJO), 'el rezago no está en la lista por defecto (D9)…');
      const rz = deLa97(await lista({ causas: ['rezago'] }));
      ok(rz.length === 1 && rz[0].sku === SKU_VIEJO && b0.totals.por_causa.rezago.n >= 1, '…pero se pide aparte y se cuenta en los totales');
      ok(neg?.product_id === null && neg?.valor === null, 'SKU sin ficha en catálogo: se publica, con valor NULL (no 0)');
      ok(b0.totals.universo === 3 && b0.totals.pendientes === 3, `universo = pendientes = 3 antes de resolver (${b0.totals.universo})`);
      const s97 = b0.totals.por_sucursal.find((x) => x.warehouse_id === whId);
      ok(!!s97 && s97.n === 2 && s97.sucursal === 'Prueba MX.2.8', 'por_sucursal: la 97, por NOMBRE, con sus 2 activos (sin el rezago)');

      console.log('\n[2] Rechazos (y no escriben nada)');
      const payload = { warehouse_id: whId, sku: SKU_VALE };
      ok(await rechaza(() => svc.resolve({ ...payload, motivo: 'porque_si' }), /motivo/) === true, 'motivo inventado se RECHAZA');
      ok(await rechaza(() => svc.resolve({ ...payload, motivo: 'faltante_confirmado', nota: ' ' }), /nota/) === true, '«faltante» sin nota se RECHAZA');
      ok(await rechaza(() => svc.resolve({ warehouse_id: whId, sku: SKU_POS, motivo: 'conteo_ajustado' }), /ya no está en negativo/) === true, 'un SKU que no está en negativo se RECHAZA');
      ok((await filas()).length === 0, 'ninguno de los rechazos escribió una fila');

      console.log('\n[3] CONTROL POSITIVO: el payload de la pantalla');
      const r1 = await svc.resolve({ ...payload, motivo: 'entrada_aplicada', nota: null });
      ok(r1.motivo === 'entrada_aplicada' && r1.existencia_vista === -3 && r1.por === 'prueba-mx28' && r1.fecha === hoy,
        `resuelve con la existencia de HOY en Kepler (${JSON.stringify(r1)})`);
      const f1 = await filas();
      ok(f1.length === 1 && Number(f1[0].qty_at_resolution) === -3 && f1[0].resolution_reason === 'entrada_aplicada', 'la fila guarda motivo y existencia vista');
      const b1 = await lista();
      ok(!deLa97(b1).some((x) => x.sku === SKU_VALE) && b1.totals.resueltas >= 1, 'sale de pendientes y cuenta en resueltas');
      ok(deLa97(await lista({ estado: 'resueltas' })).some((x) => x.sku === SKU_VALE && x.resolucion?.motivo === 'entrada_aplicada'), 'el filtro «resueltas» la muestra');
      await svc.resolve({ ...payload, motivo: 'error_de_captura', nota: 'se vendió con la clave 17089' });
      const f2 = await filas();
      ok(f2.length === 1 && f2[0].resolution_reason === 'error_de_captura', 'resolver otra vez actualiza, no duplica');

      console.log('\n[4] Si Kepler queda más negativo, vuelve');
      await trx('kepler_ods.kdil').where({ sucursal: SUC, c3: SKU_VALE }).update({ c9: 14 });
      const v4 = deLa97(await lista()).find((x) => x.sku === SKU_VALE);
      ok(!!v4 && v4.existencia === -4 && v4.reabierta === 'se_hundio' && v4.resolucion?.motivo === 'error_de_captura', `vuelve a pendientes «se hundió» con su resolución vieja a la vista (${v4?.reabierta})`);

      console.log('\n[5] Reabrir');
      ok((await svc.reopen(payload)).reabierta === true, 'reabre');
      const f5 = await filas();
      ok(f5.length === 1 && f5[0].deleted_at !== null, 'la resolución queda como historia (deleted_at), no se borra');
      const v5 = deLa97(await lista()).find((x) => x.sku === SKU_VALE);
      ok(!!v5 && v5.resolucion === null, 'y en la bandeja ya no trae resolución');
      await svc.resolve({ ...payload, motivo: 'conteo_ajustado' });
      ok((await filas()).filter((f) => f.deleted_at === null).length === 1, 'se puede volver a resolver: una sola fila viva');

      console.log('\n[6] Alcance (D10): quien ve otra sucursal no ve ni resuelve la 97');
      const ajeno = new Svc({ run: (a, b) => (typeof a === 'function' ? a : b)(trx) }, ctx, alcance({ mode: 'own', values: ['96'] }));
      const ba = await ajeno.list({ pageSize: 200 });
      ok(ba.alcance === 'propias' && !ba.rows.some((x) => x.warehouse_id === whId), 'no ve la sucursal 97');
      ok(await rechaza(() => ajeno.resolve({ warehouse_id: whId, sku: SKU_NEG, motivo: 'conteo_ajustado' }), /alcance/) === true, 'y no la puede resolver');
      const propio = new Svc({ run: (a, b) => (typeof a === 'function' ? a : b)(trx) }, ctx, alcance({ mode: 'own', values: [SUC] }));
      ok(deLa97(await propio.list({ pageSize: 200 })).some((x) => x.sku === SKU_NEG), 'CONTROL: con alcance sobre la 97 sí la ve');

      // ── [IC.26] Traspaso enviado a la 97 y sin recepción → «entrada sin aplicar» ──────────────
      console.log('\n[7] [IC.26] Traspasos en camino');
      if (!(await trx.raw(`SELECT to_regclass('analytics.v_kepler_transfers_in_transit') AS v`)).rows[0].v) {
        noMedido('falta analytics.v_kepler_transfers_in_transit (migración 20261111085104 sin aplicar)');
        ok(b0.traspasos_revisados === false, 'sin la vista la bandeja lo DECLARA (traspasos_revisados = false), no lo da por cero');
      } else {
        ok(b0.traspasos_revisados === true, 'con la vista, la bandeja dice que revisó traspasos');
        const [o96] = await trx('commercial.warehouses').insert({ tenant_id: T, code: '96', name: 'Prueba IC.26 origen', kepler_code: '96' }).returning('id');
        const [o95] = await trx('commercial.warehouses').insert({ tenant_id: T, code: '95', name: 'Prueba IC.26 otro origen', kepler_code: '95' }).returning('id');
        await trx('analytics.transfer_dest_map').insert([
          { tenant_id: T, dest_code: 'TI097TEST', dest_label: 'Prueba IC.26 a la 97', warehouse_id: whId },
          { tenant_id: T, dest_code: 'TI096TEST', dest_label: 'Prueba IC.26 a la 96', warehouse_id: o96.id || o96 },
          { tenant_id: T, dest_code: 'TI095TEST', dest_label: 'Prueba IC.26 a la 95', warehouse_id: o95.id || o95 },
        ]);
        const SKU_TRAS = 'TEST-NEG-5'; // −30; la 96 le envió 150 sin recepción → queda en 120
        const SKU_REC = 'TEST-NEG-6';  // −10; la 96 le envió 50 y SÍ se recibió → control: salió sin existencia
        const SKU_COL = 'TEST-NEG-7';  // −8; la 95 le envió 20 con el MISMO folio que una recepción de la 96
        await trx('kepler_ods.kdil').insert([kdil(SKU_TRAS, 0, 30, 1), kdil(SKU_REC, 0, 10, 1), kdil(SKU_COL, 0, 8, 1)]);
        const ayer = trx.raw(`now() - interval '1 day'`);
        const cab = (suc, c2, c3, c4, folio, c10, extra = {}) => ({ sucursal: suc, c1: suc, c2, c3, c4, c5: 2, c6: folio, c9: ayer, c10, ...extra });
        const ren = (suc, folio, sku, qty) => ({ sucursal: suc, c1: suc, c2: 'U', c3: 'D', c4: 41, c5: 2, c6: folio, c7: 1, c8: sku, c9: qty, c32: ayer });
        await trx('kepler_ods.kdm1').insert([
          cab('96', 'U', 'D', 41, 'TT00001', 'TI097TEST'),                                         // embarque sin recibir
          cab('96', 'U', 'D', 41, 'TT00002', 'TI097TEST'),                                         // embarque recibido…
          cab(SUC, 'U', 'A', 50, 'TR00001', 'TI096TEST', { c37: 41, c38: 2, c39: 'TT00002' }),    // …por esta recepción
          cab('95', 'U', 'D', 41, 'TT00003', 'TI097TEST'),                                         // embarque de OTRO origen…
          cab(SUC, 'U', 'A', 50, 'TR00002', 'TI096TEST', { c37: 41, c38: 2, c39: 'TT00003' }),    // …y una recepción de la 96 con su folio
        ]);
        await trx('kepler_ods.kdm2').insert([ren('96', 'TT00001', SKU_TRAS, 150), ren('96', 'TT00002', SKU_REC, 50), ren('95', 'TT00003', SKU_COL, 20)]);

        const b7 = deLa97(await lista());
        const tr = b7.find((x) => x.sku === SKU_TRAS);
        ok(!!tr && tr.causa === 'entrada_sin_aplicar' && tr.quedaria === 120 && tr.vale === null
          && tr.traspaso?.piezas === 150 && tr.traspaso?.folios.join() === 'TT00001' && tr.traspaso?.origen === 'Prueba IC.26 origen',
          `embarque sin recepción → «entrada sin aplicar», queda en 120, con folio y origen por NOMBRE (${tr?.donde})`);
        ok(!!tr && /Prueba IC\.26 origen le envió 150 pz en el traspaso TT00001/.test(tr.donde) && /al capturarla queda en 120 pz/.test(tr.donde), 'el «dónde» dice quién lo envió y qué capturar');
        const rc = b7.find((x) => x.sku === SKU_REC);
        ok(!!rc && rc.causa === 'salio_sin_existencia' && !rc.traspaso && /ni traspaso/.test(rc.donde),
          `CONTROL: el embarque que SÍ se recibió no cuenta (${rc?.causa})`);
        const co = b7.find((x) => x.sku === SKU_COL);
        ok(!!co && co.causa === 'entrada_sin_aplicar' && co.traspaso?.origen === 'Prueba IC.26 otro origen',
          `el folio es secuencia POR sucursal: la recepción de la 96 no cierra el embarque de la 95 (${co?.causa})`);
      }
      throw new Error(RB);
    }).catch((e) => { if (!e.message.includes(RB)) throw e; });
    const quedo = await knex('kepler_ods.kdil').where({ sucursal: SUC }).whereIn('c3', [SKU_NEG, SKU_VALE, SKU_POS, SKU_VIEJO, 'TEST-NEG-5', 'TEST-NEG-6', 'TEST-NEG-7']);
    ok(quedo.length === 0, 'ROLLBACK: no quedó ningún renglón sintético');
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nMX.2.8 existencia negativa (Prevención) → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
