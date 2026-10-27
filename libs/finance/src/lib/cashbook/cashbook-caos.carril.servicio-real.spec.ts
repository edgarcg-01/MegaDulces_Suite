import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CashbookCaosCarril } from './cashbook-caos.carril';

/**
 * `[LE.4.4]` — El carril máquina → libro contra Postgres: asienta en orden desde el punto de
 * apertura, manda a la cola lo que no tiene regla y SIGUE, se detiene en un hueco y en lo que
 * dejaría la bóveda en negativo, y releer no duplica. Tenant y equipo al azar por corrida.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = randomUUID();
const DEV = `LE44-${Date.now().toString(36)}`;
const AP = 5000;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.4.4] NO MEDIDO: sin CAJA_TEST_DB_URL el carril no se ejerce contra una base real.');
}

describe.skipIf(!URL)('[LE.4.4] el carril de la máquina contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let carril: CashbookCaosCarril;
  let hay = false;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    hay = (await knex.raw(`SELECT to_regprocedure('cashbook.enqueue_external(jsonb)') IS NOT NULL AS ok`)).rows[0].ok;
    const ctx = { requireTenantId: () => T, run: <R>(_s: unknown, fn: () => R): R => fn() } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    carril = new CashbookCaosCarril(knex, ctx, tk);
  });
  afterAll(async () => { await knex?.destroy(); });

  const mov = (id: number, typeId: number, label: string, piezas: [number, number][], total?: string) => tk.run(async (trx) => {
    const suma = piezas.reduce((s, [d, q]) => s + Math.abs(d) * q, 0);
    const [r] = await trx('analytics.caos_cash_movements').insert({
      tenant_id: T, device: DEV, external_id: id, type_id: typeId, type_label: label, occurred_at: new Date(Date.now() - 3600_000).toISOString(),
      total: total ?? suma, ref: typeId === 0 ? 'ruta 27 261026' : null, user_external: 'prueba', _row_hash: `${DEV}-${id}`,
    }).returning('id');
    for (const [d, q] of piezas) await trx('analytics.caos_cash_denominations').insert({ tenant_id: T, movement_id: r.id, denom: d, pieza_tipo: 'B', quantity: q });
  });
  const correr = () => carril.correr({ tenantId: T, desde: `${DEV}:${AP}` });
  const cola = () => tk.run(async (trx) => (await trx('cashbook.external_queue').select('event_ref', 'reason').orderBy('created_at')) as { event_ref: string; reason: string }[]);
  const saldoBoveda = () => tk.run(async (trx) => Number((await trx.raw(`SELECT balance_minor FROM cashbook.v_saldos WHERE code = 'BOVEDA_CAOS'`)).rows[0]?.balance_minor ?? 0));

  it('en orden desde la apertura; sin regla a la cola; hueco y negativo lo detienen; releer no duplica', async () => {
    if (!hay) { console.warn('[LE.4.4] NO MEDIDO: la base no tiene LE.1.9'); return; }
    expect((await carril.correr({ tenantId: T, desde: '' })).estado).toBe('sin_apertura');

    await tk.run((trx) => trx.raw('SELECT cashbook.open_day(?::date, ?)', ['2099-08-01', randomUUID()]));
    await mov(AP, 0, 'Deposito', [[500, 50]]);                      // antes del punto de apertura: NO se toma
    await mov(AP + 1, 0, 'Deposito', [[500, 10], [200, 5]]);
    await mov(AP + 2, 4, 'Dispensar', [[500, 4]]);
    await mov(AP + 3, 2, 'Fin de Dia', [[500, 6], [200, 5]]);        // sin regla: a la cola y sigue
    await mov(AP + 4, 13, 'Contenido Modificado', [], '0');           // sin piezas, sin regla: a la cola y sigue
    const r1 = await correr();
    expect(r1).toMatchObject({ estado: 'al_dia', asentados: 2, a_la_cola: 2, ultimo: AP + 4 });
    expect(await saldoBoveda()).toBe(400000);                         // 6×500 + 5×200 = $4,000

    const r2 = await correr();
    expect(r2).toMatchObject({ estado: 'al_dia', asentados: 0, a_la_cola: 0 });   // releer no duplica

    await mov(AP + 6, 0, 'Deposito', [[100, 1]]);                     // falta el AP+5
    const r3 = await correr();
    expect(r3).toMatchObject({ estado: 'detenido', asentados: 0, motivo: `hueco ${AP + 5}–${AP + 5}` });
    expect(await saldoBoveda()).toBe(400000);

    await mov(AP + 5, 4, 'Dispensar', [[500, 9]]);                    // la máquina sólo tiene 6×500
    const r4 = await correr();
    expect(r4).toMatchObject({ estado: 'detenido', asentados: 0, motivo: `#${AP + 5} dejaría la bóveda en negativo` });
    expect(await saldoBoveda()).toBe(400000);
    const refs = (await cola()).map((q) => q.event_ref);
    expect(refs).toEqual(expect.arrayContaining([`caos:${DEV}:${AP + 3}`, `caos:${DEV}:${AP + 4}`, `caos:${DEV}:hueco:${AP + 5}-${AP + 5}`, `caos:${DEV}:${AP + 5}`]));
    expect(refs.some((r) => r.endsWith(`:${AP}`))).toBe(false);       // lo de antes de la apertura nunca entra
  });
});
