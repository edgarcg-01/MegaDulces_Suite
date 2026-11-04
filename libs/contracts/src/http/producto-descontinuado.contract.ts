/**
 * `[PF.20]` Productos DESCONTINUADOS en Kepler: la marca vive en el NOMBRE.
 *
 * Kepler tiene un campo «Obsoleto?» (`kdii.c99`) que nadie llena (0 % en la base local). Lo que hace el capturista
 * es **reemplazar el nombre** por «* DESCONTINUADO»: medido el 2026-11-04 en la base local (sucursal 02, 9,679
 * fichas), 654 nombres traen la marca y **652 son exactamente «* DESCONTINUADO»** —el nombre original se pierde—,
 * con su precio y su costo reales (sólo 9 a $0.01). No son códigos simbólicos (`codigo-simbolico.contract.ts`):
 * son productos que se dejaron de manejar.
 *
 * En `catalog.products` algunos siguen con `activo = true` (22 de 51 en la base local), así que Compras › Catálogo
 * los pintaba «Activo» junto a un nombre que dice lo contrario. Esta es la regla única para reconocerlos; el
 * servidor la usa para mandarlos al final de la lista (`ordenListaCatalogo`) y la pantalla para decirlo.
 *
 * Qué cuenta: uno o más asteriscos y DESCONTINUADO/A(S), en cualquier lugar del nombre y en cualquier mayúscula
 * («* DESCONTINUADO», «*DESCONTINUADO », «***DESCONTINUADO PAL CHUPA CHUPS…»). ⛔ Sin asterisco NO cuenta: un
 * nombre que sólo menciona la palabra no es la marca del capturista.
 */
const PATRON_DESCONTINUADO = /\*+\s*DESCONTINUAD[OA]S?\b/i;

export function esNombreDescontinuado(nombre: string | null | undefined): boolean {
  return PATRON_DESCONTINUADO.test(String(nombre ?? ''));
}

/**
 * La MISMA regla en expresión regular de Postgres, para usarla con `~*` y como BINDING. Como en
 * `PATRON_PROMOCION_PG`, la frontera de palabra de Postgres es `\y` (su `\b` es el retroceso y la apagaría).
 */
export const PATRON_DESCONTINUADO_PG = '\\*+\\s*DESCONTINUAD[OA]S?\\y';

/**
 * El nombre SIN la marca, para pintarlo junto a la etiqueta «Descontinuado» sin repetirla. Quita también el
 * «[SKU]» que queda solo cuando el nombre era únicamente la marca. `''` = Kepler no dejó otro nombre.
 */
export function nombreSinMarcaDescontinuado(nombre: string | null | undefined): string {
  const s = String(nombre ?? '');
  if (!esNombreDescontinuado(s)) return s.trim();
  return s
    .replace(new RegExp(PATRON_DESCONTINUADO.source, 'gi'), ' ')
    .replace(/^[\s*.-]+|[\s*.-]+$/g, '')
    .replace(/^\[\s*\d+\s*\]$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
