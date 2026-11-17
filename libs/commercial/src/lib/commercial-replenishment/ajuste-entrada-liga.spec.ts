import { candidatoDeEntrada, deOtraEntrada, ligadoAEntrada } from './ajuste-entrada-liga';

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

// `[RE.81]` El caso real del 2026-11-17: entrada 0000545 de Morelia Abastos (08, DULCES LAS
// DELICIAS). La nota 0000118 es suya; la 0000122 Kepler la liga a la entrada 0000541; la 0000090
// no trae entrada.
describe('deOtraEntrada / candidatoDeEntrada — una nota con dueño no es candidata', () => {
  const entrada0545 = { sucursal: '08', entrada_folio: '0000545' };

  it('una nota que Kepler liga a OTRA entrada de la misma sucursal no es candidata', () => {
    const nc0122 = { sucursal: '08', entrada_folio: '0000541', proveedor_interno: false };
    expect(deOtraEntrada(nc0122, entrada0545)).toBe(true);
    expect(candidatoDeEntrada(nc0122, entrada0545)).toBe(false);
  });

  it('una nota sin entrada en Kepler sigue siendo candidata', () => {
    const nc0090 = { sucursal: '08', entrada_folio: null, proveedor_interno: false };
    expect(deOtraEntrada(nc0090, entrada0545)).toBe(false);
    expect(candidatoDeEntrada(nc0090, entrada0545)).toBe(true);
  });

  it('la nota de ESTA entrada no es «de otra»', () => {
    const nc0118 = { sucursal: '08', entrada_folio: '0000545', proveedor_interno: false };
    expect(deOtraEntrada(nc0118, entrada0545)).toBe(false);
    expect(ligadoAEntrada(nc0118, entrada0545)).toBe(true);
  });

  it('sin folio de la entrada no se puede afirmar que sea de otra', () => {
    expect(deOtraEntrada({ sucursal: '08', entrada_folio: '0000541' }, { sucursal: '08' })).toBe(false);
  });
});
