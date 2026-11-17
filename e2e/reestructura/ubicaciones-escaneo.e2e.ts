import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { sesion, contexto, quieta } from './comun';

/**
 * `[UB.3b]` + `[UB.RF.10]` Escanear para asignar y los carteles, en la pantalla viva de prod.
 *
 * Mientras prod no traiga estos cambios, cada prueba lo detecta y se SALTA diciendo NO MEDIDO: no se
 * finge un verde. Sin escribir en prod: las escrituras se detienen y se registra lo que habrían mandado.
 *
 * El lector de código de barras «teclea» y manda Enter; aquí se hace igual (`fill` + Enter).
 * Código real medido en CEDIS (2026-11-17): AVILA MAZAPAN 40, paquete 7502212930012, caja C07302.
 */

const RES = path.join(__dirname, '.resultados', 'ub-escaneo');

async function blindar(page: Page) {
  const detenidas: { metodo: string; ruta: string; cuerpo: string }[] = [];
  await page.route('**/api/**', (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.continue();
    const ruta = new URL(req.url()).pathname;
    if (!ruta.includes('/telemetry/')) detenidas.push({ metodo: req.method(), ruta, cuerpo: req.postData() ?? '' });
    return r.abort('blockedbyclient');
  });
  return detenidas;
}

async function elegirAlmacen(page: Page, contenedor: string, re: RegExp, meta: string) {
  const sel = page.locator(`${contenedor} p-select`).first();
  if (!(await sel.count())) return;
  await sel.click();
  await page.getByRole('option').filter({ hasText: re }).first().click();
  await page.locator(meta).filter({ hasText: re }).first().waitFor({ timeout: 20_000 });
  await quieta(page);
}

test.describe('UB · escanear para asignar y carteles', () => {
  test.use({ actionTimeout: 10_000 });
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('escanear la ubicación y luego el producto asigna la presentación del código', async ({ browser }) => {
    fs.mkdirSync(RES, { recursive: true });
    const ctx = await contexto(browser, s.token);
    const page = await ctx.newPage();
    const detenidas = await blindar(page);
    await page.goto('/almacen/ubicaciones/asignacion');
    await page.getByRole('heading', { name: 'Asignación', level: 1 }).waitFor({ timeout: 30_000 });
    await quieta(page);
    const escanear = page.getByRole('button', { name: 'Escanear' });
    test.skip(!(await escanear.count()), 'NO MEDIDO: prod todavía no trae «Escanear» (UB.3b); se mide al desplegar');
    await elegirAlmacen(page, '.as-actions', /CEDIS/, '.as-meta');
    await escanear.click();
    const campo = page.locator('#cs-in');
    await campo.waitFor({ timeout: 10_000 });
    await expect(campo, 'el campo queda listo para el lector').toBeFocused();
    // 1) el cartel de una ubicación que existe en CEDIS (zona Tienda → exhibición)
    await campo.fill('TA011');
    await campo.press('Enter');
    await expect(page.locator('.cs-code')).toHaveText('TA011');
    await page.screenshot({ path: path.join(RES, '01-ubicacion.png') });
    // 2) el código de barras del paquete
    await campo.fill('7502212930012');
    await campo.press('Enter');
    await page.waitForTimeout(2500);
    const post = detenidas.find((d) => d.ruta.endsWith('/warehouse/locations/assignments'));
    await page.screenshot({ path: path.join(RES, '02-producto.png') });
    fs.writeFileSync(path.join(RES, 'escaneo.json'), JSON.stringify({ detenidas, aviso: await page.locator('.cs-msg').innerText().catch(() => '') }, null, 2));
    expect(post, 'escanear el producto intentó asignar (y se detuvo antes de salir)').toBeTruthy();
    expect(JSON.parse(post!.cuerpo)).toMatchObject({ presentacion: 1, papel: 'exhibicion_tienda', bin_code: 'TA011' });
    // 3) una ubicación que no existe se ofrece dar de alta
    await campo.fill('BZ991');
    await campo.press('Enter');
    await expect(page.getByRole('button', { name: /Darla de alta como surtido/ })).toBeVisible();
    await page.screenshot({ path: path.join(RES, '03-alta.png') });
    await ctx.close();
  });

  test('los carteles: de un rack y de un pasillo, con su código de barras', async ({ browser }) => {
    fs.mkdirSync(RES, { recursive: true });
    const ctx = await contexto(browser, s.token);
    const page = await ctx.newPage();
    const detenidas = await blindar(page);
    await page.goto('/almacen/ubicaciones');
    await page.getByRole('heading', { name: 'Ubicaciones', level: 1 }).waitFor({ timeout: 30_000 });
    await quieta(page);
    const imprimir = page.getByRole('button', { name: 'Imprimir carteles' });
    test.skip(!(await imprimir.count()), 'NO MEDIDO: prod todavía no trae «Imprimir carteles» (UB.RF.10); se mide al desplegar');
    await elegirAlmacen(page, '.ub-actions', /CEDIS/, '.ub-meta');
    // El rack: tocarlo y pedir sus carteles.
    await page.locator('.ub-cell.ub-c-activa').first().click();
    const niveles = await page.locator('.ub-levels .ub-level').count();
    await page.getByRole('button', { name: 'Imprimir los carteles de este rack' }).click();
    await expect(page.locator('.ct-cartel')).toHaveCount(niveles);
    await expect(page.locator('svg.ct-bar rect').first(), 'el código de barras se dibujó').toBeVisible();
    await page.screenshot({ path: path.join(RES, '04-carteles-rack.png') });
    await page.getByRole('button', { name: 'Seguir sin imprimir' }).click();
    // El pasillo A completo.
    await imprimir.click();
    await page.getByRole('radio', { name: /Pasillo A/ }).click();
    const ver = page.getByRole('button', { name: /^Ver \d+ carteles?$/ });
    const n = Number(((await ver.innerText()).match(/\d+/) || ['0'])[0]);
    await ver.click();
    await expect(page.locator('.ct-cartel')).toHaveCount(n);
    await page.screenshot({ path: path.join(RES, '05-carteles-pasillo.png') });
    expect(detenidas.filter((d) => !d.ruta.includes('telemetry')), 'imprimir no escribe nada').toEqual([]);
    await ctx.close();
  });
});
