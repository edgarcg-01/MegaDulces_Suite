import { armarCajasDelDia, elegirTurno, ligarConteos, llaveTurno, minutos, GRACIA_MIN, type TurnoHorario } from './arqueo-cajas';

/**
 * [SM.48] A qué turno de Kepler pertenece cada conteo, por caja + hora.
 * Los horarios son los reales de prod (26-oct-2026).
 */
const t = (folio: string, caja: string, a: string, c: string | null): TurnoHorario =>
  ({ folio, caja, hora_apertura: a, hora_cierre: c });

// Morelia Abastos, caja 3: dos turnos el mismo día.
const T29 = t('29', '3', '06:39:00', '12:34:00');
const T30 = t('30', '3', '15:04:00', '18:48:00');

describe('minutos', () => {
  it('lee HH:MM, HH:MM:SS y la fracción que manda Kepler en c11', () => {
    expect(minutos('06:39')).toBe(399);
    expect(minutos('12:46:00.51')).toBe(766);
    expect(minutos('')).toBeNull();
    expect(minutos(null)).toBeNull();
  });
});

describe('elegirTurno', () => {
  it('⭐ un retiro va al turno ABIERTO en esa caja a esa hora', () => {
    expect(elegirTurno([T29, T30], 'retiro', '10:15:00')?.folio).toBe('29');
    expect(elegirTurno([T29, T30], 'retiro', '16:00:00')?.folio).toBe('30');
  });

  it('un retiro capturado poco después del corte va al turno que acaba de cerrar', () => {
    expect(elegirTurno([T29, T30], 'retiro', '12:50:00')?.folio).toBe('29');
  });

  it('⭐ el cierre contado DESPUÉS del corte va al turno que cerró, aunque ya haya otro abierto', () => {
    // 15:10: T30 ya está abierto, pero el cajón que se cuenta es el de T29.
    expect(elegirTurno([T29, T30], 'cierre', '15:10:00')?.folio).toBe('29');
    // NEGATIVA de la regla: para un retiro a esa misma hora manda el abierto.
    expect(elegirTurno([T29, T30], 'retiro', '15:10:00')?.folio).toBe('30');
  });

  it('un cierre con la caja todavía abierta (sin corte previo) va al abierto', () => {
    expect(elegirTurno([t('71', '1', '06:15:00', null)], 'cierre', '17:48:00')?.folio).toBe('71');
  });

  it('fuera de todo horario y de la gracia → ninguno (no se pega al «más parecido»)', () => {
    expect(elegirTurno([T29], 'retiro', '05:00:00')).toBeNull();
    const tarde = minutos('12:34:00')! + GRACIA_MIN + 5;
    const hh = String(Math.floor(tarde / 60)).padStart(2, '0') + ':' + String(Math.round(tarde % 60)).padStart(2, '0');
    expect(elegirTurno([T29], 'cierre', hh)).toBeNull();
  });

  it('⭐ NEGATIVA: dos turnos abiertos a la vez en la misma caja = ambiguo, no se elige', () => {
    const a = t('1', '2', '08:00:00', null);
    const b = t('2', '2', '09:00:00', null);
    expect(elegirTurno([a, b], 'retiro', '10:00:00')).toBeNull();
  });

  it('sin hora o sin candidatos → null', () => {
    expect(elegirTurno([T29], 'retiro', null)).toBeNull();
    expect(elegirTurno([], 'retiro', '10:00')).toBeNull();
  });
});

describe('ligarConteos', () => {
  // El folio 30 existe en la caja 2 y en la caja 3 de la misma sucursal (prod, 08, 26-oct).
  const C2 = t('30', '2', '13:44:00', '15:25:00');
  const turnos = [T29, T30, C2];
  const conteo = (id: string, tipo: string, caja: string, hora: string, folio: string | null = null) =>
    ({ id, tipo, caja, hora, cash_cut_folio: folio });

  it('⭐ la llave del turno es caja + folio: el folio 30 de la caja 2 no se mezcla con el de la caja 3', () => {
    const { porTurno } = ligarConteos(turnos, [conteo('a', 'retiro', '2', '14:00:00', '30'), conteo('b', 'retiro', '3', '16:00:00', '30')]);
    expect(porTurno.get(llaveTurno(C2))!.map((x) => x.id)).toEqual(['a']);
    expect(porTurno.get(llaveTurno(T30))!.map((x) => x.id)).toEqual(['b']);
  });

  it('con folio manda el folio; sin folio, caja + hora — y dice cómo se ligó', () => {
    const { porTurno } = ligarConteos(turnos, [conteo('a', 'retiro', '3', '16:00:00', '29'), conteo('b', 'retiro', '3', '10:00:00')]);
    const t29 = porTurno.get(llaveTurno(T29))!;
    expect(t29.map((x) => [x.id, x.ligado])).toEqual([['a', 'folio'], ['b', 'hora']]);
  });

  it('lo que no cae en ningún turno vuelve en sinTurno (se muestra aparte)', () => {
    const { sinTurno, porTurno } = ligarConteos(turnos, [conteo('x', 'retiro', '9', '10:00:00')]);
    expect(sinTurno.map((x) => x.id)).toEqual(['x']);
    expect([...porTurno.values()].flat()).toEqual([]);
  });
});

describe('armarCajasDelDia', () => {
  // Canindo (06), caja 1, turno 70 del 26-oct-2026: datos reales de prod.
  const turno70 = {
    warehouse_code: '06', warehouse_name: 'Canindo', caja: '1', folio: '70', cajero_code: '50C01', cajero_nombre: 'DULCE MARIA',
    hora_apertura: '06:15:00', hora_cierre: '17:22:00', abierto: false,
    efectivo_esperado: '73131.88', efectivo_retirado: '68280', arqueo_billetes: null, arqueo_monedas: null,
  };
  const conteo = (id: string, tipo: string, hora: string, total: number, extra: Record<string, unknown> = {}) => ({
    id, tipo, secuencia: 1, warehouse_code: '06', caja: '1', cash_cut_folio: null, hora, total: String(total),
    usuario: 'DULCE', usuario_nombre: null, denominations: '{"500":18}', captured_at: '2026-10-26T18:00:00Z', ...extra,
  });
  const conteos = [
    conteo('r1', 'retiro', '11:45:00', 18800), conteo('r2', 'retiro', '13:51:00', 18100),
    conteo('r3', 'retiro', '15:04:00', 17000), conteo('r4', 'retiro', '16:59:00', 13000),
    conteo('c1', 'cierre', '17:30:00', 4852),
    conteo('v1', 'rv', '16:39:00', 24173, { caja: 'RV', route_code: '5V001' }),
  ];

  it('⭐ los retiros que faltan se DICEN: $66,900 contados de $68,280 → faltan $1,380', () => {
    const r = armarCajasDelDia('2026-10-26', [turno70], conteos);
    const t = r.sucursales[0].turnos[0];
    expect(t.retiros.map((x) => x.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(t.retiros.every((x) => x.ligado === 'hora')).toBe(true);
    expect(t.retiros_contados).toBe(66900);
    expect(t.retiros_estado).toBe('faltan');
    expect(t.retiros_diferencia).toBe(-1380);
  });

  it('⭐ el cuadre usa la identidad única: los retiros sin contar se aceptan de Kepler, MARCADOS', () => {
    const t = armarCajasDelDia('2026-10-26', [turno70], conteos).sucursales[0].turnos[0];
    expect(t.cuadre.retiros_sin_verificar).toBe(1380);
    expect(t.cuadre.medible).toBe(true);
    // 73131.88 − (4852 + 66900 + 1380) = −0.12
    expect(t.cuadre.diferencia).toBe(-0.12);
  });

  it('las rutas NO entran a ninguna caja ni cuadre: van a sin_caja', () => {
    const s = armarCajasDelDia('2026-10-26', [turno70], conteos).sucursales[0];
    expect(s.sin_caja.map((x) => x.id)).toEqual(['v1']);
    expect(s.turnos[0].retiros.some((x) => x.id === 'v1')).toBe(false);
  });

  it('sin cajón contado el cuadre NO se publica como cero: se declara no medible', () => {
    const t = armarCajasDelDia('2026-10-26', [turno70], conteos.filter((c) => c.tipo !== 'cierre')).sucursales[0].turnos[0];
    expect(t.cuadre.medible).toBe(false);
    expect(t.cuadre.diferencia).toBeNull();
    expect(t.cuadre.motivo).toBe('sin_conteo');
  });

  it('un conteo de una caja sin turno ese día va a sin_turno, no se pega a otro', () => {
    const s = armarCajasDelDia('2026-10-26', [turno70], [conteo('x', 'retiro', '10:00:00', 500, { caja: '9' })]).sucursales[0];
    expect(s.sin_turno.map((x) => x.id)).toEqual(['x']);
  });

  it('las piezas viajan como objeto aunque la base las mande como texto', () => {
    const t = armarCajasDelDia('2026-10-26', [turno70], conteos).sucursales[0].turnos[0];
    expect(t.retiros[0].denominations).toEqual({ 500: 18 });
  });
});
