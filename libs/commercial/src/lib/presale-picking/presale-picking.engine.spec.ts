import type { PresaleCandidate } from '@megadulces/contracts';
import {
  CierreInvalido,
  armarReporte,
  cantidadMostrada,
  detectarCobro,
  diasEntre,
  pestanaDe,
  planearCierre,
  sumarDias,
  type RenglonParaCerrar,
} from './presale-picking.engine';

/**
 * `[MCP.3]` + `[MCP.8]` Las reglas del surtido de preventa, sin base. Lo que se prueba es lo que
 * se puede romper sin que la pantalla cambie de aspecto: en qué pestaña cae un pedido, qué se quita
 * del pedido y cuándo se acepta un ticket de Kepler como el cobro.
 */
describe('fechas en hora de México', () => {
  it('suma días cruzando mes y año sin pasar por la zona del servidor', () => {
    expect(sumarDias('2026-10-31', 1)).toBe('2026-11-01');
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('cuenta los días entre dos fechas', () => {
    expect(diasEntre('2026-10-14', '2026-10-14')).toBe(0);
    expect(diasEntre('2026-10-14', '2026-10-17')).toBe(3);
    expect(diasEntre('2026-10-14', '2026-10-10')).toBe(-4);
  });
});

describe('pestanaDe · la bandeja por día', () => {
  const HOY = '2026-10-14';
  it('el pedido de hoy va en Hoy', () => {
    expect(pestanaDe('2026-10-14', HOY)).toEqual({ bucket: 'hoy', days_late: 0 });
  });
  it('lo vencido también va en Hoy, con sus días de atraso', () => {
    expect(pestanaDe('2026-10-11', HOY)).toEqual({ bucket: 'hoy', days_late: 3 });
  });
  it('el de mañana va en Mañana', () => {
    expect(pestanaDe('2026-10-15', HOY)).toEqual({ bucket: 'manana', days_late: 0 });
  });
  it('pasado mañana en adelante va en Próximos', () => {
    expect(pestanaDe('2026-10-16', HOY).bucket).toBe('proximos');
    expect(pestanaDe('2026-11-02', HOY).bucket).toBe('proximos');
  });
  it('mañana cruzando fin de mes', () => {
    expect(pestanaDe('2026-11-01', '2026-10-31').bucket).toBe('manana');
  });
});

describe('cantidadMostrada · la unidad en que se capturó', () => {
  it('con sello exacto muestra la unidad capturada', () => {
    expect(cantidadMostrada({ quantity: 36, qty_unit: 'PAQ', qty_factor: 12 })).toEqual({ qty: 3, unit: 'PAQ', factor: 12 });
  });
  it('si el sello no divide exacto, cae a la base en vez de mostrar un decimal falso', () => {
    expect(cantidadMostrada({ quantity: 30, qty_unit: 'CJA', qty_factor: 24 })).toEqual({ qty: 30, unit: 'PZA', factor: 1 });
  });
  it('sin sello, en unidad base', () => {
    expect(cantidadMostrada({ quantity: 5, qty_unit: null, qty_factor: null })).toEqual({ qty: 5, unit: 'PZA', factor: 1 });
  });
});

describe('planearCierre · lo que no hubo se quita del pedido', () => {
  const R: RenglonParaCerrar[] = [
    { line_id: 'a', product_name: 'BOMBON GRANDE', quantity: 5, qty_unit: 'PAQ', qty_factor: 1, line_total: 161.4 },
    { line_id: 'b', product_name: 'FLAN VAINILLA', quantity: 240, qty_unit: 'PAQ', qty_factor: 12, line_total: 171.8 },
    { line_id: 'c', product_name: 'SALSA MAGA', quantity: 24, qty_unit: 'CJA', qty_factor: 24, line_total: 232.8 },
    { line_id: 'd', product_name: 'ALTOS CAM', quantity: 5, qty_unit: 'KG', qty_factor: 1, line_total: 295 },
  ];
  const todo = () => [
    { line_id: 'a', picked: 5 }, { line_id: 'b', picked: 20 }, { line_id: 'c', picked: 1 }, { line_id: 'd', picked: 5 },
  ];

  it('si hubo todo, el pedido no se toca', () => {
    const p = planearCierre(R, todo());
    expect(p.outcome).toBe('completo');
    expect(p.quitar).toEqual([]);
    expect(p.recortar).toEqual([]);
    expect(armarReporte(p, 861, 861)).toBeNull();
  });

  it('lo que hubo a medias se recorta, convertido a unidad BASE con el factor del sello', () => {
    const m = todo();
    m[1].picked = 14; // 14 PAQ de 12 = 168 piezas
    const p = planearCierre(R, m);
    expect(p.outcome).toBe('con_faltantes');
    expect(p.recortar).toEqual([{ line_id: 'b', quantity: 168 }]);
    expect(p.adjusted).toEqual([{ product_name: 'FLAN VAINILLA', unit: 'PAQ', ordered: 20, picked: 14 }]);
  });

  it('lo que no hubo nada se quita del pedido', () => {
    const m = todo();
    m[2].picked = 0;
    const p = planearCierre(R, m);
    expect(p.quitar).toEqual(['c']);
    expect(p.removed).toEqual([{ product_name: 'SALSA MAGA', unit: 'CJA', ordered: 1, picked: 0 }]);
    expect(armarReporte(p, 861.2, 628.4)).toEqual({ removed: p.removed, adjusted: [], total_before: 861.2, total_after: 628.4 });
  });

  it('a granel acepta decimales', () => {
    const m = todo();
    m[3].picked = 4.5;
    expect(planearCierre(R, m).recortar).toEqual([{ line_id: 'd', quantity: 4.5 }]);
  });

  it('en paquetes o cajas la cantidad va entera', () => {
    const m = todo();
    m[0].picked = 2.5;
    expect(() => planearCierre(R, m)).toThrow(CierreInvalido);
  });

  it('no se puede surtir más de lo pedido', () => {
    const m = todo();
    m[0].picked = 6;
    expect(() => planearCierre(R, m)).toThrow(/más de lo pedido/);
  });

  it('exige marcar cada renglón', () => {
    expect(() => planearCierre(R, todo().slice(0, 3))).toThrow(/Falta marcar «ALTOS CAM»/);
  });

  it('rechaza un renglón ajeno o repetido', () => {
    expect(() => planearCierre(R, [...todo(), { line_id: 'z', picked: 1 }])).toThrow(/no es de este pedido/);
    expect(() => planearCierre(R, [...todo(), { line_id: 'a', picked: 1 }])).toThrow(/repetido/);
  });

  it('rechaza una cantidad negativa', () => {
    const m = todo();
    m[0].picked = -1;
    expect(() => planearCierre(R, m)).toThrow(/inválida/);
  });

  it('si no hubo NADA no se surte vacío: se pide cancelarlo', () => {
    expect(() => planearCierre(R, todo().map((x) => ({ ...x, picked: 0 })))).toThrow(/cancelarlo/);
  });
});

describe('detectarCobro · un ticket de Kepler cuenta como cobro sólo si no hay duda', () => {
  const cand = (folio: string, fecha: string, shared: number, ligado: string | null = null): PresaleCandidate => ({
    folio_digital: folio, sucursal: '02', fecha, caja: 2, total: 100, cashier_name: 'RUTA VECINAL',
    shared_products: shared, order_products: 6, linked_to_order_code: ligado,
  });

  it('acepta el único ticket posterior al surtido que trae todos los productos', () => {
    const c = detectarCobro([cand('02UD1002-1', '2026-10-14', 6), cand('02UD1002-0', '2026-10-13', 6)], 6, '2026-10-14');
    expect(c?.folio_digital).toBe('02UD1002-1');
  });

  it('dos tickets igual de buenos (el cliente compró dos veces): no adivina', () => {
    expect(detectarCobro([cand('A', '2026-10-14', 6), cand('B', '2026-10-15', 6)], 6, '2026-10-14')).toBeNull();
  });

  it('un ticket con menos productos que el pedido no cuenta', () => {
    expect(detectarCobro([cand('A', '2026-10-14', 5)], 6, '2026-10-14')).toBeNull();
  });

  it('un ticket anterior al surtido no puede ser su cobro', () => {
    expect(detectarCobro([cand('A', '2026-10-13', 6)], 6, '2026-10-14')).toBeNull();
  });

  it('un ticket ya ligado a otro pedido no se toma', () => {
    expect(detectarCobro([cand('A', '2026-10-14', 6, 'PD-2026-00001')], 6, '2026-10-14')).toBeNull();
  });

  it('sin productos en el pedido no hay qué comparar', () => {
    expect(detectarCobro([cand('A', '2026-10-14', 0)], 0, '2026-10-14')).toBeNull();
  });
});
