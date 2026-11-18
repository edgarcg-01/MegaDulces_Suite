#!/usr/bin/env node
'use strict';
/**
 * [CC.21] ¿La ficha que subió el cliente ENTRÓ al banco? — el SERVICIO real (`CustomerDepositsService`) contra la base.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * Con un banco, abonos, conciliación y documentos de Kepler SINTÉTICOS (sembrados en la transacción), la bandeja dice:
 *  1. «aplicado»: el abono que la conciliación ligó al cobro de ESTE cliente, y propone ese cobro.
 *  2. «sin_aplicar»: un abono sin cobro en Kepler.
 *  3. Negativa: el abono ligado al cobro de OTRO cliente nunca sale «aplicado» (sale «de_otro_cliente»).
 *  4. «no_aparece» sólo si el estado de cuenta ya cubre la fecha; si no, «banco_sin_cargar».
 *  5. `declararAbono` escribe el cliente en el abono (con autor y nota); negativas: una ficha con cobro y una con el
 *     abono disputado por otra ficha no declaran.
 *  6. RLS: con otro tenant la bandeja no ve las fichas.
 * Corre como `app_runtime` cuando el rol existe (SET LOCAL ROLE, después de sembrar). Todo en UNA transacción que se
 * revierte. Sin la migración de CC.20 (20261117153156) reporta NO MEDIDO. ⛔ Contra producción se NIEGA.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-ficha-en-banco', { url: DST });
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = (code) => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(code ?? (fail ? 1 : (pass ? 0 : 2))); };

let B;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'solo-para-esta-prueba-no-firma-nada-real-32b';
  B = {
    ...require(path.join(__dirname, '../../libs/finance/src/lib/collection-deposits/customer-deposits.service.ts')),
    ...require(path.join(__dirname, '../../libs/finance/src/lib/collection-deposits/collection-deposits.service.ts')),
  };
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')({ client: 'pg', connection: DST, pool: { min: 1, max: 1 } });

(async () => {
  console.log('\n[CC.21] la ficha del cliente contra el banco — servicio real\n');
  const hay = (await knex.raw(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance'
      AND table_name = 'collection_deposits' AND column_name = 'origen') AS o, to_regclass('kepler_ods.kdm1') IS NOT NULL AS k,
      to_regclass('finance.bank_recon_matches') IS NOT NULL AS r, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS rt`)).rows[0];
  if (!hay.o || !hay.k || !hay.r) { noMedido('falta la migración de CC.20 o las tablas de banco/Kepler'); await knex.destroy(); return salir(); }

  const outer = await knex.transaction();
  try {
    // ── Siembra (como dueño): un banco propio, abonos, conciliación y documentos de Kepler ──────────────────────
    await outer.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    const hoy = (await outer.raw(`SELECT current_date::text d, (current_date - 20)::text d1, (current_date - 10)::text ult`)).rows[0];
    const cta = (await outer.raw(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, kind, active)
        VALUES (?, 'CC21PRUEBA', '987654321', 'bank', true) RETURNING id`, [T])).rows[0].id;
    const est = (await outer.raw(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES (?, ?, 'CC21-PRUEBA') RETURNING id`, [T, cta])).rows[0].id;
    const mov = async (monto, fecha, uuid) => (await outer.raw(`INSERT INTO finance.bank_movements
        (tenant_id, statement_id, bank_account_id, movement_date, amount_in, amount_out, concept, client_uuid)
        VALUES (?, ?, ?, ?, ?, 0, 'DEPOSITO PRUEBA CC21', ?) RETURNING id`, [T, est, cta, fecha, monto, uuid])).rows[0].id;
    const mA = await mov(1000, hoy.d1, 'cc21-a'); const mB = await mov(2000, hoy.d1, 'cc21-b');
    const mC = await mov(3000, hoy.d1, 'cc21-c'); await mov(5, hoy.ult, 'cc21-ultimo');
    for (const [folio, cli] of [['CC21A', 'CC21-A'], ['CC21Z', 'CC21-Z']]) {
      await outer.raw(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c10, c32) VALUES ('ZZ', 'ZZ', 'U', 'A', 5, 1, ?, ?, ?)`, [folio, cli, `Cliente ${cli}`]);
    }
    for (const [m, folio] of [[mA, 'CC21A'], [mC, 'CC21Z']]) {
      await outer.raw(`INSERT INTO finance.bank_recon_matches (tenant_id, bank_movement_id, kepler_sucursal, kepler_doc_tipo, kepler_doc_folio, match_type)
          VALUES (?, ?, 'ZZ', 'U-A-5', ?, 'manual')`, [T, m, folio]);
    }
    await outer.raw(`INSERT INTO kepler_ods.kdud (sucursal, c2, c3) VALUES ('ZZ', 'CC21-B', 'Cliente B') ON CONFLICT DO NOTHING`);
    const ficha = async (cli, monto, fecha, cuenta = '000987654321') => (await outer.raw(`INSERT INTO finance.collection_deposits
        (tenant_id, origen, sucursal, cuenta_sucursal, folio, cliente_code, cliente_nombre, files, ocr_cuenta_dest, ocr_status,
         reported_monto, reported_fecha, status, created_by)
        VALUES (?, 'cliente', 'ZZ', 'ZZ', NULL, ?, ?, '[]'::jsonb, ?, 'ok', ?, ?, 'recibido', 'cliente:prueba') RETURNING id`,
      [T, cli, `Cliente ${cli}`, cuenta, monto, fecha])).rows[0].id;
    const fA = await ficha('CC21-A', 1000, hoy.d1);
    const fB = await ficha('CC21-B', 2000, hoy.d1);
    const fC = await ficha('CC21-B', 3000, hoy.d1);
    const fD = await ficha('CC21-B', 777.77, hoy.d1);
    const fE = await ficha('CC21-B', 777.77, hoy.ult);
    // La foto leyó MAL la cuenta (otra que no existe): igual encuentra el abono; y una CLABE con su dígito verificador.
    const cta2 = (await outer.raw(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, kind, active)
        VALUES (?, 'CC21PRUEBA', '55501', 'bank', true) RETURNING id`, [T])).rows[0].id;
    const est2 = (await outer.raw(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES (?, ?, 'CC21-PRUEBA') RETURNING id`, [T, cta2])).rows[0].id;
    const mG = (await outer.raw(`INSERT INTO finance.bank_movements (tenant_id, statement_id, bank_account_id, movement_date, amount_in, amount_out, concept, client_uuid)
        VALUES (?, ?, ?, ?, 4100, 0, 'DEPOSITO PRUEBA CC21', 'cc21-g1'), (?, ?, ?, ?, 4100, 0, 'DEPOSITO PRUEBA CC21', 'cc21-g2'),
               (?, ?, ?, ?, 5, 0, 'DEPOSITO PRUEBA CC21', 'cc21-g-ultimo') RETURNING id, bank_account_id`,
      [T, est, cta, hoy.d1, T, est2, cta2, hoy.d1, T, est2, cta2, hoy.ult])).rows.find((r) => r.bank_account_id === cta2).id;
    const fMal = await ficha('CC21-A', 1000, hoy.d1, '000055501'); // leyó la OTRA cuenta propia
    const fClabe = await ficha('CC21-B', 4100, hoy.d1, '072 320 00 555014'); // «…55501» + el verificador «4»

    // ── El servicio real, como app_runtime ──────────────────────────────────────────────────────────────────────
    if (hay.rt) await outer.raw('SET LOCAL ROLE app_runtime'); else noMedido('sin el rol app_runtime: corre como dueño (RLS sin forzar)');
    const yo = (await outer.raw('SELECT current_user u')).rows[0].u;
    console.log(`   como ${yo} · banco cargado hasta ${hoy.ult}`);
    let tenant = T;
    const tenantCtx = { requireTenantId: () => tenant, run: (_c, fn) => fn() };
    const tk = { run: (a, b) => { const fn = typeof a === 'function' ? a : b; return outer.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenant]); return fn(trx); }); } };
    const storage = { signFiles: async (fs) => fs || [] };
    const gateway = { emitChange: () => {} };
    const deposits = new B.CollectionDepositsService(tk, tenantCtx, {}, storage, {}, {}, gateway);
    const svc = new B.CustomerDepositsService(tk, tenantCtx, {}, storage, {}, deposits, gateway);

    const t0 = Date.now(); const b = await svc.bandeja({}); const ms = Date.now() - t0;
    const de = (id) => (b.fichas.find((f) => f.id === id) || {}).banco || {};
    ok(b.banco_medido === true, `la bandeja cruzó con el banco (${ms} ms)`);
    ok(de(fA).estado === 'aplicado' && de(fA).cobro && de(fA).cobro.folio === 'CC21A', 'aplicado: el cobro de ESTE cliente que la conciliación ligó al abono');
    ok(de(fB).estado === 'sin_aplicar' && de(fB).abonos[0].id === mB, 'sin_aplicar: el abono sin cobro en Kepler');
    ok(de(fC).estado === 'de_otro_cliente' && !de(fC).cobro, 'negativa: el abono del cobro de OTRO cliente sale «de_otro_cliente», nunca «aplicado»');
    ok(de(fD).estado === 'no_aparece', 'no_aparece: el estado de cuenta ya cubre la fecha y no hay abono');
    ok(de(fE).estado === 'banco_sin_cargar' && de(fE).cargado_hasta === hoy.ult, 'banco_sin_cargar: sin cubrir la fecha no se afirma «no aparece»');
    ok(de(fMal).abonos.length === 1 && de(fMal).abonos[0].id === mA, 'una cuenta mal leída no esconde el abono (la cuenta desempata, no filtra)');
    ok(de(fClabe).estado === 'sin_aplicar' && de(fClabe).abonos.length === 1 && de(fClabe).abonos[0].id === mG,
      'CLABE con dígito verificador: de dos abonos iguales, elige el de la cuenta leída');

    const rechaza = async (p, re) => { try { await p; return false; } catch (e) { return re.test(String(e && (e.response && e.response.message || e.message))); } };
    ok(await rechaza(svc.declararAbono(fA, 'prueba'), /único abono sin cobro/), 'negativa: no se declara el abono de una ficha que ya tiene cobro');
    const dec = await svc.declararAbono(fB, 'cobranza.prueba');
    const m = (await outer.raw(`SELECT customer_code, customer_declared_by, customer_nota FROM finance.bank_movements WHERE id = ?`, [mB])).rows[0];
    ok(dec.bank_movement_id === mB && m.customer_code === 'CC21-B' && m.customer_declared_by === 'cobranza.prueba' && /Ficha que subió/.test(m.customer_nota),
      'declarar: el abono queda del cliente, con autor y nota');
    await outer.raw('RESET ROLE');
    const fF = await ficha('CC21-A', 2000, hoy.d1); // otra ficha sobre el MISMO abono
    if (hay.rt) await outer.raw('SET LOCAL ROLE app_runtime');
    ok(await rechaza(svc.declararAbono(fF, 'prueba'), /otra ficha apunta/), 'negativa: con otra ficha sobre el mismo abono no se declara');

    tenant = OTRO;
    const b2 = await svc.bandeja({});
    ok(hay.rt ? b2.fichas.length === 0 : true, hay.rt ? 'RLS: otro tenant no ve las fichas' : 'RLS no medido (sin app_runtime)');
  } catch (e) {
    fail++; console.log('  ✗ la prueba se cayó:', e && e.message);
  } finally {
    await outer.rollback().catch(() => {});
  }

  // ── El aviso en vivo: Bancos avisa (`avisarBancos`, CB.60b) → la bandeja recibe «recarga» ──────────────────────
  // LISTEN/NOTIFY real con PgListenService (su conexión dedicada lee DATABASE_URL_NEW) y el oyente real.
  try {
    const { PgListenService } = require(path.join(__dirname, '../../libs/platform-core/src/lib/database/pg-listen.service.ts'));
    const { FichasAvisoBancoService, FICHAS_AVISO_RAFAGA_MS } = require(path.join(__dirname, '../../libs/finance/src/lib/collection-deposits/fichas-aviso-banco.service.ts'));
    const { avisarBancos } = require(path.join(__dirname, '../../libs/finance/src/lib/bank/aviso-bancos.ts'));
    const antes = { w: process.env.WORKER, d: process.env.DISABLE_FICHAS_AVISO_BANCO };
    delete process.env.WORKER; delete process.env.DISABLE_FICHAS_AVISO_BANCO;
    const llegadas = [];
    const listen = new PgListenService();
    const oyente = new FichasAvisoBancoService(listen, { avisarATodosLocal: (a, m) => { llegadas.push([a, m]); return 1; } });
    oyente.onModuleInit();
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && !listen.client; i++) await espera(100); // la conexión de LISTEN es perezosa
    await espera(200);
    // Un aviso que se REVIERTE no llega (Postgres entrega el NOTIFY sólo al confirmar).
    await knex.transaction(async (trx) => { await avisarBancos(trx, { origen: 'libro', periodos: ['2026-11'] }); throw new Error('revertir'); }).catch(() => {});
    await espera(FICHAS_AVISO_RAFAGA_MS + 800);
    ok(llegadas.length === 0, 'negativa: un aviso de Bancos que se revierte no recarga la bandeja');
    // Tres avisos confirmados seguidos (una carga de varias cuentas) = UNA recarga.
    for (let i = 0; i < 3; i++) await knex.transaction((trx) => avisarBancos(trx, { origen: 'libro', periodos: ['2026-11'] }));
    await espera(FICHAS_AVISO_RAFAGA_MS + 800);
    ok(llegadas.length === 1 && llegadas[0][0] === 'bank_loaded', `al confirmarse la carga, la bandeja recibe UNA «recarga» (${llegadas.length})`);
    oyente.onModuleDestroy(); await listen.onModuleDestroy();
    if (antes.w !== undefined) process.env.WORKER = antes.w;
    if (antes.d !== undefined) process.env.DISABLE_FICHAS_AVISO_BANCO = antes.d;
  } catch (e) {
    fail++; console.log('  ✗ la prueba del aviso se cayó:', e && e.message);
  }
  await knex.destroy();
  salir();
})();
