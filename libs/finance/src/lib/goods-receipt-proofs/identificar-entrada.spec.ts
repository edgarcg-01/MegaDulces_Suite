import type { IdentificacionCandidata } from '@megadulces/contracts';
import { clasificarIdentificacion } from './identificar-entrada';
import { veredictoExpediente, type EntradaVeredicto } from './expediente-verdict';

const cand = (over: Partial<IdentificacionCandidata> = {}): IdentificacionCandidata => ({
  sucursal: '00', folio: '0009872', receipt_date: '2026-09-22', proveedor_nombre: 'CANELS SA DE CV',
  proveedor_rfc: null, oc_folio: '0000291', monto: 320584.35, diferencia: 0.18, proveedor_ok: true, deposits: 0,
  ...over,
});
const exacta = { metodo: 'uuid' as const, exacta: true, candidatos: 1 };
const base = { hayLectura: true, cfdi: true, liga: exacta, sello: true, firma: true, candidatas: [cand()] };

describe('[RE.35.7] identificar la entrada de un papel escaneado', () => {
  it('CFDI exacto + una entrada libre que cuadra + sello y firma = listo', () => {
    const r = clasificarIdentificacion(base);
    expect(r.confianza).toBe('listo');
    expect(r.propuesta).toEqual({ sucursal: '00', folio: '0009872' });
    expect(r.motivos).toEqual(['todo_coincide']);
  });

  it('sin sello o sin firma nunca sale listo (es lo que da valor al papel)', () => {
    expect(clasificarIdentificacion({ ...base, sello: false }).motivos).toContain('sin_sello');
    expect(clasificarIdentificacion({ ...base, firma: false }).confianza).toBe('revisar');
    expect(clasificarIdentificacion({ ...base, sello: null }).motivos).toContain('sello_no_visible');
  });

  it('una liga sugerida o sin CFDI propone, pero no pre-marca', () => {
    expect(clasificarIdentificacion({ ...base, liga: { metodo: 'rfc_importe', exacta: false, candidatos: 1 } }).motivos).toContain('liga_sugerida');
    const sin = clasificarIdentificacion({ ...base, cfdi: false, liga: null });
    expect(sin.confianza).toBe('revisar');
    expect(sin.motivos).toContain('sin_cfdi');
  });

  it('dos entradas libres que cuadran: elige la persona', () => {
    const r = clasificarIdentificacion({ ...base, candidatas: [cand(), cand({ folio: '0009873' })] });
    expect(r.confianza).toBe('elegir');
    expect(r.propuesta).toBeNull();
  });

  it('una libre y otra que ya tiene papel: se propone la libre', () => {
    const r = clasificarIdentificacion({ ...base, candidatas: [cand({ folio: 'X', deposits: 1 }), cand()] });
    expect(r.confianza).toBe('listo');
    expect(r.propuesta?.folio).toBe('0009872');
  });

  it('la única que cuadra ya tiene papel: revisar (puede ser el mismo papel dos veces)', () => {
    const r = clasificarIdentificacion({ ...base, candidatas: [cand({ deposits: 1 })] });
    expect(r.confianza).toBe('revisar');
    expect(r.motivos).toContain('ya_tiene_papel');
  });

  it('proveedor sin confirmar no pre-marca', () => {
    expect(clasificarIdentificacion({ ...base, candidatas: [cand({ proveedor_ok: null })] }).motivos).toContain('proveedor_sin_confirmar');
  });

  it('sin lectura o sin candidatas: sin entrada', () => {
    expect(clasificarIdentificacion({ ...base, hayLectura: false }).motivos).toEqual(['sin_lectura']);
    expect(clasificarIdentificacion({ ...base, candidatas: [] }).confianza).toBe('sin_entrada');
  });
});

describe('[RE.35.7] sello y firma en el expediente', () => {
  const v = (over: Partial<EntradaVeredicto>): EntradaVeredicto => ({
    docTipo: 'remision',
    entrada: { monto: 1000, oc_folio: '1', fecha_recepcion: '2026-09-22', fecha_recepcion_usuario: null, receipt_date: '2026-09-22', proveedor_nombre: 'X', interno: false },
    cfdi: null, liga: null, ambiguos: 0, totalLeido: 1000, fechaDocumento: '2026-09-22', historial: null,
    ctx: { receptorRfc: null, receptorRegimen: null, listasSat: [] }, hoy: '2026-10-06',
    ...over,
  });
  const check = (r: ReturnType<typeof veredictoExpediente>, k: string) => r.checks.find((c) => c.clave === k);

  it('con sello y firma la remisión que cuadra pasa sola', () => {
    const r = veredictoExpediente(v({ sello: true, firma: true }));
    expect(r.cubo).toBe('auto');
    expect(check(r, 'E4_sello')?.estado).toBe('ok');
  });

  it('sin sello o sin firma no pasa sola', () => {
    expect(veredictoExpediente(v({ sello: false, firma: true })).cubo).toBe('revisar');
    expect(veredictoExpediente(v({ sello: true, firma: false })).motivos).toContain('El papel no trae la firma de quien recibió.');
  });

  it('una lectura anterior (sin dato) informa pero no bloquea', () => {
    const r = veredictoExpediente(v({}));
    expect(r.cubo).toBe('auto');
    expect(check(r, 'E4_sello')?.estado).toBe('sin_medir');
    expect(check(r, 'E5_firma')?.bloquea).toBe(false);
  });
});
