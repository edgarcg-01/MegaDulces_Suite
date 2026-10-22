import { ForbiddenException } from '@nestjs/common';
import { asegurarHorarioAlta } from './horario-alta';
import { ExpenseProofsController } from './expense-proofs.controller';

/** `[GX.86]` El candado del horario de alta en el servidor. Hora de México (UTC−6); 2026-10-19 = lunes. */
const MX = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);

describe('[GX.86] asegurarHorarioAlta', () => {
  it('dentro del horario deja pasar', () => {
    expect(() => asegurarHorarioAlta(false, MX('2026-10-19', '09:00'))).not.toThrow();
    expect(() => asegurarHorarioAlta(false, MX('2026-10-19', '17:30'))).not.toThrow();
  });

  it('fuera del horario rechaza con 403 y dice cuándo abre', () => {
    try {
      asegurarHorarioAlta(false, MX('2026-10-19', '12:00'));
      throw new Error('debió rechazar');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as ForbiddenException).message).toContain('hoy a las 17:00');
    }
  });

  it('el sábado rechaza aunque sea la hora de una ventana', () => {
    expect(() => asegurarHorarioAlta(false, MX('2026-10-24', '09:00'))).toThrow(ForbiddenException);
  });

  it('el exento pasa a cualquier hora', () => {
    expect(() => asegurarHorarioAlta(true, MX('2026-10-24', '23:00'))).not.toThrow();
  });
});

describe('[GX.86] el controller decide la excepción con los permisos del token', () => {
  const llamar = (user: Record<string, unknown>) => {
    const create = vi.fn().mockReturnValue('ok');
    const ctl = new ExpenseProofsController({ create } as never);
    ctl.create({} as never, { user } as never);
    return create.mock.calls[0][2] as boolean;
  };

  it('quien aprueba (COMPROBAR) va exento', () => {
    expect(llamar({ username: 'a', permissions: { FINANCE_EXPENSES_COMPROBAR: true } })).toBe(true);
  });

  it('quien sólo da de alta NO va exento', () => {
    expect(llamar({ username: 'c', permissions: { FINANCE_EXPENSES_CAPTURAR: true, FINANCE_EXPENSES_VER: true } })).toBe(false);
  });

  it('sin permisos en el token NO va exento', () => {
    expect(llamar({ username: 'x' })).toBe(false);
  });
});
