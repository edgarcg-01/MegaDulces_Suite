import { decidirDictado } from './dictado';

describe('[MS.DICTADO] decidirDictado', () => {
  it('un área normal permite dictar', () => {
    expect(decidirDictado('q1', { confidential: false })).toEqual({ ok: true });
  });

  it('⛔ NEGATIVA — un área confidencial NO se transcribe (403): el audio saldría a un tercero', () => {
    const r = decidirDictado('q-rh', { confidential: true });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect((r as { mensaje: string }).mensaje).toMatch(/confidencial/i);
  });

  it('⛔ NEGATIVA — fail-closed: sin área no se transcribe (400)', () => {
    expect(decidirDictado(undefined, { confidential: false })).toMatchObject({ ok: false, status: 400 });
    expect(decidirDictado('', { confidential: false })).toMatchObject({ ok: false, status: 400 });
    expect(decidirDictado(42 as unknown as string, { confidential: false })).toMatchObject({ ok: false, status: 400 });
  });

  it('⛔ NEGATIVA — un área que no existe no se transcribe (404), aunque no sea confidencial', () => {
    expect(decidirDictado('no-existe', null)).toMatchObject({ ok: false, status: 404 });
    expect(decidirDictado('no-existe', undefined)).toMatchObject({ ok: false, status: 404 });
  });

  it('CONTROL — la confidencialidad pesa más que cualquier otra cosa: el orden de las reglas no la deja pasar', () => {
    expect(decidirDictado('q-rh', { confidential: true })).not.toEqual({ ok: true });
  });
});
