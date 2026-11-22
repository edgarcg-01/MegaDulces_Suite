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

/**
 * `[PGP.122.13]` La fecha del TICKET DE GASTO (el lector de «Pedir un gasto», la captura del vale y la liga de captura).
 * Medido el 2026-11-21: las dos primeras solicitudes de gasto de usuarios (01/0000222 y 01/0000223) traían la fecha mal
 * leída y las dos personas la corrigieron a mano. El lector todavía le pedía al modelo «convierte cualquier formato», la
 * instrucción que `[PGP.125]` ya había retirado del comprobante de pago. Ahora la copia y la convierte el código.
 */
function lectorDeTicket(fecha: string | null): LlmExtractorService {
  process.env['ANTHROPIC_API_KEY'] = 'prueba';
  const anthropic = {
    messages: async () => ({
      content: [{ type: 'tool_use', name: 'extract_receipt', input: { total: 200, subtotal: null, iva: null, fecha, comercio: 'X', rfc: null, folio: '112772', legible: true } }],
    }),
  } as unknown as AnthropicService;
  return new LlmExtractorService(anthropic);
}

const ticket = async (fecha: string | null) => lectorDeTicket(fecha).extractExpenseReceipt('/9j/4AAQ', 'image/jpeg');

describe('[PGP.122.13] fecha del ticket de gasto: se copia como está impresa y la convierte el código', () => {
  it('DÍA/MES/AÑO, con año de 4 o de 2 cifras; lo impreso viaja aparte', async () => {
    const r = await ticket('21/11/2025');
    expect(r.fecha).toBe('2025-11-21');
    expect(r.fecha_impresa).toBe('21/11/2025');
    expect((await ticket('21/11/25')).fecha).toBe('2025-11-21');
  });
  it('⭐ el AÑO de 2 cifras va al final y es del 2000: «11/11/25» nunca se lee AÑO/MES/DÍA (2011-11-25)', async () => {
    // Las dos primeras usuarias (2026-11-21) recibieron la fecha con el año mal cuando el modelo la convertía solo.
    expect((await ticket('11/11/25')).fecha).toBe('2025-11-11');
    expect((await ticket('21/11/25')).fecha).not.toBe('2021-11-25');
    expect((await ticket('21-11-25')).fecha).toBe('2025-11-21');
  });
  it('lo ambiguo (día y mes ≤ 12) se queda DÍA/MES, como en México', async () => {
    expect((await ticket('05/11/2025')).fecha).toBe('2025-11-05');
  });
  it('MES/DÍA sólo cuando no puede ser otra cosa: «11/21/2025» es el 21 de noviembre', async () => {
    expect((await ticket('11/21/2025')).fecha).toBe('2025-11-21');
  });
  it('el año primero, con - / o .', async () => {
    expect((await ticket('2025-11-21 13:05')).fecha).toBe('2025-11-21');
    expect((await ticket('2025/11/21')).fecha).toBe('2025-11-21');
  });
  it('el mes en letra, en español o en inglés, antes o después del día', async () => {
    expect((await ticket('21-NOV-2025')).fecha).toBe('2025-11-21');
    expect((await ticket('21-DEC-2025')).fecha).toBe('2025-12-21');
    expect((await ticket('Nov 21, 2025')).fecha).toBe('2025-11-21');
  });
  it('la fecha en medio de otro texto; «MAR» de martes no es marzo', async () => {
    expect((await ticket('Fecha: 21/11/2025')).fecha).toBe('2025-11-21');
    expect((await ticket('13:05 21/11/25')).fecha).toBe('2025-11-21');
    expect((await ticket('MAR 12/11/2025')).fecha).toBe('2025-11-12');
  });
  it('⛔ un gasto no puede ser de mañana: la fecha futura no se propone, pero lo impreso se conserva', async () => {
    const r = await ticket('21/11/2099');
    expect(r.fecha).toBeNull();
    expect(r.fecha_impresa).toBe('21/11/2099');
  });
  it('⛔ un día que no existe no es fecha (antes salía «2026-02-31»)', async () => {
    expect((await ticket('31/02/2025')).fecha).toBeNull();
  });
  it('sin fecha en el ticket: null en las dos, y el resto de la lectura sigue', async () => {
    const r = await ticket(null);
    expect(r.fecha).toBeNull();
    expect(r.fecha_impresa).toBeNull();
    expect(r.total).toBe(200);
    expect(r.legible).toBe(true);
  });
});
