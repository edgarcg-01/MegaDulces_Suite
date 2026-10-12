import {
  DIAS_ATORADO, agruparPorProveedor, diasDesde, textoAntiguedad, ubicacionDe,
} from './mis-gastos-columnas';

/**
 * `[GX.65.5]` — La regla de **en qué columna va cada vale** de «Mis gastos», decidida por el
 * usuario el 2026-10-03 y probada en la simulación por caminos A (sin prefactura) y B (con).
 */
describe('[GX.65.5] ubicacionDe', () => {
  it.each([
    [{ etapa: 'asignado', status: null }, 'solicitudes', 'pendiente'],
    [{ status: 'rechazada' }, 'solicitudes', 'pendiente'],
    [{ status: 'recibida' }, 'solicitudes', 'espera'],
    [{ status: 'aprobada' }, 'comprobacion', 'pendiente'],
    [{ status: 'revision' }, 'comprobacion', 'espera'],
    [{ status: 'validada' }, 'expedientes', 'pendiente'],
  ])('%o → %s / %s', (fila, columna, zona) => {
    expect(ubicacionDe(fila)).toEqual({ columna, zona });
  });

  /** Camino A: «Revisado» sin prefactura cierra el vale y salta DIRECTO a Expedientes. */
  it('camino A: el validado nunca pasa por la columna 2', () => {
    expect(ubicacionDe({ status: 'validada' })?.columna).toBe('expedientes');
  });

  /** ⛔ El XA1001 de Kepler NO mueve el vale: un validado ejercido sigue en Expedientes. */
  it('⛔ la etapa de Kepler no decide la columna', () => {
    expect(ubicacionDe({ status: 'validada', etapa: 'ejercido' })?.columna).toBe('expedientes');
    expect(ubicacionDe({ status: 'recibida', etapa: 'autorizado' })?.columna).toBe('solicitudes');
  });

  /** ⛔ Prueba NEGATIVA: un estado desconocido NO cae callado en ninguna columna. */
  it('⛔ un estado que no conoce devuelve null', () => {
    expect(ubicacionDe({ status: 'inventado' })).toBeNull();
    expect(ubicacionDe({})).toBeNull();
  });
});

describe('[GX.65.5] antigüedad de un pendiente', () => {
  const hoy = new Date(2026, 9, 3); // 3-oct-2026

  it('cuenta días enteros en hora local', () => {
    expect(diasDesde('2026-10-03', hoy)).toBe(0);
    expect(diasDesde('2026-10-02', hoy)).toBe(1);
    expect(diasDesde('2026-08-30T15:00:00.000Z', hoy)).toBe(34);
  });

  it('una fecha futura (Kepler la trae, hasta 31-dic) no da negativo', () => {
    expect(diasDesde('2026-12-31', hoy)).toBe(0);
  });

  it('sin fecha legible no inventa nada', () => {
    expect(diasDesde(null, hoy)).toBeNull();
    expect(diasDesde('no-es-fecha', hoy)).toBeNull();
    expect(textoAntiguedad(null)).toBe('');
  });

  it('el texto se lee como una persona lo diría', () => {
    expect(textoAntiguedad(0)).toBe('hoy');
    expect(textoAntiguedad(1)).toBe('hace 1 día');
    expect(textoAntiguedad(34)).toBe('hace 34 días');
  });

  it('se marca atorado pasando los 30 días', () => {
    expect(DIAS_ATORADO).toBe(30);
  });
});

describe('[GX.65.5] agruparPorProveedor', () => {
  const f = (clave: string | null, nombre: string | null, importe: number, titulo = 'tecleado') =>
    ({ proveedor_clave: clave, proveedor_nombre: nombre, importe, titulo });

  it('agrupa por la CLAVE de Kepler y suma el total', () => {
    const g = agruparPorProveedor([f('GS0044', 'ACEROS', 100), f('GS0044', 'ACEROS', 50), f('GF0007', 'GASOLINERA', 10)]);
    expect(g.map((x) => [x.clave, x.filas.length, x.total])).toEqual([['GS0044', 2, 150], ['GF0007', 1, 10]]);
  });

  /** ⛔ Sin clave NO se agrupa por el nombre tecleado (367 variantes para 337 claves). */
  it('⛔ sin clave van a UN solo grupo, al final, y lo dice', () => {
    const g = agruparPorProveedor([f(null, null, 5, 'Aceros'), f('GS0044', 'ACEROS', 1), f(null, null, 7, 'ACEROS SA')]);
    expect(g[g.length - 1].clave).toBeNull();
    expect(g[g.length - 1].etiqueta).toBe('Sin clave de proveedor en Kepler');
    expect(g[g.length - 1].filas).toHaveLength(2);
  });

  it('con clave pero sin nombre (el local no trae el catálogo) muestra la clave y lo declara', () => {
    const [g] = agruparPorProveedor([f('GG015', null, 1)]);
    expect(g.clave).toBe('GG015');
    expect(g.etiqueta).toBe('nombre no disponible en Kepler');
  });

  it('lista vacía, grupos vacíos', () => {
    expect(agruparPorProveedor([])).toEqual([]);
  });
});
