/**
 * `[TP.16.6]` Prueba de INTEGRACIÓN de TP.15: aceptar una entrega (`PurchaseDeliveriesService.receive`,
 * el código real) pasa al Calendario de Pagos las facturas aceptadas **por el pendiente vivo de
 * Kepler**, no por el importe de la entrega. Contra un Postgres de verdad.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE. TODO dentro de una transacción que se
 * revierte: hasta las migraciones que le falten a la base local desaparecen al terminar.
 * El resto del flujo (armar, preparar, autorizar, ejecutar) lo prueba
 * `libs/finance/.../payment-calendar.it.spec.ts`.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { PurchaseDeliveriesService } from './purchase-deliveries.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const USER = 'tp_it_tesoreria';
const MIGS = [
  '../../../../../database/migrations-newdb/20261008174741_analytics_v_supplier_payables.js',
  '../../../../../database/migrations-newdb/20261016002604_tp15_obligacion_desde_entrega_aceptada.js',
];
async function migUp(rel: string, trx: Knex.Transaction): Promise<void> {
  const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
  await m.up(trx);
}

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[TP.16.6] NO MEDIDO: sin TP_IT_DB la prueba de integración de entregas no corre.');

suite('[TP.16.6] Aceptar una entrega → Calendario de Pagos, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: PurchaseDeliveriesService;
  let deliveryId = '';
  let lineRechazada = '';

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    await trx.raw(`ALTER TABLE commercial.purchase_delivery_lines ADD COLUMN IF NOT EXISTS referencia text`);
    if (!(await trx.raw(`SELECT to_regclass('analytics.v_supplier_payables') AS r`)).rows[0].r) await migUp(MIGS[0], trx);
    await migUp(MIGS[1], trx);
    svc = new PurchaseDeliveriesService({ run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) } as never, { requireTenantId: () => M } as never);

    await trx('catalog.suppliers').insert({ tenant_id: M, code: 'TPIT-GONAC', name: 'TPIT COMERCIALIZADORA GONAC', activo: true });
    await trx('kepler_ods.kdxd').insert({ sucursal: '00', c2: 'TPIT-GONAC', c3: 'TPIT COMERCIALIZADORA GONAC', c13: 'C' });
    const facturas = [
      { suc: '08', folio: 'TPIT-801', amt: 16040.74, kepler: true },
      { suc: '08', folio: 'TPIT-802', amt: 48210.5, kepler: true },
      { suc: '01', folio: 'TPIT-101', amt: 35640.2, kepler: true },
      { suc: '06', folio: 'TPIT-601', amt: 27455.8, kepler: true },     // con un abono de 10,000 ya en Kepler
      { suc: '06', folio: 'TPIT-PAGADA', amt: 5000, kepler: false },    // sin documento abierto
      { suc: '01', folio: 'TPIT-RECHAZADA', amt: 1234, kepler: true },  // Finanzas la rechaza
      { suc: '08', folio: 'TPIT-SINPROV', amt: 777, kepler: true, code: 'TPIT-NOEXISTE' }, // proveedor fuera del catálogo
    ];
    for (const f of facturas.filter((x) => x.kepler)) {
      await trx('kepler_ods.kdxe').insert({ sucursal: f.suc, c1: f.suc, c2: f.code ?? 'TPIT-GONAC', c3: 'A', c4: 20, c5: 1, c6: f.folio, c7: '2030-01-10 00:00:00', c10: '2030-01-20 00:00:00', c11: f.amt });
    }
    await trx('kepler_ods.kdxf').insert({ sucursal: '06', c1: '06', c2: 'TPIT-GONAC', c3: '2030-01-11 00:00:00', c4: 30, c5: 1, c6: 'TPIT-ABONO', c7: 20, c8: 1, c9: 'TPIT-601', c10: 10000 });
    const [d] = await trx('commercial.purchase_deliveries').insert({
      tenant_id: M, code: 'ENT-TPIT-0002', status: 'entregada', date_basis: 'recepcion', delivered_by: 'tp_it_compras', recipient_username: USER, line_count: facturas.length,
    }).returning('id');
    deliveryId = d.id;
    for (const f of facturas) {
      const [l] = await trx('commercial.purchase_delivery_lines').insert({
        tenant_id: M, delivery_id: d.id, receipt_sucursal: f.suc, receipt_doc_prefix: 'XA2001', receipt_folio: f.folio, referencia: `F-${f.folio}`,
        supplier_code: f.code ?? 'TPIT-GONAC', supplier_name: 'TPIT', amount: f.amt, kepler_due_date: '2030-01-20', status: 'entregado',
      }).returning('id');
      if (f.folio === 'TPIT-RECHAZADA') lineRechazada = l.id;
    }
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('⛔ sólo el destinatario puede confirmar', async () => {
    await expect(svc.receive(deliveryId, { rejections: [] }, 'otra_persona')).rejects.toThrow(/la recibe/);
  });

  it('aceptar crea las obligaciones por el PENDIENTE de Kepler, y dice qué no pasó', async () => {
    const r = await svc.receive(deliveryId, { rejections: [{ line_id: lineRechazada, reason: 'no coincide el importe' }] }, USER);
    expect(r.status).toBe('recibida_parcial');
    // 4 de Gonac con saldo; la pagada sin saldo; la del proveedor fuera de catálogo sin proveedor; la rechazada no cuenta.
    expect(r.calendar).toMatchObject({ schema_ready: true, created: 4, without_balance: 1, without_supplier: 1 });
    expect(r.calendar?.amount).toBeCloseTo(16040.74 + 48210.5 + 35640.2 + 17455.8, 2);
  });

  it('la factura con abono en Kepler nace por lo que QUEDA (17,455.80), no por el importe (27,455.80)', async () => {
    const o = await trx('commercial.supplier_payment_obligations as o').join('commercial.purchase_delivery_lines as l', 'l.id', 'o.purchase_delivery_line_id')
      .where('l.receipt_folio', 'TPIT-601').first('o.original_amount', 'o.kepler_sucursal', 'o.kepler_folio', 'o.authorized_by', 'o.invoice_folio');
    expect(Number(o.original_amount)).toBeCloseTo(17455.8, 2);
    expect(o).toMatchObject({ kepler_sucursal: '06', kepler_folio: 'TPIT-601', authorized_by: USER, invoice_folio: 'F-TPIT-601' });
  });

  it('la rechazada y la pagada NO se vuelven obligación', async () => {
    const folios = (await trx('commercial.supplier_payment_obligations as o').join('commercial.purchase_delivery_lines as l', 'l.id', 'o.purchase_delivery_line_id')
      .where('l.delivery_id', deliveryId).select('l.receipt_folio')).map((x: { receipt_folio: string }) => x.receipt_folio).sort();
    expect(folios).toEqual(['TPIT-101', 'TPIT-601', 'TPIT-801', 'TPIT-802']);
  });
});
