/**
 * `[AB.39]` EL BORRADOR DE AUTOABASTO NACE CON LO QUE LA PERSONA VEÍA MARCADO — servicio REAL contra base REAL.
 *
 * El default de «¿Hasta dónde pides?» bajó a agotado + bajo mínimo (`POSICIONES_PEDIDO_DEFAULT`), pero la
 * columna `commercial.autoabasto_pedidos.posiciones` tiene su PROPIO default en la base, con «bajo
 * reorden». El borrador nace con el primer ajuste: si el INSERT no manda las posiciones, la persona ve
 * dos marcadas y su borrador queda con tres. Regla 13: el camino que escribe se ejerce contra una base.
 *
 * Corre contra la BASE LOCAL DE PRUEBAS y SE NIEGA a correr contra prod (`system_identifier`). Escribe como
 * `app_runtime` (RLS) y borra lo que crea.
 *
 *   1. El borrador nuevo queda con EXACTAMENTE el default del contrato.
 *   2. Pedirlo otra vez devuelve el mismo (no se duplica).
 *   3. NEGATIVA: el INSERT de antes (sin posiciones) toma el default de la base, con «bajo reorden» —
 *      la prueba sí distingue el defecto.
 *
 * Uso: node database/tests/test-localdb-autoabasto-borrador.js
 */
const path = require('path');

const PROD_SID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.join(__dirname, '..', '..');
const DUENO = process.env.REQ_TEST_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform';
const APP = process.env.REQ_TEST_APP_URL || 'postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Pedido, C;
// La plataforma exige un secreto de firma al CARGAR el módulo; un valor local de prueba, nunca uno real.
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-ab39-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ AutoabastoPedidoService: Pedido } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/autoabasto-pedido.service.ts')));
  C = require(path.join(RAIZ, 'libs/contracts/src/http/autoabasto-pedido.contract.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const dueno = require('knex')({ client: 'pg', connection: DUENO, pool: { min: 0, max: 2 } });
const app = require('knex')({ client: 'pg', connection: APP, pool: { min: 0, max: 2 } });
const creados = new Set();

(async () => {
  const sid = (await dueno.raw('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;
  if (sid === PROD_SID) throw new Error('esta prueba ESCRIBE: se niega a correr contra producción');
  if (!(await dueno.raw("SELECT to_regclass('commercial.autoabasto_pedidos') t")).rows[0].t) {
    noMedido('la base no tiene commercial.autoabasto_pedidos (falta la migración 20261012215125)');
    return;
  }
  // Un almacén sin borrador vivo: si todos tienen, no se puede medir sin tocar lo ajeno.
  const wh = (await dueno.raw(`SELECT w.id FROM commercial.warehouses w
      WHERE w.tenant_id = ? AND w.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM commercial.autoabasto_pedidos p WHERE p.warehouse_id = w.id AND p.estado = 'borrador')
      ORDER BY w.code LIMIT 2`, [T])).rows;
  if (wh.length < 2) { noMedido('no hay dos almacenes sin borrador en esta base'); return; }

  const tk = { run: (fn) => app.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
    return fn(trx);
  }) };
  const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba-ab39' }) };
  const svc = Object.assign(Object.create(Pedido.prototype), { tk, tenantCtx: ctx });

  console.log('\n  1 · el borrador nace con el default del contrato');
  const id = await tk.run((trx) => svc.borradorOCrea(trx, T, wh[0].id));
  creados.add(id);
  const fila = await dueno('commercial.autoabasto_pedidos').where({ id }).first('posiciones', 'estado');
  ok(JSON.stringify(fila.posiciones) === JSON.stringify([...C.POSICIONES_PEDIDO_DEFAULT]),
    `posiciones = ${JSON.stringify(fila.posiciones)} (contrato: ${JSON.stringify(C.POSICIONES_PEDIDO_DEFAULT)})`);
  ok(fila.estado === 'borrador', 'queda en borrador');

  console.log('\n  2 · pedirlo otra vez devuelve el mismo');
  const otra = await tk.run((trx) => svc.borradorOCrea(trx, T, wh[0].id));
  ok(otra === id, 'mismo id, sin duplicar');

  console.log('\n  3 · NEGATIVA: el INSERT de antes (sin posiciones) se queda con «bajo reorden»');
  const viejo = await tk.run(async (trx) => {
    await trx.raw(`INSERT INTO commercial.autoabasto_pedidos (tenant_id, warehouse_id, motor, abierto_por, abierto_por_username)
                   VALUES (?, ?, '{}'::jsonb, NULL, 'prueba-ab39')`, [T, wh[1].id]);
    return trx('commercial.autoabasto_pedidos').where({ tenant_id: T, warehouse_id: wh[1].id, estado: 'borrador' }).first('id', 'posiciones');
  });
  creados.add(viejo.id);
  ok(viejo.posiciones.includes('bajo_reorden') && !C.POSICIONES_PEDIDO_DEFAULT.includes('bajo_reorden'),
    `sin mandar posiciones queda ${JSON.stringify(viejo.posiciones)}: distinto de lo que se veía marcado`);
})().catch((e) => { fail++; console.log('  ✗ error:', e.message); })
  .finally(async () => {
    try {
      if (creados.size) {
        await dueno('commercial.autoabasto_pedido_eventos').whereIn('pedido_id', [...creados]).del().catch(() => undefined);
        await dueno('commercial.autoabasto_pedidos').whereIn('id', [...creados]).del();
      }
    } catch (e) { fail++; console.log('  ⚠️ limpieza incompleta:', e.message); }
    await dueno.destroy(); await app.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  });
