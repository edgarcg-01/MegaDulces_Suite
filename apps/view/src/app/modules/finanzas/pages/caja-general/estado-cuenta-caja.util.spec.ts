import type { ArqueoDia } from '@megadulces/contracts';
import type { MovimientoCaja } from '../../cash-ledger.service';
import { armarEstadoDeCuenta, limitesDeMes, restarDias } from './estado-cuenta-caja.util';

/** Un corte con los seis términos; el esperado se deriva para que el desglose lo explique. */
function corte(p: { id: string; fecha: string; fondo: number | null; ing: number; gas: number; dep?: number; disp?: number; depCaos?: number; contado: number | null; otros?: number }): ArqueoDia {
  const recompuesto = p.fondo == null ? null : p.fondo + p.ing - p.gas - (p.dep ?? 0) + (p.disp ?? 0) - (p.depCaos ?? 0);
  const esperado = recompuesto == null ? null : recompuesto + (p.otros ?? 0);
  return {
    corte_id: p.id, fecha: p.fecha, folio: `CC-${p.fecha}`, estado: 'cerrado',
    fondo: { monto: p.fondo, origen: 'cierre_anterior' },
    ingresos: p.ing, gastos: p.gas, depositos: p.dep ?? 0,
    caos: { dispensado: p.disp ?? 0, depositado: p.depCaos ?? 0, dotado: 0, vaciado: 0, movimientos: 0 },
    esperado, esperado_recompuesto: recompuesto, desglose_explica: (p.otros ?? 0) === 0,
    contado: p.contado, morralla: 0,
    diferencia: p.contado == null || esperado == null ? null : p.contado - esperado,
    sin_medir_motivo: p.contado == null ? 'sin conteo físico' : null,
  } as unknown as ArqueoDia;
}

function mov(p: { id: string; corte: string | null; tipo: 'ingreso' | 'gasto'; monto: number; fecha: string; hora?: string; estado?: string }): MovimientoCaja {
  return {
    id: p.id, folio: `F-${p.id}`, tipo: p.tipo, fecha: p.fecha, hora: p.hora ?? null, sucursal: '00',
    kepler_concepto_nombre: null, glosa: `glosa ${p.id}`, beneficiario: null, monto: p.monto,
    estado: p.estado ?? 'en_corte', corte_id: p.corte,
  } as unknown as MovimientoCaja;
}

describe('[LE.6.38] estado de cuenta de Caja General', () => {
  const arqueos = [
    // Fuera de orden a propósito: el estado de cuenta se lee de lo más viejo a lo más nuevo.
    corte({ id: 'c2', fecha: '2026-11-04', fondo: 900, ing: 500, gas: 200, disp: 100, depCaos: 50, contado: 1240 }),
    corte({ id: 'c1', fecha: '2026-11-03', fondo: 1000, ing: 300, gas: 400, contado: 900 }),
  ];
  const movimientos = [
    mov({ id: 'a', corte: 'c1', tipo: 'ingreso', monto: 300, fecha: '2026-11-03', hora: '09:00' }),
    mov({ id: 'b', corte: 'c1', tipo: 'gasto', monto: 400, fecha: '2026-10-28', hora: '10:00' }), // fecha de otro día: va por su corte
    mov({ id: 'c', corte: 'c2', tipo: 'ingreso', monto: 500, fecha: '2026-11-04' }),
    mov({ id: 'd', corte: 'c2', tipo: 'gasto', monto: 200, fecha: '2026-11-04' }),
    mov({ id: 'x', corte: 'c2', tipo: 'gasto', monto: 999, fecha: '2026-11-04', estado: 'cancelado' }),
    mov({ id: 's', corte: null, tipo: 'gasto', monto: 10, fecha: '2026-11-04', estado: 'registrado' }),
  ];

  it('ordena los días, reparte por corte y lleva el saldo corrido desde el fondo', () => {
    const e = armarEstadoDeCuenta(arqueos, movimientos, { desde: '2026-11-01', hasta: '2026-11-30' });
    expect(e.dias.map((d) => d.fecha)).toEqual(['2026-11-03', '2026-11-04']);
    const [d1, d2] = e.dias;
    expect(d1.movimientos.map((l) => l.id)).toEqual(['b', 'a']);
    expect(d1.movimientos.map((l) => l.saldo)).toEqual([600, 900]);
    expect(d2.movimientos.map((l) => l.id)).toEqual(['c', 'd']); // el cancelado no entra
    expect(d2.caja_fuerte).toBe(50);
    expect(d2.diferencia).toBe(-10);
    expect(d2.salto).toBe(0);
  });

  it('el resumen cuadra consigo mismo y cuenta lo que no tiene corte', () => {
    const { resumen: r } = armarEstadoDeCuenta(arqueos, movimientos, { desde: '2026-11-01', hasta: '2026-11-30' });
    expect(r.saldo_inicial).toBe(1000);
    expect(r.saldo_final).toBe(1240);
    expect(r.entradas).toBe(800);
    expect(r.salidas).toBe(600);
    expect(r.caja_fuerte).toBe(50);
    expect(r.diferencias).toBe(-10);
    expect(r.residuo).toBe(0);
    expect(r.sin_corte).toBe(1);
  });

  it('un salto entre el cierre de ayer y el fondo de hoy se publica y entra a la cuenta', () => {
    const conSalto = [arqueos[1], corte({ id: 'c2', fecha: '2026-11-04', fondo: 950, ing: 500, gas: 200, contado: 1250 })];
    const { dias, resumen } = armarEstadoDeCuenta(conSalto, movimientos);
    expect(dias[1].salto).toBe(50);
    expect(resumen.saltos).toBe(50);
    expect(resumen.residuo).toBe(0);
  });

  // ── Negativas ───────────────────────────────────────────────────────────────────────────
  it('si falta un movimiento, el día NO publica saldo corrido y se cuenta', () => {
    const sinUno = movimientos.filter((m) => m.id !== 'a');
    const e = armarEstadoDeCuenta(arqueos, sinUno);
    expect(e.dias[0].movimientos_cuadran).toBe(false);
    expect(e.dias[0].movimientos.every((l) => l.saldo === null)).toBe(true);
    expect(e.resumen.dias_sin_cuadre_de_movimientos).toBe(1);
  });

  it('un día sin conteo no se dibuja como cero: el saldo final y el residuo quedan sin medir', () => {
    const sinConteo = [arqueos[1], corte({ id: 'c2', fecha: '2026-11-04', fondo: 900, ing: 500, gas: 200, contado: null })];
    const { resumen } = armarEstadoDeCuenta(sinConteo, movimientos);
    expect(resumen.saldo_final).toBeNull();
    expect(resumen.diferencias).toBeNull();
    expect(resumen.residuo).toBeNull();
    expect(resumen.dias_sin_medir).toBe(1);
  });

  it('lo que el corte ajusta fuera de los seis términos sale en «otros»', () => {
    const conOtros = [corte({ id: 'c1', fecha: '2026-11-03', fondo: 1000, ing: 300, gas: 400, contado: 950, otros: 50 })];
    const { dias, resumen } = armarEstadoDeCuenta(conOtros, movimientos);
    expect(dias[0].otros).toBe(50);
    expect(dias[0].diferencia).toBe(0);
    expect(resumen.residuo).toBe(0);
  });

  it('sin cortes no hay residuo que afirmar', () => {
    expect(armarEstadoDeCuenta([], movimientos).resumen.residuo).toBeNull();
  });

  it('fechas del periodo', () => {
    expect(limitesDeMes('2026-02')).toEqual({ desde: '2026-02-01', hasta: '2026-02-28' });
    expect(limitesDeMes('2026-11')).toEqual({ desde: '2026-11-01', hasta: '2026-11-30' });
    expect(restarDias('2026-11-01', 31)).toBe('2026-10-01');
  });
});
