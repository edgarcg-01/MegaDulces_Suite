/**
 * Resuelve design tokens del DOM a hex literales para Chart.js (que no
 * acepta var()). Llamar `getChartTokens()` al construir config y dentro
 * del effect que reacciona al cambio de tema. SSR-safe (fallback light).
 */

export interface ChartTokens {
  /* Surfaces / text / borders */
  cardBg: string;
  layoutBg: string;
  surfaceGround: string;
  textMain: string;
  textMuted: string;
  textFaint: string;
  borderColor: string;

  /* Semantic */
  okFg: string;
  warnFg: string;
  badFg: string;
  infoFg: string;

  /* Chart-specific (8 series + grid + axis) */
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  chart6: string;
  chart7: string;
  chart8: string;
  chartGrid: string;
  chartAxis: string;
  chartMetaLine: string;

  /* Brand (acentos en charts brand-aware) */
  brand400: string;
  brand600: string;
  brand700: string;

  /* Chart-fill legacy (gris monocromático para seguimiento) */
  chartFillLow: string;
  chartFillMid: string;
  chartFillHigh: string;
}

/** Fallback estático (light) para SSR / tests sin `document`. */
const LIGHT_FALLBACK: ChartTokens = {
  cardBg: '#FFFFFF',
  layoutBg: '#F4F4F5',
  surfaceGround: '#F8FAFC',
  textMain: '#09090B',
  textMuted: '#52525B',
  textFaint: '#A1A1AA',
  borderColor: '#E4E4E7',
  okFg: '#16A34A',
  warnFg: '#F59E0B',
  badFg: '#DC2626',
  infoFg: '#2563EB',
  chart1: '#F68F1E',
  chart2: '#185FA5',
  chart3: '#9333EA',
  chart4: '#0EA5E9',
  chart5: '#EC4899',
  chart6: '#14B8A6',
  chart7: '#F59E0B',
  chart8: '#71717A',
  chartGrid: 'rgba(0,0,0,0.05)',
  chartAxis: '#71717A',
  chartMetaLine: '#9CA3AF',
  brand400: '#FDE707',
  brand600: '#F68F1E',
  brand700: '#F05A28',
  chartFillLow: '#C8C8D0',
  chartFillMid: '#6B6B75',
  chartFillHigh: '#1E1E22',
};

function readToken(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

/** Snapshot de tokens del tema vigente. No cachear entre cambios de tema. */
export function getChartTokens(): ChartTokens {
  if (typeof document === 'undefined') return { ...LIGHT_FALLBACK };
  return {
    cardBg:        readToken('--card-bg',          LIGHT_FALLBACK.cardBg),
    layoutBg:      readToken('--layout-bg',        LIGHT_FALLBACK.layoutBg),
    surfaceGround: readToken('--surface-ground',   LIGHT_FALLBACK.surfaceGround),
    textMain:      readToken('--text-main',        LIGHT_FALLBACK.textMain),
    textMuted:     readToken('--text-muted',       LIGHT_FALLBACK.textMuted),
    textFaint:     readToken('--text-faint',       LIGHT_FALLBACK.textFaint),
    borderColor:   readToken('--border-color',     LIGHT_FALLBACK.borderColor),
    okFg:          readToken('--ok-fg',            LIGHT_FALLBACK.okFg),
    warnFg:        readToken('--warn-fg',          LIGHT_FALLBACK.warnFg),
    badFg:         readToken('--bad-fg',           LIGHT_FALLBACK.badFg),
    infoFg:        readToken('--info-fg',          LIGHT_FALLBACK.infoFg),
    chart1:        readToken('--chart-1',          LIGHT_FALLBACK.chart1),
    chart2:        readToken('--chart-2',          LIGHT_FALLBACK.chart2),
    chart3:        readToken('--chart-3',          LIGHT_FALLBACK.chart3),
    chart4:        readToken('--chart-4',          LIGHT_FALLBACK.chart4),
    chart5:        readToken('--chart-5',          LIGHT_FALLBACK.chart5),
    chart6:        readToken('--chart-6',          LIGHT_FALLBACK.chart6),
    chart7:        readToken('--chart-7',          LIGHT_FALLBACK.chart7),
    chart8:        readToken('--chart-8',          LIGHT_FALLBACK.chart8),
    chartGrid:     readToken('--chart-grid',       LIGHT_FALLBACK.chartGrid),
    chartAxis:     readToken('--chart-axis-text',  LIGHT_FALLBACK.chartAxis),
    chartMetaLine: readToken('--chart-meta-line',  LIGHT_FALLBACK.chartMetaLine),
    brand400:      readToken('--brand-400',        LIGHT_FALLBACK.brand400),
    brand600:      readToken('--brand-600',        LIGHT_FALLBACK.brand600),
    brand700:      readToken('--brand-700',        LIGHT_FALLBACK.brand700),
    chartFillLow:  readToken('--chart-fill-low',   LIGHT_FALLBACK.chartFillLow),
    chartFillMid:  readToken('--chart-fill-mid',   LIGHT_FALLBACK.chartFillMid),
    chartFillHigh: readToken('--chart-fill-high',  LIGHT_FALLBACK.chartFillHigh),
  };
}

/** Color por score: alto≥80 ok / medio≥50 warn / bajo bad / null chart8. */
export function colorForScore(
  tokens: ChartTokens,
  score: number | null | undefined,
  thresholds: { high?: number; mid?: number } = {},
): string {
  if (score == null) return tokens.chart8;
  const high = thresholds.high ?? 80;
  const mid = thresholds.mid ?? 50;
  if (score >= high) return tokens.okFg;
  if (score >= mid) return tokens.warnFg;
  return tokens.badFg;
}

/** Cicla chart-1..chart-8 para N series. */
export function chartSeriesPalette(tokens: ChartTokens, n: number): string[] {
  const base = [
    tokens.chart1, tokens.chart2, tokens.chart3, tokens.chart4,
    tokens.chart5, tokens.chart6, tokens.chart7, tokens.chart8,
  ];
  const result: string[] = [];
  for (let i = 0; i < n; i++) result.push(base[i % base.length]);
  return result;
}
