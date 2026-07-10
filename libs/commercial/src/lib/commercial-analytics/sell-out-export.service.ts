import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';
import type { SellOutReport, SellOutColumn, SalidasReport, SalesByRouteReport, TransfersReport } from './commercial-analytics.service';

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
    return report.mode === 'range'
      ? `Salidas_por_Producto_${report.from}_a_${report.to}.xlsx`
      : `Salidas_por_Producto_${report.year}.xlsx`;
  }

  async buildSalidasXlsx(report: SalidasReport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    // Congela identidad (# + Sucursal + Clave + Descripción) y el encabezado.
    const ws = wb.addWorksheet('Salidas por Producto', { views: [{ state: 'frozen', xSplit: 4, ySplit: 1 }] });
    const months = report.months;
    const isRange = report.mode === 'range';
    const MONEY = '$#,##0.00';
    const NUM = '#,##0';

    // total: se suma en la fila de totales. kind: para formato condicional.
    type Col = { h: string; v: (r: SalidasReport['rows'][number], i: number) => string | number; fmt?: string; total?: boolean; kind?: 'delta' | 'cov' };
    const cols: Col[] = [
      { h: '#', v: (_r, i) => i + 1 },
      { h: 'Sucursal', v: (r) => r.warehouse_name },
      { h: 'Clave producto', v: (r) => r.sku },
      { h: 'Descripcion del producto', v: (r) => r.nombre },
      { h: 'UXC', v: (r) => r.uxc ?? '' },
      { h: 'Unidad', v: (r) => r.unit_sale ?? '' },
      { h: 'SN', v: (r) => r.supplier ?? '' },
      { h: 'CN', v: (r) => r.brand ?? '' },
      { h: 'Categoria', v: (r) => r.categoria ?? '' },
      { h: 'Rotacion', v: (r) => r.rotation_tier ?? '' },
      { h: 'CostoCIVA', v: (r) => r.costo_civa ?? 0, fmt: MONEY },
      { h: 'CostoXCaja', v: (r) => r.costo_caja ?? 0, fmt: MONEY },
      { h: 'Exist. Pieza', v: (r) => r.exist_paq, fmt: NUM, total: true },
      { h: 'Exist. Paquete', v: (r) => r.exist_paquete ?? '', fmt: '#,##0.00', total: true },
      { h: 'Exist. Caja', v: (r) => r.exist_caja ?? '', fmt: '#,##0.00', total: true },
      { h: 'Valor Existencia', v: (r) => r.costo_existencia, fmt: MONEY, total: true },
    ];
    if (isRange) {
      const lbl = `${report.from}…${report.to}`;
      cols.push(
        { h: `Venta ${lbl}`, v: (r) => r.venta_total, fmt: NUM, total: true },
        { h: `Costo ${lbl}`, v: (r) => r.costo_total, fmt: MONEY, total: true },
        { h: 'Venta paquetes', v: (r) => r.venta_paquetes ?? '', fmt: '#,##0.0', total: true },
        { h: 'Dias cobertura', v: (r) => r.dias_cobertura ?? '', fmt: NUM, kind: 'cov' },
        { h: 'Venta anterior', v: (r) => r.venta_prev ?? 0, fmt: NUM, total: true },
        { h: 'Var %', v: (r) => (r.venta_delta_pct == null ? '' : r.venta_delta_pct / 100), fmt: '0.0%', kind: 'delta' },
      );
    } else {
      for (const m of months) {
        cols.push(
          { h: `Venta ${MONTH_LABEL[m] ?? m}`, v: (r) => r.monthly[m]?.venta ?? 0, fmt: NUM, total: true },
          { h: `Costo ${MONTH_LABEL[m] ?? m}`, v: (r) => r.monthly[m]?.costo ?? 0, fmt: MONEY, total: true },
        );
      }
      cols.push(
        { h: 'Venta TOTAL', v: (r) => r.venta_total, fmt: NUM, total: true },
        { h: 'Venta paquetes', v: (r) => r.venta_paquetes ?? '', fmt: '#,##0.0', total: true },
        { h: 'Dias cobertura', v: (r) => r.dias_cobertura ?? '', fmt: NUM, kind: 'cov' },
      );
    }

    ws.addRow(cols.map((c) => c.h));
    const hr = ws.getRow(1);
    hr.eachCell((c) => {
      c.font = { bold: true, size: 9 };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      c.border = this.thin();
    });
    hr.height = 28;

    report.rows.forEach((r, i) => {
      const added = ws.addRow(cols.map((c) => c.v(r, i)));
      cols.forEach((c, ci) => { if (c.fmt) added.getCell(ci + 1).numFmt = c.fmt; });
    });

    const n = report.rows.length;
    const lastCol = cols.length;
    const lastColL = ws.getColumn(lastCol).letter;
    if (n > 0) {
      const first = 2, last = 1 + n; // filas de datos
      // Autofiltro sobre encabezado + datos (la fila de totales queda fuera).
      ws.autoFilter = `A1:${lastColL}${last}`;

      // Fila de totales — SUBTOTAL(109) respeta el filtro activo.
      const totalRow = ws.addRow(cols.map((c, ci) => {
        if (ci === 0) return 'TOTAL';
        if (!c.total) return '';
        const L = ws.getColumn(ci + 1).letter;
        return { formula: `SUBTOTAL(109,${L}${first}:${L}${last})` } as any;
      }));
      totalRow.eachCell((cell, ci) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
        cell.border = { top: { style: 'thin', color: { argb: 'FFB8B4AC' } } };
        if (cols[ci - 1]?.fmt) cell.numFmt = cols[ci - 1].fmt!;
      });

      const range = `A${first}:${lastColL}${last}`;
      // Renglones alternados (1 regla, sin inflar el archivo).
      ws.addConditionalFormatting({ ref: range, rules: [
        { type: 'expression', priority: 3, formulae: ['MOD(ROW(),2)=0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFAFAF9' } } } } as any,
      ] });
      // Var % (verde sube / rojo baja) + Días cobertura (rojo quiebre / ámbar sobrestock).
      const deltaIdx = cols.findIndex((c) => c.kind === 'delta');
      if (deltaIdx >= 0) {
        const L = ws.getColumn(deltaIdx + 1).letter;
        ws.addConditionalFormatting({ ref: `${L}${first}:${L}${last}`, rules: [
          { type: 'cellIs', operator: 'greaterThan', priority: 1, formulae: ['0'], style: { font: { color: { argb: 'FF15803D' } } } } as any,
          { type: 'cellIs', operator: 'lessThan', priority: 2, formulae: ['0'], style: { font: { color: { argb: 'FFB91C1C' } } } } as any,
        ] });
      }
      const covIdx = cols.findIndex((c) => c.kind === 'cov');
      if (covIdx >= 0) {
        const L = ws.getColumn(covIdx + 1).letter;
        ws.addConditionalFormatting({ ref: `${L}${first}:${L}${last}`, rules: [
          { type: 'cellIs', operator: 'lessThan', priority: 1, formulae: ['8'], style: { font: { bold: true, color: { argb: 'FFB91C1C' } } } } as any,
          { type: 'cellIs', operator: 'greaterThan', priority: 2, formulae: ['120'], style: { font: { color: { argb: 'FFA16207' } } } } as any,
        ] });
      }
    }

    ws.getColumn(2).width = 18;
    ws.getColumn(3).width = 12;
    ws.getColumn(4).width = 34;
    ws.getColumn(6).width = 22;
    ws.getColumn(7).width = 22;
    ws.getColumn(8).width = 20;
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  // ─────────── RR — Ventas por Ruta (XLSX) ───────────

  salesByRouteFileName(report: SalesByRouteReport): string {
    return `Ventas_por_Ruta_${report.year}.xlsx`;
  }

  async buildSalesByRouteXlsx(report: SalesByRouteReport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    const ws = wb.addWorksheet('Ventas por Ruta', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
    const months = report.months;

    const head: string[] = ['Sucursal', 'Ruta'];
    for (const m of months) head.push(`Venta ${MONTH_LABEL[m] ?? m}`);
    head.push('Venta TOTAL', 'Unidades', 'Tickets', 'Share %');
    ws.addRow(head);
    const hr = ws.getRow(1);
    hr.eachCell((c) => {
      c.font = { bold: true, size: 9 };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      c.border = this.thin();
    });
    hr.height = 26;

    const MONEY = '$#,##0.00';
    for (const r of report.rows) {
      const row: (string | number)[] = [r.warehouse_name, `Ruta ${r.route_no}`];
      for (const m of months) row.push(r.monthly[m] ? r.monthly[m].revenue : 0);
      row.push(r.revenue_total, r.units_total, r.tickets_total, r.share_pct / 100);
      const added = ws.addRow(row);
      months.forEach((_, mi) => (added.getCell(3 + mi).numFmt = MONEY));
      added.getCell(3 + months.length).numFmt = MONEY; // Venta TOTAL
      added.getCell(3 + months.length).font = { bold: true };
      added.getCell(6 + months.length).numFmt = '0.0%'; // Share
    }

    // Fila de totales
    const totRow: (string | number)[] = ['TOTAL', ''];
    for (const m of months) totRow.push(report.monthly_totals[m] ? report.monthly_totals[m].revenue : 0);
    totRow.push(report.totals.revenue, report.totals.units, report.totals.tickets, 1);
    const tr = ws.addRow(totRow);
    tr.eachCell((c) => {
      c.font = { bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
      c.border = this.thin();
    });
    months.forEach((_, mi) => (tr.getCell(3 + mi).numFmt = MONEY));
    tr.getCell(3 + months.length).numFmt = MONEY;
    tr.getCell(6 + months.length).numFmt = '0.0%';

    ws.getColumn(1).width = 18;
    ws.getColumn(2).width = 10;
    for (let c = 3; c <= 2 + months.length + 4; c++) ws.getColumn(c).width = 13;

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  // ─────────── T — Traspasos (XLSX) ───────────

  transfersFileName(report: TransfersReport): string {
    return `Traspasos_${report.year}.xlsx`;
  }

  async buildTransfersXlsx(report: TransfersReport): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    const ws = wb.addWorksheet('Traspasos', { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] });
    const months = report.months;
    const PRE = 3; // columnas antes de los meses: Sucursal, Tipo, Destino

    const head: string[] = ['Sucursal', 'Tipo', 'Destino'];
    for (const m of months) head.push(MONTH_LABEL[m] ?? m);
    head.push('Valor TOTAL', 'Unidades', 'Docs', 'Share %');
    ws.addRow(head);
    const hr = ws.getRow(1);
    hr.eachCell((c) => {
      c.font = { bold: true, size: 9 };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      c.border = this.thin();
    });
    hr.height = 26;

    const MONEY = '$#,##0.00';
    for (const r of report.rows) {
      const row: (string | number)[] = [r.warehouse_name, r.kind_label, r.dest_label || '—'];
      for (const m of months) row.push(r.monthly[m] ? r.monthly[m].value : 0);
      row.push(r.value_total, r.units_total, r.docs_total, r.share_pct / 100);
      const added = ws.addRow(row);
      months.forEach((_, mi) => (added.getCell(PRE + 1 + mi).numFmt = MONEY));
      added.getCell(PRE + 1 + months.length).numFmt = MONEY;
      added.getCell(PRE + 1 + months.length).font = { bold: true };
      added.getCell(PRE + 3 + months.length).numFmt = '0.0%';
    }

    // Sin fila de TOTAL: los tipos (salida CEDIS / consolidación / recepción) NO son
    // sumables (misma mercancía en etapas distintas). El share ya es dentro de cada tipo.

    ws.getColumn(1).width = 18;
    ws.getColumn(2).width = 20;
    ws.getColumn(3).width = 26;
    for (let c = PRE + 1; c <= PRE + months.length + 4; c++) ws.getColumn(c).width = 13;

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
