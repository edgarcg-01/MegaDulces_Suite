import knexFactory from 'knex';
import { Permission } from '@megadulces/platform-core';
import {
  armarUltimoCosto,
  armarUnidades,
  costoSinImpuestos,
  type EntradaCruda,
  type UnidadPrecio,
} from './catalogo-ficha';
import { ENTRADAS_XA20, ULTIMAS_ENTRADAS_SQL } from './catalogo-ficha.sql';
import { CatalogoFichaService, puedeVerCostoCatalogo } from './catalogo-ficha.service';
import { CatalogoDetalladoService } from './catalogo-detallado.service';

/**
 * `[PF.12.3]` El último costo de compra en el catálogo Sencillo: sin impuestos, en cada unidad, «Sin compras»
 * en vez de $0, «Precio bajo costo» y una sola consulta por página.
 */

const db = knexFactory({ client: 'pg' });

const entrada = (over: Partial<EntradaCruda> = {}): EntradaCruda => ({
  sucursal: '08', fecha: '2026-10-08', unidad: 'PAQ', cantidad: '1600', costo: '69.98', iva: '0', ieps: '8', ...over,
});

const u = (unidad: string, factorBase: number, precio: number | null): UnidadPrecio => ({
  unidad, factorBase, precio, mayoreo: null, equivale: factorBase === 1 ? null : { cantidad: factorBase, unidad: 'BASE' },
});

describe('costoSinImpuestos — el signo de la tasa del renglón decide si c12 trae el impuesto', () => {
  it('tasa positiva: c12 ya es neto (el documento suma el impuesto aparte)', () => {
    expect(costoSinImpuestos('69.98', '0', '8')).toEqual({ costo: 69.98, impuesto: 'neto', conImpuestos: 1.08 });
    expect(costoSinImpuestos('43.1035', '16', '0')).toMatchObject({ costo: 43.1035, impuesto: 'neto' });
  });

  it('⭐ tasa negativa: c12 TRAE el impuesto y se le quita (casos medidos en la base local)', () => {
    // 63018: el mismo costo de lista en las dos convenciones — 56.8942 con −8 y 52.68 con +8.
    const r = costoSinImpuestos('56.8942', '0', '-8');
    expect(r).toMatchObject({ impuesto: 'descontado', conImpuestos: 1.08 });
    expect(r.costo).toBeCloseTo(52.68, 3);
    // 17085: 29-jun $55.00 con −16 → 30-jun $47.41 con +16.
    expect(costoSinImpuestos('55.00', '-16', '0').costo).toBeCloseTo(47.41, 2);
    // Las dos incluidas: IEPS sobre la base e IVA sobre (base + IEPS).
    expect(costoSinImpuestos(String(100 * 1.08 * 1.16), '-16', '-8').costo).toBe(100);
  });

  it('exento (0 y 0): neto tal cual y el precio no se toca', () => {
    expect(costoSinImpuestos('10', '0', '0')).toEqual({ costo: 10, impuesto: 'neto', conImpuestos: 1 });
  });

  it('⛔ [negativa] sin tasa no se adivina: va tal cual, se declara sin_dato y no hay con qué comparar el precio', () => {
    expect(costoSinImpuestos('50', null, null)).toEqual({ costo: 50, impuesto: 'sin_dato', conImpuestos: null });
    expect(costoSinImpuestos('50', '', undefined).impuesto).toBe('sin_dato');
  });

  it('⛔ [negativa] un costo 0, negativo o basura NO es un costo: null, nunca $0', () => {
    for (const c of ['0', '-5', '', null, 'abc']) expect(costoSinImpuestos(c, '0', '8').costo).toBeNull();
  });
});

describe('armarUltimoCosto — la unidad de la entrada se convierte con la escalera del renglón', () => {
  it('⭐ 96087 KINDER DELICE: la entrada en PAQ (102.7633) da la pieza en 10.2763, lo mismo que la entrada siguiente en PZA', () => {
    // Escalera real: PZA / PAQ (10) / CJA (60). La de septiembre se capturó en PAQ; la de octubre, en PZA a 10.276333.
    const unidades = [u('PZA', 1, 17.76), u('PAQ', 10, null), u('CJA', 60, null)];
    const r = armarUltimoCosto(unidades, entrada({ unidad: 'PAQ', costo: '102.763333', fecha: '2026-09-21' }))!;
    const aCentavos = (v: number) => Math.round(v * 100) / 100;
    expect(r.porUnidad.map((x) => [x.unidad, aCentavos(x.costo)])).toEqual([['PZA', 10.28], ['PAQ', 102.76], ['CJA', 616.58]]);
    expect(r.porUnidad[0].costo).toBeCloseTo(10.276333, 5); // = la entrada del 7-oct, capturada en PZA a 10.276333
    expect(r).toMatchObject({ fecha: '2026-09-21', sucursal: '08', unidad: 'PAQ', costo: 102.763333, impuesto: 'neto' });
  });

  it('la unidad de la entrada ES la base: el costo de la base es el de la entrada y la caja lo multiplica', () => {
    const r = armarUltimoCosto([u('PAQ', 1, 86), u('CJA', 20, 1586.23)], entrada())!;
    expect(r.porUnidad.map((x) => [x.unidad, x.costo])).toEqual([['PAQ', 69.98], ['CJA', 1399.6]]);
  });

  it('el rótulo se compara recortado y en mayúsculas, como la escalera', () => {
    const r = armarUltimoCosto([u('PAQ', 1, 86), u('CJA', 20, null)], entrada({ unidad: ' cja ', costo: '1399.60' }))!;
    expect(r.unidad).toBe('CJA');
    expect(r.porUnidad.map((x) => x.costo)).toEqual([69.98, 1399.6]);
  });

  it('⛔ [negativa] la unidad de la entrada NO está en la escalera: se queda en su unidad, «sin convertir» — nunca un factor inventado', () => {
    const r = armarUltimoCosto([u('PZA', 1, 12), u('CJA', 24, 250)], entrada({ unidad: 'KG', costo: '50' }))!;
    expect(r.porUnidad).toEqual([]);
    expect(r).toMatchObject({ unidad: 'KG', costo: 50 });
    // Sin escalera (sin unidades) tampoco se convierte.
    expect(armarUltimoCosto([], entrada()).porUnidad).toEqual([]);
  });

  it('⛔ [negativa] sin entradas: null («Sin compras»), nunca un costo de $0', () => {
    expect(armarUltimoCosto([u('PAQ', 1, 86)], null)).toBeNull();
    expect(armarUltimoCosto([u('PAQ', 1, 86)], undefined)).toBeNull();
  });

  it('una entrada sin costo (> 0) se declara: costo null y nada convertido', () => {
    const r = armarUltimoCosto([u('PAQ', 1, 86)], entrada({ costo: '0' }))!;
    expect(r.costo).toBeNull();
    expect(r.porUnidad).toEqual([]);
  });
});

describe('«Precio bajo costo» — el precio de lista (con impuestos) contra el costo, los dos sin impuestos', () => {
  it('⭐ CONTROL 70977 LA ROSA MAZAPAN /40: PAQ a $2.52 con costo $86.55 por PAQ (34× menor) se marca, y su caja también', () => {
    // Escalera de la base local (sucursal 02): PAQ / CJA (40), PAQ $2.52, CJA $94.54. Costo de prod: $86.55 por PAQ.
    const r = armarUltimoCosto([u('PAQ', 1, 2.52), u('CJA', 40, 94.54)], entrada({ costo: '86.55' }))!;
    expect(r.porUnidad).toMatchObject([
      { unidad: 'PAQ', costo: 86.55, bajoCosto: true },
      { unidad: 'CJA', costo: 3462, bajoCosto: true },
    ]);
    expect(r.porUnidad[0].precioSinImpuestos).toBeCloseTo(2.3333, 4); // 2.52 / 1.08
    expect(86.55 / 2.52).toBeGreaterThan(34);
  });

  it('⭐ CONTROL 70001 LA ROSA MAZAPAN /30: precio $87.14 con costo cerca de $66 NO se marca', () => {
    const r = armarUltimoCosto([u('PAQ', 1, 87.14), u('CJA', 20, 1594.96)], entrada({ costo: '66.52' }))!;
    expect(r.porUnidad.map((x) => x.bajoCosto)).toEqual([false, false]);
    // Y con los datos locales (sucursal 01: $86.00 y CJA $1,586.23; última entrada $69.98 con IEPS +8).
    const local = armarUltimoCosto(armarUnidades(
      { u1_label: 'PAQ', u2_label: 'PAQ', f2_cap: '1.00', u3_label: 'CJA', f3_cap: '20.00' },
      { unit_base: 'PAQ', piece_price: '86.0000', wholesale_piece_price: null, wholesale_piece_min_qty: null,
        pack_size: null, pack_price: null, wholesale_pack_price: null, wholesale_pack_min_qty: null, box_size: 20, box_price: '1586.2300' },
    ), entrada())!;
    expect(local.porUnidad).toMatchObject([
      { unidad: 'PAQ', costo: 69.98, bajoCosto: false },
      { unidad: 'CJA', costo: 1399.6, bajoCosto: false },
    ]);
  });

  it('⭐ el impuesto cuenta: con IVA 16, $100 de lista contra $90 de costo SÍ es bajo costo ($86.21 sin IVA)', () => {
    const r = armarUltimoCosto([u('PZA', 1, 100)], entrada({ unidad: 'PZA', costo: '90', iva: '16', ieps: '0' }))!;
    expect(r.porUnidad[0]).toMatchObject({ precioSinImpuestos: 86.206897, bajoCosto: true });
    // Sin impuesto (exento), $100 contra $90 no lo es.
    expect(armarUltimoCosto([u('PZA', 1, 100)], entrada({ unidad: 'PZA', costo: '90', iva: '0', ieps: '0' }))!.porUnidad[0].bajoCosto).toBe(false);
  });

  it('a centavos: precio sin impuestos IGUAL al costo no es bajo costo', () => {
    const r = armarUltimoCosto([u('PZA', 1, 108)], entrada({ unidad: 'PZA', costo: '100', iva: '0', ieps: '8' }))!;
    expect(r.porUnidad[0].bajoCosto).toBe(false);
  });

  it('⛔ [negativa] sin precio o sin saber el impuesto, no se compara: null (ni verde ni rojo)', () => {
    const sinPrecio = armarUltimoCosto([u('PAQ', 1, null)], entrada())!;
    expect(sinPrecio.porUnidad[0]).toMatchObject({ precioSinImpuestos: null, bajoCosto: null });
    const sinTasa = armarUltimoCosto([u('PAQ', 1, 2.52)], entrada({ costo: '86.55', iva: null, ieps: null }))!;
    expect(sinTasa.porUnidad[0]).toMatchObject({ precioSinImpuestos: null, bajoCosto: null });
    expect(sinTasa.impuesto).toBe('sin_dato');
  });
});

describe('la consulta: UNA definición de «última entrada» para las dos listas y las dos fichas', () => {
  const normal = (s: string) => s.replace(/\s+/g, ' ').trim();

  it('se arma de la definición única de entrada XA20, con el orden de siempre y un desempate fijo', () => {
    expect(ULTIMAS_ENTRADAS_SQL).toContain(ENTRADAS_XA20('btrim(l.c8) = ANY(?::text[])'));
    expect(normal(ULTIMAS_ENTRADAS_SQL)).toMatch(/^SELECT DISTINCT ON \(btrim\(l\.c8\)\) btrim\(l\.c8\) AS sku,/);
    expect(normal(ULTIMAS_ENTRADAS_SQL)).toMatch(/ORDER BY btrim\(l\.c8\), ap\.c68 DESC, ap\.c6 DESC, ap\.sucursal DESC, l\.c7 DESC$/);
  });

  it('los filtros de siempre siguen ahí (XA20, sin canceladas, almacén principal, con fecha, cantidad y unidad)', () => {
    const s = normal(ULTIMAS_ENTRADAS_SQL);
    for (const f of ["l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20'", 'btrim(ap.c1::text) = ap.sucursal::text',
      "btrim(coalesce(ap.c43::text, '')) <> 'C'", 'ap.c68 IS NOT NULL', "NULLIF(btrim(l.c11::text), '') IS NOT NULL"]) {
      expect(s).toContain(f);
    }
  });

  it('`costo` llega CRUDO (c12) con sus tasas aparte: el impuesto lo quita `costoSinImpuestos`, no el SQL', () => {
    const s = normal(ULTIMAS_ENTRADAS_SQL);
    expect(s).toContain("nullif(regexp_replace(l.c12::text, '[^0-9.-]', '', 'g'), '')::numeric AS costo");
    expect(s).toContain('AS iva');
    expect(s).toContain('AS ieps');
  });

  it('knex la acepta: un solo binding, el arreglo de SKUs', () => {
    expect(ULTIMAS_ENTRADAS_SQL.split('?').length - 1).toBe(1);
    const nativo = db.raw(ULTIMAS_ENTRADAS_SQL, [['70001', '70977']]).toSQL().toNative();
    expect(nativo.bindings).toEqual([['70001', '70977']]);
    expect(nativo.sql).toContain('= ANY($1::text[])');
  });
});

/**
 * Un `trx` falso que contesta por SQL y anota cada consulta. `transaction(fn)` es el SAVEPOINT: corre `fn` con el
 * mismo `trx` y, si truena, lo anota como deshecho. `falla` hace tronar las consultas que casen (el tope de tiempo).
 */
function trxFalso(respuestas: Array<[RegExp, unknown[]]>, falla?: RegExp) {
  const llamadas: Array<{ sql: string; binds: unknown[] }> = [];
  const savepoints: string[] = [];
  const trx = {
    raw: async (sql: string, binds: unknown[] = []) => {
      llamadas.push({ sql, binds });
      if (falla?.test(sql)) throw new Error('canceling statement due to statement timeout');
      const r = respuestas.find(([re]) => re.test(sql));
      return { rows: r ? r[1] : [] };
    },
    transaction: async (fn: (t: unknown) => unknown) => {
      savepoints.push('abre');
      try {
        const r = await fn(trx);
        savepoints.push('suelta');
        return r;
      } catch (e) {
        savepoints.push('deshace');
        throw e;
      }
    },
  };
  return { trx, llamadas, savepoints };
}
const svcCon = (trx: unknown) => new CatalogoFichaService({ run: async (fn: (t: unknown) => unknown) => fn(trx) } as never);

describe('la lista: el último costo de la página en UNA consulta, como lectura opcional', () => {
  const fila = (id: string, sku: string | null, unidades: UnidadPrecio[] = [u('PAQ', 1, 86), u('CJA', 20, 1586.23)]) => ({
    id, sku, nombre: 'X ' + id, proveedor: null, unidades, razon: null, nCodigos: 1,
  });
  const ENTRADAS = [
    { sku: '70001', ...entrada() },
    { sku: '70977', ...entrada({ costo: '86.55', sucursal: '02' }) },
  ];
  type Costos = (trx: unknown, filas: unknown[]) => Promise<{ filas: Array<Record<string, unknown>>; medido: boolean }>;
  const costos = (trx: unknown) => {
    const svc = svcCon(trx);
    return (svc as unknown as { ultimosCostos: Costos }).ultimosCostos.bind(svc);
  };

  it('⭐ N renglones → UNA consulta de entradas con los SKUs recortados y sin repetir; «Sin compras» = null', async () => {
    const { trx, llamadas, savepoints } = trxFalso([[/DISTINCT ON \(btrim\(l\.c8\)\)/, ENTRADAS], [/current_setting/, [{ t: '30s' }]]]);
    const filas = [fila('a', '70001'), fila('b', ' 70977 '), fila('c', '99999'), fila('d', null), fila('e', '70001')];
    const r = await costos(trx)(trx, filas);
    const deEntradas = llamadas.filter((l) => l.sql === ULTIMAS_ENTRADAS_SQL);
    expect(deEntradas).toHaveLength(1);
    expect(deEntradas[0].binds).toEqual([['70001', '70977', '99999']]);
    expect(r.medido).toBe(true);
    expect(r.filas.map((f) => (f['ultimoCosto'] as { costo: number } | null)?.costo ?? null)).toEqual([69.98, 86.55, null, null, 69.98]);
    expect((r.filas[1]['ultimoCosto'] as { sucursal: string }).sucursal).toBe('02');
    // Las demás llaves del renglón no cambian.
    expect(r.filas[0]).toMatchObject(filas[0]);
    expect(savepoints).toEqual(['abre', 'suelta']);
  });

  it('⭐ el tope va DENTRO del savepoint, antes de la consulta, y se devuelve al valor anterior al terminar', async () => {
    const { trx, llamadas } = trxFalso([[/DISTINCT ON/, ENTRADAS], [/current_setting/, [{ t: '30s' }]]]);
    await costos(trx)(trx, [fila('a', '70001')]);
    const topes = llamadas.filter((l) => l.sql.includes("set_config('statement_timeout'")).map((l) => l.binds[0]);
    expect(topes).toEqual(['300ms', '30s']);
    const i = llamadas.findIndex((l) => l.sql === ULTIMAS_ENTRADAS_SQL);
    expect(llamadas[i - 1].binds).toEqual(['300ms']);
    expect(llamadas[i + 1].binds).toEqual(['30s']);
  });

  it('⛔ [negativa] si la lectura truena (tope de tiempo), la lista sale igual: medido=false y SIN ultimoCosto — no «Sin compras»', async () => {
    const { trx, savepoints } = trxFalso([[/current_setting/, [{ t: '0' }]]], /DISTINCT ON/);
    const filas = [fila('a', '70001')];
    const r = await costos(trx)(trx, filas);
    expect(r.medido).toBe(false);
    expect('ultimoCosto' in r.filas[0]).toBe(false);
    expect(savepoints).toEqual(['abre', 'deshace']);
  });

  it('sin ningún SKU en la página no consulta: todos «Sin compras»', async () => {
    const { trx, llamadas } = trxFalso([]);
    const r = await costos(trx)(trx, [fila('a', null), fila('b', '  ')]);
    expect(llamadas).toHaveLength(0);
    expect(r).toMatchObject({ medido: true, filas: [{ ultimoCosto: null }, { ultimoCosto: null }] });
  });

  it('⛔ [negativa] Detallado (filasDe) NO consulta entradas y su renglón no trae la llave', async () => {
    const { trx, llamadas } = trxFalso([[/information_schema\.columns/, [{ por_sucursal: true }]]]);
    const out = await svcCon(trx).filasDe(
      [{ id: 'a', sku: '70001', nombre: 'X', description: null, barcode: null, proveedor_id: null, proveedor: null, n_codigos: 1 } as never],
      '', '02',
    );
    expect(llamadas.some((l) => l.sql === ULTIMAS_ENTRADAS_SQL)).toBe(false);
    expect('ultimoCosto' in out[0]).toBe(false);
  });
});

describe('ficha Sencillo — la «Última entrada» con la misma consulta y la misma regla que la lista', () => {
  const ID = '57ebea8c-28de-4959-a2de-0239e947af9b';
  const montar = (entradas: unknown[]) => trxFalso([
    [/information_schema\.columns/, [{ por_sucursal: true }]],
    [/FROM catalog\.products p/, [{ id: ID, sku: '70977', nombre: 'LA ROSA MAZAPAN / 40', description: null, barcode: null, activo: true, proveedor_id: null, proveedor: null }]],
    [/DISTINCT ON \(btrim\(l\.c8\)\)/, entradas],
  ]);

  it('⭐ usa ULTIMAS_ENTRADAS_SQL con un SKU y devuelve el costo SIN impuestos', async () => {
    const { trx, llamadas } = montar([{ sku: '70977', ...entrada({ costo: '56.8944', ieps: '-8' }) }]);
    const f = await svcCon(trx).ficha(ID, { puedeVerCosto: true });
    expect(llamadas.find((l) => l.sql === ULTIMAS_ENTRADAS_SQL)?.binds).toEqual([['70977']]);
    expect(f.ultimaEntrada).toMatchObject({ unidad: 'PAQ', costo: 52.68, impuesto: 'descontado' });
    expect(f.costo_visible).toBe(true);
  });

  it('⛔ [negativa] sin permiso el costo no viaja (null), pero la entrada sí', async () => {
    const { trx } = montar([{ sku: '70977', ...entrada() }]);
    const f = await svcCon(trx).ficha(ID, { puedeVerCosto: false });
    expect(f.ultimaEntrada).toMatchObject({ fecha: '2026-10-08', costo: null });
    expect(f.costo_visible).toBe(false);
  });
});

describe('puedeVerCostoCatalogo — quién ve el costo del catálogo (decisión de David, 2026-10-30)', () => {
  it('⭐ todo el que ve el catálogo, aunque NO tenga el permiso de costo estándar', () => {
    expect(puedeVerCostoCatalogo({ permissions: { [Permission.COMMERCIAL_PRODUCTS_VER]: true } })).toBe(true);
    expect(puedeVerCostoCatalogo({ role_name: 'admin' })).toBe(true);
  });

  it('⛔ [negativa] sin ver el catálogo no lo ve, aunque tenga el de costo; y sin usuario, tampoco', () => {
    expect(puedeVerCostoCatalogo({ permissions: { [Permission.COMPRAS_COSTO_ESTANDAR_VER]: true } })).toBe(false);
    expect(puedeVerCostoCatalogo({ permissions: { [Permission.COMMERCIAL_PRODUCTS_VER]: false }, role_name: 'compras' })).toBe(false);
    expect(puedeVerCostoCatalogo(undefined)).toBe(false);
    expect(puedeVerCostoCatalogo(null)).toBe(false);
  });

  it('⛔ [PF.20] el cliente externo (customer_b2b) NUNCA ve el costo, aunque tenga el permiso de ver el catálogo', () => {
    expect(puedeVerCostoCatalogo({ role_name: 'customer_b2b', permissions: { [Permission.COMMERCIAL_PRODUCTS_VER]: true } })).toBe(false);
    expect(puedeVerCostoCatalogo({ role_name: 'customer_b2b',
      permissions: { [Permission.COMMERCIAL_PRODUCTS_VER]: true, [Permission.COMPRAS_COSTO_ESTANDAR_VER]: true } })).toBe(false);
    // [negativa] un rol interno con el mismo permiso sí lo ve.
    expect(puedeVerCostoCatalogo({ role_name: 'compras', permissions: { [Permission.COMMERCIAL_PRODUCTS_VER]: true } })).toBe(true);
  });
});

/**
 * `[PF.12.3]` Detallado (2026-11-03, pedido de David): el MISMO último costo que Sencillo, con las mismas funciones.
 * Datos de la base local (sucursal 02): 70001 PAQ $86.93 / CJA (20) $1,594.85; 70977 PAQ $2.52 / CJA (40) $94.54.
 */
describe('[PF.12.3] Detallado: el mismo último costo que Sencillo', () => {
  const ID1 = '4437138e-30a2-459a-a5e9-1a0cbab09a57';
  const ID2 = '57ebea8c-28de-4959-a2de-0239e947af9b';
  const universo = (id: string, sku: string) => ({
    id, sku, nombre: 'X ' + sku, description: null, barcode: null, proveedor_id: null, proveedor: null, n_codigos: 1,
    sin_precio: false, sin_proveedor: true,
  });
  const ENTRADAS_LOCAL = [
    { sku: '70001', ...entrada() }, // 2026-10-08, sucursal 08, PAQ $69.98, IEPS +8
    { sku: '70977', ...entrada({ costo: '86.55', sucursal: '02', fecha: '2026-10-21' }) },
  ];
  const etiqueta = (product_id: string, piece: string, box: number, boxPrice: string) => ({
    product_id, unit_base: 'PAQ', piece_price: piece, wholesale_piece_price: null, wholesale_piece_min_qty: null,
    pack_size: null, pack_price: null, wholesale_pack_price: null, wholesale_pack_min_qty: null, box_size: box, box_price: boxPrice,
  });
  const datos = (entradas: unknown[] = ENTRADAS_LOCAL) => trxFalso([
    [/information_schema\.columns/, [{ por_sucursal: true }]],
    [/current_setting/, [{ t: '0' }]],
    [/product_id = ANY/, [etiqueta(ID1, '86.9300', 20, '1594.8500'), etiqueta(ID2, '2.5200', 40, '94.5400')]],
    [/v_kepler_unit_ladder/, [
      { sku: '70001', u1_label: 'PAQ', u2_label: 'PAQ', u3_label: 'CJA', f2_cap: '1.00', f3_cap: '20.00' },
      { sku: '70977', u1_label: 'PAQ', u2_label: 'CJA', u3_label: null, f2_cap: '40.00', f3_cap: '0.00' },
    ]],
    [/DISTINCT ON \(btrim\(l\.c8\)\)/, entradas],
    [/SELECT btrim\(sku\) AS sku/, [{ sku: '70977' }]],
    [/AS corte/, [{ hoy: '2026-11-03', corte: '2026-11-03' }]],
    [/FROM catalog\.products p/, [{ id: ID2, sku: '70977', nombre: 'LA ROSA MAZAPAN / 40', description: null, barcode: null, activo: true, proveedor_id: null, proveedor: null }]],
  ]);
  type Armar = (trx: unknown, filas: unknown[], texto: string, suc: string, conPrecio: boolean) => Promise<Array<Record<string, unknown>>>;
  type Costos = (trx: unknown, filas: unknown[]) => Promise<{ filas: Array<Record<string, unknown>>; medido: boolean }>;

  it('⭐ el MISMO número en la MISMA unidad: la lista Sencillo (armarFilas + ultimosCostos) y la Detallado (filasDeConCosto)', async () => {
    const { trx } = datos();
    const svc = svcCon(trx);
    const priv = svc as unknown as { armarFilas: Armar; ultimosCostos: Costos };
    const pagina = [universo(ID1, '70001'), universo(ID2, '70977')];
    // Sencillo: lo que hace `lista()` después de sus consultas de renglones.
    const sencillo = await priv.ultimosCostos.call(svc, trx, await priv.armarFilas.call(svc, trx, pagina, '', '02', true));
    // Detallado: lo que hace `CatalogoDetalladoService.lista()` con la página.
    const detallado = await svc.filasDeConCosto(pagina as never, '', '02');
    expect(detallado.medido).toBe(true);
    expect(detallado.filas.map((f) => f.ultimoCosto)).toEqual(sencillo.filas.map((f) => f['ultimoCosto']));
    // Y es el número que se espera, en las unidades del renglón.
    expect(detallado.filas[0].ultimoCosto?.porUnidad.map((x) => [x.unidad, x.costo])).toEqual([['PAQ', 69.98], ['CJA', 1399.6]]);
  });

  it('⭐ CONTROL en Detallado: 70977 se marca «bajo costo» (PAQ y CJA); 70001 no', async () => {
    const { trx } = datos();
    const r = await svcCon(trx).filasDeConCosto([universo(ID1, '70001'), universo(ID2, '70977')] as never, '', '02');
    expect(r.filas[0].ultimoCosto?.porUnidad.map((x) => x.bajoCosto)).toEqual([false, false]);
    expect(r.filas[1].ultimoCosto?.porUnidad.map((x) => x.bajoCosto)).toEqual([true, true]);
  });

  it('una sola consulta de entradas para toda la página, con el mismo savepoint y tope que Sencillo', async () => {
    const { trx, llamadas, savepoints } = datos();
    await svcCon(trx).filasDeConCosto([universo(ID1, '70001'), universo(ID2, '70977')] as never, '', '02');
    expect(llamadas.filter((l) => l.sql === ULTIMAS_ENTRADAS_SQL).map((l) => l.binds)).toEqual([[['70001', '70977']]]);
    expect(llamadas.filter((l) => l.sql.includes("set_config('statement_timeout'")).map((l) => l.binds[0])).toEqual(['300ms', '0']);
    expect(savepoints).toEqual(['abre', 'suelta']);
  });

  it('⛔ [negativa] si la lectura truena en Detallado también: medido=false y sin ultimoCosto (no «Sin compras»)', async () => {
    const { trx } = trxFalso([[/information_schema\.columns/, [{ por_sucursal: true }]], [/current_setting/, [{ t: '0' }]]], /DISTINCT ON/);
    const r = await svcCon(trx).filasDeConCosto([universo(ID1, '70001')] as never, '', '02');
    expect(r.medido).toBe(false);
    expect('ultimoCosto' in r.filas[0]).toBe(false);
  });

  it('⭐ las fichas también: «Última entrada» de Sencillo y «Costo de la última» de Detallado dan el mismo costo y unidad', async () => {
    const entradas = [{ sku: '70977', ...entrada({ costo: '56.8944', ieps: '-8', sucursal: '00' }) }];
    const a = datos(entradas);
    const ficha = await svcCon(a.trx).ficha(ID2, { puedeVerCosto: true });
    const b = datos(entradas);
    const tk = { run: async (fn: (t: unknown) => unknown) => fn(b.trx) };
    const det = new CatalogoDetalladoService(tk as never, { requireTenantId: () => 'T' } as never, null as never, null as never, null as never);
    const compras = await det.compras(ID2, { puedeVerCosto: true });
    expect(compras.ultima).toMatchObject({ costo: 52.68, unidad: 'PAQ', impuesto: 'descontado' });
    expect([compras.ultima?.costo, compras.ultima?.unidad]).toEqual([ficha.ultimaEntrada?.costo, ficha.ultimaEntrada?.unidad]);
    // La misma consulta en las dos.
    expect(b.llamadas.find((l) => l.sql === ULTIMAS_ENTRADAS_SQL)?.binds).toEqual([['70977']]);
    expect(a.llamadas.find((l) => l.sql === ULTIMAS_ENTRADAS_SQL)?.binds).toEqual([['70977']]);
  });
});

describe('[PF.12.3] CatalogoDetalladoService.lista: el costo no mueve el universo, el filtro ni el orden', () => {
  const U = (id: string, nombre: string) => ({
    id, sku: id, nombre, description: null, barcode: null, proveedor_id: null, proveedor: null, n_codigos: 1, sin_precio: false, sin_proveedor: true,
  });
  type Pag = Array<{ id: string; sku: string | null; nombre: string }>;
  const base = (f: { id: string; sku: string | null; nombre: string }) => ({ id: f.id, sku: f.sku, nombre: f.nombre, proveedor: null, unidades: [], razon: null, nCodigos: 1 });
  const montar = () => {
    const falla = () => Promise.reject(new Error('sin medir en la prueba'));
    const catalogo = {
      universo: vi.fn(async () => ({ sucursal: '02', texto: '', conPrecio: true, filas: [U('3', 'CHOCO'), U('1', 'ALFA'), U('2', 'BETA')] })),
      filasDe: vi.fn(async (p: Pag) => p.map(base)),
      filasDeConCosto: vi.fn(async (p: Pag) => ({ filas: p.map((f) => ({ ...base(f), ultimoCosto: null })), medido: true })),
    };
    const det = new CatalogoDetalladoService(
      { run: falla } as never, { requireTenantId: () => 'T' } as never, catalogo as never,
      { cuidar: falla, list: falla } as never, { list: falla } as never,
    );
    return { det, catalogo };
  };

  it('⭐ con verCosto: misma página, mismo total y conteos; pide el costo SÓLO de la página y lo declara', async () => {
    const { det, catalogo } = montar();
    const sin = await det.lista({ pageSize: 2 });
    const con = await det.lista({ pageSize: 2 }, { verCosto: true });
    expect(con.filas.map((f) => f.id)).toEqual(sin.filas.map((f) => f.id));
    expect(con.total).toBe(sin.total);
    expect(con.conteos).toEqual(sin.conteos);
    expect([con.orden, con.dir]).toEqual([sin.orden, sin.dir]);
    expect(catalogo.filasDeConCosto).toHaveBeenCalledTimes(1);
    expect(catalogo.filasDeConCosto.mock.calls[0][0]).toHaveLength(2);
    expect(con).toMatchObject({ costo_visible: true, costo_medido: true });
    expect(con.filas.every((f) => f.ultimoCosto === null)).toBe(true);
  });

  it('⛔ [negativa] sin verCosto no pide el costo: costo_visible=false, costo_medido=null y el renglón sin la llave', async () => {
    const { det, catalogo } = montar();
    const r = await det.lista({ pageSize: 2 });
    expect(catalogo.filasDeConCosto).not.toHaveBeenCalled();
    expect(r).toMatchObject({ costo_visible: false, costo_medido: null });
    expect('ultimoCosto' in r.filas[0]).toBe(false);
  });
});
