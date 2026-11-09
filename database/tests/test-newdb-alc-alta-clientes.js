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
 *   8. `[ALC.2.8]` Escribir en Kepler (D1-b), con un DOBLE de Kepler (en el CI no hay ERP) y todo lo
 *      de la Suite real: sin la llave → 403; interruptor apagado → 409 sin consultar Kepler; un
 *      intento parcial reserva la clave; otra solicitud no se lleva la misma (índice único); una
 *      clave ajena suelta la reserva; el reintento usa la MISMA clave; escrita no se repite ni se
 *      cancela; el tope diario; ligar sin teclear la clave. Y `[ALC.3.6]`: estado del CP, uso y forma.
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
  // [ALC.3.6] Lo que Kepler guarda en kdfedir: estado del CP, uso de CFDI y forma de pago.
  kdfe33satedo: 'sucursal text NOT NULL, c1 text, c2 text, c3 text',
  kdfe33satuso: 'sucursal text NOT NULL, c1 text, c2 text, c3 text, c4 text, c5 timestamp, c6 timestamp, c7 text',
  kdfe33satfopg: 'sucursal text NOT NULL, c1 text, c2 text',
};
const SERVIDORES = ['SC', '00', '01', '02', '03', '04', '05', '06', '07', '08'];

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
      await sembrar('kdfe33satrf', ['sucursal', 'c1', 'c2', 'c3', 'c4'], ['00', '616', 'Sin obligaciones fiscales', 'Sí', 'No'], { sql: `sucursal='00' AND c1='616'`, args: [] });
      await sembrar('kdfe33satedo', ['sucursal', 'c1', 'c2', 'c3'], ['00', 'MIC', 'MEX', 'Michoacán'], { sql: `sucursal='00' AND c1='MIC' AND c2='MEX'`, args: [] });
      await sembrar('kdfe33satuso', ['sucursal', 'c1', 'c2', 'c7'], ['00', 'G01', 'Adquisición de mercancías.', '601, 603, 606, 612, 620, 621, 622, 623, 624, 625,626'], { sql: `sucursal='00' AND c1='G01'`, args: [] });
      await sembrar('kdfe33satuso', ['sucursal', 'c1', 'c2', 'c7'], ['00', 'S01', 'Sin efectos fiscales.', '601, 603, 605, 606, 608, 610, 611, 612, 614, 616, 620, 621, 622, 623, 624, 607, 615, 625, 626'], { sql: `sucursal='00' AND c1='S01'`, args: [] });
      await sembrar('kdfe33satfopg', ['sucursal', 'c1', 'c2'], ['00', '01', 'Efectivo'], { sql: `sucursal='00' AND c1='01'`, args: [] });
      await sembrar('kdfe33satfopg', ['sucursal', 'c1', 'c2'], ['00', '99', 'Por definir'], { sql: `sucursal='00' AND c1='99'`, args: [] });
      // [ALC.2.8] La cartera de verdad de Morelia (zona 20000, piso de Morelia Abastos, su vendedor de piso).
      await sembrar('kduv', ['sucursal', 'c2', 'c3'], [SUC, '20002', 'SUC MORELIA ABASTOS PISO'], { sql: 'sucursal=? AND c2=?', args: [SUC, '20002'] });
      await sembrar('kduj', ['sucursal', 'c1', 'c2'], [SUC, '2VP01', 'VENTA DE PISO MORELIA ABASTOS'], { sql: 'sucursal=? AND c1=?', args: [SUC, '2VP01'] });
      await sembrar('kduk', ['sucursal', 'c1', 'c2'], [SUC, '20000', 'CLIENTES ZONA MORELIA'], { sql: 'sucursal=? AND c1=?', args: [SUC, '20000'] });
      await trx.raw(`DELETE FROM kepler_ods.kdud WHERE c2 IN ('29990','29991','29992')`);
      await trx.raw(`INSERT INTO kepler_ods.kdud (sucursal, c2, c3, c10, c12, c13, c15, c16, c17) VALUES (?, '29990', 'ULTIMA DE LA SERIE', 'XAXX010101000', '20002', '2VP01', 0, 0, '')`, [SUC]);
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
      let puedeKepler = false;
      // [ALC.2.8] Kepler no existe en el CI: el adaptador es un doble que dice qué le pidieron. Lo que
      // SÍ es real es todo lo de la Suite: marca, reserva con índice único, resultado, tope, ligar.
      const dobleKepler = {
        reservas: [], planes: [], entrega: null, reserva: null,
        servidores: () => SERVIDORES.map((servidor) => ({ servidor, configurado: true, motivo: null })),
        reservarClave: async (serie, reservadas, reservada) => {
          dobleKepler.reservas.push({ serie, reservadas, reservada });
          return dobleKepler.reserva ?? { ok: true, clave: reservada || '29991' };
        },
        entregar: async (plan) => { dobleKepler.planes.push(plan); return dobleKepler.entrega(plan); },
      };
      const todasEscritas = (estado = 'escrita') => () => ({ servidores: SERVIDORES.map((servidor) => ({ servidor, estado, motivo: null })), claveAjena: false });
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log: nada, warn: nada, error: nada, debug: nada },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: ME, roleName: 'credito_cobranza' }) },
        scope: { readParam: async () => null, warehouseIds: async () => null },
        storage: { isConfigured: () => false },
        nuevos: { link: async () => { throw new Error('el caso V- no se ejerce aquí'); } },
        kepler: dobleKepler,
        // Cada llamada en su SAVEPOINT: un error de la base no aborta la transacción de la prueba.
        tk: { run: async (fn) => {
          await trx.raw('SAVEPOINT sp_alc');
          try { const r = await fn(trx); await trx.raw('RELEASE SAVEPOINT sp_alc'); return r; }
          catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_alc'); throw e; }
        } },
      });
      const actor = () => ({ userId: ME, roleName: 'credito_cobranza', puedeCredito, puedeKepler });

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
      ok(a.solicitud.uso_cfdi === 'G01' && a.solicitud.forma_pago === '01', '[ALC.3.6] sin elegirlos, uso G01 y forma 01 (los de costumbre de contado con RFC)', [a.solicitud.uso_cfdi, a.solicitud.forma_pago]);
      ok(await status(() => s.crear(payload())) === 409, 'el mismo RFC con una solicitud abierta → 409');

      // 7. Prueba NEGATIVA: un carácter cambiado no se guarda
      const malo = payload({ rfc: 'CACX7605101P9' });
      ok(await status(() => s.crear({ ...malo, ficha: { ...malo.ficha, rfc: 'CACX7605101P9' } })) === 400, 'NEGATIVA: RFC con el dígito verificador mal → 400, no se guarda');

      // 2. RFC que ya está en Kepler
      const moral = payload({ tipo_persona: 'moral', rfc: 'EKU9003173C9', curp: null, nombre_fiscal: 'ESCUELA KEMPER URGATE', regimen_fiscal: '601',
        credito_solicitado: 5000, plazo_dias: 15 });
      moral.ficha = { ...moral.ficha, rfc: 'EKU9003173C9', curp: '', nombre: 'ESCUELA KEMPER URGATE' };
      ok(await status(() => s.crear(moral)) === 409, 'RFC que ya tiene ficha en Kepler, sin confirmar → 409');
      // [ALC.3.5] Negativa: una coordenada imposible no se guarda (la revisión bloquea → 400).
      ok(await status(() => s.crear({ ...moral, confirmar_duplicado: true, ubicacion: { lat: 120, lng: -101.19, origen: 'mapa' } })) === 400,
        'NEGATIVA [ALC.3.5]: latitud 120 → 400, no se guarda');
      const b = await s.crear({ ...moral, confirmar_duplicado: true, ubicacion: { lat: 19.702701, lng: -101.192398, origen: 'gps', precision_m: 12.4 } });
      creadas.push(b.solicitud.id);
      ok(b.solicitud.estado === 'credito_por_aprobar', 'confirmado y con crédito → crédito por aprobar');
      ok(b.solicitud.ubicacion && b.solicitud.ubicacion.lat === 19.702701 && b.solicitud.ubicacion.lng === -101.192398
        && b.solicitud.ubicacion.origen === 'gps' && b.solicitud.ubicacion.precision_m === 12.4,
        '[ALC.3.5] la ubicación del GPS queda guardada con su precisión', b.solicitud.ubicacion);
      ok(a.solicitud.ubicacion === null, '[ALC.3.5] sin ubicación se da de alta igual (es opcional)');
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
      const cli = (await trx.raw(`SELECT code, rfc, legal_name, regimen_fiscal, billing_address->>'zip' zip, erp_source_branch, latitude::float8 lat, longitude::float8 lng FROM commercial.customers WHERE id = ?`, [l.customer_id])).rows[0];
      ok(cli && cli.lat === 19.702701 && cli.lng === -101.192398, '[ALC.3.5] al ligar, la ubicación pasa a la ficha de la Suite', cli);
      ok(cli && cli.code === `K${SUC}-ALC901` && cli.rfc === 'EKU9003173C9' && cli.legal_name === 'ESCUELA KEMPER URGATE' && cli.regimen_fiscal === '601' && cli.zip === '58000',
        'la ficha de la Suite nace K<sucursal>-<clave> con RFC, razón social, régimen y CP fiscal', cli);
      ok(/Kepler tiene límite \$0\.00/.test(l.comentarios || ''), 'la diferencia entre el crédito de Kepler y lo aprobado queda escrita', l.comentarios);
      ok(await status(() => s.ligar(b.solicitud.id, { erp_customer_code: 'ALC901' })) === 409, 'ligar dos veces → 409');

      // 6. Cancelar
      ok(await status(() => s.cancelar(a.solicitud.id, 'no')) === 400, 'cancelar sin motivo → 400');
      const x = await s.cancelar(a.solicitud.id, 'el cliente ya no quiso factura');
      ok(x.estado === 'cancelada', 'cancelar con motivo → cancelada');
      ok(await status(() => s.cancelar(a.solicitud.id, 'otra vez más')) === 409, 'cancelar dos veces → 409');

      // 8. [ALC.2.8] Escribir en Kepler (D1-b). Sin RFC, de contado, en Morelia, con el estado mal escrito.
      const sinRfc = payload({
        rfc: 'XAXX010101000', curp: null, nombre_fiscal: 'CLIENTE DE PRUEBA KEPLER', regimen_fiscal: '616',
        vendedor_code: '20002', grupo_code: '2VP01', zona_code: '20000',
      });
      sinRfc.ficha = { ...sinRfc.ficha, rfc: 'XAXX010101000', curp: '', nombre: 'Cliente de Prueba Kepler', estado: 'Michocan', telefono_1: '(443) 555-0101' };
      const k = await s.crear(sinRfc);
      creadas.push(k.solicitud.id);
      ok(k.solicitud.ficha.estado === 'MICHOACAN' && k.revision.hallazgos.some((h) => h.campo === 'ficha.estado'),
        '[ALC.3.6] el estado sale del CP: «Michocan» se guarda MICHOACAN y se dice', [k.solicitud.ficha.estado]);
      ok(k.solicitud.ficha.nombre === 'CLIENTE DE PRUEBA KEPLER' && k.solicitud.ficha.telefono_1 === '4435550101',
        '[ALC.3.6] la ficha queda como la escribe Kepler (mayúsculas; teléfono sólo dígitos)', k.solicitud.ficha);
      ok(k.solicitud.uso_cfdi === 'S01' && k.solicitud.forma_pago === '01', '[ALC.3.6] sin RFC → uso S01');

      const p0 = await s.planKepler(k.solicitud.id, actor());
      ok(p0.clave_propuesta === '29991' && p0.serie?.patron === '2####', 'plan: la clave que sigue en la serie de Morelia de contado (29990 → 29991)', [p0.clave_propuesta, p0.serie]);
      ok(p0.kdud.find((c) => c.columna === 'c6')?.valor === 'MICHOACAN' && p0.kdfedir.find((c) => c.columna === 'c16')?.valor === 'S01',
        'plan: las casillas de kdud y kdfedir con su valor', p0.kdud);
      ok(/llave/.test(p0.bloqueo_escritura || '') && p0.puede_escribir === false, 'plan: sin la llave, se dice por qué no se puede escribir', p0.bloqueo_escritura);
      ok(await status(() => s.escribirEnKepler(k.solicitud.id, actor())) === 403, 'NEGATIVA: escribir sin la llave → 403');
      puedeKepler = true;
      // El interruptor (sembrado APAGADO por la migración): apagado → no se escribe y Kepler ni se toca.
      await trx.raw(`INSERT INTO commercial.kepler_push_switch (tenant_id, sucursal, tipo, encendida, tope_dia) VALUES (?, ?, 'cliente', false, 1)
                     ON CONFLICT (tenant_id, sucursal, tipo) DO UPDATE SET encendida = false, tope_dia = 1`, [T, SUC]);
      const p1 = await s.planKepler(k.solicitud.id, actor());
      ok(/apagada/.test(p1.bloqueo_escritura || ''), 'plan: con el interruptor apagado se dice', p1.bloqueo_escritura);
      ok(await status(() => s.escribirEnKepler(k.solicitud.id, actor())) === 409 && dobleKepler.reservas.length === 0,
        'NEGATIVA: interruptor apagado → 409 y Kepler NO se consultó');
      await trx.raw(`UPDATE commercial.kepler_push_switch SET encendida = true, tope_dia = 1 WHERE sucursal = ? AND tipo = 'cliente'`, [SUC]);

      // Un intento parcial: la 08 rechaza. La clave queda reservada y la solicitud sigue lista.
      dobleKepler.entrega = (plan) => ({ servidores: SERVIDORES.map((servidor) => ({ servidor, estado: servidor === '08' ? 'rechazada' : 'escrita', motivo: servidor === '08' ? 'sin red' : null })), claveAjena: false });
      const w1 = await s.escribirEnKepler(k.solicitud.id, actor());
      const plan1 = dobleKepler.planes[0];
      ok(plan1 && plan1.clave === '29991' && plan1.kdud.c2 === '29991' && plan1.kdfedir.c2 === '29991' && plan1.kdud.c13 === '2VP01',
        'escribir: el adaptador recibe la fila con su clave en kdud.c2 y kdfedir.c2', plan1 && plan1.kdud);
      ok(w1.kepler?.clave === '29991' && w1.kepler.escrita_el === null && w1.kepler.servidores.length === 10 && w1.estado === 'lista_para_kepler',
        'parcial: la clave queda reservada, sin «escrita» y con el resultado de las 10 bases', w1.kepler);
      const marca = (await trx.raw(`SELECT kepler_write_started_at, kepler_write_by FROM commercial.customer_onboarding_requests WHERE id = ?`, [k.solicitud.id])).rows[0];
      ok(marca.kepler_write_started_at === null && marca.kepler_write_by === ME, 'la marca de «escribiendo» se suelta al terminar y queda quién lo intentó', marca);

      // Otra solicitud no puede llevarse la misma clave (índice único), aunque el adaptador se la dé.
      const otra = payload({ rfc: 'XEXX010101000', curp: null, nombre_fiscal: 'OTRO SIN RFC EXTRANJERO', regimen_fiscal: '616',
        vendedor_code: '20002', grupo_code: '2VP01', zona_code: '20000' });
      otra.ficha = { ...otra.ficha, rfc: 'XEXX010101000', curp: '', nombre: 'OTRO SIN RFC EXTRANJERO' };
      const o = await s.crear(otra);
      creadas.push(o.solicitud.id);
      await trx.raw(`UPDATE commercial.kepler_push_switch SET tope_dia = NULL WHERE sucursal = ? AND tipo = 'cliente'`, [SUC]);
      ok(dobleKepler.reservas.length === 1 && dobleKepler.reservas[0].reservadas.length === 0, 'la primera reserva no traía claves ajenas');
      dobleKepler.reserva = { ok: true, clave: '29991' };
      ok(await status(() => s.escribirEnKepler(o.solicitud.id, actor())) === 409, 'NEGATIVA: dos solicitudes no reservan la misma clave (índice único) → 409');
      ok(dobleKepler.reservas[1].reservadas.includes('29991'), 'la segunda reserva ya veía la clave de la primera como ocupada', dobleKepler.reservas[1]);
      dobleKepler.reserva = null;

      // El concentrador dice que la clave es de otro cliente: no se escribió nada → se suelta la reserva.
      dobleKepler.reserva = { ok: true, clave: '29992' };
      dobleKepler.entrega = () => ({ servidores: SERVIDORES.map((servidor) => ({ servidor, estado: 'rechazada', motivo: 'La clave 29992 ya es de otro cliente.' })), claveAjena: true });
      ok(await status(() => s.escribirEnKepler(o.solicitud.id, actor())) === 409, 'clave ajena en el concentrador → 409');
      const ajenaK = (await trx.raw(`SELECT kepler_code FROM commercial.customer_onboarding_requests WHERE id = ?`, [o.solicitud.id])).rows[0];
      ok(ajenaK.kepler_code === null, 'y la reserva se suelta para que el siguiente intento tome otra', ajenaK);
      dobleKepler.reserva = null;

      // Reintento de la primera: MISMA clave, y ahora las 10.
      dobleKepler.entrega = todasEscritas('ya_estaba');
      const w2 = await s.escribirEnKepler(k.solicitud.id, actor());
      ok(dobleKepler.reservas.at(-1).reservada === '29991', 'reintento: el adaptador recibe la clave ya reservada (no inventa otra)', dobleKepler.reservas.at(-1));
      ok(!!w2.kepler?.escrita_el && w2.kepler.clave === '29991', 'reintento completo → escrita en las 10 bases', w2.kepler);
      ok(/Ya está en las 10 bases/.test((await s.planKepler(k.solicitud.id, actor())).bloqueo_escritura || ''), 'escrita: el plan ya no ofrece escribirla otra vez');
      ok(await status(() => s.escribirEnKepler(k.solicitud.id, actor())) === 409, 'NEGATIVA: escribirla dos veces → 409');
      ok(await status(() => s.cancelar(k.solicitud.id, 'ya no la quiero')) === 409, 'NEGATIVA: lo que ya está en Kepler no se cancela desde la Suite');

      // El tope del interruptor: 1 por día y ya hubo una desde esta sucursal.
      await trx.raw(`UPDATE commercial.kepler_push_switch SET tope_dia = 1 WHERE sucursal = ? AND tipo = 'cliente'`, [SUC]);
      ok(/tope/.test((await s.planKepler(o.solicitud.id, actor())).bloqueo_escritura || ''), 'tope de 1 por día: la segunda del día no se escribe');

      // Ligar sin teclear: la clave es la que escribió la Suite (cuando llega al ODS).
      // (la ingesta la trae al ODS: se siembra como el dueño, porque app_runtime sólo LEE kepler_ods)
      await trx.raw('RESET ROLE');
      await trx.raw(`INSERT INTO kepler_ods.kdud (sucursal, c2, c3, c10, c15, c16, c17) VALUES (?, '29991', 'CLIENTE DE PRUEBA KEPLER', 'XAXX010101000', 0, 0, '')`, [SUC]);
      await trx.raw('SET LOCAL ROLE app_runtime');
      const lk = await s.ligar(k.solicitud.id, {});
      ok(lk.estado === 'ligada' && lk.erp_customer_code === '29991', 'ligar sin escribir la clave: toma la que la Suite escribió', [lk.estado, lk.erp_customer_code]);

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
