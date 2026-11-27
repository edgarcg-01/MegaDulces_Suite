#!/usr/bin/env node
'use strict';
/**
 * [PGP.213] La API de los contratos de cargos del banco — el SERVICIO REAL (`ChargeContractsService`, ts-node) contra base
 * real, con los cuerpos que manda la pantalla (regla 13), todo dentro de una transacción que se revierte (cero efecto) y,
 * si la conexión puede, como el rol de prod (`app_runtime`: permisos y RLS de verdad).
 *
 * Verifica (cifras de prueba):
 *   0. La migración que reparte la clave: la pone a tesoreria, finanzas_operativo y finanzas; no a marketing; no pisa un
 *      `false` puesto a mano; el down la quita. Idempotente.
 *   1. Antes de proponer, los cargos del banco salen «sin contrato»; `total`/`importe_total` cuentan TODO el rango aunque la
 *      página se tope (`has_more`).
 *   2. Proponer (DCR1) desde la historia del banco; la propuesta dice qué le falta para confirmarse.
 *   3. Dar de alta a mano (el cuerpo de la pantalla) y sus NEGATIVAS en llano: cuenta ajena, tipo fuera del catálogo,
 *      renglón fijo sin importe.
 *   4. Corregir una propuesta: clasificarla, corregir su renglón y agregar uno por tabla con su tabla; NEGATIVA: el renglón
 *      de otro contrato.
 *   5. Confirmar: sin PDF → 400 (DCR11); con PDF → confirmado y su cargo del mes PROGRAMADO en el Calendario, ya autorizado
 *      por el contrato (DCR5). NEGATIVAS: confirmar dos veces → 409; corregir un confirmado → 409.
 *   6. Con el contrato confirmado, sus cargos del banco dejan de estar «sin contrato».
 *   7. Rechazar (con motivo) y terminar (con motivo); sin motivo → 400; terminar una propuesta → 409.
 *   8. El PDF: URL firmada; sin PDF → 404.
 *   9. La pasada de cada carga del banco: corre sus 4 pasos sin fallas; repetirla no programa dos veces.
 * Ningún caso deja un aviso inesperado en el log.
 * ⚠️ Sin las tablas de PGP.209–212 sale con 2 = NO MEDIDO. ⛔ Escribe (aunque revierta): exige `assert-safe-target`.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp213-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000ab';
let pass = 0, fail = 0, nm = 0;
const avisos = [];
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Servicio, aHttp;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ ChargeContractsService: Servicio, aHttp } = require(path.join(__dirname, '../../libs/finance/src/lib/charge-contracts/charge-contracts.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}
const MIG = require('../migrations-newdb/20261126230517_pgp213_reparte_contratos_de_cargo.js');

const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp213-charge-contracts', { url: DST });
const knex = require('knex')({ client: 'pg', connection: { connectionString: DST }, pool: { min: 1, max: 2 } });
const salir = async () => {
  await knex.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};

/** El servicio real sobre la transacción de la prueba (cada `tk.run` es un SAVEPOINT) y un almacenamiento falso. */
function servicio(trx, subidos) {
  const storage = {
    isConfigured: () => true,
    putPdf: async (dataUri, folder) => {
      if (!/^data:application\/pdf/i.test(dataUri)) { const e = new Error('Solo se aceptan archivos PDF.'); e.status = 400; throw e; }
      const key = `${folder}/prueba-${subidos.length + 1}.pdf`; subidos.push(key); return { key, kind: 'pdf' };
    },
    signedUrl: async (key) => `https://almacen.prueba/${key}?firma=600`,
    remove: async () => undefined,
  };
  const s = new Servicio({ run: (fn) => trx.transaction((sp) => fn(sp)) }, { requireTenantId: () => T }, storage);
  s.logger = { log() { /* informativo */ }, warn(m) { avisos.push(String(m)); }, error(m) { avisos.push(String(m)); }, debug() { /* ídem */ } };
  return s;
}

/** El estado HTTP de lo que tira el servicio (y su mensaje), o null si no tiró. */
async function rechazo(fn) {
  try { await fn(); return null; } catch (e) {
    const h = aHttp(e);
    const st = h?.getStatus?.() ?? h?.status;
    return { status: st, msg: String(h?.message ?? e?.message) };
  }
}

/** El día `dia` del mes `k` meses antes del actual (YYYY-MM-DD). */
function haceMeses(k, dia) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); d.setUTCDate(dia);
  return d.toISOString().slice(0, 10);
}

(async () => {
  console.log('\n[PGP.213] la API de contratos de cargos del banco — servicio real, cuerpos de la pantalla, transacción que se revierte\n');
  let hay;
  try {
    hay = (await knex.raw(`SELECT to_regclass('finance.charge_contracts') IS NOT NULL AND to_regclass('finance.v_automatic_bank_charges') IS NOT NULL
                                  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'financial_commitments' AND column_name = 'contract_line_id') AS t`)).rows[0].t;
  } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }
  if (!hay) { noMedido('faltan las tablas o vistas de PGP.209–212 (migraciones sin aplicar)'); return salir(); }

  // 0. La migración que reparte la clave (como el dueño de la base; revertida).
  console.log(' 0. La migración reparte la clave a Tesorería y Finanzas');
  if (!(await knex.raw(`SELECT to_regclass('identity.role_permissions') IS NOT NULL AS t`)).rows[0].t) {
    noMedido('no existe identity.role_permissions en esta base');
  } else {
    const t0 = await knex.transaction();
    try {
      await t0.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const roles = ['tesoreria', 'finanzas_operativo', 'finanzas', 'marketing', 'prueba_pgp213_false'];
      await t0('identity.role_permissions').whereIn('role_name', roles).update({ deleted_at: t0.fn.now() }).catch(() => undefined);
      const cols = (await t0.raw(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'role_permissions'`)).rows.map((r) => r.column_name);
      const fila = (rol, perms) => Object.fromEntries(Object.entries({ tenant_id: T, role_name: rol, permissions: JSON.stringify(perms), deleted_at: null }).filter(([k]) => cols.includes(k)));
      await t0('identity.role_permissions').insert(['tesoreria', 'finanzas_operativo', 'finanzas', 'marketing'].map((r) => fila(r, { FINANCE_PAYMENTS_VER: true })));
      // A finanzas alguien le puso la clave en false a mano: no se le pisa.
      await t0.raw(`UPDATE identity.role_permissions SET permissions = permissions || '{"${MIG.CLAVE}": false}'::jsonb WHERE role_name = 'finanzas' AND deleted_at IS NULL`);
      await MIG.up(t0);
      const valor = async (rol) => (await t0.raw(`SELECT permissions ->> ? AS v FROM identity.role_permissions WHERE role_name = ? AND deleted_at IS NULL`, [MIG.CLAVE, rol])).rows.map((r) => r.v);
      ok(JSON.stringify(await valor('tesoreria')) === '["true"]' && JSON.stringify(await valor('finanzas_operativo')) === '["true"]', 'tesoreria y finanzas_operativo reciben la clave');
      ok(JSON.stringify(await valor('marketing')) === '[null]', 'NEGATIVA: marketing (tiene la clave de Pagos) NO la recibe');
      ok(JSON.stringify(await valor('finanzas')) === '["false"]', 'un false puesto a mano no se pisa');
      await MIG.up(t0);
      ok(JSON.stringify(await valor('tesoreria')) === '["true"]', 'up dos veces: idempotente');
      await MIG.down(t0);
      ok(JSON.stringify(await valor('tesoreria')) === '[null]' && JSON.stringify(await valor('finanzas')) === '["false"]', 'down quita SÓLO lo que puso (el false a mano se queda)');
    } catch (e) { ok(false, `la migración de la clave tronó: ${e.message}`); } finally { await t0.rollback().catch(() => undefined); }
  }

  const trx = await knex.transaction();
  const subidos = [];
  try {
    await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    const hoy = (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    // Siembra (como el dueño): dos cuentas nuestras, una de OTRO tenant, y la historia del banco.
    const cuenta = async (tenant, etiqueta) => (await trx.raw(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, kind) VALUES (?, 'BANCO PRUEBA', ?, 'bank') RETURNING id::text`, [tenant, etiqueta])).rows[0].id;
    const cta = await cuenta(T, '9213');
    const cta2 = await cuenta(T, '9214');
    await trx.raw(`SET LOCAL app.tenant_id = '${OTRO}'`);
    const ajena = await cuenta(OTRO, '9999');
    await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    const [est] = (await trx.raw(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES (?, ?, 'prueba-pgp213') RETURNING id::text`, [T, cta])).rows;
    let n = 0;
    const mov = (fecha, importe, concepto) => trx.raw(`INSERT INTO finance.bank_movements (tenant_id, statement_id, bank_account_id, movement_date, client_uuid, concept, amount_in, amount_out, sync_source)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'upload')`, [T, est.id, cta, fecha, `pgp213-${++n}`, concepto, importe]);
    const INT = [22013.10, 20486.20, 16076.30, 12693.40, 10529.50];
    for (let k = 5; k >= 1; k--) {
      await mov(haceMeses(k, 5), 83333.33, 'PAGO DE CAPITAL 012345678');
      await mov(haceMeses(k, 5), INT[5 - k], 'PAGO DE INTERESES 012345678');
    }
    for (let k = 3; k >= 1; k--) {
      await mov(haceMeses(k, 24), 21291, 'DOMICILIACION PAGO SERVICIO');
      await mov(haceMeses(k, 27), 21291, 'DOMICILIACION PAGO SERVICIO');
      await mov(haceMeses(k, 2), 830, 'COM SERV BBVA');
    }
    const desde = haceMeses(6, 1);

    let comoRuntime = false;
    try { await trx.raw('SET LOCAL ROLE app_runtime'); comoRuntime = (await trx.raw('SELECT current_user AS u')).rows[0].u === 'app_runtime'; } catch { /* se declara */ }
    if (!comoRuntime) noMedido('esta conexión no puede volverse app_runtime: los permisos y la RLS no se prueban como el rol de prod');
    const s = servicio(trx, subidos);

    console.log('\n 1. Antes de proponer: todo «sin contrato», y la cifra se puede recorrer');
    const sc0 = await s.sinContrato({ desde, hasta: hoy });
    const nuestros0 = sc0.cargos.filter((c) => c.cuenta.id === cta);
    ok(sc0.total >= 19 && nuestros0.length === 19 && nuestros0.every((c) => c.motivo === 'sin_contrato'), `los 19 cargos sembrados salen «sin contrato» (total ${sc0.total})`);
    const sc1 = await s.sinContrato({ desde, hasta: hoy, limit: 1 });
    ok(sc1.cargos.length === 1 && sc1.has_more === true && sc1.total === sc0.total && sc1.importe_total === sc0.importe_total,
      `con limit=1: 1 en la página, has_more, y total/importe de TODO el rango (${sc1.total} · $${sc1.importe_total})`);
    const malo = await rechazo(() => s.sinContrato({ desde: '2026-13-01', hasta: hoy }));
    ok(malo?.status === 400 && /tienen que existir/.test(malo.msg), `NEGATIVA: una fecha que no existe (mes 13) → 400 (${malo?.msg})`);

    console.log('\n 2. El sistema propone (DCR1)');
    const r1 = await s.proponer('prueba-pgp213');
    ok(r1.contratos === 3 && r1.renglones === 4, `3 propuestas (crédito con 2 renglones, domiciliación, comisión) de 4 series (${JSON.stringify(r1)})`);
    let lista = await s.listar();
    const de = (re) => lista.contratos.find((c) => c.cuenta.id === cta && re.test(c.acreedor));
    let domi = de(/^DOMICILIACION/);
    const credito = de(/^Crédito 012345678$/);
    ok(lista.conteo.propuesto >= 3 && domi?.estado === 'propuesto' && domi.evidencia.length === 1, 'listar: las propuestas primero, con la evidencia de su serie');
    ok(domi?.faltan_para_confirmar.some((p) => /Falta decir qué es/.test(p)), `la propuesta dice qué le falta (${domi?.faltan_para_confirmar.join(' ')})`);
    const r2 = await s.proponer('prueba-pgp213');
    ok(r2.contratos === 0, 'proponer otra vez no propone nada');

    console.log('\n 3. Dar de alta a mano, con el cuerpo de la pantalla');
    const cuerpo = {
      tipo: 'seguro', acreedor: 'Aseguradora de Prueba', referencia: 'Póliza 123', cuenta_id: cta2, cadencia: 'mensual', dia_desde: 15, dia_hasta: 15,
      inicio: haceMeses(2, 15), fin: null, notas: 'alta a mano',
      renglones: [{ concepto: 'seguro', descripcion: 'Prima mensual', regla_importe: 'fijo', importe_fijo: 4500, cargos_por_periodo: 1 }],
    };
    const alta = await s.crear(cuerpo, 'tesoreria');
    ok(alta.contrato.estado === 'propuesto' && alta.contrato.origen === 'manual' && alta.contrato.renglones[0].importe_fijo === 4500,
      'nace propuesto, origen manual, con su renglón');
    let e = await rechazo(() => s.crear({ ...cuerpo, cuenta_id: ajena }, 'tesoreria'));
    ok(e?.status === 400 && /no es una cuenta de Mega Dulces/.test(e.msg), `NEGATIVA: la cuenta de OTRO tenant → 400 (${e?.msg})`);
    e = await rechazo(() => s.crear({ ...cuerpo, tipo: 'regalo' }, 'tesoreria'));
    ok(e?.status === 400 && /tipo de contrato/.test(e.msg), `NEGATIVA: tipo fuera del catálogo → 400 en llano (${e?.msg})`);
    e = await rechazo(() => s.crear({ ...cuerpo, renglones: [{ ...cuerpo.renglones[0], importe_fijo: null }] }, 'tesoreria'));
    ok(e?.status === 400 && /Concepto 1/.test(e.msg), `NEGATIVA: renglón fijo sin importe → 400 que dice cuál (${e?.msg})`);

    console.log('\n 4. Corregir una propuesta');
    const r0 = domi.renglones[0];
    const ed = await s.editar(domi.id, {
      tipo: 'arrendamiento', acreedor: 'Arrendadora de Prueba',
      renglones: [{ id: r0.id, concepto: 'renta', descripcion: 'Renta (2 cargos al mes)', regla_importe: 'fijo', importe_fijo: 21291, cargos_por_periodo: 2 }],
    }, 'tesoreria');
    domi = ed.contrato;
    ok(domi.tipo === 'arrendamiento' && domi.acreedor === 'Arrendadora de Prueba' && domi.renglones[0].series_key === r0.series_key && domi.renglones[0].descripcion.startsWith('Renta'),
      'clasificada y su renglón corregido; la serie del banco (su evidencia) no cambia');
    const capital = credito.renglones.find((r) => r.concepto === 'capital');
    const tabla = [{ fecha: haceMeses(-1, 5), importe: 83333.33, saldo: 916666.67 }, { fecha: haceMeses(-2, 5), importe: 83333.33, saldo: 833333.34 }];
    const ed2 = await s.editar(credito.id, {
      tipo: 'credito', acreedor: 'Banco de Prueba · crédito 012345678',
      renglones: [{ id: capital.id, concepto: 'capital', descripcion: 'Capital por tabla', regla_importe: 'tabla', tabla },
        { concepto: 'iva', descripcion: 'IVA del interés', regla_importe: 'estimado' }],
    }, 'tesoreria');
    const capital2 = ed2.contrato.renglones.find((r) => r.id === capital.id);
    ok(capital2.regla_importe === 'tabla' && capital2.importe_fijo === null && capital2.tabla.length === 2 && ed2.contrato.renglones.length === 3,
      'el capital pasa a tabla (sin importe fijo) con sus 2 filas, y se agregó el IVA');
    const ed3 = await s.editar(credito.id, { renglones: [{ id: capital.id, concepto: 'capital', descripcion: 'Capital por tabla', regla_importe: 'tabla', tabla: tabla.slice(0, 1) }] }, 'tesoreria');
    ok(ed3.contrato.renglones.find((r) => r.id === capital.id).tabla.length === 1, 'la tabla se REEMPLAZA entera (2 → 1 fila)');
    e = await rechazo(() => s.editar(domi.id, { renglones: [{ id: capital.id, concepto: 'renta', descripcion: 'Ajeno', regla_importe: 'estimado' }] }, 'tesoreria'));
    ok(e?.status === 400 && /no es de este contrato/.test(e.msg), `NEGATIVA: el renglón de OTRO contrato → 400 (${e?.msg})`);
    e = await rechazo(() => s.editar(domi.id, { dia_desde: 28, dia_hasta: 3 }, 'tesoreria'));
    ok(e?.status === 400, `NEGATIVA: «hasta» antes que «desde» → 400 (${e?.msg})`);

    console.log('\n 5. Confirmar (DCR11 y DCR5)');
    e = await rechazo(() => s.confirmar(domi.id, {}, 'tesoreria'));
    ok(e?.status === 400 && /Falta el PDF/.test(e.msg), `sin el PDF del arrendamiento → 400 en llano (${e?.msg})`);
    e = await rechazo(() => s.subirDocumento(domi.id, { pdf: 'data:image/png;base64,iVBOR', nombre: 'foto.png' }, 'tesoreria'));
    ok(e?.status === 400 && subidos.length === 0, `NEGATIVA: una imagen no es el PDF → 400, nada subido (${e?.msg})`);
    const doc = await s.subirDocumento(domi.id, { pdf: 'data:application/pdf;base64,JVBERi0xLjQK', nombre: 'Contrato arrendamiento.pdf' }, 'tesoreria');
    ok(doc.contrato.documento?.nombre === 'Contrato arrendamiento.pdf' && subidos.length === 1, 'el PDF sube y queda en el contrato');
    const conf = await s.confirmar(domi.id, { notas: 'confirmado con su contrato' }, 'tesoreria');
    ok(conf.contrato.estado === 'confirmado' && conf.contrato.confirmado?.por === 'tesoreria' && conf.contrato.notas === 'confirmado con su contrato',
      'confirmado, con quién y la nota');
    ok(!conf.aviso && conf.cargos && conf.cargos.generados >= 1, `al confirmar se programa su cargo del mes (${JSON.stringify(conf.cargos)}${conf.aviso ? ` · aviso: ${conf.aviso}` : ''})`);
    const prog = (await trx.raw(`SELECT count(*)::int AS n, count(*) FILTER (WHERE a.authorized_by = ?)::int AS firmados
        FROM finance.financial_commitments fc
        JOIN finance.payment_allocation_items i ON i.obligation_source = 'financial_commitment' AND i.obligation_id = fc.id
        JOIN finance.payment_allocations a ON a.id = i.allocation_id
       WHERE fc.contract_id = ?`, [`contrato:${domi.id}`, domi.id])).rows[0];
    ok(prog.n >= 1 && prog.firmados === prog.n, `cada cargo programado lleva la firma del contrato (${prog.firmados} de ${prog.n})`);
    e = await rechazo(() => s.confirmar(domi.id, {}, 'tesoreria'));
    ok(e?.status === 409, `NEGATIVA: confirmar dos veces → 409 (${e?.msg})`);
    e = await rechazo(() => s.editar(domi.id, { notas: 'cambio' }, 'tesoreria'));
    ok(e?.status === 409 && /sólo una propuesta se corrige/.test(e.msg), `NEGATIVA: corregir un confirmado → 409 (${e?.msg})`);

    console.log('\n 6. Con el contrato confirmado, sus cargos dejan de estar «sin contrato»');
    const sc2 = await s.sinContrato({ desde, hasta: hoy, limit: 1000 });
    const domiSin = sc2.cargos.filter((c) => c.cuenta.id === cta && /^DOMICILIACION/.test(c.concepto ?? ''));
    ok(domiSin.length === 0 && sc2.total === sc0.total - 6, `los 6 cargos de la domiciliación salen de la lista (${sc0.total} → ${sc2.total})`);
    ok(sc2.cargos.filter((c) => c.cuenta.id === cta).every((c) => c.motivo === 'propuesta_sin_confirmar'), 'los demás dicen que su propuesta espera a Tesorería');

    console.log('\n 7. Rechazar y terminar, siempre con motivo');
    const com = lista.contratos.find((c) => c.cuenta.id === cta && /^COM SERV/.test(c.acreedor));
    e = await rechazo(() => s.rechazar(com.id, { motivo: '' }, 'tesoreria'));
    ok(e?.status === 400 && /motivo/.test(e.msg), `rechazar sin motivo → 400 (${e?.msg})`);
    const rech = await s.rechazar(com.id, { motivo: 'es la comisión de la cuenta, no un contrato aparte' }, 'tesoreria');
    ok(rech.contrato.estado === 'cancelado' && rech.contrato.rechazado?.motivo?.startsWith('es la comisión'), 'rechazada con su motivo');
    e = await rechazo(() => s.rechazar(com.id, { motivo: 'otra vez' }, 'tesoreria'));
    ok(e?.status === 409, `NEGATIVA: rechazar dos veces → 409 (${e?.msg})`);
    e = await rechazo(() => s.terminar(alta.contrato.id, { motivo: 'no aplica' }, 'tesoreria'));
    ok(e?.status === 409, `NEGATIVA: terminar una propuesta → 409 (${e?.msg})`);
    const antesDeTerminar = (await trx.raw(`SELECT to_char(fc.original_due_date, 'YYYY-MM-DD') AS fecha, a.status, fc.status AS compromiso
        FROM finance.financial_commitments fc
        JOIN finance.payment_allocation_items i ON i.obligation_source = 'financial_commitment' AND i.obligation_id = fc.id
        JOIN finance.payment_allocations a ON a.id = i.allocation_id
       WHERE fc.contract_id = ? ORDER BY fc.original_due_date`, [domi.id])).rows;
    const term = await s.terminar(domi.id, { motivo: 'venció el arrendamiento', fin: hoy }, 'tesoreria');
    ok(term.contrato.estado === 'terminado' && term.contrato.fin === hoy && term.contrato.terminado?.motivo === 'venció el arrendamiento', 'terminado con motivo y fecha de fin');
    const despuesDeTerminar = (await trx.raw(`SELECT to_char(fc.original_due_date, 'YYYY-MM-DD') AS fecha, a.status, fc.status AS compromiso,
             EXISTS (SELECT 1 FROM finance.payment_allocation_history h WHERE h.allocation_id = a.id AND h.event = 'retirado_por_fin_de_contrato') AS bitacora
        FROM finance.financial_commitments fc
        JOIN finance.payment_allocation_items i ON i.obligation_source = 'financial_commitment' AND i.obligation_id = fc.id
        JOIN finance.payment_allocations a ON a.id = i.allocation_id
       WHERE fc.contract_id = ? ORDER BY fc.original_due_date`, [domi.id])).rows;
    const futuros = despuesDeTerminar.filter((x) => x.fecha > hoy), pasados = despuesDeTerminar.filter((x) => x.fecha <= hoy);
    ok(futuros.length >= 1 && futuros.every((x) => x.status === 'cancelled' && x.compromiso === 'cancelled' && x.bitacora)
      && term.cargos_retirados?.retirados.length === futuros.length,
      `lo programado DESPUÉS del fin sale del Calendario, con su bitácora (${futuros.map((x) => x.fecha).join(', ')})`);
    ok(pasados.every((x) => x.status === 'pending') && pasados.length === antesDeTerminar.filter((x) => x.fecha <= hoy).length,
      `NEGATIVA: lo de antes del fin se queda (el banco pudo cobrarlo tarde): ${pasados.map((x) => `${x.fecha} ${x.status}`).join(', ') || 'ninguno'}`);
    e = await rechazo(() => s.subirDocumento(domi.id, { pdf: 'data:application/pdf;base64,JVBERi0xLjQK', nombre: 'x.pdf' }, 'tesoreria'));
    ok(e?.status === 409 && subidos.length === 1, `NEGATIVA: subir PDF a un terminado → 409 ANTES de subir (no queda un PDF huérfano: ${subidos.length} subido) (${e?.msg})`);

    console.log('\n 8. El PDF del contrato');
    const url = await s.urlDocumento(domi.id);
    ok(/^https:\/\/almacen\.prueba\/finance\/.+\.pdf\?firma=600$/.test(url.url) && url.nombre === 'Contrato arrendamiento.pdf', 'URL firmada del PDF guardado');
    e = await rechazo(() => s.urlDocumento(alta.contrato.id));
    ok(e?.status === 404, `NEGATIVA: un contrato sin PDF → 404 (${e?.msg})`);
    e = await rechazo(() => s.urlDocumento('no-es-uuid'));
    ok(e?.status === 400, 'NEGATIVA: id que no es uuid → 400');

    console.log('\n 9. La pasada de cada carga del banco');
    const p1 = await s.pasada('sistema:cargos-del-banco', hoy);
    ok(p1.fallas.length === 0 && p1.propuesta && p1.cargos && p1.cerrados !== null, `corre sus 4 pasos sin fallas (${JSON.stringify({ ...p1, cargos: p1.cargos && { ...p1.cargos, omitidos: p1.cargos.omitidos.length } })})`);
    const antes = (await trx.raw(`SELECT count(*)::int AS n FROM finance.financial_commitments WHERE contract_id IS NOT NULL`)).rows[0].n;
    const p2 = await s.pasada('sistema:cargos-del-banco', hoy);
    const despues = (await trx.raw(`SELECT count(*)::int AS n FROM finance.financial_commitments WHERE contract_id IS NOT NULL`)).rows[0].n;
    ok(p2.fallas.length === 0 && despues === antes && p2.cargos.generados === 0, `repetirla no programa dos veces (${antes} = ${despues})`);
  } catch (err) {
    ok(false, `la prueba tronó: ${err.stack || err.message}`);
  } finally {
    await trx.rollback().catch(() => undefined);
  }
  ok(avisos.length === 0, `ningún aviso inesperado en el log (${avisos.length})${avisos.length ? ': ' + avisos.slice(0, 3).join(' | ') : ''}`);
  return salir();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
