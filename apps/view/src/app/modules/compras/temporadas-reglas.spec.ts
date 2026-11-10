import type { FechasTemporada, MomentoTemporada } from '@megadulces/contracts';
import { fechaRelevante, motivoTemporadas } from './temporadas-reglas';

/** Una temporada-año mínima para la prueba. */
const f = (id: string, year: number, sale_from: string, momento: MomentoTemporada): FechasTemporada => ({
  id, year, sale_from, sale_to: sale_from, buy_by: null, cutoff: null, clearance_from: null,
  status: 'propuesta', proposal_source: null, confirmed_by_name: null, confirmed_at: null, momento,
});

describe('fechaRelevante (revisión #5: el día que exista 2027, la de 2026 en venta no desaparece)', () => {
  it('la que está EN VENTA gana aunque haya un año más nuevo', () => {
    expect(fechaRelevante([f('n27', 2027, '2027-10-20', 'por_iniciar'), f('n26', 2026, '2026-10-20', 'en_venta')])?.id).toBe('n26');
  });
  it('sin una en venta, la próxima por iniciar (la más cercana), no la terminada', () => {
    expect(fechaRelevante([
      f('m26', 2026, '2026-09-01', 'terminada'), f('m28', 2028, '2028-09-01', 'por_iniciar'), f('m27', 2027, '2027-09-01', 'por_iniciar'),
    ])?.id).toBe('m27');
  });
  it('si todas terminaron, la más reciente', () => {
    expect(fechaRelevante([f('a', 2025, '2025-01-05', 'terminada'), f('b', 2026, '2026-01-05', 'terminada')])?.id).toBe('b');
  });
  it('sin fechas, null (la fila dice «sin fechas», no inventa una)', () => {
    expect(fechaRelevante([])).toBeNull();
  });
});

describe('motivoTemporadas (revisión #11: nada de inglés de Nest en pantalla)', () => {
  const accion = 'guardar las fechas';
  it('sin respuesta (estado 0) no se confunde con un error del servidor', () => {
    expect(motivoTemporadas({ status: 0 }, accion)).toMatch(/No hubo respuesta del servidor/);
  });
  it('«Validation failed (uuid is expected)» se dice como enlace inválido', () => {
    expect(motivoTemporadas({ status: 400, error: { message: 'Validation failed (uuid is expected)' } }, accion))
      .toBe('El enlace de esta temporada no es válido: ábrela desde el calendario.');
  });
  it('un 400 con mensaje en español del servidor manda', () => {
    expect(motivoTemporadas({ status: 400, error: { message: 'La venta no puede terminar antes de empezar.' } }, accion))
      .toBe('La venta no puede terminar antes de empezar.');
  });
  it('un 400 genérico en inglés no se muestra', () => {
    expect(motivoTemporadas({ status: 400, error: { message: 'Bad Request' } }, accion)).toBe('Algún dato no es válido para guardar las fechas.');
  });
  it('403 «Forbidden resource» → «No tienes permiso para esto»', () => {
    expect(motivoTemporadas({ status: 403, error: { message: 'Forbidden resource' } }, accion)).toBe('No tienes permiso para esto.');
  });
  it('404 → «No encontramos esa temporada»', () => {
    expect(motivoTemporadas({ status: 404, error: { message: 'Not Found' } }, accion)).toBe('No encontramos esa temporada.');
  });
  it('503 con mensaje en español: el del servidor', () => {
    expect(motivoTemporadas({ status: 503, error: { message: 'La venta del ODS no está lista; vuelve a intentarlo en unos minutos.' } }, accion))
      .toMatch(/^La venta del ODS no está lista/);
  });
  it('500 «Internal server error» → genérico con el número, sin el inglés', () => {
    const m = motivoTemporadas({ status: 500, error: { message: 'Internal server error' } }, accion);
    expect(m).toBe('No se pudo completar: vuelve a intentarlo (error 500).');
    expect(m).not.toMatch(/Internal/);
  });
  it('un cuerpo HTML (página del proxy) no se escupe', () => {
    expect(motivoTemporadas({ status: 400, error: '<!DOCTYPE html><html>…</html>' }, accion)).toBe('Algún dato no es válido para guardar las fechas.');
  });
  it('una lista de mensajes se une', () => {
    expect(motivoTemporadas({ status: 400, error: { message: ['Falta la fecha.', 'Falta el año.'] } }, accion)).toBe('Falta la fecha. · Falta el año.');
  });
});
