/**
 * `[MCP.27]` Prueba de INTEGRACIÓN del aviso «no hubo nada» (regla 13: un endpoint que escribe se ejerce contra una
 * base real con lo que manda la pantalla). TODO en una transacción que se revierte; sólo con `TP_IT_DB` LOCAL que
 * no sea prod (se compara el `system_identifier`).
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { PresalePickingService } from './presale-picking.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const YO = '00000000-0000-0000-0000-00000000b311';
const ANA = '00000000-0000-0000-0000-00000000b312';
const MIG = (f: string) => `../../../../../database/migrations-newdb/${f}`;
const MIGS = {
  // La revisión en caja (MCP.10): la bandeja lee `reviewed_*`; una base local vieja no la trae.
  revision: MIG('20261029125146_presale_picks_revision_caja.js'),
  mcp27: MIG('20261120134833_mcp27_pedido_vacio_aviso_a_la_vendedora.js'),
};
const migUp = async (rel: string, k: Knex.Transaction) => (createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (x: Knex) => Promise<void> }).up(k);

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[MCP.27] NO MEDIDO: sin TP_IT_DB la prueba de integración del aviso no corre.');

suite('[MCP.27] Aviso «no hubo nada», contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: PresalePickingService;
  let yo = YO;
  const alerts = { emitTo: vi.fn() };
  const push = { sendToUser: vi.fn(async () => undefined) };
  const ids: Record<string, string> = {};
  const status = async (p: Promise<unknown>): Promise<number | 'ok'> => {
    try { await p; return 'ok'; } catch (e) { return (e as { getStatus?: () => number }).getStatus?.() ?? -1; }
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    if (!(await trx.schema.withSchema('commercial').hasTable('presale_picks'))) throw new Error('NO MEDIDO: la base local no tiene presale_picks.');
    if (!(await trx.schema.withSchema('commercial').hasColumn('presale_picks', 'reviewed_by'))) await migUp(MIGS.revision, trx);
    await migUp(MIGS.mcp27, trx);

    const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => trx.transaction((sp) => fn(sp)) };
    const tenantCtx = { requireTenantId: () => M, get: () => ({ tenantId: M, userId: yo }) };
    const scope = { warehouseIds: async () => null };
    svc = new PresalePickingService(tk as never, tenantCtx as never, scope as never, {} as never, {} as never, alerts as never, push as never);

    const vendedora = (await trx.raw('SELECT id FROM identity.users LIMIT 1')).rows[0]?.id;
    if (!vendedora) throw new Error('NO MEDIDO: la base local no tiene usuarios.');
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: 'MCP-97', name: 'MCPIT almacén' }).returning('id');
    const [cli] = await trx('commercial.customers').insert({ tenant_id: M, code: 'MCPIT-CLI', name: 'MCPIT Abarrotes' }).returning('id');
    const pedido = async (code: string, quien: string | null) => {
      const [o] = await trx('commercial.orders')
        .insert({ tenant_id: M, code, customer_id: cli.id, user_id: vendedora, warehouse_id: w.id, status: 'confirmed', delivery_type: 'route', requested_delivery_date: '2026-11-20', total: 120 })
        .returning('id');
      if (quien) await trx('commercial.presale_picks').insert({ tenant_id: M, order_id: o.id, warehouse_id: w.id, started_by: quien, started_by_name: quien === YO ? 'MCPIT Yo' : 'MCPIT Ana' });
      return o.id as string;
    };
    ids['mio'] = await pedido('PD-MCPIT1', YO);
    ids['ajeno'] = await pedido('PD-MCPIT2', ANA);
    ids['sinEmpezar'] = await pedido('PD-MCPIT3', null);
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('⭐ quien surte avisa: queda «por cancelar», con su nombre, y a la vendedora le llega el aviso una vez', async () => {
    const r = await svc.reportEmpty(ids['mio']);
    expect(r.state).toBe('por_cancelar');
    expect(r.empty_reported?.user_id).toBe(YO);
    expect(r.finished).toBeNull();
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(String((push.sendToUser.mock.calls[0] as unknown[])[1] && (push.sendToUser.mock.calls[0] as unknown as [string, { title: string }])[1].title)).toBe('No hubo nada de tu pedido');
    // Avisar otra vez: no repite el aviso ni cambia quién avisó.
    const otra = await svc.reportEmpty(ids['mio']);
    expect(otra.state).toBe('por_cancelar');
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVA: el pedido de otra persona (403) y uno sin empezar (409) no se avisan', async () => {
    expect(await status(svc.reportEmpty(ids['ajeno']))).toBe(403);
    expect(await status(svc.reportEmpty(ids['sinEmpezar']))).toBe(409);
  });

  it('NEGATIVA de la base: avisar a medias (sin quién) la rechaza el CHECK', async () => {
    const r = await trx
      .transaction((sp) => sp('commercial.presale_picks').where({ order_id: ids['ajeno'] }).update({ empty_reported_at: sp.fn.now() }))
      .then(() => 'ok', (e: { code?: string }) => e.code);
    expect(r).toBe('23514');
  });

  it('la regla de MCP sigue: el pedido NO se cerró (finished_at vacío)', async () => {
    const p = await trx('commercial.presale_picks').where({ order_id: ids['mio'] }).first('finished_at', 'empty_reported_by_name');
    expect(p.finished_at).toBeNull();
    expect(p.empty_reported_by_name).toBeTruthy();
  });
});
