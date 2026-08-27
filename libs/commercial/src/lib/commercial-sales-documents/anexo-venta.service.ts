import { BadRequestException, Injectable } from '@nestjs/common';
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
    // Un anexo sólo tiene sentido si hay mercancía y el documento vive. Sin estas dos guardas
    // se imprimían dos documentos falsos (barrido 2026-08-24): 15 facturas CANCELADAS que
    // conservan sus renglones (mostraban $43,904 de producto con total $0) y 95 facturas cuyo
    // único renglón es de SERVICIO (tabla de productos vacía, total de hasta $439,527).
    if (doc.cancelada) {
      throw new BadRequestException(
        `La factura ${folioDigital} está cancelada en Kepler (estatus ${doc.doc_estatus}): no se emite anexo.`);
    }
    if (!doc.lineas?.length) {
      throw new BadRequestException(
        `La factura ${folioDigital} no tiene renglones de producto (sólo servicio): no hay detalle que anexar.`);
    }
    // 6 facturas traen el detalle incompleto en Kepler (renglones que empiezan en L7/L3/L5): las
    // columnas no pueden sumar el total del CFDI, que es justo lo que este anexo promete.
    if (doc.detalle_explica_total === false) {
      throw new BadRequestException(
        `El detalle de ${folioDigital} no suma el total del CFDI (renglones $${doc.importe_bruto} vs total $${doc.total}): `
        + 'el documento está incompleto en Kepler y no se emite anexo.');
    }
    // El pagaré va SIEMPRE (decisión Edgar 2026-08-22); `pagare:false` lo omite explícitamente.
    return this.renderPdf(this.html(doc, { pagare: opts.pagare !== false }), this.pie(doc));
  }

  // ── navegador COMPARTIDO ────────────────────────────────────────────────
  // Lanzar Chromium por petición costaba ~3-4 s de arranque cada vez (la queja real de
  // lentitud). Se reusa UNA instancia y cada render abre solo una page (~centenas de ms).
  // Contrapeso del OOM (ADR-043): un Chromium ocioso son ~100-150 MB, así que un timer lo
  // cierra tras 3 min sin uso; si crashea, `disconnected` limpia la promesa y el siguiente
  // render lo relanza.
  private static browserP: Promise<puppeteer.Browser> | null = null;
  private static idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_MS = 3 * 60 * 1000;

  private static async getBrowser(): Promise<puppeteer.Browser> {
    if (!AnexoVentaService.browserP) {
      AnexoVentaService.browserP = puppeteer
        .launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          ...(process.env.PUPPETEER_EXECUTABLE_PATH
            ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
            : {}),
        })
        .then((b) => {
          b.on('disconnected', () => { AnexoVentaService.browserP = null; });
          return b;
        })
        .catch((e) => { AnexoVentaService.browserP = null; throw e; });
    }
    return AnexoVentaService.browserP;
  }

  private static touchIdle(): void {
    if (AnexoVentaService.idleTimer) clearTimeout(AnexoVentaService.idleTimer);
    AnexoVentaService.idleTimer = setTimeout(() => {
      const p = AnexoVentaService.browserP;
      AnexoVentaService.browserP = null;
      p?.then((b) => b.close()).catch(() => undefined);
    }, AnexoVentaService.IDLE_MS);
    // no retener el proceso vivo solo por este timer
    (AnexoVentaService.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async renderPdf(html: string, footer: string): Promise<Buffer> {
    const browser = await AnexoVentaService.getBrowser();
    const page = await browser.newPage();
    try {
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
      await page.close().catch(() => undefined);
      AnexoVentaService.touchIdle();
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
  /**
   * Unidad VERBATIM de Kepler (regla 2026-08-24: cero unidades inventadas). El censo real trae
   * PAQ/PZA/KG/CJA pero también 500, 250, 2KG, CUB… — pluralizarlas o traducirlas fabricaba
   * unidades falsas ("500s", "cubs", "kilos"). Se muestra el código tal cual; si es puramente
   * numérico (una presentación como "500") se antepone "×" para que "15 500" no se lea 15,500.
   */
  private unidad(u: any): string {
    return this.esc(String(u ?? '').trim());
  }
  private cantidadConUnidad(cant: number, u: any): string {
    const cod = this.unidad(u);
    if (!cod) return String(cant);
    return /^\d+$/.test(cod) ? `${cant} × ${cod}` : `${cant} ${cod}`;
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
    // Tasa EFECTIVA del documento, no la del catálogo: 802 facturas traen 0% en `kdud.c17` y
    // sí tienen descuento real, y en 348 el total es mayor que la suma de líneas (ajuste a
    // favor del cliente) → el signo puede ser negativo.
    const pct = Number(doc.descuento_pct_efectivo ?? doc.descuento_pct) || 0;
    const ahorro = Number(doc.importe_bruto) - Number(doc.total);
    const pctTxt = Number.isInteger(pct) ? String(pct) : pct.toFixed(2);
    const colDesc = ahorro >= 0 ? `Desc. ${pctTxt}%` : 'Ajuste';
    // 4,973 de 5,128 facturas no traen descuento: sin esto la tabla imprimía "Desc. 0%", una
    // columna entera de "−$0.00" y dos columnas de precio idénticas. Si no hay descuento, las
    // tres columnas del descuento no existen y el importe es el neto.
    const conDesc = Math.abs(ahorro) > 0.005;

    const filasArr = L.map((l: any) => {
      const cant = Number(l.cantidad);
      // Unidades TAL CUAL vienen de Kepler: la de línea (kdm2.c11) y el bulto del catálogo
      // (kdii.c83). El service ya validó el factor (null si la línea no se vendió en la
      // unidad del catálogo), así que aquí solo se rotula, nunca se traduce.
      const importe = Number(l.importe) || 0;
      const tasa = importe > 0 ? (Number(l.descuento) || 0) / importe : 0; // tasa efectiva de la línea
      // Factores de Kepler (contra la base pieza): box_factor=c84 piezas/caja · factor_paq=c81 piezas/paquete.
      const cjaF = Number(l.box_factor) || 0;
      const paqF = Number(l.factor_paq) || 0;
      const bultoU = this.unidad(l.unidad_bulto);
      const paqUu = this.unidad(l.unidad_paq);
      const baseU = this.unidad(l.unidad_venta) || this.unidad(l.unidad) || 'pza';
      const cajaOK = cjaF > 1 && !!l.unidad_bulto && !l.box_factor_dudoso;
      const paqOK = paqF > 1 && !!l.unidad_paq && String(l.unidad_paq) !== String(l.unidad_bulto);
      // Normaliza la cantidad VENDIDA a piezas (según la unidad de venta) para poder desglosarla en
      // caja/paquete/pieza AUNQUE se haya vendido en paquetes (así el cliente no divide a mano).
      const soldU = String(l.unidad || '');
      let soldFactor = 1;
      if (paqOK && soldU === String(l.unidad_paq)) soldFactor = paqF;
      else if (cajaOK && soldU === String(l.unidad_bulto)) soldFactor = cjaF;
      const qtyPz = cant * soldFactor;
      const precioPza = soldFactor > 0 ? (Number(l.precio_unitario) || 0) / soldFactor : 0;
      // Grupo real de la línea (caja 0 / paquete 1 / pieza 2). Se fija MÁS ABAJO, tras armar la
      // descomposición, porque depende de la unidad MAYOR que se muestra, no de la de venta.
      let tier = 2;

      // Niveles de UNIDAD disponibles (mayor → menor), para el precio POR unidad.
      const unitLevels: { u: any; factor: number }[] = [];
      if (cajaOK) unitLevels.push({ u: l.unidad_bulto, factor: cjaF });
      if (paqOK) unitLevels.push({ u: l.unidad_paq, factor: paqF });
      unitLevels.push({ u: l.unidad_venta || l.unidad, factor: 1 }); // pieza (la base)

      // LO COMPRADO, SEPARADO en caja + paquete + pieza (descomposición euclidiana): cuando la
      // compra abarca varias unidades se muestra "3 CJA + 5 PAQ + 2 PZA" en vez de puras piezas.
      // Son partes ADITIVAS (no equivalencias) → los remanentes llevan "+".
      const compra: { n: number; u: any }[] = [];
      let restoPz = qtyPz;
      for (const lvl of unitLevels) {
        const n = Math.floor(restoPz / lvl.factor);
        restoPz -= n * lvl.factor;
        if (n > 0) compra.push({ n, u: lvl.u });
      }
      if (!compra.length) compra.push({ n: qtyPz, u: l.unidad_venta || l.unidad });

      // El grupo se decide por la unidad MAYOR que realmente se MUESTRA (compra[0]), no por la
      // unidad de venta de Kepler (kdm2.c11): casi todo se factura en PAQ pero el anexo lo muestra
      // convertido a CJA, así que agrupar por c11 dejaba TODO en "pieza" y no salía separación.
      const primaU = String(compra[0]?.u ?? '').trim().toUpperCase();
      tier = /^(CJA|CJ|CAJA|CJS)$/.test(primaU) ? 0 : /^(PAQ|PQ|PAQUETE)$/.test(primaU) ? 1 : 2;

      // Cantidad: el mayor en grande, cada remanente debajo con "+" (se lee como suma).
      const qCell = compra.map((r, i) =>
        `<span class="${i === 0 ? 'q-main' : 'q-eq2'}">${i === 0 ? '' : '+ '}${this.cantidadConUnidad(r.n, r.u)}</span>`).join('');
      // Precio POR cada unidad disponible (caja > paquete > pieza), alineado a su unidad.
      const priceLadder = (withDesc: boolean) => unitLevels.map((lvl, i) => {
        const p = precioPza * lvl.factor;
        return `<span class="${i === 0 ? 'pu' : 'pu2'}${withDesc ? ' pd' : ''}">${this.m(withDesc ? p * (1 - tasa) : p)}</span>`
          + `<span class="pl">por ${this.unidad(lvl.u) || 'unidad'}</span>`;
      }).join('');

      // Apartado pequeño: cuánto equivale cada unidad (1 caja = N paquetes · 1 paquete = M piezas).
      const equiv: string[] = [];
      if (cajaOK && paqOK && cjaF % paqF === 0) equiv.push(`1 ${bultoU} = ${cjaF / paqF} ${paqUu}`);
      if (paqOK) equiv.push(`1 ${paqUu} = ${paqF} ${baseU}`);
      else if (cajaOK) equiv.push(`1 ${bultoU} = ${cjaF} ${baseU}`);
      const equivHtml = equiv.length ? `<div class="p-equiv">${equiv.join(' · ')}</div>` : '';

      const colsDesc = conDesc ? `
        <td class="u-price c-hl">${priceLadder(true)}</td>
        <td class="imp">${this.m(l.importe)}</td>
        <td class="desc">${Number(l.descuento) < 0 ? '+' : '−'}${this.m(Math.abs(Number(l.descuento)))}</td>
        <td class="neto">${this.m(l.neto)}</td>`
        : `<td class="neto">${this.m(l.importe)}</td>`;
      return { tier, html: `<tr>
        <td><div class="p-name">${this.esc(l.descripcion)}</div><div class="p-sku">SKU ${this.esc(l.sku)}</div>${equivHtml}</td>
        <td class="qcell">${qCell}</td>
        <td class="u-price">${priceLadder(false)}</td>
        ${colsDesc}
      </tr>` };
    });

    // Agrupar las líneas por la unidad en que se compraron (caja → paquete → pieza). Solo se
    // rotula por grupos cuando la factura mezcla unidades; si todo se vendió igual, no estorba.
    const NCOLS = conDesc ? 7 : 4;
    const GRUPOS = [
      { t: 0, label: 'Comprado por caja' },
      { t: 1, label: 'Comprado por paquete' },
      { t: 2, label: 'Comprado por pieza / unidad suelta' },
    ];
    const mezcla = new Set(filasArr.map((f) => f.tier)).size > 1;
    const filas = mezcla
      ? GRUPOS.map((g) => {
          const rows = filasArr.filter((f) => f.tier === g.t);
          if (!rows.length) return '';
          return `<tr class="grp"><td colspan="${NCOLS}">${g.label} · ${rows.length} producto${rows.length === 1 ? '' : 's'}</td></tr>`
            + rows.map((r) => r.html).join('\n');
        }).filter(Boolean).join('\n')
      : filasArr.map((f) => f.html).join('\n');

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
table.det{border-collapse:collapse;width:100%;table-layout:fixed;font-size:9pt}
col.c-prod{width:22%}col.c-cant{width:14.5%}col.c-pu{width:13%}col.c-pd{width:14%}
col.c-imp{width:12%}col.c-desc{width:11.5%}col.c-neto{width:13%}
/* sin descuento son 4 columnas: el producto se queda con el espacio que sobra */
table.det.sin-desc col.c-prod{width:42%}table.det.sin-desc col.c-cant{width:21%}
table.det.sin-desc col.c-pu{width:19%}table.det.sin-desc col.c-neto{width:18%}
table.det thead{display:table-header-group}
table.det thead th{font-size:7.5pt;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700;
  text-align:right;padding:4px 6px;border-bottom:1.5px solid var(--ink)}
table.det thead th.l{text-align:left}
table.det tbody tr{break-inside:avoid}
table.det tbody td{padding:3px 6px;border-bottom:1px solid var(--line-2);vertical-align:top}
table.det tbody tr.grp td{padding:7px 8px 4px;font-size:7.5pt;font-weight:800;letter-spacing:.09em;
  text-transform:uppercase;color:var(--accent);background:var(--accent-soft);border-bottom:1.5px solid var(--accent);break-after:avoid}
.p-name{font-weight:700;font-size:9pt;line-height:1.2}
.p-sku{font-size:8pt;color:var(--muted);font-weight:600;margin-top:2px}
.p-equiv{font-size:7pt;color:var(--muted);font-style:italic;margin-top:2px;line-height:1.25}
.qcell{text-align:left}
.q-main{font-weight:700;display:block}
.q-eq{display:block;font-size:9pt;color:var(--accent);font-weight:700;margin-top:2px}
.q-eq2{display:block;font-size:8.5pt;color:var(--muted);margin-top:1px;line-height:1.3}
.u-price{text-align:right;line-height:1.18}
.pu{display:block;font-weight:700;font-size:9pt}
.pu2{display:block;font-weight:600;font-size:8pt;margin-top:1px}
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
/* El pagaré es UNA SECCIÓN MÁS del anexo (misma jerarquía que "¿Qué compraste?"), compacta.
   Sin membrete repetido y sin salto de página forzado: fluye tras los totales, y solo se
   mantiene ENTERA (break-inside) porque lleva firma. */
.hoja-pagare{margin-top:12px;break-inside:avoid;page-break-inside:avoid}
.pg-sec{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 5px;break-after:avoid}
.pg-sec h2{font-size:12.5pt;font-weight:700;margin:0}
.pg-sec .ref{font-size:9pt;color:var(--muted)}
.pg-sec .ref b{color:var(--ink);font-weight:700}
.pg-doc{border:1px solid var(--line);border-radius:4px;padding:10px 12px}
.pg-band{display:flex;gap:12px;margin:0 0 8px;align-items:stretch}
.pg-bueno{border:1.5px solid var(--ink);border-radius:3px;padding:5px 12px;min-width:44mm}
.pg-bueno span{display:block;font-size:7pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.pg-bueno b{font-size:14pt;font-weight:800}
.pg-lugar{flex:1;display:flex;flex-direction:column;justify-content:center}
.pg-lugar span{font-size:7pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.pg-lugar b{font-size:9pt;margin-top:1px}
.pg-cuerpo{font-size:9pt;line-height:1.45;text-align:justify;margin:7px 0}
.pg-grid{display:flex;gap:14px;margin-top:8px;padding-top:7px;border-top:1px solid var(--line)}
.pg-col{flex:1 1 0}
.pg-col h5{margin:0 0 4px;font-size:7pt;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:700}
.pg-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:8pt;margin:0;line-height:1.25}
.pg-kv dt{color:var(--muted);font-weight:600;white-space:nowrap}.pg-kv dd{margin:0;font-weight:600}
.pg-firma{margin:16px auto 2px;width:64mm;text-align:center}
.pg-firma .linea{border-bottom:1px solid var(--ink);height:1px}
.pg-firma .rot{font-size:7pt;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-top:4px}
.pg-firma .rot2{font-size:8.5pt;font-weight:700;margin-top:1px}
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
<table class="det${conDesc ? '' : ' sin-desc'}">
  <colgroup><col class="c-prod"><col class="c-cant"><col class="c-pu">${conDesc
    ? '<col class="c-pd"><col class="c-imp"><col class="c-desc"><col class="c-neto">'
    : '<col class="c-neto">'}</colgroup>
  <thead><tr><th class="l">Producto</th><th class="l">Cantidad</th><th>Precio${conDesc ? ' de lista' : ''}</th>
    ${conDesc
      ? `<th class="hl">Precio con descuento</th><th>Importe</th><th>${colDesc}</th><th>Neto</th>`
      : '<th>Importe</th>'}</tr></thead>
  <tbody>${filas}</tbody>
</table>

<div class="foot-grid">
  <div class="letra">
    <div class="cl">Importe con letra</div>
    <div class="cv">${this.conLetra(Number(doc.total))}</div>
    ${ahorro > 0 ? `<div class="save-line">Ahorraste ${this.m(ahorro)} en este pedido (${pctTxt}% sobre el importe de lista).</div>
    ${Number(doc.descuento) > 0 ? `<div class="save-note">En tu CFDI ese descuento se registra como ${this.m(doc.descuento)}, porque el SAT lo calcula sobre el precio sin IEPS. Pagas exactamente el mismo total.</div>` : ''}` : ''}
  </div>
  <div class="tot">
    ${conDesc ? `<div class="r"><span class="l">Importe (${L.length} productos)</span><span class="v">${this.m(doc.importe_bruto)}</span></div>` : ''}
    ${ahorro > 0 ? `<div class="r saved"><span class="l">Descuento comercial · ${pctTxt}%</span><span class="v">−${this.m(ahorro)}</span></div>` : ''}
    ${ahorro < 0 ? `<div class="r"><span class="l">Ajuste a tu favor</span><span class="v">+${this.m(Math.abs(ahorro))}</span></div>` : ''}
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
  Cantidades, unidades y precios provienen del sistema; las unidades y la equivalencia de bulto son las registradas en el catálogo del sistema.</p>
${opts.pagare ? this.pagare(doc) : ''}`;
  }

  /**
   * Pagaré (LGTOC art. 170) — sección COMPACTA del propio anexo (va en TODOS los documentos por
   * default; `pagare:false` la omite). Sin membrete repetido ni hoja aparte. Los 6 requisitos van explícitos: mención,
   * promesa incondicional + suma, beneficiario, época y lugar de pago, fecha y lugar de
   * suscripción, y espacio de firma. Sin firma autógrafa es sólo un formato: el título de
   * crédito es el PAPEL firmado.
   */
  private pagare(doc: any): string {
    const total = Number(doc.total);
    return `
<section class="hoja-pagare">
  <div class="pg-sec">
    <h2>Pagaré</h2>
    <div class="ref">Anexo de la factura <b>${this.esc(doc.sucursal)} ${this.esc(doc.doc_prefix)}-${this.esc(doc.folio)}</b></div>
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
