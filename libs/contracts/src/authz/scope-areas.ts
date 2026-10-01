import { AUTHZ_TREE } from './authz-tree';

/**
 * `[ZN.8]` — **Las áreas donde puede variar el alcance de una persona.**
 *
 * ── De dónde salen, y por qué de ahí ────────────────────────────────────────────────────────
 * Son los **proyectos de `AUTHZ_TREE`**: `compras`, `comercial`, `pdv`, `finanzas`, `almacen`,
 * `logistica`… No se inventa una taxonomía nueva y **no se copia la lista**: se deriva. Copiarla
 * sería el modo de falla de ADR-056 — el día que alguien agregue un proyecto, la copia no se
 * entera y el formulario empieza a rechazar algo legítimo, en silencio.
 *
 * ⚠️ **El id NO es el prefijo de ruta.** El mostrador es `pdv` y su ruta `/tienda`; lo descubrió
 * el propio candado cuando escribí `'tienda'` dando por hecho que coincidían.
 *
 * Es además la granularidad que la persona ya tiene en la cabeza: lo mismo que separa el menú,
 * los permisos y las migas. «En Compras ve todo, en Punto de Venta sólo su plaza» es una
 * frase que alguien puede decir; «en el módulo `goods-receipts` ve todo» no lo es.
 *
 * ⛔ **Por módulo NO.** Son 60+ y nadie mantiene una matriz de 129 personas × 6 dimensiones ×
 * 60 módulos. Una configuración que no se puede auditar de un vistazo se vuelve decorativa.
 */

/** La regla que vale donde no hay una más específica. Debe coincidir con `AREA_DEFECTO`. */
export const AREA_TODAS = '*';

/** Los proyectos del árbol, en su orden de declaración. */
export const AREAS_DE_ALCANCE: readonly { id: string; label: string }[] = AUTHZ_TREE.flatMap(
  (app) => (app.projects ?? []).map((p) => ({ id: p.id, label: p.label })),
);

const IDS = new Set<string>(AREAS_DE_ALCANCE.map((a) => a.id));

/** `'*'` cuenta como área válida: es «todas», no la ausencia de una. */
export const esAreaDeAlcance = (v: string | null | undefined): boolean =>
  v === AREA_TODAS || (!!v && IDS.has(v));

/** La etiqueta para pantalla. `'*'` se nombra, no se deja en blanco. */
export const etiquetaDeArea = (v: string | null | undefined): string => {
  if (!v || v === AREA_TODAS) return 'Todas las áreas';
  return AREAS_DE_ALCANCE.find((a) => a.id === v)?.label ?? v;
};

/** Lo mínimo que la precedencia necesita saber de una regla. */
export interface ReglaConArea {
  dimension: string;
  area?: string | null;
}

/**
 * `[ZN.8]` — **Qué regla gana, de un conjunto que mezcla áreas.**
 *
 * Vive acá, pura y probada, porque es la pieza que **falla en silencio**: si eligiera mal, no
 * hay excepción ni log — simplemente alguien ve de más o de menos, y se descubre semanas
 * después mirando una pantalla rara.
 *
 * Decide **un solo escalón**: dentro de un mismo origen (las reglas del usuario, o las del rol),
 * lo específico del área le gana a `'*'`. El otro escalón —el usuario le gana al rol— lo decide
 * quien llama, aplicando esto dos veces.
 *
 * ⚠️ **No asume orden de llegada.** Postgres no garantiza el orden de un `SELECT` sin `ORDER BY`,
 * así que apoyarse en «la específica viene después» sería un bug que aparece cuando cambia el
 * plan de ejecución — intermitente, o sea el peor de todos.
 */
export function elegirRegla<T extends ReglaConArea>(
  reglas: readonly T[],
  dimension: string,
  area?: string | null,
): T | undefined {
  let general: T | undefined;
  for (const r of reglas) {
    if (r.dimension !== dimension) continue;
    const suArea = r.area ?? AREA_TODAS;
    // Una regla de OTRA área no aplica acá: ignorarla es tan importante como preferir la propia.
    if (suArea === area && area && area !== AREA_TODAS) return r;
    if (suArea === AREA_TODAS) general = r;
  }
  return general;
}
