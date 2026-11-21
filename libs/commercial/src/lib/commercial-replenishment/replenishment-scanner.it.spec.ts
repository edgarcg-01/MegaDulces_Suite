/**
 * `[CANON.7.4e]` Prueba de INTEGRACIÓN del scanner de reorden (A13) —el código REAL que escribe la bandeja
 * `commercial.replenishment_findings`— contra Postgres real, como `app_runtime`. Regla 13: lo que escribe se prueba
 * contra una base real.
 *
 * Lo que fija: la bandeja lee la existencia del ODS (la misma que la pantalla de Existencia crítica, [CANON.7.2]) y
 * NO la copia `commercial.stock`. Se siembra a propósito una copia que miente (100 piezas) contra Kepler (3): con la
 * copia no habría hallazgo; con el ODS, sí.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`). Sin la
 * variable se salta y lo DICE. TODO dentro de una transacción que se revierte (el scanner abre la suya: aquí es un
 * SAVEPOINT de la de la prueba).
 */
import knexFactory, { type Knex } from 'knex';
import { ReplenishmentScannerService } from './replenishment-scanner.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const SUC = '96';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[CANON.7.4e] NO MEDIDO: sin TP_IT_DB la prueba de integración del scanner no corre.');

suite('[CANON.7.4e] el scanner de reorden lee la existencia del ODS, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};

  const hallazgo = (p: string) =>
    trx('commercial.replenishment_findings')
      .where({ tenant_id: M, warehouse_id: ids['w'], product_id: p })
      .first('kind', 'status', 'on_hand');

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    // ── Siembra, como el dueño ──────────────────────────────────────────────────────────────────────
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: `IT-${SUC}`, name: 'IT 7.4e almacén', kepler_code: SUC }).returning('id');
    ids['w'] = w.id;
    const [b] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'IT 7.4e marca' }).returning('id');
    // bajo: Kepler 3, la copia dice 100 · sano: Kepler 40, la copia dice 0 (control al revés)
    for (const [k, sku, kepler, copia] of [['bajo', 'IT74E01', 3, 100], ['sano', 'IT74E02', 40, 0]] as const) {
      const [p] = await trx('catalog.products').insert({ tenant_id: M, brand_id: b.id, nombre: `IT 7.4e ${sku}`, sku, activo: true }).returning('id');
      ids[k] = p.id;
      await trx.raw(`INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9, c6, c7) VALUES (?, ?, 0, ?, ?, 0, 0, now(), now())`, [SUC, SUC, sku, kepler]);
      await trx('commercial.stock').insert({ tenant_id: M, warehouse_id: ids['w'], product_id: p.id, quantity: copia, reserved_quantity: 0 });
      await trx('commercial.reorder_policy').insert({ tenant_id: M, warehouse_id: ids['w'], product_id: p.id, reorder_point: 10, max_stock: 50 });
    }
    // ── Como la app ─────────────────────────────────────────────────────────────────────────────────
    await trx.raw('SET LOCAL ROLE app_runtime');
    await new ReplenishmentScannerService(trx as unknown as Knex).scanTenant(M);
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('marca bajo reorden lo que Kepler tiene bajo (3 ≤ 10) aunque la copia diga 100, y guarda la existencia de Kepler', async () => {
    const h = await hallazgo(ids['bajo']);
    expect(h).toBeTruthy();
    expect(h.kind).toBe('bajo_reorden');
    expect(h.status).toBe('open');
    expect(Number(h.on_hand)).toBe(3);
  });

  it('NEGATIVA: no marca lo que Kepler tiene sano (40 > 10) aunque la copia diga 0', async () => {
    expect(await hallazgo(ids['sano'])).toBeUndefined();
  });
});
