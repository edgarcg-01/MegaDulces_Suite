import { describe, expect, it } from 'vitest';
import { aBuscable, coincide, palabrasDeBusqueda } from './busqueda';

describe('[CP.8.78] el buscador del puente — como escribe una persona, sin adivinar', () => {
  const oscar = ['Oscar Hernandez', 'OSCAR HERNANDEZ RODRIGUEZ', 'HERO840925823', 'BANBAJIO 4176'];

  it('sin acentos ni mayúsculas, en cualquier orden', () => {
    expect(coincide(palabrasDeBusqueda('oscar hernandez'), oscar)).toBe(true);
    expect(coincide(palabrasDeBusqueda('Óscar Hernández'), oscar)).toBe(true);
    expect(coincide(palabrasDeBusqueda('hernandez oscar'), oscar)).toBe(true);
  });
  it('por RFC, completo o un pedazo; por razón social aunque el banco diga otra cosa', () => {
    expect(coincide(palabrasDeBusqueda('HERO840925823'), oscar)).toBe(true);
    expect(coincide(palabrasDeBusqueda('hero84'), oscar)).toBe(true);
    expect(coincide(palabrasDeBusqueda('rodriguez'), oscar)).toBe(true);
  });
  it('⛔ TODAS las palabras tienen que estar: una sola no basta', () => {
    expect(coincide(palabrasDeBusqueda('oscar martinez'), oscar)).toBe(false);
  });
  it('⛔ una búsqueda vacía o de una letra no trae nada (no «todo»)', () => {
    expect(coincide(palabrasDeBusqueda(''), oscar)).toBe(false);
    expect(coincide(palabrasDeBusqueda('o'), oscar)).toBe(false);
    expect(coincide(palabrasDeBusqueda(null), oscar)).toBe(false);
  });
  it('los textos nulos no truenan', () => {
    expect(coincide(palabrasDeBusqueda('oscar'), [null, undefined, 'Oscar'])).toBe(true);
    expect(aBuscable('Comisión, S.A. de C.V.')).toBe('COMISION S A DE C V');
  });
});
