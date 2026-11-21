import knexFactory, { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';

/**
 * `[P2.9 paso 4]` FEFO se alimenta en la UNIDAD BASE del producto (D4), contra Postgres REAL: la vista
 * `analytics.v_label_presentations` sobre `kepler_ods.kdii`/`kdpv_prod_util` sembrados en una plaza que no
 * existe (`90`), el trigger que rebalancea el lote `NA`, y los endpoints que ESCRIBEN con el payload de la
 * pantalla de Tienda (`POST /entries`, `PATCH /entries/:id`, `DELETE /entries/:id`) y de la hoja de Almacén
 * (`POST /:id/submit`). Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció
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
// 93 (unidades-captura) · 94–98 (expediente-dias) · 99 (resolve-code-kepler).
const PLAZA = '90';
const M = `PF${Date.now().toString(36)}`.toUpperCase();
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

  /** Los lotes de un producto en el almacén de prueba: `NA` y los fechados. */
  const lotes = async (p: string) => {
    const rows = await admin('commercial.stock_lots').where({ warehouse_id: wh, product_id: p }).select('lot_code', 'quantity');
    return Object.fromEntries(rows.map((r: any) => [r.lot_code, Number(r.quantity)]));
  };
  const total = async (p: string) => Number((await admin('commercial.stock').where({ warehouse_id: wh, product_id: p }).first())?.quantity);
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
    const n = await admin('kepler_ods.kdii').where({ sucursal: PLAZA }).count<{ n: string }[]>({ n: '*' });
    if (Number(n[0].n)) throw new Error(`kepler_ods.kdii ya tiene la plaza ${PLAZA}: esta prueba necesita esa plaza libre.`);
    if (await admin('commercial.warehouses').where({ code: PLAZA }).first())
      throw new Error(`La base ya tiene el almacén ${PLAZA}: esta prueba necesita ese código libre.`);

    [{ id: wh }] = await admin('commercial.warehouses').insert({ tenant_id: T, code: PLAZA, name: M, kind: 'central' }).returning('id');
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
    // Existencia: el trigger arma el lote NA con el total.
    await admin('commercial.stock').insert([
      { tenant_id: T, warehouse_id: wh, product_id: prod.A, quantity: 1000, reserved_quantity: 0 },
      { tenant_id: T, warehouse_id: wh, product_id: prod.B, quantity: 30, reserved_quantity: 0 },
      { tenant_id: T, warehouse_id: wh, product_id: prod.C, quantity: 50, reserved_quantity: 0 },
      // D con existencia a propósito: si no fecha, el motivo no puede ser «no hay existencia sin fecha».
      { tenant_id: T, warehouse_id: wh, product_id: prod.D, quantity: 50, reserved_quantity: 0 },
    ]);
    expect(await lotes(prod.A)).toEqual({ NA: 1000 });
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
    expect(await lotes(prod.A)).toMatchObject({ NA: 928, 'EXP-2027-01-10': 72 });
    expect(await total(prod.A)).toBe(1000); // reclasificación: el total no se mueve
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
    expect(await lotes(prod.B)).toEqual({ NA: 30 });
  });

  it('el kilo de un producto de bolsa de 500 g fecha 2 bolsas por kilo', async () => {
    const e = await alta(prod.B, 'kg', 2, '2027-01-14');
    const l = await renglon(e.id);
    expect([Number(l.fefo_base_qty), Number(l.fefo_factor), Number(l.fefo_qty)]).toEqual([4, 2, 2]);
    expect(await lotes(prod.B)).toMatchObject({ NA: 26, 'EXP-2027-01-14': 4 });
  });

  it('parcial: 20 kg son 40 bolsas, sólo hay 26 sin fecha → fecha 26 bolsas = 13 kg y lo dice', async () => {
    const e = await alta(prod.B, 'kg', 20, '2027-01-15');
    const l = await renglon(e.id);
    expect(l.fed_to_fefo).toBe(true);
    expect(Number(l.fefo_base_qty)).toBe(26);
    expect(Number(l.fefo_qty)).toBe(13);
    expect(l.fefo_motivo).toBe('existencia_sin_fecha_insuficiente');
    expect((await lotes(prod.B)).NA).toBe(0);
  });

  it('sin presentaciones en la plaza: no fecha y dice por qué (ni sin unidad)', async () => {
    expect((await renglon((await alta(prod.C, 'caja', 1, '2027-01-16')).id)).fefo_motivo).toBe('sin_presentaciones');
    expect((await renglon((await alta(prod.A, null, 1, '2027-01-17')).id)).fefo_motivo).toBe('sin_unidad');
    expect(await lotes(prod.C)).toEqual({ NA: 50 });
  });

  it('⛔ NEGATIVA (AUD-DAT.32) — producto sin clave de Kepler: no fecha aunque haya existencia, y lo dice', async () => {
    const e = await alta(prod.D, 'paquete', 16, '2026-12-16'); // el renglón de la foto de tienda
    const l = await renglon(e.id);
    expect(l.fed_to_fefo).toBe(false);
    expect(l.fefo_motivo).toBe('sin_clave_kepler');
    // gana sobre los motivos de unidad: ninguna unidad lo arregla
    expect((await renglon((await alta(prod.D, null, 1, '2026-12-17')).id)).fefo_motivo).toBe('sin_clave_kepler');
    expect(await lotes(prod.D)).toEqual({ NA: 50 });
  });

  it('⭐ corregir una alta revierte lo movido EN LA BASE y vuelve a fechar con la cantidad nueva', async () => {
    const e = await alta(prod.A, 'caja', 2, '2027-02-01');
    expect((await lotes(prod.A))['EXP-2027-02-01']).toBe(48);
    const na = (await lotes(prod.A)).NA;
    await svc.updateEntry(e.id, { quantity: 1 } as never);
    const l = await renglon(e.id);
    expect([Number(l.fefo_base_qty), Number(l.fefo_qty)]).toEqual([24, 1]);
    expect(await lotes(prod.A)).toMatchObject({ NA: na + 24, 'EXP-2027-02-01': 24 });
    // y cambiar a una unidad sin factor devuelve todo y deja el motivo
    await svc.updateEntry(e.id, { unit: 'pieza' } as never);
    expect((await renglon(e.id)).fefo_motivo).toBe('unidad_sin_factor');
    expect(await lotes(prod.A)).toMatchObject({ NA: na + 48, 'EXP-2027-02-01': 0 });
    expect(await total(prod.A)).toBe(1000);
  });

  it('⛔ NEGATIVA — un renglón fechado ANTES del paso 4 (sin fefo_base_qty) se revierte con lo que movió, no × factor', async () => {
    // Así quedaron 47 renglones en prod: 7 «cajas» que movieron 7 paquetes.
    const hoja = await admin('commercial.expiry_reviews').where({ warehouse_id: wh, created_by: USER, status: 'submitted' }).first();
    const [{ id }] = await admin('commercial.expiry_review_lines').insert({
      tenant_id: T, review_id: hoja.id, product_id: prod.A, quantity: 7, unit: 'caja', expiry_date: '2027-03-03',
      fed_to_fefo: true, fefo_qty: 7, created_by: USER,
    }).returning('id');
    const na = (await lotes(prod.A)).NA;
    await admin('commercial.stock_lots').insert({ tenant_id: T, warehouse_id: wh, product_id: prod.A, lot_code: 'EXP-2027-03-03', expiry_date: '2027-03-03', quantity: 7, reserved_quantity: 0 });
    await admin('commercial.stock_lots').where({ warehouse_id: wh, product_id: prod.A, lot_code: 'NA' }).update({ quantity: na - 7 });

    await svc.deleteEntry(id);
    expect(await lotes(prod.A)).toMatchObject({ NA: na, 'EXP-2027-03-03': 0 });
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

  it('el invariante SUM(lotes) = existencia se sostiene al final', async () => {
    for (const p of [prod.A, prod.B, prod.C, prod.D]) {
      const suma = Object.values(await lotes(p)).reduce((a, b) => a + b, 0);
      expect(suma).toBe(await total(p));
    }
  });

  it('⛔ NEGATIVA — la base rechaza un motivo fuera de la lista (CHECK)', async () => {
    const hoja = await admin('commercial.expiry_reviews').where({ warehouse_id: wh }).first();
    await expect(
      admin('commercial.expiry_review_lines').insert({ tenant_id: T, review_id: hoja.id, product_name_raw: 'x', quantity: 1, fefo_motivo: 'porque_si' }),
    ).rejects.toThrow(/commercial_expiry_review_lines_fefo_motivo_chk/);
  });
});
