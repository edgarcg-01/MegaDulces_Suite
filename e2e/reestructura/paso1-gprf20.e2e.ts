import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { medir } from './medir';
import { sesion, contexto, blindar, quieta } from './comun';

/**
 * `[GP.RF.20]` El cambio de vista «Pedidos · Fila de surtido» sube de su renglón propio a la cabecera
 * del Tablero, junto al periodo (`FASE_GP_AUDITORIA_INTERFACES.md` §5.5).
 *
 * Mientras el cambio no esté en prod, esta prueba es una **MAQUETA sobre la pantalla viva**: abre el
 * Tablero real (datos y CSS de prod), mide, mueve el `nav` a la cabecera tal como lo hace la plantilla
 * nueva y vuelve a medir. Cuando prod ya lo traiga, lo detecta y mide la versión REAL; el JSON dice
 * cuál de las dos fue (`modo`).
 *
 * La pregunta: ¿cuántos px sube la primera fila, y la cabecera NO se parte en un renglón más (que se
 * comería la ganancia)? Se mide a tres anchos: laptop chica, la de la oficina y un monitor.
 */

const RES = path.join(__dirname, '.resultados');
const ANCHOS = [1280, 1366, 1920];

/** Alto de la cabecera y cuántos renglones ocupan sus acciones (por la posición de cada una). */
async function cabecera(page: Page): Promise<{ alto: number; renglones_acciones: number }> {
  return page.evaluate(() => {
    const h = document.querySelector('header.gp-head') as HTMLElement | null;
    const acc = document.querySelector('header .gp-actions') as HTMLElement | null;
    // Un renglón nuevo empieza cuando una pieza arranca DEBAJO del fondo del renglón actual (las piezas
    // de un mismo renglón tienen alturas distintas: contar sus «top» distintos contaba de más).
    const cajas = Array.from(acc?.children ?? []).map((c) => (c as HTMLElement).getBoundingClientRect()).filter((r) => r.height > 0).sort((a, b) => a.top - b.top);
    let renglones = 0;
    let fondo = -Infinity;
    for (const r of cajas) {
      if (r.top >= fondo - 1) { renglones++; fondo = r.bottom; } else fondo = Math.max(fondo, r.bottom);
    }
    return { alto: Math.round(h?.getBoundingClientRect().height ?? 0), renglones_acciones: renglones };
  });
}

/** La maqueta: hace en el DOM lo mismo que la plantilla de GP.RF.20 (mismas clases y el atributo de estilos de Angular). */
async function subirAlaCabecera(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const vieja = document.querySelector('nav.gp-vistas') as HTMLElement | null;
    const acc = document.querySelector('header .gp-actions') as HTMLElement | null;
    const periodo = acc?.querySelector('.gp-seg[aria-label="Periodo"]') as HTMLElement | null;
    if (!vieja || !acc || !periodo || acc.contains(vieja)) return false;
    // Los estilos del componente se aplican por el atributo _ngcontent-*: se copia el del periodo.
    const ng = Array.from(periodo.attributes).filter((a) => a.name.startsWith('_ngcontent'));
    const marca = (el: Element) => ng.forEach((a) => el.setAttribute(a.name, a.value));
    // El CSS, igual que el diff de GP.RF.20: se BORRAN las reglas viejas de `.gp-vista`/`.gp-vistas`
    // (su alto de 44 px y su subrayado ganaban sobre el segmentado: la primera maqueta salió 11 px más
    // alta y con «Pedidos» negro sobre negro) y se agrega la nueva `a.gp-vista`.
    for (const hoja of Array.from(document.styleSheets)) {
      let reglas: CSSRuleList;
      try { reglas = hoja.cssRules; } catch { continue; }
      for (let i = reglas.length - 1; i >= 0; i--) {
        const sel = (reglas[i] as CSSStyleRule).selectorText ?? '';
        if (/\.gp-vistas?\b/.test(sel) && !/\.gp-seg-b/.test(sel)) hoja.deleteRule(i);
      }
    }
    const attr = ng[0]?.name;
    const css = document.createElement('style');
    css.textContent = `a.gp-vista${attr ? `[${attr}]` : ''} { display:inline-flex; align-items:center; text-decoration:none; font-weight:600; }`;
    document.head.appendChild(css);
    const nav = document.createElement('nav');
    nav.className = 'gp-seg gp-vistas';
    nav.setAttribute('aria-label', 'Vista');
    marca(nav);
    for (const a of Array.from(vieja.querySelectorAll('a'))) {
      const b = a.cloneNode(true) as HTMLAnchorElement;
      b.className = 'gp-seg-b gp-vista' + (a.classList.contains('on') ? ' on' : '');
      marca(b);
      nav.appendChild(b);
    }
    acc.insertBefore(nav, periodo);
    vieja.remove();
    return true;
  });
}

test.describe('1 · GP.RF.20 · el cambio de vista sube a la cabecera', () => {
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('la primera fila sube y la cabecera no se parte, a 1280, 1366 y 1920 px', async ({ browser, request }) => {
    test.setTimeout(4 * 60_000);
    const commit = await request.get('/api/health').then((r) => r.json()).then((j) => j.commit as string, () => 'NO MEDIDO');
    fs.mkdirSync(path.join(RES, 'paso1'), { recursive: true });
    const filas: Record<string, unknown>[] = [];
    for (const ancho of ANCHOS) {
      const ctx = await contexto(browser, s.token);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: ancho, height: 768 });
      const b = await blindar(page);
      await page.goto('/almacen/pedidos');
      await page.locator('nav.gp-vistas').first().waitFor({ timeout: 30_000 });
      await page.locator('tbody tr').first().waitFor({ timeout: 30_000 });
      await quieta(page);
      const real = await page.locator('header nav.gp-vistas').count() > 0;
      const antes = { ...(await cabecera(page)), marco_px: (await medir(page)).marco_px };
      await page.screenshot({ path: path.join(RES, 'paso1', `gprf20-${ancho}-antes.png`) });
      let despues: Record<string, unknown> = antes;
      if (!real) {
        const hecho = await subirAlaCabecera(page);
        expect(hecho, 'la maqueta encontró el renglón de vistas y la cabecera').toBe(true);
        await page.waitForTimeout(300);
        despues = { ...(await cabecera(page)), marco_px: (await medir(page)).marco_px };
        await page.screenshot({ path: path.join(RES, 'paso1', `gprf20-${ancho}-despues.png`) });
      }
      // Que las ligas sigan llevando a donde llevaban (la maqueta no puede romper la navegación).
      const ligas = await page.locator('nav.gp-vistas a').evaluateAll((as) => as.map((a) => `${a.textContent?.trim()}→${a.getAttribute('href')}${a.getAttribute('aria-current') ? '*' : ''}`));
      filas.push({ ancho, modo: real ? 'real (prod ya lo trae)' : 'maqueta sobre prod', antes, despues, gana_px: Number(antes.marco_px) - Number(despues['marco_px']), ligas, escrituras_abortadas: b.abortadas });
      await ctx.close();
    }
    fs.writeFileSync(path.join(RES, 'paso1-gprf20.json'), JSON.stringify({ medido_at: new Date().toISOString(), prod_commit: commit, rol: s.rol, filas }, null, 2));
    for (const f of filas) {
      // El criterio del paso: la fila SUBE y la cabecera no gana renglones de acciones.
      const a = f['antes'] as { renglones_acciones: number };
      const d = f['despues'] as { renglones_acciones: number };
      if (f['modo'] !== 'real (prod ya lo trae)') {
        expect(Number(f['gana_px']), `a ${f['ancho']} px la primera fila debe subir`).toBeGreaterThan(0);
        expect(d.renglones_acciones, `a ${f['ancho']} px las acciones no deben partirse en más renglones`).toBeLessThanOrEqual(a.renglones_acciones);
      }
    }
  });

  test('NEGATIVA: si el cambio de vista partiera la cabecera, el instrumento lo cuenta', async ({ browser }) => {
    test.setTimeout(2 * 60_000);
    const ctx = await contexto(browser, s.token);
    const page = await ctx.newPage();
    await blindar(page);
    await page.goto('/almacen/pedidos');
    await page.locator('nav.gp-vistas').first().waitFor({ timeout: 30_000 });
    await page.locator('tbody tr').first().waitFor({ timeout: 30_000 });
    await quieta(page);
    const antes = await cabecera(page);
    if (!(await page.locator('header nav.gp-vistas').count())) expect(await subirAlaCabecera(page)).toBe(true);
    // Se fuerza lo que el criterio debe atrapar: el segmentado ocupando su propio renglón.
    await page.locator('header nav.gp-vistas').evaluate((n) => { (n as HTMLElement).style.flexBasis = '100%'; });
    const roto = await cabecera(page);
    expect(roto.renglones_acciones, 'una cabecera partida debe contar más renglones').toBeGreaterThan(antes.renglones_acciones);
    await ctx.close();
  });
});
