// Sin `import ... from 'vitest'`: la config usa `globals: true`, y acá eso hace que el archivo
// NO CARGUE y reporte 0 tests en vez de fallar. Lo vigila `npm run check:spec-vivo`. [CG.38.1]
import { fondoSugerido, cuadreApertura } from './cash-opening.engine';

/**
 * `[CG.39]` Lo que se prueba es que **el cero no vuelva**. El campo `fondo_inicial` existía desde
 * `[CG.26]` con `NOT NULL DEFAULT 0` y un `?? 0` en el servicio: el arranque de la caja era un
 * cero que afirmaba *"arrancó vacía"*. Casi todas las pruebas de abajo son negativas por eso.
 */
describe('[CG.39] el estado inicial de la caja', () => {
  //  500×6 + 100×2 + 20×2 + 10×5 + 5×2 = 3000+200+40+50+10 = 3,300. El sellado coincide con su
  //  desglose a propósito: así el caso feliz NO arrastra una advertencia y las pruebas de abajo
  //  pueden afirmar `limites: []` sin trampa.
  const CIERRE = {
    folio: 'CC-2026-00041',
    fecha: '2026-10-05',
    contado: 3300,
    denominaciones: { '500': 6, '100': 2, '20': 2, '10': 5, '5': 2 } as Record<string, number>,
  };

  it('el arranque de hoy es el cierre de ayer, con su folio a la vista', () => {
    const r = fondoSugerido(CIERRE);
    expect(r.monto).toBe(3300);
    expect(r.origen).toBe('cierre_anterior');
    expect(r.procedencia).toContain('CC-2026-00041');
    expect(r.procedencia).toContain('2026-10-05');
    expect(r.limites).toEqual([]);
  });

  it('hereda el DESGLOSE, que es lo que permite saber si hay con qué dar cambio', () => {
    const r = fondoSugerido(CIERRE);
    expect(r.denominaciones['10']).toBe(5);
    expect(r.denominaciones['5']).toBe(2);
  });

  /** ⭐ La prueba que da sentido a la fase. */
  it('⛔ [negativa] sin corte anterior NO devuelve cero: devuelve "no se midió"', () => {
    const r = fondoSugerido(null);
    expect(r.monto).toBeNull();            // y NO 0
    expect(r.origen).toBe('sin_medir');
    expect(r.procedencia).toContain('nadie sabe');
    expect(r.limites.length).toBeGreaterThan(0);
  });

  it('⛔ [negativa] un cierre SIN conteo tampoco inventa un arranque', () => {
    const r = fondoSugerido({ folio: 'CC-2026-00042', fecha: '2026-10-05', contado: null, denominaciones: null });
    expect(r.monto).toBeNull();
    expect(r.origen).toBe('sin_medir');
    expect(r.procedencia).toContain('SIN conteo');
  });

  /**
   * El sellado y el desglose son dos capturas distintas. Si no coinciden, hay dinero del que no
   * sabemos la forma — y la reja de apertura va a arrancar incompleta sin avisar.
   */
  it('⛔ [negativa] si el sellado y su desglose no coinciden, la diferencia se NOMBRA', () => {
    //  Selló 3,350 pero las piezas suman 3,300: 50 de morralla suelta sin forma conocida.
    const r = fondoSugerido({ ...CIERRE, contado: 3350 });
    expect(r.monto).toBe(3350);                       // manda el sellado
    expect(r.limites.join(' ')).toContain('50.00');
    expect(r.limites.join(' ')).toContain('sin forma conocida');
  });

  it('⛔ [negativa] una llave que el catálogo no conoce se enumera, no se suma como cero', () => {
    const r = fondoSugerido({ ...CIERRE, contado: null, denominaciones: { '500': 1, '7': 3 } });
    expect(r.limites.join(' ')).toContain('7');
    expect(r.limites.join(' ')).toContain('no se pudieron sumar');
  });

  describe('el cuadre de apertura', () => {
    it('cuadra cuando se contó lo mismo que quedó', () => {
      const c = cuadreApertura(3250, 3250);
      expect(c.estado).toBe('cuadra');
      expect(c.diferencia).toBe(0);
    });

    /**
     * ⭐ Una diferencia acá NO es un error de captura: es efectivo que se movió con la caja
     * CERRADA. Es de las pocas señales que separan un descuadre de operación de uno de custodia,
     * así que el texto tiene que decirlo con esas palabras.
     */
    it('⛔ [negativa] si falta, se dice que salió con la caja cerrada', () => {
      const c = cuadreApertura(3250, 3100);
      expect(c.estado).toBe('difiere');
      expect(c.diferencia).toBe(-150);
      expect(c.texto).toContain('150.00');
      expect(c.texto).toContain('caja cerrada');
    });

    it('⛔ [negativa] si sobra, también — un sobrante no es una buena noticia', () => {
      const c = cuadreApertura(3250, 3400);
      expect(c.diferencia).toBe(150);
      expect(c.texto).toContain('MÁS');
      expect(c.texto).toContain('nadie registró');
    });

    it('⛔ [negativa] sin con qué comparar NO dice "cuadra"', () => {
      expect(cuadreApertura(null, 3250).estado).toBe('sin_medir');
      expect(cuadreApertura(3250, null).estado).toBe('sin_medir');
    });

    it('⛔ [negativa] cero contra cero CUADRA, y es distinto de no haber medido', () => {
      // 0 es un hecho: se conto y estaba vacia. `null` es la ausencia de la medicion.
      const c = cuadreApertura(0, 0);
      expect(c.estado).toBe('cuadra');
      expect(cuadreApertura(null, 0).estado).toBe('sin_medir');
    });
  });
});
