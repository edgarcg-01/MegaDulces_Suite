import type { Page, Request, Route } from '@playwright/test';

/**
 * `[GP.RF.35]` El blindaje de las mediciones de Surtir sobre el frontend de ESTE árbol.
 *
 * - Toda lectura (`GET /api/...`) se pide a PRODUCCIÓN desde Node (`desviar = true`): el frontend
 *   local nunca llega a su backend, que no es nuestro ni sabemos a qué base apunta.
 * - «Empezar a surtir» (`POST …/presale-picking/:id/start`) se contesta AQUÍ con `{}` sin llegar a
 *   ningún servidor, para poder abrir un pedido. Es idempotente para la misma persona en el servidor
 *   real, así que simularlo no cambia lo que la pantalla hace después.
 * - Cualquier otra escritura se aborta y se anota.
 * - Control: toda petición `/api` o `/socket.io` al origen local que el interceptor NO resolvió queda
 *   en `al_backend_local` (con `E2E_CONTROL_NEGATIVO=1` se deja una sin anotar a propósito).
 */
export const PROD = process.env.E2E_BASE_URL || 'https://megadulcessuite.com';
export const LOCAL = process.env.E2E_LOCAL_URL || '';
export const NEGATIVO = process.env.E2E_CONTROL_NEGATIVO === '1';
const START = /\/api\/warehouse\/presale-picking\/[^/]+\/start$/;

export type Registro = { lecturas: number; abortadas: string[]; simuladas: string[]; al_backend_local: string[] };

export async function interceptar(page: Page, desviar: boolean): Promise<Registro> {
  const reg: Registro = { lecturas: 0, abortadas: [], simuladas: [], al_backend_local: [] };
  // Las que resolvió el interceptor (abortadas, simuladas o pedidas a prod desde Node).
  const resueltas = new WeakSet<Request>();
  const manejar = async (r: Route) => {
    const req = r.request();
    // Prueba negativa del control (E2E_CONTROL_NEGATIVO=1): una lectura servida desde prod pero NO anotada debe salir en al_backend_local.
    if (!(NEGATIVO && new URL(req.url()).pathname.endsWith('/users/me/access'))) resueltas.add(req);
    const u = new URL(req.url());
    if (req.method() === 'POST' && START.test(u.pathname)) {
      reg.simuladas.push(`POST ${u.pathname}`);
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (req.method() !== 'GET') {
      reg.abortadas.push(`${req.method()} ${u.pathname}`);
      return r.abort('blockedbyclient');
    }
    reg.lecturas++;
    if (!desviar) return r.continue();
    try {
      const resp = await r.fetch({ url: PROD + u.pathname + u.search, headers: req.headers() });
      return await r.fulfill({ response: resp });
    } catch {
      return r.abort('failed').catch(() => undefined); // la página ya se cerró
    }
  };
  await page.route('**/api/**', manejar);
  await page.route('**/socket.io/**', (r) => { resueltas.add(r.request()); reg.abortadas.push(`WS ${new URL(r.request().url()).pathname}`); return r.abort('blockedbyclient'); });
  if (desviar) {
    // Se mira al TERMINAR: el evento «request» sale antes de que la ruta la atienda.
    const revisar = (q: Request) => {
      const u = new URL(q.url());
      if (!resueltas.has(q) && u.origin === new URL(LOCAL).origin && /^\/(api|socket\.io)\b/.test(u.pathname)) reg.al_backend_local.push(`${q.method()} ${u.pathname}`);
    };
    page.on('requestfinished', revisar);
    page.on('requestfailed', revisar);
  }
  return reg;
}

/**
 * El almacén con más pedidos de preventa para HOY (lectura de prod). Con superadmin no hay almacén
 * en la ficha y la pantalla abriría en «elige tu almacén», sin lista.
 */
export async function almacenConMasPedidos(browser: import('@playwright/test').Browser, token: string) {
  const ctx = await browser.newContext();
  const h = { Authorization: `Bearer ${token}` };
  const alms = (await (await ctx.request.get(`${PROD}/api/reparto/surtido/almacenes`, { headers: h })).json()) as Array<{ id: string; code: string; nombre: string }>;
  const bandeja = (await (await ctx.request.get(`${PROD}/api/warehouse/presale-picking`, { headers: h })).json()) as { data: Array<{ warehouse_id: string; bucket: string; state: string }> };
  await ctx.close();
  const n = new Map<string, number>();
  for (const p of bandeja.data ?? []) if (p.bucket === 'hoy' && p.state !== 'completo') n.set(p.warehouse_id, (n.get(p.warehouse_id) ?? 0) + 1);
  const elegido = [...alms].filter((a) => /^\d{2}$/.test(a.code)).sort((a, b) => (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0))[0];
  return { id: elegido?.id ?? '', nombre: elegido?.nombre ?? null, pedidos_hoy: elegido ? n.get(elegido.id) ?? 0 : 0 };
}
