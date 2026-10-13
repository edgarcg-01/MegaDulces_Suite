import { decidirAltaRapida, erroresDeAltaRapida, nombreComparable, nombreParaGuardar, PersonaPadron } from './alta-persona.contract';

/** `[EMB.32]` Alta rápida de ayudante o cargador: nunca un duplicado. Nombres inventados. */

const p = (o: Partial<PersonaPadron>): PersonaPadron => ({
  id: 'x', full_name: 'PERSONA DE PRUEBA', roles: ['chofer'], active: true, status: 'activo', deleted_at: null, updated_at: null, ...o,
});

describe('nombreComparable', () => {
  it('ignora acentos, mayúsculas y espacios de más', () => {
    expect(nombreComparable('  José   Pérez  López ')).toBe('JOSE PEREZ LOPEZ');
    expect(nombreComparable('JOSE PEREZ LOPEZ')).toBe(nombreComparable('josé pérez lópez'));
  });
  it('para guardar conserva acentos y deja un solo espacio en mayúsculas', () => {
    expect(nombreParaGuardar('  josé   pérez ')).toBe('JOSÉ PÉREZ');
  });
});

describe('erroresDeAltaRapida', () => {
  it('pide nombre y apellido', () => {
    expect(erroresDeAltaRapida({ full_name: 'Juan', rol: 'ayudante' })).toContain('Escribe el nombre completo.');
    expect(erroresDeAltaRapida({ full_name: 'Juanito', rol: 'ayudante' })).toContain('Escribe nombre y apellido.');
    expect(erroresDeAltaRapida({ full_name: 'Juan Prueba', rol: 'ayudante' })).toEqual([]);
  });
  it('sólo ayudante o cargador: un chofer no se da de alta así', () => {
    expect(erroresDeAltaRapida({ full_name: 'Juan Prueba', rol: 'chofer' as never })).toContain('El papel debe ser ayudante o cargador.');
  });
});

describe('decidirAltaRapida', () => {
  it('sin nadie con ese nombre: se crea', () => {
    expect(decidirAltaRapida([p({ full_name: 'OTRA PERSONA' })], 'Juan Prueba', 'ayudante')).toEqual({ accion: 'creada', persona: null });
  });

  it('activa con el mismo papel: se usa tal cual (no se duplica)', () => {
    const r = decidirAltaRapida([p({ id: 'a', full_name: 'JUAN PRUEBA', roles: ['ayudante'] })], 'juan  prueba', 'ayudante');
    expect(r.accion).toBe('ya_existia');
    expect(r.persona?.id).toBe('a');
  });

  it('activa con otro papel (chofer): se le agrega el de ayudante', () => {
    expect(decidirAltaRapida([p({ id: 'a', full_name: 'JUAN PRUEBA', roles: ['chofer'] })], 'Juan Prueba', 'ayudante').accion).toBe('papel_agregado');
  });

  it('dada de baja: se reactiva la más reciente, no se crea otra', () => {
    const r = decidirAltaRapida([
      p({ id: 'vieja', full_name: 'JUAN PRUEBA', active: false, status: 'inactivo', deleted_at: '2026-05-27', updated_at: '2026-05-27' }),
      p({ id: 'nueva', full_name: 'Juan  Prueba', active: false, status: 'inactivo', deleted_at: '2026-06-02', updated_at: '2026-06-02' }),
    ], 'JUAN PRUEBA', 'cargador');
    expect(r).toEqual({ accion: 'reactivada', persona: expect.objectContaining({ id: 'nueva' }) });
  });

  it('si hay una activa y otra de baja con el mismo nombre, gana la activa', () => {
    const r = decidirAltaRapida([
      p({ id: 'baja', full_name: 'JUAN PRUEBA', active: false, status: 'inactivo', deleted_at: '2026-06-02' }),
      p({ id: 'activa', full_name: 'JUAN PRUEBA', roles: ['ayudante'] }),
    ], 'JUAN PRUEBA', 'ayudante');
    expect(r.persona?.id).toBe('activa');
  });
});
