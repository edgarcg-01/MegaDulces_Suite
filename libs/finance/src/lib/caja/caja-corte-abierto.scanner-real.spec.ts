import knexFactory, { Knex } from 'knex';
import type { FinanceNotice } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CajaCorteAbiertoScannerService } from './caja-corte-abierto-scanner.service';

/**
 * `[CGP-L.10]` El sensor del corte abierto, contra una base REAL (la de `preparar-base-caja.js`),
 * como `app_runtime`. Siembra lo que pasó el 12-oct —un corte trabado y jornadas con movimientos y
 * sin corte— y comprueba que el sensor lo ve, deja su latido y avisa SIN repetir.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/caja-corte-abierto.scanner-real.spec.ts
 *
 * Sin `CAJA_TEST_DB_URL` se salta y lo declara. Escribe y no deshace: sólo contra una base de prueba.
 * Las aserciones son RELATIVAS (que aparezca LO SUYO): la base puede traer cortes de otras pruebas.
 */
const URL = process.env.CAJA_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';
// Un año pasado que la 00 no usó (lo elige `anioLibre()`): las jornadas tienen que haber terminado
// hace más de 26 h, y una corrida no puede chocar con lo que sembró otra.
let ANIO = 0;
let ANCLA = '';
let SIN_CORTE: string[] = [];
const CORRIDA = Date.now().toString(36);
const HORA = 60 * 60 * 1000;

/**
 * Un año sin cortes en la 00 y sin movimientos de ninguna plaza.
 * `ux_cash_cut_sucursal_fecha` admite un corte por (sucursal, fecha) y esta prueba escribe sin
 * deshacer: con un año al azar, dos corridas sobre la misma base terminaban chocando (pasó el
 * 2026-10-15 con el 2013). Si se agotan, falla con frase en vez de chocar a mitad.
 */
async function anioLibre(tk: TenantKnexService, desde: number, cuantos: number): Promise<number> {
  const usados = new Set<number>(await tk.run(async (trx) => {
    const r = await trx.raw(`SELECT extract(year FROM fecha)::int AS y FROM finance.cash_ledger_cuts WHERE sucursal = '00' UNION SELECT extract(year FROM fecha)::int FROM finance.cash_ledger`);
    return r.rows.map((x: { y: number }) => Number(x.y));
  }));
  const libres = Array.from({ length: cuantos }, (_, i) => desde + i).filter((y) => !usados.has(y));
  if (!libres.length) {
    throw new Error(`La base de prueba ya usó los ${cuantos} años desde ${desde}: reconstrúyela con database/tests/caja/preparar-base-caja.js.`);
  }
  return libres[Math.floor(Math.random() * libres.length)];
}

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-L.10] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual ejercer el sensor.');
}

describe.skipIf(!URL)('[CGP-L.10] el sensor del corte abierto contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  const avisos: FinanceNotice[] = [];
  let sensor: CajaCorteAbiertoScannerService;
  let folioTrabado = '';

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    sensor = new CajaCorteAbiertoScannerService(knex, {
      notifyCritical: async () => undefined,
      notify: async (_t: string, n: FinanceNotice) => { avisos.push(n); },
    });

    ANIO = await anioLibre(tk, 1200, 790);
    ANCLA = `${ANIO}-06-10`;
    SIN_CORTE = [`${ANIO}-06-11`, `${ANIO}-06-12`];
    await tk.run(async (trx) => {
      // El primer corte del libro (cerrado): desde acá hay jornadas que reclamar.
      await trx('finance.cash_ledger_cuts').insert({
        tenant_id: T, folio: `CC-ANCLA-${ANIO}-${CORRIDA}`, fecha: ANCLA, sucursal: '00', estado: 'cerrado',
        fondo_inicial: 0, fondo_origen: 'contado', esperado: 0, contado: 0, diferencia: 0,
        created_by: CAJERA, closed_by: CAJERA, closed_at: trx.fn.now(),
      });
      // El día del ancla TAMBIÉN tiene un movimiento: sin él, "el ancla no aparece como sin corte"
      // sería una aserción vacía (un día sin movimientos nunca aparece). Lo destapó una mutación.
      await trx('finance.cash_ledger').insert({
        tenant_id: T, folio: `CGS-${ANIO}-${Date.now()}-ancla`, tipo: 'gasto', fecha: ANCLA, sucursal: '00',
        kepler_cuenta: '601-001', kepler_concepto: '001', glosa: 'Movimiento del día que sí tiene corte',
        monto: 100, created_by: CAJERA,
        // `[CGP-L.12]` La jornada de un movimiento es la del EFECTIVO (`created_at` en hora de
        // México), no la del papel. Sin sembrarla, `now()` lo pondría en el día de la corrida y
        // este movimiento no caería en el día que la prueba dice que tiene corte.
        created_at: trx.raw(`((?::date) + interval '12 hours') AT TIME ZONE 'America/Mexico_City'`, [ANCLA]),
      });
      // Dos jornadas con movimientos (una de otra plaza: el cajón de la 00 la paga) y sin corte.
      for (const [i, fecha] of SIN_CORTE.entries()) {
        await trx('finance.cash_ledger').insert({
          tenant_id: T, folio: `CGS-${ANIO}-${Date.now()}-${i}`, tipo: 'gasto', fecha, sucursal: i ? '05' : '00',
          kepler_cuenta: '601-001', kepler_concepto: '001', glosa: 'Movimiento sin corte de la prueba',
          monto: 100, created_by: CAJERA,
          // `[CGP-L.12]` idem: la jornada sin corte se mide por el día del efectivo.
          created_at: trx.raw(`((?::date) + interval '12 hours') AT TIME ZONE 'America/Mexico_City'`, [fecha]),
        });
      }
      // El corte trabado: en borrador desde hace 75 horas, como el del 12-oct.
      folioTrabado = `CC-TRABADO-${ANIO}-${CORRIDA}`;
      await trx('finance.cash_ledger_cuts').insert({
        tenant_id: T, folio: folioTrabado, fecha: `${ANIO}-06-13`, sucursal: `ZT-${ANIO}-${CORRIDA}`,
        fondo_inicial: 0, fondo_origen: 'contado', created_by: CAJERA,
        created_at: trx.raw(`now() - interval '75 hours'`),
      });
    });
  });
  afterAll(async () => {
    await knex?.destroy();
  });

  it('ve las dos señales: el corte trabado y las jornadas con movimientos y sin corte', async () => {
    const t = Date.now();
    const m = await sensor.scan(T, t);
    const trabado = m.abiertos.find((c) => c.folio === folioTrabado);
    expect(trabado?.horas).toBeGreaterThanOrEqual(75);
    expect(m.jornadasSinCorte).toEqual(expect.arrayContaining(SIN_CORTE));
    expect(m.jornadasSinCorte).not.toContain(ANCLA);   // ese día sí tiene corte
    expect(m.universo).toBeGreaterThan(0);

    expect(m.avisado).toBe(true);
    const a = avisos.at(-1)!;
    expect(a).toMatchObject({ key: 'caja_corte_abierto', severity: 'critical', route: '/finanzas/caja-general' });
    expect(a.message).toContain(folioTrabado);
  });

  it('deja su LATIDO: sin él, un sensor parado se vería verde', async () => {
    const latido = await tk.run((trx) => trx('analytics.cron_runs')
      .where({ tenant_id: T, job_key: 'caja_corte_abierto' }).first());
    expect(latido).toMatchObject({ status: 'ok' });
    expect(Number(latido.rows_affected)).toBeGreaterThan(0);
    expect(latido.note).toMatch(/jornada\(s\) sin corte · critical/);
  });

  it('la MISMA situación una hora después no se repite, y a las 6 horas se recuerda', async () => {
    const base = Date.now() + HORA;
    const n0 = avisos.length;
    const otraHora = await sensor.scan(T, base);
    expect(otraHora.avisado).toBe(false);
    expect(avisos.length).toBe(n0);

    const seisHoras = await sensor.scan(T, base + 6 * HORA);
    expect(seisHoras.avisado).toBe(true);
    expect(avisos.length).toBe(n0 + 1);
  });
});
