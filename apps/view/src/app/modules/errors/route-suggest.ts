/**
 * Parecido entre la URL que se tecleó y las rutas reales de la app.
 *
 * Vive aparte del componente y sin nada de Angular a propósito: es la parte que
 * puede quedar tonta (sugerir cualquier cosa) y así se prueba corriéndola.
 */

/** Levenshtein normalizado a 0..1. Sin dependencias: son cadenas de <30 chars. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * Parecido 0..1 entre los segmentos tecleados y una ruta real.
 *
 * Manda el último segmento (0.5): es el que nombra la sección. El proyecto suma
 * (0.35) porque el error típico es acertarle al proyecto y errarle a la sección
 * — `/comercial/precios` cuando la ruta es `/comercial/pricing` — y el resto
 * (0.15) premia coincidencias de en medio.
 */
export function score(segs: string[], route: string): number {
  const target = route.split('/').filter(Boolean);
  if (!target.length || !segs.length) return 0;
  const last = similarity(segs[segs.length - 1], target[target.length - 1]);
  // Compuerta: si el nombre de la sección no se parece, no es candidata por más
  // que coincida el proyecto. Sin esto, "mismo proyecto" (0.35) + un segmento
  // compartido ya cruzaba el umbral y CUALQUIER ruta del proyecto aparecía como
  // sugerencia — verificado: /comercial/precios ofrecía Promociones y Productos.
  if (last < LAST_SEGMENT_MIN) return 0;
  const sameProject = segs[0] === target[0] ? 1 : 0;
  const shared = target.filter((s) => segs.includes(s)).length / target.length;
  return sameProject * 0.35 + last * 0.5 + shared * 0.15;
}

/** Piso de parecido del último segmento para siquiera considerar una ruta. */
export const LAST_SEGMENT_MIN = 0.5;

/**
 * Umbral para mostrar una sugerencia. Calibrado corriéndolo contra el árbol real
 * (ver `_nf_suggest_check`): por debajo empiezan a colarse rutas que no tienen
 * nada que ver, y en un 404 una sugerencia equivocada es peor que ninguna.
 */
export const SUGGEST_MIN_SCORE = 0.45;

/** Cuántas ofrecer. Más de tres deja de ser una pista y vuelve a ser un menú. */
export const SUGGEST_MAX = 3;

/** Ordena candidatos por parecido y devuelve los mejores por encima del umbral. */
export function rankRoutes<T extends { route: string }>(url: string, candidates: T[]): T[] {
  const segs = url.split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (!segs.length) return [];
  return candidates
    .map((c) => ({ c, s: score(segs, c.route) }))
    .filter((x) => x.s > SUGGEST_MIN_SCORE)
    .sort((a, b) => b.s - a.s)
    .slice(0, SUGGEST_MAX)
    .map((x) => x.c);
}
