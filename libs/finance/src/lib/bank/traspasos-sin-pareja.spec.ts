import { traspasosSinPareja, type MovimientoDeTraspaso } from './traspasos-sin-pareja';

let id = 0;
const m = (fecha: string, cuenta: string, importe: number, concepto: string): MovimientoDeTraspaso => ({
  id: String(++id).padStart(3, '0'), fecha, cuenta, alias: `X ${cuenta}`,
  entra: importe > 0 ? importe : 0, sale: importe < 0 ? -importe : 0, concepto,
});

/**
 * `[CB.69]` El caso de noviembre de 2026, con los renglones de prod (2026-11-13): la diferencia TI − TE era de
 * $150,000 y el Cierre explicaba $55,000. Sólo los traspasos de $95,000 y $55,000 importan; el resto se cancela.
 */
const NOVIEMBRE = [
  m('2026-11-03', '4166', 95_000, 'TRASPASO ENTRE CTAS 366'),
  m('2026-11-06', '2169', 95_000, 'TRASPASO DE BB 854'),
  m('2026-11-06', '854', -95_000, 'TRASPASO A SNTDR 2169'),
  m('2026-11-06', '2169', 55_000, 'TRASPASO DE BB 366'),
  m('2026-11-03', '7744', -560_000, 'TRASPASO A BB 4166'),
  m('2026-11-03', '4166', 560_000, 'TRASPASO DE BTE 7744'),
];

describe('[CB.69] traspasos sin pareja, 1 a 1', () => {
  it('noviembre: los sueltos suman la diferencia completa ($150,000), no $55,000', () => {
    const r = traspasosSinPareja(NOVIEMBRE);
    expect(r.sueltos.map((s) => `${s.cuenta} ${s.entra}`)).toEqual(['4166 95000', '2169 55000']);
    expect(r.explicado).toBe(150_000);
    expect(r.parejas).toBe(2);
  });

  it('[negativa] una salida no sirve de pareja a dos entradas', () => {
    const r = traspasosSinPareja([
      m('2026-11-03', '4166', 95_000, 'X'), m('2026-11-04', '2169', 95_000, 'Y'), m('2026-11-04', '854', -95_000, 'Z'),
    ]);
    expect(r.sueltos).toHaveLength(1);
    expect(r.explicado).toBe(95_000);
  });

  it('el concepto que nombra a la otra cuenta gana sobre la fecha más cercana', () => {
    // La entrada de 4166 está más cerca en fecha, pero la salida dice «A SNTDR 2169».
    const r = traspasosSinPareja([
      m('2026-11-06', '4166', 10_000, 'TRASPASO ENTRE CTAS 366'), m('2026-11-04', '2169', 10_000, 'TRASPASO DE BB 854'),
      m('2026-11-06', '854', -10_000, 'TRASPASO A SNTDR 2169'),
    ]);
    expect(r.sueltos.map((s) => s.cuenta)).toEqual(['4166']);
  });

  it('«506» no se lee dentro de «5065»: el nombre de la cuenta va completo', () => {
    const r = traspasosSinPareja([
      m('2026-11-06', '4166', 10_000, 'TRASPASO DE 5065'), m('2026-11-03', '2169', 10_000, 'TRASPASO DE 506'),
      m('2026-11-06', '506', -10_000, 'TRASPASO'),
    ]);
    expect(r.sueltos.map((s) => s.cuenta)).toEqual(['4166']);
  });

  it('ni la misma cuenta, ni más de 3 días, ni otro importe hacen pareja', () => {
    const r = traspasosSinPareja([
      m('2026-11-01', '4166', 1_000, 'a'), m('2026-11-01', '4166', -1_000, 'b'),   // misma cuenta
      m('2026-11-01', '2169', 2_000, 'c'), m('2026-11-05', '854', -2_000, 'd'),    // 4 días
      m('2026-11-01', '1463', 3_000, 'e'), m('2026-11-01', '3041', -3_000.01, 'f'), // un centavo
    ]);
    expect(r.parejas).toBe(0);
    expect(r.sueltos).toHaveLength(6);
    expect(r.explicado).toBe(-0.01);
  });

  it('cuadra con la diferencia TI − TE por construcción, también con salidas sueltas', () => {
    const movs = [...NOVIEMBRE, m('2026-11-09', '1604', -7_500.5, 'TRASPASO A 9999')];
    const delta = movs.reduce((t, x) => t + x.entra - x.sale, 0);
    expect(traspasosSinPareja(movs).explicado).toBeCloseTo(delta, 2);
  });
});
