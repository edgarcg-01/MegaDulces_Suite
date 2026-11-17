import type { AnthropicService } from './anthropic.service';
import { LlmExtractorService } from './llm-extractor.service';

/**
 * `[PGP.125]` La fecha del comprobante de pago a proveedor. Medido el 2026-11-14: un comprobante BBVA que dice
 * «09/11/2026» (9 de noviembre) se leyó como 2026-09-11, porque la instrucción le pedía al modelo convertir
 * «cualquier formato» y el modelo tomó MES/DÍA. Ahora el modelo copia lo impreso y la convierte el código, DÍA/MES.
 * Las fechas de abajo son los formatos de los comprobantes reales de noviembre (BBVA, Santander, Banorte, Bajío).
 */
function servicioQueLee(fecha: string): LlmExtractorService {
  process.env['ANTHROPIC_API_KEY'] = 'prueba';
  const anthropic = {
    messages: async () => ({
      content: [{ type: 'tool_use', name: 'extract_supplier_payment', input: { monto: 511359.31, fecha, concepto: '542 544 546' } }],
    }),
  } as unknown as AnthropicService;
  return new LlmExtractorService(anthropic);
}

const leer = async (fecha: string) => (await servicioQueLee(fecha).extractSupplierPayment('JVBERi0=', 'application/pdf')).fecha;

describe('[PGP.125] fecha del comprobante de pago: DÍA/MES/AÑO, como se imprime en México', () => {
  it('«09/11/2026» es el 9 de noviembre, no el 11 de septiembre (el caso medido)', async () => {
    expect(await leer('09/11/2026')).toBe('2026-11-09');
  });
  it('con la hora pegada, como la imprimen Santander y BBVA', async () => {
    expect(await leer('12/11/2026 17:30:58')).toBe('2026-11-12');
    expect(await leer('09/11/2026 5:17:36 PM')).toBe('2026-11-09');
  });
  it('con el mes en letra (Banorte, Bajío)', async () => {
    expect(await leer('06/Nov./2026')).toBe('2026-11-06');
    expect(await leer('04-Nov-2026')).toBe('2026-11-04');
  });
  it('ISO con hora (Santander «Consulta de movimientos») se respeta', async () => {
    expect(await leer('2026-11-06 17:02:56')).toBe('2026-11-06');
  });
  it('lo que no es fecha queda null: no se inventa', async () => {
    expect(await leer('sin fecha')).toBeNull();
    expect(await leer('31/13/2026')).toBeNull();
  });
});
