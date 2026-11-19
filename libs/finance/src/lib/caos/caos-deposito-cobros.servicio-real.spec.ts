import knexFactory, { Knex } from 'knex';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { repartirDeposito } from '@megadulces/contracts';
import { CaosService } from './caos.service';

/**
 * ⭐ `[LE.6.37]` Ligar cobros YA CAPTURADOS a un depósito de CAOS, desde Caja General, con el mismo
 * cuerpo que manda la pantalla. El caso que lo pidió: el depósito «rd can 13/11» de $51,770 y los
 * cobros de las rutas 501, 502 y 503 de Canindo ($13,414.29 + $13,260.58 + $25,154.77 = $51,829.64):
 * el último toma $25,095.13 y $59.64 se quedan en caja.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caos/caos-deposito-cobros.servicio-real.spec.ts
 *
 * ⚠️ Sin `CAJA_TEST_DB_URL` la parte de base se SALTA y lo dice. Escribe y no deshace: sólo contra una
 *    base de prueba. Cada corrida usa su propio equipo de CAOS, su sucursal y un año pasado al azar.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = { id: '00000000-0000-0000-0000-0000000000c1', username: 'cajera_prueba', roles_frescos: ['cajero'] };
const CORRIDA = Date.now().toString(36);
const DEV = `DEP-${CORRIDA}`;
const SUC = `D${CORRIDA}`.slice(0, 12);
const ANIO = 1300 + Math.floor(Math.random() * 600);
const D = (dd: number) => `${ANIO}-11-${String(dd).padStart(2, '0')}`;

const sinBase = () => {
  const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
  const tk = { run: () => { throw new Error('no debía tocar la base'); } } as unknown as TenantKnexService;
  return new CaosService(tk, ctx);
};

describe('[LE.6.37] repartirDeposito — el reparto que pintan la pantalla y el servidor', () => {
  it('el caso de Canindo: los dos primeros enteros, el tercero en parte; nada sobra del depósito', () => {
    const r = repartirDeposito(51770, [{ id: 'a', falta: 13414.29 }, { id: 'b', falta: 13260.58 }, { id: 'c', falta: 25154.77 }]);
    expect(r).toEqual([
      { id: 'a', monto: 13414.29, parcial: false },
      { id: 'b', monto: 13260.58, parcial: false },
      { id: 'c', monto: 25095.13, parcial: true },
    ]);
  });

  it('CONTROL: si los cobros suman menos que el depósito, todos van enteros y el depósito conserva lo libre', () => {
    const r = repartirDeposito(1000, [{ id: 'a', falta: 300 }, { id: 'b', falta: 200 }]);
    expect(r.map((x) => [x.monto, x.parcial])).toEqual([[300, false], [200, false]]);
  });

  it('NEGATIVA: un cobro al que ya no le alcanza nada no entra (no se escribe un vínculo de $0)', () => {
    const r = repartirDeposito(100, [{ id: 'a', falta: 100 }, { id: 'b', falta: 50 }]);
    expect(r.map((x) => x.id)).toEqual(['a']);
  });
});

describe('[LE.6.37] ligar cobros a un depósito — la forma, sin base', () => {
  it('NEGATIVA: sin cobros, o con uno repetido, no llega a la base', async () => {
    const svc = sinBase();
    await expect(svc.ligarCobrosADeposito('d', 1, { cash_ledger_ids: [] }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.ligarCobrosADeposito('d', 1, { cash_ledger_ids: ['x', 'x'] }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);
  });
});

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.6.37] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ligar cobros a un depósito.');
}

describe.skipIf(!URL)('[LE.6.37] ligar cobros ya capturados a un depósito — base real', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CaosService;
  let n = 0;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CaosService(tk, ctx);
  });
  afterAll(async () => { await knex?.destroy(); });

  const deposito = (typeId: 0 | 4, total: number, dia: string, ref: string) => tk.run(async (trx) => {
    const external_id = 9_000_000 + (n += 1);
    await trx('analytics.caos_cash_movements').insert({
      tenant_id: T, device: DEV, external_id, type_id: typeId, type_label: typeId === 0 ? 'Deposito' : 'Dispensar',
      occurred_at: trx.raw(`((?::date) + interval '13 hours') AT TIME ZONE 'America/Mexico_City'`, [dia]),
      accounting_date: dia, user_external: 'Prueba (003)', total: typeId === 0 ? total : -total, ref,
      _row_hash: `dep-${CORRIDA}-${n}`,
    });
    return external_id;
  });
  const cobro = (monto: number, dia: string, ruta: string, tipo: 'ingreso' | 'gasto' = 'ingreso') => tk.run(async (trx) => {
    const folio = `DEP-${CORRIDA}-${(n += 1)}`;
    const [l] = await trx('finance.cash_ledger').insert({
      tenant_id: T, folio, tipo, fecha: dia, sucursal: SUC, ruta,
      kepler_cuenta: '101-001', kepler_concepto: '001', glosa: `cobro de prueba ruta ${ruta}`, monto,
      origen_tipo: 'cobro', origen_ref: `${SUC}|U-A-5|${CORRIDA}${n}|0011`, created_by: CAJERA.id,
    }).returning('id');
    return { id: String(l.id ?? l), folio };
  });
  const libre = (ext: number) => tk.run(async (trx) => {
    const [{ v }] = await trx('finance.caos_cash_links').where({ tenant_id: T, caos_device: DEV, caos_external_id: ext })
      .whereNull('deleted_at').select(trx.raw('coalesce(sum(monto_enlazado),0)::numeric AS v'));
    return Number(v);
  });

  it('⭐ el depósito de $51,770 con los cobros de 501, 502 y 503: candidatos, reparto y lo que queda en caja', async () => {
    const dep = await deposito(0, 51770, D(18), 'rd can 13/11');
    const c501 = await cobro(13414.29, D(17), '501');
    const c502 = await cobro(13260.58, D(13), '502');
    const c503 = await cobro(25154.77, D(13), '503');
    const despues = await cobro(9999.99, D(19), '504');   // fecha DESPUÉS del depósito: no puede explicarlo
    const yaEntero = await cobro(500, D(12), '505');
    const otroDep = await deposito(0, 500, D(12), 'otro');
    await svc.ligarCobrosADeposito(DEV, otroDep, { cash_ledger_ids: [yaEntero.id] }, CAJERA);

    // Los candidatos: los tres, y ni el posterior ni el ya explicado entero.
    const cand = await svc.cobrosParaDeposito(DEV, dep);
    expect(cand.deposito).toMatchObject({ total: 51770, libre: 51770, fecha: D(18), ref: 'rd can 13/11' });
    const mios = cand.rows.filter((r) => r.sucursal === SUC).map((r) => r.folio);
    expect(mios).toEqual(expect.arrayContaining([c501.folio, c502.folio, c503.folio]));
    expect(mios).not.toContain(despues.folio);
    expect(mios).not.toContain(yaEntero.folio);
    expect(cand.rows.find((r) => r.folio === c501.folio)).toMatchObject({ fecha: D(17), ruta: '501', falta: 13414.29 });

    // Lo que manda la pantalla: los ids en el orden en que quedaron marcados.
    const r = await svc.ligarCobrosADeposito(DEV, dep, { cash_ledger_ids: [c501.id, c502.id, c503.id] }, CAJERA);
    expect(r.vinculos).toEqual([
      { folio: c501.folio, monto: 13414.29, parcial: false },
      { folio: c502.folio, monto: 13260.58, parcial: false },
      { folio: c503.folio, monto: 25095.13, parcial: true },
    ]);
    expect(r).toMatchObject({ ligado: 51770, libre: 0, sin_depositar: 59.64 });
    expect(await libre(dep)).toBe(51770);

    // La fecha de los vínculos ya no sale como `Tue Nov 17 …`.
    const movId = await tk.run((trx) => trx('analytics.caos_cash_movements').where({ tenant_id: T, device: DEV, external_id: dep }).first('id'));
    const v = await svc.vinculos(movId.id);
    expect(v?.filas.find((f) => f.folio === c501.folio)?.fecha).toBe(D(17));

    // NEGATIVA: el depósito ya está completo — un segundo intento no escribe nada.
    await expect(svc.ligarCobrosADeposito(DEV, dep, { cash_ledger_ids: [despues.id] }, CAJERA)).rejects.toBeInstanceOf(ConflictException);
  });

  it('NEGATIVA: todo o nada — si un cobro no pasa (es un egreso), no se guarda ninguno', async () => {
    const dep = await deposito(0, 2000, D(20), 'todo o nada');
    const bueno = await cobro(800, D(20), '501');
    const egreso = await cobro(300, D(20), '502', 'gasto');
    await expect(svc.ligarCobrosADeposito(DEV, dep, { cash_ledger_ids: [bueno.id, egreso.id] }, CAJERA)).rejects.toThrow(/un egreso/);
    expect(await libre(dep)).toBe(0);
  });

  it('NEGATIVA: un cobro que ya no alcanza nada del depósito se rechaza con su folio, sin escribir', async () => {
    const dep = await deposito(0, 1000, D(21), 'no alcanza');
    const a = await cobro(1000, D(21), '501');
    const b = await cobro(50, D(21), '502');
    await expect(svc.ligarCobrosADeposito(DEV, dep, { cash_ledger_ids: [a.id, b.id] }, CAJERA)).rejects.toThrow(new RegExp(b.folio));
    expect(await libre(dep)).toBe(0);
  });

  it('NEGATIVA: un retiro no es un depósito, y un depósito registrado como movimiento propio no recibe cobros', async () => {
    const retiro = await deposito(4, 1000, D(22), 'un retiro');
    const c = await cobro(100, D(22), '501');
    await expect(svc.ligarCobrosADeposito(DEV, retiro, { cash_ledger_ids: [c.id] }, CAJERA)).rejects.toThrow(/no es un depósito/);

    const dep = await deposito(0, 700, D(22), 'ya registrado');
    await tk.run((trx) => trx('finance.cash_ledger').insert({
      tenant_id: T, folio: `DEP-${CORRIDA}-reg`, tipo: 'ingreso', fecha: D(22), sucursal: SUC,
      kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'depósito registrado desde CAOS', monto: 700,
      origen_tipo: 'caos', origen_ref: `${DEV}|${dep}`, created_by: CAJERA.id,
    }));
    await expect(svc.ligarCobrosADeposito(DEV, dep, { cash_ledger_ids: [c.id] }, CAJERA)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.cobrosParaDeposito(DEV, dep)).rejects.toBeInstanceOf(ConflictException);
  });
});
