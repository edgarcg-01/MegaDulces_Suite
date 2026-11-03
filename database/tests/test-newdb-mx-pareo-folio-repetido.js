/* eslint-disable no-console */
/**
 * `[MX.2.7]` — Una recepción NO se pega a la salida de otra sucursal que repite su folio.
 *
 * Reportado el 2026-11-02 desde `/almacen/incidencias` (rango 5–11 oct): cuatro «diferencia»
 * —CEDIS 0000818/819/820 → Padre Hidalgo y 0000895 → Morelia Madero— que en Kepler cuadraban. La
 * recepción del 30-oct citaba «folio 0000818 serie 2», que era la salida de Morelia Abastos del
 * 28-oct; esa salida quedaba FUERA de la ventana de candidatos (from−90 … to+15) y la recepción, que
 * sí entraba (from−15 … to+90), se pegaba a la única «0000818 serie 2» visible: la de CEDIS del
 * 5-oct. Resultado: «salieron X y no llegó» + «llegaron Y y no venía en la salida», 0 productos en
 * común. Medido contra prod: septiembre 18 → 3 y agosto 26 → 3 diferencias; el importe del rango
 * del Cuadre contaba esas salidas dos veces (−$1.39 M en septiembre).
 *
 * Escenario sintético (fechas de 2025, fuera de cualquier dato real), servicio REAL:
 *   salida A  · almacén ORIGEN-A · serie 2 · folio F · 5-feb  · 3 productos → recepción R1 el 5-feb, idéntica
 *   salida B  · almacén ORIGEN-B · serie 2 · folio F · 28-feb · 1 producto  → recepción R2 el 2-mar, idéntica
 *   ✓ rango 5–11 feb: ninguna «diferencia» (antes: R2 se pegaba a A).
 *   ✓ rango ancho 1-feb–10-mar: ninguna «diferencia» — el pareo no depende de la ventana.
 *   ✓ CONTROL POSITIVO: una salida C a la que le faltan piezas en su recepción SÍ es «diferencia»
 *     (sin esto, un pareo que no reporta nada se vería igual de verde).
 * Todo en UNA transacción que se revierte.
 */
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const F = 'TEST-MX27-0818';
const FC = 'TEST-MX27-0900';
const DC = 'TEST-MX27-DEST';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const RB = '__rb__';

/** El servicio REAL; sólo se sustituye la infraestructura (mismo cargador que test-newdb-mx-resolucion.js). */
function cargarServicio() {
  const fs = require('fs');
  const Module = require('module');
  const raiz = path.resolve(__dirname, '..', '..');
  const mapa = {
    '@megadulces/platform-core': path.join(__dirname, '.stub-mx27-platform-core.js'),
    '@megadulces/contracts': path.join(__dirname, '.stub-mx27-contracts.js'),
  };
  fs.writeFileSync(mapa['@megadulces/platform-core'], 'module.exports = { TenantKnexService: class {}, TenantContextService: class {} };');
  fs.writeFileSync(mapa['@megadulces/contracts'], `module.exports = {
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/money/veredicto-cuadre.ts'))}),
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/work/excepciones-movimientos.contract.ts'))}),
  };`);
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
  return require(path.join(raiz, 'libs/commercial/src/lib/commercial-movements/commercial-movements.service.ts')).CommercialMovementsService;
}

(async () => {
  try {
    const Svc = cargarServicio();
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const alta = async (code, name) => { const [w] = await trx('commercial.warehouses').insert({ tenant_id: T, code, name }).returning('id'); return w.id || w; };
      const origenA = await alta('TEST-MX27-A', 'Prueba MX.2.7 origen A');
      const origenB = await alta('TEST-MX27-B', 'Prueba MX.2.7 origen B');
      const destino = await alta('TEST-MX27-D', 'Prueba MX.2.7 destino');
      await trx('analytics.transfer_dest_map').insert({ tenant_id: T, dest_code: DC, dest_label: 'Prueba MX.2.7 destino', warehouse_id: destino });

      let id = 990000000002700;
      const salida = (wh, folio, fecha, sku, qty) => ({
        id: id++, tenant_id: T, warehouse_id: wh, doc_date: fecha, genero: 'N', naturaleza: 'D', doc_type: 'TrsfShip', doc_code: 'TrsfShip',
        movement_kind: 'out', movement_label: 'Traspaso', doc_serie: '2', folio, signed_qty: -qty, qty, amount: qty * 10,
        source_branch: 'TEST', sku, dest_code: DC,
      });
      const recepcion = (folio, padre, fecha, sku, qty) => ({
        id: id++, tenant_id: T, warehouse_id: destino, doc_date: fecha, genero: 'N', naturaleza: 'A', doc_type: 'TrsfRcv', doc_code: 'TrsfRcv',
        movement_kind: 'in', movement_label: 'Traspaso', doc_serie: '1', folio, signed_qty: qty, qty, amount: qty * 10,
        source_branch: 'TEST', sku, parent_group: '41', parent_serie: '2', parent_folio: padre,
      });
      await trx('analytics.stock_movements').insert([
        salida(origenA, F, '2025-02-05', 'TEST27-S1', 10), salida(origenA, F, '2025-02-05', 'TEST27-S2', 20), salida(origenA, F, '2025-02-05', 'TEST27-S3', 30),
        recepcion('TEST-MX27-R1', F, '2025-02-05', 'TEST27-S1', 10), recepcion('TEST-MX27-R1', F, '2025-02-05', 'TEST27-S2', 20), recepcion('TEST-MX27-R1', F, '2025-02-05', 'TEST27-S3', 30),
        salida(origenB, F, '2025-02-28', 'TEST27-S9', 150),
        recepcion('TEST-MX27-R2', F, '2025-03-02', 'TEST27-S9', 150),
        // control positivo: salida C con 40 piezas, llegan 35
        salida(origenA, FC, '2025-02-07', 'TEST27-S4', 40),
        recepcion('TEST-MX27-R3', FC, '2025-02-07', 'TEST27-S4', 35),
      ]);
      const svc = new Svc({ run: (fn) => fn(trx) }, { requireTenantId: () => T, get: () => ({ username: 'prueba-mx27' }) });
      const diferencias = async (from, to) => (await svc.exceptions({ from, to, excepcion: 'diferencia', page: 1, pageSize: 200 })).rows
        .filter((r) => r.tipo === 'traspaso' && r.excepciones.includes('diferencia') && [F, FC].includes(r.documento.folio));

      console.log('\n[1] Rango 5–11 feb: la salida B (28-feb) queda fuera del rango pero es candidata');
      const d1 = await diferencias('2025-02-05', '2025-02-11');
      ok(!d1.some((r) => r.documento.folio === F), `ninguna «diferencia» para el folio repetido (${d1.map((r) => r.documento.folio + ': ' + r.donde).join(' | ') || 'ninguna'})`);

      console.log('\n[2] Rango ancho: el resultado no depende de la ventana');
      const d2 = await diferencias('2025-02-01', '2025-03-10');
      ok(!d2.some((r) => r.documento.folio === F), 'ninguna «diferencia» para el folio repetido con las dos salidas dentro');

      console.log('\n[3] CONTROL POSITIVO: una diferencia verdadera sí se reporta');
      ok(d1.filter((r) => r.documento.folio === FC).length === 1 && d2.filter((r) => r.documento.folio === FC).length === 1,
        'la salida C (40 → 35) es «diferencia» en los dos rangos');
      throw new Error(RB);
    }).catch((e) => { if (!e.message.includes(RB)) throw e; });
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nMX.2.7 pareo con folio repetido entre sucursales → ${pass} ✓ · ${fail} ✗`);
  process.exit(fail ? 1 : 0);
})();
