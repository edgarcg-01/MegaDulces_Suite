import knexFactory, { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';

/**
 * `[P2.9 paso 4]` FEFO se alimenta en la UNIDAD BASE del producto (D4), contra Postgres REAL: la vista
 * `analytics.v_label_presentations` sobre `kepler_ods.kdii`/`kdpv_prod_util` sembrados en una plaza que no
 * existe (`72`), la existencia de Kepler sembrada en `kepler_ods.kdil` (`[CANON.7.4c]`: lo libre = existencia de
 * `analytics.v_erp_stock_on_hand` − lo ya declarado; el `NA` ya no se mueve), y los endpoints que ESCRIBEN con el
 * payload de la pantalla de Tienda (`POST /entries`, `PATCH /entries/:id`, `DELETE /entries/:id`) y de la hoja de
 * Almacén (`POST /:id/submit`). Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció
 * contra base real.
 *
 *     CADUCIDADES_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5442/postgres_platform \
 *     CADUCIDADES_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5442/postgres_platform \
 *       npx vitest run --config libs/commercial/vitest.config.ts \
 *       src/lib/commercial-expiry-reviews/fefo-unidad-base.servicio-real.spec.ts
 *
 * Requiere la migración 20261120172724 aplicada. La URL admin sólo siembra y limpia.
 * ⚠️ Sin las dos variables se SALTA y lo dice. Nunca contra prod.
 */
const URL = process.env.CADUCIDADES_TEST_DB_URL;
const ADMIN = process.env.CADUCIDADES_TEST_ADMIN_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
// Propio de este archivo: vitest corre todos a la vez. Ocupados: 86/87 (unidades-producto) · 89 (box-labels) ·
// 90 (lotes-declarados, CANON.7.4c) · 93 (unidades-captura) · 94–98 (expediente-dias) · 99 (resolve-code-kepler).
// Era `90` hasta que `lotes-declarados` lo tomó (2026-11-20); `72` no lo usa ninguna prueba (`git grep "'72'"`).
const PLAZA = '72';
const M =`PF${Date.now().toString(36)}`.toUpperCase();
const USER = '00000000-0000-4000-8000-0000000092f4'; // quien captura: la corrección exige que sea suya y de hoy

if (!URL || !ADMIN) {
  // eslint-disable-next-line no-console
  console.warn('[P2.9 paso 4] NO MEDIDO: faltan CADUCIDADES_TEST_DB_URL y/o CADUCIDADES_TEST_ADMIN_URL.');
}

describe.skipIf(!URL || !ADMIN)('[P2.9 paso 4] FEFO en la unidad base del producto (Postgres real)', () => {
  let knex: Knex;
  let admin: Knex;
  let svc: CommercialExpiryReviewsService;
  let wh = '';
  let brand = '';
  const prod: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' };

  /** Los lotes de un producto en el almacén de prueba (los declarados; el `NA` ya no se guarda). */
  const lotes = async (p: string): Promise<Record<string, number>> => {
    const rows: Array<{ lot_code: string; quantity: string }> = await admin('commercial.stock_lots')
      .where({ warehouse_id: wh, product_id: p })
      .select('lot_code', 'quantity');
    return Object.fromEntries(rows.map((r) => [r.lot_code, Number(r.quantity)]));
  };
  /** La existencia de Kepler (la de `kdil`, por la vista que lee `lotes-declarados`). */
  const existencia = async (p: string) =>
    Number((await admin('analytics.v_erp_stock_on_hand').where({ warehouse_id: wh, product_id: p }).sum({ q: 'qty_stock_units' }))[0]?.q ?? 0);
  const declarado = async (p: string) => Object.values(await lotes(p)).filter((q) => q > 0).reduce((a, b) => a + b, 0);
  const libre = async (p: string) => Math.max((await existencia(p)) - (await declarado(p)), 0);
  const renglon = async (id: string) => admin('commercial.expiry_review_lines').where({ id }).first();
  /** El payload de la pantalla de Tienda. */
  const alta = (p: string, unit: string | null, quantity: number, expiry_date: string) =>
    svc.createEntry({ warehouse_id: wh, product_id: p, quantity, unit, expiry_date, condition: 'bueno', location: 'Anaquel 1' } as never);

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    admin = knexFactory({ client: 'pg', connection: ADMIN as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: USER, username: 'prueba-p4' }) } as unknown as TenantContextService;
    const scope = { current: async () => ({ dims: { warehouse: { modeWrite: 'all' } } }) } as unknown as ScopeService;
    const storage = { signFiles: async (f: unknown[]) => f } as never;
    svc = new CommercialExpiryReviewsService(new TenantKnexService(knex, ctx), ctx, {} as never, storage, scope);

    const [{ s }] = (await admin.raw('SELECT system_identifier::text s FROM pg_control_system()')).rows;
    if (s === '7688376744939610156') throw new Error('⛔ ESTA ES LA BASE DE PRODUCCIÓN.');
    for (const t of ['kepler_ods.kdii', 'kepler_ods.kdil']) {
      const n = await admin(t).where({ sucursal: PLAZA }).count<{ n: string }[]>({ n: '*' });
      if (Number(n[0].n)) throw new Error(`${t} ya tiene la plaza ${PLAZA}: esta prueba necesita esa plaza libre.`);
    }
    if (await admin('commercial.warehouses').where({ code: PLAZA }).orWhere({ kepler_code: PLAZA }).first())
      throw new Error(`La base ya tiene un almacén ${PLAZA}: esta prueba necesita ese código libre.`);

    // `code` da la plaza de las presentaciones; `kepler_code`, la existencia (`v_erp_stock_on_hand`). Como en prod, iguales.
    [{ id: wh }] = await admin('commercial.warehouses').insert({ tenant_id: T, code: PLAZA, kepler_code: PLAZA, name: M, kind: 'central' }).returning('id');
    [{ id: brand }] = await admin('catalog.brands').insert({ tenant_id: T, nombre: M }).returning('id');
    for (const k of ['A', 'B', 'C'] as const) {
      const [{ id }] = await admin('catalog.products')
        .insert({ tenant_id: T, brand_id: brand, sku: `${M}${k}`, nombre: `PRUEBA P2.9 paso 4 ${k}` })
        .returning('id');
      prod[k] = id;
    }
    // D — AUD-DAT.32: un producto del catálogo SIN sku de Kepler (como las altas de mayo para las promotoras).
    [{ id: prod.D }] = await admin('catalog.products')
      .insert({ tenant_id: T, brand_id: brand, sku: null, nombre: `PRUEBA P2.9 paso 4 D sin clave ${M}` })
      .returning('id');
    await admin('kepler_ods.kdii').insert([
      // A — el caso de prod (99734): base PAQ, ranura CJA de 24; en la escalera, PZA sin factor
      { sucursal: PLAZA, c1: `${M}A`, c2: 'PRUEBA PAQ', c11: 'PAQ', c90: 34, c80: 'CJA', c81: 24, c91: 750 },
      // B — bolsa de 500 g con ranura KG (2 bolsas = 1 kg)
      { sucursal: PLAZA, c1: `${M}B`, c2: 'PRUEBA 500 G', c11: '500', c90: 30, c80: 'KG', c81: 2, c91: 58 },
      // C — sin presentaciones en la plaza
    ]);
    await admin('kepler_ods.kdpv_prod_util').insert({ sucursal: PLAZA, c1: `${M}A`, c2: 'PZA', c3: 1, c4: 6, c7: 1.5 });
    // Existencia de Kepler, en la unidad BASE (`c4 + c8 − c9`), como la siembra `lotes-declarados.it.spec.ts`.
    // D no puede tener: sin sku no hay renglón de Kepler que ligar (es justo el problema de AUD-DAT.32).
    for (const [k, q] of [['A', 1000], ['B', 30], ['C', 50]] as const) {
      await admin.raw(
        `INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9, c6, c7) VALUES (?, ?, 0, ?, ?, 0, 0, now(), now())`,
        [PLAZA, PLAZA, `${M}${k}`, q],
      );
    }
    expect([await existencia(prod.A), await existencia(prod.B), await existencia(prod.C), await existencia(prod.D)]).toEqual([1000, 30, 50, 0]);
    expect(await lotes(prod.A)).toEqual({});
  });

  afterAll(async () => {
    if (admin) {
      if (wh) {
        const sheets = await admin('commercial.expiry_reviews').where({ warehouse_id: wh }).pluck('id');
        if (sheets.length) await admin('commercial.expiry_review_lines').whereIn('review_id', sheets).del();
        await admin('commercial.expiry_reviews').where({ warehouse_id: wh }).del();
        await admin('commercial.expiry_folio_sequences').where({ warehouse_code: PLAZA }).del();
        await admin('commercial.stock_lots').where({ warehouse_id: wh }).del();
        await admin('commercial.stock').where({ warehouse_id: wh }).del();
        await admin('commercial.warehouses').where({ id: wh }).del();
      }
      await admin('kepler_ods.kdil').where({ sucursal: PLAZA }).andWhere('c3', 'like', `${M}%`).del();
      await admin('kepler_ods.kdpv_prod_util').where('c1', 'like', `${M}%`).del();
      await admin('kepler_ods.kdii').where('c1', 'like', `${M}%`).del();
      await admin('catalog.products').where('sku', 'like', `${M}%`).del();
      if (prod.D) await admin('catalog.products').where({ id: prod.D }).del();
      if (brand) await admin('catalog.brands').where({ id: brand }).del();
    }
    await knex?.destroy();
    await admin?.destroy();
  });

  it('⭐ 3 cajas de 24 paquetes fechan 72 paquetes (hasta el paso 4 fechaban 3)', async () => {
    const e = await alta(prod.A, 'caja', 3, '2027-01-10');
    const l = await renglon(e.id);
    expect(l.fed_to_fefo).toBe(true);
    expect(Number(l.fefo_base_qty)).toBe(72);
    expect(Number(l.fefo_factor)).toBe(24);
    expect(Number(l.fefo_qty)).toBe(3); // en la unidad capturada: la hoja dice «3 cajas»
    expect(l.fefo_motivo).toBeNull();
    expect(await lotes(prod.A)).toEqual({ 'EXP-2027-01-10': 72 }); // `[CANON.7.4c]` ni se crea ni se toca un NA
    expect(await libre(prod.A)).toBe(928);
    expect(await existencia(prod.A)).toBe(1000); // declarar no mueve la existencia de Kepler
  });

  it('la unidad base vale 1: 5 paquetes fechan 5', async () => {
    const e = await alta(prod.A, 'paquete', 5, '2027-01-11');
    const l = await renglon(e.id);
    expect([Number(l.fefo_base_qty), Number(l.fefo_factor), Number(l.fefo_qty)]).toEqual([5, 1, 5]);
    expect((await lotes(prod.A))['EXP-2027-01-11']).toBe(5);
  });

  it('⛔ NEGATIVA — la pieza de la escalera NO tiene factor: no fecha nada y dice por qué', async () => {
    const antes = await lotes(prod.A);
    const e = await alta(prod.A, 'pieza', 2, '2027-01-12');
    const l = await renglon(e.id);
    expect(l.fed_to_fefo).toBe(false);
    expect(Number(l.fefo_qty)).toBe(0);
    expect(l.fefo_base_qty).toBeNull();
    expect(l.fefo_motivo).toBe('unidad_sin_factor');
    expect(await lotes(prod.A)).toEqual(antes);
  });

  it('⛔ NEGATIVA — una unidad que el producto no tiene en Kepler no se fecha como si fuera la base', async () => {
    const e = await alta(prod.B, 'pieza', 6, '2027-01-13');
    expect((await renglon(e.id)).fefo_motivo).toBe('unidad_fuera_del_producto');
    expect(await lotes(prod.B)).toEqual({});
  });

  it('el kilo de un producto de bolsa de 500 g fecha 2 bolsas por kilo', async () => {
    const e = await alta(prod.B, 'kg', 2, '2027-01-14');
    const l = await renglon(e.id);
    expect([Number(l.fefo_base_qty), Number(l.fefo_factor), Number(l.fefo_qty)]).toEqual([4, 2, 2]);
    expect(await lotes(prod.B)).toEqual({ 'EXP-2027-01-14': 4 });
    expect(await libre(prod.B)).toBe(26);
  });

  it('parcial: 20 kg son 40 bolsas, sólo quedan 26 libres → fecha 26 bolsas = 13 kg y lo dice', async () => {
    const e = await alta(prod.B, 'kg', 20, '2027-01-15');
    const l = await renglon(e.id);
    expect(l.fed_to_fefo).toBe(true);
    expect(Number(l.fefo_base_qty)).toBe(26);
    expect(Number(l.fefo_qty)).toBe(13);
    expect(l.fefo_motivo).toBe('existencia_sin_fecha_insuficiente');
    expect(await libre(prod.B)).toBe(0);
  });

  it('sin presentaciones en la plaza: no fecha y dice por qué (ni sin unidad)', async () => {
    expect((await renglon((await alta(prod.C, 'caja', 1, '2027-01-16')).id)).fefo_motivo).toBe('sin_presentaciones');
    expect((await renglon((await alta(prod.A, null, 1, '2027-01-17')).id)).fefo_motivo).toBe('sin_unidad');
    expect(await lotes(prod.C)).toEqual({});
  });

  it('⛔ NEGATIVA (AUD-DAT.32) — producto sin clave de Kepler: no fecha, y el motivo es ése, no el de presentaciones', async () => {
    const e = await alta(prod.D, 'paquete', 16, '2026-12-16'); // el renglón de la foto de tienda
    const l = await renglon(e.id);
    expect(l.fed_to_fefo).toBe(false);
    // Sin este motivo diría `sin_presentaciones` («Kepler no publica las presentaciones…»): tampoco es cierto.
    expect(l.fefo_motivo).toBe('sin_clave_kepler');
    // gana sobre los motivos de unidad: ninguna unidad lo arregla
    expect((await renglon((await alta(prod.D, null, 1, '2026-12-17')).id)).fefo_motivo).toBe('sin_clave_kepler');
    expect(await lotes(prod.D)).toEqual({});
  });

  it('⭐ corregir una alta retira lo declarado EN LA BASE y vuelve a fechar con la cantidad nueva', async () => {
    const e = await alta(prod.A, 'caja', 2, '2027-02-01');
    expect((await lotes(prod.A))['EXP-2027-02-01']).toBe(48);
    const libreAntes = await libre(prod.A);
    await svc.updateEntry(e.id, { quantity: 1 } as never);
    const l = await renglon(e.id);
    expect([Number(l.fefo_base_qty), Number(l.fefo_qty)]).toEqual([24, 1]);
    expect((await lotes(prod.A))['EXP-2027-02-01']).toBe(24);
    expect(await libre(prod.A)).toBe(libreAntes + 24);
    // y cambiar a una unidad sin factor retira todo y deja el motivo
    await svc.updateEntry(e.id, { unit: 'pieza' } as never);
    expect((await renglon(e.id)).fefo_motivo).toBe('unidad_sin_factor');
    expect((await lotes(prod.A))['EXP-2027-02-01']).toBe(0);
    expect(await libre(prod.A)).toBe(libreAntes + 48);
  });

  it('⛔ NEGATIVA — un renglón fechado ANTES del paso 4 (sin fefo_base_qty) se retira con lo que declaró, no × factor', async () => {
    // Así quedaron 47 renglones en prod: 7 «cajas» que declararon 7 paquetes.
    const hoja = await admin('commercial.expiry_reviews').where({ warehouse_id: wh, created_by: USER, status: 'submitted' }).first();
    const [{ id }] = await admin('commercial.expiry_review_lines').insert({
      tenant_id: T, review_id: hoja.id, product_id: prod.A, quantity: 7, unit: 'caja', expiry_date: '2027-03-03',
      fed_to_fefo: true, fefo_qty: 7, created_by: USER,
    }).returning('id');
    await admin('commercial.stock_lots').insert({ tenant_id: T, warehouse_id: wh, product_id: prod.A, lot_code: 'EXP-2027-03-03', expiry_date: '2027-03-03', quantity: 7, reserved_quantity: 0 });
    const libreAntes = await libre(prod.A);

    await svc.deleteEntry(id); // × 24 serían 168: el lote sólo tiene 7 y respondería 409
    expect((await lotes(prod.A))['EXP-2027-03-03']).toBe(0);
    expect(await libre(prod.A)).toBe(libreAntes + 7);
  });

  it('⭐ la hoja de Almacén: enviar fecha en la base y deja dicho lo que no fechó', async () => {
    const r = await svc.createReview({ warehouse_id: wh });
    const caja = await svc.addLine(r.id, { product_id: prod.A, quantity: 2, unit: 'caja', expiry_date: '2027-04-04' } as never);
    const pieza = await svc.addLine(r.id, { product_id: prod.A, quantity: 1, unit: 'pieza', expiry_date: '2027-04-04' } as never);
    const res = await svc.submitReview(r.id);
    expect(res.fed_lines).toBe(1);
    expect(Number((await renglon(caja.id)).fefo_base_qty)).toBe(48);
    expect((await renglon(pieza.id)).fefo_motivo).toBe('unidad_sin_factor');
    expect((await lotes(prod.A))['EXP-2027-04-04']).toBe(48);
  });

  it('al final: lo declarado nunca pasa de la existencia de Kepler, cuadra con los renglones, y no hay NA', async () => {
    for (const p of [prod.A, prod.B, prod.C, prod.D]) {
      expect(await declarado(p)).toBeLessThanOrEqual(await existencia(p));
      expect((await lotes(p)).NA).toBeUndefined();
      // lo que dicen los renglones fechados (en la base) = lo que hay en los lotes
      const r = await admin('commercial.expiry_review_lines as l')
        .join('commercial.expiry_reviews as v', 'v.id', 'l.review_id')
        .where({ 'v.warehouse_id': wh, 'l.product_id': p, 'l.fed_to_fefo': true })
        .sum({ q: 'l.fefo_base_qty' });
      expect(Number(r[0]?.q ?? 0)).toBe(await declarado(p));
    }
  });

  it('⛔ NEGATIVA — la base rechaza un motivo fuera de la lista (CHECK)', async () => {
    const hoja = await admin('commercial.expiry_reviews').where({ warehouse_id: wh }).first();
    await expect(
      admin('commercial.expiry_review_lines').insert({ tenant_id: T, review_id: hoja.id, product_name_raw: 'x', quantity: 1, fefo_motivo: 'porque_si' }),
    ).rejects.toThrow(/commercial_expiry_review_lines_fefo_motivo_chk/);
  });
});
