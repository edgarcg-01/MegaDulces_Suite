/**
 * Placeholder de marca para productos sin foto. Devuelve un gradiente cálido
 * tipo "candy" DETERMINISTA por clave (mismo producto → mismo color siempre),
 * para que la pared del catálogo sea estable entre cargas. Paleta alineada a
 * los tokens de avatar/chart para cohesión visual en todo el portal.
 *
 * Fuente única: la usan portal-product-card (catálogo) y portal-home
 * ("Comprar de nuevo"), así el lenguaje visual del placeholder es idéntico.
 */
const PH_GRADIENTS = [
  'linear-gradient(135deg, #F8B400 0%, #F05A28 100%)', // ember
  'linear-gradient(135deg, #FDE044 0%, #F8B400 100%)', // amarillo marca
  'linear-gradient(135deg, #F68F1E 0%, #C53E15 100%)', // sunset
  'linear-gradient(135deg, #F472B6 0%, #BE185D 100%)', // berry (chicle)
  'linear-gradient(135deg, #A78BFA 0%, #7E22CE 100%)', // uva
  'linear-gradient(135deg, #2DD4BF 0%, #0F766E 100%)', // menta
  'linear-gradient(135deg, #FB7185 0%, #B91C1C 100%)', // cereza
  'linear-gradient(135deg, #38BDF8 0%, #185FA5 100%)', // blue raspberry
];

export function brandPlaceholderGradient(key: string | null | undefined): string {
  const k = key || '?';
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return PH_GRADIENTS[h % PH_GRADIENTS.length];
}
