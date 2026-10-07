import type {
  HrAsistenciaResponse, HrDiaAsistencia, HrGravedad, HrHorarioAsignado, HrIncidenciaDelDia, HrMarcaAsistencia,
  HrPersonaAsistencia,
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
    // SIN HORARIO (01/10/2026): quien casi siempre checa UNA vez no deja deducir horario. Sus
    // días se arman igual —checadas, horas y faltas— y sólo el RETARDO queda apagado.
    const entradaUsar = asig ? hd.aMinutos(asig.entrada) : ho.entradaMin;
    const sinHorario = entradaUsar === null;
    const re = hd.retardosPorSemana(diasAMedir, {
      ...opciones,
      horarioDelDia: sinHorario ? null : horarioDelDia,
      entradaMin: sinHorario ? 0 : entradaUsar,
      turnoPorFecha: sinHorario || asig ? null : turnoPorFecha,
      diasLaborales: laboralesAsig || ho.diasLaborales,
      ausenciasPrevias,
      medirRetardo: !sinHorario && cfg.medirRetardo !== false,
    });
    if (sinHorario) {
      for (const s of re.semanas) for (const d of s.dias) d.referencia = null;
      re.diasEvaluados = 0;
    }

    // ── LAS MARCAS: por qué este número puede no ser de fiar ──
    const marcas: Marca[] = [];
    if (asig) {
      marcas.push({
        codigo: 'horario_confirmado', gravedad: 'ok',
        detalle: `RH le asignó su horario: ${asig.entrada} a ${asig.salida}, comida ${asig.comidaMin} min` +
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
    const semanas = (re?.semanas || []).map((s) => {
      let minSemana = 0;
      let excReal = 0, excAtraso = 0;
      const diasVista = s.dias.map((d): DiaVista => {
        const det = detalleDia(datos?.horas.get(d.fecha) || [], desayunoCfg);
        const incs = incDeEl.get(d.fecha) || [];
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
        if (asig && laboralesAsig) {
          const sab = hd.diaSemana(d.fecha) === 6;
          const leToca = laboralesAsig.includes(hd.diaSemana(d.fecha));
          const ent = hd.aMinutos(sab ? asig.sabadoEntrada || asig.entrada : asig.entrada);
          const sal = hd.aMinutos(sab ? asig.sabadoSalida || asig.salida : asig.salida);
          const comPermitida = sab ? 0 : asig.comidaMin;
          esperadoMin = leToca && ent !== null && sal !== null ? Math.max(0, sal - ent - comPermitida) : 0;
          if (leToca && sal !== null && det.salidaMin !== null && det.netasMin !== null) salidaAntesMin = Math.max(0, sal - det.salidaMin);
          if (leToca && comPermitida > 0 && det.comidaMin !== null) comidaExcesoMin = Math.max(0, det.comidaMin - comPermitida);
        }
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
      turnos: asig ? [asig.entrada] : ho.turnos,
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
        .filter((i) => i.personCode === cod)
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
