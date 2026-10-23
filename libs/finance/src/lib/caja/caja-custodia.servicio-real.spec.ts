import knexFactory, { Knex } from 'knex';
import { BadRequestException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CajaCustodiaService, piernasDeCustodiaDeLaJornada } from './caja-custodia.service';

/**
 * `[CGA-A.51]` El SERVICIO REAL de la custodia (ADR-101) contra una base REAL, como `app_runtime`:
 * clasificar un retiro, cargarle gastos, verlo con lo que le queda, cerrarlo con el regreso a CAOS
 * y las piernas que lee el corte. Con el mismo cuerpo que va a mandar la pantalla.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/caja-custodia.servicio-real.spec.ts
 *
 * ⚠️ Sin `CAJA_TEST_DB_URL` se SALTA y lo dice. Escribe y no deshace (el servicio confirma sus
 *    transacciones): sólo contra una base de prueba. Cada corrida usa su propio equipo de CAOS y un
 *    año pasado, así que dos corridas no se pisan.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = { id: '00000000-0000-0000-0000-0000000000c1', username: 'cajera_prueba' };
const CORRIDA = Date.now().toString(36);
const DEV = `CUST-${CORRIDA}`;
const ANIO = 1300 + Math.floor(Math.random() * 600);
const D_RETIRO = `${ANIO}-03-02`;
const D_GASTOS = `${ANIO}-03-04`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGA-A.51] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer la custodia.');
}

describe.skipIf(!URL)('[CGA-A.51] la custodia REAL contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CajaCustodiaService;
  let n = 0;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CajaCustodiaService(tk, ctx);
  });
  afterAll(async () => { await knex?.destroy(); });

  const mov = (typeId: number, total: number, dia: string, ref: string | null = null) => tk.run(async (trx) => {
    const external_id = 8_000_000 + (n += 1);
    await trx('analytics.caos_cash_movements').insert({
      tenant_id: T, device: DEV, external_id, type_id: typeId, type_label: typeId === 4 ? 'Dispensar' : 'Deposito',
      occurred_at: trx.raw(`((?::date) + interval '12 hours') AT TIME ZONE 'America/Mexico_City'`, [dia]),
      accounting_date: dia, user_external: 'Prueba (003)', total, ref, _row_hash: `cust-${CORRIDA}-${n}`,
    });
    return external_id;
  });
  /** Un gasto pagado con un pedazo del retiro: lo mismo que escribe la captura (`caos_links`). */
  const gastoConRetiro = (monto: number, retiro: number, tomado: number) => tk.run(async (trx) => {
    const [g] = await trx('finance.cash_ledger').insert({
      tenant_id: T, folio: `CUST-${CORRIDA}-${(n += 1)}`, tipo: 'gasto', fecha: D_GASTOS, sucursal: `CU-${CORRIDA}`,
      kepler_cuenta: '601-001', kepler_concepto: '001', glosa: 'Gasto de prueba pagado con un retiro', monto,
      created_by: CAJERA.id,
    }).returning('id');
    await trx('finance.caos_cash_links').insert({
      tenant_id: T, cash_ledger_id: g.id ?? g, caos_device: DEV, caos_external_id: retiro, monto_enlazado: tomado,
      confirmed_by: CAJERA.id,
    });
  });

  it('un retiro de $200,000 queda a cargo, paga dos gastos, y su sobrante regresa a CAOS', async () => {
    const retiro = await mov(4, 200000, D_RETIRO, 'pagos semana');

    // La pantalla manda { device, external_id, destino } — el responsable sale del operador.
    const { custodia_id } = await svc.clasificar({ device: DEV, external_id: retiro, destino: 'custodia' }, CAJERA);
    expect(custodia_id).toBeTruthy();

    const p19 = await tk.run((trx) => piernasDeCustodiaDeLaJornada(trx as Knex.Transaction, T, D_RETIRO));
    expect(p19?.dispensado_en_custodia).toBe(200000);

    await gastoConRetiro(120000, retiro, 120000);
    await gastoConRetiro(75803.05, retiro, 75803.05);
    const p21 = await tk.run((trx) => piernasDeCustodiaDeLaJornada(trx as Knex.Transaction, T, D_GASTOS));
    expect(p21?.gastos_de_custodia).toBe(195803.05);

    const l = await svc.listar({ from: D_RETIRO, to: D_RETIRO });
    const fila = l.retiros.find((r) => r.external_id === retiro);
    expect(fila).toMatchObject({ enlazado: 195803.05, disponible: 4196.95, responsable: 'Prueba (003)', gastos: 2 });
    // Del año ${ANIO}: pasó cualquier plazo.
    expect(fila?.estado).toBe('vencido');
    expect(l.por_responsable.find((p) => p.responsable === 'Prueba (003)')?.monto).toBeGreaterThanOrEqual(4196.95);

    // NEGATIVA: un regreso que no es exacto no cierra.
    const mal = await mov(0, 5000, D_GASTOS, 'regreso pagos');
    await expect(svc.cerrar(custodia_id, { tipo: 'regreso_caos', deposito_external_id: mal }, CAJERA))
      .rejects.toBeInstanceOf(BadRequestException);

    const bien = await mov(0, 4196.95, D_GASTOS, 'regreso pagos');
    const c = await svc.cerrar(custodia_id, { tipo: 'regreso_caos', deposito_external_id: bien }, CAJERA);
    expect(c).toMatchObject({ tipo: 'regreso_caos', monto: 4196.95, dia: D_GASTOS });

    const p23 = await tk.run((trx) => piernasDeCustodiaDeLaJornada(trx as Knex.Transaction, T, D_GASTOS));
    expect(p23?.regresos_a_caos).toBe(4196.95);
    const l2 = await svc.listar({ from: D_RETIRO, to: D_RETIRO });
    expect(l2.retiros.find((r) => r.external_id === retiro)?.estado).toBe('cerrado');

    // NEGATIVA: cerrada no se cierra otra vez, y no recibe más gastos (lo frena la base).
    await expect(svc.cerrar(custodia_id, { tipo: 'faltante', nota: 'intento de cerrar dos veces' }, CAJERA))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(gastoConRetiro(1000, retiro, 1000)).rejects.toMatchObject({ constraint: 'caos_link_custodia_cerrada' });
  });

  it('NEGATIVA: un depósito no se clasifica, y un faltante sin explicación no se cierra', async () => {
    const dep = await mov(0, 1000, D_RETIRO);
    await expect(svc.clasificar({ device: DEV, external_id: dep, destino: 'custodia' }, CAJERA))
      .rejects.toBeInstanceOf(BadRequestException);

    const retiro = await mov(4, 3000, D_RETIRO);
    const { custodia_id } = await svc.clasificar({ device: DEV, external_id: retiro, destino: 'custodia', responsable: 'Juan (002)' }, CAJERA);
    await expect(svc.cerrar(custodia_id, { tipo: 'faltante', nota: 'no sé' }, CAJERA)).rejects.toBeInstanceOf(BadRequestException);
    const f = await svc.cerrar(custodia_id, { tipo: 'faltante', nota: 'No apareció al revisar la bolsa de pagos' }, CAJERA);
    expect(f).toMatchObject({ tipo: 'faltante', monto: 3000 });
  });

  it('un retiro que fue al cajón no cambia el corte, y con gastos no se manda al cajón', async () => {
    const retiro = await mov(4, 8000, D_RETIRO);
    await svc.clasificar({ device: DEV, external_id: retiro, destino: 'cajon' }, CAJERA);
    const p = await tk.run((trx) => piernasDeCustodiaDeLaJornada(trx as Knex.Transaction, T, D_RETIRO));
    // Sólo cuentan los retiros EN CUSTODIA de esta corrida (200,000 + 3,000), no el del cajón.
    expect(p?.dispensado_en_custodia).toBe(203000);

    const r2 = await mov(4, 6000, D_RETIRO);
    await svc.clasificar({ device: DEV, external_id: r2, destino: 'custodia' }, CAJERA);
    await gastoConRetiro(2000, r2, 2000);
    await expect(svc.clasificar({ device: DEV, external_id: r2, destino: 'cajon' }, CAJERA))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
