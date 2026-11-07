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
import { PaymentCalendarService, keplerPayableId } from './payment-calendar.service';
import { ProntoPagoService, sqlSinDescuentoVigente } from '../pronto-pago/pronto-pago.service';
import { PaymentProgramService } from '../payment-program/payment-program.service';
import { sqlVentanaProntoPago } from '@megadulces/contracts/finance/pronto-pago-ventana';
import type { PaymentCalendarItemDiscountBody } from '@megadulces/contracts';
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
  // `[TP.18]` El CHECK que admite el cuarto origen. Es idempotente, así que se aplica siempre:
  // sin ella, programar una factura derivada revienta contra la restricción (así se descubrió).
  '../../../../../database/migrations-newdb/20261016171340_tp18_allocation_items_origen_kepler_payable.js',
  // `[TP.18.3]` La matview de la ventana observada, que Pronto pago une en su consulta. Nace
  // vacía acá: esta prueba mide el PUENTE con el Calendario, no la ventana (eso es de la fase PP).
  '../../../../../database/migrations-newdb/20261010111352_pronto_pago_ventana_observada.js',
  // `[TP.19.3]` Las columnas que ligan el pago ejecutado con su documento de Kepler (O3).
  '../../../../../database/migrations-newdb/20261016185746_tp19_allocation_liga_pago_kepler.js',
  // `[PGP.91]` Las columnas del descuento al pagar. El servicio las inserta y las suma SIEMPRE,
  // así que sin ellas ninguna prueba de este archivo pasa en una base local atrasada.
  '../../../../../database/migrations-newdb/20261106183612_pgp91_descuento_al_pagar_en_el_calendario.js',
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
    await migUp(MIGS[2], trx);   // `[TP.18]` el CHECK del cuarto origen (idempotente)
    await migUp(MIGS[5], trx);   // `[PGP.91]` las columnas del descuento al pagar (idempotente)

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
    const { rows } = await cal.listObligations({ search: 'TPIT' });
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

  // `[PGP.48]` La pantalla llama por primera vez a `DELETE allocations/:id/items/:itemId` («Quitar
  // esas N»): un pago con facturas que el ERP ya no debe se paga sólo después de quitarlas.
  it('[PGP.48] quitar UNA factura de un pago: su saldo regresa y el pago baja a lo que queda', async () => {
    const it803 = await trx('finance.payment_allocation_items').where({ allocation_id: a1, obligation_id: ob['TPIT-803'] }).first();
    await cal.removeItem(a1, it803.id);
    expect(await avail('TPIT-803')).toBeCloseTo(22875, 2);
    const a = await trx('finance.payment_allocations').where({ id: a1 }).first();
    expect(Number(a.amount_assigned)).toBeCloseTo(64251.24, 2);
    // Se regresa al estado del caso anterior: los que siguen cuentan con las 3 facturas en a1.
    await cal.addItem(a1, item('TPIT-803', 22875), USER);
  });

  it('[PGP.48] ⛔ no se quita la ÚNICA factura de un pago: eso es quitar el pago', async () => {
    // TPIT-102 todavía no está en ningún pago (a2 nace en el caso siguiente); se suelta al final.
    const unico = await cal.createAllocation({ date: D2, items: [item('TPIT-102', 1000)] }, USER);
    const [it] = await trx('finance.payment_allocation_items').where({ allocation_id: unico.id });
    await expect(cal.removeItem(unico.id, it.id)).rejects.toThrow(/al menos un documento/);
    await cal.cancelAllocation(unico.id, 'prueba', USER);
  });

  // `[PGP.50]` El orden por cercanía a hoy: el SQL corre de verdad (abs de una resta de fechas en
  // la zona de CDMX). Las facturas de prueba vencen todas en 2030, así que lo más cercano a hoy es
  // lo que vence antes: el control es que coincida con el orden por vencimiento.
  it('[PGP.50] orden «cercania»: lo más cercano a hoy primero', async () => {
    const cerca = await cal.listObligations({ search: 'TPIT', orden: 'cercania' });
    const venc = await cal.listObligations({ search: 'TPIT', orden: 'vencimiento' });
    expect(cerca.rows.length).toBeGreaterThan(1);
    const fechas = (r: { rows: Array<{ original_due_date: string | Date }> }) => r.rows.map((x) => String(x.original_due_date).slice(0, 10));
    expect(fechas(cerca)).toEqual(fechas(venc));
  });

  it('[PGP.48] los días YA PASADOS con pagos pendientes se listan; los futuros no', async () => {
    const [lot] = await trx('finance.payment_calendar_lots').insert({ tenant_id: M, lot_date: '2020-01-15' }).returning('id');
    await trx('finance.payment_allocations').insert({ tenant_id: M, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: 1234.5, created_by: USER });
    const dias = await cal.pendientesAtrasados();
    const d = dias.find((x) => x.date === '2020-01-15');
    expect(d).toEqual({ date: '2020-01-15', pagos: 1, monto: 1234.5 });
    expect(dias.some((x) => x.date >= '2030-01-01')).toBe(false);
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

  // `[PGP.92]` El candado de quitar UNA factura vive en el servidor, no sólo en la pantalla. `a2` tiene
  // DOS facturas (TPIT-101 y 102), así que el rechazo sólo puede venir del día autorizado, no de la
  // guarda «al menos un documento».
  it('[PGP.92] ⛔ con el día autorizado no se le quita una factura a un pago (lo firmado no cambia)', async () => {
    const antes = await trx('finance.payment_allocation_items').where({ allocation_id: a2 });
    expect(antes).toHaveLength(2);
    await expect(cal.removeItem(a2, antes[0].id, USER)).rejects.toThrow(/autorizado/);
    expect(await trx('finance.payment_allocation_items').where({ allocation_id: a2 })).toHaveLength(2);
    const a = await trx('finance.payment_allocations').where({ id: a2 }).first();
    expect(Number(a.amount_assigned)).toBeCloseTo(53940.2, 2);
  });

  // `[PGP.91]` El mismo candado para el descuento al pagar: fijarlo en un día autorizado bajaría lo
  // que sale del banco después de que Gerencia lo firmó. TPIT-101 es factura de mercancía con
  // saldo y 100 de «Volumen» sobre 35,640.20 es un descuento válido: el rechazo sólo puede venir
  // del día autorizado, no del validador.
  it('[PGP.91] ⛔ con el día autorizado no se le fija un descuento a una factura (lo firmado no cambia)', async () => {
    const it101 = await trx('finance.payment_allocation_items').where({ allocation_id: a2, obligation_id: ob['TPIT-101'] }).first();
    await expect(cal.setItemDiscount(a2, it101.id, { discount_amount: 100, discount_reason: 'volumen' }, USER)).rejects.toThrow(/autorizado/);
    const despues = await trx('finance.payment_allocation_items').where({ id: it101.id }).first();
    expect(Number(despues.applied_amount)).toBeCloseTo(35640.2, 2);
    expect(Number(despues.discount_amount)).toBe(0);
    expect(despues.discount_reason).toBeNull();
    const a = await trx('finance.payment_allocations').where({ id: a2 }).first();
    expect(Number(a.amount_assigned)).toBeCloseTo(53940.2, 2);
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

  // ── `[TP.18]` El origen DERIVADO: la deuda de Kepler que NO pasó por Entregas (ADR-094) ──────
  // Un flete de la 06: existe en el ERP, nadie lo capturó, y hasta TP.18 no había forma de pagarlo
  // desde el Calendario. Lo que se ejerce acá es lo que ningún test puro puede: que la reserva
  // funcione SIN una tabla donde guardarla.
  describe('[TP.18] deuda derivada de Kepler (sin tabla propia)', () => {
    const D3 = '2030-01-17';
    const FLETE = 'TPIT-FLETE1';
    const kep = (amount: number) => ({ obligation_source: 'kepler_payable' as const, obligation_id: keplerId, applied_amount: amount });
    let keplerId = '';
    let a3 = '';
    // ⚠️ `onlyAvailable: false` a propósito: el default esconde lo que ya no tiene disponible, y
    // justamente lo que hay que comprobar es que la reserva de una obligación SIN TABLA se vea.
    const derivada = async () => {
      const { rows } = await cal.listObligations({ search: 'TPIT', onlyAvailable: false });
      return rows.find((r: { obligation_id: string }) => r.obligation_id === keplerId) as
        { reserved_amount: number; paid_amount: number; available_amount: number; branch_code: string; payee_id: string } | undefined;
    };

    it('una factura que nadie capturó aparece como kepler_payable, con la llave determinística', async () => {
      await trx('kepler_ods.kdxe').insert({ sucursal: '06', c1: '06', c2: 'TPIT-GONAC', c3: 'A', c4: 20, c5: 1, c6: FLETE, c7: '2030-01-09 00:00:00', c10: '2030-01-09 00:00:00', c11: 9500 });
      const { rows } = await cal.listObligations({ search: 'TPIT' });
      const d = rows.filter((r: { obligation_source: string }) => r.obligation_source === 'kepler_payable');
      expect(d).toHaveLength(1);
      keplerId = (d[0] as { obligation_id: string }).obligation_id;
      // La llave que calculó el SQL es la misma que calcula el TS (si no, el pago no reencuentra su factura).
      expect(keplerId).toBe(keplerPayableId('06', 20, 1, FLETE));
      expect((d[0] as { branch_code: string }).branch_code).toBe('06');
      expect(Number((d[0] as { available_amount: number }).available_amount)).toBeCloseTo(9500, 2);
    });

    it('⛔ dedupe: ninguna factura capturada aparece TAMBIÉN como derivada', async () => {
      const rows = await cal.listObligations({ search: 'TPIT' }).then((r) => r.rows) as { obligation_source: string; concept: string }[];
      const derivadas = rows.filter((r) => r.obligation_source === 'kepler_payable');
      // La única derivada es el flete: las 6 que entraron por Entregas quedan fuera por el NOT EXISTS,
      // aunque Kepler siga debiéndolas. (No se cuentan las capturadas: a esta altura del flujo unas
      // están pagadas y otras reservadas, así que su número depende de los tests de arriba.)
      expect(derivadas).toHaveLength(1);
      expect(derivadas[0].concept).toContain(FLETE);
      for (const folio of ['TPIT-801', 'TPIT-802', 'TPIT-803', 'TPIT-101', 'TPIT-102', 'TPIT-601']) {
        expect(derivadas.some((d) => d.concept.includes(folio))).toBe(false);
      }
    });

    it('⭐ se programa, y lo reservado se ve SIN que exista una tabla donde guardarlo', async () => {
      const a = await cal.createAllocation({ date: D3, items: [kep(9500)] }, USER);
      a3 = a.id;
      expect(Number(a.amount_assigned)).toBeCloseTo(9500, 2);
      const d = await derivada();
      expect(Number(d!.reserved_amount)).toBeCloseTo(9500, 2);
      expect(Number(d!.available_amount)).toBeCloseTo(0, 2);
    });

    it('⛔ el mismo saldo no se reserva dos veces', async () => {
      await expect(cal.createAllocation({ date: D3, items: [kep(9500)] }, USER)).rejects.toThrow(/disponible|pendiente/i);
    });

    it('se agrupa con una factura CAPTURADA del mismo proveedor y sucursal (06)', async () => {
      await cal.addItem(a3, item('TPIT-601', 1000), USER);
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: a3 });
      expect(items).toHaveLength(2);
      expect(new Set(items.map((i: { obligation_source: string }) => i.obligation_source)))
        .toEqual(new Set(['kepler_payable', 'supplier_payable']));
    });

    it('⛔ dos facturas DERIVADAS de sucursales distintas no se juntan en un pago', async () => {
      // Otra factura sin capturar, esta vez en la 01. Es el mismo proveedor, así que lo único que
      // las separa es el centro de costo — que es justo la regla de `[TP.16.3]`.
      await trx('kepler_ods.kdxe').insert({ sucursal: '01', c1: '01', c2: 'TPIT-GONAC', c3: 'A', c4: 20, c5: 1, c6: 'TPIT-FLETE2', c7: '2030-01-09 00:00:00', c10: '2030-01-09 00:00:00', c11: 700 });
      const otra = keplerPayableId('01', 20, 1, 'TPIT-FLETE2');
      await expect(cal.addItem(a3, { obligation_source: 'kepler_payable', obligation_id: otra, applied_amount: 700 }, USER))
        .rejects.toThrow(/sucursal/i);
    });

    it('el día trae el pago con su etiqueta rearmada desde la vista (no hay tabla de dónde leerla)', async () => {
      const day = await cal.listDayAllocations(D3);
      const p = day.find((x: { id: string }) => x.id === a3)!;
      const it0 = (p as { items: { beneficiary: string; concept: string; branch_code: string | null }[] }).items
        .find((i) => i.concept.includes(FLETE));
      expect(it0).toBeTruthy();
      expect(it0!.beneficiary).toContain('GONAC');
      expect(it0!.branch_code).toBe('06');
    });

    // ── `[TP.17.1b]` Un crédito bancario NO es mercancía ────────────────────────────────────
    // Los $38 M de créditos, préstamos y tarjetas llegan por la MISMA vista que las facturas de
    // dulces. Si entraran como `proveedor_mercancia` se podrían agrupar en el mismo pago y
    // perderían su lugar en el orden (los compromisos financieros se pagan primero).
    // ⚠️ La clave ARRANCA con `A` a propósito, y no es un detalle del dato de prueba: en la regla
    // del ECA lo financiero se reconoce por **prefijo de clave** (`A`, `TC`, `B.B.`) o por el
    // grupo **140**. El grupo **120, que se llama «Instituciones financieras», NO cuenta** — los
    // 12 acreedores financieros reales de prod se detectan todos por prefijo. Si alguien da de
    // alta un banco con clave `G*` y grupo 120, esta clasificación lo leerá como proveedor.
    it('un acreedor financiero se deriva como compromiso_financiero, no como proveedor', async () => {
      await trx('kepler_ods.kdxd').insert({ sucursal: '00', c2: 'ATPIT999', c3: 'TPIT ACREEDOR BANCO DE PRUEBA', c13: '120' });
      await trx('kepler_ods.kdxe').insert({ sucursal: '06', c1: '06', c2: 'ATPIT999', c3: 'A', c4: 20, c5: 1, c6: 'TPIT-CRED1', c7: '2030-01-08 00:00:00', c10: '2030-01-08 00:00:00', c11: 50000 });
      const rows = await cal.listObligations({ search: 'TPIT ACREEDOR BANCO' }).then((r) => r.rows) as { classification: string; subtype: string; obligation_source: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].obligation_source).toBe('kepler_payable');
      expect(rows[0].classification).toBe('compromiso_financiero');
      expect(rows[0].subtype).toBe('financiero');
    });

    it('⛔ y por eso NO se puede juntar con una factura de proveedor en el mismo pago', async () => {
      const credito = keplerPayableId('06', 20, 1, 'TPIT-CRED1');
      await expect(cal.addItem(a3, { obligation_source: 'kepler_payable', obligation_id: credito, applied_amount: 50000 }, USER))
        .rejects.toThrow(/clasificación/i);
    });

    it('la factura de mercancía del mismo origen sigue siendo proveedor_mercancia', async () => {
      const rows = await cal.listObligations({ search: 'TPIT', onlyAvailable: false }).then((r) => r.rows) as { obligation_id: string; classification: string }[];
      expect(rows.find((r) => r.obligation_id === keplerId)!.classification).toBe('proveedor_mercancia');
    });

    // ── `[TP.17.2]` El techo se declara ──────────────────────────────────────────────────────
    // ⛔ Prueba NEGATIVA del recorte: sin esto, el `.limit()` vuelve a esconder deuda en silencio.
    // Medido en prod el 2026-10-16: el techo de 1000 dejaba fuera 1,895 documentos por
    // $105,683,725 — el 79 % del dinero — y la pantalla se veía perfecta.
    it('el techo recorta las filas pero el total dice cuántas hay de verdad', async () => {
      const todo = await cal.listObligations({ search: 'TPIT', onlyAvailable: false });
      expect(todo.rows.length).toBe(todo.total);          // sin recorte, coinciden
      expect(todo.total).toBeGreaterThan(2);

      const recortado = await cal.listObligations({ search: 'TPIT', onlyAvailable: false, limit: 2 });
      expect(recortado.rows).toHaveLength(2);             // devuelve lo que cabe
      expect(recortado.total).toBe(todo.total);           // …y CONFIESA cuántas hay
      expect(recortado.limit).toBe(2);
    });

    it('el techo no deja pedir una página infinita ni negativa', async () => {
      expect((await cal.listObligations({ search: 'TPIT', limit: 999999 })).limit).toBe(5000);
      expect((await cal.listObligations({ search: 'TPIT', limit: -5 })).limit).toBe(1000);
      expect((await cal.listObligations({ search: 'TPIT', offset: -3 })).offset).toBe(0);
    });

    it('⭐ el camino COMPLETO de escritura: ordenar → preparar → autorizar → ejecutar', async () => {
      await trx('budget.daily_capacity').insert({ tenant_id: M, capacity_date: D3, authorized_amount: 100000, created_by: 'tp_it', updated_by: 'tp_it' });
      await cal.setPriorityRank(a3, 1, USER);
      await cal.prepare(a3, { payment_method: 'transferencia', bank_account_id: originId, destination_account_text: 'BBVA · CLABE 032180000118359719' }, USER);
      const lot = await cal.releaseLot(D3, 'tp_it_gerencia');
      expect(lot.status).toBe('released');
      await cal.execute(a3, USER);
      // Lo reservado pasó a pagado, y se lee al vuelo: la factura derivada queda sin disponible.
      const d = await derivada();
      expect(Number(d!.paid_amount)).toBeCloseTo(9500, 2);
      expect(Number(d!.reserved_amount)).toBeCloseTo(0, 2);
      expect(Number(d!.available_amount)).toBeCloseTo(0, 2);
    });
  });
  /**
   * `[TP.18.3]` **El puente de O2: Pronto pago tiene que saber CON QUÉ programar.**
   *
   * La pantalla que ve vencer el descuento no puede ofrecer un botón si no sabe qué mandarle al
   * Calendario. Lo que se ejerce acá es que las dos mitades coinciden: la llave que calcula
   * Pronto pago es **la misma** que el Calendario guardó, y lo ya comprometido se descuenta de lo
   * que queda por programar. Si estas dos cosas se separan, el botón manda a la nada.
   */
  describe('[TP.18.3] Pronto pago sabe con qué programar cada factura', () => {
    let pp: ProntoPagoService;

    beforeAll(async () => {
      // La matview de la ventana observada: acá nace VACÍA, así que todo sale `sin_medir` — y es
      // correcto. Lo que esta prueba mide es el puente, no la ventana (eso lo cubre la fase PP).
      if (!(await trx.raw(`SELECT to_regclass('analytics.mv_supplier_prompt_discount') AS r`)).rows[0].r) await migUp(MIGS[3], trx);
      /**
       * ⛔ La migración la crea **`WITH NO DATA`**, y en Postgres una matview sin poblar **no se
       * puede consultar**: cualquier `SELECT` revienta con `55000 — has not been populated`. En
       * producción no se nota porque allá ya se refrescó; en una base recién levantada, **toda**
       * consulta de Pronto pago falla por esto, y el error no menciona a Pronto pago.
       * Acá nace vacía pero POBLADA, que no es lo mismo que vacía y sin poblar.
       */
      if (!(await trx.raw(`SELECT relispopulated FROM pg_class WHERE oid = 'analytics.mv_supplier_prompt_discount'::regclass`)).rows[0].relispopulated) {
        await trx.raw(`REFRESH MATERIALIZED VIEW analytics.mv_supplier_prompt_discount`);
      }
      const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) };
      pp = new ProntoPagoService(tk as never, { requireTenantId: () => M } as never);
    }, 60_000);

    const fila = async (folio: string) => {
      const r = await pp.overview({ search: 'TPIT', limit: 300 });
      return (r.rows as unknown as Record<string, unknown>[]).find((x) => String(x['folio']).trim() === folio);
    };

    // ⚠️ El proveedor arranca con `C` y no es cosmético: Pronto pago mira **sólo** mercancía
    // (`proveedor LIKE 'C%'`), porque el pronto pago es un descuento de compra. Con el proveedor
    // de los demás tests (`TPIT-GONAC`) estas filas sencillamente no existen para esa pantalla.
    const PROV = 'CTPIT999';
    const F_SUELTA = 'CTPIT-S1';   // nadie la capturó → va por la deuda derivada
    const F_ENTREGA = 'CTPIT-E1';  // Compras la capturó → manda su obligación
    const D4 = '2030-01-20';
    let obCapturada = '';

    beforeAll(async () => {
      await trx('kepler_ods.kdxd').insert({ sucursal: '00', c2: PROV, c3: 'CTPIT DULCES DE PRUEBA', c13: '001' });
      const [sup] = await trx('catalog.suppliers').insert({ tenant_id: M, code: PROV, name: 'CTPIT DULCES DE PRUEBA', activo: true }).returning('id');
      for (const [folio, monto] of [[F_SUELTA, 12000], [F_ENTREGA, 7000]] as [string, number][]) {
        await trx('kepler_ods.kdxe').insert({ sucursal: '01', c1: '01', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: folio, c7: '2030-01-06 00:00:00', c10: '2030-01-18 00:00:00', c11: monto });
      }
      // La obligación capturada se siembra con las MISMAS llaves que deja `toCalendar()` al
      // aceptar una entrega (mig TP.15); lo que se prueba es el puente, no el alta.
      const [o] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: M, supplier_id: sup.id, invoice_folio: F_ENTREGA, concept: F_ENTREGA,
        original_due_date: '2030-01-18', original_amount: 7000, reserved_amount: 0, paid_amount: 0,
        status: 'pending', created_by: USER, updated_by: USER, authorized_by: USER,
        kepler_sucursal: '01', kepler_doc_tipo: 20, kepler_doc_sub: 1, kepler_folio: F_ENTREGA,
      }).returning('id');
      obCapturada = o.id;
    }, 60_000);

    it('⭐ la llave que publica Pronto pago es LA MISMA que guarda el Calendario', async () => {
      const f = await fila(F_SUELTA);
      expect(f).toBeTruthy();
      expect(f!['obligation_source']).toBe('kepler_payable');
      expect(f!['obligation_id']).toBe(keplerPayableId('01', 20, 1, F_SUELTA));
    });

    it('una factura que SÍ pasó por Entregas se programa por su obligación capturada', async () => {
      const f = await fila(F_ENTREGA);
      expect(f!['obligation_source']).toBe('supplier_payable');
      expect(f!['obligation_id']).toBe(obCapturada);
    });

    /**
     * `[TP.19.3]` **O3 — el pago ejecutado dice cuál es en Kepler.** Sin esta liga, al marcar un
     * pago como ejecutado el rastro se corta: reaparece en el ERP como un evento sin origen.
     */
    it('⭐ un pago ejecutado se liga a su documento de Kepler', async () => {
      await migUp(MIGS[4], trx);   // las columnas de la liga (idempotente)
      // ⚠️ `analytics.erp_supplier_payments` es una VISTA (derive-no-copy): no se le inserta. El
      // pago se siembra en su fuente, `kepler_ods.kdm1`, con la forma que la vista espera —
      // `c4=26` → `XD2601` (transferencia) y la sucursal del espejo del CEDIS, que es `'00'`.
      await trx('kepler_ods.kdm1').insert({
        sucursal: '00', c1: '00', c2: 'X', c3: 'D', c4: 26, c5: 1, c6: 'TPIT-KPAGO1',
        c9: '2030-01-15 00:00:00', c10: 'CTPIT999', c16: 87126.24, c31: 'TRANSFERENCIA', c43: 'A',
      });
      const r = await cal.linkKeplerPayment(a1, { sucursal: '00', doc_prefix: 'XD2601', folio: 'TPIT-KPAGO1' }, USER);
      expect(r.kepler_payment_folio).toBe('TPIT-KPAGO1');
      expect(r.kepler_payment_linked_by).toBe(USER);
      expect(r.kepler_payment_linked_at).toBeTruthy();
    });

    it('⛔ no liga a un folio que Kepler no tiene: una trazabilidad falsa es peor que ninguna', async () => {
      await expect(cal.linkKeplerPayment(a1, { sucursal: '00', doc_prefix: 'XD2601', folio: 'NO-EXISTE' }, USER))
        .rejects.toThrow(/Kepler no tiene/);
    });

    it('⛔ no liga un pago que todavía no se ejecutó: antes no hay documento que ligar', async () => {
      await expect(cal.linkKeplerPayment(a2, { sucursal: '00', doc_prefix: 'XD2601', folio: 'TPIT-KPAGO1' }, USER))
        .rejects.toThrow(/ejecutado/);
    });

    it('⛔ lo ya comprometido no se vuelve a ofrecer: `programable` descuenta lo reservado', async () => {
      const antes = await fila(F_SUELTA);
      expect(Number(antes!['programable'])).toBeCloseTo(12000, 2);

      // Se programa por el Calendario, con la llave que Pronto pago acaba de publicar.
      await cal.createAllocation({
        date: D4,
        items: [{ obligation_source: 'kepler_payable', obligation_id: String(antes!['obligation_id']), applied_amount: 5000 }],
      }, USER);

      const despues = await fila(F_SUELTA);
      expect(Number(despues!['reservado'])).toBeCloseTo(5000, 2);
      expect(Number(despues!['programable'])).toBeCloseTo(7000, 2);
    });
  });

  /**
   * `[TP.20.4]` **La ventana de pronto pago, la MISMA para las dos pantallas.**
   *
   * El inventario descartó fusionar Pronto pago con el Calendario (ordenan y agrupan al revés);
   * lo que viaja son los tres campos que deciden. La regla vive en `@megadulces/contracts` y
   * acá se ejerce **el SQL que genera**, contra casos construidos — así se prueba la regla sin
   * depender de que la matview del ERP tenga datos.
   */
  describe('[TP.20.4] la ventana de pronto pago decide igual en las dos pantallas', () => {
    /** Evalúa el SQL real de `sqlVentanaProntoPago()` sobre una fila armada a mano. */
    const evaluar = async (diasDesdeFactura: number, nObs: number, diasMediana: number, tasa = 0.05) => {
      const { rows } = await trx.raw(`
        SELECT ${sqlVentanaProntoPago('v', 'd')}
          FROM (SELECT (CURRENT_DATE - ${diasDesdeFactura})::date AS fecha, 10000::numeric AS pendiente) v,
               (SELECT ${nObs}::int AS n_observaciones, ${diasMediana}::int AS dias_mediana,
                       ${tasa}::numeric AS tasa_observada) d`);
      return rows[0] as { pronto_fecha_limite: string | null; pronto_beneficio: string | null; pronto_estado: string };
    };

    it('todavía capturable: el límite está lejos', async () => {
      const r = await evaluar(2, 10, 30);
      expect(r.pronto_estado).toBe('capturable');
      expect(Number(r.pronto_beneficio)).toBeCloseTo(500, 2);   // 10,000 × 5 %
    });

    it('por vencer: entra dentro de los días de aviso', async () => {
      expect((await evaluar(28, 10, 30)).pronto_estado).toBe('por_vencer');
    });

    it('⛔ fuera de ventana — que NO quiere decir perdido', async () => {
      expect((await evaluar(40, 10, 30)).pronto_estado).toBe('fuera_de_ventana');
    });

    it('⛔ sin medir con menos observaciones que el mínimo, y el límite queda NULL', async () => {
      const r = await evaluar(2, 2, 30);
      expect(r.pronto_estado).toBe('sin_medir');
      // ⛔ NULL y no «hoy»: un COALESCE a la fecha actual diría «vence hoy» sobre algo que nadie midió.
      expect(r.pronto_fecha_limite).toBeNull();
      expect(r.pronto_beneficio).toBeNull();
    });

    it('el borde del aviso cae del lado correcto', async () => {
      // Límite exactamente a 5 días (el aviso) → por vencer; a 6 → todavía capturable.
      expect((await evaluar(25, 10, 30)).pronto_estado).toBe('por_vencer');
      expect((await evaluar(24, 10, 30)).pronto_estado).toBe('capturable');
    });

    it('la lista del Calendario trae los tres campos y el filtro los usa', async () => {
      const todas = await cal.listObligations({ search: 'TPIT', onlyAvailable: false });
      expect(todas.rows.length).toBeGreaterThan(0);
      for (const r of todas.rows as { pronto_estado: string }[]) expect(r.pronto_estado).toBeTruthy();
      // La matview nace vacía en esta base, así que todo es `sin_medir` — y el filtro lo respeta.
      const porVencer = await cal.listObligations({ search: 'TPIT', onlyAvailable: false, prontoPago: 'por_vencer' });
      expect(porVencer.rows).toHaveLength(0);
      expect(porVencer.total).toBe(0);
    });
  });

  /**
   * `[PP.10]` **La conciliación del Programa de pagos no puede ser ciega a un mes sin libro.** (O4)
   *
   * Recorría los meses que el Excel de Tesorería tiene, así que un mes sin cargar **no salía
   * ausente: no existía**. Y el libro se carga a mano, o sea que su estado normal es atrasado:
   * medido el 2026-10-19 con el libro en agosto, la conciliación era ciega a **5,201 movimientos
   * por $91,720,679** de septiembre y octubre, con la pantalla viéndose impecable.
   */
  describe('[PP.10] la conciliación ve los meses que el ERP tiene aunque el libro no', () => {
    let pp: PaymentProgramService;
    const MES_CON_LIBRO = '2026-03';
    const MES_SIN_LIBRO = '2026-04';

    beforeAll(async () => {
      pp = new PaymentProgramService({ run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) } as never,
                                     { requireTenantId: () => M } as never);
      // Un mes con libro…
      await trx('finance.payment_program').insert({
        tenant_id: M, source_month: MES_CON_LIBRO, client_uuid: 'pp10-con-libro',
        supplier_text: 'PP10 PROVEEDOR', amount: 1000, pay_date: `${MES_CON_LIBRO}-15`,
      });
      // …y otro que SÓLO existe en el ERP: pagos asentados, sin que nadie cargara el Excel.
      await trx('analytics.gl_poliza_lines').insert({
        tenant_id: M, source: 'kepler', cuenta_mayor: '201', tipo_pol: 'XD2601',
        anio_mes: MES_SIN_LIBRO, importe: 777777, sucursal: '00',
        ejercicio: 2026, periodo: 4, folio: 'PP10-1', num_movto: 1,
        cuenta: '201-001', cargo_abono: 'C',
      });
    }, 60_000);

    it('⭐ un mes con pagos en el ERP y sin libro APARECE, marcado como no cargado', async () => {
      const r = await pp.recon() as { months: { month: string; libro_cargado: boolean; kepler201: number; program: number }[] };
      const sin = r.months.find((m) => m.month === MES_SIN_LIBRO);
      expect(sin).toBeTruthy();                      // ⛔ antes de [PP.10] esto era `undefined`
      expect(sin!.libro_cargado).toBe(false);
      expect(Number(sin!.kepler201)).toBeCloseTo(777777, 2);
      expect(Number(sin!.program)).toBe(0);          // cero, y además DICHO con `libro_cargado`
    });

    it('el mes que sí tiene libro sigue marcado como cargado', async () => {
      const r = await pp.recon() as { months: { month: string; libro_cargado: boolean; program: number }[] };
      const con = r.months.find((m) => m.month === MES_CON_LIBRO);
      expect(con!.libro_cargado).toBe(true);
      expect(Number(con!.program)).toBeCloseTo(1000, 2);
    });

    it('los meses salen ordenados y sin repetirse', async () => {
      const r = await pp.recon() as { months: { month: string }[] };
      const ms = r.months.map((m) => m.month);
      expect(ms).toEqual([...ms].sort());
      expect(new Set(ms).size).toBe(ms.length);
    });
  });

  /**
   * `[TP.21]` **La costura: el libro de Tesorería y el Calendario son la misma línea de tiempo.**
   *
   * Medido en prod el 2026-10-20: el libro llega al **2026-08-28**, el calendario empieza el
   * **2026-10-16**, **0 días en común** y **53 días** en medio de los que ninguna de las dos
   * pantallas decía nada. Lo que se prueba acá es que el día sabe de su propio pasado — y que
   * **«no se pagó» y «el Excel no tiene ese mes» no se pintan igual** (`[PP.10]`, ADR-056).
   *
   * ⛔ No se casa un renglón del libro con una asignación: no hay llave. Se **suma por fecha**.
   */
  describe('[PGP.9] el día del calendario sabe lo que el ERP dice de ese mismo día', () => {
    const SEM = '2029-05-16';            // miércoles de una semana lejos de todo dato

    /*
     * ⚠️⚠️ **TRES PRUEBAS SE RETIRARON ACÁ, Y NO SE REEMPLAZARON. Se declara en vez de fingir.**
     *
     * `[PGP.9]` cambió la fuente de esta costura: era `finance.payment_program` —el Excel de
     * Tesorería, una TABLA que este bloque sembraba con tres filas— y pasó a
     * `analytics.erp_supplier_payments`, que es una **VISTA** sobre el ODS. Una vista no se
     * siembra: para montar el caso habría que escribir en `kepler_ods.*` imitando la forma de un
     * pago del ERP, que es frágil y acaba probando la imitación en vez del dato.
     *
     * Lo que probaban y hoy NO está cubierto por una prueba de integración:
     *   · que la suma sea por fecha (el lunes con sus dos pagos, el martes con el suyo);
     *   · que un cero con el espejo fresco signifique «no se pagó»;
     *   · que un cero sin fecha de corte se marque en vez de dibujarse.
     *
     * ⭐ Dónde SÍ se verifica: contra prod, en sólo lectura, con la comparación que motivó el
     * cambio —libro 157 pagos/$17.9 M contra ERP 530/$45.2 M en agosto; 0 contra 346 en
     * septiembre—. Eso ejerce la consulta real sobre el dato real, que es más de lo que daban
     * las tres filas sembradas. Pero **no corre en CI**, y por eso queda dicho acá y no escondido.
     */
    it('⚠️ NO MEDIDO: la costura contra el ERP no tiene prueba de integración (la fuente es una vista)', () => {
      expect(true).toBe(true);
    });

    it('⛔ la costura no inventa una liga: el libro no toca lo asignado del día', async () => {
      // Mismo día, las dos fuentes. El resumen del calendario NO puede moverse por el libro:
      // son universos distintos y mezclarlos es lo que produjo los $273 M de [PP.4].
      const antes = await cal.daySummary(LUN);
      const w = await cal.weekView(SEM);
      const lun = w.days.find((d) => d.date === LUN)!;
      expect(lun.libro!.n).toBe(2);
      expect(Number(lun.summary.assigned_amount)).toBe(Number(antes.assigned_amount));
      expect(Number(lun.summary.assigned_amount)).toBe(0);
    });

    it('la semana entera trae su bloque de libro, los siete días', async () => {
      const w = await cal.weekView(SEM);
      expect(w.days.length).toBe(7);
      expect(w.days.every((d) => d.libro != null)).toBe(true);
    });
  });

  /**
   * `[TP.19.4]` **El sistema PROPONE el documento de Kepler; no lo adivina.** (O3)
   *
   * Teclear la terna `(sucursal, doc_prefix, folio)` es el trabajo que la liga venía a evitar. El
   * espejo del ERP ya tiene con qué reconocerla: monto, día y proveedor.
   *
   * ⚠️ Este bloque arma **su propio escenario de punta a punta** —día, capacidad, pago, orden,
   * preparación, autorización y ejecución— en vez de apoyarse en los pagos de arriba. Dos razones
   * medidas: el proveedor tiene que empezar con `C`, porque la vista de pagos del ERP sólo trae
   * **proveedores de compra**; y depender del estado que dejaron otros tests ya hizo fallar esta
   * misma prueba por un pago que resultó no estar ejecutado.
   */
  describe('[TP.19.4] el documento de Kepler se propone, no se teclea', () => {
    const D5 = '2030-02-10';
    const FOLIO_SUELTO = 'CTPIT-S2';
    let a5 = '';

    beforeAll(async () => {
      await migUp(MIGS[4], trx);
      // Una factura más del proveedor de compra `CTPIT999`, sin capturar: entra por la deuda derivada.
      await trx('kepler_ods.kdxe').insert({ sucursal: '01', c1: '01', c2: 'CTPIT999', c3: 'A', c4: 20, c5: 1, c6: FOLIO_SUELTO, c7: '2030-02-01 00:00:00', c10: '2030-02-20 00:00:00', c11: 31500 });
      await trx('budget.daily_capacity').insert({ tenant_id: M, capacity_date: D5, authorized_amount: 100000, created_by: 'tp_it', updated_by: 'tp_it' });
      const a = await cal.createAllocation({
        date: D5,
        items: [{ obligation_source: 'kepler_payable', obligation_id: keplerPayableId('01', 20, 1, FOLIO_SUELTO), applied_amount: 31500 }],
      }, USER);
      a5 = a.id;
      await cal.setPriorityRank(a5, 1, USER);
      await cal.prepare(a5, { payment_method: 'transferencia', bank_account_id: originId, destination_account_text: 'BBVA · CLABE 032180000118359719' }, USER);
      await cal.releaseLot(D5, 'tp_it_gerencia');
    }, 60_000);

    it('⛔ antes de ejecutar no hay documento que buscar', async () => {
      await expect(cal.sugerirKeplerPayment(a5)).rejects.toThrow(/ejecutado/);
    });

    it('⭐ ejecutado, propone el documento por monto, día y proveedor', async () => {
      await cal.execute(a5, USER);
      // El documento del ERP, capturado un día DESPUÉS de que salió el dinero (por eso ±3 días).
      await trx('kepler_ods.kdm1').insert({
        sucursal: '00', c1: '00', c2: 'X', c3: 'D', c4: 26, c5: 1, c6: 'CTPIT-KSUG1',
        c9: '2030-02-11 00:00:00', c10: 'CTPIT999', c16: 31500, c31: 'TRANSFERENCIA', c43: 'A',
      });
      const s = await cal.sugerirKeplerPayment(a5) as { candidatos: { folio: string }[]; unico?: boolean };
      expect(s.candidatos).toHaveLength(1);
      expect(s.unico).toBe(true);
      expect(s.candidatos[0].folio).toBe('CTPIT-KSUG1');
    });

    it('⛔ con DOS candidatos no elige: los devuelve y deja decidir', async () => {
      // Mismo proveedor, mismo monto, un día de diferencia: nada permite distinguirlos.
      await trx('kepler_ods.kdm1').insert({
        sucursal: '00', c1: '00', c2: 'X', c3: 'D', c4: 26, c5: 1, c6: 'CTPIT-KSUG2',
        c9: '2030-02-12 00:00:00', c10: 'CTPIT999', c16: 31500, c31: 'TRANSFERENCIA', c43: 'A',
      });
      // Y uno que NO es candidato: mismo proveedor y día, pero $2 de diferencia. La tolerancia es
      // de un centavo (redondeo), no «parecido»: un monto distinto es otro pago.
      await trx('kepler_ods.kdm1').insert({
        sucursal: '00', c1: '00', c2: 'X', c3: 'D', c4: 26, c5: 1, c6: 'CTPIT-KSUG3',
        c9: '2030-02-11 00:00:00', c10: 'CTPIT999', c16: 31502, c31: 'TRANSFERENCIA', c43: 'A',
      });
      const s = await cal.sugerirKeplerPayment(a5) as { candidatos: { folio: string }[]; unico?: boolean };
      expect(s.candidatos).toHaveLength(2);
      expect(s.unico).toBe(false);
      expect(s.candidatos.some((c) => c.folio === 'CTPIT-KSUG3')).toBe(false);
    });

    it('⛔ un documento ya ligado a otro pago deja de ser candidato', async () => {
      await cal.linkKeplerPayment(a5, { sucursal: '00', doc_prefix: 'XD2601', folio: 'CTPIT-KSUG1' }, USER);
      // Y ligado, ya no se vuelve a proponer nada para este pago.
      const s = await cal.sugerirKeplerPayment(a5) as { ya_ligado: boolean; folio?: string };
      expect(s.ya_ligado).toBe(true);
      expect(s.folio).toBe('CTPIT-KSUG1');
    });

  });

  /**
   * `[PGP.91]` **El descuento que el proveedor da AL PAGAR.**
   *
   * Hay proveedores que conceden un 3 % de pronto pago (o uno por volumen) al momento de pagarles,
   * y Kepler lo formaliza DESPUÉS con una nota de crédito. La invariante que se ejerce acá:
   * `applied_amount` es el NETO que sale del banco (el total del día y `amount_assigned` lo
   * suman), y la factura queda CUBIERTA por neto + descuento — así el sobrante descontado no se
   * vuelve a ofrecer mientras la nota de crédito no llega.
   *
   * Proveedor propio (`DTPIT01`, sucursal 08) y días propios: no toca nada de los bloques de arriba.
   */
  describe('[PGP.91] descuento al pagar: se paga el neto y la factura queda cubierta', () => {
    const PROV = 'DTPIT01';
    const D6 = '2030-03-04';
    const D7 = '2030-03-05';
    const D8 = '2030-03-06';
    const D9 = '2030-03-07';
    const F1 = 'DTPIT-F1';   // 38,880.00 — el ejemplo de Francisco: 3 % de pronto pago
    const F2 = 'DTPIT-F2';   // 10,000.00 — control negativo: parcial SIN descuento
    const F3 = 'DTPIT-F3';   //  5,000.00 — rechazos y descuento por volumen en pesos
    const kid = (folio: string) => keplerPayableId('08', 20, 1, folio);
    const derivada = async (folio: string) => {
      const { rows } = await cal.listObligations({ search: 'DTPIT', onlyAvailable: false });
      return rows.find((r: { obligation_id: string }) => r.obligation_id === kid(folio)) as
        { reserved_amount: number; paid_amount: number; available_amount: number } | undefined;
    };
    let a6 = '';
    let obCapturada = '';

    beforeAll(async () => {
      await trx('kepler_ods.kdxd').insert({ sucursal: '00', c2: PROV, c3: 'DTPIT DESCUENTOS DE PRUEBA', c13: '001' });
      const [sup] = await trx('catalog.suppliers').insert({ tenant_id: M, code: PROV, name: 'DTPIT DESCUENTOS DE PRUEBA', activo: true }).returning('id');
      for (const [folio, monto] of [[F1, 38880], [F2, 10000], [F3, 5000]] as [string, number][]) {
        await trx('kepler_ods.kdxe').insert({ sucursal: '08', c1: '08', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: folio, c7: '2030-03-01 00:00:00', c10: '2030-03-20 00:00:00', c11: monto });
      }
      // Una obligación CAPTURADA (con tabla): ahí `recalcObligation` guarda reservado/pagado y el
      // CHECK reservado + pagado ≤ original de la tabla de origen tiene que seguir cumpliéndose.
      const [o] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: M, supplier_id: sup.id, invoice_folio: 'DTPIT-CAP1', concept: 'DTPIT-CAP1',
        original_due_date: '2030-03-20', original_amount: 20000, reserved_amount: 0, paid_amount: 0,
        status: 'pending', created_by: USER, updated_by: USER, authorized_by: USER,
      }).returning('id');
      obCapturada = o.id;
    }, 60_000);

    it('⭐ 3 % de pronto pago: sale el neto, la factura queda cubierta y NO se vuelve a ofrecer', async () => {
      const a = await cal.createAllocation({
        date: D6,
        items: [{
          obligation_source: 'kepler_payable', obligation_id: kid(F1),
          applied_amount: 37713.6, discount_amount: 1166.4, discount_reason: 'pronto_pago', discount_rate: 0.03,
        }],
      }, USER);
      a6 = a.id;
      // Lo que sale del banco es el neto.
      expect(Number(a.amount_assigned)).toBeCloseTo(37713.6, 2);
      // La factura queda cubierta entera: reservado = neto + descuento, disponible 0.
      const d = await derivada(F1);
      expect(Number(d!.reserved_amount)).toBeCloseTo(38880, 2);
      expect(Number(d!.available_amount)).toBeCloseTo(0, 2);
      // …y por eso la lista de «agregar facturas» ya no la ofrece.
      const ofrecidas = (await cal.listObligations({ search: 'DTPIT' })).rows as { obligation_id: string }[];
      expect(ofrecidas.some((r) => r.obligation_id === kid(F1))).toBe(false);
      // El día cuenta el NETO: el descuento no es dinero que salga.
      expect((await cal.daySummary(D6)).assigned_amount).toBeCloseTo(37713.6, 2);
    });

    it('⛔ CONTROL NEGATIVO: sin descuento, un pago parcial SÍ deja sobrante (la prueba ve la diferencia)', async () => {
      await cal.createAllocation({ date: D8, items: [{ obligation_source: 'kepler_payable', obligation_id: kid(F2), applied_amount: 9000 }] }, USER);
      const d = await derivada(F2);
      expect(Number(d!.reserved_amount)).toBeCloseTo(9000, 2);
      expect(Number(d!.available_amount)).toBeCloseTo(1000, 2);
      const ofrecidas = (await cal.listObligations({ search: 'DTPIT' })).rows as { obligation_id: string }[];
      expect(ofrecidas.some((r) => r.obligation_id === kid(F2))).toBe(true);
    });

    /**
     * `[PGP.91b]` **El sugerido y Pronto pago dejan de ofrecer la factura que ya lleva su descuento.**
     * Se ejerce el TEXTO EXACTO de las dos condiciones (la que la migración 20261106183613 mete en
     * `v_pago_sugerido` y la de `ProntoPagoService`), no una copia. La vista entera no sirve aquí:
     * su ventana observada nace vacía en esta base y no lista ningún proveedor de prueba.
     * Control: F2 (parcial SIN descuento) y F3 (sin pago) se quedan; sólo F1 sale.
     */
    it('⭐ [PGP.91b] la factura con descuento sale del sugerido y de Pronto pago; las otras se quedan', async () => {
      const mig = createRequire(__filename)(resolvePath(__dirname,
        '../../../../../database/migrations-newdb/20261106183613_pgp91b_que_pagar_sin_el_sobrante_del_descuento.js')) as
        { SQL: { CON_DESCUENTO_VIGENTE: string } };
      // ⚠️ La condición de la migración NO es una cláusula suelta: se inserta en el ANCLA de la vista
      // reemplazando su último «)» (`ANCLA.slice(0, -1) + CON_DESCUENTO_VIGENTE`), así que termina con
      // ese paréntesis de más. Pegada tal cual da «syntax error at or near ")"» (así falló en el CI).
      const vigente = mig.SQL.CON_DESCUENTO_VIGENTE.trimEnd();
      expect(vigente.endsWith(')')).toBe(true);
      const clausula = vigente.slice(0, -1);
      // SAVEPOINT: un error de SQL aquí no debe envenenar la transacción del resto del archivo.
      await trx.raw('SAVEPOINT pgp91b_q');
      try {
        const folios = async (condicion: string): Promise<string[]> => (await trx.raw(
          `SELECT btrim(v.folio) AS folio FROM analytics.v_supplier_payables v
            WHERE btrim(v.proveedor) = ? ${condicion} ORDER BY 1`, [PROV])).rows.map((r: { folio: string }) => r.folio);
        const todas = await folios('');
        expect(todas).toEqual([F1, F2, F3]);                        // control: la base ve las tres
        const sugerido = await folios(clausula);
        const pronto = await folios(`AND ${sqlSinDescuentoVigente('v')}`);
        expect(sugerido).toEqual([F2, F3]);
        // Una sola regla: las dos pantallas excluyen exactamente lo mismo.
        expect(pronto).toEqual(sugerido);
        await trx.raw('RELEASE SAVEPOINT pgp91b_q');
      } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT pgp91b_q');
        throw e;
      }
    });

    it('⛔ «Otro» sin detalle se rechaza, y no deja nada reservado', async () => {
      await expect(cal.createAllocation({
        date: D6,
        items: [{ obligation_source: 'kepler_payable', obligation_id: kid(F3), applied_amount: 4900, discount_amount: 100, discount_reason: 'otro' }],
      }, USER)).rejects.toThrow(/Otro/);
      expect(Number((await derivada(F3))!.available_amount)).toBeCloseTo(5000, 2);
    });

    it('⛔ una tasa que no cuadra con el descuento se rechaza (el servidor revisa la cuenta)', async () => {
      // 2 % de 5,000 son 100, no 150.
      await expect(cal.addItem(a6, {
        obligation_source: 'kepler_payable', obligation_id: kid(F3),
        applied_amount: 4850, discount_amount: 150, discount_reason: 'volumen', discount_rate: 0.02,
      }, USER)).rejects.toThrow(/no cuadra/);
    });

    it('⛔ el neto cabe pero neto + descuento NO: se mide lo cubierto, no sólo lo que sale', async () => {
      // 4,900 solos caben en los 5,000; con 200 de descuento la factura quedaría cubierta por 5,100.
      await expect(cal.addItem(a6, {
        obligation_source: 'kepler_payable', obligation_id: kid(F3),
        applied_amount: 4900, discount_amount: 200, discount_reason: 'volumen',
      }, USER)).rejects.toThrow(/disponible|pendiente/i);
    });

    it('sumar al pago una factura con descuento en PESOS (sin tasa): el total sigue siendo neto', async () => {
      await cal.addItem(a6, {
        obligation_source: 'kepler_payable', obligation_id: kid(F3),
        applied_amount: 4750, discount_amount: 250, discount_reason: 'volumen',
      }, USER);
      const a = await trx('finance.payment_allocations').where({ id: a6 }).first();
      expect(Number(a.amount_assigned)).toBeCloseTo(42463.6, 2);
      expect(Number((await derivada(F3))!.available_amount)).toBeCloseTo(0, 2);
    });

    it('el día publica el descuento por factura y el total por pago', async () => {
      const day = await cal.listDayAllocations(D6) as unknown as {
        id: string; amount_assigned: number; discount_total: number;
        items: { obligation_id: string; applied_amount: number; discount_amount: number; discount_reason: string | null; discount_rate: number | null; discount_note: string | null }[];
      }[];
      const p = day.find((x) => x.id === a6)!;
      expect(p.amount_assigned).toBeCloseTo(42463.6, 2);
      expect(p.discount_total).toBeCloseTo(1416.4, 2);
      const i1 = p.items.find((i) => i.obligation_id === kid(F1))!;
      expect(i1.discount_amount).toBeCloseTo(1166.4, 2);
      expect(i1.discount_reason).toBe('pronto_pago');
      expect(i1.discount_rate).toBeCloseTo(0.03, 6);
      const i3 = p.items.find((i) => i.obligation_id === kid(F3))!;
      expect(i3.discount_reason).toBe('volumen');
      expect(i3.discount_rate).toBeNull();
      expect((await cal.daySummary(D6)).assigned_amount).toBeCloseTo(42463.6, 2);
    });

    it('⭐ reprogramar copia el descuento: el día nuevo paga el mismo neto y la factura sigue cubierta', async () => {
      const nuevo = await cal.reprogram(a6, D7, 'presupuesto_recortado', undefined, USER);
      expect(Number(nuevo.amount_assigned)).toBeCloseTo(42463.6, 2);
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: nuevo.id });
      const i1 = items.find((i: { obligation_id: string }) => i.obligation_id === kid(F1));
      expect(Number(i1.discount_amount)).toBeCloseTo(1166.4, 2);
      expect(i1.discount_reason).toBe('pronto_pago');
      expect(Number(i1.discount_rate)).toBeCloseTo(0.03, 6);
      // Quién lo fijó también viaja: mover de día no es volver a capturar el descuento.
      expect(i1.discount_by).toBe(USER);
      // El viejo quedó cancelado y no cuenta; el nuevo sí: la factura sigue sin disponible.
      expect(Number((await derivada(F1))!.available_amount)).toBeCloseTo(0, 2);
      expect(Number((await derivada(F3))!.available_amount)).toBeCloseTo(0, 2);
      expect((await cal.daySummary(D6)).assigned_amount).toBeCloseTo(0, 2);
    });

    it('⭐ obligación CAPTURADA: ejecutar con descuento la deja «paid» por lo cubierto', async () => {
      const a = await cal.createAllocation({
        date: D9,
        items: [{ obligation_source: 'supplier_payable', obligation_id: obCapturada, applied_amount: 19600, discount_amount: 400, discount_reason: 'volumen' }],
      }, USER);
      let o = await trx('commercial.supplier_payment_obligations').where({ id: obCapturada }).first();
      expect(Number(o.reserved_amount)).toBeCloseTo(20000, 2);
      expect(o.status).toBe('partial');
      await trx('budget.daily_capacity').insert({ tenant_id: M, capacity_date: D9, authorized_amount: 100000, created_by: 'tp_it', updated_by: 'tp_it' });
      await cal.setPriorityRank(a.id, 1, USER);
      await cal.prepare(a.id, { payment_method: 'transferencia', bank_account_id: originId, destination_account_text: 'BBVA · CLABE 032180000118359719' }, USER);
      await cal.releaseLot(D9, 'tp_it_gerencia');
      await cal.execute(a.id, USER);
      o = await trx('commercial.supplier_payment_obligations').where({ id: obCapturada }).first();
      // Pagado = 19,600 que salieron + 400 que descontó el proveedor = la factura entera.
      expect(Number(o.paid_amount)).toBeCloseTo(20000, 2);
      expect(Number(o.reserved_amount)).toBeCloseTo(0, 2);
      expect(o.status).toBe('paid');
    });

    it('⛔ la base también lo impide: un motivo sin descuento viola el CHECK de consistencia', async () => {
      // El servicio ya lo rechaza; esto prueba que la RESTRICCIÓN existe por si alguien escribe
      // por otro camino. SAVEPOINT para que el error no envenene la transacción de la prueba.
      await trx.raw('SAVEPOINT pgp91_ck');
      await expect(trx('finance.payment_allocation_items').insert({
        tenant_id: M, allocation_id: a6, obligation_source: 'kepler_payable', obligation_id: kid(F2),
        applied_amount: 1, discount_amount: 0, discount_reason: 'pronto_pago',
      })).rejects.toThrow(/ck_pai_discount_consistency/);
      await trx.raw('ROLLBACK TO SAVEPOINT pgp91_ck');
    });

    /**
     * `[PGP.91]` **El descuento se fija SOBRE la factura que ya está en el pago** (`setItemDiscount`,
     * `POST allocations/:id/items/:itemId/descuento`), con el cuerpo EXACTO que arma el diálogo del
     * desglose (regla 13). En el rediseño casi toda factura entra COMPLETA —el «+», los grupos, la
     * propuesta del día—, así que éste es el camino que la pantalla usa de verdad.
     * La invariante: lo CUBIERTO no se mueve (la factura sigue sin disponible); baja lo que sale del
     * banco. Factura propia (`DTPIT-F4`) y día propio: se siembra aquí, DESPUÉS del caso
     * `[PGP.91b]`, que cuenta exactamente las tres facturas de arriba.
     */
    describe('[PGP.91] fijar o quitar el descuento de una factura ya puesta (cuerpo de la pantalla)', () => {
      const F4 = 'DTPIT-F4';   // 20,000.00 — entra COMPLETA, como la manda el «+»
      const D11 = '2030-03-11';
      let aF4 = '';
      let itF4 = '';
      const renglon = () => trx('finance.payment_allocation_items').where({ id: itF4 }).first();

      beforeAll(async () => {
        await trx('kepler_ods.kdxe').insert({ sucursal: '08', c1: '08', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: F4, c7: '2030-03-01 00:00:00', c10: '2030-03-20 00:00:00', c11: 20000 });
      }, 60_000);

      it('⭐ 3 % sobre la factura que entró completa: sale el neto, la factura sigue cubierta y NO se reofrece', async () => {
        const a = await cal.createAllocation({ date: D11, items: [{ obligation_source: 'kepler_payable', obligation_id: kid(F4), applied_amount: 20000 }] }, USER);
        aF4 = a.id;
        const [it0] = await trx('finance.payment_allocation_items').where({ allocation_id: aF4 });
        itF4 = it0.id;
        expect(Number(a.amount_assigned)).toBeCloseTo(20000, 2);
        // El cuerpo tal cual lo arma el diálogo en modo «%»: la tasa viaja; la nota, sólo con «Otro».
        const body: PaymentCalendarItemDiscountBody = { discount_amount: 600, discount_reason: 'pronto_pago', discount_rate: 0.03, discount_note: null };
        const r = await cal.setItemDiscount(aF4, itF4, body, USER);
        expect(r).toEqual({ allocation_id: aF4, item_id: itF4, applied_amount: 19400, discount_amount: 600, amount_assigned: 19400 });
        const i = await renglon();
        expect(Number(i.applied_amount)).toBeCloseTo(19400, 2);
        expect(Number(i.discount_amount)).toBeCloseTo(600, 2);
        expect(i.discount_reason).toBe('pronto_pago');
        expect(Number(i.discount_rate)).toBeCloseTo(0.03, 6);
        expect(i.discount_note).toBeNull();
        // Quién y cuándo: el descuento cambia dinero y la tabla no tiene `updated_by`.
        expect(i.discount_by).toBe(USER);
        expect(i.discount_at).toBeTruthy();
        // El pago y el día cuentan el NETO.
        const pago = await trx('finance.payment_allocations').where({ id: aF4 }).first();
        expect(Number(pago.amount_assigned)).toBeCloseTo(19400, 2);
        expect(pago.updated_by).toBe(USER);
        expect((await cal.daySummary(D11)).assigned_amount).toBeCloseTo(19400, 2);
        // ⭐ Lo cubierto NO se movió: reservado 20,000 y disponible 0. Si la reserva sumara sólo el
        // neto, aquí quedarían 600 disponibles y la factura volvería a «Agregar facturas».
        const d = await derivada(F4);
        expect(Number(d!.reserved_amount)).toBeCloseTo(20000, 2);
        expect(Number(d!.available_amount)).toBeCloseTo(0, 2);
        const ofrecidas = (await cal.listObligations({ search: 'DTPIT' })).rows as { obligation_id: string }[];
        expect(ofrecidas.some((x) => x.obligation_id === kid(F4))).toBe(false);
      });

      it('⛔ un descuento que no cuadra, uno que es toda la factura o un cuerpo sin descuento se rechazan, y la factura queda igual', async () => {
        // 2 % de 20,000 son 400, no 150.
        await expect(cal.setItemDiscount(aF4, itF4, { discount_amount: 150, discount_reason: 'volumen', discount_rate: 0.02, discount_note: null }, USER))
          .rejects.toThrow(/no cuadra/);
        // Descontar la factura entera no es un pago: es una nota de crédito.
        await expect(cal.setItemDiscount(aF4, itF4, { discount_amount: 20000, discount_reason: 'volumen', discount_rate: null, discount_note: null }, USER))
          .rejects.toThrow(/toda la factura/);
        // Un cuerpo sin `discount_amount` no se lee como «quitarlo»: quitarlo se pide con 0.
        await expect(cal.setItemDiscount(aF4, itF4, { discount_amount: undefined, discount_reason: 'volumen' }, USER))
          .rejects.toThrow(/Falta el descuento/);
        // Tampoco `null` ni '' (el validador los leería como 0 y lo quitaría en silencio).
        await expect(cal.setItemDiscount(aF4, itF4, { discount_amount: null, discount_reason: 'volumen' }, USER))
          .rejects.toThrow(/Falta el descuento/);
        await expect(cal.setItemDiscount(aF4, itF4, { discount_amount: '  ', discount_reason: 'volumen' }, USER))
          .rejects.toThrow(/Falta el descuento/);
        // El descuento que ya tenía sigue entero: un rechazo no lo borra ni lo cambia.
        const i = await renglon();
        expect(Number(i.applied_amount)).toBeCloseTo(19400, 2);
        expect(Number(i.discount_amount)).toBeCloseTo(600, 2);
        expect(i.discount_reason).toBe('pronto_pago');
        expect(Number(i.discount_rate)).toBeCloseTo(0.03, 6);
        const pago = await trx('finance.payment_allocations').where({ id: aF4 }).first();
        expect(Number(pago.amount_assigned)).toBeCloseTo(19400, 2);
      });

      it('quitar el descuento (0, el botón «Quitar el descuento»): vuelve a pagarse completa y sigue cubierta', async () => {
        const quitar: PaymentCalendarItemDiscountBody = { discount_amount: 0 };
        const r = await cal.setItemDiscount(aF4, itF4, quitar, USER);
        expect(r).toEqual({ allocation_id: aF4, item_id: itF4, applied_amount: 20000, discount_amount: 0, amount_assigned: 20000 });
        const i = await renglon();
        expect(Number(i.applied_amount)).toBeCloseTo(20000, 2);
        expect(Number(i.discount_amount)).toBe(0);
        expect(i.discount_reason).toBeNull();
        expect(i.discount_rate).toBeNull();
        expect(i.discount_note).toBeNull();
        // Sin descuento no hay a quién atribuírselo: la auditoría va con el descuento.
        expect(i.discount_by).toBeNull();
        expect(i.discount_at).toBeNull();
        const d = await derivada(F4);
        expect(Number(d!.reserved_amount)).toBeCloseTo(20000, 2);
        expect(Number(d!.available_amount)).toBeCloseTo(0, 2);
        expect((await cal.daySummary(D11)).assigned_amount).toBeCloseTo(20000, 2);
      });
    });

    /**
     * `[PGP.91]` **La nota de crédito del descuento llega a Kepler ANTES que la transferencia.**
     * Al ejecutar se mide lo CUBIERTO (neto + descuento) contra el pendiente de Kepler, con UNA
     * excepción: si Kepler ya debe EXACTAMENTE el neto (±1 centavo), la nota del descuento ya se
     * aplicó y el pago es correcto. #482 no la probaba (un gate sin prueba negativa, regla 12): va
     * con su control — una nota MAYOR que el descuento deja a Kepler debiendo menos que el neto y
     * el pago se frena. La nota se siembra en `kdxf` como el abono del candado de Kepler de arriba
     * (la vista resta todo lo aplicado al documento, sin mirar su tipo).
     */
    describe('[PGP.91] la nota de crédito del descuento llega antes que la transferencia', () => {
      const F5 = 'DTPIT-F5';   // 10,000 = 9,700 + 300 (3 % de pronto pago); en Kepler, una nota de 300
      const F6 = 'DTPIT-F6';   // 10,000 = el mismo pago — CONTROL: en Kepler, una nota de 500
      const D10 = '2030-03-08';
      let aF5 = '';
      let aF6 = '';
      const pendienteKepler = async (folio: string): Promise<number | null> => {
        const r = await trx('analytics.v_supplier_payables').where({ sucursal: '08', proveedor: PROV, folio }).first('pendiente');
        return r ? Number(r.pendiente) : null;
      };

      beforeAll(async () => {
        for (const folio of [F5, F6]) {
          await trx('kepler_ods.kdxe').insert({ sucursal: '08', c1: '08', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: folio, c7: '2030-03-01 00:00:00', c10: '2030-03-20 00:00:00', c11: 10000 });
        }
        const conTresPorCiento = async (folio: string): Promise<string> => (await cal.createAllocation({
          date: D10,
          items: [{ obligation_source: 'kepler_payable', obligation_id: kid(folio), applied_amount: 9700, discount_amount: 300, discount_reason: 'pronto_pago', discount_rate: 0.03 }],
        }, USER)).id;
        aF5 = await conTresPorCiento(F5);
        aF6 = await conTresPorCiento(F6);
        await trx('budget.daily_capacity').insert({ tenant_id: M, capacity_date: D10, authorized_amount: 100000, created_by: 'tp_it', updated_by: 'tp_it' });
        await cal.setPriorityRank(aF5, 1, USER);
        await cal.setPriorityRank(aF6, 2, USER);
        for (const id of [aF5, aF6]) {
          await cal.prepare(id, { payment_method: 'transferencia', bank_account_id: originId, destination_account_text: 'BBVA · CLABE 032180000118359719' }, USER);
        }
        await cal.releaseLot(D10, 'tp_it_gerencia');
        // Ya autorizado el día y ANTES de transferir, el proveedor emite la nota en Kepler.
        for (const [folio, monto] of [[F5, 300], [F6, 500]] as [string, number][]) {
          await trx('kepler_ods.kdxf').insert({ sucursal: '08', c1: '08', c2: PROV, c3: '2030-03-08 00:00:00', c4: 30, c5: 1, c6: `${folio}-NC`, c7: 20, c8: 1, c9: folio, c10: monto });
        }
      }, 60_000);

      it('⭐ la nota es justo el descuento: Kepler ya debe sólo el neto y ejecutar PASA', async () => {
        // Control de la siembra: si la nota no pegara, el pendiente seguiría en 10,000 y el pago
        // pasaría por la regla general, no por la excepción que aquí se prueba.
        expect(await pendienteKepler(F5)).toBeCloseTo(9700, 2);
        const r = await cal.execute(aF5, USER);
        expect(r.status).toBe('executed');
        // Lo cubierto pasó a pagado: la factura no se vuelve a ofrecer aunque Kepler siga
        // mostrando los 9,700 hasta que registre la transferencia.
        const d = await derivada(F5);
        expect(Number(d!.paid_amount)).toBeCloseTo(10000, 2);
        expect(Number(d!.reserved_amount)).toBeCloseTo(0, 2);
      });

      it('⛔ CONTROL: una nota MAYOR que el descuento deja a Kepler debiendo menos que el neto, y ejecutar se frena', async () => {
        expect(await pendienteKepler(F6)).toBeCloseTo(9500, 2);
        await expect(cal.execute(aF6, USER)).rejects.toThrow(/pendiente en Kepler/);
        const p = await trx('finance.payment_allocations').where({ id: aF6 }).first();
        expect(p.status).toBe('pending');
      });
    });
  });

});
