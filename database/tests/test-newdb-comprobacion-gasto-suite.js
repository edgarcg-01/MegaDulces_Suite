/* eslint-disable no-console */
/**
 * `[PGP.123]` G.8 — La comprobación del gasto DE PUNTA A PUNTA con los servicios REALES (ExpenseProofsService.validate y
 * .approve + ComprobacionGastoService + el escritor del X-A-10, via ts-node) como `app_runtime` con RLS, contra el ODS
 * sembrado de la sucursal 05 y un Kepler de prueba con las estructuras de Kepler.
 *
 * Casos: validar con el PAYLOAD DE LA PANTALLA («Dar por comprobado») escribe el gasto en Kepler (folio, póliza, la
 * solicitud en F) y lo anota en el vale y en la bitácora (tipo 10, disparo `validacion`) · el lazo: escrito → visto en
 * el ODS → cancelado en Kepler, con su latido · interruptor apagado → espera sin escribir, y lo dice · un vale que no
 * se puede comprobar solo (otro importe) → dice por qué y no escribe · ⛔ el gasto que capturó una persona se
 * reconoce con su folio y NO se escribe otro · ⛔ el proceso muere tras reclamarlo → el cron lo da por huérfano, busca
 * el gasto en Kepler y lo escribe una sola vez · firmar un vale que cierra en `validada` también lo comprueba.
 *
 * Revisión independiente (2026-11-17), cada hallazgo con su caso: la factura que no se encuentra no se trata como «sin
 * factura» (D2) · cancelado suelta el folio, vuelve a la cola y «Reintentar» lo escribe de nuevo (B, L) · «en duda» se
 * resuelve aunque la solicitud ya no esté en A, también con la base cerrada, y no se queda para siempre (M) · no se
 * rechaza un vale con su gasto escrito por la Suite o escribiéndose (N) · no se liga un caso ya revisado ni una cancelada
 * con su gasto vivo, y ligar limpia el estado del gasto viejo (K).
 *
 * NO MEDIDO (se declara): la llave primaria real de las tablas de Kepler, la respuesta perdida de un COMMIT y lo que
 * Kepler además escriba al capturar un X-A-10 (G.1).
 *
 * ⛔ Siembra en el ODS y en finance.expense_proofs de la base de prueba y borra EXACTAMENTE lo que sembró; crea y borra
 * su Kepler de prueba. Sólo contra un destino seguro (`assertSafeTarget`).
 *
 *   node database/tests/test-newdb-comprobacion-gasto-suite.js
 */
'use strict';

require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
const { assertSafeTarget } = require('./_lib/assert-safe-target');
const ADMIN_URL = process.env.DATABASE_URL_NEW;
assertSafeTarget('test-newdb-comprobacion-gasto-suite', { url: ADMIN_URL });
const { noMedido } = require('./_lib/no-medido');
const { columnas, ddl } = require('./_lib/kepler-de-prueba');

// ── Los módulos REALES; de platform-core, doble sólo la infraestructura de Nest ─────────────────────────────────────
const PC = (r) => path.join(RAIZ, 'libs', 'platform-core', 'src', 'lib', r);
const CONTRATOS = path.join(RAIZ, 'libs', 'contracts', 'src');
const STUB = path.join(os.tmpdir(), `.stub-pgp123-suite-${process.pid}.js`);
const real = (r) => `...require(${JSON.stringify(PC(r))})`;
fs.writeFileSync(STUB, `'use strict';
module.exports = {
  ${real('kepler/kepler-servidor.ts')},
  ${real('search/smart-search.ts')},
  ${real('date/mx-date.ts')},
  ${real('ability/platform-admin.ts')},
  ${real('provenance/cron-heartbeat.ts')},
  Permission: require(${JSON.stringify(path.join(CONTRATOS, 'index.ts'))}).Permission,
  KNEX_NEW_DB: 'KNEX_NEW_DB',
  TenantKnexService: class TenantKnexService {}, TenantContextService: class TenantContextService {},
  CloudinaryService: class CloudinaryService {}, ObjectStorageService: class ObjectStorageService {},
  LlmExtractorService: class LlmExtractorService {}, RolesGuard: class RolesGuard {},
  CloudinaryModule: class CloudinaryModule {}, AiProductMatcherModule: class AiProductMatcherModule {},
  Public: () => () => undefined, RequirePermissions: () => () => undefined, RequireAnyPermission: () => () => undefined,
  jwtVerifyOptions: () => ({}), requireJwtSecret: () => 'prueba',
};
`);
process.on('exit', () => { try { fs.unlinkSync(STUB); } catch { /* ya no está */ } });
const resolver = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '@megadulces/platform-core') return STUB;
  if (req === '@megadulces/contracts') return path.join(CONTRATOS, 'index.ts');
  if (req.startsWith('@megadulces/contracts/')) {
    const sub = path.join(CONTRATOS, req.slice('@megadulces/contracts/'.length));
    for (const f of [`${sub}.ts`, path.join(sub, 'index.ts')]) if (fs.existsSync(f)) return f;
  }
  return resolver.call(this, req, ...rest);
};
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0',
    experimentalDecorators: true, emitDecoratorMetadata: true,
  },
});
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(process.env.VERBOSE ? ['log', 'warn', 'error'] : ['error']);
const EP = path.join(RAIZ, 'libs', 'finance', 'src', 'lib', 'expense-proofs');
const { ExpenseProofsService } = require(path.join(EP, 'expense-proofs.service.ts'));
const { ComprobacionGastoService } = require(path.join(EP, 'comprobacion-kepler', 'comprobacion-gasto.service.ts'));
const { KeplerGastoSinkAdapter } = require(path.join(EP, 'comprobacion-kepler', 'kepler-gasto-sink.adapter.ts'));
const { todayMx } = require(PC('date/mx-date.ts'));

// ── La base: cada transacción como la API (app_runtime + tenant), la siembra como administrador ──────────────────
const knex = require('knex')({ client: 'pg', connection: ADMIN_URL, pool: { min: 0, max: 8 } });
const T = '00000000-0000-0000-0000-00000000d01c';
const ROL_API = 'app_runtime';
const tk = {
  run(a, b) {
    const fn = typeof a === 'function' ? a : b;
    const tenant = typeof a === 'string' ? a : T;
    return knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ROLE ${ROL_API}`);
      await trx.raw(`SET LOCAL app.tenant_id = '${tenant}'`);
      return fn(trx);
    });
  },
  get global() { return knex; },
};
const ctx = { requireTenantId: () => T, getTenantId: () => T };
const almacen = { getDataUri: async () => null };
const lector = { extractExpenseReceipt: async () => { throw new Error('la prueba no lee comprobantes'); } };

const SUC = '05';
const BASE = 'kepler_prueba_pgp123_suite';
const ROL = 'kepler_push_pgp123_suite';
const CLAVE = 'pgp123_suite_prueba';
const TIPO = 'comprobacion_gasto';
const JOB = 'gastos_comprobacion_kepler';
// Códigos y folios PROPIOS de la prueba, que no existen en ningún Kepler.
const ACR = 'GZPRU3';
const QUIEN = { username: 'valida_prueba', full_name: 'Valida De Prueba' };
/** Lo que guardó la pantalla al capturar: la foto del vale firmado y su comprobante. */
const ARCHIVOS = [{ role: 'comprobante_1', url: 'https://archivos.prueba.invalid/pgp123/ticket.jpg', public_id: 'expense-proofs/pgp123-prueba', kind: 'image' }];
/** El payload de la pantalla al «Dar por comprobado» (Aprobación de gastos). */
const PANTALLA = { clasificacion: 'fiscal' };

let ok = 0;
let fail = 0;
let sinMedir = 0;
const check = (cond, label, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detalle === undefined ? '' : ` → ${JSON.stringify(detalle)}`}`); }
};
// Un bloque que depende de los datos de ESTE destino (la base del CI no trae padrón ni canceladas reales) se declara y la
// suite SIGUE. `noMedido()` termina el proceso: a media suite dejaba sin correr todo lo que venía después (en el CI, las
// secciones I a N, medido el 2026-11-17 en el PR #550) y, como sale dentro del try, sin la limpieza del finally.
// `noMedido()` queda sólo para el arranque, cuando falta el rol o la migración y no hay nada que medir.
const bloqueNoMedido = (motivo) => { sinMedir++; console.log(`  ◻ NO MEDIDO — ${motivo}`); };
const vacio = (c) => /char|text/.test(c.type) ? '' : /timestamp|date/.test(c.type) ? '1800-01-01 00:00:00' : 0;

function urlCon(base, usuario, clave) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${base}`;
  if (usuario) { u.username = usuario; u.password = clave; }
  return u.toString();
}

async function main() {
  console.log('[PGP.123] G.8 la comprobación del gasto de punta a punta: validar → Kepler (X-A-10 con su póliza) → ODS (servicios reales, como app_runtime)');
  if (!(await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROL_API])).rows.length) noMedido(`no existe el rol ${ROL_API} en esta base`);
  if (!(await knex.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_expense_status'))) {
    noMedido('falta la migración de [PGP.123] (20261115124001) en esta base');
  }
  const hoy = todayMx();
  const MES = `kdc2${hoy.slice(2, 4)}${hoy.slice(5, 7)}`;

  // ── El Kepler de prueba de la 05 ─────────────────────────────────────────────────────────────────────────────────
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${BASE} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${ROL}`);
  await admin.query(`CREATE DATABASE ${BASE}`);
  await admin.query(`CREATE ROLE ${ROL} LOGIN PASSWORD '${CLAVE}'`);
  const k = new Client({ connectionString: urlCon(BASE) });
  await k.connect();
  const insertar = async (tabla, estructura, valores, solo) => {
    const cols = columnas(estructura, solo);
    const fila = Object.fromEntries(cols.map((c) => [c.name, valores[c.name] ?? vacio(c)]));
    await k.query(`INSERT INTO md.${tabla} (${cols.map((c) => c.name).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => fila[c.name]));
  };
  const MM = ['c1', 'c2', 'c3', 'c4', 'c18', 'c20', 'c21', 'c22'];
  await k.query('CREATE SCHEMA md');
  await k.query(`CREATE TABLE md.kdm1 (${ddl('kdm1')}, CONSTRAINT pk_kdm1 PRIMARY KEY (c1, c2, c3, c4, c5, c6))`);
  await k.query(`CREATE TABLE md.kdm6 (${ddl('kdm6')}, CONSTRAINT pk_kdm6 PRIMARY KEY (c1, c2, c3, c4, c5, c6, c7))`);
  await k.query(`CREATE TABLE md.sqliov (${ddl('sqliov')}, PRIMARY KEY (c1, c2, c3))`);
  await k.query(`CREATE TABLE md.kdxe (${ddl('kdxe')})`);
  await k.query(`CREATE TABLE md.${MES} (${ddl('kdc22611')})`);
  await k.query(`CREATE TABLE md.kdc126 (${ddl('kdc126')})`);
  await k.query(`CREATE TABLE md.kdcn26 (${ddl('kdcn26')})`);
  await k.query(`CREATE TABLE md.kdxg (${ddl('kdxg')})`);
  await k.query(`CREATE TABLE md.kdmm (${ddl('kdmm', MM)})`);
  await k.query(`CREATE TABLE md.kdc3 (${ddl('kdc3', ['c1', 'c2', 'c3', 'c4', 'c5'])})`);
  await insertar('kdmm', 'kdmm', { c1: 'X', c2: 'A', c3: 10, c4: 1, c18: 'D', c20: '201', c21: '122-001', c22: '122-003' }, MM);
  await k.query(`INSERT INTO md.kdc3 VALUES ('9-99-99-99', 'DEPTO', '', '', ''), ('9-99', 'DEPTO', '', '', '')`);
  await k.query(`INSERT INTO md.sqliov VALUES ('KFXA1001.05', 0, 0, '51')`);
  for (const cuenta of ['201', '122-001', '122', '602-008', '602']) await insertar('kdc126', 'kdc126', { c1: cuenta, c2: `CUENTA ${cuenta}` });
  await insertar('kdxg', 'kdxg', { c1: 'PESOS', c2: SUC, c3: ACR, c4: `${hoy.slice(0, 8)}01`, c6: `${hoy.slice(0, 8)}01`, c7: `${hoy.slice(0, 8)}01` });
  for (const n of [1, 2, 3]) await insertar(MES, 'kdc22611', { c1: n, c2: `${hoy.slice(0, 8)}01`, c3: '601-001', c4: 'C', c5: 1, c8: 'D', c9: 1, c10: 1, c14: SUC, c15: 'X', c16: 'D', c17: 26, c18: 1, c19: '0000900', c31: '1800-01-01' });
  /** La X-A-15 viva en el Kepler de la sucursal: 100 + IVA 16, un renglón con su cuenta y sus segmentos. */
  const solicitudEnKepler = async (folio) => {
    await insertar('kdm1', 'kdm1', {
      c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: folio, c7: 'PESOS', c9: hoy, c10: ACR, c11: 'F-1', c14: 16, c15: 0, c16: 116, c42: 116, c17: '0', c18: hoy,
      c24: 'GASTO DE PRUEBA PGP123', c31: 'Sol', c32: 'ACREEDOR DE PRUEBA PGP123 SA DE CV', c40: 1, c41: '1800-01-01', c43: 'A', c63: 'XA1501-', c67: '01ANA', c68: hoy, c69: '10:00', c90: '',
    });
    await insertar('kdm6', 'kdm6', { c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: folio, c7: 1, c8: '602-008', c9: 'MANTENIMIENTO', c10: 'C', c11: 100, c12: 'Z40', c13: '9-99-26-99', c16: '9-99-99-99' });
  };
  const grants = fs.readFileSync(path.join(RAIZ, 'ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql'), 'utf8').replace(/kepler_push\b/g, ROL);
  await k.query(`GRANT USAGE ON SCHEMA md TO ${ROL}`);
  await k.query(grants);
  await k.query(`GRANT SELECT, INSERT ON md.${MES} TO ${ROL}`);

  const ENV = ['KEPLER_GASTO_COMPROBACION', `KEPLER_PUSH_URL_${SUC}`];
  const env0 = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));
  process.env.KEPLER_GASTO_COMPROBACION = 'encendida';
  process.env[`KEPLER_PUSH_URL_${SUC}`] = urlCon(BASE, ROL, CLAVE);

  const ids = [];
  const sink = new KeplerGastoSinkAdapter();
  /** El servicio real; su cron sólo toma los vales que sembró esta prueba (la base local trae vales reales copiados). */
  class ComprobacionDePrueba extends ComprobacionGastoService {
    filtrarCandidatos(qb) { qb.whereIn('p.id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']); }
  }
  const comp = new ComprobacionDePrueba(tk, knex, sink);
  const proofs = new ExpenseProofsService(tk, ctx, {}, almacen, lector, undefined, undefined, undefined, undefined, comp);

  const sembradas = { kdm1: [], kdxd: [] };
  const sembrar = async (tabla, filas) => {
    for (const f of filas) {
      const cols = Object.keys(f);
      const r = await knex.raw(`INSERT INTO kepler_ods.${tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING ctid::text AS ctid`, cols.map((c) => f[c]));
      sembradas[tabla].push(r.rows[0].ctid);
    }
  };
  /** La X-A-15 tal como la replica el ODS. */
  const solicitudEnOds = (folio, extra = {}) => sembrar('kdm1', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: folio, c9: hoy, c10: ACR, c15: 0, c16: 116, c42: 116, c43: 'A', ...extra }]);
  /** Un vale firmado (aprobado) por otra persona, con su comprobante, ligado a su solicitud: como lo deja la pantalla. */
  const valeAprobado = async (folio, extra = {}) => {
    const [v] = await knex('finance.expense_proofs').insert({
      tenant_id: T, solicitante: 'prueba pgp123', proveedor: 'prueba pgp123', sucursal: SUC, folio_solicitud: folio, importe: 116,
      status: 'aprobada', files: JSON.stringify(ARCHIVOS), clasificacion: 'fiscal', forma_pago: 'transferencia', created_by: 'captura_prueba', ...extra,
    }).returning('id');
    ids.push(v.id ?? v);
    return v.id ?? v;
  };
  const vale = (id) => knex('finance.expense_proofs').where({ id }).first('status', 'kepler_expense_status', 'kepler_expense_folio', 'kepler_expense_policy',
    'kepler_expense_note', 'kepler_expense_attempts', knex.raw(`to_char(kepler_expense_date, 'YYYY-MM-DD') AS fecha`));
  const intentos = (id) => knex('finance.expense_request_kepler_attempts').where({ proof_id: id }).orderBy('created_at').select('document_type', 'trigger', 'result', 'folio', 'mark', 'note');
  const gastoEnKepler = async (folio) => (await k.query(`SELECT btrim(c6) c6, btrim(c43) c43 FROM md.kdm1 WHERE c4 = 10 AND btrim(c39) = $1`, [folio])).rows;
  const solicitudKepler = async (folio) => (await k.query(`SELECT btrim(c43) c43, c42::text c42 FROM md.kdm1 WHERE c4 = 15 AND c6 = $1`, [folio])).rows[0];
  const sw0 = await knex('commercial.kepler_push_switch').where({ tenant_id: T, sucursal: SUC, tipo: TIPO }).first();
  const latido0 = await knex('analytics.cron_runs').where({ tenant_id: T, job_key: JOB }).first().catch(() => undefined);
  const interruptor = (encendida, tope_dia = 100) => knex('commercial.kepler_push_switch')
    .where({ tenant_id: T, sucursal: SUC, tipo: TIPO }).update({ encendida, tope_dia, updated_at: knex.fn.now() });

  try {
    check(!!sw0, 'la migración sembró el interruptor comprobacion_gasto de la 05');
    if (!sw0) return;
    // Lo que haya dejado una corrida abortada, por los folios EXCLUSIVOS de la prueba (no existen en ningún Kepler).
    const FOLIOS = ['0990120', '0990121', '0990122', '0990123', '0990124', '0990125', '0990126', '0990127', '0990128',
      '0990140', '0990141', '0990142', '0990143', '0990144', '0990145', '0990146', '0990147', '0990150', '0990151', '0990152', '0990153'];
    await knex.raw(`DELETE FROM kepler_ods.kdm1 WHERE sucursal = ? AND c2 = 'X' AND c3 = 'A' AND ((c4 = 15 AND c6 = ANY(?)) OR (c4 = 10 AND c39 = ANY(?)))`, [SUC, FOLIOS, FOLIOS]);
    const viejos = await knex('finance.expense_proofs').where({ tenant_id: T, sucursal: SUC, solicitante: 'prueba pgp123' }).whereIn('folio_solicitud', FOLIOS).pluck('id');
    if (viejos.length) {
      await knex('finance.expense_request_kepler_attempts').whereIn('proof_id', viejos).del();
      await knex('finance.expense_proofs').whereIn('id', viejos).del();
    }
    await knex.raw(`DELETE FROM kepler_ods.kdxd WHERE sucursal = ? AND btrim(c2) = ?`, [SUC, ACR]);
    await sembrar('kdxd', [{ sucursal: SUC, c1: SUC, c2: ACR, c3: 'ACREEDOR DE PRUEBA PGP123 SA DE CV', c10: 'XAXX010101000' }]);

    // ── A ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— A. Validar con el payload de la pantalla escribe el gasto en Kepler');
    await interruptor(true);
    await solicitudEnKepler('0990120');
    await solicitudEnOds('0990120');
    const a = await valeAprobado('0990120');
    const ra = await proofs.validate(a, QUIEN.full_name, PANTALLA, QUIEN);
    check(ra.status === 'validada' && ra.gasto_kepler?.status === 'written' && ra.gasto_kepler?.folio === '0000051' && ra.gasto_kepler?.poliza === `${MES}/D/4`,
      `validar → validada, y el gasto escrito: X-A-10 0000051, póliza ${MES}/D/4`, ra);
    const va = await vale(a);
    check(va.kepler_expense_status === 'written' && va.kepler_expense_folio === '0000051' && va.kepler_expense_policy === `${MES}/D/4` && va.fecha === hoy && va.kepler_expense_attempts === 1,
      'el vale guarda el estado, el folio, la póliza, la fecha (DG1) y un intento', va);
    const ia = await intentos(a);
    check(ia.length === 1 && Number(ia[0].document_type) === 10 && ia[0].trigger === 'validacion' && ia[0].result === 'escrito' && ia[0].folio === '0000051' && ia[0].mark === 'X-A-15/0990120',
      'la bitácora: un intento del gasto (tipo 10), disparado por la validación, con la solicitud que comprueba', ia);
    check((await gastoEnKepler('0990120')).length === 1 && (await solicitudKepler('0990120')).c43 === 'F', 'en Kepler: el X-A-10 existe y su solicitud quedó aplicada (F)');

    // ── B ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— B. El lazo con el ODS, y su latido');
    // ⛔ Otro documento con el MISMO folio, de otra solicitud (0990126): no es este gasto y no lo da por visto.
    await sembrar('kdm1', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 10, c5: 1, c6: '0000051', c9: hoy, c10: ACR, c16: 116, c42: 116, c36: 'A', c37: 15, c38: 1, c39: '0990126', c43: 'N' }]);
    let m = await comp.ciclo();
    check((await vale(a)).kepler_expense_status === 'written', 'mientras el ODS no lo trae, sigue escrito (no se finge visto)', m);
    const gastoOds = { sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 10, c5: 1, c6: '0000051', c9: hoy, c10: ACR, c16: 116, c42: 116, c36: 'A', c37: 15, c38: 1, c39: '0990120', c43: 'N' };
    await sembrar('kdm1', [gastoOds]);
    m = await comp.ciclo();
    check((await vale(a)).kepler_expense_status === 'seen_in_ods' && m.vistos_en_ods >= 1, 'el ODS lo trae → seen_in_ods', m);
    // La cancelación llega como otra versión de la fila: se borra la sembrada y se siembra la cancelada (un UPDATE le
    // cambiaría el ctid y la limpieza, que borra por ctid, la dejaría viva).
    await knex.raw('DELETE FROM kepler_ods.kdm1 WHERE ctid = ?::tid', [sembradas.kdm1.pop()]);
    await sembrar('kdm1', [{ ...gastoOds, c43: 'C' }]);
    m = await comp.ciclo();
    const vb = await vale(a);
    check(vb.kepler_expense_status === 'cancelled' && /canceló el gasto X-A-10 0000051/.test(vb.kepler_expense_note) && m.cancelados >= 1, 'Kepler lo cancela → cancelled, y lo dice', vb);
    check(vb.kepler_expense_folio === null && vb.kepler_expense_policy === null && /póliza/.test(vb.kepler_expense_note),
      'cancelado SUELTA el folio y la póliza (quedan en la nota): «Reintentar» lo puede volver a reclamar', vb);
    const lat = await knex('analytics.cron_runs').where({ tenant_id: T, job_key: JOB }).first();
    check(!!lat, 'el cron deja su latido (gastos_comprobacion_kepler)');
    m = await comp.ciclo();
    check((await vale(a)).kepler_expense_status === 'cancelled' && (await gastoEnKepler('0990120')).length === 1, '⛔ cancelado no se reescribe solo');

    // ── C ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— C. Con el interruptor apagado no se escribe, y se dice');
    await interruptor(false);
    await solicitudEnKepler('0990121');
    await solicitudEnOds('0990121');
    const c = await valeAprobado('0990121');
    const rc = await proofs.validate(c, QUIEN.full_name, PANTALLA, QUIEN);
    check(rc.status === 'validada' && rc.gasto_kepler?.status === 'pending' && /interruptor de la escritura de gastos de la sucursal 05 está apagado/.test(rc.gasto_kepler?.nota), 'validado; el gasto espera y dice por qué', rc.gasto_kepler);
    const ic = await intentos(c);
    check(ic.length === 1 && ic[0].result === 'apagado' && ic[0].trigger === 'validacion' && (await gastoEnKepler('0990121')).length === 0, 'la bitácora dice «apagado» y Kepler no se tocó', ic);

    // ── D ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— D. Un vale que no se puede comprobar solo: dice por qué y no escribe');
    await interruptor(true);
    await solicitudEnKepler('0990122');
    await solicitudEnOds('0990122');
    const d = await valeAprobado('0990122', { importe: 100 });
    const rd = await proofs.validate(d, QUIEN.full_name, PANTALLA, QUIEN);
    check(rd.gasto_kepler?.status === 'pending' && /El vale es por \$100\.00 y la solicitud por \$116\.00/.test(rd.gasto_kepler?.nota) && (await gastoEnKepler('0990122')).length === 0,
      'otro importe → pendiente con el motivo, sin escribir', rd.gasto_kepler);

    console.log('\n— D2. ⛔ El vale trae factura y la Suite no la encuentra: no se escribe a ciegas');
    await solicitudEnKepler('0990128');
    await solicitudEnOds('0990128');
    const d2 = await valeAprobado('0990128', { cfdi_uuid: '0c0c0c0c-1111-4222-8333-944444444444' });
    const rd2 = await proofs.validate(d2, QUIEN.full_name, PANTALLA, QUIEN);
    check(rd2.gasto_kepler?.status === 'pending' && /trae factura y la Suite no la pudo leer/.test(rd2.gasto_kepler?.nota ?? '') && (await gastoEnKepler('0990128')).length === 0,
      'la factura no está en fiscal.cfdis → pendiente «sin medir», sin escribir (antes contaba como «sin factura» y se escribía)', rd2.gasto_kepler);

    // ── E ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— E. ⛔ El gasto que capturó una persona se reconoce, y no se escribe otro');
    await solicitudEnKepler('0990123');
    await solicitudEnOds('0990123', { c43: 'F', c42: 0 });
    await sembrar('kdm1', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 10, c5: 1, c6: '0000777', c9: hoy, c10: ACR, c16: 116, c42: 116, c36: 'A', c37: 15, c38: 1, c39: '0990123', c43: 'N' }]);
    const e = await valeAprobado('0990123');
    const re = await proofs.validate(e, QUIEN.full_name, PANTALLA, QUIEN);
    check(re.gasto_kepler?.status === 'seen_in_ods' && re.gasto_kepler?.folio === '0000777' && (await gastoEnKepler('0990123')).length === 0,
      'queda visto con el folio de la persona (0000777) y Kepler no recibe otro', re.gasto_kepler);

    // ── F ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— F. ⛔ El proceso murió tras reclamarlo: el cron lo da por huérfano, lo busca y lo escribe UNA vez');
    await solicitudEnKepler('0990124');
    await solicitudEnOds('0990124');
    const f = await valeAprobado('0990124');
    await interruptor(false);
    await proofs.validate(f, QUIEN.full_name, PANTALLA, QUIEN);
    await knex('finance.expense_proofs').where({ id: f }).update({ kepler_expense_status: 'writing', kepler_expense_at: knex.raw(`now() - interval '20 minutes'`), kepler_expense_next_at: null });
    await interruptor(true);
    m = await comp.ciclo();
    const vf = await vale(f);
    check(m.huerfanos >= 1 && vf.kepler_expense_status === 'written' && vf.kepler_expense_folio === '0000052' && (await gastoEnKepler('0990124')).length === 1,
      'huérfano → en duda → no estaba en Kepler → escrito una vez (0000052)', { m, vf });
    const ifl = await intentos(f);
    check(ifl.some((x) => x.trigger === 'cron' && x.result === 'escrito'), 'el intento del cron queda en la bitácora', ifl);
    m = await comp.ciclo();
    check((await gastoEnKepler('0990124')).length === 1, '⛔ otra pasada del cron no escribe un segundo gasto');

    // ── G ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— G. Firmar un vale que cierra en «validada» también comprueba su gasto');
    await solicitudEnKepler('0990125');
    await solicitudEnOds('0990125');
    const g = await valeAprobado('0990125', { status: 'recibida' });
    const rg = await proofs.approve(g, QUIEN.full_name, PANTALLA, QUIEN);
    if (rg.status === 'validada') {
      check(rg.gasto_kepler?.status === 'written' && (await gastoEnKepler('0990125')).length === 1, 'la firma cerró en validada y el gasto quedó escrito', rg);
      const ig = await intentos(g);
      check(ig.some((x) => x.trigger === 'firma' && x.result === 'escrito'), 'la bitácora dice que lo disparó la firma', ig);
    } else {
      check(!rg.gasto_kepler && (await gastoEnKepler('0990125')).length === 0, `la firma dejó el vale en «${rg.status}»: no se comprueba hasta validarlo`, rg);
    }

    // ── H ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— H. G.9: la cola «Esperan a Kepler» dice el motivo, el gasto y si la base escribe; «Reintentar»');
    const t0 = Date.now();
    const cola = await proofs.esperanKepler(2000);
    const msCola = Date.now() - t0;
    const fila = (id) => cola.vales.find((x) => x.id === id);
    const fc = fila(c);
    check(fc?.espera === 'falta_generar_gasto' && fc.gasto_kepler?.comprobacion.listo === true && fc.gasto_kepler.escritura.abierta === true
      && fc.gasto_kepler.gasto?.status === 'pending' && /interruptor/.test(fc.gasto_kepler.gasto?.nota ?? ''),
      'C: se comprueba sola (G.5), la base ya escribe, y su último intento dice que estaba apagada', fc?.gasto_kepler);
    const fd = fila(d);
    check(fd?.gasto_kepler?.comprobacion.listo === false && fd.gasto_kepler.comprobacion.motivo === 'total_distinto' && fd.gasto_kepler.comprobacion.quien === 'sucursal'
      && /El vale es por \$100\.00 y la solicitud por \$116\.00/.test(fd.gasto_kepler.comprobacion.texto),
      'D: el motivo en llano (otro importe) y a quién le toca (la sucursal: la comprobación es suya)', fd?.gasto_kepler?.comprobacion);
    const ff = fila(f);
    check(ff?.gasto_kepler?.gasto?.status === 'written' && ff.gasto_kepler.gasto.folio === '0000052' && new RegExp(`^${MES}/D/\\d+$`).test(ff.gasto_kepler.gasto.poliza ?? ''),
      'F: escrito por la Suite — la cola trae su folio (0000052) y su póliza, mientras el ODS no lo muestra', ff?.gasto_kepler?.gasto);
    check(!fila(e), 'E: el gasto que capturó una persona ya no espera (no está en la cola)');
    const otras = cola.vales.filter((x) => x.espera !== 'falta_generar_gasto');
    check(otras.every((x) => x.gasto_kepler === undefined), 'sólo los autorizados sin gasto llevan comprobación (las demás esperas no la necesitan)', otras.length);
    console.log(`  · la cola con los vales de la base local: ${cola.vales.length} vales en ${msCola} ms`);
    // G.UI.8: el nombre del padrón de quien capturó y de quien revisó, contra una lectura INDEPENDIENTE del padrón (como
    // superusuario, sin RLS). No se imprime ningún nombre: sólo los conteos.
    const padron = new Map((await knex.raw(`SELECT lower(username) AS u, nullif(btrim(nombre), '') AS n FROM identity.users WHERE tenant_id = ?`, [T])).rows.map((r) => [r.u, r.n]));
    const delPadron = (u) => (u ? padron.get(String(u).toLowerCase()) ?? null : null);
    const malNombre = cola.vales.filter((x) => (x.capturo_nombre ?? null) !== delPadron(x.created_by) || (x.reviso_nombre ?? null) !== delPadron(x.validated_by)).length;
    const conNombre = cola.vales.filter((x) => x.capturo_nombre || x.reviso_nombre).length;
    // Si el padrón (la lectura independiente) no tiene nombre para nadie de la cola, las dos columnas salen null de los dos
    // lados y el ✓ no mediría nada (en el CI pasaba así, «0 con nombre»): se declara. Si lo tiene, se compara, y una cola
    // que perdiera los nombres sale en rojo.
    const esperados = cola.vales.filter((x) => delPadron(x.created_by) || delPadron(x.validated_by)).length;
    if (!esperados) bloqueNoMedido('G.UI.8: ningún vale de la cola trae un usuario con nombre en el padrón');
    else check(malNombre === 0, `G.UI.8: quien capturó y quien revisó, con el nombre del padrón en los ${cola.vales.length} vales (${conNombre} con nombre, ${esperados} esperados)`, malNombre);
    // La base cerrada (DG7): otra sucursal que no es 02/04/05/07 lo dice en llano y con su detalle.
    const conDg7 = cola.vales.find((x) => x.gasto_kepler && !['02', '04', '05', '07'].includes(String(x.sucursal)));
    if (conDg7) check(conDg7.gasto_kepler.escritura.abierta === false && /contador que falta medir/.test(conDg7.gasto_kepler.escritura.motivo ?? '') && /^DG7/.test(conDg7.gasto_kepler.escritura.detalle ?? ''),
      `DG7: en ${conDg7.sucursal} la cola dice que la Suite todavía no escribe, con el detalle para Sistemas`, conDg7.gasto_kepler.escritura);
    else bloqueNoMedido('DG7 en la cola: la base local no trae vales autorizados sin gasto fuera de 02/04/05/07');

    // «Reintentar»: con el motivo vigente, dice por qué y no escribe; sobre un vale sin validar, 409; un id roto, 400.
    const rr = await proofs.reintentarGasto(d, QUIEN.full_name);
    check(rr?.status === 'pending' && /\$100\.00/.test(rr?.nota ?? '') && (await gastoEnKepler('0990122')).length === 0, 'Reintentar un vale con otro importe: dice el motivo y no escribe', rr);
    const h = await valeAprobado('0990127');
    const estatusDe = async (fn) => { try { await fn(); return 200; } catch (x) { return typeof x.getStatus === 'function' ? x.getStatus() : (x.code || x.message); } };
    check(await estatusDe(() => proofs.reintentarGasto(h, QUIEN.full_name)) === 409, '⛔ Reintentar un vale sin validar → 409');
    check(await estatusDe(() => proofs.reintentarGasto('no-es-un-id', QUIEN.full_name)) === 400, '⛔ Reintentar con un id roto → 400');
    const ih = await intentos(h);
    check(ih.length === 0, 'el 409 no deja intento en la bitácora', ih);

    // ── I ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— I. G.UI.1b: el Expediente dice qué le falta en Kepler con la regla de la cola, y el monto de la cancelada');
    const exp = await proofs.expedientePorUsuario(2000);
    const valesExp = exp.personas.flatMap((p) => p.vales);
    const porId = new Map(valesExp.map((v) => [v.id, v]));
    // Control independiente (superusuario, sin RLS): validados sin gasto ligado cuya solicitud Kepler canceló.
    const canceladas = (await knex.raw(`
      SELECT v.id, r.aplicada, v.importe_capturado::numeric AS capturado
        FROM finance.v_expense_proofs v
        JOIN analytics.expense_requests r ON r.tenant_id = v.tenant_id AND r.sucursal = v.sucursal AND r.folio = v.folio_solicitud
       WHERE v.tenant_id = ? AND v.status = 'validada' AND btrim(coalesce(r.estado, '')) = 'C'
         AND NOT EXISTS (SELECT 1 FROM analytics.expense_documents d WHERE d.tenant_id = v.tenant_id AND d.doc_tipo = 'XA1001'
                          AND d.sucursal = v.sucursal AND d.solicitud_folio = v.folio_solicitud)`, [T])).rows
      .filter((x) => porId.has(x.id));
    const malDicho = canceladas.filter((x) => porId.get(x.id).falta_en_kepler !== (x.aplicada === true ? 'cancelada_con_gasto' : 'cancelada')).length;
    const malMonto = canceladas.filter((x) => x.capturado != null && Math.round(porId.get(x.id).importe * 100) !== Math.round(Number(x.capturado) * 100)).length;
    const conGasto = canceladas.filter((x) => x.aplicada === true).length;
    if (canceladas.length) {
      check(malDicho === 0, `⛔ las ${canceladas.length} canceladas sin gasto ligado (${conGasto} con gasto generado) se dicen canceladas, no «Falta el gasto en Kepler»`, malDicho);
      check(malMonto === 0, 'su monto es lo capturado, no el 0 que dejó Kepler', malMonto);
    } else bloqueNoMedido('G.UI.1b: la base local no trae vales validados con la solicitud cancelada');
    const faltaGasto = valesExp.filter((v) => v.falta_en_kepler === 'falta_generar_gasto').length;
    check(faltaGasto > 0, `«Falta el gasto en Kepler» queda para las autorizadas sin gasto (${faltaGasto})`, faltaGasto);
    // G.UI.1c: la cola trae TODAS las canceladas (con gasto y sin él) para «Canceladas en Kepler». Antes descartaba las
    // que no tenían gasto. Control: el mismo de arriba, pero de todos los validados (la cola no se limita a 2,000).
    const colaH = await proofs.esperanKepler(2000);
    const enCola = new Map(colaH.vales.map((v) => [v.id, v]));
    const todasC = (await knex.raw(`
      SELECT v.id, r.aplicada FROM finance.v_expense_proofs v
        JOIN analytics.expense_requests r ON r.tenant_id = v.tenant_id AND r.sucursal = v.sucursal AND r.folio = v.folio_solicitud
       WHERE v.tenant_id = ? AND v.status = 'validada' AND btrim(coalesce(r.estado, '')) = 'C'
         AND NOT EXISTS (SELECT 1 FROM analytics.expense_documents d WHERE d.tenant_id = v.tenant_id AND d.doc_tipo = 'XA1001'
                          AND d.sucursal = v.sucursal AND d.solicitud_folio = v.folio_solicitud)`, [T])).rows;
    const sinGastoC = todasC.filter((x) => x.aplicada !== true);
    const faltan = todasC.filter((x) => !enCola.has(x.id) || String(enCola.get(x.id).kepler_estado ?? '').trim() !== 'C').length;
    if (sinGastoC.length) check(faltan === 0, `⛔ la cola trae las ${todasC.length} canceladas sin gasto ligado, también las ${sinGastoC.length} que no tenían gasto (antes se descartaban)`, faltan);
    else bloqueNoMedido('G.UI.1c: la base local no trae canceladas sin gasto');

    // ── J ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— J. G.UI.1d: la pista de cada cancelada (el dinero y la recaptura), contra un control independiente');
    const canc = colaH.vales.filter((v) => String(v.kepler_estado ?? '').trim() === 'C');
    // Sin canceladas en este destino (la base del CI sólo trae lo sembrado) la primera comparación fallaba y las otras dos
    // pasaban EN VACÍO (dos conjuntos vacíos son iguales). Se declara; la pista se mide en K con canceladas sembradas.
    if (!canc.length) bloqueNoMedido('J: la base no trae canceladas: la pista contra el control independiente no se mide aquí (K la mide con las sembradas)');
    else {
      check(canc.every((v) => v.pista_cancelada !== undefined), `las ${canc.length} canceladas traen su pista (o el «no se pudo» declarado)`, canc.filter((v) => v.pista_cancelada === undefined).length);
      // Control de pagos: X-A-10 de la solicitud (cualquier estado) → transferencias X-D-26 vivas aplicadas (kdm5).
      const conPagoControl = new Set((await knex.raw(`
        SELECT v.id FROM finance.v_expense_proofs v
          JOIN kepler_ods.kdm1 g ON g.sucursal = v.sucursal AND g.c2 = 'X' AND g.c3 = 'A' AND g.c4 = 10 AND g.c5 = 1 AND btrim(g.c39) = btrim(v.folio_solicitud)
          JOIN kepler_ods.kdm5 m ON m.sucursal = g.sucursal AND btrim(m.c1) = m.sucursal AND m.c2 = 'X' AND m.c3 = 'D' AND m.c4 = 26 AND m.c5 = 1
                                AND m.c8 = 'A' AND m.c9 = 10 AND m.c10 = 1 AND btrim(m.c11) = btrim(g.c6)
          JOIN kepler_ods.kdm1 h ON h.sucursal = m.sucursal AND h.c2 = 'X' AND h.c3 = 'D' AND h.c4 = 26 AND h.c5 = 1 AND h.c6 = m.c6 AND btrim(h.c43) <> 'C'
         WHERE v.tenant_id = ? AND v.id = ANY(?::uuid[])`, [T, canc.map((v) => v.id)])).rows.map((x) => x.id));
      const conPagoPista = new Set(canc.filter((v) => (v.pista_cancelada?.pagos ?? []).some((p) => !p.cancelado)).map((v) => v.id));
      const difPagos = [...conPagoControl].filter((id) => !conPagoPista.has(id)).length + [...conPagoPista].filter((id) => !conPagoControl.has(id)).length;
      check(difPagos === 0, `los vales con un pago vivo en Kepler son los mismos que dice el control (${conPagoControl.size})`, difPagos);
      // Control de recapturas: la misma regla escrita aparte (sucursal, acreedor, total y ventana de fechas; sin vale vivo).
      const libresControl = new Map((await knex.raw(`
        SELECT v.id, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM finance.expense_proofs e WHERE e.tenant_id = v.tenant_id AND e.sucursal = v.sucursal
                                                AND btrim(e.folio_solicitud) = btrim(s.c6) AND e.status <> 'rechazada'))::int AS libres
          FROM finance.v_expense_proofs v
          JOIN analytics.expense_requests r ON r.tenant_id = v.tenant_id AND r.sucursal = v.sucursal AND r.folio = v.folio_solicitud
          JOIN kepler_ods.kdm1 s ON s.sucursal = v.sucursal AND s.c2 = 'X' AND s.c3 = 'A' AND s.c4 = 15 AND s.c5 = 1 AND btrim(s.c10) = r.cuenta_clave
                                AND btrim(s.c6) <> btrim(v.folio_solicitud) AND btrim(s.c43) IN ('A', 'F', 'N')
                                AND round(s.c16::numeric, 2) = round(v.importe_capturado::numeric, 2) AND s.c9::date BETWEEN r.fecha - 15 AND r.fecha + 45
         WHERE v.tenant_id = ? AND v.id = ANY(?::uuid[])
         GROUP BY v.id`, [T, canc.map((v) => v.id)])).rows.map((x) => [x.id, x.libres]));
      const difRecap = canc.filter((v) => (v.pista_cancelada?.recapturas ?? []).filter((r) => !r.con_vale).length !== (libresControl.get(v.id) ?? 0)).length;
      const unaLibre = canc.filter((v) => (libresControl.get(v.id) ?? 0) === 1).length;
      check(difRecap === 0, `las recapturas libres de cada cancelada coinciden con el control (${unaLibre} con una sola: se ofrece ligar)`, difRecap);
    }
    const suma = Math.round(valesExp.reduce((s, v) => s + v.importe, 0) * 100) / 100;
    check(Math.round(exp.total.monto * 100) === Math.round(suma * 100), `el total del Expediente suma lo mismo que sus vales ($${suma.toFixed(2)})`, { total: exp.total.monto, suma });

    // ── K ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— K. G.UI.1e: cerrar el caso de una cancelada (ligar a su recaptura · «Ya lo revisé»), con el payload de la pantalla');
    // Montos propios (233 y 344) para que ninguna otra solicitud sembrada pase por recaptura.
    await solicitudEnOds('0990140', { c43: 'C', c16: 0, c42: 0 });           // cancelada, con recaptura
    await solicitudEnOds('0990141', { c43: 'N', c16: 233, c42: 233 });       // su recaptura, viva y sin vale
    await solicitudEnOds('0990142', { c43: 'C', c16: 0, c42: 0 });           // cancelada, sin recaptura
    await solicitudEnOds('0990143', { c43: 'A', c16: 999, c42: 999 });      // viva y sin vale, pero NO es su recaptura (otro total)
    const c1 = await valeAprobado('0990140', { status: 'validada', importe: 233, forma_pago: 'efectivo' });
    const c2 = await valeAprobado('0990142', { status: 'validada', importe: 344 });
    const dueno = { username: 'captura_prueba', full_name: '' };
    const colaK = await proofs.esperanKepler(2000);
    const k1 = colaK.vales.find((v) => v.id === c1);
    const libresK1 = (k1?.pista_cancelada?.recapturas ?? []).filter((r) => !r.con_vale).map((r) => r.folio);
    check(String(k1?.kepler_estado ?? '').trim() === 'C' && libresK1.length === 1 && libresK1[0] === '0990141' && k1.cancelada_revisada === null,
      'la cancelada viaja con su pista: una sola recaptura libre (0990141) y sin revisar', { libresK1, revisada: k1?.cancelada_revisada });
    check(k1?.pista_cancelada?.forma_pago === 'efectivo', 'la pista trae la forma de pago del vale (efectivo: salió de caja)', k1?.pista_cancelada?.forma_pago);
    // Ligar: sólo a la recaptura que propone la pista, y no quien lo capturó.
    check(await estatusDe(() => proofs.ligarCancelada(c1, '0990143', QUIEN)) === 409, '⛔ ligar a un folio que no es su recaptura → 409');
    check(await estatusDe(() => proofs.ligarCancelada(c1, '990141', QUIEN)) === 400, '⛔ ligar con un folio que no es de 7 dígitos → 400');
    check(await estatusDe(() => proofs.ligarCancelada(c1, '0990141', dueno)) === 403, '⛔ quien capturó el vale no cierra el suyo → 403');
    // El vale traía el estado del gasto de su solicitud vieja (como lo deja G.8 al validar): ligar lo tiene que limpiar.
    await knex('finance.expense_proofs').where({ id: c1 }).update({ kepler_expense_status: 'seen_in_ods', kepler_expense_folio: '0000883' });
    const lig = await proofs.ligarCancelada(c1, '0990141', QUIEN);
    const g1 = await vale(c1);
    check(g1.kepler_expense_status === null && g1.kepler_expense_folio === null,
      'ligar limpia el estado del gasto de la solicitud vieja (antes se arrastraba: la cola decía que la recaptura ya tenía su gasto)', g1);
    const trasLigar = await knex('finance.expense_proofs').where({ id: c1 }).first('folio_solicitud', 'capture_meta');
    const meta1 = typeof trasLigar.capture_meta === 'string' ? JSON.parse(trasLigar.capture_meta) : trasLigar.capture_meta;
    check(lig.resultado === 'ligada' && trasLigar.folio_solicitud === '0990141' && meta1?.religado?.de === '0990140' && meta1?.religado?.por === QUIEN.full_name
      && meta1?.religado?.gasto_anterior?.folio === '0000883',
      'ligada: el vale apunta a 0990141 y capture_meta.religado dice de dónde, quién y cuándo', { lig, meta: meta1?.religado });
    // Revisar: la nota se exige, el dueño no cierra lo suyo, y una vez.
    check(await estatusDe(() => proofs.revisarCancelada(c2, '', QUIEN)) === 400, '⛔ «Ya lo revisé» sin nota → 400');
    check(await estatusDe(() => proofs.revisarCancelada(c2, 'ok', QUIEN)) === 400, '⛔ una nota de 2 letras → 400');
    check(await estatusDe(() => proofs.revisarCancelada(c2, 'Se capturó otra vez a mano', dueno)) === 403, '⛔ quien capturó el vale no lo revisa → 403');
    const rev = await proofs.revisarCancelada(c2, 'Se capturó otra vez a mano en Kepler', QUIEN);
    const trasRevisar = await knex('finance.expense_proofs').where({ id: c2 }).first('kepler_cancel_reviewed_at', 'kepler_cancel_reviewed_by', 'kepler_cancel_note');
    check(rev.resultado === 'revisada' && !!trasRevisar.kepler_cancel_reviewed_at && trasRevisar.kepler_cancel_reviewed_by === QUIEN.full_name
      && trasRevisar.kepler_cancel_note === 'Se capturó otra vez a mano en Kepler', 'revisada: quién, cuándo y la nota quedan en el vale', trasRevisar);
    check(await estatusDe(() => proofs.revisarCancelada(c2, 'Otra vez', QUIEN)) === 409, '⛔ revisar dos veces → 409');
    check(await estatusDe(() => proofs.revisarCancelada(h, 'No es cancelada', QUIEN)) === 409, '⛔ un vale sin la solicitud cancelada (ni validado) no tiene caso que cerrar → 409');
    const colaK2 = await proofs.esperanKepler(2000);
    const k1b = colaK2.vales.find((v) => v.id === c1), k2b = colaK2.vales.find((v) => v.id === c2);
    check(!(k1b && String(k1b.kepler_estado ?? '').trim() === 'C') && k2b?.cancelada_revisada?.nota === 'Se capturó otra vez a mano en Kepler',
      'después: la ligada ya no es cancelada (sigue su camino con su solicitud nueva) y la revisada dice quién y qué', { k1: k1b?.espera, k2: k2b?.cancelada_revisada });
    // K2: un caso ya cerrado no se liga, aunque tenga una recaptura libre.
    await solicitudEnOds('0990144', { c43: 'C', c16: 0, c42: 0 });
    await solicitudEnOds('0990145', { c43: 'N', c16: 455, c42: 455 });
    const c3 = await valeAprobado('0990144', { status: 'validada', importe: 455 });
    await proofs.revisarCancelada(c3, 'Revisado antes de ligar', QUIEN);
    check(await estatusDe(() => proofs.ligarCancelada(c3, '0990145', QUIEN)) === 409, '⛔ ligar un caso ya revisado → 409 (antes lo ligaba)');
    // K3: con su gasto VIVO, ligar duplicaría el gasto: la pista lo dice y el servidor lo rechaza.
    await solicitudEnOds('0990146', { c43: 'C', c16: 0, c42: 0 });
    await solicitudEnOds('0990147', { c43: 'N', c16: 566, c42: 566 });
    await sembrar('kdm1', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 10, c5: 1, c6: '0000882', c9: hoy, c10: ACR, c16: 566, c42: 566, c36: 'A', c37: 15, c38: 1, c39: '0990146', c43: 'N' }]);
    const c4 = await valeAprobado('0990146', { status: 'validada', importe: 566 });
    const k4 = (await proofs.esperanKepler(2000)).vales.find((v) => v.id === c4);
    check(k4?.pista_cancelada?.gasto_vivo === '0000882' && (k4?.pista_cancelada?.recapturas ?? []).filter((r) => !r.con_vale).length === 1,
      'la pista trae su gasto vivo (X-A-10 0000882) y una recaptura libre', k4?.pista_cancelada);
    check(await estatusDe(() => proofs.ligarCancelada(c4, '0990147', QUIEN)) === 409, '⛔ ligar con el gasto vivo → 409 (antes lo ligaba y el gasto quedaba dos veces)');

    // ── L ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— L. Lo que Kepler canceló vuelve a la cola, y «Reintentar el gasto» lo escribe de nuevo');
    await interruptor(true);
    // En el Kepler de prueba, la cancelación de verdad: su X-A-10 en C y la solicitud de vuelta en A con su saldo (§3.9).
    await k.query(`UPDATE md.kdm1 SET c43 = 'C' WHERE c1 = $1 AND c4 = 10 AND btrim(c39) = '0990120'`, [SUC]);
    await k.query(`UPDATE md.kdm1 SET c43 = 'A', c42 = c16 WHERE c1 = $1 AND c4 = 15 AND c6 = '0990120'`, [SUC]);
    const la = (await proofs.esperanKepler(2000)).vales.find((x) => x.id === a);
    check(la?.espera === 'falta_generar_gasto' && la?.gasto_kepler?.gasto?.status === 'cancelled' && !la?.gasto_kepler?.gasto?.folio,
      'la cola lo trae: «falta el gasto», con el suyo cancelado (antes salía de la cola como si lo tuviera)', la && { espera: la.espera, gasto: la.gasto_kepler?.gasto });
    const rl = await proofs.reintentarGasto(a, QUIEN.full_name);
    const vivosL = (await gastoEnKepler('0990120')).filter((x) => x.c43 !== 'C');
    check(rl?.status === 'written' && !!rl?.folio && rl.folio !== '0000051' && vivosL.length === 1 && vivosL[0].c6 === rl.folio,
      '«Reintentar el gasto» lo escribe otra vez: un X-A-10 vivo nuevo; el cancelado se queda como estaba (antes no hacía nada)', { rl, vivosL });

    // ── M ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— M. «En duda» se resuelve aunque su solicitud ya no esté en A, y no se queda para siempre');
    const enDuda = (id) => knex('finance.expense_proofs').where({ id }).update({ kepler_expense_status: 'in_doubt', kepler_expense_note: 'prueba: en duda', kepler_expense_next_at: null });
    const gastoVivoOds = (folio, solicitud) => ({ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 10, c5: 1, c6: folio, c9: hoy, c10: ACR, c16: 116, c42: 116, c36: 'A', c37: 15, c38: 1, c39: solicitud, c43: 'N' });
    // M1: el COMMIT sí llegó — el ODS ya trae la solicitud en F y su gasto vivo.
    await solicitudEnOds('0990150', { c43: 'F', c42: 0 });
    await sembrar('kdm1', [gastoVivoOds('0000880', '0990150')]);
    const m1 = await valeAprobado('0990150', { status: 'validada' });
    await enDuda(m1);
    m = await comp.ciclo();
    const vm1 = await vale(m1);
    check(vm1.kepler_expense_status === 'seen_in_ods' && vm1.kepler_expense_folio === '0000880',
      'en duda y el ODS ya ve su gasto → visto con ese folio (antes: en duda para siempre, su solicitud ya no estaba en A)', { vm1, m });
    // M2: no llegó, y la regla ya no lo deja escribir (otro importe): deja la duda y espera con su motivo.
    await solicitudEnKepler('0990151');
    await solicitudEnOds('0990151');
    const m2 = await valeAprobado('0990151', { status: 'validada', importe: 100 });
    await enDuda(m2);
    m = await comp.ciclo();
    const vm2 = await vale(m2);
    check(vm2.kepler_expense_status === 'pending' && /El vale es por \$100\.00/.test(vm2.kepler_expense_note ?? '') && (await gastoEnKepler('0990151')).length === 0,
      'en duda, no estaba en Kepler y la regla dice que no → pendiente con su motivo (antes se volvía a tomar cada 5 min)', vm2);
    // M3: con la base CERRADA también: el ODS basta, no hace falta hablar con Kepler.
    await interruptor(false);
    await solicitudEnOds('0990152', { c43: 'F', c42: 0 });
    await sembrar('kdm1', [gastoVivoOds('0000881', '0990152')]);
    const m3 = await valeAprobado('0990152', { status: 'validada' });
    await enDuda(m3);
    m = await comp.ciclo();
    const vm3 = await vale(m3);
    check(vm3.kepler_expense_status === 'seen_in_ods' && vm3.kepler_expense_folio === '0000881' && m.dudas_resueltas >= 1,
      'con la base cerrada, el ODS resuelve la duda igual', { vm3, m });
    // M4: en duda y su solicitud ya está CANCELADA (fuera de A): el ciclo la toma igual, la busca y la deja esperando con su motivo.
    await interruptor(true);
    await solicitudEnOds('0990153', { c43: 'C', c16: 0, c42: 0 });
    const m4 = await valeAprobado('0990153', { status: 'validada' });
    await enDuda(m4);
    m = await comp.ciclo();
    const vm4 = await vale(m4);
    check(vm4.kepler_expense_status === 'pending' && /cancelada en Kepler/.test(vm4.kepler_expense_note ?? ''),
      'en duda con la solicitud cancelada → la busca, no estaba, y queda pendiente con su motivo (antes el ciclo ni la tomaba)', vm4);
    await interruptor(true);

    // ── N ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— N. No se rechaza un vale cuyo gasto la Suite escribe o ya escribió');
    const vfN = await vale(f);
    check(vfN.kepler_expense_status === 'written' && !!vfN.kepler_expense_policy, 'el vale de F tiene su gasto escrito por la Suite, con póliza', vfN);
    check(await estatusDe(() => proofs.reject(f, QUIEN.full_name, 'prueba', QUIEN)) === 409, '⛔ rechazarlo → 409: se cancela en Kepler primero (antes quedaba un gasto vivo de un vale rechazado)');
    await knex('finance.expense_proofs').where({ id: m2 }).update({ kepler_expense_status: 'writing' });
    check(await estatusDe(() => proofs.reject(m2, QUIEN.full_name, 'prueba', QUIEN)) === 409, '⛔ rechazarlo mientras se escribe su gasto → 409');
    await knex('finance.expense_proofs').where({ id: m2 }).update({ kepler_expense_status: 'pending' });
    const rj = await proofs.reject(m2, QUIEN.full_name, 'prueba: su gasto nunca se escribió', QUIEN);
    check(rj.status === 'rechazada', 'sin gasto escrito por la Suite, el rechazo de siempre pasa', rj);
  } finally {
    // ── Limpieza: exactamente lo que se creó ──────────────────────────────────────────────────────────────────────────
    const err = (q) => q.catch((x) => console.log(`  ! limpieza: ${x.message}`));
    for (const n of ENV) { if (env0[n] === undefined) delete process.env[n]; else process.env[n] = env0[n]; }
    await sink.onModuleDestroy().catch(() => undefined);
    if (ids.length) {
      await err(knex('finance.expense_request_kepler_attempts').whereIn('proof_id', ids).del());
      await err(knex('finance.expense_proofs').whereIn('id', ids).del());
    }
    for (const [tabla, ctids] of Object.entries(sembradas)) {
      if (ctids.length) await err(knex.raw(`DELETE FROM kepler_ods.${tabla} WHERE ctid = ANY(?::tid[])`, [ctids]));
    }
    if (sw0) await err(knex('commercial.kepler_push_switch').where({ tenant_id: T, sucursal: SUC, tipo: TIPO }).update({ encendida: sw0.encendida, tope_dia: sw0.tope_dia }));
    if (!latido0) await err(knex('analytics.cron_runs').where({ tenant_id: T, job_key: JOB }).del());
    const quedan = ids.length ? Number((await knex('finance.expense_proofs').whereIn('id', ids).count({ n: '*' }))[0].n) : 0;
    check(quedan === 0, 'limpieza: los vales, la bitácora, el ODS sembrado y el interruptor quedaron como estaban', quedan);
    await k.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${BASE} WITH (FORCE)`).catch((x) => console.log(`  ! no se pudo borrar ${BASE}: ${x.message}`));
    await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch((x) => console.log(`  ! no se pudo borrar ${ROL}: ${x.message}`));
    await admin.end().catch(() => undefined);
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${fail} ✗${sinMedir ? ` · ${sinMedir} bloque(s) NO MEDIDO(S) en este destino (arriba, con su motivo)` : ''}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
