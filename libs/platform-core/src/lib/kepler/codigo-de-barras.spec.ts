import knexFactory from 'knex';
import { describe, expect, it } from 'vitest';
import { orPorCodigoDeBarras, sqlSkuPorCodigoDeBarras } from './codigo-de-barras';

// `[BU.4.2]` La forma del SQL. Que ENCUENTRA se midió contra prod en sólo lectura (2026-11-14,
// system_identifier 7688376744939610156): EAN en c7 → 00066 · sólo en c102 → 08090 · C00066 → 00066 ·
// 7500000000000 → nada · «gomitas» → sin rama (1 ms). Un doble de knex no ejecuta SQL: esto prueba la
// forma y los bindings, no el resultado.
const knex = knexFactory({ client: 'pg' });

describe('sqlSkuPorCodigoDeBarras [BU.4.2]', () => {
  it('un nombre, una clave de 5 dígitos o vacío NO agregan nada', () => {
    for (const t of ['gomitas', 'coca 600', '00066', '', null, undefined]) {
      expect(sqlSkuPorCodigoDeBarras('p.sku', t)).toBeNull();
    }
  });

  it('un EAN busca en el índice GIN y en c102, con el código limpio en ambos', () => {
    const q = sqlSkuPorCodigoDeBarras('p.sku', ' 7501079221165 ')!;
    expect(q.sql).toContain('btrim(p.sku) = ANY(ARRAY(');
    expect(q.sql).toContain('ARRAY[btrim(k.c1), btrim(k.c7), btrim(k.c82), btrim(k.c93), btrim(k.c95), btrim(k.c96), btrim(k.c85)] @> ARRAY[?::text]');
    expect(q.sql).toContain('btrim(k.c102) = ?');
    expect(q.bindings).toEqual(['7501079221165', '7501079221165']);
    expect(q.sql.split('?').length - 1).toBe(q.bindings.length);
  });

  it('con sucursal la filtra en las dos ramas', () => {
    const q = sqlSkuPorCodigoDeBarras('v.sku', '7501079221165', '01')!;
    expect(q.bindings).toEqual(['7501079221165', '01', '7501079221165', '01']);
    expect(q.sql.split('?').length - 1).toBe(q.bindings.length);
  });

  it('la etiqueta de caja C + clave es la clave (Kepler no la guarda: la arma al imprimir)', () => {
    const q = sqlSkuPorCodigoDeBarras('p.sku', 'c00066')!;
    expect(q.bindings).toEqual(['C00066', 'C00066', '00066']);
    expect(q.sql.split('?').length - 1).toBe(q.bindings.length);
  });

  it('⛔ una columna que no es identificador se rechaza (no se pega SQL)', () => {
    expect(() => sqlSkuPorCodigoDeBarras('p.sku); drop table x; --', '7501079221165')).toThrow(/columna inválida/);
  });
});

describe('orPorCodigoDeBarras [BU.4.2]', () => {
  it('queda (palabras) OR (código) dentro del grupo, no palabras AND código', () => {
    const sql = knex('catalog.products as p')
      .where((g) => {
        g.where('p.nombre', 'ilike', '%x%');
        orPorCodigoDeBarras(g, 'p.sku', '7501079221165');
      })
      .toSQL().sql;
    expect(sql).toMatch(/where \("p"\."nombre" ilike \? or btrim\(p\.sku\) = ANY/);
  });

  it('con un nombre el grupo queda igual que antes', () => {
    const antes = knex('catalog.products as p').where((g) => { g.where('p.nombre', 'ilike', '%x%'); }).toSQL().sql;
    const despues = knex('catalog.products as p').where((g) => { g.where('p.nombre', 'ilike', '%x%'); orPorCodigoDeBarras(g, 'p.sku', 'gomitas'); }).toSQL().sql;
    expect(despues).toBe(antes);
  });
});

describe('variantes [BU.4.2]', () => {
  it('nombrada: cada ? pasa a :prefijo_n con su valor, y knex la acepta', async () => {
    const { sqlSkuPorCodigoDeBarrasNombrado } = await import('./codigo-de-barras');
    const q = sqlSkuPorCodigoDeBarrasNombrado('pr.sku', 'C00066', 'cb')!;
    expect(q.sql).not.toContain('?');
    expect(q.binds).toEqual({ cb_0: 'C00066', cb_1: 'C00066', cb_2: '00066' });
    const sql = knex.raw(`SELECT 1 FROM catalog.products pr WHERE (pr.nombre ILIKE :s OR ${q.sql})`, { s: '%x%', ...q.binds }).toSQL();
    expect(sql.bindings).toEqual(['%x%', 'C00066', 'C00066', '00066']);
    expect(sqlSkuPorCodigoDeBarrasNombrado('pr.sku', 'gomitas')).toBeNull();
  });

  it('applySmartSearchConCodigo: con código queda (palabras) OR (código); con nombre, igual que applySmartSearch', async () => {
    const { applySmartSearchConCodigo } = await import('./codigo-de-barras');
    const { applySmartSearch } = await import('../search/smart-search');
    const conCodigo = knex('catalog.products as p').where('p.activo', true);
    applySmartSearchConCodigo(conCodigo, '7501079221165', { columns: ['p.nombre', 'p.sku'], fuzzy: false }, 'p.sku');
    expect(conCodigo.toSQL().sql).toMatch(/where "p"\."activo" = \? and \(\(.*\) or btrim\(p\.sku\) = ANY/);

    const nuevo = knex('catalog.products as p');
    applySmartSearchConCodigo(nuevo, 'gomitas rojas', { columns: ['p.nombre', 'p.sku'], fuzzy: false }, 'p.sku');
    const viejo = knex('catalog.products as p');
    applySmartSearch(viejo, 'gomitas rojas', { columns: ['p.nombre', 'p.sku'], fuzzy: false });
    expect(nuevo.toSQL().sql).toBe(viejo.toSQL().sql);
  });
});
