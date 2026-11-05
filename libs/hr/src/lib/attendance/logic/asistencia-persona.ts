import type {
  HrAsistenciaResponse, HrDiaAsistencia, HrGravedad, HrHorarioAsignado, HrIncidenciaDelDia, HrMarcaAsistencia,
  HrPersonaAsistencia, HrTurnoAsignado,
} from '@megadulces/contracts';
import * as hd from './horario-deducido';
import { detalleDia, formatHoras, type ConfigDesayuno } from './detalle-dia';
import { esPromotora, type ReglaConfig } from './tipos';
import { tipoIncidencia } from './incidencias';
import { minutosDeHHMM, rangoFechas, siguienteDia } from './fechas';

/**
 * Fase RH · `[RH.1.5]` — ASISTENCIA POR PERSONA, con las reglas del horario deducido. Lógica PURA.
 *
 * Es el cuerpo de `asistenciaPersonas` de `mega-talento-90/api/src/agente-horarios/
 * asistencia-personas.ts` @ 5ca5f2a, separado de sus consultas: allá leía la base y calculaba
 * en la misma función de 500 líneas; aquí la lectura vive en `attendance-reader.ts` y esto
 * recibe lo leído. El recorrido por persona es el mismo, línea por línea, para que se pueda
 * auditar contra el original.
 *
 *   1. El horario sale de las checadas de CADA PERSONA, no del sitio.
 *   2. El retardo se acumula contra una bolsa de 15 min por semana (jueves→miércoles) y sólo
 *      cuenta el EXCEDENTE.
 *   3. Un día con UNA sola marca no genera retardo: no se sabe si es la entrada o la salida.
 *   4. Una falta es un día laboral DE ESA PERSONA sin ninguna marca.
 *   5. Lo que RH confirmó (`hr.person_schedules`) MANDA sobre la deducción.
 *
 * Cada persona viene con `usable` y `marcas`: **un número mal calculado que se ve igual que uno
 * bien calculado es peor que no tener nada.**
 *
 * La forma de la respuesta es la de Mega Talento (claves en español) a propósito: ADR-084 opción
 * rápida, las pantallas de `[RH.1.7]` la consumen tal cual. Lo que es fila de una tabla nueva
 * (incidencias, cierres, alertas) sí sale con sus columnas en inglés.
 *
 * Cambio contra el original, uno solo: «registrado» significa que el código del reloj está
 * ligado a una persona de la Suite (`identity.users`, ADR-084 D1), no que tenga ficha en
 * `empleados`. Hasta que `[RH.1.4]` ligue el padrón, casi todos saldrán `fuera_del_padron`
 * (gravedad media, no bloquea el número): es verdad, sus marcas todavía no son de nadie.
 */

/** Ventana de silencio a partir de la cual se considera que alguien ya no viene. */
export const DIAS_EX_TRABAJADOR = 21;
/**
 * DOS VENTANAS, Y ES LA DECISIÓN MÁS IMPORTANTE DE ESTE ARCHIVO: el horario se deduce de los
 * últimos 28 días (la historia de la persona) y el retardo se mide SÓLO en el rango pedido. Si
 * RH pide "Hoy", un día no alcanza para deducir nada (se necesitan 5 con entrada y salida).
 */
export const VENTANA_HORARIO_DIAS = 28;
/** Proporción de días con UNA marca a partir de la cual es crónico. */
const UMBRAL_UNA_MARCA = 0.7;
/**
 * `[RH.1.10]` HORAS EXTRA (Mega Talento ee4ff38, 08/10/2026, regla de RH). Es hora extra lo que se
 * queda DESPUÉS de su hora de salida, y sólo cuenta en bloques completos de 30 min (45 min = 30;
 * 1 h 10 = 1 h). Si ese día llegó tarde o se pasó del desayuno o de la comida, primero repone eso:
 * quien entra una hora tarde y se va una hora tarde no hizo horas extra. Un día con más de
 * `EXTRA_MAX_DIA_MIN` se topa ahí: casi siempre es una checada de más.
 */
export const EXTRA_BLOQUE_MIN = 30;
export const EXTRA_MAX_DIA_MIN = 6 * 60;

/** Los minutos de la incidencia de ese tipo en el día, o null si no hay. */
function minutosDe(incs: IncidenciaDia[], tipo: string): number | null {
  const i = incs.find((x) => x.tipo === tipo && x.minutos != null);
  return i ? Number(i.minutos) : null;
}
/**
 * Justificantes viejos de texto libre que SÍ excusan una ausencia. "Tráfico" explica un retardo
 * pero no borra el día; vacaciones, incapacidad y permiso sí.
 */
const JUSTIFICAN_AUSENCIA = ['vacaciones', 'incapacidad', 'permiso'];

// Los tipos de la RESPUESTA viven en el contrato (`@megadulces/contracts`, `hr-attendance.contract.ts`):
// la pantalla los importa de ahí, y que esta función los construya hace que el compilador avise si
// la copia textual de la regla (`horario-deducido.ts`) cambia de forma.
export type Gravedad = HrGravedad;
export type Marca = HrMarcaAsistencia;
export type IncidenciaDia = HrIncidenciaDelDia;
export type DiaVista = HrDiaAsistencia;
export type HorarioAsignado = HrHorarioAsignado;
export type TurnoAsignado = HrTurnoAsignado;

/**
 * `[RH.1.15]` Los horarios guardados en la fila (`hr.person_schedules.shifts`), si son válidos y
 * coinciden con sus `turnos` (las entradas). Copia de `horariosDeFila` de Mega Talento @ 8396d3c: con
 * menos de 2, o si no casan con las entradas, null (y la fila se lee como antes).
 */
export function horariosDeFila(shifts: unknown, turnos: string[]): TurnoAsignado[] | null {
  const lista = Array.isArray(shifts) ? shifts : null;
  if (!lista || lista.length < 2 || lista.length !== turnos.length) return null;
  const out: TurnoAsignado[] = [];
  for (const h of lista as Array<{ entrada?: unknown; salida?: unknown; comidaMin?: unknown } | null>) {
    if (!h || typeof h.entrada !== 'string' || typeof h.salida !== 'string') return null;
    out.push({ entrada: h.entrada, salida: h.salida, comidaMin: Number(h.comidaMin) || 0 });
  }
  return out;
}

/** La persona en el padrón del sitio, tal como la arma el lector. */
export interface FichaPadron {
  userId: string | null;
  /** Ligada a una persona de la Suite. Ver el cambio contra el original, arriba. */
  registrado: boolean;
  nombre: string | null;
  nombreCompleto: string | null;
  departamento: string | null;
  puesto: string | null;
  fotoUrl: string | null;
  activo: boolean;
  es_promotora?: boolean | null;
}

export interface IncidenciaVigente {
  id: string;
  personCode: string;
  tipo: string;
  desde: string;
  hasta: string;
  nota: string;
  minutos: number | null;
}

/** Un día-persona con todas sus horas. */
export interface FilaDia {
  codigo: string;
  nombreReloj: string;
  fecha: string;
  horas: string[];
}

export interface EntradaAsistencia {
  siteCode: string;
  desde: string;
  hasta: string;
  soloPromotoras: boolean;
  cfg: ReglaConfig;
  /** Días-persona de la ventana ANCHA (`desdeHorario`..`hasta`). */
  filas: FilaDia[];
  /** Días de silencio de cada código, contra el último día con dato DEL SITIO. */
  silencio: Map<string, number>;
  /** Días con dato y días con UNA marca, sobre toda la historia del código. */
  unaMarca: Map<string, { dias: number; conUna: number }>;
  padron: Map<string, FichaPadron>;
  turnosConfirmados: Map<string, string[]>;
  asignados: Map<string, HorarioAsignado>;
  /**
   * Justificantes viejos de texto libre APROBADOS (`hr.attendance_reviews`), código → fecha → texto.
   * Sólo excusan los que dicen vacaciones, incapacidad o permiso (`revisionExcusa`).
   */
  revisiones: Map<string, Map<string, string>>;
  incidencias: IncidenciaVigente[];
  diasExTrabajador?: number;
  ventanaHorarioDias?: number;
}

export type PersonaAsistencia = HrPersonaAsistencia;
export type AsistenciaPersonas = HrAsistenciaResponse;

/** Desde cuándo hay que leer para DEDUCIR el horario: nunca menos que el rango pedido. */
export function desdeVentanaHorario(desde: string, hasta: string, ventana = VENTANA_HORARIO_DIAS): string {
  const inicio = new Date(Date.parse(`${hasta}T12:00:00Z`) - (ventana - 1) * 86400000).toISOString().slice(0, 10);
  return [desde, inicio].sort()[0];
}

/** ¿Este justificante viejo de texto libre excusa una ausencia? */
export function revisionExcusa(texto: string | null | undefined): boolean {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return JUSTIFICAN_AUSENCIA.some((j) => t.includes(j));
}

/** La configuración del desayuno que usan la pantalla y la alerta (una sola fuente). */
export function configDesayuno(cfg: ReglaConfig): ConfigDesayuno | undefined {
  return cfg.reglasActivas?.desayuno_excedido && cfg.desayunoTopeMin > 0
    ? {
        topeMin: cfg.desayunoTopeMin,
        hastaMin: minutosDeHHMM(cfg.desayunoHastaHora) ?? 13 * 60,
        maxPlausibleMin: cfg.desayunoMaxPlausibleMin,
        cuentaComoJornada: !!cfg.desayunoCuentaComoJornada,
      }
    : undefined;
}

export function calcularAsistencia(e: EntradaAsistencia): AsistenciaPersonas {
  const { siteCode, desde, hasta, soloPromotoras, cfg } = e;
  const DIAS_EX = e.diasExTrabajador ?? DIAS_EX_TRABAJADOR;
  const ventanaHorario = e.ventanaHorarioDias ?? VENTANA_HORARIO_DIAS;
  // En un checador de COMIDA la gente sólo marca su desayuno/comida, no una jornada: la
  // detección de practicante no aplica ahí.
  const esRelojDeComida = /comida|desayuno/i.test(siteCode);
  const desayunoCfg = configDesayuno(cfg);
  const desdeHorario = desdeVentanaHorario(desde, hasta, ventanaHorario);

  // (código → fecha → incidencias). Una incidencia es un PERIODO; aquí se abre en días,
  // recortado al rango, para pegarla a cada celda.
  const incPorDia = new Map<string, Map<string, IncidenciaDia[]>>();
  for (const inc of e.incidencias) {
    const t = tipoIncidencia(inc.tipo);
    const item: IncidenciaDia = {
      id: inc.id, tipo: inc.tipo, codigo: t?.codigo || 'OTR',
      etiqueta: t?.etiqueta || inc.tipo, nota: inc.nota, minutos: inc.minutos,
    };
    if (!incPorDia.has(inc.personCode)) incPorDia.set(inc.personCode, new Map());
    const porFecha = incPorDia.get(inc.personCode) as Map<string, IncidenciaDia[]>;
    const ini = inc.desde > desde ? inc.desde : desde;
    const fin = inc.hasta < hasta ? inc.hasta : hasta;
    for (let f = ini; f <= fin; f = siguienteDia(f)) {
      if (!porFecha.has(f)) porFecha.set(f, []);
      (porFecha.get(f) as IncidenciaDia[]).push(item);
    }
  }

  // Días-persona, agrupados por código. `dias` es la historia (para deducir el horario) y
  // `enRango` es lo que se mide y se muestra.
  const porCodigo = new Map<string, {
    nombreReloj: string;
    dias: hd.DiaCrudo[];
    enRango: hd.DiaCrudo[];
    horas: Map<string, string[]>;
  }>();
  for (const r of [...e.filas].sort((a, b) => a.codigo.localeCompare(b.codigo) || a.fecha.localeCompare(b.fecha))) {
    if (r.fecha < desdeHorario || r.fecha > hasta) continue;
    if (!porCodigo.has(r.codigo)) {
      porCodigo.set(r.codigo, { nombreReloj: r.nombreReloj || '', dias: [], enRango: [], horas: new Map() });
    }
    const p = porCodigo.get(r.codigo) as { nombreReloj: string; dias: hd.DiaCrudo[]; enRango: hd.DiaCrudo[]; horas: Map<string, string[]> };
    const dia = { fecha: r.fecha, marcas: r.horas };
    p.dias.push(dia);
    if (dia.fecha >= desde && dia.fecha <= hasta) {
      p.enRango.push(dia);
      p.horas.set(dia.fecha, r.horas);
    }
  }

  // Todas las fechas del rango: un día AUSENTE de las checadas es justo el que hay que evaluar.
  const fechasDelRango = rangoFechas(desde, hasta);

  // Base: TODOS los del padrón del sitio (para ver faltas de quien no checó nada) + los
  // códigos que checan sin estar en el padrón.
  const codigos = new Set<string>([...e.padron.keys(), ...porCodigo.keys()]);
  const personas: PersonaAsistencia[] = [];

  for (const cod of codigos) {
    const emp = e.padron.get(cod);
    // Las promotoras no se miden con esta vara (no checan en el reloj del sitio: aparecían con
    // falta todos los días), y quien está dado de baja tampoco. `soloPromotoras` invierte A QUIÉN
    // se salta, con un solo predicado para las dos vistas: si se decidiera distinto, una persona
    // podría salir en ambas o en ninguna. El código SIN ficha sí se mide en la vista de planta
    // (es alguien marcando sin estar en el padrón) y se salta en la de promotoras.
    const promotora = esPromotora(emp ? { es_promotora: emp.es_promotora ?? null, departamento: emp.departamento } : null);
    if (soloPromotoras) {
      if (!emp || !promotora || emp.activo === false) continue;
    } else if (emp && (promotora || emp.activo === false)) continue;
    const datos = porCodigo.get(cod);
    const dias = datos?.dias || [];
    const turnosConf = e.turnosConfirmados.get(cod) || null;
    const asig = e.asignados.get(cod) || null;

    const opciones: hd.OpcionesHorario = { minDias: 5 };
    if (turnosConf && turnosConf.length === 1) opciones.bloqueConocido = turnosConf[0];
    // Con horario asignado, sus días de trabajo son los de su horario (lunes a viernes, y el
    // sábado si le toca), no los que se deducen de sus semanas.
    const laboralesAsig = asig ? [1, 2, 3, 4, 5, ...(asig.sabado ? [6] : [])] : null;
    if (turnosConf && turnosConf.length > 1) opciones.bloquesConocidos = turnosConf;

    const u = e.unaMarca.get(cod);
    const pctUna = u && u.dias ? u.conUna / u.dias : 0;
    const silencio = e.silencio.has(cod) ? (e.silencio.get(cod) as number) : null;

    // ── 1) El HORARIO sale de la ventana ancha (su historia) ──
    const ho = hd.deducirHorario(dias, opciones);

    // ── 2) Los días a MEDIR son los del rango, más los que faltan ──
    // Sólo dentro del periodo en que la persona demostrablemente trabajaba: desde su primera
    // checada (no inventar faltas antes del alta) y hasta su última si lleva DIAS_EX en silencio
    // (no acumularle faltas a quien ya se fue: sin corte, sepultan las de quien sí trabaja).
    const conMarca = new Set(datos?.enRango.map((d) => d.fecha) || []);
    const primeraChecada = dias.length ? dias[0].fecha : null;
    const ultimaChecada = dias.length ? dias[dias.length - 1].fecha : null;
    const seFue = silencio !== null && silencio >= DIAS_EX;
    const piso = primeraChecada && primeraChecada > desde ? primeraChecada : desde;
    const techo = seFue && ultimaChecada && ultimaChecada < hasta ? ultimaChecada : hasta;

    const diasAMedir: hd.DiaCrudo[] = (datos?.enRango || []).slice();
    if (datos && datos.enRango.length) {
      for (const f of fechasDelRango) {
        if (conMarca.has(f) || f < piso || f > techo) continue;
        diasAMedir.push({ fecha: f, marcas: [] });
      }
      diasAMedir.sort((x, y) => x.fecha.localeCompare(y.fecha));
    } else if (primeraChecada && incPorDia.has(cod)) {
      // `[RH.1.10]` Sin checadas en el periodo pero con incidencias (vacaciones, uso de horas extra...):
      // esos días se miden igual, para que la incidencia se vea y cuente. Antes, mirando un solo día,
      // quien usó horas extra el día completo no aparecía y sus horas no se sumaban.
      for (const f of [...(incPorDia.get(cod) as Map<string, IncidenciaDia[]>).keys()].sort()) {
        if (f >= piso && f <= techo) diasAMedir.push({ fecha: f, marcas: [] });
      }
    }

    // ── 3) El RETARDO se mide sólo en el rango, contra ese horario ──
    const turnoPorFecha = ho.tipo === 'rotativo'
      ? hd.deducirTurnos(
          diasAMedir,
          turnosConf && turnosConf.length > 1
            ? turnosConf.map((x) => hd.aMinutos(x)).filter((x): x is number => x !== null)
            : ho.bloques,
          opciones)
      : null;
    // `[RH.1.15]` VARIOS HORARIOS ASIGNADOS (Mega Talento 8396d3c, 15/10/2026): cada día se mide
    // contra el que trabajó, el más cercano a su entrada. Con el mismo margen que un horario asignado
    // único (120 min): con el de un rotativo deducido (60) quien llega 70 min tarde al turno de la
    // mañana se mediría contra «otro turno» y su retardo desaparecería.
    const variosHorarios = !!asig && asig.horarios.length > 1;
    const turnoAsig = variosHorarios && asig
      ? hd.deducirTurnos(
          diasAMedir,
          asig.horarios.map((h) => hd.aMinutos(h.entrada)).filter((x): x is number => x !== null),
          { ...opciones, atipicoRotativoMin: 120 })
      : null;
    /** Su horario asignado de ese día (con varios, el que trabajó; sin checadas, el primero). */
    const horarioDe = (f: string): TurnoAsignado | null => {
      if (!asig) return null;
      const t = turnoAsig?.get(f);
      return (t && asig.horarios.find((h) => hd.aMinutos(h.entrada) === t.bloque)) || asig.horarios[0];
    };
    // Si el periodo empieza a media semana, los días de esa semana ANTES del periodo también
    // gastan descansos.
    const ausenciasPrevias = new Map<string, number>();
    if (primeraChecada) {
      const conMarcaHist = new Set(dias.map((d) => d.fecha));
      const clave = hd.inicioSemana(desde);
      let n = 0;
      for (let f = clave; f < desde; f = siguienteDia(f)) {
        if (f >= primeraChecada && !conMarcaHist.has(f)) n++;
      }
      if (n) ausenciasPrevias.set(clave, n);
    }

    // "Horario distinto" de RH: ese día se mide contra la hora que capturó.
    const horarioDelDia = new Map<string, number>();
    for (const [f, incs] of incPorDia.get(cod) || []) {
      for (const i of incs) if (i.tipo === 'horario_distinto' && i.minutos != null) horarioDelDia.set(f, Number(i.minutos));
    }
    // El sábado de su horario asignado puede entrar a otra hora.
    if (asig && asig.sabado && asig.sabadoEntrada && asig.sabadoEntrada !== asig.entrada) {
      const sab = hd.aMinutos(asig.sabadoEntrada);
      if (sab !== null) {
        for (const f of fechasDelRango) if (hd.diaSemana(f) === 6 && !horarioDelDia.has(f)) horarioDelDia.set(f, sab);
      }
    }
    // `[RH.1.10]` CAMBIO DE DÍA DE DESCANSO: el día capturado es su descanso de esa semana y su
    // descanso habitual de ESA semana (jueves a miércoles) pasa a ser de trabajo: si no viene, es
    // falta. Sin días laborales conocidos sólo se marca el descanso. Las incidencias llegan con las
    // semanas completas del periodo (el lector las pide así).
    const laboralPorFecha = new Map<string, boolean>();
    const descansoCambio = new Map<string, 'descansa' | 'trabaja'>();
    const diasLab = laboralesAsig || ho.diasLaborales;
    const cambiosDesc = e.incidencias
      .filter((i) => i.personCode === cod && i.tipo === 'cambio_descanso')
      .map((i) => i.desde).sort();
    for (const f of cambiosDesc) {
      laboralPorFecha.set(f, false); descansoCambio.set(f, 'descansa');
      if (!diasLab) continue;
      for (let k = 0, g = hd.inicioSemana(f); k < 7; k++, g = siguienteDia(g)) {
        if (g !== f && !diasLab.includes(hd.diaSemana(g)) && !laboralPorFecha.has(g)) {
          laboralPorFecha.set(g, true); descansoCambio.set(g, 'trabaja');
          break;
        }
      }
    }
    // `[RH.1.15]` DESCANSO capturado por RH (Mega Talento 8dd5521, 13/10/2026): esos días son
    // descanso, sin mover ningún otro (a quien le tocan dos en la semana, o para quitarle a unas
    // vacaciones el día que de todos modos descansaba). Va después del cambio de descanso: si
    // chocan, manda éste.
    for (const i of e.incidencias) {
      if (i.personCode !== cod || i.tipo !== 'descanso') continue;
      for (let f = i.desde; f <= i.hasta; f = siguienteDia(f)) {
        laboralPorFecha.set(f, false); descansoCambio.set(f, 'descansa');
      }
    }

    // SIN HORARIO (01/10/2026): quien casi siempre checa UNA vez no deja deducir horario. Sus
    // días se arman igual —checadas, horas y faltas— y sólo el RETARDO queda apagado.
    const entradaUsar = asig ? hd.aMinutos(asig.entrada) : ho.entradaMin;
    const sinHorario = entradaUsar === null;
    const re = hd.retardosPorSemana(diasAMedir, {
      ...opciones,
      horarioDelDia: sinHorario ? null : horarioDelDia,
      entradaMin: sinHorario ? 0 : entradaUsar,
      turnoPorFecha: sinHorario ? null : asig ? turnoAsig : turnoPorFecha,
      diasLaborales: laboralesAsig || ho.diasLaborales,
      ausenciasPrevias,
      medirRetardo: !sinHorario && cfg.medirRetardo !== false,
      laboralPorFecha: laboralPorFecha.size ? laboralPorFecha : null,
    });
    if (sinHorario) {
      for (const s of re.semanas) for (const d of s.dias) d.referencia = null;
      re.diasEvaluados = 0;
    }

    // ── LAS MARCAS: por qué este número puede no ser de fiar ──
    const marcas: Marca[] = [];
    if (asig) {
      const lista = asig.horarios.map((h) => `${h.entrada} a ${h.salida}, comida ${h.comidaMin} min`);
      marcas.push({
        codigo: 'horario_confirmado', gravedad: 'ok',
        detalle: (variosHorarios
          ? `RH le asignó ${lista.length} horarios: ${lista.join(' · ')}; cada día se mide contra el que trabajó`
          : `RH le asignó su horario: ${lista[0]}`) +
          (asig.sabado ? `, sábado ${asig.sabadoEntrada || asig.entrada} a ${asig.sabadoSalida || asig.salida}` : ', sin sábado') +
          '. Manda sobre la deducción.',
      });
    } else if (turnosConf) {
      marcas.push({ codigo: 'horario_confirmado', gravedad: 'ok', detalle: `RH confirmó ${turnosConf.join(' y ')}: manda sobre la deducción.` });
    }
    if (silencio !== null && silencio >= DIAS_EX) {
      marcas.push({
        codigo: 'ex_trabajador', gravedad: 'alta',
        detalle: `${silencio} días sin aparecer${emp && emp.activo && emp.registrado ? ', y sigue ACTIVO en el padrón' : ''}. No preguntar por su horario.`,
      });
    }
    if (pctUna >= UMBRAL_UNA_MARCA && (u?.dias || 0) >= 20 && u) {
      marcas.push({
        codigo: 'solo_una_marca', gravedad: 'alta',
        detalle: `${u.conUna} de ${u.dias} días con UNA sola marca (${Math.round(pctUna * 100)}%). Con una marca no se sabe si es entrada o salida: su retardo no es calculable.`,
      });
    }
    if (ho.tipo === 'sin_datos' && !asig) {
      marcas.push({ codigo: 'sin_datos', gravedad: 'alta', detalle: `${ho.diasUsados} día(s) con entrada y salida en el rango; se necesitan 5.` });
    }
    if (ho.tipo === 'sin_patron' && !asig) {
      marcas.push({ codigo: 'sin_patron', gravedad: 'alta', detalle: ho.motivo || 'sin patrón reconocible' });
    }
    // Sólo para un FIJO: en un rotativo la mediana global no es un horario. Y sin hora límite,
    // preguntar "¿8:00 u 8:30?" no sirve: sólo cambia un retardo que aquí no se mide.
    const conHorario = cfg.medirRetardo !== false;
    if (conHorario && ho.bloqueAmbiguo && !turnosConf && ho.tipo === 'fijo') {
      const cr = hd.aMinutos(ho.entradaCruda);
      const ops = [hd.aHora(hd.bloqueDeCostumbre(cr)), hd.aHora(hd.bloqueMasCercano(cr))];
      marcas.push({
        codigo: 'horario_ambiguo', gravedad: 'media', detalle: ho.motivo || '', opciones: ops,
        // El impacto se mide sobre el RANGO que se está viendo: tiene que cuadrar con la tarjeta.
        impacto: ops.filter((t): t is string => !!t).map((t) => hd.impactoDeOpcion(diasAMedir, t)),
      });
    }
    if (ho.tipo === 'rotativo' && !asig) {
      marcas.push({ codigo: 'rotativo', gravedad: 'info', detalle: `Trabaja ${ho.turnos.length} turnos (${ho.turnos.join(', ')}). Cada día se mide contra el suyo.` });
      for (const g of (ho.grupos || []).filter((x) => conHorario && x.ambiguo && !turnosConf)) {
        const ops = [hd.aHora(hd.bloqueDeCostumbre(g.centroMin)), hd.aHora(hd.bloqueMasCercano(g.centroMin))];
        marcas.push({
          codigo: 'turno_ambiguo', gravedad: 'media',
          detalle: `Su turno de ~${g.centro} puede ser ${ops[0]} o ${ops[1]} (${g.dias} días).`,
          opciones: ops, turnoActual: g.turno, turnosActuales: ho.turnos,
          impacto: ops.filter((t): t is string => !!t).map((t) =>
            hd.impactoDeOpcion(diasAMedir, t, { base: ho.turnos.filter((x): x is string => !!x), original: g.turno })),
        });
      }
    }
    if (re && re.atipicos > 0) {
      marcas.push({ codigo: 'dias_atipicos', gravedad: 'media', detalle: `${re.atipicos} día(s) muy lejos de su horario: marca errónea o turno especial. Cuentan, pero revisar antes de usarlos.` });
    }
    if (re && re.marcasFaltantes > 0) {
      marcas.push({ codigo: 'marcas_faltantes', gravedad: 'info', detalle: `${re.marcasFaltantes} día(s) con una sola marca en el rango: no generan retardo porque no se sabe si esa marca es la entrada o la salida.` });
    }
    if (!emp || !emp.registrado) {
      marcas.push({
        codigo: 'fuera_del_padron', gravedad: 'media',
        detalle: 'Este código checa pero no está ligado a una persona de la Suite: sus marcas no se pueden atribuir a nadie.',
      });
    }

    // ── Semanas con la comida y las horas netas de cada día ──
    let minTrabajados = 0;
    // Los días que RH ya justificó dejan de ser falta. Se descuentan aquí y no en
    // horario-deducido: ése es la REGLA y el justificante es una DECISIÓN de RH.
    // Mega Talento filtraba en la consulta; aquí se filtra en la regla, que es donde se prueba.
    const excusadas = new Map([...(e.revisiones.get(cod) || new Map<string, string>())].filter(([, t]) => revisionExcusa(t)));
    const incDeEl = incPorDia.get(cod) || new Map<string, IncidenciaDia[]>();
    let faltasJustificadas = 0;
    // Días que el cálculo tomó como descanso pero RH marcó "falta injustificada": manda RH.
    let faltasForzadas = 0;
    let desayunoExcesoMin = 0;
    let diasDesayunoExcedido = 0;
    let diasConIncidencia = 0;
    let excusadoReal = 0, excusadoAtraso = 0, diasRetardoExcusados = 0;
    let esperados = 0;
    // `[RH.1.10]` Horas extra del periodo: las que ganó y las que usó.
    let extraGanadas = 0, extraUsadasPeriodo = 0;
    // Cuánto dura su jornada ese día (entrada a salida, con la comida adentro), para saber a qué
    // hora debía salir. Con horario asignado, el de RH (el sábado puede ser otro); si no, el
    // deducido de sus checadas. Sin horario asignado NO se calculan para un rotativo ni para medio
    // tiempo (jornada de 5 h 20 o menos): su horario cambia de un día a otro y la salida deducida
    // no es la de ese día.
    const jornadaDe = (f: string): number | null => {
      const h = horarioDe(f);
      if (asig && h) {
        const sab = hd.diaSemana(f) === 6;
        const ent = hd.aMinutos(sab ? asig.sabadoEntrada || h.entrada : h.entrada);
        const sal = hd.aMinutos(sab ? asig.sabadoSalida || h.salida : h.salida);
        return ent !== null && sal !== null && sal > ent ? sal - ent : null;
      }
      if (sinHorario || ho.tipo === 'rotativo' || ho.entradaMin == null || ho.salidaMin == null) return null;
      const j = ho.salidaMin - ho.entradaMin;
      return j > 320 && j <= 14 * 60 ? j : null;
    };
    const extraSegun: 'asignado' | 'deducido' | null = asig ? 'asignado'
      : jornadaDe(hasta) !== null ? 'deducido' : null;
    const semanas = (re?.semanas || []).map((s) => {
      let minSemana = 0;
      let excReal = 0, excAtraso = 0;
      const diasVista = s.dias.map((d): DiaVista => {
        const det = detalleDia(datos?.horas.get(d.fecha) || [], desayunoCfg);
        const incs = incDeEl.get(d.fecha) || [];
        // `[RH.1.10]` DESAYUNO / COMIDA DISTINTOS: ese día RH autorizó otro tiempo; el exceso de ese
        // día se mide contra el que autorizó.
        const desPermitido = minutosDe(incs, 'desayuno_distinto');
        const comPermitidaDia = minutosDe(incs, 'comida_distinta');
        if (desPermitido !== null && det.desayunoMin !== null) det.desayunoExcesoMin = Math.max(0, det.desayunoMin - desPermitido);
        // USO DE HORAS EXTRA: los minutos que usó ese día se SUMAN a lo que trabajó.
        const extraUsadas = incs.filter((i) => i.tipo === 'horas_extra').reduce((t, i) => t + (Number(i.minutos) || 0), 0);
        const netas = (det.netasMin || 0) + extraUsadas;
        if (netas) { minTrabajados += netas; minSemana += netas; }
        if (det.desayunoExcesoMin) { desayunoExcesoMin += det.desayunoExcesoMin; diasDesayunoExcedido++; }
        if (incs.length) diasConIncidencia++;
        // La incidencia que excusa manda sobre el justificante viejo de texto libre.
        const incExcusa = incs.find((i) => tipoIncidencia(i.tipo)?.excusaFalta);
        const justificacion = incExcusa?.etiqueta || excusadas.get(d.fecha);
        let esperadoMin: number | null = null, salidaAntesMin: number | null = null, comidaExcesoMin: number | null = null;
        const hDia = horarioDe(d.fecha);
        if (asig && hDia && laboralesAsig) {
          const sab = hd.diaSemana(d.fecha) === 6;
          const leToca = laboralesAsig.includes(hd.diaSemana(d.fecha));
          const ent = hd.aMinutos(sab ? asig.sabadoEntrada || hDia.entrada : hDia.entrada);
          const sal = hd.aMinutos(sab ? asig.sabadoSalida || hDia.salida : hDia.salida);
          const comPermitida = comPermitidaDia ?? (sab ? 0 : hDia.comidaMin);
          esperadoMin = leToca && ent !== null && sal !== null ? Math.max(0, sal - ent - comPermitida) : 0;
          if (leToca && sal !== null && det.salidaMin !== null && det.netasMin !== null) salidaAntesMin = Math.max(0, sal - det.salidaMin);
          if (leToca && comPermitida > 0 && det.comidaMin !== null) comidaExcesoMin = Math.max(0, det.comidaMin - comPermitida);
        }
        if (comPermitidaDia !== null) comidaExcesoMin = det.comidaMin !== null ? Math.max(0, det.comidaMin - comPermitidaDia) : null;
        // ══ HORAS EXTRA GANADAS ══ (ver EXTRA_BLOQUE_MIN). Debía salir a su entrada de ese día (la
        // referencia: su horario, su turno o el horario distinto que capturó RH) más su jornada.
        let extraMin = 0;
        let salidaEsperada: string | null = null;
        const refMin = hd.aMinutos(d.referencia ?? null);
        const jornadaDia = jornadaDe(d.fecha);
        if (refMin !== null && jornadaDia !== null && det.salidaMin !== null && det.netasMin !== null) {
          const esperada = refMin + jornadaDia;
          salidaEsperada = hd.aHora(esperada);
          const debe = (d.atrasoMin || 0) + (det.desayunoExcesoMin || 0) + (comidaExcesoMin || 0);
          const bruto = det.salidaMin - esperada - debe;
          if (bruto >= EXTRA_BLOQUE_MIN) {
            extraMin = Math.min(EXTRA_MAX_DIA_MIN, Math.floor(bruto / EXTRA_BLOQUE_MIN) * EXTRA_BLOQUE_MIN);
          }
        }
        extraGanadas += extraMin;
        extraUsadasPeriodo += extraUsadas;
        const extra = {
          comida: det.comida,
          horasNetas: formatHoras(netas),
          netasMin: netas || det.netasMin,
          horasExtraUsadasMin: extraUsadas || undefined,
          desayunoMin: det.desayunoMin,
          desayunoExcesoMin: det.desayunoExcesoMin,
          desayunoPagado: det.desayunoPagado,
          incidencias: incs,
          comidaMin: det.comidaMin,
          comidaExcesoMin,
          salidaAntesMin,
          esperadoMin,
          salidaEsperada,
          extraMin,
          ...(desPermitido !== null ? { desayunoPermitidoMin: desPermitido } : {}),
          ...(comPermitidaDia !== null ? { comidaPermitidaMin: comPermitidaDia } : {}),
          ...(descansoCambio.has(d.fecha) ? { descansoCambio: descansoCambio.get(d.fecha) } : {}),
          // `[RH.1.15]` Con varios horarios: contra cuál se midió ese día (su entrada). El sábado no:
          // si trabaja sábado, ese día manda su horario de sábado.
          ...(variosHorarios && hDia && turnoAsig?.has(d.fecha) && !(asig?.sabado && hd.diaSemana(d.fecha) === 6)
            ? { turno: hDia.entrada } : {}),
        };
        if (justificacion && d.estado === 'falta') {
          faltasJustificadas++;
          return { ...d, estado: 'justificado' as hd.EstadoDia, justificacion, ...extra, esperadoMin: asig ? 0 : null };
        }
        if (esperadoMin) esperados += esperadoMin;
        // ══ LA INCIDENCIA TAMBIÉN VALE CUANDO SÍ CHECÓ ══ un permiso para llegar tarde deja sin
        // efecto el retardo de ese día. El cálculo la lee cada vez: una capturada semanas
        // después corrige los números de esas semanas.
        if (justificacion && (d.estado === 'retardo' || d.estado === 'absorbido')) {
          excReal += d.retardoRealMin; excAtraso += d.atrasoMin;
          if (d.retardoRealMin > 0) diasRetardoExcusados++;
          return { ...d, estado: 'a_tiempo' as hd.EstadoDia, justificacion, atrasoMin: 0, absorbidoMin: 0, retardoRealMin: 0, ...extra };
        }
        if (d.estado === 'descanso' && !d.marcas && incs.some((i) => i.tipo === 'falta_injustificada')) {
          faltasForzadas++;
          return { ...d, estado: 'falta' as hd.EstadoDia, descansoPorAusencia: false, ...extra };
        }
        return { ...d, ...extra };
      });
      excusadoReal += excReal; excusadoAtraso += excAtraso;
      return {
        ...s, dias: diasVista, minutosTrabajados: minSemana,
        retardoRealMin: Math.max(0, s.retardoRealMin - excReal),
        atrasoMin: Math.max(0, s.atrasoMin - excAtraso),
      };
    });

    const bloqueantes = marcas.filter((m) => m.gravedad === 'alta');
    const diasEvaluados = re?.diasEvaluados ?? 0;

    // ── ¿PRACTICANTE? ── Media jornada: el turno (salida − entrada) ronda las 4 h.
    const entMin = asig ? hd.aMinutos(asig.entrada) : ho.entrada ? hd.aMinutos(ho.entrada) : null;
    const salMin = asig ? hd.aMinutos(asig.salida) : ho.salida ? hd.aMinutos(ho.salida) : null;
    let jornadaMin: number | null = entMin != null && salMin != null ? salMin - entMin : null;
    if (jornadaMin != null && jornadaMin < 0) jornadaMin += 24 * 60;
    const esPracticante = !esRelojDeComida && jornadaMin != null && jornadaMin >= 120 && jornadaMin <= 320;

    personas.push({
      codigo: cod,
      userId: emp?.userId ?? null,
      esPracticante,
      nombre: (emp && emp.nombre) || datos?.nombreReloj || cod,
      nombreCompleto: (emp && emp.nombreCompleto) || (emp && emp.nombre) || datos?.nombreReloj || cod,
      departamento: (emp && emp.departamento && String(emp.departamento).trim().toUpperCase()) || null,
      puesto: (emp && emp.puesto) || '',
      fotoUrl: (emp && emp.fotoUrl) || '',
      registrado: !!emp?.registrado,
      activo: emp ? emp.activo : null,
      tipo: ho.tipo,
      horario: asig ? asig.entrada : ho.entrada,
      turnos: asig ? asig.horarios.map((h) => h.entrada) : ho.turnos,
      horarioConfirmado: !!turnosConf,
      costumbre: ho.entradaCruda,
      desfaseMin: ho.desfaseMin,
      salida: asig ? asig.salida : ho.salida,
      dispersionMin: ho.dispersionMin,
      diasLaborales: laboralesAsig || ho.diasLaborales,
      diasUsados: ho.diasUsados,
      diasEnRango: datos?.enRango.length ?? 0,
      silencioDias: silencio,
      pctUnaMarca: Math.round(pctUna * 100),
      retardoRealMin: Math.max(0, (re?.retardoRealMin ?? 0) - excusadoReal),
      atrasoBrutoMin: Math.max(0, (re?.atrasoMin ?? 0) - excusadoAtraso),
      absorbidoMin: re?.absorbidoMin ?? 0,
      diasConRetardo: Math.max(0, (re?.diasConRetardo ?? 0) - diasRetardoExcusados),
      diasEvaluados,
      faltas: Math.max(0, (re?.faltas ?? 0) - faltasJustificadas + faltasForzadas),
      faltasJustificadas,
      diasNoMedibles: re?.marcasFaltantes ?? 0,
      diasAtipicos: re?.atipicos ?? 0,
      horasTrabajadas: Math.round(minTrabajados / 6) / 10,
      minutosTrabajados: minTrabajados,
      diasConIncidencia,
      incidencias: e.incidencias
        // Recortada al periodo: el lector trae las semanas completas (por el cambio de descanso).
        .filter((i) => i.personCode === cod && i.desde <= hasta && i.hasta >= desde)
        .map((i) => {
          const t = tipoIncidencia(i.tipo);
          return {
            id: i.id, tipo: i.tipo, codigo: t?.codigo || 'OTR', etiqueta: t?.etiqueta || i.tipo,
            nota: i.nota, minutos: i.minutos, desde: i.desde, hasta: i.hasta,
          };
        }),
      desayunoExcesoMin,
      diasDesayunoExcedido,
      // Sobre los días que SÍ se pudieron evaluar: sin ninguno no es 0%, es que no hay respuesta.
      pctATiempo: diasEvaluados
        ? Math.round(((diasEvaluados - Math.max(0, (re?.diasConRetardo ?? 0) - diasRetardoExcusados)) / diasEvaluados) * 100)
        : null,
      semanas,
      marcas,
      usable: bloqueantes.length === 0,
      bloqueadoPor: bloqueantes.map((m) => m.codigo),
      horarioAsignado: asig,
      minutosEsperados: asig ? esperados : null,
      horasExtraGanadasMin: extraGanadas,
      horasExtraUsadasMin: extraUsadasPeriodo,
      horasExtraSegun: extraSegun,
    });
  }

  // Primero lo que hay que ATENDER, no el retardo más alto (que suele ser de alguien cuyo
  // horario está sin confirmar).
  const orden = (p: PersonaAsistencia): number => (p.usable ? 2 : 0) + (p.marcas.some((m) => m.gravedad === 'media') ? 1 : 0);
  personas.sort((a, b) =>
    orden(a) - orden(b) || b.retardoRealMin - a.retardoRealMin || (a.nombre || a.codigo).localeCompare(b.nombre || b.codigo));

  const usables = personas.filter((p) => p.usable);
  const tieneMarca = (p: PersonaAsistencia, cod: string): boolean => p.marcas.some((m) => m.codigo === cod);

  return {
    sucursalId: siteCode, desde, hasta,
    desdeHorario, ventanaHorarioDias: ventanaHorario,
    bolsaSemanalMin: hd.BOLSA_SEMANAL_MIN,
    corteSemana: 'jueves a miércoles',
    diaInicioSemana: hd.DIA_INICIO_SEMANA,
    diasExTrabajador: DIAS_EX,
    desayunoAlertaMin: cfg.desayunoAlertaMin,
    mideRetardo: cfg.medirRetardo !== false,
    resumen: {
      personas: personas.length,
      usables: usables.length,
      conPendiente: personas.filter((p) => p.marcas.some((m) => m.gravedad === 'alta' || m.gravedad === 'media')).length,
      fijos: personas.filter((p) => p.tipo === 'fijo').length,
      rotativos: personas.filter((p) => p.tipo === 'rotativo').length,
      sinPatron: personas.filter((p) => p.tipo === 'sin_patron').length,
      sinDatos: personas.filter((p) => p.tipo === 'sin_datos').length,
      horarioAmbiguo: personas.filter((p) => tieneMarca(p, 'horario_ambiguo') || tieneMarca(p, 'turno_ambiguo')).length,
      horarioConfirmado: personas.filter((p) => p.horarioConfirmado).length,
      soloUnaMarca: personas.filter((p) => tieneMarca(p, 'solo_una_marca')).length,
      exTrabajadores: personas.filter((p) => tieneMarca(p, 'ex_trabajador')).length,
      fueraDelPadron: personas.filter((p) => !p.registrado).length,
      retardoRealMin: personas.reduce((s, p) => s + p.retardoRealMin, 0),
      retardoRealUsableMin: usables.reduce((s, p) => s + p.retardoRealMin, 0),
      atrasoBrutoMin: personas.reduce((s, p) => s + p.atrasoBrutoMin, 0),
      absorbidoMin: personas.reduce((s, p) => s + p.absorbidoMin, 0),
      faltas: personas.reduce((s, p) => s + p.faltas, 0),
      faltasJustificadas: personas.reduce((s, p) => s + p.faltasJustificadas, 0),
      diasNoMedibles: personas.reduce((s, p) => s + p.diasNoMedibles, 0),
      horasTrabajadas: Math.round(personas.reduce((s, p) => s + p.horasTrabajadas, 0)),
      desayunoExcesoMin: personas.reduce((s, p) => s + p.desayunoExcesoMin, 0),
      diasDesayunoExcedido: personas.reduce((s, p) => s + p.diasDesayunoExcedido, 0),
    },
    personas,
  };
}
