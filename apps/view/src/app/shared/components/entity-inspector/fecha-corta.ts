/**
 * `[RE.75]` Las fechas del inspector en el MISMO formato que las listas (`dd/MM/yy`). El servidor las
 * manda ISO (`2026-03-31`) en los campos y dentro de los subtítulos de las relaciones («8 Esquinas ·
 * 2026-03-31»), y la lista de entradas las pinta `31/03/26`: dos formatos de la misma fecha a un clic.
 */
const ISO = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

/** Cada fecha ISO dentro del texto pasa a `dd/MM/yy`; el resto del texto no se toca. */
export function fechasCortas(texto: string): string {
  return texto.replace(ISO, (_m, a: string, m: string, d: string) => `${d}/${m}/${a.slice(2)}`);
}
