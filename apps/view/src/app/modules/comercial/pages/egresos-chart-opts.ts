/**
 * Opciones Chart.js theme-aware para las barras de egresos (compras/gastos apiladas).
 * Chart.js no lee CSS vars, por eso se resuelven los tokens con getComputedStyle en
 * tiempo de render: ejes/leyenda desde --text-muted/--border-color y las SERIES desde
 * la secuencia categórica --chart-* (light+dark, sin morado). Un solo origen tokenizado
 * → flipa con el tema y respeta el design system. Reutilizado por /finanzas/egresos y
 * /finanzas/egresos/detalle.
 */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

/** Secuencia categórica tokenizada para las series de barras (resuelta por tema). */
export function egresChartSeries(): string[] {
  return [
    cssVar('--chart-1', '#F05A28'),
    cssVar('--chart-2', '#185FA5'),
    cssVar('--chart-3', '#16A34A'),
    cssVar('--chart-4', '#D97706'),
    cssVar('--chart-5', '#7C3AED'),
    cssVar('--chart-6', '#0891B2'),
    cssVar('--chart-7', '#DB2777'),
    cssVar('--chart-8', '#65A30D'),
  ];
}

export function egresChartOptions(dark: boolean) {
  const axis = cssVar('--text-muted', dark ? '#B0A595' : '#57534E');
  const grid = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.08)';
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom' as const, labels: { color: axis } } },
    scales: {
      x: { stacked: true, ticks: { color: axis }, grid: { color: grid } },
      y: {
        stacked: true,
        ticks: { color: axis, callback: (v: number) => '$' + Number(v).toLocaleString('es-MX') },
        grid: { color: grid },
      },
    },
  };
}
