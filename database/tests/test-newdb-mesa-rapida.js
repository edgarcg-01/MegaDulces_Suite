/**
 * `[AB.36]` LA MESA EN MENOS DE 500 ms SIN CAMBIAR UNA CIFRA — servicio REAL viejo contra nuevo, SÓLO LECTURA.
 *
 * AB.36 optimizó la ruta de la mesa de Autoabasto y «Mi pedido» (motor `criticalStock` + `armarAlmacen`):
 * matviews del factor de caja y del costo, JIT apagado, la etiquetera leída aparte, el modo `ligero`
 * (sin el reparto de la red) y las tres lecturas en paralelo. Esta prueba carga la versión ANTERIOR
 * del directorio desde git (default `624060d10`) en una carpeta temporal y compara, almacén por almacén:
 *
 *   1. /renglones de cada almacén: los mismos renglones, en el mismo orden, con los mismos campos.
 *      ÚNICA diferencia admitida: un producto cuyo costo HOY difiere entre `mv_erp_unit_cost` y la
 *      vista viva (la copia se refresca cada 15 min). Cualquier otra diferencia es falla.
 *   2. El motor sin `ligero` (lo que usan Compras y el chat) da lo mismo que antes, columna por
 *      columna, incluida la etiquetera (`box_size`, `pack_size`) que ahora se lee aparte.
 *   3. Con `ligero`, lo que no se calcula sale `null`, nunca cero.
 *   4. CONTROL NEGATIVO: comparar un almacén contra OTRO sí da diferencias.
 *   5. Tiempos (informativo, NO es compuerta: en esta máquina un tiempo suelto no se puede citar):
 *      mediana de 3, viejo y nuevo intercalados, contra el techo de 500 ms.
 * Sin renglones en la base: NO MEDIDO, nunca ✔.
 *
 * Uso: node database/tests/test-newdb-mesa-rapida.js [<commit de la versión anterior>]
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.join(__dirname, '..', '..');
const REF = process.argv[2] || '624060d10';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
let tmpRaiz;
const salir = async () => {
  if (knex) await knex.destroy();
  try { if (tmpRaiz) fs.rmSync(tmpRaiz, { recursive: true, force: true }); } catch { /* temporal */ }
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};

/** La versión anterior de los directorios que la ruta importa, escrita desde git a una carpeta temporal. */
function versionAnterior() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ab36-'));
  tmpRaiz = dest;
  for (const dir of ['libs/commercial/src/lib/commercial-replenishment', 'libs/commercial/src/lib/shared']) {
    const archivos = execSync(`git ls-tree -r --name-only ${REF} -- ${dir}`, { cwd: RAIZ, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.ts'));
    for (const f of archivos) {
      const destino = path.join(dest, path.relative('libs/commercial/src', f));
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, execSync(`git show ${REF}:${f}`, { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    }
  }
  return path.join(dest, 'lib', 'commercial-replenishment');
}

let Nuevo, Viejo, tmp;
// La copia vive fuera del repo: que resuelva sus dependencias en el `node_modules` del repo.
process.env.NODE_PATH = [path.join(RAIZ, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  const L = path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/');
  Nuevo = { Motor: require(L + 'commercial-replenishment.service.ts').CommercialReplenishmentService,
            Pedido: require(L + 'autoabasto-pedido.service.ts').AutoabastoPedidoService };
  tmp = versionAnterior();
  Viejo = { Motor: require(path.join(tmp, 'commercial-replenishment.service.ts')).CommercialReplenishmentService,
            Pedido: require(path.join(tmp, 'autoabasto-pedido.service.ts')).AutoabastoPedidoService };
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio (nuevo o ${REF}) con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
const tk = { run: (fn) => knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION READ ONLY');
  await trx.raw('SET LOCAL statement_timeout = 120000');
  await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
  return fn(trx);
}) };
const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) };
const armar = ({ Motor, Pedido }) => {
  const motor = Object.assign(Object.create(Motor.prototype), { tk, tenantCtx: ctx, logger: { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    scope: { warehouseIds: async (q) => (q && q.warehouse_id ? [q.warehouse_id] : null) } });
  return { motor, pedido: Object.assign(Object.create(Pedido.prototype), { motor, tk, tenantCtx: ctx }) };
};
const nuevo = armar(Nuevo), viejo = armar(Viejo);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Diferencias campo por campo entre dos listas de objetos, en orden. Devuelve [{ i, id, campo }]. */
function difs(a, b, id) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || id(x) !== id(y)) { out.push({ i, id: x ? id(x) : id(y), campo: '(renglón u orden)' }); continue; }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push({ i, id: id(x), campo: k });
    }
  }
  return out;
}

(async () => {
  console.log(`\n[AB.36] la mesa rápida da lo mismo que ${REF} — servicio real, sólo lectura\n`);
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  console.log(`  base: system_identifier ${sid}\n`);

  // Los pares (almacén, producto) cuyo costo HOY difiere entre la copia y la vista viva.
  const costoMovido = new Set((await tk.run((trx) => trx.raw(`
      SELECT warehouse_id::text || '|' || product_id::text AS k FROM (
        (SELECT * FROM analytics.mv_erp_unit_cost WHERE tenant_id = ? EXCEPT SELECT * FROM analytics.v_erp_unit_cost WHERE tenant_id = ?)
        UNION ALL
        (SELECT * FROM analytics.v_erp_unit_cost WHERE tenant_id = ? EXCEPT SELECT * FROM analytics.mv_erp_unit_cost WHERE tenant_id = ?)) d`, [T, T, T, T])))
    .rows.map((r) => r.k));
  console.log(`  pares con costo distinto entre la copia (15 min) y la vista viva: ${costoMovido.size}\n`);

  const whs = (await knex.raw(`SELECT id, code, name FROM commercial.warehouses WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY code`, [T])).rows;
  const porAlmacen = new Map();
  const tiempos = [];
  let renglones = 0;
  for (const w of whs) {
    const alm = { id: w.id, code: w.code, name: w.name };
    const tv = [], tn = [];
    let rv, rn;
    for (let i = 0; i < 3; i++) {
      let t0 = Date.now(); rv = await viejo.pedido.renglones(alm, 'almacen', { todos: true }); tv.push(Date.now() - t0);
      t0 = Date.now(); rn = await nuevo.pedido.renglones(alm, 'almacen', { todos: true }); tn.push(Date.now() - t0);
    }
    porAlmacen.set(w.code, { rv, rn, w });
    renglones += rn.renglones.length;
    tiempos.push({ w, viejo: med(tv), nuevo: med(tn) });
    const d = difs(rv.renglones, rn.renglones, (r) => r.product_id);
    const sinExplicar = d.filter((x) => !costoMovido.has(`${w.id}|${x.id}`));
    const explicadas = new Set(d.filter((x) => costoMovido.has(`${w.id}|${x.id}`)).map((x) => x.id)).size;
    const resumenIgual = JSON.stringify(rv.resumen) === JSON.stringify(rn.resumen);
    ok(sinExplicar.length === 0 && (resumenIgual || explicadas > 0),
      `1. ${w.name}: ${rn.renglones.length} renglones = ${rv.renglones.length} antes · ${sinExplicar.length} diferencia(s) sin explicar`
      + `${explicadas ? ` · ${explicadas} producto(s) con costo recién cambiado` : ''}`
      + `${sinExplicar.length ? ` — p. ej. ${sinExplicar.slice(0, 3).map((x) => `${x.id}.${x.campo}`).join('; ')}` : ''}`
      + `${resumenIgual ? '' : ' · resumen distinto'}`);
  }
  if (!renglones) noMedido('ningún almacén tiene renglones en la mesa: no hay con qué comparar');

  // 2 y 3. El motor sin `ligero` (Compras) da lo mismo; con `ligero`, lo omitido sale null.
  const grande = [...porAlmacen.values()].sort((a, b) => b.rn.renglones.length - a.rn.renglones.length)[0];
  if (grande && grande.rn.renglones.length) {
    const q = { warehouse_id: grande.w.id, target_basis: 'demanda', export: true };
    const mv = await viejo.motor.criticalStock(q, 'almacen');
    const mn = await nuevo.motor.criticalStock(q, 'almacen');
    const d = difs(mv.rows, mn.rows, (r) => r.product_id).filter((x) => !costoMovido.has(`${grande.w.id}|${x.id}`));
    const conEtiqueta = mn.rows.filter((r) => r.box_size != null).length;
    ok(d.length === 0 && mv.total === mn.total && conEtiqueta > 0,
      `2. motor sin ligero, ${grande.w.name}: ${mn.rows.length} filas, total ${mn.total} = ${mv.total}, ${conEtiqueta} con etiquetera · ${d.length} diferencia(s)`
      + `${d.length ? ` — p. ej. ${d.slice(0, 3).map((x) => `${x.id}.${x.campo}`).join('; ')}` : ''}`);
    const ml = await nuevo.motor.criticalStock({ ...q, ligero: true }, 'almacen');
    const omitidas = ['transfer_in', 'transfer_in_nat', 'buy_qty', 'buy_qty_nat', 'buy_cost', 'surplus_network', 'accion', 'box_size', 'pack_size'];
    const noNulas = ml.rows.filter((r) => omitidas.some((k) => r[k] !== null)).length;
    const dl = difs(mn.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omitidas.includes(k)))),
                    ml.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omitidas.includes(k)))), (r) => r.product_id);
    ok(noNulas === 0 && dl.length === 0 && ml.total === mn.total,
      `3. con ligero: ${ml.rows.length} filas, lo omitido es null en todas (${noNulas} con valor), el resto igual (${dl.length} diferencias), total ${ml.total}`);
  } else noMedido('2–3. ningún almacén con renglones para comparar el motor');

  // 4. CONTROL NEGATIVO: dos almacenes distintos NO dan lo mismo.
  const con = [...porAlmacen.values()].filter((x) => x.rn.renglones.length > 0);
  if (con.length >= 2) {
    const d = difs(con[0].rv.renglones, con[1].rn.renglones, (r) => r.product_id);
    ok(d.length > 0, `4. control: ${con[0].w.name} contra ${con[1].w.name} SÍ da diferencias (${d.length}) — la comparación ve lo que tiene que ver`);
  } else noMedido('4. menos de dos almacenes con renglones: el control negativo no se puede correr');

  // 5. Tiempos, informativos.
  console.log('\n  tiempos de /renglones (mediana de 3, intercalados; informativo):');
  for (const t of tiempos) {
    if (!porAlmacen.get(t.w.code).rn.renglones.length) continue;
    console.log(`    ${t.w.name.padEnd(20)} antes ${String(t.viejo).padStart(6)} ms → ahora ${String(t.nuevo).padStart(5)} ms ${t.nuevo < 500 ? '· bajo 500' : '· ⚠️ SOBRE 500'}`);
  }
  await salir();
})().catch(async (e) => { console.log('  ✗ error:', e.message); fail++; await salir(); });
