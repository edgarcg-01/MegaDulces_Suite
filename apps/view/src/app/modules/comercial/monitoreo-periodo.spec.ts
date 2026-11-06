import { diasConActividad, etiquetaPeriodo, inicioCatorcena, rangoDe, rangoValido } from './monitoreo-periodo';

/** `[MV.3]` Los periodos del Monitoreo vecinal. Hoy fijo: jueves 5 de noviembre de 2026. */
describe('monitoreo-periodo', () => {
  const HOY = '2026-11-05';

  it('⭐ la catorcena es la del servidor (ancla 17-oct): la de hoy empieza el sábado 31-oct', () => {
    expect(inicioCatorcena(HOY)).toBe('2026-10-31');
    expect(inicioCatorcena('2026-10-30')).toBe('2026-10-17');
    expect(rangoDe('catorcena', HOY)).toEqual({ from: '2026-10-31', to: HOY });
  });

  it('los atajos, vistos desde hoy', () => {
    expect(rangoDe('hoy', HOY)).toEqual({ from: HOY, to: HOY });
    expect(rangoDe('ayer', HOY)).toEqual({ from: '2026-11-04', to: '2026-11-04' });
    expect(rangoDe('semana', HOY)).toEqual({ from: '2026-11-02', to: HOY }); // lunes → hoy
    expect(rangoDe('mes', HOY)).toEqual({ from: '2026-11-01', to: HOY });
    expect(rangoDe('mes_anterior', HOY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(rangoDe('ultimos_30', HOY)).toEqual({ from: '2026-10-07', to: HOY });
  });

  it('la semana desde un domingo empieza el lunes anterior', () => {
    expect(rangoDe('semana', '2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('días con actividad: lunes a sábado, y nunca 0', () => {
    expect(diasConActividad('2026-10-31', '2026-11-13')).toBe(12);
    expect(diasConActividad('2026-11-01', '2026-11-01')).toBe(1);
  });

  it('el rango del calendario: se ordena, se recorta a hoy y a 92 días', () => {
    expect(rangoValido('2026-11-04', '2026-11-01', HOY)).toEqual({ from: '2026-11-01', to: '2026-11-04' });
    expect(rangoValido('2026-11-04', '2026-11-20', HOY)).toEqual({ from: '2026-11-04', to: HOY });
    expect(rangoValido('2026-11-04', null, HOY)).toEqual({ from: '2026-11-04', to: '2026-11-04' });
    expect(rangoValido('2026-01-01', HOY, HOY)?.from).toBe('2026-08-06');
    expect(rangoValido('2026-12-01', null, HOY)).toBeNull();
    expect(rangoValido(null, null, HOY)).toBeNull();
  });

  it('la etiqueta: un día con su nombre; un rango con sus dos fechas', () => {
    expect(etiquetaPeriodo({ from: HOY, to: HOY })).toMatch(/jue.*05.*nov/);
    expect(etiquetaPeriodo({ from: '2026-10-31', to: HOY })).toMatch(/31 oct – 05 nov/);
  });
});
