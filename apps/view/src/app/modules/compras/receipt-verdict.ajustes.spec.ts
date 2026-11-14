import type { EntradaDetail } from './entradas.service';
import { receiptVerdict } from './receipt-verdict';

/**
 * `[RE.70]` Caso real (2026-11-13): entrada 0000421 de Morelia Abastos, MERENGUE LA MORENITA.
 * Kepler $5,375.00, el OCR leyó $5,373.75 → cobra de menos $1.25. La pantalla decía «hay
 * devoluciones, mira abajo» por una devolución de $900 que ni siquiera era de esta entrada.
 * `[RE.73]` Con la tolerancia del expediente, $1.25 sobre $5,375 CUADRA: la prueba usa $75 (1.4 %).
 */
const detalle = (): EntradaDetail => ({
  entrada: { sucursal: '08', folio: '0000421', monto: 5375 },
  lineas: [{ importe: 2500 }, { importe: 2875 }],
  deposits: [{ id: 'p1', status: 'recibido', ocr_monto: 5300, files: [{ name: 'remision.pdf' }] }],
  cedis_twins: [],
} as unknown as EntradaDetail);

const PISTA = /mira "¿Por qué no cuadra\?"/;

describe('[RE.70] la pista «mira abajo» sólo cuando un ajuste puede explicar el hueco', () => {
  it('un ajuste candidato de $900 NO explica un hueco de $75: sin pista', () => {
    const v = receiptVerdict(detalle(), [{ monto: '900.00', match: 'proveedor+fecha' }]);
    expect(v.tone).toBe('bad');
    expect(v.titulo).toBe('El documento cobra de MENOS $75.00');
    expect(v.lectura).not.toMatch(PISTA);
  });

  it('sin ajustes: sin pista', () => {
    expect(receiptVerdict(detalle(), []).lectura).not.toMatch(PISTA);
  });

  it('un ajuste de la MISMA magnitud que el hueco sí da la pista (signo indistinto)', () => {
    expect(receiptVerdict(detalle(), [{ monto: -75, match: 'proveedor+fecha' }]).lectura).toMatch(PISTA);
  });

  it('un ajuste ligado por Kepler a ESTA entrada da la pista aunque no case el monto', () => {
    expect(receiptVerdict(detalle(), [{ monto: 900, match: 'exacto' }]).lectura).toMatch(PISTA);
  });

  it('el contrato viejo (boolean) no cambia', () => {
    expect(receiptVerdict(detalle(), true).lectura).toMatch(PISTA);
    expect(receiptVerdict(detalle(), false).lectura).not.toMatch(PISTA);
  });
});

/**
 * `[RE.73]` El panel usa la MISMA tolerancia que el expediente (menos de 0.25 % y de $200) y sólo
 * dice «al centavo» cuando lo es.
 */
describe('[RE.73] una sola tolerancia del cuadre', () => {
  const conOcr = (monto: number, ocr: number): EntradaDetail => ({
    entrada: { sucursal: '08', folio: '0000421', monto },
    lineas: [{ importe: monto }],
    deposits: [{ id: 'p1', status: 'recibido', ocr_monto: ocr, files: [{ name: 'remision.pdf' }] }],
    cedis_twins: [],
  } as unknown as EntradaDetail);

  it('$1.25 sobre $5,375 cuadra, pero NO «al centavo»: dice cuánto y que está en tolerancia', () => {
    const v = receiptVerdict(conOcr(5375, 5373.75), []);
    expect(v.tone).toBe('ok');
    expect(v.lectura).not.toMatch(/al centavo/);
    expect(v.lectura).toMatch(/difieren \$1\.25, dentro de la tolerancia \(menos de 0\.25 % y de \$200\)/);
  });

  it('igual al centavo sí dice «al centavo»', () => {
    expect(receiptVerdict(conOcr(5375, 5375), []).lectura).toMatch(/coinciden al centavo/);
  });

  it('$150 sobre $100,000 cuadra (antes: «cobra de más» con el expediente diciendo que cuadra)', () => {
    expect(receiptVerdict(conOcr(100000, 100150), []).tone).toBe('ok');
  });

  it('NEGATIVA: $1 sobre $300 es 0.33 %: ya no cuadra (antes cabía en el ±$1)', () => {
    const v = receiptVerdict(conOcr(300, 301), []);
    expect(v.tone).toBe('bad');
    expect(v.titulo).toBe('El documento cobra de MÁS $1.00');
  });
});
