import * as fs from 'fs';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';

/**
 * `[GP.RF]` Lo que comparten los pasos de la auditoría: la sesión, el blindaje contra escrituras,
 * la espera a que la pantalla quede quieta y el contador de clics.
 */

/** El JWT de `MD_TOKEN_FILE` (vacío si no hay) y el rol que trae, sin imprimir nunca el token. */
export function sesion(): { token: string; rol: string | null; vence: string | null } {
  const archivo = process.env.MD_TOKEN_FILE;
  const token = archivo && fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8').trim() : '';
  if (!token) return { token: '', rol: null, vence: null };
  const carga = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  return {
    token,
    rol: carga.role_name ?? carga.rol ?? carga.role ?? null,
    vence: carga.exp ? new Date(carga.exp * 1000).toISOString() : null,
  };
}

/** Un contexto con la sesión puesta y el service worker bloqueado (sin eso una escritura se cuela). */
export async function contexto(browser: Browser, token: string, movil = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: movil ? { width: 390, height: 844 } : { width: 1366, height: 768 },
    serviceWorkers: 'block',
    ...(movil ? { hasTouch: true, isMobile: true } : {}),
  });
  await ctx.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* sin almacenamiento */ } }, token);
  return ctx;
}

/** Sólo GET sale a la API; todo lo demás (incluida la telemetría de uso) se aborta y se cuenta. */
export async function blindar(page: Page): Promise<{ abortadas: string[] }> {
  const abortadas: string[] = [];
  await page.route('**/api/**', (r) => {
    if (r.request().method() === 'GET') return r.continue();
    abortadas.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
    return r.abort('blockedbyclient');
  });
  return { abortadas };
}

/**
 * Espera a que la pantalla quede quieta: red en calma y sin «Cargando…» (hasta 15 s). Devuelve
 * los milisegundos y si SEGUÍA cargando —eso se declara, no se mide como pantalla de trabajo—.
 */
export async function quieta(page: Page, t0 = Date.now()): Promise<{ ms: number; seguia_cargando: boolean }> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  const seguia = await page.getByText(/Cargando/).first().waitFor({ state: 'hidden', timeout: 15_000 }).then(() => false, () => true);
  return { ms: Date.now() - t0, seguia_cargando: seguia };
}

/**
 * El contador de clics del recorrido. Cada clic dice QUÉ ES:
 *  - `navega`: sólo mueve entre pantallas (lo que una sola interfaz ahorraría);
 *  - `decide`: la persona elige algo que el sistema no puede saber;
 *  - `confirma`: repite una decisión ya tomada (el «¿seguro?»), o algo que el sistema ya sabía;
 *  - `abre`: despliega un detalle que no cabía.
 * Teclear se cuenta aparte (`teclea`), porque no es un clic pero sí trabajo.
 */
export type TipoClic = 'navega' | 'decide' | 'confirma' | 'abre';
export class Recorrido {
  readonly pasos: { n: number; tipo: TipoClic | 'teclea'; que: string; pantalla: string }[] = [];
  constructor(private readonly page: Page) {}
  private pantalla(): string { const u = new URL(this.page.url()); return u.pathname + u.search; }
  async clic(loc: Locator, tipo: TipoClic, que: string): Promise<void> {
    await loc.click();
    this.pasos.push({ n: this.pasos.length + 1, tipo, que, pantalla: this.pantalla() });
  }
  async teclea(loc: Locator, texto: string, que: string): Promise<void> {
    await loc.fill(texto);
    this.pasos.push({ n: this.pasos.length + 1, tipo: 'teclea', que, pantalla: this.pantalla() });
  }
  /** Clics desde el paso `desde` (exclusivo), por tipo. */
  cuenta(desde = 0): Record<TipoClic | 'teclea' | 'clics', number> {
    const r = { navega: 0, decide: 0, confirma: 0, abre: 0, teclea: 0, clics: 0 };
    for (const p of this.pasos.slice(desde)) { r[p.tipo]++; if (p.tipo !== 'teclea') r.clics++; }
    return r;
  }
}
