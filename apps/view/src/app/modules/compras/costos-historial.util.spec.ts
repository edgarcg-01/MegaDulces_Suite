import { RespuestaHistorial } from './costo-estandar.service';
import { FiltrosHistorial, eventosTrazabilidad, graficaHistorial } from './costos-historial.util';

const base = (over: Partial<RespuestaHistorial['entradas'][number]>) => ({
  fecha: '2026-09-01',
  sucursal_registro: '01',
  plaza: '01',
  folio: 'XA2001-1',
  proveedor: 'Proveedor A',
  unidad: 'CJA',
  cantidad: 1,
  costo: 1436.8,
  factor: 20,
  costo_base: 71.84,
  cambio: false,
  cambio_pct: 0,
  estandar_vigente: 71.84,
  vs_estandar_pct: 0,
  veredicto: 'apegada' as const,
  motivo: null,
  plaza_sin_kepler: null,
  ...over,
});

const R: RespuestaHistorial = {
  sku: '70001',
  nombre: 'CHOCOLATE',
  proveedor: 'Proveedor A',
  desde: '2025-10-01',
  hasta: '2026-09-30',
  sucursales: [{ codigo: '01', nombre: 'PH' }, { codigo: '03', nombre: '8 ESQ' }],
  estandar_hoy: [{ sucursal: '01', costo: 71.84, unidad: 'PZA' }, { sucursal: '03', costo: 69.9, unidad: 'PZA' }],
  estandar_al_inicio: { '01': 66.8, '03': 66.8 },
  cambios_estandar: [
    { sucursal: '01', fecha: '2026-03-03', antes: 66.8, despues: 69.9, cambio_pct: 4.64 },
    { sucursal: '03', fecha: '2026-03-04', antes: 66.8, despues: 69.9, cambio_pct: 4.64 },
    { sucursal: '01', fecha: '2026-06-14', antes: 69.9, despues: 71.84, cambio_pct: 2.78 },
  ],
  entradas: [
    base({ fecha: '2026-02-25', folio: 'A', antes: undefined, cambio: true, costo_base: 69, cambio_pct: null }),
    base({ fecha: '2026-06-10', folio: 'B', antes: 69, cambio: true, costo_base: 71.84, cambio_pct: 4.12 }),
    base({ fecha: '2026-07-01', folio: 'C', antes: 71.84, cambio: false, costo_base: 71.84 }),
    base({ fecha: '2026-07-04', folio: 'D', plaza: '03', antes: undefined, cambio: true, proveedor: 'Proveedor J', costo_base: 72 }),
    base({ fecha: '2026-08-01', folio: 'E', plaza: null, antes: undefined, cambio: true, costo_base: 70, veredicto: 'no_comparable', motivo: 'sin_plaza', plaza_sin_kepler: 'MORELIA ABASTOS' }),
  ],
};

const F: FiltrosHistorial = { sucursal: null, proveedor: null, tipo: 'ambos', incluirSinCambio: false };

describe('[CAT-COSTO.5] eventosTrazabilidad', () => {
  it('mezcla las dos historias, lo más reciente arriba, y esconde las entradas sin cambio', () => {
    const ev = eventosTrazabilidad(R, F);
    expect(ev.map((e) => e.documento)).toEqual([
      'E',
      'D',
      'Ficha de Kepler',
      'B',
      'Ficha de Kepler',
      'Ficha de Kepler',
      'A',
    ]);
    expect(ev.find((e) => e.documento === 'C')).toBeUndefined();
  });

  it('con la casilla, también salen las entradas sin cambio', () => {
    const ev = eventosTrazabilidad(R, { ...F, incluirSinCambio: true });
    expect(ev.find((e) => e.documento === 'C')?.tipo).toBe('entrada_igual');
  });

  it('filtra por sucursal en las dos historias', () => {
    const ev = eventosTrazabilidad(R, { ...F, sucursal: '03' });
    expect(ev.map((e) => e.sucursal)).toEqual(['03', '03']);
  });

  it('el filtro de proveedor no esconde los cambios de estándar (no tienen proveedor)', () => {
    const ev = eventosTrazabilidad(R, { ...F, proveedor: 'Proveedor J' });
    expect(ev.filter((e) => e.tipo === 'estandar')).toHaveLength(3);
    expect(ev.filter((e) => e.tipo !== 'estandar').map((e) => e.documento)).toEqual(['D']);
  });

  it('por tipo: sólo estándar o sólo entrada', () => {
    expect(eventosTrazabilidad(R, { ...F, tipo: 'estandar' }).every((e) => e.tipo === 'estandar')).toBe(true);
    expect(eventosTrazabilidad(R, { ...F, tipo: 'entrada' }).some((e) => e.tipo === 'estandar')).toBe(false);
  });

  it('la primera entrada de una plaza se rotula como primera, y lo no comparable lleva su motivo con la plaza', () => {
    const ev = eventosTrazabilidad(R, F);
    expect(ev.find((e) => e.documento === 'A')?.tipo).toBe('primera');
    expect(ev.find((e) => e.documento === 'E')?.motivo).toBe('no se sabe qué plaza recibió (MORELIA ABASTOS)');
  });
});

describe('[CAT-COSTO.5] graficaHistorial', () => {
  it('dibuja los escalones del estándar de la sucursal elegida', () => {
    const g = graficaHistorial(R, F);
    expect(g.sucursalLinea).toBe('01');
    // inicio + 2 cambios × 2 puntos + cierre = 6 puntos
    expect(g.linea.split(' ')).toHaveLength(6);
    expect(g.lineaPlana).toBe(false);
  });

  it('[negativa] sin cambios en el periodo la línea es plana y se declara', () => {
    const g = graficaHistorial({ ...R, cambios_estandar: [] }, F);
    expect(g.lineaPlana).toBe(true);
    expect(g.linea.split(' ')).toHaveLength(2);
  });

  it('cada entrada con costo es un punto, filtrado igual que la tabla', () => {
    expect(graficaHistorial(R, F).puntos).toHaveLength(5);
    expect(graficaHistorial(R, { ...F, sucursal: '03' }).puntos).toHaveLength(1);
  });
});
