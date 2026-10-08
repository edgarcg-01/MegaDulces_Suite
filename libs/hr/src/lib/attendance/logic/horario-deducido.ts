/**
 * HORARIO DEDUCIDO Y RETARDO REAL CON BOLSA SEMANAL.
 *
 * ══ PROCEDENCIA (Fase RH · `[RH.1.5]`, ADR-084) ══
 *
 * Copia TEXTUAL de `mega-talento-90/api/src/agente-horarios/horario-deducido.ts` @ 1a494b3
 * (2026-09-30), salvo los nombres de empleados de sus comentarios, que se quitaron porque este
 * repositorio es público (se describen por su caso). No se reescribió a propósito: es la regla que RH ya usa para pagar, y una
 * copia textual se audita con un diff; una reescritura, no. Los nombres en español son los de
 * allá por la misma razón. Si hay que cambiar una regla, se cambia AQUÍ y su prueba
 * (`horario-deducido.spec.ts`) tiene que decir por qué cambió el número.
 *
 * ⚠️ Lo que el comentario de abajo llama «el puerto del bot» YA NO coincide: medido el
 * 2026-10-07, `BOT-RH/src/horario-deducido.js` sigue cortando la semana en MIÉRCOLES y no
 * tiene la regla de descansos del 26/09, así que su panel da 146 min de retardo a una persona de
 * Morelia donde el portal da 131 (el caso de la prueba). Y la prueba de Mega Talento (`tools/probar-horario.ts`) está en ROJO
 * desde el 18/08 (6 fallas, todas por esos dos cambios de regla). Aquí queda UNA sola
 * implementación —la del portal, la vigente— y la prueba trae los números corregidos.
 *
 * Lógica PURA: no toca la base, no lee variables de entorno, no llama a nadie.
 * Recibe días ya armados y devuelve números.
 *
 * ══ POR QUÉ EXISTE ESTE ARCHIVO ══
 *
 * El retardo se calculaba en CUATRO lugares, y los cuatro comparaban contra el
 * horario CONFIGURADO de la sucursal:
 *   · api/src/agente-horarios/reglas.ts   — este repo, servidor
 *   · src/app/rh/asistencia-resumen/*.ts  — este repo, EN EL NAVEGADOR
 *   · src/app/rh/horarios/*.ts            — este repo, EN EL NAVEGADOR
 *   · BOT-RH src/checador.js              — el otro repo, en SQL
 *
 * Y ese horario configurado está mal en casi todas las plazas. Medido al
 * 28/07/2026 sobre 115 mil checadas:
 *   · 8-Esquinas configurada 07:30; entrada real de 07:56 (p25) a 12:32 (p75)
 *     -> 81% de "retardo". No llegan tarde: hay varios turnos y una sola hora
 *     configurada.
 *   · Zamora Canindo configurada 09:00; su p25 de entrada es 06:13 -> la gente
 *     llega TRES HORAS ANTES de su horario y el sistema no lo nota.
 * De 8,724 inconsistencias detectadas, 6,257 (72%) salían de esa comparación.
 * Alertas falsas, no personas impuntuales.
 *
 * Aquí el horario sale de las checadas de CADA PERSONA, y el retardo se acumula
 * contra una bolsa semanal: solo cuenta lo que EXCEDE la bolsa.
 *
 * ══ ES UN PUERTO DE `BOT-RH/src/horario-deducido.js` ══
 *
 * La misma regla vive en dos repos porque los dos tienen que aplicarla y son
 * servicios distintos (el portal no puede depender del bot para pintar una
 * pantalla). Se portó función por función, con los MISMOS nombres, para que la
 * diferencia se pueda auditar leyendo en paralelo. `tools/probar-horario.ts`
 * corre los mismos casos con los mismos resultados esperados que
 * `BOT-RH/scripts/probar-horario-deducido.js`: si alguien cambia una regla en un
 * repo y no en el otro, esa prueba falla.
 *
 * ══ LO QUE HAY QUE SABER ANTES DE CONFIAR EN ESTO ══
 *
 * 1. DEDUCIR LEGITIMA LA COSTUMBRE. Si alguien lleva un mes entrando 8:20 y su
 *    horario real es 8:00, la mediana redondeada le deduce 8:30 y su retardo
 *    pasa a ser cero. El horario deducido describe lo que la persona HACE, no lo
 *    que la empresa ACORDÓ: sirve para encontrar el turno de quien nunca tuvo
 *    uno asignado, NO como sanción por sí solo. Por eso `bloqueConocido` (la
 *    respuesta de RH) manda sobre cualquier deducción.
 *
 * 2. `checadas.tipo` VIENE NULL EN EL 100% DE LOS REGISTROS. El reloj graba el
 *    evento, no si es entrada o salida: se infiere de la primera y la última
 *    marca. Con una sola marca NO se sabe si es la entrada o la salida, así que
 *    ese día no entra en la deducción ni genera retardo. Es el 20% de los días.
 */

// ── Constantes de la regla (los umbrales entran por parámetro) ──
export const BOLSA_SEMANAL_MIN = 15;   // minutos de tolerancia acumulada por semana
export const PASO_REDONDEO_MIN = 30;   // los horarios de la empresa son en hora o media
// 0=domingo … 4=JUEVES. La semana de nómina corre JUEVES→MIÉRCOLES, igual que el
// ReporteSemMD.rpt que RH ya usa (columnas JUE VIE SÁB DOM LUN MAR MIÉ). Antes
// era 3 (miércoles); se alineó el 18/08/2026 para que el sistema y el papel den
// el mismo acumulado.
export const DIA_INICIO_SEMANA = 4;
/**
 * Dos lecturas separadas por menos de esto son la MISMA marca: el lector leyó el
 * dedo dos veces. Importa más de lo que parece: sin colapsarlas, un día en el
 * que la persona checó UNA vez y el lector la leyó dos parece un día completo
 * con salida cuatro minutos después de la entrada — y se le calcula retardo con
 * datos que no existen. Es el mismo umbral que `duplicadaMinutos` del detector.
 */
export const DUPLICADA_MIN = 5;

export type Hora = string | number;

/** Un día de trabajo tal como se necesita aquí: las horas del día, en crudo. */
export interface DiaCrudo {
  fecha: string;                 // 'yyyy-MM-dd'
  marcas: Array<Hora | null>;    // 'HH:MM' | 'HH:MM:SS' | minutos
}

export type TipoDia = 'sin_marca' | 'marca_faltante' | 'completo';

export interface DiaClasificado {
  fecha: string;
  tipo: TipoDia;
  marcas: number;                // marcas REALES, ya sin duplicados de lector
  entrada: number | null;
  salida: number | null;
  unica?: number;
  duplicadas?: number;           // cuántas lecturas se colapsaron
}

// ──────────────────────────────────────────────────────────────────
// Utilidades de hora. Todo se trabaja en MINUTOS DESDE MEDIANOCHE:
// las horas como texto invitan a errores de comparación ('9:05' < '10:00'
// es falso en orden lexicográfico).
// ──────────────────────────────────────────────────────────────────

/** 'HH:MM' o 'HH:MM:SS' -> minutos desde medianoche. null si no se entiende. */
export function aMinutos(hora: Hora | null | undefined): number | null {
  if (hora === null || hora === undefined) return null;
  if (typeof hora === 'number') return Number.isFinite(hora) ? hora : null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hora).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutos desde medianoche -> 'HH:MM'. */
export function aHora(minutos: number | null | undefined): string | null {
  if (minutos === null || minutos === undefined || !Number.isFinite(minutos)) return null;
  const m = ((Math.round(minutos) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Redondea al múltiplo de `paso` más cercano (empate hacia arriba). */
export function redondear30(minutos: number | null, paso = PASO_REDONDEO_MIN): number | null {
  if (minutos === null || !Number.isFinite(minutos)) return null;
  return Math.round(minutos / paso) * paso;
}

// ══════════════════════════════════════════════════════════════════
// LOS DOS CRITERIOS DE BLOQUE, Y CUÁL SE USA
//
// Los horarios de la empresa son en hora completa o media hora, así que toda
// entrada hay que llevarla a un bloque de 30 min. Hay dos maneras y NO coinciden
// entre el minuto :16 y el :25 (y en :45). Once minutos de cada hora.
//
//   `bloqueMasCercano`  — el que se USA por omisión. Gana la cercanía.
//                         09:22 -> 09:30 (llega 8 min antes)
//   `bloqueDeCostumbre` — sesgado al bloque temprano: hasta :25 es de la hora en
//                         punto. 09:22 -> 09:00 (llega 22 min tarde)
//
// Se usa el más cercano porque el sesgado se probó contra la realidad y falló:
// Una persona de Morelia acostumbra entrar 09:22 y su horario ES 09:30 —llega ocho
// minutos ANTES, todos los días—; el criterio sesgado le imputaba 116 minutos de
// retardo en 28 días. Y no se puede resolver con datos: quien tiene 09:00 y
// llega 09:22 produce EXACTAMENTE las mismas checadas que quien tiene 09:30 y
// llega 09:22. Así que en esa franja se elige el más cercano y se levanta
// `bloqueAmbiguo` para que RH lo confirme.
// ══════════════════════════════════════════════════════════════════

/** (A) Bloque al que pertenece una COSTUMBRE. Sesgado al bloque temprano. */
export function bloqueDeCostumbre(minutos: number | null): number | null {
  if (minutos === null || !Number.isFinite(minutos)) return null;
  const base = Math.floor(minutos / 60) * 60;
  const m = Math.round(minutos) - base;
  if (m <= 25) return base;
  if (m <= 44) return base + 30;
  return base + 60;
}

/** (B) Bloque de 30 min MÁS CERCANO. El empate (:15, :45) se va al de ABAJO. */
export function bloqueMasCercano(minutos: number | null, paso = PASO_REDONDEO_MIN): number | null {
  if (minutos === null || !Number.isFinite(minutos)) return null;
  return Math.ceil(Math.round(minutos) / paso - 0.5) * paso;
}

/**
 * Percentil por interpolación lineal, igual que `percentile_cont` de Postgres,
 * para que el número de aquí y el de una consulta SQL no se contradigan.
 */
export function percentil(valores: number[], p: number): number | null {
  const v = valores.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const pos = (v.length - 1) * p;
  const bajo = Math.floor(pos);
  const alto = Math.ceil(pos);
  if (bajo === alto) return v[bajo];
  return v[bajo] + (v[alto] - v[bajo]) * (pos - bajo);
}

// ──────────────────────────────────────────────────────────────────
// Semana laboral. La empresa corta en JUEVES (la semana va jueves→miércoles,
// como el reporte de RH). Se mantiene una sola definición para que el mismo
// trabajador no tenga dos acumulados distintos según qué pantalla se abra.
// ──────────────────────────────────────────────────────────────────

/** El JUEVES (inicio) de la semana a la que pertenece la fecha, 'yyyy-MM-dd'. */
export function inicioSemana(fecha: string, diaInicio = DIA_INICIO_SEMANA): string {
  const d = new Date(`${fecha}T12:00:00Z`);   // mediodía UTC: ningún huso corre el día
  const atras = (d.getUTCDay() - diaInicio + 7) % 7;
  return new Date(d.getTime() - atras * 86400000).toISOString().slice(0, 10);
}

/** Día de la semana (0=domingo) de 'yyyy-MM-dd'. */
export function diaSemana(fecha: string): number {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}

// ──────────────────────────────────────────────────────────────────
// 1) DEDUCIR EL HORARIO de una persona a partir de sus propias checadas.
// ──────────────────────────────────────────────────────────────────

/**
 * Colapsa lecturas repetidas del lector: dos marcas separadas por menos de
 * `duplicadaMin` son el mismo evento. Ver `DUPLICADA_MIN`.
 */
export function colapsarDuplicadas(minutos: number[], duplicadaMin = DUPLICADA_MIN): number[] {
  const v = minutos.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const m of v) {
    if (!out.length || m - out[out.length - 1] >= duplicadaMin) out.push(m);
  }
  return out;
}

/**
 * Clasifica un día por sus marcas. Aquí se decide qué es dato utilizable.
 *
 *   0 marcas -> 'sin_marca'      (posible falta; lo resuelve quien conoce el turno)
 *   1 marca  -> 'marca_faltante' (la persona SÍ vino, pero no se sabe si esa
 *                                 marca es la entrada o la salida: no se le
 *                                 calcula retardo ni entra en la deducción)
 *   2+       -> 'completo'       (entrada = primera, salida = última)
 *
 * La marca única no se descarta por rigor teórico: es el 20% de los días. Con
 * una sola marca, suponer que es la entrada le inventaría un retardo a quien
 * quizá solo olvidó marcar la salida.
 */
export function clasificarDia(dia: DiaCrudo, duplicadaMin = DUPLICADA_MIN): DiaClasificado {
  const crudas = (dia.marcas || []).map(aMinutos).filter((x): x is number => x !== null);
  const mins = colapsarDuplicadas(crudas, duplicadaMin);
  const duplicadas = crudas.length - mins.length;

  if (!mins.length) {
    return { fecha: dia.fecha, tipo: 'sin_marca', marcas: 0, entrada: null, salida: null, duplicadas };
  }
  if (mins.length === 1) {
    return {
      fecha: dia.fecha, tipo: 'marca_faltante', marcas: 1,
      entrada: null, salida: null, unica: mins[0], duplicadas,
    };
  }
  return {
    fecha: dia.fecha, tipo: 'completo', marcas: mins.length,
    entrada: mins[0], salida: mins[mins.length - 1], duplicadas,
  };
}

export interface OpcionesHorario {
  percentil?: number;
  minDias?: number;
  paso?: number;
  umbralDiaLaboral?: number;
  huecoMin?: number;
  minFraccion?: number;
  maxTurnos?: number;
  criterioBloque?: 'cercano' | 'costumbre';
  atipicoRotativoMin?: number;
  atipicoFijoMin?: number;
  duplicadaMin?: number;
  bolsaMin?: number;
  diaInicioSemana?: number;
  /** La respuesta de RH para un FIJO: manda sobre la deducción. */
  bloqueConocido?: string | number | null;
  /** La respuesta de RH para un ROTATIVO: sus turnos reales. */
  bloquesConocidos?: Array<string | number> | null;
}

export interface Grupo {
  centro: number;
  bloque: number | null;
  ambiguo: boolean;
  dias: number;
  min: number;
  max: number;
}

/**
 * Agrupa las entradas en TURNOS buscando HUECOS REALES entre ellas.
 *
 * Por hueco y no por dispersión: la dispersión (p75−p25) no distingue a quien
 * rota turnos de quien simplemente es errático. Alguien repartido entre 7:00 y
 * 8:30 tiene 90 min de dispersión y NO rota nada — es variabilidad, y
 * reasignarle bloque cada día le perdonaría el retardo. Quien, en cambio, entra
 * unos días ~07:50 y otros ~11:50: hay cuatro horas de VACÍO entre los dos
 * grupos, y eso sí son dos turnos.
 *
 * Un grupo cuenta como turno solo si reúne al menos `minFraccion` de los días:
 * dos madrugadas sueltas en dos meses no son un turno, son dos excepciones.
 */
export function agruparEntradas(entradas: number[], opciones: OpcionesHorario = {}): Grupo[] {
  const { huecoMin = 90, minFraccion = 0.2, criterioBloque = 'cercano' } = opciones;
  const aBloque = criterioBloque === 'costumbre' ? bloqueDeCostumbre : bloqueMasCercano;
  const v = entradas.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return [];

  const grupos: number[][] = [[v[0]]];
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] >= huecoMin) grupos.push([v[i]]);
    else grupos[grupos.length - 1].push(v[i]);
  }

  return grupos
    .filter((g) => g.length / v.length >= minFraccion)
    .map((g) => {
      const centro = percentil(g, 0.5) as number;
      return {
        centro,
        bloque: aBloque(centro),
        ambiguo: bloqueDeCostumbre(centro) !== bloqueMasCercano(centro),
        dias: g.length,
        min: g[0],
        max: g[g.length - 1],
      };
    });
}

export interface Clase {
  tipo: 'fijo' | 'rotativo' | 'sin_patron';
  bloques: number[];
  grupos: Grupo[];
  ambiguo: boolean;
  costumbre?: number | null;
  motivo: string | null;
}

/**
 * Clasifica a la persona en FIJO o ROTATIVO y devuelve su(s) bloque(s).
 *
 *   FIJO     -> un solo grupo relevante. Su bloque NO se reasigna nunca: todo se
 *               mide contra ese bloque. Llegar 7:35 con horario 7:00 son 35 min,
 *               no 5. La cercanía sirve para DESCUBRIR su horario, jamás para
 *               medir el día.
 *   ROTATIVO -> 2 o 3 grupos separados por huecos. Cada día se mide contra el
 *               turno más cercano, que es identificar el turno, no perdonar el
 *               retardo.
 *
 * Más de 3 grupos no es un rotativo: es alguien sin horario reconocible. Se
 * marca `sin_patron` para que nadie lo mida contra nada inventado.
 */
export function clasificarTrabajador(entradas: number[], opciones: OpcionesHorario = {}): Clase {
  const { maxTurnos = 3, criterioBloque = 'cercano' } = opciones;
  const aBloque = criterioBloque === 'costumbre' ? bloqueDeCostumbre : bloqueMasCercano;
  const grupos = agruparEntradas(entradas, opciones);

  if (!grupos.length) {
    return { tipo: 'sin_patron', bloques: [], grupos: [], ambiguo: false, motivo: 'sin entradas utilizables' };
  }

  if (grupos.length === 1) {
    // El bloque del fijo sale de TODAS sus entradas, no solo del grupo: los días
    // sueltos y lejanos ya quedaron fuera del grupo, y así no mueven su horario.
    const costumbre = percentil(entradas.filter(Number.isFinite), 0.5);
    const ambiguo = bloqueDeCostumbre(costumbre) !== bloqueMasCercano(costumbre);
    const bloque = aBloque(costumbre);
    return {
      tipo: 'fijo',
      bloques: bloque === null ? [] : [bloque],
      grupos, costumbre, ambiguo,
      motivo: ambiguo
        ? `su costumbre (${aHora(costumbre)}) cae entre dos bloques: puede ser ${aHora(bloqueDeCostumbre(costumbre))} llegando tarde o ${aHora(bloqueMasCercano(costumbre))} llegando antes. Confirmar con RH.`
        : null,
    };
  }

  if (grupos.length > maxTurnos) {
    return {
      tipo: 'sin_patron',
      bloques: grupos.map((g) => g.bloque).filter((b): b is number => b !== null),
      grupos,
      ambiguo: grupos.some((g) => g.ambiguo),
      motivo: `${grupos.length} grupos de entrada distintos: no hay un horario reconocible`,
    };
  }

  return {
    tipo: 'rotativo',
    bloques: grupos.map((g) => g.bloque).filter((b): b is number => b !== null),
    grupos,
    ambiguo: grupos.some((g) => g.ambiguo),
    motivo: `rota turnos: ${grupos.length} bloques (${grupos.map((g) => aHora(g.bloque)).join(', ')})`,
  };
}

export interface TurnoDelDia { bloque: number; distancia: number; atipico: boolean; }

/**
 * Para un ROTATIVO: a qué turno corresponde cada día, y a qué distancia quedó.
 * Un día que dista más de `atipicoRotativoMin` de TODOS sus turnos se marca
 * `atipico`: sigue contando (no se esconde un retardo real), pero queda
 * señalado; sin eso, un día a media tarde elegiría en silencio entre +120 y
 * −120 minutos de retardo.
 */
export function deducirTurnos(
  dias: DiaCrudo[], bloques: number[], opciones: OpcionesHorario = {}
): Map<string, TurnoDelDia> {
  const { atipicoRotativoMin = 60, duplicadaMin = DUPLICADA_MIN } = opciones;
  const salida = new Map<string, TurnoDelDia>();
  if (!bloques || !bloques.length) return salida;

  for (const d of (dias || []).map((x) => clasificarDia(x, duplicadaMin))) {
    if (d.tipo !== 'completo' || d.entrada === null) continue;
    // Se elige por cercanía a la ENTRADA REAL, no al bloque redondeado.
    let mejor = bloques[0];
    let dist = Math.abs(d.entrada - bloques[0]);
    for (const b of bloques.slice(1)) {
      const dd = Math.abs(d.entrada - b);
      if (dd < dist) { dist = dd; mejor = b; }
    }
    salida.set(d.fecha, { bloque: mejor, distancia: d.entrada - mejor, atipico: dist > atipicoRotativoMin });
  }
  return salida;
}

export interface HorarioDeducido {
  tipo: 'fijo' | 'rotativo' | 'sin_patron' | 'sin_datos';
  bloques: number[];
  turnos: (string | null)[];
  grupos: Array<{ turno: string | null; centro: string | null; centroMin: number; dias: number; desde: string | null; hasta: string | null; ambiguo: boolean }>;
  entrada: string | null;
  salida: string | null;
  entradaMin: number | null;
  salidaMin: number | null;
  entradaCruda: string | null;
  salidaCruda: string | null;
  desfaseMin: number | null;
  diasUsados: number;
  diasIgnorados: number;
  diasLaborales: number[];
  dispersionMin: number | null;
  bloqueAmbiguo: boolean;
  bloqueConfirmado: boolean;
  confiable: boolean;
  motivo: string | null;
}

/**
 * Deduce el horario de UNA persona: entrada, salida y qué días de la semana
 * trabaja, todo desde sus propias checadas.
 *
 * `umbralDiaLaboral` hace falta para poder decir "faltó": sin saber si el jueves
 * es su día de descanso, un jueves sin marcas no significa nada. Se cuenta sobre
 * las SEMANAS observadas, no sobre los días: con 4 semanas de datos, trabajar
 * 3 martes de 4 lo vuelve laborable; 1 de 4 no.
 */
export function deducirHorario(dias: DiaCrudo[], opciones: OpcionesHorario = {}): HorarioDeducido {
  const {
    percentil: p = 0.5, minDias = 5, paso = PASO_REDONDEO_MIN,
    umbralDiaLaboral = 0.5, duplicadaMin = DUPLICADA_MIN,
  } = opciones;

  const clasificados = (dias || []).map((d) => clasificarDia(d, duplicadaMin));
  const completos = clasificados.filter((d) => d.tipo === 'completo');

  const semanas = new Set(clasificados.map((d) => inicioSemana(d.fecha)));
  const semanasConDia = new Map<number, Set<string>>();
  for (const d of clasificados) {
    if (d.tipo === 'sin_marca') continue;
    const dow = diaSemana(d.fecha);
    if (!semanasConDia.has(dow)) semanasConDia.set(dow, new Set());
    semanasConDia.get(dow)!.add(inicioSemana(d.fecha));
  }
  const diasLaborales = [...semanasConDia.entries()]
    .filter(([, s]) => semanas.size > 0 && s.size / semanas.size >= umbralDiaLaboral)
    .map(([dow]) => dow)
    .sort();

  if (completos.length < minDias) {
    return {
      tipo: 'sin_datos', bloques: [], turnos: [], grupos: [],
      entrada: null, salida: null, entradaMin: null, salidaMin: null,
      entradaCruda: null, salidaCruda: null, desfaseMin: null,
      diasUsados: completos.length, diasIgnorados: clasificados.length - completos.length,
      diasLaborales, dispersionMin: null,
      bloqueAmbiguo: false, bloqueConfirmado: false, confiable: false,
      motivo: `solo ${completos.length} día(s) con entrada y salida; se necesitan ${minDias}`,
    };
  }

  const entradas = completos.map((d) => d.entrada as number);
  const salidas = completos.map((d) => d.salida as number);

  const clase = clasificarTrabajador(entradas, opciones);

  const entradaCruda = percentil(entradas, p);
  const salidaCruda = percentil(salidas, p);
  const dispersionMin = Math.round((percentil(entradas, 0.75) as number) - (percentil(entradas, 0.25) as number));

  // Un horario CONFIRMADO por RH manda sobre cualquier deducción: es la única
  // forma de resolver la franja ambigua sin adivinar (el caso de Morelia: 09:30).
  const conocido = aMinutos(opciones.bloqueConocido ?? null);
  const entradaMin = conocido !== null ? conocido : (clase.bloques.length ? clase.bloques[0] : null);
  // La salida es informativa (la tolerancia es solo de entrada).
  const salidaMin = bloqueMasCercano(salidaCruda, paso);

  return {
    tipo: clase.tipo,
    bloques: clase.bloques,
    turnos: clase.bloques.map(aHora),
    grupos: clase.grupos.map((g) => ({
      turno: aHora(g.bloque), centro: aHora(g.centro), centroMin: Math.round(g.centro),
      dias: g.dias, desde: aHora(g.min), hasta: aHora(g.max), ambiguo: !!g.ambiguo,
    })),
    entrada: aHora(entradaMin),
    salida: aHora(salidaMin),
    entradaMin, salidaMin,
    entradaCruda: aHora(entradaCruda),
    salidaCruda: aHora(salidaCruda),
    desfaseMin: entradaMin === null || entradaCruda === null ? null : Math.round(entradaCruda - entradaMin),
    diasUsados: completos.length,
    diasIgnorados: clasificados.length - completos.length,
    diasLaborales,
    dispersionMin,
    bloqueAmbiguo: conocido !== null ? false : !!clase.ambiguo,
    bloqueConfirmado: conocido !== null,
    // "Confiable" = un solo horario describe a esta persona. Para el rotativo es
    // false a propósito: no es que el dato sea malo, es que UNA hora no la
    // describe (y por eso se le miden turnos, no una hora).
    confiable: clase.tipo === 'fijo',
    motivo: clase.motivo,
  };
}

// ──────────────────────────────────────────────────────────────────
// 2 y 3) BOLSA SEMANAL Y RETARDO REAL = SOLO EL EXCEDENTE.
// ──────────────────────────────────────────────────────────────────

/**
 * `justificado` es una falta que RH APROBÓ con un justificante (vacaciones,
 * incapacidad, permiso). No lo pone este módulo —aquí no se sabe nada de
 * justificantes—: lo aplica `asistencia-personas.ts` al cruzar los días con
 * `asistencia_revision`. Vive en el tipo para que nadie tenga que inventarse
 * un séptimo estado por su cuenta.
 */
export type EstadoDia = 'a_tiempo' | 'absorbido' | 'retardo' | 'falta' | 'descanso' | 'marca_faltante' | 'justificado';

export interface DiaMedido {
  fecha: string;
  estado: EstadoDia;
  entrada?: string | null;
  salida?: string | null;
  hora?: string | null;          // la marca única, cuando el día es 'marca_faltante'
  referencia?: string | null;    // contra qué se midió
  atrasoMin: number;
  absorbidoMin: number;
  retardoRealMin: number;
  bolsaAntes: number;
  bolsaDespues: number;
  atipico?: boolean;
  marcas?: number;
  /**
   * Descanso que se TOMÓ en un día que normalmente trabaja: faltó, pero esa
   * semana todavía le quedaba un descanso por usar (ver `descansosDeLaSemana`).
   */
  descansoPorAusencia?: boolean;
  /** Ese día RH capturó "Horario distinto": `referencia` es la hora de ese día. */
  horarioDistinto?: boolean;
}

export interface SemanaMedida {
  inicio: string;
  bolsaInicial: number;
  bolsaRestante: number;
  atrasoMin: number;
  retardoRealMin: number;
  bolsaAgotada: boolean;
  dias: DiaMedido[];
}

export interface Retardos {
  semanas: SemanaMedida[];
  retardoRealMin: number;
  atrasoMin: number;
  absorbidoMin: number;
  diasEvaluados: number;
  diasConRetardo: number;
  faltas: number;
  marcasFaltantes: number;
  atipicos: number;
  semanasConRetardo: number;
}

export interface OpcionesRetardo extends OpcionesHorario {
  entradaMin?: number | null;
  diasLaborales?: number[] | null;
  turnoPorFecha?: Map<string, TurnoDelDia> | null;
  /**
   * Por semana (su clave de inicio), cuántos días SIN MARCAS tuvo la persona
   * ANTES del primer día que se está midiendo. Cuando el periodo corta la
   * semana, esos días ya gastaron descansos que aquí no se ven.
   */
  ausenciasPrevias?: Map<string, number> | null;
  /**
   * HORARIO DISTINTO por día (fecha → minuto de entrada), capturado por RH:
   * ese día el retardo se mide contra esa hora y no contra su turno.
   */
  horarioDelDia?: Map<string, number> | null;
  /**
   * false = la plaza no tiene hora límite de entrada (sucursales): los días
   * con marcas salen "a tiempo" sin atraso, ni tolerancia, ni día atípico.
   * Faltas y descansos se calculan igual.
   */
  medirRetardo?: boolean;
}

/**
 * ══ UNA FALTA PUEDE SER SU DÍA DE DESCANSO (26/09/2026, regla de RH) ══
 *
 * Antes el descanso era FIJO por día de la semana: si la persona trabaja de
 * lunes a sábado, el domingo es descanso y un martes sin marcas es falta —
 * aunque esa semana haya trabajado el domingo—. Y a quien le rota el descanso
 * le iba peor: trabaja cada día de la semana en más de la mitad de las semanas,
 * todos salían "laborables", y CADA descanso suyo se contaba como falta.
 *
 * Ahora cada persona tiene un número de descansos POR SEMANA: los días que
 * normalmente no trabaja (tienda lun-sáb: 1; corporativo lun-vie: 2), y nunca
 * menos de 1. Los días sin marcas de la semana se reparten así:
 *   1. primero sus días de descanso habituales (el domingo de la tienda);
 *   2. si todavía le quedan descansos, las ausencias en días laborables, en
 *      orden, pasan a ser descanso;
 *   3. las que sobren, esas sí son falta.
 *
 * El orden importa: si la tienda faltó el viernes y descansó el domingo, la
 * falta es el viernes, no el domingo. Al revés, la pestaña de "faltas fuera
 * de domingo" se quedaría vacía teniendo una falta real.
 */
export function descansosDeLaSemana(diasLaborales: number[] | null | undefined): number {
  if (!diasLaborales) return 1;
  return Math.max(1, 7 - diasLaborales.length);
}

/**
 * Calcula el retardo real de una persona semana por semana.
 *
 * La bolsa arranca en `bolsaMin` cada semana. Cada día se ABSORBE del atraso lo
 * que quepa en el saldo; lo que no cabe es retardo real. No es "a partir del
 * minuto 16 cuenta todo": cuenta solo el excedente.
 *
 *   Bolsa 15 · Lun +6 (bolsa 9) · Mar +6 (bolsa 3) · Mié +6 (absorbe 3,
 *   retardo real 3, bolsa 0) · Jue +5 (retardo real 5)  ->  8 min en la semana.
 *
 * La tolerancia es SOLO DE ENTRADA. Salir temprano se mide aparte y no compite
 * por estos 15 minutos.
 */
export function retardosPorSemana(dias: DiaCrudo[], opciones: OpcionesRetardo = {}): Retardos {
  const {
    entradaMin, bolsaMin = BOLSA_SEMANAL_MIN,
    diasLaborales = null, diaInicioSemana = DIA_INICIO_SEMANA,
    turnoPorFecha = null, atipicoFijoMin = 120, duplicadaMin = DUPLICADA_MIN,
    ausenciasPrevias = null, medirRetardo = true, horarioDelDia = null,
  } = opciones;
  const descansosSemana = descansosDeLaSemana(diasLaborales);

  if (!turnoPorFecha && (entradaMin === null || entradaMin === undefined || !Number.isFinite(entradaMin))) {
    throw new Error('retardosPorSemana necesita entradaMin, o turnoPorFecha para un rotativo.');
  }

  // Agrupado por semana, y cada semana con sus días en orden: la bolsa se gasta
  // cronológicamente.
  const porSemana = new Map<string, DiaClasificado[]>();
  for (const dia of (dias || [])) {
    const c = clasificarDia(dia, duplicadaMin);
    const clave = inicioSemana(c.fecha, diaInicioSemana);
    if (!porSemana.has(clave)) porSemana.set(clave, []);
    porSemana.get(clave)!.push(c);
  }

  const semanas: SemanaMedida[] = [];
  let retardoRealTotal = 0, atrasoTotal = 0, absorbidoTotal = 0;
  let diasConRetardo = 0, faltas = 0, marcasFaltantes = 0, diasEvaluados = 0, atipicos = 0;

  for (const clave of [...porSemana.keys()].sort()) {
    const delaSemana = porSemana.get(clave)!.sort((a, b) => a.fecha.localeCompare(b.fecha));
    let bolsa = bolsaMin;   // ← se reinicia aquí, en cada semana
    const detalle: DiaMedido[] = [];
    let atrasoSem = 0, retardoSem = 0;

    // Qué ausencias de esta semana caben como descanso (ver descansosDeLaSemana).
    const esLaboralF = (f: string) => !diasLaborales || diasLaborales.includes(diaSemana(f));
    const sinMarca = delaSemana.filter((d) => d.tipo === 'sin_marca');
    const habituales = sinMarca.filter((d) => !esLaboralF(d.fecha));
    const enLaborable = sinMarca.filter((d) => esLaboralF(d.fecha));
    const quedan = Math.max(0,
      descansosSemana - (ausenciasPrevias?.get(clave) || 0) - habituales.length);
    const descansoTomado = new Set(enLaborable.slice(0, quedan).map((d) => d.fecha));

    for (const d of delaSemana) {
      const esLaboral = esLaboralF(d.fecha);

      if (d.tipo === 'sin_marca') {
        // Cero marcas: su descanso habitual, un descanso que se tomó en día
        // laborable (le quedaba uno esa semana), o falta. En ningún caso suma
        // minutos de retardo.
        const tomado = esLaboral && descansoTomado.has(d.fecha);
        const esFalta = esLaboral && !tomado;
        if (esFalta) faltas++;
        detalle.push({
          fecha: d.fecha, estado: esFalta ? 'falta' : 'descanso',
          atrasoMin: 0, absorbidoMin: 0, retardoRealMin: 0,
          bolsaAntes: bolsa, bolsaDespues: bolsa, marcas: 0,
          ...(tomado ? { descansoPorAusencia: true } : {}),
        });
        continue;
      }

      if (d.tipo === 'marca_faltante') {
        // Vino, pero falta una marca: no se sabe si la única es entrada o
        // salida. Se reporta para que RH lo resuelva; NO se calcula retardo
        // con datos incompletos.
        marcasFaltantes++;
        detalle.push({
          fecha: d.fecha, estado: 'marca_faltante', hora: aHora(d.unica ?? null),
          atrasoMin: 0, absorbidoMin: 0, retardoRealMin: 0,
          bolsaAntes: bolsa, bolsaDespues: bolsa, marcas: 1,
        });
        continue;
      }

      // La referencia del día: su turno (rotativo) o su bloque fijo.
      const t = turnoPorFecha ? turnoPorFecha.get(d.fecha) : null;
      const suTurno = t ? t.bloque : (entradaMin as number);
      if (suTurno === null || suTurno === undefined) continue;

      // ══ CONTRA SU PROPIO TURNO, SIN HORA LÍMITE (28/09/2026, regla de RH) ══
      //
      // Hay quien entra en turno de tarde. Antes, un día que caía lejos de TODOS
      // sus turnos (más de `atipicoFijoMin` / 60 min en un rotativo) se medía
      // igual contra su turno de siempre y se marcaba "fuera de horario": quien
      // entra 8:00 y un día entró a cubrir la tarde a las 14:10 cargaba 370 min
      // de retardo. Ahora ese día se entiende como OTRO TURNO y se mide contra
      // el bloque de :00/:30 más cercano a su entrada (14:10 → 14:00 → 10 min).
      // Dentro del margen se sigue midiendo contra su turno de siempre.
      const lejos = t ? !!t.atipico : Math.abs((d.entrada as number) - suTurno) > atipicoFijoMin;
      // RH dijo que ese día entró en otro horario: manda sobre todo lo demás.
      const delDia = horarioDelDia?.get(d.fecha);
      const referencia = delDia !== undefined ? delDia
        : lejos ? (bloqueMasCercano(d.entrada as number) as number) : suTurno;

      // `medirRetardo: false` apaga el retardo en una plaza (hoy ninguna lo usa).
      const atraso = medirRetardo ? Math.max(0, (d.entrada as number) - referencia) : 0;
      const absorbido = Math.min(atraso, bolsa);
      const real = atraso - absorbido;
      const bolsaAntes = bolsa;
      bolsa -= absorbido;

      // Ya no hay "fuera de horario": entrar en otro turno no es una anomalía.
      const atipico = false;

      diasEvaluados++;
      atrasoSem += atraso; retardoSem += real;
      atrasoTotal += atraso; absorbidoTotal += absorbido; retardoRealTotal += real;
      if (real > 0) diasConRetardo++;
      if (atipico) atipicos++;

      detalle.push({
        fecha: d.fecha,
        estado: real > 0 ? 'retardo' : atraso > 0 ? 'absorbido' : 'a_tiempo',
        entrada: aHora(d.entrada), salida: aHora(d.salida),
        referencia: aHora(referencia),
        atrasoMin: atraso, absorbidoMin: absorbido, retardoRealMin: real,
        bolsaAntes, bolsaDespues: bolsa, atipico, marcas: d.marcas,
        ...(delDia !== undefined ? { horarioDistinto: true } : {}),
      });
    }

    semanas.push({
      inicio: clave,
      bolsaInicial: bolsaMin,
      bolsaRestante: bolsa,
      atrasoMin: atrasoSem,
      retardoRealMin: retardoSem,
      bolsaAgotada: bolsa === 0,
      dias: detalle,
    });
  }

  return {
    semanas,
    retardoRealMin: retardoRealTotal,
    atrasoMin: atrasoTotal,
    absorbidoMin: absorbidoTotal,
    diasEvaluados, diasConRetardo, faltas, marcasFaltantes, atipicos,
    semanasConRetardo: semanas.filter((s) => s.retardoRealMin > 0).length,
  };
}

export interface AnalisisPersona {
  horario: HorarioDeducido;
  retardos: Retardos | null;
  turnoPorFecha: Map<string, TurnoDelDia> | null;
  motivo: string | null;
}

/**
 * Todo junto para una persona: deduce su horario y con ÉSE calcula sus retardos.
 * Si no se pudo deducir, no se inventa nada: horario con `confiable:false` y sin
 * retardos.
 */
export function analizarPersona(dias: DiaCrudo[], opciones: OpcionesHorario = {}): AnalisisPersona {
  const horario = deducirHorario(dias, opciones);
  if (horario.entradaMin === null) {
    return { horario, retardos: null, turnoPorFecha: null, motivo: horario.motivo };
  }

  // La única diferencia entre los dos tipos de trabajador:
  //   · FIJO     -> una sola referencia para todos sus días. Llegar 7:35 con
  //                 horario 7:00 son 35 min: no se le reasigna bloque.
  //   · ROTATIVO -> una referencia POR DÍA, la de su turno de ese día.
  // La bolsa semanal es la misma en ambos casos.
  const turnoPorFecha = horario.tipo === 'rotativo'
    ? deducirTurnos(
        dias,
        opciones.bloquesConocidos
          ? opciones.bloquesConocidos.map((x) => aMinutos(x)).filter((x): x is number => x !== null)
          : horario.bloques,
        opciones
      )
    : null;

  const retardos = retardosPorSemana(dias, {
    ...opciones,
    entradaMin: horario.entradaMin,
    turnoPorFecha,
    bolsaMin: opciones.bolsaMin ?? BOLSA_SEMANAL_MIN,
    diasLaborales: horario.diasLaborales,
    diaInicioSemana: opciones.diaInicioSemana ?? DIA_INICIO_SEMANA,
    atipicoFijoMin: opciones.atipicoFijoMin ?? 120,
  });
  return { horario, retardos, turnoPorFecha, motivo: null };
}

/**
 * Cuánto retardo le saldría a esta persona SI su horario fuera `turno`.
 * Es el número que convierte una duda en una pregunta contestable: en vez de
 * "¿su horario es 09:00 o 09:30?", se muestra qué cambia.
 */
export function impactoDeOpcion(
  dias: DiaCrudo[], turno: string,
  ctx: { base?: string[] | null; original?: string | null } = {}
) {
  const { base = null, original = null } = ctx;
  const opciones: OpcionesHorario = base && base.length > 1
    ? { minDias: 5, bloquesConocidos: base.map((b) => (b === original ? turno : b)) }
    : { minDias: 5, bloqueConocido: turno };
  const r = analizarPersona(dias, opciones).retardos;
  return {
    turno,
    retardoRealMin: r ? r.retardoRealMin : null,
    diasConRetardo: r ? r.diasConRetardo : null,
    atrasoBrutoMin: r ? r.atrasoMin : null,
  };
}
