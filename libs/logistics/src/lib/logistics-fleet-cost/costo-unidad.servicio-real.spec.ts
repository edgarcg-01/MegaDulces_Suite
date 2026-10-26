import * as path from 'node:path';
import knexFactory, { type Knex } from 'knex';
import type { TenantKnexService } from '@megadulces/platform-core';
import { CostoUnidadService } from './costo-unidad.service';

/**
 * `[FCU.2]` El servicio de Costo por unidad contra una base REAL (el Postgres de prueba), con el
 * payload que mandan las pantallas. Todo ocurre en UNA transacción que se revierte al final:
 * aplica las dos migraciones de la fase, siembra unidades, gastos de Kepler y GPS, y lee y escribe
 * como `app_runtime` (con RLS), igual que en producción.
 *
 *     FCU_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/logistics/vitest.config.ts costo-unidad.servicio-real
 *
 * Sin `FCU_TEST_DB_URL` se salta y lo declara (NO MEDIDO). Necesita un usuario que pueda crear las
 * tablas de la migración dentro de la transacción (por eso no es `app_runtime`).
 */
const URL = process.env.FCU_TEST_DB_URL;
const M = '00000000-0000-0000-0000-00000000d01c';
const MIG = path.resolve(__dirname, '../../../../../database/migrations-newdb');
const ROLLBACK = new Error('ROLLBACK');

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[FCU.2] NO MEDIDO: sin FCU_TEST_DB_URL no hay base contra la cual ejercer el servicio.');
}

(URL ? describe : describe.skip)('[FCU.2] Costo por unidad contra una base real (transacción revertida)', () => {
  let knex: Knex;
  beforeAll(() => { knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } }); });
  afterAll(async () => { await knex.destroy(); });

  it('lee y escribe como las pantallas, con RLS y lo que falta dicho', async () => {
    try {
      await knex.transaction(async (trx) => {
        await trx.raw(`select set_config('app.tenant_id', ?, true)`, [M]);
        if (!(await trx.raw(`select 1 from identity.tenants where id = ?`, [M])).rows.length) {
          await trx.raw(`insert into identity.tenants (id, slug, name) values (?, 'mega_dulces', 'Mega Dulces')`, [M]);
        }
        // Limpieza local (revertida al final): que nada viejo de la base de prueba choque.
        await trx.raw(`update logistics.vehicles set deleted_at = now(), kepler_code = null where deleted_at is null`);
        const unidades = [
          ['55AB1M', '00001'], ['69BB9C', '00006'], ['06AU2M', '00002'], ['19AU5F', '00003'], ['882-EW9', '00005'], ['46AG6H', '00004'],
          ['NL5485C', null], ['MZ0108A', null], ['774H6V', '00008'], ['FZ0437B', '00021'], ['NG5962D', null], ['NH9181D', '00029'], ['JV05705', null],
        ];
        for (const [plate, kc] of unidades) await trx('logistics.vehicles').insert({ tenant_id: M, plate, kepler_code: kc, status: 'disponible', active: true });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const esquema = require(path.join(MIG, '20261026161917_fcu_costo_unidad_esquema.js'));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const carga = require(path.join(MIG, '20261026161918_fcu_costo_unidad_carga_hoja.js'));
        await esquema.up(trx);
        await carga.up(trx);

        const id = async (plate: string) => (await trx('logistics.vehicles').whereNull('deleted_at').where({ plate }).first('id')).id as string;
        const U1 = await id('55AB1M'); const HINO = await id('69BB9C'); const KODIAK = await id('GS7683B');
        // GPS del International 1 en octubre.
        for (const [day, km] of [['2026-10-05', 300], ['2026-10-06', 450]] as const) {
          await trx('logistics.vehicle_day_summary').insert({ tenant_id: M, vehicle_id: U1, day, km_driven: km, moving_min: 60, stopped_min: 0, offline_min: 0, stops_count: 1, customer_stops: 0 });
        }
        // Gastos de Kepler (X-A-10).
        const doc = async (folio: string, cab: string, concepto: string, importe: number, centro: string) => {
          await trx.raw(`insert into kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c24, c32) values ('00','00','X','A',10,1,?,'2026-10-10',?, 'PROVEEDOR')`, [folio, cab]);
          await trx.raw(`insert into kepler_ods.kdm6 (sucursal, c1, c2, c3, c4, c5, c6, c7, c9, c11, c12, c16) values ('00','00','X','A',10,1,?,1,'X',?,?,?)`, [folio, importe, concepto, centro]);
        };
        await doc('ZZ9001', 'SEGURO QUALITAS INTERNATIONAL 1', '111', 36611.49, '1-08-12-00');
        await doc('ZZ9002', 'DISEL HINO 500 LA ROSA', '038', 2665.25, '1-02-30-00');
        await doc('ZZ9003', 'DIESEL HINO500,INTER 1,INTER 2', '038', 1030, '1-08-12-00');
        await doc('ZZ9004', 'REFACCION SIN NOMBRE', '255', 500, '1-08-12-00');
        await doc('ZZ9005', 'GASOLINA VENDEDOR', '038', 200, '1-01-10-70');

        // La app corre como app_runtime: con RLS.
        await trx.raw(`SET LOCAL ROLE app_runtime`);
        const tk = { run: <T>(a: unknown, b?: unknown) => (typeof a === 'function' ? a : b as (t: Knex.Transaction) => Promise<T>)(trx) } as unknown as TenantKnexService;
        const svc = new CostoUnidadService(tk);
        const yo = { userId: null };
        const OCT: [string, string] = ['2026-10-01', '2026-10-31'];

        // ── El tablero ──
        let r = await svc.resumen(...OCT, true);
        expect(r.unidades.length).toBe(14);
        const u1 = () => r.unidades.find((u) => u.vehicle_id === U1)!;
        expect(u1().economic_number).toBe('UNIDAD 1');
        expect(u1().km).toEqual({ km: 750, fuente: 'gps', dias_gps: 2 });
        expect(u1().rubros.find((x) => x.rubro === 'seguro')).toMatchObject({ real: 36611.49, procedencia: 'kepler', sugerido: 36611.49 });
        expect(r.pendientes).toEqual({
          sugerido: { renglones: 2, importe: 39276.74 }, ambiguo: { renglones: 1, importe: 1030 }, sin_unidad: { renglones: 1, importe: 500 },
        });
        expect(r.meses_sin_nomina).toEqual(['2026-10']);

        // ── La bandeja: por defecto lo de Logística; «todos» suma lo de otros centros ──
        const pl = await svc.pendientes(...OCT, 'logistica');
        expect(pl.lineas.map((l) => l.folio).sort()).toEqual(['ZZ9001', 'ZZ9002', 'ZZ9003', 'ZZ9004']);
        const pt = await svc.pendientes(...OCT, 'todos');
        expect(pt.lineas.map((l) => l.folio)).toContain('ZZ9005');

        // ── Confirmar el ambiguo al Hino, marcar otro como no-flota, y deshacer ──
        const amb = pl.lineas.find((l) => l.folio === 'ZZ9003')!;
        const sin = pl.lineas.find((l) => l.folio === 'ZZ9004')!;
        expect(await svc.asignar([{ linea_clave: amb.linea_clave, decision: 'unidad', vehicle_id: HINO }, { linea_clave: sin.linea_clave, decision: 'no_es_flota', vehicle_id: null }], yo))
          .toEqual({ guardadas: 2 });
        r = await svc.resumen(...OCT, true);
        expect(r.unidades.find((u) => u.vehicle_id === HINO)!.rubros.find((x) => x.rubro === 'combustible')!.real).toBe(3695.25);
        expect(r.pendientes.ambiguo.renglones).toBe(0);
        expect(r.pendientes.sin_unidad.renglones).toBe(0);
        await svc.asignar([{ linea_clave: amb.linea_clave, decision: 'quitar', vehicle_id: null }], yo);
        expect((await svc.resumen(...OCT, true)).pendientes.ambiguo.renglones).toBe(1);
        await expect(svc.asignar([{ linea_clave: 'x', decision: 'unidad', vehicle_id: HINO }], yo)).rejects.toThrow(/Renglón inválido/);

        // ── La ficha: propia con depreciación; alias normalizados ──
        const f = await svc.guardarFicha(U1, { ownership: 'propia', purchase_value: 1500000, residual_value: 150000, useful_life_years: 10, kepler_aliases: ['international 1 ', 'C.  seca', 'ab'] }, yo);
        expect(f.kepler_aliases).toEqual(['INTERNATIONAL 1', 'C. SECA']);
        await expect(svc.guardarFicha(U1, { fleet_area: 'marte' as never }, yo)).rejects.toThrow(/Área inválida/);
        r = await svc.resumen(...OCT, true);
        expect(u1().rubros.find((x) => x.rubro === 'arrendamiento_depreciacion')).toMatchObject({ real: 11465.75, procedencia: 'calculado' });

        // ── El presupuesto: editar una celda y quitar otra ──
        const pa = await svc.guardarPresupuesto(2026, [{ vehicle_id: U1, rubro: 'seguro', amount: 40000 }, { vehicle_id: U1, rubro: 'lubricantes', amount: null }], yo);
        const p1 = pa.unidades.find((u) => u.vehicle_id === U1)!;
        expect(p1.montos.seguro).toBe(40000);
        expect(p1.montos.lubricantes).toBeUndefined();

        // ── Nómina administrativa: se reparte por km (sólo el International 1 tiene km) ──
        await svc.guardarNomina({ year_month: '2026-10', sueldos_admin: 30000, gastos_directos: 1000, metodo: 'km', notes: null }, yo);
        r = await svc.resumen(...OCT, true);
        expect(u1().rubros.find((x) => x.rubro === 'sueldos_admin')!.real).toBe(30000);
        expect(r.unidades.find((u) => u.vehicle_id === HINO)!.rubros.find((x) => x.rubro === 'sueldos_admin')!.real).toBeNull();
        expect(r.meses_sin_nomina).toEqual([]);

        // ── Odómetro para la que no tiene GPS (el Kodiak) ──
        await svc.registrarLectura(KODIAK, { read_on: '2026-10-01', odometer_km: 100000 }, yo);
        const lect = await svc.registrarLectura(KODIAK, { read_on: '2026-10-20', odometer_km: 101500 }, yo);
        expect(lect.map((l) => l.odometer_km)).toEqual([101500, 100000]);
        r = await svc.resumen(...OCT, true);
        expect(r.unidades.find((u) => u.vehicle_id === KODIAK)!.km).toEqual({ km: 1500, fuente: 'odometro', dias_gps: 0 });
        await svc.borrarLectura(KODIAK, lect[0].id, yo);

        // ── Sin permiso de gestión no viajan salarios ni nómina ──
        const sinPermiso = await svc.resumen(...OCT, false);
        const s1 = sinPermiso.unidades.find((u) => u.vehicle_id === U1)!;
        expect(s1.rubros.find((x) => x.rubro === 'salarios')!.real).toBeNull();
        expect(s1.rubros.find((x) => x.rubro === 'sueldos_admin')!.real).toBeNull();

        // ── El detalle ──
        const d = await svc.detalle(U1, ...OCT, true);
        expect(d.lineas.map((l) => l.folio)).toEqual(['ZZ9001']);
        expect(d.km_por_mes).toEqual([{ mes: '2026-10', km: 750, fuente: 'gps' }]);
        expect(d.ficha.ownership).toBe('propia');
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
  }, 60000);
});
