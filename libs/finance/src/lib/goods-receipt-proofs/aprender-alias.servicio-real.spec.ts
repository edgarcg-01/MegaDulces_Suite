import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';

/**
 * `[RE.53]` Aprender una equivalencia escribe en `commercial.supplier_item_aliases`: regla 13, el
 * camino que escribe no está probado sin una base REAL.
 *
 *     CAJA_TEST_DB_URL=<la URL de la base de prueba, como app_runtime> \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/goods-receipt-proofs/aprender-alias.servicio-real.spec.ts
 *
 * El caso que la trae: `created_by`/`updated_by` son `uuid` y RE.11.4 les pasaba el NOMBRE de la
 * persona — en prod la tabla tiene 0 filas desde que existe. La NEGATIVA de abajo reproduce ese
 * INSERT y tiene que fallar; si deja de fallar, la prueba ya no distingue el arreglo.
 *
 * ⚠️ Sin `CAJA_TEST_DB_URL` se SALTA y lo dice. Escribe y no deshace: sólo contra una base de
 *    prueba. Cada corrida usa su propio RFC.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = '00000000-0000-0000-0000-00000000d01c';
const RFC = `PRB${Date.now().toString(36).toUpperCase()}`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[RE.53] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual probar que la equivalencia se guarda.');
}

describe.skipIf(!URL)('[RE.53] aprender una equivalencia — base real', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: GoodsReceiptProofsService;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    // Sólo se ejercita el camino de la base; el resto de las dependencias no se toca.
    const nada = undefined as never;
    svc = new GoodsReceiptProofsService(tk, ctx, nada, nada, nada, nada, nada, nada);
  });
  afterAll(async () => { await knex?.destroy(); });

  it('NEGATIVA (el defecto de RE.11.4): un nombre en created_by uuid NO se puede insertar', async () => {
    await expect(tk.run((trx) => trx.raw(
      `INSERT INTO commercial.supplier_item_aliases (tenant_id, proveedor_rfc, descripcion_norm, sku, created_by)
       VALUES (public.current_tenant_id(), ?, 'negativa', 'X', ?)`, [RFC, 'Nombre De Persona']))).rejects.toThrow(/uuid/i);
  });

  it('el upsert del aprendizaje guarda y, al repetirse, refuerza en vez de duplicar', async () => {
    const a = { descripcion: 'RED COLA 24/400', sku: 'S400', nombre_interno: 'RED COLA 400ML AGA', unidad_proveedor: 'CJ', box_factor: 24 };
    type ConUpsert = { upsertAlias: (trx: Knex.Transaction, rfc: string, x: typeof a) => Promise<{ sku: string; veces_confirmado: number; confianza: string }> };
    const up = (x: typeof a) => tk.run((trx) => (svc as unknown as ConUpsert).upsertAlias(trx, RFC, x));

    const r1 = await up(a);
    expect(r1).toMatchObject({ sku: 'S400', veces_confirmado: 1 });
    const r2 = await up(a);
    expect(Number(r2.veces_confirmado)).toBe(2);
    expect(Number(r2.confianza)).toBeCloseTo(0.8, 5);

    const filas = await tk.run((trx) => trx('commercial.supplier_item_aliases')
      .where({ proveedor_rfc: RFC, descripcion_norm: 'red cola 24 400' }).whereNull('deleted_at')
      .select('sku', 'box_factor', 'unidad_proveedor', 'created_by', 'tenant_id'));
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ sku: 'S400', unidad_proveedor: 'CJ', created_by: null, tenant_id: T });
    expect(Number(filas[0].box_factor)).toBe(24);
  });

  it('el endpoint de confirmar (RE.11.4) ya guarda con el nombre de quien confirma', async () => {
    const r = await svc.confirmLineMatch({ proveedor_rfc: RFC, descripcion: 'SQUIRT 9/2.0', sku: 'Q2L', unidad_proveedor: 'cj', box_factor: 9 }, 'Nombre De Persona');
    expect(r).toMatchObject({ sku: 'Q2L', veces_confirmado: 1 });
  });
});
