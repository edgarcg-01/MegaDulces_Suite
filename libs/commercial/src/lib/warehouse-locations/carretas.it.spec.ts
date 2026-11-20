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
import { WarehouseCartsService } from './warehouse-carts.service';

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
  // ── GP.11.4 · el servicio, con el payload de la pantalla ────────────────────────────────────

  describe('[GP.11.4] servicio de carretas (lo que manda la pantalla)', () => {
    let svc: WarehouseCartsService;
    let yo = USER;
    const ANA = '00000000-0000-0000-0000-00000000b302';
    const status = async (p: Promise<unknown>): Promise<number | 'ok'> => {
      try { await p; return 'ok'; } catch (e) { return (e as { getStatus?: () => number }).getStatus?.() ?? -1; }
    };

    beforeAll(async () => {
      const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => trx.transaction((sp) => fn(sp)) };
      const tenantCtx = { requireTenantId: () => M, get: () => ({ tenantId: M, userId: yo }) };
      const scope = { warehouseIds: async () => null, current: async () => ({}), canWrite: () => true };
      svc = new WarehouseCartsService(tk as never, tenantCtx as never, scope as never);
      // Un pedido de preventa que YO estoy surtiendo, y otro que surte Ana.
      // El vendedor del pedido: cualquier usuario de la base (orders.user_id tiene FK a identity.users).
      const vendedor = (await trx.raw('SELECT id FROM identity.users LIMIT 1')).rows[0]?.id;
      if (!vendedor) throw new Error('NO MEDIDO: la base local no tiene ningún usuario para el pedido.');
      const [cli] = await trx('commercial.customers').insert({ tenant_id: M, code: 'GPIT-CLI', name: 'GPIT Cliente' }).returning('id');
      const pedido = async (code: string, quien: string, nombre: string) => {
        const [o] = await trx('commercial.orders').insert({ tenant_id: M, code, customer_id: cli.id, user_id: vendedor, warehouse_id: ids['w'] }).returning('id');
        await trx('commercial.presale_picks').insert({ tenant_id: M, order_id: o.id, warehouse_id: ids['w'], started_by: quien, started_by_name: nombre });
        return o.id as string;
      };
      ids['pdMio'] = await pedido('PD-GPIT01', USER, 'GPIT Yo');
      ids['pdAna'] = await pedido('PD-GPIT02', ANA, 'GPIT Ana');
      // Una ola de Kepler en surtido, asignada a mí, con el U-D-40 12345 de la sucursal 97.
      const [ola] = await trx('commercial.picking_waves').insert({ tenant_id: M, code: 'W-GPIT-1', warehouse_id: ids['w'], status: 'en_surtido', assigned_to: USER }).returning('id');
      await trx.raw(
        `INSERT INTO commercial.wave_orders (tenant_id, wave_id, order_id, stage, source, kepler_sucursal, kepler_serie, kepler_folio)
         VALUES (?, ?, md5('kepler/UD40/97/40/12345')::uuid, 'en_ola', 'kepler', '97', 40, '12345')`,
        [M, ola.id],
      );
      ids['ola'] = ola.id;
      // Una TANDA: dos U-D-40 sumados en una ola.
      const [tanda] = await trx('commercial.picking_waves').insert({ tenant_id: M, code: 'W-GPIT-2', warehouse_id: ids['w'], status: 'en_surtido', assigned_to: USER }).returning('id');
      for (const folio of ['20001', '20002']) {
        await trx.raw(
          `INSERT INTO commercial.wave_orders (tenant_id, wave_id, order_id, stage, source, kepler_sucursal, kepler_serie, kepler_folio)
           VALUES (?, ?, md5('kepler/UD40/97/40/' || ?)::uuid, 'en_ola', 'kepler', '97', 40, ?)`,
          [M, tanda.id, folio, folio],
        );
      }
      ids['tanda'] = tanda.id;
    });

    it('⭐ alta por rango: C01–C03 se crean; repetir el rango no duplica y lo dice', async () => {
      expect(await svc.bulk({ warehouse_id: ids['w'], tipo: 'carreta', desde: 1, hasta: 3 })).toEqual({ creadas: ['C01', 'C02', 'C03'], ya_existian: [] });
      expect(await svc.bulk({ warehouse_id: ids['w'], tipo: 'carrito', desde: 2, hasta: 4 })).toEqual({ creadas: ['C04'], ya_existian: ['C02', 'C03'] });
      expect(await status(svc.bulk({ warehouse_id: ids['w'], tipo: 'carreta', desde: 5, hasta: 100 }))).toBe(400);
    });

    it('⭐ quien surte el PD- teclea «1» en el celular y la C01 queda con su pedido; volver a escanearla no hace nada', async () => {
      const r = await svc.occupy({ warehouse_id: ids['w'], carreta: '1', pedido: { source: 'suite', order_id: ids['pdMio'] } });
      expect(r.ya_estaba).toBe(false);
      expect(r.carreta).toMatchObject({ code: 'C01', ocupacion: { pedido: 'PD-GPIT01', occupied_by: USER, source: 'suite' } });
      const otra = await svc.occupy({ warehouse_id: ids['w'], carreta: 'C01', pedido: { source: 'suite', order_id: ids['pdMio'] } });
      expect(otra.ya_estaba).toBe(true);
    });

    it('⭐ NEGATIVA D7: Ana no mete su pedido en la C01 (409); yo no tomo carreta para el pedido de Ana (403); código malo 400; carreta que no existe 404', async () => {
      yo = ANA;
      expect(await status(svc.occupy({ warehouse_id: ids['w'], carreta: 'C01', pedido: { source: 'suite', order_id: ids['pdAna'] } }))).toBe(409);
      yo = USER;
      expect(await status(svc.occupy({ warehouse_id: ids['w'], carreta: 'C03', pedido: { source: 'suite', order_id: ids['pdAna'] } }))).toBe(403);
      expect(await status(svc.occupy({ warehouse_id: ids['w'], carreta: 'C100', pedido: { source: 'suite', order_id: ids['pdMio'] } }))).toBe(400);
      expect(await status(svc.occupy({ warehouse_id: ids['w'], carreta: 'C55', pedido: { source: 'suite', order_id: ids['pdMio'] } }))).toBe(404);
    });

    it('Kepler: el U-D-40 de mi ola entra por su llave y se lee «UD4040-12345» (como en el Tablero); uno que no está en surtido, 404', async () => {
      const r = await svc.occupy({ warehouse_id: ids['w'], carreta: 'C02', pedido: { source: 'kepler', sucursal: '97', serie: 40, folio: '12345' } });
      expect(r.carreta.ocupacion).toMatchObject({ pedido: 'UD4040-12345', source: 'kepler' });
      const lista = await svc.list(ids['w']);
      expect(lista.carretas.filter((c) => c.ocupacion).map((c) => c.code)).toEqual(['C01', 'C02', 'C07', 'C08']);
      expect(await status(svc.occupy({ warehouse_id: ids['w'], carreta: 'C03', pedido: { source: 'kepler', sucursal: '97', serie: 40, folio: '99999' } }))).toBe(404);
    });

    it('⭐ deshacer: sólo quien la escaneó; liberar a mano: el coordinador (el guard). Después queda libre', async () => {
      const c01 = (await svc.list(ids['w'])).carretas.find((c) => c.code === 'C01')!;
      yo = ANA;
      expect(await status(svc.release(c01.id, 'deshecho'))).toBe(403);
      yo = USER;
      expect((await svc.release(c01.id, 'deshecho')).ocupacion).toBeNull();
      expect(await status(svc.release(c01.id, 'manual'))).toBe(409);
      const c02 = (await svc.list(ids['w'])).carretas.find((c) => c.code === 'C02')!;
      yo = ANA;
      expect((await svc.release(c02.id, 'manual')).ocupacion).toBeNull();
      yo = USER;
      const fila = await trx('commercial.cart_occupations').where({ bin_id: c02.id }).first('release_reason', 'released_by');
      expect(fila).toEqual({ release_reason: 'manual', released_by: ANA });
    });

    it('⭐ por OLA: la pantalla manda la ola de un pedido y el servidor encuentra el U-D-40; la ola dice con qué carreta va', async () => {
      const r = await svc.occupy({ warehouse_id: ids['w'], carreta: 'C03', pedido: { source: 'ola', wave_id: ids['ola'] } });
      expect(r.carreta.ocupacion).toMatchObject({ pedido: 'UD4040-12345', source: 'kepler' });
      const w = await svc.forWave(ids['ola']);
      expect(w).toMatchObject({ pedidos: 1, tanda: false });
      // C01–C04 (alta por rango) + C07 y C08 activas; la C09 está dada de baja y no cuenta.
      expect(w.catalogo).toBe(6);
      // La C08 ya traía este mismo U-D-40 (la ocupó la prueba de C0): un pedido con dos carretas, «agregar otra».
      expect(w.carretas.map((c) => c.code)).toEqual(['C03', 'C08']);
    });

    it('NEGATIVA «tandas después»: una ola de 2 pedidos sumados no toma carreta (409) y se declara tanda', async () => {
      expect(await status(svc.occupy({ warehouse_id: ids['w'], carreta: 'C04', pedido: { source: 'ola', wave_id: ids['tanda'] } }))).toBe(409);
      expect(await svc.forWave(ids['tanda'])).toMatchObject({ pedidos: 2, tanda: true, carretas: [] });
    });
  });
});
