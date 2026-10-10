import type { PresentacionPrecio } from '@megadulces/contracts';

/**
 * `[ETQ-CAMBIOS.8]` Qué precio lleva la etiqueta cuando se manda desde «Cambios de precio».
 *
 * Es lo que la persona CONFIRMA antes de imprimir. `todos` imprime el precio grande de siempre
 * más las demás presentaciones debajo; el resto imprime sólo esa presentación.
 */
export type ModoPrecio = 'todos' | 'pieza' | 'paquete' | 'caja';

export const MODOS_PRECIO: { label: string; value: ModoPrecio }[] = [
  { label: 'Todos los precios', value: 'todos' },
  { label: 'Pieza', value: 'pieza' },
  { label: 'Paquete', value: 'paquete' },
  { label: 'Caja', value: 'caja' },
];

export const esModoPrecio = (v: unknown): v is ModoPrecio =>
  v === 'todos' || v === 'pieza' || v === 'paquete' || v === 'caja';

/**
 * El rótulo de la presentación que le toca a un modo, o `null` si el producto no la tiene.
 *
 * ⚠️ «Pieza» es la presentación BASE del ERP, no la que se llame `PZA`: en el 73.5% del catálogo
 * la base es `PAQ` y la etiqueta ya dice «Precio por paquete» para ese precio (ver `defaultHero`
 * en la etiquetera). `null` NO es un error — es un producto sin caja (o sin paquete): quien llama
 * lo declara y deja el precio grande que ya tenía, en vez de imprimir otra cosa en silencio.
 */
export function unidadDeModo(ps: readonly PresentacionPrecio[] | undefined, modo: ModoPrecio): string | null {
  if (modo === 'todos') return null;
  const conPrecio = (ps ?? []).filter((p) => !!p?.unidad && (p.precio_lista ?? 0) > 0);
  const rotulo = (p: PresentacionPrecio): string => String(p.unidad).trim().toUpperCase();
  const hit =
    modo === 'pieza' ? conPrecio.find((p) => p.origen === 'base')
    : modo === 'paquete' ? conPrecio.find((p) => rotulo(p) === 'PAQ')
    : conPrecio.find((p) => rotulo(p) === 'CJA');
  return hit ? String(hit.unidad) : null;
}

// La regla de agrupar por código vive en `libs/contracts`: la pantalla y el generador de avisos
// comparten UNA sola, para que lo que la lista agrupa y lo que el aviso cuenta no puedan divergir.
export { agruparPorCodigo } from '@megadulces/contracts';
export type { ProductoCambio } from '@megadulces/contracts';
