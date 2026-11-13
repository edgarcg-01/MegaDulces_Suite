import type { EntradaDetail } from './entradas.service';
import { receiptVerdict } from './receipt-verdict';

/**
 * `[RE.70]` Caso real (2026-11-13): entrada 0000421 de Morelia Abastos, MERENGUE LA MORENITA.
 * Kepler $5,375.00, el OCR leyó $5,373.75 → cobra de menos $1.25. La pantalla decía «hay
 * devoluciones, mira abajo» por una devolución de $900 que ni siquiera era de esta entrada.
 */
const detalle = (): EntradaDetail => ({
  entrada: { sucursal: '08', folio: '0000421', monto: 5375 },
  lineas: [{ importe: 2500 }, { importe: 2875 }],
  deposits: [{ id: 'p1', status: 'recibido', ocr_monto: 5373.75, files: [{ name: 'remision.pdf' }] }],
  cedis_twins: [],
} as unknown as EntradaDetail);

const PISTA = /mira "¿Por qué no cuadra\?"/;

describe('[RE.70] la pista «mira abajo» sólo cuando un ajuste puede explicar el hueco', () => {
  it('un ajuste candidato de $900 NO explica un hueco de $1.25: sin pista', () => {
    const v = receiptVerdict(detalle(), [{ monto: '900.00', match: 'proveedor+fecha' }]);
    expect(v.tone).toBe('bad');
    expect(v.titulo).toBe('El documento cobra de MENOS $1.25');
    expect(v.lectura).not.toMatch(PISTA);
  });

  it('sin ajustes: sin pista', () => {
    expect(receiptVerdict(detalle(), []).lectura).not.toMatch(PISTA);
  });

  it('un ajuste de la MISMA magnitud que el hueco sí da la pista (signo indistinto)', () => {
    expect(receiptVerdict(detalle(), [{ monto: -1.25, match: 'proveedor+fecha' }]).lectura).toMatch(PISTA);
  });

  it('un ajuste ligado por Kepler a ESTA entrada da la pista aunque no case el monto', () => {
    expect(receiptVerdict(detalle(), [{ monto: 900, match: 'exacto' }]).lectura).toMatch(PISTA);
  });

  it('el contrato viejo (boolean) no cambia', () => {
    expect(receiptVerdict(detalle(), true).lectura).toMatch(PISTA);
    expect(receiptVerdict(detalle(), false).lectura).not.toMatch(PISTA);
  });
});
