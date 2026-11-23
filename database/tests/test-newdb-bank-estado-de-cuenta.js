/**
 * `[CB.58]` — Subir el estado de cuenta de la banca ESCRIBE: esta suite lo ejerce contra una base
 * real, como `app_runtime` con el tenant puesto, con el payload que manda la pantalla
 * (`{ file_base64, file_name, bank_account_id? }`).
 *
 * Los archivos son FABRICADOS con la forma exacta de las descargas reales del 2026-11-05
 * (Santander CSV con apóstrofos, BBVA `.exp` con tabuladores del más nuevo al más viejo) y datos
 * inventados: el repo es público.
 *
 * Bloques (destino LOCAL / `pruebas-db`):
 *   1. ✅ Santander trae su cuenta → `en_archivo`, cuadra, se guarda con hora/rastreo/contraparte.
 *   2. ✅ El mismo archivo otra vez → la revisión ya avisa `ya_subido`; confirmar da `ya_existia`, cero renglones nuevos.
 *   3. ✅ Una descarga que se encima con la anterior → sólo entran los renglones nuevos.
 *   4. ⛔ NEGATIVA: falta un renglón a la mitad → no cuadra, `confirmar` se niega y no escribe.
 *   5. ✅ BBVA no trae la cuenta: sin elegirla se niega; elegida y sin saldo previo → `sin_testigo`.
 *   6. ✅ El siguiente archivo BBVA arranca en el saldo con que cerró el anterior → `saldo_continuo`.
 *   7. ⛔ NEGATIVA: elegir OTRA cuenta BBVA cuando el saldo es el de la primera → se niega y lo dice.
 *   8. ⛔ NEGATIVA: elegir una cuenta de otro banco → se niega.
 *   9. ⛔ RLS: sin tenant, `app_runtime` no ve ningún renglón.
 *  14. [BFU.3.4] BBVA completa la referencia en la descarga siguiente → el renglón NO entra dos veces, toma el concepto
 *      completo y el cuadre no ve repetidos; ⛔ NEGATIVA: un repetido sembrado a mano hace que la cuenta no cuadre.
 *  15. [BFU.7.4] El motor de categoría (como app_runtime, con RLS): el retiro casado con un traspaso toma la categoría del
 *      documento; el que no tiene de dónde, queda con su MOTIVO guardado (nunca mudo); ⛔ NEGATIVAS: lo manual no se
 *      toca; si el pareo se va, la categoría del documento se va y queda el motivo; una segunda corrida no escribe.
 * Destino PROD: sólo lectura (las tablas existen, cuántos archivos hay); lo que escribe, NO MEDIDO.
 */

const path = require('path');
const Module = require('module');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

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
// El servicio sólo necesita los NOMBRES de sus dos dependencias y `todayMx` (la inyección se hace a
// mano abajo). Se registran en la caché de módulos: no se escribe ningún archivo de stub.
const todayMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const STUBS = {
  '@megadulces/platform-core': { TenantKnexService: class {}, TenantContextService: class {}, todayMx, applySmartSearch: () => {}, Permission: {}, isPlatformAdminRole: () => false,
    KNEX_NEW_DB: 'KNEX_NEW_DB', PgListenService: class {}, latirCron: async () => {} },
  '@megadulces/contracts': { FINANCE_FINDINGS_SINK_PORT: 'FINANCE_FINDINGS_SINK_PORT' },
};
const stubIds = {};
for (const [pedido, exportsStub] of Object.entries(STUBS)) {
  const id = path.join(__dirname, `__stub_cb58_${pedido.replace(/[@/]/g, '_')}.js`);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsStub, children: [], paths: [] };
  stubIds[pedido] = id;
}
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return stubIds[pedido] || resolveOriginal.call(this, pedido, ...resto);
};

const knexLib = require('knex');
const { classify, assertSafeTarget } = require('./_lib/assert-safe-target');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const ALIAS = 'PRUEBA CB58';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CB.58 estado de cuenta de la banca: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

// ── Archivos fabricados con la forma de las descargas reales ────────────────────────────────
const SANTANDER_ENC = 'Cuenta,Fecha,Hora,Sucursal,Descripcion,Cargo/Abono,Importe,Saldo,Referencia,Concepto,Banco Participante,Clabe Beneficiario,Nombre Beneficiario,Cta Ordenante,Nombre Ordenante,Codigo Devolucion,Causa Devolucion,RFC Beneficiario,RFC Ordenante,Clave de Rastreo,Descripcion Larga';
const stdr = (fecha, hora, desc, signo, imp, saldo, o = {}) => [`'11112222333'`, `'${fecha}'`, hora, `'0560'`, desc.padEnd(40), signo, imp, saldo,
  (o.ref || '').padEnd(15), ' '.repeat(20), ''.padEnd(40), `'${''.padEnd(20)}'`, ''.padEnd(40), `'${(o.cta || '').padEnd(20)}'`, (o.nom || '').padEnd(40),
  '  ', ''.padEnd(30), ''.padEnd(15), (o.rfc || '').padEnd(15), (o.rastreo || '').padEnd(30), desc.padEnd(130)].join(',');
const S1 = stdr('02112026', '03:04', 'COMISION MANEJO DE CUENTA', '-', '500.00', '9500.00');
const S2 = stdr('02112026', '09:15', 'ABONO TRANSFERENCIA SPEI', '+', '1250.50', '10750.50', { ref: '000111222', cta: '012345678901234567', nom: 'CLIENTE DE PRUEBA SA DE CV', rfc: 'XAXX010101000', rastreo: 'PRUEBA0000000001' });
const S3 = stdr('03112026', '11:40', 'DEPOSITO EN EFECTIVO', '+', '3000.00', '13750.50', { ref: '0000099999' });
const S4 = stdr('03112026', '12:10', 'DEPOSITO EN EFECTIVO', '+', '249.50', '14000.00', { ref: '0000099998' });
const santander = (r) => Buffer.from([SANTANDER_ENC, ...r].join('\n'), 'ascii').toString('base64');
const bbva = (renglonesNuevoAViejo) => Buffer.from(['Día\tConcepto / Referencia\tcargo\tAbono\tSaldo', ...renglonesNuevoAViejo].join('\r\n'), 'latin1').toString('base64');
const BBVA_1 = bbva([
  '02-11-2026\tAPLI TASA DE DES DEBITO/100000001 TERMINALES PUNTO DE VENTA\t100.00\t\t1,100.00',
  '02-11-2026\tVENTAS DEBITO/100000002 TERMINALES PUNTO DE VENTA\t\t1,000.00\t1,200.00',
]);
const BBVA_2 = bbva([ // arranca en $1,100.00: el cierre de BBVA_1
  '03-11-2026\tIVA TASA DE DESC DEBITO/100000003 TERMINALES PUNTO DE VENTA\t16.00\t\t1,584.00',
  '03-11-2026\tVENTAS DEBITO/100000004 TERMINALES PUNTO DE VENTA\t\t500.00\t1,600.00',
]);

function servicio(pool, conTenant = true) {
  const { EstadoDeCuentaService } = require(path.join(ROOT, 'libs/finance/src/lib/bank/estado-de-cuenta/estado-de-cuenta.service.ts'));
  const tk = {
    run: (cb) => pool.transaction(async (trx) => {
      if (conTenant) await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]);
      return cb(trx);
    }),
  };
  const svc = new EstadoDeCuentaService(tk, { requireTenantId: () => MEGA });
  svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
  return svc;
}

const niega = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

async function faltantes(db) {
  const rels = ['finance.bank_accounts', 'finance.bank_movements', 'finance.bank_statement_files', 'finance.bank_statement_lines'];
  const r = await db.raw('SELECT r FROM unnest(?::text[]) r WHERE to_regclass(r) IS NULL', [rels]);
  return r.rows.map((x) => x.r);
}

async function limpiar(admin) {
  const ids = (await admin('finance.bank_accounts').where('alias', 'like', `${ALIAS}%`).select('id')).map((r) => r.id);
  if (!ids.length) return;
  await admin('finance.bank_statement_lines').whereIn('bank_account_id', ids).del();
  await admin('finance.bank_statement_files').whereIn('bank_account_id', ids).del();
  // El libro de [10] y [11]: sin esto, borrar la cuenta choca con su FK (y el `catch` lo callaba).
  await admin('finance.bank_movements').whereIn('bank_account_id', ids).del();
  await admin('finance.bank_statements').whereIn('bank_account_id', ids).del();
  if ((await admin.raw("select to_regclass('finance.bank_branch_keys') r")).rows[0].r) {
    await admin('finance.bank_branch_keys').whereIn('bank_account_id', ids).del();
  }
  await admin('finance.bank_accounts').whereIn('id', ids).del();
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[modo COMPLETO — destino local]');
  assertSafeTarget('test-newdb-bank-estado-de-cuenta', { url: urlAdmin });
  assertSafeTarget('test-newdb-bank-estado-de-cuenta', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  try {
    const falta = await faltantes(admin);
    if (falta.length) { noMedido(`faltan relaciones en este destino: ${falta.join(', ')}`); return; }
    await limpiar(admin);

    console.log('\n[0] Sembrar cuentas con postgres (salta el RLS: siembra, no prueba)');
    const cuenta = async (bank, label, alias) => {
      const [r] = await admin('finance.bank_accounts').insert({ tenant_id: MEGA, bank, account_label: label, alias, kind: 'bank', active: true }).returning('id');
      return r.id ?? r;
    };
    const STDR = await cuenta('SANTANDER', '22333', `${ALIAS} STDR`);
    const BBVA_A = await cuenta('BBVA', '58001', `${ALIAS} BBVA A`);
    const BBVA_B = await cuenta('BBVA', '58002', `${ALIAS} BBVA B`);
    const svc = servicio(runtime);
    const lineas = async (id) => Number((await admin('finance.bank_statement_lines').where({ bank_account_id: id }).count('* as n'))[0].n);

    console.log('\n[1] Santander: la cuenta viene en el archivo');
    const rev = await svc.revisar({ file_base64: santander([S1, S2, S3]), file_name: 'SANTANDER.csv' });
    check(rev.cuenta?.id === STDR && rev.como_se_fijo === 'en_archivo', `la cuenta se fija por el número del archivo (${rev.como_se_fijo})`);
    check(rev.ya_subido === null, 'un archivo nuevo no se reporta como ya subido');
    check(rev.cuadra && rev.puede_confirmar && rev.nuevos === 3, `cuadra y entrarían 3 nuevos (${rev.nuevos}); motivos: ${JSON.stringify(rev.motivos_bloqueo)}`);
    check(await lineas(STDR) === 0, 'revisar NO escribe');
    const c1 = await svc.confirmar({ file_base64: santander([S1, S2, S3]), file_name: 'SANTANDER.csv' }, 'prueba');
    check(!c1.ya_existia && c1.nuevos === 3 && await lineas(STDR) === 3, `confirmar guarda los 3 renglones (${c1.nuevos})`);
    const spei = await admin('finance.bank_statement_lines').where({ bank_account_id: STDR, tracking_key: 'PRUEBA0000000001' }).first();
    check(spei && spei.movement_time === '09:15' && spei.counterparty_rfc === 'XAXX010101000' && Number(spei.amount_in) === 1250.5,
      'el renglón SPEI guarda hora, RFC de quien ordena e importe en pesos');
    check(spei && typeof spei.raw_line === 'string' && spei.raw_line.includes('ABONO TRANSFERENCIA SPEI'), 'y el texto original como evidencia');
    const f1 = await admin('finance.bank_statement_files').where({ id: c1.archivo_id }).first();
    check(f1 && f1.balance_ok === true && f1.account_check === 'en_archivo' && Number(f1.opening_balance) === 10000 && Number(f1.closing_balance) === 13750.5,
      `el archivo guarda su control: saldo $${f1 && f1.opening_balance} → $${f1 && f1.closing_balance}`);

    console.log('\n[2] El mismo archivo otra vez');
    const rRep = await svc.revisar({ file_base64: santander([S1, S2, S3]), file_name: 'SANTANDER (1).csv' });
    check(rRep.ya_subido?.archivo_id === c1.archivo_id && rRep.ya_subido?.subido_por === 'prueba', `la revisión ya avisa que ese archivo se subió (${rRep.ya_subido?.subido_el})`);
    const c2 = await svc.confirmar({ file_base64: santander([S1, S2, S3]), file_name: 'SANTANDER (1).csv' }, 'prueba');
    check(c2.ya_existia === true && await lineas(STDR) === 3, 'se reconoce y no duplica nada');

    console.log('\n[3] Una descarga que se encima con la anterior');
    const c3 = await svc.confirmar({ file_base64: santander([S2, S3, S4]), file_name: 'SANTANDER 2.csv' }, 'prueba');
    check(!c3.ya_existia && c3.nuevos === 1 && c3.ya_cargados === 2 && await lineas(STDR) === 4, `entra sólo el renglón nuevo (${c3.nuevos} nuevo, ${c3.ya_cargados} ya cargados)`);

    console.log('\n[4] ⛔ NEGATIVA: falta un renglón a la mitad');
    const S5 = stdr('04112026', '08:00', 'DEPOSITO EN EFECTIVO', '+', '100.00', '14100.00');
    const S6 = stdr('04112026', '09:00', 'DEPOSITO EN EFECTIVO', '+', '100.00', '14300.00'); // salta 14200
    const rNeg = await svc.revisar({ file_base64: santander([S5, S6]) });
    check(!rNeg.cuadra && !rNeg.puede_confirmar && rNeg.motivos_bloqueo.some((m) => /no encadena/.test(m)), 'la revisión lo marca y dice por qué');
    const eNeg = await niega(() => svc.confirmar({ file_base64: santander([S5, S6]) }, 'prueba'));
    check(eNeg && /no se puede guardar/.test(JSON.stringify(eNeg.response || eNeg.message)), 'confirmar se niega');
    check(await lineas(STDR) === 4, 'y no escribe ni un renglón');

    console.log('\n[5] BBVA no trae la cuenta');
    const sinCuenta = await svc.revisar({ file_base64: BBVA_1 });
    check(!sinCuenta.puede_confirmar && sinCuenta.motivos_bloqueo.some((m) => /elige la cuenta/.test(m)), 'sin elegirla, se pide');
    const eSinAceptar = await svc.confirmar({ file_base64: BBVA_1, bank_account_id: BBVA_A }, 'prueba').then(() => null, (e) => e);
    check(eSinAceptar && /confírmalo/.test(JSON.stringify(eSinAceptar.response || eSinAceptar.message)) && await lineas(BBVA_A) === 0,
      '⛔ sin testigo y sin confirmarlo a mano, confirmar se niega y no escribe');
    const cA = await svc.confirmar({ file_base64: BBVA_1, bank_account_id: BBVA_A, aceptar_sin_testigo: true }, 'prueba');
    check(cA.como_se_fijo === 'sin_testigo' && cA.nuevos === 2, `elegida y sin saldo previo: se guarda declarada «sin_testigo» (${cA.como_se_fijo})`);
    const ordenA = await admin('finance.bank_statement_lines').where({ bank_account_id: BBVA_A }).orderBy('seq').select('concept', 'seq');
    check(ordenA.length === 2 && /^VENTAS/.test(ordenA[0].concept), 'el archivo venía al revés y se guarda en orden cronológico (seq)');

    console.log('\n[6] El siguiente archivo arranca donde cerró el anterior');
    const rB = await svc.revisar({ file_base64: BBVA_2, bank_account_id: BBVA_A });
    check(rB.como_se_fijo === 'saldo_continuo' && rB.puede_confirmar, `la cuenta queda atestiguada por el saldo (${rB.como_se_fijo}, inicial $${rB.saldo_inicial})`);
    check(rB.candidatas.some((c) => c.id === BBVA_A && c.coincide) && !rB.candidatas.some((c) => c.id === BBVA_B && c.coincide), 'la candidata que coincide es la correcta y sólo ella');

    console.log('\n[7] ⛔ NEGATIVA: elegir la otra cuenta BBVA');
    const rOtra = await svc.revisar({ file_base64: BBVA_2, bank_account_id: BBVA_B });
    check(!rOtra.puede_confirmar && rOtra.motivos_bloqueo.some((m) => m.includes(`${ALIAS} BBVA A`)), 'se niega y nombra la cuenta cuyo saldo sí es');

    console.log('\n[8] ⛔ NEGATIVA: una cuenta de otro banco');
    const rBanco = await svc.revisar({ file_base64: BBVA_2, bank_account_id: STDR });
    check(!rBanco.puede_confirmar && rBanco.motivos_bloqueo.some((m) => /no es una cuenta BBVA/.test(m)), 'se niega: el archivo es de BBVA');

    console.log('\n[8b] ⛔ La lista con tope NO recorta el resumen por cuenta');
    const lst = await svc.archivos(1);
    const porCuenta = (id) => lst.cuentas.find((c) => c.id === id);
    check(lst.archivos.length === 1 && lst.total >= 3, `la lista declara su tope: ${lst.archivos.length} de ${lst.total}`);
    check(porCuenta(STDR)?.archivos === 2 && porCuenta(BBVA_A)?.archivos === 1 && porCuenta(BBVA_A)?.hasta === '2026-11-02',
      `y cada cuenta sigue contando todos sus archivos (STDR ${porCuenta(STDR)?.archivos}, BBVA A ${porCuenta(BBVA_A)?.archivos} hasta ${porCuenta(BBVA_A)?.hasta})`);
    check(porCuenta(BBVA_A)?.sin_testigo === 1 && porCuenta(BBVA_A)?.con_lector === true, 'con su archivo sin testigo y su lector');
    // [CB.63] Cuándo se subió la descarga más reciente: dice si la cuenta ya se subió hoy. Sin archivos, null (no «hoy»).
    const sinArchivo = lst.cuentas.find((c) => c.archivos === 0);
    check(porCuenta(STDR)?.ultima_subida instanceof Date && Date.now() - porCuenta(STDR).ultima_subida.getTime() < 3600e3
      && (!sinArchivo || sinArchivo.ultima_subida === null),
      `[CB.63] la última subida por cuenta (STDR ${porCuenta(STDR)?.ultima_subida?.toISOString?.()}; sin archivo: ${sinArchivo ? sinArchivo.ultima_subida : 'no hay'})`);

    console.log('\n[9] ⛔ RLS');
    // Sin `app.tenant_id`, la política filtra todo (o `current_tenant_id()` se niega): las dos son «no ve».
    const sinTenant = await runtime.transaction(async (trx) => Number((await trx('finance.bank_statement_lines').count('* as n'))[0].n)).catch((e) => `error: ${e.message}`);
    check(sinTenant === 0 || String(sinTenant).startsWith('error'), `sin tenant, app_runtime no ve renglones (${sinTenant})`);

    console.log('\n[10] El testigo del LIBRO: el cierre del día por la cadena, no el último capturado');
    // BBVA_1 arranca en $200.00 el 02-nov. El libro de la cuenta C cierra el 01-nov en $200.00, pero ese
    // renglón se capturó PRIMERO: el «último por created_at» daría $150.00 y no la reconocería.
    const BBVA_C = await cuenta('BBVA', '58003', `${ALIAS} BBVA C`);
    const [edo] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: BBVA_C, period: '2026-11' }).returning('id');
    for (const [i, o, s] of [[50, 0, 200], [300, 0, 300], [0, 150, 150]]) {
      await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: edo.id ?? edo, bank_account_id: BBVA_C, movement_date: '2026-11-01',
        concept: 'PRUEBA LIBRO', amount_in: i, amount_out: o, running_balance: s, client_uuid: `prueba-cb59-${s}` });
    }
    const rC = await svc.revisar({ file_base64: BBVA_1 });
    const cC = rC.candidatas.find((c) => c.id === BBVA_C);
    check(cC?.coincide === true && cC.saldo_conocido === 200, `la cuenta C coincide por el cierre reconstruido ($${cC?.saldo_conocido})`);
    const rC2 = await svc.revisar({ file_base64: BBVA_1, bank_account_id: BBVA_C });
    check(rC2.como_se_fijo === 'saldo_continuo', `elegida, queda atestiguada por saldo (${rC2.como_se_fijo})`);

    console.log('\n[11] CB.60 — la descarga contra el libro, día por día');
    // STDR: el libro del 02-nov copia los dos renglones del banco (en otro orden). El 03-nov es el
    // último día de la descarga: queda «abierto», no se juzga.
    const catId = async (code) => (await admin('finance.movement_categories').where({ tenant_id: MEGA, code }).first('id'))?.id ?? null;
    const libroDe = async (cuentaId, filas) => {
      const [st] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: cuentaId, period: '2026-11' }).returning('id');
      for (const [i, o, s, cat, dia] of filas) {
        await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: st.id ?? st, bank_account_id: cuentaId, movement_date: dia ?? '2026-11-02',
          concept: 'PRUEBA LIBRO', amount_in: i, amount_out: o, running_balance: s, client_uuid: `prueba-cb60-${cuentaId}-${s}`,
          category_id: cat ? await catId(cat) : null });
      }
    };
    // [CB.61] El libro dice «nómina» para el abono SPEI (falso a propósito) y «comisión bancaria» para la comisión.
    await libroDe(STDR, [[1250.50, 0, 10750.50, 'nomina'], [0, 500, 9500, 'comision_bancaria']]);
    // BBVA A: le entra la segunda descarga (el 02-nov deja de ser el último día) y el libro del 02-nov
    // NO tiene la comisión de $100.00.
    await svc.confirmar({ file_base64: BBVA_2, bank_account_id: BBVA_A }, 'prueba');
    // El libro llega al 03-nov: el 02 ya no es su último día (si lo fuera, quedaría «a medias», no «difiere»).
    await libroDe(BBVA_A, [[1000, 0, 1200], [1, 0, 1, null, '2026-11-03']]);
    const cl = await svc.contraElLibro(30, '2026-11-09');
    const de = (id) => cl.cuentas.find((c) => c.id === id);
    const veredictos = (id) => (de(id)?.dias || []).map((d) => `${d.fecha.slice(8)}:${d.veredicto}`).join(' ');
    check(veredictos(STDR) === '02:cuadra 03:abierto', `STDR: el día copiado cuadra y el último queda abierto (${veredictos(STDR)})`);
    const bA = de(BBVA_A)?.dias.find((d) => d.fecha === '2026-11-02');
    check(bA?.veredicto === 'difiere' && bA.solo_banco.length === 1 && bA.solo_banco[0].importe === 100 && bA.solo_banco[0].lado === 'sale',
      `⛔ BBVA A: al libro le falta la comisión → difiere y la nombra (${bA?.veredicto}, ${JSON.stringify(bA?.solo_banco.map((x) => x.importe))})`);
    check(!cl.cuentas.some((c) => c.id === BBVA_B), 'una cuenta sin descarga no se juzga');

    console.log('\n[12] CB.61 — la categoría sin el libro, contra la del libro');
    const kS = de(STDR)?.categorias;
    check(kS?.pareados === 2 && kS.coinciden === 1 && kS.difieren === 1,
      `STDR: la comisión coincide por el texto del banco y el abono no (${JSON.stringify(kS && { p: kS.pareados, c: kS.coinciden, d: kS.difieren })})`);
    const dS = kS?.distintas?.[0];
    check(dS?.importe === 1250.5 && dS.banco === 'cobranza' && dS.por === 'deposito' && dS.libro === 'nomina',
      `⛔ el abono SPEI: la sombra dice cobranza (por ser depósito) y nombra que el libro dice nómina (${JSON.stringify(dS)})`);

    console.log('\n[12b] CB.64 — la descarga dentro de Movimientos: una sola lista, con app_runtime y RLS');
    {
      const { FinanceBankService } = require(path.join(ROOT, 'libs/finance/src/lib/bank/finance-bank.service.ts'));
      const tkM = { run: (cb) => runtime.transaction(async (trx) => { await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]); return cb(trx); }) };
      const fbs = new FinanceBankService(tkM, { requireTenantId: () => MEGA });
      fbs.logger = { log() {}, warn() {}, error() {}, debug() {} };
      const mov = (account_id, extra = {}) => fbs.movements({ period: '2026-11', account_id, limit: 50, ...extra });
      // STDR: el libro llega al 02 (los dos casan); los dos depósitos del 03 sólo están en la descarga.
      const mS = await mov(STDR);
      const fS = (f) => mS.rows.filter((x) => x.fuente === f);
      check(mS.total === 4 && fS('libro').length === 2 && fS('descarga').length === 2,
        `STDR: una sola lista con los 2 del libro y los 2 de la descarga (${mS.total}: ${mS.rows.map((x) => x.fuente).join(',')})`);
      check(String(mS.rows[0].movement_date).includes('03') || new Date(mS.rows[0].movement_date).getUTCDate() === 3,
        `del más nuevo al más viejo: arriba el 03 (${mS.rows[0].movement_date})`);
      check(fS('libro').every((x) => x.en_descarga === 'trae'), `lo del libro dice que la descarga lo trae (${fS('libro').map((x) => x.en_descarga)})`);
      check(fS('descarga').every((x) => x.motivo === 'libro_no_llega' && x.subido_por === 'prueba' && x.referencia && x.recon_status === null),
        `lo de la descarga: el libro no llega, con su referencia y quién la subió (${JSON.stringify(fS('descarga').map((x) => [x.motivo, x.referencia, x.subido_por]))})`);
      // [CB.65] Un depósito en efectivo sin otra señal: cobranza, y dice que salió de «depósito», no del texto.
      check(fS('descarga').every((x) => x.category_code === 'cobranza' && x.category_id && x.category_name && x.categoria_por === 'deposito'),
        `[CB.65] lo de la descarga trae categoría y quién la puso (${JSON.stringify(fS('descarga').map((x) => [x.category_code, x.categoria_por]))})`);
      check(fS('libro').every((x) => x.categoria_por === undefined), '[CB.65] lo del libro no trae «quién la puso» de la descarga');
      // BBVA A: al libro del 02 le falta la comisión de $100 y el 03 trae otro renglón (+1); el 03 es el día abierto.
      const [stA] = await admin('finance.bank_statements').where({ bank_account_id: BBVA_A, period: '2026-11' }).select('id');
      await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: stA.id, bank_account_id: BBVA_A, movement_date: '2026-11-02',
        concept: 'PRUEBA LIBRO SIN BANCO', amount_in: 0, amount_out: 7, running_balance: 1193, client_uuid: 'prueba-cb64-sin-banco' });
      const mA = await mov(BBVA_A);
      const motivoDe = (imp) => mA.rows.find((x) => x.fuente === 'descarga' && (x.amount_out === imp || x.amount_in === imp))?.motivo;
      check(motivoDe(100) === 'falta_en_libro' && motivoDe(16) === 'falta_en_libro' && motivoDe(500) === 'falta_en_libro',
        `BBVA A: lo que el libro no tiene de días que sí tiene es «falta en el libro» (${motivoDe(100)}, ${motivoDe(16)}, ${motivoDe(500)})`);
      const deLibro = (imp) => mA.rows.find((x) => x.fuente === 'libro' && (x.amount_out === imp || x.amount_in === imp))?.en_descarga;
      check(deLibro(1000) === 'trae' && deLibro(7) === 'no_trae' && deLibro(1) === null,
        `el libro: lo trae · no lo trae (dentro del archivo) · sin juicio en el día abierto (${deLibro(1000)}, ${deLibro(7)}, ${deLibro(1)})`);
      check(mA.descarga?.solo_descarga === 3 && mA.descarga?.trae === 1 && mA.descarga?.no_trae === 1,
        `el resumen de la cuenta (${JSON.stringify(mA.descarga)})`);
      // [CB.65] Cada uno con la categoría del clasificador de CB.61: comisión e IVA por el texto del banco, la venta por ser depósito.
      const catDe = (imp) => { const r = mA.rows.find((x) => x.fuente === 'descarga' && (x.amount_out === imp || x.amount_in === imp)); return r ? `${r.category_code}/${r.categoria_por}` : null; };
      check(catDe(100) === 'comision_bancaria/banco' && catDe(16) === 'iva_acreditable/banco' && catDe(500) === 'cobranza/deposito',
        `[CB.65] BBVA A: comisión, IVA y venta con su categoría (${catDe(100)}, ${catDe(16)}, ${catDe(500)})`);
      const catId = async (code) => (await runtime.transaction(async (trx) => { await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]);
        return trx('finance.movement_categories').where({ code }).first('id', 'group_key'); }));
      const comision = await catId('comision_bancaria');
      const porCat = await mov(BBVA_A, { category_id: comision.id });
      const descDeCat = porCat.rows.filter((x) => x.fuente === 'descarga');
      check(descDeCat.length === 1 && descDeCat[0].amount_out === 100 && porCat.rows.every((x) => x.category_id === comision.id),
        `[CB.65] filtrar por categoría alcanza a la descarga: sólo la comisión de $100 (${porCat.rows.map((x) => `${x.fuente}:${x.amount_out || x.amount_in}`)})`);
      const cobranza = await catId('cobranza');
      const porGrupo = await mov(BBVA_A, { group_key: cobranza.group_key });
      check(porGrupo.rows.some((x) => x.fuente === 'descarga' && x.amount_in === 500) && porGrupo.rows.every((x) => x.group_key === cobranza.group_key),
        `[CB.65] y por grupo (${cobranza.group_key}): la venta de $500 entra (${porGrupo.rows.map((x) => `${x.fuente}:${x.amount_out || x.amount_in}`)})`);
      const otra = await runtime.transaction(async (trx) => { await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]);
        return trx('finance.movement_categories').whereNotIn('code', ['comision_bancaria', 'iva_acreditable', 'cobranza', 'sin_clasificar']).first('id'); });
      const otraCat = otra ? await mov(BBVA_A, { category_id: otra.id }) : null;
      check(otraCat && otraCat.rows.every((x) => x.fuente !== 'descarga'),
        `[negativa] una categoría que ningún renglón de la descarga tiene no trae ninguno (${otraCat?.rows.map((x) => x.fuente)})`);
      const solo = await mov(BBVA_A, { contra_descarga: 'solo_descarga' });
      check(solo.total === 3 && solo.rows.every((x) => x.fuente === 'descarga'), `filtro «sólo en la descarga»: ${solo.total}, todas de la descarga`);
      const noTrae = await mov(BBVA_A, { contra_descarga: 'no_trae' });
      check(noTrae.total === 1 && noTrae.rows[0]?.concept === 'PRUEBA LIBRO SIN BANCO', `filtro «la descarga no lo trae»: el resumen se recorre (${noTrae.total})`);
      // El buscador real necesita f_unaccent y pg_trgm; aquí va un ILIKE por columna EN SU LUGAR: lo que se prueba es que la
      // búsqueda llega a la rama de la descarga con sus columnas (concepto y referencia), no el motor.
      const pc = STUBS['@megadulces/platform-core'];
      const motorStub = pc.applySmartSearch;
      pc.applySmartSearch = (qb, q, o) => qb.andWhere((w) => { for (const c of o.columns) w.orWhereRaw(`${c} ilike ?`, [`%${q}%`]); });
      const busca = await mov(BBVA_A, { search: 'IVA' });
      const buscaRef = await mov(STDR, { search: '0000099998' });
      pc.applySmartSearch = motorStub;
      check(busca.total === 1 && busca.rows[0]?.fuente === 'descarga', `la búsqueda también entra a la descarga, por concepto (${busca.total})`);
      check(buscaRef.total === 1 && buscaRef.rows[0]?.referencia === '0000099998', `y por referencia (${buscaRef.total})`);
      const sinCat = await mov(BBVA_A, { uncategorized: 'true' });
      check(sinCat.rows.length > 0 && sinCat.rows.every((x) => x.fuente === 'libro'),
        `[negativa] «sin clasificar» es del libro: la descarga no se clasifica ahí (${sinCat.rows.map((x) => x.fuente)})`);
      const sinPeriodo = await fbs.movements({ account_id: BBVA_A, limit: 50 });
      check(sinPeriodo.descarga === null && sinPeriodo.rows.every((x) => x.fuente === 'libro' && x.en_descarga === null),
        '[negativa] sin periodo no se afirma nada de la descarga');
      const otroMes = await mov(BBVA_A, { period: '2026-09' });
      check(otroMes.descarga === null && otroMes.total === 0, `un mes sin descarga: null, no ceros (${JSON.stringify(otroMes.descarga)})`);
      await admin('finance.bank_movements').where({ client_uuid: 'prueba-cb64-sin-banco' }).del();
    }

    console.log('\n[13] CB.60b — usar el banco: la descarga alimenta los movimientos de Bancos');
    if (!(await admin.raw("select to_regclass('finance.bank_branch_keys') r")).rows[0].r) {
      noMedido('la migración CB.60b no está aplicada en este destino');
    } else {
      const BANCO = await cuenta('BBVA', '59001', `${ALIAS} BANCO`);
      // 13 días de octubre: cada día una venta con terminal (+100) y su tasa de descuento (−2). Del más nuevo al más viejo (BBVA).
      const dia = (d) => String(d).padStart(2, '0');
      const renglonesDe = (desde, hasta, saldo0) => {
        const out = []; let s = saldo0;
        for (let d = desde; d <= hasta; d++) {
          s += 100; out.push({ d, txt: `${dia(d)}-10-2026\tVENTAS DEBITO/100000009 TERMINALES PUNTO DE VENTA\t\t100.00\t${s.toFixed(2)}`, i: 100, o: 0, s });
          s -= 2; out.push({ d, txt: `${dia(d)}-10-2026\tAPLI TASA DE DES DEBITO/100000009 TERMINALES PUNTO DE VENTA\t2.00\t\t${s.toFixed(2)}`, i: 0, o: 2, s });
        }
        return out;
      };
      const r12 = renglonesDe(1, 12, 1000);
      const cB = await svc.confirmar({ file_base64: bbva(r12.map((x) => x.txt).reverse()), bank_account_id: BANCO, aceptar_sin_testigo: true }, 'prueba');
      check(cB.nuevos === 24, `la descarga de 12 días entra: ${cB.nuevos} renglones`);
      // El libro: del 1 al 11 idéntico (las ventas con S=40); del 12 sólo la venta (el libro se subió a medias).
      const [st] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: BANCO, period: '2026-10' }).returning('id');
      for (const x of r12.filter((y) => y.d <= 11 || y.i > 0)) {
        await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: st.id ?? st, bank_account_id: BANCO, movement_date: `2026-10-${dia(x.d)}`,
          concept: x.i ? 'VENTA TARJETA' : 'COMISION', amount_in: x.i, amount_out: x.o, running_balance: x.s,
          sucursal: x.i ? '40' : null, category_id: await catId(x.i ? 'cobranza' : 'comision_bancaria'), client_uuid: `prueba-cb60b-${x.d}-${x.i}` });
      }

      // [CB.60b] El aviso a la conciliación (CB.53) se escucha de verdad: sale al CONFIRMAR y sólo si entró algo.
      const { Client } = require('pg');
      const oyente = new Client({ connectionString: urlAdmin });
      await oyente.connect();
      const avisos = [];
      oyente.on('notification', (m) => { if (m.channel === 'bancos_movimientos') avisos.push(JSON.parse(m.payload)); });
      await oyente.query('LISTEN bancos_movimientos');
      const recoger = async () => { await new Promise((r) => setTimeout(r, 400)); return avisos.splice(0); };
      const { avisarBancos } = require(path.join(ROOT, 'libs/finance/src/lib/bank/aviso-bancos.ts'));
      await niega(() => admin.transaction(async (trx) => { await avisarBancos(trx, { origen: 'descarga', periodos: ['2026-10'] }); throw new Error('rollback a propósito'); }));
      check((await recoger()).length === 0, '⛔ una transacción que se deshace NO avisa: el oyente nunca concilia un dato que no quedó');

      // [CB.73] Lo que decide es el CUADRE de la descarga, no el libro (Edgar, 2026-11-17). Pasa si sigue de punta a punta
      // por saldos y abre en el saldo con que la cuenta cerró antes; el banco manda desde el PRIMER día de la descarga.
      // ⛔ ENTRADA: la descarga abre en otro saldo que el último conocido de la cuenta → se niega, dice qué bajar y no escribe.
      const HUECO = await cuenta('BBVA', '59003', `${ALIAS} HUECO`);
      const rH = renglonesDe(10, 12, 5000);
      await svc.confirmar({ file_base64: bbva(rH.map((x) => x.txt).reverse()), bank_account_id: HUECO, aceptar_sin_testigo: true }, 'prueba');
      const [stH] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: HUECO, period: '2026-10' }).returning('id');
      await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: stH.id ?? stH, bank_account_id: HUECO, movement_date: '2026-10-05',
        concept: 'PRUEBA LIBRO', amount_in: 50, amount_out: 0, running_balance: 4000, client_uuid: 'prueba-cb73-entrada' });
      const hueco = await niega(() => svc.usarElBanco(HUECO, 'prueba', '2026-10-20'));
      const motivoH = JSON.stringify(hueco?.response?.motivos ?? hueco?.message ?? '');
      check(motivoH.includes('la descarga abre el 10/10 en $5,000.00 y la cuenta cerró el 05/10 en $4,000.00: baja un solo archivo del 05/10 a hoy'),
        `⛔ [CB.73] la descarga abre en $5,000 y la cuenta cerró en $4,000: NO pasa y dice desde dónde bajar (${motivoH})`);
      const escritoH = await admin('finance.bank_movements').where({ bank_account_id: HUECO }).where((w) => w.where('sync_source', 'banco').orWhereNotNull('deleted_at')).count({ n: '*' });
      const ctaH = await admin('finance.bank_accounts').where({ id: HUECO }).first('statement_source_since');
      check(Number(escritoH[0].n) === 0 && ctaH.statement_source_since === null, '⛔ [CB.73] y no escribe nada: ni borra el libro, ni mete del banco, ni fija el corte');
      // ⛔ ROTURA: el segundo archivo no abre donde cerró el primero (faltan movimientos en medio) → se niega y no escribe.
      const ROTA = await cuenta('BBVA', '59005', `${ALIAS} ROTA`);
      await svc.confirmar({ file_base64: bbva(renglonesDe(10, 11, 3000).map((x) => x.txt).reverse()), bank_account_id: ROTA, aceptar_sin_testigo: true }, 'prueba');
      await svc.confirmar({ file_base64: bbva(renglonesDe(13, 13, 9000).map((x) => x.txt).reverse()), bank_account_id: ROTA, aceptar_sin_testigo: true }, 'prueba');
      const rota = await niega(() => svc.usarElBanco(ROTA, 'prueba', '2026-10-20'));
      const motivoR = JSON.stringify(rota?.response?.motivos ?? rota?.message ?? '');
      check(motivoR.includes('el saldo no sigue entre el 11/10 y el 13/10 (cerró en $3,196.00 y abre en $9,000.00): baja un solo archivo del 11/10 a hoy'),
        `⛔ [CB.73] el saldo no sigue entre dos descargas: NO pasa y lo dice (${motivoR})`);
      const escritoR = await admin('finance.bank_movements').where({ bank_account_id: ROTA }).count({ n: '*' });
      check(Number(escritoR[0].n) === 0, `⛔ [CB.73] y no mete nada del banco (${escritoR[0].n})`);
      // Cuadra: el libro cierra el 04 en $7,000 y la descarga (05 al 07) abre en $7,000 → manda desde el 05, su primer día.
      const SINP = await cuenta('BBVA', '59004', `${ALIAS} SINP`);
      const rS = renglonesDe(5, 7, 7000);
      await svc.confirmar({ file_base64: bbva(rS.map((x) => x.txt).reverse()), bank_account_id: SINP, aceptar_sin_testigo: true }, 'prueba');
      const [stS] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: SINP, period: '2026-10' }).returning('id');
      for (const [d, imp, saldo] of [[3, 10, 6990], [4, 10, 7000], [6, 30, 7130]]) {
        await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: stS.id ?? stS, bank_account_id: SINP, movement_date: `2026-10-0${d}`,
          concept: 'PRUEBA LIBRO', amount_in: imp, amount_out: 0, running_balance: saldo, client_uuid: `prueba-cb73-sinp-${d}` });
      }
      // Una fecha FUTURA del libro (capturada mal): desde el primer día de la descarga se reemplaza también.
      await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: stS.id ?? stS, bank_account_id: SINP, movement_date: '2027-08-06',
        concept: 'PRUEBA FECHA MAL', amount_in: 1, amount_out: 0, running_balance: 1, client_uuid: 'prueba-cb67-futura' });
      // [BFU.2.5] Lo que está ligado a un renglón del libro que se va a reemplazar: un renglón del 05 (+100, el banco lo
      // trae ese día) con un pago del calendario, una captura, un programa de pagos, una confirmación de ContPAQi, el
      // cliente declarado y la categoría puesta a mano; y al del 06 (+30, el banco NO lo trae) una captura.
      const [stP] = await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: stS.id ?? stS, bank_account_id: SINP,
        movement_date: '2026-10-05', concept: 'PRUEBA LIGADO', amount_in: 100, amount_out: 0, running_balance: 7100, client_uuid: 'prueba-bfu25-par',
        customer_code: 'C-0042', customer_nota: 'lo dijo cobranza', customer_declared_by: 'prueba', customer_declared_at: new Date(),
        category_id: await catId('cobranza'), classified_by: 'manual' }).returning('id');
      const LIGADO = stP.id ?? stP;
      const SIN_PAR = (await admin('finance.bank_movements').where({ client_uuid: 'prueba-cb73-sinp-6' }).first('id')).id;
      const [lote] = await admin('finance.payment_calendar_lots').insert({ tenant_id: MEGA, lot_date: '2026-10-05' }).returning('id');
      await admin('finance.payment_allocations').insert({ tenant_id: MEGA, lot_id: lote.id ?? lote, classification: 'gasto', paid_bank_movement_id: LIGADO });
      await admin('finance.bank_capture_inbox').insert({ tenant_id: MEGA, from_phone: 'prueba-bfu25', bank_movement_id: LIGADO });
      await admin('finance.bank_capture_inbox').insert({ tenant_id: MEGA, from_phone: 'prueba-bfu25-sin', bank_movement_id: SIN_PAR });
      await admin('finance.payment_program').insert({ tenant_id: MEGA, source_month: '2026-10', client_uuid: 'prueba-bfu25', bank_movement_id: LIGADO });
      const hayCpq = (await admin.raw("select to_regclass('contpaqi.pago_confirmaciones') r")).rows[0].r;
      if (hayCpq) await admin('contpaqi.pago_confirmaciones').insert({ tenant_id: MEGA, bank_movement_id: LIGADO, facturas: ['FAC-PRUEBA-BFU25'], pagado: 100, confirmado_por: 'prueba', created_by: 'prueba' });

      const enCuadre = (await svc.cuadre('2026-10-20')).cuentas;
      const qS = enCuadre.find((c) => c.id === SINP)?.cuadre;
      check(qS?.cuadra === true && qS?.desde === '2026-10-05' && qS?.entrada === 'cuadra' && qS?.testigo?.fecha === '2026-10-04',
        `[CB.73] el cuadre: SINP cuadra desde el 05 y abre en el saldo con que la cuenta cerró el 04 (${JSON.stringify(qS)})`);
      check(enCuadre.find((c) => c.id === ROTA)?.cuadre.cuadra === false && enCuadre.find((c) => c.id === HUECO)?.cuadre.entrada === 'no_cuadra',
        '[CB.73] y en la misma lista ROTA no cuadra y HUECO no cuadra en la entrada');
      const uS = await svc.usarElBanco(SINP, 'prueba', '2026-10-20');
      check(uS.desde === '2026-10-05', `[CB.73] manda desde el primer día de la descarga (${uS.desde})`);
      check(uS.libro_borrados === 3 && uS.metidos === 6, `el 05 ligado, el 06 del libro (y la fecha futura) se reemplazan; entran los 3 días del banco (${uS.libro_borrados} borrados, ${uS.metidos} metidos)`);
      // [BFU.2.5] Cada liga pasó al renglón del banco que es el mismo movimiento (05, +100); la del 06 se declara.
      const nuevo = await admin('finance.bank_movements').where({ bank_account_id: SINP, sync_source: 'banco', movement_date: '2026-10-05' })
        .where('amount_in', 100).whereNull('deleted_at').first('id', 'customer_code', 'customer_nota', 'classified_by', 'category_id');
      const apunta = async (tabla, col, extra = {}) => (await admin(tabla).where({ [col]: nuevo?.id, ...extra }).count({ n: '*' }))[0].n;
      check(!!nuevo && Number(await apunta('finance.payment_allocations', 'paid_bank_movement_id')) === 1,
        '[BFU.2.5] el pago del calendario apunta al renglón del banco, no al reemplazado');
      check(Number(await apunta('finance.bank_capture_inbox', 'bank_movement_id', { from_phone: 'prueba-bfu25' })) === 1
        && Number(await apunta('finance.payment_program', 'bank_movement_id')) === 1,
        '[BFU.2.5] la captura y el programa de pagos también');
      if (hayCpq) check(Number(await apunta('contpaqi.pago_confirmaciones', 'bank_movement_id')) === 1, '[BFU.2.5] y la confirmación de ContPAQi');
      else noMedido('contpaqi.pago_confirmaciones no existe en este destino');
      check(nuevo?.customer_code === 'C-0042' && nuevo?.customer_nota === 'lo dijo cobranza' && nuevo?.classified_by === 'manual'
        && nuevo?.category_id === await catId('cobranza'), `[BFU.2.5] el cliente declarado y la categoría puesta a mano pasan al renglón del banco (${JSON.stringify(nuevo)})`);
      check(uS.religados === 1 && uS.sin_religar?.length === 1 && uS.sin_religar[0].fecha === '2026-10-06' && uS.sin_religar[0].importe === 30
        && uS.sin_religar[0].ligas.includes('captura de depósito'),
        `⛔ [BFU.2.5] el 06 (+30) no tiene pareja en el banco: se DECLARA, no se adivina (${JSON.stringify(uS.sin_religar)})`);
      check(Number((await admin('finance.bank_capture_inbox').where({ from_phone: 'prueba-bfu25-sin' }).first('bank_movement_id')).bank_movement_id === SIN_PAR ? 1 : 0) === 1,
        '[BFU.2.5] y su captura sigue en el renglón reemplazado (nada se pega a un movimiento que no es)');
      const vivosS = await admin('finance.bank_movements').where({ bank_account_id: SINP }).whereNull('deleted_at').whereNot('sync_source', 'banco').count({ n: '*' });
      check(Number(vivosS[0].n) === 2, `lo del libro antes del 05 no se toca (${vivosS[0].n} de 2)`);
      await recoger();
      const sinQuien = await niega(() => svc.usarElBanco(BANCO, undefined, '2026-10-20'));
      check(!!sinQuien, '⛔ sin una persona que lo decida, no se pasa');

      check((await recoger()).length === 0, '⛔ pasar al banco rechazado (sin racha, sin persona) no avisa');
      const u = await svc.usarElBanco(BANCO, 'prueba', '2026-10-20');
      const aU = await recoger();
      check(aU.length === 1 && aU[0].origen === 'descarga' && aU[0].cuenta === BANCO && aU[0].periodos.join() === '2026-10',
        `al pasar la cuenta, UN aviso a la conciliación con su periodo (${JSON.stringify(aU)})`);
      check(u.desde === '2026-10-01' && u.ya_estaba === false, `[CB.73] sin saldo anterior con que comparar, cuadra y manda desde el primer día de la descarga (${u.desde})`);
      check(u.libro_borrados === 23, `los renglones del libro desde ese día se marcan borrados (${u.libro_borrados} de 23)`);
      check(u.metidos === 24 && u.sin_sucursal === 0 && u.sin_categoria === 0, `los 24 renglones del banco entran con categoría y sucursal (${JSON.stringify(u)})`);
      const llaves = await admin('finance.bank_branch_keys').where({ bank_account_id: BANCO, active: true }).select('key_type', 'key_value', 'sucursal', 'confirmed_by');
      check(llaves.some((k) => k.key_type === 'terminal' && k.key_value === '100000009' && k.sucursal === '40' && k.confirmed_by === 'prueba'),
        `el catálogo guarda la terminal → sucursal 40, confirmada por quien pulsó (${llaves.length} llaves)`);
      const metidos = await admin('finance.bank_movements').where({ bank_account_id: BANCO, sync_source: 'banco' }).whereNull('deleted_at')
        .select('classified_by', 'sucursal', 'client_uuid');
      check(metidos.length === 24 && metidos.every((m) => m.classified_by === 'banco' && m.sucursal === '40' && m.client_uuid.startsWith('banco:')),
        'en bank_movements: sync_source y classified_by = banco, con su sucursal y la llave del renglón');
      const cta = await admin('finance.bank_accounts').where({ id: BANCO }).first(admin.raw("to_char(statement_source_since,'YYYY-MM-DD') d"), 'statement_source_set_by');
      check(cta.d === '2026-10-01' && cta.statement_source_set_by === 'prueba', 'la cuenta dice desde cuándo manda el banco y quién lo decidió');

      // [CB.75] El encabezado del periodo sale de los movimientos, no queda vacío: 12 días de +100 −2 desde 1,000.
      const encabezado = () => admin('finance.bank_statements').where({ bank_account_id: BANCO, period: '2026-10' })
        .first(admin.raw('opening_balance::float8 as ini'), admin.raw('closing_balance::float8 as fin'),
          admin.raw('total_in::float8 as ent'), admin.raw('total_out::float8 as sal'));
      const e12 = await encabezado();
      check(e12.ini === 1000 && e12.fin === 2176 && e12.ent === 1200 && e12.sal === 24,
        `⛔ [CB.75] al pasar al banco, el encabezado de oct = apertura, cierre y totales de los movimientos (${JSON.stringify(e12)})`);

      const otra = await svc.usarElBanco(BANCO, 'prueba', '2026-10-20');
      check(otra.ya_estaba === true && otra.metidos === 0, 'pulsar dos veces no hace nada dos veces');
      check((await recoger()).length === 0, '⛔ y no avisa: no entró nada');

      // Lo que se sube después entra solo.
      const r13 = renglonesDe(13, 13, r12[r12.length - 1].s);
      const c13 = await svc.confirmar({ file_base64: bbva(r13.map((x) => x.txt).reverse()), bank_account_id: BANCO, aceptar_sin_testigo: true }, 'prueba');
      check(c13.alimentado?.metidos === 2, `la descarga siguiente entra sola a los movimientos (${JSON.stringify(c13.alimentado)})`);
      const a13 = await recoger();
      check(a13.length === 1 && a13[0].origen === 'descarga', `y avisa a la conciliación (${JSON.stringify(a13)})`);

      // [CB.73] La cuenta que ya usa el banco sigue en «Cuadre» con su fecha, y la descarga siguiente la mantiene cuadrando.
      const qB = (await svc.cuadre('2026-10-20')).cuentas.find((x) => x.id === BANCO);
      check(qB?.banco_desde === '2026-10-01' && qB?.cuadre.cuadra === true && qB?.cuadre.hasta === '2026-10-13',
        `[CB.73] en el cuadre: usa el banco desde el 01 y su descarga sigue cuadrando hasta el 13 (${JSON.stringify(qB?.cuadre)})`);

      // La carga del libro: en esa cuenta, desde el 12, sus renglones NO entran (ni reviven el borrado) y lo dice.
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(`${ALIAS} BANCO`);
      ws.addRow(['FECHA', 'M', 'S', 'C', 'PROVEEDOR', 'RETIRO', 'DEPOSITO', 'SALDO']);
      ws.addRow([new Date(Date.UTC(2026, 9, 11)), 'I', '40', '102', 'VENTA TARJETA', null, 100, 1990]);
      ws.addRow([new Date(Date.UTC(2026, 9, 12)), 'I', '40', '102', 'VENTA TARJETA', null, 100, 2088]);
      const { FinanceBankService } = require(path.join(ROOT, 'libs/finance/src/lib/bank/finance-bank.service.ts'));
      const tk = { run: (cb) => runtime.transaction(async (trx) => { await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]); return cb(trx); }) };
      const fbs = new FinanceBankService(tk, { requireTenantId: () => MEGA });
      fbs.logger = { log() {}, warn() {}, error() {}, debug() {} };
      const imp = await fbs.importFromBuffer(Buffer.from(await wb.xlsx.writeBuffer()), '2026-10', 'prueba-cb60b.xlsx', 'prueba', 'upload');
      const hoja = imp.accounts.find((a) => a.sheet === `${ALIAS} BANCO`);
      check(/usa el banco desde 2026-10-01: 2 renglón/.test(hoja?.note ?? ''), `la carga del libro declara lo que no entró (${hoja?.note})`);
      const aLibro = await recoger();
      check(imp.total > 0 && aLibro.length === 1 && aLibro[0].origen === 'libro' && aLibro[0].periodos.join() === '2026-10',
        `la carga del libro también avisa a la conciliación: era el hueco declarado de CB.53 (${imp.total} renglón(es), ${JSON.stringify(aLibro)})`);
      await oyente.end();

      // [CB.60b] La FIRMA del oyente de la conciliación (CB.53) cuenta el lado banco con el tenant fijado. Corre fuera
      // de un request y como app_runtime (RLS forzado): sin el set_config contaba CERO siempre (prod, 2026-11-11).
      if (!(await admin.raw("select to_regclass('analytics.kepler_bank_movements') r")).rows[0].r) {
        // Sólo en un clúster sin la vista de Kepler (el temporal); si existe (CI, desarrollo) NO se toca.
        await admin.raw('create schema if not exists analytics');
        await admin.raw(`create view analytics.kepler_bank_movements as select null::uuid as tenant_id, null::text as account_label,
          null::date as fecha_efectiva, 0::int as signo, 0::numeric as importe where false`);
        await admin.raw('grant usage on schema analytics to app_runtime');
        await admin.raw('grant select on analytics.kepler_bank_movements to app_runtime');
      }
      const { BankReconPorAvisoService } = require(path.join(ROOT, 'libs/finance/src/lib/bank/bank-recon-aviso.service.ts'));
      const oyenteSvc = new BankReconPorAvisoService(runtime, {}, {}, {});
      oyenteSvc.logger = { log() {}, warn() {}, error() {}, debug() {} };
      const [{ n: sinTenant }] = await runtime('finance.bank_movements').where({ tenant_id: MEGA }).count('* as n');
      check(Number(sinTenant) === 0, `control: sin tenant, app_runtime no ve ni una fila de bank_movements (${sinTenant}) — lo que le pasaba a la firma`);
      const firma = await oyenteSvc.firmaDe('2026-10');
      const [{ n: esperado }] = await admin('finance.bank_movements as bm').join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where({ 'bm.tenant_id': MEGA, 'st.period': '2026-10' }).whereNull('bm.deleted_at').count('* as n');
      check(Number(esperado) > 0 && firma.bancoFilas === Number(esperado),
        `⛔ la firma del oyente ve el lado banco como app_runtime (RLS forzado): ${firma.bancoFilas} de ${esperado}`);
      const vivosLibro = await admin('finance.bank_movements').where({ bank_account_id: BANCO }).whereIn('sync_source', ['upload', 'sheet'])
        .where('movement_date', '>=', '2026-10-01').whereNull('deleted_at').count('* as n');
      check(Number(vivosLibro[0].n) === 0, `⛔ ningún renglón del libro vive desde el 01 (ni el borrado revivió): ${vivosLibro[0].n}`);
      const vivosBanco = await admin('finance.bank_movements').where({ bank_account_id: BANCO, sync_source: 'banco' }).whereNull('deleted_at').count('* as n');
      check(Number(vivosBanco[0].n) === 26, `los renglones del banco siguen intactos tras la carga del libro (${vivosBanco[0].n} de 26)`);
      // [CB.75] La carga del libro escribe el encabezado con lo que trae la hoja (aquí: nada, todo es del banco). En una
      // cuenta que usa el banco eso NO puede quedar: se re-deriva de los movimientos (13 días: cierra en 2,274).
      const eLibro = await encabezado();
      check(eLibro.ini === 1000 && eLibro.fin === 2274 && eLibro.ent === 1300 && eLibro.sal === 26,
        `⛔ [CB.75] la carga del libro no pisa el encabezado de una cuenta que usa el banco (${JSON.stringify(eLibro)})`);

      console.log('\n[14] BFU.3.4 — BBVA completa la referencia en la descarga siguiente: el mismo renglón no entra dos veces');
      // Inventado con la forma de BBVA 4176 (19-nov): el depósito del 14 llega «DEPOSITO EN EFECTIVO/» y, en la descarga
      // que se encima, «DEPOSITO EN EFECTIVO/0000001» con el mismo día, importe y saldo.
      const DEP = await cuenta('BBVA', '59006', `${ALIAS} DEP`);
      const F1 = bbva([
        '14-11-2026\tVENTAS DEBITO/100000011 TERMINALES PUNTO DE VENTA\t\t50.00\t7,471.00',
        '14-11-2026\tDEPOSITO EN EFECTIVO/\t\t100.00\t7,421.00',
      ]);
      const F2 = bbva([
        '15-11-2026\tVENTAS DEBITO/100000012 TERMINALES PUNTO DE VENTA\t\t10.00\t7,481.00',
        '14-11-2026\tVENTAS DEBITO/100000011 TERMINALES PUNTO DE VENTA\t\t50.00\t7,471.00',
        '14-11-2026\tDEPOSITO EN EFECTIVO/0000001\t\t100.00\t7,421.00',
      ]);
      const d1 = await svc.confirmar({ file_base64: F1, bank_account_id: DEP, aceptar_sin_testigo: true }, 'prueba');
      check(d1.nuevos === 2, `la primera descarga entra (${d1.nuevos})`);
      const uD = await svc.usarElBanco(DEP, 'prueba', '2026-11-20');
      check(uD.metidos === 2, `y la cuenta usa el banco (${uD.metidos} metidos)`);
      const rD = await svc.revisar({ file_base64: F2, bank_account_id: DEP });
      check(rD.nuevos === 1 && rD.ya_cargados === 2, `⛔ la revisión ve el depósito como ya cargado aunque cambió su concepto (${rD.nuevos} nuevo, ${rD.ya_cargados} ya cargados)`);
      const d2 = await svc.confirmar({ file_base64: F2, bank_account_id: DEP, aceptar_sin_testigo: true }, 'prueba');
      const lineasD = await admin('finance.bank_statement_lines').where({ bank_account_id: DEP }).select('concept', 'reference', 'amount_in');
      const depD = lineasD.filter((l) => Number(l.amount_in) === 100);
      check(d2.nuevos === 1 && lineasD.length === 3 && depD.length === 1,
        `⛔ entra sólo el renglón nuevo: 3 renglones, el depósito una vez (${lineasD.length}, depósitos ${depD.length})`);
      check(depD[0]?.concept === 'DEPOSITO EN EFECTIVO/0000001' && depD[0]?.reference === '0000001',
        `el renglón guardado toma el concepto completo (${depD[0]?.concept}, ref ${depD[0]?.reference})`);
      const movD = await admin('finance.bank_movements').where({ bank_account_id: DEP, sync_source: 'banco' }).whereNull('deleted_at').select('concept', 'amount_in');
      const sumaD = movD.reduce((a, m) => a + Number(m.amount_in), 0);
      check(movD.length === 3 && sumaD === 160 && movD.some((m) => m.concept === 'DEPOSITO EN EFECTIVO/0000001'),
        `en Bancos: 3 movimientos, $160 de abonos (no $260) y el depósito con su referencia (${movD.length}, $${sumaD})`);
      const qD = (await svc.cuadre('2026-11-20')).cuentas.find((x) => x.id === DEP)?.cuadre;
      check(qD?.cuadra === true && qD?.repetidos?.renglones === 0, `el cuadre no ve repetidos (${JSON.stringify(qD?.repetidos)}, cuadra ${qD?.cuadra})`);
      // ⛔ NEGATIVA: el repetido que dejaba el defecto, sembrado a mano en el segundo archivo → la cuenta no cuadra.
      const orig = await admin('finance.bank_statement_lines').where({ bank_account_id: DEP }).where('amount_in', 100).first();
      await admin('finance.bank_statement_lines').insert({ ...orig, id: undefined, file_id: d2.archivo_id, line_key: `${orig.line_key}-repetido`, concept: 'DEPOSITO EN EFECTIVO/' });
      const qN = (await svc.cuadre('2026-11-20')).cuentas.find((x) => x.id === DEP)?.cuadre;
      check(qN?.cuadra === false && qN?.repetidos?.renglones === 1 && qN?.repetidos?.importe === 100 && /dos veces/.test(qN?.motivo ?? ''),
        `⛔ con un renglón repetido entre archivos la cuenta NO cuadra y lo dice (${qN?.motivo})`);

      console.log('\n[15] BFU.7.4 — el motor de categoría: categoría con evidencia, o el motivo de por qué no');
      const { aplicarMotorDeCategoria } = require(path.join(ROOT, 'libs/finance/src/lib/bank/estado-de-cuenta/motor-de-categoria.aplicar.ts'));
      const [stDep] = await admin('finance.bank_statements').where({ bank_account_id: DEP, period: '2026-11' }).select('id');
      const retiro = async (n, extra = {}) => (await admin('finance.bank_movements').insert({ tenant_id: MEGA, statement_id: stDep.id, bank_account_id: DEP,
        movement_date: '2026-11-15', concept: `SPEI ENVIADO PRUEBA ${n}`, amount_in: 0, amount_out: n, client_uuid: `prueba-bfu74-${n}`,
        classified_by: 'banco', sync_source: 'banco', source_file: 'banco', ...extra }).returning('id'))[0];
      const idDe = (r) => r.id ?? r;
      const TRASP = idDe(await retiro(11));                 // casado con un traspaso (N-A-26): la categoría la da el documento
      const SIN_APL = idDe(await retiro(12));               // casado con un pago (X-D-26) que no se ve qué liquida: motivo
      const comision = await catId('comision_bancaria');
      const MANO = idDe(await retiro(13, { category_id: comision, classified_by: 'manual' })); // ya clasificado a mano
      const pareo = (mov, tipo, folio) => admin('finance.bank_recon_matches').insert({ tenant_id: MEGA, bank_movement_id: mov, kepler_sucursal: '01',
        kepler_doc_tipo: tipo, kepler_doc_folio: folio, kepler_amount: 1, match_type: 'inferred', match_confidence: 0.9, matched_by: 'motor-tes' });
      await pareo(TRASP, 'N-A-26', 'PRB0001'); await pareo(SIN_APL, 'X-D-26', 'PRB0002'); await pareo(MANO, 'N-A-26', 'PRB0003');
      const comoApp = (fn) => runtime.transaction(async (trx) => { await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [MEGA]); return fn(trx); });
      const ids = [TRASP, SIN_APL, MANO];
      const enSeco = await comoApp((trx) => aplicarMotorDeCategoria(trx, ids, { hoy: '2026-11-20', soloContar: true }));
      const tras0 = await admin('finance.bank_movements').where({ id: TRASP }).first('category_id', 'category_reason');
      check(enSeco.evaluados === 2 && enSeco.cambios === 2 && tras0.category_id === null && tras0.category_reason === null,
        `en seco evalúa 2 (lo manual no entra) y no escribe (${JSON.stringify(enSeco)})`);
      const r1 = await comoApp((trx) => aplicarMotorDeCategoria(trx, ids, { hoy: '2026-11-20' }));
      const de = async (id) => admin('finance.bank_movements as bm').leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('bm.id', id).first('mc.code', 'bm.classified_by', 'bm.category_reason', 'bm.category_evidence');
      const t1 = await de(TRASP), s1 = await de(SIN_APL), m1 = await de(MANO);
      check(t1.code === 'traspaso_entre_cuentas' && t1.classified_by === 'documento' && t1.category_reason === null && t1.category_evidence?.fuente === 'documento',
        `como app_runtime: casado con un traspaso → «traspaso», con su evidencia (${t1.code}/${t1.classified_by}/${JSON.stringify(t1.category_evidence)})`);
      check(s1.code === null && s1.category_reason === 'documento_sin_aplicacion' && s1.category_evidence?.responsable === 'sistemas',
        `⛔ sin de dónde sacar la categoría NO se adivina y queda el motivo con su responsable (${s1.category_reason}/${s1.category_evidence?.responsable})`);
      check(m1.code === 'comision_bancaria' && m1.classified_by === 'manual' && m1.category_reason === null, `⛔ lo puesto a mano no se toca (${m1.code}/${m1.classified_by})`);
      check(r1.categorizados + Object.values(r1.sin_categoria).reduce((a, b) => a + b, 0) === r1.evaluados,
        `cobertura: con categoría + con motivo = evaluados (${JSON.stringify(r1)})`);
      const r2 = await comoApp((trx) => aplicarMotorDeCategoria(trx, ids, { hoy: '2026-11-20' }));
      check(r2.cambios === 0, `⛔ la segunda corrida no escribe nada: el motor no se re-dispara solo (${JSON.stringify(r2)})`);
      await admin('finance.bank_recon_matches').where({ bank_movement_id: TRASP }).del();
      const r3 = await comoApp((trx) => aplicarMotorDeCategoria(trx, ids, { hoy: '2026-11-20' }));
      const t3 = await de(TRASP);
      check(r3.cambios === 1 && t3.code === null && t3.classified_by === 'banco' && !!t3.category_reason,
        `⛔ si el pareo se va, la categoría del documento se va y queda el motivo (${t3.code}/${t3.classified_by}/${t3.category_reason})`);
      noMedido('[BFU.7.4] la cuenta contable (kdxf → kdm6) necesita el ODS de Kepler: aquí sólo el traspaso y los motivos; en prod se mide antes/después');

      // [BFU.7.6] El diagnóstico dice la cobertura del motor: con categoría + por resolver + sin motivo = la descarga,
      // contrastado contra un conteo aparte. Se lee como app_runtime (RLS) por el mismo servicio que usa la pantalla.
      const { FinanceBankService: FBS76 } = require(path.join(ROOT, 'libs/finance/src/lib/bank/finance-bank.service.ts'));
      const fbs76 = new FBS76({ run: (cb) => comoApp(cb) }, { requireTenantId: () => MEGA });
      let dg = null;
      try { dg = await fbs76.diagnostico('2026-11'); } catch (e) { noMedido(`[BFU.7.6] el diagnóstico no corre en este destino: ${e.message}`); }
      if (dg) {
        const cc = dg.cobertura_categoria;
        const bancoNov = (await admin('finance.bank_movements as bm').join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
          .where({ 'st.period': '2026-11', 'bm.sync_source': 'banco', 'bm.tenant_id': MEGA }).whereNull('bm.deleted_at').count({ n: '*' }).first()).n;
        check(cc?.suma_cuadra === true && cc.evaluados === Number(bancoNov),
          `[BFU.7.6] la cobertura suma la descarga entera, contra un conteo aparte (${cc?.evaluados} de ${bancoNov})`);
        check(cc.por_resolver.some((g) => g.motivo === 'documento_sin_aplicacion' && g.responsable === 'sistemas' && g.n >= 1),
          `[BFU.7.6] el motivo que dejó el motor aparece con su responsable (${JSON.stringify(cc.por_resolver)})`);
        check(cc.con_categoria.n >= 1, `[BFU.7.6] lo categorizado (también lo puesto a mano) cuenta como con categoría (${cc.con_categoria.n})`);
      }
    }
  } finally {
    await limpiar(admin).catch(() => {});
    await admin.destroy();
    await runtime.destroy();
  }
}

async function soloLectura(url) {
  console.log('\n[modo SÓLO LECTURA — destino prod]');
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  try {
    servicio(pool);
    check(true, 'el servicio carga (ts-node) con sus dependencias reales');
    const falta = await faltantes(pool);
    if (falta.length) { noMedido(`la migración CB.56 no está aplicada en este destino: ${falta.join(', ')}`); return; }
    const r = await pool.raw(`SELECT count(*)::int archivos, count(*) FILTER (WHERE NOT balance_ok)::int sin_cuadre FROM finance.bank_statement_files WHERE tenant_id = ?`, [MEGA]);
    check(r.rows[0].sin_cuadre === 0, `ningún archivo guardado sin cuadre (${r.rows[0].archivos} archivos)`);
    noMedido('revisar/confirmar escriben: corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

(async () => {
  const urlAdmin = process.env.DATABASE_URL_NEW;
  const urlRuntime = process.env.DATABASE_URL_NEW_RUNTIME;
  const kAdmin = classify(urlAdmin).kind;
  const kRuntime = urlRuntime ? classify(urlRuntime).kind : null;
  if (kAdmin === 'local' && kRuntime === 'local') await completo(urlAdmin, urlRuntime);
  else if (kAdmin === 'prod') await soloLectura(urlAdmin);
  else noMedido(`destino no clasificable (admin ${kAdmin}, runtime ${kRuntime})`);
  fin();
})().catch((e) => { console.error(e); process.exit(1); });
