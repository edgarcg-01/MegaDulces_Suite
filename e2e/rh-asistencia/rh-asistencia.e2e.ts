import { test, expect, request, type Page, type APIRequestContext, type Response } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * `[RH.1.7]` — e2e de RH › Asistencia (`/rh/asistencia`), contra prod.
 *
 * Lo que defiende, con su porqué:
 *   1. **La puerta**: el menú de RH lleva a Asistencia y a Reclutamiento. Reclutamiento no tuvo entrada
 *      hasta `[RH.2.3]` (f7f1b8be7): 2,894 candidatos en prod y 0 consultas en 30 días porque nadie
 *      llegaba a la pantalla.
 *   2. **Veracidad sin datos** (ley 0 del estándar): medido el 2026-11-11, prod tiene 0 plazas de
 *      checado (`hr.attendance_sites` vacía; el corte de asistencia no ha ocurrido) y la pantalla
 *      pintaba «0 personas» y «Nadie con irregularidades en lo que se ve»: afirma un resultado que
 *      nadie midió. Lo no medido se DECLARA, no se dibuja como cero.
 *   3. **Lo que pinta = lo que responde la API**: las plazas del selector, el nombre de la plaza y
 *      cuántas personas trae el reporte se cruzan contra la respuesta, no contra una cifra a mano.
 *   4. **Ninguna pestaña truena**: cada pestaña del marco carga sin un 4xx/5xx ni un error de página.
 *
 * ⛔ SÓLO LECTURA. Cualquier POST/PATCH/PUT/DELETE a la API se ABORTA y la prueba falla; la telemetría
 * de la app se contesta aquí (204) y no sale.
 */

const RUTA = '/rh/asistencia';
const API = '/api/hr/attendance';
const TZ = 'America/Mexico_City';

const token = (() => {
  const f = process.env.MD_TOKEN_FILE;
  if (!f) return null;
  try { return readFileSync(f, 'utf8').replace(/^"|"$/g, '').trim(); } catch { return null; }
})();

test.skip(!token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión (la suite corre contra prod con un usuario real)');

// ── Sesión: lo que el JWT dice que puede (snapshot para gatear la UI; el servidor relee en cada request) ──
interface Sesion { role_name?: string; permissions?: Record<string, boolean>; exp?: number }
const sesion: Sesion = (() => {
  if (!token) return {};
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Sesion; } catch { return {}; }
})();
const esAdmin = ['admin', 'superadmin'].includes(String(sesion.role_name ?? '').toLowerCase());
const puede = (...claves: string[]) => esAdmin || claves.some((k) => sesion.permissions?.[k] === true);

// ── Lo que responde la API ─────────────────────────────────────────────────────────────────────
interface Sitio { code: string; name: string; warehouse_code: string | null; is_active: boolean }
interface Reporte { personas: unknown[]; desde: string; hasta: string }

let api: APIRequestContext;
let activos: Sitio[] = [];

test.beforeAll(async ({ baseURL }) => {
  if (sesion.exp && sesion.exp * 1000 < Date.now()) throw new Error('El JWT de MD_TOKEN_FILE ya venció: vuelve a copiarlo de una sesión abierta.');
  api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const r = await api.get(`${API}/sites`);
  expect(r.status(), `GET ${API}/sites`).toBe(200);
  activos = ((await r.json()) as Sitio[]).filter((s) => s.is_active);
});
test.afterAll(async () => { await api?.dispose(); });

// ── Fechas como las cuenta la pantalla: la semana de nómina va de jueves a miércoles, hora de México ──
const hoyMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const sumar = (f: string, d: number) => {
  const x = new Date(`${f}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};
const juevesDe = (f: string) => sumar(f, -((new Date(`${f}T12:00:00Z`).getUTCDay() - 4 + 7) % 7));

// ── La red de seguridad y lo que se observa de la página ─────────────────────────────────────────
interface Observado { abortadas: string[]; fallidas: string[]; erroresPagina: string[]; reportes: Response[] }

async function abrir(page: Page, ruta = RUTA): Promise<Observado> {
  const obs: Observado = { abortadas: [], fallidas: [], erroresPagina: [], reportes: [] };
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
    // El limitador (429) no es «la API falla»: se anota aparte para no confundirlo con un defecto.
    if (r.status() >= 400 && r.status() !== 429) obs.fallidas.push(`${r.status()} ${r.request().method()} ${u}`);
    if (/\/hr\/attendance\/report(\?|$)/.test(u) && r.request().method() === 'GET') obs.reportes.push(r);
  });
  page.on('pageerror', (e) => obs.erroresPagina.push(e.message));
  await page.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* */ } }, token);
  const sitios = page.waitForResponse((r) => /\/hr\/attendance\/sites$/.test(r.url()) && r.request().method() === 'GET', { timeout: 30_000 });
  await page.goto(ruta);
  expect((await sitios).status(), 'la pantalla pide las plazas').toBe(200);
  return obs;
}

/** Al terminar cada prueba: nada se escribió, nada tronó. */
function sinDanos(obs: Observado) {
  expect(obs.abortadas, 'la pantalla intentó escribir sólo por abrirla').toEqual([]);
  expect(obs.fallidas, 'respuestas 4xx/5xx de la API').toEqual([]);
  expect(obs.erroresPagina, 'errores de JavaScript en la página').toEqual([]);
}

const reporte = (page: Page) => page.getByRole('region', { name: 'Reporte de asistencia' });

test.describe('RH › Asistencia', () => {
  test.beforeEach(() => {
    test.skip(!puede('HR_ATTENDANCE_VER', 'HR_ATTENDANCE_GESTIONAR'), 'NO MEDIDO: el usuario de MD_TOKEN_FILE no tiene HR_ATTENDANCE_VER');
  });

  test('el menú de RH lleva a Asistencia y a Reclutamiento', async ({ page }) => {
    const obs = await abrir(page);
    await expect(page.locator('a[href="/rh/asistencia"]').first(), 'entrada «Asistencia» del menú').toBeVisible({ timeout: 20_000 });
    if (!puede('HR_RECRUITMENT_VER', 'HR_RECRUITMENT_GESTIONAR')) {
      await expect(page.locator('a[href="/rh/reclutamiento"]'), 'sin la llave, Reclutamiento no se ofrece').toHaveCount(0);
      return sinDanos(obs);
    }
    const liga = page.locator('a[href="/rh/reclutamiento"]').first();
    await expect(liga, 'entrada «Reclutamiento» del menú ([RH.2.3])').toBeVisible();
    const lista = page.waitForResponse((r) => /\/hr\/talent\/candidates(\?|$)/.test(r.url()) && r.request().method() === 'GET', { timeout: 30_000 });
    await liga.click();
    await expect(page).toHaveURL(/\/rh\/reclutamiento(\?|$)/);
    const r = await lista;
    expect(r.status(), 'GET /hr/talent/candidates').toBe(200);
    const { total, filas } = (await r.json()) as { total: number; filas: unknown[] };
    // Cruce: lo que la tabla pinta y su pie «N de TOTAL» contra lo que respondió la API.
    const tabla = page.getByRole('region', { name: 'Candidatos' });
    if (total > 0) {
      await expect(tabla.locator('tbody tr'), 'filas pintadas vs. API').toHaveCount(filas.length);
      await expect(tabla.getByText(`${filas.length} de ${total}`), 'el pie dice cuántos de cuántos').toBeVisible();
    }
    sinDanos(obs);
  });

  test('el selector de plaza ofrece exactamente las plazas activas de la API', async ({ page }) => {
    const obs = await abrir(page);
    const plaza = page.getByRole('combobox', { name: 'Plaza' });
    await expect(plaza).toBeVisible({ timeout: 20_000 });
    await plaza.click();
    const opciones = (await page.getByRole('option').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    await page.keyboard.press('Escape');
    expect(opciones.sort(), 'opciones del selector vs. GET /sites activos').toEqual(activos.map((s) => s.name).sort());
    sinDanos(obs);
  });

  // Visto en el navegador el 2026-11-11 con 0 plazas: seis pestañas afirmaban un resultado que nadie midió.
  const AFIRMACIONES_SIN_MEDIR: Array<[string, RegExp]> = [
    ['/rh/asistencia', /Nadie con irregularidades|\b0 personas\b/],
    ['/rh/asistencia/tolerancia', /Nadie agotó su tolerancia/],
    ['/rh/asistencia/faltas', /Nadie faltó/],
    ['/rh/asistencia/horas-extra', /Nadie tiene horas extra/],
    // El «0» y el «de 0 dadas…» viven en elementos distintos: por eso se busca en el texto de toda la pantalla.
    ['/rh/asistencia/cruces', /0\s*de\s*0\s*dadas/],
    ['/rh/asistencia/bajas', /Nadie está de baja/],
  ];
  for (const [ruta, afirma] of AFIRMACIONES_SIN_MEDIR) {
    test(`sin plazas de checado, ${ruta} lo DICE en vez de afirmar ${afirma.source}`, async ({ page }) => {
      test.skip(activos.length > 0, `hay ${activos.length} plaza(s) activa(s): este caso no aplica hoy`);
      const obs = await abrir(page, ruta);
      await expect(page.getByRole('navigation', { name: 'Asistencia' })).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { /* socket de alertas */ });
      // Sin plaza no hay qué calcular: pedir el reporte sería inventar una plaza.
      expect(obs.reportes.length, 'GET /report sin plaza').toBe(0);
      // Ley 0: nada afirma lo que no es. Con 0 plazas nadie midió nada. Prueba negativa hecha el 2026-11-11 en
      // prod con sesión real: las seis pantallas salieron ROJO, y Relojes (que declara su vacío) no disparó la regla.
      const texto = ((await page.locator('main').textContent()) ?? '').replace(/\s+/g, ' ');
      expect(texto, 'afirma un resultado que nadie midió').not.toMatch(afirma);
      await expect(page.getByText(/no hay (ninguna )?plaza|ninguna plaza|sin plazas/i).first(), 'debe declarar que no hay plazas de checado').toBeVisible();
      sinDanos(obs);
    });
  }

  test('con plazas: el reporte de la primera plaza y la semana de nómina en curso, contado como lo trae la API', async ({ page }) => {
    test.skip(activos.length === 0, 'NO MEDIDO: prod no tiene plazas de checado activas (el corte de asistencia no ha ocurrido)');
    const primera = [...activos].sort((a, b) => a.name.localeCompare(b.name))[0];
    const obs = await abrir(page);
    const resp = await page.waitForResponse((r) => /\/hr\/attendance\/report(\?|$)/.test(r.url()), { timeout: 30_000 });
    expect(resp.status(), 'GET /report').toBe(200);
    const q = new URL(resp.url()).searchParams;
    expect(q.get('site_code'), 'plaza pedida').toBe(primera.code);
    expect(q.get('date_from'), 'la semana de nómina empieza en jueves').toBe(juevesDe(hoyMx()));
    const datos = (await resp.json()) as Reporte;
    const n = datos.personas.length;
    if (n === 0) {
      await expect(page.getByText('Nadie checó en este periodo')).toBeVisible();
    } else {
      await expect(reporte(page).getByRole('heading', { level: 2 })).toHaveText(primera.name);
      await expect(reporte(page).getByText(new RegExp(`\\b${n} persona${n === 1 ? '' : 's'}\\b`)).first(), 'personas pintadas vs. API').toBeVisible();
    }
    sinDanos(obs);
  });

  test('«Semana anterior» pide el reporte de la semana anterior', async ({ page }) => {
    test.skip(activos.length === 0, 'NO MEDIDO: sin plazas activas la pantalla no pide reporte');
    const obs = await abrir(page);
    await page.waitForResponse((r) => /\/hr\/attendance\/report(\?|$)/.test(r.url()), { timeout: 30_000 });
    const siguiente = page.waitForResponse((r) => /\/hr\/attendance\/report(\?|$)/.test(r.url()), { timeout: 30_000 });
    await page.getByRole('group', { name: 'Semana de nómina' }).getByRole('button', { name: 'Semana anterior' }).click();
    const r = await siguiente;
    expect(new URL(r.url()).searchParams.get('date_from')).toBe(sumar(juevesDe(hoyMx()), -7));
    sinDanos(obs);
  });

  test('cada pestaña del marco abre sin errores', async ({ page }) => {
    const obs = await abrir(page);
    const pestanas = page.getByRole('navigation', { name: 'Asistencia' }).getByRole('link');
    await expect(pestanas.first()).toBeVisible({ timeout: 20_000 });
    const destinos = await pestanas.evaluateAll((as) => as.map((a) => ({ texto: (a.textContent ?? '').trim(), href: a.getAttribute('href') ?? '' })));
    expect(destinos.map((d) => d.href), 'Checadas es la primera pestaña').toContain('/rh/asistencia');
    for (const d of destinos) {
      await page.getByRole('navigation', { name: 'Asistencia' }).locator(`a[href="${d.href}"]`).click();
      await expect(page, `pestaña «${d.texto}»`).toHaveURL(new RegExp(`${d.href.replace(/[/]/g, '\\/')}(\\?|$)`));
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { /* el socket de alertas no deja quieta la red */ });
    }
    sinDanos(obs);
  });
});
