import { classifyReceivingOrigin } from './receiving-origin';

describe('classifyReceivingOrigin — proveedor externo vs traspaso interno', () => {
  it('los códigos C### son proveedor externo', () => {
    expect(classifyReceivingOrigin('CD015', 'DISTRIBUIDORA DE LA ROSA SA DE CV')).toMatchObject({
      kind: 'supplier',
      isCedis: false,
      label: 'Proveedor',
    });
    expect(classifyReceivingOrigin('CC030').kind).toBe('supplier');
  });

  it('TI000 es el CEDIS: el ERP lo nombra así explícitamente', () => {
    const o = classifyReceivingOrigin('TI000', 'CENTRO DE DISTRIBUCIÓN ( CEDIS)');
    expect(o.kind).toBe('transfer');
    expect(o.isCedis).toBe(true);
    expect(o.label).toBe('CEDIS');
  });

  it('TI001..TI008 son traspaso de otra sucursal, no CEDIS', () => {
    const o = classifyReceivingOrigin('TI001', 'SUCURSAL PADRE HIDALGO');
    expect(o.kind).toBe('transfer');
    expect(o.isCedis).toBe(false);
    expect(o.label).toBe('Traspaso');
  });

  it('conserva el nombre del documento y NO deduce la sucursal', () => {
    // TI005 sale con dos nombres distintos en el ERP; se muestra el del documento.
    expect(classifyReceivingOrigin('TI005', 'SUCURSAL ZAMORA CANINDO').name).toBe('SUCURSAL ZAMORA CANINDO');
    expect(classifyReceivingOrigin('TI005', 'SUCURSAL ABASTOS LP').name).toBe('SUCURSAL ABASTOS LP');
  });

  it('sin código cae en proveedor: es el caso mayoritario y no cambia lo que ya se ve', () => {
    expect(classifyReceivingOrigin(null).kind).toBe('supplier');
    expect(classifyReceivingOrigin('').kind).toBe('supplier');
    expect(classifyReceivingOrigin(undefined).name).toBeNull();
  });

  it('no confunde un proveedor que empiece con T pero no sea TI+dígito', () => {
    expect(classifyReceivingOrigin('TOLEDO01').kind).toBe('supplier');
    expect(classifyReceivingOrigin('TIENDA').kind).toBe('supplier');
  });

  it('tolera minúsculas y espacios del ERP', () => {
    expect(classifyReceivingOrigin('  ti001  ').kind).toBe('transfer');
  });
});
