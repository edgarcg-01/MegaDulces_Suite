import {
  avisoCortesAbiertos, debeAvisar, huellaDeSituacion, RECORDAR_CADA_MS, UMBRAL_CORTE_ABIERTO_H,
} from './caja-corte-abierto.engine';

describe('[CGP-L.10] debeAvisar — una alarma que grita de más enseña a ignorarla', () => {
  const m = { abiertos: [{ folio: 'CC-1', fecha: '2026-10-12', horas: 75 }], jornadasSinCorte: ['2026-10-13'], inicioLibro: '2026-10-12' };
  const aviso = avisoCortesAbiertos(m)!;
  const h = huellaDeSituacion(m, aviso);

  it('la primera vez, avisa', () => {
    expect(debeAvisar(null, h, 0)).toBe(true);
  });

  it('la misma situación una hora después, NO repite', () => {
    expect(debeAvisar({ huella: h, at: 0 }, h, 60 * 60 * 1000)).toBe(false);
  });

  it('la misma situación pasadas 6 horas, la recuerda', () => {
    expect(debeAvisar({ huella: h, at: 0 }, h, RECORDAR_CADA_MS)).toBe(true);
  });

  it('las horas que pasan NO cambian la situación: el mismo corte sigue siendo el mismo aviso', () => {
    const despues = { ...m, abiertos: [{ ...m.abiertos[0], horas: 76 }] };
    expect(huellaDeSituacion(despues, avisoCortesAbiertos(despues)!)).toBe(h);
  });

  it('⛔ otra jornada sin corte SÍ es otra situación, y se avisa de inmediato', () => {
    const peor = { ...m, jornadasSinCorte: ['2026-10-13', '2026-10-14'] };
    const h2 = huellaDeSituacion(peor, avisoCortesAbiertos(peor)!);
    expect(h2).not.toBe(h);
    expect(debeAvisar({ huella: h, at: 0 }, h2, 60 * 1000)).toBe(true);
  });
});

/**
 * `[CGP-L.10]` El sensor del corte abierto, como función pura.
 *
 * El corte del 12-oct estuvo trabado tres jornadas y NINGÚN sistema avisó: un corte en borrador
 * bloquea abrir los siguientes de su sucursal, y los días se acumulan en silencio. Esto decide si
 * hay que avisar y con qué fuerza; el servicio sólo mide y entrega.
 */
describe('[CGP-L.10] avisoCortesAbiertos', () => {
  const sano = { abiertos: [], jornadasSinCorte: [], inicioLibro: '2026-10-12' };

  it('sin cortes viejos ni jornadas sin corte, no avisa', () => {
    expect(avisoCortesAbiertos(sano)).toBeNull();
  });

  it('un corte abierto de pocas horas es la jornada en curso: no avisa', () => {
    expect(avisoCortesAbiertos({ ...sano, abiertos: [{ folio: 'CC-2026-00007', fecha: '2026-10-15', horas: 5 }] }))
      .toBeNull();
  });

  it(`pasadas ${UMBRAL_CORTE_ABIERTO_H.aviso} h abierto, avisa`, () => {
    const a = avisoCortesAbiertos({ ...sano, abiertos: [{ folio: 'CC-2026-00007', fecha: '2026-10-15', horas: 27 }] });
    expect(a).toMatchObject({ severity: 'warn', key: 'caja_corte_abierto' });
    expect(a?.message).toContain('CC-2026-00007');
    expect(a?.message).toContain('15-oct');
  });

  it(`⛔ pasadas ${UMBRAL_CORTE_ABIERTO_H.critico} h, es crítico y dice que bloquea los días siguientes`, () => {
    const a = avisoCortesAbiertos({ ...sano, abiertos: [{ folio: 'CC-2026-00001', fecha: '2026-10-12', horas: 75 }] });
    expect(a?.severity).toBe('critical');
    expect(a?.message).toMatch(/lleva 3 días abierto/);
    expect(a?.message).toMatch(/no se puede abrir el de los días siguientes/);
  });

  it('una jornada con movimientos y sin corte avisa, aunque no haya corte abierto', () => {
    const a = avisoCortesAbiertos({ ...sano, jornadasSinCorte: ['2026-10-13'] });
    expect(a).toMatchObject({ severity: 'warn' });
    expect(a?.message).toContain('13-oct');
  });

  it('⛔ dos o más jornadas sin corte es crítico: es exactamente lo que pasó el 13 y el 14-oct', () => {
    const a = avisoCortesAbiertos({
      abiertos: [{ folio: 'CC-2026-00001', fecha: '2026-10-12', horas: 75 }],
      jornadasSinCorte: ['2026-10-13', '2026-10-14'],
      inicioLibro: '2026-10-12',
    });
    expect(a?.severity).toBe('critical');
    expect(a?.message).toContain('CC-2026-00001');
    expect(a?.message).toContain('13-oct');
    expect(a?.message).toContain('14-oct');
  });

  it('las horas se dicen en horas antes de llegar a dos días', () => {
    const a = avisoCortesAbiertos({ ...sano, abiertos: [{ folio: 'CC-1', fecha: '2026-10-15', horas: 30.4 }] });
    expect(a?.message).toMatch(/lleva 30 h abierto/);
  });
});
