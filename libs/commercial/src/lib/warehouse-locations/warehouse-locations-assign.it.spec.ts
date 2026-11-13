/**
 * `[UB.3]` Prueba de INTEGRACIÓN de la asignación por producto y presentación: los endpoints que
 * ESCRIBEN (alta, cambio, quitar, Excel) con el código real del servicio y el payload de la pantalla,
 * contra un Postgres de verdad (regla 13 del repo).
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE. TODO dentro de una transacción que se
 * revierte; cada `tk.run` del servicio es un SAVEPOINT, como en la vida real cada llamada es su
 * propia transacción (un 23505 no envenena a las siguientes).
 *
 * La ficha de Kepler sembrada es la del caso medido en PH (70243, 2026-10-10): base PAQ · un
 * peldaño 2 «PAQ» sin factor (fantasma de captura) · CJA ×20. Lo que se espera ver es lo mismo que
 * vio Francisco en la maqueta: se ofrecen PAQ y CJA, nunca el fantasma.
 *
 * El almacén se llama `MD-97` con sucursal `97`: el caso Morelia, donde `code` ≠ clave del alcance.
 * El alcance de escritura se le pregunta a `canWrite` con la clave CANÓNICA o falla la prueba.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import type { BulkAssignmentInputRow } from '@megadulces/contracts';
import { WarehouseLocationsAssignService } from './warehouse-locations-assign.service';
import { WarehouseLocationsBulkService } from './warehouse-locations-bulk.service';
import { BinLocationService } from '../commercial-inventory/bin-location.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const USER = '00000000-0000-0000-0000-00000000b301';
const SUC = '97';
const SKU = 'UBIT70243';
const MIG = (f: string) => `../../../../../database/migrations-newdb/${f}`;
const MIGS = {
  ub1: MIG('20261008012049_ub1_ubicaciones_catalogo.js'),
  ub2: MIG('20261008040747_ub2_ubicaciones_captura_masiva.js'),
  ub3: MIG('20261010030108_ub3_ubicaciones_asignaciones.js'),
  escalera: MIG('20261106173448_pq87_ficha_peldanos_que_repiten_la_base.js'),
};
async function migUp(rel: string, trx: Knex.Transaction): Promise<void> {
  const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
  await m.up(trx);
}
const existe = async (trx: Knex.Transaction, obj: string) => !!(await trx.raw(`SELECT to_regclass(?) AS r`, [obj])).rows[0].r;

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[UB.3] NO MEDIDO: sin TP_IT_DB la prueba de integración de la asignación no corre.');

suite('[UB.3] Asignación por producto y presentación, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: WarehouseLocationsAssignService;
  let bulk: WarehouseLocationsBulkService;
  let bins: BinLocationService;
  /** Lo que el servicio le preguntó a `canWrite`: tiene que ser la clave canónica (`97`), no `MD-97`. */
  const preguntas: string[] = [];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    if (!(await existe(trx, 'kepler_ods.kdii'))) throw new Error('NO MEDIDO: la base no trae kepler_ods.kdii (el molde lo crea dev-bootstrap-empty-db).');
    // Lo que le falte a la base local se aplica DENTRO de la transacción y desaparece al revertir.
    if (!(await trx.schema.withSchema('commercial').hasColumn('warehouse_bins', 'familia'))) await migUp(MIGS.ub1, trx);
    if (!(await existe(trx, 'commercial.location_capture_batches'))) await migUp(MIGS.ub2, trx);
    if (!(await existe(trx, 'commercial.bin_assignments'))) await migUp(MIGS.ub3, trx);
    // La escalera VIGENTE (PQ.87), aunque la base traiga una versión anterior de la vista.
    await migUp(MIGS.escalera, trx);

    const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => trx.transaction((sp) => fn(sp)) };
    const tenantCtx = { requireTenantId: () => M, get: () => ({ tenantId: M, userId: USER }) };
    const scope = {
      warehouseIds: async () => null,
      current: async () => ({}),
      canWrite: (_r: unknown, _dim: string, valor: string) => { preguntas.push(valor); return valor === SUC; },
    };
    svc = new WarehouseLocationsAssignService(tk as never, tenantCtx as never, scope as never);
    bulk = new WarehouseLocationsBulkService(tk as never, tenantCtx as never, scope as never);
    bins = new BinLocationService(tk as never, tenantCtx as never);

    const [marca] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'UBIT DE LA ROSA' }).returning('id');
    const [p] = await trx('catalog.products').insert({ tenant_id: M, brand_id: marca.id, nombre: 'UBIT MAZAPAN DE LA ROSA 30P', sku: SKU }).returning('id');
    const [sinFicha] = await trx('catalog.products').insert({ tenant_id: M, brand_id: marca.id, nombre: 'UBIT SIN FICHA EN KEPLER', sku: 'UBIT-SINFICHA' }).returning('id');
    ids['producto'] = p.id;
    ids['sinFicha'] = sinFicha.id;
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: 'MD-97', name: 'UBIT Morelia prueba', kepler_code: SUC, wincaja_source_branch: SUC }).returning('id');
    const [otro] = await trx('commercial.warehouses').insert({ tenant_id: M, code: '96', name: 'UBIT Otra sucursal', kepler_code: '96' }).returning('id');
    ids['w'] = w.id;
    ids['otro'] = otro.id;
    // La ficha de Kepler del caso real: base PAQ ($30.45) · peldaño 2 «PAQ» sin factor ni costo · CJA ×20 ($609).
    await trx('kepler_ods.kdii').insert({
      sucursal: SUC, c1: SKU, c11: 'PAQ', c80: 'PAQ', c83: 'CJA', c84: 20, c77: '30.45', c79: 609,
      c7: '7501000111', c93: '7501000111', c85: '17501000111',
    });
    const [lote] = await trx('commercial.location_capture_batches').insert({ tenant_id: M, warehouse_id: w.id, kind: 'rango', params: {} }).returning('id');
    ids['lote'] = lote.id;
    const bin = (code: string, extra: Record<string, unknown> = {}) => ({
      tenant_id: M, warehouse_id: w.id, code, familia: 'ubicacion',
      zona: code[0], pasillo: code[1], rack: Number(code.slice(2, 4)), nivel: Number(code[4]), estado: 'activa', ...extra,
    });
    const filas = await trx('commercial.warehouse_bins')
      .insert([
        bin('BA053'), bin('BA052'), bin('BA054'), bin('TA021'), bin('BC022'),
        bin('BA061', { estado: 'baja', active: false, motivo_estado: 'UBIT rack desmontado' }),
        bin('BD011', { capture_batch_id: lote.id }),
      ])
      .returning(['id', 'code']);
    for (const f of filas as Array<{ id: string; code: string }>) ids[f.code] = f.id;
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('el detalle ofrece PAQ (base) y CJA ×20 — el peldaño fantasma no aparece, los códigos no se repiten', async () => {
    const d = await svc.detail(ids['w'], ids['producto']);
    expect(d.ficha_kepler).toBe(true);
    expect(d.presentaciones.map((p) => [p.peldano, p.rotulo, p.factor, p.es_caja])).toEqual([[1, 'PAQ', 1, false], [3, 'CJA', 20, true]]);
    expect(d.presentaciones[0].codigos).toEqual(['7501000111']);
    expect(d.presentaciones[1].codigos).toEqual(['17501000111', `C${SKU}`]);
    expect(d.asignaciones).toEqual([]);
  });

  it('alta: CJA en lugar fijo BA053 con mín 4 / máx 12 (payload de la pantalla); el alcance se pregunta con la clave 97', async () => {
    preguntas.length = 0;
    const a = await svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 3, papel: 'surtido_fijo', bin_code: 'ba053', min_qty: 4, max_qty: 12 });
    expect(a).toMatchObject({ code: 'BA053', presentacion: 3, presentacion_rotulo: 'CJA', papel: 'surtido_fijo', min_qty: 4, max_qty: 12, estado: 'activa' });
    expect(preguntas).toEqual([SUC]);
    ids['cajaFija'] = a.id;
  });

  it('⛔ un segundo lugar fijo para la misma presentación: 409 en claro, no 500', async () => {
    await expect(svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 3, papel: 'surtido_fijo', bin_code: 'BA054', min_qty: null, max_qty: null }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/ya tiene lugar fijo/i) });
  });

  it('⛔ lugar fijo en una ubicación de TIENDA: 400 por zona', async () => {
    await expect(svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 1, papel: 'surtido_fijo', bin_code: 'TA021', min_qty: null, max_qty: null }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/bodega/) });
  });

  it('⛔ la presentación fantasma (peldaño 2) no se puede asignar', async () => {
    await expect(svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 2, papel: 'reserva_preferida', bin_code: 'BC022', min_qty: null, max_qty: null }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no tiene la presentación 2/) });
  });

  it('⛔ una ubicación dada de baja no recibe asignaciones', async () => {
    await expect(svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 1, papel: 'reserva_preferida', bin_code: 'BA061', min_qty: null, max_qty: null }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/dada de baja/) });
  });

  it('⛔ mínimo mayor que máximo: 400 antes de tocar la base', async () => {
    await expect(svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 1, papel: 'surtido_fijo', bin_code: 'BA052', min_qty: 30, max_qty: 10 }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no puede pasar del máximo/) });
  });

  it('⛔ PRUEBA NEGATIVA del alcance: sin escritura en esa sucursal, 403 con su nombre', async () => {
    await expect(svc.create({ warehouse_id: ids['otro'], product_id: ids['producto'], presentacion: 1, papel: 'surtido_fijo', bin_code: 'BA052', min_qty: null, max_qty: null }))
      .rejects.toMatchObject({ status: 403, message: expect.stringMatching(/UBIT Otra sucursal/) });
  });

  it('exhibición del PAQ en tienda, sin mínimo ni máximo', async () => {
    const a = await svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 1, papel: 'exhibicion_tienda', bin_code: 'TA021', min_qty: null, max_qty: null });
    expect(a).toMatchObject({ code: 'TA021', presentacion: 1, presentacion_rotulo: 'PAQ', min_qty: null, max_qty: null });
    ids['exhibicion'] = a.id;
  });

  it('cambiar SÓLO la ubicación conserva mínimo y máximo', async () => {
    const a = await svc.update(ids['cajaFija'], { bin_code: 'BA052' });
    expect(a).toMatchObject({ code: 'BA052', min_qty: 4, max_qty: 12 });
  });

  it('la lista cuenta sobre el universo con ficha en Kepler y un lugar fijo dado de baja NO cuenta', async () => {
    const l = await svc.products(ids['w'], 'UBIT', 'todos', 50, 0);
    expect(l).toMatchObject({ ficha_kepler: true, universo: 1, total: 1, sin_ubicacion: 0 });
    expect(l.filas.map((f) => [f.sku, f.surtido_fijo, f.asignaciones])).toEqual([[SKU, ['BA052'], 2]]);
    await trx('commercial.warehouse_bins').where({ id: ids['BA052'] }).update({ estado: 'baja', active: false, motivo_estado: 'UBIT prueba' });
    try {
      const sin = await svc.products(ids['w'], 'UBIT', 'sin_ubicacion', 50, 0);
      expect(sin).toMatchObject({ universo: 1, total: 1, sin_ubicacion: 1 });
      expect(sin.filas[0].surtido_fijo).toEqual([]);
    } finally {
      await trx('commercial.warehouse_bins').where({ id: ids['BA052'] }).update({ estado: 'activa', active: true, motivo_estado: null });
    }
  });

  const archivo: BulkAssignmentInputRow[] = [
    // Mueve la CJA de BA052 a BA054 con mín/máx VACÍOS: se conservan 4/12, no se borran.
    { fila: 2, sku: SKU, presentacion: 'caja', ubicacion: 'BA054', papel: 'surtido', min: '', max: '' },
    { fila: 3, sku: SKU, presentacion: 'paquete', ubicacion: 'BA053', papel: 'surtido', min: 10, max: 30 },
    { fila: 4, sku: SKU, presentacion: 'paquete', ubicacion: 'BA053', papel: 'surtido', min: 10, max: 30 },
    { fila: 5, sku: 'UBIT-NOEXISTE', presentacion: 'caja', ubicacion: 'BA053', papel: 'surtido', min: '', max: '' },
    { fila: 6, sku: SKU, presentacion: 'caja', ubicacion: 'BC022', papel: 'reserva', min: '', max: '' },
    { fila: 7, sku: SKU, presentacion: 'paquete', ubicacion: 'TA021', papel: 'exhibición', min: '', max: '' },
  ];

  it('Excel, vista previa: nueva / cambia (conserva mín-máx) / repetida / error / ya está así', async () => {
    const p = await svc.bulkPreview({ warehouse_id: ids['w'], filas: archivo, archivo: 'ubit.xlsx' });
    expect(p.conteo).toEqual({ nueva: 2, cambia: 1, igual: 1, repetida: 1, error: 1 });
    const f2 = p.filas.find((f) => f.fila === 2)!;
    expect(f2).toMatchObject({ accion: 'cambia', min_qty: 4, max_qty: 12 });
    expect(f2.motivo).toMatch(/Se mueve de BA052 a BA054.*se conservan/);
    expect(p.filas.find((f) => f.fila === 5)).toMatchObject({ accion: 'error', motivo: expect.stringMatching(/No existe el producto/) });
  });

  it('Excel, aplicar: escribe lo mismo que prometió la vista previa', async () => {
    const r = await svc.bulkApply({ warehouse_id: ids['w'], filas: archivo, archivo: 'ubit.xlsx' });
    expect(r).toEqual({ creadas: 2, actualizadas: 1, omitidas: 3 });
    const d = await svc.detail(ids['w'], ids['producto']);
    const vista = d.asignaciones.map((a) => [a.papel, a.presentacion, a.code, a.min_qty, a.max_qty]).sort();
    expect(vista).toEqual([
      ['exhibicion_tienda', 1, 'TA021', null, null],
      ['reserva_preferida', 3, 'BC022', null, null],
      ['surtido_fijo', 1, 'BA053', 10, 30],
      ['surtido_fijo', 3, 'BA054', 4, 12],
    ]);
    // La foto del rótulo es el de KEPLER (CJA), no lo que se tecleó (caja).
    expect(d.asignaciones.find((a) => a.code === 'BC022')?.presentacion_rotulo).toBe('CJA');
  });

  it('⛔ aplicar el mismo archivo otra vez no hace nada y lo dice', async () => {
    await expect(svc.bulkApply({ warehouse_id: ids['w'], filas: archivo, archivo: 'ubit.xlsx' }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/No hay nada/) });
  });

  it('quitar no borra: queda con quién y cuándo, y sale del detalle', async () => {
    await expect(svc.remove(ids['exhibicion'])).resolves.toEqual({ id: ids['exhibicion'], quitada: true });
    const fila = await trx('commercial.bin_assignments').where({ id: ids['exhibicion'] }).first('deleted_at', 'deleted_by');
    expect(fila.deleted_at).not.toBeNull();
    expect(fila.deleted_by).toBe(USER);
    const d = await svc.detail(ids['w'], ids['producto']);
    expect(d.asignaciones.some((a) => a.id === ids['exhibicion'])).toBe(false);
  });

  it('una asignación a un peldaño que Kepler ya no ofrece llega en el detalle (la pantalla la muestra como «ya no está en Kepler»)', async () => {
    await trx('commercial.bin_assignments').insert({ tenant_id: M, warehouse_id: ids['w'], product_id: ids['producto'], bin_id: ids['BA053'], presentacion: 2, presentacion_rotulo: 'PAQ', papel: 'exhibicion_tienda' });
    const d = await svc.detail(ids['w'], ids['producto']);
    expect(d.presentaciones.some((p) => p.peldano === 2)).toBe(false);
    expect(d.asignaciones.filter((a) => a.presentacion === 2).map((a) => a.code)).toEqual(['BA053']);
  });

  it('⛔ borrar una ubicación con productos asignados (vivos o ya quitados): 409 en claro', async () => {
    await expect(bins.deleteBin(ids['BC022'])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/productos asignados/) });
    await expect(bins.deleteBin(ids['TA021'])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/productos asignados/) });
  });

  it('el historial de capturas cuenta como «en uso» la ubicación con producto asignado (no sólo con mercancía)', async () => {
    const antes = (await bulk.batches(ids['w'])).find((b) => b.id === ids['lote']);
    expect(antes?.en_uso).toBe(0);
    await svc.create({ warehouse_id: ids['w'], product_id: ids['producto'], presentacion: 1, papel: 'reserva_preferida', bin_code: 'BD011', min_qty: null, max_qty: null });
    const despues = (await bulk.batches(ids['w'])).find((b) => b.id === ids['lote']);
    expect(despues?.en_uso).toBe(1);
  });

  it('un producto sin ficha de Kepler en la sucursal no entra al universo ni tiene presentaciones', async () => {
    const d = await svc.detail(ids['w'], ids['sinFicha']);
    expect(d).toMatchObject({ ficha_kepler: false, presentaciones: [] });
    const l = await svc.products(ids['w'], 'UBIT SIN FICHA', 'todos', 50, 0);
    expect(l.universo).toBe(0);
  });
});
