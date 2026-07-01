import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';
import type { SellOutReport, SellOutColumn } from './commercial-analytics.service';

/**
 * Exporta un {@link SellOutReport} a XLSX (ExcelJS) y PDF (puppeteer), con el
 * formato del reporte manual: título + encabezado de 2 filas (sucursal×canal
 * con pares Cajas/Monto) + columna TOTAL + fila de totales.
 */
@Injectable()
export class SellOutExportService {
  private readonly logger = new Logger(SellOutExportService.name);

  private colLabel(c: SellOutColumn): string {
    return c.channel_label ? `${c.branch_name} · ${c.channel_label}` : c.branch_name;
  }

  private periodLabel(from: string, to: string): string {
    const fmt = (s: string) =>
      new Date(s + 'T12:00:00').toLocaleDateString('es-MX', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    return `${fmt(from)} — ${fmt(to)}`;
  }

  fileName(report: SellOutReport, ext: string): string {
    const brand = (report.brand.nombre || 'EMPRESA').replace(/[^\w\s-]/g, '').trim().slice(0, 40);
    return `SELL OUT ${brand} ${report.period.from}_${report.period.to}.${ext}`;
  }

  // ─────────── XLSX ───────────

  async buildXlsx(report: SellOutReport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const ws = wb.addWorksheet('Sell Out', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }],
    });

    const cols = report.columns;
    // 3 fijas (código, desc, uxc) + 2 por columna + 2 total
    const totalCols = 3 + cols.length * 2 + 2;

    // Fila 1 — título
    ws.mergeCells(1, 1, 1, totalCols);
    const title = ws.getCell(1, 1);
    title.value = `SELL OUT  ${report.brand.nombre}  ·  ${this.periodLabel(report.period.from, report.period.to)}`;
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    // Fila 2/3 — encabezado
    const r2 = ws.getRow(2);
    const r3 = ws.getRow(3);
    ws.mergeCells(2, 1, 3, 1);
    ws.mergeCells(2, 2, 3, 2);
    ws.mergeCells(2, 3, 3, 3);
    ws.getCell(2, 1).value = 'CÓDIGO';
    ws.getCell(2, 2).value = 'DESCRIPCIÓN';
    ws.getCell(2, 3).value = 'UXC';

    cols.forEach((c, i) => {
      const cajasCol = 4 + i * 2;
      ws.mergeCells(2, cajasCol, 2, cajasCol + 1);
      ws.getCell(2, cajasCol).value = this.colLabel(c);
      r3.getCell(cajasCol).value = 'CAJAS';
      r3.getCell(cajasCol + 1).value = 'MONTO';
    });
    const totCajasCol = 4 + cols.length * 2;
    ws.mergeCells(2, totCajasCol, 2, totCajasCol + 1);
    ws.getCell(2, totCajasCol).value = 'TOTAL';
    r3.getCell(totCajasCol).value = 'CAJAS';
    r3.getCell(totCajasCol + 1).value = 'MONTO';

    [r2, r3].forEach((row) => {
      row.eachCell((cell) => {
        cell.font = { bold: true, size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
        cell.border = this.thin();
      });
    });
    r2.height = 30;

    const CAJAS_FMT = '#,##0.00';
    const MONEY_FMT = '$#,##0.00';

    // Filas de datos
    let rowIdx = 4;
    for (const prod of report.rows) {
      const row = ws.getRow(rowIdx++);
      row.getCell(1).value = prod.sku;
      row.getCell(2).value = prod.nombre;
      row.getCell(3).value = prod.uxc ?? '';
      cols.forEach((c, i) => {
        const cell = prod.cells[c.key];
        const cajasCol = 4 + i * 2;
        row.getCell(cajasCol).value = cell ? cell.cajas : 0;
        row.getCell(cajasCol + 1).value = cell ? cell.monto : 0;
        row.getCell(cajasCol).numFmt = CAJAS_FMT;
        row.getCell(cajasCol + 1).numFmt = MONEY_FMT;
      });
      row.getCell(totCajasCol).value = prod.total.cajas;
      row.getCell(totCajasCol + 1).value = prod.total.monto;
      row.getCell(totCajasCol).numFmt = CAJAS_FMT;
      row.getCell(totCajasCol + 1).numFmt = MONEY_FMT;
      row.getCell(totCajasCol).font = { bold: true };
      row.getCell(totCajasCol + 1).font = { bold: true };
      row.eachCell((cell) => (cell.border = this.thin()));
    }

    // Fila de totales
    const totRow = ws.getRow(rowIdx);
    ws.mergeCells(rowIdx, 1, rowIdx, 3);
    totRow.getCell(1).value = 'TOTAL';
    cols.forEach((c, i) => {
      const t = report.column_totals[c.key] ?? { cajas: 0, monto: 0 };
      const cajasCol = 4 + i * 2;
      totRow.getCell(cajasCol).value = t.cajas;
      totRow.getCell(cajasCol + 1).value = t.monto;
      totRow.getCell(cajasCol).numFmt = CAJAS_FMT;
      totRow.getCell(cajasCol + 1).numFmt = MONEY_FMT;
    });
    totRow.getCell(totCajasCol).value = report.grand_total.cajas;
    totRow.getCell(totCajasCol + 1).value = report.grand_total.monto;
    totRow.getCell(totCajasCol).numFmt = CAJAS_FMT;
    totRow.getCell(totCajasCol + 1).numFmt = MONEY_FMT;
    totRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
      cell.border = this.thin();
    });

    // Anchos
    ws.getColumn(1).width = 10;
    ws.getColumn(2).width = 40;
    ws.getColumn(3).width = 6;
    for (let c = 4; c <= totalCols; c++) ws.getColumn(c).width = 12;

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  private thin(): Partial<ExcelJS.Borders> {
    const s = { style: 'thin' as const, color: { argb: 'FFD8D5CE' } };
    return { top: s, left: s, bottom: s, right: s };
  }

  // ─────────── PDF ───────────

  async buildPdf(report: SellOutReport): Promise<Buffer> {
    const html = this.buildHtml(report);
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
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '10mm', right: '8mm', bottom: '10mm', left: '8mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private buildHtml(report: SellOutReport): string {
    const esc = (s: any) =>
      String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
    const money = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
    const num = (n: number) => n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cols = report.columns;

    const topHeads = cols.map((c) => `<th colspan="2">${esc(this.colLabel(c))}</th>`).join('') + `<th colspan="2">TOTAL</th>`;
    const subHeads = cols.map(() => `<th>Cajas</th><th class="m">Monto</th>`).join('') + `<th>Cajas</th><th class="m">Monto</th>`;

    const body = report.rows
      .map((p) => {
        const cells = cols
          .map((c) => {
            const cell = p.cells[c.key];
            return `<td class="n">${cell ? num(cell.cajas) : '·'}</td><td class="n m">${cell ? money(cell.monto) : '·'}</td>`;
          })
          .join('');
        return `<tr><td>${esc(p.sku)}</td><td class="d">${esc(p.nombre)}</td><td class="n">${p.uxc ?? ''}</td>${cells}<td class="n b">${num(p.total.cajas)}</td><td class="n m b">${money(p.total.monto)}</td></tr>`;
      })
      .join('');

    const totCells = cols
      .map((c) => {
        const t = report.column_totals[c.key] ?? { cajas: 0, monto: 0 };
        return `<td class="n">${num(t.cajas)}</td><td class="n m">${money(t.monto)}</td>`;
      })
      .join('');
    const totRow = `<tr class="tot"><td colspan="3">TOTAL</td>${totCells}<td class="n">${num(report.grand_total.cajas)}</td><td class="n m">${money(report.grand_total.monto)}</td></tr>`;

    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box} body{font-family:'Hanken Grotesk',Arial,sans-serif;color:#1c1917;margin:0;padding:4px}
      h1{font-size:14px;margin:0 0 2px} .sub{font-size:10px;color:#57534e;margin:0 0 8px}
      .note{font-size:8px;color:#78716c;margin:6px 0 0}
      table{border-collapse:collapse;width:100%;font-size:7.5px}
      th,td{border:1px solid #d8d5ce;padding:2px 3px;text-align:center}
      th{background:#f1f0ec;font-weight:700}
      td.d{text-align:left;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
      td.n{text-align:right;font-variant-numeric:tabular-nums} td.m{border-right:1px solid #b8b4ad}
      td.b,tr.tot td{font-weight:700} tr.tot td{background:#f1f0ec}
      tr:nth-child(even) td{background:#faf9f7}
    </style></head><body>
      <h1>SELL OUT · ${esc(report.brand.nombre)}</h1>
      <p class="sub">${esc(this.periodLabel(report.period.from, report.period.to))} · ${report.rows.length} productos</p>
      <table><thead>
        <tr><th rowspan="2">Código</th><th rowspan="2">Descripción</th><th rowspan="2">UXC</th>${topHeads}</tr>
        <tr>${subHeads}</tr>
      </thead><tbody>${body}${totRow}</tbody></table>
      <p class="note">${esc(report.coverage.note)}</p>
    </body></html>`;
  }
}
