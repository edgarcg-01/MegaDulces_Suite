/**
 * `[AB.PM.3]` EL PEDIDO A MANO DE AUTOABASTO — servicio REAL y escritor REAL contra base REAL (regla 13).
 *
 * Ejerce los endpoints que ESCRIBEN (guardar, quitar, mandar) con el payload que mandará la pantalla, y
 * la regla R1 del anexo (un producto vive una vez en el borrador) sobre el sugerido:
 *
 *   1. El sugerido trae VIS-001 (motor) y se ajusta; pedirlo a mano lo REEMPLAZA (R1) y deja huella.
 *   2. Ya pedido a mano, sale de la cuenta del sugerido (`pedido` y `renglones`) y «Enviar» del
 *      sugerido lo deja fuera con su motivo: sale UNA vez.
 *   3. NEGATIVAS al guardar: la presentación de factor decimal (R8 a), cantidad no entera o cero, pedirse a
 *      sí mismo o a un camión (R6), un producto que no existe — y ninguna escribe nada.
 *   4. La lista lo parte en un documento por sucursal y Compras aparte, y dice qué rechazaría Kepler (R8 d).
 *   5. Mandar: UN pedido a la sucursal (R5), sólo con lo enviable; lo de Compras (R7) y lo que Kepler
 *      rechazaría se quedan con su motivo. El pedido queda guardado y aprobado; sin escritor a Kepler en
 *      esta base, dice por qué no salió (no se simula que salió). Lo mandado deja el borrador.
 *   6. Mandar otra vez sin nada enviable → 400 y ninguna requisición nueva; lo ya pedido no se repite.
 *   7. Quitar: borra lo de a mano (huella) y el producto vuelve al sugerido; quitar otra vez → 400.
 *
 * Lo que esta base local NO tiene (escalera, fichas, plan, motor de reabasto) se inyecta con datos de
 * prueba; esas LECTURAS se probaron aparte contra prod en sólo lectura (`buscarMano`, 2026-11-26).
 *
 * Corre contra la BASE LOCAL DE PRUEBAS y SE NIEGA a correr contra prod (`system_identifier`). Todo pasa en
 * UNA transacción que se DESHACE al final. El servicio escribe como `app_runtime` (`SET LOCAL ROLE`, con RLS).
 *
 * Uso: node database/tests/test-localdb-autoabasto-pedido-a-mano.js
 */
const path = require('path');

const PROD_SID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.join(__dirname, '..', '..');
const DUENO = process.env.REQ_TEST_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform';
const MIG = path.join(RAIZ, 'database/migrations-newdb/20261126133836_autoabasto_captura_a_mano.js');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Pedido, Motor;
// La plataforma exige un secreto de firma al CARGAR el módulo; un valor local de prueba, nunca uno real.
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-abpm3-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ AutoabastoPedidoService: Pedido } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/autoabasto-pedido.service.ts')));
  ({ CommercialReplenishmentService: Motor } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}
const mig = require(MIG);
const dueno = require('knex')({ client: 'pg', connection: DUENO, pool: { min: 0, max: 2 } });

/** El código HTTP de una excepción de Nest (o `undefined` si no es una). */
const http = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
/**
 * Llama al SERVICIO y devuelve su error. ⚠️ Sin savepoint propio: el servicio ya abre el suyo
 * (`tk.run`), y envolverlo en otro sobre la misma transacción lo deja esperando a su hermano.
 */
const atrapa = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ── Lo que la base local no tiene, con los casos de R8 ─────────────────────────────────────────
const esc = (e) => ({ unit_base: null, u2_label: null, u3_label: null, f2: null, f3: null, is_weight: false, ...e });
const FIX = {
  // Caja de 24, y la ficha de 08 dice lo mismo: pasa.
  'VIS-001': { escalera: esc({ unit_base: 'PZA', u3_label: 'CJA', f3: 24 }), bf: 24, ficha: { unidad_base: 'PZA', factor: 24 }, existencia: 10, venta30: 48, viene: 0, cajaCost: 240, exOrigen: 500 },
  // La Suite dice caja de 100 y la ficha de 08 de 50: Kepler rechazaría el documento entero (R8 d).
  'VIS-002': { escalera: esc({ unit_base: 'PZA', u3_label: 'CJA', f3: 100 }), bf: 100, ficha: { unidad_base: 'PZA', factor: 50 }, existencia: 0, venta30: 30, viene: 0, cajaCost: 500, exOrigen: 80 },
  // Granel con bulto de 19.75 KG (el 95579 de [COT.45]): sólo kilos enteros (R8 a).
  'VIS-003': { escalera: esc({ unit_base: 'KG', u2_label: 'KG', u3_label: 'BTO', f3: 19.75, is_weight: true }), bf: 1, ficha: { unidad_base: 'KG', factor: 1 }, existencia: 3, venta30: 20, viene: 0, cajaCost: 60, exOrigen: 40 },
};

/** Lo que manda la pantalla al guardar un renglón a mano (`AutoabastoManoGuardarRequest`). */
const guardar = (whId, p, origen_code, cantidad, unidad) => ({ warehouse_id: whId, product_id: p.id, origen_code, cantidad, unidad, ms_en_renglon: 1500 });
/** Lo que manda la pantalla al ajustar el sugerido (`almacen-autoabasto.component.ts` → `guardar()`). */
const ajuste = (whId, p, cantidad) => ({
  warehouse_id: whId, product_id: p.id, sku: p.sku, origen_tipo: 'matriz', origen_clave: '08',
  sugerido: 2, unidad: 'CJA', factor: 24, cantidad, motivo: null, ms_en_renglon: 1800,
  contexto: { venta_30d: 2, existencia: 0.4, objetivo: 1.4, falta: 1, ya_pedido: 0, atorado: 0, negado_30d: 0, regla: 'cajas', posicion: 'bajo_minimo' },
});

(async () => {
  const sid = (await dueno.raw('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;
  if (sid === PROD_SID) throw new Error('esta prueba ESCRIBE: se niega a correr contra producción');
  if (!(await dueno.raw("SELECT to_regclass('commercial.autoabasto_pedido_lineas') t")).rows[0].t) {
    noMedido('la base no tiene commercial.autoabasto_pedido_lineas (falta la migración 20261012215125)');
    return;
  }
  const reqAntes = Number((await dueno('commercial.purchase_requisitions').count('* as n'))[0].n);

  const trx = await dueno.transaction();
  trx.executionPromise.catch(() => undefined);   // deshacer es el final esperado
  try {
    await mig.up(trx);
    const whs = (await trx.raw(`SELECT id, code, name FROM commercial.warehouses WHERE tenant_id = ? AND deleted_at IS NULL AND code IN ('07','08')`, [T])).rows;
    const W07 = whs.find((w) => w.code === '07'), W08 = whs.find((w) => w.code === '08');
    const prods = (await trx.raw(`SELECT id, sku, nombre FROM catalog.products WHERE tenant_id = ? AND sku IN ('VIS-001','VIS-002','VIS-003') AND deleted_at IS NULL ORDER BY sku`, [T])).rows;
    const conBorrador = W07 && (await trx('commercial.autoabasto_pedidos').where({ tenant_id: T, warehouse_id: W07.id, estado: 'borrador' }).first('id'));
    if (!W07 || !W08 || prods.length < 3 || conBorrador) { noMedido('esta base no tiene 07 y 08 sin borrador y los tres productos VIS-00n'); return; }
    const [A, B, C] = prods;
    const almacen = { id: W07.id, code: W07.code, name: W07.name };

    await trx.raw('SET LOCAL ROLE app_runtime');
    await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
    // Un savepoint a la vez: `armarAlmacen` lanza tres lecturas en paralelo y dos savepoints de la misma
    // transacción no pueden estar abiertos a la vez sin pisarse.
    let cola = Promise.resolve();
    const tk = { run: (fn) => { const p = cola.then(() => trx.transaction(fn)); cola = p.catch(() => undefined); return p; } };
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba-abpm3' }) };
    const logger = { warn: () => undefined, log: () => undefined, error: () => undefined };
    // El escritor REAL de requisiciones; sin escritor a Kepler en esta base (`keplerSink` ausente).
    const motor = Object.assign(Object.create(Motor.prototype), { tk, tenantCtx: ctx, logger });
    // El motor de reabasto no corre en esta base: la mesa trae a A (le falta 1 caja de 24, de 08) y a B.
    const fila = (p, cf, falta) => ({
      product_id: p.id, sku: p.sku, nombre: p.nombre, venta_30d: 2, on_hand: 0.4, target_qty: 1.4, suggested_qty: falta / cf,
      suggested_qty_nat: falta, caja_factor: cf, unit_cost: 10, rung_veredicto: null, bucket: 'bajo_minimo',
      replenish_via: 'transfer', source_warehouse_code: '08', supplier_id: null, supplier_name: null,
      venta_30d_nat: 48, on_hand_nat: 10, caja_cost: 240, in_transit: 0, min_stock: 1, reorder_point: 1.2, max_stock: 2,
    });
    motor.criticalStock = async () => ({ rows: [fila(A, 24, 24), fila(B, 100, 100)] });
    const svc = Object.assign(Object.create(Pedido.prototype), { tk, tenantCtx: ctx, logger, motor });
    svc.escalerasDe = async () => new Map(Object.entries(FIX).map(([sku, f]) => [sku, f.escalera]));
    svc.lineasDe = async () => new Map();
    svc.medidasMano = async (_trx, _t, _alm, productos, origenes) => {
      const porProducto = new Map();
      for (const p of productos) {
        const f = FIX[p.sku];
        if (!f) continue;
        porProducto.set(p.id, {
          sku: p.sku, escalera: f.escalera, existencia: f.existencia, venta30: f.venta30, noConfiable: false, viene: f.viene,
          bf: f.bf, cajaCost: f.cajaCost,
          origen: new Map(origenes.map((o) => [o.id, { existencia: f.exOrigen, ficha: o.kepler_code === '08' ? f.ficha : null }])),
        });
      }
      return { porProducto, vieneMedido: true };
    };
    const linea = (p) => trx('commercial.autoabasto_pedido_lineas as l')
      .join('commercial.autoabasto_pedidos as b', 'b.id', 'l.pedido_id')
      .where({ 'l.tenant_id': T, 'l.product_id': p.id, 'b.warehouse_id': W07.id, 'b.estado': 'borrador' })
      .first('l.captura', 'l.cantidad', 'l.unidad', 'l.cantidad_base', 'l.origen_tipo', 'l.origen_clave', 'l.sugerido', 'l.contexto');
    const lineas = async () => Number((await trx('commercial.autoabasto_pedido_lineas as l').join('commercial.autoabasto_pedidos as b', 'b.id', 'l.pedido_id')
      .where({ 'l.tenant_id': T, 'b.warehouse_id': W07.id }).count('* as n'))[0].n);
    const huellas = async (evento) => Number((await trx('commercial.autoabasto_huella').where({ tenant_id: T, warehouse_id: W07.id, evento }).count('* as n'))[0].n);
    const enSugerido = (r, p) => r.grupos.some((g) => g.lineas.some((l) => l.product_id === p.id));

    console.log('\n  0 · a quién se le puede pedir (R6, [AB.PM.4])');
    // En esta base: 07 y 08 con Kepler, MD-30/32/50 sin Kepler, RUTA-* camiones. Para 07 sólo sirve 08.
    const ors = await svc.origenesMano(almacen);
    ok(ors.origenes.map((o) => o.code).join(',') === '08',
      `la lista ofrece sólo lo que el servidor acepta: ${ors.origenes.map((o) => o.code).join(', ') || '(nada)'}`);

    console.log('\n  1 · pedirlo a mano reemplaza el ajuste del sugerido (R1)');
    const antes = await svc.pedido(almacen, 'almacen', true);
    ok(enSugerido(antes, A), 'el sugerido trae a VIS-001');
    await svc.ajustar(W07.id, ajuste(W07.id, A, 2));
    ok((await linea(A))?.captura === 'motor', 'se ajustó en el sugerido (captura=motor)');
    const g1 = await svc.guardarMano(almacen, guardar(W07.id, A, '08', 3, 'cja'));
    const la = await linea(A);
    ok(la && la.captura === 'mano' && Number(la.cantidad) === 3 && Number(la.cantidad_base) === 72 && la.unidad === 'CJA'
      && la.origen_tipo === 'matriz' && la.origen_clave === '08' && Number(la.sugerido) === 0,
      `ahora es a mano: 3 CJA × 24 = ${la?.cantidad_base} base, de ${la?.origen_clave}, sugerido ${la?.sugerido}`);
    ok(la?.contexto?.reemplaza === 'sugerido' && la?.contexto?.existencia === 10 && la?.contexto?.kepler === null,
      'el contexto lo calcula el servidor: existencia, Kepler y que reemplazó al sugerido', la?.contexto);
    ok(g1.renglon.kepler === null && g1.renglon.alcance_con_pedido.estado === 'medible' && g1.renglon.unidades.length === 2,
      `la respuesta trae el renglón: alcance con pedido ${g1.renglon.alcance_con_pedido.con_pedido?.toFixed(1)} días, Kepler pasa`);
    ok(await huellas('capturar') === 1, 'deja huella «capturar»');

    console.log('\n  2 · ya a mano, sale de la cuenta del sugerido y no se manda dos veces');
    const despues = await svc.pedido(almacen, 'almacen', true);
    ok(!enSugerido(despues, A) && enSugerido(despues, B), '«Mi pedido» ya no trae a VIS-001 (y sí a VIS-002)');
    const mesa = await svc.renglones(almacen, 'almacen', {});
    ok(!mesa.renglones.some((r) => r.product_id === A.id), 'la mesa tampoco');
    const eEnv = await atrapa(() => svc.enviar(almacen, 'almacen', { warehouse_id: W07.id, product_ids: [A.id] }));
    ok(http(eEnv) === 400 && /pediste a mano/.test(eEnv.message), `«Enviar» del sugerido lo deja fuera: «${eEnv ? eEnv.message : 'NO falló'}»`);
    const eAj = await atrapa(() => svc.ajustar(W07.id, ajuste(W07.id, A, 1)));
    ok(http(eAj) === 400 && Number((await linea(A))?.cantidad) === 3, 'y el sugerido no puede pisarlo (sigue en 3)');

    console.log('\n  3 · NEGATIVAS al guardar: ninguna escribe');
    await svc.guardarMano(almacen, guardar(W07.id, B, '08', 1, 'CJA'));
    await svc.guardarMano(almacen, guardar(W07.id, C, null, 5, 'KG'));
    const n0 = await lineas(), h0 = await huellas('capturar');
    const negativas = [
      ['el bulto de 19.75 KG (R8 a)', guardar(W07.id, C, null, 1, 'BTO'), /se pide en KG/],
      ['cantidad 1.5', guardar(W07.id, A, '08', 1.5, 'CJA'), /entero/],
      ['cantidad 0', guardar(W07.id, A, '08', 0, 'CJA'), /entero/],
      ['una unidad que no existe', guardar(W07.id, A, '08', 1, 'PALET'), /se pide en CJA, PZA/],
      ['a sí mismo (R6)', guardar(W07.id, A, '07', 1, 'CJA'), /este mismo almacén/],
      ['a un camión (R6)', guardar(W07.id, A, 'RUTA-21', 1, 'CJA'), /camión/],
      ['a un almacén que no existe', guardar(W07.id, A, 'NO-HAY', 1, 'CJA'), /no existe/],
      ['un producto que no existe', { ...guardar(W07.id, A, '08', 1, 'CJA'), product_id: '00000000-0000-0000-0000-0000000000ff' }, /catálogo/],
    ];
    for (const [que, body, rx] of negativas) {
      const e = await atrapa(() => svc.guardarMano(almacen, body));
      ok(http(e) === 400 && rx.test(e.message), `${que} → 400 «${e ? e.message : 'NO falló'}»`);
    }
    ok(await lineas() === n0 && await huellas('capturar') === h0, `ninguna escribió (renglones ${n0}, huellas «capturar» ${h0})`);

    console.log('\n  4 · la lista: un documento por sucursal, Compras aparte, y lo que Kepler rechazaría');
    const lista = await svc.pedidoAMano(almacen);
    const rb = lista.renglones.find((r) => r.product_id === B.id);
    const rc = lista.renglones.find((r) => r.product_id === C.id);
    ok(lista.renglones.length === 3, `3 renglones a mano (${lista.renglones.length})`);
    ok(lista.grupos.length === 2 && lista.grupos[0].destino.code === '08' && lista.grupos[0].renglones.length === 2
      && lista.grupos[1].destino.tipo === 'compras' && lista.grupos[1].enviable === false,
      'grupos: 08 con 2 renglones, Compras al final y no enviable', lista.grupos.map((g) => [g.destino, g.renglones.length, g.enviable]));
    ok(rb?.kepler === 'factor_distinto', `VIS-002 (Suite 100 / ficha 50): «${rb?.kepler}»`);
    ok(rc?.kepler === null && rc?.destino.tipo === 'compras' && rc?.cantidad_base === 5, 'VIS-003 va a Compras: 5 KG, sin revisión de traspaso');

    console.log('\n  5 · mandar: un pedido a 08 sólo con lo enviable');
    const env = await svc.enviarMano(almacen, { warehouse_id: W07.id, nota: 'prueba abpm3' });
    ok(env.requisiciones.length === 1 && env.requisiciones[0].surte.clave === '08' && env.requisiciones[0].renglones === 1,
      `una requisición a 08 con 1 renglón (${env.requisiciones.map((r) => `${r.folio}:${r.renglones}`).join(', ')})`);
    const motivos = Object.fromEntries(env.pendientes.map((p) => [p.product_id, p.motivo]));
    ok(/Kepler lo rechazaría/.test(motivos[B.id] ?? '') && /Ruta por confirmar/.test(motivos[C.id] ?? ''),
      'se quedan con su motivo: VIS-002 (Kepler) y VIS-003 (Compras)', motivos);
    const k = env.requisiciones[0].kepler;
    ok(k && k.estado === 'no_salio' && /no está habilitada/.test(k.motivo), `sin escritor a Kepler dice por qué no salió: «${k?.motivo}»`);
    const req = await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: env.requisiciones[0].id })
      .first('warehouse_id', 'source_type', 'source_warehouse_id', 'estado', 'requested_by_branch', 'notes', 'total_cost');
    ok(req && req.warehouse_id === W07.id && req.source_type === 'branch' && req.source_warehouse_id === W08.id
      && req.estado === 'approved' && req.requested_by_branch === true && /a mano/.test(req.notes),
      `guardada: de 08 a 07, traspaso, ${req?.estado}, pedida por la sucursal`);
    const ls = await trx('commercial.purchase_requisition_lines').where({ tenant_id: T, requisition_id: env.requisiciones[0].id })
      .select('product_id', 'final_qty', 'unit_cost', 'source_type', 'source_warehouse_id', 'suggested_qty');
    ok(ls.length === 1 && ls[0].product_id === A.id && Number(ls[0].final_qty) === 3 && Number(ls[0].unit_cost) === 240
      && ls[0].source_type === 'branch' && ls[0].source_warehouse_id === W08.id && Number(ls[0].suggested_qty) === 0,
      `el renglón: 72 base ÷ 24 = ${ls[0]?.final_qty} cajas a $${ls[0]?.unit_cost}, sugerido 0`);
    ok(!(await linea(A)) && (await linea(B))?.captura === 'mano' && (await linea(C))?.captura === 'mano',
      'lo mandado dejó el borrador; lo pendiente sigue');
    ok(await huellas('enviar') === 1, 'deja huella «enviar»');

    console.log('\n  5b · si el renglón cambia MIENTRAS viaja a Kepler, lo nuevo no se borra (revisión del PR)');
    // VIS-002 se vuelve enviable (la ficha de 08 pasa a decir 100) y, a medio envío —después de guardar la
    // requisición y antes de limpiar el borrador—, «otra pestaña» lo sube de 1 a 2 cajas.
    FIX['VIS-002'].ficha = { unidad_base: 'PZA', factor: 100 };
    const soltarReal = motor.soltarPedidoDeSucursal;
    motor.soltarPedidoDeSucursal = async (ids) => {
      await svc.guardarMano(almacen, guardar(W07.id, B, '08', 2, 'CJA'));
      return soltarReal.call(motor, ids);
    };
    try {
      const envB = await svc.enviarMano(almacen, { warehouse_id: W07.id });
      const lsB = await trx('commercial.purchase_requisition_lines').where({ tenant_id: T, requisition_id: envB.requisiciones[0]?.id ?? null })
        .select('product_id', 'final_qty');
      ok(lsB.length === 1 && lsB[0].product_id === B.id && Number(lsB[0].final_qty) === 1,
        `salió lo que se leyó: VIS-002 con ${lsB[0]?.final_qty} caja`);
      const lb = await linea(B);
      ok(lb && lb.captura === 'mano' && Number(lb.cantidad) === 2,
        `lo nuevo (2 CJA) sigue en el borrador: no se borró sin haber salido (${lb ? lb.cantidad : 'BORRADO'})`);
      ok(envB.pendientes.some((p) => p.product_id === B.id && /Cambió mientras se mandaba/.test(p.motivo)),
        'y se dice', envB.pendientes);
    } finally {
      motor.soltarPedidoDeSucursal = soltarReal;
      FIX['VIS-002'].ficha = { unidad_base: 'PZA', factor: 50 };
    }

    console.log('\n  6 · mandar otra vez sin nada enviable, y lo ya pedido no se repite');
    const reqs1 = Number((await trx('commercial.purchase_requisitions').where({ tenant_id: T }).count('* as n'))[0].n);
    const e6 = await atrapa(() => svc.enviarMano(almacen, { warehouse_id: W07.id }));
    ok(http(e6) === 400 && /Nada se puede mandar todavía/.test(e6.message), `→ 400 «${e6 ? e6.message.slice(0, 80) : 'NO falló'}»`);
    await svc.guardarMano(almacen, guardar(W07.id, A, '08', 1, 'CJA'));
    const otra = await svc.enviarMano(almacen, { warehouse_id: W07.id });
    ok(otra.requisiciones.length === 0 && otra.pendientes.some((p) => p.product_id === A.id && /Ya lo pediste/.test(p.motivo)),
      'VIS-001 ya va en un pedido vivo: no sale otra vez, se dice');
    const reqs2 = Number((await trx('commercial.purchase_requisitions').where({ tenant_id: T }).count('* as n'))[0].n);
    ok(reqs2 === reqs1, `ninguna requisición nueva (${reqs1} → ${reqs2})`);
    const soloUna = await atrapa(() => svc.enviarMano(almacen, { warehouse_id: W07.id, origen_code: '01' }));
    ok(http(soloUna) === 400, 'mandar sólo a una sucursal que no tiene renglones → 400');

    console.log('\n  7 · quitar');
    await svc.quitarMano(almacen, { warehouse_id: W07.id, product_id: A.id, ms_en_renglon: 600 });
    ok(!(await linea(A)) && await huellas('quitar') === 1, 'borra lo de a mano y deja huella «quitar»');
    const vuelve = await svc.pedido(almacen, 'almacen', true);
    ok(enSugerido(vuelve, A), 'y VIS-001 vuelve a la cuenta del sugerido');
    const e7 = await atrapa(() => svc.quitarMano(almacen, { warehouse_id: W07.id, product_id: A.id }));
    ok(http(e7) === 400, 'quitar lo que no está → 400');
    await svc.ajustar(W07.id, ajuste(W07.id, A, 2));
    const e8 = await atrapa(() => svc.quitarMano(almacen, { warehouse_id: W07.id, product_id: A.id }));
    ok(http(e8) === 400 && (await linea(A))?.captura === 'motor', '«quitar» no toca un ajuste del sugerido');
  } finally {
    await trx.rollback().catch(() => undefined);
  }
  const reqDespues = Number((await dueno('commercial.purchase_requisitions').count('* as n'))[0].n);
  ok(reqDespues === reqAntes, `la base quedó como estaba (requisiciones ${reqAntes} → ${reqDespues})`);
})().catch((e) => { fail++; console.log('  ✗ error:', e.stack || e.message); })
  .finally(async () => {
    await dueno.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  });
