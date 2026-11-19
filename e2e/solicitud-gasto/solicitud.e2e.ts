import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { servirApi, tokenSintetico, hoyMx, NOTA_RECHAZO, type Opciones, type Registro } from './api-sintetica';

/**
 * `[PGP.122]` La solicitud de gasto recorrida DESDE LA INTERFAZ, como la usa la gente:
 *
 *   1. Pedir (`/finanzas/gastos` → «Registrar o pedir»): elegir el proveedor frecuente, subir el ticket y mandar a
 *      firma. La Suite llena el resto (hábito del proveedor + lectura del ticket).
 *   2. Firmar (`/finanzas/aprobacion-gastos`): abrir el vale, ver ANTES del botón lo que se escribe en Kepler, y
 *      «Revisado». La API contesta «escrita en Kepler, folio 0000083».
 *   3. Cancelar en Kepler (F3): desde «Esperan a Kepler», abrir el vale y cancelarlo con motivo.
 *   4. (2ª prueba) Kepler RECHAZA al firmar: el aviso lo dice con su motivo, el vale se encuentra y se reintenta.
 *
 * Cada paso guarda una captura y lo que la pantalla MANDÓ (el payload real de la interfaz). Al final: ninguna
 * petición salió del navegador. Ver `api-sintetica.ts` para lo que este modo no puede decir.
 */

const RES = path.join(__dirname, '.resultados');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function captura(page: Page, nombre: string): Promise<void> {
  fs.mkdirSync(RES, { recursive: true });
  await page.screenshot({ path: path.join(RES, `${nombre}.png`), fullPage: true });
}

/**
 * Los textos con contenido propio cuyo borde derecho cae fuera de la ventana (se cortan y no se pueden leer), medidos
 * con la pantalla QUIETA. ⛔ Sin esperar a las animaciones el panel lateral se mide a medio deslizar: el 2026-11-18 eso
 * dio 31 elementos «cortados» que un segundo después eran 0 (y se reportó como defecto; no lo era).
 */
async function fueraDeLaPantalla(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), undefined, { timeout: 5_000 });
  return page.evaluate(() => {
    const ancho = window.innerWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const propio = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
      if (!propio) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > ancho + 1 && getComputedStyle(el).visibility !== 'hidden') out.push(`${propio.slice(0, 60)} (borde ${Math.round(r.right)} > ${ancho})`);
    }
    return out.slice(0, 12);
  });
}

/** Una ventana con el token sintético y TODA la API contestada aquí. Registra los errores de la página. */
async function abrir(browser: Browser, op: Opciones = {}): Promise<{ ctx: BrowserContext; page: Page; reg: Registro; errores: string[] }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 768 }, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* sin almacenamiento */ } }, tokenSintetico());
  const page = await ctx.newPage();
  const reg = await servirApi(page, op);
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text().slice(0, 200)); });
  return { ctx, page, reg, errores };
}

/** Pedir (`/finanzas/gastos` → «Registrar o pedir»): proveedor frecuente + ticket → «Mandar a firma». */
async function pedir(page: Page, prefijo: string): Promise<void> {
  await page.goto('/finanzas/gastos');
  await expect(page.getByRole('heading', { name: 'Registrar o pedir un gasto' })).toBeVisible({ timeout: 30_000 });
  // Una sola base abierta: queda fija, con su nombre (nunca «05»).
  await expect(page.locator('.pg-suc-fija')).toContainText('Zamora');
  await captura(page, `${prefijo}a-pedir-vacia`);

  // El proveedor frecuente, a un toque: su hábito llena concepto, proyecto, departamento, forma de pago y plazo.
  await page.locator('.pg-chips').getByRole('button', { name: 'Plomería Prueba' }).click();
  // El ticket: se sube y se LEE solo (folio, fecha, IVA e importe).
  await page.locator('.pg-subir input[type=file]').setInputFiles({ name: 'ticket.png', mimeType: 'image/png', buffer: PNG_1PX });
  await expect(page.locator('#pg-folio')).toHaveValue('T-0001', { timeout: 15_000 });

  const barra = page.locator('.pg-barra');
  const listo = await barra.getByText('Listo para firma').waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (!listo) {
    await captura(page, `${prefijo}b-pedir-falta`);
    const faltan = await page.locator('.pg-faltan li').allInnerTexts();
    throw new Error(`«Mandar a firma» no se habilitó. Falta: ${JSON.stringify(faltan)}`);
  }
  await expect(barra).toContainText('$116.00');
  await captura(page, `${prefijo}b-pedir-llena`);
  await barra.getByRole('button', { name: 'Mandar a firma' }).click();
  await expect(page.locator('.pg-hecho')).toContainText('$116.00 espera firma', { timeout: 15_000 });
  await captura(page, `${prefijo}c-pedir-mandada`);
}

/** Ruido conocido del modo sintético: el token sin firma (los sockets lo rechazan), lo abortado a propósito, la CSP de
 *  prod contra la imagen inventada y el beacon de Cloudflare. */
const RUIDO = /cloudflareinsights|WebSocket is already|ejemplo\.invalid|auth_error|ERR_BLOCKED_BY_CLIENT/;

test.describe.configure({ mode: 'serial' });

test('[PGP.122] pedir → firmar → cancelar en Kepler, desde la interfaz (API sintética)', async ({ browser }) => {
  const { ctx, page, reg, errores } = await abrir(browser);
  let etiquetaFila: string | null = null;
  let nombreConfirmar: string | null = null;
  let cortadoAlFirmar: string[] = [];
  let cortadoAlCancelar: string[] = [];

  try {
    // ── 1 · Pedir ────────────────────────────────────────────────────────────────────────────────
    await pedir(page, '1');

    // Lo que la pantalla MANDÓ: es el payload que el servidor valida (y el que la prueba de base real debe usar).
    const c = reg.crear!;
    expect(c).toBeTruthy();
    expect(c['sucursal']).toBe('05');
    expect(c['acreedor']).toBe('GP001');
    expect(c['renglones']).toEqual([{ concepto: 'MANT', proyecto: 'P01', departamento: 'D01', importe: 100 }]);
    expect(c['iva']).toBe(16);
    expect(c['comprobante']).toMatchObject({ tipo: 'ticket', folio: 'T-0001', fecha: hoyMx(), uuid: null });
    expect(c['forma_pago']).toBe('transferencia');
    expect((c['files'] as unknown[]).length).toBe(1);
    expect(String(c['id_cliente'])).toMatch(/^[0-9a-f-]{36}$/);

    // ── 2 · Firmar ───────────────────────────────────────────────────────────────────────────────
    await page.goto('/finanzas/aprobacion-gastos');
    const fila = page.locator('article.ap-item').first();
    await expect(fila).toBeVisible({ timeout: 30_000 });
    etiquetaFila = await fila.getAttribute('aria-label');
    // Sin folio todavía (nace en la Suite): se anuncia de quién y cuánto, no «Ver el vale null».
    expect(etiquetaFila).toBe('Ver el vale sin folio de Plomería Prueba por $116.00');
    await captura(page, '2a-bandeja');
    await fila.click();
    // ANTES del botón, quien firma ve lo que se escribe en Kepler.
    await expect(page.getByText('Al firmarla se escribe en Kepler así:')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.vp-ren')).toContainText('Mantenimiento de local');
    await expect(page.locator('.vp-ren')).toContainText('603-008');
    await captura(page, '2b-vale-abierto');
    cortadoAlFirmar = await fueraDeLaPantalla(page);
    expect(cortadoAlFirmar).toEqual([]);
    await page.getByRole('button', { name: 'Revisado', exact: true }).click();
    await expect(page.getByText(/Nació autorizada/)).toBeVisible({ timeout: 15_000 });
    await captura(page, '2c-firmada');
    expect(reg.aprobar).toBeTruthy();

    // ── 3 · Cancelar en Kepler (F3) ──────────────────────────────────────────────────────────────
    // Las listas se eligen en «Qué lista ver» (un desplegable, no pestañas).
    await page.getByRole('combobox', { name: 'Qué lista ver' }).click();
    await page.getByRole('option', { name: /Esperan a Kepler/ }).click();
    await page.getByRole('button', { name: 'Abrir el vale 0000083' }).click();
    await expect(page.getByText('En Kepler se escribe así:')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Cancelar en Kepler…' }).click();
    // ⚠️ Medido: el nombre accesible del botón trae delante el glifo del ícono de PrimeIcons (« Cancelar en Kepler»).
    const confirmar = page.locator('.vp-cancelar-b').getByRole('button', { name: /Cancelar en Kepler$/ });
    nombreConfirmar = await confirmar.getAttribute('aria-label') ?? await confirmar.innerText();
    await expect(confirmar).toBeDisabled();
    const motivo = 'Prueba: el proveedor repitió el ticket';
    await page.locator('#vp-cancelar-m').fill(motivo);
    await captura(page, '3a-motivo');
    cortadoAlCancelar = await fueraDeLaPantalla(page);
    expect(cortadoAlCancelar).toEqual([]);
    await confirmar.click();
    await expect(page.getByText('Cancelada en Kepler').first()).toBeVisible({ timeout: 15_000 });
    await captura(page, '3b-cancelada');
    expect(reg.cancelar).toEqual({ motivo });
  } finally {
    fs.mkdirSync(RES, { recursive: true });
    const informe = {
      fecha: new Date().toISOString(), base: test.info().project.use.baseURL,
      // Hallazgos que se MIDEN (no se afirman): cómo se anuncia el renglón del vale sin folio y el botón destructivo.
      etiqueta_del_renglon_sin_folio: etiquetaFila, nombre_del_boton_confirmar: nombreConfirmar,
      cortado_a_la_derecha_al_firmar: cortadoAlFirmar, cortado_a_la_derecha_al_cancelar: cortadoAlCancelar,
      payload_crear: reg.crear, payload_aprobar: reg.aprobar, payload_cancelar: reg.cancelar,
      subidas: reg.subidas, servidas: reg.servidas, abortadas: reg.abortadas, desconocidas: [...new Set(reg.desconocidas)], salieron: reg.salieron,
      errores_de_pagina: errores.slice(0, 30),
    };
    fs.writeFileSync(path.join(RES, 'informe.json'), JSON.stringify(informe, null, 2));
    console.log(JSON.stringify({ ...informe, payload_crear: reg.crear ? '(en informe.json)' : null }, null, 1));
    await ctx.close();
  }
  // ⛔ El blindaje: nada salió del navegador.
  expect(reg.salieron).toEqual([]);
  // Ningún endpoint quedó sin contestar con su forma, y la pantalla no tronó (fuera del RUIDO conocido).
  expect([...new Set(reg.desconocidas)]).toEqual([]);
  expect(errores.filter((e) => !RUIDO.test(e))).toEqual([]);
});

test('[PGP.122] Kepler rechaza al firmar → el vale se encuentra y se reintenta, desde la interfaz', async ({ browser }) => {
  const { ctx, page, reg, errores } = await abrir(browser, { kepler: 'rechaza' });
  const visto: Record<string, unknown> = {};
  try {
    await pedir(page, 'r1');

    // ── Firmar: Kepler la rechaza ────────────────────────────────────────────────────────────────
    await page.goto('/finanzas/aprobacion-gastos');
    const fila = page.locator('article.ap-item').first();
    await expect(fila).toBeVisible({ timeout: 30_000 });
    await fila.click();
    await expect(page.getByText('Al firmarla se escribe en Kepler así:')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Revisado', exact: true }).click();
    // El rechazo se DICE, con el motivo de Kepler, y no se va solo (sticky).
    const aviso = page.locator('.p-toast-message').filter({ hasText: 'Kepler no la aceptó' });
    await expect(aviso).toBeVisible({ timeout: 15_000 });
    await expect(aviso).toContainText(NOTA_RECHAZO);
    visto['aviso'] = (await aviso.innerText()).replace(/\s+/g, ' ');
    await captura(page, 'r2-rechazo');

    // Medición (no falla): ¿la bandeja del día todavía lo muestra y desde ahí se reintenta? Es un camino de HOY nada más:
    // la bandeja es del día, mañana el vale ya no está ahí.
    const enBandeja = page.locator('article.ap-item').filter({ hasText: 'Plomería Prueba' });
    visto['en_bandeja_de_hoy'] = await enBandeja.count();
    if (visto['en_bandeja_de_hoy']) {
      await enBandeja.first().click();
      visto['bandeja_ofrece_reintentar'] = await page.getByRole('button', { name: /Reintentar en Kepler$/ }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
      await captura(page, 'r2b-desde-la-bandeja');
      await page.keyboard.press('Escape');
    }
    // Medición (no falla): ¿el buscador de arriba lo encuentra por el proveedor y desde ahí se reintenta?
    const caja = page.getByRole('searchbox', { name: 'Buscar en todos los gastos' });
    visto['hay_buscador'] = await caja.count();
    if (visto['hay_buscador']) {
      await caja.fill('Plomería');
      const hallado = page.locator('.bg-resultados tr').filter({ hasText: 'Plomería Prueba' });
      visto['buscador_lo_encuentra'] = await hallado.first().waitFor({ timeout: 8_000 }).then(() => true, () => false);
      if (visto['buscador_lo_encuentra']) {
        visto['buscador_renglon'] = (await hallado.first().innerText()).replace(/\s+/g, ' ');
        await hallado.first().click();
        visto['buscador_ofrece_reintentar'] = await page.getByRole('button', { name: /Reintentar en Kepler$/ }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
        await captura(page, 'r2c-desde-el-buscador');
        await page.keyboard.press('Escape');
      }
      await caja.fill('');
    }

    // ── Encontrarlo. El aviso dice «ábrelo y usa Reintentar en Kepler»; lo firmado que no cierra vive en «Esperan a Kepler».
    await page.getByRole('combobox', { name: 'Qué lista ver' }).click();
    await page.getByRole('option', { name: /Esperan a Kepler/ }).click();
    const renglon = page.locator('.ap-kep').filter({ hasText: 'Plomería Prueba' });
    await expect(renglon).toHaveCount(1, { timeout: 15_000 });
    // Si cayó en un grupo plegado, se despliega como lo haría la persona (y se anota en cuál cayó).
    const plegado = page.locator('details.ap-kep-pleg', { has: renglon });
    if (await plegado.count()) {
      visto['grupo_plegado'] = (await plegado.locator('summary').innerText()).replace(/\s+/g, ' ');
      await plegado.locator('summary').click();
    }
    await expect(renglon).toBeVisible({ timeout: 5_000 });
    visto['renglon_en_esperan_a_kepler'] = (await renglon.innerText()).replace(/\s+/g, ' ');
    visto['botones_del_renglon'] = await renglon.getByRole('button').allInnerTexts();
    await captura(page, 'r3-esperan-kepler');
    // A la vista (no plegado), en su sección, diciendo lo que pasó (Kepler la rechazó, con su motivo) y no «no se pudo
    // leer». Soft, para medir también lo de abajo en la misma corrida.
    expect.soft(visto['grupo_plegado'], 'el rechazo no va plegado').toBeUndefined();
    expect.soft(page.locator('section.ap-kep-sec', { has: renglon }).locator('h3'), 'su sección').toContainText('Su solicitud todavía no está en Kepler');
    expect.soft(renglon, 'el renglón debe decir que Kepler la rechazó').not.toContainText('No se pudo leer su estado en Kepler');
    expect.soft(renglon, 'el renglón debe decir que Kepler la rechazó').toContainText('Kepler: no la aceptó');
    expect.soft(renglon, 'el renglón debe traer el motivo de Kepler').toContainText(NOTA_RECHAZO);
    // Y se puede abrir (el aviso dice «ábrelo»), anunciado por de quién y cuánto.
    await renglon.getByRole('button', { name: 'Abrir el vale sin folio de Plomería Prueba por $116.00', exact: true }).click({ timeout: 5_000 });

    // ── Reintentar ───────────────────────────────────────────────────────────────────────────────
    const reintentar = page.getByRole('button', { name: /Reintentar en Kepler$/ });
    await expect(reintentar).toBeVisible({ timeout: 15_000 });
    await reintentar.click();
    await expect(page.locator('.p-toast-message').filter({ hasText: 'Escrita en Kepler' })).toContainText('0000083', { timeout: 15_000 });
    await captura(page, 'r4-reintentada');
    expect(reg.reintentos).toBe(1);
  } finally {
    fs.mkdirSync(RES, { recursive: true });
    const informe = {
      fecha: new Date().toISOString(), visto, reintentos: reg.reintentos, desconocidas: [...new Set(reg.desconocidas)], salieron: reg.salieron,
      errores_de_pagina: errores.filter((e) => !RUIDO.test(e)).slice(0, 30),
    };
    fs.writeFileSync(path.join(RES, 'informe-rechazo.json'), JSON.stringify(informe, null, 2));
    console.log(JSON.stringify(informe, null, 1));
    await ctx.close();
  }
  expect(reg.salieron).toEqual([]);
  expect([...new Set(reg.desconocidas)]).toEqual([]);
  expect(errores.filter((e) => !RUIDO.test(e))).toEqual([]);
});
