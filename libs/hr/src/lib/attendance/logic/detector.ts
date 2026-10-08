import { analizarDia } from './reglas';
import type { BorradorAlerta, ChecadaMin, HorarioMin, Inconsistencia, ReglaConfig } from './tipos';
import { rangoFechas } from './fechas';

/**
 * Fase RH · `[RH.1.5]` — el recorrido del AGENTE DE ALERTAS: agrupa por persona-día, corre el
 * motor puro (`reglas.ts`) y arma los borradores. Lógica PURA: es el cuerpo de `detectar` de
 * `mega-talento-90/api/src/agente-horarios/detector.ts` @ 3d77a7d sin sus consultas (que viven
 * en `attendance-reader.ts`). No persiste ni notifica.
 *
 * ⚠️ Fiel al original en lo que no es obvio: el detector mide contra el turno ASIGNADO a la
 * persona (`person_schedules.schedule_id`) o el horario GENERAL del sitio por día de la semana,
 * NO contra el horario deducido. Es la comparación que `horario-deducido.ts` documenta como
 * fuente del 72% de alertas falsas de retardo; por eso en Mega Talento las reglas de retardo,
 * falta y fuera de turno se apagan por configuración y la medición de retardo vive en la
 * pantalla de asistencia. Se traslada igual: cambiarlo es una decisión de RH, no de la mudanza.
 */

/** Un horario del sitio, como lo lee el lector. */
export interface HorarioSitio {
  id: string;
  nombre: string;
  dias: number[];
  entrada: string;
  salida: string;
  inicioComida: string | null;
  finComida: string | null;
  toleranciaMin: number;
  activo: boolean;
}

/** Una persona del padrón del sitio que entra a la detección. */
export interface PersonaDetector {
  codigo: string;
  nombre: string;
  /** Turno de sitio asignado (`person_schedules.schedule_id`), o null. */
  horarioId: string | null;
  /** Las promotoras y las bajas se quedan fuera de la detección (no checan aquí). */
  excluida: boolean;
}

export interface ChecadaDetector {
  codigo: string;
  nombre: string | null;
  fecha: string;
  fechaHora: string;
  hora: string;
  tipo: number | null;
}

export interface EntradaDetector {
  sucursalId: string;
  desde: string;
  hasta: string;
  config: ReglaConfig;
  hoy: string;
  personas: PersonaDetector[];
  horarios: HorarioSitio[];
  checadas: ChecadaDetector[];
  /** Quien dejó de venir: código → fecha de su última checada (se analiza hasta ahí). */
  cortePorCodigo: Map<string, string>;
}

export interface ResumenDeteccion {
  sucursalId: string;
  desde: string;
  hasta: string;
  empleadosAnalizados: number;
  diasAnalizados: number;
  checadasLeidas: number;
  totalInconsistencias: number;
  porRegla: Record<string, number>;
  empleadosSinTurno: number;
  exTrabajadoresOmitidos: number;
}

/** Día de la semana (0=domingo..6=sábado), a mediodía UTC. */
function diaSemanaDe(fecha: string): number {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}

function aHorarioMin(h: HorarioSitio, ambiguo: boolean): HorarioMin {
  return {
    nombre: h.nombre, dias: h.dias || [], entrada: h.entrada, salida: h.salida,
    inicioComida: h.inicioComida, finComida: h.finComida, toleranciaMin: h.toleranciaMin || 0, ambiguo,
  };
}

/**
 * Horario GENERAL del sitio para un día (cuando la persona no tiene turno asignado). Con varios
 * candidatos marca `ambiguo`. Mega Talento prefería el de `area_id` NULL; en la Suite los
 * horarios de sitio no tienen área (ver `[RH.1.1]`), así que toma el primero por nombre.
 */
function horarioGeneral(horarios: HorarioSitio[], diaSemana: number): HorarioMin | null {
  const candidatos = horarios.filter((h) => h.activo !== false && Array.isArray(h.dias) && h.dias.includes(diaSemana));
  if (!candidatos.length) return null;
  return aHorarioMin(candidatos[0], candidatos.length > 1);
}

export function detectarEnDatos(e: EntradaDetector): { borradores: BorradorAlerta[]; resumen: ResumenDeteccion } {
  const { sucursalId, desde, hasta, config, hoy } = e;
  const horariosPorId = new Map(e.horarios.map((h) => [h.id, h]));
  const activos = e.personas.filter((p) => !p.excluida);
  const horarioIdPorCodigo = new Map(e.personas.map((p) => [p.codigo, p.horarioId]));

  // codigo -> fecha -> checadas, y codigo -> nombre visto.
  const porEmpleadoDia = new Map<string, Map<string, ChecadaMin[]>>();
  const nombrePorCodigo = new Map<string, string>();
  for (const p of activos) nombrePorCodigo.set(p.codigo, p.nombre);
  for (const r of e.checadas) {
    if (r.nombre && !nombrePorCodigo.has(r.codigo)) nombrePorCodigo.set(r.codigo, r.nombre);
    if (!porEmpleadoDia.has(r.codigo)) porEmpleadoDia.set(r.codigo, new Map());
    const porDia = porEmpleadoDia.get(r.codigo) as Map<string, ChecadaMin[]>;
    if (!porDia.has(r.fecha)) porDia.set(r.fecha, []);
    (porDia.get(r.fecha) as ChecadaMin[]).push({ fechaHora: r.fechaHora, hora: r.hora, tipo: r.tipo ?? null });
  }
  // Igual que en Mega Talento: las excluidas (promotoras, bajas) salen del padrón —así no se les
  // inventan faltas—, pero el universo es activos ∪ los que aparecen en checadas, de modo que una
  // excluida que SÍ checa se evalúa con sus marcas.
  const codigos = new Set<string>([...activos.map((p) => p.codigo), ...porEmpleadoDia.keys()]);
  const fechas = rangoFechas(desde, hasta);

  const generalPorDia = new Map<number, HorarioMin | null>();
  for (const f of fechas) {
    const ds = diaSemanaDe(f);
    if (!generalPorDia.has(ds)) generalPorDia.set(ds, horarioGeneral(e.horarios, ds));
  }

  const borradores: BorradorAlerta[] = [];
  const porRegla: Record<string, number> = {};
  let empleadosSinTurno = 0;
  let exTrabajadoresOmitidos = 0;

  for (const codigo of codigos) {
    const nombre = nombrePorCodigo.get(codigo) || codigo;
    const porDia = porEmpleadoDia.get(codigo) || new Map<string, ChecadaMin[]>();
    // Si dejó de venir, se analiza hasta su última checada y ya.
    const corte = e.cortePorCodigo.get(codigo) || null;
    if (corte) exTrabajadoresOmitidos++;
    const conActividad = porDia.size > 0;
    const asignadoId = horarioIdPorCodigo.get(codigo) || null;
    const asignado = asignadoId ? horariosPorId.get(asignadoId) : null;

    for (const fecha of fechas) {
      if (corte && fecha > corte) break;
      const ds = diaSemanaDe(fecha);
      let horario: HorarioMin | null;
      if (asignado) {
        horario = asignado.activo !== false && Array.isArray(asignado.dias) && asignado.dias.includes(ds)
          ? aHorarioMin(asignado, false)
          : null; // ese día no es laborable para su turno asignado
      } else {
        horario = generalPorDia.get(ds) ?? null;
      }
      const checadas = (porDia.get(fecha) || []).slice().sort((a, b) => a.fechaHora.localeCompare(b.fechaHora));
      if (!horario && checadas.length === 0) continue;
      if (!horario && checadas.length > 0) empleadosSinTurno++;

      const inconsistencias: Inconsistencia[] = analizarDia({
        empleado: { sucursalId, codigo, nombre },
        fecha, diaSemana: ds, cerrado: fecha < hoy,
        checadas, horario, config,
        empleadoConActividadRango: conActividad,
      });
      for (const inc of inconsistencias) {
        porRegla[inc.regla] = (porRegla[inc.regla] || 0) + 1;
        borradores.push({ ...inc, sucursalId, empleadoCodigo: codigo, empleadoNombre: nombre, fecha });
      }
    }
  }

  return {
    borradores,
    resumen: {
      sucursalId, desde, hasta,
      empleadosAnalizados: codigos.size,
      diasAnalizados: fechas.length,
      checadasLeidas: e.checadas.length,
      totalInconsistencias: borradores.length,
      porRegla,
      empleadosSinTurno,
      exTrabajadoresOmitidos,
    },
  };
}
