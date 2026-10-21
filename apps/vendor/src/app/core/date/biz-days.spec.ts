// `[MCP.3.4]` La fecha de entrega que propone la app al levantar un pedido.
import { fechaEntregaPorOmision } from './biz-days';

const dia = (iso: string, hora = '10:00') => new Date(`${iso}T${hora}:00`);

describe('[MCP.3.4] fechaEntregaPorOmision', () => {
  it('⭐ entre semana propone HOY (antes era mañana)', () => {
    expect(fechaEntregaPorOmision(dia('2026-10-20'))).toBe('2026-10-20'); // martes
  });

  it('el sábado también es hoy (hay reparto)', () => {
    expect(fechaEntregaPorOmision(dia('2026-10-24'))).toBe('2026-10-24');
  });

  it('el domingo no hay reparto: propone el lunes', () => {
    expect(fechaEntregaPorOmision(dia('2026-10-25'))).toBe('2026-10-26');
  });

  it('en la noche sigue siendo hoy en hora local (no se corre al día UTC siguiente)', () => {
    expect(fechaEntregaPorOmision(dia('2026-10-20', '23:30'))).toBe('2026-10-20');
  });

  it('cruza fin de mes desde domingo', () => {
    expect(fechaEntregaPorOmision(dia('2026-05-31'))).toBe('2026-06-01'); // domingo
  });
});
