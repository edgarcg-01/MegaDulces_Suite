/**
 * `[RH.1.5]` El candado del horario deducido.
 *
 * Los casos son los de `mega-talento-90/api/tools/probar-horario.ts`. Esa prueba está en ROJO
 * desde el 18/08/2026 (medido el 2026-10-07: 6 fallas) porque nadie la actualizó tras dos
 * cambios de regla de RH. Aquí cada número que cambió dice POR QUÉ cambió:
 *
 *   · 18/08/2026 — la semana de nómina pasó de MIÉRCOLES a JUEVES (como el ReporteSemMD.rpt).
 *   · 26/09/2026 — una ausencia puede ser el descanso de la semana (`descansosDeLaSemana`).
 *
 * Ninguno de los seis es un defecto de la regla: es la prueba la que se quedó atrás.
 */
import * as h from './horario-deducido';

const dia = (fecha: string, entrada: string, salida = '18:00'): h.DiaCrudo => ({ fecha, marcas: [entrada, salida] });

describe('bloques de 30 min: los dos criterios', () => {
  it('costumbre se sesga al bloque temprano; cercano gana la cercanía', () => {
    expect(h.aHora(h.bloqueDeCostumbre(h.aMinutos('07:25')))).toBe('07:00');
    expect(h.aHora(h.bloqueMasCercano(h.aMinutos('07:25')))).toBe('07:30');
    expect(h.aHora(h.bloqueMasCercano(h.aMinutos('07:10')))).toBe('07:00');
  });
  it('06:13 va a 06:00 (Zamora Canindo real) y 23:50 no se desborda', () => {
    expect(h.aHora(h.bloqueMasCercano(h.aMinutos('06:13')))).toBe('06:00');
    expect(h.aHora(h.bloqueMasCercano(h.aMinutos('23:50')))).toBe('00:00');
  });
});

describe('la semana de nómina abre en JUEVES (18/08/2026)', () => {
  // La prueba de Mega Talento todavía esperaba miércoles: 4 de sus 6 fallas son éstas.
  it('jueves abre su propia semana; el miércoles siguiente la cierra', () => {
    expect(h.inicioSemana('2026-07-02')).toBe('2026-07-02');   // jueves
    expect(h.inicioSemana('2026-07-08')).toBe('2026-07-02');   // miércoles: misma semana
    expect(h.inicioSemana('2026-07-09')).toBe('2026-07-09');   // jueves: otra semana
  });
  it('el miércoles 01-jul pertenece a la semana del jueves 25-jun (antes abría la suya)', () => {
    expect(h.inicioSemana('2026-07-01')).toBe('2026-06-25');
    expect(h.inicioSemana('2026-07-05')).toBe('2026-07-02');   // domingo
  });
  it('el corte viejo sigue disponible como opción, para reproducir números de antes del 18/08', () => {
    expect(h.inicioSemana('2026-07-07', 3)).toBe('2026-07-01');
  });
});

describe('deducir el horario de la persona, no del sitio', () => {
  const casiOcho = [
    dia('2026-07-01', '07:52'), dia('2026-07-02', '08:07'), dia('2026-07-03', '07:55'),
    dia('2026-07-04', '08:04'), dia('2026-07-06', '07:58'), dia('2026-07-07', '08:02'),
  ];
  it('entrada 08:00, salida 18:00, confiable, con los 6 días', () => {
    const ded = h.deducirHorario(casiOcho);
    expect([ded.entrada, ded.salida, ded.confiable, ded.diasUsados]).toEqual(['08:00', '18:00', true, 6]);
  });
  it('mediana, no promedio: un día a las 13:30 no mueve el horario', () => {
    expect(h.deducirHorario([
      dia('2026-07-01', '08:02'), dia('2026-07-02', '08:03'), dia('2026-07-03', '07:58'),
      dia('2026-07-04', '08:01'), dia('2026-07-06', '08:00'), dia('2026-07-07', '13:30'),
    ]).entrada).toBe('08:00');
  });
});

describe('días de UNA sola marca y lecturas duplicadas', () => {
  it('una marca = marca_faltante (no se sabe si es entrada o salida); cero = sin_marca', () => {
    const una = h.clasificarDia({ fecha: '2026-07-02', marcas: ['08:05'] });
    expect([una.tipo, una.entrada]).toEqual(['marca_faltante', null]);
    expect(h.clasificarDia({ fecha: '2026-07-02', marcas: [] }).tipo).toBe('sin_marca');
  });
  it('turno partido: entrada = primera, salida = última', () => {
    const p = h.clasificarDia({ fecha: '2026-07-01', marcas: ['08:03', '14:00', '15:30', '19:02'] });
    expect([h.aHora(p.entrada), h.aHora(p.salida)]).toEqual(['08:03', '19:02']);
  });
  it('dos lecturas a 3 min son UNA marca, y la salida no es la segunda lectura', () => {
    const doble = h.clasificarDia({ fecha: '2026-07-01', marcas: ['08:00', '08:03'] });
    expect([doble.tipo, doble.marcas]).toEqual(['marca_faltante', 1]);
    const j = h.clasificarDia({ fecha: '2026-07-01', marcas: ['08:00', '08:02', '18:00', '18:01'] });
    expect([j.tipo, j.marcas, h.aHora(j.salida)]).toEqual(['completo', 2, '18:00']);
  });
});

describe('bolsa semanal: sólo cuenta el EXCEDENTE', () => {
  it('atraso 7+21+2 = 30 → 30 − 15 de bolsa = 15', () => {
    // Pasa con los dos cortes: el miércoles 01 llega a tiempo, así que da igual en qué semana caiga.
    const junto = h.analizarPersona([
      dia('2026-07-01', '07:52'), dia('2026-07-02', '08:07'), dia('2026-07-03', '08:21'),
      dia('2026-07-04', '07:58'), dia('2026-07-06', '08:02'), dia('2026-07-07', '08:00'),
    ]);
    expect(junto.horario.entrada).toBe('08:00');
    expect(junto.retardos?.atrasoMin).toBe(30);
    expect(junto.retardos?.retardoRealMin).toBe(15);
  });
  it('no devuelve retardos si no pudo deducir el horario', () => {
    expect(h.analizarPersona([dia('2026-07-01', '08:00')]).retardos).toBeNull();
  });
});

describe('el caso de Morelia: 09:22 todos los días', () => {
  // La razón de que exista el horario CONFIRMADO: quien entra 09:22 con horario 09:00 y quien
  // tiene 09:30 y llega antes producen exactamente las mismas checadas.
  const morelia = [
    dia('2026-07-01', '09:22'), dia('2026-07-02', '09:24'), dia('2026-07-03', '09:20'),
    dia('2026-07-06', '09:23'), dia('2026-07-07', '09:21'), dia('2026-07-08', '09:22'),
    dia('2026-07-09', '09:25'), dia('2026-07-10', '09:19'),
  ];
  it('la deducción se declara AMBIGUA y elige el más cercano (09:30)', () => {
    const d = h.deducirHorario(morelia);
    expect([d.bloqueAmbiguo, d.entrada]).toEqual([true, '09:30']);
  });
  it('confirmado en 09:30 su retardo es 0, y deja de ser ambiguo', () => {
    const r = h.analizarPersona(morelia, { bloqueConocido: '09:30' });
    expect(r.retardos?.retardoRealMin).toBe(0);
    expect([r.horario.bloqueConfirmado, r.horario.bloqueAmbiguo]).toEqual([true, false]);
  });
  it('confirmado en 09:00: 131 min con la semana de JUEVES (antes 146)', () => {
    // 176 min de atraso. Con corte de jueves caen en TRES semanas (01 | 02-08 | 09-10) y cada una
    // absorbe 15: 7 + 95 + 29 = 131. Con el corte viejo de miércoles eran DOS semanas: 95 + 51.
    expect(h.analizarPersona(morelia, { bloqueConocido: '09:00' }).retardos?.retardoRealMin).toBe(131);
    expect(h.analizarPersona(morelia, { bloqueConocido: '09:00', diaInicioSemana: 3 }).retardos?.retardoRealMin).toBe(146);
  });
  it('el impacto que se le muestra a RH es el mismo número que se aplica', () => {
    expect(h.impactoDeOpcion(morelia, '09:00').retardoRealMin)
      .toBe(h.analizarPersona(morelia, { bloqueConocido: '09:00' }).retardos?.retardoRealMin);
  });
});

describe('un fijo NO se mide por cercanía día con día', () => {
  const impuntual = [
    dia('2026-07-01', '07:35'), dia('2026-07-02', '07:33'), dia('2026-07-03', '07:38'),
    dia('2026-07-06', '07:31'), dia('2026-07-07', '07:36'),
  ];
  it('contra 07:00 el atraso bruto es la suma completa y el retardo real es el excedente', () => {
    const r = h.analizarPersona(impuntual, { bloqueConocido: '07:00' }).retardos;
    expect(r?.atrasoMin).toBe(35 + 33 + 38 + 31 + 36);
    expect(r?.retardoRealMin).toBe((r?.atrasoMin ?? 0) - 15 * (r?.semanas.length ?? 0));
  });
});

describe('rotativo: dos turnos, cada día contra el suyo', () => {
  const rot = [
    dia('2026-07-01', '07:22'), dia('2026-07-02', '07:20'), dia('2026-07-03', '07:25'),
    dia('2026-07-06', '15:02'), dia('2026-07-07', '15:01'), dia('2026-07-08', '14:58'),
    dia('2026-07-09', '07:23'), dia('2026-07-10', '15:00'),
  ];
  it('detecta dos turnos y es rotativo', () => {
    const d = h.deducirHorario(rot);
    expect([d.turnos.length, d.tipo]).toEqual([2, 'rotativo']);
  });
  it('con la mañana a las 07:00 hay retardo; con 07:30 no', () => {
    const turnos = h.deducirHorario(rot).turnos.filter((t): t is string => !!t);
    expect(h.impactoDeOpcion(rot, '07:00', { base: turnos, original: '07:30' }).retardoRealMin ?? 0).toBeGreaterThan(0);
    expect(h.impactoDeOpcion(rot, '07:30', { base: turnos, original: '07:30' }).retardoRealMin).toBe(0);
  });
});

describe('faltas: sólo en los días laborales DE ESA PERSONA, y una puede ser su descanso (26/09/2026)', () => {
  // Trabaja mié/jue/vie tres semanas: el lunes no es su día.
  const parcial: h.DiaCrudo[] = [];
  for (const semana of ['2026-07-01', '2026-07-08', '2026-07-15']) {
    for (const off of [0, 1, 2]) {
      const d = new Date(Date.parse(`${semana}T12:00:00Z`) + off * 86400000).toISOString().slice(0, 10);
      parcial.push(dia(d, '08:00'));
    }
  }
  it('sus días laborales son mié(3) jue(4) vie(5), y un lunes vacío no es falta', () => {
    expect(h.analizarPersona(parcial).horario.diasLaborales).toEqual([3, 4, 5]);
    expect(h.analizarPersona(parcial.concat([{ fecha: '2026-07-20', marcas: [] }])).retardos?.faltas).toBe(0);
  });
  it('un miércoles vacío YA NO es falta: con 3 días laborales le quedan 4 descansos a la semana', () => {
    // Era la 6ª falla de Mega Talento (esperaba 1). Desde el 26/09 quien trabaja 3 días tiene
    // 7 − 3 = 4 descansos por semana, y una ausencia en día laboral se toma como uno de ellos.
    expect(h.analizarPersona(parcial.concat([{ fecha: '2026-07-22', marcas: [] }])).retardos?.faltas).toBe(0);
  });

  // La regla vista donde sí muerde: tienda de lunes a sábado = 1 descanso por semana.
  const tienda: h.DiaCrudo[] = [];
  for (let i = 0; i < 21; i++) {
    const f = new Date(Date.parse('2026-07-02T12:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    if (h.diaSemana(f) !== 0) tienda.push(dia(f, '08:00'));
  }
  it('tienda: si descansó el domingo, el martes vacío ES falta', () => {
    const conDomingoLibre = tienda.concat([
      dia('2026-07-23', '08:00'), dia('2026-07-24', '08:00'), dia('2026-07-25', '08:00'),
      { fecha: '2026-07-26', marcas: [] }, dia('2026-07-27', '08:00'),
      { fecha: '2026-07-28', marcas: [] }, dia('2026-07-29', '08:00'),
    ]);
    expect(h.analizarPersona(conDomingoLibre).retardos?.faltas).toBe(1);
  });
  it('tienda: si trabajó el domingo, el martes vacío es su descanso', () => {
    const conDomingoTrabajado = tienda.concat([
      dia('2026-07-23', '08:00'), dia('2026-07-24', '08:00'), dia('2026-07-25', '08:00'),
      dia('2026-07-26', '08:00'), dia('2026-07-27', '08:00'),
      { fecha: '2026-07-28', marcas: [] }, dia('2026-07-29', '08:00'),
    ]);
    const r = h.analizarPersona(conDomingoTrabajado).retardos;
    expect(r?.faltas).toBe(0);
    const martes = r?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === '2026-07-28');
    expect([martes?.estado, martes?.descansoPorAusencia]).toEqual(['descanso', true]);
  });
});
