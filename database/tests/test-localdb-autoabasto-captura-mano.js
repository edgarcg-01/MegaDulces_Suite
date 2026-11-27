/**
 * `[AB.PM.1]` EL RENGLÓN A MANO EN EL BORRADOR DE AUTOABASTO — migración REAL y servicio REAL contra base REAL.
 *
 * La migración `20261126133836_autoabasto_captura_a_mano` agrega `captura` ('motor' | 'mano') a
 * `commercial.autoabasto_pedido_lineas` y los eventos `capturar` / `quitar` a la huella. Un producto vive
 * UNA vez en el borrador (R1 del anexo): el ajuste del sugerido no puede pisar lo pedido a mano, ni
 * restablecerlo. Regla 13 y 14: el único camino que inserta (`ajustar()`) se ejerce con el payload de la
 * pantalla (`almacen-autoabasto.component.ts` → `guardar()`).
 *
 * Corre contra la BASE LOCAL DE PRUEBAS y SE NIEGA a correr contra prod (`system_identifier`). Todo pasa en
 * UNA transacción que se DESHACE al final: la migración, los renglones y la huella no quedan en la base.
 * El servicio escribe como `app_runtime` (`SET LOCAL ROLE`, con RLS), en savepoints de esa transacción.
 *
 *   1. La migración corre dos veces sin error (idempotente) y deja la columna NOT NULL DEFAULT 'motor'.
 *   2. El camino de siempre (`ajustar`) nace `motor` sin mandar la columna.
 *   3. NEGATIVA: el CHECK rechaza una captura inventada; la huella admite capturar/quitar y no un evento inventado.
 *   4. Un renglón a mano (lo que escribirá `[AB.PM.3]`) NO lo pisa `ajustar` ni lo borra `restablecer`.
 *   5. `restablecer` sigue borrando el ajuste del motor.
 *   6. `down` se NIEGA con un renglón a mano; sin él, deshace y la migración vuelve a aplicar.
 *
 * Uso: node database/tests/test-localdb-autoabasto-captura-mano.js
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

let Pedido;
// La plataforma exige un secreto de firma al CARGAR el módulo; un valor local de prueba, nunca uno real.
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-abpm1-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ AutoabastoPedidoService: Pedido } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/autoabasto-pedido.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}
const mig = require(MIG);

const dueno = require('knex')({ client: 'pg', connection: DUENO, pool: { min: 0, max: 2 } });

/** El código HTTP de una excepción de Nest (o `undefined` si no es una). */
const http = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);

/** Corre SQL suelto en un savepoint y devuelve el error (o `null` si no falló). */
const falla = async (trx, fn) => {
  try { await trx.transaction(fn); return null; } catch (e) { return e; }
};
/**
 * Llama al SERVICIO y devuelve su error. ⚠️ Sin savepoint propio: el servicio ya abre el suyo
 * (`tk.run`). Envolverlo en otro sobre la misma transacción lo deja esperando a su hermano, que
 * lo espera a él — la prueba se queda colgada sin un solo error (vivido al escribirla).
 */
const atrapa = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

/** El payload que arma la pantalla en `guardar()` (`almacen-autoabasto.component.ts`). */
const payloadPantalla = (whId, p, cantidad) => ({
  warehouse_id: whId, product_id: p.id, sku: p.sku,
  origen_tipo: 'matriz', origen_clave: '08',
  sugerido: 3, unidad: 'CJA', factor: 12,
  cantidad, motivo: null, ms_en_renglon: 1800,
  contexto: { venta_30d: 4, existencia: 1, objetivo: 4, falta: 3, ya_pedido: 0, atorado: 0, negado_30d: 0, regla: 'cajas', posicion: 'bajo_minimo' },
});

(async () => {
  const sid = (await dueno.raw('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;
  if (sid === PROD_SID) throw new Error('esta prueba ESCRIBE: se niega a correr contra producción');
  if (!(await dueno.raw("SELECT to_regclass('commercial.autoabasto_pedido_lineas') t")).rows[0].t) {
    noMedido('la base no tiene commercial.autoabasto_pedido_lineas (falta la migración 20261012215125)');
    return;
  }
  const columnaAntes = await dueno.schema.withSchema('commercial').hasColumn('autoabasto_pedido_lineas', 'captura');

  const trx = await dueno.transaction();
  // Deshacer es el final esperado, no una falla: sin esto knex lo reporta como promesa rechazada.
  trx.executionPromise.catch(() => undefined);
  try {
    console.log('\n  1 · la migración, dos veces');
    await mig.up(trx);
    await mig.up(trx);
    const col = (await trx.raw(`SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'commercial' AND table_name = 'autoabasto_pedido_lineas' AND column_name = 'captura'`)).rows[0];
    ok(col && col.is_nullable === 'NO' && /'motor'/.test(String(col.column_default)), `captura NOT NULL DEFAULT 'motor' (${col ? `${col.is_nullable} · ${col.column_default}` : 'sin columna'})`);

    // Un almacén sin borrador vivo y dos productos: si no hay, no se mide sin tocar lo ajeno.
    const wh = (await trx.raw(`SELECT w.id FROM commercial.warehouses w
        WHERE w.tenant_id = ? AND w.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM commercial.autoabasto_pedidos p WHERE p.warehouse_id = w.id AND p.estado = 'borrador')
        ORDER BY w.code LIMIT 1`, [T])).rows[0];
    const prods = (await trx.raw(`SELECT id, sku FROM catalog.products WHERE tenant_id = ? ORDER BY sku LIMIT 2`, [T])).rows;
    if (!wh || prods.length < 2) { noMedido('no hay un almacén sin borrador y dos productos en esta base'); return; }
    const [A, B] = prods;

    // Desde acá escribe la aplicación: rol de runtime, con RLS y el tenant de la sesión.
    await trx.raw('SET LOCAL ROLE app_runtime');
    await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
    const tk = { run: (fn) => trx.transaction(fn) };
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba-abpm1' }) };
    const svc = Object.assign(Object.create(Pedido.prototype), { tk, tenantCtx: ctx });
    const linea = (p) => trx('commercial.autoabasto_pedido_lineas').where({ tenant_id: T, product_id: p.id })
      .whereIn('pedido_id', trx('commercial.autoabasto_pedidos').where({ tenant_id: T, warehouse_id: wh.id, estado: 'borrador' }).select('id'))
      .first('captura', 'cantidad', 'cantidad_base', 'origen_tipo', 'origen_clave', 'sugerido');

    console.log('\n  2 · el camino de siempre nace «motor» sin mandar la columna');
    const r = await svc.ajustar(wh.id, payloadPantalla(wh.id, A, 3));
    const la = await linea(A);
    ok(la && la.captura === 'motor' && Number(la.cantidad) === 3 && Number(la.cantidad_base) === 36,
      `ajuste de la pantalla → captura=${la?.captura}, 3 CJA = ${la?.cantidad_base} base`);
    const pedidoId = r.pedido_id;

    console.log('\n  3 · NEGATIVAS del esquema');
    const eCheck = await falla(trx, (t) => t.raw(`UPDATE commercial.autoabasto_pedido_lineas SET captura = 'otra'
        WHERE tenant_id = ? AND pedido_id = ? AND product_id = ?`, [T, pedidoId, A.id]));
    ok(eCheck && /captura_chk/.test(eCheck.message), `una captura inventada la rechaza el CHECK (${eCheck ? eCheck.message.slice(0, 90) : 'NO falló'})`);
    const huella = (evento) => falla(trx, (t) => t('commercial.autoabasto_huella').insert({
      tenant_id: T, warehouse_id: wh.id, pedido_id: pedidoId, product_id: B.id, evento, username: 'prueba-abpm1' }));
    ok(!(await huella('capturar')), 'la huella admite «capturar»');
    ok(!(await huella('quitar')), 'la huella admite «quitar»');
    const eEv = await huella('importar');
    ok(eEv && /evento_chk/.test(eEv.message), `y rechaza un evento inventado (${eEv ? 'evento_chk' : 'NO falló'})`);

    console.log('\n  4 · un renglón a mano no lo pisa el sugerido');
    // Lo que escribirá [AB.PM.3]: B pedido a mano a la sucursal 06, 5 PAQ de 10.
    await trx.raw(`INSERT INTO commercial.autoabasto_pedido_lineas
        (tenant_id, pedido_id, product_id, sku, origen_tipo, origen_clave, sugerido, sugerido_unidad, sugerido_base,
         cantidad, unidad, cantidad_base, captura, ajustado_por_username)
      VALUES (?, ?, ?, ?, 'matriz', '06', 0, 'PAQ', 0, 5, 'PAQ', 50, 'mano', 'prueba-abpm1')`, [T, pedidoId, B.id, B.sku]);
    const huellasAntes = Number((await trx('commercial.autoabasto_huella').where({ tenant_id: T, pedido_id: pedidoId, product_id: B.id, evento: 'ajustar' }).count('* as n'))[0].n);
    const eAj = await atrapa(() => svc.ajustar(wh.id, payloadPantalla(wh.id, B, 3)));
    ok(http(eAj) === 400 && /a mano/.test(eAj.message), `ajustar sobre lo de a mano → 400 «${eAj ? eAj.message : 'NO falló'}»`);
    const lb = await linea(B);
    ok(lb && lb.captura === 'mano' && Number(lb.cantidad) === 5 && lb.origen_clave === '06',
      `el renglón a mano sigue igual: ${lb?.captura} · ${lb?.cantidad} · de ${lb?.origen_clave}`);
    const huellasDespues = Number((await trx('commercial.autoabasto_huella').where({ tenant_id: T, pedido_id: pedidoId, product_id: B.id, evento: 'ajustar' }).count('* as n'))[0].n);
    ok(huellasDespues === huellasAntes, `y no deja huella de un ajuste que no ocurrió (${huellasAntes} → ${huellasDespues})`);
    const eRe = await atrapa(() => svc.restablecer(wh.id, { warehouse_id: wh.id, product_id: B.id, ms_en_renglon: 900 }));
    ok(http(eRe) === 400, `restablecer lo de a mano → 400 (${eRe ? eRe.message.slice(0, 40) : 'NO falló'})`);
    ok((await linea(B))?.captura === 'mano', 'y el renglón a mano sigue en el borrador');

    console.log('\n  5 · restablecer sigue borrando el ajuste del motor');
    await svc.restablecer(wh.id, { warehouse_id: wh.id, product_id: A.id, ms_en_renglon: 700 });
    ok(!(await linea(A)), 'el ajuste de A volvió al sugerido');

    console.log('\n  6 · down');
    await trx.raw('RESET ROLE');
    const eDown = await falla(trx, (t) => mig.down(t));
    ok(eDown && /no se deshace/.test(eDown.message), `se niega con un renglón a mano (${eDown ? eDown.message : 'NO se negó'})`);
    await trx('commercial.autoabasto_pedido_lineas').where({ tenant_id: T, pedido_id: pedidoId, captura: 'mano' }).del();
    await trx('commercial.autoabasto_huella').where({ tenant_id: T, pedido_id: pedidoId }).whereIn('evento', ['capturar', 'quitar']).del();
    await mig.down(trx);
    ok(!(await trx.schema.withSchema('commercial').hasColumn('autoabasto_pedido_lineas', 'captura')), 'sin renglones a mano, deshace: la columna ya no está');
    const eViejo = await huella('capturar');
    ok(eViejo && /evento_chk/.test(eViejo.message), 'y la huella vuelve a su CHECK de [AB.18]');
    await mig.up(trx);
    ok(await trx.schema.withSchema('commercial').hasColumn('autoabasto_pedido_lineas', 'captura'), 'y la migración vuelve a aplicar');
  } finally {
    await trx.rollback().catch(() => undefined);
  }
  const columnaDespues = await dueno.schema.withSchema('commercial').hasColumn('autoabasto_pedido_lineas', 'captura');
  ok(columnaDespues === columnaAntes, `la base quedó como estaba (columna antes: ${columnaAntes}, después: ${columnaDespues})`);
})().catch((e) => { fail++; console.log('  ✗ error:', e.message); })
  .finally(async () => {
    await dueno.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  });
