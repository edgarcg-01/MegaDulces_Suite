import type { EntradaDetail } from './entradas.service';
import { receiptVerdict } from './receipt-verdict';

/**
 * `[RE.86]` Una entrada sin papel propio pero ligada (con motivo) a la factura de otra entrada ya no pide remisión:
 * el aviso dice de qué factura es parte, por qué y quién la ligó. Caso: CEDIS 0010302 (la caja que faltó de la
 * factura GDL/319 de PAF), importe SINTÉTICO.
 */
const detalle = (ligada: boolean, conPapel = false): EntradaDetail => ({
  entrada: { sucursal: '00', folio: '0010302', monto: 20 },
  lineas: [{ importe: 18.5 }],
  deposits: conPapel ? [{ id: 'p1', status: 'recibido', ocr_monto: 20, files: [{ name: 'remision.pdf' }] }] : [],
  cedis_twins: [],
  factura_compartida: ligada
    ? { cfdi_uuid: 'U-319', serie: 'GDL/2026/', folio: '319', motivo: 'Llegó la caja que faltó de la factura 319', por: 'Revisora', fecha: '2026-11-23' }
    : null,
} as unknown as EntradaDetail);

describe('[RE.86] la entrada ligada a una factura compartida', () => {
  it('CONTROL: sin liga y sin papel, sigue pidiendo la remisión', () => {
    expect(receiptVerdict(detalle(false)).titulo).toBe('Falta la remisión del proveedor');
  });

  it('ligada, dice de qué factura es parte, por qué y quién; no pide remisión', () => {
    const v = receiptVerdict(detalle(true));
    expect(v.titulo).toBe('Parte de la factura GDL/2026/319');
    expect(v.lectura).toContain('«Llegó la caja que faltó de la factura 319»');
    expect(v.lectura).toContain('Revisora, 2026-11-23');
    expect(v.lectura).not.toMatch(/adjúntalo/);
  });

  it('si además tiene papel propio, manda el papel (la liga no lo tapa)', () => {
    expect(receiptVerdict(detalle(true, true)).titulo).not.toMatch(/Parte de la factura/);
  });
});
