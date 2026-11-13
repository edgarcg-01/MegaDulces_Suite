/**
 * `[MOV]` Qué entra en los 4 lugares de la barra inferior del celular.
 *
 * Primero los items con `movil` (1, 2, 3…), que se ponen SÓLO con uso medido; después el resto
 * en el orden del menú de escritorio. Orden estable: dos items sin `movil` nunca se invierten.
 *
 * No filtra permisos: recibe la lista ya filtrada (`navItems()`), así la barra nunca ofrece una
 * pantalla que el menú lateral no ofrecería.
 */
export function ordenarParaBarraMovil<T extends { movil?: number }>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.movil ?? Infinity) - (b.item.movil ?? Infinity) || a.i - b.i)
    .map(({ item }) => item);
}
