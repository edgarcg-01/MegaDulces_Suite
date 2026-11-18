import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { sesion, contexto, quieta } from './comun';
import { interceptar, almacenConMasPedidos, LOCAL } from './desvio';
import { servirSintetico, tokenSintetico, ALMACEN_SINTETICO } from './sintetico';

/**
 * `[GP.RF.38]` Re-auditoría de Surtir con las guías de Modern Web Guidance (GoogleChrome), en el
 * celular (390 × 844, táctil), sobre el frontend de ESTE árbol con las lecturas desviadas a prod
 * (`desvio.ts`: ninguna escritura sale, «Empezar» se simula, cero peticiones al backend local).
 *
 * Lo que la auditoría de §5c.6 NO midió y las guías piden:
 *  1. `stack-drill-down` — el gesto «atrás» del celular con un pedido abierto: ¿regresa a la lista?
 *  2. `accessibility` §5 — el foco al abrir un pedido y al volver (¿se queda en <body>?).
 *  3. `state-aware-sticky-headers` / `form-factor-adaptation` — ¿un control enfocado queda TAPADO
 *     por el escáner fijo o por el pie fijo? (WCAG 2.4.11). Con control: uno tapado a propósito.
 *  4. `scrollability-affordance-hints` — los renglones que se deslizan: ¿esconden su barra sin
 *     ninguna pista? ¿cuántos chips quedan fuera? ¿se corta el anillo de foco?
 *  5. `accessibility` §2 — los grupos `role="radio"`: ¿las flechas mueven la elección? ¿cuántos Tab?
 *  6. `color` — alto contraste de Windows (forced-colors): ¿se distingue la opción elegida?
 *  7. `card` — al elegir un chip, ¿los vecinos brincan (negritas)? ¿qué tan largo es el nombre
 *     accesible de la tarjeta?
 *  8. `accessibility` §1 y §8 — encabezados (h1) y regiones vivas.
 *  9. `performance` / `content-first-noise-reduction` — qué movió la pantalla al cargar (CLS por
 *     nodo) y cuánto alto se comen las barras fijas.
 *
 * Dos modos:
 *  - con `MD_TOKEN_FILE` (sesión vigente): lecturas de PROD por `desvio.ts`;
 *  - con `E2E_SINTETICO=1`: la API la contesta `sintetico.ts` con datos INVENTADOS —ninguna petición
 *    sale del navegador—. Mide comportamiento, no volúmenes ni tiempos de red.
 *
 *   E2E_SINTETICO=1 E2E_LOCAL_URL=http://localhost:4200 E2E_ETIQUETA=antes \
 *     npx playwright test -c e2e/reestructura/playwright.config.ts surtir-mwg
 */

const RES = path.join(__dirname, '.resultados');
const SHOTS = path.join(RES, 'surtir-mwg');
const ETIQUETA = process.env.E2E_ETIQUETA || 'medicion';
const SINTETICO = process.env.E2E_SINTETICO === '1';

type Caja = { top: number; bottom: number; left: number; right: number; height: number };

/** El elemento enfocado, descrito para el informe. */
const enfocado = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return 'BODY (nadie)';
  return `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${a.className && typeof a.className === 'string' ? '.' + a.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} «${(a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40)}»`;
});

/** Encabezados y regiones vivas visibles, en orden de documento. */
const estructura = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const enc = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')).filter(vis)
    .map((e) => `h${e.getAttribute('aria-level') || e.tagName.slice(1)} ${(e as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 40)}`);
  const vivas = Array.from(document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]'))
    .map((e) => `${e.getAttribute('role') ?? ''}/${e.getAttribute('aria-live') ?? ''} ${(e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 40) ?? ''}`);
  return { encabezados: enc, h1: enc.filter((x) => x.startsWith('h1 ')).length, regiones_vivas: vivas.length, vivas };
});

/**
 * ¿Se ve el control enfocado? 5 puntos (centro y 4 esquinas metidas 3 px): si `elementFromPoint`
 * en un punto no cae en el control (o adentro), ese punto está tapado. 0 de 5 = tapado entero.
 */
const visibilidad = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return null;
  const r = a.getBoundingClientRect();
  const pts = [[(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + 3, r.top + 3], [r.right - 3, r.top + 3], [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3]];
  let vistos = 0; let tapa = '';
  for (const [x, y] of pts) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    const h = document.elementFromPoint(x, y);
    if (h && (h === a || a.contains(h) || h.contains(a))) vistos++;
    else if (h && !tapa) { const c = h.closest('.sr-fijo, .sr-pie, header, [class*=topbar], [class*=layout-top]') as HTMLElement | null; tapa = c ? (c.className.toString().split(' ')[0] || c.tagName) : (h.className.toString().split(' ')[0] || h.tagName); }
  }
  return { vistos, tapa, que: (a.innerText || a.getAttribute('aria-label') || a.tagName).replace(/\s+/g, ' ').trim().slice(0, 30) };
});

/** Los renglones que se deslizan: barra, pista, chips fuera de vista y anillo de foco recortado. */
async function deslizables(page: Page) {
  const filas = await page.locator('app-almacen-surtir .sr-desliza').count();
  const out: unknown[] = [];
  for (let i = 0; i < filas; i++) {
    const fila = page.locator('app-almacen-surtir .sr-desliza').nth(i);
    if (!(await fila.isVisible())) continue;
    const geo = await fila.evaluate((s) => {
      const cs = getComputedStyle(s);
      const r = s.getBoundingClientRect();
      const hijos = Array.from(s.children) as HTMLElement[];
      return {
        que: s.getAttribute('aria-label') || s.closest('section')?.getAttribute('aria-label') || 'fila',
        chips: hijos.length,
        se_desliza: s.scrollWidth > s.clientWidth + 1,
        fuera_de_vista: hijos.filter((h) => h.getBoundingClientRect().left >= r.right - 1).length,
        barra: cs.scrollbarWidth,
        pista_mascara: cs.maskImage !== 'none' && !!cs.maskImage ? 'sí' : 'no',
        // El desvanecido real en cada borde (0px = sin pista ahí): al inicio, sólo el de la derecha.
        desvanecido: { inicio: cs.getPropertyValue('--sr-fade-ini').trim() || 'n/a', fin: cs.getPropertyValue('--sr-fade-fin').trim() || 'n/a' },
        snap: cs.scrollSnapType,
      };
    });
    // El anillo de foco del primer chip, con modalidad de TECLADO (Shift+Tab y Tab de regreso).
    const primero = fila.locator('button, input, label').first();
    await primero.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const anillo = await fila.evaluate((s) => {
      const a = document.activeElement as HTMLElement | null;
      if (!a || !s.contains(a)) return { medido: false as const, enfocado: a?.tagName ?? null };
      const cs = getComputedStyle(a);
      const ow = parseFloat(cs.outlineWidth) || 0; const of = parseFloat(cs.outlineOffset) || 0;
      const r = a.getBoundingClientRect(); const c = s.getBoundingClientRect();
      const bl = parseFloat(getComputedStyle(s).borderLeftWidth) || 0; const bt = parseFloat(getComputedStyle(s).borderTopWidth) || 0;
      const clip = { top: c.top + bt, bottom: c.top + bt + s.clientHeight, left: c.left + bl, right: c.left + bl + s.clientWidth };
      const ext = ow + of;
      const ring = { top: r.top - ext, bottom: r.bottom + ext, left: r.left - ext, right: r.right + ext };
      return {
        medido: true as const, focus_visible: a.matches(':focus-visible'), anillo_px: ow, separacion_px: of,
        recortado_px: { arriba: Math.max(0, Math.round(clip.top - ring.top)), abajo: Math.max(0, Math.round(ring.bottom - clip.bottom)), izquierda: Math.max(0, Math.round(clip.left - ring.left)), derecha: Math.max(0, Math.round(ring.right - clip.right)) },
      };
    });
    await fila.screenshot({ path: path.join(SHOTS, `${ETIQUETA}-desliza-${i}.png`) }).catch(() => undefined);
    out.push({ ...geo, anillo });
  }
  return out;
}

/** El grupo «Pedidos de»: ¿las flechas eligen? ¿cuántos Tab cuesta cruzarlo? */
async function grupoOrigen(page: Page) {
  const grupo = page.locator('app-almacen-surtir .sr-origen');
  if (!(await grupo.count())) return 'NO MEDIDO: no hay grupo de origen';
  const elegido = () => grupo.evaluate((g) => (g.querySelector('[aria-checked=true], input:checked')?.closest('button, label') as HTMLElement | null)?.innerText.trim() ?? null);
  const antes = await elegido();
  await grupo.locator('[aria-checked=true], input:checked').first().focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const despues = await elegido();
  const foco = await enfocado(page);
  // Regresar a Preventa (la flecha, si eligió, cambió el origen; si no, no pasó nada).
  if (despues !== antes) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(300); }
  await page.locator('app-almacen-surtir button.sr-ped').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  // Paradas de Tab DENTRO del grupo (el patrón de radio pide UNA): los enfocables con tabindex ≥ 0.
  // Un radio nativo cuenta como una sola parada por grupo (`name`): el navegador sólo deja entrar al elegido.
  const paradas = await grupo.evaluate((g) => {
    const enf = Array.from(g.querySelectorAll('button, input, [tabindex]')).filter((e) => (e as HTMLElement).tabIndex >= 0 && !(e as HTMLButtonElement).disabled);
    const radios = enf.filter((e) => (e as HTMLInputElement).type === 'radio');
    return {
      n: enf.length - radios.length + new Set(radios.map((r) => (r as HTMLInputElement).name)).size,
      detalle: Array.from(g.querySelectorAll('button, input')).map((e) => `${e.tagName.toLowerCase()} tabIndex=${(e as HTMLElement).tabIndex}${(e as HTMLButtonElement).disabled ? ' disabled' : ''} «${((e as HTMLElement).innerText || (e.parentElement as HTMLElement).innerText).trim()}»`),
    };
  });
  return { elegido_antes: antes, tras_flecha_derecha: despues, la_flecha_eligio: despues !== antes, foco_tras_flecha: foco, paradas_de_tab_en_el_grupo: paradas };
}

/** Alto contraste de Windows: ¿la opción elegida se distingue de las demás sin el color? */
async function altoContraste(page: Page) {
  // Sin foco: el anillo de foco también es un contorno y contaminaría la comparación.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.emulateMedia({ forcedColors: 'active' });
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => {
    const leer = (e: Element | null) => {
      if (!e) return null; const s = getComputedStyle(e as HTMLElement);
      return { fondo: s.backgroundColor, texto: s.color, borde: s.borderTopColor, peso: s.fontWeight, contorno: s.outlineStyle === 'none' ? 'none' : `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`, sombra: s.boxShadow };
    };
    const g = document.querySelector('app-almacen-surtir .sr-origen');
    const on = g?.querySelector('[aria-checked=true], input:checked')?.closest('button, label') ?? null;
    const off = g?.querySelector('[aria-checked=false], input:not(:checked)')?.closest('button, label') ?? null;
    const a = leer(on); const b = leer(off);
    const difieren = a && b ? (Object.keys(a) as Array<keyof typeof a>).filter((k) => a[k] !== b[k]) : [];
    return { elegido: a, no_elegido: b, difieren_en: difieren };
  });
  await page.locator('app-almacen-surtir .sr-cab').screenshot({ path: path.join(SHOTS, `${ETIQUETA}-alto-contraste.png`) }).catch(() => undefined);
  await page.emulateMedia({ forcedColors: 'none' });
  return r;
}

/** Al elegir un vendedor, ¿cuánto se mueven los chips vecinos? (negritas al elegir = brinco). */
async function brincoAlElegir(page: Page) {
  const fila = page.locator('app-almacen-surtir .sr-desliza[aria-label="Vendedor"], app-almacen-surtir [aria-label="Vendedor"]').first();
  if (!(await fila.count()) || !(await fila.isVisible())) return 'NO MEDIDO: no hay renglón de vendedores';
  const xs = () => fila.evaluate((f) => Array.from(f.querySelectorAll('button, label')).map((b) => Math.round((b as HTMLElement).getBoundingClientRect().left + (f as HTMLElement).scrollLeft)));
  const antes = await xs();
  const segundo = fila.locator('button, label').nth(1);
  await segundo.click();
  await page.waitForTimeout(250);
  const despues = await xs();
  await fila.locator('button, label').first().click();
  await page.waitForTimeout(250);
  const mov = antes.map((x, i) => Math.abs((despues[i] ?? x) - x));
  return { chips: antes.length, max_px: Math.max(0, ...mov), chips_que_se_movieron: mov.filter((m) => m > 0).length };
}

/** Las barras fijas en el pedido, después de desplazar: cuánto del alto se comen. */
const barrasFijas = (page: Page) => page.evaluate(() => {
  const fijos = Array.from(document.querySelectorAll('body *')).filter((e) => {
    const s = getComputedStyle(e as HTMLElement); if (s.position !== 'fixed' && s.position !== 'sticky') return false;
    const r = (e as HTMLElement).getBoundingClientRect(); return r.height > 4 && r.width > 100 && r.bottom > 0 && r.top < innerHeight && r.height < innerHeight * 0.6;
  }).map((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return { que: (e.className.toString().split(' ')[0] || e.tagName).slice(0, 30), pos: getComputedStyle(e as HTMLElement).position, top: Math.round(r.top), alto: Math.round(r.height) }; });
  const arriba = fijos.filter((f) => f.top < innerHeight / 2);
  const abajo = fijos.filter((f) => f.top >= innerHeight / 2);
  const cubreArriba = Math.max(0, ...arriba.map((f) => f.top + f.alto));
  const cubreAbajo = abajo.length ? innerHeight - Math.min(...abajo.map((f) => f.top)) : 0;
  return { fijos, cubre_arriba_px: cubreArriba, cubre_abajo_px: cubreAbajo, pct_del_alto: Math.round(((cubreArriba + cubreAbajo) / innerHeight) * 100) };
});

/** Recorre el pedido con Tab y cuenta cuántos controles enfocados quedan tapados. */
async function focoTapado(page: Page) {
  await page.locator('#sr-buscar').focus();
  const vistos: Array<{ vistos: number; tapa: string; que: string }> = [];
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const dentro = await page.evaluate(() => !!document.activeElement?.closest('app-almacen-surtir'));
    if (!dentro) break;
    const v = await visibilidad(page);
    if (v) vistos.push(v);
  }
  const tapados = vistos.filter((v) => v.vistos === 0);
  const parciales = vistos.filter((v) => v.vistos > 0 && v.vistos < 5);
  // CONTROL: un botón de renglón puesto a propósito DEBAJO del escáner fijo tiene que salir tapado.
  const control = await page.evaluate(() => {
    const fijo = document.querySelector('.sr-fijo') as HTMLElement | null;
    const b = Array.from(document.querySelectorAll('.sr-ren button')).find((x) => (x as HTMLElement).getBoundingClientRect().height > 0) as HTMLElement | undefined;
    if (!fijo || !b) return 'NO MEDIDO';
    b.focus({ preventScroll: true });
    // Llevar el botón justo debajo del borde de arriba (queda bajo .sr-fijo).
    let p: HTMLElement | null = b.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    const caja = p ?? (document.scrollingElement as HTMLElement);
    const top0 = caja === document.scrollingElement ? 0 : caja.getBoundingClientRect().top;
    caja.scrollTop += b.getBoundingClientRect().top - top0 - 4;
    return 'listo';
  });
  const controlVis = control === 'listo' ? await visibilidad(page) : null;
  return { recorridos: vistos.length, tapados: tapados.length, parciales: parciales.length, ejemplos: [...tapados, ...parciales].slice(0, 6), control_tapado_a_proposito: controlVis };
}

test.describe('[GP.RF.38] Surtir re-auditado con Modern Web Guidance, en el celular', () => {
  test.use({ actionTimeout: 15_000 });
  const s = sesion();
  test.skip(!s.token && !SINTETICO, 'NO MEDIDO: sin MD_TOKEN_FILE ni E2E_SINTETICO=1 no hay con qué abrir la pantalla');
  test.skip(!LOCAL, 'NO MEDIDO: sin E2E_LOCAL_URL no hay frontend de este árbol');

  test('lo que las guías piden y la auditoría anterior no midió', async ({ browser }) => {
    test.setTimeout(360_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const salida: Record<string, unknown> = {
      medido_at: new Date().toISOString(), etiqueta: ETIQUETA, viewport: '390x844 táctil',
      modo: SINTETICO ? 'sintético (datos inventados, sin red)' : 'lecturas de prod', rol: SINTETICO ? 'superadmin (sintético)' : s.rol,
    };
    const alm = SINTETICO ? { id: ALMACEN_SINTETICO, nombre: 'Sucursal de prueba Norte', pedidos_hoy: 16 } : await almacenConMasPedidos(browser, s.token);
    salida['almacen'] = { nombre: alm.nombre, pedidos_hoy: alm.pedidos_hoy };
    const ctx = await contexto(browser, SINTETICO ? tokenSintetico() : s.token, true);
    await ctx.addInitScript((id) => { try { localStorage.setItem('gp.surtir.almacen.v1', id as string); } catch { /* sin almacenamiento */ } }, alm.id);
    // CLS de la carga con su NODO (qué se movió), sin entradas con interacción reciente.
    await ctx.addInitScript(() => {
      const w = window as unknown as { __cls: Array<{ v: number; nodos: string[] }> };
      w.__cls = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> }>) {
            if (e.hadRecentInput) continue;
            w.__cls.push({ v: e.value, nodos: (e.sources ?? []).map((x) => { const n = x.node as HTMLElement | undefined; const d = n?.nodeType === 1 ? `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ')[0]}` : (n?.parentElement ? `texto en ${n.parentElement.tagName.toLowerCase()}.${(n.parentElement.className || '').toString().split(' ')[0]}` : '?'); return `${d} ${Math.round(x.previousRect.top)}→${Math.round(x.currentRect.top)}`; }) });
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch { /* sin soporte */ }
      // Qué bloque de la página cambió de alto entre cuadros (los primeros 8 s): ahí está la causa del empuje.
      const ww = window as unknown as { __bloques: string[] };
      ww.__bloques = [];
      let previo = '';
      const t0 = performance.now();
      const mirar = () => {
        const pag = document.querySelector('app-almacen-surtir .sr-page');
        if (pag) {
          const firma = Array.from(pag.children).filter((e) => (e as HTMLElement).getBoundingClientRect().height > 0)
            .map((e) => `${(e.className || e.tagName).toString().split(' ').filter((c) => c !== 'in')[0] || e.tagName.toLowerCase()}↕${Math.round((e as HTMLElement).getBoundingClientRect().height)}`).join(' | ');
          if (firma !== previo) { ww.__bloques.push(`${Math.round(performance.now() - t0)} ms: ${firma}`); previo = firma; }
          // El segundo renglón de la primera tarjeta: ancho, alto y texto (¿qué lo hace partirse?).
          const r2 = pag.querySelector('button.sr-ped .sr-ped-r2') as HTMLElement | null;
          const w2 = window as unknown as { __r2: string[]; __r2p: string };
          w2.__r2 ??= [];
          const f2 = r2 ? `${Math.round(r2.getBoundingClientRect().width)}x${Math.round(r2.getBoundingClientRect().height)} «${r2.innerText.replace(/\s+/g, ' ')}»` : '';
          if (f2 && f2 !== w2.__r2p) { w2.__r2.push(`${Math.round(performance.now() - t0)} ms: ${f2}`); w2.__r2p = f2; }
        }
        if (performance.now() - t0 < 8000) requestAnimationFrame(mirar);
      };
      requestAnimationFrame(mirar);
    });
    const page = await ctx.newPage();
    const reg = SINTETICO ? await servirSintetico(page) : await interceptar(page, true);

    // Una entrada previa en el historial (así llega el surtidor: desde otra pantalla de la Suite).
    await page.goto(LOCAL + '/');
    await page.waitForLoadState('domcontentloaded');
    const t0 = Date.now();
    await page.goto(LOCAL + '/almacen/surtir');
    await page.locator('app-almacen-surtir button.sr-ped').first().waitFor({ timeout: 45_000 });
    salida['quieta'] = await quieta(page, t0);
    const cls = await page.evaluate(() => (window as unknown as { __cls: Array<{ v: number; nodos: string[] }> }).__cls);
    salida['cls_carga'] = {
      total: Math.round(cls.reduce((a, x) => a + x.v, 0) * 1000) / 1000,
      movimientos: cls.filter((x) => x.v >= 0.001).map((x) => ({ v: Math.round(x.v * 1000) / 1000, nodos: x.nodos.slice(0, 3) })),
      bloques: await page.evaluate(() => (window as unknown as { __bloques: string[] }).__bloques.slice(-8)),
      // Cuándo terminó de llegar cada fuente (ms desde el inicio de la navegación): si coincide con un
      // cambio de alto en `bloques`, el empuje es el cambio de fuente (texto que se re-parte en renglones).
      fuentes: await page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .filter((r) => /\.(woff2?|ttf|otf)(\?|$)/.test(r.name)).map((r) => `${r.name.split('/').pop()?.slice(0, 40)} @${Math.round(r.responseEnd)} ms`)),
      segundo_renglon: await page.evaluate(() => (window as unknown as { __r2?: string[] }).__r2 ?? []),
      // La tarjeta que creció: qué renglón interno tiene más de una línea al final.
      primera_tarjeta: await page.evaluate(() => {
        const t = document.querySelector('app-almacen-surtir button.sr-ped');
        return t ? Array.from(t.children).map((c) => `${(c.className || c.tagName).toString().split(' ')[0]}↕${Math.round((c as HTMLElement).getBoundingClientRect().height)}`) : null;
      }),
    };

    // ── LISTA ──
    salida['lista_estructura'] = await estructura(page);
    salida['tarjeta_nombre_accesible'] = await page.locator('app-almacen-surtir button.sr-ped').evaluateAll((bs) => bs.slice(0, 40).map((b) => (b as HTMLElement).innerText.replace(/\s+/g, ' ').trim().length).reduce((a, n) => ({ max: Math.max(a.max, n), suma: a.suma + n, n: a.n + 1 }), { max: 0, suma: 0, n: 0 }));
    salida['tarjeta_nombre_ejemplo'] = await page.locator('app-almacen-surtir button.sr-ped').first().evaluate((b) => (b as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
    salida['etiqueta_almacen'] = await page.evaluate(() => {
      const ps = document.querySelector('app-almacen-surtir .sr-cab p-select');
      if (!ps) return 'sin selector (un solo almacén)';
      const cb = ps.querySelector('[role=combobox]') as HTMLElement | null;
      return { nombre_programatico: cb?.getAttribute('aria-label') ?? cb?.getAttribute('aria-labelledby') ?? null, rotulo_visible: !!document.querySelector('app-almacen-surtir label[for="sr-alm"]') };
    });
    salida['deslizables'] = await deslizables(page);
    salida['grupo_origen'] = await grupoOrigen(page);
    salida['alto_contraste'] = await altoContraste(page);
    salida['brinco_al_elegir_vendedor'] = await brincoAlElegir(page);
    await page.screenshot({ path: path.join(SHOTS, `${ETIQUETA}-lista.png`) });

    // ── ABRIR con teclado: ¿a dónde va el foco? ──
    const tarjeta = page.locator('app-almacen-surtir button.sr-ped').first();
    await tarjeta.focus();
    await page.keyboard.press('Enter');
    await page.locator('app-almacen-surtir .sr-ren, app-almacen-surtir .sr-hecho').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(400);
    salida['foco_al_abrir'] = await enfocado(page);
    salida['url_al_abrir'] = new URL(page.url()).pathname + new URL(page.url()).search;
    salida['pedido_estructura'] = await estructura(page);
    salida['pedido_foco_tapado'] = await focoTapado(page);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(400);
    salida['pedido_barras_fijas'] = await barrasFijas(page);
    await page.screenshot({ path: path.join(SHOTS, `${ETIQUETA}-pedido.png`) });

    // ── VOLVER con «← Pedidos» por teclado: ¿a dónde va el foco? ──
    const volver = page.getByRole('button', { name: /Pedidos/ }).first();
    await volver.focus();
    await page.keyboard.press('Enter');
    await page.locator('app-almacen-surtir button.sr-ped').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(400);
    salida['foco_al_volver'] = await enfocado(page);
    salida['url_al_volver'] = new URL(page.url()).pathname + new URL(page.url()).search;

    // ── El gesto ATRÁS del celular con un pedido abierto ──
    await page.locator('app-almacen-surtir button.sr-ped').first().click();
    await page.locator('app-almacen-surtir .sr-ren, app-almacen-surtir .sr-hecho').first().waitFor({ timeout: 30_000 });
    const antesAtras = new URL(page.url()).pathname + new URL(page.url()).search;
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const u = new URL(page.url());
    const enLista = await page.locator('app-almacen-surtir button.sr-ped').first().isVisible().catch(() => false);
    const enPedido = await page.locator('app-almacen-surtir .sr-ren, app-almacen-surtir .sr-hecho').first().isVisible().catch(() => false);
    salida['atras_del_celular'] = { url_antes: antesAtras, url_despues: u.pathname + u.search, sigue_en_surtir: u.pathname === '/almacen/surtir', ve_la_lista: enLista, ve_el_pedido: enPedido };

    salida['red'] = reg;
    fs.writeFileSync(path.join(RES, `surtir-mwg-${ETIQUETA}.json`), JSON.stringify(salida, null, 2));
    await ctx.close();
    // Controles del instrumento.
    expect('salieron' in reg ? reg.salieron : reg.al_backend_local, 'control: ninguna petición a la API salió sin pasar por el instrumento').toEqual([]);
    const ctl = (salida['pedido_foco_tapado'] as { control_tapado_a_proposito: { vistos: number } | null }).control_tapado_a_proposito;
    expect(ctl, 'control: un botón puesto bajo el escáner fijo tiene que salir tapado').not.toBeNull();
    expect(ctl!.vistos).toBeLessThan(5);
  });
});
