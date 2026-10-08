import type { WarehouseLocationRow } from '@megadulces/contracts';
import { estadoDeRack } from './almacen-ubicaciones-mapa.component';

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
