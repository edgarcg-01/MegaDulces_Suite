import { dateFromDelPeriodo, MESES_ESTADO_CUENTA_POR_DEFECTO, PERIODOS_ESTADO_CUENTA, restarMeses } from './estado-cuenta-periodo.contract';

describe('[CXC.47] periodo del estado de cuenta', () => {
  it('restar meses respeta el fin de mes y el cambio de año', () => {
    expect(restarMeses('2026-05-31', 3)).toBe('2026-02-28');
    expect(restarMeses('2024-05-31', 3)).toBe('2024-02-29');
    expect(restarMeses('2026-01-15', 1)).toBe('2025-12-15');
    expect(restarMeses('2026-03-31', 12)).toBe('2025-03-31');
    expect(restarMeses('2026-11-20', 0)).toBe('2026-11-20');
  });

  it('cada periodo da su date_from; «todo» viaja como palabra, no como fecha', () => {
    expect(dateFromDelPeriodo('2026-11-20', '1m')).toBe('2026-10-20');
    expect(dateFromDelPeriodo('2026-11-20', '3m')).toBe('2026-08-20');
    expect(dateFromDelPeriodo('2026-11-20', '12m')).toBe('2025-11-20');
    expect(dateFromDelPeriodo('2026-11-20', 'todo')).toBe('todo');
  });

  it('el default existe entre los periodos que se ofrecen', () => {
    expect(PERIODOS_ESTADO_CUENTA.some((p) => p.meses === MESES_ESTADO_CUENTA_POR_DEFECTO)).toBe(true);
  });
});
