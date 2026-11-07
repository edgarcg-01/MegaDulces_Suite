import knexFactory, { Knex } from 'knex';
import { BadRequestException } from '@nestjs/common';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';

/**
 * `[P2.9 paso 3]` `GET products/:sku/unidades` (`unidadesProducto`) contra Postgres REAL: la vista
 * `analytics.v_label_presentations` de verdad, sobre filas de `kepler_ods.kdii` y
 * `kepler_ods.kdpv_prod_util` sembradas en plazas que no existen (`94`, `91`). Lo que un doble no ve:
 * que la vista traiga la base, las ranuras y la escalera, y en qué plaza.
 *
 *     CADUCIDADES_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5442/postgres_platform \
 *     CADUCIDADES_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5442/postgres_platform \
 *       npx vitest run --config libs/commercial/vitest.config.ts \
 *       libs/commercial/src/lib/commercial-expiry-reviews/unidades-producto.servicio-real.spec.ts
 *
 * La URL admin sólo siembra y limpia. ⚠️ Sin las dos variables se SALTA y lo dice. Nunca contra prod.
 */
const URL = process.env.CADUCIDADES_TEST_DB_URL;
const ADMIN = process.env.CADUCIDADES_TEST_ADMIN_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
// Plaza y almacén que no existen en una base real de sucursales. No `93`: ése lo usa
// `unidades-captura.servicio-real.spec.ts`, y vitest corre las dos a la vez.
const PLAZA = '94';
const OTRA = '91'; // ordena ANTES que la del almacén: «la primera» no puede ganar por casualidad
const M = `PU${Date.now().toString(36)}`.toUpperCase();

if (!URL || !ADMIN) {
  // eslint-disable-next-line no-console
  console.warn('[P2.9 paso 3] NO MEDIDO: faltan CADUCIDADES_TEST_DB_URL y/o CADUCIDADES_TEST_ADMIN_URL.');
}

describe.skipIf(!URL || !ADMIN)('[P2.9 paso 3] unidadesProducto lee las presentaciones de Kepler (Postgres real)', () => {
  let knex: Knex;
  let admin: Knex;
  let svc: CommercialExpiryReviewsService;
  let wh = '';

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    admin = knexFactory({ client: 'pg', connection: ADMIN as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba' }) } as unknown as TenantContextService;
    svc = new CommercialExpiryReviewsService(new TenantKnexService(knex, ctx), ctx, {} as never, {} as never, {} as unknown as ScopeService);

    for (const p of [PLAZA, OTRA]) {
      const n = await admin('kepler_ods.kdii').where({ sucursal: p }).count<{ n: string }[]>({ n: '*' });
      if (Number(n[0].n)) throw new Error(`kepler_ods.kdii ya tiene la plaza ${p}: esta prueba necesita esa plaza libre.`);
    }
    const ocupado = await admin('commercial.warehouses').where({ code: PLAZA }).first();
    if (ocupado) throw new Error(`La base ya tiene el almacén ${PLAZA}: esta prueba necesita ese código libre.`);
    const [w] = await admin('commercial.warehouses').insert({ tenant_id: T, code: PLAZA, name: M, kind: 'central' }).returning('id');
    wh = w.id;

    await admin('kepler_ods.kdii').insert([
      // base PAQ con ranura CJA de 12
      { sucursal: PLAZA, c1: `${M}A`, c2: 'PRUEBA PAQ', c11: 'PAQ', c90: 10, c80: 'CJA', c81: 12, c91: 100 },
      // base bolsa de 500 g con ranura KG (2 bolsas = 1 kg)
      { sucursal: PLAZA, c1: `${M}B`, c2: 'PRUEBA 500 G', c11: '500', c90: 20, c80: 'KG', c81: 2, c91: 38 },
      // sólo en OTRA plaza
      { sucursal: OTRA, c1: `${M}C`, c2: 'PRUEBA PZA', c11: 'PZA', c90: 5 },
      // base fuera de las 7
      { sucursal: PLAZA, c1: `${M}D`, c2: 'PRUEBA CUBETA', c11: 'CUB', c90: 50 },
      // el MISMO sku en dos plazas con base distinta: manda la del almacén
      { sucursal: OTRA, c1: `${M}E`, c2: 'PRUEBA DOS PLAZAS', c11: 'PZA', c90: 3 },
      { sucursal: PLAZA, c1: `${M}E`, c2: 'PRUEBA DOS PLAZAS', c11: 'PAQ', c90: 30 },
    ]);
    // escalera: PZA con peldaño de mayoreo para el producto A (no está en kdii)
    await admin('kepler_ods.kdpv_prod_util').insert({ sucursal: PLAZA, c1: `${M}A`, c2: 'PZA', c3: 1, c4: 6, c7: 1.5 });
  });

  afterAll(async () => {
    if (admin) {
      await admin('kepler_ods.kdpv_prod_util').where('c1', 'like', `${M}%`).del();
      await admin('kepler_ods.kdii').where('c1', 'like', `${M}%`).del();
      if (wh) await admin('commercial.warehouses').where({ id: wh }).del();
    }
    await knex?.destroy();
    await admin?.destroy();
  });

  it('⭐ base PAQ + ranura CJA + escalera PZA → pieza · paquete · caja, base paquete, la escalera SIN factor', async () => {
    const r = await svc.unidadesProducto(`${M}A`, wh);
    expect(r).toMatchObject({ plaza: PLAZA, otra_plaza: false, base: 'paquete', motivo: 'ok', fuera_de_las_7: [] });
    expect(r.unidades).toEqual([
      { codigo: 'pieza', kepler: 'PZA', factor: null, base: false },
      { codigo: 'paquete', kepler: 'PAQ', factor: 1, base: true },
      { codigo: 'caja', kepler: 'CJA', factor: 12, base: false },
    ]);
  });

  it('⭐ el criterio del plan: base 500 con ranura KG devuelve «g500» y «kg»', async () => {
    const r = await svc.unidadesProducto(`${M}B`, wh);
    expect(r.unidades?.map((u) => u.codigo)).toEqual(['kg', 'g500']);
    expect(r.base).toBe('g500');
  });

  it('la plaza del almacén no lo publica → toma la que sí y lo DICE (otra_plaza)', async () => {
    const r = await svc.unidadesProducto(`${M}C`, wh);
    expect(r).toMatchObject({ plaza: OTRA, otra_plaza: true, base: 'pieza', motivo: 'ok' });
  });

  it('⭐ el mismo SKU en dos plazas: manda la plaza del almacén (94 = paquete), no la primera (91 = pieza)', async () => {
    const r = await svc.unidadesProducto(`${M}E`, wh);
    expect(r).toMatchObject({ plaza: PLAZA, otra_plaza: false, base: 'paquete' });
    expect(r.unidades?.map((u) => u.codigo)).toEqual(['paquete']);
  });

  it('base fuera de las 7 (CUB) → unidades null y el rótulo declarado, no traducido', async () => {
    const r = await svc.unidadesProducto(`${M}D`, wh);
    expect(r).toMatchObject({ unidades: null, base: null, fuera_de_las_7: ['CUB'], motivo: 'ok' });
  });

  it('⛔ NEGATIVA — un SKU que Kepler no publica: null con su motivo, nunca una lista vacía', async () => {
    const r = await svc.unidadesProducto(`${M}Z`, wh);
    expect(r).toMatchObject({ unidades: null, plaza: null, motivo: 'sin_presentaciones' });
  });

  it('⛔ NEGATIVA — sku o warehouse_id malformados: 400', async () => {
    await expect(svc.unidadesProducto("1' OR '1'='1", wh)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.unidadesProducto(`${M}A`, 'no-es-uuid')).rejects.toBeInstanceOf(BadRequestException);
  });
});
