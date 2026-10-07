import {
  MIN_VALID_DATE,
  clockDriftSeconds,
  deviceUsers,
  lastDateByCode,
  latestLocal,
  normalizePunches,
  normalizeSource,
} from './ingest-batch';

describe('normalizePunches', () => {
  it('acepta la fecha con T o con espacio y la deja como hora de pared con espacio', () => {
    const { rows, rejected } = normalizePunches([
      { codigo: '15', fechaHora: '2026-10-06T08:17:03', tipo: 0 },
      { codigo: '16', fechaHora: '2026-10-06 08:20:00', tipo: 1 },
    ]);
    expect(rejected).toBe(0);
    expect(rows.map((r) => r.local)).toEqual(['2026-10-06 08:17:03', '2026-10-06 08:20:00']);
    expect(rows[0]).toMatchObject({ code: '15', date: '2026-10-06', punchType: 0, verifyMode: null });
  });

  it('rechaza código vacío, formato distinto y fechas del año 2000 (reloj sin hora)', () => {
    const { rows, rejected } = normalizePunches([
      { codigo: '', fechaHora: '2026-10-06T08:00:00' },
      { codigo: '15', fechaHora: '06/10/2026 08:00' },
      { codigo: '15', fechaHora: '2000-01-01T00:00:00' },
      { codigo: '15', fechaHora: '2026-10-06T08:00:00Z' },
    ]);
    expect(rows).toHaveLength(0);
    expect(rejected).toBe(4);
    expect(MIN_VALID_DATE).toBe('2001-01-01');
  });

  it('descarta la misma checada repetida dentro del lote', () => {
    const { rows, rejected } = normalizePunches([
      { codigo: '15', fechaHora: '2026-10-06T08:00:00' },
      { codigo: '15', fechaHora: '2026-10-06 08:00:00' },
      { codigo: '16', fechaHora: '2026-10-06T08:00:00' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rejected).toBe(1);
  });

  it('sólo guarda tipo y verificación cuando son enteros', () => {
    const { rows } = normalizePunches([
      { codigo: '15', fechaHora: '2026-10-06T08:00:00', tipo: '0' as unknown as number, verificacion: 1 },
    ]);
    expect(rows[0].punchType).toBeNull();
    expect(rows[0].verifyMode).toBe(1);
  });

  it('un lote que no es arreglo no revienta', () => {
    expect(normalizePunches(null)).toEqual({ rows: [], rejected: 0 });
  });
});

describe('normalizeSource', () => {
  it('push y manual se respetan; lo demás es el agente', () => {
    expect(normalizeSource('push')).toBe('push');
    expect(normalizeSource('manual')).toBe('manual');
    expect(normalizeSource('carga_unica')).toBe('agente');
    expect(normalizeSource(undefined)).toBe('agente');
  });
});

describe('clockDriftSeconds', () => {
  const now = new Date('2026-10-06T14:00:00Z');
  it('positivo si el reloj va adelantado', () => {
    expect(clockDriftSeconds('2026-10-06T14:03:00Z', now)).toBe(180);
  });
  it('null sin hora válida (no se inventa un cero)', () => {
    expect(clockDriftSeconds('', now)).toBeNull();
    expect(clockDriftSeconds('no es fecha', now)).toBeNull();
    expect(clockDriftSeconds(undefined, now)).toBeNull();
  });
});

describe('deviceUsers', () => {
  it('nombre vacío queda como «Empleado <código>» y los códigos vacíos se ignoran', () => {
    const m = deviceUsers([{ codigo: '15', nombre: 'Ana' }, { codigo: '16', nombre: '  ' }, { codigo: '', nombre: 'X' }]);
    expect([...m.entries()]).toEqual([['15', 'Ana'], ['16', 'Empleado 16']]);
  });
});

describe('lastDateByCode y latestLocal', () => {
  it('toman la fecha y la hora más recientes del lote', () => {
    const { rows } = normalizePunches([
      { codigo: '15', fechaHora: '2026-10-05T08:00:00' },
      { codigo: '15', fechaHora: '2026-10-06T07:59:00' },
      { codigo: '16', fechaHora: '2026-10-06T09:00:00' },
    ]);
    expect(lastDateByCode(rows).get('15')).toBe('2026-10-06');
    expect(latestLocal(rows)).toBe('2026-10-06 09:00:00');
    expect(latestLocal([])).toBeNull();
  });
});
