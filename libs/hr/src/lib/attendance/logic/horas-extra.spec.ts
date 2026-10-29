/**
 * `[RH.1.10]` Horas extra ganadas, desayuno/comida distintos, cambio de día de descanso y el día con
 * incidencia sin checadas (Mega Talento ee4ff38, 08/10/2026). Cada caso fija una frase de la regla
 * de RH tal como la dejó Mega Talento.
 */
import { calcularAsistencia, EXTRA_BLOQUE_MIN, type EntradaAsistencia, type FilaDia, type IncidenciaVigente } from './asistencia-persona';
import { CONFIG_DEFAULT } from './config-reglas';
import { rangoFechas } from './fechas';

/**
 * Ana: lunes a sábado 08:00–13:00 · 14:00–18:00 del jueves 02-jul al miércoles 22-jul; descansa el
 * domingo. `cambia(f)` devuelve las marcas de ese día (null = no vino) para mover un caso.
 */
function escenario(cambia: (f: string) => string[] | null | undefined = () => undefined, over: Partial<EntradaAsistencia> = {}): EntradaAsistencia {
  const filas: FilaDia[] = [];
  for (const f of rangoFechas('2026-07-02', '2026-07-22')) {
    if (new Date(`${f}T12:00:00Z`).getUTCDay() === 0) continue;
    const c = cambia(f);
    if (c === null) continue;
    filas.push({ codigo: '15', nombreReloj: 'Ana R', fecha: f, horas: c ?? ['08:00', '13:00', '14:00', '18:00'] });
  }
  return {
    siteCode: 'cedis', desde: '2026-07-16', hasta: '2026-07-22', soloPromotoras: false,
    cfg: CONFIG_DEFAULT, filas,
    silencio: new Map([['15', 0]]), unaMarca: new Map([['15', { dias: filas.length, conUna: 0 }]]),
    padron: new Map([['15', {
      userId: 'u-15', registrado: true, nombre: 'Ana', nombreCompleto: 'PRUEBA UNO', departamento: 'ALMACEN',
      puesto: 'Auxiliar', fotoUrl: null, activo: true,
    }]]),
    turnosConfirmados: new Map(), asignados: new Map(), revisiones: new Map(), incidencias: [],
    ...over,
  };
}
const ana = (e: EntradaAsistencia) => calcularAsistencia(e).personas.find((p) => p.codigo === '15');
const dia = (e: EntradaAsistencia, f: string) => ana(e)?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === f);
const inc = (tipo: string, desde: string, minutos: number | null = null, hasta = desde): IncidenciaVigente =>
  ({ id: `i-${tipo}-${desde}`, personCode: '15', tipo, desde, hasta, nota: 'prueba', minutos });

describe('[RH.1.10] horas extra ganadas', () => {
  it('se queda 45 min después de su salida: 30 (sólo bloques completos de 30)', () => {
    const e = escenario((f) => (f === '2026-07-20' ? ['08:00', '13:00', '14:00', '18:45'] : undefined));
    expect(dia(e, '2026-07-20')).toMatchObject({ salidaEsperada: '18:00', extraMin: 30 });
    expect(ana(e)?.horasExtraGanadasMin).toBe(30);
    expect(ana(e)?.horasExtraSegun).toBe('deducido');
  });

  it('1 h 10 después: 60', () => {
    const e = escenario((f) => (f === '2026-07-20' ? ['08:00', '13:00', '14:00', '19:10'] : undefined));
    expect(dia(e, '2026-07-20')?.extraMin).toBe(60);
  });

  it('⛔ llegó 40 min tarde y se fue 40 min tarde: primero repone, no hay hora extra', () => {
    const e = escenario((f) => (f === '2026-07-20' ? ['08:40', '13:00', '14:00', '18:40'] : undefined));
    expect(dia(e, '2026-07-20')?.extraMin).toBe(0);
  });

  it('se pasó 30 min de la comida (horario asignado, 60 min) y se quedó 1 h: gana 30', () => {
    const asignados = new Map([['15', { entrada: '08:00', salida: '18:00', comidaMin: 60, horarios: [{ entrada: '08:00', salida: '18:00', comidaMin: 60 }], sabado: true, sabadoEntrada: null, sabadoSalida: null }]]);
    const e = escenario((f) => (f === '2026-07-20' ? ['08:00', '13:00', '14:30', '19:00'] : undefined), { asignados } as Partial<EntradaAsistencia>);
    expect(dia(e, '2026-07-20')).toMatchObject({ comidaExcesoMin: 30, extraMin: 30 });
    expect(ana(e)?.horasExtraSegun).toBe('asignado');
  });

  it('un día se topa en 6 h (casi siempre es una checada de más)', () => {
    const asignados = new Map([['15', { entrada: '08:00', salida: '12:00', comidaMin: 0, horarios: [{ entrada: '08:00', salida: '12:00', comidaMin: 0 }], sabado: true, sabadoEntrada: null, sabadoSalida: null }]]);
    const e = escenario((f) => (f === '2026-07-20' ? ['08:00', '19:30'] : undefined), { asignados } as Partial<EntradaAsistencia>);
    expect(dia(e, '2026-07-20')?.extraMin).toBe(6 * 60);
  });

  it('⛔ medio tiempo deducido (jornada de 4 h): no se le calculan', () => {
    const e = escenario((f) => (f === '2026-07-20' ? ['08:00', '14:00'] : ['08:00', '12:00']));
    expect(ana(e)?.horasExtraSegun).toBeNull();
    expect(ana(e)?.horasExtraGanadasMin).toBe(0);
  });

  it('el uso de horas extra se cuenta en el periodo aparte de las ganadas', () => {
    const e = escenario((f) => (f === '2026-07-20' ? null : undefined), { incidencias: [inc('horas_extra', '2026-07-20', 540)] });
    expect([ana(e)?.horasExtraUsadasMin, ana(e)?.horasExtraGanadasMin]).toEqual([540, 0]);
    expect(EXTRA_BLOQUE_MIN).toBe(30);
  });
});

describe('[RH.1.10] comida y desayuno distintos', () => {
  it('con «Comida distinta» de 90 min, 90 min de comida ya no es exceso (y repone menos)', () => {
    const asignados = new Map([['15', { entrada: '08:00', salida: '18:00', comidaMin: 60, horarios: [{ entrada: '08:00', salida: '18:00', comidaMin: 60 }], sabado: true, sabadoEntrada: null, sabadoSalida: null }]]);
    const marcas = (f: string) => (f === '2026-07-20' ? ['08:00', '13:00', '14:30', '19:00'] : undefined);
    const sin = escenario(marcas, { asignados } as Partial<EntradaAsistencia>);
    const con = escenario(marcas, { asignados, incidencias: [inc('comida_distinta', '2026-07-20', 90)] } as Partial<EntradaAsistencia>);
    expect(dia(sin, '2026-07-20')).toMatchObject({ comidaExcesoMin: 30, extraMin: 30 });
    expect(dia(con, '2026-07-20')).toMatchObject({ comidaExcesoMin: 0, comidaPermitidaMin: 90, extraMin: 60 });
  });

  it('con «Desayuno distinto» el exceso de desayuno se mide contra lo autorizado', () => {
    const cfg = { ...CONFIG_DEFAULT, desayunoTopeMin: 20, reglasActivas: { ...CONFIG_DEFAULT.reglasActivas, desayuno_excedido: true } };
    const marcas = (f: string) => (f === '2026-07-20' ? ['08:00', '10:00', '10:40', '13:00', '14:00', '18:00'] : undefined);
    const sin = escenario(marcas, { cfg });
    const con = escenario(marcas, { cfg, incidencias: [inc('desayuno_distinto', '2026-07-20', 45)] });
    expect((dia(sin, '2026-07-20')?.desayunoExcesoMin ?? 0) > 0).toBe(true);
    expect(dia(con, '2026-07-20')).toMatchObject({ desayunoExcesoMin: 0, desayunoPermitidoMin: 45 });
  });
});

describe('[RH.1.10] cambio de día de descanso', () => {
  it('descansa el miércoles 22 y su domingo 19 pasa a laborable: no vino el domingo → falta', () => {
    const e = escenario((f) => (f === '2026-07-22' ? null : undefined), { incidencias: [inc('cambio_descanso', '2026-07-22')] });
    expect(dia(e, '2026-07-22')).toMatchObject({ descansoCambio: 'descansa' });
    expect(dia(e, '2026-07-19')).toMatchObject({ descansoCambio: 'trabaja', estado: 'falta' });
    expect(ana(e)?.faltas).toBe(1);
  });

  it('⛔ NEGATIVA — sin el cambio, faltar el miércoles es la falta y el domingo es descanso', () => {
    const e = escenario((f) => (f === '2026-07-22' ? null : undefined));
    expect(dia(e, '2026-07-22')?.estado).toBe('falta');
    expect(dia(e, '2026-07-19')?.estado).toBe('descanso');
  });

  it('el cambio de un periodo anterior no aparece en la lista de incidencias de la persona', () => {
    const e = escenario(undefined, { incidencias: [inc('cambio_descanso', '2026-07-10')] });
    expect(ana(e)?.incidencias).toEqual([]);
  });
});

describe('[RH.1.10] día con incidencia sin checadas en el periodo', () => {
  it('pidió sólo el jueves 23 (no checó) con uso de horas extra todo el día: aparece y cuenta', () => {
    const e = escenario(undefined, { desde: '2026-07-23', hasta: '2026-07-23', incidencias: [inc('horas_extra', '2026-07-23', 540)] });
    const p = ana(e);
    expect(p?.horasExtraUsadasMin).toBe(540);
    expect(p?.semanas.flatMap((s) => s.dias).map((d) => d.fecha)).toEqual(['2026-07-23']);
  });
});
