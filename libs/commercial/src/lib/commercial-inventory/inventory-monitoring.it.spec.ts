/**
 * `[CANON.7.4d]` Prueba de INTEGRACIÓN de `InventoryMonitoringService` —el código REAL que registra un conteo
 * rápido— contra Postgres real, como `app_runtime`. Regla 13: un camino que ESCRIBE no está probado hasta
 * ejercerlo contra una base real con el payload de la pantalla.
 *
 * ⭐ Por qué importa más que en otros lectores: `recordCount` **guarda** el teórico en `expected_qty` y de él sale
 * la `difference`, que es lo que acusa una pérdida ocurrida en una ventana de horas. Con la copia
 * `commercial.stock` —27,035 celdas que Kepler ya no tiene, medidas en prod el 2026-11-25— el teórico podía estar
 * congelado y el faltante lo fabricaba el instrumento.
 *
 * El control de la prueba: la copia se siembra **mintiendo a propósito** (999 donde Kepler dice 40). Si el
 * servicio volviera a leerla, `expected_qty` sería 999 y estos casos se ponen rojos.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`).
 * Sin la variable se salta y lo DICE. Todo dentro de una transacción que se revierte.
 */
import knexFactory, { type Knex } from 'knex';
import { InventoryMonitoringService } from './inventory-monitoring.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const SUC = '96';
const SKU = 'IT74D01';
/** Un SKU que NO existe en `kdil`: «sin fila» se lee como 0, la misma regla que con la copia. */
const SKU_SIN_KEPLER = 'IT74D02';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[CANON.7.4d] NO MEDIDO: sin TP_IT_DB la prueba de integración del conteo rápido no corre.');

suite('[CANON.7.4d] el conteo rápido de Monitoreo: teórico del ODS, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};
  let user = '';
  /** El servicio REAL, con el `tk` apuntado a la transacción de la prueba. */
  let svc: InventoryMonitoringService;

  const monitorear = async (productKey: string): Promise<string> => {
    // `commercial_inv_monitoring_one_active`: UN monitoreo activo por (almacén, producto). Es regla de dominio,
    // así que la prueba la respeta cerrando el anterior en vez de esquivarla con otro producto.
    await trx('commercial.inventory_monitoring')
      .where({ warehouse_id: ids['w'], product_id: ids[productKey], status: 'active' })
      .update({ status: 'closed', closed_at: trx.fn.now() });
    const [m] = await trx('commercial.inventory_monitoring')
      .insert({
        tenant_id: M, warehouse_id: ids['w'], product_id: ids[productKey],
        status: 'active', counts_per_day: 2, reason: 'IT 7.4d', started_at: trx.fn.now(), started_by: user,
      })
      .returning('id');
    return m.id;
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);

    // ── Siembra, como el dueño ──────────────────────────────────────────────────────────────────
    user = (await trx('public.users').where({ tenant_id: M }).first('id')).id;
    const [w] = await trx('commercial.warehouses')
      .insert({ tenant_id: M, code: `IT-${SUC}`, name: 'IT 7.4d almacén', kepler_code: SUC })
      .returning('id');
    ids['w'] = w.id;
    const [b] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'IT 7.4d marca' }).returning('id');
    for (const [k, sku] of [['p', SKU], ['p_sin', SKU_SIN_KEPLER]] as const) {
      const [p] = await trx('catalog.products')
        .insert({ tenant_id: M, brand_id: b.id, nombre: `IT 7.4d ${sku}`, sku })
        .returning('id');
      ids[k] = p.id;
    }
    // Kepler dice 40 del primero y no conoce al segundo.
    await trx.raw(
      `INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9, c6, c7) VALUES (?, ?, 0, ?, 40, 0, 0, now(), now())`,
      [SUC, SUC, SKU],
    );
    // ⛔ El CONTROL: la copia miente. Si el servicio la leyera, el teórico sería 999 y 0.
    await trx('commercial.stock').insert([
      { tenant_id: M, warehouse_id: ids['w'], product_id: ids['p'], quantity: 999, reserved_quantity: 0 },
      { tenant_id: M, warehouse_id: ids['w'], product_id: ids['p_sin'], quantity: 777, reserved_quantity: 0 },
    ]);

    // ── De aquí en adelante, como la app ────────────────────────────────────────────────────────
    await trx.raw('SET LOCAL ROLE app_runtime');
    svc = new InventoryMonitoringService(
      { run: (cb: (t: Knex.Transaction) => unknown) => cb(trx) } as never,
      { get: () => ({ userId: user }) } as never,
    );
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('el teórico es la existencia de Kepler (40), NO la de la copia (999)', async () => {
    const monId = await monitorear('p');
    const row = await svc.recordCount(monId, { physical_qty: 37 });
    expect(Number(row.expected_qty)).toBe(40);
    expect(Number(row.physical_qty)).toBe(37);
    expect(Number(row.difference)).toBe(-3);
  });

  it('un producto que Kepler no tiene vale 0, igual que con la copia (y la copia dice 777)', async () => {
    const monId = await monitorear('p_sin');
    const row = await svc.recordCount(monId, { physical_qty: 5 });
    expect(Number(row.expected_qty)).toBe(0);
    expect(Number(row.difference)).toBe(5);
  });

  it('la ventana del 1er conteo arranca en el inicio del monitoreo y la del 2º, en el conteo previo', async () => {
    const monId = await monitorear('p');
    const mon = await trx('commercial.inventory_monitoring').where({ id: monId }).first('started_at');
    const uno = await svc.recordCount(monId, { physical_qty: 40 });
    expect(new Date(uno.window_from).getTime()).toBe(new Date(mon.started_at).getTime());
    const dos = await svc.recordCount(monId, { physical_qty: 38 });
    expect(new Date(dos.window_from).getTime()).toBe(new Date(uno.counted_at).getTime());
    // La pérdida queda acotada a la 2ª ventana: el 1er conteo cuadraba con Kepler.
    expect(Number(uno.difference)).toBe(0);
    expect(Number(dos.difference)).toBe(-2);
  });

  it('registrar el conteo NO toca la copia: la Suite no escribe el saldo (ADR-040)', async () => {
    const antes = await trx('commercial.stock').where({ warehouse_id: ids['w'] }).orderBy('product_id').select('product_id', 'quantity');
    const monId = await monitorear('p');
    await svc.recordCount(monId, { physical_qty: 1 });
    const despues = await trx('commercial.stock').where({ warehouse_id: ids['w'] }).orderBy('product_id').select('product_id', 'quantity');
    expect(despues).toEqual(antes);
  });

  it('un monitoreo cerrado no acepta conteos, y un id que no es uuid se rechaza antes de tocar la base', async () => {
    const monId = await monitorear('p');
    await trx('commercial.inventory_monitoring').where({ id: monId }).update({ status: 'closed' });
    await expect(svc.recordCount(monId, { physical_qty: 1 })).rejects.toThrow(/cerrado/i);
    await expect(svc.recordCount('no-soy-uuid', { physical_qty: 1 })).rejects.toThrow(/inválido/i);
  });

  it('un físico negativo o no numérico se rechaza (el payload de la pantalla no siempre llega limpio)', async () => {
    const monId = await monitorear('p');
    await expect(svc.recordCount(monId, { physical_qty: -1 })).rejects.toThrow(/physical_qty/);
    await expect(svc.recordCount(monId, { physical_qty: 'tres' as never })).rejects.toThrow(/physical_qty/);
  });
});
