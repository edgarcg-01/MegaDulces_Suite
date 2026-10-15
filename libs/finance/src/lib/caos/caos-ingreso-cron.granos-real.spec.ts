import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CaosIngresoCronService } from './caos-ingreso-cron.service';
import type { CaosIngresoReconService } from './caos-ingreso-recon.service';

/**
 * `[CGP-L.6]` El grano de cada depósito de CAOS, contra una base REAL y como `app_runtime`.
 *
 * `clasificarGranos()` escribía en `finance.caos_deposito_grano` —RLS FORZADO— con la conexión cruda,
 * sin fijar el tenant: la política rechaza la fila. Y el `catch` se lo tragaba con un `warn` y
 * devolvía 0, que el latido publicaba como «0 clasificados». Un carril que no escribe nada se veía
 * igual que uno sin trabajo.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caos/caos-ingreso-cron.granos-real.spec.ts
 *
 * Sin `CAJA_TEST_DB_URL` se salta y lo declara. Escribe y no deshace: sólo contra una base de prueba.
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-L.6] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer el grano de CAOS.');
}

describe.skipIf(!URL)('[CGP-L.6] el grano de los depósitos de CAOS se escribe con el tenant', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let cron: CaosIngresoCronService;

  beforeAll(() => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = new TenantContextService();
    tk = new TenantKnexService(knex, ctx);
    cron = new CaosIngresoCronService(knex, {} as CaosIngresoReconService, ctx, tk);
  });
  afterAll(async () => { await knex?.destroy(); });

  it('⛔ un depósito nuevo queda clasificado (antes: rechazado por RLS y tragado como «0»)', async () => {
    const ext = Date.now();
    await knex('analytics.caos_cash_movements').insert({
      tenant_id: T, device: 'CGP-L6', external_id: ext, type_id: 0, type_label: 'Depósito',
      occurred_at: '2026-10-13T01:00:00.000Z', total: 1000, ref: null, _row_hash: `cgp-l6-${ext}`,
    });

    const n = await (cron as unknown as { clasificarGranos(): Promise<number> }).clasificarGranos();
    expect(n).toBeGreaterThanOrEqual(1);

    const fila = await tk.run(T, (trx) => trx('finance.caos_deposito_grano')
      .where({ caos_device: 'CGP-L6', caos_external_id: ext }).first());
    expect(fila).toMatchObject({ tenant_id: T, grano: 'sin_declarar' });
  });

  it('⛔ correrlo otra vez no vuelve a elegir lo ya clasificado (antes: la lectura sin tenant veía la tabla vacía)', async () => {
    const ext = Date.now() + 1;
    await knex('analytics.caos_cash_movements').insert({
      tenant_id: T, device: 'CGP-L6', external_id: ext, type_id: 0, type_label: 'Depósito',
      occurred_at: '2026-10-12T18:00:00.000Z', total: 500, ref: null, _row_hash: `cgp-l6-${ext}`,
    });
    const clasificar = () => (cron as unknown as { clasificarGranos(): Promise<number> }).clasificarGranos();
    await clasificar();
    await expect(clasificar()).resolves.toBe(0);
    const n = await tk.run(T, (trx) => trx('finance.caos_deposito_grano')
      .where({ caos_device: 'CGP-L6', caos_external_id: ext }).count<{ n: string }[]>('* as n'));
    expect(Number(n[0].n)).toBe(1);
  });
});
