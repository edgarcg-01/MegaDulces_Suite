#!/usr/bin/env node
'use strict';
/**
 * `[CANON.5.25]` La captura manual de parámetros de pedido NO la pisa el importer.
 *
 * `/compras/proveedores` guarda UN parámetro a la vez (`POST suppliers/:id/order-params` con
 * `{ cadence_days_override: 9 }`, por ejemplo) y `import-supplier-params` los deriva cada noche.
 * Antes nada decía quién puso cada valor, así que el importer sólo llenaba NULL y lo derivado nunca
 * se refrescaba (medido el 2026-11-06: 260 de 290 proveedores con algún valor distinto del derivable).
 *
 *   A. La regla del importer (`planearProveedor`, pura): refresca lo `derivado`, no toca `manual` ni
 *      `desconocido`, y clasifica lo que no tiene llave.
 *   B. El endpoint que ESCRIBE (regla 13): el servicio real contra una base real, con el payload de la
 *      pantalla, deja el valor y la marca `manual` en la misma fila; y después la regla del importer
 *      sobre esa fila no la pisa. Todo dentro de una transacción que se revierte.
 *   PRUEBA NEGATIVA: la misma fila SIN la marca sí se pisaría (si eso sale verde, la prueba no mide).
 *
 * Sin la columna (migración 20261106135431 sin aplicar) o sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-supplier-params-procedencia');

const T = '00000000-0000-0000-0000-00000000d01c';
const USER = '99999999-8888-4777-8666-555555555555';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

const { planearProveedor } = require('../importers/kepler/import-supplier-params.js');
const D = { cadence: 10, colchon: 4, minAmt: 50000, minCaj: 30 };

console.log('\n── A. la regla del importer ──');
{
  const fila = (src, vals = {}) => ({ cadence_days_override: 7, colchon_days: 3, min_order_amount: '20000.00', min_order_boxes: '12', order_params_source: src, ...vals });
  let p = planearProveedor(fila({ cadence_days_override: 'manual', colchon_days: 'desconocido', min_order_amount: 'derivado', min_order_boxes: 'derivado' }), D, true);
  ok(!('cadence_days_override' in p.set), 'manual: no se pisa');
  ok(!('colchon_days' in p.set), 'desconocido: no se pisa');
  ok(p.set.min_order_amount === 50000 && p.set.min_order_boxes === 30, 'derivado: se refresca');
  ok(Object.keys(p.marca).length === 0, 'lo que ya tiene marca no se re-marca');

  p = planearProveedor(fila({}, { cadence_days_override: null, colchon_days: 4 }), D, true);
  ok(p.set.cadence_days_override === 10 && p.marca.cadence_days_override === 'derivado', 'sin llave y NULL: se llena y queda derivado');
  ok(!('colchon_days' in p.set) && p.marca.colchon_days === 'derivado', 'sin llave e igual a lo derivable: derivado, sin escribir el valor');
  ok(!('min_order_amount' in p.set) && p.marca.min_order_amount === 'desconocido', 'sin llave y distinto: desconocido, el valor se queda');

  p = planearProveedor(fila({}, { cadence_days_override: null, colchon_days: 9 }), D, false);
  ok(p.set.cadence_days_override === 10 && !('colchon_days' in p.set) && Object.keys(p.marca).length === 0, 'sin la columna: el comportamiento viejo (sólo NULL, sin marcas)');

  p = planearProveedor(fila({}), { ...D, minCaj: null }, true);
  ok(!('min_order_boxes' in p.set) && !('min_order_boxes' in p.marca), 'lo que no se pudo derivar (cajas sin factor) no se toca ni se clasifica');
}

console.log('\n── B. el endpoint que escribe, contra base real ──');
(async () => {
  let Servicio;
  try {
    require('ts-node').register({
      transpileOnly: true, skipProject: true,
      compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
    });
    const tsc = require('typescript');
    const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
    require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
    require('reflect-metadata');
    ({ CommercialReplenishmentService: Servicio } = require(path.join(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts')));
  } catch (e) { noMedido(`no se pudo cargar el servicio real con ts-node: ${e.message}`); return salir(); }

  const knex = require('knex')(require('../knexfile-newdb.js').development);
  const REVERTIR = new Error('revertir');
  try {
    await knex.raw('SELECT 1');
  } catch (e) { noMedido(`sin base: ${e.message}`); await knex.destroy().catch(() => {}); return salir(); }
  try {
    await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
      const col = (await trx.raw(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='catalog'
        AND table_name='suppliers' AND column_name='order_params_source') AS c`)).rows[0].c;
      if (!col) { noMedido('falta catalog.suppliers.order_params_source (migración 20261106135431 sin aplicar)'); throw REVERTIR; }
      const ten = (await trx.raw('SELECT 1 FROM identity.tenants WHERE id = ?', [T])).rows.length;
      if (!ten) { noMedido('la base no tiene el tenant mega_dulces'); throw REVERTIR; }

      const [sup] = await trx('catalog.suppliers')
        .insert({ tenant_id: T, code: 'TEST-CANON525', name: 'PROVEEDOR DE PRUEBA CANON.5.25', cadence_days_override: 7, colchon_days: 3 })
        .returning(['id']);
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log() {}, warn() {}, error() {}, debug() {} },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: USER }) },
        tk: { run: (fn) => fn(trx) },
      });

      // el payload exacto de compras-proveedores.component.ts → saveParam(r, { cadence_days_override })
      await s.setSupplierOrderParams(sup.id, { cadence_days_override: 9 });
      let r = await trx('catalog.suppliers').where({ id: sup.id }).first();
      ok(r.cadence_days_override === 9, 'el valor capturado queda en la fila');
      ok(r.order_params_source?.cadence_days_override === 'manual', 'y en la MISMA escritura queda marcado manual');
      ok(r.updated_by === USER, 'y firmado por quien lo capturó');
      ok(!('colchon_days' in (r.order_params_source || {})), 'el campo que no se tocó no se marca');

      await s.setSupplierOrderParams(sup.id, { min_order_amount: 15000 });
      r = await trx('catalog.suppliers').where({ id: sup.id }).first();
      ok(r.order_params_source?.cadence_days_override === 'manual' && r.order_params_source?.min_order_amount === 'manual', 'una segunda captura SUMA su marca, no borra la anterior');

      await s.setSupplierMinBoxes(sup.id, 40);
      r = await trx('catalog.suppliers').where({ id: sup.id }).first();
      ok(r.order_params_source?.min_order_boxes === 'manual', 'el endpoint de mínimo en cajas también marca');

      const p = planearProveedor(r, D, true);
      ok(!('cadence_days_override' in p.set) && !('min_order_amount' in p.set) && !('min_order_boxes' in p.set),
        'la noche siguiente, el importer no pisa nada de lo capturado');
      ok(p.marca.colchon_days === 'desconocido', 'el colchón previo (sin llave y distinto) queda protegido como desconocido');

      // PRUEBA NEGATIVA: la misma fila sin marcas → el importer sí la pisaría.
      const neg = planearProveedor({ ...r, order_params_source: { cadence_days_override: 'derivado' } }, D, true);
      ok(neg.set.cadence_days_override === 10, 'NEGATIVA: sin la marca manual, el importer sí la pisaría (la prueba distingue)');
      throw REVERTIR;
    });
  } catch (e) {
    if (e !== REVERTIR) { fail++; console.log('  ✗ error:', e.message); }
  } finally {
    await knex.destroy().catch(() => {});
  }
  salir();
})();
