import type { GuiaRepartoFiltro, GuiaRepartoViaje } from '@megadulces/contracts';
import { aYmd, titularBusqueda, titularViajes, vacioDeBusqueda, vacioDeViajes } from './logistica-guia-reparto.component';

const TODOS: GuiaRepartoFiltro = { por_chofer: false, chofer_nombre: null, motivo: null };
const CHOFER: GuiaRepartoFiltro = { por_chofer: true, chofer_nombre: 'JUAN P.', motivo: null };

/** `[EMB.56]` Lo primero que lee el chofer: cuántos viajes hay ese día y dónde, por NOMBRE. */
const viaje = (sucursal: string, guia: string): GuiaRepartoViaje => ({
  sucursal, guia, guia_digital: `${sucursal}-G${guia}`, fecha: '2026-07-23', paradas: 12,
  unidad_descripcion: 'FORD 450', unidad_placas: '774H6V', destinos_texto: 'PENJAMILLO', asignado_por: null,
});

describe('[EMB.56] titularViajes', () => {
  it('hoy, una sucursal: la nombra, no la numera', () => {
    expect(titularViajes({ fecha: '2026-07-23', rows: [viaje('01', '0000969'), viaje('01', '0000968')], filtro: TODOS }, '2026-07-23'))
      .toBe('Viajes de hoy en Padre Hidalgo.');
  });

  it('otro día, varias sucursales', () => {
    expect(titularViajes({ fecha: '2026-07-22', rows: [viaje('01', '1'), viaje('06', '2')], filtro: TODOS }, '2026-07-23'))
      .toBe('Viajes del 22/07/2026 en 2 sucursales.');
  });

  it('sin viajes lo dice', () => {
    expect(titularViajes({ fecha: '2026-07-23', rows: [], filtro: TODOS }, '2026-07-23')).toBe('Hoy no hay viajes de Kepler en tus sucursales.');
  });
});

describe('[EMB.56] el chofer ve sólo SUS viajes, y si no ve nada sabe por qué', () => {
  it('con viajes: le habla a él', () => {
    expect(titularViajes({ fecha: '2026-07-23', rows: [viaje('06', '0001660')], filtro: CHOFER }, '2026-07-23'))
      .toBe('Hoy tienes 1 viaje, JUAN P.');
  });

  it('sin viajes ese día: no dice «no hay viajes» (sí los hay, de otros)', () => {
    const d = { fecha: '2026-07-23', rows: [], filtro: CHOFER };
    expect(titularViajes(d, '2026-07-23')).toBe('Hoy no tienes viajes asignados.');
    expect(vacioDeViajes(d).titulo).toBe('No tienes viajes este día');
  });

  it('sin ficha ligada: lo dice y manda a la pantalla y el campo donde se liga', () => {
    const d = { fecha: '2026-07-23', rows: [], filtro: { ...CHOFER, chofer_nombre: null, motivo: 'sin_ficha_de_chofer' as const } };
    expect(titularViajes(d, '2026-07-23')).toBe('No podemos mostrarte tus viajes todavía.');
    expect(vacioDeViajes(d).pista).toContain('«Cuenta del sistema»');
  });

  it('⛔ sin clave de Kepler NO manda a una pantalla que no la captura', () => {
    const d = { fecha: '2026-07-23', rows: [], filtro: { ...CHOFER, motivo: 'sin_clave_kepler' as const } };
    expect(vacioDeViajes(d).pista).not.toContain('Flotilla');
  });
});

describe('[EMB.56] reimprimir por número de guía', () => {
  const b = (rows: GuiaRepartoViaje[], filtro: GuiaRepartoFiltro = TODOS) => ({ guia: '0000969', rows, filtro });

  it('el número es por sucursal: la 969 de Padre Hidalgo y la de CEDIS se muestran para escoger', () => {
    expect(titularBusqueda(b([viaje('01', '0000969'), viaje('00', '0000969')])))
      .toBe('La guía 969 existe en 2 viajes: cada sucursal lleva su propia numeración. Escoge la tuya.');
    expect(titularBusqueda(b([viaje('01', '0000969')]))).toBe('Guía 969.');
  });

  it('no encontrada: al chofer le dice por qué puede ser (sólo ve las suyas)', () => {
    expect(titularBusqueda(b([]))).toBe('No encontramos la guía 969.');
    expect(vacioDeBusqueda(b([], CHOFER)).pista).toContain('Sólo ves tus guías');
    expect(vacioDeBusqueda(b([])).pista).toContain('Sólo se buscan las guías de tus sucursales');
  });

  it('sin ficha de chofer, la búsqueda dice lo mismo que la lista', () => {
    const sinFicha = { ...CHOFER, chofer_nombre: null, motivo: 'sin_ficha_de_chofer' as const };
    expect(vacioDeBusqueda(b([], sinFicha)).titulo).toBe('Tu usuario no está ligado a tu ficha de chofer');
  });
});

describe('[EMB.56] aYmd', () => {
  it('toma la fecha LOCAL del selector, sin correrla por UTC', () => {
    expect(aYmd(new Date(2026, 6, 23, 23, 59))).toBe('2026-07-23');
    expect(aYmd(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});
