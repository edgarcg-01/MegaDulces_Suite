import type { IngresoDiaRow } from '../budget/income-forecast.sql';
import { capacidadDesdeIngreso } from './capacity-from-income';

const DOW: Record<string, number> = {
  '2026-11-13': 5, '2026-11-14': 6, '2026-11-15': 7, '2026-11-16': 1, '2026-11-17': 2, '2026-11-18': 3,
};
const fila = (fecha: string, est: [number | null, number | null], real: [number | null, number | null] = [null, null]): IngresoDiaRow => ({
  fecha, dia_semana: DOW[fecha], semana: 0, semana_anio: 2026,
  est: { bancos: est[0], caja_general: est[1] },
  real: { bancos: real[0], caja_general: real[1] },
});

describe('[PU.14] capacidad de pago desde el ingreso', () => {
  // viernes 13 (antes del rango) · fin de semana · lunes 16 inhábil · martes 17 · miércoles 18
  const rows = [
    fila('2026-11-13', [1000, 100]),
    fila('2026-11-14', [300, 50]),
    fila('2026-11-15', [60, 0]),
    fila('2026-11-16', [60, 0]),
    fila('2026-11-17', [5000, 400]),
    fila('2026-11-18', [1400, 200]),
  ];

  it('el fin de semana y el feriado se suman al siguiente día hábil', () => {
    const r = capacidadDesdeIngreso(rows, ['2026-11-16'], '2026-11-16', '2026-11-18');
    expect(r.items.map((i) => i.date)).toEqual(['2026-11-17', '2026-11-18']);
    const mar = r.items[0];
    expect(mar.ingreso_dia).toBe(5400);
    expect(mar.arrastre).toBe(350 + 60 + 60);
    expect(mar.arrastre_de).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    expect(mar.amount).toBe(5870);
    expect(r.items[1].amount).toBe(1600);
  });

  it('un día hábil antes del rango consume lo suyo: no se arrastra al rango', () => {
    const r = capacidadDesdeIngreso(rows, ['2026-11-16'], '2026-11-18', '2026-11-18');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].amount).toBe(1600);
    expect(r.items[0].arrastre).toBe(0);
  });

  it('lo real gana al estimado y el origen lo dice', () => {
    const conReal = rows.map((x) => (x.fecha === '2026-11-17' ? fila(x.fecha, [5000, 400], [4200, null]) : x));
    const r = capacidadDesdeIngreso(conReal, ['2026-11-16'], '2026-11-17', '2026-11-17');
    expect(r.items[0].ingreso_dia).toBe(4200 + 400);
    expect(r.items[0].origen).toBe('mixto');
  });

  it('un día hábil sin real ni estimado NO se propone en cero: se declara', () => {
    const sinDato = rows.map((x) => (x.fecha === '2026-11-18' ? fila(x.fecha, [null, null]) : x));
    const r = capacidadDesdeIngreso(sinDato, ['2026-11-16'], '2026-11-18', '2026-11-18');
    expect(r.items).toHaveLength(0);
    expect(r.sin_estimado).toEqual(['2026-11-18']);
  });

  it('un día hábil sin dato NO se propone con el puro arrastre: el arrastre pasa al siguiente', () => {
    const sinDato = rows.map((x) => (x.fecha === '2026-11-17' ? fila(x.fecha, [null, null]) : x));
    const r = capacidadDesdeIngreso(sinDato, ['2026-11-16'], '2026-11-16', '2026-11-18');
    expect(r.sin_estimado).toEqual(['2026-11-17']);
    expect(r.items.map((i) => i.date)).toEqual(['2026-11-18']);
    expect(r.items[0].arrastre).toBe(350 + 60 + 60);
    expect(r.items[0].amount).toBe(1600 + 470);
  });

  it('un día inhábil sin dato dentro del rango también se declara', () => {
    const sinDato = rows.map((x) => (x.fecha === '2026-11-16' ? fila(x.fecha, [null, null]) : x));
    const r = capacidadDesdeIngreso(sinDato, ['2026-11-16'], '2026-11-16', '2026-11-17');
    expect(r.sin_estimado).toEqual(['2026-11-16']);
    expect(r.items[0].arrastre).toBe(350 + 60);
  });

  it('sin feriados declarados, el lunes es hábil y se lleva el fin de semana', () => {
    const r = capacidadDesdeIngreso(rows, [], '2026-11-16', '2026-11-16');
    expect(r.items[0].amount).toBe(60 + 350 + 60);
  });
});
