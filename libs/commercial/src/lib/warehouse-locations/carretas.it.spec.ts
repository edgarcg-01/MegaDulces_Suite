/**
 * `[GP.11.1]` `[GP.11.2]` Prueba de INTEGRACIÓN de la capa de datos de las carretas: lo que la BASE
 * garantiza aunque una pantalla o un servicio se equivoquen (regla 12: cada regla, rota una vez a propósito).
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE. TODO dentro de una transacción que se revierte;
 * cada intento que debe fallar va en su propio SAVEPOINT para no envenenar a los siguientes.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const USER = '00000000-0000-0000-0000-00000000b301';
const MIG = (f: string) => `../../../../../database/migrations-newdb/${f}`;
const MIGS = {
  ub1: MIG('20261008012049_ub1_ubicaciones_catalogo.js'),
  ub2: MIG('20261008040747_ub2_ubicaciones_captura_masiva.js'),
  // UB3 crea el índice único (tenant, almacén, id) de warehouse_bins al que apunta la FK de la ocupación.
  ub3: MIG('20261010030108_ub3_ubicaciones_asignaciones.js'),
  gp111: MIG('20261120112959_gp11_1_carretas_en_catalogo.js'),
  gp112: MIG('20261120113241_gp11_2_ocupacion_de_carretas.js'),
};
async function migUp(rel: string, trx: Knex.Transaction): Promise<void> {
  const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
  await m.up(trx);
}

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[GP.11] NO MEDIDO: sin TP_IT_DB la prueba de integración de las carretas no corre.');

/** El código SQLSTATE de lo que falló dentro de un SAVEPOINT; `null` si NO falló. */
async function falla(trx: Knex.Transaction, fn: (sp: Knex.Transaction) => Promise<unknown>): Promise<string | null> {
  try {
    await trx.transaction(async (sp) => { await fn(sp); });
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'sin-codigo';
  }
}

const keplerId = (suc: string, serie: number, folio: string) =>
  `md5('kepler/UD40/${suc}/${serie}/${folio}')::uuid`;

suite('[GP.11] Carretas: catálogo y ocupación, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};

  const carreta = (code: string, tipo: string | null, extra: Record<string, unknown> = {}) => ({
    tenant_id: M, warehouse_id: ids['w'], code, familia: 'carreta', tipo, estado: 'activa', ...extra,
  });
  const ocupar = (bin: string, extra: Record<string, unknown> = {}) => ({
    tenant_id: M, warehouse_id: ids['w'], bin_id: ids[bin], source: 'suite', order_id: ids['pedido'],
    occupied_by: USER, occupied_by_name: 'GPIT Surtidor', created_by: USER, updated_by: USER, ...extra,
  });

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    if (!(await trx.schema.withSchema('commercial').hasColumn('warehouse_bins', 'familia'))) await migUp(MIGS.ub1, trx);
    const existe = async (obj: string) => !!(await trx.raw('SELECT to_regclass(?) AS r', [obj])).rows[0].r;
    if (!(await existe('commercial.location_capture_batches'))) await migUp(MIGS.ub2, trx);
    if (!(await existe('commercial.bin_assignments'))) await migUp(MIGS.ub3, trx);
    await migUp(MIGS.gp111, trx);
    await migUp(MIGS.gp112, trx);

    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: 'GP-97', name: 'GPIT almacén', kepler_code: '97' }).returning('id');
    const [otro] = await trx('commercial.warehouses').insert({ tenant_id: M, code: 'GP-96', name: 'GPIT otro almacén', kepler_code: '96' }).returning('id');
    ids['w'] = w.id;
    ids['otro'] = otro.id;
    const filas = await trx('commercial.warehouse_bins')
      .insert([
        carreta('C07', 'carreta'),
        carreta('C08', 'carrito'),
        carreta('C09', 'carreta', { estado: 'baja', active: false, motivo_estado: 'GPIT rueda rota' }),
        { tenant_id: M, warehouse_id: ids['w'], code: 'BA053', familia: 'ubicacion', zona: 'B', pasillo: 'A', rack: 5, nivel: 3, tipo: 'surtido', estado: 'activa' },
        { tenant_id: M, warehouse_id: otro.id, code: 'C07', familia: 'carreta', tipo: 'carreta', estado: 'activa' },
      ])
      .returning(['id', 'code', 'warehouse_id']);
    for (const f of filas as Array<{ id: string; code: string; warehouse_id: string }>) ids[f.warehouse_id === otro.id ? `otro:${f.code}` : f.code] = f.id;
    ids['pedido'] = (await trx.raw('SELECT gen_random_uuid() AS u')).rows[0].u;
    ids['pedido2'] = (await trx.raw('SELECT gen_random_uuid() AS u')).rows[0].u;
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  // ── GP.11.1 · el catálogo ───────────────────────────────────────────────────────────────────

  it('una carreta y un carrito se dan de alta con su código Cnn y su tipo', () => {
    expect(ids['C07']).toBeTruthy();
    expect(ids['C08']).toBeTruthy();
  });

  it('NEGATIVA: carreta sin tipo (NULL), con tipo de ubicación, con código fuera de C01–C99 o con zona: la base la rechaza', async () => {
    expect(await falla(trx, (sp) => sp('commercial.warehouse_bins').insert(carreta('C10', null)))).toBe('23514');
    expect(await falla(trx, (sp) => sp('commercial.warehouse_bins').insert(carreta('C11', 'surtido')))).toBe('23514');
    expect(await falla(trx, (sp) => sp('commercial.warehouse_bins').insert(carreta('C100', 'carreta')))).toBe('23514');
    expect(await falla(trx, (sp) => sp('commercial.warehouse_bins').insert(carreta('C00', 'carreta')))).toBe('23514');
    expect(await falla(trx, (sp) => sp('commercial.warehouse_bins').insert(carreta('C12', 'carreta', { zona: 'B' })))).toBe('23514');
  });

  it('NEGATIVA: una ubicación BA0nn no puede quedar como carrito', async () => {
    expect(await falla(trx, (sp) => sp('commercial.warehouse_bins').where({ id: ids['BA053'] }).update({ tipo: 'carrito' }))).toBe('23514');
  });

  // ── GP.11.2 · la ocupación ──────────────────────────────────────────────────────────────────

  it('⭐ D7: una carreta, un pedido a la vez — la segunda ocupación abierta choca; liberada, se vuelve a tomar', async () => {
    const [a] = await trx('commercial.cart_occupations').insert(ocupar('C07')).returning('id');
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('C07', { order_id: ids['pedido2'] })))).toBe('23505');
    await trx('commercial.cart_occupations').where({ id: a.id }).update({
      released_at: trx.fn.now(), released_by: USER, released_by_name: 'GPIT Coordinador', release_reason: 'manual',
    });
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('C07', { order_id: ids['pedido2'] })))).toBeNull();
  });

  it('un pedido sí puede traer dos carretas («agregar otra carreta»)', async () => {
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('C08', { order_id: ids['pedido2'] })))).toBeNull();
    const { rows } = await trx.raw(
      `SELECT count(*)::int AS n FROM commercial.cart_occupations WHERE order_id = ? AND released_at IS NULL`, [ids['pedido2']]);
    expect(rows[0].n).toBe(2);
  });

  it('NEGATIVA: no se ocupa una ubicación que no es carreta, una carreta dada de baja ni la carreta de otro almacén', async () => {
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('BA053')))).toBe('23514');
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('C09')))).toBe('23514');
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('otro:C07')))).toBe('23503');
  });

  it('Kepler: el order_id sale de la llave del U-D-40 (el mismo de wave_orders); uno inventado se rechaza', async () => {
    const llave = { source: 'kepler', kepler_sucursal: '97', kepler_serie: 40, kepler_folio: '12345' };
    // Hay que liberar la C08 para volverla a ocupar.
    await trx('commercial.cart_occupations').where({ bin_id: ids['C08'] }).whereNull('released_at').update({
      released_at: trx.fn.now(), released_by: USER, released_by_name: 'GPIT', release_reason: 'deshecho',
    });
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('C08', { ...llave, order_id: ids['pedido'] })))).toBe('23514');
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('C08', { ...llave, order_id: sp.raw(keplerId('97', 40, '12345')) })))).toBeNull();
    // Y un pedido de la Suite no puede traer partes de la llave de Kepler.
    expect(await falla(trx, (sp) => sp('commercial.cart_occupations').insert(ocupar('C07', { kepler_folio: '1' })))).toBe('23514');
  });

  it('NEGATIVA: liberar a medias (sin quién, sin motivo o con un motivo inventado) se rechaza', async () => {
    const abierta = await trx('commercial.cart_occupations').where({ bin_id: ids['C08'] }).whereNull('released_at').first('id');
    const liberar = (cambios: Record<string, unknown>) => (sp: Knex.Transaction) =>
      sp('commercial.cart_occupations').where({ id: abierta.id }).update(cambios);
    expect(await falla(trx, liberar({ released_at: trx.fn.now(), release_reason: 'manual' }))).toBe('23514');
    expect(await falla(trx, liberar({ released_at: trx.fn.now(), released_by: USER, released_by_name: 'X' }))).toBe('23514');
    expect(await falla(trx, liberar({ released_at: trx.fn.now(), released_by: USER, released_by_name: 'X', release_reason: 'se_perdio' }))).toBe('23514');
  });

  it('la tabla tiene RLS forzado y app_runtime NO puede borrar (la historia de ocupación no se borra)', async () => {
    const { rows } = await trx.raw(`
      SELECT c.relforcerowsecurity AS forced,
             has_table_privilege('app_runtime', 'commercial.cart_occupations', 'DELETE') AS borra,
             has_table_privilege('app_runtime', 'commercial.cart_occupations', 'INSERT') AS inserta
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'commercial' AND c.relname = 'cart_occupations'`);
    expect(rows[0]).toEqual({ forced: true, borra: false, inserta: true });
  });
});
