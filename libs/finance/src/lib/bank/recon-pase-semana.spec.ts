import { elegirEnLaSemana } from './recon-pase-semana';

type C = { id: string; importe: number; d: number };
const c = (id: string, importe: number, d: number): C => ({ id, importe, d });
const dist = (p: C) => p.d;
const elegir = (ex: C[], tol: C[], imp: number) => elegirEnLaSemana(ex, tol, dist, imp)?.elegido.id ?? null;

describe('[BFU.7.5] pase 1: el candidato de la misma semana', () => {
  it('⛔ el caso de prod: un exacto a 37 días ya no le gana al redondeo del mismo día', () => {
    // «rem piñatas» $2,400.00 — PIÑATAS $2,400.01 el mismo día; COMISIONES $2,400.00 a 37 días.
    const r = elegirEnLaSemana([c('comisiones', 2400, 37)], [c('pinatas', 2400.01, 0)], dist, 2400);
    expect(r).toEqual({ elegido: c('pinatas', 2400.01, 0), exacto: false, dias: 0 });
  });
  it('[sin cambio] el exacto dentro de la semana gana, aunque haya un redondeo más cerca', () => {
    expect(elegir([c('exacto', 100, 3)], [c('redondeo', 100.01, 0)], 100)).toBe('exacto');
  });
  it('[sin cambio] sin ningún exacto, ±$1 dentro de la semana, el más cercano', () => {
    expect(elegir([], [c('lejos', 100.9, 6), c('cerca', 100.5, 2)], 100)).toBe('cerca');
    expect(elegir([], [c('fuera', 100.5, 8)], 100)).toBeNull();
  });
  it('⛔ angosto: con exacto lejos, diez centavos NO se toman (pueden ser otro cheque de nómina)', () => {
    expect(elegir([c('exacto', 2117.4, 16)], [c('otro-empleado', 2117.3, 0)], 2117.4)).toBeNull();
  });
  it('⛔ angosto: con exacto lejos, el redondeo a más de un día tampoco', () => {
    expect(elegir([c('exacto', 100, 20)], [c('redondeo', 100.01, 2)], 100)).toBeNull();
    expect(elegir([c('exacto', 100, 20)], [c('redondeo', 100.05, 1)], 100)).toBe('redondeo');
  });
});
