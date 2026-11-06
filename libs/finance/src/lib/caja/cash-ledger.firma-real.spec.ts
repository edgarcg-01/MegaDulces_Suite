import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CashLedgerService } from './cash-ledger.service';

/**
 * `[LE.6.22]` La firma de la cola contra una base REAL: un doble de Knex no ejecuta su SQL.
 *
 * El repaso de 20 s de Captura armaba la cola entera cada vez (15,590 pedidos y 449 min de
 * servidor en 14 días). Ahora pregunta con la firma de lo que tiene delante y, si no cambió, el
 * servidor no arma nada. Lo que tiene que ser cierto:
 *   · la misma cola da la misma firma (si no, el repaso recargaría siempre y no se ganó nada);
 *   · un movimiento nuevo del libro la cambia (si no, la pantalla se quedaría con la foto vieja);
 *   · con la firma vigente no viajan filas, y con una vieja viaja la bandeja con la firma nueva.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/caja_v \
 *       npx vitest run libs/finance/src/lib/caja/cash-ledger.firma-real.spec.ts
 *
 * ⚠️ Necesita `finance.v_caja_movimientos_pendientes`, que la base del job `caja-db` del CI no
 * crea: ahí se salta y lo declara. Escribe y no deshace: sólo contra una base de prueba.
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.6.22] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer la firma de la cola.');
}

describe.skipIf(!URL)('[LE.6.22] firma de la cola contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CashLedgerService;
  let hayVista = false;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CashLedgerService(tk, ctx);
    const r = await knex.raw(`SELECT to_regclass('finance.v_caja_movimientos_pendientes') IS NOT NULL AS ok`);
    hayVista = !!r.rows[0].ok;
    // eslint-disable-next-line no-console
    if (!hayVista) console.warn('[LE.6.22] NO MEDIDO: esta base no tiene finance.v_caja_movimientos_pendientes.');
  });
  afterAll(async () => { await knex?.destroy(); });

  it('la misma cola da la misma firma, y un movimiento nuevo del libro la cambia', async (c) => {
    if (!hayVista) c.skip();
    const q = { caja: '0011' };
    const a = await svc.firmaDeLaCola(q);
    const b = await svc.firmaDeLaCola(q);
    expect(a.firma).toBe(b.firma);
    expect(a.firma.split('#').length).toBeGreaterThanOrEqual(6);

    await tk.run((trx) => trx('finance.cash_ledger').insert({
      tenant_id: T, folio: `CGL-F22-${Date.now()}`, tipo: 'ingreso', fecha: '1985-06-02', sucursal: 'F22',
      kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'Movimiento de la prueba LE.6.22', monto: 10, created_by: CAJERA,
    }));
    expect((await svc.firmaDeLaCola(q)).firma).not.toBe(a.firma);
  });

  it('con la firma vigente no viajan filas; con una vieja viaja la bandeja con la firma nueva', async (c) => {
    if (!hayVista) c.skip();
    const q = { caja: '0011', limit: 5 };
    const { firma } = await svc.firmaDeLaCola(q);

    const igual = await svc.movimientosPendientesSiCambio(q, firma);
    expect(igual).toMatchObject({ sin_cambios: true, firma });
    expect('rows' in igual).toBe(false);

    const vieja = await svc.movimientosPendientesSiCambio(q, 'firma-de-otra-cola');
    expect('sin_cambios' in vieja).toBe(false);
    expect(vieja).toMatchObject({ firma });
    expect(Array.isArray((vieja as { rows?: unknown }).rows)).toBe(true);

    // Sin firma (la primera carga, el buscador): la bandeja entera, como siempre.
    expect(Array.isArray(((await svc.movimientosPendientesSiCambio(q)) as { rows?: unknown }).rows)).toBe(true);
  });
});
