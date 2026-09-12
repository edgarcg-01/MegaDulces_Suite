import {
  ajustarARejilla,
  bajarEscalon,
  conteoExacto,
  escalera,
  factorDe,
  hayEleccion,
  subirEscalon,
} from './qty-units';

/**
 * Los candados de la captura de cantidad en /vendor/take-order.
 *
 * Cada bloque trae su PRUEBA NEGATIVA: la formula vieja corriendo sobre el MISMO
 * caso, para que se vea que el caso no es degenerado y que el candado mide algo
 * (ADR-056 -- un gate sin prueba negativa es una intencion).
 */
describe('qty-units · la cantidad que se ve es la que se pide', () => {
  describe('escalera de medidas', () => {
    it('⭐ colapsa el rotulo repetido con el MISMO factor (2,061 de 8,928 SKU en prod)', () => {
      // Lo que manda hoy el catalogo para esos SKU.
      const cruda = [
        { unit: 'PZA', factor: 1 },
        { unit: 'PZA', factor: 1 },
        { unit: 'PZA', factor: 1 },
      ];
      expect(escalera(cruda)).toEqual([{ unit: 'PZA', factor: 1 }]);
      // Y por lo tanto NO se ofrece elegir: no hay nada que elegir.
      expect(hayEleccion(cruda)).toBe(false);
      // Prueba negativa: la lista cruda si tenia 3 entradas y 1 solo rotulo distinto
      // -> el selector se pintaba con 3 chips identicos y clave @for duplicada.
      expect(cruda.length).toBe(3);
      expect(new Set(cruda.map((u) => u.unit)).size).toBe(1);
    });

    it('⭐ el rotulo repetido con factor DISTINTO se desambigua, no se descarta', () => {
      // Medido en prod: 1 SKU donde PAQ vale 1 y 11 a la vez.
      const cruda = [
        { unit: 'PAQ', factor: 1 },
        { unit: 'PAQ', factor: 11 },
        { unit: 'CJA', factor: 66 },
      ];
      const e = escalera(cruda);
      // Las tres presentaciones sobreviven (esconder una tapaba media escalera)...
      expect(e.map((u) => u.factor)).toEqual([1, 11, 66]);
      // ...y ningun rotulo se repite, asi que el @for tiene claves unicas.
      expect(new Set(e.map((u) => u.unit)).size).toBe(3);
      expect(e[1].unit).toBe('PAQ x11');
      expect(hayEleccion(cruda)).toBe(true);
    });

    it('descarta factores no usables sin tumbar la escalera', () => {
      expect(escalera([{ unit: 'PZA', factor: 1 }, { unit: 'CJA', factor: 0 }, { unit: '', factor: 5 }]))
        .toEqual([{ unit: 'PZA', factor: 1 }]);
      expect(escalera(null)).toEqual([]);
      expect(escalera([])).toEqual([]);
      expect(factorDe(null)).toBe(1);
      expect(factorDe({ unit: 'CJA', factor: Number.NaN })).toBe(1);
      expect(factorDe({ unit: 'CJA', factor: -3 })).toBe(1);
    });
  });

  describe('la fila nunca muestra un numero que no es', () => {
    it('⭐ una cantidad fuera de rejilla se DECLARA, no se redondea', () => {
      // 5 piezas con paquete de 6: no hay forma honesta de decirlo en paquetes.
      expect(conteoExacto(5, 6)).toBeNull();
      // Prueba negativa -- la formula vieja: Math.round(5 / 6) = 1.
      // La fila decia "1 PAQ" (= 6 piezas) sobre un pedido de 5.
      expect(Math.round(5 / 6)).toBe(1);

      // Y el caso que dejaba la fila en CERO con la linea ya creada:
      expect(conteoExacto(3, 8)).toBeNull();
      expect(Math.round(3 / 8)).toBe(0);
    });

    it('en rejilla el conteo es exacto, y su vuelta a base tambien', () => {
      for (const [base, f] of [[12, 12], [24, 12], [6, 6], [7, 1], [0, 8]] as const) {
        const n = conteoExacto(base, f);
        expect(n).not.toBeNull();
        expect((n as number) * f).toBe(base); // la invariante, literal
      }
    });
  });

  describe('el escalon sube y baja al mismo lugar', () => {
    it('⭐ "+" y luego "−" vuelven al punto de partida', () => {
      for (const f of [1, 6, 8, 12, 24]) {
        for (const base of [0, f, f * 3]) {
          expect(bajarEscalon(subirEscalon(base, f), f)).toBe(base);
        }
      }
    });

    it('⭐ desde fuera de rejilla, un toque ACOMODA en vez de arrastrar el resto', () => {
      // 5 piezas, paquete de 6.
      expect(subirEscalon(5, 6)).toBe(6); // sube al paquete completo
      expect(bajarEscalon(5, 6)).toBe(0); // baja al escalon inmediato inferior
      // Prueba negativa -- la formula vieja (base ± factor) dejaba el resto pegado
      // para siempre: 5 + 6 = 11, que sigue sin ser multiplo de 6, y la fila
      // mostraba Math.round(11 / 6) = 2 sobre un pedido de 11 piezas (= 1.83 paq).
      expect(5 + 6).toBe(11);
      expect(11 % 6).not.toBe(0);
      expect(Math.round(11 / 6)).toBe(2);
      expect(conteoExacto(11, 6)).toBeNull();
    });

    it('nunca baja de cero', () => {
      expect(bajarEscalon(0, 12)).toBe(0);
      expect(bajarEscalon(4, 12)).toBe(0);
      expect(bajarEscalon(12, 12)).toBe(0);
    });
  });

  describe('la cantidad inicial nace en rejilla', () => {
    it('⭐ el promedio historico se acomoda a la presentacion activa', () => {
      expect(ajustarARejilla(5, 6)).toBe(6); // 5 piezas -> 1 paquete de 6
      expect(ajustarARejilla(3, 8)).toBe(8); // 3 piezas -> 1 caja de 8
      expect(ajustarARejilla(13, 6)).toBe(18); // 13 -> 3 paquetes, no 2.16
      expect(ajustarARejilla(0, 12)).toBe(12); // nunca crea una linea vacia
      expect(ajustarARejilla(7, 1)).toBe(7); // sin presentacion, no toca nada
    });

    it('respeta el minimo de compra, que viene en unidad base', () => {
      expect(ajustarARejilla(2, 6, 10)).toBe(12); // min 10 -> 2 paquetes de 6
      expect(ajustarARejilla(2, 1, 10)).toBe(10);
    });

    it('⭐ todo lo que nace aca se puede mostrar sin mentir', () => {
      for (const f of [1, 5, 6, 8, 10, 12, 20, 24]) {
        for (const avg of [1, 3, 5, 7, 13, 25, 100]) {
          const base = ajustarARejilla(avg, f);
          expect(conteoExacto(base, f)).not.toBeNull();
        }
      }
    });
  });
});
