/**
 * `[RE.86]` Prueba de INTEGRACIÓN de la factura compartida: los métodos REALES `ligarFacturaCompartida` /
 * `desligarFacturaCompartida` del servicio, el expediente (`calcularLote`) comparando EN GRUPO, y la condición de
 * «tiene papel» de la lista, contra Postgres real como `app_runtime` (RLS), dentro de una transacción que se
 * revierte. El caso es el de CEDIS con PAF (folios reales, importes SINTÉTICOS: el repo es público): la 0010129
 * registra la factura completa, la 0010302 vuelve a cargar la caja que faltó, y comparten la factura 319.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`), con
 * la migración `20261123165526_re86_factura_compartida_con_motivo` aplicada.
 */
import knexFactory, { type Knex } from 'knex';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';
import { GoodsReceiptExpedienteService } from './goods-receipt-expediente.service';
import { tieneLigaCompartidaSql } from './liga-compartida';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const RFC = 'PAP900115BNA';
const UUID_319 = 'CE15A2DD-0000-4000-8000-000000000319';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[RE.86] NO MEDIDO: sin TP_IT_DB la prueba de la factura compartida no corre.');

type Metodo = (...a: unknown[]) => Promise<unknown>;

suite('[RE.86] factura compartida con motivo, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let cfdiId = '';
  // El servicio REAL, con su transacción, su tenant y su alcance sustituidos por los de la prueba.
  const ctx = () => ({
    tenantCtx: { requireTenantId: () => T, get: () => ({ userId: null, username: 'prueba' }) },
    tk: { run: (fn: (t: Knex.Transaction) => Promise<unknown>) => trx.transaction((sp) => fn(sp)) },
    exigirAlcance: async () => undefined,
  });
  const ligar = (folio: string, body: Record<string, unknown>) =>
    (GoodsReceiptProofsService.prototype as unknown as { ligarFacturaCompartida: Metodo }).ligarFacturaCompartida.call(ctx(), '00', folio, body, 'Revisora de prueba');
  const desligar = (folio: string, motivo: string) =>
    (GoodsReceiptProofsService.prototype as unknown as { desligarFacturaCompartida: Metodo }).desligarFacturaCompartida.call(ctx(), '00', folio, motivo, 'Revisora de prueba');
  const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { const x = e as { getStatus?: () => number; message: string }; return typeof x.getStatus === 'function' ? x.getStatus() : x.message; } };
  const tienePapel = async (folio: string) =>
    (await trx.raw(`SELECT ${tieneLigaCompartidaSql(true)} AS ok FROM analytics.erp_goods_receipts c WHERE c.sucursal = '00' AND c.folio = ?`, [folio])).rows[0]?.ok as boolean;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    // Las dos aplicaciones de Kepler (X-A-20) y una de otro proveedor, para la negativa del RFC.
    const ap = (folio: string, fecha: string, total: number, rfc: string, prov: string, concepto: string) =>
      trx.raw(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c22, c24, c32, c43)
               VALUES ('00', '00', 'X', 'A', 20, 1, ?, ?::timestamp, ?, ?, ?, ?, 'PROVEEDOR DE PRUEBA', 'N')`, [folio, fecha, prov, total, rfc, concepto]);
    await ap('0010129', '2026-10-28', 1000, RFC, 'CP009', 'FALTO 1 CJA');
    await ap('0010302', '2026-11-11', 20, RFC, 'CP009', '2% 10 DIAS');
    await ap('0010999', '2026-11-11', 20, 'XAXX010101000', 'ZZ999', 'otro proveedor');
    const [c] = await trx('fiscal.cfdis').insert({
      tenant_id: T, uuid: UUID_319, serie: 'GDL/2026/', folio: '319', fecha: '2026-10-27', emisor_rfc: RFC, emisor_nombre: 'PAF',
      total: 1000, subtotal: 1000, rol: 'recibidas', tipo_comprobante: 'I', estatus_sat: 'vigente',
    }).returning('id');
    cfdiId = c.id;
    // La liga principal de la 0010129 (sin motivo): así quedaba en Materialidad.
    await trx('fiscal.cfdi_assignments').insert({ tenant_id: T, cfdi_id: cfdiId, cfdi_uuid: UUID_319, rfc: RFC, sucursal: '00', doc_tipo: 'XA2001', doc_folio: '0010129', status: 'confirmed', match_source: 'importe_fecha' });
    await trx.raw('SET LOCAL ROLE app_runtime');
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('CONTROL: la 0010302 no tiene papel ni liga', async () => {
    expect(await tienePapel('0010302')).toBe(false);
  });

  it('NEGATIVAS: sin motivo, motivo corto, sin UUID y factura de OTRO proveedor se rechazan (400) y no escriben', async () => {
    expect(await status(ligar('0010302', { cfdi_uuid: UUID_319 }))).toBe(400);
    expect(await status(ligar('0010302', { cfdi_uuid: UUID_319, motivo: 'falta' }))).toBe(400);
    expect(await status(ligar('0010302', { motivo: 'Llegó la caja que faltó de la 319' }))).toBe(400);
    expect(await status(ligar('0010999', { cfdi_uuid: UUID_319, motivo: 'Llegó la caja que faltó de la 319' }))).toBe(400);
    expect(await tienePapel('0010302')).toBe(false);
  });

  it('con motivo se liga, aunque la factura ya sea de la 0010129; desde ahí la entrada TIENE papel', async () => {
    const r = await ligar('0010302', { cfdi_uuid: UUID_319.toLowerCase(), motivo: '  Llegó la caja que faltó de la factura 319  ' }) as { motivo: string; por: string };
    expect(r).toMatchObject({ motivo: 'Llegó la caja que faltó de la factura 319', por: 'Revisora de prueba' });
    expect(await tienePapel('0010302')).toBe(true);
    const ligas = await trx('fiscal.cfdi_assignments').where({ cfdi_id: cfdiId, status: 'confirmed' }).orderBy('doc_folio').select('doc_folio', 'shared_reason');
    expect(ligas).toEqual([{ doc_folio: '0010129', shared_reason: null }, { doc_folio: '0010302', shared_reason: 'Llegó la caja que faltó de la factura 319' }]);
    // Una entrada sigue teniendo UNA factura: ligarla otra vez se niega.
    expect(await status(ligar('0010302', { cfdi_uuid: UUID_319, motivo: 'Otra vez la misma factura' }))).toBe(400);
  });

  it('el expediente compara EN GRUPO: las dos entradas contra la factura, no una sola contra el total', async () => {
    // `calcularLote` recibe su transacción: no usa ni la conexión, ni el tenant, ni el alcance del servicio.
    type Deps = ConstructorParameters<typeof GoodsReceiptExpedienteService>;
    const svc = new GoodsReceiptExpedienteService(...([null, null, null] as unknown as Deps));
    const lote = await svc.calcularLote(trx, T, [{ sucursal: '00', folio: '0010302' }]);
    const x = lote.get('00/0010302');
    expect(x?.docTipo).toBe('factura');
    expect(x?.cfdi?.uuid).toBe(UUID_319);
    expect(x?.compartida).toMatchObject({ motivo: 'Llegó la caja que faltó de la factura 319', monto_grupo: 1020 });
    expect(x?.compartida?.entradas.map((e) => e.folio)).toEqual(['0010129', '0010302']);
    expect(x?.veredicto.diferencia).toBe(-20); // 1,000 de factura contra 1,020 del grupo, no contra 20
  });

  it('desligar pide motivo; con motivo no borra: queda rechazada con el porqué, y la entrada vuelve a no tener papel', async () => {
    expect(await status(desligar('0010302', 'no'))).toBe(400);
    expect(await status(desligar('0010302', 'Se ligó a la factura equivocada'))).toBe(200);
    const f = await trx('fiscal.cfdi_assignments').where({ doc_folio: '0010302' }).first('status', 'shared_reason', 'note');
    expect(f).toMatchObject({ status: 'rejected', shared_reason: 'Llegó la caja que faltó de la factura 319' });
    expect(f.note).toContain('Se ligó a la factura equivocada');
    expect(await tienePapel('0010302')).toBe(false);
    expect(await status(desligar('0010302', 'Ya no tiene liga que deshacer'))).toBe(400);
  });
});
