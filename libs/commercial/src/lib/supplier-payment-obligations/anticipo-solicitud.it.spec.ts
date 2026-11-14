/**
 * `[PGP.119]` Prueba de INTEGRACIÓN: pedir un anticipo (`SupplierPaymentObligationsService.crearAnticipo`,
 * el código real) contra un Postgres de verdad, con el cuerpo EXACTO que manda el diálogo (regla 13), y
 * su seguimiento hasta que Kepler lo captura y lo aplica.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE. Todo dentro de una transacción que se
 * revierte. Datos de PRUEBA (`CIT119…`), nunca reales.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import type { AnticipoSolicitudBody } from '@megadulces/contracts';
import { SupplierPaymentObligationsService } from './supplier-payment-obligations.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const USER = 'pgp119_it_compras';
const MIG = '../../../../../database/migrations-newdb/20261113175529_pgp119_anticipo_como_obligacion_de_pago.js';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[PGP.119] NO MEDIDO: sin TP_IT_DB la prueba de integración del anticipo no corre.');

suite('[PGP.119] pedir un anticipo contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: SupplierPaymentObligationsService;
  let prov = '', gasto = '', otro = '', oc = '', ocOtro = '', primero = '';
  const cuerpo = (p: Partial<AnticipoSolicitudBody> = {}): AnticipoSolicitudBody => ({
    supplier_id: prov, sucursal: '03', monto: 6000, motivo: 'apartar producto de temporada', purchase_order_id: oc, fecha: null, ...p,
  });

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    const m = createRequire(__filename)(resolvePath(__dirname, MIG)) as { up: (k: Knex) => Promise<void> };
    await m.up(trx);
    svc = new SupplierPaymentObligationsService({ run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) } as never, { requireTenantId: () => M } as never);

    const sup = async (code: string, name: string) => (await trx('catalog.suppliers').insert({ tenant_id: M, code, name, activo: true }).returning('id'))[0].id as string;
    prov = await sup('CIT119A', 'CIT119 DULCES DE PRUEBA');
    gasto = await sup('GIT119B', 'GIT119 RENTA DE PRUEBA');
    otro = await sup('CIT119C', 'CIT119 OTRO PROVEEDOR');
    const wh = (await trx('commercial.warehouses').where({ tenant_id: M }).first('id'))?.id
      ?? (await trx('commercial.warehouses').insert({ tenant_id: M, code: 'IT9', name: 'IT119 ALMACÉN DE PRUEBA' }).returning('id'))[0].id;
    const po = async (folio: string, supplierId: string) => (await trx('commercial.purchase_orders').insert({
      tenant_id: M, folio, warehouse_id: wh, supplier_id: supplierId, total_cost: 10000, estado: 'open', created_by: USER,
    }).returning('id'))[0].id as string;
    oc = await po('IT119-OC1', prov);
    ocOtro = await po('IT119-OC2', otro);
  }, 60_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('⭐ pedir $6,000 atado a la OC: nace una obligación de naturaleza anticipo, autorizada para programarse', async () => {
    const r = await svc.crearAnticipo(cuerpo(), USER);
    primero = r.obligation_id;
    expect(r.monto).toBe(6000);
    expect(r.concepto).toContain('Anticipo · OC IT119-OC1');
    const o = await trx('commercial.supplier_payment_obligations').where({ id: primero }).first();
    expect(o).toMatchObject({ nature: 'anticipo', supplier_id: prov, purchase_order_id: oc, kepler_sucursal: '03', kepler_folio: null, authorized_by: USER, created_by: USER, status: 'pending' });
    expect(Number(o.original_amount)).toBe(6000);
    expect(o.notes).toBe('apartar producto de temporada');
    expect(o.original_due_date).toBeTruthy();   // sin fecha: hoy
  });

  it('las OC abiertas del proveedor dicen lo ya anticipado (el tope de la pantalla)', async () => {
    const ocs = await svc.anticipoOcs(prov);
    expect(ocs.find((x) => x.id === oc)).toMatchObject({ folio: 'IT119-OC1', total: 10000, anticipado: 6000 });
  });

  it('⛔ NEGATIVA — un segundo pedido no pasa del saldo de la OC ($4,000) y lo dice; dentro del saldo, sí', async () => {
    await expect(svc.crearAnticipo(cuerpo({ monto: 4000.01 }), USER)).rejects.toThrow(/quedan \$4000\.00/);
    const r = await svc.crearAnticipo(cuerpo({ monto: 4000, sucursal: '00' }), USER);
    expect(r.monto).toBe(4000);
  });

  it('⛔ NEGATIVA — a un acreedor de gasto no se le pide anticipo, y la OC de otro proveedor no se acepta', async () => {
    await expect(svc.crearAnticipo(cuerpo({ supplier_id: gasto, purchase_order_id: null }), USER)).rejects.toThrow(/mercancía/);
    await expect(svc.crearAnticipo(cuerpo({ purchase_order_id: ocOtro }), USER)).rejects.toThrow(/otro proveedor/);
  });

  it('⛔ NEGATIVA (la base) — un anticipo no puede llevar folio de Kepler: el CHECK lo rechaza', async () => {
    await expect(trx.transaction(async (t) => {
      await t('commercial.supplier_payment_obligations').where({ id: primero }).update({ kepler_folio: '0000001' });
    })).rejects.toThrow(/ck_spo_anticipo_sin_folio/);
  });

  it('⭐ el seguimiento: por programar → «En Kepler» cuando CxP lo captura → «Aplicado» cuando Kepler lo aplica', async () => {
    const de = async () => (await svc.listAnticiposSolicitados()).find((s) => s.obligation_id === primero)!;
    expect(await de()).toMatchObject({ etapa: 'por_programar', proveedor: 'CIT119A', sucursal: '03', oc_folio: 'IT119-OC1', kepler: null });
    // CxP captura el X-D-60 en Kepler: mismo acreedor, misma sucursal, mismo importe, hoy.
    await trx.raw(`INSERT INTO kepler_ods.kdxe (sucursal, c1, c2, c3, c4, c5, c6, c7, c11, c20)
                   VALUES ('03', '03', 'CIT119A', 'D', 60, 1, 'IT119X60', now()::date, 6000, 6000)`);
    // Control negativo: el mismo importe en OTRA sucursal no se liga.
    await trx.raw(`INSERT INTO kepler_ods.kdxe (sucursal, c1, c2, c3, c4, c5, c6, c7, c11, c20)
                   VALUES ('08', '08', 'CIT119A', 'D', 60, 1, 'IT119X61', now()::date, 6000, 6000)`);
    expect(await de()).toMatchObject({ etapa: 'en_kepler', kepler: { folio: 'IT119X60', importe: 6000, remanente: 6000 }, posibles: 1 });
    await trx.raw(`UPDATE kepler_ods.kdxe SET c20 = 0 WHERE sucursal = '03' AND btrim(c6) = 'IT119X60' AND c4::int = 60`);
    expect((await de()).etapa).toBe('aplicado');
  });
});
