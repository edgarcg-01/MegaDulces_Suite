import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { sesion, contexto, quieta } from './comun';
import { interceptar, almacenConMasPedidos, PROD, LOCAL, NEGATIVO } from './desvio';

/**
 * `[GP.RF.35]` Surtir rehecho (maqueta aprobada por Edgar, 2026-11-17), en el celular (390 × 844, táctil).
 *
 * Mide lo mismo en dos lados con el MISMO instrumento:
 *  - **antes** = `/almacen/surtir` de producción (lo desplegado);
 *  - **después** = el frontend de este árbol (`E2E_LOCAL_URL`, p. ej. `http://localhost:4200`) con las
 *    LECTURAS desviadas a producción desde Playwright. El backend local NO se toca: ninguna petición
 *    `/api` o `/socket.io` sale del navegador hacia él.
 *
 * SÓLO LECTURA en los dos: todo lo que no es GET se aborta, salvo «Empezar a surtir»
 * (`POST …/presale-picking/:id/start`), que se contesta AQUÍ con `{}` sin llegar a ningún servidor,
 * para poder abrir un pedido y medir su vista. Marcar es local hasta «Terminé», que no se toca.
 *
 *   MD_TOKEN_FILE=<ruta> E2E_LOCAL_URL=http://localhost:4200 \
 *     npx playwright test -c e2e/reestructura/playwright.config.ts surtir-rehecho
 */

const RES = path.join(__dirname, '.resultados');
const SHOTS = path.join(RES, 'surtir-rehecho');
const TAP = 44;

/** Lo que importa de la LISTA: dónde empieza el trabajo, cuántos controles hay antes y si alguno es chico. */
async function medirLista(page: Page) {
  return page.evaluate(({ TAP }) => {
    const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(e as HTMLElement); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const pagina = document.querySelector('app-almacen-surtir') ?? document.body;
    const tarjetas = Array.from(pagina.querySelectorAll('.sr-ped')).filter(vis);
    const primera = tarjetas[0] as HTMLElement | undefined;
    const top = primera ? Math.round(primera.getBoundingClientRect().top) : null;
    const sel = 'button, a[href], input:not([type=hidden]), [role=radio], [role=button], select, p-select';
    const ctrls = Array.from(pagina.querySelectorAll(sel)).filter(vis);
    const antes = top == null ? ctrls : ctrls.filter((e) => (e as HTMLElement).getBoundingClientRect().bottom <= top + 1);
    const chicos = ctrls.map((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return { t: ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.w < TAP || x.h < TAP);
    // Botones DENTRO de una tarjeta (antes: «Surtir este pedido» naranja en cada una).
    const botonesEnTarjeta = tarjetas.reduce((n, t) => n + t.querySelectorAll('button').length + (t.tagName === 'BUTTON' ? 1 : 0), 0);
    const naranjas = tarjetas.reduce((n, t) => n + Array.from(t.querySelectorAll('*')).concat([t]).filter((x) => {
      const bg = getComputedStyle(x as HTMLElement).backgroundColor; const a = getComputedStyle(document.documentElement).getPropertyValue('--action').trim();
      return !!a && bg !== 'rgba(0, 0, 0, 0)' && (x as HTMLElement).innerText?.trim() && bg === getComputedStyle(Object.assign(document.createElement('i'), { style: `color:${a}` })).color;
    }).length, 0);
    const aviso = pagina.querySelector('app-clientes-nuevos-aviso');
    const avisoDespues = !!(aviso && primera && (primera.compareDocumentPosition(aviso) & Node.DOCUMENT_POSITION_FOLLOWING));
    // Texto encimado dentro de cada tarjeta (rectángulos del TEXTO, no de las cajas).
    let encimadas = 0;
    const encimadasEjemplo: string[] = [];
    for (const t of tarjetas.slice(0, 60)) {
      // Cada rectángulo con su nodo: las líneas de UN mismo texto partido no se comparan entre sí (su caja de
      // fuente puede rebasar el interlineado 1-2 px sin que se vea encimado).
      const rects: Array<{ r: DOMRect; n: number }> = [];
      let nodo = 0;
      const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        nodo++;
        for (const r of Array.from(rg.getClientRects())) if (r.width > 1 && r.height > 1) rects.push({ r, n: nodo });
      }
      const choca = rects.some((x, i) => rects.some((y, j) => { const a = x.r, b = y.r; return j > i && x.n !== y.n && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1; }));
      if (choca) { encimadas++; encimadasEjemplo.push((t as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 90)); }
    }
    return {
      tarjetas: tarjetas.length,
      primera_tarjeta_px: top,
      controles_antes_de_la_lista: antes.length,
      controles_antes_ejemplos: antes.map((e) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 30)),
      botones_en_tarjetas: botonesEnTarjeta,
      tarjetas_con_naranja: naranjas,
      chicos: chicos.length,
      ejemplos_chicos: chicos.slice(0, 8),
      aviso_clientes_despues_de_los_pedidos: avisoDespues,
      aviso_clientes_texto: aviso?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null,
      tarjetas_con_texto_encimado: encimadas,
      encimadas_ejemplo: encimadasEjemplo.slice(0, 3),
      // Qué ocupa el alto antes de la primera tarjeta (hijos visibles de la página, con su alto).
      bloques_antes_de_la_lista: Array.from((pagina.querySelector('.sr-page') ?? pagina).children)
        .filter((e) => vis(e) && (top == null || (e as HTMLElement).getBoundingClientRect().top < top))
        .map((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return `${(e.className || e.tagName).toString().split(' ')[0]} @${Math.round(r.top)} ↕${Math.round(r.height)}`; }),
      es_la_version_nueva: !!pagina.querySelector('.sr-cab'),
    };
  }, { TAP });
}

/** La vista del PEDIDO: qué es lo primero de un renglón, si el escáner queda fijo y si el pie se ve. */
async function medirPedido(page: Page) {
  const base = await page.evaluate(() => {
    const ren = document.querySelector('.sr-ren') as HTMLElement | null;
    const lugar = ren?.querySelector('.sr-lugar, .sr-ubic') as HTMLElement | null;
    const nombre = ren?.querySelector('.sr-ren-prod strong') as HTMLElement | null;
    const cant = ren?.querySelector('.sr-cant') as HTMLElement | null;
    const r = (e: HTMLElement | null) => (e ? e.getBoundingClientRect() : null);
    const rn = r(nombre), rc = r(cant), rl = r(lugar), rr = r(ren);
    return {
      renglones: document.querySelectorAll('.sr-ren, .sr-hecho').length,
      primer_renglon_px: rr ? Math.round(rr.top) : null,
      lo_primero_del_renglon: ren?.firstElementChild?.className ?? null,
      ubicacion_arriba_del_nombre: !!(rl && rn && rl.bottom <= rn.top + 1),
      nombre_y_cantidad_en_un_renglon: !!(rn && rc && rc.top < rn.bottom && rn.top < rc.bottom),
      alto_primer_renglon_px: rr ? Math.round(rr.height) : null,
      escaner_px: Math.round((document.querySelector('#sr-buscar') as HTMLElement | null)?.getBoundingClientRect().top ?? -1),
      borde_escaner: getComputedStyle((document.querySelector('#sr-buscar')?.closest('.sr-buscar') as HTMLElement) ?? document.body).borderTopColor,
    };
  });
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(400);
  const tras = await page.evaluate(() => {
    const b = (document.querySelector('#sr-buscar') as HTMLElement | null)?.getBoundingClientRect();
    const pie = (document.querySelector('.sr-pie') as HTMLElement | null)?.getBoundingClientRect();
    return {
      escaner_visible_tras_desplazar: !!b && b.top >= 0 && b.bottom <= innerHeight,
      escaner_px_tras_desplazar: b ? Math.round(b.top) : null,
      pie_visible: !!pie && pie.top < innerHeight && pie.bottom > 0,
    };
  });
  return { ...base, ...tras };
}

async function recorrer(page: Page, url: string, etiqueta: string) {
  const out: Record<string, unknown> = {};
  // CLS de la carga: suma de layout-shift sin entrada reciente del usuario (la definición de web-vitals, sin ventanas).
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    } catch { /* sin soporte */ }
  });
  const t0 = Date.now();
  await page.goto(url);
  await page.locator('app-almacen-surtir').waitFor({ timeout: 45_000 });
  // Origen preventa (antes «Sucursal», después «Preventa»): es el que abre por omisión.
  await page.locator('.sr-ped').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  out['quieta'] = await quieta(page, t0);
  out['cls_carga'] = await page.evaluate(() => Math.round(((window as unknown as { __cls: number }).__cls ?? 0) * 1000) / 1000);
  out['lista'] = await medirLista(page);
  await page.screenshot({ path: path.join(SHOTS, `${etiqueta}-lista.png`), fullPage: false });
  // Abrir el primer pedido que se pueda tocar (la tarjeta nueva, o su botón «Surtir este pedido» viejo).
  // El pedido con MÁS productos (para que haya desplazamiento y se pruebe el escáner fijo).
  const idx = await page.evaluate(() => {
    const ts = Array.from(document.querySelectorAll('button.sr-ped, .sr-ped:has(button)'));
    let mejor = -1, n = -1;
    ts.forEach((t, i) => { const m = /(\d+)\s+productos?/.exec((t as HTMLElement).innerText); const k = m ? Number(m[1]) : 0; if (k > n) { n = k; mejor = i; } });
    return mejor;
  });
  const tarjeta = page.locator('button.sr-ped, .sr-ped:has(button)').nth(Math.max(idx, 0));
  const abrir = idx < 0 ? null
    : (await tarjeta.evaluate((e) => e.tagName === 'BUTTON')) ? tarjeta : tarjeta.locator('button:has-text("Surtir este")').first();
  if (abrir && (await abrir.count())) {
    out['pedido_productos'] = await tarjeta.evaluate((e) => /(\d+)\s+productos?/.exec((e as HTMLElement).innerText)?.[1] ?? null);
    const t1 = Date.now();
    await abrir.click();
    await page.locator('.sr-ren, .sr-hecho').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    out['abrir_ms'] = Date.now() - t1;
    await page.screenshot({ path: path.join(SHOTS, `${etiqueta}-pedido.png`), fullPage: false });
    out['pedido'] = await medirPedido(page);
  } else {
    out['pedido'] = 'NO MEDIDO: no había un pedido que se pudiera tocar';
  }
  return out;
}

test.describe('[GP.RF.35] Surtir rehecho, en el celular', () => {
  test.use({ actionTimeout: 15_000 });
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('antes (prod) y después (este árbol, lecturas de prod)', async ({ browser }) => {
    test.setTimeout(300_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const salida: Record<string, unknown> = { medido_at: new Date().toISOString(), rol: s.rol, viewport: '390x844 táctil' };
    const alm = await almacenConMasPedidos(browser, s.token);
    salida['almacen'] = { nombre: alm.nombre, pedidos_hoy: alm.pedidos_hoy };
    const conAlmacen = async (ctx: import('@playwright/test').BrowserContext) =>
      ctx.addInitScript((id) => { try { localStorage.setItem('gp.surtir.almacen.v1', id as string); } catch { /* sin almacenamiento */ } }, alm.id);

    const ctxA = await contexto(browser, s.token, true);
    await conAlmacen(ctxA);
    const pA = await ctxA.newPage();
    const regA = await interceptar(pA, false);
    salida['antes'] = { ...(await recorrer(pA, PROD + '/almacen/surtir', 'antes')), red: regA };
    await ctxA.close();

    if (LOCAL) {
      const ctxD = await contexto(browser, s.token, true);
      await conAlmacen(ctxD);
      const pD = await ctxD.newPage();
      const regD = await interceptar(pD, true);
      salida['despues'] = { ...(await recorrer(pD, LOCAL + '/almacen/surtir', 'despues')), red: regD };
      // «← Pedidos» de verdad: regresa a la lista, arriba, sin cerrar el pedido (ninguna escritura).
      const antesDeVolver = regD.abortadas.length;
      await pD.getByRole('button', { name: /Pedidos/ }).first().click();
      await pD.locator('button.sr-ped').first().waitFor({ timeout: 30_000 });
      const vuelta = await medirLista(pD);
      // Control negativo del detector de encimado: la cantidad de productos montada sobre el nombre TIENE que contar.
      await pD.addStyleTag({ content: '.sr-ped-n { position: relative; left: -12rem; }' });
      const roto = await medirLista(pD);
      salida['volver_a_pedidos'] = {
        primera_tarjeta_px: vuelta.primera_tarjeta_px,
        bloques: vuelta.bloques_antes_de_la_lista,
        escrituras_al_volver: regD.abortadas.slice(antesDeVolver),
        control_encimado_con_maqueta_rota: roto.tarjetas_con_texto_encimado,
      };
      expect(roto.tarjetas_con_texto_encimado).toBeGreaterThan(0);
      expect(regD.abortadas.slice(antesDeVolver).filter((x) => !x.includes('/telemetry/'))).toEqual([]);
      await ctxD.close();
      // Control del instrumento: el backend local no recibió nada; y lo medido es la versión nueva.
      if (NEGATIVO) {
        expect(regD.al_backend_local.length).toBeGreaterThan(0);
        return;
      }
      expect(regD.al_backend_local).toEqual([]);
      expect((salida['despues'] as { lista: { es_la_version_nueva: boolean } }).lista.es_la_version_nueva).toBe(true);
    } else {
      salida['despues'] = 'NO MEDIDO: sin E2E_LOCAL_URL';
    }
    // Control negativo: prod (sin desplegar) NO es la versión nueva. Si lo fuera, el «antes» no sirve.
    expect((salida['antes'] as { lista: { es_la_version_nueva: boolean } }).lista.es_la_version_nueva).toBe(false);
    fs.writeFileSync(path.join(RES, 'surtir-rehecho.json'), JSON.stringify(salida, null, 2));
  });
});
