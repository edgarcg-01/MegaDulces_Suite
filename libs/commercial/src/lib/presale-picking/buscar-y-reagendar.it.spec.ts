/**
 * `[MCP.28]` `[MCP.29]` `[MCP.30]` Prueba de INTEGRACIÓN — el código REAL de los servicios contra Postgres real,
 * como `app_runtime` (RLS y grants de verdad). Regla 13: un camino que escribe no está probado hasta ejercerlo
 * contra una base real, con el payload de la pantalla (el de `VendorService.modificarPedido`).
 *
 *   · MCP.28 «Mis pedidos» busca por folio, cliente sin acento, producto y monto; las palabras cortas van completas;
 *     trae cancelados; la vendedora sólo ve lo suyo y el supervisor también lo de su equipo (`is_mine: false`).
 *   · MCP.29 mover el día de entrega: sólo la fecha NO reabre (no deja fila `→ draft`), mueve el grupo entero,
 *     deja la fila de historia con las dos fechas y «Por qué cambió» la cuenta; el pasado, otro vendedor y un
 *     pedido que el surtidor ya tomó NO se mueven, y no queda nada escrito.
 *   · MCP.30 la lista de «Por entregar» (`list`) busca en TODO lo que cumple los filtros y `total` cuenta lo encontrado.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`). Sin la
 * variable se salta y lo DICE. TODO dentro de una transacción que se revierte; cada intento que debe fallar va en su
 * propio SAVEPOINT (el `tk.run` de prueba abre uno por llamada, como la request abre su transacción).
 */
import knexFactory, { type Knex } from 'knex';
import { CommercialOrdersService } from '../commercial-orders/commercial-orders.service';
import { PresaleControlService } from '../presale-control/presale-control.service';
import { PresalePickingService } from './presale-picking.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const HOY_MAS = (d: number): string => {
  const f = new Date(Date.now() + d * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(f);
};

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[MCP.28-29] NO MEDIDO: sin TP_IT_DB la prueba de integración del buscador y del cambio de fecha no corre.');

/** El código HTTP de la excepción de Nest (o el código SQL) de lo que falló; 200 si NO falló. */
async function status(fn: () => Promise<unknown>): Promise<number | string> {
  try {
    await fn();
    return 200;
  } catch (e) {
    const x = e as { getStatus?: () => number; code?: string; message: string };
    return typeof x.getStatus === 'function' ? x.getStatus() : (x.code ?? x.message);
  }
}

suite('[MCP.28-29] buscar pedidos y mover el día de entrega, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};
  /** Quién está en sesión: la vendedora `yo` (supervisora de `equipo`) u `otro` (de nadie). */
  let sesion = '';
  const ctx = { get: () => ({ userId: sesion, roleName: 'vendedor_ruta', tenantId: M }), requireTenantId: () => M };
  // Cada llamada al servicio corre en su SAVEPOINT: un rechazo no envenena la transacción de la prueba.
  const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => trx.transaction((sp) => fn(sp)) };
  const nada = {} as never;
  const pedidos = new CommercialOrdersService(tk as never, ctx as never, nada, nada, nada, nada, nada, nada);
  const control = new PresaleControlService(tk as never, ctx as never, nada);
  const picking = new PresalePickingService(tk as never, ctx as never, nada, pedidos, control, nada, nada);

  /** El payload de «Guardar cambios» de la tarjeta (`VendorService.modificarPedido` + MCP.29). */
  const guardar = (id: string, fecha: string | undefined, changes: unknown[] = []) =>
    pedidos.modificarAgendado(id, 'Cambiar la fecha de entrega: el cliente no está', changes, false, fecha);
  const diaDe = async (id: string): Promise<string> =>
    (await trx('commercial.orders').where({ id }).first(trx.raw(`to_char(requested_delivery_date, 'YYYY-MM-DD') AS d`))).d;
  const historia = (id: string) =>
    trx('commercial.order_status_history').where({ order_id: id }).orderBy('changed_at')
      .select('from_status', 'to_status', trx.raw(`snapshot -> 'delivery_date' AS dd`));
  const buscar = async (q: string) => (await picking.sellerSearch(q)).data.map((d) => d.code).sort();

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    // ── Siembra, como el dueño ──────────────────────────────────────────────────────────────────────
    const { role_name } = await trx('identity.users').where({ tenant_id: M }).whereNotNull('role_name').first('role_name');
    const usuario = async (username: string, nombre: string, supervisor_id: string | null = null) =>
      (await trx('identity.users').insert({ tenant_id: M, username, nombre, role_name, status: 'invited', supervisor_id }).returning('id'))[0].id;
    ids['yo'] = await usuario('it_mcp27_yo', 'VENDEDORA IT MCP27');
    ids['equipo'] = await usuario('it_mcp27_eq', 'RUBEN IT MCP27', ids['yo']);
    ids['otro'] = await usuario('it_mcp27_otro', 'AJENO IT MCP27');
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: 'IT-M27', name: 'IT MCP27 almacén' }).returning('id');
    const [b] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'IT MCP27 marca' }).returning('id');
    const [payaso] = await trx('catalog.products').insert({ tenant_id: M, brand_id: b.id, nombre: 'PALETA PAYASO IT27', sku: 'IT27PAY' }).returning('id');
    const [mazapan] = await trx('catalog.products').insert({ tenant_id: M, brand_id: b.id, nombre: 'MAZAPAN ROSA IT27', sku: 'IT27MAZ' }).returning('id');
    const cliente = async (code: string, name: string) =>
      (await trx('commercial.customers').insert({ tenant_id: M, code, name }).returning('id'))[0].id;
    const lupita = await cliente('IT27LUP', 'Abarrotes Lupita IT27');
    const trebol = await cliente('IT27TRE', 'Dulcería El Trébol IT27');
    const pedido = async (k: string, code: string, customer_id: string, user_id: string, st: string, total: number, prods: string[], extra: Record<string, unknown> = {}) => {
      const [o] = await trx('commercial.orders').insert({
        tenant_id: M, code, customer_id, user_id, warehouse_id: w.id, status: st, total,
        requested_delivery_date: HOY_MAS(1), delivery_type: 'route', ...extra,
      }).returning('id');
      ids[k] = o.id;
      await trx('commercial.order_lines').insert(prods.map((p, i) => ({
        tenant_id: M, order_id: o.id, product_id: p, line_number: i + 1, quantity: 1, unit_price: 1, line_subtotal: 1, line_tax: 0, line_total: 1,
      })));
    };
    await pedido('A', 'IT27-10458', lupita, ids['yo'], 'confirmed', 1843.5, [payaso.id, mazapan.id]);
    await pedido('C', 'IT27-10301', trebol, ids['yo'], 'cancelled', 640, [mazapan.id]);
    await pedido('R', 'IT27-10472', lupita, ids['equipo'], 'confirmed', 780, [payaso.id]);
    await pedido('X', 'IT27-10999', lupita, ids['otro'], 'confirmed', 99, [payaso.id]);
    // Un pedido en 2 sucursales: principal G1 (apunta a sí mismo) y su parte G2.
    await pedido('G1', 'IT27-20001', trebol, ids['yo'], 'confirmed', 500, [mazapan.id]);
    await trx('commercial.orders').where({ id: ids['G1'] }).update({ group_id: ids['G1'] });
    await pedido('G2', 'IT27-20002', trebol, ids['yo'], 'confirmed', 300, [payaso.id], { group_id: ids['G1'] });
    // Uno que el surtidor ya tomó.
    await pedido('S', 'IT27-30001', lupita, ids['yo'], 'confirmed', 120, [payaso.id]);
    await trx('commercial.presale_picks').insert({
      tenant_id: M, order_id: ids['S'], warehouse_id: w.id, started_by: ids['equipo'], started_by_name: 'SURTIDOR IT27', started_at: trx.fn.now(),
    });
    // ── De aquí en adelante, como la app ────────────────────────────────────────────────────────────
    await trx.raw('SET LOCAL ROLE app_runtime');
    sesion = ids['yo'];
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  // ─── MCP.28 ────────────────────────────────────────────────────────────────────────────────────────
  it('MCP.28 por cliente SIN acento y por producto: cada palabra en cualquier orden', async () => {
    expect(await buscar('trebol')).toEqual(['IT27-10301', 'IT27-20001', 'IT27-20002']);
    expect(await buscar('payaso lupita')).toEqual(['IT27-10458', 'IT27-10472', 'IT27-30001']);
  });

  it('MCP.28 trae CANCELADOS (la lista del día no) y el folio por pedazo', async () => {
    const r = await picking.sellerSearch('10301');
    expect(r.data.map((d) => [d.code, d.status])).toEqual([['IT27-10301', 'cancelled']]);
  });

  it('MCP.28 una palabra de 1–2 caracteres va COMPLETA: «27» no pega con el folio IT27-…', async () => {
    expect(await buscar('lupita 27')).toEqual([]);
    expect(await buscar('lupita it27')).toEqual(['IT27-10458', 'IT27-10472', 'IT27-30001']);
  });

  it('MCP.28 el supervisor ve también lo de su equipo, marcado como ajeno; lo de alguien de fuera NO', async () => {
    const r = await picking.sellerSearch('IT27-10');
    expect(r.includes_team).toBe(true);
    expect(r.data.map((d) => [d.code, d.is_mine]).sort()).toEqual([['IT27-10301', true], ['IT27-10458', true], ['IT27-10472', false]]);
    expect(r.data.find((d) => d.code === 'IT27-10472')?.seller_name).toBe('RUBEN IT MCP27');
  });

  it('MCP.28 NEGATIVA: alguien de fuera no ve los míos; menos de 2 letras es 400', async () => {
    sesion = ids['otro'];
    try {
      expect(await buscar('IT27')).toEqual(['IT27-10999']);
    } finally {
      sesion = ids['yo'];
    }
    expect(await status(() => picking.sellerSearch('a'))).toBe(400);
  });

  // ─── MCP.29 ────────────────────────────────────────────────────────────────────────────────────────
  it('MCP.29 sólo la fecha: se mueve SIN reabrir, deja su fila con las dos fechas y «Por qué cambió» lo dice', async () => {
    const antes = await diaDe(ids['A']);
    const nueva = HOY_MAS(4);
    expect(await status(() => guardar(ids['A'], nueva))).toBe(200);
    expect(await diaDe(ids['A'])).toBe(nueva);
    const h = await historia(ids['A']);
    expect(h.some((f) => f.to_status === 'draft')).toBe(false); // no se reabrió
    expect(h.at(-1)).toMatchObject({ from_status: 'confirmed', to_status: 'confirmed', dd: { from: antes, to: nueva } });
    const encontrado = (await picking.sellerSearch('10458')).data[0];
    expect(encontrado.requested_delivery_date).toBe(nueva);
    expect(encontrado.justifications?.map((j) => j.action)).toEqual(['rescheduled']);
  });

  it('MCP.29 un pedido en 2 sucursales se mueve ENTERO (las dos partes, cada una con su fila)', async () => {
    const nueva = HOY_MAS(6); // un día cualquiera; domingos incluidos (D5)
    expect(await status(() => guardar(ids['G2'], nueva))).toBe(200);
    expect([await diaDe(ids['G1']), await diaDe(ids['G2'])]).toEqual([nueva, nueva]);
    expect((await historia(ids['G1'])).at(-1)?.dd?.to).toBe(nueva);
  });

  it('MCP.29 NEGATIVA: al pasado, la misma fecha, sin motivo de «agregar» o ya en surtido NO se mueve, y nada se escribe', async () => {
    const antes = await diaDe(ids['A']);
    expect(await status(() => guardar(ids['A'], HOY_MAS(-1)))).toBe(400);
    expect(await status(() => guardar(ids['A'], antes))).toBe(400); // ya se entrega ese día
    expect(await status(() => pedidos.modificarAgendado(ids['A'], 'x', [], true, HOY_MAS(3)))).toBe(400); // con «Agregar»
    expect(await diaDe(ids['A'])).toBe(antes);
    const sAntes = await diaDe(ids['S']);
    expect(await status(() => guardar(ids['S'], HOY_MAS(5)))).toBe(409); // D1: el surtidor ya lo tomó
    expect(await diaDe(ids['S'])).toBe(sAntes);
    expect((await historia(ids['S'])).length).toBe(0);
  });

  it('MCP.29 NEGATIVA: el pedido de otro vendedor (aunque sea de mi equipo) no lo muevo yo', async () => {
    const antes = await diaDe(ids['R']);
    expect(await status(() => guardar(ids['R'], HOY_MAS(5)))).toBe(403);
    expect(await diaDe(ids['R'])).toBe(antes);
  });

  // ─── MCP.30 ────────────────────────────────────────────────────────────────────────────────────────
  it('MCP.30 la lista busca en TODO lo filtrado y `total` cuenta lo encontrado (no la página)', async () => {
    // «it27» acota a lo sembrado: la base local puede tener clientes reales que se llamen «Trébol».
    const r = await pedidos.list({ statuses: 'confirmed', q: 'trebol it27', pageSize: 1 });
    expect(r.total).toBe(2); // G1 y G2, aunque la página sea de 1
    expect(r.data).toHaveLength(1);
    const porProducto = await pedidos.list({ statuses: 'confirmed', q: 'mazapan rosa it27', pageSize: 50 });
    expect((porProducto.data as Array<{ code: string }>).map((d) => d.code).sort()).toEqual(['IT27-10458', 'IT27-20001']);
    // Sin `q`, la lista es la de siempre (cuenta también lo sembrado que no es del Trébol).
    expect((await pedidos.list({ statuses: 'confirmed', pageSize: 1 })).total).toBeGreaterThan(2);
  });
});
