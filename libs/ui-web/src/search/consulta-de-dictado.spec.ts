// [MCP.26] Sin `import ... from 'vitest'`: la config usa `globals: true` (ver buscar-en-cliente.spec.ts).
import { coincideBusqueda } from './buscar-en-cliente';
import { consultaDeDictado } from './consulta-de-dictado';

/**
 * Nombres con la forma real de Kepler (medida en prod el 2026-11-13): unidad pegada y separada,
 * GR / G / KG / K, marcas con «LA», guion entre palabras.
 */
const LA_ROSA_400 = 'LA ROSA BOMBON MEDIANO BLANCO/ROSA 400GR';
const CAJETA_KG = 'CHOC CAJETA 1KG';
const ARROZ_K = 'ARROZ SUPER EXTRA 1 K';
const COCA_600 = 'COCA-COLA 600 ML';
const CACAHUATE_G = 'CACAHUATE JAPONES 500G';

describe('[MCP.26] lo dictado se convierte en la búsqueda que encuentra el producto', () => {
  it('⭐ prueba negativa: la frase TAL CUAL no encuentra nada (por eso existe la conversión)', () => {
    expect(coincideBusqueda('bombón de la rosa de cuatrocientos gramos', LA_ROSA_400)).toBe(false);
    expect(coincideBusqueda('cajeta de un kilo', CAJETA_KG)).toBe(false);
  });

  it('⭐ convertida, sí: quita «de/la», pasa el número dicho a cifra y la unidad a su abreviatura', () => {
    expect(consultaDeDictado('Bombón de la Rosa de cuatrocientos gramos')).toBe('bombón rosa 400 g');
    expect(coincideBusqueda(consultaDeDictado('Bombón de la Rosa de cuatrocientos gramos'), LA_ROSA_400)).toBe(true);
    expect(consultaDeDictado('cajeta de un kilo')).toBe('cajeta 1 k');
    expect(coincideBusqueda(consultaDeDictado('cajeta de un kilo'), CAJETA_KG)).toBe(true);
  });

  it('«k» y «g» encuentran todas las formas de Kepler: KG y K, GR y G', () => {
    expect(coincideBusqueda(consultaDeDictado('arroz de un kilo'), ARROZ_K)).toBe(true);
    expect(coincideBusqueda(consultaDeDictado('cacahuate japonés quinientos gramos'), CACAHUATE_G)).toBe(true);
    // El reconocedor a veces ya abrevia («1 kg», «500 gr»): se lleva a la misma forma.
    expect(consultaDeDictado('arroz 1 kg')).toBe('arroz 1 k');
    expect(consultaDeDictado('cacahuate 500 gr')).toBe('cacahuate 500 g');
  });

  it('número y unidad pegados se separan: encuentran «600ML» y «600 ML»', () => {
    expect(consultaDeDictado('Coca-Cola de 600ml.')).toBe('coca cola 600 ml');
    expect(coincideBusqueda(consultaDeDictado('Coca-Cola de 600ml.'), COCA_600)).toBe(true);
    expect(coincideBusqueda(consultaDeDictado('coca cola 600 mililitros'), 'COCA COLA 600ML')).toBe(true);
  });

  it('el número con letra sólo se convierte antes de una unidad: «tres leches» se queda', () => {
    expect(consultaDeDictado('pastel tres leches')).toBe('pastel tres leches');
    expect(consultaDeDictado('veinte piezas de chicle')).toBe('20 pz chicle');
  });

  it('el decimal se respeta y «medio kilo» deja sólo la unidad (Kepler escribe 1/2 KG o 500G)', () => {
    expect(consultaDeDictado('agua 1.5 litros')).toBe('agua 1.5 l');
    expect(consultaDeDictado('medio kilo de gomitas')).toBe('k gomitas');
  });

  it('«sabor», «caja» y «una» no están en el nombre: se quitan', () => {
    expect(consultaDeDictado('una caja de paleta sabor fresa')).toBe('paleta fresa');
  });

  it('sólo palabras de enlace, vacío o nulo → nada que buscar', () => {
    expect(consultaDeDictado('de la')).toBe('');
    expect(consultaDeDictado('')).toBe('');
    expect(consultaDeDictado(null)).toBe('');
    expect(consultaDeDictado(undefined)).toBe('');
  });

  it('conserva los acentos de lo dicho (la búsqueda los ignora igual)', () => {
    expect(consultaDeDictado('piña')).toBe('piña');
    expect(coincideBusqueda(consultaDeDictado('piña'), 'PIÑA EN ALMIBAR')).toBe(true);
  });
});
