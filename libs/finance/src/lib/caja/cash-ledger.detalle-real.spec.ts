import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CashLedgerService } from './cash-ledger.service';

/**
 * `[CGP-L.8]` `detail()` contra una base REAL: el cambio devuelto RESTA.
 *
 * `detail()` alimenta el comprobante impreso. Sumaba todas las piezas sin mirar `flujo` (ni lo
 * devolvía), así que un cobro de $380 pagado con $500 y $120 de cambio salía «desglosado $620,
 * diferencia +$240» — un descuadre inventado — y el ticket listaba el cambio como recibido.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/cash-ledger.detalle-real.spec.ts
 *
 * Sin `CAJA_TEST_DB_URL` se salta y lo declara. Escribe y no deshace: sólo contra una base de prueba.
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-L.8] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer detail().');
}

describe.skipIf(!URL)('[CGP-L.8] detail() contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CashLedgerService;

  beforeAll(() => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CashLedgerService(tk, ctx);
  });
  afterAll(async () => { await knex?.destroy(); });

  it('un cobro de $380 con $500 recibidos y $120 de cambio cuadra, y cada pieza dice su flujo', async () => {
    const id = await tk.run(async (trx) => {
      const [m] = await trx('finance.cash_ledger').insert({
        tenant_id: T, folio: `CGL-L8-${Date.now()}`, tipo: 'ingreso', fecha: '1985-06-01', sucursal: 'L8',
        kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'Cobro con cambio de la prueba L.8',
        monto: 380, created_by: CAJERA,
      }).returning('id');
      const mid = (m as { id: string }).id ?? m;
      await trx('finance.cash_ledger_denominations').insert([
        { tenant_id: T, cash_ledger_id: mid, denominacion: 500, piezas: 1, denom_key: '500', flujo: 'recibido' },
        { tenant_id: T, cash_ledger_id: mid, denominacion: 100, piezas: 1, denom_key: '100', flujo: 'devuelto' },
        { tenant_id: T, cash_ledger_id: mid, denominacion: 20, piezas: 1, denom_key: '20', flujo: 'devuelto' },
      ]);
      return mid as string;
    });

    const d = await svc.detail(id);
    expect(d.arqueo).toEqual({ desglosado: 380, diferencia: 0 });
    expect(d.denominaciones.map((x: { flujo: string }) => x.flujo).sort()).toEqual(['devuelto', 'devuelto', 'recibido']);
  });
});
