import knexFactory, { Knex } from 'knex';
import { BadRequestException } from '@nestjs/common';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';

/**
 * `[P2.8.1]` `expedienteDias()` — el SERVICIO REAL contra una base REAL (mismo patrón que
 * `cash-cut.servicio-real.spec.ts`).
 *
 * Por qué existe: el SQL de «Capturas por día» agrupa por día y sucursal, filtra el universo de
 * sucursales y aplica el alcance. Un doble (mock) de Knex no ve nada de eso: un `GROUP BY` mal
 * escrito, un `::date` que revienta con una fecha imposible (salió como 500 en la primera corrida real)
 * o un almacén-ruta que se cuela sólo existen contra Postgres.
 *
 * Conexión COMO `app_runtime`, el rol de prod: con un superusuario la RLS no se aplica.
 *
 *     CADUCIDADES_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5442/postgres_platform \
 *       npx vitest run --config libs/commercial/vitest.config.ts \
 *       libs/commercial/src/lib/commercial-expiry-reviews/expediente-dias.servicio-real.spec.ts
 *
 * ⚠️ Sin `CADUCIDADES_TEST_DB_URL` se SALTA y lo dice: el job de pruebas del CI no tiene Postgres
 *    (deuda VP.5). Esta prueba SIEMBRA filas confirmadas (el servicio abre su propia transacción) y las
 *    borra al terminar; corre sólo contra una base de prueba, nunca contra prod.
 */
const URL = process.env.CADUCIDADES_TEST_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
// Códigos de 2 dígitos que NO existen en una base real de sucursales (01–08, 00 CEDIS).
const COD_A = '97';
const COD_B = '98';
const COD_BAJA = '96';
const COD_C = '95';   // nunca ha subido una hoja con renglones (sólo una cabecera vacía)
const COD_D = '94';   // su única captura es de hace 40 días: fuera de una ventana de 7
const CORRIDA = Date.now().toString(36);
const MARCA = `PRUEBA-DIAS-${CORRIDA}`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[P2.8.1] NO MEDIDO: sin CADUCIDADES_TEST_DB_URL no hay base contra la cual ejercer expedienteDias().');
}

describe.skipIf(!URL)('[P2.8.1] expedienteDias(): el servicio REAL contra Postgres', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CommercialExpiryReviewsService;
  let alcance: string[] | null = null; // lo que devolvería ScopeService.warehouseIds()
  const ids: { wh: string[]; reviews: string[] } = { wh: [], reviews: [] };
  let A = '';
  let B = '';
  let C = '';
  let D = '';

  const sucursalesDe = (r: { data: Array<{ sucursal: string }> }): string[] => [...new Set(r.data.map((x) => x.sucursal))].sort();
  const mias = <R extends { data: Array<{ sucursal: string }> }>(r: R) => r.data.filter((x) => [COD_A, COD_B].includes(x.sucursal));

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba' }) } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    const scope = { warehouseIds: async () => alcance } as unknown as ScopeService;
    svc = new CommercialExpiryReviewsService(tk, ctx, {} as never, {} as never, scope);

    await tk.run(async (trx) => {
      const ocupados = await trx('commercial.warehouses').whereIn('code', [COD_A, COD_B, COD_BAJA, COD_C, COD_D]).pluck('code');
      if (ocupados.length) throw new Error(`La base ya tiene almacenes ${ocupados.join(', ')}: esta prueba necesita esos códigos libres.`);
      const mk = async (code: string, name: string, borrado = false): Promise<string> => {
        const [r] = await trx('commercial.warehouses').insert({ tenant_id: T, code, name, kind: 'central' }).returning('id');
        if (borrado) await trx('commercial.warehouses').where({ id: r.id }).update({ deleted_at: trx.fn.now() });
        ids.wh.push(r.id);
        return r.id as string;
      };
      A = await mk(COD_A, `Suc A ${CORRIDA}`);
      B = await mk(COD_B, `Suc B ${CORRIDA}`);
      C = await mk(COD_C, `Suc C ${CORRIDA}`);
      D = await mk(COD_D, `Suc D ${CORRIDA}`);
      const ruta = await mk(`RUTA-${CORRIDA}`.slice(0, 20), `Ruta basura ${CORRIDA}`);
      const baja = await mk(COD_BAJA, `Suc dada de baja ${CORRIDA}`, true);

      /** Una hoja `atras` días antes de hoy, con renglones `[expiraEn días, quién]`. */
      const hoja = async (wh: string, atras: number, lineas: Array<[number, string]>): Promise<void> => {
        const [r] = await trx('commercial.expiry_reviews').insert({
          tenant_id: T, warehouse_id: wh, review_date: trx.raw(`CURRENT_DATE - ${atras}`), status: 'submitted', notes: MARCA,
          responsible_name: lineas[0][1],
        }).returning('id');
        ids.reviews.push(r.id);
        for (const [exp, quien] of lineas) {
          // `created_by` null → el nombre sale del `responsible_name` de la hoja; probamos los dos capturistas
          // con una hoja por persona.
          void quien;
          await trx('commercial.expiry_review_lines').insert({
            tenant_id: T, review_id: r.id, product_name_raw: `Producto ${MARCA}`, quantity: 1, unit: 'caja',
            expiry_date: trx.raw(`CURRENT_DATE + ${exp}`),
          });
        }
      };
      // A: hoy 3 renglones (una vencida, una por vencer, una buena) · ayer 1 · hace 40 días 1 (fuera de 30)
      await hoja(A, 0, [[-5, 'Ana'], [10, 'Ana'], [200, 'Ana']]);
      await hoja(A, 1, [[100, 'Beto']]);
      await hoja(A, 40, [[100, 'Ana']]);
      // B: ayer 2 renglones · hace 3 días 1
      await hoja(B, 1, [[50, 'Beto'], [60, 'Beto']]);
      await hoja(B, 3, [[50, 'Ana']]);
      // C: sólo una CABECERA sin renglones (hace 2 días): no es una captura. D: una sola hoja, hace 40 días.
      const [cab] = await trx('commercial.expiry_reviews').insert({
        tenant_id: T, warehouse_id: C, review_date: trx.raw('CURRENT_DATE - 2'), status: 'submitted', notes: MARCA, responsible_name: 'Ana',
      }).returning('id');
      ids.reviews.push(cab.id);
      await hoja(D, 40, [[100, 'Ana']]);
      // NO son sucursal / dada de baja: no deben aparecer
      await hoja(ruta, 0, [[50, 'Ana']]);
      await hoja(baja, 0, [[50, 'Ana']]);
    });
  });

  afterAll(async () => {
    try {
      await tk?.run(async (trx) => {
        if (ids.reviews.length) {
          await trx('commercial.expiry_review_lines').whereIn('review_id', ids.reviews).del();
          await trx('commercial.expiry_reviews').whereIn('id', ids.reviews).del();
        }
        if (ids.wh.length) await trx('commercial.warehouses').whereIn('id', ids.wh).del();
      });
    } finally {
      await knex?.destroy();
    }
  });

  beforeEach(() => { alcance = null; });

  const ultimaDe = (r: { ultimas: Array<{ sucursal: string; ultima: string | null }> }, cod: string) => r.ultimas.find((x) => x.sucursal === cod);
  const atras = (hoy: string, n: number): string => new Date(Date.parse(hoy) - n * 86_400_000).toISOString().slice(0, 10);

  it('⭐ trae la ÚLTIMA captura de cada sucursal sin importar la ventana (el CEDIS captura cada mes, no cada semana)', async () => {
    const r = await svc.expedienteDias({ dias: 7 });
    expect(r.hoy).toBe(r.to);                                       // el «hoy» del server
    expect(ultimaDe(r, COD_A)?.ultima).toBe(r.hoy);
    expect(ultimaDe(r, COD_B)?.ultima).toBe(atras(r.hoy, 1));
    expect(ultimaDe(r, COD_D)?.ultima).toBe(atras(r.hoy, 40));      // fuera de los 7 días, y aun así se sabe
    expect(mias(r).some((x) => x.sucursal === COD_D)).toBe(false);  // …sin que aparezca en los días de la ventana
  });

  it('⛔ una sucursal que nunca ha subido hojas SALE, con «ultima: null» (no se esconde ni se inventa una fecha)', async () => {
    const r = await svc.expedienteDias({});
    expect(ultimaDe(r, COD_C)).toMatchObject({ sucursal: COD_C, ultima: null });  // su cabecera vacía de hace 2 días no cuenta
  });

  it('«últimas» respeta el universo, el filtro de sucursal y el alcance', async () => {
    const todas = await svc.expedienteDias({});
    expect(todas.ultimas.every((x) => /^\d{2}$/.test(x.sucursal))).toBe(true);
    expect(todas.ultimas.some((x) => x.warehouse_name.includes('Ruta basura') || x.warehouse_name.includes('dada de baja'))).toBe(false);
    const soloB = await svc.expedienteDias({ sucursal: COD_B });
    expect(soloB.ultimas.map((x) => x.sucursal)).toEqual([COD_B]);
    alcance = [];
    expect((await svc.expedienteDias({})).ultimas).toEqual([]);
    alcance = [A];
    expect((await svc.expedienteDias({})).ultimas.map((x) => x.sucursal)).toEqual([COD_A]);
  });

  it('⭐ sólo entran SUCURSALES vivas: el almacén-ruta y el dado de baja no aparecen', async () => {
    const r = await svc.expedienteDias({});
    expect(r.data.every((x) => /^\d{2}$/.test(x.sucursal))).toBe(true);
    expect(r.data.some((x) => x.warehouse_name.includes('Ruta basura'))).toBe(false);
    expect(r.data.some((x) => x.warehouse_name.includes('dada de baja'))).toBe(false);
    expect(sucursalesDe({ data: mias(r) })).toEqual([COD_A, COD_B]);
  });

  it('una fila por (día, sucursal) con sus conteos: hojas, capturistas, vencidos y por vencer', async () => {
    const r = await svc.expedienteDias({});
    const hoy = mias(r).find((x) => x.sucursal === COD_A && x.fecha === r.to);
    expect(hoy).toMatchObject({ hojas: 3, vencidos: 1, riesgosos: 1 });
    expect(hoy?.capturistas).toEqual(['Ana']);
    expect(mias(r)).toHaveLength(4); // A hoy, A ayer, B ayer, B hace 3 días — la de hace 40 días queda fuera
    expect(typeof hoy?.hojas).toBe('number'); // COUNT(...)::int llega como número, no como string
  });

  it('la ventana por defecto es de 30 días inclusive; dias=7 y dias=90 la mueven', async () => {
    const dias = (r: { from: string; to: string }) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 + 1;
    expect(dias(await svc.expedienteDias({}))).toBe(30);
    expect(dias(await svc.expedienteDias({ dias: 7 }))).toBe(7);
    const noventa = await svc.expedienteDias({ dias: 90 });
    expect(dias(noventa)).toBe(90);
    expect(mias(noventa).filter((x) => x.sucursal === COD_A)).toHaveLength(3); // ahora sí entra la de hace 40 días
  });

  it('`dias` raro (0, texto, más de un año) cae a 30 en vez de reventar', async () => {
    for (const raro of [0, -3, Number.NaN, 9999]) {
      const r = await svc.expedienteDias({ dias: raro });
      expect((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 + 1).toBe(30);
    }
  });

  it('filtrar por sucursal deja sólo esa; una sin hojas devuelve vacío (no error)', async () => {
    const b = await svc.expedienteDias({ sucursal: COD_B });
    expect(b.data).toHaveLength(2);
    expect(b.data.every((x) => x.sucursal === COD_B)).toBe(true);
    expect((await svc.expedienteDias({ sucursal: '55' })).data).toEqual([]);
  });

  it('⛔ el alcance manda: [] no devuelve nada (no «todas»), [A] sólo la A, y pedir la B no lo amplía', async () => {
    alcance = [];
    expect((await svc.expedienteDias({})).data).toEqual([]);
    alcance = [A];
    const soloA = await svc.expedienteDias({});
    expect(soloA.data.length).toBeGreaterThan(0);
    expect(soloA.data.every((x) => x.sucursal === COD_A)).toBe(true);
    expect((await svc.expedienteDias({ sucursal: COD_B })).data).toEqual([]);
  });

  it('⛔ entradas inválidas son 400 con su frase, no un 500 de Postgres', async () => {
    const casos: Array<[Parameters<CommercialExpiryReviewsService['expedienteDias']>[0], RegExp]> = [
      [{ sucursal: '3' }, /sucursal inválida/],
      [{ sucursal: 'abc' }, /sucursal inválida/],
      [{ from: 'ayer' }, /from inválido/],
      [{ to: '2026-13-45' }, /to inválido/],        // tenía forma de fecha: reventaba al castear ::date
      [{ from: '2026-02-30' }, /from inválido/],    // 30 de febrero
      [{ from: '2026-10-10', to: '2020-01-01' }, /no puede ser posterior/],
      [{ from: '2020-01-01' }, /máximo es de un año/],
    ];
    for (const [q, frase] of casos) {
      await expect(svc.expedienteDias(q)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.expedienteDias(q)).rejects.toThrow(frase);
    }
  });
});
