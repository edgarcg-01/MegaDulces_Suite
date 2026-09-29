import { LARGO_MINIMO_USUARIO, esMiVale, normalizarUsuarioKepler } from './vale-asignado.contract';

/**
 * `[GX.41]` La regla que decide **de quién es un vale de Kepler**. Se prueba acá, sin base,
 * porque de ella depende que a alguien le aparezca —o no— el gasto de otro. Mismo criterio
 * que `aporte-solicitante.spec.ts`: se arranca del caso que SÍ casa y se le rompe una cosa.
 */

describe('[GX.41] a quién le toca el vale', () => {
  it('el mismo username casa', () => {
    expect(esMiVale('demo_captura', 'demo_captura')).toBe(true);
  });

  /**
   * ⭐ **El caso que sostiene la fase.** La vista publica `c48` en MAYÚSCULAS
   * (`upper(regexp_replace(btrim(c48),'\s+',' '))`), así que un `demo_captura` tecleado en
   * Kepler llega como `DEMO_CAPTURA`. Con una comparación literal NUNCA casaría — y el
   * defecto no se ve: la sección sale vacía y parece que no le asignaron nada.
   */
  it('casa aunque Kepler lo devuelva en mayúsculas', () => {
    expect(esMiVale('DEMO_CAPTURA', 'demo_captura')).toBe(true);
    expect(esMiVale('demo_captura', 'DEMO_CAPTURA')).toBe(true);
  });

  it('casa con espacios de sobra a los lados', () => {
    expect(esMiVale('   demo_captura  ', 'demo_captura')).toBe(true);
  });

  it('casa con espacios internos de más (la vista los colapsa)', () => {
    expect(esMiVale('JUAN   PEREZ', 'juan perez')).toBe(true);
  });

  /**
   * ⛔ **Nunca parcial.** Un vale mal asignado le muestra a alguien el gasto de otro — es
   * exactamente lo que el usuario pidió que no pasara en GX.34.
   */
  describe('⛔ jamás por parecido', () => {
    it('no casa un prefijo', () => {
      expect(esMiVale('JUANA', 'juan')).toBe(false);
      expect(esMiVale('juan', 'juana')).toBe(false);
    });

    it('no casa un substring', () => {
      expect(esMiVale('1024', '02')).toBe(false);
      expect(esMiVale('demo_captura_2', 'demo_captura')).toBe(false);
    });

    /** El caso real: hoy la caja trae ÁREAS. Ninguna puede llevarse el vale de un usuario. */
    it('un área no casa con un usuario', () => {
      expect(esMiVale('10 PADRE HIDALGO RD', 'demo_captura')).toBe(false);
      expect(esMiVale('8 ESQUINAS', '8')).toBe(false);
    });
  });

  /**
   * ⛔ **El vacío no vincula.** Si lo hiciera, todos los vales con «Solicita» en blanco
   * caerían en el perfil de cualquiera cuyo username llegue vacío por un token raro.
   */
  describe('⛔ el vacío y la basura no vinculan', () => {
    it.each([
      ['', 'demo_captura'], ['   ', 'demo_captura'], [null, 'demo_captura'], [undefined, 'demo_captura'],
      ['demo_captura', ''], ['demo_captura', '   '], ['demo_captura', null], ['demo_captura', undefined],
      [null, null], ['', ''],
    ])('no casa %p con %p', (a, b) => {
      expect(esMiVale(a as string | null, b as string | null)).toBe(false);
    });

    it('un solo carácter no vincula, ni consigo mismo', () => {
      expect(esMiVale('A', 'A')).toBe(false);
      expect(LARGO_MINIMO_USUARIO).toBe(2);
    });

    /** Pero los usuarios reales de 2 caracteres (`02`, `03`) SÍ tienen que funcionar. */
    it('los usuarios de dos caracteres sí vinculan', () => {
      expect(esMiVale('02', '02')).toBe(true);
    });
  });

  it('nunca lanza, por más basura que traiga el campo', () => {
    for (const v of [null, undefined, '', '   ', '\t\n', '💥', '0'.repeat(500)]) {
      expect(() => esMiVale(v as string | null, 'demo_captura')).not.toThrow();
    }
  });
});

describe('[GX.41] la normalización', () => {
  it('deja el valor como lo publica la vista: sin bordes, sin dobles espacios, en mayúsculas', () => {
    expect(normalizarUsuarioKepler('  juan   perez  ')).toBe('JUAN PEREZ');
  });

  it('el vacío y el nulo dan cadena vacía, no explotan', () => {
    expect(normalizarUsuarioKepler(null)).toBe('');
    expect(normalizarUsuarioKepler(undefined)).toBe('');
    expect(normalizarUsuarioKepler('   ')).toBe('');
  });

  /** Es idempotente: normalizar dos veces da lo mismo. Si no, los dos lados se separarían. */
  it('normalizar lo ya normalizado no lo cambia', () => {
    const una = normalizarUsuarioKepler('  demo   captura ');
    expect(normalizarUsuarioKepler(una)).toBe(una);
  });
});
