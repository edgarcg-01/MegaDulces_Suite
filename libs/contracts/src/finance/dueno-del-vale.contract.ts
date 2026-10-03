/**
 * `[GX.65.4a]` — **Nadie aprueba, valida ni rechaza su propio vale.**
 *
 * Control interno básico (segregación de funciones): quien levanta un gasto no puede ser quien
 * lo revisa. Hasta hoy nada lo impedía — medido en local, **5 de 18** decisiones las tomó el
 * mismo dueño del vale (todas de cuentas de prueba, pero el hueco era real).
 *
 * ## ⚠️ Por qué compara contra DOS identidades de cada lado
 * El sistema guarda personas como texto `full_name || username`. Si alguien capturó cuando no
 * tenía nombre completo, el vale dice `david_cisneros`; si después se lo cargaron, al aprobar
 * llega como «David Cisneros». Comparar un solo texto dejaría pasar justo ese caso.
 *  · El que decide se identifica por su **nombre completo Y su username**.
 *  · El vale tiene dos dueños posibles: quien lo **levantó** (`created_by`) y quien **subió la
 *    evidencia** (`evidencia_por`, GX.34 — también lo hace suyo).
 *  · `link:NOMBRE` (captura por link, GX.9) se compara sin el prefijo.
 *
 * ⛔ Aplica a TODOS, incluido god-mode: «nadie» es nadie. Un director que levanta un gasto lo
 * tiene que revisar otra persona.
 */

export interface IdentidadQueDecide {
  username?: string | null;
  full_name?: string | null;
}

export interface DuenosDelVale {
  created_by?: string | null;
  evidencia_por?: string | null;
}

/** Mayúsculas, sin espacios dobles ni en los bordes, y sin el prefijo `link:`. */
export function normalizarPersona(v: unknown): string {
  return String(v ?? '')
    .replace(/^\s*link:/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** ¿Quien decide es dueño de este vale? Vacíos no cuentan: nadie es dueño de «nada». */
export function esDuenoDelVale(vale: DuenosDelVale, quien: IdentidadQueDecide): boolean {
  const duenos = [vale.created_by, vale.evidencia_por].map(normalizarPersona).filter(Boolean);
  const yo = [quien.username, quien.full_name].map(normalizarPersona).filter(Boolean);
  return yo.some((y) => duenos.includes(y));
}

/** La frase para quien lo intenta. Dice qué pasa y qué hacer, no sólo «prohibido». */
export const MENSAJE_PROPIO_VALE =
  'Este vale es tuyo: lo tiene que revisar otra persona con permiso de autorizar gastos.';
