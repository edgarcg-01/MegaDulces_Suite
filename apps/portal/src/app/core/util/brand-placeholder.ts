/**
 * Placeholder de marca para productos sin foto. Devuelve un gradiente
 * MONOCROMÁTICO (escala Stone, carbón cálido) DETERMINISTA por clave (mismo
 * producto → mismo tono siempre), para que la pared del catálogo sea estable
 * entre cargas. Dirección quiet-luxury (DESIGN.md): el color de marca queda
 * para CTA/promos/estado, no para los thumbnails. El monograma blanco de los
 * consumidores sigue legible porque todos los tonos son oscuros.
 *
 * Fuente única: la usan portal-product-card (catálogo) y portal-home
 * ("Comprar de nuevo"), así el lenguaje visual del placeholder es idéntico.
 */
const PH_GRADIENTS = [
  'linear-gradient(140deg, #2B2620 0%, #100D09 100%)',
  'linear-gradient(140deg, #463F36 0%, #1A1611 100%)',
  'linear-gradient(140deg, #5E564B 0%, #2B2620 100%)',
  'linear-gradient(140deg, #3A332B 0%, #16130F 100%)',
  'linear-gradient(140deg, #514A40 0%, #211D18 100%)',
  'linear-gradient(140deg, #1A1611 0%, #2B2620 100%)',
  'linear-gradient(140deg, #6B6356 0%, #322C25 100%)',
  'linear-gradient(140deg, #38322A 0%, #100D09 100%)',
];

export function brandPlaceholderGradient(key: string | null | undefined): string {
  const k = key || '?';
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return PH_GRADIENTS[h % PH_GRADIENTS.length];
}
