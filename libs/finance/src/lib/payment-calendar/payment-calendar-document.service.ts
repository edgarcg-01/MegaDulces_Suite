import { BadRequestException, Injectable } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { warehouseName } from '@megadulces/contracts';
import { PaymentCalendarService, type ExpedienteLinea } from './payment-calendar.service';

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
/**
 * `[PGP.33]` **Quién ejecuta este pago.** No es siempre Caja General, y este documento lo daba por
 * hecho: se titulaba «Instrucción de Ejecución — Caja General» y pedía su firma para TODO el lote.
 * Medido contra prod el 2026-10-29 sobre los 4,898 pagos a proveedor del ERP:
 *
 *   - **$404,105,108 — el 87.3 % del dinero** — sale de una cuenta de **banco**, y eso lo dispersa
 *     Tesorería: el papel le pedía la firma a un área que no toca ese dinero;
 *   - **$58,799,036 (12.7 %)** sale de **CAJA GENERAL**, que son el **56.7 % de los pagos** por
 *     conteo: muchos y chicos.
 *
 * Lo que decide es la **clase de la cuenta de origen**, no el método. Un pago sin preparar no tiene
 * ejecutor y **se declara**; no se le asigna uno por omisión (ADR-056).
 */
/** Lo unico que `ejecutorDe` necesita de una asignacion: con que cuenta y metodo se paga. */
type ConEjecutor = { payment_method?: string | null; bank_account_kind?: string | null };

function ejecutorDe(a: ConEjecutor): string {
  if (!a.payment_method) return 'sin preparar';
  if (a.bank_account_kind === 'cash' || a.payment_method === 'efectivo') return 'Caja General';
  if (a.bank_account_kind === 'bank' || a.bank_account_kind === 'factoraje') return 'Tesorería';
  return 'sin preparar';
}

/** Los ejecutores que el lote REALMENTE involucra, en orden estable. Sin inventar al que no está. */
function ejecutoresDelLote(allocations: ConEjecutor[]): string[] {
  const vistos = new Set(allocations.map(ejecutorDe));
  return ['Tesorería', 'Caja General'].filter((e) => vistos.has(e));
}

const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/**
 * `[PGP.47]` `2026-10-25` → `25-oct`. En una tabla de 10 columnas la fecha ISO se come el ancho
 * de dos, y el año no aporta: todo lo que se programa para pagar es del ejercicio en curso.
 * ⛔ Se corta el string, NO se construye un `Date`: `new Date('2026-10-25')` es UTC y en
 * `America/Mexico_City` imprime el día ANTERIOR (GOTCHAS, el clásico de la fecha corrida).
 */
function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [, m, d] = String(iso).slice(0, 10).split('-');
  const mi = Number(m) - 1;
  return mi >= 0 && mi < 12 ? `${Number(d)}-${MES_CORTO[mi]}` : String(iso).slice(0, 10);
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
 *   - `renderEjecucion`: la INSTRUCCIÓN DE EJECUCIÓN, sólo disponible tras autorizar (el lote
 *     ya tiene folio) — dice qué ejecutar, con qué método/cuenta y **quién lo ejecuta**: Tesorería
 *     lo que sale de banco o factoraje, Caja General lo que sale de la caja (`[PGP.33]`).
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
          <td>${esc(a.bank_account_label || (a.payment_method === 'efectivo' ? 'Caja' : '—'))}</td>
          ${opts.conFolio ? `<td>${esc(ejecutorDe(a))}</td>` : ''}
          <td>${esc(cuenta)}</td>
          <td class="r">${money(a.amount_assigned)}</td>
        </tr>`;
      }).join('');
    return `<table>
      <thead><tr><th>${opts.conFolio ? 'Folio' : 'Orden'}</th><th>Beneficiario</th><th>Clasificación</th><th>Método</th><th>Cuenta origen</th>${opts.conFolio ? '<th>Ejecuta</th>' : ''}<th>Cuenta destino / referencia</th><th class="r">Importe</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="total-row"><td colspan="${opts.conFolio ? 7 : 6}">Total</td><td class="r">${money(this.filaTotal(allocations))}</td></tr></tfoot>
    </table>`;
  }

  /**
   * `[PGP.47]` **El desglose por factura**, que es lo que convierte este papel en la carátula del
   * expediente físico: una fila por pago y, debajo, un renglón por cada documento que liquida,
   * con el folio interno (el del ERP), el externo (el impreso en el papel del proveedor), las
   * fechas, los importes y **qué papel existe hoy**.
   *
   * ⛔ El folio externo lleva su FUENTE en una columna propia porque los dos no valen lo mismo:
   * `CFDI` es el folio timbrado y `OCR` es una lectura automática de la foto del comprobante.
   * Juntarlos bajo un solo rótulo haría que una lectura se leyera como un dato fiscal.
   */
  private tablaExpediente(allocations: any[], detalle: ExpedienteLinea[]): string {
    const porPago = new Map<string, ExpedienteLinea[]>();
    for (const d of detalle) {
      const arr = porPago.get(d.allocation_id) ?? [];
      arr.push(d);
      porPago.set(d.allocation_id, arr);
    }
    const FUENTE: Record<string, string> = { cfdi: 'CFDI', ocr: 'OCR', erp: 'ERP', ninguna: '—' };
    const PAPEL: Record<string, string> = { pdf: 'PDF', uuid: 'UUID', ninguna: 'FALTA', no_aplica: '—' };
    const cuerpo = allocations
      .slice()
      .sort((a, b) => (a.priority_rank ?? 999) - (b.priority_rank ?? 999))
      .map((a) => {
        const lineas = (porPago.get(a.id) ?? []).slice()
          .sort((x, y) => String(x.folio_interno ?? '').localeCompare(String(y.folio_interno ?? '')));
        const quien = [...new Set((a.items || []).map((i: any) => String(i.beneficiary || '')).filter(Boolean))].join('; ');
        const rfcs = [...new Set(lineas.map((l) => l.rfc).filter(Boolean))];
        const comoSale = [
          a.payment_method ? METHOD_LABEL[a.payment_method] || a.payment_method : 'sin preparar',
          a.bank_account_label || (a.payment_method === 'efectivo' ? 'Caja' : null),
          a.destination_account_text || a.cash_register_text || a.reference_text || null,
        ].filter(Boolean).join(' · ');
        const cabeza = `<tr class="pago-row">
          <td class="c">${esc(a.priority_rank ?? '—')}</td>
          <td colspan="6"><b>${esc(quien || '—')}</b>${rfcs.length ? ` · RFC ${esc(rfcs.join(' / '))}` : ''}
            <div class="como">${esc(comoSale)} · ${CLASSIFICATION_LABEL[a.classification] || esc(a.classification)}</div></td>
          <td class="r"><b>${money(a.amount_assigned)}</b></td>
          <td class="c">${lineas.length || '—'}</td>
        </tr>`;
        const hijas = lineas.length
          ? lineas.map((l) => `<tr class="doc-row">
              <td></td>
              <td>${esc(warehouseName(l.sucursal) || '—')}</td>
              <td>${esc(l.folio_interno || '—')}${l.saldada ? ' <b>· YA SALDADA EN EL ERP</b>' : ''}</td>
              <td>${esc(l.folio_externo || '—')}</td>
              <td class="c">${esc(l.folio_externo ? FUENTE[l.folio_externo_fuente ?? 'ninguna'] : '—')}</td>
              <td class="c">${esc(fechaCorta(l.fecha))}</td>
              <td class="c">${esc(fechaCorta(l.vencimiento))}</td>
              <td class="r">${l.importe === null ? '—' : money(l.importe)}</td>
              <td class="r">${money(l.se_paga)}</td>
              <td class="c">${esc(PAPEL[l.papel])}</td>
            </tr>`).join('')
          : `<tr class="doc-row"><td></td><td colspan="9"><em>Sin desglose: este pago no tiene documentos ligados.</em></td></tr>`;
        return cabeza + hijas;
      }).join('');
    return `<table class="exp">
      <thead><tr>
        <th>Orden</th><th>Sucursal</th><th>Folio interno</th><th>Folio externo</th><th class="c">Fte</th>
        <th class="c">Fecha</th><th class="c">Vence</th><th class="r">Importe doc.</th><th class="r">Se paga</th><th class="c">Papel</th>
      </tr></thead>
      <tbody>${cuerpo}</tbody>
      <tfoot><tr class="total-row"><td colspan="8">Total del día</td><td class="r">${money(this.filaTotal(allocations))}</td><td></td></tr></tfoot>
    </table>`;
  }

  /**
   * `[PGP.47]` **Qué falta para poder armar el expediente**, contado sobre este día. Va arriba de
   * las firmas porque es lo que alguien tiene que resolver ANTES de que el papel sirva de carátula.
   * ⛔ Se cuenta sólo lo que debería tener factura del ERP: una obligación propia no tiene papel
   * que buscar, y sumarla a «sin papel» inflaría el pendiente (ADR-056).
   */
  private controlExpediente(detalle: ExpedienteLinea[]): string {
    const conPapel = detalle.filter((d) => d.papel !== 'no_aplica');
    const n = (p: string) => conPapel.filter((d) => d.papel === p).length;
    const saldadas = detalle.filter((d) => d.saldada).length;
    const sinExterno = conPapel.filter((d) => !d.folio_externo).length;
    const porOcr = conPapel.filter((d) => d.folio_externo_fuente === 'ocr').length;
    const porErp = conPapel.filter((d) => d.folio_externo_fuente === 'erp').length;
    const parcial = detalle.filter((d) => d.pendiente !== null && d.se_paga < d.pendiente - 0.005).length;
    const fila = (k: string, v: number | string, nota = '') =>
      `<tr><td>${esc(k)}</td><td class="r"><b>${esc(String(v))}</b></td><td class="nota">${esc(nota)}</td></tr>`;
    return `<h2>Control del expediente</h2>
      <table class="ctrl">
        ${fila('Documentos del día', detalle.length, `${conPapel.length} con factura del ERP detrás`)}
        ${fila('Con la factura digitalizada (PDF)', n('pdf'), 'se puede imprimir del sistema')}
        ${fila('Sólo con UUID fiscal, sin archivo', n('uuid'), 'hay que pedir el PDF al proveedor')}
        ${fila('SIN ningún papel', n('ninguna'), 'hay que buscarlos en el archivo físico')}
        ${fila('Sin folio externo legible', sinExterno, 'el papel se busca por folio interno y fecha')}
        ${fila('Folio externo leído por OCR', porOcr, 'no verificado contra el CFDI — cotejar contra el papel')}
        ${fila('Folio externo tecleado en el ERP', porErp, 'lleva el prefijo de captura — cotejar contra el papel')}
        ${fila('Se paga menos de lo que se debe', parcial, 'pago parcial o descuento: anexar el soporte')}
        ${saldadas ? fila('ATENCIÓN — el ERP ya no debe este documento', saldadas, 'no se puede pagar: revisar antes de autorizar') : ''}
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
        /* [PGP.47] El desglose. Es papel en BLANCO Y NEGRO: la jerarquia entre el pago y sus
           facturas la llevan el fondo, el peso y la sangria, nunca un color. */
        table.exp { font-size: 8pt; }
        table.exp th, table.exp td { padding: 1.1mm 1.4mm; }
        .pago-row td { background: #ececec; border-top: 1.2pt solid #555; padding-top: 1.8mm; }
        .pago-row .como { font-size: 7.5pt; color: #444; margin-top: 0.6mm; }
        .doc-row td { border-color: #ddd; }
        .doc-row td:nth-child(2) { padding-left: 3.5mm; }
        /* El thead se repite solo en cada página impresa; sin esto, la página 2 son filas mudas. */
        table.exp thead { display: table-header-group; }
        .pago-row, .doc-row { break-inside: avoid; }
        table.ctrl { width: auto; min-width: 110mm; font-size: 9pt; }
        table.ctrl td { border: none; border-bottom: 1px solid #e3e3e3; padding: 1.2mm 3mm 1.2mm 0; }
        table.ctrl .nota { color: #666; font-size: 8pt; }
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
    const [lot, summary, allocations, detalle] = await Promise.all([
      this.calendar.getLot(date), this.calendar.daySummary(date), this.calendar.listDayAllocations(date),
      this.calendar.detalleExpediente(date),
    ]);
    if (!allocations.length) throw new BadRequestException('Este día no tiene pagos asignados — no hay nada que autorizar.');
    const total = this.filaTotal(allocations);
    const html = `<!doctype html><html><head><meta charset="utf-8">${this.baseCss()}</head><body>
      <h1>Programación de Pagos — Preliminar para autorización</h1>
      <p class="sub">Fecha de pago: <b>${fechaLarga(date)}</b> · Folio del lote: <b>${esc(lot?.folio || 'sin asignar (se genera al autorizar)')}</b> · Capacidad autorizada: <b>${summary.capacity_defined ? money(summary.authorized_amount) : 'NO DEFINIDA'}</b> · Total propuesto: <b>${money(total)}</b> · <b>${allocations.length}</b> pago(s), <b>${detalle.length}</b> documento(s)</p>
      ${this.tablaExpediente(allocations, detalle)}
      ${this.controlExpediente(detalle)}
      <div class="leyenda">
        <b>Control interno — tramo de autorización</b>
        Este documento es un PRELIMINAR y NO autoriza pago alguno por sí mismo. Requiere la firma de
        quien tiene facultad de autorización sobre el Calendario de Pagos antes de proceder.<br/>
        <b>Instrucción de ejecución:</b> una vez autorizado (folio asignado), cada pago lo EJECUTA
        quien corresponde a su cuenta de origen —Tesorería lo que sale de banco o factoraje, Caja
        General lo que sale de la caja— exactamente por el método y la cuenta indicados en cada
        renglón, respetando el orden de pago si la capacidad disponible no alcanza para todos.<br/>
        <b>Expediente:</b> el desglose de arriba es la carátula del expediente de cada pago. Cada
        renglón identifica un documento por su <b>folio interno</b> (el del ERP) y, cuando existe,
        por el <b>folio externo</b> impreso en el papel del proveedor, indicando si ése viene del
        CFDI timbrado o de la lectura automática del comprobante —en cuyo caso <b>se coteja contra
        el papel antes de archivar</b>. La columna «Papel» dice qué hay hoy: PDF se imprime del
        sistema, UUID se le pide al proveedor, y FALTA se busca en el archivo físico.
      </div>
      <div class="firmas">
        <div class="firma">Preparó (Tesorería)</div>
        <div class="firma">Autorizó</div>
      </div>
      <p class="foot-note">Generado el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Calendario de Pagos (Fase TP) · Este documento no reemplaza el registro electrónico de autorización.</p>
    </body></html>`;
    return this.renderPdf(html, '<span></span>');
  }

  /**
   * `[PGP.33]` Instrucción de ejecución — SOLO tras autorizar (el lote ya tiene folio).
   *
   * ⛔ Antes se llamaba `renderCajaGeneral` y el papel entero se titulaba «— Caja General», con
   * una sola línea de firma «Ejecutó (Caja General)». Medido: el **87.3 % del dinero** sale de
   * banco y lo dispersa **Tesorería**, que no aparecía en el documento. Ahora el título es neutro,
   * cada renglón dice quién lo ejecuta y **las firmas son las de los ejecutores que el lote
   * realmente involucra** — una, dos, o ninguna si no hay nada preparado.
   */
  async renderEjecucion(date: string): Promise<Buffer> {
    const [lot, allocations] = await Promise.all([this.calendar.getLot(date), this.calendar.listDayAllocations(date)]);
    if (!lot?.folio) throw new BadRequestException('Este día aún no está autorizado — no se puede imprimir la instrucción de ejecución.');
    const total = this.filaTotal(allocations);
    // `[PGP.33]` Sólo los ejecutores que este lote realmente involucra. Si está todo sin preparar
    // la lista queda vacía y el texto lo dice, en vez de nombrar a Caja General por costumbre.
    const ejecutores = ejecutoresDelLote(allocations);
    const html = `<!doctype html><html><head><meta charset="utf-8">${this.baseCss()}</head><body>
      <h1>Instrucción de Ejecución</h1>
      <p class="sub">Fecha de pago: <b>${fechaLarga(date)}</b> · Folio del lote: <b>${esc(lot.folio)}</b> · Autorizado por <b>${esc(lot.released_by || '—')}</b> el <b>${lot.released_at ? new Date(lot.released_at).toISOString().slice(0, 16).replace('T', ' ') : '—'}</b> · Total: <b>${money(total)}</b></p>
      ${this.tablaPagos(allocations, { conFolio: true })}
      <div class="leyenda">
        <b>Instrucción a ${esc(ejecutores.join(' y ')) || 'quien ejecute'}</b>
        Cada renglón indica en la columna <b>Ejecuta</b> a quién le toca: lo que sale de una cuenta
        de banco o de factoraje lo dispersa Tesorería; lo que sale de la caja, Caja General.
        Ejecutar exactamente por el método y la cuenta indicados, y registrar el comprobante de cada
        pago al concluir. Cualquier diferencia (cuenta errónea, falla del sistema del banco, pago
        devuelto) se reporta para reprogramar — NO se improvisa un cambio de cuenta o de monto.
      </div>
      <div class="firmas">${ejecutores.map((e) => `<div class="firma">Ejecutó (${esc(e)})</div>`).join('')}<div class="firma">Recibió conformidad</div></div>
      <p class="foot-note">Generado el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Calendario de Pagos (Fase TP).</p>
    </body></html>`;
    return this.renderPdf(html, '<span></span>');
  }
}
