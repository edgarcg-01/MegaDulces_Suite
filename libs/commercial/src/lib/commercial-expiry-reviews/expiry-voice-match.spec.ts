import { normalizarFrase, palabrasDeBusqueda, nombreParaDecir, RELLENO_HABLA } from './expiry-voice-match';

/**
 * Los casos son **las frases que fallaron de verdad** contra los 11,197
 * productos del catálogo, no ejemplos inventados. Cada `it` deja escrito por qué
 * la búsqueda devolvía cero y qué palabra la envenenaba.
 */
describe('expiry-voice-match — qué se busca cuando alguien DICE un producto', () => {
  describe('palabrasDeBusqueda', () => {
    it('tira el relleno del habla: "tengo tres cajas de gansito" busca solo gansito', () => {
      // Con `tengo` y `tres` adentro, el AND contra el catálogo daba 0 resultados.
      expect(palabrasDeBusqueda('tengo tres cajas de gansito')).toEqual(['gansito']);
    });

    it('aguanta la frase completa de dictado sin quedarse sin palabras', () => {
      expect(palabrasDeBusqueda('quiero registrar unas paletas payaso que caducan'))
        .toEqual(['paletas', 'payaso']);
    });

    it('CONSERVA el sabor: "fresa" y "chocolate" sí están en los nombres del catálogo', () => {
      // Es la diferencia entre relleno y dato: quitar el sabor confundiría dos SKUs.
      expect(palabrasDeBusqueda('bubulubu de fresa')).toEqual(['bubulubu', 'fresa']);
      expect(palabrasDeBusqueda('mazapan con chocolate')).toEqual(['mazapan', 'chocolate']);
    });

    it('quita acentos (se dicta "mazapan", el catálogo dice "MAZAPAN")', () => {
      expect(palabrasDeBusqueda('mazapán de la rosa')).toEqual(['mazapan', 'rosa']);
    });

    it('descarta palabras de menos de 3 letras, que no distinguen nada', () => {
      expect(palabrasDeBusqueda('pan de kg')).toEqual(['pan']);
    });

    it('corta a 6 palabras: más que eso es una frase, no un nombre', () => {
      expect(palabrasDeBusqueda('alfa beta gama delta epsilon zeta eta theta')).toHaveLength(6);
    });

    it('con puro relleno devuelve vacío (el service pide el nombre de nuevo)', () => {
      expect(palabrasDeBusqueda('tengo unas cajas que ya caducaron')).toEqual([]);
    });

    it('no trae vacíos ni espacios cuando el dictado viene sucio', () => {
      expect(palabrasDeBusqueda('  ¡¡gansito!!,   mini  ')).toEqual(['gansito', 'mini']);
    });
  });

  describe('normalizarFrase', () => {
    it('deja la frase como se compara contra el catálogo', () => {
      expect(normalizarFrase('Coca-Cola 600ml ¡FRÍA!')).toBe('coca cola 600ml fria');
    });

    it('tolera null/undefined sin lanzar (viene de una transcripción)', () => {
      expect(normalizarFrase(null)).toBe('');
      expect(normalizarFrase(undefined)).toBe('');
    });
  });

  describe('nombreParaDecir', () => {
    it('quita el código de empaque del final, que en voz alta estorba', () => {
      expect(nombreParaDecir('IND PALETA PAYASO GDE RICOLINO /1')).toBe('IND PALETA PAYASO GDE RICOLINO');
      expect(nombreParaDecir('MOTO C/CHICLE /5 MAYRA')).toBe('MOTO C/CHICLE /5 MAYRA'); // en medio NO se toca
    });

    it('limpia asteriscos de promoción y espacios dobles', () => {
      expect(nombreParaDecir('*  MOTO  C/CHICLE   CARAMELO')).toBe('MOTO C/CHICLE CARAMELO');
    });

    it('recorta los nombres kilométricos del ERP', () => {
      const largo = '3 BLS SALSA MEGA CHAMOY 1 LT  O 1 1/2 = GRATIS 1 MAS';
      expect(nombreParaDecir(largo).length).toBeLessThanOrEqual(42);
    });

    it('sin nombre no revienta', () => {
      expect(nombreParaDecir(null)).toBe('');
    });
  });

  describe('RELLENO_HABLA', () => {
    it('no incluye sabores ni colores: son lo que distingue un SKU', () => {
      for (const dato of ['fresa', 'chocolate', 'mango', 'rojo', 'natural']) {
        expect(RELLENO_HABLA.has(dato)).toBe(false);
      }
    });
  });
});
