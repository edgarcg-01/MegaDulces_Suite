import { describe, expect, it } from 'vitest';
import { ligadoAEntrada } from './ajuste-entrada-liga';

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
