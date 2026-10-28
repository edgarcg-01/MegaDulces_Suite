import { compactarHistorial, type PriceHistoryRow } from './price-history.contract';

const f = (sucursal: string, fecha: string, hora: string | null, unidad: string | null, ant: number | null, nvo: number | null): PriceHistoryRow => ({
  sucursal, fecha, hora, unidad, precio_anterior: ant, precio_nuevo: nvo,
  delta: ant == null || nvo == null ? null : Math.round((nvo - ant) * 100) / 100, es_baja: nvo === 0,
});

describe('[ETQ-HISTORIAL.1.1] compactarHistorial', () => {
  it('⭐ el caso real del 92013: el mismo cambio reescrito muchas veces es UN tramo', () => {
    const filas = [
      f('06', '2026-10-27', '07:41:59.08', 'CJA', 1152.44, 1152.45),
      f('06', '2026-10-27', '07:42:00.07', 'CJA', 1152.44, 1152.45),
      f('06', '2026-10-28', '06:33:08.41', 'CJA', 1152.44, 1152.45),
      f('06', '2026-10-28', '08:07:48.56', 'CJA', 1152.44, 1152.45),
    ];
    const r = compactarHistorial(filas);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ desde: '2026-10-27', hasta: '2026-10-28', precio: 1152.45, precio_anterior: 1152.44, veces: 4 });
  });

  it('⛔ NEGATIVA — A→B→A son TRES tramos: fundirlos globalmente perdería que el precio volvió', () => {
    const r = compactarHistorial([
      f('06', '2026-09-01', '10:00:00.00', 'PZA', 10, 12),
      f('06', '2026-09-01', '10:00:05.00', 'PZA', 10, 12),
      f('06', '2026-10-01', '09:00:00.00', 'PZA', 12, 10),
    ]);
    expect(r.map((t) => t.precio)).toEqual([10, 12]);
    // con la historia previa a 10→12 (el precio original) el ciclo completo se ve así:
    const r2 = compactarHistorial([
      f('06', '2026-08-01', '09:00:00.00', 'PZA', 8, 10),
      f('06', '2026-09-01', '10:00:00.00', 'PZA', 10, 12),
      f('06', '2026-10-01', '09:00:00.00', 'PZA', 12, 10),
    ]);
    expect(r2.map((t) => t.precio)).toEqual([10, 12, 10]);
  });

  it('del tramo más reciente al más viejo, por plaza y presentación', () => {
    const r = compactarHistorial([
      f('08', '2026-01-01', '10:00:00.00', 'CJA', 1, 2),
      f('02', '2026-01-02', '10:00:00.00', 'PAQ', 5, 6),
      f('02', '2026-01-01', '10:00:00.00', 'CJA', 1, 3),
      f('02', '2026-02-01', '10:00:00.00', 'CJA', 3, 4),
    ]);
    expect(r.map((t) => `${t.sucursal}${t.unidad}${t.precio}`)).toEqual(['02CJA4', '02CJA3', '02PAQ6', '08CJA2']);
  });

  it('las presentaciones de una misma plaza NO se mezclan', () => {
    const r = compactarHistorial([
      f('06', '2026-01-01', '10:00:00.00', 'CJA', 100, 101),
      f('06', '2026-01-01', '10:00:01.00', 'PAQ', 10, 11),
      f('06', '2026-01-02', '10:00:00.00', 'CJA', 100, 101),
    ]);
    expect(r).toHaveLength(2);
    expect(r.find((t) => t.unidad === 'CJA')?.veces).toBe(2);
  });

  it('el precio 0 conserva su bandera (Kepler le quitó el precio) y no se funde con un precio real', () => {
    const r = compactarHistorial([f('02', '2026-10-20', '10:00:00.00', 'PZA', 45.5, 0), f('02', '2026-10-21', '10:00:00.00', 'PZA', 0, 46)]);
    expect(r[1]).toMatchObject({ precio: 0, es_baja: true });
    expect(r[0]).toMatchObject({ precio: 46, es_baja: false });
  });

  it('una fila sin precio nuevo no se funde con nadie: no se sabe qué precio dejó', () => {
    expect(compactarHistorial([f('06', '2026-01-01', null, 'PZA', 1, null), f('06', '2026-01-02', null, 'PZA', 1, null)])).toHaveLength(2);
  });

  it('presentación vacía queda vacía (no se inventa «PZA») y sin filas devuelve lista vacía', () => {
    expect(compactarHistorial([f('06', '2026-01-01', null, null, 1, 2)])[0].unidad).toBeNull();
    expect(compactarHistorial([])).toEqual([]);
  });

  it('no muta la entrada y respeta el orden de llegada cuando falta la hora', () => {
    const entrada = [f('06', '2026-01-01', null, 'PZA', 1, 2), f('06', '2026-01-01', null, 'PZA', 2, 3)];
    const copia = JSON.stringify(entrada);
    const r = compactarHistorial(entrada);
    expect(JSON.stringify(entrada)).toBe(copia);
    expect(r.map((t) => t.precio)).toEqual([3, 2]);
  });
});
