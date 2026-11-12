import { fechaCorta, respuesta } from './quote-tracking.component';
import type { PasoSeguimiento } from '../quotes.service';

/** `[GP.9.1]` La línea que contesta «¿dónde va mi pedido?», con casos medidos en prod el 2026-11-12. */
const paso = (clave: PasoSeguimiento['clave'], titulo: string, hecho: boolean, o: Partial<PasoSeguimiento> = {}): PasoSeguimiento => ({
  clave, titulo, hecho, cuando: null, quien: null, sin_responsable: false, documentos: [], ...o,
});
const cadena = (hasta: number, extra: Partial<Record<PasoSeguimiento['clave'], Partial<PasoSeguimiento>>> = {}) =>
  ([['pedido', 'Pedido en Kepler'], ['autorizado', 'Autorizado'], ['surtido', 'Surtido'], ['checado', 'Checado'], ['embarcado', 'Embarcado'], ['facturado', 'Facturado']] as const)
    .map(([c, t], i) => paso(c, t, i <= hasta, extra[c]));

describe('respuesta', () => {
  it('facturado: dice cuándo y no propone siguiente', () => {
    expect(respuesta(cadena(5, { facturado: { cuando: '2026-11-11 16:49' } }))).toEqual({ ahora: 'Facturado · 11 nov 16:49', sigue: null });
  });

  it('detenido en surtido: el siguiente paso en minúscula', () => {
    expect(respuesta(cadena(2))).toEqual({ ahora: 'Surtido', sigue: 'Sigue: checado' });
  });

  it('Canindo: embarcado y su única factura cancelada → lo dice, no sólo «sigue: facturado»', () => {
    const r = respuesta(cadena(4, {
      embarcado: { cuando: '2026-11-10' },
      facturado: { documentos: [{ documento: 'UD0801-0001350', fecha: '2026-11-10', cancelado: true, importe: 0 }] },
    }));
    expect(r).toEqual({ ahora: 'Embarcado · 10 nov', sigue: 'La factura UD0801-0001350 se canceló y falta refacturar' });
  });

  it('con una refactura viva, la cancelada ya no es el mensaje', () => {
    const r = respuesta(cadena(5, { facturado: { cuando: '2026-11-13', documentos: [
      { documento: 'UD0801-0001400', fecha: '2026-11-13', cancelado: false, importe: 1 },
      { documento: 'UD0801-0001350', fecha: '2026-11-10', cancelado: true, importe: 0 },
    ] } }));
    expect(r.sigue).toBeNull();
  });

  it('sin pasos hechos no inventa avance', () => {
    expect(respuesta(cadena(-1))).toEqual({ ahora: 'Sin avance en Kepler', sigue: null });
  });
});

describe('fechaCorta', () => {
  it('fecha y fecha con hora, en español', () => {
    expect(fechaCorta('2026-11-02')).toBe('2 nov');
    expect(fechaCorta('2026-01-31 09:05')).toBe('31 ene 09:05');
  });
  it('lo que no es fecha pasa tal cual (no se inventa)', () => {
    expect(fechaCorta('pronto')).toBe('pronto');
    expect(fechaCorta(null)).toBe('');
  });
});
