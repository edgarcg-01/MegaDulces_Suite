import { montoBuscado } from './cash-ledger.service';

/**
 * `[CG.116]` El buscador de la bandeja de Caja General, leyendo el término **como importe**.
 *
 * Hasta acá el buscador pegaba contra seis columnas de TEXTO y contra ninguna de dinero: el
 * papel que la persona tiene en la mano —el ticket, la ficha de depósito— lo que trae grande es
 * el monto, y era justo lo único con lo que no se podía buscar.
 *
 * ⭐ Se prueba la FUNCIÓN PURA y no la consulta, a propósito: la suite que ejerce la base real
 * (`cash-ledger.grupos-real.spec.ts`) **se saltea sin `CAJA_TEST_DB_URL`**, así que una prueba
 * que viva sólo ahí no corre en CI. Lo que decide qué se busca —cómo se lee el término— es
 * esto, y esto sí corre siempre.
 */
describe('[CG.116] montoBuscado — el término leído como importe', () => {
  describe('lo que SÍ es un importe', () => {
    it('un entero pelado busca el PESO ENTERO, no el centavo exacto', () => {
      // «9781» tiene que encontrar $9,781.50: así se lee un total redondeado, y exigir los
      // centavos haría que el caso más común no encuentre nada.
      expect(montoBuscado('9781')).toEqual({ valor: '9781', entero: true });
    });

    it('con centavos busca EXACTO', () => {
      expect(montoBuscado('9781.50')).toEqual({ valor: '9781.50', entero: false });
    });

    it('acepta lo que una persona copia de un papel: signo de pesos y separadores de miles', () => {
      for (const t of ['$52,050.00', '52,050.00', '$ 52050.00', '52 050.00']) {
        expect(montoBuscado(t), `no leyó "${t}" como importe`).toEqual({ valor: '52050.00', entero: false });
      }
    });

    it('⚠️ limpia el espacio DURO, que es el que traen los PDF y el que no se ve', () => {
      expect(montoBuscado('52 050')).toEqual({ valor: '52050', entero: true });
    });

    it('un solo centavo decimal también vale', () => {
      expect(montoBuscado('1170.5')).toEqual({ valor: '1170.5', entero: false });
    });

    it('cero es un importe: hay movimientos en cero y esconderlos sería decidir por la persona', () => {
      expect(montoBuscado('0')).toEqual({ valor: '0', entero: true });
    });
  });

  describe('⛔ lo que NO es un importe — ahí la búsqueda queda como estaba, sólo texto', () => {
    it.each([
      ['', 'vacío'],
      ['   ', 'sólo espacios'],
      ['BOTANAS PAU', 'un beneficiario'],
      ['X-D-26', 'un tipo de documento'],
      ['U-A-5 0000183', 'documento con folio'],
      ['1.234', 'tres decimales no son centavos'],
      ['12.', 'punto colgado'],
      ['.50', 'sin parte entera'],
      ['-500', 'negativo: la vista fuerza importe > 0'],
      ['1e5', 'notación científica'],
      ['1234567890123', 'trece enteros: eso es un folio largo, no un importe de caja'],
    ])('%s (%s) no se lee como importe', (termino) => {
      expect(montoBuscado(termino)).toBeNull();
    });

    it('null y undefined no revientan', () => {
      expect(montoBuscado(null)).toBeNull();
      expect(montoBuscado(undefined)).toBeNull();
    });
  });

  describe('⛔ [negativa] lo que esto evita', () => {
    it('NO devuelve un número de JavaScript: el valor viaja como CADENA', () => {
      /**
       * Se liga con `?::numeric` para que lo redondee Postgres y no el `double` de JS. `monto`
       * es `numeric` en la vista, y comparar dinero contra un flotante es la forma de que
       * `0.1 + 0.2` termine decidiendo un arqueo.
       */
      const m = montoBuscado('0.30');
      expect(typeof m?.valor, 'el importe volvió como number').toBe('string');
      expect(m?.valor, 'se perdió la forma exacta que tecleó la persona').toBe('0.30');
    });

    it('un folio de puros dígitos SIGUE siendo importe candidato, y eso es a propósito', () => {
      // El buscador es universal: el término se prueba contra texto Y contra monto, así que
      // «90» encuentra el folio que contiene 90 **y** los movimientos de $90.xx. Suma
      // resultados, no los reemplaza — por eso acá no se intenta adivinar la intención.
      expect(montoBuscado('0000090')).toEqual({ valor: '0000090', entero: true });
    });
  });
});
