import { test, expect, request, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Anexo CE — el proceso de entrada con caducidad, de punta a punta, SÓLO LECTURA (ver la config).
 *
 * Lo que se recorre, en el orden en que lo vive el almacenista:
 *   1. ¿A dónde aterriza al entrar?           (antes: la estación vieja que no pide fecha)
 *   2. El Andén: sucursales por recibir        (no se abre ningún vale: abrir escribe)
 *   3. Los vales de una sucursal               (la lista, sin abrir)
 *   4. Llegadas al andén                       (¿qué % de lo que llegó tiene caducidad?)
 *   5. Por fechar                              (la cola de lo que entró sin fecha)
 *   6. Políticas de caducidad                  (¿qué no caduca? ¿hay vida mínima?)
 *   7. Por vencer                              (¿cuánto tarda? ¿dice qué hacer?)
 *   8. La estación vieja                       (después de CE: redirige al Andén)
 *
 * Cada prueba deja captura en `.resultados/capturas/` y anota lo medido (`test.info().annotations`).
 * Lo que depende de que el anexo esté desplegado se detecta, no se supone: `GET .../policy/departments`
 * existe sólo con CE.
 */

const token = (() => {
  const f = process.env.MD_TOKEN_FILE;
  if (!f) return null;
  try { return readFileSync(f, 'utf8').replace(/^"|"$/g, '').trim(); } catch { return null; }
})();

test.skip(!token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión (la suite corre contra prod con un usuario real)');

interface Sesion { role_name?: string; username?: string; permissions?: Record<string, boolean>; exp?: number }
const sesion: Sesion = (() => {
  if (!token) return {};
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Sesion; } catch { return {}; }
})();
const esAdmin = ['admin', 'superadmin'].includes(String(sesion.role_name ?? '').toLowerCase());
const puede = (...claves: string[]) => esAdmin || claves.some((k) => sesion.permissions?.[k] === true);

const CAPTURAS = join(__dirname, '.resultados', 'capturas');
mkdirSync(CAPTURAS, { recursive: true });

let api: APIRequestContext;
/** `true` si el anexo CE está desplegado (su endpoint nuevo responde). `null` = no se pudo saber. */
let conCE: boolean | null = null;

test.beforeAll(async ({ baseURL }) => {
  if (sesion.exp && sesion.exp * 1000 < Date.now()) throw new Error('El JWT de MD_TOKEN_FILE ya venció: vuelve a copiarlo de una sesión abierta.');
  api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const h = await api.get('/api/health');
  const r = await api.get('/api/commercial/receiving/policy/departments');
  conCE = r.status() === 200 ? true : r.status() === 404 ? false : null;
  // eslint-disable-next-line no-console
  console.log(`  prod: ${h.status() === 200 ? JSON.stringify(await h.json()) : h.status()} · anexo CE: ${conCE === null ? `NO MEDIDO (${r.status()})` : conCE ? 'desplegado' : 'todavía no'} · usuario: ${sesion.username ?? '?'} (${sesion.role_name ?? '?'})`);
});
test.afterAll(async () => { await api?.dispose(); });

// ── La red de seguridad ─────────────────────────────────────────────────────────────────────────
interface Observado { abortadas: string[]; fallidas: string[]; erroresPagina: string[] }

async function abrir(page: Page, ruta: string): Promise<Observado> {
  const obs: Observado = { abortadas: [], fallidas: [], erroresPagina: [] };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const m = req.method();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
    if (/\/api\/telemetry\//.test(req.url())) return route.fulfill({ status: 204, body: '' });
    if (/\/socket\.io\//.test(req.url())) return route.continue();
    obs.abortadas.push(`${m} ${req.url()}`);
    return route.abort();
  });
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    if (r.status() >= 400 && r.status() !== 429) obs.fallidas.push(`${r.status()} ${r.request().method()} ${u}`);
  });
  page.on('pageerror', (e) => obs.erroresPagina.push(e.message));
  await page.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* */ } }, token);
  await page.goto(ruta);
  return obs;
}

function sinDanos(obs: Observado) {
  expect(obs.abortadas, 'la pantalla intentó escribir sólo por abrirla').toEqual([]);
  expect(obs.fallidas, 'respuestas 4xx/5xx de la API').toEqual([]);
  expect(obs.erroresPagina, 'errores de JavaScript en la página').toEqual([]);
}

const anotar = (tipo: string, descripcion: string) => {
  test.info().annotations.push({ type: tipo, description: descripcion });
  // eslint-disable-next-line no-console
  console.log(`    · ${tipo}: ${descripcion}`);
};
const capturar = (page: Page, nombre: string) => page.screenshot({ path: join(CAPTURAS, `${nombre}.png`), fullPage: true });

test.describe('Entrada con caducidad (Anexo CE)', () => {
  test('1 · a dónde aterriza al entrar', async ({ page }) => {
    const obs = await abrir(page, '/');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    const ruta = new URL(page.url()).pathname;
    anotar('aterrizaje', ruta);
    await capturar(page, '1-aterrizaje');
    if (puede('COMMERCIAL_INVENTORY_RECIBIR') && !esAdmin && conCE) {
      expect(ruta, '[CE.2.2] quien recibe aterriza en el Andén').toBe('/almacen/anden');
    }
    sinDanos(obs);
  });

  test('2–3 · el Andén: sucursales y los vales de una (sin abrir ninguno)', async ({ page }) => {
    test.skip(!puede('COMMERCIAL_INVENTORY_RECIBIR'), 'NO MEDIDO: el usuario no tiene COMMERCIAL_INVENTORY_RECIBIR');
    const obs = await abrir(page, '/almacen/anden');
    // La portada separa los dos trabajos: «Acomodar mercancía» y «Dar de alta caducidades».
    const alta = page.getByRole('button', { name: /Dar de alta caducidades/ });
    await expect(alta, 'portada del Andén').toBeVisible({ timeout: 30_000 });
    await capturar(page, '2a-anden-portada');
    const menu = page.waitForResponse((r) => /\/commercial\/receiving\/sessions\/erp-pending-branches/.test(r.url()), { timeout: 45_000 });
    const t0 = Date.now();
    await alta.click();
    expect((await menu).status(), 'GET erp-pending-branches').toBe(200);
    anotar('menú del Andén', `${Date.now() - t0} ms después de pedirlo`);
    const filas = page.locator('button.su-row:not([disabled])');
    await expect(filas.first(), 'al menos una sucursal por recibir').toBeVisible({ timeout: 30_000 });
    anotar('sucursales por recibir', String(await filas.count()));
    // Lo que la fila dice de la sucursal: el estándar exige NOMBRE, nunca «01»/«00».
    const codigo = (await page.locator('button.su-row .su-code').first().textContent())?.trim() ?? '';
    if (/^\d{2}$/.test(codigo)) anotar('⚠ hallazgo', `la fila de sucursal muestra el código «${codigo}» junto al nombre`);
    await capturar(page, '2-anden-sucursales');

    const vales = page.waitForResponse((r) => /\/commercial\/receiving\/sessions\/erp-pending(\?|$)/.test(r.url()), { timeout: 45_000 });
    await filas.first().click();
    const rv = await vales;
    expect(rv.status(), 'GET erp-pending').toBe(200);
    const lista = (await rv.json()) as unknown[];
    anotar('vales por recibir en la primera sucursal', String(lista.length));
    await page.waitForTimeout(500);
    await capturar(page, '3-anden-vales');
    sinDanos(obs);
  });

  test('4 · Llegadas al andén: cuánto de lo que llegó tiene caducidad', async ({ page }) => {
    test.skip(!puede('ALMACEN_LLEGADAS_VER'), 'NO MEDIDO: el usuario no tiene ALMACEN_LLEGADAS_VER (sin CE sólo lo ve el modo dios)');
    const llegadas = page.waitForResponse((r) => /\/commercial\/receiving\/sessions\/arrivals/.test(r.url()), { timeout: 60_000 });
    const obs = await abrir(page, '/almacen/inventory/llegadas');
    const t0 = Date.now();
    const r = await llegadas;
    expect(r.status(), 'GET arrivals').toBe(200);
    anotar('arrivals', `${Date.now() - t0} ms`);
    await expect(page.getByRole('heading', { name: 'Llegadas al andén' })).toBeVisible({ timeout: 30_000 });
    const kpis = (await page.locator('.ll-kpis').innerText().catch(() => '')).replace(/\s+/g, ' ');
    anotar('tablero', kpis.slice(0, 300));
    if (conCE) {
      const cob = (await page.locator('.ll-cob').innerText()).replace(/\s+/g, ' ');
      anotar('[CE.3.3] cobertura', cob);
      expect(cob, '[CE.3.3] la cifra de la fase arriba').toMatch(/%|ningún renglón/);
    }
    await capturar(page, '4-llegadas');
    sinDanos(obs);
  });

  test('5 · Por fechar: la cola de lo que entró sin fecha', async ({ page }) => {
    test.skip(!puede('COMMERCIAL_EXPIRY_CAPTURAR'), 'NO MEDIDO: el usuario no tiene COMMERCIAL_EXPIRY_CAPTURAR');
    const cola = page.waitForResponse((r) => /\/commercial\/receiving\/sessions\/pending-expiry/.test(r.url()), { timeout: 45_000 });
    const obs = await abrir(page, '/almacen/inventory/por-fechar');
    const r = await cola;
    expect(r.status(), 'GET pending-expiry').toBe(200);
    anotar('renglones por fechar', String(((await r.json()) as unknown[]).length));
    await page.waitForTimeout(800);
    await capturar(page, '5-por-fechar');
    sinDanos(obs);
  });

  test('6 · Políticas de caducidad: qué no caduca y qué vida mínima se exige', async ({ page }) => {
    test.skip(!puede('COMMERCIAL_INVENTORY_SUPERVISAR'), 'NO MEDIDO: las políticas sólo las ve COMMERCIAL_INVENTORY_SUPERVISAR');
    const obs = await abrir(page, '/almacen/inventory/recepcion');
    const boton = page.getByRole('button', { name: /Políticas/ });
    await expect(boton).toBeVisible({ timeout: 30_000 });
    const pol = page.waitForResponse((r) => /\/commercial\/receiving\/policy$/.test(r.url()) && r.request().method() === 'GET', { timeout: 30_000 });
    await boton.click();
    const r = await pol;
    expect(r.status(), 'GET policy').toBe(200);
    const filas = (await r.json()) as Array<{ category?: string | null; tracks_expiry?: boolean | null; min_shelf_life_days?: number | null }>;
    anotar('políticas', `${filas.length} · con vida mínima: ${filas.filter((p) => p.min_shelf_life_days != null).length} · «no caduca»: ${filas.filter((p) => p.tracks_expiry === false).length}`);
    if (conCE) {
      expect(filas.filter((p) => p.tracks_expiry === false).map((p) => p.category).sort(), '[CE.1.1] semilla').toEqual(
        expect.arrayContaining(['ARTICULOS DE FIESTAS', 'DESECHABLES']),
      );
    }
    await page.waitForTimeout(500);
    await capturar(page, '6-politicas');
    sinDanos(obs);
  });

  test('7 · Por vencer: cuánto tarda y si dice qué hacer', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!puede('COMMERCIAL_INVENTORY_VER'), 'NO MEDIDO: el usuario no tiene COMMERCIAL_INVENTORY_VER');
    const lista = page.waitForResponse((r) => /\/commercial\/inventory\/expiring/.test(r.url()) && r.request().method() === 'GET', { timeout: 100_000 });
    const obs = await abrir(page, '/almacen/inventory/expiring');
    const t0 = Date.now();
    const r = await lista;
    const ms = Date.now() - t0;
    expect(r.status(), 'GET expiring').toBe(200);
    const lotes = (await r.json()) as Array<{ dated_may_be_stale?: boolean | null }>;
    anotar('Por vencer', `${lotes.length} lotes en ${ms} ms${ms > 500 ? ' (⚠ más de 500 ms: deuda CE.1.5)' : ''}`);
    if (conCE) {
      anotar('[CE.1.4] pueden estar vendidos', String(lotes.filter((l) => l.dated_may_be_stale === true).length));
      await expect(page.getByRole('columnheader', { name: 'Qué hacer' }), '[CE.3.1] la columna de la acción').toBeVisible({ timeout: 60_000 });
    }
    await page.waitForTimeout(1_500);
    await capturar(page, '7-por-vencer');
    sinDanos(obs);
  });

  test('8 · la estación vieja de vales', async ({ page }) => {
    test.skip(!puede('COMMERCIAL_INVENTORY_RECIBIR'), 'NO MEDIDO: el usuario no tiene COMMERCIAL_INVENTORY_RECIBIR');
    const obs = await abrir(page, '/almacen/inventory/recepcion-sesiones');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    const ruta = new URL(page.url()).pathname;
    anotar('/recepcion-sesiones termina en', ruta);
    if (conCE) expect(ruta, '[CE.2.2] la estación vieja redirige al Andén').toBe('/almacen/anden');
    await capturar(page, '8-estacion-vieja');
    sinDanos(obs);
  });
});
