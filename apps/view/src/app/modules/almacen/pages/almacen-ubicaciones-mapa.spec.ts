import { FIXTURE_KINDS, nombrePieza, type WarehouseLocationRow } from '@megadulces/contracts';
import { ariaDeRack, armarPasillos, cartelesDe, elAlmacenQueSiTieneTrabajo, estadoDeRack, formatoPorZona, productosDeRack, zonaConUbicaciones } from './almacen-ubicaciones-mapa.component';

const nivel = (p: Partial<WarehouseLocationRow>): WarehouseLocationRow => ({
  id: 'x', warehouse_id: 'w', warehouse_code: '01', code: 'BA051', label: null, familia: 'ubicacion',
  zona: 'B', pasillo: 'A', rack: 5, nivel: 1, tipo: null, estado: 'activa', motivo_estado: null,
  pick_sequence: 1, renglones_con_cantidad: 0, renglones_totales: 0, productos_asignados: 0, updated_at: '2026-10-08T00:00:00.000Z', ...p,
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

/**
 * `[UB.RF.17]` El número del cuadro es **productos con lugar**, no niveles dados de alta.
 *
 * Medido el 2026-11-25: los 75 racks de CEDIS tenían los mismos 5 niveles y los 39 de Padre Hidalgo los
 * mismos 4 — el mapa pintaba 75 y 39 cuadros idénticos. Lo que sí variaba (2 racks de PH con producto
 * asignado, de 39) no se veía por ningún lado.
 */
describe('[UB.RF.17] mapa · el número que se pinta', () => {
  it('⭐ suma los productos asignados de los niveles del rack', () => {
    expect(productosDeRack([nivel({ productos_asignados: 2 }), nivel({ nivel: 2, productos_asignados: 3 })])).toBe(5);
  });

  it('⭐ NEGATIVA: un lugar en un nivel dado de baja no es un lugar', () => {
    expect(productosDeRack([nivel({ estado: 'baja', motivo_estado: 'x', productos_asignados: 7 })])).toBe(0);
  });

  it('un rack dado de alta sin productos no pinta número', () => {
    expect(productosDeRack([nivel({}), nivel({ nivel: 2 })])).toBe(0);
  });

  it('⭐ lo que oye quien no ve el cuadro dice frente, estado, niveles y productos (el color no porta nada solo)', () => {
    expect(ariaDeRack('A', 5, 'activa', 4, 3)).toBe('Rack A05, frente de nones, dada de alta, 4 niveles, 3 productos asignados');
    expect(ariaDeRack('B', 1, 'activa', 1, 1)).toBe('Rack B01, frente de nones, dada de alta, 1 nivel, 1 producto asignado');
    expect(ariaDeRack('C', 12, 'bloqueada', 2, 0)).toBe('Rack C12, frente de pares, con un nivel bloqueado, 2 niveles, sin productos asignados');
  });

  it('NEGATIVA: un rack sin dar de alta no habla de niveles ni de productos que no tiene', () => {
    expect(ariaDeRack('A', 9, 'vacio', 0, 0)).toBe('Rack A09, frente de nones, sin dar de alta');
  });
});

/**
 * `[UB.RF.18]` **Un pasillo es un corredor con dos frentes enfrentados** (Edgar, 2026-11-25). El mapa
 * los dibuja como tales: los nones de un lado, los pares del otro, con el corredor en medio. El frente
 * se deduce del número de rack, no se captura.
 */
describe('[UB.RF.18] mapa · los dos frentes del pasillo', () => {
  const pasilloDe = (racks: number[], pasillo = 'A') =>
    racks.map((rack) => nivel({ code: `T${pasillo}${String(rack).padStart(2, '0')}1`, zona: 'T', pasillo, rack, nivel: 1 }));

  it('⭐ un pasillo de 6 racks sale en dos frentes de 3, apareados por columna', () => {
    const [p] = armarPasillos(pasilloDe([1, 2, 3, 4, 5, 6]), 'T');
    expect(p.columnas).toBe(3);
    expect(p.nones.celdas.map((c) => c.rack)).toEqual([1, 3, 5]);
    expect(p.pares.celdas.map((c) => c.rack)).toEqual([2, 4, 6]);
  });

  it('⭐ la columna k son los racks 2k-1 y 2k: el 05 queda EXACTAMENTE enfrente del 06', () => {
    const [p] = armarPasillos(pasilloDe([1, 2, 3, 4, 5, 6]), 'T');
    const col = 2; // tercera columna
    expect(p.nones.celdas[col].rack).toBe(5);
    expect(p.pares.celdas[col].rack).toBe(6);
  });

  it('⭐ cada pasillo usa SÓLO sus columnas: uno de 6 racks no arrastra las de uno de 25', () => {
    const ps = armarPasillos([...pasilloDe([1, 2, 3, 4, 5, 6], 'A'), ...pasilloDe([1, 2], 'B')], 'T');
    expect(ps.map((p) => [p.pasillo, p.columnas])).toEqual([['A', 3], ['B', 1]]);
  });

  it('un rack que falta en medio sale como hueco, no corre a los demás', () => {
    const [p] = armarPasillos(pasilloDe([1, 2, 5, 6]), 'T');
    expect(p.nones.celdas.map((c) => c.estado)).toEqual(['activa', 'vacio', 'activa']);
    expect(p.nones.celdas.map((c) => c.rack)).toEqual([1, 3, 5]);
  });

  it('⭐ los frentes se numeran en el orden en que se recorren: las flechas cruzan el corredor y siguen', () => {
    const ps = armarPasillos([...pasilloDe([1, 2], 'A'), ...pasilloDe([1, 2], 'B')], 'T');
    expect(ps.flatMap((p) => [p.nones, p.pares]).map((f) => [f.pasillo, f.cara, f.fi])).toEqual([
      ['A', 'nones', 0], ['A', 'pares', 1], ['B', 'nones', 2], ['B', 'pares', 3],
    ]);
  });

  it('⛔ NEGATIVA: un pasillo con un solo frente no inventa racks del otro lado', () => {
    const [p] = armarPasillos(pasilloDe([1, 3, 5]), 'T');
    expect(p.nones.celdas.map((c) => c.estado)).toEqual(['activa', 'activa', 'activa']);
    expect(p.pares.celdas.every((c) => c.estado === 'vacio')).toBe(true);
  });

  it('NEGATIVA: la zona que no se mira no entra al mapa', () => {
    expect(armarPasillos(pasilloDe([1, 2]), 'B')).toEqual([]);
  });
});

/**
 * `[UB.RF.19]` «Los productos no se están almacenando ni mostrando» (Edgar, 2026-11-25). Sí se estaban
 * almacenando: dos a las 13:54 y 13:55 en TA011 de Padre Hidalgo, sin un solo error. Lo que pasaba es
 * que quien no tiene almacén en su ficha abre en el primero por código —CEDIS, 375 ubicaciones y **0
 * productos**— y lee «no hay nada» sobre el almacén equivocado. A las 13:56 intentó dar de alta TA011.
 */
describe('[UB.RF.19] mapa · el almacén que sí tiene trabajo', () => {
  const cedis = { id: 'c', name: 'CEDIS', con_producto: 0 };
  const ph = { id: 'p', name: 'Padre Hidalgo', con_producto: 23 };
  const zamora = { id: 'z', name: 'Zamora Centro', con_producto: 0 };

  it('⭐ parado en un almacén sin productos, ofrece el que sí los tiene, por su NOMBRE', () => {
    expect(elAlmacenQueSiTieneTrabajo([cedis, ph, zamora], 'c')).toEqual(ph);
  });

  it('⭐ NEGATIVA: si el almacén de aquí ya tiene productos, no ofrece nada (no estorba a quien trabaja)', () => {
    expect(elAlmacenQueSiTieneTrabajo([cedis, ph], 'p')).toBeNull();
  });

  it('NEGATIVA: si ningún otro tiene productos, no inventa una salida', () => {
    expect(elAlmacenQueSiTieneTrabajo([cedis, zamora], 'c')).toBeNull();
  });

  it('entre varios con productos, ofrece el que más tiene', () => {
    const otro = { id: 'o', name: 'La Piedad Abastos', con_producto: 5 };
    expect(elAlmacenQueSiTieneTrabajo([cedis, otro, ph], 'c')).toEqual(ph);
  });

  it('NEGATIVA: sin almacén abierto todavía, no se ofrece nada', () => {
    expect(elAlmacenQueSiTieneTrabajo([cedis, ph], null)).toBeNull();
  });
});

/**
 * `[UB.PL]` El croquis: el mapa dibuja **la tienda**, no una rejilla. Lo que esto cierra, medido el
 * 2026-11-26: 60 de 315 ubicaciones de Padre Hidalgo eran cabeceras dadas de alta como «pasillos D a
 * H», y el mapa las dibujaba como pasillos porque los datos decían eso.
 */
describe('[UB.PL] mapa · cómo se dibuja cada pieza', () => {
  it('⭐ un anaquel de pasillo lleva corredor: tiene dos frentes', () => {
    expect(FIXTURE_KINDS.anaquel.dosFrentes).toBe(true);
  });

  it('⛔ NEGATIVA: una CABECERA no lleva corredor — es de una cara, y dibujarle dos es dibujar algo que no existe', () => {
    expect(FIXTURE_KINDS.cabecera.dosFrentes).toBe(false);
  });

  it('una caja no genera códigos, así que en el croquis va sin racks', () => {
    expect(FIXTURE_KINDS.caja.generaCodigos).toBe(false);
  });

  it('⭐ cada pieza se nombra en palabras de la tienda, y su nombre propio manda', () => {
    expect(nombrePieza({ tipo: 'cabecera', pasillo: 'D', label: null })).toBe('Cabecera D');
    expect(nombrePieza({ tipo: 'caja', pasillo: null, label: 'Caja 3' })).toBe('Caja 3');
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

describe('[UB.RF.12] mapa · qué se imprime por omisión', () => {
  it('⭐ en tienda, la etiqueta chica (un cartel grande le quita vista al producto); en bodega, el cartel', () => {
    expect(formatoPorZona('T')).toBe('etiqueta');
    expect(formatoPorZona('B')).toBe('cartel');
  });
});
