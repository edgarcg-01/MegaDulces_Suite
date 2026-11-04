import { test, expect, request, type Page, type APIRequestContext, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * `[RD.103.5]` — e2e de /comercial/comisiones: el tabulador por familia y el alta en «Quién cobra».
 *
 * Lo que defiende, con su porqué:
 *   1. ⛔ **El riesgo que cerró RD.103.5**: el editor tomaba «la vigente» de TODAS las familias.
 *      Con la versión vecinal en la lista habría estrenado una versión de Ruta Directa con
 *      escalones de markup. Aquí: el editor de Ruta Directa parte de la vigente DE RUTA DIRECTA
 *      (cruzado contra la API) y su estreno manda `familia: 'ruta_directa'`.
 *   2. La vecinal: la propuesta del libro va APARTE con su fuente (D-V1), «Usar como base» la copia
 *      en % de markup, no se ofrece simular (y se dice por qué) y el estreno manda familia,
 *      `gate_field: 'markup'`, piso y parte del supervisor.
 *   3. «Quién cobra»: un código vecinal no se deja guardar sin decir con qué tabulador cobra.
 *
 * ⭐ El principio de las suites hermanas: lo que pinta la pantalla se cruza contra lo que responde
 * la API, no contra una cifra escrita a mano.
 *
 * ⛔ SÓLO LECTURA. Los dos `POST` que escriben se interceptan (`page.route`) y se responden aquí;
 * la simulación (`/scales/simulate`) sí va al servidor porque no escribe nada (es permiso VER).
 * Cualquier otro POST/PATCH/PUT/DELETE se ABORTA y la prueba falla.
 */

const RUTA = '/comercial/comisiones';
const API = '/api/commercial/commissions';

const token = (() => {
  const f = process.env.MD_TOKEN_FILE;
  if (!f) return null;
  try { return readFileSync(f, 'utf8').replace(/^"|"$/g, '').trim(); } catch { return null; }
})();

test.skip(!token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión (la suite corre contra prod con un usuario real)');

// ── Tipos mínimos de lo que responde la API ─────────────────────────────────────────────
interface Tier { min_amount: string | number; max_amount: string | number | null; pct: string | number }
interface Escala {
  id: string; code: string; vigente: boolean; familia?: string; gate_field: string;
  share_supervisor_pct: string | number; piso_chofer_venta?: string | number | null; tiers: Tier[];
}
interface Escalas { escalas: Escala[]; piso_editable: string | null; hoy: string }

let api: APIRequestContext;
test.beforeAll(async ({ baseURL }) => {
  api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
});
test.afterAll(async () => { await api?.dispose(); });

const getEscalas = async (): Promise<Escalas> => {
  const r = await api.get(`${API}/scales`);
  expect(r.status(), 'GET /scales').toBe(200);
  return r.json();
};
const familiaDe = (e: Escala) => e.familia ?? 'ruta_directa';
const vigenteDe = (d: Escalas, familia: string) =>
  d.escalas.filter((e) => familiaDe(e) === familia).find((e) => e.vigente)
  ?? d.escalas.filter((e) => familiaDe(e) === familia)[0] ?? null;

/** Lo que la pantalla quiso escribir, capturado sin dejarlo pasar. */
interface Capturas { estreno: Record<string, unknown>[]; alta: Record<string, unknown>[]; abortadas: string[] }

/**
 * ⛔ La red de seguridad. Se instala ANTES de abrir la pantalla:
 *  · POST /scales (estrenar) y POST /routes (alta) → se capturan y se responden aquí.
 *  · POST /scales/simulate → pasa: no escribe.
 *  · cualquier otra escritura → se aborta y queda anotada (la prueba la exige vacía).
 */
async function blindar(page: Page): Promise<Capturas> {
  const cap: Capturas = { estreno: [], alta: [], abortadas: [] };
  await page.route('**/api/**', async (route) => {
    const req: Request = route.request();
    const m = req.method();
    const url = req.url();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
    if (m === 'POST' && /\/commissions\/scales\/simulate(\?|$)/.test(url)) return route.continue();
    if (m === 'POST' && /\/commissions\/scales(\?|$)/.test(url)) {
      const body = req.postDataJSON() as Record<string, unknown>;
      cap.estreno.push(body);
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ id: 'e2e-no-escrito', valid_from: body.valid_from, cerro_a: null,
          escalones: Array.isArray(body.tiers) ? body.tiers.length : 0, bonos_heredados: 0 }),
      });
    }
    if (m === 'POST' && /\/commissions\/routes(\?|$)/.test(url)) {
      const body = req.postDataJSON() as Record<string, unknown>;
      cap.alta.push(body);
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ id: 'e2e-no-escrito', route_code: body.route_code, scale_id: 'e2e',
          familia: body.familia ?? 'ruta_directa', zona: null, chofer_nombre: null, supervisor_nombre: null,
          nomina_banco: body.nomina_banco, activo: true, notes: null, activo_desde: body.activo_desde,
          activo_hasta: null, updated_at: null, updated_by: null, quincenas_pagadas: 0, pagado_historico: 0 }),
      });
    }
    cap.abortadas.push(`${m} ${url}`);
    return route.abort();
  });
  return cap;
}

async function abrir(page: Page, vista: 'Tabulador' | 'Quién cobra') {
  await page.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* */ } }, token);
  await page.goto(RUTA);
  const vistas = page.getByRole('radiogroup', { name: 'Qué se está viendo' });
  await expect(vistas).toBeVisible({ timeout: 20_000 });
  await vistas.getByRole('radio', { name: new RegExp(`^${vista}`) }).click();
}

async function familia(page: Page, nombre: 'Ruta Directa' | 'Vecinal') {
  await page.getByRole('radiogroup', { name: 'De qué familia es el tabulador' })
    .getByRole('radio', { name: nombre }).click();
}

/** Los escalones del borrador, leídos de los campos (`$189,999.99`, `12.01 %`, `-100.00 %`). */
async function escalonesEnPantalla(page: Page) {
  const filas = page.locator('table.surf-table').filter({ has: page.getByRole('columnheader', { name: /^Desde/ }) })
    .locator('tbody tr');
  const n = await filas.count();
  const out: { min: number; max: number | null; pct: number; minTexto: string }[] = [];
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(/[^0-9.-]/g, '')));
  for (let i = 0; i < n; i++) {
    const ins = filas.nth(i).locator('input');
    const [a, b, c] = [await ins.nth(0).inputValue(), await ins.nth(1).inputValue(), await ins.nth(2).inputValue()];
    out.push({ min: num(a) as number, max: num(b), pct: num(c) as number, minTexto: a });
  }
  return out;
}

const puedeGestionar = async (page: Page) =>
  (await page.getByRole('button', { name: 'Descartar cambios' }).count()) > 0;

// ════════════════════════════════════════════════════════════════════════════════════
test.describe('tabulador por familia — lectura', () => {
  test('Ruta Directa: el editor parte de la vigente DE RUTA DIRECTA (cruzado con la API)', async ({ page }) => {
    const cap = await blindar(page);
    const d = await getEscalas();
    const rd = vigenteDe(d, 'ruta_directa');
    expect(rd, 'hay una versión de Ruta Directa').not.toBeNull();
    await abrir(page, 'Tabulador');
    await familia(page, 'Ruta Directa');

    await expect(page.getByRole('columnheader', { name: /Desde \(venta\)/ })).toBeVisible();
    const t = await escalonesEnPantalla(page);
    expect(t.length, 'tantos escalones como la vigente RD').toBe(rd!.tiers.length);
    rd!.tiers.forEach((x, i) => {
      expect(t[i].min, `escalón ${i + 1}: desde`).toBeCloseTo(Number(x.min_amount), 2);
      expect(t[i].pct, `escalón ${i + 1}: %`).toBeCloseTo(Number(x.pct), 4);
    });
    // ⭐ Control negativo: si hay versión vecinal, sus escalones (en %) NO son los que se ven aquí.
    const vec = vigenteDe(d, 'vecinal');
    if (vec) expect(t.map((x) => x.min)).not.toEqual(vec.tiers.map((x) => Number(x.min_amount)));
    await expect(page.getByText('Es un acantilado, no una rampa.')).toBeVisible();
    expect(cap.abortadas, 'ninguna escritura fuera de las interceptadas').toEqual([]);
  });

  test('Vecinal: dice si hay versión, muestra la propuesta APARTE con su fuente y no ofrece simular', async ({ page }) => {
    const cap = await blindar(page);
    const d = await getEscalas();
    const vec = vigenteDe(d, 'vecinal');
    await abrir(page, 'Tabulador');
    await familia(page, 'Vecinal');

    await expect(page.getByRole('columnheader', { name: /Desde \(markup\)/ })).toBeVisible();
    if (vec) {
      await expect(page.getByText(/Vigente desde el/)).toBeVisible();
      expect((await escalonesEnPantalla(page)).length).toBe(vec.tiers.length);
    } else {
      await expect(page.getByText('Todavía no hay tabulador vecinal.')).toBeVisible();
      expect((await escalonesEnPantalla(page)).length, 'sin versión, el borrador arranca vacío — no con los de RD').toBe(0);
    }
    await expect(page.getByText('Propuesta: la regla con la que Comercial ya paga')).toBeVisible();
    await expect(page.getByText(/COMISIONES RV MORELIA 2026/)).toBeVisible();
    await expect(page.getByText(/la propuesta\s+deja 4 %, y eso es una lectura nuestra/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver qué pasaría' }), 'vecinal: no hay contra qué simular').toHaveCount(0);
    await expect(page.getByText('Es un acantilado, no una rampa.')).toHaveCount(0);
    if (await puedeGestionar(page)) await expect(page.getByText('No se puede simular:')).toBeVisible();
    expect(cap.abortadas).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
test.describe('tabulador por familia — lo que la pantalla MANDA al estrenar (interceptado)', () => {
  test('Vecinal: «Usar como base» copia la propuesta en % y el estreno manda familia, markup, piso y 20 %', async ({ page }) => {
    const cap = await blindar(page);
    await abrir(page, 'Tabulador');
    await familia(page, 'Vecinal');
    test.skip(!(await puedeGestionar(page)), 'NO MEDIDO: el usuario de MD_TOKEN_FILE no tiene COMMERCIAL_COMMISSIONS_GESTIONAR');

    await page.getByRole('button', { name: 'Usar como base' }).click();
    const t = await escalonesEnPantalla(page);
    expect(t.map((x) => [x.min, x.max, x.pct])).toEqual([
      [-100, 12.01, 2.73], [12.01, 13.01, 2.95], [13.01, 15.01, 3.13], [15.01, 18.01, 3.41], [18.01, null, 4],
    ]);
    expect(t[0].minTexto, 'el escalón vecinal se escribe en %, no en pesos').toContain('%');
    expect(t[0].minTexto).not.toContain('$');

    const estrenar = page.getByRole('button', { name: 'Estrenar esta versión' });
    await expect(estrenar, 'sin «Rige desde» no se deja estrenar').toBeDisabled();
    const fecha = page.locator('label.cm-campo', { hasText: 'Rige desde' }).locator('input[type="date"]');
    const min = (await fecha.getAttribute('min')) ?? '2026-10-22';
    const desde = min > '2026-10-22' ? min : '2026-10-22';
    await fecha.fill(desde);
    await expect(estrenar).toBeEnabled();
    await estrenar.click();

    // La confirmación nombra lo que decide, en palabras — y que no se pudo simular.
    const dialogo = page.getByRole('alertdialog').or(page.locator('.p-confirmdialog'));
    await expect(dialogo).toContainText('No se pudo simular');
    await expect(dialogo).toContainText('129,999.99');
    await dialogo.getByRole('button', { name: 'Estrenar' }).click();

    await expect.poll(() => cap.estreno.length).toBe(1);
    const b = cap.estreno[0];
    expect(b.familia).toBe('vecinal');
    expect(b.gate_field).toBe('markup');
    expect(b.piso_chofer_venta).toBe(129999.99);
    expect(b.share_supervisor_pct).toBe(20);
    expect(b.valid_from).toBe(desde);
    expect((b.tiers as Tier[]).length).toBe(5);
    expect((b.tiers as Tier[])[4].max_amount, 'el último escalón va sin techo').toBeNull();
    await expect(page.getByText('Tabulador vecinal estrenado')).toBeVisible();
    expect(cap.abortadas).toEqual([]);
  });

  test('⛔ Ruta Directa: el estreno manda familia ruta_directa y los escalones de RD (el riesgo de RD.103.5)', async ({ page }) => {
    const cap = await blindar(page);
    const rd = vigenteDe(await getEscalas(), 'ruta_directa');
    await abrir(page, 'Tabulador');
    // Se pasa primero por Vecinal y se vuelve: el borrador tiene que volver a ser el de RD.
    await familia(page, 'Vecinal');
    await familia(page, 'Ruta Directa');
    test.skip(!(await puedeGestionar(page)), 'NO MEDIDO: el usuario de MD_TOKEN_FILE no tiene COMMERCIAL_COMMISSIONS_GESTIONAR');

    // La simulación SÍ va al servidor: no escribe (permiso VER) y es obligatoria antes de estrenar en RD.
    await page.getByRole('button', { name: 'Ver qué pasaría' }).click();
    await expect(page.getByText(/la última quincena pagada/)).toBeVisible({ timeout: 30_000 });
    const fecha = page.locator('section.cm-sim label.cm-campo', { hasText: 'Rige desde' }).locator('input[type="date"]');
    await fecha.fill((await fecha.getAttribute('min')) ?? '2026-11-05');
    await page.getByRole('button', { name: 'Estrenar esta versión' }).click();
    await page.getByRole('alertdialog').or(page.locator('.p-confirmdialog'))
      .getByRole('button', { name: 'Estrenar' }).click();

    await expect.poll(() => cap.estreno.length).toBe(1);
    const b = cap.estreno[0];
    expect(b.familia, 'la familia viaja SIEMPRE').toBe('ruta_directa');
    expect(b.gate_field, 'RD no cambia cómo escalona').toBeUndefined();
    expect(b.piso_chofer_venta, 'RD no tiene piso del chofer').toBeUndefined();
    expect((b.tiers as Tier[]).map((x) => Number(x.min_amount)))
      .toEqual(rd!.tiers.map((x) => Number(x.min_amount)));
    expect(cap.abortadas).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
test.describe('«Quién cobra» — el alta de un código vecinal (interceptado)', () => {
  async function abrirAlta(page: Page) {
    await abrir(page, 'Quién cobra');
    const boton = page.getByRole('button', { name: 'Dar de alta una ruta' });
    test.skip((await boton.count()) === 0, 'NO MEDIDO: el usuario no puede dar de alta (sin GESTIONAR)');
    await boton.click();
    const d = page.getByRole('dialog', { name: 'Dar de alta una ruta' });
    await expect(d).toBeVisible();
    return d;
  }

  test('un código vecinal no se deja guardar sin decir con qué tabulador cobra; eligiéndolo, manda la familia', async ({ page }) => {
    const cap = await blindar(page);
    const d = await abrirAlta(page);
    await d.locator('input[name="route_code"]').fill('2V003');
    await d.locator('input[name="nomina"]').fill('0');
    await d.locator('input[name="desde"]').fill('2026-10-22');
    const guardar = d.getByRole('button', { name: 'Guardar' });

    await expect(guardar, 'poka-yoke: sin familia no se envía').toBeDisabled();
    await expect(d.getByText(/2V003 es un código vecinal/)).toBeVisible();

    await d.getByRole('radiogroup', { name: 'Con qué tabulador cobra' }).getByRole('radio', { name: 'Vecinal' }).click();
    await expect(d.getByText(/es un código vecinal/)).toHaveCount(0);
    await expect(guardar).toBeEnabled();
    await guardar.click();

    await expect.poll(() => cap.alta.length).toBe(1);
    expect(cap.alta[0]).toMatchObject({ route_code: '2V003', familia: 'vecinal', nomina_banco: 0, activo_desde: '2026-10-22' });
    expect(cap.abortadas).toEqual([]);
  });

  test('control: un código de Ruta Directa se guarda sin elegir familia (lo de siempre)', async ({ page }) => {
    const cap = await blindar(page);
    const d = await abrirAlta(page);
    await d.locator('input[name="route_code"]').fill('E2E999');
    await d.locator('input[name="nomina"]').fill('0');
    await d.locator('input[name="desde"]').fill('2026-10-22');
    await expect(d.getByText(/es un código vecinal/)).toHaveCount(0);
    const guardar = d.getByRole('button', { name: 'Guardar' });
    await expect(guardar).toBeEnabled();
    await guardar.click();

    await expect.poll(() => cap.alta.length).toBe(1);
    expect(cap.alta[0].familia, 'sin elegir, no se manda: el servidor pone Ruta Directa').toBeUndefined();
    expect(cap.abortadas).toEqual([]);
  });
});
