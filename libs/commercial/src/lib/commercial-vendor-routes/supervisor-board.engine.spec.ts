import {
  CATORCENA_ANCLA,
  SIN_MEDIR,
  attributeSales,
  catorcenaOf,
  isCatorcenaStart,
  progressPct,
  saleKey,
  teamSales,
} from './supervisor-board.engine';
import { RouteCatalog, kindInScope, routeScopeFor } from './route-scope';

/**
 * `[MCP.3.9]` Reglas puras del tablero: la catorcena (sáb→vie, dos semanas, desde un ancla), la
 * venta atribuida a la RUTA (lo no medible se declara, nunca $0) y el alcance por tipo de ruta.
 */
const sabado = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay() === 6;

describe('catorcena', () => {
  it('el ancla es sábado', () => {
    expect(sabado(CATORCENA_ANCLA)).toBe(true);
  });

  it('el día del ancla abre la catorcena (día 1) y cierra el viernes 13 días después', () => {
    expect(catorcenaOf('2026-10-17')).toEqual({ start: '2026-10-17', end: '2026-10-30', day: 1 });
  });

  it('el día 14 es el viernes de cierre; el sábado siguiente abre otra', () => {
    expect(catorcenaOf('2026-10-30')).toEqual({ start: '2026-10-17', end: '2026-10-30', day: 14 });
    expect(catorcenaOf('2026-10-31')).toEqual({ start: '2026-10-31', end: '2026-11-13', day: 1 });
  });

  it('antes del ancla cuenta hacia atrás de 14 en 14', () => {
    expect(catorcenaOf('2026-10-16')).toEqual({ start: '2026-10-03', end: '2026-10-16', day: 14 });
    expect(catorcenaOf('2026-10-03')).toEqual({ start: '2026-10-03', end: '2026-10-16', day: 1 });
    expect(catorcenaOf('2026-10-02').start).toBe('2026-09-19');
  });

  it('cruza el año sin perder el paso', () => {
    expect(catorcenaOf('2027-01-01')).toEqual({ start: '2026-12-26', end: '2027-01-08', day: 7 });
    expect(catorcenaOf('2027-01-09')).toEqual({ start: '2027-01-09', end: '2027-01-22', day: 1 });
  });

  it('invariantes en dos años: arranca en sábado, dura 14 días y contiene la fecha', () => {
    for (let t = Date.parse('2025-06-01T12:00:00Z'); t < Date.parse('2027-06-01T12:00:00Z'); t += 86_400_000) {
      const ymd = new Date(t).toISOString().slice(0, 10);
      const p = catorcenaOf(ymd);
      expect(sabado(p.start)).toBe(true);
      expect(p.start <= ymd && ymd <= p.end).toBe(true);
      expect(p.day).toBeGreaterThanOrEqual(1);
      expect(p.day).toBeLessThanOrEqual(14);
      expect(catorcenaOf(p.end).day).toBe(14);
    }
  });

  it('isCatorcenaStart: sólo el sábado ALINEADO; no otro sábado, no otro día, no basura', () => {
    expect(isCatorcenaStart('2026-10-17')).toBe(true);
    expect(isCatorcenaStart('2026-10-03')).toBe(true);
    expect(isCatorcenaStart('2026-12-26')).toBe(true);
    expect(isCatorcenaStart('2026-10-24')).toBe(false); // sábado, pero a media catorcena
    expect(isCatorcenaStart('2026-10-18')).toBe(false); // domingo
    expect(isCatorcenaStart('2026-02-30')).toBe(false);
    expect(isCatorcenaStart('17/10/2026')).toBe(false);
    expect(isCatorcenaStart('')).toBe(false);
  });
});

describe('progressPct', () => {
  it('con meta y venta: % con un decimal (puede pasar de 100)', () => {
    expect(progressPct(10000, 3000.5)).toBe(30);
    expect(progressPct(1000, 1234)).toBe(123.4);
  });
  it('sin meta, meta 0 o venta no medida: null (no 0)', () => {
    expect(progressPct(null, 100)).toBeNull();
    expect(progressPct(0, 100)).toBeNull();
    expect(progressPct(1000, null)).toBeNull();
  });
});

describe('alcance por tipo de ruta (route-scope)', () => {
  it('RV → vecinal; RD → directa; god-mode y otros → todas', () => {
    expect(routeScopeFor('ruta_vecinal', false)).toBe('vecinal');
    expect(routeScopeFor('ruta_directa', false)).toBe('directa');
    expect(routeScopeFor('ruta_vecinal', true)).toBeNull();
    expect(routeScopeFor('ventas', false)).toBeNull();
    expect(routeScopeFor(null, false)).toBeNull();
  });
  it('RD ve lo no declarado; RV no', () => {
    expect(kindInScope('directa', null)).toBe(true);
    expect(kindInScope('directa', 'camion')).toBe(true);
    expect(kindInScope('directa', 'vecinal')).toBe(false);
    expect(kindInScope('vecinal', null)).toBe(false);
    expect(kindInScope('vecinal', 'vecinal')).toBe(true);
  });
  it('catálogo: código Kepler declarado o del nombre; sin distinguir mayúsculas', () => {
    const c = new RouteCatalog([
      { value: '1V003 PAULINA', route_kind: 'vecinal', erp_vendor_code: null },
      { value: 'RVMM01 GUILLERMO', route_kind: 'vecinal', erp_vendor_code: '2V003' },
      { value: 'RUTA 27', route_kind: 'camion' },
    ]);
    expect(c.keplerCode('1V003 PAULINA')).toBe('1V003');
    expect(c.keplerCode('rvmm01 guillermo')).toBe('2V003');
    expect(c.keplerCode('RUTA 27')).toBeNull();
    expect(c.inScope('vecinal', 'Ruta 27')).toBe(false);
    expect(c.inScope('directa', 'RUTA 99 SIN CATALOGO')).toBe(true);
    expect(c.inScope('vecinal', null)).toBe(false);
  });
});

describe('venta atribuida a la ruta', () => {
  const cat = new RouteCatalog([
    { value: '1V003 PAULINA', route_kind: 'vecinal', erp_vendor_code: '1V003' },
    { value: 'VECINAL SIN CODIGO', route_kind: 'vecinal', erp_vendor_code: null },
    { value: 'RUTA 27', route_kind: 'camion' },
    { value: '10001 MAYOREO', route_kind: 'mayoreo' },
  ]);
  const sales = new Map([
    [saleKey('1V003', '2026-10-18'), { amount: 2000, tickets: 4 }],
    [saleKey('1V003', '2026-10-21'), { amount: 1000.5, tickets: 3 }],
  ]);

  it('suma la venta de sus rutas en los días que las tuvo; un día sin venta es $0 MEDIDO', () => {
    const r = attributeSales([
      { date: '2026-10-18', route: '1V003 PAULINA' },
      { date: '2026-10-20', route: '1V003 PAULINA' },
      { date: '2026-10-21', route: '1V003 PAULINA' },
    ], cat, sales);
    expect(r.sales).toEqual({ amount: 3000.5, tickets: 7, unmeasured_reason: null });
    expect(r.keys).toHaveLength(3);
  });

  it('⛔ Ruta Directa: null + motivo, nunca $0 — y bloquea el total', () => {
    const r = attributeSales([{ date: '2026-10-21', route: 'RUTA 27' }], cat, sales);
    expect(r.sales).toEqual({ amount: null, tickets: null, unmeasured_reason: SIN_MEDIR.directa });
    expect(r.blocks).toBe(true);
  });

  it('⛔ una ruta-día no medible anula la cifra entera (no se publica la parte medida como total)', () => {
    const r = attributeSales([
      { date: '2026-10-21', route: '1V003 PAULINA' },
      { date: '2026-10-21', route: 'VECINAL SIN CODIGO' },
    ], cat, sales);
    expect(r.sales.amount).toBeNull();
    expect(r.sales.unmeasured_reason).toContain('VECINAL SIN CODIGO');
  });

  it('otro tipo (mayoreo) declara su propio motivo', () => {
    const r = attributeSales([{ date: '2026-10-21', route: '10001 MAYOREO' }], cat, sales);
    expect(r.sales.unmeasured_reason).toContain('mayoreo');
  });

  it('sin ruta: null con motivo, y NO bloquea el total del equipo', () => {
    const r = attributeSales([], cat, sales);
    expect(r.sales.amount).toBeNull();
    expect(r.sales.unmeasured_reason).toBe(SIN_MEDIR.sinRuta);
    expect(r.blocks).toBe(false);
  });

  it('total del equipo: la misma ruta-día de dos personas se cuenta UNA vez', () => {
    const a = attributeSales([{ date: '2026-10-21', route: '1V003 PAULINA' }], cat, sales);
    const b = attributeSales([{ date: '2026-10-21', route: '1V003 PAULINA' }], cat, sales);
    expect(a.sales.amount).toBe(1000.5);
    expect(b.sales.amount).toBe(1000.5);
    expect(teamSales([a, b], sales)).toBe(1000.5);
  });

  it('total del equipo: null si alguien no se midió, o si nada se midió', () => {
    const a = attributeSales([{ date: '2026-10-21', route: '1V003 PAULINA' }], cat, sales);
    const d = attributeSales([{ date: '2026-10-21', route: 'RUTA 27' }], cat, sales);
    expect(teamSales([a, d], sales)).toBeNull();
    expect(teamSales([attributeSales([], cat, sales)], sales)).toBeNull();
  });
});
