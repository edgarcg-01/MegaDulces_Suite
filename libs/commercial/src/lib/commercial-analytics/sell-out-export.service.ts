import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';
import type { SellOutReport, SellOutColumn, SellOutCell, SalidasReport, SalesByRouteReport, TransfersReport } from './commercial-analytics.service';
import type { PromoResult } from './route-promo.service';

/** RS — medida elegida en pantalla; decide las subcolumnas del export. */
export type SellOutMeasure = 'cajas' | 'monto' | 'ambas';

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
    const base = c.channel_label ? `${c.branch_name} · ${c.channel_label}` : c.branch_name;
    // RS.5/6 — fuente (Kepler) o vendedor Wincaja viaja en source_label.
    return c.source_label ? `${base} · ${c.source_label}` : base;
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

  // ─────────── Medida (cajas / monto / ambas) ───────────

  /**
   * RS — la "Medida" elegida en pantalla decide QUÉ subcolumnas lleva el export.
   * Antes el XLSX la ignoraba: la matriz sacaba siempre CAJAS+MONTO y el formato
   * por plaza siempre CAJAS, así que "Ambas" + "Por plaza" salía sin monto.
   */
  private subs(measure: SellOutMeasure): { label: string; pick: (c?: SellOutCell) => number; fmt: string }[] {
    const cajas = { label: 'CAJAS', pick: (c?: SellOutCell) => c?.cajas ?? 0, fmt: '#,##0.00' };
    const monto = { label: 'MONTO', pick: (c?: SellOutCell) => c?.monto ?? 0, fmt: '$#,##0.00' };
    return measure === 'cajas' ? [cajas] : measure === 'monto' ? [monto] : [cajas, monto];
  }

  // ─────────── XLSX ───────────

  async buildXlsx(report: SellOutReport, measure: SellOutMeasure = 'ambas'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const ws = wb.addWorksheet('Sell Out', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }],
    });

    const cols = report.columns;
    const subs = this.subs(measure);
    const N = subs.length; // subcolumnas por plaza/sucursal (1 si es una sola medida, 2 si "ambas")
    // 3 fijas (código, desc, uxc) + N por columna + N del TOTAL
    const totalCols = 3 + cols.length * N + N;

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
    // Identidad de fila: por producto (Código/Descr/UXC), empresa o MES (resumen mensual).
    // El mes viaja en `nombre` (col 2) → esa columna lleva la etiqueta 'MES'.
    ws.getCell(2, 1).value = report.row_dim === 'month' ? '' : 'CÓDIGO';
    ws.getCell(2, 2).value = report.row_dim === 'month' ? 'MES' : report.row_dim === 'brand' ? 'EMPRESA' : 'DESCRIPCIÓN';
    ws.getCell(2, 3).value = 'UXC';

    // Cabecera de grupo: con 2 subcolumnas se mergea horizontal (fila 2) y la 3 lleva
    // CAJAS/MONTO; con 1 sola medida no hay subtítulo → se mergea vertical 2-3.
    const groupHead = (col: number, label: string) => {
      if (N > 1) {
        ws.mergeCells(2, col, 2, col + N - 1);
        subs.forEach((s, k) => (r3.getCell(col + k).value = s.label));
      } else {
        ws.mergeCells(2, col, 3, col);
      }
      ws.getCell(2, col).value = label;
    };
    cols.forEach((c, i) => groupHead(4 + i * N, this.colLabel(c)));
    const totCol = 4 + cols.length * N;
    groupHead(totCol, 'TOTAL');

    [r2, r3].forEach((row) => {
      row.eachCell((cell) => {
        cell.font = { bold: true, size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
        cell.border = this.thin();
      });
    });
    r2.height = 30;

    // Filas de datos
    let rowIdx = 4;
    for (const prod of report.rows) {
      const row = ws.getRow(rowIdx++);
      row.getCell(1).value = prod.sku;
      row.getCell(2).value = prod.nombre;
      row.getCell(3).value = prod.uxc ?? '';
      cols.forEach((c, i) => {
        const cell = prod.cells[c.key];
        subs.forEach((s, k) => {
          const cc = row.getCell(4 + i * N + k);
          cc.value = s.pick(cell);
          cc.numFmt = s.fmt;
        });
      });
      subs.forEach((s, k) => {
        const cc = row.getCell(totCol + k);
        cc.value = s.pick(prod.total);
        cc.numFmt = s.fmt;
        cc.font = { bold: true };
      });
      row.eachCell((cell) => (cell.border = this.thin()));
    }

    // Fila de totales
    const totRow = ws.getRow(rowIdx);
    ws.mergeCells(rowIdx, 1, rowIdx, 3);
    totRow.getCell(1).value = 'TOTAL';
    cols.forEach((c, i) => {
      const t = report.column_totals[c.key];
      subs.forEach((s, k) => {
        const cc = totRow.getCell(4 + i * N + k);
        cc.value = s.pick(t);
        cc.numFmt = s.fmt;
      });
    });
    subs.forEach((s, k) => {
      const cc = totRow.getCell(totCol + k);
      cc.value = s.pick(report.grand_total);
      cc.numFmt = s.fmt;
    });
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

  // ─────────── RS.13 — Layout "por plaza" (formato estándar, CAJAS) ───────────

  /** Título del período para el reporte de plaza: mismo mes → "FEBRERO 2026"; si no, rango. */
  private plazaPeriodTitle(report: SellOutReport): string {
    const { from, to } = report.period;
    if (from.slice(0, 7) === to.slice(0, 7)) {
      const [y, m] = from.split('-');
      return `${(MONTH_LABEL[m] ?? m).toUpperCase()} ${y}`;
    }
    return this.periodLabel(from, to);
  }

  /**
   * XLSX del formato estándar por plaza: 1 grupo por plaza (SUCURSAL/MAYOREO/RUTAS) + TOTAL.
   * La MEDIDA elegida manda: 'cajas' (como el reporte manual, default histórico), 'monto',
   * o 'ambas' → dos subcolumnas CAJAS|MONTO por plaza.
   */
  async buildPlazaXlsx(report: SellOutReport, measure: SellOutMeasure = 'cajas'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const ws = wb.addWorksheet('Sell Out', { views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }] });
    const cols = report.columns;
    const subs = this.subs(measure);
    const N = subs.length;
    const totalCols = 3 + cols.length * N + N; // código, descripción, uxc + N/plaza + N del TOTAL

    // Fila 1 — título "SELL OUT  <MES AÑO>  <MARCA>"
    ws.mergeCells(1, 1, 1, totalCols);
    const title = ws.getCell(1, 1);
    title.value = `SELL OUT  ${this.plazaPeriodTitle(report)}  ${report.brand.nombre}`;
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    // Filas 2-3 — encabezado (una etiqueta por columna; se mergea vertical para el frozen ySplit:3).
    ws.mergeCells(2, 1, 3, 1); ws.mergeCells(2, 2, 3, 2); ws.mergeCells(2, 3, 3, 3);
    ws.getCell(2, 1).value = 'CÓDIGO';
    ws.getCell(2, 2).value = 'DESCRIPCIÓN';
    ws.getCell(2, 3).value = 'UXC';
    const r3 = ws.getRow(3);
    const groupHead = (col: number, label: string) => {
      if (N > 1) {
        ws.mergeCells(2, col, 2, col + N - 1);
        subs.forEach((s, k) => (r3.getCell(col + k).value = s.label));
      } else {
        ws.mergeCells(2, col, 3, col);
      }
      ws.getCell(2, col).value = label;
    };
    cols.forEach((c, i) => groupHead(4 + i * N, c.branch_name));
    const totCol = 4 + cols.length * N;
    groupHead(totCol, 'TOTAL');
    [2, 3].forEach((rn) => ws.getRow(rn).eachCell((cell) => {
      cell.font = { bold: true, size: 9 };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
      cell.border = this.thin();
    }));
    ws.getRow(2).height = 34;

    let rowIdx = 4;
    for (const prod of report.rows) {
      const row = ws.getRow(rowIdx++);
      row.getCell(1).value = prod.sku;
      row.getCell(2).value = prod.nombre;
      row.getCell(3).value = prod.uxc ?? '';
      cols.forEach((c, i) => {
        const cell = prod.cells[c.key];
        subs.forEach((s, k) => {
          const cc = row.getCell(4 + i * N + k);
          cc.value = s.pick(cell);
          cc.numFmt = s.fmt;
        });
      });
      subs.forEach((s, k) => {
        const tc = row.getCell(totCol + k);
        tc.value = s.pick(prod.total); tc.numFmt = s.fmt; tc.font = { bold: true };
      });
      row.eachCell((cell) => (cell.border = this.thin()));
    }

    // Fila de totales
    const totRow = ws.getRow(rowIdx);
    ws.mergeCells(rowIdx, 1, rowIdx, 3);
    totRow.getCell(1).value = 'TOTAL';
    cols.forEach((c, i) => {
      const t = report.column_totals[c.key];
      subs.forEach((s, k) => {
        const cc = totRow.getCell(4 + i * N + k);
        cc.value = s.pick(t); cc.numFmt = s.fmt;
      });
    });
    subs.forEach((s, k) => {
      const gc = totRow.getCell(totCol + k);
      gc.value = s.pick(report.grand_total); gc.numFmt = s.fmt;
    });
    totRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } };
      cell.border = this.thin();
    });

    ws.getColumn(1).width = 10;
    ws.getColumn(2).width = 42;
    ws.getColumn(3).width = 6;
    for (let c = 4; c <= totalCols; c++) ws.getColumn(c).width = 14;

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  // ─────────── RR-PROMO — Incentivo de ruta (XLSX + PDF) ───────────

  promoFileName(r: PromoResult, ext: string): string {
    const prod = (r.product?.nombre || r.product?.sku || 'PRODUCTO').replace(/[^\w\s-]/g, '').trim().slice(0, 40);
    return `Incentivo ${prod} ${r.period.from}_${r.period.to}.${ext}`;
  }

  async buildPromoXlsx(r: PromoResult): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces';
    wb.created = new Date();
    const MONEY = '$#,##0.00';
    const NUM = '#,##0.##';
    const head = (row: ExcelJS.Row) => row.eachCell((c) => {
      c.font = { bold: true, size: 9 }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } }; c.border = this.thin();
    });

    // Hoja 1 — Resumen por ruta
    const ws = wb.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.mergeCells(1, 1, 1, 5);
    ws.getCell(1, 1).value = `INCENTIVO — ${r.product?.nombre || ''}${r.product?.sku ? ' · ' + r.product.sku : ''}`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.mergeCells(2, 1, 2, 5);
    ws.getCell(2, 1).value = `${r.rule.descripcion || r.metric_label} · ${r.period.label} · $${r.rule.rate.toFixed(2)} por ${r.base_label.toLowerCase()}`;
    ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF52525B' } };
    ws.addRow([]);
    head(ws.addRow(['Ruta', 'Clientes', 'Piezas', 'Importe', 'Pago']));
    for (const row of r.rows) {
      const a = ws.addRow([row.label, row.clientes, row.piezas, row.importe, row.payout]);
      a.getCell(3).numFmt = NUM; a.getCell(4).numFmt = MONEY; a.getCell(5).numFmt = MONEY; a.getCell(5).font = { bold: true };
      a.eachCell((c) => (c.border = this.thin()));
    }
    const tot = ws.addRow(['TOTAL', r.total_clientes, r.total_piezas, r.total_importe, r.total_payout]);
    tot.getCell(3).numFmt = NUM; tot.getCell(4).numFmt = MONEY; tot.getCell(5).numFmt = MONEY;
    tot.eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F0EC' } }; c.border = this.thin(); });
    ws.getColumn(1).width = 34; ws.getColumn(2).width = 11; ws.getColumn(3).width = 11; ws.getColumn(4).width = 15; ws.getColumn(5).width = 13;

    // Hoja 2 — Clientes que participaron
    const wc = wb.addWorksheet('Clientes', { views: [{ state: 'frozen', ySplit: 1 }] });
    head(wc.addRow(['Ruta', 'Cliente', 'Nombre', 'Piezas', 'Importe']));
    for (const c of r.clientes_detalle) {
      const a = wc.addRow([c.route_label, c.cliente, c.nombre, c.piezas, c.importe]);
      a.getCell(4).numFmt = NUM; a.getCell(5).numFmt = MONEY;
      a.eachCell((cc) => (cc.border = this.thin()));
    }
    wc.getColumn(1).width = 32; wc.getColumn(2).width = 12; wc.getColumn(3).width = 40; wc.getColumn(4).width = 11; wc.getColumn(5).width = 15;
    if (r.clientes_detalle.length) wc.autoFilter = `A1:E${1 + r.clientes_detalle.length}`;

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  async buildPromoPdf(r: PromoResult): Promise<Buffer> {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
    const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
    const num = (n: number) => Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
    const sumRows = r.rows.map((x) => `<tr><td>${esc(x.label)}</td><td class="n">${x.clientes}</td><td class="n">${num(x.piezas)}</td><td class="n">${money(x.importe)}</td><td class="n b">${money(x.payout)}</td></tr>`).join('');
    const cliRows = r.clientes_detalle.map((c) => `<tr><td>${esc(c.route_label)}</td><td>${esc(c.cliente)}</td><td class="d">${esc(c.nombre)}</td><td class="n">${num(c.piezas)}</td><td class="n">${money(c.importe)}</td></tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box} body{font-family:Helvetica,Arial,sans-serif;color:#09090b;margin:0;padding:22px 18px}
      h1{font-size:15px;margin:0 0 2px} .sub{font-size:10px;color:#52525b;margin:0 0 14px}
      h2{font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}
      table{border-collapse:collapse;width:100%;font-size:8px;margin-bottom:8px}
      th,td{border:.5px solid #e4e4e7;padding:3px 5px;text-align:left} th{background:#f4f4f5;font-weight:700}
      td.n{text-align:right;font-variant-numeric:tabular-nums} td.b,tr.tot td{font-weight:700} tr.tot td{background:#f4f4f5}
      td.d{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    </style></head><body>
      <h1>Incentivo — ${esc(r.product?.nombre || '')}${r.product?.sku ? ' · ' + esc(r.product.sku) : ''}</h1>
      <p class="sub">${esc(r.rule.descripcion || r.metric_label)} · ${esc(r.period.label)} · $${r.rule.rate.toFixed(2)} por ${esc(r.base_label.toLowerCase())}</p>
      <h2>Resumen por ruta</h2>
      <table><thead><tr><th>Ruta</th><th>Clientes</th><th>Piezas</th><th>Importe</th><th>Pago</th></tr></thead>
      <tbody>${sumRows}<tr class="tot"><td>TOTAL</td><td class="n">${r.total_clientes}</td><td class="n">${num(r.total_piezas)}</td><td class="n">${money(r.total_importe)}</td><td class="n">${money(r.total_payout)}</td></tr></tbody></table>
      <h2>Clientes que participaron (${r.clientes_detalle.length})</h2>
      <table><thead><tr><th>Ruta</th><th>Cliente</th><th>Nombre</th><th>Piezas</th><th>Importe</th></tr></thead><tbody>${cliRows}</tbody></table>
    </body></html>`;
    const browser = await puppeteer.launch({
      headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', right: '8mm', bottom: '10mm', left: '8mm' } });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
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
      { h: 'Pz/Paq', v: (r) => r.pack_size ?? '' },
      { h: 'Pz/Cja', v: (r) => r.box_size ?? '' },
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
        { h: 'Venta cajas', v: (r) => r.venta_cajas ?? '', fmt: '#,##0.0', total: true },
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
        { h: 'Venta cajas', v: (r) => r.venta_cajas ?? '', fmt: '#,##0.0', total: true },
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
    const PRE = 3; // columnas antes de los meses: Origen, Destino, Tipo

    // Origen → Destino explícito por tipo (mismo criterio que la pantalla): salida CEDIS/
    // traspaso_salida = warehouse → dest_label; recepción = CEDIS → warehouse (dest_label null);
    // consolidación = interna (mismo almacén).
    const origin = (r: TransfersReport['rows'][number]) =>
      (r.kind === 'recepcion' || r.kind === 'traspaso_entrada') ? (r.dest_label || 'CEDIS') : r.warehouse_name;
    const destination = (r: TransfersReport['rows'][number]) => {
      if (r.kind === 'salida_cedis' || r.kind === 'traspaso_salida') return r.dest_label || '—';
      if (r.kind === 'consolidacion') return `${r.warehouse_name} (interna)`;
      return r.warehouse_name;
    };

    const head: string[] = ['Origen', 'Destino', 'Tipo'];
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
      const row: (string | number)[] = [origin(r), destination(r), r.kind_label];
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

    ws.getColumn(1).width = 24; // Origen
    ws.getColumn(2).width = 28; // Destino
    ws.getColumn(3).width = 20; // Tipo
    for (let c = PRE + 1; c <= PRE + months.length + 4; c++) ws.getColumn(c).width = 13;

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf as ArrayBuffer);
  }

  private thin(): Partial<ExcelJS.Borders> {
    const s = { style: 'thin' as const, color: { argb: 'FFD8D5CE' } };
    return { top: s, left: s, bottom: s, right: s };
  }

  // ─────────── PDF ───────────

  async buildPdf(report: SellOutReport, measure: SellOutMeasure = 'ambas'): Promise<Buffer> {
    const html = this.buildHtml(report, measure);
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

  private buildHtml(report: SellOutReport, measure: SellOutMeasure = 'ambas'): string {
    const esc = (s: any) =>
      String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
    const money = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
    const num = (n: number) => n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cols = report.columns;

    // Mismas reglas de medida que el XLSX: con una sola medida no hay fila de subtitulos
    // (el grupo se estira con rowspan); con "ambas" van las dos subcolumnas Cajas|Monto.
    const showCajas = measure !== 'monto';
    const showMonto = measure !== 'cajas';
    const N = (showCajas ? 1 : 0) + (showMonto ? 1 : 0);
    const groupTh = (label: string) =>
      N > 1 ? `<th colspan="2">${label}</th>` : `<th rowspan="2">${label}</th>`;
    const topHeads = cols.map((c) => groupTh(esc(this.colLabel(c)))).join('') + groupTh('TOTAL');
    const subHeads = N > 1
      ? cols.map(() => `<th>Cajas</th><th class="m">Monto</th>`).join('') + `<th>Cajas</th><th class="m">Monto</th>`
      : '';
    /** Celdas de una fila para un par (cajas, monto), respetando la medida. */
    const pairTds = (cell: SellOutCell | undefined, bold = false) => {
      const b = bold ? ' b' : '';
      const c = showCajas ? `<td class="n${b}">${cell ? num(cell.cajas) : '·'}</td>` : '';
      const m = showMonto ? `<td class="n m${b}">${cell ? money(cell.monto) : '·'}</td>` : '';
      return c + m;
    };

    const body = report.rows
      .map((p) => {
        const cells = cols.map((c) => pairTds(p.cells[c.key])).join('');
        return `<tr><td>${esc(p.sku)}</td><td class="d">${esc(p.nombre)}</td><td class="n">${p.uxc ?? ''}</td>${cells}${pairTds(p.total, true)}</tr>`;
      })
      .join('');

    const totCells = cols
      .map((c) => pairTds(report.column_totals[c.key] ?? { cajas: 0, monto: 0 }))
      .join('');
    const totRow = `<tr class="tot"><td colspan="3">TOTAL</td>${totCells}${pairTds(report.grand_total)}</tr>`;

    const period = this.periodLabel(report.period.from, report.period.to);
    const sucursales = report.coverage?.branches_with_data?.length ?? 0;

    // Etiquetas según la vista (producto / empresa / mes).
    const rowNoun = report.row_dim === 'month' ? 'meses' : report.row_dim === 'brand' ? 'empresas' : 'productos';
    const rowNounCap = report.row_dim === 'month' ? 'Meses' : report.row_dim === 'brand' ? 'Empresas' : 'Productos';
    const sectionTitle = report.row_dim === 'month' ? 'Resumen mensual' : report.row_dim === 'brand' ? 'Detalle por empresa' : 'Detalle por producto';
    // El cuerpo escribe siempre sku(col1)/nombre(col2)/uxc(col3). En vista mensual el
    // mes viaja en `nombre` → la etiqueta 'Mes' va en la 2ª columna para que coincida.
    const idHead = report.row_dim === 'month'
      ? '<th rowspan="2"></th><th rowspan="2">Mes</th><th rowspan="2"></th>'
      : `<th rowspan="2">Código</th><th rowspan="2">${report.row_dim === 'brand' ? 'Empresa' : 'Descripción'}</th><th rowspan="2">UXC</th>`;

    // KPIs (mismo lenguaje que la tabla "MÉTRICAS PRINCIPALES" del PDF de /reports)
    const kpis: Array<[string, string]> = [
      ['Monto total', money(report.grand_total.monto)],
      ['Cajas', report.grand_total.cajas.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })],
      [rowNounCap, String(report.rows.length)],
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
        <span class="ch">${report.rows.length} ${rowNoun} · ${cols.length} columnas</span>
      </div>
      <div class="kpis">${kpiCells}</div>
      <div class="sec">${esc(sectionTitle)}</div>
      <table><thead>
        <tr>${idHead}${topHeads}</tr>
        <tr>${subHeads}</tr>
      </thead><tbody>${body}${totRow}</tbody></table>
      <p class="note">${esc(report.coverage.note)}</p>
    </body></html>`;
  }
}
