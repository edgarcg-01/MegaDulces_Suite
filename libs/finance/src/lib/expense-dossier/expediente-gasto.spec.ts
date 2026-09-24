import { cuadraImporte, derivarEtapa, ETAPA_LABEL, type EntradaEtapa } from './expediente-gasto.service';

/**
 * `[GX.15]` La etapa del trámite es lo que le dice a una persona qué tiene que hacer. Si
 * se equivoca, manda a alguien a perseguir algo que no existe — o peor, calla que falta.
 *
 * Los casos no son inventados: cada uno corresponde a una combinación **medida en prod**
 * el 2026-09-24 (`analytics.expense_requests` × `analytics.expense_documents`).
 */

const base = (over: Partial<EntradaEtapa> = {}): EntradaEtapa => ({
  estado: 'F',
  expediente: { forma_pago: 'efectivo', files: [{ role: 'comprobante_1' }, { role: 'solicitud_kepler' }] },
  gastos: [{}],
  comprobaciones: [{ status: 'validada' }],
  sumaGastos: 100,
  solImporte: 100,
  ...over,
});

describe('[GX.15] la etapa del trámite', () => {
  it('con los cuatro eslabones completos, está cerrada y no falta nada', () => {
    const r = derivarEtapa(base());
    expect(r.etapa).toBe('cerrada');
    expect(r.falta).toEqual([]);
    expect(r.label).toBe(ETAPA_LABEL.cerrada);
  });

  /**
   * ⭐ El caso que decide el ORDEN de las preguntas. En prod hay **116 solicitudes
   * canceladas CON gasto aplicado**. Si `cancelada` no se preguntara primero, esas caerían
   * en «gastada_sin_comprobar» y la bandeja mandaría a comprobar algo que se canceló.
   */
  it('cancelada en Kepler manda, aunque ya tenga gasto aplicado', () => {
    expect(derivarEtapa(base({ estado: 'C', comprobaciones: [] })).etapa).toBe('cancelada');
    expect(derivarEtapa(base({ estado: 'C', gastos: [{}, {}], comprobaciones: [] })).etapa).toBe('cancelada');
  });

  it('sin gasto aplicado distingue autorizada de por autorizar', () => {
    // Medido: 283 solicitudes en 'A' sin gasto, y 619 en 'N' sin gasto. Son dos esperas
    // distintas — una espera a que alguien ejerza, la otra a que alguien autorice.
    expect(derivarEtapa(base({ estado: 'A', gastos: [], comprobaciones: [] })).etapa).toBe('autorizada_sin_gasto');
    expect(derivarEtapa(base({ estado: 'F', gastos: [], comprobaciones: [] })).etapa).toBe('autorizada_sin_gasto');
    expect(derivarEtapa(base({ estado: 'N', gastos: [], comprobaciones: [] })).etapa).toBe('por_autorizar');
  });

  it('con gasto y sin comprobación, pide la comprobación', () => {
    const r = derivarEtapa(base({ comprobaciones: [] }));
    expect(r.etapa).toBe('gastada_sin_comprobar');
    expect(r.falta).toContain('la comprobación del gasto');
  });

  it('con comprobación sin validar, lo que falta es de Finanzas, no de quien gastó', () => {
    const r = derivarEtapa(base({ comprobaciones: [{ status: 'recibida' }] }));
    expect(r.etapa).toBe('comprobada_sin_validar');
    expect(r.falta).toContain('que Finanzas valide la comprobación');
    expect(r.falta).not.toContain('la comprobación del gasto');
  });

  it('basta UNA comprobación validada entre varias para cerrar', () => {
    const r = derivarEtapa(base({ comprobaciones: [{ status: 'rechazada' }, { status: 'validada' }] }));
    expect(r.etapa).toBe('cerrada');
  });

  it('sin expediente propio lo dice, en vez de callarlo', () => {
    // Es el caso de los 9 expedientes contra 10,082 solicitudes: casi todo está así.
    const r = derivarEtapa(base({ expediente: null }));
    expect(r.falta[0]).toContain('el expediente propio');
  });

  it('un expediente viejo sin forma de pago se declara como tal, no como error', () => {
    const r = derivarEtapa(base({ expediente: { forma_pago: null, files: [{ role: 'comprobante_1' }] } }));
    expect(r.falta.some((f) => f.includes('cómo se pagó'))).toBe(true);
  });

  it('la solicitud firmada NO cuenta como foto del comprobante', () => {
    const r = derivarEtapa(base({ expediente: { forma_pago: 'efectivo', files: [{ role: 'solicitud_kepler' }] } }));
    expect(r.falta).toContain('la foto del comprobante en el expediente');
  });

  /**
   * ⭐ El descuadre se juzga contra la SUMA de los gastos, no contra uno. En prod hay 177
   * solicitudes con más de un gasto (165 con 2, 10 con 3, 2 con 4): comparar contra el
   * primero diría «no cuadra» de un trámite perfectamente cuadrado.
   */
  it('con varios gastos, el cuadre se mide contra la suma', () => {
    // Dos gastos de 50 contra una solicitud de 100: cuadra.
    // (`.some(...)` y no `.not.toContain(expect.stringContaining(...))`: eso último NO
    //  compara con el matcher dentro de un arreglo y la aserción no puede fallar nunca.)
    expect(derivarEtapa(base({ gastos: [{}, {}], sumaGastos: 100, solImporte: 100 }))
      .falta.some((f) => f.includes('no cuadra'))).toBe(false);
    const r = derivarEtapa(base({ gastos: [{}, {}], sumaGastos: 160, solImporte: 100 }));
    expect(r.falta.some((f) => f.includes('no cuadra'))).toBe(true);
    expect(r.falta.some((f) => f.includes('160.00') && f.includes('100.00'))).toBe(true);
  });

  it('sin gasto aplicado NO se reporta descuadre (no hay contra qué comparar)', () => {
    const r = derivarEtapa(base({ gastos: [], comprobaciones: [], sumaGastos: 0, solImporte: 100 }));
    expect(r.falta.some((f) => f.includes('no cuadra'))).toBe(false);
  });

  it('cada etapa tiene su texto para la persona', () => {
    for (const k of Object.keys(ETAPA_LABEL)) {
      expect(ETAPA_LABEL[k as keyof typeof ETAPA_LABEL].length).toBeGreaterThan(3);
    }
  });
});

describe('[GX.15] el cuadre de importes', () => {
  it('tolera $1 o el 1%, lo que sea mayor', () => {
    expect(cuadraImporte(100, 100.5)).toBe(true);    // dentro del peso
    expect(cuadraImporte(100, 102)).toBe(false);     // 2% de 100 y más de $1
    expect(cuadraImporte(10000, 10090)).toBe(true);  // 0.9% de 10 mil
    expect(cuadraImporte(10000, 10200)).toBe(false); // 2%
  });

  it('es simétrico en el signo de la diferencia', () => {
    expect(cuadraImporte(100, 99.5)).toBe(cuadraImporte(100, 100.5));
  });

  it('un importe en cero no revienta ni cuadra con cualquier cosa', () => {
    // Importa: en prod las canceladas tienen importe 0 y no deben «cuadrar» con nada.
    expect(cuadraImporte(0, 0)).toBe(true);
    expect(cuadraImporte(0, 500)).toBe(false);
  });
});
