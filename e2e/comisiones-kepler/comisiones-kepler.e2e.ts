import { test, expect, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { sesion, contexto, quieta } from '../reestructura/comun';
import { medir } from '../reestructura/medir';

/**
 * `[CB.62.4]` **Bancos › Contra Kepler › Comisiones, medido contra PRODUCCIÓN.**
 *
 * Contesta tres preguntas que ninguna compuerta contesta, y ninguna se cree sin su control:
 *
 *   0. ¿El instrumento ve? Una ruta real contesta 200 y una **inventada** 404. Si ese control falla, ninguna
 *      medición de abajo se publica (skill `auditoria-diseno` §4: todo instrumento arranca con una respuesta
 *      que ya se conoce).
 *   1. ¿La pantalla **dice la verdad**? Lo que pinta en «Listos» se cruza contra un **testigo independiente**:
 *      la misma consulta pedida por el runner, que no pasa por la página. ⭐ Ese es el cruce que caza el
 *      defecto canónico —una lista que esconde filas mientras el rótulo afirma otra cosa— y el que el
 *      control negativo `E2E_MUTANTE=esconde` ejerce a propósito.
 *   2. ⭐ ¿El **dial** frena de verdad? `POST …/generar` con `KEPLER_COMISIONES_TERMINAL` apagado debe
 *      devolver `escritos: 0` y un motivo por día, sin tocar Kepler ni la bitácora. Hasta que alguien lo
 *      ejerza, «nace apagado» es una intención (regla 12).
 *
 * ── Lo que esta prueba NO puede decir ────────────────────────────────────────────────────────────────────
 *   - Que el escritor escribe BIEN: eso es el canario de una cuenta real, documento por documento
 *     (`ops/prod/ensayo-comisiones-kepler/README.md`), no esto.
 *   - Que la bitácora quedó en cero filas: desde el navegador no se ve la base. Se mide aparte, leyendo
 *     `finance.bank_commission_kepler_days` en sólo lectura, y se declara en el informe.
 *   - Nada sobre el botón «Generar en Kepler» si el frontend desplegado todavía no lo trae: el caso 3
 *     reporta **cuál de los dos estados vio**, y no afirma el otro.
 */

const BASE = process.env.E2E_BASE_URL || 'https://megadulcessuite.com';
const RES = path.join(__dirname, '.resultados');
/** El periodo de Bancos (el resto de la pantalla); la propuesta de comisiones va por días, no por periodo. */
const PERIODO = process.env.E2E_PERIODO || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const RUTA = `/finanzas/bancos?view=comisiones&period=${PERIODO}`;
/** Control negativo: la página recibe UN día listo de menos y el resumen intacto. El caso 1 debe salir ROJO. */
const MUTANTE = process.env.E2E_MUTANTE === 'esconde';
/** ⛔ La única escritura de toda la prueba, y sólo si se pide explícitamente. Ver el caso 4. */
const EJERCER_DIAL = process.env.E2E_ESCRIBE_GENERAR === '1';

const { token, rol, vence } = sesion();
const SIN_SESION = !token
  && 'Sin sesión: corré primero `node e2e/reestructura/iniciar-sesion.js "$HOME/.md-token"` y pasá MD_TOKEN_FILE.';

interface Cargo { id: string; importe: number; kepler_pago: string | null }
interface Dia { sucursal: string; dia_venta: string; banco: string; estado: string; total: number; cargos: Cargo[] }
interface Propuesta {
  medido: boolean; motivo: string | null; desde: string; hasta: string;
  descarga: { hasta: string | null; subida_en: string | null };
  dias: Dia[]; por_revisar: unknown[]; huerfanos: unknown[];
  resumen: { cargos: number; listos: number; ya_en_kepler: number; gasto_capturado_sin_pago: number; esperando_sucursal: number; por_revisar: number; monto_listo: number };
}

/** Lo que se guarda al final, para poder citarlo. ⛔ No se versiona: trae cifras reales del negocio. */
const informe: Record<string, unknown> = { base: BASE, ruta: RUTA, cuando: new Date().toISOString(), rol, vence, mutante: MUTANTE };
const anotar = (k: string, v: unknown): void => { informe[k] = v; };

test.afterAll(() => {
  fs.mkdirSync(RES, { recursive: true });
  fs.writeFileSync(path.join(RES, 'comisiones-kepler.json'), JSON.stringify(informe, null, 2));
});

/**
 * La página, blindada: **sólo `GET` sale**; cualquier escritura se aborta y se anota. Con `E2E_MUTANTE=esconde`
 * además le quita un día listo a la respuesta de la propuesta **sin tocar el resumen**, que es el defecto que
 * el caso 1 tiene que cazar. Guarda la URL exacta que la página pidió, para que el testigo repita ESA y no una
 * parecida.
 */
async function blindarYRegistrar(page: Page): Promise<{ abortadas: string[]; telemetria: string[]; urlPropuesta: string | null; mutadas: number; msPropuesta: number | null }> {
  const reg = { abortadas: [] as string[], telemetria: [] as string[], urlPropuesta: null as string | null, mutadas: 0, msPropuesta: null as number | null };
  // El tiempo de la consulta de comisiones SOLA: sin él, los segundos del arranque de toda la Suite se le
  // cargan a esta pantalla y se acusa al lugar equivocado.
  page.on('requestfinished', (q) => {
    if (!new URL(q.url()).pathname.endsWith('/finance/bank/comisiones-kepler')) return;
    try {
      const t = q.timing(); // síncrono: devuelve ResourceTiming, no una promesa
      if (t.responseEnd > 0) reg.msPropuesta = Math.round(t.responseEnd);
    } catch { /* la petición ya no está */ }
  });
  await page.route('**/api/**', async (r: Route) => {
    const q = r.request();
    const u = new URL(q.url());
    if (q.method() !== 'GET') {
      // La telemetría de uso (`analytics.ui_usage`) la manda CUALQUIER pantalla de la Suite y no es del flujo:
      // se aborta igual —esta visita no debe contar como uso real— pero se anota aparte, para que no se lea
      // como «la pantalla de Comisiones intentó escribir».
      (/\/telemetry\//.test(u.pathname) ? reg.telemetria : reg.abortadas).push(`${q.method()} ${u.pathname}`);
      return r.abort('blockedbyclient');
    }
    const esPropuesta = u.pathname.endsWith('/finance/bank/comisiones-kepler');
    if (esPropuesta) reg.urlPropuesta = u.pathname + u.search;
    if (!esPropuesta || !MUTANTE) return r.continue();

    const resp = await r.fetch();
    const j = (await resp.json()) as Propuesta;
    const i = (j.dias ?? []).findIndex((d) => d.estado === 'lista');
    if (i >= 0) { j.dias.splice(i, 1); reg.mutadas++; }
    return r.fulfill({ response: resp, body: JSON.stringify(j), headers: { 'content-type': 'application/json' } });
  });
  return reg;
}

test.describe.configure({ mode: 'serial' });

test.describe('[CB.62.4] Comisiones de terminal, contra producción', () => {
  test('0 · control del instrumento: la consulta real contesta y una inventada NO', async ({ playwright }) => {
    test.skip(!!SIN_SESION, SIN_SESION || '');
    const api = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    const real = await api.get('/api/finance/bank/comisiones-kepler?dias=14');
    const inventada = await api.get('/api/finance/bank/comisiones-kepler-que-no-existe');
    const sinSesion = await (await playwright.request.newContext({ baseURL: BASE })).get('/api/finance/bank/comisiones-kepler?dias=14');
    anotar('control', { real: real.status(), inventada: inventada.status(), sin_sesion: sinSesion.status() });

    // Si estas tres no se cumplen, lo que midan los casos siguientes no significa nada.
    expect(real.status(), 'la consulta real debe contestar 200').toBe(200);
    expect(inventada.status(), 'una ruta inventada debe dar 404 (si da 200, el instrumento no distingue)').toBe(404);
    expect(sinSesion.status(), 'sin sesión debe dar 401 (si da 200, la pantalla está abierta a cualquiera)').toBe(401);

    const p = (await real.json()) as Propuesta;
    anotar('propuesta', {
      medido: p.medido, motivo: p.motivo, desde: p.desde, hasta: p.hasta, descarga: p.descarga,
      resumen: p.resumen, dias: p.dias.length, listos_dias: p.dias.filter((d) => d.estado === 'lista').length,
    });
    await api.dispose();
  });

  test('1 · la pantalla abre con su veredicto y no esconde ni una fila', async ({ browser, playwright }) => {
    test.skip(!!SIN_SESION, SIN_SESION || '');
    const ctx = await contexto(browser, token);
    const page = await ctx.newPage();
    const errores: string[] = [];
    page.on('pageerror', (e) => errores.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text().slice(0, 200)); });
    const reg = await blindarYRegistrar(page);

    const t0 = Date.now();
    await page.goto(RUTA);
    await expect(page.locator('#cm-titulo'), 'la pantalla de Comisiones debe abrir').toBeVisible({ timeout: 45_000 });
    const t = await quieta(page, t0);

    // El testigo INDEPENDIENTE: la misma consulta que pidió la página, pedida de nuevo sin pasar por ella.
    // ⛔ `urlPropuesta` ya viene con su `/api` (es el pathname que pidió el navegador): anteponerle otro da
    // /api/api/… → 404, y el 404 llega acá como un objeto sin `dias`, que es un TypeError y no un diagnóstico.
    const api = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const tApi = Date.now();
    const resp = await api.get(reg.urlPropuesta ?? '/api/finance/bank/comisiones-kepler?dias=14');
    const verdad = (await resp.json()) as Propuesta;
    const msApi = Date.now() - tApi;
    await api.dispose();
    expect(resp.status(), `el testigo independiente debe contestar 200 (pidió ${reg.urlPropuesta})`).toBe(200);
    expect(Array.isArray(verdad.dias), 'el testigo debe traer la propuesta con sus días').toBe(true);

    const listosApi = verdad.dias.filter((d) => d.estado === 'lista');
    const filas = page.locator('#cm-listos').locator('xpath=../..').locator('tbody tr');
    const pintadas = (await filas.count()) - (await page.locator('#cm-listos').locator('xpath=../..').locator('tbody .surf-empty').count());
    const m = await medir(page);
    const vacio = await page.locator('.cm-vacio').count();
    // ⭐ El segundo cruce, entre dos cosas que la persona VE: el titular dice «N cargos» y la tabla agrupa esos
    // cargos por día de venta. Medido el 2026-11-26: 16 cargos en 5 días, 214 en 46, 180 en 4 cuentas, 20 en 10
    // bloques — o sea las secciones **agrupan**, no esconden. Si alguna vez la suma de la columna «Cargos» no da
    // el número del titular, o el titular cuenta otra cosa, o la tabla está dejando filas fuera.
    const cargosPintados = (await filas.locator('td:nth-child(4)').allInnerTexts())
      .map((s) => Number(s.replace(/[^\d]/g, ''))).filter((n) => Number.isFinite(n))
      .reduce((s, n) => s + n, 0);

    anotar('pantalla', {
      // Tres relojes distintos, para no acusar al lugar equivocado: la pantalla entera (incluye arrancar la
      // Suite), la consulta de comisiones dentro del navegador, y la misma consulta sin navegador.
      ms_hasta_quieta: t.ms, ms_consulta_en_pantalla: reg.msPropuesta, ms_consulta_sola: msApi,
      seguia_cargando: t.seguia_cargando, errores_de_consola: errores.slice(0, 6),
      escrituras_abortadas: reg.abortadas, telemetria_abortada: reg.telemetria,
      url_que_pidio: reg.urlPropuesta, mutadas: reg.mutadas,
      primario: (await page.locator('.cm-primary').first().textContent())?.replace(/\s+/g, ' ').trim(),
      secundario: (await page.locator('.cm-secondary').first().textContent())?.replace(/\s+/g, ' ').trim(),
      cifras_del_strip: await page.locator('app-metric-strip').getByRole('button').allInnerTexts().catch(() => []),
      listos_pintados: pintadas, listos_segun_api: listosApi.length, seccion_vacia: vacio === 1,
      cargos_pintados: cargosPintados, cargos_del_titular: verdad.resumen.listos,
      monto_listo_api: verdad.resumen.monto_listo, suma_total_dias_listos: listosApi.reduce((s, d) => s + Number(d.total), 0),
      medicion: m,
    });
    await page.screenshot({ path: path.join(RES, 'comisiones-prod.png'), fullPage: true });

    // ⛔ Ninguna escritura salió del navegador.
    expect(reg.abortadas, 'la pantalla no debe intentar ninguna escritura').toEqual([]);
    expect(errores.filter((e) => !/cloudflareinsights|beacon\.min\.js/.test(e)), 'sin errores de la app en consola').toEqual([]);
    // ⭐ El cruce: lo pintado contra el testigo. El mutante `esconde` lo pone rojo aquí.
    if (listosApi.length === 0) {
      expect(vacio, 'con cero días listos la sección debe decirlo, no quedar en blanco').toBe(1);
    } else {
      expect(pintadas, 'la tabla de «Listos» debe pintar TODOS los días listos que la API reporta').toBe(listosApi.length);
      expect(cargosPintados, 'los cargos de la tabla deben sumar los que anuncia el titular (agrupar sí, esconder no)').toBe(verdad.resumen.listos);
    }
    expect(t.seguia_cargando, 'la pantalla no puede quedarse en «Cargando»').toBe(false);
    await ctx.close();
  });

  test('2 · cada sección se abre y dice lo que contiene', async ({ browser }) => {
    test.skip(!!SIN_SESION, SIN_SESION || '');
    const ctx = await contexto(browser, token);
    const page = await ctx.newPage();
    const reg = await blindarYRegistrar(page);
    await page.goto(RUTA);
    await expect(page.locator('#cm-titulo')).toBeVisible({ timeout: 45_000 });
    await quieta(page);

    const secciones: Record<string, unknown> = {};
    for (const id of ['cm-medias', 'cm-espera', 'cm-revisar']) {
      const cab = page.locator(`#${id} .cm-toggle`);
      if (!(await cab.count())) { secciones[id] = 'no existe en la pantalla desplegada'; continue; }
      const rotulo = (await cab.innerText()).replace(/\s+/g, ' ').trim();
      await cab.click();
      await expect(page.locator(`#${id}-cuerpo`), `${id} debe abrir su cuerpo`).toBeVisible({ timeout: 10_000 });
      const filas = await page.locator(`#${id}-cuerpo tbody tr`).count();
      const vacia = await page.locator(`#${id}-cuerpo .surf-empty`).count();
      secciones[id] = { rotulo, filas: vacia ? 0 : filas, dice_que_esta_vacia: vacia > 0 };
      // Un rótulo que anuncia N y un cuerpo sin filas ni aviso de vacío es el defecto que esto caza.
      expect(vacia > 0 || filas > 0, `${id}: si no hay filas, la sección tiene que DECIR que está vacía`).toBe(true);
      await cab.click();
    }
    anotar('secciones', { ...secciones, telemetria_abortada: reg.telemetria });
    expect(reg.abortadas, 'abrir secciones no debe escribir nada del dominio').toEqual([]);
    await ctx.close();
  });

  test('3 · el botón dice la verdad sobre lo que puede hacer', async ({ browser }) => {
    test.skip(!!SIN_SESION, SIN_SESION || '');
    const ctx = await contexto(browser, token);
    const page = await ctx.newPage();
    await blindarYRegistrar(page);
    await page.goto(RUTA);
    await expect(page.locator('#cm-titulo')).toBeVisible({ timeout: 45_000 });
    await quieta(page);

    const boton = page.getByRole('button', { name: /Generar en Kepler/ });
    await expect(boton, 'la pantalla debe ofrecer «Generar en Kepler»').toHaveCount(1);
    const apagado = await boton.isDisabled();
    const nota = (await page.locator('#cm-apagado, .cm-nota-accion').first().textContent().catch(() => null))?.replace(/\s+/g, ' ').trim() ?? null;
    anotar('boton', { apagado, nota });

    // Vale cualquiera de los dos estados; lo que NO vale es un botón mudo. Apagado sin decir por qué es un
    // rótulo que miente por omisión; encendido sin decir qué va a escribir, también.
    expect(nota, 'el botón tiene que venir con una línea que diga qué pasa si se toca (o por qué no)').toBeTruthy();
    if (apagado) expect(nota).toMatch(/[Aa]pagad|todavía no|no hay días listos/);
    await ctx.close();
  });

  test('4 · ⭐ el dial frena: generar con la escritura apagada no escribe nada', async ({ playwright }) => {
    test.skip(!!SIN_SESION, SIN_SESION || '');
    test.skip(!EJERCER_DIAL, 'NO MEDIDO: ejercer el dial manda un POST real. Antes de correrlo con '
      + 'E2E_ESCRIBE_GENERAR=1, verificá en el pod que KEPLER_COMISIONES_TERMINAL sigue AUSENTE — con la '
      + 'bandera encendida este POST ESCRIBE EN KEPLER.');

    const api = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const r = await api.post('/api/finance/bank/comisiones-kepler/generar', { data: { dias: 14 } });
    const j = (await r.json()) as { candidatos: number; escritos: number; resultados: { estado: string; motivo?: string; sucursal: string; dia_venta: string }[] };
    anotar('dial', { status: r.status(), candidatos: j.candidatos, escritos: j.escritos, resultados: j.resultados });
    await api.dispose();

    expect(r.status(), 'generar debe contestar, no reventar').toBeLessThan(300);
    expect(j.escritos, '⛔ con el dial apagado no se escribe NI UN día').toBe(0);
    // Cada día candidato tiene que decir POR QUÉ no se escribió, y el motivo tiene que ser el dial.
    for (const x of j.resultados) {
      expect(x.estado, `${x.sucursal} ${x.dia_venta}: debe quedar «apagado», no rechazado ni en duda`).toBe('apagado');
      expect(x.motivo, `${x.sucursal} ${x.dia_venta}: el motivo debe nombrar el dial`).toMatch(/KEPLER_COMISIONES_TERMINAL/);
    }
    // Llamarlo dos veces no puede cambiar nada: no hay estado que mover con el dial cerrado.
    const api2 = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const r2 = await api2.post('/api/finance/bank/comisiones-kepler/generar', { data: { dias: 14 } });
    const j2 = (await r2.json()) as { escritos: number; candidatos: number };
    anotar('dial_segunda_vez', { status: r2.status(), candidatos: j2.candidatos, escritos: j2.escritos });
    await api2.dispose();
    expect(j2.escritos, 'la segunda llamada tampoco escribe').toBe(0);
  });
});
