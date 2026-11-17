import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { sesion, contexto, blindar, quieta } from './comun';

/**
 * `[GP.10.5]` La lista del Tablero, medida en la pantalla viva (`FASE_GP_AUDITORIA_INTERFACES.md` §5.5).
 *
 * Tres preguntas, a tres anchos:
 *  1. ¿Cuánto pesa lo que baja la lista, trae `pagina` y se topa? (antes: 1.40 MB, 2,000 de 2,348).
 *  2. ¿En cuántas filas el volumen («16 CJA · 58 PAQ») se encima sobre la etiqueta de etapa o se sale
 *     de su celda? Se mide con las cajas reales del navegador, no a ojo.
 *  3. ¿Qué unidades aparecen en la página? (lo que la leyenda tiene que explicar).
 * Sólo lectura: lo que no es GET se aborta (blindar).
 */

const RES = path.join(__dirname, '.resultados');
const ANCHOS = [1280, 1366, 1920];

async function encimados(page: Page) {
  return page.evaluate(() => {
    const filas = Array.from(document.querySelectorAll('section.gp-block p-table tbody tr'));
    let medidas = 0;
    const malas: string[] = [];
    const unidades = new Set<string>();
    for (const tr of filas) {
      const vol = tr.querySelector('.gp-vol') as HTMLElement | null;
      const tag = tr.querySelector('td[data-label="Etapa"] .p-tag, td[data-label="Etapa"] p-tag') as HTMLElement | null;
      if (!vol || !vol.textContent?.trim()) continue;
      medidas++;
      for (const m of vol.textContent.matchAll(/\d[\d,.]*\s+(?:de\s+)?([A-Z0-9]+)/g)) unidades.add(m[1]);
      // ⛔ Se mide el TEXTO pintado (sus rectángulos de línea), no la caja del elemento. La primera
      // versión medía la caja: con `white-space: nowrap` el texto se salía de sus 11rem y la caja no,
      // así que contó 0 de 200 mientras Edgar veía el encimado en su pantalla (2026-11-17).
      const rg = document.createRange();
      rg.selectNodeContents(vol);
      const lineas = Array.from(rg.getClientRects()).filter((r) => r.width > 0);
      const v = lineas.reduce(
        (a, r) => ({ left: Math.min(a.left, r.left), right: Math.max(a.right, r.right), top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom) }),
        { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
      );
      const td = (vol.closest('td') as HTMLElement).getBoundingClientRect();
      const t = tag?.getBoundingClientRect();
      const choca = !!t && v.left < t.right && v.right > t.left && v.top < t.bottom && v.bottom > t.top;
      const fuera = v.right > td.right + 0.5 || v.left < td.left - 0.5;
      if (choca || fuera) malas.push(`${(tr.querySelector('td') as HTMLElement)?.innerText.split('\n')[0]}: ${vol.textContent.trim()}${choca ? ' [choca]' : ''}${fuera ? ' [fuera]' : ''}`);
    }
    return { filas: filas.length, medidas, encimadas: malas.length, ejemplos: malas.slice(0, 5), unidades: [...unidades].sort() };
  });
}

test.describe('[GP.10.5] la lista del Tablero', () => {
  test.use({ actionTimeout: 10_000 });
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('peso, página y volumen encimado, a tres anchos', async ({ browser }) => {
    // Tres cargas completas del Tablero (antes de GP.10.5, ~7 s cada una con 1.4 MB): no caben en 90 s.
    test.setTimeout(300_000);
    fs.mkdirSync(RES, { recursive: true });
    const salida: Record<string, unknown>[] = [];
    for (const ancho of ANCHOS) {
      const ctx = await contexto(browser, s.token);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: ancho, height: ancho === 1920 ? 1080 : 768 });
      await blindar(page);
      let lista: { bytes: number; items: number; truncado: boolean; pagina: unknown; total: number } | null = null;
      page.on('response', async (r) => {
        const u = new URL(r.url());
        if (r.request().method() !== 'GET' || !/\/api\/warehouse\/orders$/.test(u.pathname) || lista) return;
        try {
          const txt = await r.text();
          const d = JSON.parse(txt);
          lista = { bytes: txt.length, items: d.items.length, truncado: d.truncado, pagina: d.pagina ?? null, total: d.totales?.pedidos };
        } catch { /* una respuesta que no se pudo leer queda null: NO MEDIDO */ }
      });
      const t0 = Date.now();
      await page.goto('/almacen/pedidos');
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 });
      await page.locator('section.gp-block p-table tbody tr').first().waitFor({ timeout: 30_000 });
      const q = await quieta(page, t0);
      const e = await encimados(page);
      const paginador = await page.locator('.p-paginator').count();
      const reporte = (await page.locator('.p-paginator-current').first().textContent().catch(() => null))?.trim() ?? null;
      const leyenda = (await page.locator('.gp-leyenda').first().textContent().catch(() => null))?.replace(/\s+/g, ' ').trim() ?? null;
      await page.screenshot({ path: path.join(RES, `gp105-${ancho}.png`) });
      // [GP.RF.22] MAQUETA del arreglo mientras prod no lo trae: lo mismo que hace la plantilla nueva
      // (el volumen sin la clase `.num`, cuyo nowrap ganaba). Si prod ya lo trae, no cambia nada.
      const conNum = await page.evaluate(() => {
        const v = Array.from(document.querySelectorAll('.gp-vol.num'));
        v.forEach((e) => e.classList.remove('num'));
        return v.length;
      });
      const arreglo = await encimados(page);
      // CONTROL NEGATIVO del instrumento: corrido a propósito hacia la columna Etapa, el volumen
      // TIENE que contarse como encimado. Si el instrumento da cero aquí, su cero de arriba no vale.
      await page.addStyleTag({ content: '.gp-vol { position: relative !important; left: 9rem !important; }' });
      const control = await encimados(page);
      salida.push({ ancho, lista, quieta_ms: q.ms, seguia_cargando: q.seguia_cargando, ...e, maqueta_aplicada_a: conNum, encimadas_con_arreglo: arreglo.encimadas, control_encimadas: control.encimadas, paginador, reporte, leyenda });
      await ctx.close();
    }
    const modo = salida.some((x) => (x['lista'] as { pagina: unknown } | null)?.pagina) ? 'despues' : 'antes';
    fs.writeFileSync(path.join(RES, `gp105-${modo}.json`), JSON.stringify({ medido: new Date().toISOString(), modo, salida }, null, 2));
    // El instrumento tiene que haber medido algo: sin filas con volumen no hay pregunta 2.
    expect(salida.every((x) => (x['medidas'] as number) > 0), 'hubo filas con volumen que medir').toBe(true);
    expect(salida.every((x) => (x['control_encimadas'] as number) > 0), 'el control negativo se detecta').toBe(true);
  });
});
