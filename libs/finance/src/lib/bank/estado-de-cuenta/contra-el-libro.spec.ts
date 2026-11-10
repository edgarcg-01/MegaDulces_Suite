import { compararContraElLibro, type RenglonComparable } from './contra-el-libro';

// Importes inventados (el repo es público). Cuenta que abre en 1,000.00.
let n = 0;
const r = (fecha: string, ent: number, sal: number, saldo: number | null, concepto = ''): RenglonComparable =>
  ({ id: `r${++n}`, fecha, amount_in: ent, amount_out: sal, running_balance: saldo, concepto });

const BANCO = [
  r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300),
  r('2026-10-02', 0, 3.51, 1296.49), r('2026-10-02', 0, 0.56, 1295.93),
  r('2026-10-03', 100, 0, 1395.93), // último día: abierto
];

describe('[CB.60] compararContraElLibro', () => {
  it('el libro copiado del banco, en otro orden: los días cerrados cuadran y el último queda abierto', () => {
    const libro = [r('2026-10-01', 0, 200, 1300), r('2026-10-01', 500, 0, 1500), r('2026-10-02', 0, 0.56, 1295.93), r('2026-10-02', 0, 3.51, 1296.49)];
    const c = compararContraElLibro(BANCO, libro);
    expect(c.dias.map((d) => d.veredicto)).toEqual(['cuadra', 'cuadra', 'abierto']);
    expect(c.resumen).toMatchObject({ cuadra: 2, difiere: 0, abierto: 1, solo_banco: 0, solo_libro: 0 });
  });

  it('[negativa] un movimiento que el libro no tiene: el día difiere y lo nombra', () => {
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300), r('2026-10-02', 0, 3.51, 1296.49)];
    const d = compararContraElLibro(BANCO, libro).dias[1];
    expect(d.veredicto).toBe('difiere');
    expect(d.solo_banco).toEqual([expect.objectContaining({ lado: 'sale', importe: 0.56 })]);
  });

  it('[negativa] mismos importes pero el saldo del libro no cierra igual: difiere', () => {
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1310)];
    expect(compararContraElLibro(BANCO, libro).dias[0].veredicto).toBe('difiere');
  });

  it('[negativa] un renglón de más en el libro: difiere y lo nombra del lado del libro', () => {
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300), r('2026-10-01', 0, 50, 1250)];
    const d = compararContraElLibro(BANCO, libro).dias[0];
    expect(d.veredicto).toBe('difiere');
    expect(d.solo_libro.map((x) => x.importe)).toEqual([50]);
  });

  it('el libro lo anotó otro día (±3): cuenta como pareado, declarado como fecha distinta', () => {
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-03', 0, 200, null)];
    const d = compararContraElLibro(BANCO, libro).dias[0];
    expect(d.solo_banco).toEqual([]);
    expect(d.fecha_distinta).toBe(1);
    expect(d.veredicto).toBe('difiere'); // el saldo del día ya no puede cerrar igual
  });

  it('el libro no llega a ese día: sin libro, no difiere', () => {
    const c = compararContraElLibro(BANCO, [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300)]);
    expect(c.dias.map((d) => d.veredicto)).toEqual(['cuadra', 'sin_libro', 'abierto']);
  });
});
