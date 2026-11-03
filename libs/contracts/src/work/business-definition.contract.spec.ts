// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { resolverDefinicion, validarRespuesta, type RespuestaDefinicion } from './business-definition.contract';

const DEF = { id: 'd1', status: 'respondida' as const };
const resp = (valid_from: string, answered_at: string, value: unknown, definition_id = 'd1'): RespuestaDefinicion => ({
  id: `${definition_id}-${valid_from}-${answered_at}`, definition_id, value, valid_from, note: 'motivo',
  answered_by: 'u1', answered_at,
});

describe('[DP.1.1] resolverDefinicion — la vigente a una fecha, o «sin definir» declarado', () => {
  it('sin respuestas → sin_definir / sin_respuesta (nunca la propuesta ni un default)', () => {
    expect(resolverDefinicion({ id: 'd1', status: 'pendiente' }, [], '2026-11-03'))
      .toEqual({ estado: 'sin_definir', motivo: 'sin_respuesta' });
  });

  it('la respuesta que todavía no rige → sin_definir / no_rige_aun', () => {
    expect(resolverDefinicion(DEF, [resp('2026-12-01', '2026-11-03T10:00:00Z', 3)], '2026-11-03'))
      .toEqual({ estado: 'sin_definir', motivo: 'no_rige_aun' });
  });

  it('una quincena vieja se resuelve con la regla que regía entonces', () => {
    const rs = [resp('2026-01-01', '2026-01-01T10:00:00Z', 3), resp('2026-11-01', '2026-11-01T10:00:00Z', 4)];
    expect(resolverDefinicion(DEF, rs, '2026-10-15')).toMatchObject({ estado: 'definida', valor: 3 });
    expect(resolverDefinicion(DEF, rs, '2026-11-01')).toMatchObject({ estado: 'definida', valor: 4 });
  });

  it('⭐ una reversa RETROACTIVA gana: el caso «sigue al chofer» (Edgar, 2026-11-03)', () => {
    const rs = [
      resp('2026-10-20', '2026-10-20T18:00:00Z', 'tipo_ruta'), // la del 20-oct, rige desde ese día
      resp('2026-09-08', '2026-11-03T21:00:00Z', 'chofer'), // la de hoy, con retroactivo al renombre
    ];
    expect(resolverDefinicion(DEF, rs, '2026-09-01')).toEqual({ estado: 'sin_definir', motivo: 'no_rige_aun' });
    expect(resolverDefinicion(DEF, rs, '2026-09-15')).toMatchObject({ estado: 'definida', valor: 'chofer' });
    // Con «la vigencia más alta» esta fecha devolvía 'tipo_ruta' (10-20 > 09-08): la reversa perdía.
    expect(resolverDefinicion(DEF, rs, '2026-10-25')).toMatchObject({ estado: 'definida', valor: 'chofer' });
  });

  it('dos respuestas con la misma vigencia: gana la contestada más tarde (la corrección)', () => {
    const rs = [resp('2026-11-01', '2026-11-01T10:00:00Z', 3), resp('2026-11-01', '2026-11-01T12:00:00Z', 5)];
    expect(resolverDefinicion(DEF, rs, '2026-11-03')).toMatchObject({ estado: 'definida', valor: 5 });
  });

  it('las respuestas de OTRA pregunta no cuentan', () => {
    expect(resolverDefinicion(DEF, [resp('2026-01-01', '2026-01-01T10:00:00Z', 9, 'd2')], '2026-11-03'))
      .toEqual({ estado: 'sin_definir', motivo: 'sin_respuesta' });
  });

  it('una pregunta descartada no se resuelve aunque tenga respuestas', () => {
    expect(resolverDefinicion({ id: 'd1', status: 'descartada' }, [resp('2026-01-01', '2026-01-01T10:00:00Z', 3)], '2026-11-03'))
      .toEqual({ estado: 'sin_definir', motivo: 'descartada' });
  });
});

describe('[DP.1.1] validarRespuesta — el valor tiene que corresponder al tipo', () => {
  const opciones = [{ value: 'comision', label: 'La comisión' }, { value: 'venta', label: 'La venta' }];

  it.each([
    ['number', 3, true], ['number', -1, false], ['number', '3', false], ['number', Number.NaN, false],
    ['money', 1500.5, true], ['percent', 100, true], ['percent', 101, false],
    ['boolean', false, true], ['boolean', 'no', false],
    ['text', 'el supervisor', true], ['text', '   ', false],
    ['date', '2026-11-28', true], ['date', '28/11/2026', false],
  ] as const)('%s con %j → %s', (tipo, valor, sirve) => {
    expect(validarRespuesta({ value_type: tipo, choices: null }, valor) === null).toBe(sirve);
  });

  it('choice: sólo una de las opciones declaradas', () => {
    expect(validarRespuesta({ value_type: 'choice', choices: opciones }, 'venta')).toBeNull();
    expect(validarRespuesta({ value_type: 'choice', choices: opciones }, 'subtotal')).not.toBeNull();
  });

  it('choices: una o varias, todas declaradas y sin repetir', () => {
    expect(validarRespuesta({ value_type: 'choices', choices: opciones }, ['venta', 'comision'])).toBeNull();
    expect(validarRespuesta({ value_type: 'choices', choices: opciones }, [])).not.toBeNull();
    expect(validarRespuesta({ value_type: 'choices', choices: opciones }, ['venta', 'venta'])).not.toBeNull();
    expect(validarRespuesta({ value_type: 'choices', choices: opciones }, ['venta', 'otra'])).not.toBeNull();
  });

  it('config_ref: tiene que apuntar a la configuración que la contesta', () => {
    expect(validarRespuesta({ value_type: 'config_ref', choices: null }, { ref: 'commercial.commission_scales:abc' })).toBeNull();
    expect(validarRespuesta({ value_type: 'config_ref', choices: null }, { ref: '' })).not.toBeNull();
    expect(validarRespuesta({ value_type: 'config_ref', choices: null }, 'abc')).not.toBeNull();
  });
});
