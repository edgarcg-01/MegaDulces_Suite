/**
 * **Lo que se busca cuando alguien DICE el nombre de un producto.**
 *
 * Pura y aparte del service porque es la pieza que se rompió y la que hay que
 * poder probar sin DB ni LLM (mismo patrón que `receiving-origin.ts` y
 * `expiry-short.ts`).
 *
 * El problema medido: la primera versión exigía que **todas** las palabras
 * dichas aparecieran en el nombre del catálogo. Contra los 11,197 productos
 * reales, de 8 frases de prueba **4 devolvían NADA**:
 *
 *   "tengo tres cajas de gansito"  → `tengo` y `tres` no están en ningún nombre
 *   "chicle motita"                → el operador agrega la categoría; el catálogo dice "MOTO C/CHICLE"
 *   "bubulubu de fresa"            → el sabor no está en el nombre
 *   "sabritas adobadas"            → la marca dicha no es la del catálogo ("PAPITAS ADOBADAS")
 *
 * Dos arreglos: **quitar el relleno del habla** (acá) y **puntuar en vez de
 * filtrar** (en el service, con `word_similarity` de pg_trgm). Con eso las 8
 * devuelven referencias útiles.
 */

/**
 * Palabras que el operador dice y el catálogo nunca trae. Si entran a la
 * búsqueda, la envenenan: una sola palabra ausente tiraba el resultado a cero.
 *
 * Ojo con lo que NO está acá a propósito: nada de sabores ni colores
 * ("fresa", "chocolate", "rojo"), porque ésos **sí** aparecen en los nombres y
 * son justo lo que distingue un SKU de otro.
 */
export const RELLENO_HABLA = new Set([
  // Artículos y nexos
  'una', 'uno', 'unos', 'unas', 'del', 'las', 'los', 'que', 'con', 'para', 'por', 'sin', 'mas',
  // Unidades: van en `unit`, no en el nombre del producto
  'caja', 'cajas', 'pieza', 'piezas', 'bulto', 'bultos', 'kilo', 'kilos', 'gramos', 'paquete', 'paquetes',
  // Verbos y muletillas con las que arranca el dictado
  'producto', 'productos', 'quiero', 'dar', 'alta', 'registrar', 'anotar', 'poner',
  'tengo', 'tenemos', 'hay', 'esta', 'este', 'esa', 'ese', 'estos', 'estas', 'son', 'estan',
  // Números dichos con palabra: la cantidad va en `quantity`
  'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce',
  'veinte', 'treinta', 'cien', 'ciento', 'mil',
  // Contexto de la captura, no del producto
  'caduco', 'caducado', 'caducar', 'caducidad', 'vence', 'vencido', 'vencer', 'vencen',
  'anaquel', 'bodega', 'exhibidor', 'sabor', 'marca',
]);

/**
 * Conjugaciones de "caducar" y "vencer": **por prefijo, no por lista**.
 *
 * La lista tenía `caduco/caducado/caducar/caducidad/vence/vencido/vencer/vencen`
 * y el test la reventó con `caducan` y `caducaron` — las conjugaciones del
 * español no se terminan de enumerar nunca, y cada una que falte envenena la
 * búsqueda. Ningún producto de dulcería se llama `caduc*` ni `venc*`.
 */
const RELLENO_PREFIJOS = /^(caduc|venc)/;

/** Palabras más cortas que esto no distinguen nada ("de", "kg", "pz"). */
const MIN_LARGO = 3;
/** Más de esto es una frase, no un nombre de producto: se corta. */
const MAX_PALABRAS = 6;

/**
 * Minúsculas, sin acentos y sin signos — exactamente como se compara contra el
 * catálogo (que en SQL se normaliza con `translate`, no con `unaccent()`,
 * porque esa extensión no vive en el mismo schema en todos los entornos).
 */
export function normalizarFrase(texto: string | null | undefined): string {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Las palabras que de verdad sirven para buscar, sin el relleno del habla. */
export function palabrasDeBusqueda(texto: string | null | undefined): string[] {
  return normalizarFrase(texto)
    .split(' ')
    .filter((w) => w.length >= MIN_LARGO && !RELLENO_HABLA.has(w) && !RELLENO_PREFIJOS.test(w))
    .slice(0, MAX_PALABRAS);
}

/**
 * El nombre del catálogo, dicho de forma escuchable.
 *
 * Los nombres del ERP traen ruido que en voz alta estorba: el código de empaque
 * al final (`/12`, `/1`), asteriscos de promoción y dobles espacios. El operador
 * necesita reconocer el producto, no oír el SKU completo.
 */
export function nombreParaDecir(nombre: string | null | undefined, largoMax = 42): string {
  const limpio = String(nombre ?? '')
    .replace(/\s*\/\s*\d+\s*$/g, '')
    .replace(/[*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > largoMax ? limpio.slice(0, largoMax).trim() : limpio;
}
