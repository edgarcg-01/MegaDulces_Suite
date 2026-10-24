/* eslint-disable no-console */
/**
 * `[AB.34]` «LO QUE LA SUCURSAL YA PIDIÓ» — la versión de RED da lo mismo que la de cada sucursal.
 * Módulo REAL vía ts-node, SÓLO LECTURA (transacción READ ONLY), contra la base de `DATABASE_URL_NEW`.
 *
 *   1. «Mi pedido» no cambia: el SQL por sucursal del módulo compartido es, carácter por carácter, el
 *      que tenía `autoabasto-pedido.service.ts` en el commit indicado (default: el padre del que lo movió).
 *   2. Para CADA sucursal con cliente de traspaso, `leerYaPedidoRed` (una pasada para toda la red) da
 *      exactamente lo que dan las consultas por sucursal + `sumarYaPedido`: mismos SKU, mismas cantidades.
 *   3. CONTROL NEGATIVO: comparar una sucursal contra OTRA da diferencias (si no, la comparación no ve nada).
 * Sin renglones en la base: NO MEDIDO, nunca ✔.
 *
 * Uso: node database/tests/test-newdb-ya-pedido-red.js [<commit de referencia para la prueba 1>]
 */
const path = require('path');
const { execSync } = require('child_process');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.join(__dirname, '..', '..');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
let knex;
const salir = async () => { if (knex) await knex.destroy(); console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

let M;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', esModuleInterop: true, ignoreDeprecations: '6.0' } });
  M = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/ya-pedido-sucursal.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el módulo con ts-node: ${e.message}`);
  process.exit(2);
}

knex = require('knex')(require('../knexfile-newdb.js').development);

/** Las cantidades de dos mapas `sku → VieneBase`, comparadas con tolerancia de redondeo. */
function diferencias(a, b) {
  const d = [];
  const skus = new Set([...(a ? a.keys() : []), ...(b ? b.keys() : [])]);
  for (const s of skus) {
    const x = a?.get(s) ?? { ya: 0, atorado: 0, negado: 0, camino: 0 };
    const y = b?.get(s) ?? { ya: 0, atorado: 0, negado: 0, camino: 0 };
    for (const k of ['ya', 'atorado', 'negado', 'camino']) if (Math.abs(x[k] - y[k]) > 1e-6) d.push(`${s}.${k}: ${x[k]} ≠ ${y[k]}`);
  }
  return d;
}

(async () => {
  console.log('\n[AB.34] lo que la sucursal ya pidió — red contra sucursal por sucursal, sólo lectura\n');

  // 1. El SQL por sucursal es el mismo texto que tenía «Mi pedido».
  const ref = process.argv[2] || 'c4e06e039';
  try {
    const viejo = execSync(`git show ${ref}:libs/commercial/src/lib/commercial-replenishment/autoabasto-pedido.service.ts`,
      { cwd: RAIZ, encoding: 'utf8' }).split('\r\n').join('\n');
    for (const nombre of ['PEDIDOS_SUCURSAL_SQL', 'EMBARCADO_SIN_RECIBIR_SQL']) {
      const m = new RegExp(`const ${nombre} = \`([\\s\\S]*?)\`;`).exec(viejo);
      // El texto viejo tiene las ventanas como \${...}: se resuelven con las mismas constantes.
      const texto = m && m[1]
        .replace(/\$\{VENTANA_YA_PEDIDO_DIAS\}/g, String(M.VENTANA_YA_PEDIDO_DIAS))
        .replace(/\$\{VENTANA_NEGADO_DIAS\}/g, String(M.VENTANA_NEGADO_DIAS))
        .replace(/\$\{VENTANA_EN_CAMINO_DIAS\}/g, String(M.VENTANA_EN_CAMINO_DIAS));
      ok(texto != null && texto === M[nombre], `1. ${nombre} es idéntico al de «Mi pedido» en ${ref}`);
    }
  } catch (e) {
    noMedido(`no se pudo leer ${ref} con git: ${e.message}`);
  }

  await knex.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw('SET LOCAL statement_timeout = 180000');
    await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
    const sid = (await trx.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
    console.log(`  base: system_identifier ${sid}\n`);

    const t0 = Date.now();
    const red = await M.leerYaPedidoRed(trx, T);
    const ms = Date.now() - t0;
    const sucs = (await trx.raw('SELECT DISTINCT suc_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = ? ORDER BY 1', [T])).rows.map((r) => r.suc_code);

    let renglones = 0;
    const porSuc = new Map();
    for (const suc of sucs) {
      const binds = { t: T, suc };
      const pedidos = (await trx.raw(M.PEDIDOS_SUCURSAL_SQL, binds)).rows;
      const camino = (await trx.raw(M.EMBARCADO_SIN_RECIBIR_SQL, binds)).rows;
      const skus = [...new Set([...pedidos, ...camino].map((r) => r.sku))];
      const esc = new Map();
      if (skus.length) {
        const nn = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
        for (const x of await trx('analytics.v_product_unit_ladder').select('sku', 'unit_base', 'u2_label', 'u3_label', 'f2', 'f3', 'is_weight').whereIn('sku', skus)) {
          esc.set(x.sku, { unit_base: x.unit_base, u2_label: x.u2_label, u3_label: x.u3_label, f2: nn(x.f2), f3: nn(x.f3), is_weight: !!x.is_weight });
        }
      }
      const uno = M.sumarYaPedido(pedidos, camino, esc);
      porSuc.set(suc, uno);
      renglones += uno.viene.size;
      const d = diferencias(uno.viene, red.get(suc)?.viene);
      ok(d.length === 0 && uno.sinUnidad === (red.get(suc)?.sinUnidad ?? 0),
        `2. ${suc}: ${uno.viene.size} producto(s), red = sucursal${d.length ? ` — ${d.length} diferencia(s), p. ej. ${d.slice(0, 3).join('; ')}` : ''}`);
    }
    if (!renglones) noMedido('ninguna sucursal tiene pedidos abiertos ni embarques: no hay con qué comparar');
    console.log(`\n  leerYaPedidoRed: ${ms} ms para ${sucs.length} sucursal(es)`);

    // 3. Control negativo: dos sucursales con renglones NO pueden dar lo mismo.
    const con = [...porSuc.entries()].filter(([, v]) => v.viene.size > 0);
    if (con.length >= 2) {
      ok(diferencias(con[0][1].viene, red.get(con[1][0])?.viene).length > 0,
        `3. control: ${con[0][0]} contra ${con[1][0]} SÍ da diferencias (la comparación ve lo que tiene que ver)`);
    } else {
      noMedido('menos de dos sucursales con renglones: el control negativo no se puede correr');
    }
  });
  await salir();
})().catch(async (e) => { console.log('  ✗ error:', e.message); fail++; await salir(); });
