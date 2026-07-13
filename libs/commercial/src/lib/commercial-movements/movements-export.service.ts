import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';

/**
 * DM.6 — Export del Diario de movimientos a XLSX (ExcelJS) y PDF (puppeteer),
 * mismo patrón que SellOutExportService. Dos secciones:
 *   1. Documentos (folios englobados, con estado de traspaso y auditoría)
 *   2. Validación de traspasos (salida ↔ recepción con Δ)
 */

export interface MovementsExportData {
  range: { from: string; to: string };
  totals: { entradas: number; salidas: number; valor: number; documentos: number };
  docs: any[];       // filas de lines() (folio englobado + transfer_status + audited)
  transfers: any[];  // filas de transfersCheck()
  truncated: boolean;
}

const ESTADO_LABEL: Record<string, string> = {
  en_transito: 'En tránsito', completado: 'Completado', diferencia: 'Diferencia',
  ok: 'Recibido', sin_recepcion: 'Sin recepción', sin_origen: 'Sin origen',
};

@Injectable()
export class MovementsExportService {
  private readonly logger = new Logger(MovementsExportService.name);

  fileName(range: { from: string; to: string }, ext: string): string {
    return `Diario de movimientos ${range.from}_${range.to}.${ext}`;
  }

  private fmtDate(d: any): string {
    return d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '';
  }

  // ─────────── XLSX ───────────

  async buildXlsx(data: MovementsExportData): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();

    // Hoja 1 — Documentos
    const ws = wb.addWorksheet('Documentos', { views: [{ state: 'frozen', ySplit: 2 }] });
    ws.mergeCells(1, 1, 1, 10);
    const title = ws.getCell(1, 1);
    title.value = `DIARIO DE MOVIMIENTOS  ·  ${data.range.from} — ${data.range.to}`;
    title.font = { bold: true, size: 13 };
    ws.getRow(1).height = 22;

    ws.getRow(2).values = ['Fecha', 'Tipo', 'Folio', 'Almacén', 'Líneas', 'Cantidad', 'Valor', 'Estado traspaso', 'Auditado', 'Auditado por'];
    ws.getRow(2).font = { bold: true };
    ws.columns = [
      { width: 12 }, { width: 24 }, { width: 10 }, { width: 9 }, { width: 8 },
      { width: 12 }, { width: 14 }, { width: 15 }, { width: 10 }, { width: 18 },
    ] as any;

    for (const d of data.docs) {
      ws.addRow([
        this.fmtDate(d.doc_date), d.movement_label, d.folio, d.warehouse_code || d.source_branch,
        Number(d.lineas) || 0, Number(d.signed_qty) || 0, Number(d.amount) || 0,
        d.transfer_status ? ESTADO_LABEL[d.transfer_status] || d.transfer_status : '',
        d.audited ? 'Sí' : 'No', d.audited_by || '',
      ]);
    }
    ws.getColumn(6).numFmt = '#,##0';
    ws.getColumn(7).numFmt = '"$"#,##0.00';
    const totRow = ws.addRow(['TOTAL', '', '', '', '', '', data.totals.valor, '', '', '']);
    totRow.font = { bold: true };
    if (data.truncated) ws.addRow([`(reporte truncado a ${data.docs.length} documentos)`]);

    // Hoja 2 — Validación de traspasos
    const wt = wb.addWorksheet('Traspasos', { views: [{ state: 'frozen', ySplit: 2 }] });
    wt.mergeCells(1, 1, 1, 10);
    const t2 = wt.getCell(1, 1);
    t2.value = `VALIDACIÓN DE TRASPASOS (salida ↔ recepción)  ·  ${data.range.from} — ${data.range.to}`;
    t2.font = { bold: true, size: 13 };
    wt.getRow(1).height = 22;
    wt.getRow(2).values = ['Estado', 'Origen', 'Folio salida', 'Fecha salida', 'Enviadas', 'Destino', 'Folio recepción', 'Fecha recepción', 'Recibidas', 'Δ piezas'];
    wt.getRow(2).font = { bold: true };
    wt.columns = [
      { width: 14 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 11 },
      { width: 8 }, { width: 14 }, { width: 14 }, { width: 11 }, { width: 10 },
    ] as any;
    for (const r of data.transfers) {
      wt.addRow([
        ESTADO_LABEL[r.status] || r.status, r.origin_wh || '', r.origin_folio || '', this.fmtDate(r.ship_date),
        r.qty_sent != null ? Number(r.qty_sent) : '', r.dest_wh || '', r.rcv_folio || '', this.fmtDate(r.rcv_date),
        r.qty_received != null ? Number(r.qty_received) : '', Number(r.delta) || 0,
      ]);
    }
    wt.getColumn(5).numFmt = '#,##0';
    wt.getColumn(9).numFmt = '#,##0';
    wt.getColumn(10).numFmt = '#,##0';

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ─────────── PDF ───────────

  async buildPdf(data: MovementsExportData): Promise<Buffer> {
    const html = this.buildHtml(data);
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      ...(process.env.PUPPETEER_EXECUTABLE_PATH
        ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      const pdf = await page.pdf({
        format: 'A4', landscape: true, printBackground: true,
        margin: { top: '10mm', right: '8mm', bottom: '10mm', left: '8mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private buildHtml(data: MovementsExportData): string {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
    const money = (n: number) => (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
    const num = (n: any) => n == null || n === '' ? '·' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: 0 });

    const PDF_CAP = 1200; // el PDF es para lectura; el detalle completo va en el XLSX
    const docs = data.docs.slice(0, PDF_CAP);
    const docRows = docs.map((d) => `
      <tr><td>${esc(this.fmtDate(d.doc_date))}</td><td class="d">${esc(d.movement_label)}</td><td>${esc(d.folio)}</td>
      <td>${esc(d.warehouse_code || d.source_branch)}</td><td class="n">${num(d.lineas)}</td>
      <td class="n">${num(d.signed_qty)}</td><td class="n">${money(d.amount)}</td>
      <td>${esc(d.transfer_status ? ESTADO_LABEL[d.transfer_status] : '·')}</td><td>${d.audited ? 'Sí' : 'No'}</td></tr>`).join('');

    const trRows = data.transfers.map((r) => `
      <tr><td class="${r.status === 'ok' ? 'ok' : r.status === 'diferencia' ? 'warn' : 'bad'}">${esc(ESTADO_LABEL[r.status] || r.status)}</td>
      <td>${esc(r.origin_wh || '·')}</td><td>${esc(r.origin_folio || '·')}</td><td>${esc(this.fmtDate(r.ship_date) || '·')}</td><td class="n">${num(r.qty_sent)}</td>
      <td>${esc(r.dest_wh || '·')}</td><td>${esc(r.rcv_folio || '·')}</td><td>${esc(this.fmtDate(r.rcv_date) || '·')}</td><td class="n">${num(r.qty_received)}</td>
      <td class="n b">${num(r.delta)}</td></tr>`).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; } body { font-family: Arial, Helvetica, sans-serif; font-size: 8.5px; color: #1c1917; margin: 0; }
      h1 { font-size: 14px; margin: 0 0 2px; } .sub { color: #57534e; margin: 0 0 8px; font-size: 9px; }
      h2 { font-size: 11px; margin: 14px 0 4px; }
      .kpis { display: flex; gap: 14px; margin: 6px 0 10px; }
      .kpi { border: 1px solid #d6d3d1; border-radius: 4px; padding: 4px 10px; }
      .kpi-l { display: block; color: #78716c; font-size: 7.5px; text-transform: uppercase; }
      .kpi-v { font-weight: bold; font-size: 11px; }
      table { border-collapse: collapse; width: 100%; }
      th { background: #f5f5f4; border: 1px solid #d6d3d1; padding: 3px 5px; text-align: left; font-size: 8px; }
      td { border: 1px solid #e7e5e4; padding: 2.5px 5px; }
      .n { text-align: right; font-variant-numeric: tabular-nums; } .d { max-width: 160px; } .b { font-weight: bold; }
      .ok { color: #15803d; } .warn { color: #b45309; font-weight: bold; } .bad { color: #b91c1c; font-weight: bold; }
      tr { page-break-inside: avoid; }
    </style></head><body>
      <h1>Diario de movimientos</h1>
      <p class="sub">${esc(data.range.from)} — ${esc(data.range.to)} · Mega Dulces</p>
      <div class="kpis">
        <div class="kpi"><span class="kpi-l">Entradas</span><span class="kpi-v">+${num(data.totals.entradas)}</span></div>
        <div class="kpi"><span class="kpi-l">Salidas</span><span class="kpi-v">−${num(Math.abs(data.totals.salidas))}</span></div>
        <div class="kpi"><span class="kpi-l">Valor movido</span><span class="kpi-v">${money(data.totals.valor)}</span></div>
        <div class="kpi"><span class="kpi-l">Documentos</span><span class="kpi-v">${num(data.totals.documentos)}</span></div>
      </div>
      <h2>Documentos${data.docs.length > PDF_CAP ? ` (primeros ${PDF_CAP} de ${data.docs.length} — el detalle completo está en el Excel)` : ''}</h2>
      <table><thead><tr><th>Fecha</th><th>Tipo</th><th>Folio</th><th>Almacén</th><th>Líneas</th><th>Cantidad</th><th>Valor</th><th>Estado</th><th>Auditado</th></tr></thead>
      <tbody>${docRows}</tbody></table>
      <h2>Validación de traspasos (salida ↔ recepción)</h2>
      <table><thead><tr><th>Estado</th><th>Origen</th><th>Folio salida</th><th>Fecha</th><th>Enviadas</th><th>Destino</th><th>Folio recep.</th><th>Fecha</th><th>Recibidas</th><th>Δ</th></tr></thead>
      <tbody>${trRows || '<tr><td colspan="10">Sin traspasos en el rango.</td></tr>'}</tbody></table>
    </body></html>`;
  }
}
