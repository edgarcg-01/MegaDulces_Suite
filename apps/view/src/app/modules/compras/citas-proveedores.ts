import {
  ETIQUETA_AREA_PARTICIPANTE, ETIQUETA_MODALIDAD_REUNION, ETIQUETA_TIPO_REUNION, LIMITES_REUNION,
  type AgendaCitas, type AgendarReunionDto, type AreaParticipante, type ChoqueReunion, type ParticipanteDto, type ReunionVista,
  type SituacionReunion,
} from '@megadulces/contracts';

/**
 * `[PQ.3.8]` Compras › Proveedores › Citas — lo que la pantalla dice y arma, sin Angular (se prueba con vitest).
 * La situación y las acciones de cada reunión las calcula la API; aquí sólo se ponen en palabras.
 */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const partes = (fecha: string) => {
  const [a, m, d] = fecha.split('-').map(Number);
  return { a, m, d, dow: new Date(Date.UTC(a, m - 1, d)).getUTCDay() };
};

/** «martes 2 de diciembre». */
export function diaLargo(fecha: string): string {
  const { m, d, dow } = partes(fecha);
  return `${DIAS[dow]} ${d} de ${MESES[m - 1]}`;
}

/** «mar 2 dic». */
export function diaCorto(fecha: string): string {
  const { m, d, dow } = partes(fecha);
  return `${DIAS[dow].slice(0, 3)} ${d} ${MESES_CORTO[m - 1]}`;
}

/** «23 al 29 de noviembre de 2026» · «30 de noviembre al 6 de diciembre de 2026» · cruzando año, los dos años. */
export function rangoSemana(s: { desde: string; hasta: string }): string {
  const a = partes(s.desde);
  const b = partes(s.hasta);
  if (a.a !== b.a) return `${a.d} de ${MESES[a.m - 1]} de ${a.a} al ${b.d} de ${MESES[b.m - 1]} de ${b.a}`;
  if (a.m !== b.m) return `${a.d} de ${MESES[a.m - 1]} al ${b.d} de ${MESES[b.m - 1]} de ${b.a}`;
  return `${a.d} al ${b.d} de ${MESES[b.m - 1]} de ${b.a}`;
}

const diasEntre = (desde: string, hasta: string) => {
  const x = partes(desde);
  const y = partes(hasta);
  return Math.round((Date.UTC(y.a, y.m - 1, y.d) - Date.UTC(x.a, x.m - 1, x.d)) / 86_400_000);
};

/** «hoy», «ayer», «mañana», «hace 3 días», «en 5 días». */
export function relativo(fecha: string, hoy: string): string {
  const n = diasEntre(hoy, fecha);
  if (n === 0) return 'hoy';
  if (n === -1) return 'ayer';
  if (n === 1) return 'mañana';
  return n < 0 ? `hace ${-n} días` : `en ${n} días`;
}

export function sumarDiasIso(fecha: string, n: number): string {
  const { a, m, d } = partes(fecha);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

export const horario = (r: Pick<ReunionVista, 'start_time' | 'end_time'>) => `${r.start_time} a ${r.end_time}`;

/** El proveedor por su nombre; sin ficha, por su clave (no se inventa un nombre). */
export const proveedorEnPalabras = (r: Pick<ReunionVista, 'supplier_name' | 'supplier_code'>) => r.supplier_name || `Clave ${r.supplier_code}`;

/** «Ana López, Luis Pérez · 1 del proveedor». */
export function quienVa(r: Pick<ReunionVista, 'participants'>): string {
  const casa = r.participants.filter((p) => p.side === 'internal').map((p) => p.nombre);
  const prov = r.participants.filter((p) => p.side === 'supplier').length;
  const partesTexto = [casa.join(', ')];
  if (prov) partesTexto.push(`${prov} del proveedor`);
  return partesTexto.filter(Boolean).join(' · ') || 'Nadie de Mega Dulces';
}

export const areaEnPalabras = (a: AreaParticipante | null) => (a ? ETIQUETA_AREA_PARTICIPANTE[a] : '');

/** Dónde y cómo: «En persona · Sala de juntas». */
export function lugarEnPalabras(r: Pick<ReunionVista, 'mode' | 'location'>): string {
  return [ETIQUETA_MODALIDAD_REUNION[r.mode], r.location].filter(Boolean).join(' · ');
}

/** «Plan de trabajo 2027» o el tipo tal cual. */
export function tipoEnPalabras(r: Pick<ReunionVista, 'kind' | 'work_plan_year'>): string {
  return r.kind === 'work_plan' && r.work_plan_year ? `${ETIQUETA_TIPO_REUNION.work_plan} ${r.work_plan_year}` : ETIQUETA_TIPO_REUNION[r.kind];
}

/**
 * El color acompaña a la etiqueta, nunca la sustituye (la etiqueta sale de `ETIQUETA_SITUACION_REUNION`). Ámbar = pide
 * algo (confirmar o escribir la minuta); verde = cerrada bien; gris = ya no ocupa a nadie.
 */
export const SEVERIDAD_SITUACION: Readonly<Record<SituacionReunion, 'success' | 'info' | 'warn' | 'secondary'>> = {
  por_confirmar: 'warn',
  agendada: 'info',
  en_curso: 'info',
  sin_minuta: 'warn',
  realizada: 'success',
  cancelada: 'secondary',
};

export function choqueEnPalabras(c: ChoqueReunion): string {
  return `${c.nombre} también tiene reunión con ${c.supplier_name || `la clave ${c.supplier_code}`} de ${c.start_time} a ${c.end_time}.`;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * La respuesta de arriba (Q.1): qué hay en la semana que se ve y qué quedó pendiente de antes. Si la semana es la
 * actual, «Esta semana»; si no, el rango.
 */
export function respuesta(a: AgendaCitas): string {
  const vivas = a.reuniones.filter((r) => r.situacion !== 'cancelada');
  const actual = a.semana.desde <= a.hoy && a.hoy <= a.semana.hasta;
  const cuando = actual ? 'Esta semana' : `Del ${rangoSemana(a.semana)}`;
  const frases = [`${cuando}: ${vivas.length ? plural(vivas.length, 'reunión', 'reuniones') : 'sin reuniones'}.`];
  if (a.sin_minuta.total) frases.push(`${plural(a.sin_minuta.total, 'reunión ya pasó', 'reuniones ya pasaron')} sin minuta.`);
  if (a.por_confirmar) frases.push(`${plural(a.por_confirmar, 'sigue', 'siguen')} por confirmar.`);
  return frases.join(' ');
}

/** ¿Este renglón abre un día nuevo en la lista? (la fecha se pinta sólo en el primero de cada día). */
export const primeraDelDia = (lista: readonly ReunionVista[], i: number) => i === 0 || lista[i - 1].date !== lista[i].date;

/** Las horas que se ofrecen, cada 15 minutos de 06:00 a 22:00. */
export const HORAS: readonly string[] = Array.from({ length: (22 - 6) * 4 + 1 }, (_, i) => {
  const min = 6 * 60 + i * 15;
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
});

/** El fin que se propone: una hora después del inicio (sin pasar de las 22:00). */
export function finSugerido(inicio: string): string {
  const [h, m] = inicio.split(':').map(Number);
  const min = Math.min(h * 60 + m + 60, 22 * 60);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** El año del plan: el actual y el siguiente (DC12). */
export const aniosDelPlan = (hoy: string) => [Number(hoy.slice(0, 4)), Number(hoy.slice(0, 4)) + 1];

/** `Date` del selector (medianoche local) ↔ `AAAA-MM-DD`, sin pasar por UTC (que cambiaría el día en la noche). */
export function fechaIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fechaDeIso(s: string): Date {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d);
}

/** Una reunión para editar: el mismo payload que agendar, con los `id` de la gente que ya estaba. */
export function dtoDeReunion(r: ReunionVista): AgendarReunionDto {
  return {
    supplier_code: r.supplier_code, kind: r.kind, date: r.date, start_time: r.start_time, end_time: r.end_time, mode: r.mode,
    location: r.location, topics: [...r.topics], work_plan_year: r.work_plan_year,
    participants: r.participants.map((p): ParticipanteDto => (p.side === 'internal'
      ? { id: p.id, side: 'internal', user_id: p.user_id, area: p.area }
      : { id: p.id, side: 'supplier', name: p.nombre, job_title: p.job_title })),
  };
}

/**
 * Lo que falta para poder guardar, en una frase (o `null`). Es un aviso ANTES de mandar: la API vuelve a revisar todo
 * y su mensaje es el que manda.
 */
export function faltaParaGuardar(dto: AgendarReunionDto): string | null {
  if (!dto.supplier_code) return 'Elige el proveedor.';
  if (!dto.date) return 'Elige la fecha.';
  if (!dto.start_time || !dto.end_time) return 'Elige la hora de inicio y de fin.';
  if (dto.end_time <= dto.start_time) return 'La hora de fin va después de la de inicio.';
  if (dto.kind === 'work_plan' && !dto.work_plan_year) return 'Elige el año del plan de trabajo.';
  const casa = dto.participants.filter((p) => p.side === 'internal');
  if (!casa.some((p) => p.user_id)) return 'Agrega al menos a una persona de Mega Dulces.';
  if (casa.some((p) => !p.user_id || !p.area)) return 'Completa la persona y el área de cada quien va por Mega Dulces (o quita el renglón).';
  if (dto.participants.some((p) => p.side === 'supplier' && !(p.name ?? '').trim())) return 'Escribe el nombre de cada quien va por el proveedor (o quita el renglón).';
  if ((dto.topics ?? []).filter((t) => t.trim()).length > LIMITES_REUNION.temas) return `Máximo ${LIMITES_REUNION.temas} temas.`;
  return null;
}
