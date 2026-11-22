/* eslint-disable no-console */
/**
 * `[PQ.137]` · `[PQ.136]` UN PEDIDO CANCELADO EN KEPLER NO SE PINTA COMO «TE VA A LLEGAR»,
 * Y UN PEDIDO `CREADO` SÍ CUENTA — consulta REAL del servicio, contra prod, SÓLO LECTURA.
 *
 * Kepler cancela con `kdm1.c43='C'`: deja el importe en $0 y borra los renglones, pero **conserva
 * el `c11`**. «Lo que te va a llegar» decidía por ese `c11` a secas (el filtro de cancelados sólo
 * estaba del lado del embarque `U-D-41`), así que un pedido cancelado seguía apareciendo como si
 * viniera en camino. Y desde ADR-127 la Suite escribe el pedido de Autoabasto, que nace `CREADO`:
 * ese estado tampoco entraba en la lista de «abierto».
 *
 *   1. El SQL NUEVO no devuelve ningún pedido cancelado, en ninguna sucursal.
 *   2. CONTROL NEGATIVO: el SQL VIEJO (c11 crudo + lista sin CREADO) sí los devuelve. Si no
 *      devolviera ninguno, no hay nada que probar: NO MEDIDO, nunca ✔.
 *   3. Los documentos que el nuevo devuelve son exactamente los del viejo menos los cancelados:
 *      no se perdió ningún pedido vivo por el camino.
 *   4. `CREADO` cuenta como abierto — sobre filas SIMULADAS (`VALUES`), porque en prod no existe
 *      ningún pedido de sucursal en ese estado (se mide y se declara).
 *   5. NEGATIVA de la simulación: `CANCELADO` y `EMBARCADO` no pasan el mismo filtro.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
let knex;
const salir = async () => { if (knex) await knex.destroy(); console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

let VIENE_DOCS_SQL, ABIERTOS_SQL;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ VIENE_DOCS_SQL } = require(path.join(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/autoabasto-pedido.service.ts')));
  ({ WAREHOUSE_ORDER_ABIERTOS_SQL: ABIERTOS_SQL } = require(path.join(__dirname, '../../libs/contracts/src/http/warehouse-orders.contract.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar la consulta real con ts-node: ${e.message}`);
  process.exit(2);
}

knex = require('knex')(require('../knexfile-newdb.js').development);
const soloLectura = (fn) => knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION READ ONLY');
  await trx.raw('SET LOCAL statement_timeout = 120000');
  await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
  return fn(trx);
});

/**
 * La consulta COMO ERA ANTES de PQ.136/137: el `c11` crudo y la lista de abiertos sin `CREADO`.
 * Se deriva de la de hoy para que el control compare las dos versiones de la MISMA consulta y no
 * una copia que se quede vieja: si el SQL cambia, el control cambia con él.
 */
const VIEJO_SQL = VIENE_DOCS_SQL
  .replace(/CASE WHEN btrim\(coalesce\(k\.c43::text, ''\)\) = 'C' THEN 'CANCELADO'\s*ELSE upper\(NULLIF\(btrim\(k\.c11::text\), ''\)\) END/,
    'upper(btrim(k.c11::text))')
  .replace(ABIERTOS_SQL, `('AUTORIZADO','SURTIDO','CHECADO')`);

const llave = (d) => `${d.origen}/${d.serie}/${d.folio}`;

(async () => {
  console.log('\n[PQ.137] El cancelado de Kepler no se pinta como «te va a llegar» — prod, sólo lectura\n');

  if (VIEJO_SQL === VIENE_DOCS_SQL) {
    noMedido('no se pudo derivar la consulta vieja: el SQL de hoy ya no tiene las piezas que se reemplazaron');
    return salir();
  }

  const sucursales = (await soloLectura((trx) => trx.raw(
    `SELECT suc_code, nombre FROM analytics.v_erp_branch_catalog WHERE tenant_id = ? ORDER BY suc_code`, [T],
  ))).rows;
  if (!sucursales.length) { noMedido('el catálogo de sucursales del ERP vino vacío'); return salir(); }

  let nuevoTotal = 0, viejoTotal = 0, canceladosEnViejo = 0, perdidos = 0;
  const detalle = [];

  for (const s of sucursales) {
    const [nuevo, viejo] = await soloLectura(async (trx) => [
      (await trx.raw(VIENE_DOCS_SQL, { t: T, suc: s.suc_code })).rows,
      (await trx.raw(VIEJO_SQL, { t: T, suc: s.suc_code })).rows,
    ]);
    const pedN = nuevo.filter((d) => d.tipo === 'pedido');
    const pedV = viejo.filter((d) => d.tipo === 'pedido');
    nuevoTotal += pedN.length;
    viejoTotal += pedV.length;

    // ¿Cuáles de los que pintaba el viejo están cancelados en Kepler? Testigo aparte, por c43.
    const llaves = pedV.map(llave);
    let cancelados = [];
    if (llaves.length) {
      cancelados = (await soloLectura((trx) => trx.raw(
        `SELECT DISTINCT btrim(k.sucursal) || '/' || (k.c5)::int || '/' || btrim(k.c6::text) AS llave
           FROM kepler_ods.kdm1 k
          WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = 40 AND btrim(k.c1) = btrim(k.sucursal)
            AND btrim(COALESCE(k.c43::text, '')) = 'C'
            AND btrim(k.sucursal) || '/' || (k.c5)::int || '/' || btrim(k.c6::text) = ANY(?)`,
        [llaves],
      ))).rows.map((r) => r.llave);
    }
    canceladosEnViejo += cancelados.length;

    const vivosViejo = pedV.filter((d) => !cancelados.includes(llave(d))).map(llave).sort();
    const enNuevo = pedN.map(llave).sort();
    const faltan = vivosViejo.filter((k) => !enNuevo.includes(k));
    perdidos += faltan.length;
    if (cancelados.length || faltan.length) {
      detalle.push(`${s.nombre}: viejo ${pedV.length} · nuevo ${pedN.length} · cancelados ${cancelados.length}${faltan.length ? ` · ⚠ perdidos ${faltan.length}` : ''}`);
    }

    const sucios = pedN.filter((d) => cancelados.includes(llave(d)));
    if (sucios.length) {
      fail++;
      console.log(`  ✗ 1. ${s.nombre} devuelve ${sucios.length} pedido(s) cancelado(s): ${sucios.slice(0, 3).map(llave).join(', ')}`);
    }
  }

  // 1 · El nuevo no devuelve ningún cancelado (si no hubo fallas arriba, pasó en las 9).
  if (!fail) ok(nuevoTotal >= 0, `1. ningún pedido cancelado en la respuesta nueva, en ${sucursales.length} sucursales (${nuevoTotal} pedidos vivos)`);

  // 2 · CONTROL NEGATIVO: el viejo sí los traía.
  if (canceladosEnViejo > 0) {
    ok(viejoTotal > nuevoTotal, `2. CONTROL: la consulta vieja pintaba ${canceladosEnViejo} pedido(s) cancelado(s) (viejo ${viejoTotal} → nuevo ${nuevoTotal})`);
    for (const d of detalle) console.log('     ·', d);
  } else {
    noMedido('2. hoy no hay pedidos cancelados en la ventana: el control no pudo ejercerse');
  }

  // 3 · No se perdió ningún pedido vivo.
  ok(perdidos === 0, `3. los vivos del viejo siguen todos en el nuevo (perdidos: ${perdidos})`);

  // 4 · CREADO: en prod no existe todavía, así que la regla se prueba sobre filas simuladas.
  const reales = (await soloLectura((trx) => trx.raw(
    `SELECT count(*)::int AS n FROM kepler_ods.kdm1 k
      WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = 40 AND btrim(k.c1) = btrim(k.sucursal)
        AND upper(btrim(COALESCE(k.c27::text, ''))) = 'SUCURSAL'
        AND upper(btrim(COALESCE(k.c11::text, ''))) = 'CREADO'
        AND (k.c9)::date >= current_date - 365`,
  ))).rows[0].n;
  if (reales === 0) noMedido(`4. en 365 días no hay ningún pedido de sucursal en CREADO en prod (${reales}): la regla se prueba simulada`);
  else ok(true, `4. hay ${reales} pedido(s) de sucursal en CREADO en prod`);

  const sim = (await soloLectura((trx) => trx.raw(
    `SELECT estado, (estado IN ${ABIERTOS_SQL}) AS cuenta
       FROM (VALUES ('CREADO'), ('AUTORIZADO'), ('SURTIDO'), ('CHECADO'), ('EMBARCADO'), ('CANCELADO')) v(estado)`,
  ))).rows;
  const pasa = (e) => sim.find((r) => r.estado === e)?.cuenta === true;
  ok(pasa('CREADO') && pasa('AUTORIZADO') && pasa('SURTIDO') && pasa('CHECADO'),
    '4b. CREADO, AUTORIZADO, SURTIDO y CHECADO cuentan como abierto');

  // 5 · NEGATIVA de la simulación.
  ok(!pasa('CANCELADO') && !pasa('EMBARCADO'),
    '5. NEGATIVA: CANCELADO y EMBARCADO no cuentan como abierto');

  return salir();
})().catch(async (e) => { console.error('  ✗ ERROR', e.message); fail++; await salir(); });
