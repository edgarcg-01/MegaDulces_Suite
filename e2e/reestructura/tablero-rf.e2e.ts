import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { contexto } from './comun';
import { LOCAL } from './desvio';
import { servirSintetico, tokenSintetico } from './sintetico';

/**
 * `[GP.RF.16]` `[GP.RF.21]` El Tablero en el navegador, sobre la API sintética (datos inventados,
 * ninguna petición sale del navegador):
 *  - el aviso de los atorados: dice cuántos y dónde, y «Velos» lleva la frontera de la cuenta;
 *  - el botón «Preventa» con su número: un toque pide sólo la preventa (antes, desplegable + opción);
 *  - control: los atorados se piden UNA vez (no en cada filtro);
 *  - control: ningún texto del aviso ni del botón queda encimado o cortado.
 *
 *   E2E_LOCAL_URL=http://localhost:4200 npx playwright test -c e2e/reestructura/playwright.config.ts tablero-rf
 */
const RES = path.join(__dirname, '.resultados');

test.describe('[GP.RF.16][GP.RF.21] Tablero: atorados y preventa a un toque', () => {
  test.skip(!LOCAL, 'NO MEDIDO: sin E2E_LOCAL_URL no hay frontend de este árbol');

  test('aviso, liga, botón y sus controles', async ({ browser }) => {
    fs.mkdirSync(RES, { recursive: true });
    const ctx = await contexto(browser, tokenSintetico(), false);
    const page = await ctx.newPage();
    const reg = await servirSintetico(page);
    const pedidas: string[] = [];
    page.on('request', (q) => { const u = new URL(q.url()); if (/\/warehouse\/orders/.test(u.pathname)) pedidas.push(u.pathname.replace(/^.*?\/api/, '') + u.search); });

    await page.goto(LOCAL + '/almacen/pedidos');
    const aviso = page.locator('.gp-note-warn').first();
    await aviso.waitFor({ timeout: 30_000 });
    const texto = (await aviso.innerText()).replace(/\s+/g, ' ');
    expect(texto).toContain('396 pedidos siguen autorizados en Kepler desde el 29/11/2025');
    expect(texto).toContain('en 3 sucursales (288 en Zamora Centro)');
    const href = await aviso.getByRole('link', { name: 'Velos' }).getAttribute('href');
    expect(href).toContain('kepler_status=AUTORIZADO');
    expect(href).toContain('date_from=2025-11-29');

    const chip = page.getByRole('button', { name: /^Preventa\s+2$/ });
    await chip.waitFor();
    const caja = await chip.boundingBox();
    const antes = pedidas.filter((x) => x.startsWith('/warehouse/orders?')).length;
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('td[data-label="Pedido"] .mono').first()).toHaveText(/^PD-/);
    const despues = pedidas.filter((x) => x.startsWith('/warehouse/orders?'));
    expect(despues.length).toBeGreaterThan(antes);
    expect(despues.at(-1)).toContain('origin=PREVENTA');

    // Controles.
    const veces = pedidas.filter((x) => x.startsWith('/warehouse/orders/atorados')).length;
    expect(veces, 'los atorados se piden una vez, no en cada filtro').toBe(1);
    const cortado = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.gp-note-warn span, .gp-filters .gp-chip')] as HTMLElement[];
      return els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent?.trim().slice(0, 40));
    });
    expect(cortado, 'nada del aviso ni del botón queda cortado').toEqual([]);
    expect(reg.salieron, 'control: ninguna petición salió del navegador').toEqual([]);

    await page.screenshot({ path: path.join(RES, 'tablero-rf.png') });
    fs.writeFileSync(path.join(RES, 'tablero-rf.json'), JSON.stringify({ medido_at: new Date().toISOString(), aviso: texto, href, chip_px: caja, pedidas }, null, 2));
    await ctx.close();
  });
});
