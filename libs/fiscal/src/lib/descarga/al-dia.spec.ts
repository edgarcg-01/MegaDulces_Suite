import { cubrioSusDias, decidirAlDia, primerHueco, type SolicitudPrevia } from './al-dia';

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
  it('[PGP.164] recibidas HOY: se recupera sola — pide desde el 1-ene (ene–jun nunca bajó), no desde el 17-jul', () => {
    // [PGP.110e] pedía desde el 17-jul: tomaba el fin de la buena de julio como «cubierto» y se saltaba ene–jun.
    const d = decidirAlDia(RECIBIDAS_HOY, '2026-11-13');
    expect(d).toMatchObject({ accion: 'pedir', desde: '2026-01-01', hasta: '2026-11-13' });
    expect(d.accion === 'pedir' && d.recupera).toContain('del 2026-01-01 al 2026-07-01');
  });

  it('[PGP.164] recibidas en prod el 2026-11-20: con las diarias al corriente, el hueco de ene–jun se pide igual', () => {
    const diaria = (ini: string, fin: string) => s({ fecha_ini: ini, fecha_fin: fin, creada: fin, packages_total: 1, packages_done: 1 });
    const prod = [...RECIBIDAS_HOY, diaria('2026-07-17', '2026-11-14'), diaria('2026-11-14', '2026-11-15'), diaria('2026-11-19', '2026-11-20'), diaria('2026-11-15', '2026-11-19')];
    expect(decidirAlDia(prod, '2026-11-21')).toMatchObject({ accion: 'pedir', desde: '2026-01-01', hasta: '2026-11-21' });
    // ⛔ control: cuando la de ene–hoy termina completa, al día siguiente vuelve a pedir sólo desde ayer
    const completa = s({ fecha_ini: '2026-01-01', fecha_fin: '2026-11-21', creada: '2026-11-21', packages_total: 6, packages_done: 6 });
    expect(decidirAlDia([...prod, completa], '2026-11-22')).toEqual({ accion: 'pedir', desde: '2026-11-21', hasta: '2026-11-22' });
  });

  it('[PGP.164] un hueco a mitad del año también se pide, desde su primer día', () => {
    const a = s({ fecha_ini: '2026-01-01', fecha_fin: '2026-03-31', creada: '2026-03-31' });
    const b = s({ fecha_ini: '2026-05-01', fecha_fin: '2026-11-19', creada: '2026-11-19' });
    expect(decidirAlDia([a, b], '2026-11-20')).toMatchObject({ accion: 'pedir', desde: '2026-03-31', hasta: '2026-11-20' });
    expect(primerHueco([b, a], '2026-01-01')).toEqual({ desde: '2026-03-31', siguiente: '2026-05-01' });
    // ⛔ control: pegadas (una empieza el día que la otra termina) no son hueco, ni lo del año anterior
    const c = s({ fecha_ini: '2026-03-31', fecha_fin: '2026-05-01', creada: '2026-05-01' });
    expect(primerHueco([a, b, c], '2026-01-01')).toEqual({ desde: '2026-11-19', siguiente: null });
    const dic = s({ fecha_ini: '2025-12-15', fecha_fin: '2026-01-04', creada: '2026-01-04' });
    expect(decidirAlDia([dic], '2026-01-05')).toEqual({ accion: 'pedir', desde: '2026-01-04', hasta: '2026-01-05' });
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
