import type { TemporadaFila } from './compras.service';
import {
  accionFinPico, accionTemporada, etiquetaFreno, finPicoSucursalTitle, listaSucursales, temporadaNoRepone, temporadaTitle, temporadaTxt,
} from './pedido-freno';

/**
 * `[PQ.95]` La etiqueta del freno (plan PQ §19.3 y §19.15). Los casos salen de prod el 2026-11-25:
 * Navidad y posadas 2026 confirmada (venta 20-oct → 24-dic, remate 26-dic, se repone hasta el corte) y el
 * RICOLINO 88022 frenado por fin de pico en seis sucursales.
 */
const NAVIDAD: TemporadaFila = {
  nombre: 'Navidad y posadas', estado: 'en_venta', reposicion: 'hasta_corte', repone: true,
  desde: '2026-10-20', hasta: '2026-12-24', corte: '2026-12-24', remate: '2026-12-26',
};
const con = (cambios: Partial<TemporadaFila>): TemporadaFila => ({ ...NAVIDAD, ...cambios });

describe('[PQ.95] la etiqueta del renglón: UNA, la que manda', () => {
  it('sin freno no hay etiqueta: no decora (criterio 2)', () => {
    expect(etiquetaFreno(null, [])).toBeNull();
  });

  it('fin de pico en una sucursal la nombra; en varias, dice cuántas', () => {
    expect(etiquetaFreno(null, ['Morelia Madero'])?.txt).toBe('fin de pico · Morelia Madero');
    const varias = etiquetaFreno(null, ['Padre Hidalgo', 'La Piedad Abastos', '8 Esquinas', 'Zamora Centro', 'Morelia Madero', 'Morelia Abastos']);
    expect(varias?.txt).toBe('fin de pico · 6 sucursales');
    // El detalle sí las nombra a todas (hasta 9), para quien pasa el puntero.
    expect(varias?.title).toContain('Padre Hidalgo, La Piedad Abastos, 8 Esquinas, Zamora Centro, Morelia Madero y Morelia Abastos');
    expect(varias?.tono).toBe('neutro');
  });

  it('con la temporada en venta y que se repone, manda el fin de pico (es el que mueve el número)', () => {
    const e = etiquetaFreno(NAVIDAD, ['Canindo']);
    expect(e?.txt).toBe('fin de pico · Canindo');
    expect(e?.title).toContain('Además: Navidad y posadas');
  });

  it('cuando la temporada ya no deja reponer, manda la temporada aunque haya fin de pico', () => {
    const e = etiquetaFreno(con({ estado: 'pasado_el_corte', repone: false }), ['Canindo']);
    expect(e?.txt).toBe('Navidad y posadas · pasó el corte');
    expect(e?.tono).toBe('warn');
  });

  it('la temporada en curso sola es un aviso, con la fecha del corte', () => {
    const e = etiquetaFreno(NAVIDAD, []);
    expect(e?.txt).toBe('Navidad y posadas · se repone hasta 24-dic');
    expect(e?.tono).toBe('neutro');
  });

  it('una temporada por iniciar no frena, aunque sea compra única', () => {
    const t = con({ estado: 'por_iniciar', reposicion: 'compra_unica', repone: false });
    expect(temporadaNoRepone(t)).toBe(false);
    expect(etiquetaFreno(t, [])?.tono).toBe('neutro');
    expect(temporadaTxt(t)).toBe('Navidad y posadas · empieza 20-oct');
  });
});

describe('[PQ.95] ley 0: ninguna etiqueta afirma un freno que el número no cumple', () => {
  it.each([
    ['compra única en venta', con({ reposicion: 'compra_unica', repone: false })],
    ['pasado el corte', con({ estado: 'pasado_el_corte', repone: false })],
    ['remate', con({ estado: 'en_remate', repone: false })],
  ])('%s: dice no reponer Y que el sugerido todavía no lo frena', (_caso, t) => {
    expect(temporadaTitle(t)).toContain('el sugerido todavía no lo frena');
    expect(accionTemporada(t).por).toContain('el sugerido todavía no lo frena');
    expect(accionTemporada(t).tono).toBe('warn');
  });

  it('la que se repone dice que el sugerido no cambia (no promete un freno)', () => {
    expect(temporadaTitle(NAVIDAD)).toContain('El sugerido no cambia por la temporada.');
    expect(temporadaTitle(NAVIDAD)).not.toContain('no lo frena');
  });
});

describe('[PQ.95] «Qué hacer»: verbo + qué + por qué', () => {
  it('Navidad en venta: «Repón sólo hasta el 24-dic»', () => {
    expect(accionTemporada(NAVIDAD)).toEqual({ verbo: 'Repón', que: 'sólo hasta el 24-dic', por: '(Navidad y posadas; el remate empieza el 26-dic)', tono: 'info' });
  });

  it('remate: «Remata», con la fecha y la instrucción', () => {
    const a = accionTemporada(con({ estado: 'en_remate', repone: false }));
    expect(a.verbo).toBe('Remata');
    expect(a.por).toBe('(desde el 26-dic; el sugerido todavía no lo frena: no lo pidas)');
  });

  it('fin de pico: dónde, por nombre; sin sucursales frenadas no hay línea', () => {
    expect(accionFinPico([])).toBeNull();
    expect(accionFinPico(['Padre Hidalgo', 'Canindo'])?.que).toBe('en Padre Hidalgo y Canindo');
  });
});

describe('[PQ.95] la marca de la sucursal y las listas', () => {
  it('la cifra de la sucursal sale de la venta de 30 días por la razón del freno', () => {
    // Control: el bombón 70012 en Morelia Madero, 18.7 cajas en 30 días con razón 0.364 → ≈6.8 cajas.
    const t = finPicoSucursalTitle('Morelia Madero', 18.7, 0.364, 'cj');
    expect(t).toContain('(18.7 cj)');
    expect(t).toContain('≈6.8 cj al mes, el 36 % de la de 30 días');
  });

  it('las sucursales se enumeran en español y se resumen pasando el tope', () => {
    expect(listaSucursales(['Padre Hidalgo'])).toBe('Padre Hidalgo');
    expect(listaSucursales(['Padre Hidalgo', 'Canindo'])).toBe('Padre Hidalgo y Canindo');
    expect(listaSucursales(['Padre Hidalgo', 'Canindo', 'Yurécuaro'])).toBe('Padre Hidalgo, Canindo y Yurécuaro');
    expect(listaSucursales(['a', 'b', 'c', 'd'])).toBe('4 sucursales');
  });

  it('las fechas de calendario no se corren de día (texto, sin zona)', () => {
    // 2026-12-24 como Date a medianoche local se leería 23-dic al oeste de UTC.
    expect(temporadaTxt(NAVIDAD)).toContain('24-dic');
  });
});
