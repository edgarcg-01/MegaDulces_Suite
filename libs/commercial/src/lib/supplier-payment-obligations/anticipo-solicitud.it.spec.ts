/**
 * `[PGP.119]` Prueba de INTEGRACIÓN: pedir un anticipo (`SupplierPaymentObligationsService.crearAnticipo`,
 * el código real) contra un Postgres de verdad, con el cuerpo EXACTO que manda el diálogo (regla 13), y
 * su seguimiento hasta que Kepler lo captura y lo aplica.
 *
 * `[PGP.127]` El pedido ya lleva sus papeles: la OC de Kepler (`X-A-35`, leída de `kepler_ods.kdm1`), la
 * cotización (llave del almacenamiento privado) y la cuenta (aprobada · CLABE nueva → solicitud de alta ·
 * efectivo). El almacenamiento es un doble: lo que se prueba aquí es la BASE (qué se guarda, qué se rechaza).
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE. Todo dentro de una transacción que se
 * revierte. Datos de PRUEBA (`CIT119…`, `CIT127…`), nunca reales.
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
const MIGS = [
  '../../../../../database/migrations-newdb/20261113175529_pgp119_anticipo_como_obligacion_de_pago.js',
  '../../../../../database/migrations-newdb/20261117121939_pgp127_anticipo_cotizacion_oc_y_cuenta.js',
];
const COT = { key: `commercial/${M}/anticipos/it127.pdf`, kind: 'pdf' as const };
const CLABE = '012180001234567899', OTRA = '072180009999999993';   // sintéticas, dígito de control bien

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[PGP.119] NO MEDIDO: sin TP_IT_DB la prueba de integración del anticipo no corre.');

suite('[PGP.119] pedir un anticipo contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: SupplierPaymentObligationsService;
  let prov = '', gasto = '', otro = '', oc = '', ocOtro = '', primero = '', segundo = '';
  /** Lo que subió el doble del almacenamiento (la carpeta decide si la llave es de este tenant). */
  const subidos: string[] = [];
  const oc1 = { sucursal: '03', serie: '1', folio: 'IT127OC1' };
  const oc6 = { sucursal: '00', serie: '1', folio: 'IT127OC6' };
  const cuerpo = (p: Partial<AnticipoSolicitudBody> = {}): AnticipoSolicitudBody => ({
    supplier_id: prov, sucursal: '03', monto: 6000, motivo: 'apartar producto de temporada', purchase_order_id: oc, fecha: null,
    kepler_ocs: [oc1], cotizacion: COT, cuenta: { tipo: 'efectivo' }, ...p,
  });
  /** Una OC `X-A-35` en la réplica de Kepler. */
  const ocKepler = (sucursal: string, folio: string, acreedor: string, total: number, estado = 'N') => trx.raw(
    `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c43) VALUES (?, ?, 'X', 'A', 35, 1, ?, now(), ?, ?, ?)`,
    [sucursal, sucursal, folio, acreedor, total, estado]);

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    for (const rel of MIGS) {
      const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
      await m.up(trx);
    }
    const storage = {
      putFile: async (_uri: string, folder: string) => { const key = `${folder}/subida-${subidos.length}.pdf`; subidos.push(key); return { key, kind: 'pdf' as const }; },
      signedUrl: async (key: string) => `https://firmada.example/${key}`,
    };
    svc = new SupplierPaymentObligationsService({ run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) } as never, { requireTenantId: () => M } as never, storage as never);

    const sup = async (code: string, name: string) => (await trx('catalog.suppliers').insert({ tenant_id: M, code, name, activo: true }).returning('id'))[0].id as string;
    prov = await sup('CIT119A', 'CIT119 DULCES DE PRUEBA');
    gasto = await sup('GIT119B', 'GIT119 RENTA DE PRUEBA');
    otro = await sup('CIT119C', 'CIT119 OTRO PROVEEDOR');
    const wh = (await trx('commercial.warehouses').where({ tenant_id: M }).first('id'))?.id
      ?? (await trx('commercial.warehouses').insert({ tenant_id: M, code: 'IT9', name: 'IT119 ALMACÉN DE PRUEBA' }).returning('id'))[0].id;
    // `[PGP.127]` Sin `created_by`: en prod (y en la base de prueba) es UUID, y el nombre de usuario de la
    // siembra de `[PGP.119]` tumbaba esta prueba entera en el `beforeAll` — nunca llegó a correr un caso.
    const po = async (folio: string, supplierId: string) => (await trx('commercial.purchase_orders').insert({
      tenant_id: M, folio, warehouse_id: wh, supplier_id: supplierId, total_cost: 10000, estado: 'open',
    }).returning('id'))[0].id as string;
    oc = await po('IT119-OC1', prov);
    ocOtro = await po('IT119-OC2', otro);
    // `[PGP.127]` Las OC de Kepler: dos vivas en 03, una en 08, una en 00, una SURTIDA (F) y una de OTRO acreedor.
    await ocKepler('03', 'IT127OC1', 'CIT119A', 10000);
    await ocKepler('03', 'IT127OC2', 'CIT119A', 5000, 'R');
    await ocKepler('08', 'IT127OC3', 'CIT119A', 9000);
    await ocKepler('03', 'IT127OC4', 'CIT119A', 7000, 'F');
    await ocKepler('03', 'IT127OC5', 'CIT119C', 7000);
    await ocKepler('00', 'IT127OC6', 'CIT119A', 8000);
  }, 60_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('⭐ pedir $6,000 con su OC de Kepler, su cotización y en efectivo: nace una obligación anticipo con sus papeles', async () => {
    const r = await svc.crearAnticipo(cuerpo(), USER);
    primero = r.obligation_id;
    expect(r).toMatchObject({ monto: 6000, cuenta: 'efectivo' });
    expect(r.concepto).toMatch(/^Anticipo · OC IT127OC1 · OC Suite IT119-OC1 · \S/);   // la sucursal, por nombre
    const o = await trx('commercial.supplier_payment_obligations').where({ id: primero }).first();
    expect(o).toMatchObject({ nature: 'anticipo', supplier_id: prov, purchase_order_id: oc, kepler_sucursal: '03', kepler_folio: null, authorized_by: USER, created_by: USER, status: 'pending',
      quote_file_key: COT.key, quote_file_kind: 'pdf', payee_clabe: null });
    expect(o.kepler_ocs).toEqual([oc1]);
    expect(Number(o.original_amount)).toBe(6000);
    expect(o.notes).toBe('apartar producto de temporada');
    expect(o.original_due_date).toBeTruthy();   // sin fecha: hoy
  });

  it('[PGP.127] las OC de Kepler del proveedor: vivas (N/R) y suyas, con lo ya pedido sobre cada una', async () => {
    const ocs = await svc.anticipoOcs(prov);
    const folios = ocs.map((x) => x.folio);
    expect(folios).toEqual(expect.arrayContaining(['IT127OC1', 'IT127OC2', 'IT127OC3', 'IT127OC6']));
    expect(folios).not.toContain('IT127OC4');   // surtida: ya tiene su factura
    expect(folios).not.toContain('IT127OC5');   // de otro acreedor
    expect(ocs.find((x) => x.folio === 'IT127OC1')).toMatchObject({ sucursal: '03', serie: '1', total: 10000, pedidos: [{ id: primero, monto: 6000 }] });
    expect(ocs.find((x) => x.folio === 'IT127OC2')).toMatchObject({ estado: 'R', pedidos: [] });
  });

  it('⛔ NEGATIVA — un segundo pedido no pasa del saldo de la OC ($4,000) y lo dice; dentro del saldo, sí', async () => {
    await expect(svc.crearAnticipo(cuerpo({ monto: 4000.01 }), USER)).rejects.toThrow(/quedan \$4000\.00/);
    const r = await svc.crearAnticipo(cuerpo({ monto: 4000, sucursal: '00', kepler_ocs: [oc6] }), USER);
    expect(r.monto).toBe(4000);
    segundo = r.obligation_id;
  });

  it('⛔ NEGATIVA — a un acreedor de gasto no se le pide anticipo, y la OC de la Suite de otro proveedor no se acepta', async () => {
    await expect(svc.crearAnticipo(cuerpo({ supplier_id: gasto, purchase_order_id: null }), USER)).rejects.toThrow(/mercancía/);
    await expect(svc.crearAnticipo(cuerpo({ purchase_order_id: ocOtro }), USER)).rejects.toThrow(/otro proveedor/);
  });

  it('⛔ NEGATIVA [PGP.127] — sin cotización, con una llave ajena, sin OC, con OC ajena, surtida o de dos sucursales no sale', async () => {
    const p = { purchase_order_id: null, monto: 100 };
    await expect(svc.crearAnticipo(cuerpo({ ...p, cotizacion: null }), USER)).rejects.toThrow(/cotización/);
    await expect(svc.crearAnticipo(cuerpo({ ...p, cotizacion: { key: 'commercial/otro-tenant/anticipos/x.pdf', kind: 'pdf' } }), USER)).rejects.toThrow(/no es válida/);
    await expect(svc.crearAnticipo(cuerpo({ ...p, cotizacion: { key: `commercial/${M}/anticipos/../../x.pdf`, kind: 'pdf' } }), USER)).rejects.toThrow(/no es válida/);
    await expect(svc.crearAnticipo(cuerpo({ ...p, kepler_ocs: [] }), USER)).rejects.toThrow(/orden de compra de Kepler/);
    await expect(svc.crearAnticipo(cuerpo({ ...p, kepler_ocs: [{ sucursal: '03', serie: '1', folio: 'IT127OC5' }] }), USER)).rejects.toThrow(/IT127OC5 no es de este proveedor/);
    await expect(svc.crearAnticipo(cuerpo({ ...p, kepler_ocs: [{ sucursal: '03', serie: '1', folio: 'IT127OC4' }] }), USER)).rejects.toThrow(/ya no está pendiente/);
    await expect(svc.crearAnticipo(cuerpo({ ...p, kepler_ocs: [oc1, { sucursal: '08', serie: '1', folio: 'IT127OC3' }] }), USER)).rejects.toThrow(/sucursales distintas/);
    await expect(svc.crearAnticipo(cuerpo({ ...p, sucursal: '08' }), USER)).rejects.toThrow(/sucursal del anticipo es la de su orden/);
    // Nada de lo rechazado dejó fila.
    expect(await trx('commercial.supplier_payment_obligations').where({ supplier_id: prov, nature: 'anticipo' }).count('* as n').first()).toMatchObject({ n: '2' });
  });

  it('[PGP.127] D6 sobre dos OC: la suma menos lo ya pedido, y el pedido que abarca las dos se cuenta UNA vez', async () => {
    // OC1 (10,000, con 6,000 ya pedidos) + OC2 (5,000) → quedan 9,000.
    await expect(svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 9000.01, kepler_ocs: [oc1, { sucursal: '03', serie: '1', folio: 'IT127OC2' }] }), USER))
      .rejects.toThrow(/Las 2 OC suman \$15000\.00 y ya tienen \$6000\.00 en anticipos: quedan \$9000\.00/);
    const r = await svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 1000, kepler_ocs: [oc1, { sucursal: '03', serie: '1', folio: 'IT127OC2' }] }), USER);
    const ocs = await svc.anticipoOcs(prov);
    // Ese pedido aparece en LAS DOS OC (abarca las dos)…
    expect(ocs.find((x) => x.folio === 'IT127OC1')!.pedidos.map((p) => p.id)).toContain(r.obligation_id);
    expect(ocs.find((x) => x.folio === 'IT127OC2')!.pedidos.map((p) => p.id)).toEqual([r.obligation_id]);
    // …y aun así el tope de las dos lo cuenta una sola vez: 15,000 − 6,000 − 1,000 = 8,000.
    await expect(svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 8000.01, kepler_ocs: [oc1, { sucursal: '03', serie: '1', folio: 'IT127OC2' }] }), USER))
      .rejects.toThrow(/quedan \$8000\.00/);
    await svc.cancel(r.obligation_id, 'prueba del tope de dos OC', USER);
  });

  it('⭐ [PGP.127] D12 — una CLABE nueva queda PEDIDA de alta con la cotización de respaldo; la misma CLABE no se pide dos veces', async () => {
    const r1 = await svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 500, cuenta: { tipo: 'nueva', clabe: '0121 8000 1234 5678 99', banco: 'BBVA' } }), USER);
    expect(r1.cuenta).toBe('pedida');
    const pedidas = await trx('commercial.supplier_payment_account_change_requests').where({ tenant_id: M, supplier_id: prov, proposed_clabe: CLABE });
    expect(pedidas).toHaveLength(1);
    expect(pedidas[0]).toMatchObject({ status: 'pending_approval', proposed_bank_name: 'BBVA', proposed_attachment_url: COT.key, proposed_attachment_kind: 'pdf', requested_by: USER, account_id: null, deactivate: false, proposed_es_favorita: false });
    // Nunca da de alta la cuenta: eso lo hace Dirección.
    expect(await trx('commercial.supplier_payment_accounts').where({ tenant_id: M, supplier_id: prov })).toHaveLength(0);
    expect((await trx('commercial.supplier_payment_obligations').where({ id: r1.obligation_id }).first()).payee_clabe).toBe(CLABE);
    const de = async (id: string) => (await svc.listAnticiposSolicitados()).find((s) => s.obligation_id === id)!;
    expect((await de(r1.obligation_id)).cuenta).toEqual({ estado: 'en_aprobacion', clabe: CLABE, banco: 'BBVA' });

    const r2 = await svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 500, cuenta: { tipo: 'nueva', clabe: CLABE, banco: 'BBVA' } }), USER);
    expect(r2.cuenta).toBe('ya_pedida');
    expect(await trx('commercial.supplier_payment_account_change_requests').where({ tenant_id: M, supplier_id: prov, proposed_clabe: CLABE })).toHaveLength(1);

    // Dirección la aprueba (lo que hace `approveRequest`): el seguimiento la dice aprobada, sin copiar nada.
    await trx('commercial.supplier_payment_accounts').insert({ tenant_id: M, supplier_id: prov, bank_name: 'BBVA', clabe: CLABE, status: 'activa', es_favorita: false, created_by: 'direccion_it' });
    await trx('commercial.supplier_payment_account_change_requests').where({ id: pedidas[0].id }).update({ status: 'applied', decided_by: 'direccion_it' });
    expect((await de(r1.obligation_id)).cuenta.estado).toBe('aprobada');
    // Y ya aprobada, capturarla otra vez no pide nada: el servidor la reconoce.
    const r3 = await svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 500, cuenta: { tipo: 'nueva', clabe: CLABE, banco: 'BBVA' } }), USER);
    expect(r3.cuenta).toBe('aprobada');
    for (const id of [r1.obligation_id, r2.obligation_id, r3.obligation_id]) await svc.cancel(id, 'prueba de la cuenta', USER);
  });

  it('⛔ NEGATIVA [PGP.127] — una cuenta «aprobada» de OTRO proveedor no sirve; la propia sí, con su CLABE', async () => {
    const ajena = (await trx('commercial.supplier_payment_accounts').insert({ tenant_id: M, supplier_id: otro, bank_name: 'BANORTE', clabe: OTRA, status: 'activa', es_favorita: false, created_by: USER }).returning('id'))[0].id as string;
    await expect(svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 100, cuenta: { tipo: 'aprobada', account_id: ajena } }), USER)).rejects.toThrow(/no es de este proveedor/);
    const propia = (await trx('commercial.supplier_payment_accounts').where({ tenant_id: M, supplier_id: prov, clabe: CLABE }).first('id')).id as string;
    const r = await svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 100, cuenta: { tipo: 'aprobada', account_id: propia } }), USER);
    expect(r.cuenta).toBe('aprobada');
    expect((await trx('commercial.supplier_payment_obligations').where({ id: r.obligation_id }).first()).payee_clabe).toBe(CLABE);
    await expect(svc.crearAnticipo(cuerpo({ purchase_order_id: null, monto: 100, cuenta: { tipo: 'nueva', clabe: '012180001234567890', banco: 'BBVA' } }), USER)).rejects.toThrow(/dígito de control/);
    await svc.cancel(r.obligation_id, 'prueba de la cuenta', USER);
  });

  it('[PGP.127] la cotización: sólo PDF o foto, en la carpeta del tenant; se abre con URL firmada, y el pedido viejo dice que no la tiene', async () => {
    await expect(svc.subirCotizacion('data:text/plain;base64,aG9sYQ==')).rejects.toThrow(/PDF o foto/);
    const s = await svc.subirCotizacion('data:application/pdf;base64,JVBERi0xLjQK');
    expect(s.key.startsWith(`commercial/${M}/anticipos/`)).toBe(true);
    expect(await svc.cotizacionUrl(primero)).toEqual({ url: `https://firmada.example/${COT.key}`, kind: 'pdf' });
    const viejo = (await trx('commercial.supplier_payment_obligations').insert({
      tenant_id: M, supplier_id: prov, nature: 'anticipo', concept: 'pedido de antes', original_amount: 10, authorized_by: USER, authorized_at: trx.fn.now(),
      created_by: USER, kepler_sucursal: '03', kepler_doc_tipo: 60,
    }).returning('id'))[0].id as string;
    await expect(svc.cotizacionUrl(viejo)).rejects.toThrow(/sin cotización/);
    expect((await svc.listAnticiposSolicitados()).find((x) => x.obligation_id === viejo)!.cuenta.estado).toBe('sin_dato');
    await svc.cancel(viejo, 'prueba del pedido viejo', USER);
  });

  it('⛔ NEGATIVA (la base) — un anticipo no puede llevar folio de Kepler, ni una CLABE que no sean 18 dígitos', async () => {
    await expect(trx.transaction(async (t) => {
      await t('commercial.supplier_payment_obligations').where({ id: primero }).update({ kepler_folio: '0000001' });
    })).rejects.toThrow(/ck_spo_anticipo_sin_folio/);
    await expect(trx.transaction(async (t) => {
      await t('commercial.supplier_payment_obligations').where({ id: primero }).update({ payee_clabe: '0121-8000' });
    })).rejects.toThrow(/ck_spo_payee_clabe/);
  });

  it('⭐ el seguimiento: por programar → «En Kepler» cuando CxP lo captura → «Aplicado» cuando Kepler lo aplica', async () => {
    const de = async () => (await svc.listAnticiposSolicitados()).find((s) => s.obligation_id === primero)!;
    expect(await de()).toMatchObject({ etapa: 'por_programar', proveedor: 'CIT119A', sucursal: '03', oc_folio: 'IT119-OC1', kepler: null,
      // `[PGP.127]`/`[PGP.129]` Lo que el Calendario necesita para ofrecerlo en su día.
      supplier_id: prov, disponible: 6000, ocs: [oc1], tiene_cotizacion: true, cuenta: { estado: 'efectivo', clabe: null, banco: null } });
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

  // ── `[PGP.126]` Cancelar desde el submódulo: el mismo `POST :id/cancelar`, con el cuerpo de la pantalla ──
  // `[PGP.142]` La pantalla ya cancela por `POST anticipos/:id/cancelar` (`cancelAnticipo`), que también usa Finanzas.
  it('⛔ NEGATIVA [PGP.126] — cancelar un anticipo exige razón y no se repite; al cancelarlo, su OC recupera el saldo', async () => {
    await expect(svc.cancelAnticipo(segundo, '  ', USER)).rejects.toThrow(/por qué se cancela/);
    const r = await svc.cancelAnticipo(segundo, 'el proveedor ya no lo pide', USER);
    expect(r).toMatchObject({ status: 'cancelled', notes: 'apartar producto de temporada\n[cancelado] el proveedor ya no lo pide', updated_by: USER });
    await expect(svc.cancelAnticipo(segundo, 'otra vez', USER)).rejects.toThrow(/ya estaba cancelado/);
    expect((await svc.anticipoOcs(prov)).find((x) => x.folio === 'IT127OC6')).toMatchObject({ pedidos: [] });
  });

  it('⛔ NEGATIVA [PGP.142] — la cancelación de anticipos NO cancela una factura de Compras: «no encontrado» y queda viva', async () => {
    const [factura] = await trx('commercial.supplier_payment_obligations').insert({
      tenant_id: M, supplier_id: prov, nature: 'factura', original_amount: 1234, authorized_by: USER, concept: 'IT130 factura de prueba',
    }).returning('id');
    await expect(svc.cancelAnticipo(factura.id, 'no debería poder', USER)).rejects.toThrow(/Anticipo no encontrado/);
    expect((await trx('commercial.supplier_payment_obligations').where({ id: factura.id }).first('status')).status).not.toBe('cancelled');
    await expect(svc.cancelAnticipo('no-es-un-id', 'x x x', USER)).rejects.toThrow(/inválido/);
    // La puerta de Compras (genérica) sí la cancela: lo de Compras sigue siendo de Compras.
    expect(await svc.cancel(factura.id, undefined, USER)).toMatchObject({ status: 'cancelled' });
  });

  it('⛔ NEGATIVA [PGP.126] — el pedido cancelado no le quita su X-D-60 al vivo de mismo acreedor, sucursal e importe', async () => {
    const vivo = (await svc.crearAnticipo(cuerpo({ monto: 4000, sucursal: '00', purchase_order_id: null, kepler_ocs: [oc6] }), USER)).obligation_id;
    await trx.raw(`INSERT INTO kepler_ods.kdxe (sucursal, c1, c2, c3, c4, c5, c6, c7, c11, c20)
                   VALUES ('00', '00', 'CIT119A', 'D', 60, 1, 'IT119X62', now()::date, 4000, 4000)`);
    const filas = await svc.listAnticiposSolicitados();
    expect(filas.find((s) => s.obligation_id === vivo)).toMatchObject({ etapa: 'en_kepler', kepler: { folio: 'IT119X62' } });
    expect(filas.find((s) => s.obligation_id === segundo)).toMatchObject({ etapa: 'cancelado', kepler: null, posibles: 0 });
  });

  // ── `[PGP.144]` El embudo: «Cubierto» con su fecha, y lo que Kepler tiene sin solicitud ──
  it('⭐ [PGP.144] cuando el programa de pagos lo paga, queda Cubierto con el día en que se pagó', async () => {
    const r = await svc.crearAnticipo(cuerpo({ monto: 500, sucursal: '03', purchase_order_id: null, kepler_ocs: [{ sucursal: '03', serie: '1', folio: 'IT127OC2' }] }), USER);
    // Un día de lote propio (la base local puede tener ya el de hoy): «programado» es el día del lote, «cubierto» el del pago.
    const [lote] = await trx('finance.payment_calendar_lots').insert({ tenant_id: M, lot_date: '2031-01-15' })
      .onConflict(['tenant_id', 'lot_date']).merge().returning('id');
    const [pago] = await trx('finance.payment_allocations').insert({ tenant_id: M, lot_id: lote.id, classification: 'proveedor_mercancia', status: 'executed', executed_at: trx.fn.now() }).returning('id');
    await trx('finance.payment_allocation_items').insert({ tenant_id: M, allocation_id: pago.id, obligation_source: 'supplier_payable', obligation_id: r.obligation_id, applied_amount: 500 });
    const de = async () => (await svc.listAnticiposSolicitados()).find((s) => s.obligation_id === r.obligation_id)!;
    const { rows: [h] } = await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`);
    // ⛔ NEGATIVA: con el pago hecho pero la obligación sin abono todavía, no se dice «Cubierto».
    expect(await de()).toMatchObject({ etapa: 'programado', cubierto_el: h.d });
    await trx('commercial.supplier_payment_obligations').where({ id: r.obligation_id }).update({ paid_amount: 500 });
    expect(await de()).toMatchObject({ etapa: 'pagado', cubierto_el: h.d, programado_dia: '2031-01-15', kepler: null });
  });

  it('⭐ [PGP.144] lo que Kepler tiene sin solicitud: sin los pareados, sin gasto, y dentro del periodo', async () => {
    await trx.raw(`INSERT INTO kepler_ods.kdxe (sucursal, c1, c2, c3, c4, c5, c6, c7, c11, c20) VALUES
      ('03', '03', 'GIT119B', 'D', 60, 1, 'IT132G1', now()::date, 700, 700),
      ('03', '03', 'CIT119C', 'D', 60, 1, 'IT132V1', (now() - interval '100 days')::date, 900, 900),
      ('03', '03', 'CIT119C', 'D', 60, 1, 'IT119X60', now()::date, 250, 250)`);
    const sin = await svc.anticiposKeplerSinSolicitud(90);
    const folios = sin.map((k) => k.folio);
    // ⛔ NEGATIVA (revisión del PR): OTRO acreedor con el MISMO folio en la misma sucursal que un pareado no se esconde.
    expect(sin.filter((k) => k.folio === 'IT119X60').map((k) => k.proveedor)).toEqual(['CIT119C']);
    expect(folios).toContain('IT119X61');            // en 08 nadie lo pidió: fuera del embudo
    expect(sin.some((k) => k.folio === 'IT119X60' && k.proveedor === 'CIT119A')).toBe(false);   // pareado con su solicitud
    expect(folios).not.toContain('IT119X62');        // pareado con el vivo (no con el cancelado)
    expect(folios).not.toContain('IT132G1');         // gasto: no se pide aquí
    expect(folios).not.toContain('IT132V1');         // de hace 100 días: fuera de 90
    expect((await svc.anticiposKeplerSinSolicitud(180)).map((k) => k.folio)).toContain('IT132V1');
    const x61 = (await svc.anticiposKeplerSinSolicitud(90)).find((k) => k.folio === 'IT119X61')!;
    expect(x61).toMatchObject({ sucursal: '08', proveedor: 'CIT119A', proveedor_nombre: 'CIT119 DULCES DE PRUEBA', importe: 6000 });
  });
});
