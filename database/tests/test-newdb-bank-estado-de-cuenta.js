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
  '@megadulces/platform-core': { TenantKnexService: class {}, TenantContextService: class {}, todayMx, applySmartSearch: () => {}, Permission: {}, isPlatformAdminRole: () => false },
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

      // STDR tiene UN día que cuadra (el 02): hay racha, pero corta. Con cero días fallaría por otro lado y no probaría la regla.
      const corto = await niega(() => svc.usarElBanco(STDR, 'prueba', '2026-11-09'));
      check(/hacen falta 10/.test(JSON.stringify(corto?.response ?? corto?.message ?? '')),
        `⛔ una cuenta con menos de 10 días seguidos que cuadran NO puede usar el banco: STDR lleva 1 (${JSON.stringify(corto?.response?.motivos ?? corto?.message)})`);
      const sinQuien = await niega(() => svc.usarElBanco(BANCO, undefined, '2026-10-20'));
      check(!!sinQuien, '⛔ sin una persona que lo decida, no se pasa');

      const u = await svc.usarElBanco(BANCO, 'prueba', '2026-10-20');
      check(u.desde === '2026-10-12' && u.ya_estaba === false, `manda el banco desde el día siguiente al último que cuadró (${u.desde})`);
      check(u.libro_borrados === 1, `el renglón del libro del día a medias se marca borrado (${u.libro_borrados})`);
      check(u.metidos === 2 && u.sin_sucursal === 0 && u.sin_categoria === 0, `los 2 renglones del banco del 12 entran con categoría y sucursal (${JSON.stringify(u)})`);
      const llaves = await admin('finance.bank_branch_keys').where({ bank_account_id: BANCO, active: true }).select('key_type', 'key_value', 'sucursal', 'confirmed_by');
      check(llaves.some((k) => k.key_type === 'terminal' && k.key_value === '100000009' && k.sucursal === '40' && k.confirmed_by === 'prueba'),
        `el catálogo guarda la terminal → sucursal 40, confirmada por quien pulsó (${llaves.length} llaves)`);
      const metidos = await admin('finance.bank_movements').where({ bank_account_id: BANCO, sync_source: 'banco' }).whereNull('deleted_at')
        .select('classified_by', 'sucursal', 'client_uuid');
      check(metidos.length === 2 && metidos.every((m) => m.classified_by === 'banco' && m.sucursal === '40' && m.client_uuid.startsWith('banco:')),
        'en bank_movements: sync_source y classified_by = banco, con su sucursal y la llave del renglón');
      const cta = await admin('finance.bank_accounts').where({ id: BANCO }).first(admin.raw("to_char(statement_source_since,'YYYY-MM-DD') d"), 'statement_source_set_by');
      check(cta.d === '2026-10-12' && cta.statement_source_set_by === 'prueba', 'la cuenta dice desde cuándo manda el banco y quién lo decidió');

      const otra = await svc.usarElBanco(BANCO, 'prueba', '2026-10-20');
      check(otra.ya_estaba === true && otra.metidos === 0, 'pulsar dos veces no hace nada dos veces');

      // Lo que se sube después entra solo.
      const r13 = renglonesDe(13, 13, r12[r12.length - 1].s);
      const c13 = await svc.confirmar({ file_base64: bbva(r13.map((x) => x.txt).reverse()), bank_account_id: BANCO, aceptar_sin_testigo: true }, 'prueba');
      check(c13.alimentado?.metidos === 2, `la descarga siguiente entra sola a los movimientos (${JSON.stringify(c13.alimentado)})`);

      // ⛔ El comparador no compara al banco contra sí mismo.
      const cl2 = await svc.contraElLibro(30, '2026-10-20');
      const d12 = cl2.cuentas.find((c) => c.id === BANCO)?.dias.find((d) => d.fecha === '2026-10-12');
      check(d12?.veredicto === 'sin_libro', `⛔ el 12 ya no «cuadra» contra los renglones que metió el propio banco (${d12?.veredicto})`);

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
      check(/usa el banco desde 2026-10-12: 1 renglón/.test(hoja?.note ?? ''), `la carga del libro declara lo que no entró (${hoja?.note})`);
      const vivosLibro = await admin('finance.bank_movements').where({ bank_account_id: BANCO }).whereIn('sync_source', ['upload', 'sheet'])
        .where('movement_date', '>=', '2026-10-12').whereNull('deleted_at').count('* as n');
      check(Number(vivosLibro[0].n) === 0, `⛔ ningún renglón del libro vive desde el 12 (ni el borrado revivió): ${vivosLibro[0].n}`);
      const vivosBanco = await admin('finance.bank_movements').where({ bank_account_id: BANCO, sync_source: 'banco' }).whereNull('deleted_at').count('* as n');
      check(Number(vivosBanco[0].n) === 4, `los renglones del banco siguen intactos tras la carga del libro (${vivosBanco[0].n})`);
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
