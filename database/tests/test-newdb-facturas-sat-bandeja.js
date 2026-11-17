/* eslint-disable no-console */
/**
 * `[PGP.122]` S.13 — **La bandeja de facturas del SAT por registrar**, con el servicio REAL contra un Postgres real
 * (anexo S §14). Lo que la spec del contrato no ve: las lecturas de verdad (el catálogo de Kepler en el ODS, el padrón
 * de emisores de `fiscal.cfdis` con sus DOS convenciones de fecha, la escalera del RFC, los X-A-15/10 de todos los
 * acreedores y los X-D-26 de `kepler_ods.kdm1`, los vales de la Suite con y sin factura), RLS y GRANT como
 * `app_runtime`, el alcance por sucursal (ScopeService) y el endpoint que ESCRIBE —sacar de la bandeja «sólo de esta
 * sucursal» o «para todas», y regresarla— con el payload de la pantalla (regla 13).
 *
 * Datos sintéticos (RFC, claves y UUID que no existen en ningún Kepler ni en el SAT): la base local puede traer datos
 * reales copiados de prod y no deben estorbar. Se borra al final exactamente lo que se sembró (el ODS, por `ctid`).
 *
 *   DATABASE_URL_NEW=postgresql://…local… node database/tests/test-newdb-facturas-sat-bandeja.js
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
assertSafeTarget('test-newdb-facturas-sat-bandeja', { url: ADMIN_URL });
const { noMedido } = require('./_lib/no-medido');

// ── Los módulos REALES; de platform-core, doble sólo la infraestructura de Nest ─────────────────────
const PC = (r) => path.join(RAIZ, 'libs', 'platform-core', 'src', 'lib', r);
const CONTRATOS = path.join(RAIZ, 'libs', 'contracts', 'src');
const STUB = path.join(os.tmpdir(), `.stub-pgp122-s13-${process.pid}.js`);
fs.writeFileSync(STUB, `'use strict';
module.exports = {
  ...require(${JSON.stringify(PC('date/mx-date.ts'))}),
  Permission: require(${JSON.stringify(path.join(CONTRATOS, 'index.ts'))}).Permission,
  TenantKnexService: class TenantKnexService {}, TenantContextService: class TenantContextService {}, ScopeService: class ScopeService {},
  RolesGuard: class RolesGuard {}, RequirePermissions: () => () => undefined, RequireAnyPermission: () => () => undefined,
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
const { FacturasSatService } = require(path.join(RAIZ, 'libs', 'finance', 'src', 'lib', 'expense-proofs', 'solicitud-kepler', 'facturas-sat.service.ts'));
const { todayMx } = require(PC('date/mx-date.ts'));

// ── La base: cada transacción como la API (app_runtime + tenant), la siembra como administrador ─────
const knex = require('knex')({ client: 'pg', connection: ADMIN_URL, pool: { min: 0, max: 6 } });
const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_TENANT = '00000000-0000-0000-0000-0000000005e1';
const ROL_API = 'app_runtime';
const tk = {
  run(a, b) {
    const fn = typeof a === 'function' ? a : b;
    return knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ROLE ${ROL_API}`);
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      return fn(trx);
    });
  },
  get global() { return knex; },
};
const ctx = { requireTenantId: () => T, getTenantId: () => T };
/** El alcance de quien consulta (ScopeService, ADR-050): `null` = todas las sucursales. */
const alcance = { visibles: null };
const scope = { current: async () => ({}), intersect: () => alcance.visibles };
const nuevo = () => new FacturasSatService(tk, ctx, scope);

// Emisores, acreedores y facturas SINTÉTICOS.
const RFC_A = 'QZA991231AA1'; // tal cual en Kepler
const RFC_B = 'QZB991231BB2'; // en Kepler con guiones
const RFC_C = 'QZC991231CC3'; // en Kepler con dos caracteres cambiados (parecido)
const RFC_D = 'QZD991231DD4'; // también proveedor de compras: no es gasto
const RFC_E = 'QZE991231EE5'; // historia empatada entre 06 y 08: sin sucursal propuesta
const RFC_F = 'QZG991231GG7'; // Kepler tiene el RFC de OTRA razón social: se reconoce por el nombre, no se puede registrar
const RECEPTOR = 'RCP991231RC1';
const u = (n) => `5a5a${String(n).padStart(4, '0')}-0000-4000-8000-0000000${String(n).padStart(5, '0')}`;
const F = {
  A1: u(1), A2: u(2), A3: u(3), B1: u(4), C1: u(5), D1: u(6), G01: u(7), CANC: u(8), A6a: u(9), A6b: u(10), PRE: u(11), SUITE: u(12),
  A8: u(13), A9: u(14), A10: u(15), A11: u(16), A12: u(17), A13: u(18), E1: u(19), F1: u(20), K1: u(21),
};
const QUIEN = 'Ana Prueba Capturista';
/** Lo que manda la pantalla al sacar una factura «para todas» y «sólo de esta sucursal». */
const PARA_TODAS = (sucursal) => ({ sucursal, alcance: 'todas', motivo: 'No es un gasto de la empresa' });
const DE_AQUI_NO = (sucursal) => ({ sucursal, alcance: 'sucursal', motivo: '' });

let ok = 0;
let fail = 0;
const check = (cond, label, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detalle === undefined ? '' : ` → ${JSON.stringify(detalle)}`}`); }
};
const diasDesde = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const falla = async (p) => { try { await p; return null; } catch (e) { return e?.status ?? e?.response?.statusCode ?? e?.code ?? e?.message; } };

const XML_A1 = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="501" Total="500.00" SubTotal="431.03">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveUnidad="LTR" Cantidad="20" Descripcion="DIESEL DE PRUEBA" ValorUnitario="17.24" Importe="344.83"/>
    <cfdi:Concepto ClaveUnidad="E48" Cantidad="1" Descripcion="LAVADO DE PRUEBA" ValorUnitario="86.20" Importe="86.20"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

async function main() {
  console.log('[PGP.122] S.13 — la bandeja de facturas del SAT por registrar (servicio real, como app_runtime)');
  if (!(await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROL_API])).rows.length) noMedido(`no existe el rol ${ROL_API}: sin él no se prueba RLS ni GRANT como en la API`);
  if (!(await knex.schema.withSchema('finance').hasColumn('expense_sat_invoice_dismissals', 'scope'))) noMedido('falta la migración de S.13 (20261115045210) en esta base');
  if (!(await knex.schema.withSchema('finance').hasColumn('expense_proofs', 'cfdi_uuid'))) noMedido('falta la migración de [PGP.122] (20261115003547) en esta base');

  const hoy = todayMx();
  const d0 = diasDesde(hoy, -10);
  const corte1 = '2026-10-02';
  const sembradas = { kdxd: [], kdm1: [] };
  const vales = [];
  const sembrar = async (tabla, filas) => {
    for (const f of filas) {
      const cols = Object.keys(f);
      const r = await knex.raw(`INSERT INTO kepler_ods.${tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING ctid::text AS ctid`, cols.map((c) => f[c]));
      sembradas[tabla].push(r.rows[0].ctid);
    }
  };
  const iva16 = (t) => Math.round((t - t / 1.16) * 100) / 100;
  const cfdi = (uuid, p) => knex.raw(`
    INSERT INTO fiscal.cfdis (tenant_id, uuid, rol, tipo_comprobante, emisor_rfc, emisor_nombre, receptor_rfc, receptor_uso_cfdi, subtotal, descuento,
                              total, total_trasladados, total_retenidos, impuestos, moneda, metodo_pago, forma_pago, estatus_sat, fecha, serie, folio, xml,
                              aso_contabilidad, source)
    VALUES (?, ?, 'recibidas', 'I', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?::jsonb, 'MXN', 'PUE', '01', ?, ?::timestamptz, ?, ?, ?, ?, ?)`, [
    T, uuid, p.rfc, p.nombre ?? `EMISOR ${p.rfc}`, RECEPTOR, p.uso ?? 'G03', p.subtotal ?? Math.round((p.total / 1.16) * 100) / 100, p.total,
    iva16(p.total), p.retenido ?? 0, JSON.stringify(p.impuestos ?? { iva_trasladado: iva16(p.total) }),
    p.estatus ?? 'vigente', p.instante ?? `${p.fecha ?? d0}T12:00:00-06:00`, p.serie ?? 'A', p.folio ?? null, p.xml ?? null, p.contabilizada ?? false,
    p.source ?? 'contpaqi_add',
  ]);
  const doc = (p) => ({ sucursal: p.suc ?? '06', c1: p.suc ?? '06', c2: 'X', c3: p.c3 ?? 'A', c4: p.tipo, c5: 1, c6: p.folio, c9: p.fecha, c10: p.acr, c16: p.total,
    c43: 'A', c11: p.c11 ?? '', c24: p.c24 ?? '', ...(p.tipo === 10 ? { c36: 'A', c37: 15, c39: p.solicitud } : {}) });
  const vale = async (p) => {
    const [v] = await knex('finance.expense_proofs').insert({ tenant_id: T, solicitante: 'prueba s13', proveedor: 'prueba s13', sucursal: '06', ...p }).returning('id');
    vales.push(v.id ?? v);
    return v.id ?? v;
  };

  try {
    // ── Siembra ─────────────────────────────────────────────────────────────────────────────────
    await sembrar('kdxd', [
      { sucursal: '06', c1: '06', c2: 'GZS13A', c3: 'PROVEEDOR S13 A SA DE CV', c10: RFC_A },
      { sucursal: '08', c1: '08', c2: 'GZS13A', c3: 'PROVEEDOR S13 A SA DE CV', c10: RFC_A },
      { sucursal: '06', c1: '06', c2: 'GZS13B', c3: 'PROVEEDOR S13 B', c10: 'QZB-991231-BB2' },
      { sucursal: '06', c1: '06', c2: 'GZS13C', c3: 'PROVEEDOR S13 C', c10: 'QXC991231CC8' },
      { sucursal: '06', c1: '06', c2: 'GZS13D', c3: 'PROVEEDOR S13 D', c10: RFC_D },
      { sucursal: '06', c1: '06', c2: 'CZS13D', c3: 'PROVEEDOR S13 D (COMPRAS)', c10: RFC_D },
      { sucursal: '06', c1: '06', c2: 'GZS13E', c3: 'PROVEEDOR S13 E', c10: RFC_E },
      { sucursal: '08', c1: '08', c2: 'GZS13E', c3: 'PROVEEDOR S13 E', c10: RFC_E },
      { sucursal: '06', c1: '06', c2: 'GZS13F', c3: 'PROVEEDOR S13 F SA DE CV', c10: 'QZF991231ZZ9' },
    ]);
    await cfdi(F.A1, { rfc: RFC_A, nombre: 'PROVEEDOR S13 A SA DE CV', total: 500, folio: '501', xml: XML_A1, contabilizada: true });
    await cfdi(F.A2, { rfc: RFC_A, total: 300, folio: '502' });
    await cfdi(F.A3, { rfc: RFC_A, total: 777, folio: '503' });
    await cfdi(F.B1, { rfc: RFC_B, total: 1000, folio: '9001' });
    await cfdi(F.C1, { rfc: RFC_C, total: 250, folio: '7001' });
    await cfdi(F.D1, { rfc: RFC_D, total: 640, folio: '6001' });
    await cfdi(F.G01, { rfc: RFC_A, total: 90, folio: '504', uso: 'G01' });
    await cfdi(F.CANC, { rfc: RFC_A, total: 120, folio: '505', estatus: 'cancelado' });
    await cfdi(F.A6a, { rfc: RFC_A, total: 400, folio: '506' });
    await cfdi(F.A6b, { rfc: RFC_A, total: 400, folio: '507', fecha: diasDesde(d0, 1) });
    await cfdi(F.PRE, { rfc: RFC_A, total: 55, folio: '508', fecha: '2026-09-20' });
    await cfdi(F.SUITE, { rfc: RFC_A, total: 333, folio: '509' });
    await cfdi(F.A8, { rfc: RFC_A, total: 612.5, folio: '510' });
    await cfdi(F.A9, { rfc: RFC_A, total: 250.25, folio: '511' });
    await cfdi(F.A10, { rfc: RFC_A, total: 1700, folio: '467', serie: 'F' });
    await cfdi(F.A11, { rfc: RFC_A, total: 845.14, folio: '512' });
    // Las DOS convenciones de fecha medidas en prod: ContPAQi guarda la hora LOCAL como UTC; la descarga masiva, el instante real.
    await cfdi(F.A12, { rfc: RFC_A, total: 91.5, folio: '513', instante: `${d0}T02:30:00Z` });
    await cfdi(F.A13, { rfc: RFC_A, total: 92.5, folio: '514', instante: `${d0}T02:30:00-06:00`, source: 'descarga_masiva',
      impuestos: { Traslados: { Traslado: [{ '@_Impuesto': '002', '@_Importe': '12.76' }, { '@_Impuesto': '003', '@_Importe': '3.00' }] } } });
    await cfdi(F.E1, { rfc: RFC_E, total: 99.99, folio: '8001' });
    await cfdi(F.F1, { rfc: RFC_F, nombre: 'PROVEEDOR S13 F SA DE CV', total: 150, folio: '9101' });
    const tail = F.A3.replace(/-/g, '').slice(-5);
    const tail8 = F.A8.replace(/-/g, '').slice(-6);
    await sembrar('kdm1', [
      // A2: un gasto del mismo total dos días después (difusa)
      doc({ tipo: 15, folio: '0990101', fecha: diasDesde(d0, 2), acr: 'GZS13A', total: 300 }),
      // A3: su X-A-10 trae la cola del UUID en la referencia, aunque el total no cuadre (referencia)
      doc({ tipo: 15, folio: '0990102', fecha: diasDesde(d0, 1), acr: 'GZS13A', total: 780 }),
      doc({ tipo: 10, folio: '0990201', solicitud: '0990102', fecha: diasDesde(d0, 3), acr: 'GZS13A', total: 780, c11: `TARJ 4512 ${tail}` }),
      // A6a/A6b: UNA solicitud con su comprobación y SU PAGO por 400 → cubre una sola de las dos (el pago no esconde la otra)
      doc({ tipo: 15, folio: '0990103', fecha: diasDesde(d0, 1), acr: 'GZS13A', total: 400 }),
      doc({ tipo: 10, folio: '0990202', solicitud: '0990103', fecha: diasDesde(d0, 4), acr: 'GZS13A', total: 400 }),
      doc({ c3: 'D', tipo: 26, folio: '0990302', fecha: diasDesde(d0, 5), acr: 'GZS13A', total: 400 }),
      // historia de A en 06 desde el corte (sin que case con nada)
      doc({ tipo: 15, folio: '0990104', fecha: corte1, acr: 'GZS13A', total: 111.11 }),
      doc({ tipo: 15, folio: '0990105', fecha: corte1, acr: 'GZS13A', total: 222.22 }),
      // B1: pagada con un X-D-26 al día siguiente (pagada contra un gasto agrupado)
      doc({ c3: 'D', tipo: 26, folio: '0990301', fecha: diasDesde(d0, 1), acr: 'GZS13B', total: 1000 }),
      // ⛔ placebo: un gasto de A por 500 +$7 → A1 sigue sin registro
      doc({ tipo: 15, folio: '0990106', fecha: diasDesde(d0, 2), acr: 'GZS13A', total: 507 }),
      // A8: un reembolso — el gasto está a nombre de OTRO acreedor y trae la cola del UUID (referencia_otro)
      doc({ tipo: 15, folio: '0990110', fecha: diasDesde(d0, 2), acr: 'GEMPL99', total: 612.5, c11: `REEMB ${tail8}` }),
      // A10: el folio de 3 dígitos en c11, con el total, a +16 días (fuera de la difusa)
      doc({ tipo: 15, folio: '0990111', fecha: diasDesde(d0, 16), acr: 'GZS13A', total: 1700, c11: '467' }),
      // A11: un documento de OTRO acreedor por el mismo importe, sin referencia: se AVISA, no se esconde
      doc({ tipo: 15, folio: '0990112', fecha: diasDesde(d0, 3), acr: 'GOTRO77', total: 845.14 }),
      // A11b ([PGP.123] H11): el mismo importe en la 03, que NO ve la factura (su acreedor es de la 06): coincidencia, no se avisa
      doc({ suc: '03', tipo: 15, folio: '0990113', fecha: diasDesde(d0, 3), acr: 'GOTRO03', total: 845.14 }),
      // E1: la historia de su acreedor empata entre 06 y 08 → sin propuesta, la ven 06, 08 y 00
      doc({ suc: '06', tipo: 15, folio: '0990120', fecha: corte1, acr: 'GZS13E', total: 11.11 }),
      doc({ suc: '06', tipo: 15, folio: '0990121', fecha: corte1, acr: 'GZS13E', total: 22.22 }),
      doc({ suc: '08', tipo: 15, folio: '0990122', fecha: corte1, acr: 'GZS13E', total: 33.33 }),
      doc({ suc: '08', tipo: 15, folio: '0990123', fecha: corte1, acr: 'GZS13E', total: 44.44 }),
    ]);
    // La señal 0: un vale de la Suite que ya trae el UUID de una factura.
    await vale({ cfdi_uuid: F.SUITE });
    // La señal 0b: un vale nacido en la Suite con el TICKET (sin la factura ligada), mismo acreedor y total.
    await vale({ origen: 'solicitud', creditor_code: 'GZS13A', importe: 250.25, document_date: d0, requested_on: d0, kepler_request_status: 'pending' });

    // ── A. La bandeja de 06 ─────────────────────────────────────────────────────────────────────
    console.log('\n— A. La bandeja de 06: universo, escalera del RFC, cascada y sucursal');
    const svc = nuevo();
    const b06 = await svc.bandeja('06');
    const mias = new Set(Object.values(F));
    const por = (b) => b.por_registrar.filter((f) => mias.has(f.uuid));
    const reg = (b) => new Map(b.registradas.filter((f) => mias.has(f.uuid)).map((f) => [f.uuid, f.registro]));
    const p06 = por(b06);
    const r06 = reg(b06);
    const a1 = p06.find((f) => f.uuid === F.A1);
    check(!!a1, 'A1 (sin documento en Kepler) está por registrar en 06', p06.map((f) => f.uuid));
    check(a1?.acreedores.length === 1 && a1.acreedores[0].clave === 'GZS13A' && a1.acreedores[0].via === 'tal_cual' && a1.acreedores[0].en_la_sucursal && a1.acreedores[0].registrable,
      'A1: su acreedor GZS13A, reconocido tal cual, en el catálogo de 06 y registrable', a1?.acreedores);
    check(a1?.sucursal.propuesta === '06' && a1.sucursal.via === 'historia' && a1.sucursal.documentos >= 5,
      'A1: se propone 06 por la historia del acreedor desde el corte', a1?.sucursal);
    check(a1?.serie_folio === 'A-501' && a1.total === 500 && a1.iva !== null && a1.contabilizada === true && /En Kepler no hay solicitud ni gasto de GZS13A por \$500\.00/.test(a1.motivo),
      'A1: serie-folio, total, IVA del CFDI, la marca de ContPAQi y por qué está aquí', a1);
    check(r06.get(F.A2)?.senal === 'difusa' && r06.get(F.A2)?.documento?.folio === '0990101', 'A2: registrada por un gasto del mismo total (difusa)', r06.get(F.A2));
    check(r06.get(F.A3)?.senal === 'referencia' && r06.get(F.A3)?.documento?.tipo === 'X-A-10', 'A3: registrada porque su X-A-10 trae la cola del UUID (referencia)', r06.get(F.A3));
    check(r06.get(F.B1)?.senal === 'pagada' && r06.get(F.B1)?.documento?.tipo === 'X-D-26', 'B1: pagada con un X-D-26 (RFC con guiones en Kepler)', r06.get(F.B1));
    check(r06.get(F.SUITE)?.senal === 'suite', 'la factura que ya trae un vale de la Suite: registrada (señal 0)', r06.get(F.SUITE));
    check(r06.get(F.A9)?.senal === 'suite_ticket', 'A9: el vale de la Suite capturado con el ticket la cubre (sin factura ligada)', r06.get(F.A9));
    check(r06.get(F.A10)?.senal === 'referencia', 'A10: el folio de 3 dígitos («467») en c11, con el total, a +16 días', r06.get(F.A10));
    const seis = [F.A6a, F.A6b].map((x) => ({ x, por: p06.some((f) => f.uuid === x), reg: r06.has(x) }));
    check(seis.filter((s) => s.reg).length === 1 && seis.filter((s) => s.por).length === 1,
      '⛔ UN gasto (la X-A-15 con su X-A-10) y SU pago cubren UNA de las dos facturas de 400: la otra queda por registrar', seis);
    const sobra = p06.find((f) => f.uuid === F.A6a || f.uuid === F.A6b);
    check(/ya cubre otra factura/.test(sobra?.motivo ?? ''), '⛔ …y su motivo NO afirma que no haya gasto: dice que el que hay cubre otra factura', sobra?.motivo);
    const a11 = p06.find((f) => f.uuid === F.A11);
    check(!!a11 && a11.avisos.some((x) => /otro acreedor \(GOTRO77\)/i.test(x)), 'A11: un documento de OTRO acreedor por el mismo importe se AVISA, sin esconderla', a11?.avisos);
    check(!!a11 && !a11.avisos.some((x) => /GOTRO03/.test(x)), '⛔ A11b: el mismo importe en una sucursal que NO ve la factura (la 03) no se avisa', a11?.avisos);
    const a12 = p06.find((f) => f.uuid === F.A12);
    const a13 = p06.find((f) => f.uuid === F.A13);
    check(a12?.fecha === d0, `A12 (ContPAQi, 02:30 guardada como UTC): su día es el del CFDI (${d0}), no el anterior`, a12?.fecha);
    check(a13?.fecha === d0 && a13.iva === 12.76, `A13 (descarga masiva, instante real): su día (${d0}) y el IVA del nodo crudo (12.76, sin el IEPS)`, { f: a13?.fecha, iva: a13?.iva });
    check(!b06.por_registrar.some((f) => [F.D1, F.G01, F.CANC, F.PRE].includes(f.uuid)) && !b06.registradas.some((f) => [F.D1, F.G01, F.CANC, F.PRE].includes(f.uuid)),
      '⛔ no entran: la de un proveedor de compras, la de mercancía (G01), la cancelada ni la anterior al corte');
    check(b06.declarado.some((d) => /no entran: mercancía/.test(d)) && b06.declarado.some((d) => /OTRO acreedor/.test(d)),
      'lo que no entra y lo que la regla no ve se DECLARA', b06.declarado);
    check(!p06.some((f) => f.uuid === F.C1), 'C1 (sin historia desde el corte) no se ofrece en 06: la ve 00');
    check(typeof b06.ultima_llegada === 'string' && b06.desde === '2026-10-01', 'la bandeja dice desde cuándo y cuándo llegó la última factura', { u: b06.ultima_llegada, d: b06.desde });
    check(r06.get(F.A8)?.senal === 'referencia_otro' && r06.get(F.A8)?.acreedor === 'GEMPL99' && r06.get(F.A8)?.documento?.folio === '0990110',
      'A8: el reembolso a nombre de OTRO acreedor con la cola del UUID: registrada (referencia_otro), y dice de quién');

    // ── B. Quién ve qué ─────────────────────────────────────────────────────────────────────────
    console.log('\n— B. Quién ve qué (DS21) y lo que se puede registrar');
    const b00 = await svc.bandeja('00');
    const c1 = por(b00).find((f) => f.uuid === F.C1);
    check(!!c1 && c1.acreedores[0]?.via === 'parecido' && c1.acreedores[0]?.registrable && c1.sucursal.propuesta === null && c1.sucursal.via === 'sin_historia',
      '00 ve C1: RFC reparado «parecido» (dos caracteres cambiados en Kepler), registrable y sin sucursal propuesta', c1);
    const f1 = por(b00).find((f) => f.uuid === F.F1);
    check(!!f1 && f1.acreedores[0]?.via === 'por_nombre' && f1.acreedores[0]?.registrable === false && /QZF991231ZZ9/.test(f1.acreedores[0]?.por_que_no ?? ''),
      '⛔ F1: reconocida por el nombre pero Kepler tiene el RFC de OTRA razón social → no se ofrece «Registrar» (fallaría al mandar a firma) y dice por qué', f1?.acreedores);
    check(por(b00).some((f) => f.uuid === F.A1), '00 ve también las de 06');
    check(!por(await svc.bandeja('08')).some((f) => f.uuid === F.A1), '08 no ve A1 (su sucursal es 06), aunque el acreedor está en su catálogo');
    check(await falla(svc.bandeja('5')) === 400, '⛔ sucursal mal escrita → 400');

    // ── C. El alcance lo decide el servidor (ScopeService) ───────────────────────────────────────
    console.log('\n— C. El alcance por sucursal lo decide el servidor');
    alcance.visibles = ['06'];
    check(await falla(svc.bandeja('00')) === 403, '⛔ quien sólo ve 06 pide la bandeja de 00 → 403');
    check(await falla(svc.bandeja('08')) === 403, '⛔ … y la de 08 → 403');
    check((await svc.bandeja('06')).por_registrar.some((f) => f.uuid === F.A1), 'la de 06 sí');
    check(await falla(svc.detalle(F.C1, '06')) === 404, '⛔ el detalle de una factura que 06 no ve (C1) → 404');
    check(await falla(svc.xml(F.C1, '06')) === 404, '⛔ … ni su XML');
    check(await falla(svc.descartar(F.A1, PARA_TODAS('08'), QUIEN)) === 403, '⛔ sacar una factura desde una sucursal que no le toca → 403');
    alcance.visibles = null;

    // ── D. El detalle y el XML ──────────────────────────────────────────────────────────────────
    console.log('\n— D. El detalle y el XML (con el permiso de la bandeja, sólo de facturas de gasto)');
    const det = await svc.detalle(F.A1, '06');
    check(det.por_registrar?.uuid === F.A1 && det.conceptos.length === 2 && det.conceptos[0].descripcion === 'DIESEL DE PRUEBA' && det.tiene_xml,
      'el detalle trae los conceptos del XML', det.conceptos);
    const detReg = await svc.detalle(F.A2, '06');
    check(detReg.registrada?.registro.documento?.folio === '0990101' && detReg.por_registrar === null, 'el detalle de una registrada dice qué documento la cubre');
    const x = await svc.xml(F.A1, '06');
    check(/DIESEL DE PRUEBA/.test(x.xml) && x.nombre === `${RFC_A}_A-501.xml`, 'el XML se descarga como RFC_SERIE-FOLIO.xml', x.nombre);
    check(await falla(svc.xml(F.D1, '00')) === 404, '⛔ el XML de una factura de compras NO se abre por aquí → 404');
    check(await falla(svc.detalle(F.D1, '00')) === 404, '⛔ el detalle de una factura de compras → 404');
    check(await falla(svc.detalle('no-es-uuid', '06')) === 400, '⛔ un UUID mal escrito → 400');

    // ── E. Sacar de la bandeja, con el payload de la pantalla (regla 13) — y con la lectura guardada ────
    console.log('\n— E. Sacar de la bandeja y regresarla (escribe), con el mismo servicio y su lectura guardada');
    const des = await svc.descartar(F.A1, PARA_TODAS('06'), QUIEN);
    check(des.uuid === F.A1 && des.alcance === 'todas' && des.motivo === 'No es un gasto de la empresa' && des.por === QUIEN, 'sacar «para todas» devuelve lo guardado', des);
    const fila = await knex('finance.expense_sat_invoice_dismissals').where({ tenant_id: T, cfdi_uuid: F.A1 }).whereNull('undone_at').first();
    check(fila?.reason === 'No es un gasto de la empresa' && fila.scope === 'todas' && fila.created_by === QUIEN && fila.sucursal === '06', 'quedó en la tabla, con su tenant, alcance, motivo y quién', fila);
    const tras = await svc.bandeja('06');
    check(!tras.por_registrar.some((f) => f.uuid === F.A1) && tras.descartadas.some((f) => f.uuid === F.A1 && f.alcance === 'todas'),
      'sale de «por registrar» y aparece en las descartadas EN ESE MOMENTO (misma lectura guardada: los descartes no esperan al minuto)');
    check((await svc.bandeja('00')).descartadas.some((f) => f.uuid === F.A1), '00 también la ve en descartadas');
    check(await falla(svc.descartar(F.A1, PARA_TODAS('06'), 'Otra Persona')) === 409, '⛔ sacarla otra vez → 409');
    check(await falla(svc.descartar(F.A2, PARA_TODAS('06'), QUIEN)) === 409, '⛔ sacar una ya registrada → 409 (no hace falta)');
    check(await falla(svc.descartar(F.C1, { sucursal: '00', alcance: 'todas', motivo: ' ' }, QUIEN)) === 400, '⛔ «para todas» sin motivo → 400');
    check(await falla(svc.descartar(F.C1, { sucursal: '00', alcance: 'todas', motivo: '👍👍' }, QUIEN)) === 400, '⛔ un motivo de 2 caracteres reales (emoji) → 400, no 500');
    check(await falla(svc.descartar(F.C1, PARA_TODAS('00'), '')) === 400, '⛔ sin quién → 400');
    check(await falla(svc.descartar(F.C1, { sucursal: '00', alcance: 'sucursal', motivo: '' }, QUIEN)) === 400, '⛔ «no es de esta sucursal» desde 00 → 400');
    check(await falla(svc.descartar(F.D1, PARA_TODAS('00'), QUIEN)) === 404, '⛔ una factura de compras → 404');
    const rest = await svc.restaurar(F.A1, '06', QUIEN);
    const fila2 = await knex('finance.expense_sat_invoice_dismissals').where({ tenant_id: T, cfdi_uuid: F.A1 }).first();
    check(rest.restaurada && fila2?.undone_by === QUIEN && fila2.undone_at, 'regresarla deja quién y cuándo (nada se borra)', fila2);
    check((await svc.bandeja('06')).por_registrar.some((f) => f.uuid === F.A1), 'vuelve a «por registrar» en ese momento');
    check(await falla(svc.restaurar(F.A1, '06', QUIEN)) === 404, '⛔ regresar lo que no está descartado → 404');

    // ── F. «No es de esta sucursal» y «para todas» con dos sucursales candidatas ─────────────────
    console.log('\n— F. Una factura sin sucursal clara (la ven 06, 08 y 00): los dos alcances');
    const ve = async (s) => { const b = await svc.bandeja(s); return { por: b.por_registrar.find((f) => f.uuid === F.E1), des: b.descartadas.find((f) => f.uuid === F.E1) }; };
    const e06 = await ve('06');
    check(!!e06.por && e06.por.sucursal.via === 'empate' && (await ve('08')).por && (await ve('00')).por, 'E1 empata entre 06 y 08: la ven 06, 08 y 00', e06.por?.sucursal);
    await svc.descartar(F.E1, DE_AQUI_NO('08'), QUIEN);
    const tras08 = await ve('08');
    const tras06 = await ve('06');
    const tras00 = await ve('00');
    check(!tras08.por && tras08.des?.alcance === 'sucursal' && tras08.des.motivo === 'No es de esta sucursal', '«no es de esta sucursal» desde 08: sale de 08 y queda en SUS descartadas', tras08);
    check(!!tras06.por && tras06.por.avisos.some((a) => /08 dijo que no es de su sucursal/.test(a)), '… 06 la sigue viendo por registrar, con el aviso de 08', tras06.por?.avisos);
    check(!!tras00.por, '… y 00 también');
    await svc.restaurar(F.E1, '08', QUIEN);
    check(!!(await ve('08')).por, 'regresarla desde 08 la devuelve a 08');
    await svc.descartar(F.E1, PARA_TODAS('08'), QUIEN);
    const t06 = await ve('06');
    const t00 = await ve('00');
    check(!t06.por && t06.des?.alcance === 'todas' && t00.des?.alcance === 'todas',
      '⛔ «para todas» desde 08: 06 (la otra dueña) la ve en SUS descartadas —con quién y por qué— y 00 también', { t06, t00 });
    await svc.restaurar(F.E1, '06', QUIEN);
    check(!!(await ve('06')).por && !!(await ve('08')).por, 'la dueña la puede regresar: vuelve para 06 y 08');

    // ── G. Lo fresco: un vale que llega DESPUÉS de la primera lectura ───────────────────────────
    console.log('\n— G. Un vale con la factura que llega después de la lectura guardada');
    await vale({ cfdi_uuid: F.A1 });
    check(reg(await svc.bandeja('06')).get(F.A1)?.senal === 'suite', 'en ese momento pasa a registrada (señal 0), sin esperar al minuto');

    // ── G2. [PGP.123] H13: el registro se guarda entre peticiones; lo que lo cambia lo vuelve a calcular ──────────
    console.log('\n— G2. El registro guardado: una factura sacada ANTES de la lectura vuelve a competir al regresarla');
    await cfdi(F.K1, { rfc: RFC_A, total: 1234.56, folio: '516' });
    await nuevo().descartar(F.K1, PARA_TODAS('06'), QUIEN);
    // Su gasto llega a Kepler mientras está sacada: la lectura nueva se calcula SIN ella y el gasto queda libre.
    await sembrar('kdm1', [doc({ tipo: 15, folio: '0990130', fecha: diasDesde(d0, 2), acr: 'GZS13A', total: 1234.56 })]);
    const svcG = nuevo();
    check((await svcG.bandeja('06')).descartadas.some((f) => f.uuid === F.K1), 'K1 sacada para todas: en descartadas de la lectura nueva');
    check(!reg(await svcG.bandeja('06')).has(F.K1), '… y la segunda petición (registro guardado) dice lo mismo');
    await svcG.restaurar(F.K1, '06', QUIEN);
    const k1 = reg(await svcG.bandeja('06')).get(F.K1);
    check(k1?.senal === 'difusa' && k1.documento?.folio === '0990130',
      '⛔ al regresarla vuelve a competir y toma su gasto: el registro guardado no la deja «por registrar»', k1);

    // ── H. RLS y los candados de la tabla, versionados ───────────────────────────────────────────
    console.log('\n— H. RLS entre tenants y los candados de la tabla de descartes');
    const comoOtro = (fn) => knex.transaction(async (trx) => { await trx.raw(`SET LOCAL ROLE ${ROL_API}`); await trx.raw(`SET LOCAL app.tenant_id = '${OTRO_TENANT}'`); return fn(trx); });
    await svc.descartar(F.C1, PARA_TODAS('00'), QUIEN);
    check(Number((await comoOtro((trx) => trx('finance.expense_sat_invoice_dismissals').count({ n: '*' })))[0].n) === 0, '⛔ otro tenant no ve los descartes de éste (RLS)');
    check(await falla(comoOtro((trx) => trx('finance.expense_sat_invoice_dismissals').insert({ tenant_id: T, cfdi_uuid: F.B1, sucursal: '06', scope: 'todas', reason: 'intruso', created_by: 'x' }))) === '42501',
      '⛔ otro tenant no puede escribir un descarte a nombre de éste (WITH CHECK)');
    const candado = (p) => falla(knex.transaction(async (trx) => {
      await trx('finance.expense_sat_invoice_dismissals').insert({ tenant_id: T, cfdi_uuid: F.B1, sucursal: '06', scope: 'todas', reason: 'motivo de prueba', created_by: 'x', ...p });
      throw Object.assign(new Error('sin error'), { code: 'NINGUNO' });
    }));
    check(await candado({ scope: 'sucursal', sucursal: '00' }) === '23514', '⛔ «no es de esta sucursal» desde 00 → CHECK de la base');
    check(await candado({ cfdi_uuid: F.B1.toUpperCase() }) === '23514', '⛔ UUID en mayúsculas → CHECK de la base');
    check(await candado({ reason: ' ' }) === '23514', '⛔ sin motivo → CHECK de la base');
  } finally {
    // ── Limpieza: exactamente lo que se creó ─────────────────────────────────────────────────────
    alcance.visibles = null;
    const err = (q) => q.catch((e) => console.log(`  ! limpieza: ${e.message}`));
    await err(knex('finance.expense_sat_invoice_dismissals').where({ tenant_id: T }).whereIn('cfdi_uuid', Object.values(F)).del());
    await err(knex('fiscal.cfdis').where({ tenant_id: T }).whereIn('uuid', Object.values(F)).del());
    if (vales.length) await err(knex('finance.expense_proofs').whereIn('id', vales).del());
    for (const [tabla, ctids] of Object.entries(sembradas)) {
      if (ctids.length) await err(knex.raw(`DELETE FROM kepler_ods.${tabla} WHERE ctid = ANY(?::tid[])`, [ctids]));
    }
    const quedan = Number((await knex('fiscal.cfdis').where({ tenant_id: T }).whereIn('uuid', Object.values(F)).count({ n: '*' }))[0].n);
    check(quedan === 0, 'limpieza: las facturas, los vales, los descartes y el ODS sembrados se borraron', quedan);
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
