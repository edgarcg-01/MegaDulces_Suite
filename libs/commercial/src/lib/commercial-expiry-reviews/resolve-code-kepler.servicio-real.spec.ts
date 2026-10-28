import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';

/**
 * `resolveCode()` — un producto con VARIOS códigos de barras (SKU 31081: el 2º código estaba en
 * `kepler_ods.kdii` y todavía no en `catalog.product_barcodes`). El servicio REAL contra Postgres REAL.
 *
 *     CADUCIDADES_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5442/postgres_platform \
 *     CADUCIDADES_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5442/postgres_platform \
 *       npx vitest run --config libs/commercial/vitest.config.ts \
 *       libs/commercial/src/lib/commercial-expiry-reviews/resolve-code-kepler.servicio-real.spec.ts
 *
 * La URL admin SOLO siembra (`app_runtime` no puede escribir en `kepler_ods`); borra todo al terminar.
 * ⚠️ Sin las dos variables se SALTA y lo dice. Nunca contra prod.
 */
const URL = process.env.CADUCIDADES_TEST_DB_URL;
const ADMIN = process.env.CADUCIDADES_TEST_ADMIN_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const RUN = Date.now().toString().slice(-6);
const SKU = `9${RUN}`; // sku de prueba, sin ceros al frente
const COD_CATALOGO = `750999${RUN}`.slice(0, 13); // el que YA está en product_barcodes
const COD_SOLO_KEPLER = `751999${RUN}`.slice(0, 13); // c93: solo en Kepler
const COD_CAJA = `752999${RUN}`.slice(0, 13); // c82: unidad 2, factor 12
const COD_BASURA = `753999${RUN}`.slice(0, 13); // en ningún lado

if (!URL || !ADMIN) {
  // eslint-disable-next-line no-console
  console.warn('[resolveCode/kdii] NO MEDIDO: faltan CADUCIDADES_TEST_DB_URL y/o CADUCIDADES_TEST_ADMIN_URL.');
}

describe.skipIf(!URL || !ADMIN)('resolveCode(): el 2º código de un producto sale de Kepler si el catálogo aún no lo tiene', () => {
  let knex: Knex;
  let admin: Knex;
  let svc: CommercialExpiryReviewsService;
  let brandId: string | null = null;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    admin = knexFactory({ client: 'pg', connection: ADMIN as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba' }) } as unknown as TenantContextService;
    const tk = new TenantKnexService(knex, ctx);
    svc = new CommercialExpiryReviewsService(tk, ctx, {} as never, {} as never, {} as never);

    await admin.transaction(async (t) => {
      await t.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const [b] = await t('public.brands').insert({ tenant_id: T, nombre: `MARCA PRUEBA ${RUN}` }).returning('id');
      brandId = b.id;
      await t('public.products').insert({ tenant_id: T, sku: SKU, nombre: `PRUEBA KDII ${RUN}`, brand_id: brandId });
      await t('catalog.product_barcodes').insert({ tenant_id: T, sku: SKU, barcode: COD_CATALOGO, source: 'kepler_base', is_primary: true });
      await t('kepler_ods.kdii').insert({
        sucursal: '99', c1: SKU.padStart(5, '0'), c2: `PRUEBA KDII ${RUN}`,
        c7: COD_CATALOGO, c11: 'PZA', c93: COD_SOLO_KEPLER, c82: COD_CAJA, c80: 'CJA', c81: '12',
      });
    });
  });

  afterAll(async () => {
    await admin?.transaction(async (t) => {
      await t.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      await t('kepler_ods.kdii').where({ sucursal: '99', c1: SKU.padStart(5, '0') }).del();
      await t('catalog.product_barcodes').where({ sku: SKU }).del();
      await t('public.products').where({ sku: SKU }).del();
      if (brandId) await t('public.brands').where({ id: brandId }).del();
    });
    await knex?.destroy();
    await admin?.destroy();
  });

  it('el código que ya está en el catálogo sigue resolviendo por el catálogo', async () => {
    const r = await svc.resolveCode(COD_CATALOGO);
    expect(r.match?.sku).toBe(SKU);
    expect(r.source).toBe('barcode');
  });

  it('el 2º código (solo en kdii.c93) resuelve al MISMO producto', async () => {
    const r = await svc.resolveCode(COD_SOLO_KEPLER);
    expect(r.match?.sku).toBe(SKU);
    expect(r.source).toBe('barcode');
  });

  it('un código de unidad 2 (c82) trae su unidad y factor', async () => {
    const r = await svc.resolveCode(COD_CAJA);
    expect(r.match?.sku).toBe(SKU);
    expect(r.match?.scanned_unit).toBe('CJA');
    expect(r.match?.factor).toBe(12);
    expect(r.match?.unit_hint).toBe('caja');
  });

  it('un código que no está en ningún lado sigue sin lanzar: none', async () => {
    const r = await svc.resolveCode(COD_BASURA);
    expect(r.match).toBeNull();
    expect(r.source).toBe('none');
  });
});
