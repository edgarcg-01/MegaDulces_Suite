import { puertasRevision, type CorteARevisar } from './caja-revision.util';

/** `[CGS.24]` Los botones de la supervisora se apagan con su motivo, igual que el servidor. */
describe('puertasRevision', () => {
  const cerrado: CorteARevisar = {
    estado: 'cerrado', veredicto: 'cuadra', diferencia: 0, no_revisa: ['u-cajera', 'u-mayra'],
  };
  const nota = 'Un billete de 500 mal clasificado';

  it('un corte que cuadra se autoriza sin nota; observar pide texto', () => {
    const p = puertasRevision(cerrado, 'u-maria', true, '');
    expect(p.autorizar.ok).toBe(true);
    expect(p.pideNota).toBe(false);
    expect(p.observar.ok).toBe(false);
  });

  it('[negativa] con diferencia, autorizar pide nota de 10+', () => {
    const c = { ...cerrado, veredicto: 'falta' as const, diferencia: -62.45 };
    expect(puertasRevision(c, 'u-maria', true, 'ok').autorizar.ok).toBe(false);
    expect(puertasRevision(c, 'u-maria', true, nota).autorizar.ok).toBe(true);
    expect(puertasRevision(c, 'u-maria', true, '').pideNota).toBe(true);
  });

  it('[negativa] un esperado imposible no se autoriza ni con nota, pero sí se observa', () => {
    const c = { ...cerrado, veredicto: 'esperado_imposible' as const, diferencia: 207486.32 };
    const p = puertasRevision(c, 'u-maria', true, 'Falta la pierna del depósito del banco');
    expect(p.autorizar.ok).toBe(false);
    expect(p.autorizar.texto).toContain('Obsérvalo');
    expect(p.observar.ok).toBe(true);
  });

  it('[negativa] quien abrió, cerró o capturó no revisa (D3)', () => {
    const p = puertasRevision(cerrado, 'u-mayra', true, nota);
    expect(p.autorizar.ok).toBe(false);
    expect(p.observar.ok).toBe(false);
    expect(p.autorizar.texto).toContain('otra persona');
  });

  it('[negativa] sin permiso, observado o autorizado: no, y dice por qué', () => {
    expect(puertasRevision(cerrado, 'u-maria', false, nota).autorizar.texto).toContain('permiso');
    expect(puertasRevision({ ...cerrado, estado: 'observado', observo: 'maria' }, 'u-x', true, nota).observar.texto)
      .toContain('espera la respuesta');
    expect(puertasRevision({ ...cerrado, estado: 'autorizado', autorizo: 'guillermo' }, 'u-x', true, nota).autorizar.texto)
      .toContain('guillermo');
  });
});
