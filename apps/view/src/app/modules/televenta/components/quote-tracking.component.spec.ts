import { fechaCorta, gruposCambios, marcaRenglon, respuesta, resumenCambios, textoCambio } from './quote-tracking.component';
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

  it('facturado con factura viva: el importe va en la respuesta (COT-2026-00279: $9,000.10)', () => {
    const r = respuesta(cadena(5, { facturado: { cuando: '2026-11-12', documentos: [
      { documento: 'UD0801-0000764', fecha: '2026-11-12', cancelado: false, importe: 9000.1 },
    ] } }));
    expect(r.ahora).toBe('Facturado · 12 nov · $9,000.10');
  });

  it('el importe de una cancelada NO va en la respuesta (prueba negativa)', () => {
    const r = respuesta(cadena(5, { facturado: { cuando: '2026-11-12', documentos: [
      { documento: 'UD0801-0001350', fecha: '2026-11-12', cancelado: true, importe: 500 },
    ] } }));
    expect(r.ahora).toBe('Facturado · 12 nov');
  });

  it('sin pasos hechos no inventa avance', () => {
    expect(respuesta(cadena(-1))).toEqual({ ahora: 'Sin avance en Kepler', sigue: null });
  });
});

describe('[GP.9.3] cambios contra la cotización', () => {
  const c = (tipo: 'quitado' | 'menos' | 'mas' | 'agregado', o: Record<string, unknown> = {}) =>
    ({ sku: '47005', nombre: 'X', tipo, cotizado: 2, pedido: tipo === 'quitado' ? 0 : 1, unidad: 'CJA', importe_cotizado: 812.5, ...o }) as never;

  it('cada tipo se lee en la presentación cotizada', () => {
    expect(textoCambio(c('quitado'))).toBe('Cotizaste 2 CJA; el pedido ya no lo trae');
    expect(textoCambio(c('menos'))).toBe('Cotizaste 2 CJA; el pedido trae 1 CJA');
    expect(textoCambio(c('mas', { pedido: 3 }))).toBe('Cotizaste 2 CJA; el pedido trae 3 CJA (más)');
    expect(textoCambio(c('agregado', { cotizado: null, pedido: 6, unidad: 'PAQ' }))).toBe('No se cotizó; el pedido trae 6 PAQ');
  });

  it('el resumen cuenta los quitados con su importe cotizado y aparte lo demás', () => {
    const r = resumenCambios([c('quitado'), c('quitado', { sku: '2', importe_cotizado: 187.5 }), c('menos', { sku: '3' })]);
    expect(r).toMatch(/^En Kepler cambiaron 3 renglones de tu cotización: 2 quitados \(\$1,000\.00 cotizados\), 1 con otra cantidad o agregado$/);
  });

  it('un solo renglón, en singular', () => {
    expect(resumenCambios([c('menos')])).toBe('En Kepler cambió 1 renglón de tu cotización: 1 con otra cantidad o agregado');
  });
});

describe('[GP.9.3] detalle agrupado y marca en la tabla (auditoría 2026-11-13)', () => {
  const c = (tipo: 'quitado' | 'menos' | 'mas' | 'agregado', o: Record<string, unknown> = {}) =>
    ({ sku: '47005', nombre: 'X', tipo, cotizado: 2, pedido: tipo === 'quitado' ? 0 : 1, unidad: 'CJA', importe_cotizado: 812.5, ...o }) as never;

  it('agrupa por lo que pasó; cada renglón sólo lleva su cantidad, sin repetir la frase', () => {
    const g = gruposCambios([c('quitado', { cotizado: 16, unidad: 'PAQ' }), c('menos', { sku: '2' }), c('agregado', { sku: '3', cotizado: null, pedido: 60, unidad: 'KG' }), c('quitado', { sku: '4' })]);
    expect(g.map((x) => [x.clave, x.renglones.length])).toEqual([['quitado', 2], ['cantidad', 1], ['agregado', 1]]);
    expect(g[0].renglones[0]).toEqual({ sku: '47005', nombre: 'X', cantidad: '16 PAQ' });
    expect(g[1].renglones[0].cantidad).toBe('2 → 1 CJA');
    expect(g[2].renglones[0].cantidad).toBe('60 KG');
  });

  it('sin cambios no hay grupos', () => {
    expect(gruposCambios([])).toEqual([]);
  });

  it('la marca del renglón: quitado y otra cantidad sí; agregado y sin cambio no', () => {
    expect(marcaRenglon(c('quitado'))).toBe('No va en el pedido de Kepler');
    expect(marcaRenglon(c('menos'))).toBe('El pedido de Kepler trae 1 CJA');
    expect(marcaRenglon(c('agregado'))).toBeNull();
    expect(marcaRenglon(undefined)).toBeNull();
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
