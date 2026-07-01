import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';
import type { SellOutReport, SellOutColumn, SalidasReport } from './commercial-analytics.service';

const MONTH_LABEL: Record<string, string> = {
  '01': 'Enero', '02': 'Febrero', '03': 'Marzo', '04': 'Abril', '05': 'Mayo', '06': 'Junio',
  '07': 'Julio', '08': 'Agosto', '09': 'Septiembre', '10': 'Octubre', '11': 'Noviembre', '12': 'Diciembre',
};

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

  // ─────────── SAL — Salidas/Ventas por Producto (XLSX estilo Kepler) ───────────

  salidasFileName(report: SalidasReport): string {
    return `Salidas_por_Producto_${report.year}.xlsx`;
  }

  async buildSalidasXlsx(report: SalidasReport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    const ws = wb.addWorksheet('Salidas por Producto', { views: [{ state: 'frozen', ySplit: 1 }] });
    const months = report.months;

    const headBase = ['#', 'Sucursal', 'Clave producto', 'Descripcion del producto', 'UXC', 'SN', 'CN', 'CostoCIVA', 'CostoXCaja', 'Exist. Paq. Actual', 'Exist. Cja. Actual', 'Costo Caja'];
    const head: string[] = [...headBase];
    for (const m of months) { head.push(`Venta ${MONTH_LABEL[m] ?? m}`, `Costo ${MONTH_LABEL[m] ?? m}`); }
    head.push('Venta TOTAL');
    ws.addRow(head);
    const hr = ws.getRow(1);
    hr.eachCell((c) => {
      c.font = { bold: true, size: 9 };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      c.border = this.thin();
    });
    hr.height = 28;

    const MONEY = '$#,##0.00';
    report.rows.forEach((r, i) => {
      const row: (string | number)[] = [
        i + 1, r.warehouse_name, r.sku, r.nombre, r.uxc ?? '', r.supplier ?? '', r.brand ?? '',
        r.costo_civa ?? 0, r.costo_caja ?? 0, r.exist_paq, r.exist_cja, r.costo_existencia,
      ];
      for (const m of months) {
        const cell = r.monthly[m];
        row.push(cell ? cell.venta : 0, cell ? cell.costo : 0);
      }
      row.push(r.venta_total);
      const added = ws.addRow(row);
      // formato moneda en columnas de costo
      [8, 9, 12].forEach((ci) => (added.getCell(ci).numFmt = MONEY));
      months.forEach((_, mi) => (added.getCell(14 + mi * 2).numFmt = MONEY)); // Costo mensual
    });

    ws.getColumn(2).width = 18;
    ws.getColumn(3).width = 12;
    ws.getColumn(4).width = 34;
    ws.getColumn(6).width = 22;
    ws.getColumn(7).width = 22;
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

    const period = this.periodLabel(report.period.from, report.period.to);
    const sucursales = report.coverage?.branches_with_data?.length ?? 0;

    // KPIs (mismo lenguaje que la tabla "MÉTRICAS PRINCIPALES" del PDF de /reports)
    const kpis: Array<[string, string]> = [
      ['Monto total', money(report.grand_total.monto)],
      ['Cajas', report.grand_total.cajas.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })],
      ['Productos', String(report.rows.length)],
      ['Sucursales', String(sucursales)],
    ];
    const kpiCells = kpis
      .map(([l, v]) => `<div class="kpi"><span class="kpi-l">${esc(l)}</span><span class="kpi-v">${esc(v)}</span></div>`)
      .join('');

    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}
      body{font-family:Helvetica,Arial,sans-serif;color:#09090b;background:#fff;margin:0;padding:24px 18px}
      /* Header ejecutivo: marca izq · reporte der (estilo PDF /reports) */
      .hd{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
      .hd .brand{font-size:15px;font-weight:700;letter-spacing:.02em}
      .hd .brand small{display:block;font-size:9px;font-weight:400;color:#52525b;margin-top:2px;letter-spacing:.04em}
      .hd .rep{text-align:right}
      .hd .rep .t{font-size:16px;font-weight:700}
      .hd .rep .s{font-size:9px;color:#52525b;margin-top:2px}
      /* Caja de periodo */
      .period{background:#f4f4f5;border-radius:6px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
      .period .lbl{font-size:8px;font-weight:700;letter-spacing:.06em;color:#52525b}
      .period .val{font-size:11px;font-weight:700;color:#3f3f46}
      .period .ch{font-size:8.5px;color:#52525b}
      /* KPIs */
      .kpis{display:flex;gap:10px;margin-bottom:16px}
      .kpi{flex:1;border:1px solid #e4e4e7;border-radius:6px;padding:8px 10px}
      .kpi-l{display:block;font-size:8px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#71717a}
      .kpi-v{display:block;font-size:15px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums}
      /* Sección */
      .sec{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:0 0 6px}
      /* Tabla grid (tema del autoTable de /reports) */
      table{border-collapse:collapse;width:100%;font-size:7px}
      th,td{border:.5px solid #e4e4e7;padding:2.5px 3px;text-align:center}
      th{background:#f4f4f5;font-weight:700;color:#3f3f46}
      td.d{text-align:left;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
      td.n{text-align:right;font-variant-numeric:tabular-nums}
      td.m{border-right:1px solid #d4d4d8}
      td.b,tr.tot td{font-weight:700}
      tr.tot td{background:#f4f4f5}
      tbody tr:nth-child(even) td{background:#fafafa}
      .note{font-size:8px;color:#71717a;margin:10px 0 0;line-height:1.4}
    </style></head><body>
      <div class="hd">
        <div class="brand">MEGA DULCES<small>Trade Marketing · Sell-Out</small></div>
        <div class="rep"><div class="t">Reporte Sell-Out</div><div class="s">${esc(report.brand.nombre)}</div></div>
      </div>
      <div class="period">
        <div><span class="lbl">PERÍODO DE ANÁLISIS</span> &nbsp; <span class="val">${esc(period)}</span></div>
        <span class="ch">${report.rows.length} productos · ${cols.length} columnas</span>
      </div>
      <div class="kpis">${kpiCells}</div>
      <div class="sec">Detalle por producto</div>
      <table><thead>
        <tr><th rowspan="2">Código</th><th rowspan="2">Descripción</th><th rowspan="2">UXC</th>${topHeads}</tr>
        <tr>${subHeads}</tr>
      </thead><tbody>${body}${totRow}</tbody></table>
      <p class="note">${esc(report.coverage.note)}</p>
    </body></html>`;
  }
}
