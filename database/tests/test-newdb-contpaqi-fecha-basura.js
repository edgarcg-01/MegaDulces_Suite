/* eslint-disable no-console */
/**
 * `[CP.8.93]` — Candado de **la fecha basura en el armado de egresos**: un egreso fechado a más de 7 días del mes de su
 * estado de cuenta no se arma; se declara en el mes de SU estado con `fecha_fuera_del_estado`. Antes el armado lo
 * elegía por la fecha: desaparecía de su mes y caía en otro (agosto 2026: 11 egresos fechados en 2027).
 *
 *   [B] contra PROD, sólo lectura: lo que el armado declara en agosto 2026 contra un conteo independiente en SQL de los
 *       egresos de los estados de agosto con la fecha fuera (dos caminos, el mismo número).
 *   [C] contra destino LOCAL (job `pruebas-db`), escribiendo como `app_runtime`: un estado de junio con un egreso
 *       normal, uno fechado un año después y uno de los últimos días de mayo (corte, no basura). Sale sólo el normal;
 *       el basura se declara en junio y no aparece en el junio del año siguiente; el del corte se arma en mayo.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
const ALIAS = {
  '@megadulces/contracts': path.join(ROOT, 'libs/contracts/src/index.ts'),
  '@megadulces/platform-core': path.join(ROOT, 'libs/platform-core/src/index.ts'),
};
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return ALIAS[pedido] ? ALIAS[pedido] : resolveOriginal.call(this, pedido, ...resto);
};

const knexLib = require('knex');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { classify, assertSafeTarget } = require('./_lib/assert-safe-target');

const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'contpaqi');
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const MES = '2001-06';
const CAT = 'cp893_candado';
const GASTO = '5299990003';
const BANCO = '1020990005';
const MES_REAL = '2026-08';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.93 la fecha basura no se arma: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

function servicio(pool) {
  const { ContpaqiArmadoService } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
  const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));
  const armado = new ContpaqiArmadoService(pool, new ContpaqiTxtSinkAdapter());
  armado.log = silencio;
  return armado;
}
const basuraDe = (lotes) => lotes.filter((l) => String(l.clave ?? '').startsWith('basura|'));

async function soloLectura(url) {
  console.log(`\n[B] Contra prod, sólo lectura: ${MES_REAL}`);
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query("SET default_transaction_read_only = on; SET app.tenant_id = ''", (e) => d(e, c)) },
  });
  try {
    const armado = servicio(pool);
    const r = await armado.simularLotes(MES_REAL);
    const declarados = basuraDe(r.lotes).reduce((a, l) => a + l.movimientos, 0);
    // El otro camino: SQL directo, con el tenant puesto a mano (las tablas tienen RLS forzado).
    const sql = await pool.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]);
      return (await trx.raw(`
        SELECT count(*)::int AS n
          FROM finance.bank_movements m
          JOIN finance.bank_statements st ON st.id = m.statement_id
          JOIN finance.bank_accounts ba ON ba.id = m.bank_account_id AND ba.contpaqi_cuenta IS NOT NULL
          LEFT JOIN finance.movement_categories c ON c.id = m.category_id
         WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND m.amount_out > 0 AND coalesce(c.code, '') <> 'iva_acreditable'
           AND left(st.period::text, 7) = ?
           AND (m.movement_date < to_date(? || '-01', 'YYYY-MM-DD') - 7
                OR m.movement_date >= (to_date(? || '-01', 'YYYY-MM-DD') + interval '1 month')::date + 7)`,
      [MEGA, MES_REAL, MES_REAL, MES_REAL])).rows[0].n;
    });
    console.log(`    el armado declara ${declarados} · el conteo directo en SQL da ${sql}`);
    check(sql > 0 && declarados === sql, `⭐ declara con fecha basura los mismos que cuenta el SQL directo (${declarados} = ${sql})`);
    check(basuraDe(r.lotes).every((l) => l.incluidas === 0 && l.motivos.fecha_fuera_del_estado === l.movimientos),
      'ninguno entra a una póliza y todos llevan su motivo');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[C] Contra destino local, escribiendo como app_runtime');
  assertSafeTarget('test-newdb-contpaqi-fecha-basura', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-fecha-basura', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = {};
  try {
    for (const [s, t] of [['contpaqi', 'account_rules'], ['analytics', 'contpaqi_accounts']]) {
      if (!(await admin.schema.withSchema(s).hasTable(t))) { noMedido(`${s}.${t} no existe en este destino`); return; }
    }
    // Siembra con postgres (salta el RLS: siembra, no prueba).
    await admin('analytics.contpaqi_accounts').insert([[GASTO, 'CANDADO GASTO CP893', 'G'], [BANCO, 'CANDADO BANCO CP893', 'A']]
      .map(([codigo, nombre, tipo]) => ({ tenant_id: MEGA, codigo, nombre, tipo, es_baja: false, afectable: 1 })));
    const [cta] = await admin('finance.bank_accounts').insert({ tenant_id: MEGA, bank: 'CANDADO', account_label: 'CP893', kind: 'bank', contpaqi_cuenta: BANCO }).returning('id');
    ids.cuenta = cta.id ?? cta;
    const [est] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: ids.cuenta, period: MES }).returning('id');
    const [cat] = await admin('finance.movement_categories').insert({ tenant_id: MEGA, code: CAT, name: 'Candado CP.8.93', flow: 'out', group_key: 'candado' }).returning('id');
    ids.categoria = cat.id ?? cat;
    await admin('contpaqi.account_rules').insert({ tenant_id: MEGA, categoria_code: CAT, tipo_regla: 'por_categoria', estado: 'aprobada', cuenta_gasto: GASTO });
    const mov = async (n, fecha, imp) => {
      const [m] = await admin('finance.bank_movements').insert({
        tenant_id: MEGA, statement_id: est.id ?? est, bank_account_id: ids.cuenta, movement_date: fecha,
        client_uuid: `cp893-candado-${n}`, concept: `CANDADO CP893 ${n}`, amount_out: imp, category_id: ids.categoria,
      }).returning('id');
      return String(m.id ?? m);
    };
    await mov(1, '2001-06-10', 100.00);
    const basura = await mov(2, '2002-06-10', 55.00);
    await mov(3, '2001-05-28', 33.00);
    check(true, 'sembrado: un estado de junio con un egreso normal, uno fechado un año después y uno del 28 de mayo');

    const armado = servicio(runtime);
    const a = await armado.generarArchivoMes(MES);
    check(a.polizas === 1 && a.total === 100, `⭐ junio arma sólo el normal: ${a.polizas} póliza por ${a.total}`);
    const r = await armado.simularLotes(MES);
    const b = basuraDe(r.lotes);
    check(b.length === 1 && b[0].clave === `basura|${BANCO}|${MES}` && b[0].movimientos === 1 && b[0].incluidas === 0
      && b[0].motivos.fecha_fuera_del_estado === 1, `el fechado un año después se declara en junio: ${b.map((l) => `${l.clave} · ${l.movimientos}`).join(', ') || 'nada'}`);
    const estados = new Map();
    await armado.conTenant(() => armado.construirLotes(MES, estados));
    check((estados.get(basura) || {}).motivo === 'fecha_fuera_del_estado', `con su motivo: ${(estados.get(basura) || {}).motivo}`);

    const r2 = await armado.simularLotes('2002-06');
    check(!r2.lotes.some((l) => l.cuenta_banco === BANCO), '⛔ y no aparece en el junio del año siguiente: es del estado de junio 2001');
    const may = await armado.generarArchivoMes('2001-05');
    check(may.polizas === 1 && may.total === 33, `el del 28 de mayo no es basura (corte, a menos de 7 días): se arma en mayo, ${may.total}`);
  } finally {
    try {
      await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT }).del();
      if (ids.cuenta) await admin('finance.bank_accounts').where({ id: ids.cuenta }).del(); // cascada: estado y movimientos
      if (ids.categoria) await admin('finance.movement_categories').where({ id: ids.categoria }).del();
      await admin('analytics.contpaqi_accounts').where({ tenant_id: MEGA }).whereIn('codigo', [GASTO, BANCO]).del();
    } catch (e) {
      console.log(`  ⚠ limpieza incompleta: ${e.message}`);
    }
    await admin.destroy();
    await runtime.destroy();
  }
}

(async () => {
  const urlAdmin = process.env.DATABASE_URL_NEW;
  const urlRuntime = process.env.DATABASE_URL_NEW_RUNTIME;
  const kAdmin = classify(urlAdmin).kind;
  const kRuntime = classify(urlRuntime).kind;
  if (kAdmin === 'local' && kRuntime === 'local') await completo(urlAdmin, urlRuntime);
  else if (kAdmin === 'prod') await soloLectura(urlAdmin);
  else noMedido(`destino ${kAdmin}/${kRuntime}: ni local ni prod — no se corre`);
  fin();
})().catch((e) => {
  console.log(`  ✗ excepción: ${e && e.message}`);
  fail += 1;
  fin();
});
