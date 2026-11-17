import { decidirCancelacionSolicitud, sentenciasCancelacionSolicitud, type EntradaCancelacionSolicitud } from './solicitud-kepler.cancelacion';

const MARCA = 'SUITE SG-1A2B3C4D';
const buena = (): EntradaCancelacionSolicitud => ({ coincidencias: 1, solicitud: { folio: '0000082', estado: 'A', marca: MARCA }, marcaDelVale: MARCA, gastosVivos: [] });

describe('[PGP.122] F3 decidirCancelacionSolicitud — cancelar desde la Suite igual que Kepler (DS40)', () => {
  it('autorizada (A) o nueva (N), con la marca del vale y sin gasto vivo → se cancela', () => {
    expect(decidirCancelacionSolicitud(buena())).toEqual({ ok: true });
    expect(decidirCancelacionSolicitud({ ...buena(), solicitud: { ...buena().solicitud!, estado: 'N' } })).toEqual({ ok: true });
  });
  it('⛔ DS40: con un gasto X-A-10 vivo no se cancela aquí, y dice cuál', () => {
    const d = decidirCancelacionSolicitud({ ...buena(), gastosVivos: ['0000151'] });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.motivo).toMatch(/0000151.*DS40/);
  });
  it('⛔ una solicitud con otra marca (o sin marca) no es de este vale: no se toca', () => {
    expect(decidirCancelacionSolicitud({ ...buena(), solicitud: { ...buena().solicitud!, marca: 'SUITE SG-FFFFFFFF' } }).ok).toBe(false);
    expect(decidirCancelacionSolicitud({ ...buena(), solicitud: { ...buena().solicitud!, marca: '' } }).ok).toBe(false);
    expect(decidirCancelacionSolicitud({ ...buena(), marcaDelVale: '' }).ok).toBe(false);
  });
  it('ya cancelada en Kepler → no se escribe, y se avisa para cerrar el vale igual', () => {
    const d = decidirCancelacionSolicitud({ ...buena(), solicitud: { ...buena().solicitud!, estado: 'C' } });
    expect(d).toMatchObject({ ok: false, yaCancelada: true });
  });
  it('⛔ ejecutada (F), inexistente o con el folio repetido en dos series → no', () => {
    expect(decidirCancelacionSolicitud({ ...buena(), solicitud: { ...buena().solicitud!, estado: 'F' } }).ok).toBe(false);
    expect(decidirCancelacionSolicitud({ ...buena(), solicitud: null, coincidencias: 0 }).ok).toBe(false);
    expect(decidirCancelacionSolicitud({ ...buena(), coincidencias: 2 }).ok).toBe(false);
  });
});

describe('[PGP.122] F3 sentenciasCancelacionSolicitud — lo mismo que escribe Kepler, y con candado', () => {
  const plan = { sucursal: '05', folio: '0000082', estado: 'A', marca: MARCA, capturista: 'SUITE', fecha: '2026-11-17', hora: '14:05' };
  it('pone C y en cero IVA, total y saldo; quién y cuándo; NO borra renglones (Kepler los conserva)', () => {
    const [s, ...resto] = sentenciasCancelacionSolicitud(plan);
    expect(resto).toHaveLength(0);
    expect(s.sql).toMatch(/SET c43 = 'C', c14 = 0, c16 = 0, c42 = 0, c67 = \$5, c68 = \$6, c69 = \$7/);
    expect(s.sql).not.toMatch(/DELETE|kdm6/);
    expect(s.params).toEqual(['05', '0000082', 'A', MARCA, 'SUITE', '2026-11-17', '14:05']);
    expect(s.esperadas).toBe(1);
  });
  it('el WHERE repite estado, marca y «sin gasto vivo» (c37 = 15, c39 = folio): si alguien la tocó, 0 filas', () => {
    const [s] = sentenciasCancelacionSolicitud(plan);
    expect(s.sql).toMatch(/btrim\(c43\) = \$3 AND btrim\(c26\) = \$4/);
    expect(s.sql).toMatch(/NOT EXISTS[\s\S]*c4 = 10[\s\S]*btrim\(g\.c37::text\) = '15' AND btrim\(g\.c39\) = \$2 AND btrim\(g\.c43\) <> 'C'/);
  });
  it('⛔ un estado no cancelable no llega a sentencia', () => {
    expect(() => sentenciasCancelacionSolicitud({ ...plan, estado: 'F' })).toThrow();
  });
});
