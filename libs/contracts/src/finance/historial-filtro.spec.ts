import {
  FILTRO_HISTORIAL_VACIO, filtroHistorialActivo, filtroHistorialAParams, leerFiltroHistorial, pasaFiltroHistorial,
  type FiltroHistorial,
} from './historial-filtro.contract';

/**
 * `[GX.78]` Candado de los filtros del Historial. La regla la leen el servidor (calendario) y la
 * pantalla (lista del día): si se rompe acá, las dos cifras dejan de cuadrar.
 */
describe('[GX.78] leerFiltroHistorial', () => {
  it('sin parámetros no filtra nada', () => {
    expect(leerFiltroHistorial({})).toEqual({ ok: true, filtro: FILTRO_HISTORIAL_VACIO });
    expect(leerFiltroHistorial(null)).toEqual({ ok: true, filtro: FILTRO_HISTORIAL_VACIO });
  });

  it('lee estados separados por coma, sin repetir y en el orden del trámite', () => {
    const r = leerFiltroHistorial({ estado: 'validada, recibida,recibida' });
    expect(r).toEqual({ ok: true, filtro: { estados: ['recibida', 'validada'], sucursal: null, persona: null } });
  });

  it('lee sucursal y persona, recortando espacios', () => {
    const r = leerFiltroHistorial({ sucursal: ' 08 ', persona: '  capturista_a ' });
    expect(r).toEqual({ ok: true, filtro: { estados: [], sucursal: '08', persona: 'capturista_a' } });
  });

  /** ⛔ Un estado mal escrito NO puede caer a «sin filtro»: devolvería el mes entero. */
  it('⛔ un estado desconocido es error, no «todos»', () => {
    const r = leerFiltroHistorial({ estado: 'recibida,firmada' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('firmada');
  });

  it('⛔ una sucursal que no es de dos dígitos es error', () => {
    expect(leerFiltroHistorial({ sucursal: 'CEDIS' }).ok).toBe(false);
    expect(leerFiltroHistorial({ sucursal: '0' }).ok).toBe(false);
  });

  it('⛔ una persona absurdamente larga es error', () => {
    expect(leerFiltroHistorial({ persona: 'x'.repeat(161) }).ok).toBe(false);
  });
});

describe('[GX.78] pasaFiltroHistorial', () => {
  const fila = { status: 'recibida', sucursal: '00', created_by: 'capturista_a' };
  const f = (o: Partial<FiltroHistorial>): FiltroHistorial => ({ ...FILTRO_HISTORIAL_VACIO, ...o });

  it('sin filtro pasa todo', () => {
    expect(pasaFiltroHistorial(fila, FILTRO_HISTORIAL_VACIO)).toBe(true);
    expect(pasaFiltroHistorial(fila, null)).toBe(true);
  });

  it('cada dimensión filtra por igualdad exacta', () => {
    expect(pasaFiltroHistorial(fila, f({ estados: ['recibida', 'aprobada'] }))).toBe(true);
    expect(pasaFiltroHistorial(fila, f({ estados: ['validada'] }))).toBe(false);
    expect(pasaFiltroHistorial(fila, f({ sucursal: '00' }))).toBe(true);
    expect(pasaFiltroHistorial(fila, f({ sucursal: '08' }))).toBe(false);
    expect(pasaFiltroHistorial(fila, f({ persona: 'capturista_a' }))).toBe(true);
    expect(pasaFiltroHistorial(fila, f({ persona: 'capturista' }))).toBe(false);
  });

  it('las dimensiones se combinan con Y', () => {
    expect(pasaFiltroHistorial(fila, f({ estados: ['recibida'], sucursal: '08' }))).toBe(false);
    expect(pasaFiltroHistorial(fila, f({ estados: ['recibida'], sucursal: '00', persona: 'capturista_a' }))).toBe(true);
  });

  it('un levantamiento sin sucursal no pasa un filtro de sucursal', () => {
    expect(pasaFiltroHistorial({ status: 'recibida', sucursal: null }, f({ sucursal: '00' }))).toBe(false);
  });
});

describe('[GX.78] filtroHistorialActivo y filtroHistorialAParams', () => {
  it('vacío no está activo y no manda parámetros', () => {
    expect(filtroHistorialActivo(FILTRO_HISTORIAL_VACIO)).toBe(false);
    expect(filtroHistorialAParams(FILTRO_HISTORIAL_VACIO)).toEqual({});
  });

  it('ida y vuelta: lo que se manda se vuelve a leer igual', () => {
    const filtro: FiltroHistorial = { estados: ['aprobada', 'rechazada'], sucursal: '06', persona: 'link: capturista_c' };
    expect(filtroHistorialActivo(filtro)).toBe(true);
    expect(leerFiltroHistorial(filtroHistorialAParams(filtro))).toEqual({ ok: true, filtro });
  });
});
