/**
 * `[KBD.2]` Búsqueda tokenizada **del lado del cliente**, con la MISMA semántica que el servidor.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE, Y POR QUÉ NO ES UN MOTOR NUEVO
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * El motor tokenizado ya existe y es `applySmartSearch`
 * (`libs/platform-core/src/lib/search/smart-search.ts`): normaliza sin acentos, parte el texto en
 * tokens y exige **cada token, en cualquier orden y en cualquier campo**. Esto NO lo reemplaza.
 *
 * Esto cubre el caso que `applySmartSearch` no puede atender: **la lista que ya está entera en
 * el navegador** y se filtra sin ir al servidor — el catálogo que el verificador baja a
 * IndexedDB para trabajar sin red, un combo con sus opciones cargadas, un panel de detalle.
 *
 * ⛔ **El patrón que esto reemplaza, medido: 24 archivos filtran con
 * `x.toLowerCase().includes(q)`.** Ese patrón falla de cuatro formas, y las cuatro se ven en un
 * catálogo de dulcería:
 *
 *   1. **Acentos** — buscás `pina`, existe `PIÑA`, no aparece. (Medido en el servidor sobre
 *      `/compras/costo-estandar`: el `LIKE` ingenuo devolvía **18 filas donde hay 1,425**.)
 *   2. **Varias palabras** — `coca 600` no encuentra `COCA COLA 600 ML`, porque pide esa
 *      cadena exacta y contigua.
 *   3. **El orden** — `600 coca` no encuentra nada, aunque las dos palabras estén ahí.
 *   4. **Un solo campo** — `includes` corre sobre el nombre O sobre el SKU, nunca sobre los dos.
 *
 * ⚠️ **Y la trampa estructural que esto NO arregla:** filtrar en el cliente una lista
 * **PAGINADA** sólo mira las filas que ya llegaron. Buscás algo que existe en la fila 400 y la
 * pantalla dice que no hay. Ahí el arreglo no es tokenizar: es **mandar el texto al servidor**.
 * Esta función es para listas COMPLETAS en memoria; la compuerta `check:busqueda` separa los dos
 * casos y no deja confundirlos.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * LA DIFERENCIA DECLARADA CONTRA EL SERVIDOR
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * El servidor además tolera **typos** por trigramas (`pg_trgm.word_similarity`, tokens
 * alfabéticos de 4+): `erejon` encuentra `herrejon`. **Acá eso NO está**, y se declara en vez de
 * imitarse: una aproximación en JS que *casi* da lo mismo que Postgres es peor que no tenerla —
 * el mismo texto devolvería conjuntos distintos según quién filtró, y nadie sabría cuál creer.
 *
 * O sea: **mismo resultado que el servidor para texto bien escrito; sin tolerancia a typos.**
 * Si una pantalla necesita typos sobre datos locales, el camino es pedirle al servidor, no
 * inventar acá un segundo criterio de verdad.
 */

/** Marcas diacríticas combinantes. El MISMO rango que usa `smart-search.ts` en el servidor. */
const DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Normaliza igual que `public.f_unaccent(lower(...))` en SQL.
 *
 * ⚠️ Esta función es la que tiene que quedarse pegada a la del servidor. Si allá cambia la
 * normalización, acá cambia el mismo día — si no, el mismo texto filtra distinto según dónde
 * se filtró, que es exactamente la clase de bug que nadie reporta porque parece "que no estaba".
 */
export function normalizarBusqueda(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(DIACRITICOS, '').toLowerCase().trim();
}

/**
 * Parte el texto en tokens, igual que el servidor: `norm(raw).split(/\s+/)` sin vacíos.
 *
 * Texto vacío ⇒ **cero tokens**, y cero tokens significa "no filtres nada" (ver `coincide`).
 * Es a propósito: un buscador vacío muestra todo, no muestra nada.
 */
export function tokensDeBusqueda(consulta: string | null | undefined): string[] {
  const n = normalizarBusqueda(consulta);
  return n ? n.split(/\s+/).filter(Boolean) : [];
}

/**
 * ¿Esta fila casa con la consulta?
 *
 * Los campos se concatenan en UN solo pajar —igual que el `concat_ws(' ', …)` del servidor— y se
 * exige **cada token** dentro de él. Por eso `600 coca` y `coca 600` encuentran lo mismo, y por
 * eso un token puede venir del nombre y otro del SKU.
 *
 * @param consulta lo que escribió el usuario.
 * @param campos   los campos de la fila. Los `null`/`undefined` se ignoran sin romper.
 */
export function coincideBusqueda(
  consulta: string | null | undefined,
  ...campos: (string | number | null | undefined)[]
): boolean {
  const tokens = tokensDeBusqueda(consulta);
  if (!tokens.length) return true; // sin texto no se filtra: el buscador vacío muestra todo.
  const pajar = normalizarBusqueda(
    campos.filter((c) => c !== null && c !== undefined && c !== '').join(' '),
  );
  if (!pajar) return false;
  return tokens.every((t) => pajar.includes(t));
}

/**
 * Filtra una lista COMPLETA en memoria.
 *
 * ⚠️ Si la lista viene paginada del servidor, esto filtra sólo la página — ver el encabezado.
 *
 * @param filas  la lista entera.
 * @param consulta lo que escribió el usuario.
 * @param campos función que devuelve los campos buscables de cada fila.
 */
export function filtrarPorBusqueda<T>(
  filas: readonly T[],
  consulta: string | null | undefined,
  campos: (fila: T) => (string | number | null | undefined)[],
): T[] {
  const tokens = tokensDeBusqueda(consulta);
  if (!tokens.length) return filas.slice();
  return filas.filter((f) => {
    const pajar = normalizarBusqueda(
      campos(f).filter((c) => c !== null && c !== undefined && c !== '').join(' '),
    );
    return !!pajar && tokens.every((t) => pajar.includes(t));
  });
}
