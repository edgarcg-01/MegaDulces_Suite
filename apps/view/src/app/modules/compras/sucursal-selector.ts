/**
 * ¿Se le ofrece a esta persona el selector de sucursal?
 *
 * ── Por qué es una función y no un `computed` copiado tres veces ────────────────────────────
 *
 * Esta regla vivía duplicada a mano en `compras-entradas`, `compras-entradas-pendientes` y
 * `compras-entradas-revision`, idéntica en las tres:
 *
 *     computed(() => { const a = this.alcance(); return a === null || a.length > 1; })
 *
 * …y por eso el mismo defecto estaba en las tres a la vez. Una regla repetida no se arregla una
 * vez; se arregla tantas veces como copias tenga, y la última copia es la que nadie encuentra.
 *
 * ── El defecto que obligó a escribirla ──────────────────────────────────────────────────────
 *
 * El backend publicaba bajo `alcance.sucursales` **lo que estabas viendo**, no **lo que podías
 * ver**: era el alcance de permisos ya intersectado con el filtro. Al elegir una sucursal la
 * lista quedaba en UNO, `length > 1` daba false y el selector **desaparecía con el filtro
 * puesto**. Sin control para cambiarlo ni para soltarlo — y como la elección viaja en la URL
 * (`?suc=`) y se relee al montar, recargar tampoco rescataba: la única salida era editar la
 * barra de direcciones.
 *
 * El origen quedó arreglado en `alcanceSucursales()` del servicio, que ahora separa las dos
 * preguntas. Esto es la garantía de que no vuelva desde otro endpoint.
 *
 * ── La regla, en una línea ──────────────────────────────────────────────────────────────────
 *
 * ⭐ **Un control que aplicó un filtro no puede desaparecer**: es el único camino de vuelta.
 *
 * @param visibles Sucursales que la persona PUEDE ver. `null` = alcance `all` (el servidor no
 *                 manda lista y las opciones salen del catálogo). `[]` = no le toca ninguna.
 * @param elegida  La que está filtrando ahora, o `null`.
 */
export function ofrecerSelectorSucursal(
  visibles: readonly string[] | null | undefined,
  elegida: string | null | undefined,
): boolean {
  // Primero, y sin mirar nada más: si hay un filtro puesto, tiene que haber cómo sacarlo.
  if (elegida) return true;
  // `null` no es "ninguna": es "el servidor no acotó". Con alcance de red se ofrece igual.
  if (visibles == null) return true;
  // Con una sola sucursal visible el selector no decide nada, y un control que no decide es ruido.
  return visibles.length > 1;
}
