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

/**
 * [GX.19] Lo que hace falta saber de cada mes para no leer mal su barra: si el rango lo corta y
 * cuántas sucursales reportaron. Lo llena el servidor (`series[].parcial` / `.sucursales`).
 */
export interface EgresMesMeta { parcial: boolean; sucursales: number; }

export function egresChartOptions(dark: boolean, meta?: Map<string, EgresMesMeta>) {
  const axis = cssVar('--text-muted', dark ? '#A1A1AA' : '#52525B');
  const grid = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.08)';
  // [GX.19] El tooltip DECLARA por qué una barra es más baja o más alta que su vecina. Las dos
  // causas que no son gasto —mes cortado por el rango y sucursales que entran al universo— se leían
  // como auge y desplome: con el default de 90 días la gráfica dibujaba jun $20.5M / jul $62.1M /
  // ago $71.8M / sep $40.8M, y las puntas eran calendario.
  const declarar = (mes: string): string[] => {
    const m = meta?.get(String(mes).replace(' ·parcial', ''));
    if (!m) return [];
    const out: string[] = [];
    if (m.parcial) out.push('Mes incompleto: el rango lo corta — no es comparable con un mes entero.');
    if (m.sucursales) out.push(`${m.sucursales} sucursal${m.sucursales > 1 ? 'es' : ''} con movimiento.`);
    return out;
  };
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom' as const, labels: { color: axis } },
      tooltip: { callbacks: { afterBody: (items: Array<{ label: string }>) => declarar(items?.[0]?.label ?? '') } },
    },
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
