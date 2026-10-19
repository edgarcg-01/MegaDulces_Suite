import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import knexLib, { type Knex } from 'knex';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FloorStockoutsService, DESCRIPCION_MAX } from './floor-stockouts.service';

/**
 * `[MOS.2]` / `[MOS.3]` — **No registrados** y la descripción que escribe la cajera, contra una
 * base REAL.
 *
 * ── Por qué contra la base y no con dobles ───────────────────────────────────────────────────
 * Lo que puede fallar acá es SQL: juntar las semanas, cruzar las 7 llaves de `kdii`, decidir que
 * un código ya está en ESA sucursal y no en otra. Un doble que contesta filas armadas a mano se
 * pone verde con la consulta rota. Así que se corre el código real del servicio contra Postgres:
 *
 *   · la tabla se crea con SUS migraciones reales (no una copia del DDL),
 *   · todo pasa dentro de UNA transacción que se revierte al final: no queda nada,
 *   · sólo contra una base LOCAL (`127.0.0.1`/`localhost`): nunca contra producción.
 *
 * ⚠️ **Sin base disponible las pruebas se SALTAN y lo dicen** (`NO MEDIDO` en la salida). Un salto
 * no es un verde: en CI esta suite no tiene base y no prueba nada — se corre a mano antes del PR.
 */

// La cadena de conexion llega por entorno, nunca escrita aqui (el repo es publico). Para correrla:
//   NR_TEST_DB_URL=<url de tu base LOCAL> npx vitest run --config libs/commercial/vitest.config.ts <este archivo>
const URL = process.env['NR_TEST_DB_URL'] ?? '';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const MIG = '../../../../../database/migrations-newdb/';

/** Fuerza el rollback al final de cada prueba: ningún dato sembrado sobrevive. */
class Revertir extends Error {}

let db: Knex | null = null;
let motivoSinBase = '';

beforeAll(async () => {
  if (!URL) {
    motivoSinBase = 'falta NR_TEST_DB_URL (la base local de pruebas)';
    return;
  }
  const host = new globalThis.URL(URL.replace(/^postgres(ql)?:/, 'http:')).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    motivoSinBase = `la base ${host} no es local; esta prueba sólo corre contra una base local`;
    return;
  }
  const k = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 2 } });
  try {
    await k.raw('SELECT 1 FROM kepler_ods.kdii LIMIT 1');
    await k.raw('SELECT 1 FROM commercial.warehouses LIMIT 1');
    db = k;
  } catch (e) {
    motivoSinBase = `sin base local utilizable (${(e as Error).message})`;
    await k.destroy();
  }
});

afterAll(async () => { await db?.destroy(); });

interface Ctx { trx: Knex.Transaction; whA: { id: string; code: string; kepler: string }; whB: { id: string; code: string; kepler: string } }

/**
 * Abre la transacción, crea la tabla con sus migraciones y entrega dos sucursales Kepler. La
 * prueba corre adentro y al salir TODO se revierte.
 */
async function enTransaccion(fn: (c: Ctx) => Promise<void>): Promise<void> {
  if (!db) throw new Error('sin base');
  try {
    await db.transaction(async (trx) => {
      for (const f of ['20260919150000_commercial_floor_stockouts.js', '20260926120000_floor_stockouts_no_en_anaquel.js']) {
        const mod = await import(pathToFileURL(resolve(__dirname, MIG, f)).href);
        await (mod.default ?? mod).up(trx);
      }
      await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
      const whs = await trx('commercial.warehouses')
        .select('id', 'code', 'kepler_code')
        .whereNotNull('kepler_code').whereNull('deleted_at')
        .orderBy('kepler_code').limit(2);
      if (whs.length < 2) throw new Error('la base local no tiene dos sucursales Kepler');
      const [a, b] = whs.map((w: { id: string; code: string; kepler_code: string }) => ({ id: w.id, code: w.code, kepler: w.kepler_code }));
      await fn({ trx, whA: a, whB: b });
      throw new Revertir();
    });
  } catch (e) {
    if (!(e instanceof Revertir)) throw e;
  }
}

/** Un renglón de faltante, con lo mínimo. `hace` = minutos desde el último reporte. */
async function anotar(trx: Knex.Transaction, o: {
  wh: string; kind: string; sku?: string; code?: string; nombre?: string;
  veces?: number; semana?: string; status?: string; hace?: number;
}): Promise<string> {
  const semana = o.semana ?? '2026-10-12';
  const [r] = await trx('commercial.floor_stockouts').insert({
    tenant_id: TENANT, warehouse_id: o.wh, sku: o.sku ?? null, scanned_code: o.code ?? null,
    product_name: o.nombre ?? null, kind: o.kind, week_start: semana,
    times_reported: o.veces ?? 1, status: o.status ?? 'open',
    decision: o.status && o.status !== 'open' && o.status !== 'in_progress' ? 'era_error' : null,
    last_reported_at: trx.raw(`now() - (? || ' minutes')::interval`, [o.hace ?? 0]),
    dedup_key: `${o.wh}|${o.kind}|${o.sku ?? o.code ?? o.nombre}|${semana}|${Math.random()}`,
  }).returning('id');
  return r.id;
}

/** Una fila de `kdii` en una sucursal, con su clave, nombre y (opcional) un código de barras. */
async function kdii(trx: Knex.Transaction, suc: string, sku: string, nombre: string, cols: Record<string, string> = {}): Promise<void> {
  await trx('kepler_ods.kdii').insert({ sucursal: suc, c1: sku, c2: nombre, ...cols });
}

/** El servicio con su base REAL: `tk.run` entrega la misma transacción. */
function servicio(trx: Knex.Transaction, alcance: 'all' | 'none' = 'all'): FloorStockoutsService {
  return new FloorStockoutsService(
    { run: async (fn: (t: Knex.Transaction) => unknown) => fn(trx) } as never,
    { requireTenantId: () => TENANT, get: () => ({ userId: null, username: 'prueba' }) } as never,
    {
      assertCanRead: async (_d: string, v: string) => {
        if (alcance === 'none') throw new ForbiddenException(`Tu alcance no incluye la sucursal "${v}".`);
      },
    } as never,
  );
}

/** Salta la prueba DICIENDO por qué. */
const sinBase = (ctx: { skip: (m?: string) => void }) => {
  if (!db) { console.warn(`  NO MEDIDO: ${motivoSinBase}`); ctx.skip(motivoSinBase); return true; }
  return false;
};

describe('[MOS.2] No registrados contra la base real', () => {
  it('junta las semanas, completa desde Kepler y saca sola lo que ya está en esa sucursal', async (ctx) => {
    if (sinBase(ctx)) return;
    await enTransaccion(async ({ trx, whA, whB }) => {
      const marca = await trx('catalog.brands').select('id').first();
      const [prov] = await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'ZTPRV', name: 'ZT PROVEEDOR' }).returning('id');
      await trx('catalog.products').insert({ tenant_id: TENANT, brand_id: marca.id, nombre: 'ZT CON PROVEEDOR', sku: 'ZT904', supplier_id: prov.id });

      // 1) No existe en ninguna sucursal, dos semanas, con lo que escribió la cajera.
      await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000099', veces: 2, semana: '2026-10-05' });
      await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000099', veces: 3, nombre: 'gomita roja', hace: 1 });
      // 2) No estaba en ninguna... y ya apareció en OTRA sucursal: se completa clave y nombre.
      await kdii(trx, whB.kepler, 'ZT902', 'ZT PRODUCTO EN B', { c7: '7509990000011' });
      await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000011' });
      // 3) Por clave, y ya la dieron de alta en ESA sucursal: sale sola.
      await kdii(trx, whA.kepler, 'ZT903', 'ZT YA DADO DE ALTA');
      await anotar(trx, { wh: whA.id, kind: 'no_en_sucursal', sku: 'ZT903' });
      // 4) Por código, ya en ESA sucursal por la casilla de la segunda unidad: sale sola.
      await kdii(trx, whB.kepler, 'ZT905', 'ZT CAJA EN B', { c82: '7509990000028' });
      await anotar(trx, { wh: whB.id, kind: 'no_en_catalogo', code: '7509990000028' });
      // 5) Con proveedor en la ficha.
      await anotar(trx, { wh: whA.id, kind: 'no_en_sucursal', sku: 'ZT904' });
      // 6) Negativos: atendido por Compras, y otro motivo.
      await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000035', status: 'resolved' });
      await anotar(trx, { wh: whA.id, kind: 'agotado', sku: 'ZT906' });

      const r = await servicio(trx).noRegistrados();
      const nuestros = r.filas.filter((f) => (f.sku ?? '').startsWith('ZT') || (f.scanned_code ?? '').startsWith('750999'));
      const de = (code: string) => nuestros.find((f) => f.scanned_code === code || f.sku === code);

      expect(nuestros).toHaveLength(3);
      expect(r.recortado).toBe(false);

      const nada = de('7509990000099');
      expect(nada?.veces).toBe(5);                       // las dos semanas, sumadas
      expect(nada?.sku).toBeNull();                      // no existe en Kepler: no hay clave
      expect(nada?.nombre).toBe('gomita roja');
      expect(nada?.nombre_escrito).toBe(true);
      expect(nada?.warehouse_code).toBe(whA.code);

      const enB = de('7509990000011');
      expect(enB?.sku).toBe('ZT902');                    // completado desde la otra sucursal
      expect(enB?.nombre).toBe('ZT PRODUCTO EN B');
      expect(enB?.nombre_escrito).toBe(false);

      expect(de('ZT904')?.proveedor).toBe('ZT PROVEEDOR');

      // Los que ya están en Kepler de su sucursal no aparecen.
      expect(de('ZT903')).toBeUndefined();
      expect(de('7509990000028')).toBeUndefined();
      // Ni lo atendido, ni otro motivo.
      expect(de('7509990000035')).toBeUndefined();
      expect(de('ZT906')).toBeUndefined();
    });
  });

  it('⛔ NEGATIVA: un código en OTRA sucursal no cuenta como dado de alta en ésta', async (ctx) => {
    if (sinBase(ctx)) return;
    await enTransaccion(async ({ trx, whA, whB }) => {
      await kdii(trx, whB.kepler, 'ZT907', 'ZT SOLO EN B');
      await anotar(trx, { wh: whA.id, kind: 'no_en_sucursal', sku: 'ZT907' });
      const r = await servicio(trx).noRegistrados();
      expect(r.filas.some((f) => f.sku === 'ZT907' && f.warehouse_code === whA.code)).toBe(true);

      // Y al darlo de alta en la A, sale.
      await kdii(trx, whA.kepler, 'ZT907', 'ZT SOLO EN B');
      const r2 = await servicio(trx).noRegistrados();
      expect(r2.filas.some((f) => f.sku === 'ZT907')).toBe(false);
    });
  });
});

describe('[MOS.3] La cajera describe un código que Kepler no tiene', () => {
  it('guarda el texto limpio y recortado, sin sumar un reporte', async (ctx) => {
    if (sinBase(ctx)) return;
    await enTransaccion(async ({ trx, whA }) => {
      const id = await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000042', veces: 2 });
      const largo = '  gomita   enchilada ' + 'x'.repeat(200);
      const r = await servicio(trx).describir(id, largo);
      expect(r.product_name).toHaveLength(DESCRIPCION_MAX);
      expect(r.product_name.startsWith('gomita enchilada x')).toBe(true);
      const fila = await trx('commercial.floor_stockouts').where({ id }).first();
      expect(fila.product_name).toBe(r.product_name);
      expect(fila.times_reported).toBe(2);             // no se sumó un reporte
    });
  });

  it('⛔ NEGATIVAS: texto vacío, otro motivo, fuera de la ventana, ya atendido y sin alcance', async (ctx) => {
    if (sinBase(ctx)) return;
    await enTransaccion(async ({ trx, whA }) => {
      const svc = servicio(trx);
      const ok = await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000059' });
      await expect(svc.describir(ok, '   ')).rejects.toBeInstanceOf(BadRequestException);

      const otro = await anotar(trx, { wh: whA.id, kind: 'no_en_sucursal', sku: 'ZT908' });
      await expect(svc.describir(otro, 'algo')).rejects.toBeInstanceOf(ConflictException);

      const viejo = await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000066', hace: 30 });
      await expect(svc.describir(viejo, 'algo')).rejects.toBeInstanceOf(ConflictException);

      const atendido = await anotar(trx, { wh: whA.id, kind: 'no_en_catalogo', code: '7509990000073', status: 'dismissed' });
      await expect(svc.describir(atendido, 'algo')).rejects.toBeInstanceOf(ConflictException);

      await expect(servicio(trx, 'none').describir(ok, 'algo')).rejects.toBeInstanceOf(ForbiddenException);
      const fila = await trx('commercial.floor_stockouts').where({ id: ok }).first();
      expect(fila.product_name).toBeNull();            // ningún intento rechazado escribió
    });
  });
});
