import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { servirApi, tokenSintetico, hoyMx, type Registro } from './api-sintetica';

/**
 * `[PGP.122]` La solicitud de gasto recorrida DESDE LA INTERFAZ, como la usa la gente:
 *
 *   1. Pedir (`/finanzas/gastos` → «Registrar o pedir»): elegir el proveedor frecuente, subir el ticket y mandar a
 *      firma. La Suite llena el resto (hábito del proveedor + lectura del ticket).
 *   2. Firmar (`/finanzas/aprobacion-gastos`): abrir el vale, ver ANTES del botón lo que se escribe en Kepler, y
 *      «Revisado». La API contesta «escrita en Kepler, folio 0000083».
 *   3. Cancelar en Kepler (F3): desde «Esperan a Kepler», abrir el vale y cancelarlo con motivo.
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
 * Los textos con contenido propio cuyo borde derecho cae fuera de la ventana (se cortan y no se pueden leer). Se MIDE
 * y se declara en `informe.json`; no frena. Medido el 2026-11-18: con el vale de la Suite que espera firma salen 12
 * textos (de 9 a 21 px), y con la misma solicitud ya escrita, ninguno; el instrumento distingue los dos casos.
 */
async function fueraDeLaPantalla(page: Page): Promise<string[]> {
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

test.describe.configure({ mode: 'serial' });

test('[PGP.122] pedir → firmar → cancelar en Kepler, desde la interfaz (API sintética)', async ({ browser }) => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 768 }, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* sin almacenamiento */ } }, tokenSintetico());
  const page = await ctx.newPage();
  const reg: Registro = await servirApi(page);
  const errores: string[] = [];
  let etiquetaFila: string | null = null;
  let nombreConfirmar: string | null = null;
  let cortadoAlFirmar: string[] = [];
  let cortadoAlCancelar: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text().slice(0, 200)); });

  try {
    // ── 1 · Pedir ────────────────────────────────────────────────────────────────────────────────
    await page.goto('/finanzas/gastos');
    await expect(page.getByRole('heading', { name: 'Registrar o pedir un gasto' })).toBeVisible({ timeout: 30_000 });
    // Una sola base abierta: queda fija, con su nombre (nunca «05»).
    await expect(page.locator('.pg-suc-fija')).toContainText('Zamora');
    await captura(page, '1a-pedir-vacia');

    // El proveedor frecuente, a un toque: su hábito llena concepto, proyecto, departamento, forma de pago y plazo.
    await page.locator('.pg-chips').getByRole('button', { name: 'Plomería Prueba' }).click();
    // El ticket: se sube y se LEE solo (folio, fecha, IVA e importe).
    await page.locator('.pg-subir input[type=file]').setInputFiles({ name: 'ticket.png', mimeType: 'image/png', buffer: PNG_1PX });
    await expect(page.locator('#pg-folio')).toHaveValue('T-0001', { timeout: 15_000 });

    const barra = page.locator('.pg-barra');
    const listo = await barra.getByText('Listo para firma').waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!listo) {
      await captura(page, '1b-pedir-falta');
      const faltan = await page.locator('.pg-faltan li').allInnerTexts();
      throw new Error(`«Mandar a firma» no se habilitó. Falta: ${JSON.stringify(faltan)}`);
    }
    await expect(barra).toContainText('$116.00');
    await captura(page, '1b-pedir-llena');
    await barra.getByRole('button', { name: 'Mandar a firma' }).click();
    await expect(page.locator('.pg-hecho')).toContainText('$116.00 espera firma', { timeout: 15_000 });
    await captura(page, '1c-pedir-mandada');

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
    await captura(page, '2a-bandeja');
    await fila.click();
    // ANTES del botón, quien firma ve lo que se escribe en Kepler.
    await expect(page.getByText('Al firmarla se escribe en Kepler así:')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.vp-ren')).toContainText('Mantenimiento de local');
    await expect(page.locator('.vp-ren')).toContainText('603-008');
    await captura(page, '2b-vale-abierto');
    cortadoAlFirmar = await fueraDeLaPantalla(page);
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
  // Ningún endpoint quedó sin contestar con su forma, y la pantalla no tronó. Lo que se filtra es ruido conocido del
  // modo sintético: el token sin firma (los sockets lo rechazan), lo abortado a propósito, la CSP de prod contra la
  // imagen inventada y el beacon de Cloudflare.
  expect([...new Set(reg.desconocidas)]).toEqual([]);
  const ruido = /cloudflareinsights|WebSocket is already|ejemplo\.invalid|auth_error|ERR_BLOCKED_BY_CLIENT/;
  expect(errores.filter((e) => !ruido.test(e))).toEqual([]);
});
