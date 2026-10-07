import type { ReceiptExpediente } from '@megadulces/contracts';
import type { EntradaDetail } from './entradas.service';
import { cfdiQueCuadra, receiptVerdict } from './receipt-verdict';

/**
 * [RE.35.6] Cuando el CFDI de ContPAQi cuadra con Kepler, manda sobre el OCR. Caso real que lo
 * pidió (2026-10-06): el OCR leyó $3,320,584.53 (un "3" de más) en una factura de $320,584.53;
 * Kepler registró $320,584.35. El aviso decía "cobra de MÁS $3,000,000.18".
 */
const detalle = (ocr: number | null): EntradaDetail => ({
  entrada: { sucursal: '00', folio: '0009872', monto: 320584.35 },
  lineas: [{ importe: 296730.98 }],
  deposits: [{ id: 'p1', status: 'recibido', ocr_monto: ocr, files: [{ name: 'factura.pdf' }] }],
  cedis_twins: [],
} as unknown as EntradaDetail);

const expediente = (over: Partial<ReceiptExpediente> = {}, e1: 'ok' | 'falla' = 'ok'): ReceiptExpediente => ({
  sucursal: '00', folio: '0009872', doc_tipo: 'factura', cubo: 'auto', motivos: [],
  checks: [{ clave: 'E1_cuadre', grupo: 'entrada', etiqueta: 'Total contra la entrada', valor: null, estado: e1, bloquea: true, nota: null }],
  cfdi: { uuid: 'F32A11C2-0AE3-4DFF-9993-55E3690649E9', total: 320584.53 },
  liga: { metodo: 'rfc_importe', exacta: true, candidatos: 1 },
  lectura: null, monto_entrada: 320584.35, diferencia: 0.18, via: 'factura', hallazgos: [],
  nota_credito: null, regla: 'R-v1', tolerancia: { pct: 0.0025, abs: 200 },
  ...over,
} as unknown as ReceiptExpediente);

describe('[RE.35.6] el CFDI que cuadra manda sobre el OCR', () => {
  it('sin CFDI, el OCR equivocado sigue siendo "cobra de MÁS" (lo de antes no cambia)', () => {
    const v = receiptVerdict(detalle(3320584.53));
    expect(v.tone).toBe('bad');
    expect(v.ocrDesmentido).toBe(false);
  });

  it('con el CFDI que cuadra, el aviso es verde y el OCR queda desmentido', () => {
    const v = receiptVerdict(detalle(3320584.53), true, cfdiQueCuadra(expediente()));
    expect(v.tone).toBe('ok');
    expect(v.titulo).toBe('Cuadra con el CFDI de ContPAQi');
    expect(v.ocrDesmentido).toBe(true);
    expect(v.lectura).toMatch(/error de lectura/);
  });

  it('con el CFDI que cuadra y un OCR que no leyó el total, también pasa', () => {
    const v = receiptVerdict(detalle(null), false, cfdiQueCuadra(expediente()));
    expect(v.tone).toBe('ok');
    expect(v.ocrDesmentido).toBe(false);
  });

  it('una liga sugerida (no exacta) no manda', () => {
    expect(cfdiQueCuadra(expediente({ liga: { metodo: 'rfc_importe', exacta: false, candidatos: 2 } }))).toBeNull();
  });

  it('un CFDI que NO cuadra con Kepler no manda', () => {
    expect(cfdiQueCuadra(expediente({}, 'falla'))).toBeNull();
  });

  it('la vía de remisión no usa CFDI', () => {
    expect(cfdiQueCuadra(expediente({ via: 'remision' }))).toBeNull();
  });

  it('sin papel adjunto, sigue faltando la remisión aunque haya CFDI', () => {
    const d = { ...detalle(null), deposits: [] } as unknown as EntradaDetail;
    expect(receiptVerdict(d, false, cfdiQueCuadra(expediente())).tone).toBe('muted');
  });
});
