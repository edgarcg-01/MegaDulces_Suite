import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { contexto } from './comun';
import { LOCAL } from './desvio';
import { servirSintetico, tokenSintetico } from './sintetico';

/**
 * `[GP.RF.12]` Revisión en caja (`/almacen/pedidos/revision`) en el celular: cuántos TAMAÑOS de letra
 * distintos hay a la vista (la auditoría contó 9), cuál es el más chico y qué texto de color no llega a
 * AA. API sintética (datos inventados, ninguna petición sale del navegador).
 *
 *   E2E_LOCAL_URL=http://localhost:4200 E2E_ETIQUETA=antes npx playwright test -c e2e/reestructura/playwright.config.ts revision-letra
 */
const RES = path.join(__dirname, '.resultados');
const ETIQUETA = process.env.E2E_ETIQUETA || 'medicion';

async function niveles(page: Page) {
  return page.evaluate(() => {
    const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const fondo = (el: Element | null): string => { while (el) { const b = getComputedStyle(el).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b; el = el.parentElement; } return 'rgb(255, 255, 255)'; };
    const tam: Record<string, { n: number; ej: string[] }> = {};
    const bajos: string[] = [];
    for (const el of Array.from(document.querySelectorAll('main *')) as HTMLElement[]) {
      const t = Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
      if (!t) continue;
      const b = el.getBoundingClientRect(); if (!b.width || !b.height || b.top > innerHeight * 3) continue;
      const cs = getComputedStyle(el);
      const k = `${parseFloat(cs.fontSize)}px`;
      tam[k] ??= { n: 0, ej: [] }; tam[k].n++; if (tam[k].ej.length < 3) tam[k].ej.push(t.slice(0, 24));
      const [a, c] = [L(rgb(cs.color)), L(rgb(fondo(el)))].sort((x, y) => y - x);
      const r = (a + 0.05) / (c + 0.05);
      const grande = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
      if (r < (grande ? 3 : 4.5)) bajos.push(`${t.slice(0, 24)} ${r.toFixed(2)}`);
    }
    const orden = Object.keys(tam).sort((x, y) => parseFloat(y) - parseFloat(x));
    return { niveles: orden.length, tamaños: orden.map((k) => `${k} ×${tam[k].n} (${tam[k].ej.join(' | ')})`), mas_chico: orden.at(-1), contraste_bajo: [...new Set(bajos)] };
  });
}

test.describe('[GP.RF.12] Revisión: niveles de letra y contraste', () => {
  test.skip(!LOCAL, 'NO MEDIDO: sin E2E_LOCAL_URL no hay frontend de este árbol');

  test('lista y pedido abierto, a 390 px', async ({ browser }) => {
    fs.mkdirSync(RES, { recursive: true });
    const ctx = await contexto(browser, tokenSintetico(), true);
    const page = await ctx.newPage();
    const reg = await servirSintetico(page);
    await page.goto(LOCAL + '/almacen/pedidos/revision');
    await page.getByText('Abarrotes Revisión 1').first().waitFor({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const lista = await niveles(page);
    await page.screenshot({ path: path.join(RES, `revision-${ETIQUETA}-lista.png`) });
    await page.getByText('Abarrotes Revisión 1').first().click();
    await page.getByText('Producto de revisión 1', { exact: false }).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    const pedido = await niveles(page);
    await page.screenshot({ path: path.join(RES, `revision-${ETIQUETA}-pedido.png`) });
    const salida = { medido_at: new Date().toISOString(), etiqueta: ETIQUETA, lista, pedido };
    console.log(JSON.stringify(salida, null, 1));
    fs.writeFileSync(path.join(RES, `revision-letra-${ETIQUETA}.json`), JSON.stringify(salida, null, 2));
    expect(reg.salieron, 'control: ninguna petición salió del navegador').toEqual([]);
    await ctx.close();
  });
});
