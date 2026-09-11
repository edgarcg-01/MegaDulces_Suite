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
 * AX.9 — el anexo dejó de AFIRMAR el desglose del CFDI. Imprimía "Tu CFDI presenta:
 * Subtotal + IEPS − Descuento = Total" con `subtotal` (un despeje: `total − ieps + descuento`)
 * y `descuento` (`kdm1.c13`). Era cierto por álgebra —el despeje se construye del total— pero
 * nadie lo contrastó nunca contra un CFDI emitido, y no se puede: `fiscal.cfdis` tiene 167,503
 * filas y **todas son `rol='recibidas'`**, cero emitidos. Encima ninguno de los dos cuadra con
 * los renglones impresos: el subtotal coincide con Σrenglones en 238 de 1,268, y `c13` no es
 * lo que se descontó (985 de 1,268). Ahora el bloque dice sólo lo medido —los precios son
 * finales, el IEPS ya va dentro (744/744 sin descuento: Σrenglones == total EXACTO, nunca
 * total − ieps)— y sobre el CFDI se limita a que ampara el mismo total.
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
/**
 * Etiquetas que el CP fiscal NO trae: la plaza de pago del pagaré. Sólo la del CP configurado
 * está validada contra el catálogo del SAT (36910 = GUA/023); para cualquier otro CP se imprime
 * el CP a secas en vez de inventarle un municipio.
 */
const PLAZA_POR_CP: Record<string, { larga: string; corta: string }> = {
  '36910': {
    larga: 'Santa Ana Pacueco, Pénjamo, Guanajuato, C.P. 36910',
    corta: 'Santa Ana Pacueco, Pénjamo, Gto.',
  },
};
/** Catálogo c_RegimenFiscal del SAT — sólo los que aplican a este emisor. */
const REGIMEN_LABEL: Record<string, string> = {
  '601': 'General de Ley Personas Morales',
  '612': 'Personas Físicas con Actividades Empresariales y Profesionales',
  '626': 'Régimen Simplificado de Confianza',
};
/** RFCs genéricos del SAT: NO son el RFC del cliente y no deben imprimirse como si lo fueran. */
const RFC_GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);
const MORATORIO_PCT = 3; // mensual, pactado expresamente (LGTOC 174: sin pacto no se cobra)

/** El emisor tal como se IMPRIME, derivado de `fiscal.issuer_config`. */
interface EmisorImpreso {
  nombre: string;
  rfc: string;
  regimen_code: string;
  regimen: string;
  cp: string;
  plaza: string;
  plazaCorta: string;
}

export interface AnexoOpts {
  pagare?: boolean;
  /** Alcance de sucursal YA resuelto (ver el controller). `null`/ausente = sin recorte. */
  warehouse_codes?: string[] | null;
}

@Injectable()
export class AnexoVentaService {
  private logoCache?: string;

  constructor(private readonly docs: CommercialSalesDocumentsService) {}

  async pdfDeFolio(folioDigital: string, opts: AnexoOpts = {}): Promise<Buffer> {
    // El PDF pasa por el MISMO recorte que la pantalla: si el documento no es de una
    // sucursal alcanzable, `detail` responde "no encontrado" y acá no se imprime nada.
    const doc = await this.docs.detail(folioDigital, { warehouse_codes: opts.warehouse_codes });
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
    // La identidad fiscal sale de `fiscal.issuer_config` (AX.10) — nunca de una constante.
    const emisor = this.emisorImpreso(await this.docs.emisorFiscal());
    // El pagaré va SIEMPRE (decisión Edgar 2026-08-22); `pagare:false` lo omite explícitamente.
    return this.renderPdf(this.html(doc, emisor, { pagare: opts.pagare !== false }), this.pie(doc));
  }

  /**
   * Rellena las etiquetas que el catálogo fiscal no trae (plaza, texto del régimen).
   *
   * El nombre se imprime **verbatim**. Antes se capitalizaba con `/\b\w+/g`, que en JS no
   * matchea letras acentuadas: `LUIS FRANCISCO LÓPEZ GUTIÉRREZ` salía impreso como
   * **"Luis Francisco LÓPez GutiÉRrez"** en el beneficiario de TODOS los anexos. Y para un
   * beneficiario de pago lo correcto es la razón social tal como consta en el RFC, no una
   * versión bonita.
   */
  private emisorImpreso(e: { rfc: string; nombre: string; regimen_code: string; cp: string }): EmisorImpreso {
    const plaza = PLAZA_POR_CP[e.cp];
    const label = REGIMEN_LABEL[e.regimen_code];
    return {
      nombre: e.nombre,
      rfc: e.rfc,
      regimen_code: e.regimen_code,
      regimen: e.regimen_code + (label ? ` · ${label}` : ''),
      cp: e.cp,
      plaza: plaza?.larga || `C.P. ${e.cp}`,
      plazaCorta: plaza?.corta || `C.P. ${e.cp}`,
    };
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

  /**
   * HTML → PDF con el navegador COMPARTIDO de arriba. Es `public` a propósito: la Guía de
   * Cobranza (GT.2) imprime desde este mismo lib y lanzar su propio Chromium duplicaría los
   * ~150 MB que el idle-timer de acá existe para no pagar.
   */
  async renderPdf(html: string, footer: string): Promise<Buffer> {
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
        // AX.10: 12mm de lado eran 24mm de papel sin usar en una hoja de 215.9mm. A 9mm el
        // ancho útil pasa de 191.9 a 197.9mm (+3%) y sigue dentro del área imprimible de
        // cualquier láser/inyección (los que menos dan son ~6.4mm).
        margin: { top: '10mm', bottom: '12mm', left: '9mm', right: '9mm' },
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
      padding:0 9mm;display:flex;justify-content:space-between;align-items:center;">
      <span>${t}</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
  }

  /**
   * RFC del cliente para IMPRIMIR. 79.1% de las facturas imprimibles traen `XAXX010101000`
   * (el genérico del SAT para "público en general"): mostrarlo junto a un nombre propio hace
   * creer que ése es su RFC. Se rotula en vez de disfrazarse (ADR-056).
   */
  private rfcCliente(doc: any): { valor: string; generico: boolean } {
    const r = String(doc.cliente_rfc || '').trim().toUpperCase();
    if (!r) return { valor: '—', generico: false };
    return { valor: r, generico: RFC_GENERICOS.has(r) };
  }

  // ── documento ──────────────────────────────────────────────────────────
  private html(doc: any, EMISOR: EmisorImpreso, opts: AnexoOpts): string {
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

      // Cantidad: el mayor primero, cada remanente debajo con "+" (se lee como suma).
      const qCell = compra.map((r, i) =>
        `<span class="${i === 0 ? 'q-main' : 'q-eq2'}">${i === 0 ? '' : '+ '}${this.cantidadConUnidad(r.n, r.u)}</span>`).join('');
      // Precio POR cada unidad disponible (caja > paquete > pieza), UNA LÍNEA POR UNIDAD.
      // AX.10: la unidad iba en su propio renglón ("$495.00" / "por CJA"), así que un producto
      // con 3 niveles gastaba 6 líneas por columna y las dos columnas de precio se pagaban
      // dobles. Pegada al importe son 3 — la mitad del alto de la tabla en facturas largas.
      const priceLadder = (withDesc: boolean) => unitLevels.map((lvl, i) => {
        const p = precioPza * lvl.factor;
        return `<span class="pu${i === 0 ? '' : ' pu2'}${withDesc ? ' pd' : ''}">`
          + `${this.m(withDesc ? p * (1 - tasa) : p)}<i class="pl">/${this.unidad(lvl.u) || 'ud'}</i></span>`;
      }).join('');

      // Cuánto equivale cada unidad (1 caja = N paquetes · 1 paquete = M piezas). Va PEGADO al
      // SKU en el mismo renglón: eran dos líneas para dos datos cortos.
      const equiv: string[] = [];
      if (cajaOK && paqOK && cjaF % paqF === 0) equiv.push(`1 ${bultoU} = ${cjaF / paqF} ${paqUu}`);
      if (paqOK) equiv.push(`1 ${paqUu} = ${paqF} ${baseU}`);
      else if (cajaOK) equiv.push(`1 ${bultoU} = ${cjaF} ${baseU}`);
      const equivHtml = equiv.length ? `<i class="p-equiv">${equiv.join(' · ')}</i>` : '';

      const colsDesc = conDesc ? `
        <td class="u-price c-hl">${priceLadder(true)}</td>
        <td class="imp">${this.m(l.importe)}</td>
        <td class="desc">${Number(l.descuento) < 0 ? '+' : '−'}${this.m(Math.abs(Number(l.descuento)))}</td>
        <td class="neto">${this.m(l.neto)}</td>`
        : `<td class="neto">${this.m(l.importe)}</td>`;
      return { tier, html: `<tr>
        <td><div class="p-name">${this.esc(l.descripcion)}</div><div class="p-sku">${this.esc(l.sku)}${equivHtml}</div></td>
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
    // Los rótulos de grupo existen para ORGANIZAR una lista larga. En una factura corta cuestan
    // ~20 px cada uno —hasta 40 px, media docena de renglones— para decir algo que la columna
    // Cantidad ya dice en cada línea ("3 CJA", "48 KG"). Se rotula desde 10 productos.
    const mezcla = new Set(filasArr.map((f) => f.tier)).size > 1 && filasArr.length >= 10;
    const filas = mezcla
      ? GRUPOS.map((g) => {
          const rows = filasArr.filter((f) => f.tier === g.t);
          if (!rows.length) return '';
          return `<tr class="grp"><td colspan="${NCOLS}">${g.label} · ${rows.length} producto${rows.length === 1 ? '' : 's'}</td></tr>`
            + rows.map((r) => r.html).join('\n');
        }).filter(Boolean).join('\n')
      : filasArr.map((f) => f.html).join('\n');

    const ctas = CUENTAS.map((c) => `<tr><td class="bco">${c.banco}</td><td>${c.cuenta}</td><td class="clabe">${c.clabe}</td></tr>`).join('');
    const rfc = this.rfcCliente(doc);

    return `<meta charset="utf-8"><title>Detalle de Pedido</title>
<style>
:root{--ink:#1b1b1b;--ink-2:#454545;--muted:#5f5f5f;--line:#c9c9c9;--line-2:#e2e2e2;--soft:#f5f5f3;
  --accent:#8a3c06;--accent-soft:#fbf1e6;--save:#155e35}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;padding:0;background:#fff;color:var(--ink);font-family:"Segoe UI",Arial,Helvetica,sans-serif;font-size:10.5pt;line-height:1.25}
/* El logo manda en el membrete: es la marca del documento que se le entrega al cliente. 62 px
   es GRATIS en alto — el bloque del emisor (razón social + RFC/régimen/plaza + folio) ya hace
   esta fila de ~72 px, así que el logo cabe dentro sin empujar nada. */
.head{display:flex;justify-content:space-between;align-items:center;gap:16px}
.logo{height:62px;width:auto;flex:0 0 auto}
.hd-title{flex:1 1 auto}
.hd-title .sub{font-size:7pt;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);font-weight:700}
.hd-title h1{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:15pt;margin:0;line-height:1.05}
.emisor{text-align:right;font-size:7.5pt;color:var(--ink-2);line-height:1.3;flex:0 0 auto;max-width:104mm}
.emisor b{display:block;color:var(--ink);font-size:9pt;font-weight:700;margin-bottom:0}
.emisor .fl{font-size:7pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.emisor .fv{font-size:10.5pt;font-weight:700;color:var(--ink)}
.rule{height:2px;background:var(--accent);margin:4px 0 0}
.nofiscal{display:flex;align-items:center;gap:8px;margin-top:5px;padding:2px 9px;background:var(--accent-soft);
  border:1.5px solid var(--accent);border-radius:4px;color:#6d2f04;font-size:7.5pt;font-weight:600;line-height:1.25;break-inside:avoid}
.nofiscal .badge{flex:0 0 auto;font-size:7pt;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  background:var(--accent);color:#fff;padding:2px 7px;border-radius:3px}
.info{display:flex;gap:8px;margin-top:7px}
.box{flex:1 1 0;background:var(--soft);border:1px solid var(--line-2);border-radius:4px;padding:4px 8px;break-inside:avoid}
/* La caja del cliente carga el domicilio, que es el único texto largo de la tira: con las tres
   cajas iguales se partía en 3 renglones y fijaba el alto de la fila entera, mientras las otras
   dos (fechas, tipo de documento) desperdiciaban su ancho. */
.info>.box:first-child{flex:1.45 1 0}
.box h4{margin:0 0 2px;font-size:7pt;letter-spacing:.11em;text-transform:uppercase;color:var(--accent);font-weight:700}
.kv{display:grid;grid-template-columns:auto 1fr;gap:0 9px;font-size:8pt;margin:0;line-height:1.18}
.kv dt{color:var(--muted);font-weight:600;white-space:nowrap}
.kv dd{margin:0;text-align:right;font-weight:600}
.kv dd i{font-style:normal;font-weight:600;color:var(--muted);font-size:7pt}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:6px 0 3px;break-after:avoid}
.sec-h h2{font-size:11pt;font-weight:700;margin:0}
.sec-h span{font-size:8pt;color:var(--muted)}
/* Anchos DIMENSIONADOS CON EL DATO, no a ojo: medidos sobre los 14,872 renglones de 90 días,
   la cifra más larga es $49,750.20 en precio por caja (15 caracteres con la unidad pegada ≈ 90px
   a 8.5pt) y $36,810.00 en importe (≈ 65px); el nombre de producto llega a 70 caracteres y su
   p95 es 41. Así que el dinero se queda con lo que mide su peor caso más un margen, y todo el
   resto va al nombre — que con el 22% original se partía en dos renglones constantemente, y cada
   partición era una línea de alto pagada en TODAS las facturas. */
table.det{border-collapse:collapse;width:100%;table-layout:fixed;font-size:8.5pt}
col.c-prod{width:38.5%}col.c-cant{width:8%}col.c-pu{width:12.5%}col.c-pd{width:12.5%}
col.c-imp{width:9.5%}col.c-desc{width:9%}col.c-neto{width:10%}
/* sin descuento son 4 columnas: todo el sobrante va al nombre del producto */
table.det.sin-desc col.c-prod{width:60%}table.det.sin-desc col.c-cant{width:11%}
table.det.sin-desc col.c-pu{width:14.5%}table.det.sin-desc col.c-neto{width:14.5%}
table.det thead{display:table-header-group}
table.det thead th{font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;
  text-align:right;padding:3px 5px;border-bottom:1.5px solid var(--ink)}
table.det thead th.l{text-align:left}
table.det tbody tr{break-inside:avoid}
table.det tbody td{padding:2px 5px;border-bottom:1px solid var(--line-2);vertical-align:top}
table.det tbody tr.grp td{padding:4px 7px 3px;font-size:7pt;font-weight:800;letter-spacing:.09em;
  text-transform:uppercase;color:var(--accent);background:var(--accent-soft);border-bottom:1.5px solid var(--accent);break-after:avoid}
.p-name{font-weight:700;font-size:8.5pt;line-height:1.18}
.p-sku{font-size:7pt;color:var(--muted);font-weight:600;margin-top:1px;line-height:1.2}
.p-sku:before{content:'SKU '}
.p-equiv{font-style:italic;margin-left:6px}
.qcell{text-align:left}
.q-main{font-weight:700;display:block;white-space:nowrap}
.q-eq2{display:block;font-size:7.5pt;color:var(--muted);margin-top:0;line-height:1.2;white-space:nowrap}
.u-price{text-align:right;line-height:1.2}
.pu{display:block;font-weight:700;font-size:8.5pt;white-space:nowrap}
.pu2{font-weight:600;font-size:7.5pt}
.pl{font-style:normal;font-size:6.5pt;color:var(--muted);margin-left:2px}
.c-hl{background:#f2f7f3}.pd{color:var(--save)}th.hl{color:var(--save)}
td.imp,td.desc,td.neto{text-align:right;white-space:nowrap}
td.imp{font-weight:600}td.desc{color:var(--save);font-weight:700}td.neto{font-weight:700}
.cierre{display:flex;gap:9px;margin-top:7px;align-items:flex-start;break-inside:avoid}
.cierre>.pago{flex:1.25 1 0}.cierre>.tot{flex:1 1 0}
.tot{border:1px solid var(--line);border-radius:4px;overflow:hidden}
.letra-in{padding:4px 11px;font-size:8pt;font-weight:700;line-height:1.25;border-top:1px solid var(--line-2)}
.save-in{padding:3px 11px 4px;font-size:7.5pt;font-weight:700;color:var(--save);line-height:1.25;background:var(--soft)}
.tot .r{display:flex;justify-content:space-between;gap:10px;padding:4px 11px;font-size:9pt;border-bottom:1px solid var(--line-2)}
.tot .r .l{color:var(--ink-2)}.tot .r .v{font-weight:700;text-align:right;white-space:nowrap}
.tot .r.saved .l,.tot .r.saved .v{color:var(--save);font-weight:700}
.tot .r.memo{background:var(--soft)}.tot .r.memo .l,.tot .r.memo .v{color:var(--muted);font-size:8.5pt;font-weight:600}
.tot .grand{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 11px;background:var(--accent-soft)}
.tot .grand .l{font-weight:800;color:#6d2f04;font-size:10pt}
.tot .grand .v{font-weight:800;color:#6d2f04;font-size:14pt;white-space:nowrap}
/* flex-start, no stretch: con stretch la caja de texto crecía hasta el alto de la tabla de
   bancos y dejaba un tercio de hoja en blanco. */
.pago{border:1.5px solid var(--accent);border-radius:4px;overflow:hidden;break-inside:avoid}
.pago h4{margin:0;padding:4px 10px;background:var(--accent);color:#fff;font-size:7.5pt;letter-spacing:.11em;text-transform:uppercase;font-weight:700}
.pago .benef{padding:4px 10px;background:var(--accent-soft);font-size:8pt;color:#6d2f04;border-bottom:1px solid var(--line-2);line-height:1.3}
table.ctas{border-collapse:collapse;width:100%;font-size:8.5pt}
table.ctas th{font-size:6.5pt;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700;
  text-align:left;padding:3px 10px;border-bottom:1px solid var(--line-2);background:var(--soft)}
table.ctas td{padding:3px 10px;border-bottom:1px solid var(--line-2);white-space:nowrap}
table.ctas tr:last-child td{border-bottom:0}
table.ctas .bco{font-weight:700}table.ctas .clabe{font-weight:700;letter-spacing:.03em}
.pago .nota{padding:3px 10px;font-size:7pt;color:var(--muted);background:var(--soft);border-top:1px solid var(--line-2);line-height:1.3}
.disclaimer{margin-top:4px;font-size:6.5pt;color:var(--ink-2);line-height:1.3;break-inside:avoid;text-align:justify}
.disclaimer b{color:var(--ink)}
/* El pagaré es UNA SECCIÓN MÁS del anexo (misma jerarquía que "¿Qué compraste?"), compacta.
   Sin membrete repetido y sin salto de página forzado: fluye tras los totales, y solo se
   mantiene ENTERA (break-inside) porque lleva firma. */
.hoja-pagare{margin-top:7px;break-inside:avoid;page-break-inside:avoid}
.pg-sec{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 3px;break-after:avoid}
.pg-sec h2{font-size:11pt;font-weight:700;margin:0}
.pg-sec .ref{font-size:8pt;color:var(--muted)}
.pg-sec .ref b{color:var(--ink);font-weight:700}
.pg-doc{border:1px solid var(--line);border-radius:4px;padding:6px 10px}
.pg-band{display:flex;gap:12px;margin:0 0 4px;align-items:stretch}
.pg-bueno{border:1.5px solid var(--ink);border-radius:3px;padding:3px 10px;min-width:42mm}
.pg-bueno span{display:block;font-size:6.5pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.pg-bueno b{font-size:12.5pt;font-weight:800}
.pg-lugar{flex:1;display:flex;flex-direction:column;justify-content:center}
.pg-lugar span{font-size:6.5pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.pg-lugar b{font-size:8.5pt;margin-top:1px}
.pg-cuerpo{font-size:8.5pt;line-height:1.32;text-align:justify;margin:3px 0}
.pg-grid{display:flex;gap:14px;margin-top:4px;padding-top:4px;border-top:1px solid var(--line)}
.pg-col{flex:1 1 0}
.pg-col h5{margin:0 0 2px;font-size:6.5pt;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:700}
.pg-kv{display:grid;grid-template-columns:auto 1fr;gap:0 9px;font-size:7.5pt;margin:0;line-height:1.18}
.pg-kv dt{color:var(--muted);font-weight:600;white-space:nowrap}.pg-kv dd{margin:0;font-weight:600}
.pg-acepto{margin-top:4px;padding-top:4px;border-top:1px solid var(--line)}
.pg-acepto h5{margin:0;font-size:7pt;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:800}
/* 8 mm de aire sobre la raya: espacio real para firmar a mano sin gastar media hoja. */
.pg-firmas{display:flex;gap:16px;justify-content:space-around;margin-top:7mm}
.pg-firma{flex:0 1 66mm;text-align:center}
.pg-firma .linea{border-bottom:1px solid var(--ink);height:1px}
.pg-firma .rot{font-size:7pt;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-top:4px}
.pg-firma .rot2{font-size:8.5pt;font-weight:700;margin-top:1px}
.pg-firma .rot2.vacio{color:var(--muted);font-weight:600}
</style>

<!-- Membrete y título en UNA fila. Eran dos bloques apilados (logo+emisor, luego título+folio)
     con una regla en medio: 82 px para cuatro datos que caben en 50. -->
<div class="head">
  ${this.logo() ? `<img class="logo" src="${this.logo()}" alt="Mega Dulces">` : ''}
  <div class="hd-title"><div class="sub">Anexo informativo al CFDI</div><h1>Detalle de tu pedido</h1></div>
  <!-- El régimen va por CÓDIGO (612), no con su descripción de 62 caracteres: envolvía dos
       renglones del membrete para repetir un dato del catálogo público del SAT que el propio
       CFDI ya trae desglosado. Este anexo es informativo. -->
  <div class="emisor"><b>${this.esc(EMISOR.nombre)}</b>RFC ${this.esc(EMISOR.rfc)} · Régimen ${this.esc(EMISOR.regimen_code)}
    · expedido en C.P. ${this.esc(EMISOR.cp)}, ${this.esc(EMISOR.plazaCorta)}
    <br><span class="fl">Folio</span> <b class="fv">${this.esc(doc.sucursal)} ${this.esc(doc.doc_prefix)} · ${this.esc(doc.folio)}</b></div>
</div>
<div class="rule"></div>

<div class="nofiscal"><span class="badge">Anexo</span>
  <span>Documento <b>informativo, sin validez fiscal</b>. Tu comprobante es el CFDI timbrado que se entrega junto a este detalle.</span></div>

<!-- Tres columnas, no dos: el alto de esta tira lo fijaba la columna MÁS LARGA, y "Datos del
     pedido" tenía 7 renglones contra 4 del cliente — 3 renglones de alto pagados en blanco al
     lado. Repartido en tres, la más larga tiene 4. -->
<div class="info">
  <div class="box"><h4>Cliente</h4><dl class="kv">
    <dt>Nombre</dt><dd>${this.esc(doc.cliente_nombre)}</dd>
    <dt>RFC</dt><dd>${this.esc(rfc.valor)}${rfc.generico ? ' <i>· público en general</i>' : ''}</dd>
    <dt>Domicilio</dt><dd>${this.esc([doc.cliente_domicilio, doc.cliente_colonia, doc.cliente_estado].filter(Boolean).join(', '))}</dd>
    <dt>Clave</dt><dd>${this.esc(doc.cliente_code)}</dd>
  </dl></div>
  <div class="box"><h4>Documento</h4><dl class="kv">
    <dt>Tipo</dt><dd>${this.esc(doc.doc_label)}</dd>
    <dt>Sucursal</dt><dd>${this.esc(doc.sucursal)}</dd>
    ${doc.vendedor_nombre ? `<dt>Vendedor</dt><dd>${this.esc(doc.vendedor_nombre)}</dd>` : ''}
    ${doc.doc_origen ? `<dt>Pedido origen</dt><dd>${this.esc(doc.doc_origen)}</dd>` : ''}
    ${doc.referencia ? `<dt>Referencia</dt><dd>${this.esc(doc.referencia)}</dd>` : ''}
  </dl></div>
  <div class="box"><h4>Fechas</h4><dl class="kv">
    <dt>Emisión</dt><dd>${this.fechaLarga(doc.fecha)}</dd>
    <dt>Vencimiento</dt><dd>${this.fechaLarga(doc.vencimiento)}</dd>
    ${doc.dias_credito ? `<dt>Crédito</dt><dd>${doc.dias_credito} días</dd>` : ''}
  </dl></div>
</div>

<div class="sec-h"><h2>¿Qué compraste?</h2>
  <span>${L.length} producto${L.length === 1 ? '' : 's, en orden alfabético'} · precios finales (IEPS incluido · IVA 0%)</span></div>
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

<!-- Un solo cierre en UNA fila: los totales a la derecha y las cuentas de pago a la izquierda.
     Antes eran dos filas apiladas (importe-con-letra + totales, y luego cómo-leer + bancos) que
     juntas medían 252 px, con la mitad de cada una en blanco. El importe con letra baja como
     pie del total, que es donde se lee (como en un cheque). -->
<div class="cierre">
  <div class="pago"><h4>¿Dónde pagar?</h4>
    <div class="benef">Beneficiario: <b>${this.esc(EMISOR.nombre)}</b> · RFC ${this.esc(EMISOR.rfc)}<br>
      Referencia: <b>${this.esc(doc.cliente_code)}</b> (tu número de cliente) — anótala y envía tu comprobante</div>
    <table class="ctas"><thead><tr><th>Banco</th><th>Cuenta</th><th>CLABE interbancaria</th></tr></thead>
      <tbody>${ctas}</tbody></table>
  </div>
  <div class="tot">
    ${conDesc ? `<div class="r"><span class="l">Importe (${L.length} productos)</span><span class="v">${this.m(doc.importe_bruto)}</span></div>` : ''}
    ${ahorro > 0 ? `<div class="r saved"><span class="l">Descuento comercial · ${pctTxt}%</span><span class="v">−${this.m(ahorro)}</span></div>` : ''}
    ${ahorro < 0 ? `<div class="r"><span class="l">Ajuste a tu favor</span><span class="v">+${this.m(Math.abs(ahorro))}</span></div>` : ''}
    <div class="r memo"><span class="l">Incluye IEPS</span><span class="v">${this.m(doc.ieps)}</span></div>
    <div class="grand"><span class="l">Total a pagar</span><span class="v">${this.m(doc.total)}</span></div>
    <div class="letra-in">${this.conLetra(Number(doc.total))}</div>
    ${ahorro > 0 ? `<div class="save-in">Ahorraste ${this.m(ahorro)} en este pedido (${pctTxt}% sobre el importe de lista)</div>` : ''}
  </div>
</div>

<!-- El aviso de "no es comprobante fiscal" ya va ARRIBA, en la banda con borde: repetirlo acá
     era decir dos veces lo mismo en la misma hoja. Queda sólo lo que no está en otro lado. -->
<p class="disclaimer"><b>Cómo leer estos importes.</b> Todos son <b>finales</b>: ya incluyen el IEPS
  (${this.m(doc.ieps)} en este documento) y llevan IVA 0%. Tu CFDI ampara el mismo total, con el desglose que
  pide el SAT (base, traslados y descuento por separado). Las unidades y la equivalencia de bulto son las
  registradas en el catálogo del sistema.</p>
${opts.pagare ? this.pagare(doc, EMISOR) : ''}`;
  }

  /**
   * Pagaré (LGTOC art. 170) — sección COMPACTA del propio anexo (va en TODOS los documentos por
   * default; `pagare:false` la omite). Sin membrete repetido ni hoja aparte. Los 6 requisitos van explícitos: mención,
   * promesa incondicional + suma, beneficiario, época y lugar de pago, fecha y lugar de
   * suscripción, y espacio de firma. Sin firma autógrafa es sólo un formato: el título de
   * crédito es el PAPEL firmado.
   */
  private pagare(doc: any, EMISOR: EmisorImpreso): string {
    const total = Number(doc.total);
    const rfc = this.rfcCliente(doc);
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
    <p class="pg-cuerpo">Debo y pagaré incondicionalmente a la orden de <b>${this.esc(EMISOR.nombre)}</b>, en <b>${this.esc(EMISOR.plaza)}</b>,
      el día <b>${this.fechaLarga(doc.vencimiento)}</b>, la cantidad de <b>${this.m(total)}</b>
      <b>(${this.conLetra(total).toUpperCase()})</b>, valor recibido a mi entera satisfacción.
      Este pagaré causará <b>intereses moratorios a razón del ${MORATORIO_PCT}% mensual</b> a partir de la fecha de su
      vencimiento y hasta el día de su total liquidación, pagaderos en esta misma plaza junto con la suerte principal.</p>
    <div class="pg-grid">
      <div class="pg-col"><h5>Suscriptor (deudor)</h5><dl class="pg-kv">
        <dt>Nombre</dt><dd>${this.esc(doc.cliente_nombre)}</dd>
        <!-- Sin RFC cuando el documento trae el GENÉRICO del SAT: en un título de crédito, un
             RFC que no es del deudor es peor que no ponerlo (no es requisito del art. 170).
             El deudor queda identificado por nombre, domicilio y número de cliente. -->
        ${rfc.generico ? '' : `<dt>RFC</dt><dd>${this.esc(rfc.valor)}</dd>`}
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
    <!-- Apartado ACEPTAMOS: es el bloque de aceptación del título. Va en plural porque el
         pagaré admite DOS firmantes — el suscriptor (deudor) y, si lo hay, el aval u obligado
         solidario (LGTOC 109-116: el aval responde igual que el avalado). La línea del aval va
         en blanco a propósito: se llena a mano cuando hay uno, y vacía no obliga a nadie. -->
    <div class="pg-acepto">
      <h5>Aceptamos</h5>
      <div class="pg-firmas">
        <div class="pg-firma"><div class="linea"></div>
          <div class="rot">Firma del suscriptor (deudor)</div>
          <div class="rot2">${this.esc(doc.cliente_nombre)}</div></div>
        <div class="pg-firma"><div class="linea"></div>
          <div class="rot">Aval u obligado solidario</div>
          <div class="rot2 vacio">Nombre y firma</div></div>
      </div>
    </div>
  </div>
</section>`;
  }
}
