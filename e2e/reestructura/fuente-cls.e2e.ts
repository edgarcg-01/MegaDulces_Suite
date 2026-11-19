import { test, expect, type Browser } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { contexto } from './comun';
import { LOCAL } from './desvio';
import { servirSintetico, tokenSintetico, ALMACEN_SINTETICO } from './sintetico';

/**
 * `[GP.RF.40]` ¿Cuánto brinca la página cuando llegan Hanken Grotesk y Geist Mono, con y sin los
 * respaldos medidos ('Hanken Respaldo' y 'Geist Mono Respaldo' en libs/design-tokens/tokens.css)?
 * A/B en la MISMA corrida y el mismo árbol: la variante «sin» recibe styles.css con los dos
 * respaldos quitados de las pilas de --font-body y --font-mono.
 *
 * Para que el cambio de letra ocurra siempre DESPUÉS de pintar (como en un celular con red lenta),
 * los archivos de fonts.gstatic.com se retrasan RETRASO_MS. La API la contesta `sintetico.ts`
 * (datos inventados, ninguna petición sale del navegador).
 *
 * Controles:
 *  - con la letra BLOQUEADA no hay cambio de letra: lo que mida esa variante es ruido de la página;
 *  - «sin» tiene que brincar (si no, el instrumento no ve el defecto y «con» no prueba nada);
 *  - ya con Hanken cargada, la posición final de los textos es IDÉNTICA en «sin» y «con» (el
 *    respaldo sólo vive mientras Hanken baja);
 *  - en «con», el respaldo de verdad se usó antes de que llegara Hanken (caras cargadas > 0).
 *
 *   E2E_LOCAL_URL=http://localhost:4200 npx playwright test -c e2e/reestructura/playwright.config.ts fuente-cls
 */

const RES = path.join(__dirname, '.resultados');
const RETRASO_MS = 1500;
const VUELTAS = Number(process.env.E2E_VUELTAS || 5);
const PANTALLAS: Array<{ ruta: string; movil: boolean; espera: string }> = [
  { ruta: '/almacen/surtir', movil: true, espera: 'app-almacen-surtir button.sr-ped' },
  { ruta: '/almacen/surtir', movil: false, espera: 'app-almacen-surtir button.sr-ped' },
  { ruta: '/almacen/pedidos', movil: false, espera: 'main h1, main h2' },
  { ruta: '/finanzas/caja-general', movil: false, espera: 'main h1, main h2' },
];
type Variante = 'sin' | 'con' | 'bloqueada';
type Lectura = { cls: number; respaldo_cargadas: number; hanken_al_final: boolean; firma: string; textos: number; mayores: string[] };

async function medir(browser: Browser, ruta: string, movil: boolean, espera: string, v: Variante): Promise<Lectura> {
  const ctx = await contexto(browser, tokenSintetico(), movil);
  await ctx.addInitScript((id) => { try { localStorage.setItem('gp.surtir.almacen.v1', id as string); } catch { /* sin almacenamiento */ } }, ALMACEN_SINTETICO);
  await ctx.addInitScript(() => {
    const w = window as unknown as { __cls: Array<{ v: number; n: string }>; __resp: number };
    w.__cls = []; w.__resp = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node }> }>) {
        if (e.hadRecentInput) continue;
        const n = e.sources?.[0]?.node as HTMLElement | undefined;
        const el = n?.nodeType === 1 ? n : n?.parentElement;
        w.__cls.push({ v: e.value, n: el ? `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}` : '?' });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const page = await ctx.newPage();
  const reg = await servirSintetico(page);
  if (v === 'sin') {
    await page.route('**/styles.css', async (r) => {
      const resp = await r.fetch();
      const css = (await resp.text()).replace(/,\s*["'](?:Hanken|Geist Mono) Respaldo["']/g, '');
      await r.fulfill({ response: resp, body: css });
    });
  }
  await page.route('https://fonts.gstatic.com/**', async (r) => {
    if (v === 'bloqueada') return r.abort('blockedbyclient');
    await new Promise((ok) => setTimeout(ok, RETRASO_MS));
    return r.continue();
  });
  await page.goto(LOCAL + ruta);
  await page.locator(espera).first().waitFor({ timeout: 45_000 });
  // Antes de que llegue Hanken: ¿qué caras del respaldo se usaron?
  const respaldo = await page.evaluate(() => Array.from(document.fonts).filter((f) => / Respaldo$/.test(f.family.replace(/["']/g, '')) && f.status === 'loaded').length);
  if (v !== 'bloqueada') await page.waitForFunction(() => document.fonts.check("400 16px 'Hanken Grotesk'"), null, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const w = window as unknown as { __cls: Array<{ v: number; n: string }> };
    // Firma de la posición final de los textos visibles (para el control «idéntico al final»).
    const els = Array.from(document.querySelectorAll('main *, header *, nav *')).filter((e) => {
      const h = e as HTMLElement; if (!h.childNodes.length) return false;
      if (!Array.from(h.childNodes).some((c) => c.nodeType === 3 && (c.textContent || '').trim())) return false;
      const b = h.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.top < innerHeight;
    }).slice(0, 300);
    const firma = els.map((e) => { const b = (e as HTMLElement).getBoundingClientRect(); return `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}`; }).join(';');
    const porNodo = new Map<string, number>();
    for (const x of w.__cls) porNodo.set(x.n, (porNodo.get(x.n) || 0) + x.v);
    return {
      cls: Math.round(w.__cls.reduce((a, x) => a + x.v, 0) * 10000) / 10000,
      hanken_al_final: document.fonts.check("400 16px 'Hanken Grotesk'"),
      firma, textos: els.length,
      mayores: [...porNodo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, x]) => `${n} ${Math.round(x * 1000) / 1000}`),
    };
  });
  expect(reg.salieron, 'control: ninguna petición a la API salió del navegador').toEqual([]);
  await ctx.close();
  return { ...r, respaldo_cargadas: respaldo };
}

test.describe('[GP.RF.40] Brinco por el cambio de letra, con y sin el respaldo medido', () => {
  test.skip(!LOCAL, 'NO MEDIDO: sin E2E_LOCAL_URL no hay frontend de este árbol');

  test('A/B por pantalla, con letra retrasada y bloqueada', async ({ browser }) => {
    test.setTimeout(900_000);
    fs.mkdirSync(RES, { recursive: true });
    const salida: Record<string, unknown> = { medido_at: new Date().toISOString(), retraso_ms: RETRASO_MS, vueltas: VUELTAS, pantallas: [] };
    for (const p of PANTALLAS) {
      const lect: Record<Variante, Lectura[]> = { sin: [], con: [], bloqueada: [] };
      for (let i = 0; i < VUELTAS; i++) {
        // Alternadas, para que la deriva del servidor de desarrollo no caiga sólo en una variante.
        for (const v of (i % 2 ? ['con', 'sin'] : ['sin', 'con']) as Variante[]) lect[v].push(await medir(browser, p.ruta, p.movil, p.espera, v));
      }
      lect.bloqueada.push(await medir(browser, p.ruta, p.movil, p.espera, 'bloqueada'));
      const cls = (v: Variante) => lect[v].map((x) => x.cls).sort((a, b) => a - b);
      const med = (a: number[]) => a[a.length >> 1];
      const fila = {
        pantalla: `${p.ruta} ${p.movil ? '390x844' : '1366x768'}`,
        textos: lect.con[0].textos,
        cls_sin: cls('sin'), cls_con: cls('con'), mediana_sin: med(cls('sin')), mediana_con: med(cls('con')),
        cls_bloqueada: lect.bloqueada[0].cls,
        mayores_sin: lect.sin[0].mayores, mayores_con: lect.con[0].mayores,
        respaldo_usado_en_con: lect.con.map((x) => x.respaldo_cargadas),
        respaldo_usado_en_sin: lect.sin.map((x) => x.respaldo_cargadas),
        hanken_al_final: lect.con.every((x) => x.hanken_al_final) && lect.sin.every((x) => x.hanken_al_final),
        // Si la pantalla no repite su posición ni contra sí misma (un reloj, «hace N s»), el control no se puede leer.
        final_identico: [...lect.sin, ...lect.con].every((x) => x.firma === lect.sin[0].firma)
          ? true : (lect.sin.every((x) => x.firma === lect.sin[0].firma) ? false : 'NO MEDIDO: la pantalla no repite su posición ni sin el cambio'),
      };
      (salida.pantallas as unknown[]).push(fila);
      console.log(JSON.stringify(fila));
      if (p.ruta === '/almacen/surtir' && p.movil) {
        // Control del instrumento: sin los respaldos, el cambio de letra SÍ mueve Surtir (si no, «con» no prueba nada).
        expect(fila.mediana_sin, 'control: sin respaldo la tarjeta brinca').toBeGreaterThan(0.01);
        expect(fila.mediana_con, 'con respaldo: lo mismo que sin cambio de letra').toBeLessThanOrEqual(fila.cls_bloqueada + 0.002);
      }
      expect(fila.final_identico, 'ya con la letra web, el respaldo no deja rastro').not.toBe(false);
    }
    fs.writeFileSync(path.join(RES, 'fuente-cls.json'), JSON.stringify(salida, null, 2));
  });
});
