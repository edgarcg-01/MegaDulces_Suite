/**
 * `[AB.29]` + `[AB.32]` «ENVIAR A COMPRAS» Y EL RECHAZO CON MOTIVO — servicio REAL contra una base REAL.
 *
 * Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base real,
 * con el payload de la pantalla. Esta corre contra la BASE LOCAL DE PRUEBAS (`postgres_platform`, la de
 * caja: marca `public._caja_test_base`) y SE NIEGA a correr contra prod (`system_identifier`).
 *
 * Lo único simulado es la LECTURA del motor (`armarAlmacen`: la base local no tiene plan de reabasto):
 * se le dan renglones armados con `armarRenglon` del contrato. Todo lo que ESCRIBE es real: el servicio de
 * Autoabasto (`enviar`, con `{ warehouse_id, product_ids, nota }`, lo que manda la pantalla), el motor
 * (`crearRequisicionesDeSucursal`, `insertRequisition`, `reject`, `bulkEstado`), las restricciones de la
 * migración `20261026084306` y RLS (el servicio escribe como `app_runtime`).
 *
 *   1. Un envío con 4 productos crea DOS requisiciones (su matriz y el proveedor) y omite, con su porqué,
 *      el que ya viene y el que no tiene ruta. A quién le llega sale de la responsabilidad repartida.
 *   2. En la base: marcadas `requested_by_branch`, por aprobar, base `demanda`, origen correcto, cajas.
 *   3. Reenviar lo mismo NO duplica (lo vivo se vuelve a mirar dentro de la transacción).
 *   4. Dos envíos simultáneos del mismo producto crean UNA sola requisición (candado por almacén).
 *   5. Rechazar una de sucursal SIN motivo → 400, sigue por aprobar.
 *   6. Con motivo → cancelada, con motivo, quién y cuándo.
 *   7. La base misma rechaza un rechazo sin motivo (CHECK) — negativa a nivel de datos.
 *   8. Una requisición de Compras se sigue rechazando sin motivo (no se rompe lo de antes).
 *   9. En lote, una de sucursal sin motivo falla sola, con su mensaje.
 * Al final borra todo lo que sembró.
 *
 * Uso: node database/tests/test-localdb-requisicion-sucursal.js
 *   REQ_TEST_DB_URL (dueño, siembra y limpia; default postgres@127.0.0.1:5432/postgres_platform)
 *   REQ_TEST_APP_URL (el servicio; default app_runtime@127.0.0.1:5432/postgres_platform)
 */
const path = require('path');
const { randomUUID } = require('crypto');

const PROD_SID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.join(__dirname, '..', '..');
const DUENO = process.env.REQ_TEST_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform';
const APP = process.env.REQ_TEST_APP_URL || 'postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Motor, Pedido, C;
// La plataforma exige un secreto de firma al CARGAR el módulo. Esta prueba no firma nada y NO lee
// `.env` a propósito (ahí viven las URLs de prod): un valor local de prueba, nunca uno real.
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-ab29-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  const L = path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/');
  ({ CommercialReplenishmentService: Motor } = require(L + 'commercial-replenishment.service.ts'));
  ({ AutoabastoPedidoService: Pedido } = require(L + 'autoabasto-pedido.service.ts'));
  C = require(path.join(RAIZ, 'libs/contracts/src/http/autoabasto-pedido.contract.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const dueno = require('knex')({ client: 'pg', connection: DUENO, pool: { min: 0, max: 2 } });
const app = require('knex')({ client: 'pg', connection: APP, pool: { min: 0, max: 4 } });
const sembrado = { requisiciones: new Set(), productos: [], marca: null, proveedor: null, responsabilidad: null, secuencia: false };

const salir = async () => {
  try {
    if (sembrado.requisiciones.size) await dueno('commercial.purchase_requisitions').whereIn('id', [...sembrado.requisiciones]).del();
    // Lo que el servicio haya creado y la prueba no alcanzó a anotar (p. ej. por un fallo a la mitad).
    if (sembrado.productos.length) {
      const ids = (await dueno('commercial.purchase_requisition_lines').whereIn('product_id', sembrado.productos).distinct('requisition_id')).map((r) => r.requisition_id);
      if (ids.length) await dueno('commercial.purchase_requisitions').whereIn('id', ids).del();
      await dueno('catalog.products').whereIn('id', sembrado.productos).del();
    }
    if (sembrado.proveedor) await dueno('catalog.suppliers').where({ id: sembrado.proveedor }).del();
    if (sembrado.marca) await dueno('catalog.brands').where({ id: sembrado.marca }).del();
    if (sembrado.responsabilidad) await dueno('identity.user_responsibilities').where({ id: sembrado.responsabilidad }).del();
    if (sembrado.secuencia) await dueno('commercial.requisition_sequences').where({ tenant_id: T }).del();
  } catch (e) { console.log('  ⚠️ limpieza incompleta:', e.message); fail++; }
  await dueno.destroy(); await app.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};

(async () => {
  console.log('\n[AB.29/AB.32] Enviar a Compras y rechazo con motivo — servicio real, base local de pruebas\n');
  const sid = (await dueno.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  const marca = (await dueno.raw(`SELECT to_regclass('public._caja_test_base') AS t`)).rows[0].t;
  console.log(`  base: system_identifier ${sid} · marca de base de pruebas: ${marca ? 'sí' : 'NO'}\n`);
  if (sid === PROD_SID || !marca) { console.log('  ⛔ No es la base local de pruebas: no se escribe nada.'); fail++; return salir(); }
  const col = (await dueno.raw(`SELECT 1 FROM information_schema.columns WHERE table_schema='commercial' AND table_name='purchase_requisitions' AND column_name='requested_by_branch'`)).rows.length;
  if (!col) { noMedido('la base no tiene la migración 20261026084306 aplicada'); return salir(); }

  // ── Siembra ──────────────────────────────────────────────────────────────────────────────
  const [suc, matriz] = await Promise.all(['07', '08'].map((c) => dueno('commercial.warehouses').where({ tenant_id: T, code: c }).first('id', 'code', 'name')));
  if (!suc || !matriz) { noMedido('faltan los almacenes 07 / 08 en la base de pruebas'); return salir(); }
  const persona = await dueno('identity.users').where({ tenant_id: T, username: 'superoot' }).first('id', 'nombre');
  sembrado.secuencia = !(await dueno('commercial.requisition_sequences').where({ tenant_id: T }).first());
  sembrado.marca = randomUUID();
  await dueno('catalog.brands').insert({ id: sembrado.marca, tenant_id: T, nombre: 'AB29 PRUEBA' });
  sembrado.proveedor = randomUUID();
  await dueno('catalog.suppliers').insert({ id: sembrado.proveedor, tenant_id: T, code: 'AB29TEST', name: 'Proveedor de prueba AB29' });
  const P = Array.from({ length: 6 }, () => randomUUID());
  sembrado.productos = P;
  await dueno('catalog.products').insert(P.map((id, i) => ({ id, tenant_id: T, brand_id: sembrado.marca, nombre: `AB29 prueba ${i + 1}`, sku: `AB29T${i + 1}` })));
  sembrado.responsabilidad = randomUUID();
  await dueno('identity.user_responsibilities').insert({ id: sembrado.responsabilidad, tenant_id: T, user_id: persona.id,
    responsibility_key: 'compras.requisiciones_sucursal', accion: 'suma', nota: 'AB29 prueba local — se borra al terminar' });

  // ── Servicio real, escribiendo como app_runtime ──────────────────────────────────────────
  const tk = { run: (fn) => app.transaction(async (trx) => { await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]); return fn(trx); }) };
  const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: persona.id }) };
  const motor = Object.assign(Object.create(Motor.prototype), { tk, tenantCtx: ctx, logger: { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    scope: { warehouseIds: async () => null } });
  const svc = Object.assign(Object.create(Pedido.prototype), { motor, tk, tenantCtx: ctx });

  // Lo único simulado: los renglones del motor (la base local no tiene plan de reabasto).
  const esc = { unit_base: 'PZA', u2_label: 'PAQ', u3_label: 'CJA', f2: null, f3: 12, is_weight: false };
  const renglon = (product_id, sku, surte, viene) => {
    const a = C.armarRenglon({ product_id, sku, nombre: sku, venta_30d: 10, existencia: 1, objetivo: 5, falta: 4, falta_base: 48,
      caja_factor: 12, costo_base: 2, rung_veredicto: null, posicion: 'bajo_minimo', viene, planeado_compras: 0, pedido_sucursal: 0,
      escalera: esc, ajuste: null, surte });
    return { ...a, fila: { on_hand: 1, in_transit: 0, min_stock: 2, reorder_point: 3, max_stock: 5 }, cf: 12 };
  };
  const deMatriz = { tipo: 'matriz', clave: matriz.code, nombre: matriz.code };
  const delProv = { tipo: 'proveedor', clave: sembrado.proveedor, nombre: 'Proveedor de prueba AB29' };
  const sinRuta = { tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' };
  const mesa = [
    renglon(P[0], 'AB29T1', deMatriz, null),
    renglon(P[1], 'AB29T2', delProv, null),
    renglon(P[2], 'AB29T3', deMatriz, { ya: 48, atorado: 0, negado: 0, camino: 0 }), // ya viene todo
    renglon(P[3], 'AB29T4', sinRuta, null),
    renglon(P[4], 'AB29T5', deMatriz, null),
  ];
  svc.armarAlmacen = async () => ({ renglones: mesa });
  const alm = { id: suc.id, code: suc.code, name: suc.name };
  const anotar = (r) => { for (const q of r.requisiciones) sembrado.requisiciones.add(q.id); return r; };

  // 1 · El envío.
  const r1 = anotar(await svc.enviar(alm, 'almacen', { warehouse_id: suc.id, product_ids: [P[0], P[1], P[2], P[3]], nota: 'prueba AB29' }));
  const tipos = r1.requisiciones.map((q) => q.surte.tipo).sort();
  const om = Object.fromEntries(r1.omitidos.map((o) => [o.product_id, o.motivo]));
  ok(r1.requisiciones.length === 2 && tipos.join() === 'matriz,proveedor',
    `1. dos requisiciones, una por origen (${tipos.join(' + ')})`, r1);
  ok(om[P[2]] === 'Ya viene lo que falta' && om[P[3]] === 'No tiene a quién pedírselo (sin ruta configurada)',
    `1. omitidos con su porqué: «${om[P[2]]}» · «${om[P[3]]}»`, r1.omitidos);
  ok(r1.le_llega_a.includes(persona.nombre), `1. le llega a quien tiene la responsabilidad (${r1.le_llega_a.join(', ')})`);

  // 2 · Lo que quedó en la base.
  const filas = await dueno('commercial.purchase_requisitions as r').whereIn('r.id', r1.requisiciones.map((q) => q.id))
    .select('r.id', 'r.requested_by_branch', 'r.estado', 'r.target_basis', 'r.source_type', 'r.source_warehouse_id', 'r.supplier_id', 'r.notes', 'r.created_by');
  const lineas = await dueno('commercial.purchase_requisition_lines').whereIn('requisition_id', r1.requisiciones.map((q) => q.id)).select('requisition_id', 'product_id', 'final_qty', 'suggested_qty');
  const tr = filas.find((f) => f.source_type === 'branch'), cp = filas.find((f) => f.source_type === 'supplier');
  ok(filas.length === 2 && filas.every((f) => f.requested_by_branch === true && f.estado === 'pending_approval' && f.target_basis === 'demanda' && f.created_by === persona.id),
    '2. marcadas «pedida por sucursal», por aprobar, base demanda, con su autor', filas);
  ok(tr && tr.source_warehouse_id === matriz.id && cp && cp.supplier_id === sembrado.proveedor,
    `2. el traspaso sale de su matriz (${matriz.code}) y la compra va a su proveedor`);
  ok(lineas.length === 2 && lineas.every((l) => Number(l.final_qty) === 4), `2. 48 piezas con caja de 12 = 4 cajas en cada renglón (${lineas.map((l) => l.final_qty).join(', ')})`);
  ok(filas.every((f) => /Morelia Madero/.test(f.notes) && /prueba AB29/.test(f.notes)), '2. la nota dice qué sucursal la pidió y lleva lo que escribió');

  // 3 · Reenviar lo mismo no duplica.
  const r3 = anotar(await svc.enviar(alm, 'almacen', { warehouse_id: suc.id, product_ids: [P[0], P[1]] }));
  const vivas = await dueno('commercial.purchase_requisition_lines').whereIn('product_id', [P[0], P[1]]).count('* as n').first();
  ok(r3.requisiciones.length === 0 && Number(vivas.n) === 2 && r3.omitidos.every((o) => o.motivo === 'Ya lo pediste a Compras'),
    `3. reenviar: 0 requisiciones nuevas, ${vivas.n} renglones en total, «Ya lo pediste a Compras»`, r3);

  // 4 · Dos envíos simultáneos del mismo producto.
  const dos = await Promise.all([1, 2].map(() => svc.enviar(alm, 'almacen', { warehouse_id: suc.id, product_ids: [P[4]] }).then(anotar)));
  const n5 = await dueno('commercial.purchase_requisition_lines').where({ product_id: P[4] }).count('* as n').first();
  ok(Number(n5.n) === 1 && dos.reduce((s, r) => s + r.requisiciones.length, 0) === 1,
    `4. dos envíos a la vez del mismo producto → ${n5.n} renglón (candado por almacén)`);

  // 5 · Rechazar una de sucursal sin motivo.
  let msg5 = null;
  try { await motor.reject(tr.id); } catch (e) { msg5 = e.message; }
  const est5 = (await dueno('commercial.purchase_requisitions').where({ id: tr.id }).first('estado')).estado;
  ok(/motivo/i.test(msg5 || '') && est5 === 'pending_approval', `5. sin motivo → «${msg5}» y sigue ${est5}`);

  // 6 · Con motivo.
  await motor.reject(tr.id, '  Hay existencia en la matriz para la otra semana  ');
  const f6 = await dueno('commercial.purchase_requisitions').where({ id: tr.id }).first('estado', 'rejection_reason', 'rejected_by', 'rejected_at');
  ok(f6.estado === 'cancelled' && f6.rejection_reason === 'Hay existencia en la matriz para la otra semana' && f6.rejected_by === persona.id && f6.rejected_at,
    '6. con motivo → cancelada, con el motivo (sin espacios de más), quién y cuándo', f6);

  // 7 · La base rechaza un rechazo sin motivo.
  let msg7 = null;
  try { await dueno('commercial.purchase_requisitions').where({ id: cp.id }).update({ rejected_at: new Date() }); } catch (e) { msg7 = e.message; }
  ok(/purchase_req_rechazo_con_motivo_chk/.test(msg7 || ''), '7. la base misma no admite un rechazo sin motivo (CHECK)');

  // 8 · Una requisición de Compras sigue rechazándose sin motivo.
  const compras = await tk.run((trx) => motor.insertRequisition(trx, T, { warehouse_id: suc.id, source_type: 'supplier', supplier_id: sembrado.proveedor,
    target_basis: 'max', lines: [{ product_id: P[5], supplier_id: sembrado.proveedor, final_qty: 1 }] }));
  sembrado.requisiciones.add(compras.id);
  await motor.reject(compras.id);
  const f8 = await dueno('commercial.purchase_requisitions').where({ id: compras.id }).first('estado', 'requested_by_branch', 'rejected_at');
  ok(f8.estado === 'cancelled' && f8.requested_by_branch === false && f8.rejected_at === null,
    '8. una de Compras se rechaza sin motivo como antes (y no queda marcada de sucursal)', f8);

  // 9 · En lote, la de sucursal sin motivo falla sola.
  const b = await motor.bulkEstado([cp.id], 'reject');
  const f9 = (await dueno('commercial.purchase_requisitions').where({ id: cp.id }).first('estado')).estado;
  ok(b.hechas === 0 && b.fallas.length === 1 && /motivo/i.test(b.fallas[0].motivo) && f9 === 'pending_approval',
    `9. en lote sin motivo: 0 hechas, falla «${b.fallas[0] && b.fallas[0].motivo}», sigue ${f9}`);

  await salir();
})().catch(async (e) => { console.log('  ✗ error:', e.stack || e.message); fail++; await salir(); });
