import knexFactory, { Knex } from 'knex';
import { BadRequestException } from '@nestjs/common';
import { CADUCIDAD_UNIDADES } from '@megadulces/contracts';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';

/**
 * `[P2.9 paso 2]` `POST /entries` (`createEntry`) con **cada una de las 7 unidades**, contra Postgres REAL y con el
 * payload que manda la pantalla de Tienda. Regla 13: un endpoint que escribe no está probado hasta que una
 * prueba lo ejerció contra base real. Lo que un doble de Knex no ve: el CHECK de la columna.
 *
 *     CADUCIDADES_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5442/postgres_platform \
 *     CADUCIDADES_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5442/postgres_platform \
 *       npx vitest run --config libs/commercial/vitest.config.ts \
 *       libs/commercial/src/lib/commercial-expiry-reviews/unidades-captura.servicio-real.spec.ts
 *
 * La URL admin sólo siembra y limpia el almacén de prueba. Requiere la migración 20261102123053 aplicada.
 * ⚠️ Sin las dos variables se SALTA y lo dice. Nunca contra prod.
 */
const URL = process.env.CADUCIDADES_TEST_DB_URL;
const ADMIN = process.env.CADUCIDADES_TEST_ADMIN_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const COD = '93'; // código de 2 dígitos que no existe en una base real de sucursales
const MARCA = `PRUEBA-UNIDADES-${Date.now().toString(36)}`;

if (!URL || !ADMIN) {
  // eslint-disable-next-line no-console
  console.warn('[P2.9 paso 2] NO MEDIDO: faltan CADUCIDADES_TEST_DB_URL y/o CADUCIDADES_TEST_ADMIN_URL.');
}

describe.skipIf(!URL || !ADMIN)('[P2.9 paso 2] createEntry guarda cada una de las 7 unidades (Postgres real)', () => {
  let knex: Knex;
  let admin: Knex;
  let svc: CommercialExpiryReviewsService;
  let wh = '';

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    admin = knexFactory({ client: 'pg', connection: ADMIN as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba' }) } as unknown as TenantContextService;
    const tk = new TenantKnexService(knex, ctx);
    const scope = { current: async () => ({ dims: { warehouse: { modeWrite: 'all' } } }) } as unknown as ScopeService;
    // Sin adjuntos en estas pruebas: firmar es devolver lo mismo.
    const storage = { signFiles: async (f: unknown[]) => f } as never;
    svc = new CommercialExpiryReviewsService(tk, ctx, {} as never, storage, scope);
    const ocupado = await admin('commercial.warehouses').where({ code: COD }).first();
    if (ocupado) throw new Error(`La base ya tiene el almacén ${COD}: esta prueba necesita ese código libre.`);
    const [w] = await admin('commercial.warehouses').insert({ tenant_id: T, code: COD, name: MARCA, kind: 'central' }).returning('id');
    wh = w.id;
  });

  afterAll(async () => {
    if (admin && wh) {
      const sheets = await admin('commercial.expiry_reviews').where({ warehouse_id: wh }).pluck('id');
      if (sheets.length) await admin('commercial.expiry_review_lines').whereIn('review_id', sheets).del();
      await admin('commercial.expiry_reviews').where({ warehouse_id: wh }).del();
      await admin('commercial.expiry_folio_sequences').where({ warehouse_code: COD }).del();
      await admin('commercial.warehouses').where({ id: wh }).del();
    }
    await knex?.destroy();
    await admin?.destroy();
  });

  /** El payload de la pantalla de Tienda, sin producto de catálogo (no alimenta FEFO: aquí se prueba la unidad). */
  const payload = (unit: string) => ({
    warehouse_id: wh, product_code_raw: `${MARCA}-${unit}`, product_name_raw: `Producto ${unit}`,
    quantity: 3, expiry_date: '2027-03-15', unit,
  });

  it.each(CADUCIDAD_UNIDADES.map((u) => [u]))('⭐ guarda «%s» y la lee igual', async (unit) => {
    await svc.createEntry(payload(unit) as never);
    const fila = await admin('commercial.expiry_review_lines').where({ product_code_raw: `${MARCA}-${unit}` }).first();
    expect(fila?.unit).toBe(unit);
  });

  it('⛔ NEGATIVA — una unidad fuera de las 7 la rechaza el servicio con 400', async () => {
    await expect(svc.createEntry(payload('cubeta') as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⛔ NEGATIVA — y si se saltara el servicio, la BASE también la rechaza (CHECK)', async () => {
    const sheet = await admin('commercial.expiry_reviews').where({ warehouse_id: wh }).first();
    await expect(
      admin('commercial.expiry_review_lines').insert({ tenant_id: T, review_id: sheet.id, product_name_raw: 'x', quantity: 1, unit: 'cubeta' }),
    ).rejects.toThrow(/commercial_expiry_review_lines_unit_chk/);
  });
});
