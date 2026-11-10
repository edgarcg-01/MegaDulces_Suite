import { SUCURSAL_DE_CENTRO_COMPRA_OFICINAS, warehouseName } from '@megadulces/contracts';
import { cargosDeCrudos } from './caja-reposicion.query';

/**
 * `[LE.6.25]` Lo que oficinas pagó a cuenta de una sucursal: el centro «COMPRA PROVEEDOR …» del catálogo
 * de la `00` dice a qué sucursal se carga. Los nombres son los de `kepler_ods.kdxv` de la `00` (prod, sólo
 * lectura, 2026-11-09): si el mapa manda un centro a otra plaza, el nombre de Kepler lo contradice aquí.
 */
// Nombre en Kepler (cortado a 30 caracteres) → la plaza que nombra, leída a mano del catálogo.
const CATALOGO_00: Record<string, [string, string]> = {
  'C-002': ['COMPRA PROVEEDOR PADRE HIDALGO', 'Padre Hidalgo'], 'C-003': ['COMPRA PROVEEDOR 8ESQUINAS', '8 Esquinas'],
  'C-004': ['COMPRA PROVEEDOR LA PIEDAD ABS', 'La Piedad Abastos'], 'C-005': ['COMPRA PROVEEDOR YURECUARO', 'Yurécuaro'],
  'C-010': ['COMPRA PROVEEDOR MORELIA ABAST', 'Morelia Abastos'], 'C-011': ['COMPRA PROVEEDOR MORELIA MADER', 'Morelia Madero'],
  'C-020': ['COMPRA PROVEEDOR ZAMORA CANIND', 'Canindo'], 'C-021': ['COMPRA PORVEEDOR ZAMORA CENTRO', 'Zamora Centro'],
};

describe('[LE.6.25] el centro de compra de oficinas → la sucursal a la que se carga', () => {
  it('cada centro del catálogo de la 00 va a la plaza que su nombre en Kepler dice, y ninguno falta', () => {
    expect(Object.keys(SUCURSAL_DE_CENTRO_COMPRA_OFICINAS).sort()).toEqual(Object.keys(CATALOGO_00).sort());
    for (const [centro, [, plaza]] of Object.entries(CATALOGO_00)) {
      expect(warehouseName(SUCURSAL_DE_CENTRO_COMPRA_OFICINAS[centro]), centro).toBe(plaza);
    }
  });

  it('C-001 (CEDIS misma) no está: no es «a cuenta de otra sucursal»', () => {
    expect(SUCURSAL_DE_CENTRO_COMPRA_OFICINAS['C-001']).toBeUndefined();
  });

  it('el pago real del 29/10: C-010 → Morelia Abastos, con el importe convertido una vez', () => {
    const [c] = cargosDeCrudos([{ origen_ref: '00|X-D-26|0023691|0011', folio: '0023691', fecha_valor: '2026-10-29',
      beneficiario: 'PROVEEDOR DE PRUEBA', importe: '117905.32', centro: 'C-010', centro_nombre: 'COMPRA PROVEEDOR MORELIA ABAST',
      referencia: 'COMPRA 6267' }]);
    expect(c).toMatchObject({ sucursal: '08', importe: 117905.32 });
    expect(warehouseName(c.sucursal)).toBe('Morelia Abastos');
  });

  it('NEGATIVA: un centro que el mapa no conoce sale sin sucursal, nunca adivinada', () => {
    const [c] = cargosDeCrudos([{ origen_ref: '00|X-D-26|1|0011', folio: '1', fecha_valor: '2026-10-29', beneficiario: null,
      importe: 1, centro: 'C-099', centro_nombre: null, referencia: null }]);
    expect(c.sucursal).toBeNull();
  });
});
