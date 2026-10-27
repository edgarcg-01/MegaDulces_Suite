import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CashbookCaosCarril, propuestaDeCobro, type CobroDeRuta } from './cashbook-caos.carril';

/**
 * `[LE.4.4]` — La mitad de Kepler del carril contra Postgres: cada cobro de ruta a caja entra una
 * vez a «por rendir», releer no duplica, y un cobro que Kepler CAMBIA después de asentado no se
 * edita: va a la cola (B42). La lectura de `analytics.route_collections` (un SELECT) se sustituye
 * con filas de prueba — la tabla no existe en la base de prueba —; la ESCRITURA es la real.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = randomUUID();

class CarrilConFilas extends CashbookCaosCarril {
  filas: CobroDeRuta[] = [];
  protected override async cobrosDeKepler(): Promise<CobroDeRuta[]> { return this.filas; }
}

describe('[LE.4.4] la cobranza de ruta: el asiento puro', () => {
  it('cobro de $21,000.00 de la ruta 27 → + por rendir de la ruta / − cobranza, con la llave del libro viejo', () => {
    const p = propuestaDeCobro({ almacen: '01-005', cobro_folio: '0000024', cuenta: '0011', ruta: '27', fecha: '2026-10-26', importe: '21000.00' });
    expect(p.asiento.event_ref).toBe('kepler:01-005|U-A-5|0000024|0011');
    expect(p.asiento.lines).toEqual([
      { account: 'POR_RENDIR:RUTA:27', amount_minor: '2100000' },
      { account: 'COBRANZA_KEPLER', amount_minor: '-2100000' },
    ]);
    expect(p.asiento.actor).toEqual({ kind: 'servicio', service: 'libro-kepler' });
  });
});

describe.skipIf(!URL)('[LE.4.4] la cobranza de ruta contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let carril: CarrilConFilas;
  let hay = false;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    hay = (await knex.raw(`SELECT to_regprocedure('cashbook.enqueue_external(jsonb)') IS NOT NULL AS ok`)).rows[0].ok;
    const ctx = { requireTenantId: () => T, run: <R>(_s: unknown, fn: () => R): R => fn() } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    carril = new CarrilConFilas(knex, ctx, tk);
  });
  afterAll(async () => { await knex?.destroy(); });

  const saldo = (code: string) => tk.run(async (trx) => Number((await trx.raw('SELECT balance_minor FROM cashbook.v_saldos WHERE code = ?', [code])).rows[0]?.balance_minor ?? 0));

  it('entra una vez; releer no duplica; un cobro cambiado va a la cola', async () => {
    if (!hay) { console.warn('[LE.4.4] NO MEDIDO: la base no tiene LE.1.9'); return; }
    expect((await carril.correrKepler({ tenantId: T, desde: '' })).estado).toBe('sin_apertura');
    await tk.run((trx) => trx.raw('SELECT cashbook.open_day(?::date, ?)', ['2099-09-01', randomUUID()]));
    carril.filas = [
      { almacen: '01-005', cobro_folio: '0000024', cuenta: '0011', ruta: '27', fecha: '2026-10-26', importe: '21000.00' },
      { almacen: '01-006', cobro_folio: '0000031', cuenta: '0011', ruta: '28', fecha: '2026-10-26', importe: '18500.50' },
    ];
    expect(await carril.correrKepler({ tenantId: T, desde: '2026-10-15' })).toMatchObject({ estado: 'al_dia', asentados: 2, a_la_cola: 0 });
    expect(await saldo('POR_RENDIR:RUTA:27')).toBe(2100000);
    expect(await saldo('COBRANZA_KEPLER')).toBe(-3950050);

    await carril.correrKepler({ tenantId: T, desde: '2026-10-15' });
    expect(await saldo('POR_RENDIR:RUTA:27')).toBe(2100000);       // releer no duplica

    carril.filas[0] = { ...carril.filas[0], importe: '21500.00' };   // Kepler corrigió el cobro
    expect(await carril.correrKepler({ tenantId: T, desde: '2026-10-15' })).toMatchObject({ estado: 'al_dia', asentados: 0, a_la_cola: 1 });
    expect(await saldo('POR_RENDIR:RUTA:27')).toBe(2100000);       // no se editó: espera la reversa firmada
    const cola = await tk.run(async (trx) => (await trx('cashbook.external_queue').where({ source: 'kepler' }).select('reason')) as { reason: string }[]);
    expect(cola).toHaveLength(1);
    expect(cola[0].reason).toMatch(/reversa \+ versión nueva/);
  });
});
