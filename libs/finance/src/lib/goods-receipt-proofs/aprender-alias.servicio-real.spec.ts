import knexFactory, { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';
import { rfcsDelProveedor } from './fuente-renglones';

/**
 * `[RE.53]` Aprender una equivalencia escribe en `commercial.supplier_item_aliases`: regla 13, el
 * camino que escribe no está probado sin una base REAL.
 *
 *     CAJA_TEST_DB_URL=<la URL de la base de prueba, como app_runtime> \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/goods-receipt-proofs/aprender-alias.servicio-real.spec.ts
 *
 * El caso que la trae: `created_by`/`updated_by` son `uuid` y RE.11.4 les pasaba el NOMBRE de la
 * persona — en prod la tabla tiene 0 filas desde que existe. La NEGATIVA de abajo reproduce ese
 * INSERT y tiene que fallar; si deja de fallar, la prueba ya no distingue el arreglo.
 *
 * ⚠️ Sin `CAJA_TEST_DB_URL` se SALTA y lo dice. Escribe y no deshace: sólo contra una base de
 *    prueba. Cada corrida usa su propio RFC.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = '00000000-0000-0000-0000-00000000d01c';
const RFC = `PRB${Date.now().toString(36).toUpperCase()}`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[RE.53] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual probar que la equivalencia se guarda.');
}

describe.skipIf(!URL)('[RE.53] aprender una equivalencia — base real', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: GoodsReceiptProofsService;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    // Sólo se ejercita el camino de la base; el resto de las dependencias no se toca.
    const nada = undefined as never;
    svc = new GoodsReceiptProofsService(tk, ctx, nada, nada, nada, nada, nada, nada);
  });
  afterAll(async () => { await knex?.destroy(); });

  it('NEGATIVA (el defecto de RE.11.4): un nombre en created_by uuid NO se puede insertar', async () => {
    await expect(tk.run((trx) => trx.raw(
      `INSERT INTO commercial.supplier_item_aliases (tenant_id, proveedor_rfc, descripcion_norm, sku, created_by)
       VALUES (public.current_tenant_id(), ?, 'negativa', 'X', ?)`, [RFC, 'Nombre De Persona']))).rejects.toThrow(/uuid/i);
  });

  it('el upsert del aprendizaje guarda y, al repetirse, refuerza en vez de duplicar', async () => {
    const a = { descripcion: 'RED COLA 24/400', sku: 'S400', nombre_interno: 'RED COLA 400ML AGA', unidad_proveedor: 'CJ', box_factor: 24 };
    type ConUpsert = { upsertAlias: (trx: Knex.Transaction, rfc: string, x: typeof a) => Promise<{ sku: string; veces_confirmado: number; confianza: string }> };
    const up = (x: typeof a) => tk.run((trx) => (svc as unknown as ConUpsert).upsertAlias(trx, RFC, x));

    const r1 = await up(a);
    expect(r1).toMatchObject({ sku: 'S400', veces_confirmado: 1 });
    const r2 = await up(a);
    expect(Number(r2.veces_confirmado)).toBe(2);
    expect(Number(r2.confianza)).toBeCloseTo(0.8, 5);

    const filas = await tk.run((trx) => trx('commercial.supplier_item_aliases')
      .where({ proveedor_rfc: RFC, descripcion_norm: 'red cola 24 400' }).whereNull('deleted_at')
      .select('sku', 'box_factor', 'unidad_proveedor', 'created_by', 'tenant_id'));
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ sku: 'S400', unidad_proveedor: 'CJ', created_by: null, tenant_id: T });
    expect(Number(filas[0].box_factor)).toBe(24);
  });

  // `[PQ.148]` El código del proveedor como segunda llave (mig 20261124210829).
  type ConCodigo = { descripcion: string; sku: string; nombre_interno: string | null; unidad_proveedor: string | null; box_factor: number | null; codigo_proveedor: string | null };
  type UpsertCod = { upsertAlias: (trx: Knex.Transaction, rfc: string, x: ConCodigo) => Promise<{ sku: string; veces_confirmado: number }> };
  const upCod = (x: ConCodigo) => tk.run((trx) => (svc as unknown as UpsertCod).upsertAlias(trx, RFC, x));
  const filasDe = (where: Record<string, string>) => tk.run((trx) => trx('commercial.supplier_item_aliases')
    .where({ proveedor_rfc: RFC, ...where }).whereNull('deleted_at').select('descripcion_norm', 'codigo_proveedor', 'sku', 'veces_confirmado'));

  it('[PQ.148] el código refuerza SU equivalencia aunque la descripción cambie de una factura a otra', async () => {
    const base: ConCodigo = { descripcion: 'RED COLA 24/400 PET', sku: 'S400', nombre_interno: null, unidad_proveedor: 'CJ', box_factor: 24, codigo_proveedor: ' aga-400 ' };
    expect(await upCod(base)).toMatchObject({ sku: 'S400', veces_confirmado: 1 });
    const r2 = await upCod({ ...base, descripcion: 'REFRESCO RED COLA 400 ML C/24' });
    expect(Number(r2.veces_confirmado)).toBe(2);
    const filas = await filasDe({ codigo_proveedor: 'AGA-400' });
    expect(filas).toHaveLength(1);
    // La descripción con que se aprendió se queda: la llave que encontró la fila fue el código.
    expect(filas[0].descripcion_norm).toBe('red cola 24 400 pet');
    // CONTROL: la descripción nueva NO creó otra fila.
    expect(await filasDe({ descripcion_norm: 'refresco red cola 400 ml c 24' })).toHaveLength(0);
  });

  it('[PQ.148] una equivalencia sin código gana el suyo; uno DISTINTO que ya traía no se pisa', async () => {
    const x: ConCodigo = { descripcion: 'SQUIRT 9/2.0 TOR', sku: 'Q2L', nombre_interno: null, unidad_proveedor: 'CJ', box_factor: 9, codigo_proveedor: null };
    await upCod(x);
    expect((await filasDe({ descripcion_norm: 'squirt 9 2 0 tor' }))[0].codigo_proveedor).toBeNull();
    await upCod({ ...x, codigo_proveedor: 'AGA-SQ2' });
    expect((await filasDe({ descripcion_norm: 'squirt 9 2 0 tor' }))[0].codigo_proveedor).toBe('AGA-SQ2');
    await upCod({ ...x, codigo_proveedor: 'AGA-OTRO' });
    const f = await filasDe({ descripcion_norm: 'squirt 9 2 0 tor' });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ codigo_proveedor: 'AGA-SQ2', veces_confirmado: 3 });
  });

  it('[PQ.148] NEGATIVA: la base no deja dos equivalencias vivas con el mismo código del proveedor', async () => {
    const ins = (desc: string) => tk.run((trx) => trx.raw(
      `INSERT INTO commercial.supplier_item_aliases (tenant_id, proveedor_rfc, descripcion_norm, sku, codigo_proveedor)
       VALUES (public.current_tenant_id(), ?, ?, 'X', 'AGA-DOBLE')`, [RFC, desc]));
    await ins('doble uno');
    await expect(ins('doble dos')).rejects.toThrow(/uq_supplier_item_alias_codigo|duplicate|duplicad/i);
  });

  it('el endpoint de confirmar (RE.11.4) ya guarda con el nombre de quien confirma', async () => {
    const r = await svc.confirmLineMatch({ proveedor_rfc: RFC, descripcion: 'SQUIRT 9/2.0', sku: 'Q2L', unidad_proveedor: 'cj', box_factor: 9 }, 'Nombre De Persona');
    expect(r).toMatchObject({ sku: 'Q2L', veces_confirmado: 1 });
  });

  // `[PQ.150]` segundo tramo: lo aprendido se busca con el RFC de la factura Y el del acreedor en Kepler.
  type Equivalencias = { aliasMap: Map<string, { sku: string }>; aliasPorCodigo: Map<string, { sku: string }>; historiaPorCodigo: Map<string, { sku: string }> };
  type ConEquivalencias = { equivalenciasDe: (trx: Knex.Transaction, tenantId: string, quien: ReturnType<typeof rfcsDelProveedor>) => Promise<Equivalencias> };
  const equivalencias = (kepler: string | null, factura: string | null) =>
    tk.run((trx) => (svc as unknown as ConEquivalencias).equivalenciasDe(trx, T, rfcsDelProveedor(kepler, factura)));

  it('[PQ.150] se busca con los dos RFC y, si los dos traen el mismo código, gana el de la factura', async () => {
    const K = `K${RFC}`, F = `F${RFC}`;
    const con = (rfc: string, descripcion: string, sku: string, codigo: string) => tk.run((trx) =>
      (svc as unknown as UpsertCod).upsertAlias(trx, rfc, { descripcion, sku, nombre_interno: null, unidad_proveedor: null, box_factor: null, codigo_proveedor: codigo }));
    // El mismo código en los dos RFC, insertado en órdenes OPUESTOS: sin la precedencia, el que gana depende del
    // orden en que la base devuelve las filas, y con un solo orden la prueba podía pasar por suerte (pasó: un
    // mutante sin precedencia sobrevivió una corrida). Con los dos órdenes, uno de los dos falla sin ella.
    await con(K, 'GOMITA X KEPLER', 'SK', 'CODX');
    await con(F, 'GOMITA X FACTURA', 'SF', 'CODX');
    await con(F, 'GOMITA Y FACTURA', 'SFY', 'CODY');
    await con(K, 'GOMITA Y KEPLER', 'SKY', 'CODY');
    await con(K, 'SOLO EN KEPLER', 'SK2', 'CODK');
    await con(F, 'SOLO EN FACTURA', 'SF2', 'CODF');

    const ambos = await equivalencias(K, F);
    expect(ambos.aliasPorCodigo.get('CODX')?.sku).toBe('SF');
    expect(ambos.aliasPorCodigo.get('CODY')?.sku).toBe('SFY');
    expect(ambos.aliasPorCodigo.get('CODK')?.sku).toBe('SK2');
    expect(ambos.aliasPorCodigo.get('CODF')?.sku).toBe('SF2');
    expect(ambos.aliasMap.get('solo en kepler')?.sku).toBe('SK2');

    // CONTROL: sin factura ligada, como antes (sólo lo del RFC de Kepler).
    const soloKepler = await equivalencias(K, null);
    expect(soloKepler.aliasPorCodigo.get('CODX')?.sku).toBe('SK');
    expect(soloKepler.aliasPorCodigo.get('CODY')?.sku).toBe('SKY');
    expect(soloKepler.aliasPorCodigo.has('CODF')).toBe(false);

    // El acreedor sin RFC en Kepler (42 % de las entradas): antes no buscaba nada; con la factura, encuentra.
    expect((await equivalencias('', null)).aliasPorCodigo.size).toBe(0);
    const sinRfc = await equivalencias('', F);
    expect(sinRfc.aliasPorCodigo.get('CODX')?.sku).toBe('SF');
    expect(sinRfc.aliasPorCodigo.has('CODK')).toBe(false);
  });

  it('[PQ.150] si la vista de historia no se puede leer, la conciliación sigue sin ella (savepoint): no tumba la transacción', async () => {
    const r = await tk.run(async (trx) => {
      const eq = await (svc as unknown as ConEquivalencias).equivalenciasDe(trx, T, rfcsDelProveedor(null, `F${RFC}`));
      // La transacción sigue viva después del intento: otra consulta funciona.
      const vivo = (await trx.raw('SELECT 1 AS uno')).rows[0].uno;
      return { historia: eq.historiaPorCodigo.size, vivo, vista: (await trx.raw(`SELECT to_regclass('commercial.v_supplier_item_code_history') AS v`)).rows[0].v };
    });
    expect(r.vivo).toBe(1);
    // En la base del CI la vista no existe (no tiene ODS): 0 propuestas de historia, sin error.
    if (r.vista === null) expect(r.historia).toBe(0);
  });
});
