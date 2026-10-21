/* eslint-disable no-console */
/**
 * `[LC.17]` — Candado del TRÁMITE de «Movimientos no asociados»: los tres endpoints que
 * ESCRIBEN (`generar`, `estado`, y el registro de facturas que hace `generar`) más la descarga.
 *
 * ⛔⛔ Regla 13 de `CLAUDE.md`: un endpoint que escribe no está probado hasta que una prueba lo
 * ejerció contra una base REAL con el payload de la pantalla. Hasta LC.17 estos tres no tenían
 * ninguna: `test-newdb-libro-compras-caratula.js` revisa esquema y texto del código, y
 * `test-newdb-libro-compras-txt.js` sólo el layout.
 *
 * Lo que motivó LC.17, medido en prod el 2026-10-21:
 *   · el complemento de 2026-07 seguía `generado` con su TXT en formato LEGADO (P=147/M=211) y
 *     la descarga lo servía tal cual — ContPAQi lo rechaza;
 *   · `generar` no registraba las facturas incluidas por default, así que la puerta exacta
 *     «ya se entregó» no las veía y el mes las volvía a ofrecer (doble registro);
 *   · `generar` regeneraba encima de una entrega, y `marcar` aceptaba cualquier salto.
 *
 * Dos modos, según contra qué base corre (y lo dice):
 *   destino LOCAL (job `pruebas-db`) → COMPLETO: siembra un mes 2031-03 con postgres, ejerce el
 *     servicio real como `app_runtime` (RLS activo) con el payload de la pantalla, y limpia.
 *   destino PROD → SÓLO LECTURA: las corridas reales de 2026-06/07 se declaran no entregables y
 *     las guardas rechazan ANTES de escribir (la sesión es read-only: si escribieran, fallaría).
 *     Lo demás se declara NO MEDIDO.
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
// Los alias salen del tsconfig y no de una lista a mano: platform-core importa subrutas
// (`@megadulces/contracts/authz/permissions`) que una lista de dos se perdía.
const ALIAS = {};
const fs = require('fs');
for (const m of fs.readFileSync(path.join(ROOT, 'tsconfig.base.json'), 'utf8')
  .matchAll(/"(@megadulces\/[^"]+)"\s*:\s*\[\s*"([^"]+)"/g)) {
  ALIAS[m[1]] = path.join(ROOT, m[2]);
}
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return ALIAS[pedido] ? ALIAS[pedido] : resolveOriginal.call(this, pedido, ...resto);
};

const knexLib = require('knex');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { classify, assertSafeTarget } = require('./_lib/assert-safe-target');

const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'purchase-book');
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const MES = '2031-03';
const RFC = 'LCX170101AAA';
const SUF = '9990017';
const UUIDS = ['1C170000-0000-4000-8000-000000000001', '1C170000-0000-4000-8000-000000000002'];

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log() {}, warn() {}, error() {}, debug() {} };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.17 trámite de no asociados: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

/** El servicio REAL, con un `TenantKnex` mínimo: una transacción con el tenant puesto. */
function servicio(pool) {
  const { PurchaseBookService } = require(path.join(SRC, 'purchase-book.service.ts'));
  const tk = {
    run: async (cb) => pool.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return cb(trx);
    }),
  };
  const ctx = { get: () => ({ userId: null, tenantId: MEGA }), requireTenantId: () => MEGA };
  const svc = new PurchaseBookService(tk, ctx);
  svc.logger = silencio;
  return svc;
}

/** Corre `fn` y devuelve el error (o null). Para afirmar un rechazo con su mensaje. */
async function rechazo(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
const msg = (e) => String((e && (e.response?.message || e.message)) || '');

async function soloLectura(url) {
  console.log('\n[modo SÓLO LECTURA — destino prod]');
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  try {
    const svc = servicio(pool);
    const { vigenciaArchivo, construirTxt } = require(path.join(SRC, 'poliza-txt.ts'));

    console.log('\n[0] La vigencia, sobre un archivo que el emisor escribe HOY');
    const nuevo = construirTxt('20310331', 2, 'CANDADO', [
      { cuenta: '5010000001', referencia: 'A1', abono: false, importe: 10, concepto: '' },
      { cuenta: '2120000001', referencia: 'A1', abono: true, importe: 10, concepto: '' },
    ]);
    check(vigenciaArchivo(nuevo).vigente === true, 'el archivo del emisor actual es entregable');
    const legado = nuevo.split('\r\n').map((l) => (l.startsWith('M1') ? `M ${l.slice(2)}` : l)).join('\r\n');
    check(vigenciaArchivo(legado).vigente === false, '⛔ prueba negativa: con la etiqueta legada «M » deja de ser entregable');
    check(vigenciaArchivo(null).vigente === false, 'sin contenido no es entregable');

    const runs = await pool('finance.purchase_book_runs')
      .where({ tenant_id: MEGA, tipo: 'complemento' }).whereIn('anio_mes', ['2026-06', '2026-07'])
      .whereNull('deleted_at').select('anio_mes', 'estado');
    const jul = runs.find((r) => r.anio_mes === '2026-07');
    const jun = runs.find((r) => r.anio_mes === '2026-06');

    if (jul && jul.estado === 'generado') {
      console.log('\n[1] 2026-07: el TXT guardado tiene el formato legado');
      const d = await svc.getMes('2026-07', 'complemento');
      check(d.run && d.run.archivo_vigente === false, 'la pantalla recibe archivo_vigente = false');
      check(/formato anterior/.test(String(d.run && d.run.archivo_motivo)), `y el motivo: «${String(d.run && d.run.archivo_motivo).slice(0, 60)}…»`);
      check(d.run && !('archivo_contenido' in d.run), 'la pantalla ya no recibe los ~77 KB del archivo');
      const e1 = await rechazo(() => svc.obtenerArchivo('2026-07', 'complemento'));
      check(e1 && /formato anterior/.test(msg(e1)), 'la descarga lo rechaza en vez de servirlo');
      const e2 = await rechazo(() => svc.marcar('2026-07', 'entregado', { tipo: 'complemento', entregado_a: 'candado' }));
      check(e2 && /no se puede marcar entregado/.test(msg(e2)), 'y no se puede marcar entregado (rechaza antes de escribir)');
      const e3 = await rechazo(() => svc.marcar('2026-07', 'aplicado', { tipo: 'complemento' }));
      check(e3 && /no se puede pasar de generado a aplicado/.test(msg(e3)), '⛔ generado → aplicado se rechaza (nadie lo entregó)');
    } else {
      noMedido(`2026-07 ya no está en generado (${jul ? jul.estado : 'sin corrida'}): se regeneró o se movió`);
    }

    if (jun && jun.estado === 'generado') {
      console.log('\n[2] 2026-06: la firma sin el archivo');
      const d = await svc.getMes('2026-06', 'complemento');
      check(d.run && d.run.archivo_vigente === false && /firma/.test(String(d.run.archivo_motivo)),
        'archivo_vigente = false, por la firma sin contenido');
      const e = await rechazo(() => svc.marcar('2026-06', 'entregado', { tipo: 'complemento' }));
      check(e && /no se puede marcar entregado/.test(msg(e)), 'no se puede marcar entregado sin archivo');
    } else {
      noMedido(`2026-06 ya no está en generado (${jun ? jun.estado : 'sin corrida'})`);
    }

    noMedido('generar · registrar las facturas · entregar · cancelar · aplicar: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[modo COMPLETO — destino local]');
  assertSafeTarget('test-newdb-libro-compras-tramite', { url: urlAdmin });
  assertSafeTarget('test-newdb-libro-compras-tramite', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const limpiar = async () => {
    const ids = (await admin('finance.purchase_book_runs').where({ tenant_id: MEGA, anio_mes: MES }).select('id')).map((r) => r.id);
    if (ids.length) await admin('finance.purchase_book_run_items').whereIn('run_id', ids).del();
    await admin('finance.purchase_book_runs').where({ tenant_id: MEGA, anio_mes: MES }).del();
    await admin('fiscal.cfdis').where({ tenant_id: MEGA }).whereIn('uuid', UUIDS).del();
    await admin('finance.gl_supplier_accounts').where({ tenant_id: MEGA, rfc: RFC }).del();
  };
  try {
    for (const t of ['finance.purchase_book_runs', 'finance.purchase_book_run_items', 'fiscal.cfdis', 'finance.gl_supplier_accounts']) {
      const [s, n] = t.split('.');
      if (!(await admin.schema.withSchema(s).hasTable(n))) { noMedido(`${t} no existe en este destino`); return; }
    }
    await limpiar();

    console.log('\n[0] Sembrar un mes de prueba con postgres (salta el RLS: siembra, no prueba)');
    await admin('finance.gl_supplier_accounts').insert({
      tenant_id: MEGA, rfc: RFC, supplier_name: 'CANDADO LC17', account_suffix: SUF,
      cuenta_proveedor: `212${SUF}`, cuenta_compra_exenta: `501${SUF}`, cuenta_compra_iva: `502${SUF}`,
      proveedor_existe: true, compra_exenta_existe: true, compra_iva_existe: true,
    });
    // Una gravada (100 + 16 de IVA) y una exenta (50): las dos patas de compras del asiento.
    const cfdis = [
      { uuid: UUIDS[0], total: 116, subtotal: 100, imp: { iva_trasladado: 16, ieps_trasladado: 0, subtotal_iva_16: 100 } },
      { uuid: UUIDS[1], total: 50, subtotal: 50, imp: { iva_trasladado: 0, ieps_trasladado: 0, subtotal_iva_16: 0 } },
    ];
    for (const [i, c] of cfdis.entries()) {
      await admin('fiscal.cfdis').insert({
        tenant_id: MEGA, uuid: c.uuid, tipo_comprobante: 'I', serie: 'LC', folio: `17${i}`,
        fecha: `2031-03-1${i}`, emisor_rfc: RFC, emisor_nombre: 'CANDADO LC17',
        subtotal: c.subtotal, descuento: 0, total: c.total, impuestos: JSON.stringify(c.imp),
        rol: 'recibidas', source: 'contpaqi_add', aso_contabilidad: false,
      });
    }
    check(true, `sembrado: 1 proveedor con sus 3 cuentas · ${cfdis.length} CFDIs sin asociar en ${MES}`);

    const svc = servicio(runtime);
    const T = { tipo: 'complemento' };
    const items = () => admin('finance.purchase_book_run_items as i')
      .join('finance.purchase_book_runs as r', 'r.id', 'i.run_id')
      .where({ 'r.tenant_id': MEGA, 'r.anio_mes': MES }).select('i.cfdi_uuid', 'i.origen', 'i.incluida');
    const corrida = () => admin('finance.purchase_book_runs').where({ tenant_id: MEGA, anio_mes: MES, tipo: 'complemento' }).first();

    console.log('\n[1] El mes, antes de tocar nada');
    let d = await svc.getMes(MES, 'complemento');
    check(d.resumen.incluidas === 2, `las 2 entran por default (dio ${d.resumen.incluidas})`);

    console.log('\n[2] generar, con el payload de la pantalla { impuestos, uuid }');
    const g = await svc.generar(MES, { impuestos: 'global', uuid: true, ...T });
    check(g.facturas === 2 && g.cargos === g.abonos, `2 facturas, cuadra en ${g.cargos}`);
    let it = await items();
    check(it.length === 2 && it.every((r) => r.origen === 'generado' && r.incluida),
      `⭐ B1: las 2 incluidas por default quedan registradas (origen generado) — dio ${it.length}`);
    d = await svc.getMes(MES, 'complemento');
    check(d.resumen.incluidas === 2, 'lo registrado por generar NO cuenta como decisión: siguen entrando por default');
    check(d.run.archivo_vigente === true && !('archivo_contenido' in d.run), 'la pantalla ve un archivo entregable, sin el contenido');

    console.log('\n[3] Las transiciones que no van');
    let e = await rechazo(() => svc.marcar(MES, 'aplicado', T));
    check(e && /de generado a aplicado/.test(msg(e)), '⛔ generado → aplicado se rechaza');
    e = await rechazo(() => svc.marcar(MES, 'borrador', T));
    check(e && /no se puede pasar/.test(msg(e)), '⛔ un estado que no existe en la máquina se rechaza (antes: 500 por el CHECK)');

    console.log('\n[4] descargar y entregar');
    const a = await svc.obtenerArchivo(MES, 'complemento');
    check(a.txt === (await corrida()).archivo_contenido, 'la descarga es el archivo guardado, byte a byte');
    await svc.marcar(MES, 'entregado', { ...T, entregado_a: 'Candado LC17' });
    check((await corrida()).estado === 'entregado', 'queda entregado');

    console.log('\n[5] Lo entregado ya no se puede pisar, y la puerta exacta lo ve');
    e = await rechazo(() => svc.generar(MES, { impuestos: 'global', uuid: true, ...T }));
    check(e && /ya se entregó/.test(msg(e)), '⭐ B3: generar encima de una entrega se rechaza');
    d = await svc.getMes(MES, 'complemento');
    check(d.facturas.every((f) => f.prueba_certeza === 'exacta' && !f.incluida),
      '⭐ B1: el mes ya NO vuelve a ofrecer las facturas entregadas (certeza exacta, fuera)');
    e = await rechazo(() => svc.setInclusion(MES, [UUIDS[0]], false, 'x', 'complemento'));
    check(e && /entregado/.test(msg(e)), 'tampoco se cambia qué entra');

    console.log('\n[6] Cancelar la entrega (ContPAQi la rechazó)');
    await svc.marcar(MES, 'cancelado', { ...T, notas: 'Entrega cancelada: candado' });
    let r = await corrida();
    check(r.estado === 'cancelado' && /candado/.test(String(r.notas)), 'queda cancelada, con su motivo en notas');
    e = await rechazo(() => svc.obtenerArchivo(MES, 'complemento'));
    check(e && /no tiene archivo/.test(msg(e)), 'una cancelada ya no sirve su archivo');
    d = await svc.getMes(MES, 'complemento');
    check(d.resumen.incluidas === 2 && d.facturas.every((f) => f.prueba_certeza === null),
      'las facturas vuelven a estar pendientes');

    console.log('\n[7] Volver a generar tras cancelar');
    await svc.generar(MES, { impuestos: 'global', uuid: true, ...T });
    r = await corrida();
    check(r.estado === 'generado' && r.entregado_at === null, 'generado de nuevo, sin la entrega anterior pegada');
    it = await items();
    check(it.length === 2, `sigue habiendo una fila por factura (dio ${it.length}), no se duplicaron`);

    console.log('\n[8] Un archivo legado guardado no se entrega');
    const bueno = r.archivo_contenido;
    const viejo = bueno.split('\r\n').map((l) => (l.startsWith('M1') ? `M ${l.slice(2)}` : l)).join('\r\n');
    await admin('finance.purchase_book_runs').where({ id: r.id }).update({ archivo_contenido: viejo });
    e = await rechazo(() => svc.obtenerArchivo(MES, 'complemento'));
    check(e && /formato anterior/.test(msg(e)), 'la descarga lo rechaza');
    e = await rechazo(() => svc.marcar(MES, 'entregado', T));
    check(e && /no se puede marcar entregado/.test(msg(e)), 'y no se marca entregado');
    d = await svc.getMes(MES, 'complemento');
    check(d.run.archivo_vigente === false, 'la pantalla lo sabe (archivo_vigente = false)');
    await admin('finance.purchase_book_runs').where({ id: r.id }).update({ archivo_contenido: bueno });

    console.log('\n[9] aplicado es terminal');
    await svc.marcar(MES, 'entregado', T);
    await svc.marcar(MES, 'aplicado', T);
    e = await rechazo(() => svc.marcar(MES, 'cancelado', T));
    check(e && /ya está aplicado/.test(msg(e)), '⛔ una aplicada no se cancela (sus facturas volverían a ofrecerse)');
    e = await rechazo(() => svc.marcar(MES, 'entregado', T));
    check(e && /ya está aplicado/.test(msg(e)), '⛔ ni retrocede a entregado');
  } finally {
    try { await limpiar(); } catch (e) { console.log(`  ⚠ limpieza incompleta: ${e.message}`); }
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
