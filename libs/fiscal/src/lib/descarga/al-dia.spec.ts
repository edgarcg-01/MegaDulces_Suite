import { cubrioSusDias, decidirAlDia, type SolicitudPrevia } from './al-dia';

/**
 * `[PGP.110c]` Las solicitudes de prod tal como estaban el 2026-11-12 (sólo lectura): recibidas con la del
 * 27-oct caída (0 de 5 paquetes) y una buena del 17-jul; emitidas con la del 27-oct que bajó 17 de 18.
 */
const s = (o: Partial<SolicitudPrevia>): SolicitudPrevia => ({
  estado: 'descargada', codigo_estado: '5000', fecha_ini: '2026-01-01', fecha_fin: '2026-01-31',
  creada: '2026-02-01', packages_total: 1, packages_done: 1, ...o,
});

const RECIBIDAS_HOY: SolicitudPrevia[] = [
  s({ estado: 'error', fecha_ini: '2026-01-01', fecha_fin: '2026-10-27', creada: '2026-10-27', packages_total: 5, packages_done: 0 }),
  s({ estado: 'descargada', fecha_ini: '2026-07-01', fecha_fin: '2026-07-17', creada: '2026-07-17', packages_total: 1, packages_done: 1 }),
  s({ estado: 'error', codigo_estado: null, fecha_ini: '2026-07-01', fecha_fin: '2026-07-17', creada: '2026-07-17', packages_total: 0, packages_done: 0 }),
  s({ estado: 'error', codigo_estado: null, fecha_ini: '2026-07-01', fecha_fin: '2026-07-15', creada: '2026-07-15', packages_total: 0, packages_done: 0 }),
];
const EMITIDAS_HOY: SolicitudPrevia[] = [
  s({ estado: 'descargada', fecha_ini: '2026-01-01', fecha_fin: '2026-10-27', creada: '2026-10-27', packages_total: 18, packages_done: 17 }),
];
/** La re-descarga manual que destraba recibidas: del 1-ene a hoy, completa. */
const MANUAL = s({ estado: 'descargada', fecha_ini: '2026-01-01', fecha_fin: '2026-11-12', creada: '2026-11-12', packages_total: 6, packages_done: 6 });

describe('[PGP.110c] qué le pide la Suite al SAT', () => {
  it('recibidas HOY: frenada — la del 27-oct dejó del 18-jul al 27-oct sin cubrir', () => {
    const d = decidirAlDia(RECIBIDAS_HOY, '2026-11-12');
    expect(d).toMatchObject({ accion: 'frenada', motivo: 'dias_sin_cubrir' });
    expect(d.accion === 'frenada' && d.detalle).toContain('2026-07-17');
  });

  it('emitidas HOY: frenada — la única que hay perdió un paquete, no hay desde dónde seguir', () => {
    expect(decidirAlDia(EMITIDAS_HOY, '2026-11-12')).toMatchObject({ accion: 'frenada', motivo: 'sin_base' });
  });

  it('el mismo día de la re-descarga manual no pide otra (mismos parámetros: código 5002)', () => {
    expect(decidirAlDia([MANUAL, ...RECIBIDAS_HOY], '2026-11-12')).toEqual({ accion: 'nada', motivo: 'ya_pedida_hoy' });
  });

  it('al día siguiente pide desde el último día cubierto, inclusive, hasta hoy', () => {
    expect(decidirAlDia([MANUAL, ...RECIBIDAS_HOY], '2026-11-13')).toEqual({ accion: 'pedir', desde: '2026-11-12', hasta: '2026-11-13' });
  });

  it('con una en curso no pide otra (el SAT pide no repetir mientras procesa)', () => {
    const enCurso = s({ estado: 'en_proceso', fecha_ini: '2026-11-12', fecha_fin: '2026-11-13', creada: '2026-11-13', packages_total: 0, packages_done: 0 });
    expect(decidirAlDia([enCurso, MANUAL], '2026-11-14')).toEqual({ accion: 'nada', motivo: 'una_en_curso' });
  });

  it('una en curso desde hace más de 3 días está atorada: se frena y lo dice', () => {
    const vieja = s({ estado: 'solicitada', fecha_ini: '2026-11-12', fecha_fin: '2026-11-13', creada: '2026-11-13', packages_total: 0, packages_done: 0 });
    expect(decidirAlDia([vieja, MANUAL], '2026-11-17')).toMatchObject({ accion: 'frenada', motivo: 'atorada' });
    expect(decidirAlDia([vieja, MANUAL], '2026-11-16')).toEqual({ accion: 'nada', motivo: 'una_en_curso' });
  });

  it('un día sin CFDI (5004) cubre sus días: no frena la siguiente', () => {
    const vacia = s({ estado: 'error', codigo_estado: '5004', fecha_ini: '2026-11-12', fecha_fin: '2026-11-15', creada: '2026-11-15', packages_total: 0, packages_done: 0 });
    expect(cubrioSusDias(vacia)).toBe(true);
    expect(decidirAlDia([vacia, MANUAL], '2026-11-16')).toEqual({ accion: 'pedir', desde: '2026-11-15', hasta: '2026-11-16' });
  });

  it('una automática que falla frena las siguientes hasta que una persona cubra esos días', () => {
    const fallo = s({ estado: 'error', fecha_ini: '2026-11-12', fecha_fin: '2026-11-13', creada: '2026-11-13', packages_total: 2, packages_done: 0 });
    expect(decidirAlDia([fallo, MANUAL], '2026-11-14')).toMatchObject({ accion: 'frenada', motivo: 'dias_sin_cubrir' });
    const cubierta = s({ fecha_ini: '2026-11-12', fecha_fin: '2026-11-14', creada: '2026-11-14', packages_total: 1, packages_done: 1 });
    expect(decidirAlDia([cubierta, fallo, MANUAL], '2026-11-15')).toEqual({ accion: 'pedir', desde: '2026-11-14', hasta: '2026-11-15' });
  });

  it('una fallida vieja, dentro de lo ya cubierto, no frena (los errores de julio)', () => {
    expect(decidirAlDia([MANUAL, ...RECIBIDAS_HOY], '2026-11-20')).toMatchObject({ accion: 'pedir', desde: '2026-11-12' });
  });

  it('una «descargada» que perdió paquetes no cubrió sus días (17 de 18)', () => {
    expect(cubrioSusDias(EMITIDAS_HOY[0])).toBe(false);
    expect(cubrioSusDias({ ...EMITIDAS_HOY[0], packages_done: 18 })).toBe(true);
  });
});
