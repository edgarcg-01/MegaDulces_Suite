import {
  HORAS_VISIBLE_TRAS_RECHAZO, puedeAutorizarReapertura, puedePedirReapertura, siguemVisible,
  type ValeParaReabrir,
} from './reapertura';

/**
 * `[GX.29]` Estas reglas deciden **quién puede tocar dinero ya aprobado**. Si una se afloja,
 * alguien reabre el vale de otro, o reabre uno que Kepler ya contabilizó y la evidencia deja
 * de coincidir con la póliza.
 */

const vale = (over: Partial<ValeParaReabrir> = {}): ValeParaReabrir => ({
  id: 'v1',
  status: 'validada',
  validated_by: 'maria_gutierrez',
  created_by: 'tania_sanchez',
  estado_kepler: 'A',
  ...over,
});

describe('[GX.29] pedir la reapertura', () => {
  it('el dueño de un vale ya aprobado puede pedirla', () => {
    expect(puedePedirReapertura(vale(), 'tania_sanchez').puede).toBe(true);
  });

  it('otro no puede pedir la reapertura de un vale ajeno', () => {
    const v = puedePedirReapertura(vale(), 'juan_perez');
    expect(v.puede).toBe(false);
    expect(v.motivo).toBe('no_es_tuyo');
  });

  /**
   * ⭐ Decisión del usuario: un rechazado NO se reabre, se vuelve a capturar. Reabrirlo
   * dejaría editar el vale que alguien ya juzgó mal, que es justo lo que no se quiere.
   */
  it('un vale rechazado NO se reabre', () => {
    const v = puedePedirReapertura(vale({ status: 'rechazada' }), 'tania_sanchez');
    expect(v.puede).toBe(false);
    expect(v.motivo).toBe('rechazado');
    expect(v.explicacion).toContain('capturarlo de nuevo');
  });

  /**
   * ⭐ El caso que más cuesta si se afloja: Kepler ya lo aplicó, o sea que ya hay póliza.
   * Cambiarle la evidencia hace que el expediente deje de coincidir con la contabilidad.
   */
  it('un vale ya aplicado en Kepler no se toca, ni siquiera por su dueño', () => {
    const v = puedePedirReapertura(vale({ estado_kepler: 'F' }), 'tania_sanchez');
    expect(v.puede).toBe(false);
    expect(v.motivo).toBe('aplicado_en_kepler');
    expect(v.explicacion).toContain('póliza');
  });

  /**
   * El orden de las negativas importa: a alguien cuyo vale ya se aplicó en Kepler no se le
   * dice «no es tuyo» — eso lo manda a buscar al dueño para nada.
   */
  it('lo que cierra el caso gana sobre lo que manda a buscar a otro', () => {
    const v = puedePedirReapertura(vale({ estado_kepler: 'F' }), 'quien_sea');
    expect(v.motivo).toBe('aplicado_en_kepler');
  });

  it('un vale que todavía está abierto no necesita reapertura', () => {
    expect(puedePedirReapertura(vale({ status: 'recibida' }), 'tania_sanchez').motivo).toBe('ya_abierto');
  });

  it('sin vale, lo dice en vez de caerse', () => {
    expect(puedePedirReapertura(null, 'tania_sanchez').motivo).toBe('no_existe');
  });
});

describe('[GX.29] autorizar la reapertura', () => {
  it('sólo quien aprobó el vale', () => {
    expect(puedeAutorizarReapertura(vale(), 'maria_gutierrez').puede).toBe(true);
  });

  /** ⭐ La prueba negativa que sostiene la regla que pidió el usuario. */
  it('otro aprobador NO puede autorizar la reapertura de un vale que no firmó', () => {
    const v = puedeAutorizarReapertura(vale(), 'jesus_carrillo');
    expect(v.puede).toBe(false);
    expect(v.explicacion).toContain('Sólo quien aprobó');
  });

  it('un vale sin aprobador registrado no se puede reabrir por nadie', () => {
    expect(puedeAutorizarReapertura(vale({ validated_by: null }), 'maria_gutierrez').puede).toBe(false);
  });
});

describe('[GX.29] el rechazo se oculta a las 24 h', () => {
  const ahora = new Date('2026-09-26T12:00:00Z');

  it('un rechazo reciente se ve', () => {
    expect(siguemVisible('rechazada', '2026-09-26T06:00:00Z', ahora)).toBe(true);
  });

  it('pasadas las 24 h deja de verse', () => {
    expect(siguemVisible('rechazada', '2026-09-24T06:00:00Z', ahora)).toBe(false);
  });

  it('lo que no está rechazado se ve siempre, por viejo que sea', () => {
    expect(siguemVisible('validada', '2020-01-01T00:00:00Z', ahora)).toBe(true);
  });

  /**
   * ⚠️ Sin hora de rechazo NO se puede medir la antigüedad. Se DECLARA visible en vez de
   * esconderlo: ocultar por no poder medir haría desaparecer vales por un dato faltante.
   */
  it('sin hora de rechazo se DECLARA visible, no se esconde', () => {
    expect(siguemVisible('rechazada', null, ahora)).toBe(true);
    expect(siguemVisible('rechazada', 'no es una fecha', ahora)).toBe(true);
  });

  it('la ventana es de 24 horas', () => {
    expect(HORAS_VISIBLE_TRAS_RECHAZO).toBe(24);
  });
});
