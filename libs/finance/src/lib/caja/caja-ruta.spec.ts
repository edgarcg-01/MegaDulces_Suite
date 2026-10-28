import { codigosDeSucursalBuscada, rutaBuscada, rutaDelDocumento } from './caja-ruta';

describe('[CGA-A.59] la ruta del documento que guarda el libro', () => {
  it('una ruta: su número', () => {
    expect(rutaDelDocumento('ruta_501')).toBe('501');
    expect(rutaDelDocumento('ruta_21')).toBe('21');
  });
  it('NEGATIVA: dos rutas distintas en un mismo documento no eligen una — null', () => {
    expect(rutaDelDocumento('ruta_501 · ruta_502')).toBeNull();
  });
  it('la misma ruta repetida sigue siendo una', () => {
    expect(rutaDelDocumento('ruta_501 · ruta_501')).toBe('501');
  });
  it('NEGATIVA: sin ruta (documento de caja de Kepler) — null', () => {
    expect(rutaDelDocumento(null)).toBeNull();
    expect(rutaDelDocumento('CONTADO')).toBeNull();
  });
});

describe('[CGA-A.59] el buscador reconoce una ruta', () => {
  it.each([['501', '501'], ['R501', '501'], ['r 501', '501'], ['ruta 501', '501'], ['Ruta_21', '21'], [' 0504 ', '504']])(
    '«%s» → %s', (t, r) => expect(rutaBuscada(t)).toBe(r));
  it('NEGATIVA: un folio, un nombre o un importe con decimales no son ruta', () => {
    expect(rutaBuscada('CI-2026-00019')).toBeNull();
    expect(rutaBuscada('canindo')).toBeNull();
    expect(rutaBuscada('17668.70')).toBeNull();
    expect(rutaBuscada('')).toBeNull();
  });
});

describe('[CGA-A.59] el buscador reconoce una sucursal por su nombre', () => {
  it('«canindo» → el servidor 06; sin acentos ni mayúsculas', () => {
    expect(codigosDeSucursalBuscada('canindo')).toEqual(['06']);
    expect(codigosDeSucursalBuscada('YURECUARO')).toEqual(['04']);
    expect(codigosDeSucursalBuscada('padre hidalgo')).toEqual(['01']);
  });
  it('«morelia» trae las dos sucursales de Morelia', () => {
    expect(codigosDeSucursalBuscada('morelia').sort()).toEqual(['07', '08']);
  });
  it('NEGATIVA: menos de 4 letras o un número no buscan sucursal', () => {
    expect(codigosDeSucursalBuscada('can')).toEqual([]);
    expect(codigosDeSucursalBuscada('0601')).toEqual([]);
    expect(codigosDeSucursalBuscada('gasolina')).toEqual([]);
  });
});
