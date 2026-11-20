import { decidirAvisoVacio } from './presale-picking.engine';

/** `[MCP.27]` Avisar a la vendedora que no hubo nada: sólo quien surte, en un pedido abierto; no se repite. */
describe('[MCP.27] decidirAvisoVacio', () => {
  const P = (p: Partial<{ started_by: string; started_by_name: string | null; finished_at: unknown; empty_reported_at: unknown }> = {}) =>
    ({ started_by: 'yo', started_by_name: 'Yo', finished_at: null, empty_reported_at: null, ...p });
  it('⭐ quien lo surte avisa', () => {
    expect(decidirAvisoVacio(P(), 'yo')).toEqual({ ok: true, ya_avisado: false });
  });
  it('avisar otra vez no repite el aviso (idempotente)', () => {
    expect(decidirAvisoVacio(P({ empty_reported_at: '2026-11-20T19:20:00Z' }), 'yo')).toEqual({ ok: true, ya_avisado: true });
  });
  it('NEGATIVA: sin empezar, ya cerrado, o lo surte otra persona', () => {
    expect(decidirAvisoVacio(null, 'yo')).toMatchObject({ ok: false, status: 409 });
    expect(decidirAvisoVacio(P({ finished_at: '2026-11-20T19:00:00Z' }), 'yo')).toMatchObject({ ok: false, status: 409 });
    expect(decidirAvisoVacio(P({ started_by: 'ana', started_by_name: 'Ana' }), 'yo')).toEqual({ ok: false, status: 403, motivo: 'Lo está surtiendo Ana.' });
  });
});
