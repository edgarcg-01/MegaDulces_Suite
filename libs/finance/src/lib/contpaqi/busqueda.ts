/**
 * `[CP.8.78]` La coincidencia del buscador del puente. Pura, para poder probarla sin base.
 *
 * Se busca como escribe una persona: sin acentos, sin mayúsculas, en cualquier orden y con palabras sueltas.
 * «oscar hernandez» encuentra «Oscar Hernandez R», «OSCAR HERNÁNDEZ RODRÍGUEZ» y «Hernandez Oscar».
 * Cada palabra de la búsqueda tiene que aparecer en ALGUNO de los textos del movimiento (concepto, razón
 * social, RFC, banco); un pedazo basta («HERO84» encuentra el RFC). ⛔ Sin coincidencias aproximadas: un
 * buscador que «adivina» devuelve proveedores que no son, y en contabilidad eso se confirma por error.
 */
export function palabrasDeBusqueda(q: string | null | undefined): string[] {
  return [...new Set(aBuscable(q).split(' ').filter((w) => w.length >= 2))];
}

/** Mayúsculas, sin acentos, sólo letras y números separados por un espacio. */
export function aBuscable(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** ¿Todas las palabras aparecen en alguno de los textos? Sin palabras, no coincide nada. */
export function coincide(palabras: string[], textos: unknown[]): boolean {
  if (!palabras.length) return false;
  const pajar = ` ${textos.map(aBuscable).join(' ')} `;
  return palabras.every((w) => pajar.includes(w));
}
