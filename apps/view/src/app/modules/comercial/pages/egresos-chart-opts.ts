/**
 * Opciones Chart.js theme-aware para las barras de egresos (compras/gastos apiladas).
 * Chart.js no lee CSS vars, por eso se pasan colores explícitos según el tema: sin
 * esto los ejes/leyenda usan el gris default (#666) que en dark mode queda ilegible.
 * Reutilizado por /finanzas/egresos y /finanzas/egresos/detalle.
 */
export function egresChartOptions(dark: boolean) {
  const axis = dark ? '#B0A595' : '#57534E';
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
