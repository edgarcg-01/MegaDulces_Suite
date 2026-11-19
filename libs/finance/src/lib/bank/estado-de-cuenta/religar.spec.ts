import { planReligar, type RenglonConLigas } from './religar';
import type { RenglonComparable } from './contra-el-libro';

/** `[BFU.2.5]` El plan de volver a ligar: el pareo de la compuerta, 1:1, y lo que no tiene pareja se dice. */
const lib = (id: string, fecha: string, entra: number, sale = 0, ligas = ['pago del calendario']): RenglonConLigas => ({
  id, fecha, amount_in: entra, amount_out: sale, running_balance: null, ligas,
  customer_code: null, customer_nota: null, customer_declared_by: null, customer_declared_at: null, category_id: null, manual: false,
});
const ban = (id: string, fecha: string, entra: number, sale = 0): RenglonComparable => ({ id, fecha, amount_in: entra, amount_out: sale, running_balance: null });

describe('[BFU.2.5] planReligar', () => {
  it('el mismo día, lado e importe → su renglón del banco', () => {
    const { par, sinPareja } = planReligar([lib('L1', '2026-11-05', 0, 1500)], [ban('B9', '2026-11-04', 0, 1500), ban('B1', '2026-11-05', 0, 1500)]);
    expect(par.get('L1')).toBe('B1');
    expect(sinPareja).toEqual([]);
  });

  it('si el banco lo trae otro día (±3), el más cercano', () => {
    const { par } = planReligar([lib('L1', '2026-11-05', 200)], [ban('B7', '2026-11-08', 200), ban('B6', '2026-11-06', 200)]);
    expect(par.get('L1')).toBe('B6');
  });

  it('1:1 — dos del libro iguales y uno en el banco: uno se liga, el otro se declara sin pareja', () => {
    const { par, sinPareja } = planReligar([lib('L1', '2026-11-05', 50), lib('L2', '2026-11-05', 50)], [ban('B1', '2026-11-05', 50)]);
    expect(par.size).toBe(1);
    expect(sinPareja.map((l) => l.id)).toHaveLength(1);
  });

  it('control: el otro lado, otro importe o más de 3 días no se liga', () => {
    const { par, sinPareja } = planReligar(
      [lib('L1', '2026-11-05', 50), lib('L2', '2026-11-05', 0, 70), lib('L3', '2026-11-05', 90)],
      [ban('B1', '2026-11-05', 0, 50), ban('B2', '2026-11-05', 0, 70.01), ban('B3', '2026-11-09', 90)],
    );
    expect(par.size).toBe(0);
    expect(sinPareja.map((l) => l.id)).toEqual(['L1', 'L2', 'L3']);
  });
});
