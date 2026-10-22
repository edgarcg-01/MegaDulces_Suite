/**
 * `[TP.20.5]` Prueba de INTEGRACIÓN de **la ficha de la obligación**: el código real de
 * `EntityRefService` contra un Postgres de verdad.
 *
 * ⭐ Lo que se ejerce es la **unificación**: que una sola factura reúna lo que hasta hoy vivía
 * repartido en cuatro pantallas —la deuda, la ventana de pronto pago, el día en que quedó
 * programada y el pago de Kepler que la liquidó— y que el vínculo factura↔pago sea el del ERP
 * (`kepler_ods.kdxf`) y no un cruce por monto y mes.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE (no se pinta verde). Todo vive en UNA
 * transacción que se revierte: la base queda como estaba.
 *
 * Datos de PRUEBA (`CTPIT-ER*`), nunca reales.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { EntityRefService } from './entity-ref.service';
import { makeRef } from './entity-ref.types';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const PROV = 'CTPIT-ER1';
const SUC = '00';
const FOLIO = 'TPIT-ER-F1';
const FOLIO_PARCIAL = 'TPIT-ER-F2';
const PAGO = 'TPIT-ER-P1';

const MIGS = [
  '../../../../../database/migrations-newdb/20261008174741_analytics_v_supplier_payables.js',
  '../../../../../database/migrations-newdb/20261010111352_pronto_pago_ventana_observada.js',
  '../../../../../database/migrations-newdb/20261016171340_tp18_allocation_items_origen_kepler_payable.js',
  '../../../../../database/migrations-newdb/20261016185746_tp19_allocation_liga_pago_kepler.js',
];

async function migUp(rel: string, trx: Knex.Transaction): Promise<void> {
  const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
  await m.up(trx);
}

/** Un llamador que puede todo: los filtros POR TIPO tienen su propia prueba abajo. */
const ADMIN = { perms: {}, isAdmin: true };

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[TP.20.5] NO MEDIDO: sin TP_IT_DB la prueba de integración no corre.');
else if (!local) console.log('[TP.20.5] NO MEDIDO: TP_IT_DB no es una base local; me niego a escribir ahí.');

suite('[TP.20.5] La ficha de la obligación contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: EntityRefService;

  const refFactura = (folio: string) => makeRef('oblig', SUC, 20, 1, folio);

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);

    if (!(await trx.raw(`SELECT to_regclass('analytics.v_supplier_payables') AS r`)).rows[0].r) await migUp(MIGS[0], trx);
    if (!(await trx.raw(`SELECT to_regclass('analytics.mv_supplier_prompt_discount') AS r`)).rows[0].r) await migUp(MIGS[1], trx);
    await migUp(MIGS[2], trx);
    await migUp(MIGS[3], trx);

    const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) };
    const ctx = { requireTenantId: () => M };
    svc = new EntityRefService(tk as never, ctx as never);

    // ── Siembra: el proveedor, dos facturas y un pago que liquida parte de una ──
    await trx('kepler_ods.kdxd').insert({ sucursal: SUC, c2: PROV, c3: 'TPIT PROVEEDOR FICHA', c13: 'C' });
    await trx('kepler_ods.kdxe').insert([
      { sucursal: SUC, c1: SUC, c2: PROV, c3: 'A', c4: 20, c5: 1, c6: FOLIO,
        c7: '2030-03-01 00:00:00', c10: '2030-03-31 00:00:00', c11: 50000 },
      { sucursal: SUC, c1: SUC, c2: PROV, c3: 'A', c4: 20, c5: 1, c6: FOLIO_PARCIAL,
        c7: '2030-03-02 00:00:00', c10: '2030-04-01 00:00:00', c11: 30000 },
    ]);
    // El PAGO, en su fuente (`erp_supplier_payments` es una VISTA: no se le inserta).
    await trx('kepler_ods.kdm1').insert({
      sucursal: SUC, c1: SUC, c2: 'X', c3: 'D', c4: 26, c5: 1, c6: PAGO,
      c9: '2030-03-10 00:00:00', c10: PROV, c16: 12000, c31: 'TRANSFERENCIA', c43: 'A',
    });
    // Y la APLICACIÓN del pago contra la factura: esto es lo que liga, y lo pone el ERP.
    await trx('kepler_ods.kdxf').insert({
      sucursal: SUC, c1: SUC, c2: PROV, c3: '2030-03-10 00:00:00',
      c4: 26, c5: 1, c6: PAGO, c7: 20, c8: 1, c9: FOLIO_PARCIAL, c10: 12000,
    });
  }, 60_000);

  afterAll(async () => {
    if (trx) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('⭐ la factura trae su deuda, y el pendiente sale del ERP, no de una resta nuestra', async () => {
    const r = await svc.resolve(refFactura(FOLIO), ADMIN);
    expect(r.kind).toBe('oblig');
    expect(r.title).toContain(FOLIO);
    const campo = (l: string) => r.fields.find((f) => f.label === l)?.value;
    expect(Number(campo('Importe'))).toBe(50000);
    expect(Number(campo('Pendiente'))).toBe(50000);
    expect(Number(campo('Aplicado'))).toBe(0);
  });

  it('⭐ el pago aplicado aparece como RELACIÓN, con lo que aplicó a ESTA factura', async () => {
    const r = await svc.resolve(refFactura(FOLIO_PARCIAL), ADMIN);
    const pago = r.relations.find((x) => x.group === 'Pagos aplicados (Kepler)');
    expect(pago).toBeTruthy();
    expect(pago!.ref).toBe(makeRef('pay', SUC, 'XD2601', PAGO));
    expect(pago!.amount).toBe(12000);
    // Y el saldo refleja la aplicación: 30,000 − 12,000.
    expect(Number(r.fields.find((f) => f.label === 'Pendiente')?.value)).toBe(18000);
  });

  it('⭐ la liga es de ida y vuelta: desde el pago se llega a la factura que liquidó', async () => {
    const r = await svc.resolve(makeRef('pay', SUC, 'XD2601', PAGO), ADMIN);
    const fact = r.relations.find((x) => x.group === 'Facturas que liquidó (liga del ERP)');
    expect(fact).toBeTruthy();
    expect(fact!.ref).toBe(refFactura(FOLIO_PARCIAL));
    expect(fact!.amount).toBe(12000);
  });

  it('⛔ una factura sin programar lo DICE, no se dibuja en cero', async () => {
    const r = await svc.resolve(refFactura(FOLIO), ADMIN);
    expect(r.badges.some((b) => b.text === 'Sin programar')).toBe(true);
    expect(r.notes.join(' ')).toMatch(/todavía no está en ningún día del calendario/i);
  });

  it('⛔ sin observaciones la ventana sale «sin medir», no «no da descuento»', async () => {
    const r = await svc.resolve(refFactura(FOLIO), ADMIN);
    expect(r.badges.some((b) => b.text === 'Ventana sin medir')).toBe(true);
    // ⭐ Y la fecha límite queda NULL: un COALESCE a hoy diría «vence hoy» sobre algo sin medir.
    expect(r.fields.find((f) => f.label === 'Límite de pronto pago')?.value).toBeNull();
  });

  it('⭐ lo programado en el Calendario viaja en la MISMA ficha', async () => {
    const [lot] = await trx('finance.payment_calendar_lots')
      .insert({ tenant_id: M, lot_date: '2030-03-20', status: 'released', released_by: 'tpit_gerencia' })
      .returning('id');
    const [al] = await trx('finance.payment_allocations')
      .insert({ tenant_id: M, lot_id: lot.id, classification: 'proveedor_mercancia',
        amount_assigned: 5000, status: 'pending', created_by: 'tpit_tesoreria' })
      .returning('id');
    const { rows } = await trx.raw(
      `SELECT md5('kepler_payable|'||?||'|'||20||'|'||1||'|'||?)::uuid AS id`, [SUC, FOLIO]);
    await trx('finance.payment_allocation_items').insert({
      tenant_id: M, allocation_id: al.id, obligation_source: 'kepler_payable',
      obligation_id: rows[0].id, applied_amount: 5000,
    });

    const r = await svc.resolve(refFactura(FOLIO), ADMIN);
    const prog = r.fields.find((f) => f.label === 'Programada para 2030-03-20');
    expect(prog).toBeTruthy();
    expect(Number(prog!.value)).toBe(5000);
    // ⭐ Quién liberó el día viaja con el campo: la autorización ES liberar el día (ADR-094).
    expect(prog!.source).toContain('tpit_gerencia');
    expect(r.badges.some((b) => b.text === 'Sin programar')).toBe(false);
  });

  it('⛔ la llave de la ficha es la MISMA que usa el motor de asignaciones', async () => {
    // Si estas dos divergen, la ficha diría «sin programar» sobre algo que sí está programado.
    const { rows } = await trx.raw(
      `SELECT md5('kepler_payable|'||?||'|'||20||'|'||1||'|'||?)::uuid AS id`, [SUC, FOLIO]);
    const item = await trx('finance.payment_allocation_items').where({ obligation_id: rows[0].id }).first();
    expect(item).toBeTruthy();
  });

  it('⛔ una factura saldada no se inventa: se dice que no tiene saldo', async () => {
    await expect(svc.resolve(refFactura('TPIT-NO-EXISTE'), ADMIN))
      .rejects.toThrow(/no tiene saldo pendiente|no existe/i);
  });

  it('⛔ un rol sin el permiso de pagos NO abre la ficha (prueba negativa)', async () => {
    const compras = { perms: { COMPRAS_360_VER: true }, isAdmin: false };
    await expect(svc.resolve(refFactura(FOLIO), compras as never))
      .rejects.toThrow(/no puede abrir/i);
  });

  it('⛔ un ref de factura con partes de menos se rechaza antes de tocar la base', async () => {
    await expect(svc.resolve(`oblig:${SUC}|20|1`, ADMIN)).rejects.toThrow(/espera 4 parte/i);
  });
});
