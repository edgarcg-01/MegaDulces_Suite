import { armarMatriz, ExistenciaCelda, ExistenciaFiltrosMem } from './existencia-agregado';

/**
 * `[EX-PERF.3]` — el armado en memoria tiene que decir lo mismo que el SQL que reemplazó. La
 * paridad contra prod (mismos datos, 9 combinaciones de filtros) está registrada en el encabezado
 * de `existencia-agregado.ts`; acá se fijan las reglas que, si se rompen, cambian una cifra
 * publicada sin que nadie lo note.
 */

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';

function celda(o: Partial<ExistenciaCelda>): ExistenciaCelda {
  return {
    product_id: P1, sku: '100', nombre: 'A', supplier_id: null, brand_id: null, category_id: null,
    warehouse_code: '01', nat: 0, dbf: 1, base_label: 'PZA', factor_source: 'kepler_c84',
    is_weight: false, rung_veredicto: null, rung_arbitrado: null, bucket: null, cu: 1,
    cu_source: 'erp', pf: null, pu: null, ...o,
  };
}

const F = (o: Partial<ExistenciaFiltrosMem> = {}): ExistenciaFiltrosMem =>
  ({ codes: [], only_unverified: false, hide_zero: false, page: 1, pageSize: 50, ...o });

const FOTO: ExistenciaCelda[] = [
  celda({ product_id: P1, sku: '100', nombre: 'MAZAPAN', warehouse_code: '01', nat: 360, dbf: 180, cu: 2, pf: 12, pu: 'PAQ', bucket: 'sano' }),
  celda({ product_id: P1, sku: '100', nombre: 'MAZAPAN', warehouse_code: '02', nat: 90, dbf: 180, cu: 2, bucket: 'bajo_minimo' }),
  // P2: una celda con el peldaño contradicho — no se valúa ni se suma en cajas.
  celda({ product_id: P2, sku: '200', nombre: 'CHICLE', warehouse_code: '01', nat: 50, dbf: 10, cu: 5,
          rung_veredicto: 'x1_inflada', rung_arbitrado: 123.456 }),
  // P3: sin existencia en ningún almacén, y sin factor (divisor 1, fuente none).
  celda({ product_id: P3, sku: '050', nombre: 'PALETA', warehouse_code: '02', nat: 0, factor_source: 'none', cu_source: 'catalogo', bucket: 'agotado' }),
];

describe('[EX-PERF.3] armarMatriz', () => {
  it('valor y cajas suman sólo lo medible; lo contradicho va NULL, nunca 0', () => {
    const m = armarMatriz(FOTO, F());
    const p1 = m.rows.find((r) => r.product_id === P1)!;
    expect(p1.valor).toBe(900);                // (360 + 90) × 2
    expect(p1.total_cajas).toBe(2.5);          // 450 / 180
    const p2 = m.rows.find((r) => r.product_id === P2)!;
    expect(p2.valor).toBeNull();
    expect(p2.total_cajas).toBeNull();
    expect(p2.sin_valuar).toBe(1);
    expect(p2.arbitrado).toBe(123.46);
    expect(p2.cells['01']).toEqual({ nat: 50, natu: 'PZA', bf: 10, rung: 'x1_inflada' });
  });

  it('la celda viaja con su divisor y su paquete (para el desglose cj/paq/pz)', () => {
    const p1 = armarMatriz(FOTO, F()).rows.find((r) => r.product_id === P1)!;
    expect(p1.cells['01']).toMatchObject({ q: 2, nat: 360, bf: 180, pf: 12, pu: 'PAQ', b: 'sano' });
    expect(p1.cells['02']).not.toHaveProperty('pf');
  });

  it('orden por valor desc con NULLS LAST', () => {
    expect(armarMatriz(FOTO, F()).rows.map((r) => r.sku)).toEqual(['100', '050', '200']);
  });

  it('hide_zero quita los productos sin existencia — pero los totales por almacén NO cambian', () => {
    const todo = armarMatriz(FOTO, F());
    const conExistencia = armarMatriz(FOTO, F({ hide_zero: true }));
    expect(conExistencia.total).toBe(2);
    expect(conExistencia.rows.map((r) => r.sku)).not.toContain('050');
    // El CTE tw del SQL leía de src (celdas filtradas), no de agg: hide_zero no lo toca.
    expect(conExistencia.totals.per_warehouse).toEqual(todo.totals.per_warehouse);
  });

  it('totales de la red y del almacén', () => {
    const t = armarMatriz(FOTO, F()).totals;
    expect(t.skus).toBe(3);
    expect(t.valor).toBe(900);
    expect(t.celdas_sin_valuar).toBe(1);
    expect(t.skus_sin_valuar).toBe(1);
    expect(t.celdas_sin_factor).toBe(1);       // P3: factor_source none
    // Sin costo del ERP SÓLO cuenta celdas con existencia (P3 tiene 0): el SQL viejo nunca la
    // seleccionaba y la pantalla recibía siempre 0.
    expect(t.celdas_sin_costo_erp).toBe(0);
    expect(t.per_warehouse).toEqual([
      { code: '01', valor: 720, cajas: 2, sin_valuar: 1, sin_factor: 0, skus_con_existencia: 2 },
      { code: '02', valor: 180, cajas: 0.5, sin_valuar: 0, sin_factor: 1, skus_con_existencia: 1 },
    ]);
  });

  it('filtros: búsqueda (sku o nombre), almacén, bucket, sólo sin verificar', () => {
    expect(armarMatriz(FOTO, F({ search: 'mazA' })).rows.map((r) => r.sku)).toEqual(['100']);
    expect(armarMatriz(FOTO, F({ search: '20' })).rows.map((r) => r.sku)).toEqual(['200']);
    const s02 = armarMatriz(FOTO, F({ codes: ['02'] }));
    expect(s02.rows.map((r) => r.sku).sort()).toEqual(['050', '100']);
    expect(s02.rows.find((r) => r.sku === '100')!.total_cajas).toBe(0.5);
    expect(armarMatriz(FOTO, F({ bucket: 'agotado' })).rows.map((r) => r.sku)).toEqual(['050']);
    expect(armarMatriz(FOTO, F({ bucket: 'no-existe' })).total).toBe(3);   // bucket inválido = sin filtro
    expect(armarMatriz(FOTO, F({ only_unverified: true })).rows.map((r) => r.sku)).toEqual(['200']);
  });

  it('el alias se pliega al canónico: una fila, suma de los dos', () => {
    const foto = [...FOTO, celda({ product_id: P1, sku: '101', nombre: 'MAZAPAN ALIAS', warehouse_code: '03', nat: 180, dbf: 180, cu: 2 })];
    const p1 = armarMatriz(foto, F()).rows.filter((r) => r.product_id === P1);
    expect(p1).toHaveLength(1);
    expect(p1[0].total_cajas).toBe(3.5);
    expect(p1[0].sku).toBe('101');            // max(sku), igual que el SQL
  });

  it('paginación sobre el orden', () => {
    const m = armarMatriz(FOTO, F({ page: 2, pageSize: 2 }));
    expect(m.total).toBe(3);
    expect(m.rows.map((r) => r.sku)).toEqual(['200']);
  });

  it('redondeo como el round(numeric) de Postgres: 6,471 / 180 = 35.95 → 36.0', () => {
    const foto = [1, 2, 3, 4, 5, 7, 8].map((w, i) =>
      celda({ warehouse_code: `0${w}`, nat: [2353, 686, 249, 269, 100, 1180, 1634][i], dbf: 180 }));
    expect(armarMatriz(foto, F()).rows[0].total_cajas).toBe(36);
  });
});
