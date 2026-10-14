import type { Browser } from 'puppeteer';

/**
 * **Un solo Chromium para los PDF de la Suite** (infra leaf, cero deps de dominio).
 *
 * Nació en `libs/finance/shared` (`[GX.15]`), que ya advertía: «si alguna vez se comparte, sube a un lib común».
 * `[RH.3.3.3]` es ese momento — Recursos Humanos arma el CV del candidato en PDF —, así que sube acá y Finanzas lo
 * reexporta: una sola implementación, sin tocar a sus consumidores.
 *
 * ⬜ Deuda declarada (heredada de `[GX.15]`, sin cambios): `PaymentCalendarDocumentService` (finance) y
 * `AnexoVentaService` (commercial) conservan su propia copia del singleton; deben migrar a éste.
 *
 * ## Por qué singleton con temporizador de inactividad
 * Lanzar Chromium por request cuesta ~3–4 s; dejarlo ocioso cuesta ~100–150 MB. El singleton paga el arranque una vez
 * y el temporizador devuelve la memoria cuando nadie pide documentos (medido y decidido en TP.8).
 *
 * `puppeteer` se carga al PRIMER PDF, no al importar `platform-core`: el barril lo importa todo el backend y no tiene
 * por qué arrastrar el navegador a quien nunca genera un documento.
 */

let browserP: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 3 * 60 * 1000;

async function getBrowser(): Promise<Browser> {
  if (!browserP) {
    browserP = import('puppeteer')
      .then((puppeteer) => puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        ...(process.env['PUPPETEER_EXECUTABLE_PATH'] ? { executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] } : {}),
      }))
      // Si el proceso muere por su cuenta, la promesa cacheada quedaría apuntando a un navegador cerrado y TODOS los PDF
      // siguientes fallarían hasta reiniciar la API.
      .then((b) => { b.on('disconnected', () => { browserP = null; }); return b; })
      .catch((e: unknown) => { browserP = null; throw e; });
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
  /** Márgenes de la página. Por omisión, los de los documentos de Finanzas. */
  margin?: { top: string; bottom: string; left: string; right: string };
}

/** Convierte HTML en un PDF. El HTML tiene que venir ya escapado por quien lo arma (ver `esc`). */
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
      margin: opts.margin ?? { top: '10mm', bottom: '12mm', left: '9mm', right: '9mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
    touchIdle();
  }
}

/** Escapa texto para meterlo en HTML. **Todo** lo que viene de afuera (la base, un candidato) pasa por acá. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Dinero en pesos, con separador de miles y dos decimales. */
export function money(n: unknown): string {
  return '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
