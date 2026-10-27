import knexFactory, { Knex } from 'knex';
import { ConflictException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CaosIngresoReconService, conciliadorEncendido } from './caos-ingreso-recon.service';

/**
 * `[LE.0.0]` La contención del reparto automático de depósitos (`CG.58`), contra una base REAL.
 *
 * Medido el 2026-10-27: 86 depósitos de CAOS ($1,703,230) tenían DOS explicaciones — el libro los
 * ligaba al cobro de su ruta y su día, y el reparto por antigüedad a cobros de meses antes. Estas
 * pruebas fijan las dos defensas:
 *   1. apagado por default: `conciliar()` se niega con una frase (y el cron no reparte);
 *   2. encendido, un depósito que el libro ya explica NO entra al reparto.
 *
 *     CAJA_TEST_DB_URL=<la URL de la base de prueba, como app_runtime> \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caos/caos-ingreso-recon.libro-real.spec.ts
 *
 * ⚠️ Sin `CAJA_TEST_DB_URL` la parte de base se SALTA y lo dice. Escribe y no deshace: sólo contra
 *    una base de prueba. Cada corrida usa su propio equipo de CAOS y fechas de 2098.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';
const CORRIDA = Date.now().toString(36);
const DEV = `LE00-${CORRIDA}`;
const DESDE = '2098-03-01';

const conInterruptor = async <R>(valor: string | undefined, fn: () => Promise<R>): Promise<R> => {
  const antes = process.env['CAOS_INGRESO_CONCILIAR'];
  if (valor === undefined) delete process.env['CAOS_INGRESO_CONCILIAR'];
  else process.env['CAOS_INGRESO_CONCILIAR'] = valor;
  try { return await fn(); } finally {
    if (antes === undefined) delete process.env['CAOS_INGRESO_CONCILIAR'];
    else process.env['CAOS_INGRESO_CONCILIAR'] = antes;
  }
};

describe('[LE.0.0] el interruptor del reparto automático', () => {
  it('NEGATIVA: sin la variable (default) está apagado; sólo «on» lo enciende', async () => {
    await conInterruptor(undefined, async () => expect(conciliadorEncendido()).toBe(false));
    await conInterruptor('1', async () => expect(conciliadorEncendido()).toBe(false));
    await conInterruptor('true', async () => expect(conciliadorEncendido()).toBe(false));
    await conInterruptor('on', async () => expect(conciliadorEncendido()).toBe(true));
  });

  it('NEGATIVA: apagado, conciliar() se niega con su frase antes de tocar la base', async () => {
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    const tk = { run: () => { throw new Error('no debía tocar la base'); } } as unknown as TenantKnexService;
    const svc = new CaosIngresoReconService(tk, ctx);
    await conInterruptor(undefined, async () => {
      await expect(svc.conciliar(null, {})).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.0.0] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual probar que el reparto deja fuera lo que el libro explica.');
}

describe.skipIf(!URL)('[LE.0.0] encendido, el reparto deja fuera lo que el libro ya explica — base real', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CaosIngresoReconService;
  let n = 0;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CaosIngresoReconService(tk, ctx);
  });
  afterAll(async () => { await knex?.destroy(); });

  const deposito = (total: number) => tk.run(async (trx) => {
    const external_id = 7_000_000 + (n += 1);
    await trx('analytics.caos_cash_movements').insert({
      tenant_id: T, device: DEV, external_id, type_id: 0, type_label: 'Deposito',
      occurred_at: `${DESDE}T18:00:00-06:00`, accounting_date: DESDE, user_external: 'Vendedor (006) - VENTAS',
      total, ref: 'ruta 27 010398', _row_hash: `le00-${CORRIDA}-${n}`,
    });
    return external_id;
  });

  it('el depósito ligado a su cobro en el libro no se reparte; el otro sí entra al reparto', async () => {
    // Línea base: la base de prueba puede traer depósitos de otras corridas. Sin cobros pendientes
    // el reparto no escribe nada, así que correrlo antes no cambia lo que se mide después.
    const r0 = await conInterruptor('on', () => svc.conciliar(null, { from: DESDE }));
    const ligado = await deposito(18940);
    await deposito(5000);
    await tk.run(async (trx) => {
      const [l] = await trx('finance.cash_ledger').insert({
        tenant_id: T, folio: `LE00-${CORRIDA}`, tipo: 'ingreso', fecha: DESDE, sucursal: `LE-${CORRIDA}`,
        kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'cobro ruta 27 de prueba', monto: 18942,
        origen_tipo: 'cobro', origen_ref: `01-005|U-A-5|${CORRIDA}|0011`, created_by: CAJERA,
      }).returning('id');
      await trx('finance.caos_cash_links').insert({
        tenant_id: T, cash_ledger_id: l.id ?? l, caos_device: DEV, caos_external_id: ligado,
        monto_enlazado: 18940, confirmed_by: CAJERA,
      });
    });

    const r = await conInterruptor('on', () => svc.conciliar(null, { from: DESDE }));
    // Sólo el depósito de $5,000 entra; el de $18,940 ya lo explica el libro.
    expect(r.depositos - r0.depositos).toBe(1);
    expect(Math.round((r.monto_depositado - r0.monto_depositado) * 100) / 100).toBe(5000);
  });
});
