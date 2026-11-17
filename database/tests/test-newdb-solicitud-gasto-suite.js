/* eslint-disable no-console */
/**
 * `[PGP.122]` La solicitud de gasto de PUNTA A PUNTA, con los servicios REALES contra un Postgres real:
 * la pantalla pide → otra persona firma → la Suite la escribe en Kepler → el cron cierra el lazo con el ODS.
 *
 * Lo que la prueba del escritor (`test-newdb-kepler-solicitud-gasto.js`) no ve, porque ahí el escritor se
 * llama solo: el PAYLOAD DE LA PANTALLA (`finanzas-pedir-gasto.component.ts`, `enviar()`), la validación
 * contra el catálogo del ODS, la firma REAL (`ExpenseProofsService.approve`, con la guarda de «tu propio
 * vale»), el reclamo atómico, la bitácora, el interruptor por sucursal, la espera entre reintentos, el
 * huérfano que quedó en `writing`, dos reintentos a la vez, el tope diario y el lazo `written → seen_in_ods`.
 *
 * Carga los `.ts` REALES vía ts-node: `SolicitudGastoService`, `ExpenseProofsService`, el escritor y los
 * contratos completos. De `platform-core` sólo se dobla la infraestructura de Nest (tenant, almacén de
 * archivos, lector, guardias); lo que decide (servidor de Kepler, folio, texto, fechas, buscador, latido)
 * es el real. Cada transacción corre como `app_runtime` con `app.tenant_id` puesto: RLS y GRANT como la API.
 * Kepler es una base desechable con los tipos de Kepler (`_lib/kepler-de-prueba.js`).
 *
 * NO MEDIDO (se declara): la llave primaria real de `kdm6`; un COMMIT de Kepler cuya RESPUESTA se pierde (aquí
 * se reproduce el caso vecino: el proceso muere después del commit y el vale queda huérfano en `writing`); el
 * lector de comprobantes (sin llave, la firma no pide aviso); la conexión real a `md` (eso es el ensayo,
 * `ops/prod/ensayo-solicitud-gasto/`, y sólo corre desde md).
 *
 * ⛔ Siembra el ODS de la sucursal 05, crea vales, una base y un rol: sólo contra un destino seguro
 * (`assertSafeTarget`), y borra al final exactamente lo que creó (las filas del ODS, por su `ctid`).
 *
 *   DATABASE_URL_NEW=postgresql://…local… node database/tests/test-newdb-solicitud-gasto-suite.js
 */
'use strict';

require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const RAIZ = path.resolve(__dirname, '..', '..');
const { assertSafeTarget } = require('./_lib/assert-safe-target');
const ADMIN_URL = process.env.DATABASE_URL_NEW;
assertSafeTarget('test-newdb-solicitud-gasto-suite', { url: ADMIN_URL });
const { noMedido } = require('./_lib/no-medido');
const { crearKeplerDePrueba } = require('./_lib/kepler-de-prueba');

// ── Los módulos REALES; de platform-core, doble sólo la infraestructura de Nest ─────────────────────
const PC = (r) => path.join(RAIZ, 'libs', 'platform-core', 'src', 'lib', r);
const CONTRATOS = path.join(RAIZ, 'libs', 'contracts', 'src');
const STUB = path.join(os.tmpdir(), `.stub-pgp122-suite-${process.pid}.js`);
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
const { SolicitudGastoService } = require(path.join(EP, 'solicitud-kepler', 'solicitud-gasto.service.ts'));
const { KeplerSolicitudGastoSinkAdapter } = require(path.join(EP, 'solicitud-kepler', 'kepler-solicitud-gasto-sink.adapter.ts'));
const { AutorizacionKeplerLecturaService } = require(path.join(EP, 'autorizacion-kepler', 'autorizacion-kepler-lectura.service.ts'));
const { todayMx } = require(PC('date/mx-date.ts'));

// ── La base: cada transacción como la API (app_runtime + tenant), la siembra como administrador ─────
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
const BASE = 'kepler_prueba_pgp122_suite';
const ROL = 'kepler_push_pgp122_suite';
const CLAVE = 'pgp122_suite_prueba';
const PLANTILLA = '0000079';
const TIPO = 'solicitud_gasto';
const JOB = 'gastos_solicitud_kepler';
// Códigos PROPIOS de la prueba, que no existen en ningún Kepler: la base local puede traer el catálogo real.
const ACR = 'GZPRU1';
const C_GASTO = 'Z40';
const C_SUA = 'Z47';
const C_CAMBIO = 'Z99';
const DEPTO = '9-99-99-99';
const PIDE = { nombre: 'Ana Prueba Solicitante', usuario: 'aprueba' };
const FIRMA = { username: 'firmante_prueba', full_name: 'Firmante De Prueba' };
/** Lo que devuelve `POST /finance/expenses/proofs/upload` y la pantalla manda tal cual. */
const ARCHIVO = { role: 'comprobante_1', url: 'https://archivos.prueba.invalid/pgp122/ticket-1198.jpg', public_id: 'expense-proofs/pgp122-prueba-ticket', kind: 'image', live: false };

let ok = 0;
let fail = 0;
const check = (cond, label, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detalle === undefined ? '' : ` → ${JSON.stringify(detalle)}`}`); }
};
const diasDesde = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

async function main() {
  console.log('[PGP.122] la solicitud de gasto de punta a punta: pedir → firmar → Kepler → ODS (servicios reales, como app_runtime)');
  if (!(await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROL_API])).rows.length) {
    noMedido(`no existe el rol ${ROL_API} en esta base: sin él no se prueba RLS ni GRANT como en la API`);
  }
  if (!(await knex.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_request_status'))) {
    noMedido('falta la migración de [PGP.122] (20261115003547) en esta base');
  }

  const hoy = todayMx();
  const ayer = diasDesde(hoy, -1);
  const PROYECTO = `9-99-${hoy.slice(2, 4)}-99`; // el armador exige el proyecto del año de la solicitud
  const kep = await crearKeplerDePrueba(ADMIN_URL, { base: BASE, rol: ROL, clave: CLAVE, sucursal: SUC, plantilla: PLANTILLA, siguiente: '990001', proyecto: PROYECTO });
  const k = kep.k;
  await k.query('TRUNCATE md.kdxd, md.kdco, md.kdcp, md.kdc3');
  await k.query(`INSERT INTO md.kdxd (c1, c2, c3, c10) VALUES ($1, $2, 'ACREEDOR DE PRUEBA PGP122 SA DE CV', 'XAXX010101000')`, [SUC, ACR]);
  // En Kepler, el concepto C_CAMBIO ya no tiene cuenta (el ODS todavía cree que sí: ver la siembra del ODS).
  await k.query(`INSERT INTO md.kdco (c1, c2, c3) VALUES ($1, 'MANTENIMIENTO VEHICULAR.', '602-008'), ($2, 'SUA', '601-015'), ($3, 'CONCEPTO QUE CAMBIO EN KEPLER', '')`, [C_GASTO, C_SUA, C_CAMBIO]);
  await k.query(`INSERT INTO md.kdcp (c1, c2, c3, c4, c5) VALUES ($1, 'PRESUPUESTO DE PRUEBA', $2, '', 'A')`, [PROYECTO, SUC]);
  await k.query(`INSERT INTO md.kdc3 (c1, c2, c3, c4, c5) VALUES ($1, 'DEPTO PRUEBA', '', '', '')`, [DEPTO]);
  const ENV = ['KEPLER_GASTO_SOLICITUD', `KEPLER_PUSH_URL_${SUC}`, `KEPLER_SOLGASTO_TEMPLATE_FOLIO_${SUC}`, 'ANTHROPIC_API_KEY'];
  const env0 = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));
  process.env.KEPLER_GASTO_SOLICITUD = 'encendida';
  process.env[`KEPLER_PUSH_URL_${SUC}`] = kep.url;
  process.env[`KEPLER_SOLGASTO_TEMPLATE_FOLIO_${SUC}`] = PLANTILLA;
  delete process.env.ANTHROPIC_API_KEY;

  const sink = new KeplerSolicitudGastoSinkAdapter();
  // S.17 (DS27): el alcance de quien pide, como lo contesta ScopeService (área `finanzas`). Cada caso lo cambia.
  const alcance = {
    dim: { mode: 'all', values: [], resolvable: true },
    async current(area) { if (area !== 'finanzas') throw new Error(`el alcance se pregunta en el área finanzas, no en «${area}»`); return { dims: { warehouse: this.dim } }; },
  };
  const svc = new SolicitudGastoService(tk, ctx, knex, alcance, sink, undefined, lector, almacen);
  const proofs = new ExpenseProofsService(tk, ctx, {}, almacen, lector, undefined, undefined, undefined, svc);

  const ids = [];
  const sembradas = { kdxd: [], kdco: [], kdcp: [], kdc3: [], kdm1: [], kdm6: [] };
  const cfdisSembrados = [];
  const sembrar = async (tabla, filas) => {
    for (const f of filas) {
      const cols = Object.keys(f);
      const r = await knex.raw(`INSERT INTO kepler_ods.${tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING ctid::text AS ctid`, cols.map((c) => f[c]));
      sembradas[tabla].push(r.rows[0].ctid);
    }
  };
  const sw0 = await knex('commercial.kepler_push_switch').where({ tenant_id: T, sucursal: SUC, tipo: TIPO }).first();
  const latido0 = await knex('analytics.cron_runs').where({ tenant_id: T, job_key: JOB }).first();
  const interruptor = (encendida, tope_dia = 100) => knex('commercial.kepler_push_switch')
    .where({ tenant_id: T, sucursal: SUC, tipo: TIPO }).update({ encendida, tope_dia, updated_at: knex.fn.now() });

  const pantalla = (extra = {}) => ({
    sucursal: SUC, acreedor: ACR,
    renglones: [{ concepto: C_GASTO, proyecto: PROYECTO, departamento: DEPTO, importe: 100 }],
    iva: 16,
    comprobante: { tipo: 'ticket', folio: '1198', fecha: ayer, uuid: null },
    forma_pago: 'efectivo', forma_pago_detalle: null,
    files: [ARCHIVO], comentario: null,
    periodo_del: null, periodo_al: null, unidad: null,
    necesita_para: null, motivo_fecha: null,
    fuentes: { acreedor: 'habito', renglon_1: 'habito', folio: 'ticket', fecha: 'ticket' },
    ...extra,
  });
  const pedir = async (extra) => { const c = await svc.crear(pantalla(extra), PIDE); ids.push(c.id); return c; };
  const firmar = (id) => proofs.approve(id, FIRMA.full_name, undefined, FIRMA);
  const vale = (id) => knex('finance.expense_proofs').where({ id }).first('*',
    knex.raw(`to_char(requested_on, 'YYYY-MM-DD') AS req`), knex.raw(`to_char(document_date, 'YYYY-MM-DD') AS doc`));
  const enKepler = async (marca) => (await k.query(`SELECT btrim(c6) AS c6 FROM md.kdm1 WHERE btrim(c26) = $1`, [marca])).rows;
  const contador = async () => (await k.query(`SELECT btrim(c4) AS c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [`KFXA1501.${SUC}`])).rows[0]?.c4;
  const intentos = (id) => knex('finance.expense_request_kepler_attempts').where({ proof_id: id }).orderBy('created_at')
    .select('trigger', 'result', 'folio', 'retryable', 'note', 'plan_hash');

  try {
    check(!!sw0, 'la migración sembró el interruptor solicitud_gasto de la sucursal 05 (commercial.kepler_push_switch)');
    if (!sw0) return;
    await sembrar('kdxd', [
      { sucursal: SUC, c1: SUC, c2: ACR, c3: 'ACREEDOR DE PRUEBA PGP122 SA DE CV', c10: 'XAXX010101000' },
      { sucursal: SUC, c1: SUC, c2: 'GN001', c3: 'NOMINA DE PRUEBA PGP122', c10: '' },
      { sucursal: SUC, c1: SUC, c2: 'GB010', c3: 'COMISIONES DE PRUEBA PGP122', c10: '' },
    ]);
    await sembrar('kdco', [
      { sucursal: SUC, c1: C_GASTO, c2: 'MANTENIMIENTO VEHICULAR.', c3: '602-008' },
      { sucursal: SUC, c1: C_SUA, c2: 'SUA', c3: '601-015' },
      // El ODS cree que el 999 tiene cuenta; el Kepler de la sucursal ya no (su catálogo cambió después de la réplica).
      { sucursal: SUC, c1: C_CAMBIO, c2: 'CONCEPTO QUE CAMBIO EN KEPLER', c3: '602-099' },
    ]);
    await sembrar('kdcp', [{ sucursal: SUC, c1: PROYECTO, c2: 'PRESUPUESTO DE PRUEBA' }]);
    await sembrar('kdc3', [{ sucursal: SUC, c1: DEPTO, c2: 'DEPTO PRUEBA' }]);

    // ── A ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— A. Lo que la pantalla lee del ODS: catálogo, acreedores y si la puerta está abierta');
    await interruptor(true);
    const cat = await svc.catalogo(SUC);
    const c240 = cat.conceptos.find((c) => c.codigo === C_GASTO);
    const c047 = cat.conceptos.find((c) => c.codigo === C_SUA);
    check(c240?.cuenta === '602-008' && !c240.fuera_de_alcance, 'catálogo: el concepto de gasto trae su cuenta (602-008) y entra', c240);
    check(!!c047?.fuera_de_alcance, 'catálogo: el del SUA (601-015) viene marcado fuera de alcance', c047);
    check(cat.proyectos.some((p) => p.codigo === PROYECTO) && cat.departamentos.some((d) => d.codigo === DEPTO), 'catálogo: el proyecto y el departamento de la sucursal');
    const acr = await svc.buscarAcreedores(SUC, 'acreedor prueba');
    check(acr.length === 1 && acr[0].clave === ACR && acr[0].rfc === 'XAXX010101000', 'acreedores: «acreedor prueba» encuentra al acreedor de prueba con su RFC', acr);
    const claves = (await svc.buscarAcreedores(SUC, 'pgp122')).map((a) => a.clave);
    check(claves.includes(ACR) && !claves.includes('GN001') && !claves.includes('GB010'), 'acreedores: la nómina (GN001) y las comisiones (GB…) no se ofrecen', claves);
    // Una solicitud anterior al mismo acreedor, ya en Kepler (ODS): de ahí sale «como la última vez».
    const hace10 = diasDesde(hoy, -10);
    await sembrar('kdm1', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: '0989999', c9: hace10, c10: ACR, c16: 58, c43: 'A', c48: 'ANA', c67: '01ANA', c68: hace10, c69: '09:30' }]);
    await sembrar('kdm6', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: '0989999', c7: 1, c12: C_GASTO, c13: PROYECTO, c16: DEPTO }]);
    const pre = await svc.precarga(SUC, ACR.toLowerCase());
    check(pre.acreedor?.clave === ACR && pre.acreedor.usos === 1 && pre.conceptos[0]?.codigo === C_GASTO && pre.conceptos[0]?.cuenta === '602-008'
      && pre.ultimo?.proyecto === PROYECTO && pre.ultimo?.departamento === DEPTO && pre.forma_pago === null,
      '«como la última vez»: el concepto, proyecto y departamento de su solicitud anterior (aún sin forma de pago)', pre);
    const dupK = await svc.duplicados(SUC, ACR, 58, hace10);
    check(dupK.length === 1 && dupK[0].donde === 'kepler' && dupK[0].folio === '0989999', 'duplicados: avisa de la que Kepler ya tiene (mismo acreedor, importe y día)', dupK);
    const abierta = await svc.disponibilidad(SUC);
    check(abierta.disponible && abierta.motivos.length === 0, 'disponibilidad: bandera, URL, plantilla e interruptor → abierta', abierta);
    await interruptor(false);
    const cerrada = await svc.disponibilidad(SUC);
    check(!cerrada.disponible && cerrada.motivos.some((m) => /interruptor/.test(m)), 'disponibilidad: con el interruptor apagado → cerrada, y dice por qué', cerrada);
    check(!(await svc.abiertas()).sucursales.includes(SUC), '«abiertas» (la que decide si hay pestaña) no la ofrece apagada');
    await interruptor(true);
    check((await svc.abiertas()).sucursales.includes(SUC), '… y la ofrece encendida');

    // ── B ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— B. Pedir con el payload de la pantalla');
    const c1 = await pedir();
    check(c1.status === 'recibida' && c1.kepler_request_status === 'pending' && c1.total === 116, 'crear → por firmar, pendiente de Kepler, total $116.00 (100 + IVA 16)', c1);
    const v1 = await vale(c1.id);
    check(v1.origen === 'solicitud' && v1.folio_solicitud === null && v1.creditor_code === ACR && Number(v1.vat_amount) === 16,
      'el vale nace sin folio, origen solicitud, acreedor de prueba, IVA 16', { origen: v1.origen, folio: v1.folio_solicitud, acreedor: v1.creditor_code, iva: v1.vat_amount });
    check(v1.req === hoy && v1.doc === ayer && v1.document_type === 'ticket' && v1.document_folio === '1198',
      'las dos fechas (DS15): solicitud = hoy, documento = ayer; ticket 1198', { req: v1.req, doc: v1.doc, tipo: v1.document_type, folio: v1.document_folio });
    check(v1.kepler_request_mark === `SUITE SG-${c1.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`, 'la marca para Kepler (c26): SUITE SG- y los 8 primeros del id, en mayúsculas como todo texto de Kepler', v1.kepler_request_mark);
    const meta = typeof v1.capture_meta === 'string' ? JSON.parse(v1.capture_meta) : v1.capture_meta;
    check(meta?.solicita_usuario === 'aprueba' && v1.created_by === PIDE.nombre && v1.proveedor === 'ACREEDOR DE PRUEBA PGP122 SA DE CV',
      'quién pide (su usuario para c48, su nombre en el vale) y el proveedor del catálogo', { meta, created_by: v1.created_by, proveedor: v1.proveedor });
    const l1 = await knex('finance.expense_proof_lines').where({ proof_id: c1.id }).orderBy('line_no');
    check(l1.length === 1 && l1[0].concept_code === C_GASTO && l1[0].account === '602-008' && l1[0].concept_name === 'MANTENIMIENTO VEHICULAR.'
      && Number(l1[0].amount) === 100 && l1[0].prefill_source === 'habito', 'el renglón: concepto, cuenta y nombre del catálogo, importe y de dónde salió (hábito)', l1);
    const enVista = await tk.run((trx) => trx('finance.v_expense_proofs').where({ id: c1.id }).first('status'));
    check(enVista?.status === 'recibida', 'Aprobación la ve en finance.v_expense_proofs (como app_runtime, con RLS)', enVista);
    check(c1.duplicados.length === 0, 'al pedirla no había otra igual: crear no avisa de nada', c1.duplicados);
    const pre2 = await svc.precarga(SUC, ACR);
    check(pre2.forma_pago === 'efectivo', 'con un vale ya pedido a ese acreedor, «como la última vez» propone su forma de pago', pre2.forma_pago);
    const dupS = await svc.duplicados(SUC, ACR, 116, hoy);
    const dupSin = await svc.duplicados(SUC, ACR, 116, hoy, c1.id);
    check(dupS.some((d) => d.donde === 'suite' && d.id === c1.id) && !dupSin.some((d) => d.id === c1.id),
      'duplicados: avisa de la que se acaba de pedir en la Suite, y no se cuenta a sí misma', { dupS, dupSin });

    // ── C ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— C. Lo que no se puede pedir: 400 y nada escrito');
    const cuantas = async () => Number((await knex('finance.expense_proofs').where({ tenant_id: T, origen: 'solicitud' }).count({ n: '*' }))[0].n);
    const antes = await cuantas();
    const no = async (extra, re, label) => {
      let st = 200;
      let msg = '';
      try { const c = await svc.crear(pantalla(extra), PIDE); ids.push(c.id); } catch (e) {
        st = typeof e.getStatus === 'function' ? e.getStatus() : e.message;
        msg = String(e?.response?.message ?? e?.message ?? e);
      }
      check(st === 400 && re.test(msg), label, { st, msg });
    };
    await no({ acreedor: 'GN001' }, /nómina/i, 'la nómina (GN001) → 400: tiene su propio flujo');
    await no({ renglones: [{ concepto: C_SUA, proyecto: PROYECTO, departamento: DEPTO, importe: 100 }] }, /SUA|601-015/, 'el concepto del SUA (601-015) → 400: no es gasto de esta versión');
    await no({ renglones: [{ concepto: C_GASTO, proyecto: '8-88-88-88', departamento: DEPTO, importe: 100 }] }, /proyecto 8-88-88-88 no está en el catálogo/, 'un proyecto que la sucursal no tiene → 400');
    await no({ files: [] }, /evidencia|comprobante|foto|archivo/i, 'sin archivo y sin factura del SAT → 400: falta la evidencia');
    await no({ acreedor: 'GZ404' }, /no tiene al acreedor GZ404/, 'un acreedor que la sucursal no tiene en Kepler → 400');
    check(await cuantas() === antes, 'ninguno de los rechazados dejó vale', { antes, despues: await cuantas() });

    // ── D ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— D. Firmar: la firma de la Suite ESCRIBE la solicitud en Kepler, ya autorizada (DS2)');
    let st = 200;
    try { await proofs.approve(c1.id, PIDE.nombre, undefined, { username: PIDE.usuario, full_name: PIDE.nombre }); } catch (e) { st = typeof e.getStatus === 'function' ? e.getStatus() : e.message; }
    check(st === 403, 'quien la pidió no se la firma (403)', st);
    check((await vale(c1.id)).status === 'recibida' && (await enKepler(v1.kepler_request_mark)).length === 0, '… y nada cambió: sigue por firmar y Kepler no la tiene');
    const r1 = await firmar(c1.id);
    const folio1 = r1?.solicitud_kepler?.folio;
    check(r1.status === 'validada' && r1.solicitud_kepler?.status === 'written' && folio1 === '0990001',
      'otra persona firma → validada y escrita en Kepler con el folio del contador (0990001)', r1);
    const filas1 = (await k.query(`SELECT btrim(c6) c6, btrim(c43) c43, to_char(c9, 'YYYY-MM-DD') c9, c16::float8 c16, c14::float8 c14, c42::float8 c42,
        btrim(c10) c10, btrim(c48) c48, btrim(c67) c67, btrim(c25) c25, btrim(c11) c11, btrim(c30) c30
      FROM md.kdm1 WHERE btrim(c26) = $1`, [v1.kepler_request_mark])).rows;
    check(filas1.length === 1, 'Kepler: UNA fila con la marca del vale', filas1.length);
    const f1 = filas1[0] || {};
    check(f1.c43 === 'A' && f1.c30 === 'FINANZAS' && f1.c42 === 116, 'Kepler: nace autorizada (c43 A, autoriza FINANZAS, c42 = total)', f1);
    check(f1.c9 === hoy && f1.c25 === `AMPARA TICKET 1198 DEL ${dmy(ayer)}` && f1.c11 === '1198', 'Kepler: c9 = fecha de solicitud y c25 = «AMPARA TICKET 1198 DEL …» (DS15)', f1);
    check(f1.c16 === 116 && f1.c14 === 16 && f1.c10 === ACR && f1.c48 === 'APRUEBA' && f1.c67 === 'SUITE',
      'Kepler: total, IVA, acreedor, quién solicita (su usuario) y capturista SUITE', f1);
    const ren1 = (await k.query(`SELECT btrim(c12) c12, btrim(c13) c13, btrim(c16) c16 FROM md.kdm6 WHERE c1 = $1 AND btrim(c6) = $2`, [SUC, folio1])).rows;
    check(ren1.length === 1 && ren1[0].c12 === C_GASTO && ren1[0].c13 === PROYECTO && ren1[0].c16 === DEPTO, 'Kepler: el renglón (kdm6) con concepto, proyecto y departamento', ren1);
    check(await contador() === '990002', 'el contador sqliov avanzó a 990002', await contador());
    const v1b = await vale(c1.id);
    check(v1b.folio_solicitud === folio1 && v1b.kepler_request_status === 'written' && v1b.kepler_authorization_status === 'escrito' && Number(v1b.kepler_request_attempts) === 1,
      'el vale: el folio de Kepler, written, autorizado en Kepler, 1 intento', { folio: v1b.folio_solicitud, st: v1b.kepler_request_status, aut: v1b.kepler_authorization_status, n: v1b.kepler_request_attempts });
    const b1 = await intentos(c1.id);
    check(b1.length === 1 && b1[0].trigger === 'firma' && b1[0].result === 'escrito' && b1[0].folio === folio1 && /^[0-9a-f]{64}$/.test(b1[0].plan_hash || ''),
      'la bitácora: un renglón (firma → escrito, con el plan y su huella)', b1);
    const otra = await svc.escribirAlFirmar(c1.id, FIRMA.full_name);
    const re1 = await svc.reintentar(c1.id, FIRMA.full_name);
    check(otra?.status === 'written' && re1?.status === 'written' && (await enKepler(v1.kepler_request_mark)).length === 1 && (await intentos(c1.id)).length === 1,
      'firmar o reintentar otra vez no escribe una segunda ni cuenta otro intento');

    // ── E ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— E. El cron cierra el lazo con el ODS');
    const m0 = await svc.ciclo();
    check(m0.vistos_en_ods === 0 && (await vale(c1.id)).kepler_request_status === 'written', 'sin la réplica, el cron no la da por vista', m0);
    await sembrar('kdm1', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: folio1, c9: hoy, c10: ACR, c16: 116, c26: v1.kepler_request_mark, c43: 'A', c48: 'APRUEBA', c67: 'SUITE', c68: hoy, c69: '10:00' }]);
    const m1 = await svc.ciclo();
    check(m1.vistos_en_ods === 1 && (await vale(c1.id)).kepler_request_status === 'seen_in_ods', 'cuando la réplica llega (analytics.expense_requests), el cron la marca seen_in_ods', m1);
    const latido = await knex('analytics.cron_runs').where({ tenant_id: T, job_key: JOB }).first('status', 'note', 'error');
    // Escritas hace > 30 min y no vistas, AJENAS a la prueba (p. ej. una prueba visual en esta base): con ellas la alarma
    // DEBE sonar; sin ellas, el latido queda en verde. La prueba es correcta en una base limpia y en una usada.
    const ajenas = Number((await knex('finance.expense_proofs').where({ tenant_id: T, origen: 'solicitud', kepler_request_status: 'written' })
      .whereNotIn('id', ids).whereRaw(`kepler_request_at < now() - interval '30 minutes'`).count({ n: '*' }))[0].n);
    check(ajenas
      ? latido?.status === 'error' && /no aparecen en el ODS/.test(latido.error || '')
      : latido?.status === 'ok' && /vistas en el ODS/.test(latido.note || ''),
    ajenas ? `el latido sale en ROJO: ${ajenas} solicitud(es) ajena(s) a la prueba, escritas hace más de 30 min, no aparecen en el ODS`
      : 'el latido del cron queda en verde en analytics.cron_runs (lo ve db-health)', latido);

    // ── F ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— F. Firmada con el interruptor apagado: espera, y el cron la escribe al encender');
    // DS17: se PIDE por transferencia y todavía no hay referencia del banco (llega al pagar).
    const c2 = await pedir({ renglones: [{ concepto: C_GASTO, proyecto: PROYECTO, departamento: DEPTO, importe: 250.5 }], iva: 40.08, forma_pago: 'transferencia', forma_pago_detalle: null });
    await interruptor(false);
    const r2 = await firmar(c2.id);
    const v2 = await vale(c2.id);
    check(v2.forma_pago === 'transferencia' && v2.forma_pago_detalle === null, 'DS17: pedida por transferencia SIN referencia (llega al pagar): se acepta y se guarda «sin dato», no vacío', { forma: v2.forma_pago, detalle: v2.forma_pago_detalle });
    check(r2.status === 'validada' && r2.solicitud_kepler?.status === 'pending' && /interruptor/.test(r2.solicitud_kepler?.nota || ''),
      'la firma se guarda; Kepler espera y dice por qué (el interruptor)', r2.solicitud_kepler);
    check((await enKepler(v2.kepler_request_mark)).length === 0 && Number(v2.kepler_request_attempts) === 0, '… sin tocar Kepler y sin gastar intentos');
    const b2 = await intentos(c2.id);
    check(b2.length === 1 && b2[0].result === 'apagado' && b2[0].trigger === 'firma', 'la bitácora dice que no se intentó (apagado)', b2);
    const mApagada = await svc.ciclo();
    check(mApagada.intentados === 0 && Number((await vale(c2.id)).kepler_request_attempts) === 0, 'con la sucursal apagada el cron ni la toma (no ocupa el cupo de las demás ni gasta intentos)', mApagada);
    await interruptor(true);
    const m2 = await svc.ciclo();
    const v2b = await vale(c2.id);
    check(m2.intentados >= 1 && v2b.kepler_request_status === 'written' && v2b.folio_solicitud === '0990002',
      'al encender, el cron la escribe con el folio siguiente (0990002)', { m2, st: v2b.kepler_request_status, folio: v2b.folio_solicitud });
    check((await intentos(c2.id)).some((x) => x.trigger === 'cron' && x.result === 'escrito'), 'la bitácora: cron → escrito');
    const forma2 = (await k.query(`SELECT btrim(c90) AS c90 FROM md.kdm1 WHERE btrim(c26) = $1`, [v2.kepler_request_mark])).rows[0]?.c90;
    check(forma2 === '03', 'DS17: en Kepler va la forma (c90 = 03, transferencia); la referencia la pone el pago', forma2);

    // ── G ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— G. Kepler no responde: espera 5 min y el cron la escribe cuando vuelve');
    // Sin usuario ni clave en el texto (gitleaks): el puerto cerrado contesta antes de autenticar.
    process.env[`KEPLER_PUSH_URL_${SUC}`] = 'postgresql://127.0.0.1:1/kepler_apagado';
    const c3 = await pedir();
    const r3 = await firmar(c3.id);
    let v3 = await vale(c3.id);
    const espera = (await knex.raw(`SELECT round(extract(epoch FROM kepler_request_next_at - now()) / 60)::int AS min FROM finance.expense_proofs WHERE id = ?`, [c3.id])).rows[0].min;
    check(r3.solicitud_kepler?.status === 'retry' && Number(v3.kepler_request_attempts) === 1 && espera === 5 && /no responde/.test(v3.kepler_request_note || ''),
      'Kepler caído → retry, 1 intento, vuelve a intentar en 5 min y dice por qué', { st: r3.solicitud_kepler?.status, n: v3.kepler_request_attempts, espera, nota: v3.kepler_request_note });
    await svc.ciclo();
    v3 = await vale(c3.id);
    check(v3.kepler_request_status === 'retry' && Number(v3.kepler_request_attempts) === 1, 'el cron respeta la espera: no lo intenta antes', { st: v3.kepler_request_status, n: v3.kepler_request_attempts });
    process.env[`KEPLER_PUSH_URL_${SUC}`] = kep.url;
    await knex('finance.expense_proofs').where({ id: c3.id }).update({ kepler_request_next_at: knex.raw(`now() - interval '1 minute'`) });
    await svc.ciclo();
    v3 = await vale(c3.id);
    check(v3.kepler_request_status === 'written' && v3.folio_solicitud === '0990003' && Number(v3.kepler_request_attempts) === 2,
      'vencida la espera y de vuelta Kepler, el cron la escribe (0990003, 2 intentos)', { st: v3.kepler_request_status, folio: v3.folio_solicitud, n: v3.kepler_request_attempts });

    // ── H ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— H. Kepler rechaza (su catálogo ya no es el del ODS): rejected_by_kepler, sin reintento automático');
    const antesH = await contador();
    const c4 = await pedir({ renglones: [{ concepto: C_CAMBIO, proyecto: PROYECTO, departamento: DEPTO, importe: 80 }], iva: 0 });
    const r4 = await firmar(c4.id);
    let v4 = await vale(c4.id);
    check(r4.solicitud_kepler?.status === 'rejected_by_kepler' && /concepto Z99/.test(v4.kepler_request_note || ''),
      'rejected_by_kepler, y la nota dice qué concepto', { st: r4.solicitud_kepler?.status, nota: v4.kepler_request_note });
    check((await enKepler(v4.kepler_request_mark)).length === 0 && (await contador()) === antesH, '… sin escribir nada ni mover el contador');
    await svc.ciclo();
    v4 = await vale(c4.id);
    check(v4.kepler_request_status === 'rejected_by_kepler' && Number(v4.kepler_request_attempts) === 1, 'el cron no lo reintenta solo: lo reintenta una persona (COMPROBAR)');

    // ── J ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— J. El proceso muere DESPUÉS del commit de Kepler: el cron pregunta por la marca y no duplica');
    console.log('    (el error que sigue es el esperado: lo escribe escribirAlFirmar al morir)');
    const anotarReal = svc.anotar;
    let morir = true;
    svc.anotar = async function (...a) {
      if (morir) { morir = false; throw new Error('el proceso murió después del COMMIT de Kepler'); }
      return anotarReal.apply(this, a);
    };
    const c5 = await pedir();
    const r5 = await firmar(c5.id);
    delete svc.anotar;
    let v5 = await vale(c5.id);
    const k5 = await enKepler(v5.kepler_request_mark);
    check(r5.status === 'validada' && !r5.solicitud_kepler && v5.kepler_request_status === 'writing' && v5.folio_solicitud === null && k5.length === 1,
      'la firma quedó; Kepler SÍ la tiene; el vale quedó en writing, sin folio', { r5, st: v5.kepler_request_status, kepler: k5 });
    await svc.ciclo();
    check((await vale(c5.id)).kepler_request_status === 'writing', 'el cron no toca un writing reciente (podría seguir vivo)');
    await knex('finance.expense_proofs').where({ id: c5.id }).update({ kepler_request_at: knex.raw(`now() - interval '11 minutes'`) });
    const m5 = await svc.ciclo();
    v5 = await vale(c5.id);
    check(m5.huerfanos === 1 && v5.kepler_request_status === 'written' && v5.folio_solicitud === k5[0]?.c6 && /ya la tenía/.test(v5.kepler_request_note || ''),
      'a los 10 min es huérfano: el cron pregunta por la marca y adopta el folio de Kepler', { m5, st: v5.kepler_request_status, folio: v5.folio_solicitud, nota: v5.kepler_request_note });
    check((await enKepler(v5.kepler_request_mark)).length === 1, '… sin escribir una segunda');

    // ── K ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— K. Dos reintentos a la vez: una sola escritura (el reclamo es atómico)');
    const c6 = await pedir();
    await interruptor(false);
    await firmar(c6.id);
    await interruptor(true);
    await Promise.all([svc.reintentar(c6.id, 'Uno'), svc.reintentar(c6.id, 'Otro')]);
    const v6 = await vale(c6.id);
    const escritos6 = (await intentos(c6.id)).filter((x) => x.result === 'escrito');
    check((await enKepler(v6.kepler_request_mark)).length === 1 && escritos6.length === 1 && v6.kepler_request_status === 'written',
      'Kepler la tiene UNA vez y la bitácora dice un solo «escrito»', { kepler: (await enKepler(v6.kepler_request_mark)).length, escritos: escritos6.length, st: v6.kepler_request_status });

    // ── I ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— I. Tope diario del interruptor: se reintenta mañana a las 7, sin gastar intentos');
    const hechasHoy = Number((await k.query(`SELECT count(*)::int AS n FROM md.kdm1 WHERE btrim(c67) = 'SUITE' AND c68::date = $1::date`, [hoy])).rows[0].n);
    await interruptor(true, hechasHoy);
    const c7 = await pedir();
    const r7 = await firmar(c7.id);
    const v7 = await vale(c7.id);
    const cuando = (await knex.raw(`SELECT to_char(kepler_request_next_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS t FROM finance.expense_proofs WHERE id = ?`, [c7.id])).rows[0].t;
    check(r7.solicitud_kepler?.status === 'retry' && Number(v7.kepler_request_attempts) === 0 && cuando === `${diasDesde(hoy, 1)} 07:00` && /Tope diario/.test(v7.kepler_request_note || ''),
      `tope de ${hechasHoy} alcanzado → retry mañana 07:00, 0 intentos`, { st: r7.solicitud_kepler?.status, n: v7.kepler_request_attempts, cuando, nota: v7.kepler_request_note });
    check((await enKepler(v7.kepler_request_mark)).length === 0, '… y Kepler no la tiene');

    // ── L ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— L. Lo que encontró la revisión independiente del PR');
    await interruptor(true); // tope 100: la I lo dejó al límite
    const estatusDe = async (fn) => { try { await fn(); return 200; } catch (e) { return typeof e.getStatus === 'function' ? e.getStatus() : (e.code || e.message); } };
    // a) la puerta: con la sucursal cerrada no se pide (409), la misma regla que la pestaña
    await interruptor(false);
    check(await estatusDe(() => svc.crear(pantalla(), PIDE)) === 409, 'puerta cerrada → 409 al pedir, también por API');
    await interruptor(true);
    // b) una fecha imposible es un 400 con su motivo, no un 500
    check(await estatusDe(() => svc.crear(pantalla({ comprobante: { tipo: 'ticket', folio: '1', fecha: '2026-02-30', uuid: null } }), PIDE)) === 400, 'fecha imposible (2026-02-30) → 400');
    // c) idempotencia: la misma solicitud otra vez (la respuesta se perdió) devuelve la misma
    const idCli = '7a1c0de0-0000-4000-8000-0000000c0de1';
    const p1 = await svc.crear(pantalla({ id_cliente: idCli }), PIDE); ids.push(p1.id);
    const p2 = await svc.crear(pantalla({ id_cliente: idCli }), PIDE);
    const conEseId = Number((await knex('finance.expense_proofs').where({ id: idCli }).count({ n: '*' }))[0].n);
    check(p1.id === idCli && p2.id === idCli && conEseId === 1, 'mandarla dos veces con el mismo id → la misma solicitud, una sola', { p1: p1.id, p2: p2.id, conEseId });
    // d) la factura del SAT: verificada, única, y respalda la firma sin foto
    const UUID_OK = '6f9a1b2c-3d4e-4f50-8a1b-2c3d4e5f6a7b';
    await knex.raw(`INSERT INTO fiscal.cfdis (tenant_id, uuid, rol, tipo_comprobante, emisor_rfc, subtotal, total_trasladados, total, estatus_sat, fecha, serie, folio)
      VALUES (?, ?, 'recibidas', 'I', 'XAXX010101000', 100, 16, 116, 'vigente', ?::timestamptz, 'F', '393')`, [T, UUID_OK, `${ayer}T12:00:00-06:00`]);
    cfdisSembrados.push(UUID_OK);
    const conSat = { comprobante: { tipo: 'cfdi', folio: 'F-393', fecha: ayer, uuid: UUID_OK }, files: [] };
    const cS = await pedir(conSat);
    check((await vale(cS.id)).cfdi_uuid === UUID_OK, 'con la factura del SAT verificada no hace falta foto: se guarda su UUID');
    await no(conSat, /ya respalda otro vale/, 'la misma factura del SAT no respalda dos vales');
    await no({ comprobante: { tipo: 'cfdi', folio: 'X', fecha: ayer, uuid: '00000000-0000-4000-8000-000000000000' }, files: [] }, /no está entre las recibidas/, '⛔ un UUID inventado → 400: no está entre las facturas recibidas del SAT');
    await no({ ...conSat, renglones: [{ concepto: C_GASTO, proyecto: PROYECTO, departamento: DEPTO, importe: 500 }], iva: 80 }, /es por \$116/, '⛔ la factura es por otro total → 400');
    const rS = await firmar(cS.id);
    check(rS.status === 'validada' && rS.solicitud_kepler?.status === 'written', 'la factura del SAT respalda la firma (sin foto) y se escribe en Kepler', rS);
    // e) rechazar: antes de escribirse queda cancelled (no se escribe); ya escrita → 409 (se cancela en Kepler, DS8)
    const cR = await pedir();
    await interruptor(false); await firmar(cR.id); await interruptor(true);
    await proofs.reject(cR.id, FIRMA.full_name, 'ya no se necesita', FIRMA);
    const vR = await vale(cR.id);
    check(vR.status === 'rechazada' && vR.kepler_request_status === 'cancelled', 'rechazarla antes de escribirse la deja cancelled', { st: vR.status, k: vR.kepler_request_status });
    await svc.ciclo();
    check((await enKepler(vR.kepler_request_mark)).length === 0 && (await vale(cR.id)).kepler_request_status === 'cancelled', '… y el cron ya no la escribe');
    check(await estatusDe(() => proofs.reject(c1.id, FIRMA.full_name, 'no', FIRMA)) === 409, 'rechazar una YA escrita en Kepler → 409: se cancela allá primero (DS8)');
    // f) firmada que pasa a «revision» (subió su factura) se escribe igual: la escritura cuelga de la firma
    const cV = await pedir();
    await interruptor(false); await firmar(cV.id);
    await knex('finance.expense_proofs').where({ id: cV.id }).update({ status: 'revision' });
    await interruptor(true);
    await svc.ciclo();
    check((await vale(cV.id)).kepler_request_status === 'written', 'en «revision» (ya firmada) se escribe igual');
    // g) «Capturas sin folio» no la ofrece y «Ligar» la rechaza
    const cL = await pedir();
    const sinF = await proofs.sinFolio({ limit: 500 });
    check(!sinF.rows.some((r) => r.id === cL.id), '«Capturas sin folio» no ofrece una solicitud nacida en la Suite');
    check(await estatusDe(() => proofs.match(cL.id, '0000123')) === 409, '«Ligar» una solicitud de la Suite → 409: su folio lo pone Kepler');
    // h) la pastilla de Aprobación (la lectura de PGP.79) trae cómo va su escritura
    const pk = await new AutorizacionKeplerLecturaService(tk, ctx).porVales([cL.id, c1.id]);
    check(pk[cL.id]?.nace_en_la_suite?.status === 'pending' && pk[c1.id]?.nace_en_la_suite?.status === 'seen_in_ods', 'la lectura de Aprobación trae el estado de la escritura de cada solicitud de la Suite', pk);
    // i) lo que se escribe, para quien firma
    const det = await svc.detalle(cL.id);
    check(det.renglones.length === 1 && det.renglones[0].cuenta === '602-008' && det.total === 116 && det.iva === 16, 'el detalle para quien firma: renglón con su cuenta, IVA y total', det);
    // j) en duda sin poder preguntar: no se reintenta a ciegas y el latido sale en ROJO
    await interruptor(false); await firmar(cL.id); await interruptor(true);
    await knex('finance.expense_proofs').where({ id: cL.id }).update({ kepler_request_status: 'in_doubt', kepler_request_next_at: null });
    process.env[`KEPLER_PUSH_URL_${SUC}`] = 'postgresql://127.0.0.1:1/kepler_apagado';
    const mDuda = await svc.ciclo();
    const lat2 = await knex('analytics.cron_runs').where({ tenant_id: T, job_key: JOB }).first('status', 'error');
    check(mDuda.en_duda === 1 && lat2?.status === 'error' && /EN DUDA/.test(lat2.error || '') && (await vale(cL.id)).kepler_request_status === 'in_doubt',
      'en duda sin poder preguntar: no se reintenta y el latido sale en rojo', { mDuda, lat2 });
    process.env[`KEPLER_PUSH_URL_${SUC}`] = kep.url;
    await knex('finance.expense_proofs').where({ id: cL.id }).update({ kepler_request_next_at: knex.raw(`now() - interval '1 minute'`) });
    await svc.ciclo();
    check((await vale(cL.id)).kepler_request_status === 'written', 'de vuelta Kepler: pregunta por la marca (no está) y la escribe');

    // ── M ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— M. S.17: la base sale de los almacenes de quien pide; el plazo y la información de pago');
    await interruptor(true);
    // a) la base (DS27): una → esa; otra que no es suya → 403 al pedir Y al leer; sin almacén en su ficha → ninguna
    alcance.dim = { mode: 'own', values: [SUC], resolvable: true };
    const ab1 = await svc.abiertas();
    check(ab1.sucursales.length === 1 && ab1.sucursales[0] === SUC && ab1.alcance === 'una', 'con un solo almacén: «abiertas» da sólo el suyo, y dice «una»', ab1);
    const cBase = await pedir();
    check(cBase.status === 'recibida', 'con un solo almacén, pedir en el suyo pasa');
    alcance.dim = { mode: 'listed', values: ['03', '07'], resolvable: true };
    check(await estatusDe(() => svc.crear(pantalla(), PIDE)) === 403, '⛔ pedir en una base que no es de sus almacenes → 403 (por API también)');
    check(await estatusDe(() => svc.catalogo(SUC)) === 403 && await estatusDe(() => svc.precarga(SUC, ACR)) === 403 && await estatusDe(() => svc.disponibilidad(SUC)) === 403,
      '⛔ … y leer el catálogo, el hábito o la puerta de esa base → 403');
    const ab2 = await svc.abiertas();
    check(!ab2.sucursales.includes(SUC) && ab2.alcance === 'varias', 'con varios almacenes: «abiertas» no ofrece una base ajena', ab2);
    alcance.dim = { mode: 'own', values: [], resolvable: false };
    const ab3 = await svc.abiertas();
    let msg = '';
    try { await svc.crear(pantalla(), PIDE); } catch (e) { msg = String(e.message); }
    check(ab3.sucursales.length === 0 && ab3.alcance === 'sin_almacen' && /Sistemas/.test(msg), '⛔ sin almacén en su ficha: ninguna base (nunca las nueve) y el 403 dice que lo arregla Sistemas', { ab3, msg });
    alcance.dim = { mode: 'all', values: [], resolvable: true };
    const ab4 = await svc.abiertas();
    check(ab4.sucursales.includes(SUC) && ab4.alcance === 'todas', 'con todas: la base abierta se ofrece', ab4);

    // b) el plazo (DS30): de los días de crédito de Kepler; si no tiene, de su última solicitud; viaja como fecha de pago
    const ACR_D = 'GZPRU2';
    const ACR_H = 'GZPRU3';
    await sembrar('kdxd', [
      { sucursal: SUC, c1: SUC, c2: ACR_D, c3: 'ACREEDOR A CREDITO PGP122', c10: 'XAXX010101000', c11: 'pagos@acreedor-prueba.com.mx', c16: 15 },
      { sucursal: SUC, c1: SUC, c2: ACR_H, c3: 'ACREEDOR DE HABITO PGP122', c10: 'XAXX010101000', c11: 'no es un correo' },
    ]);
    const hace20 = diasDesde(hoy, -20);
    await sembrar('kdm1', [{ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: '0989998', c9: hace20, c18: diasDesde(hace20, 7), c10: ACR_H, c16: 70, c43: 'A', c48: 'ANA', c67: '01ANA', c68: hace20, c69: '10:00' }]);
    const preD = await svc.precarga(SUC, ACR_D);
    check(preD.plazo?.dias === 15 && preD.plazo.fuente === 'catalogo', 'plazo: los 15 días de crédito del catálogo de Kepler (kdxd.c16)', preD.plazo);
    check(preD.pago?.correo === 'pagos@acreedor-prueba.com.mx' && preD.pago.fuente_correo === 'catalogo' && preD.pago.cuenta === null,
      'información de pago: el correo del catálogo de Kepler (kdxd.c11); la cuenta, ninguna (no está en ningún catálogo)', preD.pago);
    const preH = await svc.precarga(SUC, ACR_H);
    check(preH.plazo?.dias === 7 && preH.plazo.fuente === 'habito', 'plazo: sin días en Kepler, el de su última solicitud (fecha de pago − fecha = 7)', preH.plazo);
    check(preH.pago === null, '⛔ un «correo» de Kepler que no tiene forma de correo no se propone', preH.pago);
    const enQuince = diasDesde(hoy, 15);
    const cPlazo = await pedir({ necesita_para: enQuince });
    check((await vale(cPlazo.id)).needed_by != null && (await svc.detalle(cPlazo.id)).necesita_para === enQuince, 'la fecha de pago del plazo se guarda y quien firma la ve', enQuince);

    // c) la información de pago (DS31): se valida su forma, se guarda limpia y la ve quien firma; la siguiente la propone
    const CLABE = '012180001234567899';
    const cPago = await pedir({ pago: { cuenta: '0121 8000 1234 5678 99', banco: ' BBVA ', correo: ' pagos@acreedor-prueba.com.mx ' } });
    const vPago = await vale(cPago.id);
    check(vPago.payee_account === CLABE && vPago.payee_bank === 'BBVA' && vPago.payee_email === 'pagos@acreedor-prueba.com.mx',
      'la CLABE se guarda sólo con dígitos, y el banco y el correo sin espacios', { a: vPago.payee_account, b: vPago.payee_bank, c: vPago.payee_email });
    const dPago = await svc.detalle(cPago.id);
    check(dPago.pago?.cuenta === CLABE && dPago.pago?.correo === 'pagos@acreedor-prueba.com.mx', 'quien firma ve a dónde se paga y a quién se manda el comprobante', dPago.pago);
    const preP = await svc.precarga(SUC, ACR);
    check(preP.pago?.cuenta === CLABE && preP.pago.fuente_cuenta === 'habito' && preP.pago.fuente_correo === 'habito', 'la siguiente solicitud al mismo acreedor la propone «como la última vez»', preP.pago);
    const cVacio = await pedir({ pago: { cuenta: ' ', banco: '', correo: '' } });
    const vVacio = await vale(cVacio.id);
    check(vVacio.payee_account === null && vVacio.payee_bank === null && vVacio.payee_email === null, 'una información de pago vacía no guarda nada (ni cadenas vacías)');
    await no({ pago: { cuenta: '012180001234567890' } }, /dígito de control/, '⛔ una CLABE con el dígito de control mal → 400');
    await no({ pago: { correo: 'pagos@acreedor' } }, /no es un correo/, '⛔ un correo sin dominio → 400');
    await no({ pago: { cuenta: '12345' } }, /dígitos/, '⛔ una cuenta de 5 dígitos → 400');
  } finally {
    // ── Limpieza: exactamente lo que se creó ─────────────────────────────────────────────────────
    if (cfdisSembrados.length) await knex('fiscal.cfdis').where({ tenant_id: T }).whereIn('uuid', cfdisSembrados).del().catch((e) => console.log(`  ! limpieza: ${e.message}`));
    const err = (q) => q.catch((e) => console.log(`  ! limpieza: ${e.message}`));
    if (ids.length) {
      await err(knex('finance.expense_request_kepler_attempts').whereIn('proof_id', ids).del());
      await err(knex('finance.expense_proof_lines').whereIn('proof_id', ids).del());
      await err(knex('finance.expense_proofs').whereIn('id', ids).del());
    }
    for (const [tabla, ctids] of Object.entries(sembradas)) {
      if (ctids.length) await err(knex.raw(`DELETE FROM kepler_ods.${tabla} WHERE ctid = ANY(?::tid[])`, [ctids]));
    }
    if (sw0) await err(knex('commercial.kepler_push_switch').where({ tenant_id: T, sucursal: SUC, tipo: TIPO }).update({ encendida: sw0.encendida, tope_dia: sw0.tope_dia, nota: sw0.nota, updated_at: sw0.updated_at }));
    if (!latido0) await err(knex('analytics.cron_runs').where({ tenant_id: T, job_key: JOB }).del());
    for (const [n, v] of Object.entries(env0)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    await sink.onModuleDestroy();
    await kep.cerrar();
    const quedan = Number((await knex('finance.expense_proofs').whereIn('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).count({ n: '*' }))[0].n);
    check(quedan === 0, `limpieza: los ${ids.length} vales de la prueba se borraron`, quedan);
  }
}

main()
  .then(async () => {
    await knex.destroy();
    console.log(`\n  ${ok} ✓ · ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error('  ✗ la prueba se cayó:', e?.stack || e);
    await knex.destroy().catch(() => undefined);
    process.exit(1);
  });
