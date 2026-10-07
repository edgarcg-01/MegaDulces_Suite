/**
 * Vocabulario del buscador de artículos de cotizaciones (COT.16).
 *
 * Quien levanta un pedido por teléfono escribe lo que el cliente DICE ("paleta jumbo cereza",
 * "chocolate ranita"), y Kepler guarda los nombres con SUS abreviaturas ("PAL JUMBO CEREZA",
 * "CHOC RANITA"). Sin este puente esas búsquedas daban cero resultados: en la simulación de 3
 * pedidos dictados de 15 partidas, 7 de 45 búsquedas hubo que reescribirlas.
 *
 * ⚠️ Las abreviaturas NO se inventaron: son los tokens más frecuentes en los nombres de
 * `analytics.v_label_prices` (sucursal 01, medido 2026-10-01): PAL 585 · CHOC 380 · GALL 264 ·
 * EST 212 · CAR 124 · BOL 119 · BLS 79 · VIT 283 · EXH 81 · CAM 68 · GDE 39 · PAQ 55 · PZS 67.
 * Si se agrega una, medirla primero contra el catálogo.
 *
 * Los sinónimos se buscan como PALABRA COMPLETA (no substring): `pal` no pega con "PALOMITAS".
 * Claves = palabra hablada en singular (el buscador prueba el singular solo: "paletas" → "paleta").
 */
export const SINONIMOS_CATALOGO: Record<string, string[]> = {
  paleta: ['pal'],
  chocolate: ['choc', 'choco'],
  galleta: ['gall'],
  caramelo: ['car'],
  estuche: ['est'],
  bolsa: ['bol', 'bls'],
  vitrolero: ['vit'],
  exhibidor: ['exh'],
  camiseta: ['cam'],
  cortada: ['cort'],
  grande: ['gde'],
  paquete: ['paq', 'pack'],
  pieza: ['pz', 'pzs', 'pza'],
  // Medidas: el catálogo las pega al número ("CANELS 4S BOLSA 1Kg", "MANGO 1K", "500GR") y
  // el buscador acepta el sinónimo con un dígito por delante.
  kilo: ['kg', 'k', 'kl'],
  kilogramo: ['kg'],
  gramo: ['gr', 'g'],
  litro: ['lt', 'l'],
  mililitro: ['ml'],
  // Diminutivos de tamaño que el catálogo escribe "MINI" ("los takis chiquitos").
  chiquito: ['mini'],
  chiquita: ['mini'],
};

/**
 * Palabras de relleno del dictado que el nombre del producto no trae: "altos 25 POR 35",
 * "canels bolsa DE kilo", "los takis chiquitos". No se exigen en la búsqueda.
 */
export const PALABRAS_RELLENO = ['de', 'del', 'la', 'las', 'el', 'los', 'por', 'con', 'y', 'un', 'una', 'unos', 'unas', 'x'];
