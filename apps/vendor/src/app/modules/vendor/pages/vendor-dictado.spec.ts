// [MCP.3.15] Las indicaciones del pedido: lo dictado se suma a lo escrito y los sabores se avisan.
import { describe, expect, it } from 'vitest';
import { mencionaSabores, unirDictado } from '../dictado';

describe('unirDictado', () => {
  it('sin texto previo, lo dictado empieza con mayúscula', () => {
    expect(unirDictado('', 'que no vengan golpeadas')).toBe('Que no vengan golpeadas');
  });

  it('se suma con punto si lo anterior no terminaba en punto', () => {
    expect(unirDictado('Bajar por atrás', 'traer cambio de 500')).toBe('Bajar por atrás. Traer cambio de 500');
  });

  it('se suma con espacio si lo anterior ya terminaba en punto', () => {
    expect(unirDictado('Bajar por atrás.', 'traer cambio')).toBe('Bajar por atrás. Traer cambio');
  });

  it('un dictado vacío no cambia lo escrito', () => {
    expect(unirDictado('  Bajar por atrás  ', '   ')).toBe('Bajar por atrás');
  });
});

describe('mencionaSabores', () => {
  it('avisa cuando la indicación nombra sabores (cada sabor es otro producto en Kepler)', () => {
    expect(mencionaSabores('Del Electrolit una de fresa, una de coco y una de uva')).toBe(true);
    expect(mencionaSabores('Que vengan de varios sabores')).toBe(true);
    expect(mencionaSabores('LIMÓN y mandarina')).toBe(true);
  });

  it('no avisa por lo que no cambia el producto', () => {
    expect(mencionaSabores('Las Sabritas con caducidad de diciembre en adelante')).toBe(false);
    expect(mencionaSabores('Bajar por la puerta de atrás, traer cambio de $500')).toBe(false);
    expect(mencionaSabores('')).toBe(false);
  });

  it('no confunde una palabra que sólo contiene el sabor', () => {
    // «uvas» sí es sabor; «Uvalde» o «coconut» no son palabras completas de la lista.
    expect(mencionaSabores('Entregar en la calle Uvalde')).toBe(false);
    expect(mencionaSabores('Moradas no, sólo las cajas cerradas')).toBe(false);
  });
});
