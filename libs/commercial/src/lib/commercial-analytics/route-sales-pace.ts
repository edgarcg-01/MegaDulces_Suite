export interface RouteSalesPaceInput {
  totalRevenue: number;
  clients: number;
  identifiedRevenue: number;
  units: number;
  /** Sum of the distinct SKUs bought by each identified client. */
  articles: number;
  tickets: number;
  lines: number;
}

export interface RouteSalesPace {
  clients: number;
  revenue: number;
  public_revenue: number;
  public_pct: number;
  avg_revenue: number | null;
  avg_skus: number | null;
  avg_tickets: number | null;
  avg_lines: number | null;
  avg_units: number | null;
  avg_value_per_article: number | null;
  avg_unit_value: number | null;
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const average = (value: number, count: number, digits = 2): number | null =>
  count > 0 ? round(value / count, digits) : null;

/** Calculates the pace over identified clients only; walk-up sales stay separate. */
export function calculateRouteSalesPace(input: RouteSalesPaceInput): RouteSalesPace {
  const publicRevenue = round(input.totalRevenue - input.identifiedRevenue, 2);

  return {
    clients: input.clients,
    revenue: round(input.identifiedRevenue, 2),
    public_revenue: publicRevenue,
    public_pct: input.totalRevenue > 0 ? round((publicRevenue / input.totalRevenue) * 100, 1) : 0,
    avg_revenue: average(input.identifiedRevenue, input.clients),
    avg_skus: average(input.articles, input.clients),
    avg_tickets: average(input.tickets, input.clients),
    avg_lines: average(input.lines, input.clients),
    avg_units: average(input.units, input.clients),
    avg_value_per_article: average(input.identifiedRevenue, input.articles),
    avg_unit_value: average(input.identifiedRevenue, input.units),
  };
}
