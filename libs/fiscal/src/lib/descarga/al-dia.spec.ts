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
/** Una descarga del 1-ene a hoy, completa (manual o la recuperación automática). */
const MANUAL = s({ estado: 'descargada', fecha_ini: '2026-01-01', fecha_fin: '2026-11-12', creada: '2026-11-12', packages_total: 6, packages_done: 6 });

describe('[PGP.110c] qué le pide la Suite al SAT', () => {
  it('[PGP.110e] recibidas HOY: se recupera sola — pide desde el 17-jul (lo último cubierto) hasta hoy', () => {
    const d = decidirAlDia(RECIBIDAS_HOY, '2026-11-13');
    expect(d).toMatchObject({ accion: 'pedir', desde: '2026-07-17', hasta: '2026-11-13' });
    expect(d.accion === 'pedir' && d.recupera).toContain('2026-10-27');
  });

  it('[PGP.110e] emitidas HOY: sin ninguna completa, pide sola desde el 1-ene del año', () => {
    const d = decidirAlDia(EMITIDAS_HOY, '2026-11-13');
    expect(d).toMatchObject({ accion: 'pedir', desde: '2026-01-01', hasta: '2026-11-13' });
    expect(d.accion === 'pedir' && d.recupera).toBeTruthy();
  });

  it('[PGP.110e] la recuperación nunca repite los parámetros de la que falló (termina hoy, no el 27-oct)', () => {
    for (const previas of [RECIBIDAS_HOY, EMITIDAS_HOY]) {
      const d = decidirAlDia(previas, '2026-11-13');
      expect(d.accion === 'pedir' && previas.some((p) => p.fecha_ini === d.desde && p.fecha_fin === d.hasta)).toBe(false);
    }
  });

  it('[PGP.110e] tres fallas seguidas frenan y lo dicen (a una por día, ya no es mala suerte)', () => {
    const f = (dia: string) => s({ estado: 'error', fecha_ini: '2026-01-01', fecha_fin: dia, creada: dia, packages_total: 2, packages_done: 0 });
    expect(decidirAlDia([f('2026-11-13'), f('2026-11-14'), ...EMITIDAS_HOY], '2026-11-15')).toMatchObject({ accion: 'frenada', motivo: 'fallas_seguidas' });
    expect(decidirAlDia([f('2026-11-13'), ...EMITIDAS_HOY], '2026-11-14')).toMatchObject({ accion: 'pedir', desde: '2026-01-01' });
  });

  it('[PGP.110e] un rechazo por la e.firma (305) o por el tope (5003) frena: pedir otra vez daría lo mismo', () => {
    for (const codigo of ['305', '5003']) {
      const r = s({ estado: 'error', codigo_estado: codigo, fecha_ini: '2026-11-12', fecha_fin: '2026-11-13', creada: '2026-11-13', packages_total: 0, packages_done: 0 });
      const d = decidirAlDia([r, MANUAL], '2026-11-14');
      expect(d).toMatchObject({ accion: 'frenada', motivo: 'rechazo_del_sat' });
      expect(d.accion === 'frenada' && d.detalle).toContain(codigo);
    }
  });

  it('[PGP.110e] un 5002 (esos parámetros) NO frena: la de mañana termina otro día', () => {
    const r = s({ estado: 'error', codigo_estado: '5002', fecha_ini: '2026-11-12', fecha_fin: '2026-11-13', creada: '2026-11-13', packages_total: 0, packages_done: 0 });
    expect(decidirAlDia([r, MANUAL], '2026-11-14')).toMatchObject({ accion: 'pedir', desde: '2026-11-12', hasta: '2026-11-14' });
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

  it('[PGP.110e] una automática que falla: la siguiente vuelve a pedir esos días sola', () => {
    const fallo = s({ estado: 'error', fecha_ini: '2026-11-12', fecha_fin: '2026-11-13', creada: '2026-11-13', packages_total: 2, packages_done: 0 });
    expect(decidirAlDia([fallo, MANUAL], '2026-11-14')).toMatchObject({ accion: 'pedir', desde: '2026-11-12', hasta: '2026-11-14' });
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
