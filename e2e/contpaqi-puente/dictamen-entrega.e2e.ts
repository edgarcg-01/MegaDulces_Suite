import { test, expect, request, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * `[CP.8.97]` — e2e del paso 4 de /contabilidad/contpaqi-puente («Revisar y entregar») con el dictamen, en
 * navegador real y contra PROD, sólo lectura.
 *
 * ⭐ El principio de `e2e/libro-compras`: **lo que pinta la pantalla se cruza contra lo que responde la API**
 * (`GET dictamen`, `GET lotes`), no contra cifras escritas a mano que envejecen con el mes.
 *
 * Lo que se afirma:
 *   · arriba dice lo que SALE (listas + por revisar) y su importe, no lo armado;
 *   · la segunda línea cuenta por revisar, frenadas y ya entregadas, y cada parte filtra la lista;
 *   · cada chip de veredicto cuenta lo que la API dice y, al elegirlo, la lista muestra sólo eso;
 *   · sin filtro, lo frenado y lo por revisar van primero;
 *   · el porqué en la fila y los hallazgos del detalle son mensajes de la API, no texto inventado;
 *   · la tira de métricas abre lo frenado; el paso 4 dice lo que sale;
 *   · el aviso de descarga cuenta lo que dicen los encabezados del archivo;
 *   · ⛔ ninguna petición que no sea GET sale de la pantalla en toda la suite.
 *
 * Se salta, declarado, si no hay sesión (`MD_TOKEN_FILE`) o si prod todavía no tiene `[CP.8.97]` (la API no
 * devuelve `entregadas`): probar la pantalla vieja contra estas afirmaciones sería medir otra cosa.
 */

const RUTA = '/contabilidad/contpaqi-puente';
const API = '/api/finance/contpaqi';

/** El mes que abre la pantalla: el último cerrado (`mesesAtras(…)[0]`). `E2E_MES` elige otro de la lista. */
const MES = process.env.E2E_MES || (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();

const token = (() => {
  const f = process.env.MD_TOKEN_FILE;
  if (!f) return null;
  try { return readFileSync(f, 'utf8').replace(/^"|"$/g, '').trim(); } catch { return null; }
})();

test.skip(!token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión (la suite corre contra prod con un usuario real)');

// ── Lo que responde la API (espejo mínimo de `DictamenResp` y `LotesResp`) ──────────────────────────────
type Veredicto = 'lista' | 'revisar' | 'bloqueada';
interface Hallazgo { regla: string; severidad: 'bloquea' | 'revisar' | 'aviso'; mensaje: string }
interface Poliza { clave: string; lote: string; veredicto: Veredicto; hallazgos: Hallazgo[]; total: number }
interface Dictamen {
  mes: string; polizas: Poliza[]; entregadas?: string[];
  resumen: { polizas: number; por_veredicto: Record<Veredicto, number> };
}

let api: APIRequestContext;
let dic: Dictamen;
let sinVersion = false;

test.beforeAll(async ({ baseURL }) => {
  test.setTimeout(120_000);
  api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const r = await api.get(`${API}/dictamen?mes=${MES}`, { timeout: 90_000 });
  expect(r.status(), `GET dictamen ${MES}`).toBe(200);
  dic = await r.json();
  sinVersion = !Array.isArray(dic.entregadas) || dic.polizas.some((p) => typeof p.lote !== 'string');
});
test.afterAll(async () => { await api?.dispose(); });

test.beforeEach(() => {
  test.skip(sinVersion, 'NO MEDIDO: prod todavía no tiene [CP.8.97] (GET dictamen sin `lote`/`entregadas`) — correr después de soltar');
});

// ── La pantalla ─────────────────────────────────────────────────────────────────────────────────────────
/** Las peticiones a la API que no fueron GET. Se abortan y la prueba las reclama en `afterEach`. */
let escrituras: string[] = [];
test.afterEach(() => {
  expect(escrituras, '⛔ la pantalla intentó escribir durante una prueba de sólo lectura').toEqual([]);
  escrituras = [];
});

const numero = (s: string) => Number(s.replace(/[^0-9.-]/g, ''));
const n = (v: Veredicto) => dic.resumen.por_veredicto[v];
const salen = () => n('lista') + n('revisar');
const mensajes = () => new Set(dic.polizas.flatMap((p) => p.hallazgos.map((h) => h.mensaje)));

async function abrir(page: Page) {
  await page.route('**/api/**', (r) => {
    if (r.request().method() === 'GET') return r.continue();
    escrituras.push(`${r.request().method()} ${r.request().url()}`);
    return r.abort();
  });
  await page.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* */ } }, token);
  await page.goto(RUTA);
  if (process.env.E2E_MES) {
    await page.locator('p-select.cpp-sel').click();
    await page.getByRole('option', { name: MES, exact: true }).click();
  }
  // El dictamen llega después de la lista (tarda segundos): hasta entonces arriba dice «armadas».
  await expect(page.locator('.cpp-verdict h2')).toContainText(/sale(n)? en el archivo/, { timeout: 60_000 });
}

async function paso4(page: Page) {
  await page.locator('.cpp-paso', { hasText: 'Revisar y entregar' }).click();
  await expect(page.locator('.cpp-cuerpo h3')).toContainText('Descarga el archivo');
}

const filas = (page: Page) => page.locator('tr.cpp-lote');
const veredictoDeFila = (page: Page, i: number) => filas(page).nth(i).locator('td').nth(1).innerText();

async function chips(page: Page): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await page.locator('.cpp-chip').allInnerTexts()) {
    const m = t.replace(/\s+/g, ' ').trim().match(/^(.*?)\s*([\d,]+)$/);
    if (m) out[m[1]] = numero(m[2]);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe(`${MES}: la entrega dice lo que sale, según el dictamen`, () => {
  test('arriba: cuántas salen y cuánto suman = listas + por revisar de la API', async ({ page }) => {
    await abrir(page);
    const h2 = (await page.locator('.cpp-verdict h2').innerText()).replace(/\s+/g, ' ');
    expect(numero(h2.split(' ')[0]), 'la cifra de arriba = lista + revisar').toBe(salen());
    const importe = dic.polizas.filter((p) => p.veredicto !== 'bloqueada').reduce((a, p) => a + Number(p.total), 0);
    expect(numero(await page.locator('.cpp-v-imp').innerText()), 'su importe, a pesos').toBe(Math.round(importe));

    const sub = (await page.locator('.cpp-v-sub').innerText()).replace(/\s+/g, ' ');
    if (n('revisar')) expect(sub).toContain(`${n('revisar').toLocaleString('es-MX')} por revisar`);
    if (n('bloqueada')) expect(sub).toMatch(new RegExp(`${n('bloqueada').toLocaleString('es-MX')} frenadas? por el dictamen`));
    const ent = dic.entregadas!.length;
    if (ent) expect(sub).toMatch(new RegExp(`${ent.toLocaleString('es-MX')} ya entregadas?`));
    if (!n('revisar') && !n('bloqueada') && !ent) expect(sub).toContain('Todas pasan el dictamen');
  });

  test('el paso 4 dice lo que sale, no lo armado', async ({ page }) => {
    await abrir(page);
    const estado = await page.locator('.cpp-paso', { hasText: 'Revisar y entregar' }).locator('.cpp-paso-s').innerText();
    expect(numero(estado), `«${estado}»`).toBe(salen());
  });

  test('cada chip de veredicto cuenta lo que dice la API, y al elegirlo la lista muestra sólo eso', async ({ page }) => {
    await abrir(page);
    await paso4(page);
    const c = await chips(page);
    const casos: [string, string, number][] = [
      ['Frenadas', 'Frenada', n('bloqueada')], ['Por revisar', 'Por revisar', n('revisar')],
      ['Listas', 'Lista', n('lista')], ['Ya entregadas', 'Ya entregada', dic.entregadas!.length],
    ];
    for (const [chip, , esperado] of casos) {
      if (esperado) expect(c[chip], `chip «${chip}»`).toBe(esperado);
      else expect(c[chip], `sin «${chip}» no hay chip`).toBeUndefined();
    }
    for (const [chip, etiqueta, esperado] of casos.filter(([, , e]) => e > 0 && e <= 120)) {
      await page.locator('.cpp-chip', { hasText: chip }).click();
      await expect(page.locator('.cpp-chip', { hasText: chip })).toHaveAttribute('aria-pressed', 'true');
      await expect(filas(page), `filas con «${chip}»`).toHaveCount(esperado);
      const tags = await filas(page).locator('td:nth-child(2)').allInnerTexts();
      expect(new Set(tags.map((t) => t.trim())), `todas dicen «${etiqueta}»`).toEqual(new Set([etiqueta]));
      await page.locator('.cpp-chip', { hasText: 'Todas' }).click();
    }
  });

  test('sin filtro, lo frenado y lo por revisar van primero', async ({ page }) => {
    await abrir(page);
    await paso4(page);
    const primeros = Math.min(n('bloqueada') + n('revisar'), 120);
    test.skip(primeros === 0, 'NO MEDIDO: el mes no tiene nada frenado ni por revisar');
    const vistos: string[] = [];
    for (let i = 0; i < primeros; i++) vistos.push((await veredictoDeFila(page, i)).trim());
    const rango = (v: string) => (v === 'Frenada' ? 0 : v === 'Por revisar' ? 1 : 2);
    expect(vistos.every((v) => rango(v) < 2), `las primeras ${primeros} filas: ${[...new Set(vistos)].join(', ')}`).toBe(true);
    expect(vistos.map(rango), 'frenadas antes que por revisar').toEqual([...vistos.map(rango)].sort((a, b) => a - b));
  });

  test('el porqué de una frenada, en la fila y en el detalle, son mensajes de la API', async ({ page }) => {
    await abrir(page);
    await paso4(page);
    test.skip(!n('bloqueada'), 'NO MEDIDO: el mes no tiene pólizas frenadas');
    await page.locator('.cpp-chip', { hasText: 'Frenadas' }).click();
    const fila = filas(page).first();
    const porque = (await fila.locator('.cpp-porque').innerText()).trim();
    const frenan = new Set(dic.polizas.flatMap((p) => p.hallazgos.filter((h) => h.severidad === 'bloquea').map((h) => h.mensaje)));
    expect(frenan.has(porque), `el porqué de la fila es un hallazgo que frena: «${porque.slice(0, 80)}»`).toBe(true);

    await fila.click();
    const peek = page.locator('.cpp-peek');
    await expect(peek.locator('.cpp-dict')).toContainText('Frenada');
    const items = (await peek.locator('.cpp-hallazgos li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(items.length, 'el detalle lista sus hallazgos').toBeGreaterThan(0);
    expect(items[0], 'el más grave primero').toMatch(/^Frena:/);
    const todos = mensajes();
    for (const it of items) {
      const msg = it.replace(/^(Frena|Revisar|Aviso):\s*/, '');
      expect(todos.has(msg), `«${msg.slice(0, 80)}» viene de la API`).toBe(true);
    }
  });

  test('la tira de métricas y la frase de arriba abren lo frenado', async ({ page }) => {
    await abrir(page);
    test.skip(!n('bloqueada'), 'NO MEDIDO: el mes no tiene pólizas frenadas');
    await page.locator('.cpp-v-sub button', { hasText: /frenadas? por el dictamen/ }).click();
    await expect(page.locator('.cpp-chip', { hasText: 'Frenadas' })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.cpp-chip', { hasText: 'Todas' }).click();
    await page.getByRole('button', { name: 'Ver las pólizas frenadas por el dictamen' }).click();
    await expect(page.locator('.cpp-chip', { hasText: 'Frenadas' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('la ayuda explica los veredictos', async ({ page }) => {
    await abrir(page);
    await page.locator('.cpp-v-sub').getByRole('button', { name: /^Ayuda: El dictamen/ }).click();
    const panel = page.locator('.ch-drawer');
    await expect(panel).toContainText('El dictamen — qué revisa antes de entregar');
    for (const t of ['Lista', 'Por revisar', 'Frenada', 'Ya entregada']) await expect(panel).toContainText(t);
  });

  test('el aviso de descarga cuenta lo que dicen los encabezados del archivo', async ({ page }) => {
    await abrir(page);
    await paso4(page);
    const boton = page.getByRole('button', { name: /Descargar el archivo/ });
    test.skip(!(await boton.count()), 'NO MEDIDO: el usuario de la sesión no tiene _GESTIONAR (no ve el botón)');
    test.skip(salen() === 0, 'NO MEDIDO: nada sale en el mes; el archivo no se genera');
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`${API}/archivo`), { timeout: 60_000 }),
      page.waitForEvent('download', { timeout: 60_000 }),
      boton.click(),
    ]);
    const h = resp.headers();
    expect(numero(h['x-polizas'] ?? 'NaN'), 'el archivo lleva lo que sale').toBe(salen());
    expect(numero(h['x-bloqueadas-dictamen'] ?? 'NaN'), 'y deja fuera lo frenado').toBe(n('bloqueada'));
    const aviso = page.locator('.cpp-aviso', { hasText: 'generado' });
    await expect(aviso).toContainText(`con ${salen().toLocaleString('es-MX')} póliza`);
    if (n('bloqueada')) await expect(aviso).toContainText(`${n('bloqueada').toLocaleString('es-MX')} frenada`);
    await expect(aviso).toContainText('NO quedó marcado como entregado');
  });
});
