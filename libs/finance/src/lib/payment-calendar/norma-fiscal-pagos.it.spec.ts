/**
 * `[PGP.225]` **El freno fiscal del Calendario contra Postgres real** (regla 13): el código real de
 * `PaymentCalendarService` (crear, sumar, reprogramar, autorizar el pago y el día) con el payload de la pantalla,
 * contra `fiscal.cfdis` y `kepler_ods.kdxe` de verdad.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`). Sin la
 * variable se salta y lo DICE. ⭐ Todo corre en UNA transacción que se revierte: la base queda como estaba.
 *
 * ⚠️ `analytics.v_supplier_rfc` (el RFC del acreedor) nace de migraciones que asertan datos reales del ERP y en una
 * base vacía no existe. Dentro de la transacción se aparta la real (si la hay) y se pone una de prueba con sus mismas
 * cuatro columnas que lee el Calendario: lo que se prueba aquí es el freno, no la vista del RFC.
 * Datos de PRUEBA (acreedor `NFIT01`), nunca reales.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { PaymentCalendarService, keplerPayableId } from './payment-calendar.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const USER = 'nf_it_tesoreria';
const DIR = 'nf_it_direccion';
const PROV = 'NFIT01';
const RFC = 'NFI010101AB1';
const MIG_AUTORIZACIONES = '../../../../../database/migrations-newdb/20261126215436_pgp224_autorizaciones_norma_fiscal_cfdi.js';
const MIGS = [
  '../../../../../database/migrations-newdb/20261008174741_analytics_v_supplier_payables.js',
  '../../../../../database/migrations-newdb/20261016171340_tp18_allocation_items_origen_kepler_payable.js',
  '../../../../../database/migrations-newdb/20261016185746_tp19_allocation_liga_pago_kepler.js',
  '../../../../../database/migrations-newdb/20261106183612_pgp91_descuento_al_pagar_en_el_calendario.js',
  '../../../../../database/migrations-newdb/20261109163309_pgp101_varios_descuentos_por_factura.js',
  '../../../../../database/migrations-newdb/20261110080925_pgp107_evidencia_del_pago.js',
  '../../../../../database/migrations-newdb/20261110141406_pgp113_autorizacion_por_pago.js',
  '../../../../../database/migrations-newdb/20261026173001_pgp17_creditos_de_proveedor_aplicados_y_no.js',
  '../../../../../database/migrations-newdb/20261113171713_pgp120_descuento_por_anticipo.js',
  '../../../../../database/migrations-newdb/20261113175529_pgp119_anticipo_como_obligacion_de_pago.js',
  MIG_AUTORIZACIONES,
];

type Migracion = { up: (k: Knex) => Promise<void>; down: (k: Knex) => Promise<void> };
const migracion = (rel: string) => createRequire(__filename)(resolvePath(__dirname, rel)) as Migracion;

async function migUp(rel: string, trx: Knex.Transaction): Promise<void> {
  await migracion(rel).up(trx);
}

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[PGP.225] NO MEDIDO: sin TP_IT_DB la prueba de integración no corre.');
else if (!local) console.log('[PGP.225] NO MEDIDO: TP_IT_DB no es una base local; me niego a escribir ahí.');

suite('[PGP.225] el freno fiscal del Calendario contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let cal: PaymentCalendarService;
  let origen = '';

  const kid = (folio: string) => keplerPayableId('08', 20, 1, folio);
  const kp = (folio: string, monto: number) => ({ obligation_source: 'kepler_payable' as const, obligation_id: kid(folio), applied_amount: monto });
  const transferencia = { payment_method: 'transferencia' as const, destination_account_text: 'BBVA · CLABE 032180000118359719' };
  const renglones = async (folio: string) =>
    Number((await trx('finance.payment_allocation_items').where({ tenant_id: M, obligation_id: kid(folio) }).count('* as n'))[0].n);

  /** Una factura de Kepler (sucursal 08) y su CFDI recibido, con la misma fecha e importe. */
  const factura = async (folio: string, monto: number, fecha: string, cfdi: {
    uuid: string; metodo: string; forma: string; estatus: string; uso?: string; regimen?: string;
    /** Lo que guarda `fiscal.cfdis.fecha` tal cual, y de qué descarga vino (cada una con su convención). */
    guardada?: string; source?: 'contpaqi_add' | 'descarga_masiva';
  }) => {
    await trx('kepler_ods.kdxe').insert({ sucursal: '08', c1: '08', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: folio, c7: `${fecha} 00:00:00`, c10: `${fecha} 00:00:00`, c11: monto });
    await trx('fiscal.cfdis').insert({
      tenant_id: M, uuid: cfdi.uuid, rol: 'recibidas', tipo_comprobante: 'I', source: cfdi.source ?? 'contpaqi_add', estatus_sat: cfdi.estatus,
      emisor_rfc: RFC, total: monto, fecha: cfdi.guardada ?? `${fecha} 12:00:00-06`, metodo_pago: cfdi.metodo, forma_pago: cfdi.forma,
      receptor_uso_cfdi: cfdi.uso ?? 'G01', receptor_regimen: cfdi.regimen ?? '612', emisor_regimen: '601',
    });
  };
  const preparado = async (fecha: string, folio: string, monto: number) => {
    const a = await cal.createAllocation({ date: fecha, items: [kp(folio, monto)] }, USER);
    await cal.prepare(a.id, { ...transferencia, bank_account_id: origen }, USER);
    return a.id;
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    if (!(await trx.raw(`SELECT to_regclass('analytics.v_supplier_payables') AS r`)).rows[0].r) await migUp(MIGS[0], trx);
    for (const rel of MIGS.slice(1)) await migUp(rel, trx);   // idempotentes: lo que le falte a la base local

    // La vista del RFC: la real se aparta (si existe) y queda una de prueba con las columnas que lee el Calendario.
    if ((await trx.raw(`SELECT to_regclass('analytics.v_supplier_rfc') AS r`)).rows[0].r) {
      await trx.raw('ALTER VIEW analytics.v_supplier_rfc RENAME TO v_supplier_rfc__aparte_pgp225');
    }
    // DDL no admite parámetros: las dos constantes de prueba van en el texto.
    await trx.raw(`CREATE VIEW analytics.v_supplier_rfc AS
      SELECT * FROM (VALUES ('08'::text, '${PROV}'::text, 'NFIT PROVEEDOR DE PRUEBA'::text, '${RFC}'::text)) v(sucursal, proveedor_code, proveedor_nombre, rfc)`);

    const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) };
    cal = new PaymentCalendarService(tk as never, { requireTenantId: () => M } as never);

    await trx('kepler_ods.kdxd').insert({ sucursal: '00', c2: PROV, c3: 'NFIT PROVEEDOR DE PRUEBA', c13: '001' });
    await trx('catalog.suppliers').insert({ tenant_id: M, code: PROV, name: 'NFIT PROVEEDOR DE PRUEBA', activo: true });
    const [acc] = await trx('finance.bank_accounts').insert({ tenant_id: M, bank: 'BBVA', account_label: '9225', alias: 'BBVA 9225 (prueba)', kind: 'bank', active: true }).returning('id');
    origen = acc.id;
    for (const dia of ['2030-04-25', '2030-04-30', '2030-05-02', '2030-06-03']) {
      await trx('budget.daily_capacity').insert({ tenant_id: M, capacity_date: dia, authorized_amount: 1_000_000, created_by: 'nf_it', updated_by: 'nf_it' });
    }
    // Montos distintos: cada factura casa con UN solo CFDI (la liga es por RFC + total ±$1 + fecha ±45 días).
    await factura('NFIT-PUE-ABR', 11600, '2030-04-28', { uuid: 'aaaa0001-0000-4000-8000-000000000001', metodo: 'PUE', forma: '03', estatus: 'vigente' });
    await factura('NFIT-PUE-TDC', 2320, '2030-04-10', { uuid: 'aaaa0002-0000-4000-8000-000000000002', metodo: 'PUE', forma: '04', estatus: 'vigente' });
    await factura('NFIT-CANC', 4640, '2030-04-12', { uuid: 'aaaa0003-0000-4000-8000-000000000003', metodo: 'PPD', forma: '99', estatus: 'cancelado' });
    await factura('NFIT-SINVER', 6960, '2030-04-14', { uuid: 'aaaa0004-0000-4000-8000-000000000004', metodo: 'PPD', forma: '99', estatus: 'desconocido' });
    await factura('NFIT-S01', 8120, '2030-04-16', { uuid: 'aaaa0005-0000-4000-8000-000000000005', metodo: 'PPD', forma: '99', estatus: 'vigente', uso: 'S01' });
    await factura('NFIT-REPRO', 9280, '2030-04-20', { uuid: 'aaaa0006-0000-4000-8000-000000000006', metodo: 'PUE', forma: '03', estatus: 'vigente' });
    await factura('NFIT-ADD', 10440, '2030-04-15', { uuid: 'aaaa0007-0000-4000-8000-000000000007', metodo: 'PUE', forma: '02', estatus: 'vigente' });
    await factura('NFIT-PPD', 12760, '2030-04-18', { uuid: 'aaaa0008-0000-4000-8000-000000000008', metodo: 'PPD', forma: '99', estatus: 'vigente' });
    await factura('NFIT-DIA', 13920, '2030-05-20', { uuid: 'aaaa0009-0000-4000-8000-000000000009', metodo: 'PPD', forma: '99', estatus: 'desconocido' });
    // En MAYÚSCULAS, como los 174,384 recibidos de prod (medido 2026-11-26); la decisión se guarda en minúsculas.
    await factura('NFIT-S01-NO', 15080, '2030-04-17', { uuid: 'AAAA000A-0000-4000-8000-00000000000A', metodo: 'PPD', forma: '99', estatus: 'vigente', uso: 'S01' });
    // El día del CFDI depende de su descarga (medido en prod el 2026-11-26): ContPAQi guarda la hora LOCAL del XML como
    // si fuera UTC; la descarga masiva, el instante real.
    await factura('NFIT-PUE-MAD', 16240, '2030-05-01', { uuid: 'aaaa000b-0000-4000-8000-00000000000b', metodo: 'PUE', forma: '03', estatus: 'vigente',
      source: 'contpaqi_add', guardada: '2030-05-01 03:00:00+00' });      // timbrada el 1-may a las 03:00 de México
    await factura('NFIT-PUE-SAT', 17400, '2030-04-30', { uuid: 'aaaa000c-0000-4000-8000-00000000000c', metodo: 'PUE', forma: '03', estatus: 'vigente',
      source: 'descarga_masiva', guardada: '2030-05-01 02:00:00+00' });   // instante real: el 30-abr a las 20:00 de México
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('⭐ PUE del 28-abr por transferencia: programada para mayo se rechaza y no escribe nada', async () => {
    await expect(cal.createAllocation({ date: '2030-05-02', items: [kp('NFIT-PUE-ABR', 11600)] }, USER))
      .rejects.toThrow('No se puede programar este pago — la factura de $11,600.00 (CFDI AAAA0001): PUE del 28-abr: su mes cerró el 30-abr y el pago sale el 2-may');
    expect(await renglones('NFIT-PUE-ABR')).toBe(0);
  });

  it('la misma PUE dentro de su mes se programa, y al autorizar ya en mayo se niega; en abril se autoriza', async () => {
    const id = await preparado('2030-04-30', 'NFIT-PUE-ABR', 11600);
    await expect(cal.authorize(id, DIR, '2030-05-01')).rejects.toThrow(/No se puede autorizar este pago .*PUE del 28-abr/);
    expect((await trx('finance.payment_allocations').where({ id }).first()).authorized_at).toBeNull();
    const r = await cal.authorize(id, DIR, '2030-04-29');
    expect(r.authorized_by).toBe(DIR);
  });

  it('⭐ el día del CFDI según su descarga: la de ContPAQi del 1-may de madrugada es de mayo y se paga en mayo', async () => {
    const a = await cal.createAllocation({ date: '2030-05-02', items: [kp('NFIT-PUE-MAD', 16240)] }, USER);
    expect(Number(a.amount_assigned)).toBeCloseTo(16240, 2);
  });

  it('⛔ la de la descarga masiva se lee en hora de México: su instante cae el 30-abr y en mayo no se paga', async () => {
    await expect(cal.createAllocation({ date: '2030-05-02', items: [kp('NFIT-PUE-SAT', 17400)] }, USER))
      .rejects.toThrow(/PUE del 30-abr: su mes cerró el 30-abr y el pago sale el 2-may/);
  });

  it('⛔ control: la PUE pagada con tarjeta (04) ya se pagó al momento y se programa en otro mes', async () => {
    const a = await cal.createAllocation({ date: '2030-05-02', items: [kp('NFIT-PUE-TDC', 2320)] }, USER);
    expect(Number(a.amount_assigned)).toBeCloseTo(2320, 2);
  });

  it('⛔ la factura cancelada en el SAT no se programa', async () => {
    await expect(cal.createAllocation({ date: '2030-04-30', items: [kp('NFIT-CANC', 4640)] }, USER)).rejects.toThrow(/cancelada/);
    expect(await renglones('NFIT-CANC')).toBe(0);
  });

  it('⭐ sin verificar en el SAT: se programa, no se autoriza; verificada, sí', async () => {
    const id = await preparado('2030-04-30', 'NFIT-SINVER', 6960);
    await expect(cal.authorize(id, DIR, '2030-04-29')).rejects.toThrow(/todavía no la verifica/);
    await trx('fiscal.cfdis').where({ tenant_id: M, uuid: 'aaaa0004-0000-4000-8000-000000000004' }).update({ estatus_sat: 'vigente' });
    expect((await cal.authorize(id, DIR, '2030-04-29')).authorized_by).toBe(DIR);
  });

  it('S01 sin decisión todavía pasa (la pantalla para decidir llega con PGP.229): programar y autorizar', async () => {
    // ⛔ La decisión de OTRO tenant no cuenta.
    await trx('finance.cfdi_norm_authorizations').insert({
      tenant_id: '00000000-0000-0000-0000-0000000000ff', cfdi_uuid: 'aaaa0005-0000-4000-8000-000000000005', norm_rule: 'sin_efectos_fiscales',
      decision: 'no_se_usa', reason: 'De otro tenant', created_by: 'nf_it_otro',
    });
    const id = await preparado('2030-04-30', 'NFIT-S01', 8120);
    expect((await cal.authorize(id, DIR, '2030-04-29')).authorized_by).toBe(DIR);
  });

  it('⛔ reprogramar una PUE a otro mes se niega y el pago se queda donde estaba', async () => {
    const a = await cal.createAllocation({ date: '2030-04-25', items: [kp('NFIT-REPRO', 9280)] }, USER);
    await expect(cal.reprogram(a.id, '2030-05-02', 'presupuesto_recortado', undefined, USER)).rejects.toThrow(/No se puede programar este pago .*PUE del 20-abr/);
    const sigue = await trx('finance.payment_allocations').where({ id: a.id }).first();
    expect(sigue.status).toBe('pending');
    expect(await renglones('NFIT-REPRO')).toBe(1);
  });

  it('⛔ sumar una PUE de abril a un pago de mayo se niega; una PPD se suma (control)', async () => {
    const a = await cal.createAllocation({ date: '2030-05-02', items: [kp('NFIT-PPD', 12760)] }, USER);
    await expect(cal.addItem(a.id, kp('NFIT-ADD', 10440), USER)).rejects.toThrow(/PUE del 15-abr/);
    expect(await renglones('NFIT-ADD')).toBe(0);
    expect(await renglones('NFIT-PPD')).toBe(1);
  });

  it('⛔ autorizar el día completo no salta el freno', async () => {
    const id = await preparado('2030-06-03', 'NFIT-DIA', 13920);
    await trx('finance.payment_allocations').where({ id }).update({ priority_rank: 1 });
    await expect(cal.releaseLot('2030-06-03', DIR)).rejects.toThrow(/No se puede autorizar este pago .*todavía no la verifica/);
    expect((await trx('finance.payment_calendar_lots').where({ tenant_id: M, lot_date: '2030-06-03' }).first()).status).toBe('draft');
  });

  // ─── [PGP.224] La decisión de Administración o Contabilidad ───────────────────────────────────────────────
  const S01_NO = 'aaaa000a-0000-4000-8000-00000000000a';
  const decidir = (o: Record<string, unknown> = {}, t: Knex.Transaction = trx) => t('finance.cfdi_norm_authorizations').insert({
    tenant_id: M, cfdi_uuid: S01_NO, norm_rule: 'sin_efectos_fiscales', decision: 'no_se_usa', reason: 'No es gasto de la empresa', created_by: 'nf_it_contabilidad', ...o,
  }).returning('id');
  /** Lo que tiene que fallar va en un savepoint, para no tumbar la transacción de toda la prueba. */
  const falla = (fn: (t: Knex.Transaction) => Promise<unknown>) => trx.transaction(async (sp) => { await fn(sp); });

  it('⭐ [PGP.224] «no se usa» detiene al programar (dice quién) y no escribe; revocada, ya no cuenta', async () => {
    const [d] = await decidir();
    await expect(cal.createAllocation({ date: '2030-04-30', items: [kp('NFIT-S01-NO', 15080)] }, USER))
      .rejects.toThrow('No se puede programar este pago — la factura de $15,080.00 (CFDI AAAA000A): Uso S01 (sin efectos fiscales): nf_it_contabilidad decidió que no se usa');
    expect(await renglones('NFIT-S01-NO')).toBe(0);
    await trx('finance.cfdi_norm_authorizations').where({ id: d.id })
      .update({ revoked_at: trx.fn.now(), revoked_by: 'nf_it_contabilidad', revoke_reason: 'Sí era de la empresa' });
    await cal.createAllocation({ date: '2030-04-30', items: [kp('NFIT-S01-NO', 15080)] }, USER);
    expect(await renglones('NFIT-S01-NO')).toBe(1);
  });

  it('⛔ [PGP.224] una sola decisión viva por factura y regla; revocada la anterior, se decide otra vez', async () => {
    const [d] = await decidir({ decision: 'se_usa', reason: 'Autorizada para la prueba' });
    await expect(falla((sp) => sp('finance.cfdi_norm_authorizations').insert({
      tenant_id: M, cfdi_uuid: S01_NO, norm_rule: 'sin_efectos_fiscales', decision: 'no_se_usa', reason: 'Otra firma a la vez', created_by: 'nf_it_admin',
    }))).rejects.toThrow(/ux_cfdi_norm_authorizations_viva/);
    // La misma factura, OTRA regla: es otra decisión.
    await decidir({ norm_rule: 'regimen', decision: 'se_usa', reason: 'Régimen aceptado' });
    await trx('finance.cfdi_norm_authorizations').where({ id: d.id }).update({ revoked_at: trx.fn.now(), revoked_by: 'nf_it_admin', revoke_reason: 'Se corrige' });
    await decidir({ decision: 'no_se_usa', reason: 'Se corrige: no se usa' });
    const vivas = await trx('finance.cfdi_norm_authorizations').where({ tenant_id: M, cfdi_uuid: S01_NO }).whereNull('revoked_at').orderBy('norm_rule');
    expect(vivas.map((x) => `${x.norm_rule}:${x.decision}`)).toEqual(['regimen:se_usa', 'sin_efectos_fiscales:no_se_usa']);
  });

  it('⛔ [PGP.224] la tabla sólo acepta lo que tiene salida humana, en minúsculas, con motivo y revocación completa', async () => {
    // Otra factura, sin decisiones: cada intento choca SÓLO con la restricción que prueba.
    const otra = 'aaaa0008-0000-4000-8000-000000000008';
    const intenta = (o: Record<string, unknown>) => falla((sp) => decidir({ cfdi_uuid: otra, ...o }, sp));
    await expect(intenta({ norm_rule: 'cancelada' })).rejects.toThrow(/rule_ck/);
    await expect(intenta({ decision: 'tal_vez' })).rejects.toThrow(/decision_ck/);
    await expect(intenta({ cfdi_uuid: otra.toUpperCase() })).rejects.toThrow(/uuid_ck/);
    await expect(intenta({ reason: ' . ' })).rejects.toThrow(/reason_ck/);
    await expect(intenta({ revoked_at: new Date() })).rejects.toThrow(/revoke_ck/);
    // Control: bien formada, entra; se revierte a propósito para no dejarla viva.
    await expect(falla(async (sp) => { await decidir({ cfdi_uuid: otra }, sp); throw new Error('control: entró'); })).rejects.toThrow('control: entró');
  });

  it('[PGP.224] la migración: RLS forzado, se puede correr dos veces, y el down no borra decisiones', async () => {
    const rls = (await trx.raw(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'finance.cfdi_norm_authorizations'::regclass`)).rows[0];
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await migUp(MIG_AUTORIZACIONES, trx);                       // idempotente
    await decidir({ cfdi_uuid: 'aaaa0008-0000-4000-8000-000000000008', decision: 'se_usa', reason: 'Para la prueba del down' });
    await migracion(MIG_AUTORIZACIONES).down(trx);              // hay decisiones: se conserva
    expect((await trx.raw(`SELECT to_regclass('finance.cfdi_norm_authorizations') AS r`)).rows[0].r).not.toBeNull();
  });
});
