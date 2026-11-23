/**
 * `[RE.86]` Materialidad convive con la factura COMPARTIDA (liga con motivo, la hace Revisión de facturas): su lista
 * (`reconcile`) da UNA fila por CFDI aunque tenga varias ligas vivas, y confirmar la liga principal no borra las
 * compartidas. Contra Postgres real como `app_runtime`, en una transacción revertida. Importes SINTÉTICOS.
 *
 * ⛔ Sólo corre con `TP_IT_DB` LOCAL que no sea prod, con la migración `20261123165526` aplicada.
 */
import knexFactory, { type Knex } from 'knex';
import { MaterialidadAssignmentsService } from './materialidad-assignments.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const RFC = 'PAP900115BNA';
const UUID = 'CE15A2DD-0000-4000-8000-000000000086';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[RE.86] NO MEDIDO: sin TP_IT_DB la prueba de Materialidad con factura compartida no corre.');

suite('[RE.86] Materialidad con una factura compartida (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let cfdiId = '';
  const svc = () => {
    type Deps = ConstructorParameters<typeof MaterialidadAssignmentsService>;
    const tk = { run: (fn: (t: Knex.Transaction) => Promise<unknown>) => trx.transaction((sp) => fn(sp)) };
    const tenantCtx = { requireTenantId: () => T, get: () => ({ userId: null, username: 'prueba' }) };
    return new MaterialidadAssignmentsService(...([tk, tenantCtx] as unknown as Deps));
  };
  const vivas = async () => (await trx('fiscal.cfdi_assignments').where({ cfdi_id: cfdiId }).whereIn('status', ['confirmed', 'auto'])
    .orderBy('doc_folio').select('doc_folio', 'shared_reason')) as Array<{ doc_folio: string; shared_reason: string | null }>;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    const [c] = await trx('fiscal.cfdis').insert({
      tenant_id: T, uuid: UUID, serie: 'GDL/2026/', folio: '319', fecha: '2026-10-27', emisor_rfc: RFC, emisor_nombre: 'PAF',
      total: 1000, subtotal: 1000, rol: 'recibidas', tipo_comprobante: 'I', estatus_sat: 'vigente',
    }).returning('id');
    cfdiId = c.id;
    const liga = (folio: string, shared_reason: string | null) => ({
      tenant_id: T, cfdi_id: cfdiId, cfdi_uuid: UUID, rfc: RFC, sucursal: '00', doc_tipo: 'XA2001', doc_folio: folio,
      status: 'confirmed', match_source: shared_reason ? 'compartida' : 'importe_fecha', shared_reason,
    });
    await trx('fiscal.cfdi_assignments').insert([liga('0010129', null), liga('0010302', 'Llegó la caja que faltó de la factura 319')]);
    await trx.raw('SET LOCAL ROLE app_runtime');
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('la lista da UNA fila por CFDI y muestra la liga principal, no la compartida', async () => {
    const filas = (await svc().reconcile(RFC)) as Array<Record<string, unknown>>;
    const deEsta = filas.filter((f) => JSON.stringify(f).includes(UUID));
    expect(deEsta).toHaveLength(1);
    expect(JSON.stringify(deEsta[0])).toContain('0010129');
  });

  it('confirmar otra vez la liga principal NO borra la compartida', async () => {
    await svc().confirm({ cfdi_id: cfdiId, sucursal: '00', doc_tipo: 'XA2001', doc_folio: '0010129' });
    expect(await vivas()).toEqual([
      { doc_folio: '0010129', shared_reason: null },
      { doc_folio: '0010302', shared_reason: 'Llegó la caja que faltó de la factura 319' },
    ]);
  });
});
