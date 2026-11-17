import type { WarehouseLocationRow } from '@megadulces/contracts';
import { cartelesDe, estadoDeRack, zonaConUbicaciones } from './almacen-ubicaciones-mapa.component';

const nivel = (p: Partial<WarehouseLocationRow>): WarehouseLocationRow => ({
  id: 'x', warehouse_id: 'w', warehouse_code: '01', code: 'BA051', label: null, familia: 'ubicacion',
  zona: 'B', pasillo: 'A', rack: 5, nivel: 1, tipo: null, estado: 'activa', motivo_estado: null,
  pick_sequence: 1, renglones_con_cantidad: 0, updated_at: '2026-10-08T00:00:00.000Z', ...p,
});

/**
 * `[UB.1]` El color de un rack en el mapa es el estado MÁS URGENTE de sus niveles. Si un nivel
 * bloqueado se escondiera detrás de dos niveles sanos, el mapa diría "todo bien" sobre un rack que
 * no se puede usar.
 */
describe('[UB.1] mapa · estado de un rack', () => {
  it('sin niveles = sin dar de alta (no se dibuja como activo)', () => {
    expect(estadoDeRack([])).toBe('vacio');
  });

  it('un solo nivel bloqueado manda sobre los demás', () => {
    expect(estadoDeRack([nivel({}), nivel({ renglones_con_cantidad: 3 }), nivel({ estado: 'bloqueada', motivo_estado: 'x' })])).toBe('bloqueada');
  });

  it('con mercancía gana a sólo activo', () => {
    expect(estadoDeRack([nivel({}), nivel({ renglones_con_cantidad: 1 })])).toBe('contenido');
  });

  it('la mercancía de un nivel dado de baja no cuenta como contenido vivo', () => {
    expect(estadoDeRack([nivel({ estado: 'baja', motivo_estado: 'x', renglones_con_cantidad: 2 })])).toBe('baja');
  });

  it('todo dado de alta y vacío = activo', () => {
    expect(estadoDeRack([nivel({}), nivel({ nivel: 2 })])).toBe('activa');
  });
});

/** `[UB.RF.5]` CEDIS abría en «Bodega (0)» con sus 375 en Tienda (medido 2026-11-17). */
describe('[UB.RF.5] mapa · zona en la que abre', () => {
  it('⭐ si la elegida está vacía y la otra no, abre en la otra', () => {
    expect(zonaConUbicaciones('B', 0, 375)).toBe('T');
    expect(zonaConUbicaciones('T', 12, 0)).toBe('B');
  });
  it('NEGATIVA: con ubicaciones en la elegida, no se mueve (aunque la otra tenga más)', () => {
    expect(zonaConUbicaciones('B', 1, 375)).toBe('B');
  });
  it('NEGATIVA: un almacén sin ninguna, se queda donde está', () => {
    expect(zonaConUbicaciones('B', 0, 0)).toBe('B');
  });
});

/** `[UB.RF.10]` Carteles: uno, un rack, un pasillo o toda la zona; sin los dados de baja y en orden de recorrido. */
describe('[UB.RF.10] mapa · carteles a imprimir', () => {
  const ubs = [
    nivel({ code: 'BB012', pasillo: 'B', rack: 1, nivel: 2 }),
    nivel({ code: 'BA051', pasillo: 'A', rack: 5, nivel: 1 }),
    nivel({ code: 'BA011', pasillo: 'A', rack: 1, nivel: 1 }),
    nivel({ code: 'BA052', pasillo: 'A', rack: 5, nivel: 2, estado: 'baja', motivo_estado: 'x' }),
    nivel({ code: 'TA011', zona: 'T', pasillo: 'A', rack: 1, nivel: 1 }),
  ];
  it('⭐ toda la zona, en orden de recorrido y sin los dados de baja', () => {
    expect(cartelesDe(ubs, { zona: 'B' }, '01').map((c) => c.code)).toEqual(['BA011', 'BA051', 'BB012']);
  });
  it('un pasillo, un rack y uno solo', () => {
    expect(cartelesDe(ubs, { zona: 'B', pasillo: 'A' }, '01').map((c) => c.code)).toEqual(['BA011', 'BA051']);
    expect(cartelesDe(ubs, { zona: 'B', pasillo: 'A', rack: 5 }, '01').map((c) => c.code)).toEqual(['BA051']);
    expect(cartelesDe(ubs, { zona: 'B', code: 'BB012' }, '01')).toEqual([{ code: 'BB012', label: 'Bodega · nivel 2', almacen: '01' }]);
  });
  it('NEGATIVA: la zona de tienda no se cuela en los de bodega (y viceversa)', () => {
    expect(cartelesDe(ubs, { zona: 'T' }, '01').map((c) => c.code)).toEqual(['TA011']);
  });
});
