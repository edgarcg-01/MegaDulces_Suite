import { decidirCorrida, firmaVacia, periodosAEvaluar, textoFirma, type FirmaPeriodo } from './bank-recon-aviso.engine';

/**
 * `[CB.53]` — Candado del disparador por aviso.
 *
 * Lo que este candado cuida son las dos formas en que un motor por evento falla **sin avisar**:
 *
 *  1. **Corre de más.** El carril de ingesta emite su aviso cada vez que el CDC toca `kdm1`, o
 *     sea muchas veces al día. Sin firma, cada aviso dispararía una corrida completa (medido en
 *     prod: 2.41 s sólo en cargar el lado Kepler, 0.45 s el lado banco).
 *  2. **Corre de menos.** Si sólo se re-evaluara el mes en curso, los movimientos que Kepler
 *     captura tarde —mediana 2–5 días, **máximo 19** medido en octubre— aparecerían cuando su
 *     mes ya nunca se vuelve a mirar, y no encontrarían pareja jamás. Ése es el caso que
 *     `periodosAEvaluar` cubre y el que la prueba negativa de abajo exige.
 */

const firma = (p: Partial<FirmaPeriodo> = {}): FirmaPeriodo => ({ ...firmaVacia, kepFilas: 10, bancoFilas: 5, ...p });

describe('[CB.53] qué periodos re-evalúa cada aviso', () => {
  it('a mitad de mes basta con el mes en curso', () => {
    expect(periodosAEvaluar('2026-10-25')).toEqual(['2026-10']);
  });

  it('⚠️ en los primeros días también el mes anterior: Kepler captura hasta 19 días tarde', () => {
    expect(periodosAEvaluar('2026-10-05')).toEqual(['2026-10', '2026-09']);
  });

  it('el día del corte todavía incluye el mes anterior', () => {
    expect(periodosAEvaluar('2026-10-20')).toEqual(['2026-10', '2026-09']);
    expect(periodosAEvaluar('2026-10-21')).toEqual(['2026-10']);
  });

  it('en enero el mes anterior es diciembre del año pasado', () => {
    expect(periodosAEvaluar('2027-01-03')).toEqual(['2027-01', '2026-12']);
  });

  it('una fecha que no es una fecha falla fuerte, no devuelve un periodo inventado', () => {
    expect(() => periodosAEvaluar('hoy')).toThrow(/fecha inválida/);
  });

  it('PRUEBA NEGATIVA: con el corte en 0 (como si el lag no existiera) el mes anterior deja de mirarse', () => {
    // Es exactamente el defecto que la ventana evita: el documento que Kepler captura el día 3
    // con fecha del mes pasado no vuelve a tener quien lo busque.
    expect(periodosAEvaluar('2026-10-03', 0)).toEqual(['2026-10']);
  });
});

describe('[CB.53] cuándo merece correr', () => {
  it('corre cuando la firma cambió', () => {
    const d = decidirCorrida({ habilitado: true, corriendo: false, firma: firma(), ultimaFirma: 'otra' });
    expect(d.correr).toBe(true);
    expect(d.motivo).toBe('cambio');
  });

  it('no corre si la firma es la misma — y lo dice', () => {
    const f = firma();
    const d = decidirCorrida({ habilitado: true, corriendo: false, firma: f, ultimaFirma: textoFirma(f) });
    expect(d.correr).toBe(false);
    expect(d.motivo).toBe('sin_cambios');
    expect(d.detalle).toContain('no se movió');
  });

  it('⭐ la firma distingue un cambio de IMPORTE aunque el conteo sea idéntico', () => {
    const antes = firma({ kepCentavos: 100_00 });
    const despues = firma({ kepCentavos: 100_01 });
    expect(textoFirma(antes)).not.toBe(textoFirma(despues));
    expect(decidirCorrida({ habilitado: true, corriendo: false, firma: despues, ultimaFirma: textoFirma(antes) }).correr).toBe(true);
  });

  it('⭐ y un movimiento nuevo del lado BANCO también la mueve, no sólo los de Kepler', () => {
    const antes = firma({ bancoFilas: 5 });
    const despues = firma({ bancoFilas: 6 });
    expect(decidirCorrida({ habilitado: true, corriendo: false, firma: despues, ultimaFirma: textoFirma(antes) }).correr).toBe(true);
  });

  it('apagado no corre, y el motivo NO se confunde con «no había nada»', () => {
    const d = decidirCorrida({ habilitado: false, corriendo: false, firma: firma(), ultimaFirma: '' });
    expect(d.correr).toBe(false);
    expect(d.motivo).toBe('apagado');
  });

  it('con una corrida en curso el aviso se descarta, con su propio motivo', () => {
    const d = decidirCorrida({ habilitado: true, corriendo: true, firma: firma(), ultimaFirma: '' });
    expect(d.correr).toBe(false);
    expect(d.motivo).toBe('ya_corriendo');
  });

  it('un periodo sin datos de ningún lado tiene su propio motivo, no «sin cambios»', () => {
    const d = decidirCorrida({ habilitado: true, corriendo: false, firma: firmaVacia, ultimaFirma: '' });
    expect(d.correr).toBe(false);
    expect(d.motivo).toBe('sin_datos');
  });

  it('los cuatro motivos de NO correr son distintos entre sí (ninguno es un return mudo)', () => {
    const motivos = new Set([
      decidirCorrida({ habilitado: false, corriendo: false, firma: firma(), ultimaFirma: '' }).motivo,
      decidirCorrida({ habilitado: true, corriendo: true, firma: firma(), ultimaFirma: '' }).motivo,
      decidirCorrida({ habilitado: true, corriendo: false, firma: firmaVacia, ultimaFirma: '' }).motivo,
      decidirCorrida({ habilitado: true, corriendo: false, firma: firma(), ultimaFirma: textoFirma(firma()) }).motivo,
    ]);
    expect(motivos.size).toBe(4);
    expect([...motivos].every((m) => m !== 'cambio')).toBe(true);
  });

  it('PRUEBA NEGATIVA: sin mirar la firma, todo aviso correría — el caso que el debounce evita', () => {
    const f = firma();
    const sinDebounce = { habilitado: true, corriendo: false, firma: f, ultimaFirma: '' };
    expect(decidirCorrida(sinDebounce).correr).toBe(true);
    // …y con la firma ya registrada, el MISMO aviso repetido no vuelve a correr.
    expect(decidirCorrida({ ...sinDebounce, ultimaFirma: textoFirma(f) }).correr).toBe(false);
  });
});
