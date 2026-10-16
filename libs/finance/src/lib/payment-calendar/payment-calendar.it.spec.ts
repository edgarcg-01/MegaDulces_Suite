/**
 * `[TP.16.6]` Prueba de INTEGRACIÓN del Calendario de Pagos: el código real de
 * `PaymentCalendarService` contra un Postgres de verdad, con el payload que manda la pantalla.
 * Regla 13 del proyecto: un endpoint que escribe no está probado hasta que una prueba lo ejerció
 * contra base real. (El paso «aceptar la entrega» vive en `libs/commercial`,
 * `purchase-deliveries.it.spec.ts`.)
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL (localhost/127.0.0.1) que NO sea prod
 * (se compara el `system_identifier`). Sin la variable se salta y lo DICE (no se pinta verde).
 * ⭐ TODO corre dentro de UNA transacción que se revierte al final: incluso las migraciones que le
 * falten a la base local (vista de deuda de Kepler, TP.15) se aplican ahí y desaparecen. La base
 * queda exactamente como estaba.
 *
 * El escenario es el de Francisco (2026-10-16): Gonac con 3 facturas en la 08, 2 en la 01 y 1 en
 * la 06, más una ya pagada en Kepler. Datos de PRUEBA (proveedor `TPIT-GONAC`), nunca reales.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { PaymentCalendarService } from './payment-calendar.service';
// ⛔ `finance` no puede depender de `commercial` (reglas de módulos): el paso «aceptar la entrega»
// lo prueba `purchase-deliveries.it.spec.ts` en `libs/commercial`. Aquí las obligaciones nacen del
// backfill de la mig TP.15, que es el MISMO INSERT que hace `toCalendar()` al aceptar.

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const USER = 'tp_it_tesoreria';
const D = '2030-01-15';      // día de pago de la prueba (lejos de cualquier dato local)
const D2 = '2030-01-16';
const MIGS = [
  '../../../../../database/migrations-newdb/20261008174741_analytics_v_supplier_payables.js',
  '../../../../../database/migrations-newdb/20261016002604_tp15_obligacion_desde_entrega_aceptada.js',
];

/** Las migraciones son CommonJS (`exports.up`): según el cargador llegan como `up` o `default.up`. */
async function migUp(rel: string, trx: Knex.Transaction): Promise<void> {
  const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
  await m.up(trx);
}

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[TP.16.6] NO MEDIDO: sin TP_IT_DB la prueba de integración no corre.');
else if (!local) console.log('[TP.16.6] NO MEDIDO: TP_IT_DB no es una base local; me niego a escribir ahí.');

suite('[TP.16.6] Calendario de Pagos contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let cal: PaymentCalendarService;
  const ob: Record<string, string> = {};   // folio → obligation_id
  let originId = '';
  let a1 = '', a2 = '';

  const item = (folio: string, amount?: number) => ({ obligation_source: 'supplier_payable' as const, obligation_id: ob[folio], applied_amount: amount ?? 0 });
  const avail = async (folio: string) => {
    const r = await trx('commercial.supplier_payment_obligations').where({ id: ob[folio] }).first();
    return Number(r.original_amount) - Number(r.reserved_amount) - Number(r.paid_amount);
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);

    // Migraciones que le falten a la base local — dentro de la transacción (se revierten).
    // RE.32.2 (prod ya la tiene): la columna que TP.15 lee del renglón de la entrega.
    await trx.raw(`ALTER TABLE commercial.purchase_delivery_lines ADD COLUMN IF NOT EXISTS referencia text`);
    if (!(await trx.raw(`SELECT to_regclass('analytics.v_supplier_payables') AS r`)).rows[0].r) await migUp(MIGS[0], trx);
    // TP.15 se aplica DESPUÉS de sembrar (abajo): su backfill es el que crea las obligaciones.

    const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) };
    const ctx = { requireTenantId: () => M };
    cal = new PaymentCalendarService(tk as never, ctx as never);

    // ── Siembra ──
    const [sup] = await trx('catalog.suppliers').insert({ tenant_id: M, code: 'TPIT-GONAC', name: 'TPIT COMERCIALIZADORA GONAC', activo: true }).returning('id');
    void sup;
    const [acc] = await trx('finance.bank_accounts').insert({ tenant_id: M, bank: 'BBVA', account_label: '9999', alias: 'BBVA 9999 (prueba)', kind: 'bank', active: true }).returning('id');
    originId = acc.id;
    await trx('kepler_ods.kdxd').insert({ sucursal: '00', c2: 'TPIT-GONAC', c3: 'TPIT COMERCIALIZADORA GONAC', c13: 'C' });
    const facturas = [
      { suc: '08', folio: 'TPIT-801', due: '2030-01-10', amt: 16040.74 },
      { suc: '08', folio: 'TPIT-802', due: '2030-01-12', amt: 48210.5 },
      { suc: '08', folio: 'TPIT-803', due: '2030-01-14', amt: 22875 },
      { suc: '01', folio: 'TPIT-101', due: '2030-01-11', amt: 35640.2 },
      { suc: '01', folio: 'TPIT-102', due: '2030-01-13', amt: 18300 },
      { suc: '06', folio: 'TPIT-601', due: '2030-01-15', amt: 27455.8 },
      { suc: '06', folio: 'TPIT-PAGADA', due: '2030-01-05', amt: 5000 }, // sin documento abierto en Kepler
    ];
    for (const f of facturas.filter((x) => x.folio !== 'TPIT-PAGADA')) {
      await trx('kepler_ods.kdxe').insert({ sucursal: f.suc, c1: f.suc, c2: 'TPIT-GONAC', c3: 'A', c4: 20, c5: 1, c6: f.folio, c7: `${f.due} 00:00:00`, c10: `${f.due} 00:00:00`, c11: f.amt });
    }
    const [d] = await trx('commercial.purchase_deliveries').insert({
      tenant_id: M, code: 'ENT-TPIT-0001', status: 'recibida', date_basis: 'recepcion', delivered_by: 'tp_it_compras', recipient_username: USER, received_by: USER, received_at: trx.fn.now(), line_count: facturas.length,
    }).returning('id');
    for (const f of facturas) {
      await trx('commercial.purchase_delivery_lines').insert({
        tenant_id: M, delivery_id: d.id, receipt_sucursal: f.suc, receipt_doc_prefix: 'XA2001', receipt_folio: f.folio,
        supplier_code: 'TPIT-GONAC', supplier_name: 'TPIT COMERCIALIZADORA GONAC', amount: f.amt, kepler_due_date: f.due, status: 'aceptado', decided_by: USER, decided_at: trx.fn.now(),
      });
    }
    await trx('budget.daily_capacity').insert({ tenant_id: M, capacity_date: D, authorized_amount: 1000000, created_by: 'tp_it', updated_by: 'tp_it' });

    // ── TP.15: el backfill crea las obligaciones de lo ACEPTADO, por el pendiente de Kepler ──
    await migUp(MIGS[1], trx);
    const rows2 = await trx('commercial.supplier_payment_obligations as o').join('commercial.purchase_delivery_lines as l', 'l.id', 'o.purchase_delivery_line_id')
      .where('l.delivery_id', d.id).select('o.id', 'l.receipt_folio');
    for (const x of rows2) ob[x.receipt_folio] = x.id;
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('TP.15: la factura sin saldo abierto en Kepler NO se vuelve obligación', () => {
    expect(Object.keys(ob).sort()).toEqual(['TPIT-101', 'TPIT-102', 'TPIT-601', 'TPIT-801', 'TPIT-802', 'TPIT-803']);
  });

  it('las obligaciones disponibles traen sucursal y el id del proveedor', async () => {
    const rows = await cal.listObligations({ search: 'TPIT' });
    expect(rows).toHaveLength(6);
    const by = Object.fromEntries(rows.map((r: { concept: string; branch_code: string; payee_id: string }) => [r.concept.split(' ')[1], r]));
    expect(by['08-TPIT-801'].branch_code).toBe('08');
    expect(by['06-TPIT-601'].branch_code).toBe('06');
    expect(new Set(rows.map((r: { payee_id: string }) => r.payee_id)).size).toBe(1);
  });

  it('un pago junta facturas del MISMO proveedor y sucursal', async () => {
    const a = await cal.createAllocation({ date: D, items: [item('TPIT-801', 16040.74), item('TPIT-802', 48210.5)] }, USER);
    a1 = a.id;
    expect(Number(a.amount_assigned)).toBeCloseTo(64251.24, 2);
    expect(await avail('TPIT-801')).toBeCloseTo(0, 2);
  });

  it('⛔ un pago NO junta sucursales distintas (08 + 01)', async () => {
    await expect(cal.createAllocation({ date: D, items: [item('TPIT-803', 22875), item('TPIT-101', 35640.2)] }, USER)).rejects.toThrow(/sucursales distintas/);
  });

  it('sumar al pago existente: misma sucursal sí, otra sucursal no', async () => {
    await expect(cal.addItem(a1, item('TPIT-101', 35640.2), USER)).rejects.toThrow(/sucursal 01/);
    await cal.addItem(a1, item('TPIT-803', 22875), USER);
    const items = await trx('finance.payment_allocation_items').where({ allocation_id: a1 });
    expect(items).toHaveLength(3);
    const a = await trx('finance.payment_allocations').where({ id: a1 }).first();
    expect(Number(a.amount_assigned)).toBeCloseTo(87126.24, 2);
  });

  it('Gonac 01 va en otro pago', async () => {
    const a = await cal.createAllocation({ date: D, items: [item('TPIT-101', 35640.2), item('TPIT-102', 18300)] }, USER);
    a2 = a.id;
    expect(Number(a.amount_assigned)).toBeCloseTo(53940.2, 2);
  });

  it('⛔ candado de Kepler: si Kepler registró un abono después de aceptar, no deja programar de más', async () => {
    // Un abono (D) de 10,000 aplicado a la factura de la 06 → el pendiente en Kepler baja a 17,455.80.
    await trx('kepler_ods.kdxf').insert({ sucursal: '06', c1: '06', c2: 'TPIT-GONAC', c3: '2030-01-14 00:00:00', c4: 30, c5: 1, c6: 'TPIT-ABONO', c7: 20, c8: 1, c9: 'TPIT-601', c10: 10000 });
    await expect(cal.createAllocation({ date: D2, items: [item('TPIT-601', 27455.8)] }, USER)).rejects.toThrow(/pendiente en Kepler/);
    const ok = await cal.createAllocation({ date: D2, items: [item('TPIT-601', 17455.8)] }, USER);
    // Quitarlo del día regresa el saldo a la lista.
    await cal.cancelAllocation(ok.id, 'prueba', USER);
    expect(await avail('TPIT-601')).toBeCloseTo(27455.8, 2);
  });

  it('⛔ autorizar se niega sin orden y sin preparar; ejecutar se niega sin autorizar', async () => {
    await expect(cal.releaseLot(D, 'tp_it_gerencia')).rejects.toThrow(/sin orden/);
    await cal.setPriorityRank(a1, 1, USER);
    await cal.setPriorityRank(a2, 2, USER);
    await expect(cal.releaseLot(D, 'tp_it_gerencia')).rejects.toThrow(/sin preparar/);
  });

  it('preparar: transferencia exige origen y una CLABE válida', async () => {
    await expect(cal.prepare(a1, { payment_method: 'transferencia', destination_account_text: 'BBVA · CLABE 032180000118359719' }, USER)).rejects.toThrow(/origen/);
    await expect(cal.prepare(a1, { payment_method: 'transferencia', bank_account_id: originId, destination_account_text: 'BBVA · CLABE 032180000118359710' }, USER)).rejects.toThrow(/dígito de control/);
    await expect(cal.prepare(a1, { payment_method: 'transferencia', bank_account_id: originId, destination_account_text: 'BBVA · 03218000011835971' }, USER)).rejects.toThrow(/18/);
    await cal.prepare(a1, { payment_method: 'transferencia', bank_account_id: originId, destination_account_text: 'BBVA · CLABE 032180000118359719' }, USER);
    // Efectivo: el destino se descarta aunque llegue.
    const p2 = await cal.prepare(a2, { payment_method: 'efectivo', cash_register_text: 'CAJA GENERAL', destination_account_text: 'algo' }, USER);
    expect(p2.destination_account_text).toBeNull();
    await expect(cal.execute(a1, USER)).rejects.toThrow(/no está autorizado/);
  });

  it('autorizar el día genera folio; ya autorizado no admite sumar ni crear', async () => {
    const lot = await cal.releaseLot(D, 'tp_it_gerencia');
    expect(lot.status).toBe('released');
    expect(lot.folio).toBe('300115-01');
    await expect(cal.addItem(a2, item('TPIT-601', 1000), USER)).rejects.toThrow(/autorizado/);
    await expect(cal.createAllocation({ date: D, items: [item('TPIT-601', 1000)] }, USER)).rejects.toThrow(/autorizado/);
  });

  it('ejecutar tras autorizar: lo reservado pasa a pagado', async () => {
    await cal.execute(a1, USER);
    const o = await trx('commercial.supplier_payment_obligations').where({ id: ob['TPIT-801'] }).first();
    expect(o.status).toBe('paid');
    expect(Number(o.paid_amount)).toBeCloseTo(16040.74, 2);
  });

  it('la semana: el día trae sus 2 pagos con cuenta de origen y sucursal por factura', async () => {
    const w = await cal.weekView(D);
    expect(w.from).toBe('2030-01-14');
    expect(w.days).toHaveLength(7);
    const day = w.days.find((x) => x.date === D)!;
    expect(day.allocations).toHaveLength(2);
    const p1 = day.allocations.find((a) => a.id === a1)!;
    expect(p1.bank_account_label).toBe('BBVA 9999 (prueba)');
    expect(p1.items.every((i) => i.branch_code === '08')).toBe(true);
    expect(day.lot_folio).toBe('300115-01');
  });
});
