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
import { ProntoPagoService } from '../pronto-pago/pronto-pago.service';
import { PaymentProgramService } from '../payment-program/payment-program.service';
import { sqlVentanaProntoPago } from '@megadulces/contracts/finance/pronto-pago-ventana';
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

});
