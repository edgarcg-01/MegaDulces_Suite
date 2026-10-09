// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`.
import type { SdPriority } from '@megadulces/contracts';
import type { BusinessCalendar } from './business-clock';
import { aplicarMinimoDeCasos, armarReporte, suprimirFilas, type ConfigReporte, type FilaReporte } from './report';

/**
 * `[MSH.2]` H8 — el reporte de una cola CONFIDENCIAL. Lo que se defiende:
 *  · ⛔ con menos casos que el mínimo NO sale ninguna cifra (un agregado de 2 casos es casi un caso individual);
 *  · ⛔ una fila con menos casos que el mínimo no se muestra;
 *  · ⛔ supresión COMPLEMENTARIA: si sólo quedó oculta UNA fila, también se oculta la visible más chica; si no, total − visibles = la oculta;
 *  · lo que se oculta se DECLARA (no desaparece en silencio) y un reporte con casos de sobra no se toca.
 */
const MX: BusinessCalendar = { tz: 'America/Mexico_City', days: [1, 2, 3, 4, 5, 6], startMin: 480, endMin: 1140 };
const CFG: ConfigReporte = {
  calendar: MX,
  policies: { media: { priority: 'media', first_response_minutes: 240, resolution_minutes: 1440, clock: 'business' } } as ConfigReporte['policies'],
};
const mx = (dia: number, h: number): string => new Date(Date.UTC(2026, 9, dia, h + 6)).toISOString();
const AHORA = Date.parse(mx(6, 18));

const fila = (p: Partial<FilaReporte> & { priority?: SdPriority }): FilaReporte => ({
  priority: 'media',
  category_id: 'cat-a',
  category_name: 'Queja',
  warehouse_code: null,
  status: 'nuevo',
  created_at: mx(5, 10),
  first_responded_at: null,
  first_response_due_at: null,
  resolved_at: null,
  due_at: null,
  paused_minutes: 0,
  reopened_count: 0,
  ...p,
});
const reporte = (filas: FilaReporte[]) =>
  armarReporte(filas, CFG, { desde: '2026-10-01', hasta: '2026-10-06', ahora: AHORA, truncado: false, nombreSucursal: () => null });
const veces = (n: number, p: Partial<FilaReporte>): FilaReporte[] => Array.from({ length: n }, () => fila(p));

describe('MSH.2 · suprimirFilas', () => {
  const n = (x: number) => x;
  it('⭐ sin filas por debajo del mínimo no oculta nada', () => {
    expect(suprimirFilas([5, 4, 3], n, 3)).toEqual({ visibles: [5, 4, 3], ocultas: 0 });
  });
  it('⛔ NEGATIVA — UNA oculta arrastra a la visible más chica (si no, el total la revelaría)', () => {
    const r = suprimirFilas([9, 6, 4, 1], n, 3);
    expect(r.visibles).toEqual([9, 6]); // el 4 también se fue
    expect(r.ocultas).toBe(2);
  });
  it('dos o más ocultas: sólo se deduce su suma; no se arrastra a nadie más', () => {
    const r = suprimirFilas([9, 6, 2, 1], n, 3);
    expect(r.visibles).toEqual([9, 6]);
    expect(r.ocultas).toBe(2);
  });
  it('una oculta y NINGUNA visible: no hay a quién arrastrar', () => {
    expect(suprimirFilas([1], n, 3)).toEqual({ visibles: [], ocultas: 1 });
  });
  it('empate en la más chica: se va sólo UNA', () => {
    const r = suprimirFilas([9, 4, 4, 1], n, 3);
    expect(r.visibles).toHaveLength(2);
    expect(r.ocultas).toBe(2);
  });
});

describe('MSH.2 · aplicarMinimoDeCasos', () => {
  it('⛔ NEGATIVA — con menos casos que el mínimo, el reporte entero se SUPRIME: nada de cifras', () => {
    const base = reporte([fila({}), fila({ status: 'resuelto', resolved_at: mx(5, 12) })]);
    const r = aplicarMinimoDeCasos(base, 5);
    expect(r.suprimido).toEqual({ minimo: 5, motivo: 'menos de 5 casos en el periodo' });
    expect(r.totales.creados).toBe(0);
    expect(r.totales.resueltos).toBe(0);
    expect(r.por_categoria).toEqual([]);
    expect(r.por_sucursal).toEqual([]);
    expect(r.recurrentes).toEqual([]);
    expect(r.no_medido.join(' ')).toContain('confidencial');
  });
  it('⭐ justo en el mínimo SÍ sale (el mínimo es «al menos»)', () => {
    const r = aplicarMinimoDeCasos(reporte(veces(5, {})), 5);
    expect(r.suprimido).toBeUndefined();
    expect(r.totales.creados).toBe(5);
    expect(r.por_categoria).toHaveLength(1);
  });
  it('⛔ NEGATIVA — una categoría con pocos casos no se muestra, y se arrastra la más chica visible (complementaria)', () => {
    const filas = [...veces(8, { category_id: 'a', category_name: 'A' }), ...veces(4, { category_id: 'b', category_name: 'B' }), ...veces(1, { category_id: 'c', category_name: 'C' })];
    const r = aplicarMinimoDeCasos(reporte(filas), 3);
    expect(r.por_categoria.map((c) => c.name)).toEqual(['A']); // C oculta + B arrastrada
    expect(r.totales.creados).toBe(13);
    expect(r.no_medido.join(' ')).toContain('2 fila(s)');
  });
  it('lo ocultado se DECLARA en `no_medido`; sin nada oculto, no se agrega ruido', () => {
    const limpio = aplicarMinimoDeCasos(reporte(veces(6, {})), 3);
    expect(limpio.no_medido.join(' ')).not.toContain('confidencial');
    const con = aplicarMinimoDeCasos(reporte([...veces(6, {}), ...veces(1, { category_id: 'z', category_name: 'Z' }), ...veces(1, { category_id: 'y', category_name: 'Y' })]), 3);
    expect(con.no_medido.join(' ')).toContain('Área confidencial');
  });
  it('⛔ NEGATIVA — la sucursal con pocos casos también se oculta', () => {
    const filas = [...veces(6, { warehouse_code: '02' }), ...veces(1, { warehouse_code: '03' }), ...veces(1, { warehouse_code: '04' })];
    const r = aplicarMinimoDeCasos(reporte(filas), 3);
    expect(r.por_sucursal.map((s) => s.warehouse_code)).toEqual(['02']);
  });
});
