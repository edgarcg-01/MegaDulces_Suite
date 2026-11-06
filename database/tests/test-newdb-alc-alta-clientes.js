#!/usr/bin/env node
'use strict';
/**
 * `[ALC.2]` — El servicio REAL del alta de clientes, contra Postgres real, como `app_runtime`.
 *
 * ⛔ Regla 13: un endpoint que escribe no está probado hasta ejercerlo contra base real con el
 * payload de la pantalla. Carga `customer-onboarding.service.ts` (ts-node + alias de
 * `tsconfig.base.json`), con RLS y grants de verdad, y le manda la forma del body de la pantalla.
 *
 *   1. Revisar y crear de contado → «lista para Kepler», folio ALC-…; el mismo RFC otra vez → 409.
 *   2. RFC que ya está en Kepler: sin confirmar → 409 con el duplicado; confirmado y con crédito →
 *      «crédito por aprobar».
 *   3. Crédito: sin la llave → 403; sin motivo → 400; aprobado → «lista para Kepler» con la decisión.
 *   4. Bandeja: la solicitud con RFC en Kepler trae su coincidencia; otro tenant no ve nada (RLS).
 *   5. Ligar: clave que Kepler no tiene → 404; clave con otro RFC → 409; la buena crea la ficha
 *      `K<sucursal>-<clave>` con RFC, razón social, régimen y CP fiscal, y deja escrita la
 *      diferencia de crédito entre Kepler y lo aprobado.
 *   6. Cancelar con motivo; cancelar otra vez → 409.
 *   7. ⛔ Prueba NEGATIVA de la regla: un RFC con un carácter cambiado NO se guarda (400).
 *
 * Datos ficticios o públicos (RFC de prueba del SAT, CURP de ejemplo de RENAPO). Si la base no trae
 * las tablas del ODS que usa el alta (el CI no las tiene: las crea la ingesta), se crean mínimas
 * DENTRO de la transacción. Todo en UNA transacción que se revierte, y se prueba el rollback.
 * Lo que NO mide: la capa HTTP (guardias, el parseo del body) ni el almacén de la constancia.
 * ⛔ No se corre con el `.env` por defecto: apunta a producción. Corre en el job `pruebas-db`.
 */
const path = require('path');
const { randomUUID } = require('crypto');
const RAIZ = path.resolve(__dirname, '..', '..');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_TENANT = '00000000-0000-0000-0000-0000000a1c00';
const ME = randomUUID();
const SUC = '07';
let pass = 0, fail = 0, nm = 0;
const nada = () => undefined;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Servicio, fichaDesdeConstancia;
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-alc-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ CustomerOnboardingService: Servicio } = require(path.join(RAIZ, 'libs/commercial/src/lib/customer-onboarding/customer-onboarding.service.ts')));
  ({ fichaDesdeConstancia } = require(path.join(RAIZ, 'libs/commercial/src/lib/customer-onboarding/ficha-kepler.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-alc-alta-clientes');

/** El código HTTP de la excepción de Nest (o el mensaje si no es una). */
async function status(fn) {
  try { await fn(); return 200; } catch (e) { return typeof e.getStatus === 'function' ? e.getStatus() : (e.code || e.message); }
}

/** Tablas del ODS que lee el alta: si no existen (CI), mínimas dentro de la transacción. */
const ODS = {
  kdud: `sucursal text NOT NULL, ${Array.from({ length: 30 }, (_, i) => `c${i + 1} ${[15, 16, 28, 29].includes(i + 1) ? 'numeric' : 'text'}`).join(', ')}`,
  kduv: 'sucursal text NOT NULL, c1 text, c2 text, c3 text',
  kduj: 'sucursal text NOT NULL, c1 text, c2 text, c3 text',
  kduk: 'sucursal text NOT NULL, c1 text, c2 text',
  kdfe33satrf: 'sucursal text NOT NULL, c1 text, c2 text, c3 text, c4 text, c5 timestamp, c6 timestamp',
  kdfe33satcp: 'sucursal text NOT NULL, c1 text, c2 text, c3 text, c4 text',
};

/** La forma del body que manda la pantalla (lo que arma la ficha desde la constancia). */
function payload(extra = {}) {
  const constancia = {
    tipo: 'fisica', rfc: 'CACX7605101P8', curp: 'HEGG560427MVZRRL04', nombre: 'GLORIA', primer_apellido: 'HERNANDEZ',
    segundo_apellido: 'GARCIA', razon_social: null, regimen_capital: null, nombre_comercial: null,
    nombre_fiscal: 'GLORIA HERNANDEZ GARCIA', estatus_padron: 'ACTIVO', inicio_operaciones: null, ultimo_cambio_estado: null,
    domicilio: { codigo_postal: '58000', tipo_vialidad: 'AVENIDA (AV.)', vialidad: 'PRUEBA ALC', numero_exterior: '1', numero_interior: null,
      colonia: 'CENTRO', localidad: 'MORELIA', municipio: 'MORELIA', entidad: 'MICHOACAN DE OCAMPO', entre_calle: null, y_calle: null },
    regimenes: [], emitida_el: '2026-01-28', lugar_emision: null, id_cif: null,
  };
  const { ficha } = fichaDesdeConstancia(constancia);
  return {
    branch: SUC, origen: 'manual', tipo_persona: 'fisica', rfc: 'CACX7605101P8', curp: 'HEGG560427MVZRRL04',
    nombre_fiscal: 'GLORIA HERNANDEZ GARCIA', regimen_fiscal: '612', codigo_postal_fiscal: '58000', ficha,
    vendedor_code: 'ZV1', grupo_code: 'ZG1', zona_code: 'ZZ1', credito_solicitado: 0, plazo_dias: 0, descuento_pct: 0,
    ...extra,
  };
}

(async () => {
  try {
    console.log('\n[ALC.2] Alta de clientes — el servicio REAL que escribe, como app_runtime\n');
    const id = (await knex.raw('SELECT system_identifier::text sid, current_database() db FROM pg_control_system()')).rows[0];
    console.log(`   base ${id.db} · system_identifier ${id.sid}`);
    const hayTabla = (await knex.raw(`SELECT to_regclass('commercial.customer_onboarding_requests') t`)).rows[0].t;
    if (!hayTabla) { noMedido('la base no tiene commercial.customer_onboarding_requests (falta la migración 20261104235236)'); return; }

    const creadas = [];
    await knex.transaction(async (trx) => {
      // ── Siembra (como el dueño, antes de bajar a app_runtime) ─────────────────────────────
      for (const [t, cols] of Object.entries(ODS)) {
        const existe = (await trx.raw(`SELECT to_regclass(?) r`, [`kepler_ods.${t}`])).rows[0].r;
        if (!existe) { await trx.raw(`CREATE TABLE kepler_ods.${t} (${cols})`); console.log(`   (kepler_ods.${t} no existía: creada mínima dentro de la transacción)`); }
        await trx.raw(`GRANT SELECT ON kepler_ods.${t} TO app_runtime`);
      }
      const sembrar = async (t, cols, vals, donde) => {
        const ya = (await trx.raw(`SELECT 1 FROM kepler_ods.${t} WHERE ${donde.sql} LIMIT 1`, donde.args)).rows.length;
        if (!ya) await trx.raw(`INSERT INTO kepler_ods.${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
      };
      await sembrar('kdfe33satrf', ['sucursal', 'c1', 'c2', 'c3', 'c4'], ['00', '612', 'Personas Físicas con Actividades Empresariales y Profesionales', 'Sí', 'No'], { sql: `sucursal='00' AND c1='612'`, args: [] });
      await sembrar('kdfe33satrf', ['sucursal', 'c1', 'c2', 'c3', 'c4'], ['00', '601', 'General de Ley Personas Morales', 'No', 'Sí'], { sql: `sucursal='00' AND c1='601'`, args: [] });
      await sembrar('kdfe33satcp', ['sucursal', 'c1', 'c2'], ['00', '58000', 'MIC'], { sql: `sucursal='00' AND c1='58000'`, args: [] });
      await sembrar('kduv', ['sucursal', 'c2', 'c3'], [SUC, 'ZV1', 'VENDEDOR DE PRUEBA ALC'], { sql: 'sucursal=? AND c2=?', args: [SUC, 'ZV1'] });
      await sembrar('kduj', ['sucursal', 'c1', 'c2'], [SUC, 'ZG1', 'GRUPO DE PRUEBA ALC'], { sql: 'sucursal=? AND c1=?', args: [SUC, 'ZG1'] });
      await sembrar('kduk', ['sucursal', 'c1', 'c2'], [SUC, 'ZZ1', 'ZONA DE PRUEBA ALC'], { sql: 'sucursal=? AND c1=?', args: [SUC, 'ZZ1'] });
      // Dos fichas de Kepler ficticias: una con el RFC de prueba del SAT, otra con otro RFC.
      await trx.raw(`DELETE FROM kepler_ods.kdud WHERE c2 IN ('ALC901','ALC902')`);
      await trx.raw(`INSERT INTO kepler_ods.kdud (sucursal, c2, c3, c10, c15, c16, c17) VALUES
        (?, 'ALC901', 'ESCUELA KEMPER URGATE', 'EKU9003173C9', 0, 0, '0'),
        (?, 'ALC902', 'OTRO CLIENTE DE PRUEBA', 'XEXX010101000', 0, 0, '0')`, [SUC, SUC]);
      await trx.raw(`DELETE FROM commercial.customers WHERE erp_source_branch = ? AND erp_customer_code IN ('ALC901','ALC902')`, [SUC]);

      // ── Como la API: app_runtime con el tenant fijado ─────────────────────────────────────
      await trx.raw('SET LOCAL ROLE app_runtime');
      const fijarTenant = (t) => trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]);
      await fijarTenant(T);
      let puedeCredito = false;
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log: nada, warn: nada, error: nada, debug: nada },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: ME, roleName: 'credito_cobranza' }) },
        scope: { readParam: async () => null, warehouseIds: async () => null },
        storage: { isConfigured: () => false },
        nuevos: { link: async () => { throw new Error('el caso V- no se ejerce aquí'); } },
        // Cada llamada en su SAVEPOINT: un error de la base no aborta la transacción de la prueba.
        tk: { run: async (fn) => {
          await trx.raw('SAVEPOINT sp_alc');
          try { const r = await fn(trx); await trx.raw('RELEASE SAVEPOINT sp_alc'); return r; }
          catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_alc'); throw e; }
        } },
      });
      const actor = () => ({ userId: ME, roleName: 'credito_cobranza', puedeCredito });

      // 0. Catálogos
      const cat = await s.catalogos(SUC);
      ok(cat.regimenes.some((r) => r.clave === '612' && r.persona_fisica && !r.persona_moral), 'catálogos: el régimen 612 llega del ODS con su bandera física/moral');

      // 1. Revisar y crear de contado
      const rev = await s.revisar(payload());
      ok(!rev.hallazgos.some((h) => h.gravedad === 'bloquea'), 'revisar: la solicitud de la pantalla no bloquea', rev.hallazgos);
      const a = await s.crear(payload());
      creadas.push(a.solicitud.id);
      ok(a.solicitud.estado === 'lista_para_kepler' && /^ALC-\d{5,}$/.test(a.solicitud.folio), `crear de contado → lista para Kepler (${a.solicitud.folio})`);
      ok(a.solicitud.ficha.direccion_1 === 'AV. PRUEBA ALC 1' && a.solicitud.regimen_fiscal === '612', 'la ficha y lo fiscal quedan como se capturaron');
      ok(await status(() => s.crear(payload())) === 409, 'el mismo RFC con una solicitud abierta → 409');

      // 7. Prueba NEGATIVA: un carácter cambiado no se guarda
      const malo = payload({ rfc: 'CACX7605101P9' });
      ok(await status(() => s.crear({ ...malo, ficha: { ...malo.ficha, rfc: 'CACX7605101P9' } })) === 400, 'NEGATIVA: RFC con el dígito verificador mal → 400, no se guarda');

      // 2. RFC que ya está en Kepler
      const moral = payload({ tipo_persona: 'moral', rfc: 'EKU9003173C9', curp: null, nombre_fiscal: 'ESCUELA KEMPER URGATE', regimen_fiscal: '601',
        credito_solicitado: 5000, plazo_dias: 15 });
      moral.ficha = { ...moral.ficha, rfc: 'EKU9003173C9', curp: '', nombre: 'ESCUELA KEMPER URGATE' };
      ok(await status(() => s.crear(moral)) === 409, 'RFC que ya tiene ficha en Kepler, sin confirmar → 409');
      const b = await s.crear({ ...moral, confirmar_duplicado: true });
      creadas.push(b.solicitud.id);
      ok(b.solicitud.estado === 'credito_por_aprobar', 'confirmado y con crédito → crédito por aprobar');
      ok(b.revision.duplicados.some((d) => d.clave === 'ALC901' && d.por === 'rfc'), 'la revisión nombra la ficha de Kepler que ya tiene ese RFC');

      // 3. Crédito
      ok(await status(() => s.decidirCredito(b.solicitud.id, { decision: 'aprobado', motivo: 'buen historial' }, actor())) === 403, 'decidir crédito sin la llave → 403');
      puedeCredito = true;
      ok(await status(() => s.decidirCredito(b.solicitud.id, { decision: 'aprobado', motivo: '' }, actor())) === 400, 'sin motivo → 400');
      const c = await s.decidirCredito(b.solicitud.id, { decision: 'aprobado', motivo: 'referencias comerciales verificadas', credito_aprobado: 3000, plazo_aprobado: 15 }, actor());
      ok(c.estado === 'lista_para_kepler' && c.credito?.credito_aprobado === 3000 && c.credito?.plazo_aprobado === 15 && c.credito?.por === ME,
        'aprobado → lista para Kepler, con lo aprobado y quién lo firmó', c.credito);
      ok(await status(() => s.decidirCredito(b.solicitud.id, { decision: 'rechazado', motivo: 'otra vez' }, actor())) === 409, 'decidir dos veces → 409');

      // 4. Bandeja y RLS
      const bandeja = await s.bandeja({}, actor());
      const enBandeja = bandeja.solicitudes.find((x) => x.id === b.solicitud.id);
      ok(!!enBandeja && enBandeja.coincidencias_kepler.some((k) => k.clave === 'ALC901'), 'bandeja: la solicitud con RFC en Kepler trae su coincidencia (ligar es un clic)');
      ok(bandeja.puede_aprobar_credito === true && bandeja.conteo.lista_para_kepler >= 2, 'bandeja: conteo por estado y la llave de crédito');
      await fijarTenant(OTRO_TENANT);
      const ajena = await trx.raw(`SELECT count(*)::int n FROM commercial.customer_onboarding_requests WHERE id = ANY(?)`, [creadas]);
      ok(ajena.rows[0].n === 0, 'RLS: otro tenant no ve las solicitudes');
      await fijarTenant(T);

      // 5. Ligar
      ok(await status(() => s.ligar(a.solicitud.id, { erp_customer_code: 'NOEXISTE9' })) === 404, 'ligar con una clave que Kepler no tiene → 404');
      ok(await status(() => s.ligar(b.solicitud.id, { erp_customer_code: 'ALC902' })) === 409, 'ligar con una clave de otro RFC → 409');
      const l = await s.ligar(b.solicitud.id, { erp_customer_code: 'ALC901' });
      ok(l.estado === 'ligada' && l.erp_customer_code === 'ALC901' && !!l.customer_id, 'ligar con la clave buena → ligada, con su ficha de la Suite');
      const cli = (await trx.raw(`SELECT code, rfc, legal_name, regimen_fiscal, billing_address->>'zip' zip, erp_source_branch FROM commercial.customers WHERE id = ?`, [l.customer_id])).rows[0];
      ok(cli && cli.code === `K${SUC}-ALC901` && cli.rfc === 'EKU9003173C9' && cli.legal_name === 'ESCUELA KEMPER URGATE' && cli.regimen_fiscal === '601' && cli.zip === '58000',
        'la ficha de la Suite nace K<sucursal>-<clave> con RFC, razón social, régimen y CP fiscal', cli);
      ok(/Kepler tiene límite \$0\.00/.test(l.comentarios || ''), 'la diferencia entre el crédito de Kepler y lo aprobado queda escrita', l.comentarios);
      ok(await status(() => s.ligar(b.solicitud.id, { erp_customer_code: 'ALC901' })) === 409, 'ligar dos veces → 409');

      // 6. Cancelar
      ok(await status(() => s.cancelar(a.solicitud.id, 'no')) === 400, 'cancelar sin motivo → 400');
      const x = await s.cancelar(a.solicitud.id, 'el cliente ya no quiso factura');
      ok(x.estado === 'cancelada', 'cancelar con motivo → cancelada');
      ok(await status(() => s.cancelar(a.solicitud.id, 'otra vez más')) === 409, 'cancelar dos veces → 409');

      throw Object.assign(new Error('rollback'), { esRollback: true });
    }).catch((e) => { if (!e.esRollback) throw e; });

    // Con el tenant fijado: la tabla tiene FORCE RLS y un usuario que no la salte vería 0 aunque hubiera filas.
    const quedaron = await knex.transaction(async (t) => {
      await t.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      return (await t.raw(`SELECT count(*)::int n FROM commercial.customer_onboarding_requests WHERE id = ANY(?)`, [creadas])).rows[0].n;
    });
    ok(creadas.length > 0 && quedaron === 0, 'ROLLBACK real: no quedó ninguna solicitud de la prueba');
  } catch (e) {
    fail++;
    console.log('  ✗ error inesperado:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  }
})();
