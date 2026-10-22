import { verificarCorte, fallasDe, type EntradaVerificacion } from './caja-verificacion.engine';
import type { VerdadDiferencia } from '@megadulces/contracts';

/** `[CGS.12]` La revisión de la mañana, con los casos de prod del 2026-10-21. */
describe('verificarCorte — V1…V12', () => {
  const limpio: EntradaVerificacion = {
    fecha: '2026-10-19', cerrado_dia: '2026-10-19', contado: 1500, morralla: 0, suma_piezas: 1500,
    fondo_inicial: 500, contado_anterior: 500, folio_anterior: 'CC-2026-00006',
    veredicto: 'cuadra', diferencia: 0, explicacion: null,
    gastos_sin_respaldo: 0, manuales_otra_fecha: 0, sueltos_despues: 0, editados_despues: 0,
  };
  const de = (e: EntradaVerificacion, id: string) => verificarCorte(e).find((x) => x.id === id)!;

  it('un corte limpio cumple todo lo medible, y V9 se declara NO MEDIDO (no se pinta verde)', () => {
    const v = verificarCorte(limpio);
    expect(fallasDe(v)).toEqual([]);
    expect(de(limpio, 'V9').estado).toBe('no_medido');
    expect(v.map((x) => x.id)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V12', 'V6', 'V7', 'V8', 'V9', 'V11']);
  });

  it('[negativa] CC-2026-00001: cerrado 3 días después', () => {
    expect(de({ ...limpio, fecha: '2026-10-12', cerrado_dia: '2026-10-15' }, 'V1'))
      .toMatchObject({ estado: 'no_cumple', detalle: 'Se cerró 3 día(s) después de la jornada.' });
  });

  it('[negativa] CC-2026-00004: abrió con $24,960 y el anterior contó $14,128.50', () => {
    const v = de({ ...limpio, fondo_inicial: 24960, contado_anterior: 14128.5, folio_anterior: 'CC-2026-00003' }, 'V3');
    expect(v.estado).toBe('no_cumple');
    expect(v.detalle).toContain('CC-2026-00003');
    expect(v.detalle).toContain('$10,831.50');
  });

  it('el primer corte no tiene anterior: V3 NO MEDIDO, no verde', () => {
    expect(de({ ...limpio, contado_anterior: undefined }, 'V3').estado).toBe('no_medido');
  });

  it('[negativa] esperado imposible: V4 no cumple y dice que se observa', () => {
    const v = de({ ...limpio, veredicto: 'esperado_imposible', diferencia: 207486.32 }, 'V4');
    expect(v.estado).toBe('no_cumple');
    expect(v.detalle).toContain('Se observa');
  });

  it('V5: diferencia sin explicar no cumple; explicada por la caja, sí', () => {
    const conDif = { ...limpio, veredicto: 'falta' as const, diferencia: -62.45 };
    expect(de(conDif, 'V5').estado).toBe('no_cumple');
    expect(de({ ...conDif, explicacion: 'Faltó un vale de gasolina de 62.45' }, 'V5').estado).toBe('cumple');
  });

  it('[negativa] piezas que no suman, gastos sin respaldo, capturas fuera, ediciones post-cierre', () => {
    expect(de({ ...limpio, suma_piezas: 1400 }, 'V2').estado).toBe('no_cumple');
    expect(de({ ...limpio, gastos_sin_respaldo: 2 }, 'V6').estado).toBe('no_cumple');
    expect(de({ ...limpio, manuales_otra_fecha: 1 }, 'V7').estado).toBe('no_cumple');
    expect(de({ ...limpio, sueltos_despues: 3 }, 'V8').estado).toBe('no_cumple');
    expect(de({ ...limpio, editados_despues: 28 }, 'V11').detalle).toContain('28');
  });

  const verdad = (estado: VerdadDiferencia['estado'], contradice = false): VerdadDiferencia => ({
    estado, publicada: 80019.86, verdadera: estado === 'corregida' ? 136602.36 : 80019.86, pistas: [], resumen: 'resumen ' + estado,
    testigos: [{ id: 'caja_fuerte', pregunta: 'p', estado: contradice ? 'contradice' : 'confirma', detalle: 'd', ajuste: 0 }],
  });

  it('[negativa] V12 (CGS.36): una diferencia CORREGIDA por los testigos no cumple, y exige nota para autorizar', () => {
    const v = de({ ...limpio, verdad: verdad('corregida') }, 'V12');
    expect(v).toMatchObject({ estado: 'no_cumple', detalle: 'resumen corregida' });
    expect(fallasDe(verificarCorte({ ...limpio, verdad: verdad('corregida') })).map((x) => x.id)).toEqual(['V12']);
  });

  it('[negativa] V12: un testigo que contradice sin poder corregir tampoco cumple', () => {
    expect(de({ ...limpio, verdad: verdad('sin_confirmar', true) }, 'V12').estado).toBe('no_cumple');
  });

  it('V12: confirmada cumple; sin testigo o sin arbitrar se declara NO MEDIDO, no verde', () => {
    expect(de({ ...limpio, verdad: verdad('confirmada') }, 'V12').estado).toBe('cumple');
    expect(de({ ...limpio, verdad: verdad('sin_confirmar') }, 'V12').estado).toBe('no_medido');
    expect(de({ ...limpio, verdad: null }, 'V12').estado).toBe('no_medido');
  });
});
