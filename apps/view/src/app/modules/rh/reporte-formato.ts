import type { HrAsistenciaResponse, HrDiaAsistencia, HrHorarioAsignado, HrPersonaAsistencia } from '@megadulces/contracts';
import { sumarDias } from './rh.service';

/**
 * Fase RH · `[RH.1.7c]` — el reporte semanal «calcado» de Mega Talento (`asistencia-resumen`: `celda`,
 * `irregularidadesDe`, `horasTexto`, `firmaHoras`, `horarioCorto`), en funciones puras para la pantalla, el PDF y el
 * Excel: «lo que se ve es lo que sale».
 *
 * Aquí no se recalcula ningún número del servidor: sólo se DICE cada día como RH lo lee en papel. Lo único propio de
 * la pantalla es el DÍA EN CURSO: el servidor lo mide como si ya hubiera terminado (igual que Mega Talento), así que
 * a las 7 de la mañana quien no ha llegado saldría con falta y quien salió a desayunar, con «salida» a las 11. Hoy se
 * pinta como lo que es: «sigue en su jornada» o «todavía no checa», y no se cuenta como falta ni como irregularidad.
 */

export type TipoCelda =
  | 'vacio' | 'descanso' | 'desc_aus' | 'inc' | 'just' | 'falta' | 'marca' | 'curso' | 'sin_checar_hoy' | 'dia';

export interface CeldaReporte {
  tipo: TipoCelda;
  /** La línea principal: «07:56 - 17:04», «VAC», «0 - 0», «08:02 - 0», «08:01 - …», «—», «DESC.», «JUST.». */
  jornada: string;
  /** Las pausas del día, «11:02–11:24». */
  tramos: string[];
  desMin: number | null;
  comMin: number | null;
  desExcedido: boolean;
  comExcedida: boolean;
  /** Entró tarde contra su horario (sólo donde la plaza mide retardo). */
  tarde: boolean;
  /** Salió antes de lo que pide su horario asignado. */
  salioAntes: boolean;
  /** Códigos de incidencia del día («VAC·PCG»). */
  inc: string;
  /** Lo que dice el tooltip: el porqué de la celda. */
  titulo: string;
}

export interface ColumnaDia { fecha: string; dow: string; dia: number; hoy: boolean; }

const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DOW_LARGO = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Una columna por día del rango. */
export function columnasDelRango(desde: string, hasta: string, hoy: string): ColumnaDia[] {
  const out: ColumnaDia[] = [];
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
    const d = new Date(`${f}T12:00:00Z`);
    out.push({ fecha: f, dow: DOW[d.getUTCDay()], dia: d.getUTCDate(), hoy: f === hoy });
    if (out.length > 62) break;   // un rango absurdo no cuelga la pantalla
  }
  return out;
}

/** «lunes 5». */
export function diaLargo(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return `${DOW_LARGO[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** Los días de una persona por fecha (para no buscar en las semanas en cada celda). */
export function diasPorFecha(p: HrPersonaAsistencia): Map<string, HrDiaAsistencia> {
  return new Map(p.semanas.flatMap((s) => s.dias).map((d) => [d.fecha, d]));
}

/** «10:58 – 11:14 · 14:02 – 14:58» (el texto del servidor) → ['10:58–11:14', '14:02–14:58']. Una salida sin regreso queda sola. */
export function tramosDe(comida: string | null | undefined): string[] {
  const t = String(comida || '').trim();
  if (!t || t === '—') return [];
  return t.split('·').map((x) => x.trim().replace(/\s*[–-]\s*/, '–')).filter(Boolean);
}

const VACIA: Omit<CeldaReporte, 'tipo' | 'jornada' | 'titulo'> = {
  tramos: [], desMin: null, comMin: null, desExcedido: false, comExcedida: false, tarde: false, salioAntes: false, inc: '',
};

/** Cómo se dice UN día de una persona en el reporte. */
export function celdaDe(p: HrPersonaAsistencia, dias: Map<string, HrDiaAsistencia>, fecha: string, o: { hoy: string; mideRetardo: boolean }): CeldaReporte {
  const d = dias.get(fecha);
  // La incidencia se busca también en los PERIODOS de la persona: quien estuvo de vacaciones la semana entera no
  // checó y no trae días que pintar.
  const incs = d?.incidencias?.length ? d.incidencias : p.incidencias.filter((i) => i.desde <= fecha && i.hasta >= fecha);
  const inc = incs.map((i) => i.codigo).join('·');
  const incTitulo = incs.map((i) => i.etiqueta + (i.nota ? ` — ${i.nota}` : '')).join(' · ');
  const esHoy = fecha === o.hoy;

  if (!d) {
    if (inc) return { ...VACIA, tipo: 'inc', jornada: inc, inc, titulo: incTitulo };
    return { ...VACIA, tipo: 'vacio', jornada: '', titulo: fecha > o.hoy ? '' : 'Sin checadas que medir ese día' };
  }
  if (d.estado === 'descanso') {
    // El descanso que se tomó en un día que trabaja se dice como tal: un guion se leería como su descanso de siempre.
    if (inc) return { ...VACIA, tipo: 'inc', jornada: inc, inc, titulo: incTitulo };
    return d.descansoPorAusencia
      ? { ...VACIA, tipo: 'desc_aus', jornada: 'DESC.', titulo: 'No checó en un día que normalmente trabaja; se tomó como su descanso de la semana.' }
      : { ...VACIA, tipo: 'descanso', jornada: '—', titulo: 'Su día de descanso' };
  }
  if (d.estado === 'justificado') {
    // En el papel, el día justificado se marca: en blanco no se distingue de un día sin dato, y en rojo sería una
    // falta que RH ya perdonó.
    return { ...VACIA, tipo: inc ? 'inc' : 'just', jornada: inc || 'JUST.', inc, titulo: incTitulo || d.justificacion || 'Justificado' };
  }
  if (d.estado === 'falta') {
    if (esHoy) return { ...VACIA, tipo: 'sin_checar_hoy', jornada: '·', titulo: 'Todavía no checa hoy. El día no ha terminado: no es falta.' };
    return { ...VACIA, tipo: 'falta', jornada: inc || '0 - 0', inc, titulo: inc ? `Falta · ${incTitulo}` : 'Falta: un día que trabaja, sin checadas' };
  }
  const entrada = d.entrada || d.hora || '';
  if (esHoy) {
    return { ...VACIA, tipo: 'curso', jornada: `${entrada || '?'} - …`, inc, titulo: 'Sigue en su jornada: el día se mide completo cuando termina.' };
  }
  if (d.estado === 'marca_faltante') {
    return { ...VACIA, tipo: 'marca', jornada: `${entrada || '?'} - 0`, inc, titulo: 'Checó una sola vez: no se sabe si fue entrada o salida, y no se mide retardo.' };
  }
  const tarde = o.mideRetardo && d.atrasoMin > 0;
  const salioAntes = (d.salidaAntesMin || 0) > 0;
  const comExcedida = (d.comidaExcesoMin || 0) > 0;
  const desExcedido = (d.desayunoExcesoMin || 0) > 0;
  const avisos: string[] = [];
  if (tarde) avisos.push(`${d.atrasoMin} min tarde`);
  if (salioAntes) avisos.push(`salió ${d.salidaAntesMin} min antes`);
  if (desExcedido) avisos.push(`desayuno +${d.desayunoExcesoMin} min`);
  if (comExcedida) avisos.push(`comida +${d.comidaExcesoMin} min`);
  if (incTitulo) avisos.push(incTitulo);
  return {
    tipo: 'dia', jornada: `${entrada} - ${d.salida || '0'}`, tramos: tramosDe(d.comida),
    desMin: d.desayunoMin ?? null, comMin: d.comidaMin ?? null, desExcedido, comExcedida, tarde, salioAntes, inc,
    titulo: avisos.join(' · '),
  };
}

/**
 * El desayuno y la comida de un día, como tramos («11:02–11:24»). El servidor da los minutos de cada uno y el texto
 * de todas las pausas; el desayuno es la PRIMERA pausa que dura lo que dice `desayunoMin` (sólo existe con dos pausas).
 */
export function pausasDelDia(d: HrDiaAsistencia): { desayuno: string | null; comida: string | null } {
  const tramos = tramosDe(d.comida);
  const dur = (t: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})–(\d{1,2}):(\d{2})$/.exec(t);
    return m ? (Number(m[3]) * 60 + Number(m[4])) - (Number(m[1]) * 60 + Number(m[2])) : null;
  };
  const i = d.desayunoMin != null ? tramos.findIndex((t) => dur(t) === d.desayunoMin) : -1;
  const comida = tramos.filter((_, k) => k !== i);
  return { desayuno: i >= 0 ? tramos[i] : null, comida: comida.length ? comida.join(' · ') : null };
}

// ── Horas y horario ──────────────────────────────────────────────────────────────────────────

/** 2750 → «45h 50m»; nada → «—». */
export function horasTexto(min: number | null | undefined): string {
  if (!min || min <= 0) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Diferencia contra el horario: «+1h 10m», «−0h 40m», «0h 00m»; sin horario asignado, ''. */
export function firmaHoras(min: number | null | undefined): string {
  if (min == null) return '';
  if (min === 0) return '0h 00m';
  return `${min > 0 ? '+' : '−'}${horasTexto(Math.abs(min))}`;
}

/** Horas trabajadas menos las que pide su horario asignado (null si no tiene). */
export function difHorario(p: HrPersonaAsistencia): number | null {
  return p.horarioAsignado && p.minutosEsperados != null ? p.minutosTrabajados - p.minutosEsperados : null;
}

/** «08:00» → «8:00 am». */
export function hora12(h: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h || ''));
  if (!m) return String(h || '');
  const a = Number(m[1]);
  return `${a % 12 || 12}:${m[2]} ${a < 12 ? 'am' : 'pm'}`;
}

/** «8:00–17:00 · sáb 9:00–14:00». */
export function horarioAsignadoCorto(h: HrHorarioAsignado): string {
  const sab = h.sabado ? (h.sabadoEntrada && h.sabadoSalida ? ` · sáb ${h.sabadoEntrada}–${h.sabadoSalida}` : ' · sáb') : '';
  return `${h.entrada}–${h.salida}${sab}`;
}

/** La columna Horario: el asignado por RH, o lo que sale de sus checadas. */
export function horarioDe(p: HrPersonaAsistencia): { texto: string; asignado: boolean } {
  if (p.horarioAsignado) return { texto: horarioAsignadoCorto(p.horarioAsignado), asignado: true };
  const turnos = p.turnos.filter((t): t is string => !!t);
  if (turnos.length > 1) return { texto: `Rota · ${turnos.join(' / ')}`, asignado: false };
  if (p.horario) return { texto: `Deducido · ${hora12(p.horario)}`, asignado: false };
  return { texto: '—', asignado: false };
}

// ── Irregularidades (las de la fila en rojo) ───────────────────────────────────────────────

export type NivelIrregularidad = 'alta' | 'baja';
export interface Irregularidad { fecha: string; nivel: NivelIrregularidad; tipo: string; texto: string; }

/** Incidencias que NO justifican el día: con ellas el día sigue siendo irregular. */
const NO_JUSTIFICAN = new Set(['falta_injustificada', 'amonestacion', 'horario_distinto']);

/**
 * Las irregularidades de una persona, día por día (`irregularidadesDe` de Mega Talento). La fila va en rojo con una
 * ALTA; «dentro de su tolerancia» se lista pero no pinta (llegó tarde y le alcanzó la bolsa). El día en curso no
 * cuenta: todavía no termina.
 */
export function irregularidadesDe(p: HrPersonaAsistencia, o: { hoy: string; desayunoAlertaMin: number }): Irregularidad[] {
  const out: Irregularidad[] = [];
  for (const s of p.semanas) for (const d of s.dias) {
    if (d.fecha >= o.hoy) continue;
    if (d.estado === 'justificado' || d.estado === 'descanso') continue;
    if ((d.incidencias ?? []).some((i) => !NO_JUSTIFICAN.has(i.tipo))) continue;
    const base = { fecha: d.fecha };
    if (d.estado === 'falta') out.push({ ...base, nivel: 'alta', tipo: 'falta', texto: 'Falta' });
    // El retardo sólo acusa si el número se puede usar: con el horario por confirmar el minuto no es de fiar.
    if (d.retardoRealMin > 0 && p.usable) {
      const extra = d.atrasoMin > d.retardoRealMin ? ` (${d.retardoRealMin} fuera de tolerancia)` : '';
      out.push({ ...base, nivel: 'alta', tipo: 'retardo', texto: `Llegó ${Math.max(d.atrasoMin, d.retardoRealMin)} min tarde${extra}` });
    } else if (d.atrasoMin > 0 && p.usable) {
      out.push({ ...base, nivel: 'alta', tipo: 'tolerancia', texto: `Llegó ${d.atrasoMin} min tarde (dentro de su tolerancia)` });
    }
    if ((d.desayunoExcesoMin || 0) >= o.desayunoAlertaMin) out.push({ ...base, nivel: 'alta', tipo: 'desayuno', texto: `Desayuno +${d.desayunoExcesoMin} min` });
    if (d.estado === 'marca_faltante') out.push({ ...base, nivel: 'baja', tipo: 'una_marca', texto: 'Sólo checó una vez' });
    if (d.atipico) out.push({ ...base, nivel: 'baja', tipo: 'atipico', texto: 'Fuera de su horario' });
  }
  return out;
}

/** Cuántas de cada nivel, sin contar las que caben en la tolerancia (ésas no pintan). */
export function cuentaIrregular(irr: Irregularidad[], nivel: NivelIrregularidad): number {
  return irr.filter((i) => i.nivel === nivel && i.tipo !== 'tolerancia').length;
}

// ── Lo que cuentan las pestañas ─────────────────────────────────────────────────────────────

/** Quien se pasó de la tolerancia de su semana (con su número usable: el resto se lista aparte, «por confirmar»). */
export function rebasados(d: HrAsistenciaResponse | null): { usables: HrPersonaAsistencia[]; porConfirmar: HrPersonaAsistencia[] } {
  const con = (d?.personas ?? []).filter((p) => p.retardoRealMin > 0).sort((a, b) => b.retardoRealMin - a.retardoRealMin);
  return { usables: con.filter((p) => p.usable), porConfirmar: con.filter((p) => !p.usable) };
}

export interface FaltaDia { persona: HrPersonaAsistencia; fecha: string; inc: string; }

/** Las faltas del periodo, día por día, SIN el día de hoy (todavía no termina). */
export function faltasDelPeriodo(d: HrAsistenciaResponse | null, hoy: string): FaltaDia[] {
  const out: FaltaDia[] = [];
  for (const p of d?.personas ?? []) for (const s of p.semanas) for (const dia of s.dias) {
    if (dia.estado !== 'falta' || dia.fecha >= hoy) continue;
    out.push({ persona: p, fecha: dia.fecha, inc: (dia.incidencias ?? []).map((i) => i.codigo).join('·') });
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.persona.nombreCompleto || a.persona.nombre).localeCompare(b.persona.nombreCompleto || b.persona.nombre));
}

// ── Agrupado por departamento ───────────────────────────────────────────────────────────────

export const SIN_DEPARTAMENTO = 'SIN DEPARTAMENTO';

/** El departamento como lo lee RH: el nombre (sin el código interno), en mayúsculas. */
export function departamentoDe(p: HrPersonaAsistencia): string {
  const d = String(p.departamento || '').split(' · ')[0].trim();
  return d ? d.toUpperCase() : SIN_DEPARTAMENTO;
}

export interface GrupoDepartamento { departamento: string; personas: HrPersonaAsistencia[]; total: number; }

/**
 * Las personas por departamento, en orden alfabético y con «SIN DEPARTAMENTO» al final. `total` es el departamento
 * COMPLETO (para decir «3 de 8» cuando hay filtro), y el orden de las personas, por nombre.
 */
export function porDepartamento(todas: HrPersonaAsistencia[], visibles: HrPersonaAsistencia[]): GrupoDepartamento[] {
  const total = new Map<string, number>();
  for (const p of todas) total.set(departamentoDe(p), (total.get(departamentoDe(p)) ?? 0) + 1);
  const grupos = new Map<string, HrPersonaAsistencia[]>();
  for (const p of visibles) {
    const k = departamentoDe(p);
    if (!grupos.has(k)) grupos.set(k, []);
    (grupos.get(k) as HrPersonaAsistencia[]).push(p);
  }
  const nombre = (p: HrPersonaAsistencia) => p.nombreCompleto || p.nombre;
  return [...grupos.entries()]
    .sort(([a], [b]) => (a === SIN_DEPARTAMENTO ? 1 : b === SIN_DEPARTAMENTO ? -1 : a.localeCompare(b)))
    .map(([departamento, personas]) => ({
      departamento, total: total.get(departamento) ?? personas.length,
      personas: personas.slice().sort((a, b) => nombre(a).localeCompare(nombre(b))),
    }));
}

/** «solo SISTEMAS», «solo 3 personas», «solo Daniela Ortiz»: los reportes parciales dicen que lo son (regla 8 de RH). */
export function etiquetaParcial(o: { unica: HrPersonaAsistencia | null; departamentos: string[]; buscar: string; soloIrregulares: boolean }): string {
  if (o.unica) return `solo ${o.unica.nombreCompleto || o.unica.nombre}`;
  const partes: string[] = [];
  if (o.departamentos.length === 1) partes.push(`solo ${o.departamentos[0]}`);
  else if (o.departamentos.length > 1) partes.push(`solo ${o.departamentos.length} departamentos`);
  if (o.buscar.trim()) partes.push(`quien coincide con «${o.buscar.trim()}»`);
  if (o.soloIrregulares) partes.push('sólo con irregularidades');
  return partes.join(' · ');
}
