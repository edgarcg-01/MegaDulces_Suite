import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';

/**
 * DM.6 — Export del Diario de movimientos a XLSX (ExcelJS) y PDF (puppeteer).
 * Diseño empresarial alineado a DESIGN.md (Stone + sunset, quiet-luxury):
 * masthead oscuro con acento de marca, KPIs, pills semánticas de estado,
 * folios en mono. El Excel prioriza eficiencia: autofiltro, paneles congelados,
 * sin gridlines, fechas reales (filtrables), estados coloreados, data bars,
 * fila de totales y título repetido al imprimir.
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

type Sev = 'ok' | 'warn' | 'bad' | 'mut';
const ESTADO_SEV: Record<string, Sev> = {
  completado: 'ok', ok: 'ok', en_transito: 'warn',
  diferencia: 'bad', sin_recepcion: 'bad', sin_origen: 'mut',
};

// Paleta impresa (tokens Stone/sunset/semánticos de DESIGN.md, en ARGB)
const C = {
  dark: 'FF1A1611', ink: 'FF241E18', mute: 'FF837A6C', ink2: 'FF463F36',
  sunset: 'FFF05A28', white: 'FFFFFFFF', sub: 'FFD8CFC0',
  paper: 'FFFBF9F6', sand: 'FFF5F1EA', hair: 'FFE8E2D7', bar: 'FFF6C7B2',
  okBg: 'FFDCFCE7', okFg: 'FF166534',
  warnBg: 'FFFEF3C7', warnFg: 'FF92400E',
  badBg: 'FFFEE2E2', badFg: 'FF991B1B',
  mutBg: 'FFEDE8DF', mutFg: 'FF463F36',
};
const SEV_FILL: Record<Sev, { bg: string; fg: string }> = {
  ok: { bg: C.okBg, fg: C.okFg }, warn: { bg: C.warnBg, fg: C.warnFg },
  bad: { bg: C.badBg, fg: C.badFg }, mut: { bg: C.mutBg, fg: C.mutFg },
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
  private asDate(d: any): Date | null {
    const s = this.fmtDate(d);
    return s ? new Date(`${s}T12:00:00`) : null;
  }
  private periodLabel(from: string, to: string): string {
    const fmt = (s: string) =>
      new Date(`${s}T12:00:00`).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
    return `${fmt(from)} — ${fmt(to)}`;
  }
  private generatedAt(): string {
    return new Date().toLocaleString('es-MX', {
      timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
  private transferCounts(transfers: any[]): Record<string, number> {
    const t: Record<string, number> = { ok: 0, diferencia: 0, sin_recepcion: 0, sin_origen: 0 };
    for (const r of transfers) t[r.status] = (t[r.status] || 0) + 1;
    return t;
  }

  // ─────────── XLSX ───────────

  /** Masthead de 3 filas (título oscuro + subtítulo + cinta sunset) sobre `cols` columnas. */
  private masthead(ws: ExcelJS.Worksheet, cols: number, title: string, subtitle: string) {
    for (let c = 1; c <= cols; c++) {
      ws.getCell(1, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dark } };
      ws.getCell(2, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dark } };
      ws.getCell(3, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.sunset } };
    }
    ws.mergeCells(1, 1, 1, cols);
    ws.mergeCells(2, 1, 2, cols);
    const t = ws.getCell(1, 1);
    t.value = title;
    t.font = { bold: true, size: 13, color: { argb: C.white } };
    t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    const s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { size: 9, color: { argb: C.sub } };
    s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(1).height = 26;
    ws.getRow(2).height = 15;
    ws.getRow(3).height = 4;
    ws.getRow(4).height = 8;
  }

  /** Banda de KPIs en filas 5-6: pares de 2 columnas (label arriba, valor abajo). */
  private kpiBand(
    ws: ExcelJS.Worksheet,
    kpis: { label: string; value: ExcelJS.CellValue; numFmt?: string; color?: string }[],
  ) {
    kpis.forEach((k, i) => {
      const col = 1 + i * 2;
      ws.mergeCells(5, col, 5, col + 1);
      ws.mergeCells(6, col, 6, col + 1);
      const l = ws.getCell(5, col);
      l.value = k.label.toUpperCase();
      l.font = { size: 8, bold: true, color: { argb: C.mute } };
      l.alignment = { horizontal: 'left', vertical: 'bottom' };
      const v = ws.getCell(6, col);
      v.value = k.value;
      v.font = { size: 13, bold: true, color: { argb: k.color || C.ink } };
      v.alignment = { horizontal: 'left', vertical: 'middle' };
      if (k.numFmt) v.numFmt = k.numFmt;
      for (let c = col; c <= col + 1; c++) {
        ws.getCell(6, c).border = { bottom: { style: 'hair', color: { argb: C.hair } } };
      }
    });
    ws.getRow(5).height = 12;
    ws.getRow(6).height = 20;
    ws.getRow(7).height = 8;
  }

  /** Fila 8 = encabezado de tabla (fondo oscuro, autofiltro). `rightCols` = índices numéricos. */
  private tableHeader(ws: ExcelJS.Worksheet, labels: string[], rightCols: number[]) {
    const row = ws.getRow(8);
    labels.forEach((label, i) => {
      const cell = row.getCell(i + 1);
      cell.value = label;
      cell.font = { bold: true, size: 9.5, color: { argb: C.white } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dark } };
      cell.alignment = { horizontal: rightCols.includes(i + 1) ? 'right' : 'left', vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: C.sunset } } };
    });
    row.height = 20;
    ws.autoFilter = { from: { row: 8, column: 1 }, to: { row: 8, column: labels.length } };
    ws.views = [{ state: 'frozen', ySplit: 8, showGridLines: false }];
    ws.pageSetup = {
      orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printTitlesRow: '8:8',
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    };
  }

  private baseCell(cell: ExcelJS.Cell) {
    cell.font = { size: 10, color: { argb: C.ink } };
    cell.border = { bottom: { style: 'hair', color: { argb: C.hair } } };
  }
  private sevCell(cell: ExcelJS.Cell, status: string | null | undefined) {
    if (!status) {
      cell.value = '—';
      cell.font = { size: 10, color: { argb: C.mute } };
      return;
    }
    const sev = SEV_FILL[ESTADO_SEV[status] || 'mut'];
    cell.value = ESTADO_LABEL[status] || status;
    cell.font = { size: 9.5, bold: true, color: { argb: sev.fg } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sev.bg } };
  }

  async buildXlsx(data: MovementsExportData): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mega Dulces · Mercado';
    wb.lastModifiedBy = 'Mercado';
    wb.created = new Date();
    wb.modified = new Date();
    wb.title = 'Diario de movimientos';
    wb.subject = `Movimientos de inventario ${data.range.from} — ${data.range.to}`;

    const period = this.periodLabel(data.range.from, data.range.to);
    const stamp = this.generatedAt();
    const audited = data.docs.filter((d) => d.audited).length;
    const tc = this.transferCounts(data.transfers);

    // ── Hoja 1 · Documentos ──────────────────────────────────────────
    const ws = wb.addWorksheet('Documentos', { properties: { tabColor: { argb: C.sunset } } });
    ws.columns = [
      { width: 11 }, { width: 30 }, { width: 11 }, { width: 18 }, { width: 8 },
      { width: 12 }, { width: 14 }, { width: 15 }, { width: 11 }, { width: 17 },
    ] as any;
    this.masthead(ws, 10, 'MEGA DULCES  ·  DIARIO DE MOVIMIENTOS',
      `Periodo ${period}   ·   Generado el ${stamp}   ·   ${data.docs.length.toLocaleString('es-MX')} documentos`);
    this.kpiBand(ws, [
      { label: 'Entradas (pzas)', value: Math.abs(Number(data.totals.entradas) || 0), numFmt: '#,##0' },
      { label: 'Salidas (pzas)', value: -Math.abs(Number(data.totals.salidas) || 0), numFmt: '#,##0;-#,##0' },
      { label: 'Valor movido', value: Number(data.totals.valor) || 0, numFmt: '"$"#,##0' },
      { label: 'Documentos', value: Number(data.totals.documentos) || 0, numFmt: '#,##0' },
      { label: 'Auditados', value: `${audited.toLocaleString('es-MX')} de ${data.docs.length.toLocaleString('es-MX')}`, color: audited ? C.okFg : C.mute },
    ]);
    this.tableHeader(ws,
      ['Fecha', 'Tipo de documento', 'Folio', 'Almacén', 'Líneas', 'Cantidad', 'Valor', 'Estado traspaso', 'Auditado', 'Auditado por'],
      [5, 6, 7]);

    // info: la Cantidad muestra lo AMPARADO (muted, no suma inventario)
    let sumLineas = 0, sumQty = 0, sumInfoQty = 0, sumValor = 0;
    for (const d of data.docs) {
      const isInfo = d.movement_kind === 'info';
      const row = ws.addRow([
        this.asDate(d.doc_date), d.movement_label, d.folio, d.warehouse_name || d.warehouse_code || d.source_branch,
        Number(d.lineas) || 0, isInfo ? Number(d.qty) || 0 : Number(d.signed_qty) || 0, Number(d.amount) || 0,
        '', '', d.audited_by || '',
      ]);
      sumLineas += Number(d.lineas) || 0;
      if (isInfo) sumInfoQty += Number(d.qty) || 0;
      else sumQty += Number(d.signed_qty) || 0;
      sumValor += Number(d.amount) || 0;
      row.eachCell({ includeEmpty: true }, (cell) => this.baseCell(cell));
      row.getCell(1).numFmt = 'dd/mm/yyyy';
      row.getCell(3).font = { name: 'Consolas', size: 9, color: { argb: C.ink } };
      row.getCell(5).numFmt = '#,##0';
      row.getCell(6).numFmt = '#,##0.00;[Red]-#,##0.00';
      if (isInfo) row.getCell(6).font = { size: 10, italic: true, color: { argb: C.mute } };
      row.getCell(7).numFmt = '"$"#,##0.00';
      this.sevCell(row.getCell(8), d.transfer_status);
      const aud = row.getCell(9);
      aud.value = d.audited ? 'Sí' : 'Pendiente';
      aud.font = { size: 9.5, bold: !!d.audited, color: { argb: d.audited ? C.okFg : C.mute } };
      row.getCell(10).font = { size: 9, color: { argb: C.mute } };
    }
    const lastDocRow = ws.rowCount;
    if (lastDocRow >= 9) {
      // Data bar sutil en Valor: escanear los movimientos grandes de un vistazo
      ws.addConditionalFormatting({
        ref: `G9:G${lastDocRow}`,
        rules: [{
          type: 'dataBar', priority: 1, gradient: false,
          cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: C.bar },
        } as any],
      });
    }
    const totLabel = data.truncated ? 'TOTAL (docs listados)' : 'TOTAL';
    const hasInv = data.docs.some((d) => d.movement_kind !== 'info');
    const tot = ws.addRow([totLabel, '', '', '', sumLineas, hasInv ? sumQty : sumInfoQty, sumValor, '', '', '']);
    tot.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { size: 10, bold: true, color: { argb: C.ink } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.sand } };
      cell.border = { top: { style: 'medium', color: { argb: C.dark } } };
    });
    tot.getCell(5).numFmt = '#,##0';
    tot.getCell(6).numFmt = '#,##0.00;[Red]-#,##0.00';
    tot.getCell(7).numFmt = '"$"#,##0.00';
    if (data.truncated) {
      const n = ws.addRow([`Listado truncado a ${data.docs.length.toLocaleString('es-MX')} documentos — acotá el rango o los filtros para el detalle completo.`]);
      n.getCell(1).font = { size: 9, italic: true, color: { argb: C.mute } };
    }

    // ── Hoja 2 · Traspasos ───────────────────────────────────────────
    const wt = wb.addWorksheet('Traspasos', { properties: { tabColor: { argb: 'FFF8B400' } } });
    wt.columns = [
      { width: 15 }, { width: 17 }, { width: 13 }, { width: 12 }, { width: 11 },
      { width: 17 }, { width: 14 }, { width: 13 }, { width: 11 }, { width: 11 },
    ] as any;
    this.masthead(wt, 10, 'MEGA DULCES  ·  VALIDACIÓN DE TRASPASOS',
      `Salida ↔ recepción   ·   Periodo ${period}   ·   Generado el ${stamp}`);
    this.kpiBand(wt, [
      { label: 'Recibidos OK', value: tc['ok'], numFmt: '#,##0', color: C.okFg },
      { label: 'Con diferencia', value: tc['diferencia'], numFmt: '#,##0', color: tc['diferencia'] ? C.badFg : C.mute },
      { label: 'Sin recepción', value: tc['sin_recepcion'], numFmt: '#,##0', color: tc['sin_recepcion'] ? C.badFg : C.mute },
      { label: 'Sin origen', value: tc['sin_origen'], numFmt: '#,##0', color: C.mute },
      {
        label: 'Δ neto (pzas)',
        value: data.transfers.reduce((a, r) => a + (Number(r.delta) || 0), 0),
        numFmt: '+#,##0;[Red]-#,##0;0', color: C.ink,
      },
    ]);
    this.tableHeader(wt,
      ['Estado', 'Origen', 'Folio salida', 'Fecha salida', 'Enviadas', 'Destino', 'Folio recepción', 'Fecha recepción', 'Recibidas', 'Δ piezas'],
      [5, 9, 10]);

    for (const r of data.transfers) {
      const row = wt.addRow([
        '', r.origin_wh || '—', r.origin_folio || '—', this.asDate(r.ship_date),
        r.qty_sent != null ? Number(r.qty_sent) : null, r.dest_wh || '—', r.rcv_folio || '—',
        this.asDate(r.rcv_date), r.qty_received != null ? Number(r.qty_received) : null,
        Number(r.delta) || 0,
      ]);
      row.eachCell({ includeEmpty: true }, (cell) => this.baseCell(cell));
      this.sevCell(row.getCell(1), r.status);
      row.getCell(3).font = { name: 'Consolas', size: 9, color: { argb: C.ink } };
      row.getCell(7).font = { name: 'Consolas', size: 9, color: { argb: C.ink } };
      row.getCell(4).numFmt = 'dd/mm/yyyy';
      row.getCell(8).numFmt = 'dd/mm/yyyy';
      row.getCell(5).numFmt = '#,##0.00';
      row.getCell(9).numFmt = '#,##0.00';
      const delta = row.getCell(10);
      delta.numFmt = '+#,##0.00;-#,##0.00;"—"';
      if (Number(r.delta)) delta.font = { size: 10, bold: true, color: { argb: C.badFg } };
    }
    if (!data.transfers.length) {
      const n = wt.addRow(['Sin traspasos en el rango.']);
      n.getCell(1).font = { size: 10, italic: true, color: { argb: C.mute } };
    }

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
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: `
          <div style="width:100%;font-size:8px;color:#837A6C;padding:0 8mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif;">
            <span>Mega Dulces · Diario de movimientos · ${data.range.from} — ${data.range.to} · Uso interno</span>
            <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
          </div>`,
        margin: { top: '9mm', right: '8mm', bottom: '14mm', left: '8mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private buildHtml(data: MovementsExportData): string {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
    const money = (n: number, dec = 0) => (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: dec, minimumFractionDigits: dec });
    // hasta 2 decimales: hay cantidades fraccionarias (KG); los enteros se muestran limpios
    const num = (n: any) => (n == null || n === '' ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 }));
    const dmy = (d: any) => {
      const s = this.fmtDate(d);
      return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}` : '—';
    };
    const pill = (status: string | null | undefined) => {
      if (!status) return '<span class="mut">—</span>';
      const sev = ESTADO_SEV[status] || 'mut';
      return `<span class="pill p-${sev}">${esc(ESTADO_LABEL[status] || status)}</span>`;
    };

    const PDF_CAP = 1200; // el PDF es para lectura; el detalle completo va en el XLSX
    const docs = data.docs.slice(0, PDF_CAP);
    const audited = data.docs.filter((d) => d.audited).length;
    // docs informativos: la columna muestra la cantidad AMPARADA (muted); el TOTAL suma
    // inventario (signed) si hay docs de inventario, o lo amparado si el listado es solo-info
    const hasInv = docs.some((d) => d.movement_kind !== 'info');
    const tc = this.transferCounts(data.transfers);
    let sumQty = 0, sumInfoQty = 0, sumValor = 0;

    const docRows = docs.map((d) => {
      if (d.movement_kind === 'info') sumInfoQty += Number(d.qty) || 0;
      else sumQty += Number(d.signed_qty) || 0;
      sumValor += Number(d.amount) || 0;
      return `
      <tr><td>${dmy(d.doc_date)}</td><td class="dsc">${esc(d.movement_label)}</td><td class="mono">${esc(d.folio)}</td>
      <td>${esc(d.warehouse_name || d.warehouse_code || d.source_branch)}</td>
      <td class="num">${d.movement_kind === 'info' ? `<span class="mut">${num(d.qty)}</span>` : num(d.signed_qty)}</td><td class="num">${money(d.amount, 2)}</td>
      <td>${pill(d.transfer_status)}</td><td>${d.audited ? '<span class="aud">✓ Sí</span>' : '<span class="mut">Pendiente</span>'}</td></tr>`;
    }).join('');

    const trRows = data.transfers.map((r) => `
      <tr><td>${pill(r.status)}</td>
      <td>${esc(r.origin_wh || '—')}</td><td class="mono">${esc(r.origin_folio || '—')}</td><td>${dmy(r.ship_date)}</td><td class="num">${num(r.qty_sent)}</td>
      <td>${esc(r.dest_wh || '—')}</td><td class="mono">${esc(r.rcv_folio || '—')}</td><td>${dmy(r.rcv_date)}</td><td class="num">${num(r.qty_received)}</td>
      <td class="num ${Number(r.delta) ? 'delta' : ''}">${Number(r.delta) ? (Number(r.delta) > 0 ? '+' : '') + num(r.delta) : '—'}</td></tr>`).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>
      * { box-sizing: border-box; }
      /* Hoja de papel: fondo blanco SIEMPRE explícito (OS en dark lo pintaría oscuro) */
      html, body { background: #FFFFFF; }
      body { font-family: Helvetica, 'Segoe UI', Arial, sans-serif; font-size: 9.5px; color: #241E18; margin: 0; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      td.num { font-size: 10.5px; }
      .ctr { text-align: center; }
      .mono { font-family: Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 9.5px; }
      .mut { color: #837A6C; }
      .dsc { max-width: 210px; }

      .mast { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 9px; border-bottom: 2px solid #1A1611; position: relative; }
      .mast:after { content: ''; position: absolute; left: 0; bottom: -2px; width: 92px; height: 2px; background: #F05A28; }
      .brand { font-size: 9px; font-weight: 700; letter-spacing: .18em; color: #837A6C; }
      h1 { font-size: 19px; margin: 3px 0 0; letter-spacing: -.01em; color: #1A1611; }
      .meta { text-align: right; color: #5E564B; font-size: 9px; line-height: 1.55; }
      .meta b { color: #1A1611; font-size: 11.5px; }

      .kpis { display: flex; gap: 8px; margin: 11px 0 6px; }
      .kpi { flex: 1; border: 1px solid #E8E2D7; border-radius: 5px; padding: 7px 11px; background: #FFFFFF; }
      .kpi-l { display: block; color: #837A6C; font-size: 7.5px; letter-spacing: .09em; text-transform: uppercase; font-weight: 700; }
      .kpi-v { display: block; font-weight: 700; font-size: 17px; margin-top: 3px; font-variant-numeric: tabular-nums; color: #1A1611; }
      .chips { display: flex; gap: 5px; align-items: center; margin: 0 0 8px; }
      .chips .t { font-size: 7.5px; color: #837A6C; text-transform: uppercase; letter-spacing: .09em; font-weight: 700; margin-right: 3px; }

      .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 8.5px; font-weight: 700; border: 1px solid transparent; }
      .p-ok { background: #DCFCE7; color: #166534; border-color: #BBF7D0; }
      .p-warn { background: #FEF3C7; color: #92400E; border-color: #FDE68A; }
      .p-bad { background: #FEE2E2; color: #991B1B; border-color: #FECACA; }
      .p-mut { background: #F5F1EA; color: #463F36; border-color: #E8E2D7; }
      .aud { color: #166534; font-weight: 700; }
      .delta { color: #991B1B; font-weight: 700; }

      .sec { display: flex; justify-content: space-between; align-items: baseline; margin: 14px 0 5px; padding-left: 9px; border-left: 3px solid #F05A28; }
      .sec h2 { font-size: 12.5px; margin: 0; color: #1A1611; }
      .sec .cnt { font-size: 9px; color: #837A6C; }
      .brk { page-break-before: always; }

      table { border-collapse: collapse; width: 100%; }
      thead { display: table-header-group; }
      th { background: #F5F1EA; color: #5E564B; padding: 5px 6px; text-align: left; font-size: 8px; font-weight: 700;
           text-transform: uppercase; letter-spacing: .06em; border-bottom: 1.5px solid #1A1611; border-top: 1px solid #E8E2D7; }
      th.num { text-align: right; font-size: 8px; } th.ctr { text-align: center; }
      td { border-bottom: 1px solid #EFEAE0; padding: 4px 6px; vertical-align: top; line-height: 1.3; }
      tr { page-break-inside: avoid; }
      .tot td { font-weight: 700; background: #FBF9F6; border-top: 1.5px solid #1A1611; border-bottom: none; }
      .note { color: #837A6C; font-size: 8.5px; margin-top: 4px; font-style: italic; }
      .empty { color: #837A6C; font-style: italic; padding: 10px 6px; }
    </style></head><body>

      <div class="mast">
        <div>
          <div class="brand">MEGA DULCES</div>
          <h1>Diario de movimientos</h1>
        </div>
        <div class="meta">
          <b>${esc(this.periodLabel(data.range.from, data.range.to))}</b><br>
          Generado el ${esc(this.generatedAt())}<br>
          ${num(data.totals.documentos)} documentos · ${num(data.transfers.length)} traspasos
        </div>
      </div>

      <div class="kpis">
        <div class="kpi"><span class="kpi-l">Entradas (pzas)</span><span class="kpi-v">+${num(Math.abs(data.totals.entradas))}</span></div>
        <div class="kpi"><span class="kpi-l">Salidas (pzas)</span><span class="kpi-v">−${num(Math.abs(data.totals.salidas))}</span></div>
        <div class="kpi"><span class="kpi-l">Valor movido</span><span class="kpi-v">${money(data.totals.valor)}</span></div>
        <div class="kpi"><span class="kpi-l">Documentos</span><span class="kpi-v">${num(data.totals.documentos)}</span></div>
        <div class="kpi"><span class="kpi-l">Auditados</span><span class="kpi-v">${num(audited)} <span style="font-size:10px;color:#837A6C;font-weight:400">de ${num(docs.length)}</span></span></div>
      </div>

      <div class="chips">
        <span class="t">Traspasos</span>
        <span class="pill p-ok">${num(tc['ok'])} recibidos OK</span>
        <span class="pill p-bad">${num(tc['diferencia'])} con diferencia</span>
        <span class="pill p-bad">${num(tc['sin_recepcion'])} sin recepción</span>
        <span class="pill p-mut">${num(tc['sin_origen'])} sin origen</span>
      </div>

      <div class="sec">
        <h2>1 · Documentos del periodo</h2>
        <span class="cnt">${data.docs.length > PDF_CAP
          ? `primeros ${num(PDF_CAP)} de ${num(data.docs.length)} — el detalle completo está en el Excel`
          : `${num(docs.length)} documentos`}</span>
      </div>
      <table><thead><tr><th>Fecha</th><th>Tipo de documento</th><th>Folio</th><th>Almacén</th>
      <th class="num">Cantidad</th><th class="num">Valor</th><th>Estado</th><th>Auditado</th></tr></thead>
      <tbody>${docRows || '<tr><td colspan="8" class="empty">Sin documentos en el rango.</td></tr>'}
      ${docRows ? `<tr class="tot"><td colspan="4">TOTAL${data.docs.length > PDF_CAP ? ' (docs listados)' : ''}</td>
        <td class="num">${hasInv ? num(sumQty) : `<span class="mut">${num(sumInfoQty)}</span>`}</td><td class="num">${money(sumValor, 2)}</td><td></td><td></td></tr>` : ''}
      </tbody></table>

      <div class="sec${docs.length > 22 ? ' brk' : ''}">
        <h2>2 · Validación de traspasos (salida ↔ recepción)</h2>
        <span class="cnt">${num(data.transfers.length)} traspasos</span>
      </div>
      <table><thead><tr><th>Estado</th><th>Origen</th><th>Folio salida</th><th>Fecha salida</th><th class="num">Enviadas</th>
      <th>Destino</th><th>Folio recepción</th><th>Fecha recepción</th><th class="num">Recibidas</th><th class="num">Δ piezas</th></tr></thead>
      <tbody>${trRows || '<tr><td colspan="10" class="empty">Sin traspasos en el rango.</td></tr>'}</tbody></table>

    </body></html>`;
  }
}
