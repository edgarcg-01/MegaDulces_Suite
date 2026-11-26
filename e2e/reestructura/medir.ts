import type { Page } from '@playwright/test';

/**
 * `[GP.RF.0]` El instrumento de la auditoría: lo que se mide en CADA pantalla, igual en todas.
 * Su control (una página con respuestas conocidas) está en `paso0.e2e.ts`: si no acierta, no se
 * publica ninguna medición (skill `auditoria-diseno` §4).
 *
 * Mide sobre lo PINTADO, no sobre la plantilla (Cruce 4): sólo cuenta lo visible en la primera
 * pantalla (el viewport), salvo donde se dice «toda la página».
 */
export interface Medicion {
  /** Elementos accionables visibles en la primera pantalla (Hick: decisiones simultáneas). */
  controles: number;
  /** Cifras visibles en la primera pantalla (montos, conteos, porcentajes). */
  cifras: number;
  /** Textos visibles en la primera pantalla que no llegan a WCAG AA (4.5:1, o 3:1 si es grande). */
  contraste_falla: number;
  /** Hasta 5 ejemplos de lo anterior: texto, ratio y colores. */
  contraste_ejemplos: { texto: string; ratio: number; color: string; fondo: string }[];
  /** Niveles distintos de tamaño de letra en lo visible (Q.5 pide al menos 3). */
  tamanos_letra: number;
  /** Texto visible más chico, en px. */
  letra_min_px: number | null;
  /** Píxeles desde el borde superior hasta la primera fila de trabajo (marco contra trabajo). */
  marco_px: number | null;
  /** Encabezados h1 de la página, por texto. */
  h1: string[];
  /** Accionables visibles de menos de 24 px de alto (WCAG 2.5.8; el piso táctil del repo es 44). */
  objetivos_chicos: number;
}

/** Corre dentro de la página. Sin dependencias: se serializa tal cual. */
function medirEnPagina(): Medicion {
  const W = innerWidth, H = innerHeight;
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  // Color de cualquier formato CSS (rgb, oklch, color(srgb …)) → rgba 0..255, vía un canvas: el
  // navegador hace la conversión. (El helper que parseaba a mano ya falló una vez, skill §4.)
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  const rgba = (c: string): [number, number, number, number] => {
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
  };
  const fondo = (el: Element | null): [number, number, number] => {
    for (let e = el; e; e = e.parentElement) {
      const [r, g, b, a] = rgba(getComputedStyle(e).backgroundColor);
      if (a > 0.95) return [r, g, b];
    }
    return [255, 255, 255];
  };
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a: number[], b: number[]) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=checkbox],[role=switch],[role=combobox],[role=menuitem],[role=radio]';
  const acc = [...document.querySelectorAll(SEL)].filter(visible)
    // Un accionable dentro de otro (un span role=button dentro de un <a>) cuenta una vez.
    .filter((el, _i, arr) => !arr.some((o) => o !== el && o.contains(el)));

  const tamanos = new Set<number>();
  let letraMin: number | null = null, cifras = 0, contrasteFalla = 0;
  const ejemplos: Medicion['contraste_ejemplos'] = [];
  const vistos = new Set<Element>();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = (n.textContent || '').trim();
    const el = n.parentElement;
    if (!t || !el || !visible(el)) continue;
    cifras += (t.match(/[-−+]?\$?\d[\d,]*(\.\d+)?\s?%?/g) || []).length;
    if (vistos.has(el)) continue;
    vistos.add(el);
    const s = getComputedStyle(el);
    const px = parseFloat(s.fontSize);
    tamanos.add(Math.round(px));
    letraMin = letraMin == null ? px : Math.min(letraMin, px);
    const [r, g, b, a] = rgba(s.color);
    const bg = fondo(el);
    const fg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const k = ratio(fg, bg);
    const grande = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
    if (k < (grande ? 3 : 4.5)) {
      contrasteFalla++;
      if (ejemplos.length < 5) ejemplos.push({ texto: t.slice(0, 40), ratio: Math.round(k * 100) / 100, color: s.color, fondo: `rgb(${bg.join(',')})` });
    }
  }
  const fila = [...document.querySelectorAll('tbody tr, [role=row]')].find(visible);
  return {
    controles: acc.length,
    cifras,
    contraste_falla: contrasteFalla,
    contraste_ejemplos: ejemplos,
    tamanos_letra: tamanos.size,
    letra_min_px: letraMin,
    marco_px: fila ? Math.round(fila.getBoundingClientRect().top) : null,
    h1: [...document.querySelectorAll('h1')].filter(visible).map((h) => (h.textContent || '').trim()),
    objetivos_chicos: acc.filter((el) => el.getBoundingClientRect().height < 24).length,
  };
}

/**
 * Lo que el árbol de accesibilidad de Chromium dice que NO tiene nombre (el algoritmo real de
 * nombre accesible, no uno a mano): botones, ligas, campos y pestañas sin nombre, en toda la página.
 */
export async function sinNombre(page: Page): Promise<{ total: number; ejemplos: string[] }> {
  const yaml = await page.locator('body').ariaSnapshot();
  const malos = yaml.split('\n').map((l) => l.trim())
    .filter((l) => /^- (button|link|textbox|combobox|checkbox|tab|switch|radio|menuitem|spinbutton|searchbox)(\s*\[[^\]]*\])?:?$/.test(l));
  return { total: malos.length, ejemplos: malos.slice(0, 5) };
}

export async function medir(page: Page): Promise<Medicion & { sin_nombre: number; sin_nombre_ejemplos: string[] }> {
  const m = await page.evaluate(medirEnPagina);
  const s = await sinNombre(page);
  return { ...m, sin_nombre: s.total, sin_nombre_ejemplos: s.ejemplos };
}

/**
 * Los textos con contenido propio cuyo borde derecho cae FUERA de la ventana: se cortan y no se pueden
 * leer. Medido con la pantalla QUIETA.
 *
 * ⛔ Sin esperar a las animaciones el panel lateral se mide a medio deslizar: el 2026-11-18 eso dio 31
 * elementos «cortados» que un segundo después eran 0, y se reportó como defecto sin serlo.
 *
 * ⭐ Vive acá y no en una prueba porque ya se había escrito dos veces. `solicitud-gasto/solicitud.e2e.ts`
 * conserva su copia local (`fueraDeLaPantalla`) hasta que su fase la pueda tocar: esa es la deuda, con
 * nombre. El 2026-11-26 esta medición faltaba en `comisiones-kepler` y por eso la prueba dio verde con
 * «libro importado hace 16 d» cortado por el borde en /finanzas/bancos — lo encontró la captura, no el
 * instrumento.
 */
export async function cortados(page: Page, limite = 12): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), undefined, { timeout: 5_000 })
    .catch(() => undefined);
  return page.evaluate((n) => {
    const ancho = window.innerWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const propio = Array.from(el.childNodes).filter((x) => x.nodeType === 3).map((x) => x.textContent ?? '').join('').trim();
      if (!propio) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden') continue;
      // (a) El texto se sale de la VENTANA.
      if (r.right > ancho + 1) { out.push(`fuera de la ventana: ${propio.slice(0, 60)} (borde ${Math.round(r.right)} > ${ancho})`); continue; }
      // (b) El texto no cabe en SU PROPIA CAJA y el contenedor lo recorta sin dejar cómo verlo. Es el caso
      //     que (a) no puede ver —el padre limita el rect del hijo, así que nunca desborda la ventana— y el
      //     que de verdad aparece en las capturas. Con `scroll`/`auto` el texto sigue siendo alcanzable.
      // ⛔ Las cajas de 1 px con clip son `sr-only`: texto puesto a propósito SÓLO para el lector de
      //    pantalla. Contarlas como «recortado» es el instrumento midiendo la técnica, no un defecto
      //    (el 2026-11-26 fue el único hallazgo de un barrido, y era «Los datos pueden estar atrasados»).
      const recorta = (s.overflowX === 'hidden' || s.overflowX === 'clip') && r.width > 24;
      if (recorta && el.scrollWidth > el.clientWidth + 1) {
        out.push(`recortado por su caja${s.textOverflow === 'ellipsis' ? ' (con «…»)' : ' SIN aviso'}: ${propio.slice(0, 60)} (${el.scrollWidth} > ${el.clientWidth} px)`);
      }
    }
    return out.slice(0, n);
  }, limite);
}
