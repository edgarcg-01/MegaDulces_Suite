import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { TOLERANCIA_MAYOR_515, veredictoCuadre, type VeredictoCuadre } from '@megadulces/contracts';

/**
 * DM.6 — Export del Diario de movimientos a PDF (puppeteer).
 * Diseño empresarial alineado a DESIGN.md (Stone + sunset, quiet-luxury):
 * masthead oscuro con acento de marca, KPIs, pills semánticas de estado, folios en mono.
 * [MX] Sin Excel (Edgar, 2026-10-28): la reportería vive en la pantalla; el PDF queda para imprimir.
 */

export interface MovementsExportData {
  range: { from: string; to: string };
  /** [MX.1.2] `lineas_sin_importe`: renglones con costo 0 en Kepler que `valor` no incluye. */
  totals: { entradas: number; salidas: number; valor: number; documentos: number; lineas_sin_importe?: number };
  docs: any[];       // filas de lines() (folio englobado + transfer_status + audited)
  transfers: any[];  // filas de transfersCheck()
  /** [MX.2.1] Conteos y sumas del conjunto COMPLETO: los KPIs salen de acá, nunca de `transfers` (cortada en 500, problemas primero). */
  transfer_totals: { ok: number; diferencia: number; sin_recepcion: number; sin_origen: number };
  transfer_sums: { n: number; qty_sent: number; qty_received: number; delta: number; amount: number };
  transfers_capped: boolean;
  truncated: boolean;
}

/** DM.12 — datos del reporte de cuadre de traspasos (contable + matriz física + folios + detalle). */
export interface CuadreExportData {
  range: { from: string; to: string };
  ledger: { totals: { entrada: number; salida: number; delta: number }; rows: any[]; by_sucursal: any[] };
  matrix: { totals: any; rows: any[] };
  check: { totals: { ok: number; diferencia: number; sin_recepcion: number; sin_origen: number }; rows: any[] };
  detail?: { totals: any; rows: any[]; total: number; truncated: boolean };
}

const ESTADO_LABEL: Record<string, string> = {
  en_transito: 'En tránsito', completado: 'Completado', diferencia: 'Diferencia',
  sin_acuse: 'Sin acuse', sin_recepcion_esperada: 'A ruta o cliente',
  ok: 'Recibido', sin_recepcion: 'Sin recepción', sin_origen: 'Sin origen',
};

type Sev = 'ok' | 'warn' | 'bad' | 'mut';
const ESTADO_SEV: Record<string, Sev> = {
  completado: 'ok', ok: 'ok', en_transito: 'warn', sin_acuse: 'bad', sin_recepcion_esperada: 'mut',
  diferencia: 'bad', sin_recepcion: 'bad', sin_origen: 'mut',
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
  /**
   * [MX.2.1] KPIs de traspasos desde los totales del motor. Antes se contaban sobre `transfers`,
   * que viene cortada en 500 con los problemas primero: con más de 500 problemas en el rango
   * «Recibidos OK» salía en 0 y «Δ neto»/«Valor enviado» eran de una muestra sin decirlo.
   * `cut` dice si el LISTADO está recortado (los KPIs nunca lo están, salvo `capped`).
   */
  private transferKpis(data: MovementsExportData) {
    const tc = data.transfer_totals;
    const sums = data.transfer_sums;
    const listed = data.transfers.length;
    return { tc, sums, listed, cut: listed < sums.n, capped: data.transfers_capped };
  }
  private transferListNote(k: ReturnType<MovementsExportService['transferKpis']>): string | null {
    const parts: string[] = [];
    if (k.cut) parts.push(`Listado: los primeros ${k.listed.toLocaleString('es-MX')} de ${k.sums.n.toLocaleString('es-MX')} traspasos, los problemas primero. Los indicadores de arriba son del total.`);
    if (k.capped) parts.push('El pareo llegó a su tope de 50,000 filas: los indicadores están INCOMPLETOS — acota el rango.');
    return parts.length ? parts.join(' ') : null;
  }

  // ─────────── PDF ───────────

  /** Render genérico HTML → PDF (A4 landscape) con footer de página. */
  private async renderPdf(html: string, footerLeft: string): Promise<Buffer> {
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
            <span>${footerLeft}</span>
            <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
          </div>`,
        margin: { top: '9mm', right: '8mm', bottom: '14mm', left: '8mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  async buildPdf(data: MovementsExportData): Promise<Buffer> {
    return this.renderPdf(this.buildHtml(data),
      `Mega Dulces · Diario de movimientos · ${data.range.from} — ${data.range.to} · Uso interno`);
  }

  // ─────────── PDF · Cuadre de traspasos (DM.12) ───────────

  cuadreFileName(range: { from: string; to: string }, ext: string): string {
    return `Cuadre de traspasos ${range.from}_${range.to}.${ext}`;
  }

  /**
   * Reporte del cuadre de traspasos. `mode`:
   *   global  → consolidado de red (4 secciones).
   *   resumen → concentrado POR SUCURSAL (KPIs + tabla resumen por sucursal contable).
   *   detalle → desglosado POR SUCURSAL (una sección por sucursal con sus pólizas sin rastro).
   */
  async buildCuadrePdf(data: CuadreExportData, mode: 'global' | 'resumen' | 'detalle' = 'global'): Promise<Buffer> {
    const html = mode === 'resumen' ? this.buildCuadreResumenHtml(data)
      : mode === 'detalle' ? this.buildCuadreDetalleHtml(data)
      : this.buildCuadreHtml(data);
    return this.renderPdf(html,
      `Mega Dulces · Cuadre de traspasos · ${data.range.from} — ${data.range.to} · Uso interno`);
  }

  // Formato compartido de los reportes de cuadre.
  private cEsc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
  private cMoney = (n: any, dec = 0) => (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: dec, minimumFractionDigits: dec });
  private cSigned = (n: any) => (Number(n) > 0 ? '+' : '') + this.cMoney(n);
  private cNum = (n: any) => (n == null || n === '' ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: 0 }));
  /**
   * [MX.1.2] Veredicto del mayor 515 en tres estados — el mismo que la pantalla (`vLedger`): un mes sin
   * entrada ni delta es «sin datos», no «cuadra». Antes `Number(x) || 0` lo pintaba como bueno.
   */
  private cV = (delta: unknown, base: unknown): VeredictoCuadre => veredictoCuadre(delta, base, TOLERANCIA_MAYOR_515);
  /** Texto de la celda: «cuadra», el Δ con signo, o «sin datos». */
  private cTxt = (delta: unknown, base: unknown) => {
    const v = this.cV(delta, base);
    return v === 'cuadra' ? 'cuadra' : v === 'difiere' ? this.cSigned(delta) : 'sin datos';
  };

  /** CSS compartido por los 3 modos del reporte de cuadre. */
  private cuadreStyles(): string {
    return `
      * { box-sizing: border-box; }
      html, body { background: #FFFFFF; }
      body { font-family: Helvetica, 'Segoe UI', Arial, sans-serif; font-size: 9.5px; color: #241E18; margin: 0; }
      .num { text-align: right; font-variant-numeric: tabular-nums; } td.num { font-size: 10.5px; }
      .mono { font-family: Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 9.5px; }
      .mut { color: #837A6C; } .up { color: #166534; } .dn { color: #991B1B; } .delta { color: #991B1B; font-weight: 700; }
      .mast { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 9px; border-bottom: 2px solid #1A1611; position: relative; }
      .mast:after { content: ''; position: absolute; left: 0; bottom: -2px; width: 92px; height: 2px; background: #F05A28; }
      .brand { font-size: 9px; font-weight: 700; letter-spacing: .18em; color: #837A6C; }
      h1 { font-size: 19px; margin: 3px 0 0; letter-spacing: -.01em; color: #1A1611; }
      .meta { text-align: right; color: #5E564B; font-size: 9px; line-height: 1.55; } .meta b { color: #1A1611; font-size: 11.5px; }
      .kpis { display: flex; gap: 8px; margin: 11px 0 6px; }
      .kpi { flex: 1; border: 1px solid #E8E2D7; border-radius: 5px; padding: 7px 11px; background: #FFFFFF; }
      .kpi.big { border-width: 2px; } .kpi.ok { border-color: #BBF7D0; background: #F0FDF4; } .kpi.bad { border-color: #FECACA; background: #FEF2F2; }
      .kpi-l { display: block; color: #837A6C; font-size: 7.5px; letter-spacing: .09em; text-transform: uppercase; font-weight: 700; }
      .kpi-v { display: block; font-weight: 700; font-size: 17px; margin-top: 3px; font-variant-numeric: tabular-nums; color: #1A1611; }
      .kpi.ok .kpi-v { color: #166534; } .kpi.bad .kpi-v { color: #991B1B; }
      .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 8.5px; font-weight: 700; border: 1px solid transparent; }
      .p-ok { background: #DCFCE7; color: #166534; border-color: #BBF7D0; } .p-warn { background: #FEF3C7; color: #92400E; border-color: #FDE68A; }
      .p-bad { background: #FEE2E2; color: #991B1B; border-color: #FECACA; } .p-mut { background: #F5F1EA; color: #463F36; border-color: #E8E2D7; }
      .sec { display: flex; justify-content: space-between; align-items: baseline; margin: 14px 0 5px; padding-left: 9px; border-left: 3px solid #F05A28; }
      .sec h2 { font-size: 12.5px; margin: 0; color: #1A1611; } .sec .cnt { font-size: 9px; color: #837A6C; }
      .lead { color: #5E564B; font-size: 9px; margin: 2px 0 0; }
      .brk { page-break-before: always; }
      table { border-collapse: collapse; width: 100%; } thead { display: table-header-group; }
      th { background: #F5F1EA; color: #5E564B; padding: 5px 6px; text-align: left; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; border-bottom: 1.5px solid #1A1611; border-top: 1px solid #E8E2D7; }
      th.num { text-align: right; }
      td { border-bottom: 1px solid #EFEAE0; padding: 4px 6px; vertical-align: top; line-height: 1.3; } tr { page-break-inside: avoid; }
      .cols { display: flex; gap: 14px; } .cols > div { flex: 1; }
      .empty { color: #837A6C; font-style: italic; padding: 10px 6px; }
      .sucband { margin: 16px 0 4px; padding: 6px 9px; background: #1A1611; color: #FFF; border-radius: 4px; display: flex; justify-content: space-between; align-items: baseline; }
      .sucband h2 { font-size: 12px; margin: 0; color: #FFF; } .sucband .n { font-size: 9px; color: #D8CFC0; }`;
  }

  /** Masthead + KPIs globales (compartido). */
  private cuadreHead(data: CuadreExportData, title: string, subtitle?: string): string {
    const lg = data.ledger, ck = data.check;
    const totV = this.cV(lg.totals?.delta, lg.totals?.entrada);
    return `
      <div class="mast">
        <div><div class="brand">MEGA DULCES</div><h1>${this.cEsc(title)}</h1></div>
        <div class="meta"><b>${this.cEsc(this.periodLabel(data.range.from, data.range.to))}</b><br>
          Generado el ${this.cEsc(this.generatedAt())}<br>${this.cEsc(subtitle || 'Mayor 515 · Ajuste traspasos internos')}</div>
      </div>
      <div class="kpis">
        <div class="kpi big ${totV === 'cuadra' ? 'ok' : totV === 'difiere' ? 'bad' : ''}"><span class="kpi-l">Descuadre acumulado</span><span class="kpi-v">${totV === 'sin_datos' ? 'sin datos' : this.cSigned(lg.totals?.delta)}</span></div>
        <div class="kpi"><span class="kpi-l">515-001 · Entrada</span><span class="kpi-v" style="color:#166534">${this.cMoney(lg.totals?.entrada)}</span></div>
        <div class="kpi"><span class="kpi-l">515-002 · Salida</span><span class="kpi-v" style="color:#991B1B">${this.cMoney(lg.totals?.salida)}</span></div>
        <div class="kpi"><span class="kpi-l">Traspasos sin cuadrar</span><span class="kpi-v">${this.cNum(ck.totals.diferencia + ck.totals.sin_recepcion + ck.totals.sin_origen)}</span></div>
      </div>`;
  }

  /**
   * Agrega por SUCURSAL CONTABLE (eje A, columna sucursal 00–05): la balanza `by_sucursal`
   * + las pólizas sin-rastro agrupadas por su sucursal. Ordenado por monto sin-rastro desc.
   */
  private cuadreBySucursal(data: CuadreExportData) {
    const map = new Map<string, any>();
    const get = (s: string) => {
      if (!map.has(s)) map.set(s, { sucursal: s, entrada: 0, salida: 0, delta: 0, sr_ent_n: 0, sr_ent_amt: 0, sr_sal_n: 0, sr_sal_amt: 0, rows: [] });
      return map.get(s);
    };
    for (const s of (data.ledger?.by_sucursal || [])) {
      const g = get(String(s.sucursal)); g.entrada = Number(s.entrada) || 0; g.salida = Number(s.salida) || 0; g.delta = Number(s.delta) || 0;
    }
    for (const r of (data.detail?.rows || [])) {
      const g = get(String(r.sucursal)); g.rows.push(r);
      if (r.kind === 'entrada') { g.sr_ent_n++; g.sr_ent_amt += Number(r.importe) || 0; }
      else { g.sr_sal_n++; g.sr_sal_amt += Number(r.importe) || 0; }
    }
    return Array.from(map.values()).sort((a, b) =>
      (b.sr_ent_amt + b.sr_sal_amt) - (a.sr_ent_amt + a.sr_sal_amt) || Math.abs(b.delta) - Math.abs(a.delta));
  }

  /** Modo CONCENTRADO por sucursal: KPIs globales + tabla resumen por sucursal. */
  private buildCuadreResumenHtml(data: CuadreExportData): string {
    const sucs = this.cuadreBySucursal(data);
    const rows = sucs.map((g) => `<tr>
      <td class="mono">${this.cEsc(g.sucursal)}</td>
      <td class="num up">${this.cMoney(g.entrada)}</td><td class="num dn">${this.cMoney(g.salida)}</td>
      <td class="num ${this.cV(g.delta, g.entrada) === 'difiere' ? 'delta' : 'mut'}">${this.cTxt(g.delta, g.entrada)}</td>
      <td class="num">${this.cNum(g.sr_ent_n)}</td><td class="num up">${this.cMoney(g.sr_ent_amt)}</td>
      <td class="num">${this.cNum(g.sr_sal_n)}</td><td class="num dn">${this.cMoney(g.sr_sal_amt)}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${this.cuadreStyles()}</style></head><body>
      ${this.cuadreHead(data, 'Cuadre de traspasos', 'Concentrado por sucursal · Mayor 515')}
      <div class="sec"><h2>Resumen por sucursal (contable)</h2><span class="cnt">${sucs.length} sucursales</span></div>
      <p class="lead">Entrada/salida/Δ de la balanza (mayor 515) y pólizas SIN RASTRO por sucursal donde se contabiliza. El CEDIS concentra las salidas (es el hub de despacho).</p>
      <table><thead><tr><th>Suc.</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Δ descuadre</th><th class="num">S/rastro ent (n)</th><th class="num">S/rastro ent ($)</th><th class="num">S/rastro sal (n)</th><th class="num">S/rastro sal ($)</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="empty">Sin datos.</td></tr>'}</tbody></table>` +
      `</body></html>`;
  }

  /** Modo DESGLOSADO por sucursal: una sección por sucursal con sus pólizas sin rastro. */
  private buildCuadreDetalleHtml(data: CuadreExportData): string {
    const sucs = this.cuadreBySucursal(data);
    const blocks = sucs.map((g, idx) => {
      const rows = [...g.rows].sort((a: any, b: any) => (Number(b.importe) || 0) - (Number(a.importe) || 0)).map((r: any) => `<tr>
        <td class="mono">${this.cEsc(r.anio_mes)}</td>
        <td class="${r.kind === 'entrada' ? 'up' : 'dn'}">${r.kind === 'entrada' ? 'Entrada 515-001' : 'Salida 515-002'}</td>
        <td class="num">${this.cMoney(r.importe, 2)}</td><td>${this.cEsc(r.referencia || '—')}</td></tr>`).join('');
      return `
      <div class="sucband${idx > 0 ? ' brk' : ''}"><h2>Sucursal ${this.cEsc(g.sucursal)}</h2>
        <span class="n">Entrada ${this.cMoney(g.entrada)} · Salida ${this.cMoney(g.salida)} · Δ ${this.cSigned(g.delta)} · sin rastro ${this.cNum(g.sr_ent_n + g.sr_sal_n)} pólizas (${this.cMoney(g.sr_ent_amt + g.sr_sal_amt)})</span></div>
      <table><thead><tr><th>Mes</th><th>Tipo</th><th class="num">Importe</th><th>Referencia (localizador en Kepler)</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty">Sin pólizas sin rastro en esta sucursal.</td></tr>'}</tbody></table>`;
    }).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${this.cuadreStyles()}</style></head><body>
      ${this.cuadreHead(data, 'Cuadre de traspasos', 'Desglosado por sucursal · Mayor 515')}
      <p class="lead">Pólizas de la cuenta 515 SIN RASTRO (sin contraparte con tolerancia ±2% ni en la ventana ±1 mes), agrupadas por la sucursal donde se contabilizan. La referencia trae el folio del traspaso para ubicarlo en Kepler.</p>
      ${blocks || '<div class="empty">Sin pólizas sin rastro en el rango.</div>'}
      </body></html>`;
  }

  private buildCuadreHtml(data: CuadreExportData): string {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
    const money = (n: any, dec = 0) => (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: dec, minimumFractionDigits: dec });
    const signed = (n: any) => (Number(n) > 0 ? '+' : '') + money(n);
    const num = (n: any) => (n == null || n === '' ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: 0 }));
    const dmy = (d: any) => { const s = this.fmtDate(d); return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}` : '—'; };
    // cuadra si |Δ| < $1 o < 0.1% de las entradas
    const pct = (delta: any, base: any) => { const b = Math.abs(Number(base) || 0); return b ? ((Math.abs(Number(delta) || 0) / b) * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%' : '—'; };
    const pill = (status: string) => `<span class="pill p-${ESTADO_SEV[status] || 'mut'}">${esc(ESTADO_LABEL[status] || status)}</span>`;

    const lg = data.ledger, mx = data.matrix, ck = data.check;
    // serie mensual con acumulado corriente
    let acc = 0;
    const monthRows = (lg.rows || []).map((m: any) => {
      acc += Number(m.delta) || 0;
      return `<tr><td class="mono">${esc(m.anio_mes)}</td>
        <td class="num up">${money(m.entrada)}</td><td class="num dn">${money(m.salida)}</td>
        <td class="num ${this.cV(m.delta, m.entrada) === 'difiere' ? 'delta' : 'mut'}">${this.cTxt(m.delta, m.entrada)}</td>
        <td class="num mut">${pct(m.delta, m.entrada)}</td>
        <td class="num ${this.cV(acc, m.entrada) === 'difiere' ? 'delta' : ''}">${signed(acc)}</td></tr>`;
    }).join('');
    const sucRows = (lg.by_sucursal || []).map((s: any) => `<tr><td class="mono">${esc(s.sucursal)}</td>
      <td class="num up">${money(s.entrada)}</td><td class="num dn">${money(s.salida)}</td>
      <td class="num ${this.cV(s.delta, s.entrada) === 'difiere' ? 'delta' : 'mut'}">${this.cTxt(s.delta, s.entrada)}</td></tr>`).join('');
    const mxRows = (mx.rows || []).map((r: any) => `<tr>
      <td>${esc(r.origin_wh || '—')}</td><td>${esc(r.dest_wh || '(sin destino)')}</td>
      <td class="num">${num(r.qty_sent)}</td><td class="num">${num(r.qty_received)}</td>
      <td class="num ${Math.abs(Number(r.delta_qty) || 0) < 0.01 ? 'mut' : 'delta'}">${Math.abs(Number(r.delta_qty) || 0) < 0.01 ? 'cuadra' : (Number(r.delta_qty) > 0 ? '+' : '') + num(r.delta_qty)}</td>
      <td class="num">${money(r.amount)}</td>
      <td class="num mut">${num(r.n_ok)} / ${num(r.n_diferencia)} / ${num(r.n_sin_recepcion)}</td></tr>`).join('');
    const unmatched = (ck.rows || []).filter((r: any) => r.status !== 'ok');
    const ckRows = unmatched.map((r: any) => `<tr>
      <td>${pill(r.status)}</td><td>${esc(r.origin_wh || '—')}</td><td class="mono">${esc(r.origin_folio || r.rcv_folio || '—')}</td>
      <td>${esc(r.dest_wh || '—')}</td><td class="num">${num(r.qty_sent)}</td><td class="num">${num(r.qty_received)}</td>
      <td class="num ${Number(r.delta) ? 'delta' : ''}">${Number(r.delta) ? (Number(r.delta) > 0 ? '+' : '') + num(r.delta) : '—'}</td>
      <td class="num">${r.amount != null ? money(r.amount, 2) : '—'}</td>
      <td>${dmy(r.ship_date || r.rcv_date)}</td></tr>`).join('');
    const dt = data.detail;
    const detailRows = (dt?.rows || []).map((r: any) => `<tr>
      <td class="mono">${esc(r.anio_mes)}</td>
      <td class="${r.kind === 'entrada' ? 'up' : 'dn'}">${r.kind === 'entrada' ? 'Entrada 515-001' : 'Salida 515-002'}</td>
      <td>${esc(r.sucursal || '—')}</td><td class="num">${money(r.importe, 2)}</td>
      <td>${esc(r.referencia || '—')}</td></tr>`).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${this.cuadreStyles()}</style></head><body>
      ${this.cuadreHead(data, 'Cuadre de traspasos')}

      <div class="sec"><h2>1 · Cuadre contable por mes</h2><span class="cnt">balanza Kepler, mayor 515</span></div>
      <p class="lead">Cuenta puente: cada salida (515-002) debe tener su entrada (515-001) → el mayor debe netear $0. Δ ≠ 0 = traspasos sin cuadrar o en tránsito al corte.</p>
      <div class="cols">
        <div>
          <table><thead><tr><th>Mes</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Δ</th><th class="num">% desc.</th><th class="num">Acumulado</th></tr></thead>
          <tbody>${monthRows || '<tr><td colspan="6" class="empty">Sin datos contables en el rango.</td></tr>'}</tbody></table>
        </div>
        <div>
          <table><thead><tr><th>Sucursal</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Δ descuadre</th></tr></thead>
          <tbody>${sucRows || '<tr><td colspan="4" class="empty">—</td></tr>'}</tbody></table>
        </div>
      </div>

      <div class="sec brk"><h2>2 · Flujo físico origen → destino</h2><span class="cnt">${num((mx.rows || []).length)} pares</span></div>
      <p class="lead">Pareo de cada salida física con su recepción. Le pone cara (sucursales) al descuadre contable.</p>
      <table><thead><tr><th>Origen</th><th>Destino</th><th class="num">Enviado</th><th class="num">Recibido</th><th class="num">Δ pzs</th><th class="num">Valor</th><th class="num">OK / dif / s.rec.</th></tr></thead>
      <tbody>${mxRows || '<tr><td colspan="7" class="empty">Sin traspasos físicos en el rango.</td></tr>'}</tbody></table>

      <div class="sec"><h2>3 · Traspasos sin cuadrar</h2><span class="cnt">${num(unmatched.length)} a revisar</span></div>
      <table><thead><tr><th>Estado</th><th>Origen</th><th>Folio</th><th>Destino</th><th class="num">Enviado</th><th class="num">Recibido</th><th class="num">Δ pzs</th><th class="num">Valor</th><th>Fecha</th></tr></thead>
      <tbody>${ckRows || '<tr><td colspan="9" class="empty">No hay traspasos sin cuadrar en el rango.</td></tr>'}</tbody></table>

      <div class="sec brk"><h2>4 · Pólizas contables sin rastro</h2><span class="cnt">${num(dt?.total || 0)} pólizas${dt?.truncated ? ` · primeras ${num((dt?.rows || []).length)}` : ''}</span></div>
      <p class="lead">Pareo con tolerancia ±${dt?.totals?.cost != null ? '2' : '2'}% + ventana ±1 mes. Balance: ${num(dt?.totals?.n_exact || 0)} pareadas exactas · ${num(dt?.totals?.cost?.n || 0)} con diferencia de costo (Δ ${money(dt?.totals?.cost?.diff_total || 0)}). Lo de abajo es lo SIN RASTRO — la referencia trae el folio para ubicarlo en Kepler.</p>
      <table><thead><tr><th>Mes</th><th>Tipo</th><th>Suc.</th><th class="num">Importe</th><th>Referencia (localizador)</th></tr></thead>
      <tbody>${detailRows || '<tr><td colspan="5" class="empty">No hay pólizas sin contraparte en el rango.</td></tr>'}</tbody></table>
    </body></html>`;
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
    const tk = this.transferKpis(data);
    const tc = tk.tc;
    const trNote = this.transferListNote(tk);
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

    const valListado = data.transfers.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const trRows = data.transfers.map((r) => `
      <tr><td>${pill(r.status)}</td>
      <td>${esc(r.origin_wh || '—')}</td><td class="mono">${esc(r.origin_folio || '—')}</td><td>${dmy(r.ship_date)}</td><td class="num">${num(r.qty_sent)}</td>
      <td class="num">${r.amount != null ? money(r.amount, 2) : '—'}</td>
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
          ${num(data.totals.documentos)} documentos · ${num(tk.sums.n)} traspasos
        </div>
      </div>

      <div class="kpis">
        <div class="kpi"><span class="kpi-l">Entradas (pzas)</span><span class="kpi-v">+${num(Math.abs(data.totals.entradas))}</span></div>
        <div class="kpi"><span class="kpi-l">Salidas (pzas)</span><span class="kpi-v">−${num(Math.abs(data.totals.salidas))}</span></div>
        <div class="kpi"><span class="kpi-l">Valor movido</span><span class="kpi-v">${money(data.totals.valor)}</span>${data.totals.lineas_sin_importe ? `<span style="font-size:9px;color:#837A6C">parcial: ${num(data.totals.lineas_sin_importe)} renglones sin costo en Kepler</span>` : ''}</div>
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
          ? `primeros ${num(PDF_CAP)} de ${num(data.docs.length)} — acota el rango o los filtros para ver el resto`
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
        <span class="cnt">${tk.cut ? `primeros ${num(tk.listed)} de ${num(tk.sums.n)}, los problemas primero` : `${num(tk.sums.n)} traspasos`}</span>
      </div>
      <table><thead><tr><th>Estado</th><th>Origen</th><th>Folio salida</th><th>Fecha salida</th><th class="num">Enviadas</th>
      <th class="num">Valor</th><th>Destino</th><th>Folio recepción</th><th>Fecha recepción</th><th class="num">Recibidas</th><th class="num">Δ piezas</th></tr></thead>
      <tbody>${trRows || '<tr><td colspan="11" class="empty">Sin traspasos en el rango.</td></tr>'}
      ${trRows ? `<tr class="tot"><td colspan="5">TOTAL${tk.cut ? ' (filas listadas)' : ''}</td><td class="num">${money(valListado, 2)}</td><td colspan="5"></td></tr>` : ''}
      </tbody></table>
      ${trNote ? `<p class="mut" style="font-size:9px;margin:4px 0 0">${esc(trNote)}</p>` : ''}

    </body></html>`;
  }
}
