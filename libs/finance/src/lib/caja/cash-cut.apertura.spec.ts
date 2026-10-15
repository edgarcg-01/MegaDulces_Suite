import { puedeAbrirCorte } from './cash-cut.engine';

/**
 * `[CGP-L.4]` ¿Se puede abrir el corte de esta fecha?
 *
 * La pantalla abría siempre el de HOY y el servidor aceptaba cualquier fecha sin mirarla. Ponerse
 * al día con jornadas atrasadas (el 13 y el 14-oct) exige abrir fechas pasadas, y eso trae dos
 * riesgos que esto frena: abrir un día que todavía no pasa, y abrir un día ANTERIOR a un corte que ya
 * existe — el posterior heredó su fondo sin ese día, y un corte firmado ya no se corrige.
 */
describe('[CGP-L.4] puedeAbrirCorte', () => {
  const base = { fecha: '2026-10-13', hoy: '2026-10-15', mismoDia: null, posterior: null };

  it('una jornada pasada sin corte y sin cortes posteriores se puede abrir', () => {
    expect(puedeAbrirCorte(base)).toEqual({ ok: true });
  });

  it('hoy también', () => {
    expect(puedeAbrirCorte({ ...base, fecha: '2026-10-15' })).toEqual({ ok: true });
  });

  it('⛔ una fecha que todavía no pasa NO se abre', () => {
    const r = puedeAbrirCorte({ ...base, fecha: '2026-10-16' });
    expect(r).toMatchObject({ ok: false, motivo: 'fecha_futura' });
    expect(r.texto).toContain('16-oct');
  });

  it('⛔ una fecha que no es fecha NO se abre', () => {
    expect(puedeAbrirCorte({ ...base, fecha: '2026-13-40' })).toMatchObject({ ok: false, motivo: 'fecha_invalida' });
    expect(puedeAbrirCorte({ ...base, fecha: 'ayer' })).toMatchObject({ ok: false, motivo: 'fecha_invalida' });
    expect(puedeAbrirCorte({ ...base, fecha: '2026-02-30' })).toMatchObject({ ok: false, motivo: 'fecha_invalida' });
  });

  it('⛔ un día que ya tiene corte se rechaza nombrando el folio', () => {
    const r = puedeAbrirCorte({ ...base, mismoDia: { folio: 'CC-2026-00002' } });
    expect(r).toMatchObject({ ok: false, motivo: 'ya_existe' });
    expect(r.texto).toContain('CC-2026-00002');
  });

  it('⛔ un día ANTERIOR a un corte que ya existe NO se abre: el posterior heredó su fondo sin él', () => {
    const r = puedeAbrirCorte({ ...base, posterior: { folio: 'CC-2026-00003', fecha: '2026-10-14' } });
    expect(r).toMatchObject({ ok: false, motivo: 'hay_posterior' });
    expect(r.texto).toContain('CC-2026-00003');
    expect(r.texto).toContain('14-oct');
  });
});
