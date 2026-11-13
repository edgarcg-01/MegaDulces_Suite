/**
 * `[MCP.26]` **Lo dictado, convertido en una búsqueda de producto.**
 *
 * El micrófono escribe como se habla («bombón de la rosa de un kilo») y Kepler nombra como se
 * abrevia («LA ROSA BOMBON 1KG»). La búsqueda tokenizada (`coincideBusqueda`) exige que CADA palabra
 * esté en el nombre, así que la frase tal cual no encuentra nada: «de» y «un» no están, y «kilo»
 * tampoco. Esto la traduce antes de buscar, y lo traducido es lo que queda escrito en el campo
 * (lo que se ve es lo que se busca).
 *
 * Medido en prod el 2026-11-13 sobre los 11,163 productos activos de `catalog.products`:
 *  - gramos se escribe GR (2,984), G (866) y GRS (16) → se busca «g», que está en las tres;
 *  - kilos: KG (1,143), K (65), KGS (10) → «k»;
 *  - el número va pegado a la unidad 4,644 veces («1KG») y separado 1,602 («1 KG») → número y unidad
 *    van como DOS palabras, que encuentran las dos formas;
 *  - «LA» está en 407 nombres y «DE» en 342, pero «UN» en ninguno: quitar las palabras de enlace
 *    sólo puede AGREGAR resultados (una palabra menos que exigir), nunca quitar.
 *
 * Lo que NO hace, a propósito:
 *  - no corrige errores del reconocedor ni busca por parecido (el mismo límite de `coincideBusqueda`);
 *  - «medio kilo» queda en «k»: Kepler lo escribe «1/2 KG» (28 nombres) o «500G», y adivinar cuál
 *    escondería la otra;
 *  - un código dictado número por número no se arma: para códigos está la cámara.
 */

import { normalizarBusqueda } from './buscar-en-cliente';

/** Palabras de enlace y de unidad de venta: no están en el nombre de Kepler (la caja se elige aparte). */
const SE_QUITAN = new Set([
  'de', 'del', 'la', 'el', 'lo', 'los', 'las', 'con', 'y', 'e', 'en', 'por', 'para', 'a', 'al',
  'un', 'uno', 'una', 'unos', 'unas', 'sabor', 'sabores', 'caja', 'cajas', 'paquete', 'paquetes',
]);

/** La unidad dicha (o abreviada por el reconocedor) → lo que la encuentra en todas sus formas de Kepler. */
const UNIDAD: Record<string, string> = {
  kilo: 'k', kilos: 'k', kilogramo: 'k', kilogramos: 'k', kg: 'k', kgs: 'k', k: 'k',
  gramo: 'g', gramos: 'g', gr: 'g', grs: 'g', grm: 'g', gms: 'g', g: 'g',
  mililitro: 'ml', mililitros: 'ml', ml: 'ml', mls: 'ml',
  litro: 'l', litros: 'l', lt: 'l', lts: 'l', ltr: 'l', l: 'l',
  pieza: 'pz', piezas: 'pz', pz: 'pz', pzs: 'pz', pza: 'pz', pzas: 'pz',
  onza: 'oz', onzas: 'oz', oz: 'oz',
  centimetro: 'cm', centimetros: 'cm', cm: 'cm',
};

/** Un número dicho con letra. Sólo se convierte ANTES de una unidad («tres leches» se queda como está). */
const NUMERO: Record<string, string> = {
  un: '1', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7',
  ocho: '8', nueve: '9', diez: '10', doce: '12', quince: '15', veinte: '20', veinticuatro: '24',
  treinta: '30', cuarenta: '40', cincuenta: '50', cien: '100', ciento: '100', doscientos: '200',
  trescientos: '300', cuatrocientos: '400', quinientos: '500', seiscientos: '600',
  setecientos: '700', ochocientos: '800', novecientos: '900', mil: '1000',
};

/**
 * Convierte la frase dictada en la consulta que la encuentra.
 *
 * @example consultaDeDictado('Bombón de la Rosa de un kilo') === 'bombón rosa 1 k'
 * @example consultaDeDictado('Coca-Cola de 600ml.') === 'coca cola 600 ml'
 * @returns `''` si no queda nada que buscar (sólo se dijeron palabras de enlace).
 */
export function consultaDeDictado(frase: string | null | undefined): string {
  const limpio = String(frase ?? '')
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, '$1\u0000$2') // el punto decimal se respeta: «1.5 litros»
    .replace(/[^\p{L}\p{N}\s/\u0000]/gu, ' ') // «Coca-Cola.» → «coca cola»
    .replace(/\u0000/g, '.')
    .replace(/(\d)(\p{L})/gu, '$1 $2'); // «600ml» → «600 ml»: encuentra «600ML» y «600 ML»
  const palabras = limpio.split(/\s+/).filter(Boolean);
  const salida: string[] = [];
  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i];
    const clave = normalizarBusqueda(p);
    const siguiente = i + 1 < palabras.length ? normalizarBusqueda(palabras[i + 1]) : '';
    if (NUMERO[clave] && UNIDAD[siguiente]) { salida.push(NUMERO[clave]); continue; }
    if (clave === 'medio' && UNIDAD[siguiente]) continue;
    if (UNIDAD[clave]) { salida.push(UNIDAD[clave]); continue; }
    if (SE_QUITAN.has(clave)) continue;
    salida.push(p);
  }
  return salida.join(' ');
}
