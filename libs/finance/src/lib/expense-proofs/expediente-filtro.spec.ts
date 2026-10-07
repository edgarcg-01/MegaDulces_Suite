import { BadRequestException } from '@nestjs/common';
import { DEPARTAMENTO_SIN } from '@megadulces/contracts';
import { filtroExpedienteDesdeQuery, pideSinDepartamento } from './expediente-filtro';
import { ExpenseProofsController } from './expense-proofs.controller';
import type { ExpenseProofsService } from './expense-proofs.service';

/**
 * `[GX.72]` El filtro del Expediente (fechas + departamento).
 *
 * Lo que vigila: que un filtro malo NO se convierta en «sin filtro» en silencio. Eso pintaría
 * los KPIs de toda la historia bajo el rótulo del periodo que la persona eligió.
 */
describe('[GX.72] filtroExpedienteDesdeQuery', () => {
  it('sin nada, no filtra', () => {
    expect(filtroExpedienteDesdeQuery({})).toEqual({ desde: null, hasta: null, departamento: null });
  });

  it('vacío o espacios cuenta como ausente', () => {
    expect(filtroExpedienteDesdeQuery({ desde: '', hasta: '  ', departamento: ' ' }))
      .toEqual({ desde: null, hasta: null, departamento: null });
  });

  it('lee un rango válido y recorta el departamento', () => {
    expect(filtroExpedienteDesdeQuery({ desde: '2026-09-01', hasta: '2026-09-30', departamento: '  LOGISTICA ' }))
      .toEqual({ desde: '2026-09-01', hasta: '2026-09-30', departamento: 'LOGISTICA' });
  });

  it('el mismo día como desde y hasta es válido (un solo día)', () => {
    expect(filtroExpedienteDesdeQuery({ desde: '2026-10-07', hasta: '2026-10-07' }).desde).toBe('2026-10-07');
  });

  it('«sin departamento» viaja con su valor propio', () => {
    const f = filtroExpedienteDesdeQuery({ departamento: DEPARTAMENTO_SIN });
    expect(pideSinDepartamento(f)).toBe(true);
    expect(pideSinDepartamento(filtroExpedienteDesdeQuery({ departamento: 'RRHH' }))).toBe(false);
  });

  /** ⛔ NEGATIVAS: cada una devolvería «todas las fechas» si se ignorara. */
  it('⛔ fecha con formato malo → 400', () => {
    expect(() => filtroExpedienteDesdeQuery({ desde: '07/10/2026' })).toThrow(BadRequestException);
    expect(() => filtroExpedienteDesdeQuery({ hasta: '2026-9-1' })).toThrow(BadRequestException);
  });

  it('⛔ día que no existe en el calendario → 400', () => {
    expect(() => filtroExpedienteDesdeQuery({ desde: '2026-02-30' })).toThrow(BadRequestException);
    expect(() => filtroExpedienteDesdeQuery({ hasta: '2026-13-01' })).toThrow(BadRequestException);
  });

  it('⛔ rango al revés → 400 con las dos fechas en el mensaje', () => {
    expect(() => filtroExpedienteDesdeQuery({ desde: '2026-10-07', hasta: '2026-10-01' }))
      .toThrow(/2026-10-07.*2026-10-01/);
  });
});

describe('[GX.72] GET /expediente pasa el filtro al servicio', () => {
  const armar = () => {
    const llamadas: unknown[][] = [];
    const svc = {
      expedientePorUsuario: (...a: unknown[]) => { llamadas.push(a); return Promise.resolve({}); },
    } as unknown as ExpenseProofsService;
    return { ctrl: new ExpenseProofsController(svc), llamadas };
  };

  it('las fechas y el departamento llegan leídos', async () => {
    const { ctrl, llamadas } = armar();
    await ctrl.expediente(undefined, '2026-09-01', '2026-09-30', 'RRHH');
    expect(llamadas[0][1]).toEqual({ desde: '2026-09-01', hasta: '2026-09-30', departamento: 'RRHH' });
  });

  /** ⛔ Un filtro malo NO llega a la base: se corta antes, con 400. */
  it('⛔ filtro inválido: no consulta', () => {
    const { ctrl, llamadas } = armar();
    expect(() => ctrl.expediente(undefined, '2026-02-30')).toThrow(BadRequestException);
    expect(llamadas).toHaveLength(0);
  });
});
