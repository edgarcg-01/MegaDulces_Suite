/**
 * Placeholder de marca para productos sin foto. Devuelve un gradiente
 * MONOCROMÁTICO (escala Zinc) DETERMINISTA por clave (mismo producto → mismo
 * tono siempre), para que la pared del catálogo sea estable entre cargas.
 * Dirección quiet-luxury (DESIGN.md): el color de marca queda para
 * CTA/promos/estado, no para los thumbnails. El monograma blanco de los
 * consumidores sigue legible porque todos los tonos son oscuros.
 *
 * 2026-09-14: los 8 gradientes pasaron de Stone (carbón cálido) a Zinc al
 * unificar los neutrales de toda la suite. Se conservó el L* EXACTO de cada
 * extremo, así que la progresión de tonos y el contraste del monograma no se
 * movieron — sólo cambió la familia de color.
 *
 * Fuente única: la usan portal-product-card (catálogo) y portal-home
 * ("Comprar de nuevo"), así el lenguaje visual del placeholder es idéntico.
 */
const PH_GRADIENTS = [
  'linear-gradient(140deg, #272728 0%, #0D0D0F 100%)',
  'linear-gradient(140deg, #404042 0%, #171718 100%)',
  'linear-gradient(140deg, #57575A 0%, #272728 100%)',
  'linear-gradient(140deg, #343436 0%, #131315 100%)',
  'linear-gradient(140deg, #4B4B4D 0%, #1D1D1F 100%)',
  'linear-gradient(140deg, #171718 0%, #272728 100%)',
  'linear-gradient(140deg, #646467 0%, #2D2D2F 100%)',
  'linear-gradient(140deg, #333335 0%, #0D0D0F 100%)',
];

export function brandPlaceholderGradient(key: string | null | undefined): string {
  const k = key || '?';
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return PH_GRADIENTS[h % PH_GRADIENTS.length];
}
