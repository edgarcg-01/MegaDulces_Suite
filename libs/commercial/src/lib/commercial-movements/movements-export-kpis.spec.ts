// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver transfers-annotate-folio.spec.ts).
import { MovementsExportService, MovementsExportData } from './movements-export.service';

/**
 * `[MX.2.1]` — **Los KPIs de traspasos del PDF salen del conjunto completo, no de las filas.**
 *
 * ⛔ El defecto: `transfers` viene cortada en 500 con los problemas primero, y el export contaba
 * «recibidos OK» sobre esas filas. Medido en prod el 2026-10-28 con el código de HEAD: en los
 * últimos 30 días decía **0 recibidos OK**; el conjunto completo tenía **1,215**. Este caso
 * reproduce esa forma: 500 filas, todas problema, contra totales de 2,892 traspasos.
 * (El Excel se quitó el mismo día por decisión de Edgar: la reportería vive en la pantalla.)
 */
const data = (): MovementsExportData => ({
  range: { from: '2026-09-28', to: '2026-10-28' },
  totals: { entradas: 0, salidas: 0, valor: 0, documentos: 0 },
  docs: [],
  transfers: Array.from({ length: 500 }, (_, i) => ({
    status: 'sin_recepcion', origin_wh: 'CEDIS', origin_folio: String(i), ship_date: '2026-10-01',
    qty_sent: 10, amount: 100, dest_wh: 'Zamora', rcv_folio: null, rcv_date: null, qty_received: null, delta: -10,
  })),
  transfer_totals: { ok: 1215, diferencia: 0, sin_recepcion: 1677, sin_origen: 0 },
  transfer_sums: { n: 2892, qty_sent: 900000, qty_received: 139852, delta: -760148, amount: 54546346 },
  transfers_capped: false,
  truncated: false,
});

describe('[MX.2.1] KPIs de traspasos del PDF', () => {
  const svc = new MovementsExportService();
  const html = (d: MovementsExportData): string => (svc as unknown as { buildHtml(x: MovementsExportData): string }).buildHtml(d);

  it('toma los conteos de los totales, no de las 500 filas listadas', () => {
    const h = html(data());
    expect(h).toContain('1,215 recibidos OK');
    expect(h).toContain('1,677 sin recepción');
    expect(h).toContain('2,892 traspasos');
  });

  it('declara que el listado está recortado y rotula su TOTAL como de las filas listadas', () => {
    const h = html(data());
    expect(h).toContain('primeros 500 de 2,892');
    expect(h).toContain('TOTAL (filas listadas)');
    expect(h).toContain('los primeros 500 de 2,892 traspasos');
  });

  it('sin recorte no hay nota ni rótulo de filas listadas', () => {
    const d = data();
    d.transfers = d.transfers.slice(0, 3);
    d.transfer_sums = { ...d.transfer_sums, n: 3 };
    const h = html(d);
    expect(h).not.toContain('filas listadas');
    expect(h).not.toContain('los primeros');
  });

  it('[MX.1.2] «Valor movido» se declara parcial si hay renglones sin costo en Kepler', () => {
    const d = data();
    d.totals = { ...d.totals, valor: 154_702_114, lineas_sin_importe: 30 };
    expect(html(d)).toContain('parcial: 30 renglones sin costo en Kepler');
    d.totals = { ...d.totals, lineas_sin_importe: 0 };
    expect(html(d)).not.toContain('renglones sin costo');
  });

  it('el tope del pareo (capped) se declara como indicadores INCOMPLETOS', () => {
    const d = data();
    d.transfers_capped = true;
    expect(html(d)).toContain('INCOMPLETOS');
  });
});
