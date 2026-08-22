import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { CommercialSalesDocumentsService } from './commercial-sales-documents.service';

/**
 * AX.4 — Anexo informativo al CFDI (+ pagaré desprendible), en PDF.
 *
 * El HTML se arma en TS —no en un `.hbs`— a propósito: el dinero de este documento tiene que
 * cuadrar al centavo (el descuento por renglón va repartido por mayor residuo en el service) y
 * prefiero formatear donde controlo el redondeo, no en helpers de plantilla.
 *
 * Render con puppeteer DIRECTO, igual que `movements-export` y `sell-out-export` en este mismo
 * lib. Se descartó el `PdfService` de `libs/trade`: no está en su barrel, y colgar `ReportsModule`
 * de commercial arrastraría WebSocketModule/Mapbox/scanners y crearía una arista commercial→trade
 * que hoy no existe. El chromium sale de `PUPPETEER_EXECUTABLE_PATH` (lo fija el Dockerfile).
 *
 * El documento NO es fiscal: el comprobante es el CFDI timbrado. Eso va dicho en el banner,
 * en el aviso final y en el pie de cada página.
 *
 * Tipografías del SISTEMA (Segoe UI / Georgia): un PDF que se imprime en cualquier equipo no
 * debe depender de webfonts.
 */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Cuentas de depósito. Cambian poco; si se vuelven configurables, mover a `finance.bank_accounts`. */
const CUENTAS = [
  { banco: 'BBVA', cuenta: '0489396721', clabe: '012 535 00489396721 7' },
  { banco: 'Banorte', cuenta: '1326933041', clabe: '072 496 01326933041 2' },
  { banco: 'Banamex', cuenta: '8301463', clabe: '002 496 70078301463 6' },
];
const EMISOR = {
  nombre: 'LUIS FRANCISCO LÓPEZ GUTIÉRREZ',
  rfc: 'LOGL8810144QS',
  regimen: '612 · Personas Físicas con Actividades Empresariales y Profesionales',
  cp: '59701, Michoacán',
  plaza: 'Santa Ana Pacueco, Pénjamo, Guanajuato, C.P. 36910', // validado vs catálogo SAT (GUA/023)
  plazaCorta: 'Santa Ana Pacueco, Pénjamo, Gto.',
};
const MORATORIO_PCT = 3; // mensual, pactado expresamente (LGTOC 174: sin pacto no se cobra)

export interface AnexoOpts { pagare?: boolean }

@Injectable()
export class AnexoVentaService {
  private logoCache?: string;

  constructor(private readonly docs: CommercialSalesDocumentsService) {}

  async pdfDeFolio(folioDigital: string, opts: AnexoOpts = {}): Promise<Buffer> {
    const doc = await this.docs.detail(folioDigital);
    return this.renderPdf(this.html(doc, opts), this.pie(doc));
  }

  private async renderPdf(html: string, footer: string): Promise<Buffer> {
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
        format: 'Letter',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: footer,
        margin: { top: '13mm', bottom: '14mm', left: '12mm', right: '12mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  // ── formato ────────────────────────────────────────────────────────────
  private m(n: any): string {
    return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  private fechaLarga(d: any): string {
    const x = new Date(d);
    return `${x.getUTCDate()} de ${MESES[x.getUTCMonth()]} de ${x.getUTCFullYear()}`;
  }
  private esc(s: any): string {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  }
  /** Plural de la unidad vendida, para leerlo natural ("120 paquetes"). */
  private unidadPlural(u: string, n: number): string {
    const base = { CJA: 'caja', PAQ: 'paquete', PZA: 'pieza', KG: 'kilo' }[String(u).toUpperCase()] || String(u || '').toLowerCase();
    return n === 1 ? base : `${base}s`;
  }
  private unidadSingular(u: string): string {
    return { CJA: 'caja', PAQ: 'paquete', PZA: 'pieza', KG: 'kilo' }[String(u).toUpperCase()] || String(u || '').toLowerCase();
  }

  /** Importe con letra (pesos MXN). Sin dependencia externa: el documento debe ser autosuficiente. */
  private conLetra(n: number): string {
    const ent = Math.floor(n);
    const cent = Math.round((n - ent) * 100);
    return `${this.letras(ent)} pesos ${String(cent).padStart(2, '0')}/100 M.N.`.replace(/^./, (c) => c.toUpperCase());
  }
  private letras(n: number): string {
    if (n === 0) return 'cero';
    if (n === 100) return 'cien';
    const U = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
      'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
    const D = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
    const C = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
      'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
    if (n < 20) return U[n];
    if (n < 30) return n === 20 ? 'veinte' : `veinti${U[n - 20]}`;
    if (n < 100) return D[Math.floor(n / 10)] + (n % 10 ? ` y ${U[n % 10]}` : '');
    if (n < 1000) return C[Math.floor(n / 100)] + (n % 100 ? ` ${this.letras(n % 100)}` : '');
    if (n < 1e6) {
      const miles = Math.floor(n / 1000);
      const pre = miles === 1 ? 'mil' : `${this.letras(miles)} mil`;
      return pre + (n % 1000 ? ` ${this.letras(n % 1000)}` : '');
    }
    const mill = Math.floor(n / 1e6);
    const pre = mill === 1 ? 'un millón' : `${this.letras(mill)} millones`;
    return pre + (n % 1e6 ? ` ${this.letras(n % 1e6)}` : '');
  }

  private logo(): string {
    if (this.logoCache !== undefined) return this.logoCache;
    const cands = [
      // el optimizado (400px) pesa 36 KB contra 477 KB del original: el PDF baja ~70%
      path.join(process.cwd(), 'apps', 'view', 'src', 'assets', 'logos', 'mega-dulces-logo-print.png'),
      path.join(process.cwd(), 'apps', 'view', 'src', 'assets', 'logos', 'mega-dulces-logo.png'),
    ];
    for (const p of cands) {
      try { this.logoCache = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`; return this.logoCache; }
      catch { /* siguiente */ }
    }
    this.logoCache = '';
    return this.logoCache;
  }

  private pie(doc: any): string {
    const t = this.esc(`Folio ${doc.sucursal} ${doc.doc_prefix}-${doc.folio} · ${doc.cliente_nombre || ''} (${doc.cliente_code || ''}) · Mega Dulces`);
    return `<div style="width:100%;font-family:'Segoe UI',sans-serif;font-size:7.5pt;color:#8a8078;
      padding:0 12mm;display:flex;justify-content:space-between;align-items:center;">
      <span>${t}</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
  }

  // ── documento ──────────────────────────────────────────────────────────
  private html(doc: any, opts: AnexoOpts): string {
    const L = [...(doc.lineas || [])].sort((a: any, b: any) =>
      String(a.descripcion || '').localeCompare(String(b.descripcion || ''), 'es'));
    const pct = Number(doc.descuento_pct) || 0;
    const ahorro = Number(doc.importe_bruto) - Number(doc.total);

    const filas = L.map((l: any) => {
      const cant = Number(l.cantidad);
      const uPl = this.unidadPlural(l.unidad, cant);
      const uSg = this.unidadSingular(l.unidad);
      const eq = l.cajas_equivalentes
        ? `<span class="q-eq">= ${l.cajas_equivalentes} caja${l.cajas_equivalentes > 1 ? 's' : ''}</span>` : '';
      const fac = l.factor_caja && Number(l.factor_caja) > 1
        ? `<span class="q-eq2">${Number(l.factor_caja)} paq. por caja</span>` : '';
      const caja = l.precio_caja
        ? `<span class="pu2">${this.m(l.precio_caja)}</span><span class="pl">por caja</span>` : '';
      const cajaD = l.precio_caja_con_descuento
        ? `<span class="pu2 pd">${this.m(l.precio_caja_con_descuento)}</span><span class="pl">por caja</span>` : '';
      return `<tr>
        <td><div class="p-name">${this.esc(l.descripcion)}</div><div class="p-sku">SKU ${this.esc(l.sku)}</div></td>
        <td class="qcell"><span class="q-main">${cant} ${uPl}</span>${eq}${fac}</td>
        <td class="u-price"><span class="pu">${this.m(l.precio_unitario)}</span><span class="pl">por ${uSg}</span>${caja}</td>
        <td class="u-price c-hl"><span class="pu pd">${this.m(l.precio_con_descuento)}</span><span class="pl">por ${uSg}</span>${cajaD}</td>
        <td class="imp">${this.m(l.importe)}</td>
        <td class="desc">−${this.m(l.descuento)}</td>
        <td class="neto">${this.m(l.neto)}</td>
      </tr>`;
    }).join('\n');

    const ctas = CUENTAS.map((c) => `<tr><td class="bco">${c.banco}</td><td>${c.cuenta}</td><td class="clabe">${c.clabe}</td></tr>`).join('');

    return `<meta charset="utf-8"><title>Detalle de Pedido</title>
<style>
:root{--ink:#1b1b1b;--ink-2:#454545;--muted:#5f5f5f;--line:#c9c9c9;--line-2:#e2e2e2;--soft:#f5f5f3;
  --accent:#8a3c06;--accent-soft:#fbf1e6;--save:#155e35}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;padding:0;background:#fff;color:var(--ink);font-family:"Segoe UI",Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.3}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}
.logo{height:64px;width:auto}
.emisor{text-align:right;font-size:8pt;color:var(--ink-2);line-height:1.4;max-width:78mm}
.emisor b{display:block;color:var(--ink);font-size:9.5pt;font-weight:700;margin-bottom:2px}
.rule{height:2px;background:var(--accent);margin:9px 0 12px}
.titleband{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
.titleband .sub{font-size:8.5pt;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
.titleband h1{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:19pt;margin:3px 0 0;line-height:1.1}
.folio{text-align:right;white-space:nowrap}
.folio .fl{font-size:8pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
.folio .fv{font-size:13pt;font-weight:700}
.nofiscal{display:flex;align-items:center;gap:9px;margin-top:11px;padding:7px 12px;background:var(--accent-soft);
  border:1.5px solid var(--accent);border-radius:4px;color:#6d2f04;font-size:9pt;font-weight:600;line-height:1.3;break-inside:avoid}
.nofiscal .badge{flex:0 0 auto;font-size:8pt;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  background:var(--accent);color:#fff;padding:3px 8px;border-radius:3px}
.info{display:flex;gap:10px;margin-top:11px}
.box{flex:1 1 0;background:var(--soft);border:1px solid var(--line-2);border-radius:4px;padding:9px 12px;break-inside:avoid}
.box h4{margin:0 0 6px;font-size:7.5pt;letter-spacing:.11em;text-transform:uppercase;color:var(--accent);font-weight:700}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:8.5pt;margin:0;line-height:1.25}
.kv dt{color:var(--muted);font-weight:600;white-space:nowrap}
.kv dd{margin:0;text-align:right;font-weight:600}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:13px 0 4px;break-after:avoid}
.sec-h h2{font-size:12.5pt;font-weight:700;margin:0}
.sec-h span{font-size:9pt;color:var(--muted)}
table.det{border-collapse:collapse;width:100%;table-layout:fixed;font-size:10.5pt}
col.c-prod{width:22%}col.c-cant{width:14.5%}col.c-pu{width:13%}col.c-pd{width:14%}
col.c-imp{width:12%}col.c-desc{width:11.5%}col.c-neto{width:13%}
table.det thead{display:table-header-group}
table.det thead th{font-size:8pt;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700;
  text-align:right;padding:8px 7px;border-bottom:1.5px solid var(--ink)}
table.det thead th.l{text-align:left}
table.det tbody tr{break-inside:avoid}
table.det tbody td{padding:6px 7px;border-bottom:1px solid var(--line-2);vertical-align:top}
.p-name{font-weight:700;font-size:10.5pt;line-height:1.25}
.p-sku{font-size:8.5pt;color:var(--muted);font-weight:600;margin-top:2px}
.qcell{text-align:left}
.q-main{font-weight:700;display:block}
.q-eq{display:block;font-size:9pt;color:var(--accent);font-weight:700;margin-top:2px}
.q-eq2{display:block;font-size:8.5pt;color:var(--muted);margin-top:1px;line-height:1.3}
.u-price{text-align:right;line-height:1.18}
.pu{display:block;font-weight:700;font-size:10.5pt}
.pu2{display:block;font-weight:600;font-size:9.5pt;margin-top:3px}
.pl{display:block;font-size:7.5pt;color:var(--muted)}
.c-hl{background:#f2f7f3}.pd{color:var(--save)}th.hl{color:var(--save)}
td.imp,td.desc,td.neto{text-align:right;white-space:nowrap}
td.imp{font-weight:600}td.desc{color:var(--save);font-weight:700}td.neto{font-weight:700}
.foot-grid{display:flex;gap:12px;margin-top:10px;align-items:flex-start;break-inside:avoid}
.letra{flex:1.15 1 0;background:var(--soft);border:1px solid var(--line-2);border-radius:4px;padding:10px 13px}
.letra .cl{font-size:7pt;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700}
.letra .cv{font-size:9pt;font-weight:700;margin-top:3px;line-height:1.3}
.letra .save-line{margin-top:8px;padding-top:8px;border-top:1px solid var(--line-2);color:var(--save);font-weight:700;font-size:9.5pt}
.letra .save-note{margin-top:5px;font-size:8pt;color:var(--ink-2);line-height:1.35}
.tot{flex:.85 1 0;border:1px solid var(--line);border-radius:4px;overflow:hidden}
.tot .r{display:flex;justify-content:space-between;gap:12px;padding:9px 15px;font-size:10.5pt;border-bottom:1px solid var(--line-2)}
.tot .r .l{color:var(--ink-2)}.tot .r .v{font-weight:700;text-align:right}
.tot .r.saved .l,.tot .r.saved .v{color:var(--save);font-weight:700}
.tot .r.memo{background:var(--soft)}.tot .r.memo .l,.tot .r.memo .v{color:var(--muted);font-size:9.5pt;font-weight:600}
.tot .grand{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 15px;background:var(--accent-soft)}
.tot .grand .l{font-weight:800;color:#6d2f04;font-size:11pt}
.tot .grand .v{font-weight:800;color:#6d2f04;font-size:16pt}
.admin{display:flex;gap:11px;margin-top:9px;align-items:stretch}
.admin>.fiscal{flex:.9 1 0;margin-top:0}.admin>.pago{flex:1.1 1 0;margin-top:0}
.fiscal{padding:9px 12px;background:var(--soft);border:1px solid var(--line-2);border-radius:4px;break-inside:avoid}
.fiscal h4{margin:0 0 5px;font-size:7pt;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700}
.fiscal .cfdi-eq{font-size:8.5pt;color:var(--ink-2);line-height:1.4}
.fiscal .cfdi-eq b{color:var(--ink)}
.fiscal .small{font-size:7.5pt;color:var(--muted);margin-top:4px;line-height:1.35}
.pago{border:1.5px solid var(--accent);border-radius:4px;overflow:hidden;break-inside:avoid}
.pago h4{margin:0;padding:7px 12px;background:var(--accent);color:#fff;font-size:8pt;letter-spacing:.11em;text-transform:uppercase;font-weight:700}
.pago .benef{padding:7px 12px;background:var(--accent-soft);font-size:8.5pt;color:#6d2f04;border-bottom:1px solid var(--line-2)}
table.ctas{border-collapse:collapse;width:100%;font-size:9.5pt}
table.ctas th{font-size:7pt;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700;
  text-align:left;padding:6px 12px;border-bottom:1px solid var(--line-2);background:var(--soft)}
table.ctas td{padding:7px 12px;border-bottom:1px solid var(--line-2)}
table.ctas tr:last-child td{border-bottom:0}
table.ctas .bco{font-weight:700}table.ctas .clabe{font-weight:700;letter-spacing:.04em}
.pago .nota{padding:6px 12px;font-size:7.5pt;color:var(--muted);background:var(--soft);border-top:1px solid var(--line-2)}
.disclaimer{margin-top:8px;font-size:8pt;color:var(--ink-2);line-height:1.5;break-inside:avoid}
.disclaimer b{color:var(--ink)}
/* El pagaré es un ANEXO del mismo documento, no una hoja suelta: mismo membrete, misma
   tipografía y misma jerarquía de sección que "¿Qué compraste?". Arranca en página propia
   sólo porque necesita espacio para firmar, no porque sea otro documento. */
.hoja-pagare{break-before:page}
.pg-sec{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 8px;break-after:avoid}
.pg-sec .sub{font-size:8.5pt;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
.pg-sec h2{font-family:Georgia,"Times New Roman",serif;font-size:19pt;font-weight:700;margin:3px 0 0;line-height:1.1}
.pg-sec .ref{text-align:right;font-size:8.5pt;color:var(--muted)}
.pg-sec .ref b{display:block;font-size:11pt;color:var(--ink);font-weight:700}
.pg-doc{border:1px solid var(--line);border-radius:4px;padding:14px 16px}
.pg-band{display:flex;gap:14px;margin:0 0 13px;align-items:stretch}
.pg-bueno{border:1.5px solid var(--ink);border-radius:3px;padding:7px 14px;min-width:52mm}
.pg-bueno span{display:block;font-size:7.5pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.pg-bueno b{font-size:19pt;font-weight:800}
.pg-lugar{flex:1;display:flex;flex-direction:column;justify-content:center;padding:7px 0}
.pg-lugar span{font-size:7.5pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.pg-lugar b{font-size:10.5pt;margin-top:2px}
.pg-cuerpo{font-size:11pt;line-height:1.65;text-align:justify;margin:11px 0}
.pg-grid{display:flex;gap:16px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.pg-col{flex:1 1 0}
.pg-col h5{margin:0 0 6px;font-size:7.5pt;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:700}
.pg-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:9.5pt;margin:0}
.pg-kv dt{color:var(--muted);font-weight:600;white-space:nowrap}.pg-kv dd{margin:0;font-weight:600}
.pg-firma{margin:34px auto 4px;width:72mm;text-align:center}
.pg-firma .linea{border-bottom:1px solid var(--ink);height:1px}
.pg-firma .rot{font-size:8pt;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-top:5px}
.pg-firma .rot2{font-size:9.5pt;font-weight:700;margin-top:2px}
</style>

<div class="head">
  ${this.logo() ? `<img class="logo" src="${this.logo()}" alt="Mega Dulces">` : '<div></div>'}
  <div class="emisor"><b>${EMISOR.nombre}</b>RFC: ${EMISOR.rfc}<br>Régimen ${EMISOR.regimen}<br>Lugar de expedición: C.P. ${EMISOR.cp}</div>
</div>
<div class="rule"></div>

<div class="titleband">
  <div><div class="sub">Anexo informativo al CFDI</div><h1>Detalle de tu pedido</h1></div>
  <div class="folio"><div class="fl">Folio</div><div class="fv">${this.esc(doc.sucursal)} ${this.esc(doc.doc_prefix)} · ${this.esc(doc.folio)}</div></div>
</div>

<div class="nofiscal"><span class="badge">Anexo</span>
  <span>Documento <b>informativo, sin validez fiscal</b>. Tu comprobante es el CFDI timbrado que se entrega junto a este detalle.</span></div>

<div class="info">
  <div class="box"><h4>Cliente</h4><dl class="kv">
    <dt>Nombre</dt><dd>${this.esc(doc.cliente_nombre)}</dd>
    <dt>RFC</dt><dd>${this.esc(doc.cliente_rfc || '—')}</dd>
    <dt>Domicilio</dt><dd>${this.esc([doc.cliente_domicilio, doc.cliente_colonia, doc.cliente_estado].filter(Boolean).join(', '))}</dd>
    <dt>Clave</dt><dd>${this.esc(doc.cliente_code)}</dd>
  </dl></div>
  <div class="box"><h4>Datos del pedido</h4><dl class="kv">
    <dt>Fecha</dt><dd>${this.fechaLarga(doc.fecha)}</dd>
    <dt>Sucursal</dt><dd>${this.esc(doc.sucursal)}</dd>
    <dt>Documento</dt><dd>${this.esc(doc.doc_label)}</dd>
    ${doc.vendedor_nombre ? `<dt>Vendedor</dt><dd>${this.esc(doc.vendedor_nombre)}</dd>` : ''}
    ${doc.referencia ? `<dt>Referencia</dt><dd>${this.esc(doc.referencia)}</dd>` : ''}
    ${doc.doc_origen ? `<dt>Pedido origen</dt><dd>${this.esc(doc.doc_origen)}</dd>` : ''}
    <dt>Vencimiento</dt><dd>${this.fechaLarga(doc.vencimiento)}${doc.dias_credito ? ` (${doc.dias_credito} días)` : ''}</dd>
  </dl></div>
</div>

<div class="sec-h"><h2>¿Qué compraste?</h2>
  <span>${L.length} producto${L.length === 1 ? '' : 's'}, en orden alfabético · precios finales (IEPS incluido · IVA 0%)</span></div>
<table class="det">
  <colgroup><col class="c-prod"><col class="c-cant"><col class="c-pu"><col class="c-pd"><col class="c-imp"><col class="c-desc"><col class="c-neto"></colgroup>
  <thead><tr><th class="l">Producto</th><th class="l">Cantidad</th><th>Precio de lista</th>
    <th class="hl">Precio con descuento</th><th>Importe</th><th>Desc. ${pct}%</th><th>Neto</th></tr></thead>
  <tbody>${filas}</tbody>
</table>

<div class="foot-grid">
  <div class="letra">
    <div class="cl">Importe con letra</div>
    <div class="cv">${this.conLetra(Number(doc.total))}</div>
    ${ahorro > 0 ? `<div class="save-line">Ahorraste ${this.m(ahorro)} con tu ${pct}% de descuento.</div>
    <div class="save-note">En tu CFDI ese mismo ${pct}% se registra como descuento de ${this.m(doc.descuento)}, porque el SAT lo calcula sobre el precio sin IEPS. Pagas exactamente el mismo total.</div>` : ''}
  </div>
  <div class="tot">
    <div class="r"><span class="l">Importe (${L.length} productos)</span><span class="v">${this.m(doc.importe_bruto)}</span></div>
    ${ahorro > 0 ? `<div class="r saved"><span class="l">Descuento comercial · ${pct}%</span><span class="v">−${this.m(ahorro)}</span></div>` : ''}
    <div class="r memo"><span class="l">Incluye IEPS</span><span class="v">${this.m(doc.ieps)}</span></div>
    <div class="grand"><span class="l">Total a pagar</span><span class="v">${this.m(doc.total)}</span></div>
  </div>
</div>

<div class="admin">
  <div class="fiscal"><h4>Referencia fiscal</h4>
    <div class="cfdi-eq">Tu CFDI presenta el mismo total con el desglose que pide el SAT:<br>
      <b>Subtotal ${this.m(doc.subtotal)}</b> + <b>IEPS ${this.m(doc.ieps)}</b> − <b>Descuento ${this.m(doc.descuento)}</b> = <b>Total ${this.m(doc.total)}</b></div>
    <div class="small">Aquí los precios se muestran como los pagas (impuesto ya incluido); el CFDI los separa. El total es idéntico en ambos.</div>
  </div>
  <div class="pago"><h4>¿Dónde pagar?</h4>
    <div class="benef">Beneficiario: <b>${EMISOR.nombre.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())}</b> · RFC ${EMISOR.rfc} · Referencia de pago: <b>${this.esc(doc.cliente_code)}</b> (tu número de cliente)</div>
    <table class="ctas"><thead><tr><th style="width:22%">Banco</th><th style="width:26%">Cuenta</th><th>CLABE interbancaria</th></tr></thead>
      <tbody>${ctas}</tbody></table>
    <div class="nota">Al pagar, anota tu número de cliente como referencia y envía tu comprobante. Las transferencias entre bancos distintos se hacen con la CLABE.</div>
  </div>
</div>

<p class="disclaimer"><b>Este es un anexo informativo, no un comprobante fiscal.</b> El documento con validez fiscal es el CFDI timbrado por el SAT.
  Cantidades, unidades y precios provienen del sistema; la equivalencia paquete–caja usa el factor de empaque registrado en el catálogo.</p>
${opts.pagare ? this.pagare(doc) : ''}`;
  }

  /**
   * Pagaré (LGTOC art. 170) — presentado como ANEXO del mismo documento, con su membrete y
   * su jerarquía de sección, no como hoja suelta. Los 6 requisitos van explícitos: mención,
   * promesa incondicional + suma, beneficiario, época y lugar de pago, fecha y lugar de
   * suscripción, y espacio de firma. Sin firma autógrafa es sólo un formato: el título de
   * crédito es el PAPEL firmado.
   */
  private pagare(doc: any): string {
    const total = Number(doc.total);
    return `
<section class="hoja-pagare">
  <div class="head">
    ${this.logo() ? `<img class="logo" src="${this.logo()}" alt="Mega Dulces">` : '<div></div>'}
    <div class="emisor"><b>${EMISOR.nombre}</b>RFC: ${EMISOR.rfc}<br>Régimen ${EMISOR.regimen}</div>
  </div>
  <div class="rule"></div>
  <div class="pg-sec">
    <div><div class="sub">Anexo al detalle de pedido</div><h2>Pagaré</h2></div>
    <div class="ref">Factura<b>${this.esc(doc.sucursal)} ${this.esc(doc.doc_prefix)}-${this.esc(doc.folio)}</b></div>
  </div>
  <div class="pg-doc">
    <div class="pg-band">
      <div class="pg-bueno"><span>Bueno por</span><b>${this.m(total)}</b></div>
      <div class="pg-lugar"><span>Lugar y fecha de suscripción</span><b>${EMISOR.plazaCorta}, a ${this.fechaLarga(doc.fecha)}</b></div>
    </div>
    <p class="pg-cuerpo">Debo y pagaré incondicionalmente a la orden de <b>${EMISOR.nombre}</b>, en <b>${EMISOR.plaza}</b>,
      el día <b>${this.fechaLarga(doc.vencimiento)}</b>, la cantidad de <b>${this.m(total)}</b>
      <b>(${this.conLetra(total).toUpperCase()})</b>, valor recibido a mi entera satisfacción.</p>
    <p class="pg-cuerpo">Este pagaré causará <b>intereses moratorios a razón del ${MORATORIO_PCT}% mensual</b> a partir de la fecha de su
      vencimiento y hasta el día de su total liquidación, pagaderos en esta misma plaza junto con la suerte principal.</p>
    <div class="pg-grid">
      <div class="pg-col"><h5>Suscriptor (deudor)</h5><dl class="pg-kv">
        <dt>Nombre</dt><dd>${this.esc(doc.cliente_nombre)}</dd>
        <dt>RFC</dt><dd>${this.esc(doc.cliente_rfc || '—')}</dd>
        <dt>Domicilio</dt><dd>${this.esc([doc.cliente_domicilio, doc.cliente_colonia, doc.cliente_estado].filter(Boolean).join(', '))}</dd>
        <dt>Cliente</dt><dd>${this.esc(doc.cliente_code)}</dd>
      </dl></div>
      <div class="pg-col"><h5>Obligación que ampara</h5><dl class="pg-kv">
        <dt>Factura</dt><dd>${this.esc(doc.sucursal)} ${this.esc(doc.doc_prefix)}-${this.esc(doc.folio)}</dd>
        <dt>Fecha</dt><dd>${this.fechaLarga(doc.fecha)}</dd>
        <dt>Vencimiento</dt><dd>${this.fechaLarga(doc.vencimiento)}</dd>
        ${doc.dias_credito ? `<dt>Crédito</dt><dd>${doc.dias_credito} días</dd>` : ''}
        <dt>Importe</dt><dd>${this.m(total)}</dd>
      </dl></div>
    </div>
    <div class="pg-firma"><div class="linea"></div>
      <div class="rot">Firma del suscriptor</div><div class="rot2">${this.esc(doc.cliente_nombre)}</div></div>
  </div>
</section>`;
  }
}
