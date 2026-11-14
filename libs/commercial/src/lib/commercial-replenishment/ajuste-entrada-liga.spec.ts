import { candidatoDeEntrada, ligadoAEntrada } from './ajuste-entrada-liga';

// `[RE.70]` El caso real del 2026-11-13: la entrada 0000421 de Morelia Abastos (08, MERENGUE LA
// MORENITA) recibía como «exacto» la devolución 0000003 de 8 Esquinas (03, PIÑATAS TOÑO), que
// apunta a la entrada 0000421 DE 8 ESQUINAS.
describe('ligadoAEntrada — la llave es (sucursal, entrada_folio)', () => {
  const devolucionDe8Esquinas = { sucursal: '03', entrada_folio: '0000421' };

  it('el mismo folio en OTRA sucursal no es la misma entrada', () => {
    expect(ligadoAEntrada(devolucionDe8Esquinas, { sucursal: '08', entrada_folio: '0000421' })).toBe(false);
  });

  it('misma sucursal y mismo folio sí es la entrada', () => {
    expect(ligadoAEntrada(devolucionDe8Esquinas, { sucursal: '03', entrada_folio: '0000421' })).toBe(true);
  });

  it('sin sucursal no se afirma la liga (el folio solo no identifica)', () => {
    expect(ligadoAEntrada(devolucionDe8Esquinas, { sucursal: null, entrada_folio: '0000421' })).toBe(false);
    expect(ligadoAEntrada(devolucionDe8Esquinas, { entrada_folio: '0000421' })).toBe(false);
  });

  it('un ajuste sin entrada ligada nunca es exacto', () => {
    expect(ligadoAEntrada({ sucursal: '03', entrada_folio: null }, { sucursal: '03', entrada_folio: '0000421' })).toBe(false);
  });
});

// `[RE.71]` El candidato por proveedor + fecha: misma sucursal y proveedor real.
describe('candidatoDeEntrada — sin ajustes de otra sucursal ni traspasos', () => {
  const entradaMoreliaAbastos = { sucursal: '08' };

  it('un ajuste de OTRA sucursal no es candidato', () => {
    expect(candidatoDeEntrada({ sucursal: '03', proveedor_interno: false }, entradaMoreliaAbastos)).toBe(false);
  });

  it('un ajuste de la misma sucursal y proveedor real sí es candidato', () => {
    expect(candidatoDeEntrada({ sucursal: '08', proveedor_interno: false }, entradaMoreliaAbastos)).toBe(true);
  });

  it('una nota a CEDIS u otra sucursal (proveedor interno) no es candidato, aunque sea de la misma sucursal', () => {
    expect(candidatoDeEntrada({ sucursal: '08', proveedor_interno: true }, entradaMoreliaAbastos)).toBe(false);
  });

  it('sin sucursal de la entrada no se descarta por sucursal (contrato viejo)', () => {
    expect(candidatoDeEntrada({ sucursal: '03', proveedor_interno: false }, {})).toBe(true);
  });
});
