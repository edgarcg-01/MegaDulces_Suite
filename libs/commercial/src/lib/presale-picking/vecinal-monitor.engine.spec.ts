import type { PresalePickReport, PresaleReviewResult } from '@megadulces/contracts';
import {
  PeriodoInvalido,
  cajaAjusto,
  diasConActividad,
  lineasDelPedido,
  periodoDe,
  resumenCajeras,
  resumenSurtidores,
  type PickParaMonitor,
} from './vecinal-monitor.engine';

/**
 * `[MV.1]` Monitoreo vecinal (surtidores y cajeras), sin base. Lo que se prueba es lo que se rompe
 * sin que la pantalla cambie de aspecto: el periodo, los tiempos, quién ajustó qué y cuánto se debió
 * cobrar.
 */
describe('periodoDe · el rango que se consulta', () => {
  const HOY = '2026-11-05';
  it('sin fechas es hoy, con sus días con actividad', () => {
    expect(periodoDe(undefined, undefined, HOY)).toEqual({ from: HOY, to: HOY, days: 1 });
  });
  it('una sola fecha es ese día', () => {
    expect(periodoDe('2026-11-04', undefined, HOY)).toEqual({ from: '2026-11-04', to: '2026-11-04', days: 1 });
  });
  it('cuenta lunes a sábado: la catorcena del 24 oct al 5 nov tiene 11', () => {
    expect(periodoDe('2026-10-24', HOY, HOY).days).toBe(11);
  });
  it('un domingo solo cuenta como 1 (nunca 0: el promedio no divide entre cero)', () => {
    expect(diasConActividad('2026-11-01', '2026-11-01')).toBe(1);
  });
  it('rechaza lo que no es una fecha real, al revés o en el futuro', () => {
    expect(() => periodoDe('2026-02-31', undefined, HOY)).toThrow(PeriodoInvalido);
    expect(() => periodoDe('05/11/2026', undefined, HOY)).toThrow(/AAAA-MM-DD/);
    expect(() => periodoDe(HOY, '2026-11-01', HOY)).toThrow(/antes/);
    expect(() => periodoDe(HOY, '2026-11-06', HOY)).toThrow(/después de hoy/);
  });
  it('no más de 92 días', () => {
    expect(() => periodoDe('2026-07-01', HOY, HOY)).toThrow(/92/);
    expect(periodoDe('2026-08-06', HOY, HOY).from).toBe('2026-08-06');
  });
});

const pick = (p: Partial<PickParaMonitor>): PickParaMonitor => ({
  order_id: 'o', code: 'PD-1', started_by: 's1', started_by_name: 'Juan', started_at: '2026-11-05T15:00:00Z',
  finished_at: '2026-11-05T15:20:00Z', outcome: 'completo', report: null, reviewed_by: null, reviewed_by_name: null,
  reviewed_at: null, review: null, ...p,
});
const revision = (lines: Array<[number, number, number]>, antes = 100, despues = 100): PresaleReviewResult => ({
  lines: lines.map(([ordered, picked, final], i) => ({ key: 'l' + i, product_name: 'P' + i, unit: 'PZA', ordered, picked, final, returned: 0, resolution: 'bien' })),
  total_before: antes, total_after: despues,
});

describe('resumenSurtidores', () => {
  it('⭐ cuenta, promedia el tiempo de lo terminado y nombra el más lento', () => {
    const [r] = resumenSurtidores([
      pick({ code: 'PD-1' }),
      pick({ code: 'PD-2', started_at: '2026-11-05T16:00:00Z', finished_at: '2026-11-05T16:40:00Z', outcome: 'con_faltantes' }),
      pick({ code: 'PD-3', started_at: '2026-11-05T17:00:00Z', finished_at: null, outcome: null }),
    ]);
    expect(r).toMatchObject({ taken: 3, finished: 2, in_progress: 1, avg_minutes: 30, slowest: { code: 'PD-2', minutes: 40 }, with_shortage: 1 });
    expect(r.first_at).toBe('2026-11-05T15:00:00.000Z');
    expect(r.last_at).toBe('2026-11-05T17:00:00.000Z');
  });
  it('sin pedidos terminados, el promedio NO es cero: es null', () => {
    const [r] = resumenSurtidores([pick({ finished_at: null, outcome: null })]);
    expect(r.avg_minutes).toBeNull();
    expect(r.slowest).toBeNull();
  });
  it('separa a cada surtidor y pone primero al que más tomó', () => {
    const rs = resumenSurtidores([pick({ started_by: 'a', started_by_name: 'Ana' }), pick({ started_by: 'b', started_by_name: 'Beto' }), pick({ started_by: 'b', started_by_name: 'Beto' })]);
    expect(rs.map((r) => [r.name, r.taken])).toEqual([['Beto', 2], ['Ana', 1]]);
  });
  it('cuenta los cambios por otro producto y lo que después ajustó la caja', () => {
    const rep: PresalePickReport = { removed: [], adjusted: [], total_before: 1, total_after: 1,
      substituted: [{ line_id: 'n', for_line_id: 'l', for_product_name: 'X', for_sku: null, product_id: 'p', product_name: 'Y', sku: null, quantity: 1, unit: 'PZA', line_total: 1 }] };
    const [r] = resumenSurtidores([pick({ report: rep }), pick({ review: revision([[2, 1, 2]]) }), pick({ review: revision([[1, 1, 1]]) })]);
    expect(r.substituted).toBe(1);
    expect(r.adjusted_by_cashier).toBe(1);
  });
});

describe('resumenCajeras', () => {
  const rev = (p: Partial<PickParaMonitor>) => pick({ reviewed_by: 'c1', reviewed_by_name: 'Ana', reviewed_at: '2026-11-05T15:50:00Z', ...p });
  it('⭐ debió cobrarse = la suma de los totales tras la revisión; y cuánto los movió', () => {
    const [r] = resumenCajeras([
      rev({ review: revision([[2, 1, 2]], 100, 150) }),
      rev({ review: revision([[3, 3, 2]], 300, 250), reviewed_at: '2026-11-05T16:20:00Z' }),
    ]);
    expect(r).toMatchObject({ reviewed: 2, should_charge: 400, delta: 0, completed_lines: 1, removed_lines: 1 });
    expect(r.avg_wait_minutes).toBe(45); // 30 y 60 min después de surtir
  });
  it('lo que tardó en revisar NO se mide: siempre null', () => {
    expect(resumenCajeras([rev({ review: revision([[1, 1, 1]]) })])[0].avg_review_minutes).toBeNull();
  });
  it('lo que nadie ha revisado no cuenta para ninguna cajera', () => {
    expect(resumenCajeras([pick({}), pick({ reviewed_by: 'c1', reviewed_at: null })])).toEqual([]);
  });
  it('centavos sin error de coma flotante', () => {
    const [r] = resumenCajeras([rev({ review: revision([[1, 1, 1]], 0.1, 0.1) }), rev({ review: revision([[1, 1, 1]], 0.2, 0.2) })]);
    expect(r.should_charge).toBe(0.3);
  });
});

describe('cajaAjusto', () => {
  it('sí, si algún renglón quedó distinto de lo surtido; no, si todo quedó igual o no hay revisión', () => {
    expect(cajaAjusto(revision([[2, 1, 2]]))).toBe(true);
    expect(cajaAjusto(revision([[2, 2, 2]]))).toBe(false);
    expect(cajaAjusto(null)).toBe(false);
  });
});

describe('lineasDelPedido · los productos como los dejó cada etapa', () => {
  const vivos = [
    { line_id: 'a', product_id: 'pa', product_name: 'PALETA', sku: '100', quantity: 24, qty_unit: 'CJA', qty_factor: 12 },
    { line_id: 'n', product_id: 'px', product_name: 'SALSA VALENTINA', sku: '300', quantity: 1, qty_unit: 'PZA', qty_factor: 1 },
  ];
  const restore = { product_id: 'pb', quantity: 2, qty_unit: 'PZA', qty_factor: 1, qty_factor_source: null, discount_percent: 0, unit_price: 10, tax_rate: 0, source_warehouse_id: null, line_number: 2, notes: null };
  const reporte: PresalePickReport = {
    removed: [{ product_name: 'SALSA MAGA', unit: 'PZA', ordered: 2, picked: 0, line_id: 'b', restore }],
    adjusted: [{ product_name: 'PALETA', unit: 'CJA', ordered: 3, picked: 2, line_id: 'a' }],
    substituted: [{ line_id: 'n', for_line_id: 'b', for_product_name: 'SALSA MAGA', for_sku: '200', product_id: 'px', product_name: 'SALSA VALENTINA', sku: '300', quantity: 1, unit: 'PZA', line_total: 30 }],
    total_before: 1, total_after: 1,
  };
  const sku = (id: string | null | undefined) => (id === 'pb' ? '200' : null);

  it('⭐ sin revisión: lo pedido del reporte, lo surtido del pedido, y el original cambiado NO se esconde', () => {
    const ls = lineasDelPedido({ report: reporte, review: null }, vivos, sku);
    expect(ls).toEqual([
      { product_name: 'PALETA', sku: '100', unit: 'CJA', ordered: 3, picked: 2, final: null, substitute: null, substitutes_for: null },
      { product_name: 'SALSA VALENTINA', sku: '300', unit: 'PZA', ordered: 1, picked: 1, final: null, substitute: null, substitutes_for: 'SALSA MAGA' },
      { product_name: 'SALSA MAGA', sku: '200', unit: 'PZA', ordered: 2, picked: 0, final: null,
        substitute: { product_name: 'SALSA VALENTINA', sku: '300', quantity: 1, unit: 'PZA' }, substitutes_for: null },
    ]);
  });

  it('con revisión: la foto es la revisión, y el original cubierto (que la caja no vio) se agrega', () => {
    const review: PresaleReviewResult = {
      lines: [
        { key: 'a', product_name: 'PALETA', unit: 'CJA', ordered: 3, picked: 2, final: 3, returned: 0, resolution: 'completo', sku: '100' },
        { key: 'n', product_name: 'SALSA VALENTINA', unit: 'PZA', ordered: 1, picked: 1, final: 1, returned: 0, resolution: 'bien' },
      ],
      total_before: 1, total_after: 1,
    };
    const ls = lineasDelPedido({ report: reporte, review }, vivos, sku);
    expect(ls[0]).toMatchObject({ product_name: 'PALETA', sku: '100', ordered: 3, picked: 2, final: 3 });
    // Revisión vieja sin SKU: se toma del renglón vivo.
    expect(ls[1]).toMatchObject({ product_name: 'SALSA VALENTINA', sku: '300', final: 1, substitutes_for: 'SALSA MAGA' });
    expect(ls[2]).toMatchObject({ product_name: 'SALSA MAGA', ordered: 2, picked: 0, final: 0, substitute: { product_name: 'SALSA VALENTINA' } });
  });

  it('un pedido sin reporte (hubo todo) sale tal cual, en la unidad capturada', () => {
    const ls = lineasDelPedido({ report: null, review: null }, [vivos[0]], sku);
    expect(ls).toEqual([{ product_name: 'PALETA', sku: '100', unit: 'CJA', ordered: 2, picked: 2, final: null, substitute: null, substitutes_for: null }]);
  });
});
