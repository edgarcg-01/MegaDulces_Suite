// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver transfers-annotate-folio.spec.ts).
import * as ExcelJS from 'exceljs';
import { MovementsExportService, MovementsExportData } from './movements-export.service';

/**
 * `[MX.2.1]` — **Los KPIs de traspasos del Excel/PDF salen del conjunto completo, no de las filas.**
 *
 * ⛔ El defecto: `transfers` viene cortada en 500 con los problemas primero, y el export contaba
 * «Recibidos OK», «Δ neto» y «Valor enviado» sobre esas filas. Medido en prod el 2026-10-28 con el
 * código de HEAD: en los últimos 30 días el Excel decía **0 recibidos OK y $7.5 M enviados**; el
 * conjunto completo tenía **1,215 OK y $54.5 M**. Este caso reproduce esa forma: 500 filas, todas
 * problema, contra totales de 2,892 traspasos.
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

const kpis = async (buf: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.getWorksheet('Traspasos')!;
  const out: Record<string, any> = {};
  for (let col = 1; col <= 11; col += 2) out[String(ws.getCell(5, col).value)] = ws.getCell(6, col).value;
  const col1: string[] = [];
  ws.eachRow((r) => col1.push(String(r.getCell(1).value ?? '')));
  return { out, col1 };
};

describe('[MX.2.1] KPIs de traspasos del export', () => {
  const svc = new MovementsExportService();

  it('el Excel toma conteos y sumas de los totales, no de las 500 filas listadas', async () => {
    const { out } = await kpis(await svc.buildXlsx(data()));
    expect(out['RECIBIDOS OK']).toBe(1215);
    expect(out['SIN RECEPCIÓN']).toBe(1677);
    expect(out['Δ NETO (PZAS)']).toBe(-760148);
    expect(out['VALOR ENVIADO']).toBe(54546346);
  });

  it('el Excel declara que el listado está recortado y rotula su TOTAL como de las filas listadas', async () => {
    const { col1 } = await kpis(await svc.buildXlsx(data()));
    expect(col1).toContain('TOTAL (filas listadas)');
    expect(col1.some((s) => s.includes('los primeros 500 de 2,892 traspasos'))).toBe(true);
  });

  it('sin recorte no hay nota ni rótulo de filas listadas', async () => {
    const d = data();
    d.transfers = d.transfers.slice(0, 3);
    d.transfer_sums = { ...d.transfer_sums, n: 3 };
    const { col1 } = await kpis(await svc.buildXlsx(d));
    expect(col1).toContain('TOTAL');
    expect(col1.some((s) => s.includes('los primeros'))).toBe(false);
  });

  it('el tope del pareo (capped) se declara como indicadores INCOMPLETOS', async () => {
    const d = data();
    d.transfers_capped = true;
    const { col1 } = await kpis(await svc.buildXlsx(d));
    expect(col1.some((s) => s.includes('INCOMPLETOS'))).toBe(true);
  });

  it('el PDF usa los mismos totales', () => {
    const html: string = (svc as any).buildHtml(data());
    expect(html).toContain('1,215 recibidos OK');
    expect(html).toContain('primeros 500 de 2,892');
    expect(html).toContain('TOTAL (filas listadas)');
  });
});
