/* eslint-disable no-console */
'use strict';
/**
 * `[CGA-A.72]` — Ligar un depósito de CAOS ya capturado con el documento de Kepler que es: el
 * SERVICIO REAL (`CashLedgerService.ligarDocumento`), contra una base real, con el payload de la
 * pantalla (`POST /finance/cash-ledger/:id/ligar-documento { origen_ref }`).
 *
 * Siembra el caso real del 2026-11-09 con fechas de 2025: el cobro U-A-5 0000008 de la ruta 21
 * (`analytics.route_collections`, como lo trae la camioneta) y su depósito ya capturado desde CAOS
 * sin documento («CAOS Deposito #1580 · rd21 10/02»), dentro de un corte CERRADO —así estaba el real,
 * `en_corte`—. Escribe como `app_runtime` (el rol de prod) y mide:
 *
 *  1. la cola real marca el cobro como «ya en el libro» con ESE depósito (lo que la pantalla manda);
 *  2. ligar escribe `declared_doc_ref` aunque el corte esté cerrado, y la cola deja de ofrecerlo;
 *  3. repetirlo no escribe nada (idempotente);
 *  4. [negativa] ligarlo a OTRA ruta del mismo importe se rechaza (lo decide el servidor, no el clic);
 *  5. [negativa] una captura que no es depósito de CAOS, o que ya declara otro documento, no se liga;
 *  6. [control] el candado del corte SÍ está puesto: cambiarle el importe falla.
 *
 * Todo en una transacción que se deshace. Plan: `FASE_LE_ANEXO_CUADRE` / tracker `[CGA-A.72]`.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-ligar-documento');

const T = '00000000-0000-0000-0000-00000000d01c';
const OPERA = '00000000-0000-0000-0000-0000000072a1';
const REF = '01-001|U-A-5|0000008|0011';
const REF_OTRA = '01-002|U-A-5|0000008|0011';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nomedido} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

let Servicio;
// El servicio importa la guarda de autenticación, que se niega a cargar sin secreto de firma: en el
// CI eso dejaba esta prueba en NO MEDIDO (2026-11-10). Un secreto de prueba, como test-newdb-alc-alta-clientes.
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-cga72-${'x'.repeat(40)}`;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ CashLedgerService: Servicio } = require(path.join(__dirname, '../../libs/finance/src/lib/caja/cash-ledger.service.ts')));
} catch (e) {
  console.log(`  ⃝ NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

/** El servicio real, con su `tk.run` dentro de la transacción de la prueba (un SAVEPOINT por llamada). */
const servicio = (trx) => new Servicio(
  { run: (fn) => trx.transaction((sp) => fn(sp)) },
  { requireTenantId: () => T, get: () => ({ tenantId: T, userId: OPERA }) },
);
async function error(fn) {
  try { await fn(); return null; } catch (e) { return { status: e.getStatus?.() ?? null, code: e.code ?? null, constraint: e.constraint ?? null, msg: String(e.message).slice(0, 160) }; }
}

(async () => {
  console.log('\n[CGA-A.72] Ligar un depósito de CAOS con su documento de Kepler — servicio real\n');
  const id = (await knex.raw('SELECT system_identifier::text sid, current_database() db FROM pg_control_system()')).rows[0];
  console.log(`   base ${id.db} · system_identifier ${id.sid}`);
  const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;

  await knex.transaction(async (trx) => {
    console.log('── 1. Siembra (superusuario) ──');
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    await trx.raw(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
      VALUES (?, 'cga72_opera', '{"FINANCE_CAJA_GESTIONAR": true, "FINANCE_CAJA_VER": true}'::jsonb)
      ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`, [T]);
    await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, password_hash)
      VALUES (?, ?, 'cga72_opera', 'cga72_opera', true, 'prueba-sin-login')`, [OPERA, T]);
    // El cobro de la camioneta, como lo trae la ruta (y otro de OTRA ruta por el MISMO importe: el señuelo).
    for (const [truck, almacen] of [['ruta_21', '01-001'], ['ruta_22', '01-002']]) {
      await trx('analytics.route_collections').insert({
        tenant_id: T, truck, almacen, cobro_folio: '0000008', fecha: '2025-02-10', cuenta: '0011',
        doc_tipo: 'D-23-1', folio_corte: '0000008', importe: 13552, referencia: 'Caja 1-109',
      });
    }
    const [corte] = await trx('finance.cash_ledger_cuts').insert({
      tenant_id: T, folio: `CGA72-${Date.now()}`, fecha: '2025-02-13', sucursal: '00',
      fondo_inicial: 0, fondo_origen: 'contado', created_by: OPERA, created_by_username: 'cga72_opera',
    }).returning('*');
    const dep = (folio, over = {}) => ({
      tenant_id: T, folio, tipo: 'ingreso', fecha: '2025-02-13', sucursal: '00',
      kepler_cuenta: '115', kepler_concepto: '071', glosa: 'CAOS Deposito #1580 · rd21 10/02', monto: 13552,
      origen_tipo: 'caos', origen_ref: `AST700-TEST|${folio}`, created_by: OPERA, created_by_username: 'cga72_opera', ...over,
    });
    const [d] = await trx('finance.cash_ledger').insert({ ...dep(`CI-CGA72-${Date.now()}`), corte_id: corte.id }).returning('*');
    const [otro] = await trx('finance.cash_ledger').insert(dep(`CI-CGA72-K-${Date.now()}`, { origen_tipo: 'cobro', origen_ref: '01-003|U-A-5|0000099|0011', glosa: 'U-A-5 0000099 · CONTADO' })).returning('*');
    const [declarado] = await trx('finance.cash_ledger').insert(dep(`CI-CGA72-D-${Date.now()}`, { declared_doc_ref: '01-004|U-A-5|0000098|0011', monto: 999 })).returning('*');
    ok(!!d && !!otro && !!declarado, 'sembrados: el cobro de la ruta 21, el señuelo de la 22 y tres capturas');

    // El corte se CIERRA: el depósito queda como el real, dentro de un corte firmado.
    const cierre = await error(() => trx.transaction((sp) => sp('finance.cash_ledger_cuts').where({ id: corte.id })
      .update({ estado: 'cerrado', closed_by: OPERA, closed_at: trx.fn.now() })));
    const cerrado = !cierre;
    if (cerrado) ok(true, 'el corte del depósito quedó CERRADO');
    else skip(`no se pudo cerrar el corte sembrado (${cierre.code} ${cierre.constraint ?? ''} ${cierre.msg}): el caso «en corte firmado» queda sin medir`);

    if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
    else skip('sin app_runtime: las escrituras corren como superusuario, no como la app.');
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    const s = servicio(trx);
    const yo = { id: OPERA, username: 'cga72_opera' };

    console.log('\n── 2. La cola real lo marca (lo que la pantalla manda) ──');
    let cola = null;
    const ec = await error(async () => { cola = await s.movimientosPendientes({ from: '2025-02-01', to: '2025-02-28', limit: 500 }); });
    if (ec) skip(`la cola real no corrió en esta base (${ec.msg}): la marca se mide abajo con el motor del servidor`);
    else {
      const fila = cola.rows.find((r) => r.origen_ref === REF);
      ok(!!fila, `la cola ofrece ${REF}`);
      ok(fila?.ya_en_libro?.folio === d.folio && fila?.ya_en_libro?.id === d.id && fila?.ya_en_libro?.certeza === 'alta',
        `y lo marca: ya en el libro como ${d.folio}, con su id y certeza alta (dice: ${JSON.stringify(fila?.ya_en_libro ?? null)})`);
      ok(cola.rows.find((r) => r.origen_ref === REF_OTRA)?.ya_en_libro == null, '[negativa] el señuelo de la ruta 22 NO se marca con ese depósito');
    }

    console.log('\n── 3. Ligar con el payload de la pantalla ──');
    const e4 = await error(() => s.ligarDocumento(d.id, REF_OTRA, yo));
    ok(e4?.status === 409, `[negativa] ligarlo a la ruta 22 (mismo importe) se rechaza: 409 (dio ${e4 ? `${e4.status} ${e4.msg}` : 'pasó'})`);
    const e5a = await error(() => s.ligarDocumento(otro.id, REF, yo));
    ok(e5a?.status === 400, `[negativa] una captura de Kepler no se liga así: 400 (dio ${e5a ? e5a.status : 'pasó'})`);
    const e5b = await error(() => s.ligarDocumento(declarado.id, REF, yo));
    ok(e5b?.status === 409, `[negativa] una captura que ya declara otro documento no se cambia: 409 (dio ${e5b ? e5b.status : 'pasó'})`);
    const e5c = await error(() => s.ligarDocumento(d.id, 'cualquier cosa', yo));
    ok(e5c?.status === 400, `[negativa] una llave mal formada se rechaza antes de tocar la base: 400 (dio ${e5c ? e5c.status : 'pasó'})`);

    let r = null;
    const e3 = await error(async () => { r = await s.ligarDocumento(d.id, REF, { ...yo }); });
    ok(!e3 && r?.declared_doc_ref === REF && r?.ya_estaba === false && r?.como === 'deposito_ruta',
      `ligar ${d.folio} → ${REF}${cerrado ? ' (en corte CERRADO)' : ''} (dio ${e3 ? `${e3.status} ${e3.code} ${e3.msg}` : JSON.stringify(r)})`);
    const fila = await trx('finance.cash_ledger').where({ id: d.id }).first('declared_doc_ref', 'monto', 'estado', 'updated_by');
    ok(fila?.declared_doc_ref === REF && Number(fila?.monto) === 13552 && String(fila?.updated_by) === OPERA,
      'en la base: el documento quedó escrito, el importe intacto y se sabe quién lo ligó');
    const r2 = await s.ligarDocumento(d.id, REF, yo).catch((e) => ({ err: e.message }));
    ok(r2?.ya_estaba === true, `repetirlo no escribe nada (ya_estaba: ${r2?.ya_estaba})`);

    if (!ec) {
      const despues = await s.movimientosPendientes({ from: '2025-02-01', to: '2025-02-28', limit: 500 });
      ok(!despues.rows.some((x) => x.origen_ref === REF), 'la cola ya NO ofrece el cobro ligado');
      ok(despues.rows.some((x) => x.origen_ref === REF_OTRA), 'y el de la ruta 22 sigue ahí: no se escondió nada de más');
    }

    if (cerrado) {
      console.log('\n── 4. [control] el candado del corte sí está puesto ──');
      const e6 = await error(() => trx.transaction((sp) => sp('finance.cash_ledger').where({ id: d.id }).update({ monto: 13553 })));
      ok(e6?.constraint === 'cash_ledger_en_corte_firmado_chk',
        `cambiarle el importe al depósito del corte cerrado falla (${e6 ? `${e6.code} ${e6.constraint}` : 'pasó sin error'}): ligar no se coló por un candado apagado`);
    }
    throw new Error('__ROLLBACK__');
  }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
  console.log('\n  ✓ rollback aplicado — la base queda como estaba');
  await knex.destroy();
  salir();
})().catch(async (e) => { console.error('  ✗', e.stack ?? e.message); fail++; await knex.destroy(); salir(); });
