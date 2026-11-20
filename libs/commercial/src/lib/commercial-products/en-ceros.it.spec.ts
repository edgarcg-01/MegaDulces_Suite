/**
 * `[CAT-PRECIO.6]` Prueba de INTEGRACIÓN de Mantenimiento · **Costo o precio en cero**: el servicio REAL
 * (`PreciosCatalogoService.enCeros`) corre `EN_CEROS_SQL` contra Postgres real, como `app_runtime`, con fichas de Kepler
 * (`kepler_ods.kdii`) sembradas. Lo que fija:
 *  - costo VACÍO y costo CERO en la base se marcan, cada uno con su nombre;
 *  - el precio en cero se marca;
 *  - una segunda unidad rotulada con factor 0 (costo y precio 0 por construcción) NO es un error;
 *  - una ficha sana no aparece (control);
 *  - una sucursal que no vende al público no cuenta;
 *  - el filtro por lo que está en cero y el resumen cuadran; no viaja ningún costo con valor.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`). Sin la
 * variable se salta y lo DICE. TODO dentro de una transacción que se revierte.
 */
import knexFactory, { type Knex } from 'knex';
import type { RespuestaEnCeros } from '@megadulces/contracts';
import { PreciosCatalogoService } from './precios-catalogo.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const A = '93'; // vende al público
const B = '94'; // vende al público
const X = '92'; // NO vende al público

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[CAT-PRECIO.6] NO MEDIDO: sin TP_IT_DB la prueba de integración de «en ceros» no corre.');

suite('[CAT-PRECIO.6] costo o precio en cero, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: PreciosCatalogoService;
  const fila = (r: RespuestaEnCeros, sku: string) => r.filas.find((f) => f.sku === sku);

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    // Sólo las sucursales de la prueba venden al público dentro de la transacción: el resultado no depende de la base.
    await trx('commercial.warehouses').update({ sells_to_public: false });
    await trx('commercial.warehouses').insert([
      { tenant_id: M, code: 'IT-93', name: 'IT Sucursal A', kepler_code: A, sells_to_public: true },
      { tenant_id: M, code: 'IT-94', name: 'IT Sucursal B', kepler_code: B, sells_to_public: true },
      { tenant_id: M, code: 'IT-92', name: 'IT Almacén X', kepler_code: X, sells_to_public: false },
    ]);
    const kdii = (suc: string, sku: string, c: Record<string, string | number | null>) =>
      trx('kepler_ods.kdii').insert({ sucursal: suc, c1: sku, c2: `IT ${sku}`, c3: 'L1', c11: 'PZA', c77: '10.00', c90: 12, c80: '', c81: 0, c83: '', c84: 0, ...c });
    await trx('kepler_ods.kdig').insert([{ sucursal: A, c1: 'L1', c2: 'LINEA IT' }, { sucursal: B, c1: 'L1', c2: 'LINEA IT' }]);
    await kdii(A, 'IT6SANO', {});                                  // control: sano en las dos
    await kdii(B, 'IT6SANO', {});
    await kdii(A, 'IT6VACIO', { c77: '' });                        // costo vacío en A; sano en B
    await kdii(B, 'IT6VACIO', {});
    await kdii(A, 'IT6CERO', { c77: '0', c90: 0 });                // costo 0 y precio 0 en A
    await kdii(A, 'IT6CAJA', { c80: 'CJA', c81: 10, c78: 0, c91: 0 }); // la caja en uso con costo y precio 0
    await kdii(A, 'IT6ROT', { c80: 'CJA', c81: 0, c78: 0, c91: 0 });   // caja rotulada con factor 0: NO es error
    await kdii(X, 'IT6SOLOX', { c77: '' });                        // sólo en una sucursal que no vende al público
    await trx.raw('SET LOCAL ROLE app_runtime');
    const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) };
    svc = new PreciosCatalogoService(tk as never, {} as never, { get: () => ({ roleName: 'compras' }) } as never);
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('marca costo vacío y costo cero con su nombre, el precio en cero, y la caja EN USO', async () => {
    const r = await svc.enCeros();
    expect(fila(r, 'IT6VACIO')).toMatchObject({
      plazas: 2, falta: ['costo'], linea: { codigo: 'L1', nombre: 'LINEA IT' },
      ceros: [{ sucursal: A, sucursal_nombre: 'IT Sucursal A', unidad: 'PZA', costo: 'vacio', precio_cero: false }],
    });
    expect(fila(r, 'IT6CERO')).toMatchObject({ falta: ['costo', 'precio'], ceros: [{ unidad: 'PZA', costo: 'cero', precio_cero: true }] });
    expect(fila(r, 'IT6CAJA')).toMatchObject({ falta: ['costo', 'precio'], ceros: [{ unidad: 'CJA', costo: 'cero', precio_cero: true }] });
  });

  it('NEGATIVA: la ficha sana, la caja rotulada con factor 0 y la sucursal que no vende al público no aparecen', async () => {
    const r = await svc.enCeros();
    expect(fila(r, 'IT6SANO')).toBeUndefined();
    expect(fila(r, 'IT6ROT')).toBeUndefined();
    expect(fila(r, 'IT6SOLOX')).toBeUndefined();
    expect(r.con_cero).toBe(3);
    expect(r.resumen).toEqual({ costo: 3, precio: 2 });
  });

  it('el filtro por lo que está en cero y la búsqueda cuadran con el resumen', async () => {
    expect((await svc.enCeros({ falta: 'precio' })).filas.map((f) => f.sku).sort()).toEqual(['IT6CAJA', 'IT6CERO']);
    const q = await svc.enCeros({ q: 'vacio' });
    expect(q.filas.map((f) => f.sku)).toEqual(['IT6VACIO']);
    expect(q.resumen).toEqual({ costo: 1, precio: 0 });
  });

  it('no viaja ningún costo con valor: sólo qué está en cero', async () => {
    const r = await svc.enCeros();
    expect(JSON.stringify(r.filas)).not.toContain('10');
    for (const f of r.filas) {
      for (const z of f.ceros) {
        expect(Object.keys(z).sort()).toEqual(['costo', 'precio_cero', 'sucursal', 'sucursal_nombre', 'unidad']);
        expect([null, 'cero', 'vacio']).toContain(z.costo);
      }
    }
  });
});
