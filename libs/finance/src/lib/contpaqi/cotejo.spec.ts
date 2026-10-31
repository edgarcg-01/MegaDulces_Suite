import { cotejar, mismoAsiento, type PolizaReal, type RenglonCotejo } from './cotejo';

/** `[CP.8.87]` El cotejo contra la contadora: la misma regla que `comparar-armado-contpaqi.js`, ahora en el producto. */
const r = (cuenta: string, abono: boolean, importe: number): RenglonCotejo => ({ cuenta, abono, importe });
const MANTENIMIENTO = [r('5200730000', false, 9303.45), r('1060000000', false, 1488.55), r('1020210000', true, 10792)];
const real = (k: string, fecha: string, renglones: RenglonCotejo[]): PolizaReal => ({ k, fecha, renglones });

describe('[CP.8.87] cotejo contra la póliza de la contadora', () => {
  it('la póliza del mantenimiento de reparto (Egreso 373) contra sí misma: igual', () => {
    const res = cotejar([{ clave: 'm1', fecha: '2026-09-21', renglones: MANTENIMIENTO }], [real('9|373', '2026-09-21', MANTENIMIENTO)]);
    expect(res.get('m1')).toBe('igual');
  });

  it('⛔ otra cuenta de gasto con el mismo importe: difiere (no se cuela por cuadrar)', () => {
    const otra = [r('5200720000', false, 9303.45), r('1060000000', false, 1488.55), r('1020210000', true, 10792)];
    expect(cotejar([{ clave: 'm1', fecha: '2026-09-21', renglones: otra }], [real('9|373', '2026-09-21', MANTENIMIENTO)]).get('m1')).toBe('difiere');
  });

  it('la empareja hasta 3 días; a 4 ya no tiene par', () => {
    const p = [real('x', '2026-09-24', MANTENIMIENTO)];
    expect(cotejar([{ clave: 'm1', fecha: '2026-09-21', renglones: MANTENIMIENTO }], p).get('m1')).toBe('igual');
    expect(cotejar([{ clave: 'm1', fecha: '2026-09-20', renglones: MANTENIMIENTO }], p).get('m1')).toBe('sin_par');
  });

  it('⛔ una póliza real que agrupa varios movimientos de banco no se califica renglón a renglón', () => {
    const agrupa = [...MANTENIMIENTO, r('1020210000', true, 500), r('5200730000', false, 500)];
    expect(cotejar([{ clave: 'm1', fecha: '2026-09-21', renglones: MANTENIMIENTO }], [real('g', '2026-09-21', agrupa)]).get('m1')).toBe('agrupada');
  });

  it('⛔ una póliza real se usa una sola vez: el segundo pago idéntico queda sin par', () => {
    const res = cotejar([
      { clave: 'a', fecha: '2026-09-21', renglones: MANTENIMIENTO }, { clave: 'b', fecha: '2026-09-21', renglones: MANTENIMIENTO },
    ], [real('9|373', '2026-09-21', MANTENIMIENTO)]);
    expect([res.get('a'), res.get('b')].sort()).toEqual(['igual', 'sin_par']);
  });

  it('dos candidatas: desempata la cuenta de gasto; si no, ambigua', () => {
    const otra = [r('5200410000', false, 9303.45), r('1060000000', false, 1488.55), r('1020210000', true, 10792)];
    const reales = [real('p1', '2026-09-21', otra), real('p2', '2026-09-21', MANTENIMIENTO)];
    expect(cotejar([{ clave: 'm1', fecha: '2026-09-21', renglones: MANTENIMIENTO }], reales).get('m1')).toBe('igual');
    expect(cotejar([{ clave: 'm1', fecha: '2026-09-21', renglones: MANTENIMIENTO }], [real('p1', '2026-09-21', MANTENIMIENTO), real('p2', '2026-09-21', MANTENIMIENTO)]).get('m1')).toBe('ambigua');
  });

  it('dos centavos de tolerancia por cuenta, tres ya difieren', () => {
    expect(mismoAsiento([r('5200730000', false, 100.02)], [r('5200730000', false, 100)])).toBe(true);
    expect(mismoAsiento([r('5200730000', false, 100.03)], [r('5200730000', false, 100)])).toBe(false);
  });
});
