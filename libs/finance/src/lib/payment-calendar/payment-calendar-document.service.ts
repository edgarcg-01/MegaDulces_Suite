import { BadRequestException, Injectable } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { PaymentCalendarService } from './payment-calendar.service';

const CLASSIFICATION_LABEL: Record<string, string> = {
  compromiso_financiero: 'Compromiso financiero', gasto: 'Gasto', proveedor_mercancia: 'Proveedor de mercancía',
};
const METHOD_LABEL: Record<string, string> = {
  transferencia: 'Transferencia', cheque: 'Cheque', efectivo: 'Efectivo', cargo_automatico: 'Cargo automático',
};

function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
}
function money(n: any): string {
  return '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fechaLarga(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${d} de ${MESES[m - 1]} de ${y}`;
}

/**
 * Fase TP.8 (ADR-064) — Documentos imprimibles del Calendario de Pagos:
 *   - `renderPreliminar`: el documento que va a AUTORIZACIÓN (leyendas de control interno,
 *     nunca ejecuta nada — sólo informa/formaliza la decisión pendiente).
 *   - `renderCajaGeneral`: la INSTRUCCIÓN DE EJECUCIÓN, sólo disponible tras autorizar (el lote
 *     ya tiene folio) — le dice a Caja General qué ejecutar y con qué método/cuenta.
 * Navegador Chromium propio (mismo patrón exacto que `AnexoVentaService` — Fase AX — pero NO se
 * importa desde acá: `libs/finance` mantiene la frontera limpia con `commercial`/`trade`, misma
 * decisión ya tomada para AX mismo al descartar `libs/trade`'s `PdfService`). Singleton + idle
 * timer de 3 min: lanzar Chromium por request cuesta ~3-4s; un ocioso son ~100-150MB.
 */
@Injectable()
export class PaymentCalendarDocumentService {
  constructor(private readonly calendar: PaymentCalendarService) {}

  private static browserP: Promise<puppeteer.Browser> | null = null;
  private static idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_MS = 3 * 60 * 1000;

  private static async getBrowser(): Promise<puppeteer.Browser> {
    if (!PaymentCalendarDocumentService.browserP) {
      PaymentCalendarDocumentService.browserP = puppeteer
        .launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
        })
        .then((b) => { b.on('disconnected', () => { PaymentCalendarDocumentService.browserP = null; }); return b; })
        .catch((e) => { PaymentCalendarDocumentService.browserP = null; throw e; });
    }
    return PaymentCalendarDocumentService.browserP;
  }

  private static touchIdle(): void {
    if (PaymentCalendarDocumentService.idleTimer) clearTimeout(PaymentCalendarDocumentService.idleTimer);
    PaymentCalendarDocumentService.idleTimer = setTimeout(() => {
      const p = PaymentCalendarDocumentService.browserP;
      PaymentCalendarDocumentService.browserP = null;
      p?.then((b) => b.close()).catch(() => undefined);
    }, PaymentCalendarDocumentService.IDLE_MS);
    (PaymentCalendarDocumentService.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async renderPdf(html: string, footer: string): Promise<Buffer> {
    const browser = await PaymentCalendarDocumentService.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      const pdf = await page.pdf({
        format: 'Letter', printBackground: true, displayHeaderFooter: true,
        headerTemplate: '<span></span>', footerTemplate: footer,
        margin: { top: '10mm', bottom: '12mm', left: '9mm', right: '9mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
      PaymentCalendarDocumentService.touchIdle();
    }
  }

  private filaTotal(allocations: any[]): number {
    return allocations.reduce((s, a) => s + Number(a.amount_assigned), 0);
  }

  private tablaPagos(allocations: any[], opts: { conFolio: boolean }): string {
    const rows = allocations
      .slice()
      .sort((a, b) => (a.priority_rank ?? 999) - (b.priority_rank ?? 999))
      .map((a) => {
        const beneficiarios = (a.items || []).map((i: any) => esc(i.beneficiary)).join('; ');
        const cuenta = a.destination_account_text || a.cash_register_text || a.reference_text || '—';
        return `<tr>
          <td class="c">${opts.conFolio ? esc(a.folio || '—') : esc(a.priority_rank ?? '—')}</td>
          <td>${beneficiarios || '—'}</td>
          <td>${CLASSIFICATION_LABEL[a.classification] || esc(a.classification)}</td>
          <td>${a.payment_method ? METHOD_LABEL[a.payment_method] || esc(a.payment_method) : '<em>sin preparar</em>'}</td>
          <td>${esc(cuenta)}</td>
          <td class="r">${money(a.amount_assigned)}</td>
        </tr>`;
      }).join('');
    return `<table>
      <thead><tr><th>${opts.conFolio ? 'Folio' : 'Orden'}</th><th>Beneficiario</th><th>Clasificación</th><th>Método</th><th>Cuenta / referencia</th><th class="r">Importe</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  private baseCss(): string {
    return `
      <style>
        * { box-sizing: border-box; }
        body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; color: #1a1a1a; }
        h1 { font-size: 14pt; margin: 0 0 2mm; } h2 { font-size: 11pt; margin: 6mm 0 2mm; }
        .sub { color: #555; font-size: 9pt; margin-bottom: 4mm; }
        table { width: 100%; border-collapse: collapse; margin: 3mm 0; font-size: 9pt; }
        th, td { border: 1px solid #ccc; padding: 1.6mm 2mm; text-align: left; vertical-align: top; }
        th { background: #f2f2f2; }
        .r { text-align: right; font-variant-numeric: tabular-nums; } .c { text-align: center; }
        .total-row td { font-weight: 700; border-top: 2px solid #333; }
        .leyenda { border: 1.4pt solid #333; padding: 3mm 4mm; margin: 5mm 0; font-size: 9.5pt; background: #fafafa; }
        .leyenda b { display: block; margin-bottom: 1mm; }
        .firmas { display: flex; gap: 12mm; margin-top: 10mm; }
        .firma { flex: 1; border-top: 1pt solid #333; padding-top: 2mm; font-size: 9pt; text-align: center; }
        .foot-note { font-size: 8pt; color: #777; margin-top: 4mm; }
      </style>`;
  }

  /**
   * El "preliminar" que va a autorización. Disponible en CUALQUIER momento del borrador (aún
   * sin folio) — precisamente para que quien autoriza vea qué se le está pidiendo firmar.
   */
  async renderPreliminar(date: string): Promise<Buffer> {
    const [lot, summary, allocations] = await Promise.all([
      this.calendar.getLot(date), this.calendar.daySummary(date), this.calendar.listDayAllocations(date),
    ]);
    if (!allocations.length) throw new BadRequestException('Este día no tiene pagos asignados — no hay nada que autorizar.');
    const total = this.filaTotal(allocations);
    const html = `<!doctype html><html><head><meta charset="utf-8">${this.baseCss()}</head><body>
      <h1>Programación de Pagos — Preliminar para autorización</h1>
      <p class="sub">Fecha de pago: <b>${fechaLarga(date)}</b> · Folio del lote: <b>${esc(lot?.folio || 'sin asignar (se genera al autorizar)')}</b> · Capacidad autorizada: <b>${summary.capacity_defined ? money(summary.authorized_amount) : 'NO DEFINIDA'}</b> · Total propuesto: <b>${money(total)}</b></p>
      ${this.tablaPagos(allocations, { conFolio: false })}
      <tr class="total-row"><td colspan="5">Total</td><td class="r">${money(total)}</td></tr>
      <div class="leyenda">
        <b>Control interno — tramo de autorización</b>
        Este documento es un PRELIMINAR y NO autoriza pago alguno por sí mismo. Requiere la firma de
        quien tiene facultad de autorización sobre el Calendario de Pagos antes de proceder.<br/>
        <b>Instrucción a Tesorería:</b> una vez autorizado (folio asignado), Caja General debe
        EJECUTAR los pagos anteriores exactamente por el método y la cuenta/caja indicados en cada
        renglón, respetando el orden de pago si la capacidad disponible no alcanza para todos.
      </div>
      <div class="firmas">
        <div class="firma">Preparó (Tesorería)</div>
        <div class="firma">Autorizó</div>
      </div>
      <p class="foot-note">Generado el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Calendario de Pagos (Fase TP) · Este documento no reemplaza el registro electrónico de autorización.</p>
    </body></html>`;
    return this.renderPdf(html, '<span></span>');
  }

  /** Instrucción de ejecución para Caja General — SOLO tras autorizar (el lote ya tiene folio). */
  async renderCajaGeneral(date: string): Promise<Buffer> {
    const [lot, allocations] = await Promise.all([this.calendar.getLot(date), this.calendar.listDayAllocations(date)]);
    if (!lot?.folio) throw new BadRequestException('Este día aún no está autorizado — no se puede imprimir la instrucción de ejecución.');
    const total = this.filaTotal(allocations);
    const html = `<!doctype html><html><head><meta charset="utf-8">${this.baseCss()}</head><body>
      <h1>Instrucción de Ejecución — Caja General</h1>
      <p class="sub">Fecha de pago: <b>${fechaLarga(date)}</b> · Folio del lote: <b>${esc(lot.folio)}</b> · Autorizado por <b>${esc(lot.released_by || '—')}</b> el <b>${lot.released_at ? new Date(lot.released_at).toISOString().slice(0, 16).replace('T', ' ') : '—'}</b> · Total: <b>${money(total)}</b></p>
      ${this.tablaPagos(allocations, { conFolio: true })}
      <tr class="total-row"><td colspan="5">Total</td><td class="r">${money(total)}</td></tr>
      <div class="leyenda">
        <b>Instrucción a Caja General</b>
        Ejecutar los pagos anteriores exactamente por el método y la cuenta/caja indicados en cada
        renglón. Registrar el comprobante de cada pago al concluir. Cualquier diferencia (cuenta
        errónea, falla del sistema del banco, pago devuelto) se reporta para reprogramar — NO se
        improvisa un cambio de cuenta o de monto en Caja.
      </div>
      <div class="firmas"><div class="firma">Ejecutó (Caja General)</div><div class="firma">Recibió conformidad</div></div>
      <p class="foot-note">Generado el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Calendario de Pagos (Fase TP).</p>
    </body></html>`;
    return this.renderPdf(html, '<span></span>');
  }
}
