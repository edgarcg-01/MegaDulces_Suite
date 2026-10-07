import { calculateRouteSalesPace } from './route-sales-pace';

describe('calculateRouteSalesPace', () => {
  it('descompone la venta por cliente con el mismo universo identificado', () => {
    const pace = calculateRouteSalesPace({
      totalRevenue: 1_200,
      identifiedRevenue: 1_000,
      clients: 2,
      articles: 5,
      units: 20,
      tickets: 4,
      lines: 8,
    });

    expect(pace).toEqual({
      clients: 2,
      revenue: 1_000,
      public_revenue: 200,
      public_pct: 16.7,
      avg_revenue: 500,
      avg_skus: 2.5,
      avg_tickets: 2,
      avg_lines: 4,
      avg_units: 10,
      avg_value_per_article: 200,
      avg_unit_value: 50,
    });
    expect(Number(pace.avg_skus) * Number(pace.avg_value_per_article)).toBe(pace.avg_revenue);
    expect(Number(pace.avg_units) * Number(pace.avg_unit_value)).toBe(pace.avg_revenue);
  });

  it('expresa ausencia de población como sin dato, no como cero', () => {
    const pace = calculateRouteSalesPace({
      totalRevenue: 300,
      identifiedRevenue: 0,
      clients: 0,
      articles: 0,
      units: 0,
      tickets: 0,
      lines: 0,
    });

    expect(pace.public_pct).toBe(100);
    expect(pace.avg_revenue).toBeNull();
    expect(pace.avg_skus).toBeNull();
    expect(pace.avg_tickets).toBeNull();
    expect(pace.avg_lines).toBeNull();
    expect(pace.avg_units).toBeNull();
    expect(pace.avg_value_per_article).toBeNull();
    expect(pace.avg_unit_value).toBeNull();
  });
});
