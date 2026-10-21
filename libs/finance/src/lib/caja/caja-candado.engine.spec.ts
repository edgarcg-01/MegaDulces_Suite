import { candadoDeCaptura, candadoDeCierre, puedeDarLlave, type EstadoParaCapturar } from './caja-candado.engine';

/**
 * `[CGS.14][CGS.15][CGS.3]` Los candados de la caja. El caso de prod que los motiva (2026-10-21): el
 * 20-oct con 30 movimientos y sin corte, y el 21 ya capturando encima.
 */
describe('candadoDeCaptura — sin corte de ayer, hoy no se captura (D1)', () => {
  const base: EstadoParaCapturar = { hoy: '2026-10-21', sinCorte: [], borradorAnterior: null, llave: null, activo: true };

  it('sin jornadas pendientes, se captura', () => {
    expect(candadoDeCaptura(base).bloqueado).toBe(false);
  });

  it('[negativa] el 20-oct sin corte bloquea el 21, y la frase dice qué hacer', () => {
    const c = candadoDeCaptura({ ...base, sinCorte: [{ fecha: '2026-10-20', movimientos: 30 }] });
    expect(c).toMatchObject({ bloqueado: true, motivo: 'jornada_sin_corte', jornada: '2026-10-20' });
    expect(c.texto).toContain('20/10/2026');
    expect(c.texto).toContain('llave de emergencia');
  });

  it('hoy todavía no tiene corte y eso NO bloquea: es la jornada en curso', () => {
    expect(candadoDeCaptura({ ...base, sinCorte: [{ fecha: '2026-10-21', movimientos: 5 }] }).bloqueado).toBe(false);
  });

  it('[negativa] un corte de ayer abierto y sin cerrar también bloquea', () => {
    const c = candadoDeCaptura({ ...base, borradorAnterior: { folio: 'CC-2026-00008', fecha: '2026-10-20' } });
    expect(c).toMatchObject({ bloqueado: true, motivo: 'corte_sin_cerrar' });
    expect(c.texto).toContain('CC-2026-00008');
  });

  it('el corte de HOY abierto no bloquea: es el que se está trabajando', () => {
    expect(candadoDeCaptura({ ...base, borradorAnterior: { folio: 'CC-2026-00009', fecha: '2026-10-21' } }).bloqueado).toBe(false);
  });

  it('con llave vigente se captura, y se dice que es con llave', () => {
    const llave = { otorgada_por_username: 'maria', motivo: 'Pago urgente a proveedor', vence_at: '2026-10-22T05:59:59Z' };
    const c = candadoDeCaptura({ ...base, sinCorte: [{ fecha: '2026-10-20', movimientos: 30 }], llave });
    expect(c.bloqueado).toBe(false);
    expect(c.con_llave).toEqual(llave);
  });

  it('apagado por el interruptor de emergencia, no bloquea (y lo declara)', () => {
    const c = candadoDeCaptura({ ...base, activo: false, sinCorte: [{ fecha: '2026-10-20', movimientos: 30 }] });
    expect(c).toMatchObject({ bloqueado: false, activo: false });
  });
});

describe('puedeDarLlave — nadie se abre su propio candado', () => {
  const ok = { otorgaId: 'u-maria', paraId: 'u-carmen', motivo: 'Pago urgente de nómina de ruta', hayCandado: true };
  it('otra persona, con motivo, con la caja bloqueada: sí', () => {
    expect(puedeDarLlave(ok)).toEqual({ ok: true });
  });
  it('[negativa] para sí misma, sin motivo, sin destinatario o sin candado: no', () => {
    expect(puedeDarLlave({ ...ok, paraId: 'u-maria' }).motivo).toBe('para_si_misma');
    expect(puedeDarLlave({ ...ok, motivo: 'ya' }).motivo).toBe('sin_motivo');
    expect(puedeDarLlave({ ...ok, paraId: null }).motivo).toBe('sin_destinatario');
    expect(puedeDarLlave({ ...ok, hayCandado: false }).motivo).toBe('no_hace_falta');
  });
});

describe('candadoDeCierre (CGS.3, D2) — sin revisión no se acumula', () => {
  const dos = [{ folio: 'CC-1', fecha: '2026-10-22' }, { folio: 'CC-2', fecha: '2026-10-23' }];
  it('apagado (sin fecha de arranque) nunca frena', () => {
    expect(candadoDeCierre({ sinRevisar: dos, desde: null }).ok).toBe(true);
  });
  it('con uno sin revisar, se cierra', () => {
    expect(candadoDeCierre({ sinRevisar: dos.slice(0, 1), desde: '2026-10-22' }).ok).toBe(true);
  });
  it('[negativa] con dos sin revisar, no se cierra el tercero y los nombra', () => {
    const r = candadoDeCierre({ sinRevisar: dos, desde: '2026-10-22' });
    expect(r.ok).toBe(false);
    expect(r.texto).toContain('CC-1');
    expect(r.texto).toContain('suplente');
  });
});
