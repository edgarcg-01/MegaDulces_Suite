/**
 * `[RH.1.5]` La asistencia por persona (la pantalla de Asistencia) y el detalle de un día.
 *
 * Los casos fijan lo que la regla de RH dice en palabras: un día real de oficinas (seis marcas),
 * el desayuno pagado de corporativo, la falta que una incidencia excusa, la que RH fuerza, las
 * horas extra que suman, y que la promotora no se mida con la vara del personal de planta.
 */
import { calcularAsistencia, desdeVentanaHorario, revisionExcusa, type EntradaAsistencia, type FichaPadron, type FilaDia } from './asistencia-persona';
import { detalleDia } from './detalle-dia';
import { CONFIG_DEFAULT, configEfectiva } from './config-reglas';
import { rangoFechas } from './fechas';

describe('detalle de un día', () => {
  // Un día real de oficinas (sin nombre: este repositorio es público): desayuno 10:07–10:27 y comida 15:17–15:44.
  const oficinas = ['07:45', '10:07', '10:27', '15:17', '15:44', '18:00'];
  it('descuenta los huecos DE A PARES: 47 min fuera, 9 h 28 min trabajadas (la regla vieja daba 4 h 38)', () => {
    const d = detalleDia(oficinas);
    expect([d.brutasMin, d.netasMin, d.comida]).toEqual([615, 568, '10:07 – 10:27 · 15:17 – 15:44']);
  });
  it('en corporativo el desayuno se paga si hubo otra pausa: 588 min, y la comida son 27', () => {
    const cfg = { topeMin: 25, hastaMin: 13 * 60, maxPlausibleMin: 120, cuentaComoJornada: true };
    const d = detalleDia(oficinas, cfg);
    expect([d.desayunoMin, d.desayunoPagado, d.netasMin, d.comidaMin]).toEqual([20, true, 588, 27]);
  });
  it('con UNA sola pausa no se sabe cuál fue: se descuenta', () => {
    const cfg = { topeMin: 25, hastaMin: 13 * 60, maxPlausibleMin: 120, cuentaComoJornada: true };
    const d = detalleDia(['08:00', '10:00', '10:30', '18:00'], cfg);
    expect([d.desayunoPagado, d.netasMin]).toEqual([false, 570]);
  });
  it('una salida sin regreso se enseña pero no se descuenta', () => {
    const d = detalleDia(['08:00', '14:00', '18:00']);
    expect([d.comida, d.netasMin]).toEqual(['14:00', 600]);
  });
});

describe('ventanas y justificantes viejos', () => {
  it('pedir "hoy" lee 28 días de historia para deducir el horario', () => {
    expect(desdeVentanaHorario('2026-07-31', '2026-07-31')).toBe('2026-07-04');
    expect(desdeVentanaHorario('2026-01-01', '2026-07-31')).toBe('2026-01-01');
  });
  it('sólo excusan vacaciones, incapacidad o permiso (con o sin acento); "tráfico" no', () => {
    expect(['Vacaciones', 'INCAPACIDAD imss', 'permiso del jefe', 'Tráfico'].map(revisionExcusa)).toEqual([true, true, true, false]);
  });
});

/** Un sitio con Ana: lunes a sábado 08:00–18:00 del jueves 02-jul al miércoles 22-jul. */
function escenario(over: Partial<EntradaAsistencia> = {}, ficha: Partial<FichaPadron> = {}): EntradaAsistencia {
  const filas: FilaDia[] = [];
  for (const f of rangoFechas('2026-07-02', '2026-07-22')) {
    const dow = new Date(`${f}T12:00:00Z`).getUTCDay();
    if (dow === 0) continue;                           // domingo, su descanso
    if (f === '2026-07-14') continue;                  // martes: no vino
    filas.push({ codigo: '15', nombreReloj: 'Ana R', fecha: f, horas: [f === '2026-07-21' ? '08:40' : '08:00', '13:00', '14:00', '18:00'] });
  }
  return {
    siteCode: 'cedis', desde: '2026-07-09', hasta: '2026-07-22', soloPromotoras: false,
    cfg: CONFIG_DEFAULT, filas,
    silencio: new Map([['15', 0]]), unaMarca: new Map([['15', { dias: filas.length, conUna: 0 }]]),
    padron: new Map([['15', {
      userId: 'u-15', registrado: true, nombre: 'Ana', nombreCompleto: 'PRUEBA UNO', departamento: 'ALMACEN',
      puesto: 'Auxiliar', fotoUrl: null, activo: true, ...ficha,
    }]]),
    turnosConfirmados: new Map(), asignados: new Map(), revisiones: new Map(), incidencias: [],
    ...over,
  };
}
const ana = (e: EntradaAsistencia) => calcularAsistencia(e).personas.find((p) => p.codigo === '15');

describe('asistencia por persona', () => {
  it('deduce su horario de SUS checadas y mide el martes que faltó', () => {
    const p = ana(escenario());
    expect([p?.horario, p?.tipo, p?.faltas, p?.usable, p?.registrado]).toEqual(['08:00', 'fijo', 1, true, true]);
    // 11 días que sí vino: 9 h de jornada − 1 h de comida = 540 min, salvo el martes 21, que
    // entró 08:40 (500).
    expect(p?.minutosTrabajados).toBe(10 * 540 + 500);
  });
  it('40 min de retardo el martes 21 con 15 de bolsa: 25 reales', () => {
    const p = ana(escenario());
    expect([p?.atrasoBrutoMin, p?.retardoRealMin, p?.diasConRetardo]).toEqual([40, 25, 1]);
  });
  it('una incidencia de vacaciones CALIFICADA convierte la falta en justificado', () => {
    const p = ana(escenario({ incidencias: [{ id: 'i1', personCode: '15', tipo: 'vacaciones', desde: '2026-07-14', hasta: '2026-07-14', nota: '', minutos: null }] }));
    expect([p?.faltas, p?.faltasJustificadas, p?.diasConIncidencia]).toEqual([0, 1, 1]);
    const martes = p?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === '2026-07-14');
    expect([martes?.estado, martes?.justificacion]).toEqual(['justificado', 'Vacaciones']);
  });
  it('un permiso el día del retardo deja ese retardo sin efecto (sí vino: no es falta excusada)', () => {
    const p = ana(escenario({ incidencias: [{ id: 'i2', personCode: '15', tipo: 'permiso_con_goce', desde: '2026-07-21', hasta: '2026-07-21', nota: 'cita', minutos: null }] }));
    expect([p?.retardoRealMin, p?.atrasoBrutoMin, p?.faltas]).toEqual([0, 0, 1]);
  });
  it('horas extra usadas se suman a las horas del día', () => {
    const p = ana(escenario({ incidencias: [{ id: 'i3', personCode: '15', tipo: 'horas_extra', desde: '2026-07-20', hasta: '2026-07-20', nota: '', minutos: 60 }] }));
    expect(p?.minutosTrabajados).toBe(10 * 540 + 500 + 60);
  });
  it('un justificante viejo de texto libre también excusa, pero sólo si dice vacaciones/incapacidad/permiso', () => {
    expect(ana(escenario({ revisiones: new Map([['15', new Map([['2026-07-14', 'Incapacidad IMSS']])]]) }))?.faltas).toBe(0);
    expect(ana(escenario({ revisiones: new Map([['15', new Map([['2026-07-14', 'Tráfico']])]]) }))?.faltas).toBe(1);
  });
  it('el horario CONFIRMADO manda: con 08:30 confirmado, el martes 21 son 10 min (absorbidos)', () => {
    const p = ana(escenario({ turnosConfirmados: new Map([['15', ['08:30']]]) }));
    expect([p?.horario, p?.horarioConfirmado, p?.retardoRealMin]).toEqual(['08:30', true, 0]);
  });
  it('sin ligar a una persona de la Suite sale fuera del padrón (gravedad media: no bloquea el número)', () => {
    const p = ana(escenario({}, { registrado: false, userId: null }));
    expect([p?.registrado, p?.usable, p?.marcas.find((m) => m.codigo === 'fuera_del_padron')?.gravedad]).toEqual([false, true, 'media']);
  });
  it('la promotora sale de la vista de planta y entra en la suya; la baja no sale en ninguna', () => {
    const prom = escenario({}, { departamento: 'PROMOTORIA ZONA 2' });
    expect(ana(prom)).toBeUndefined();
    expect(ana({ ...prom, soloPromotoras: true })?.codigo).toBe('15');
    const baja = escenario({}, { activo: false });
    expect([ana(baja), ana({ ...baja, soloPromotoras: true })]).toEqual([undefined, undefined]);
  });
  it('quien lleva 21 días en silencio queda marcado ex-trabajador y su número no es usable', () => {
    const p = ana(escenario({ silencio: new Map([['15', 30]]) }));
    expect([p?.usable, p?.bloqueadoPor]).toEqual([false, ['ex_trabajador']]);
  });
  it('el resumen suma lo mismo que las personas', () => {
    const r = calcularAsistencia(escenario());
    expect([r.resumen.personas, r.resumen.faltas, r.resumen.retardoRealMin, r.corteSemana]).toEqual([1, 1, 25, 'jueves a miércoles']);
  });
  it('corporativo, con desayuno y comida, paga el desayuno en las horas', () => {
    const filas: FilaDia[] = [{ codigo: '15', nombreReloj: 'Oficinas', fecha: '2026-07-21', horas: ['07:45', '10:07', '10:27', '15:17', '15:44', '18:00'] }];
    const r = calcularAsistencia(escenario({ siteCode: 'corporativo', cfg: configEfectiva('corporativo', null, null), filas, desde: '2026-07-21', hasta: '2026-07-21' }));
    expect(r.personas[0].minutosTrabajados).toBe(588);
  });
});
