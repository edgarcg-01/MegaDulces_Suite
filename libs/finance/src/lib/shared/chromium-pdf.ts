import * as puppeteer from 'puppeteer';

/**
 * `[GX.15]` — **Un solo Chromium para los PDF de `libs/finance`.**
 *
 * Al escribir el PDF del expediente de gasto me encontré con que el mecanismo ya existía
 * **dos veces**: `AnexoVentaService` (Fase AX, en `libs/commercial`) y
 * `PaymentCalendarDocumentService` (Fase TP.8, en `libs/finance`) tienen cada uno su
 * singleton de Chromium con idle timer, escrito a mano, idéntico salvo el nombre de la
 * clase. Hacer una tercera copia es exactamente lo que ADR-056 midió ocho veces.
 *
 * Así que el mecanismo sube acá y el que lo estrena lo usa. ⬜ **Deuda declarada con
 * nombre:** `PaymentCalendarDocumentService` sigue con su copia y debe migrar a este
 * helper. No se migró en esta fase a propósito — es un servicio que ya está en prod
 * generando documentos de autorización, y cambiarle el motor del navegador en el mismo
 * commit que estrena una fase mezcla dos riesgos que conviene separar.
 * (`AnexoVentaService` vive en `libs/commercial`: esa frontera ya se declaró y no se
 * cruza — si alguna vez se comparte, sube a un lib común, no de finance a commercial.)
 *
 * ## Por qué singleton con temporizador de inactividad
 * Lanzar Chromium por request cuesta ~3–4 s; dejarlo ocioso cuesta ~100–150 MB. El
 * singleton paga el arranque una vez y el temporizador devuelve la memoria cuando nadie
 * pide documentos. Medido y decidido en TP.8; acá sólo se conserva.
 */

let browserP: Promise<puppeteer.Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 3 * 60 * 1000;

async function getBrowser(): Promise<puppeteer.Browser> {
  if (!browserP) {
    browserP = puppeteer
      .launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
      })
      // Si el proceso muere por su cuenta, la promesa cacheada quedaría apuntando a un
      // navegador cerrado y TODOS los PDF siguientes fallarían hasta reiniciar la API.
      .then((b) => { b.on('disconnected', () => { browserP = null; }); return b; })
      .catch((e) => { browserP = null; throw e; });
  }
  return browserP;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const p = browserP;
    browserP = null;
    p?.then((b) => b.close()).catch(() => undefined);
  }, IDLE_MS);
  // `unref` para que este temporizador no impida que el proceso termine.
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

export interface PdfOpts {
  /** Plantilla del pie de página (HTML de puppeteer). */
  footer?: string;
  format?: 'Letter' | 'A4';
  landscape?: boolean;
}

/** Convierte HTML en un PDF. El HTML tiene que venir ya escapado por quien lo arma. */
export async function htmlAPdf(html: string, opts: PdfOpts = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    const pdf = await page.pdf({
      format: opts.format ?? 'Letter',
      landscape: opts.landscape ?? false,
      printBackground: true,
      displayHeaderFooter: !!opts.footer,
      headerTemplate: '<span></span>',
      footerTemplate: opts.footer ?? '<span></span>',
      margin: { top: '10mm', bottom: '12mm', left: '9mm', right: '9mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
    touchIdle();
  }
}

/**
 * Escapa texto para meterlo en HTML. **Todo** lo que venga de la base pasa por acá: el
 * concepto y el beneficiario son texto capturado a mano en Kepler y pueden traer `<`.
 */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Dinero en pesos, con separador de miles y dos decimales. */
export function money(n: unknown): string {
  return '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
