import { EntradaDia, Inconsistencia, ChecadaMin, Severidad } from './tipos';
import { DUPLICADA_MIN } from './horario-deducido';

/**
 * Fase RH · `[RH.1.5]` — copia TEXTUAL de `mega-talento-90/api/src/agente-horarios/reglas.ts`
 * @ 2030086 (2026-09-28), más la corrección del desayuno de 14c2b60 y 091ea65 (08/10/2026, `[RH.1.5b]`,
 * en `reglaDesayunoExcedido`). Ver la procedencia en `horario-deducido.ts`. Lo único que cambió es
 * el tipado de la evidencia (`unknown` en vez de `any`, regla de lint de la Suite).
 *
 * MOTOR DE DETECCIÓN — lógica PURA (sin DB, sin Express). Testeable directo:
 * dado (checadas + horario + config) de UN empleado-día, devuelve las
 * inconsistencias. No decide nada de negocio (no aprueba ni notifica): solo
 * detecta y describe. Los umbrales vienen SIEMPRE de `entrada.config`.
 *
 * Sobre el tipo de checada: el reloj ZKTeco manda `tipo`
 *   0=Entrada, 1=Salida, 2=Salida a comer, 3=Regreso.
 * Cuando viene nulo, se infiere por orden (1ª marca=entrada, última=salida) y se
 * marca `inferido:true` en la evidencia para que RH sepa que es aproximado.
 */

// ---------- utilidades de tiempo (minutos desde medianoche) ----------
function minDeHora(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hhmm).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function minDeFechaHora(fechaHora: string): number | null {
  const m = /T(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(fechaHora || ''));
  if (!m) return minDeHora(fechaHora); // por si viniera solo 'HH:mm:ss'
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function hhmm(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------- clasificación entrada/salida ----------
function hayTipos(checadas: ChecadaMin[]): boolean {
  return checadas.some((c) => c.tipo !== null && c.tipo !== undefined);
}
/** Minuto de la PRIMERA entrada del día (tipo=0, o 1ª marca si no hay tipos). */
function primeraEntradaMin(checadas: ChecadaMin[]): number | null {
  if (!checadas.length) return null;
  if (hayTipos(checadas)) {
    const ent = checadas.filter((c) => c.tipo === 0);
    if (!ent.length) return null;
    return Math.min(...ent.map((c) => minDeFechaHora(c.fechaHora) ?? Infinity));
  }
  return minDeFechaHora(checadas[0].fechaHora);
}

function severidadPorMinutos(min: number): Severidad {
  if (min < 15) return 'baja';
  if (min < 30) return 'media';
  return 'alta';
}

// Cada checada como {min, hora, tipo} ya ordenada.
interface Marca { min: number; hora: string; tipo: number | null; }
function aMarcas(checadas: ChecadaMin[]): Marca[] {
  return checadas
    .map((c) => ({ min: minDeFechaHora(c.fechaHora) ?? -1, hora: c.hora, tipo: c.tipo ?? null }))
    .filter((m) => m.min >= 0)
    .sort((a, b) => a.min - b.min);
}

// =====================================================================
// REGLAS INDIVIDUALES — cada una devuelve Inconsistencia | null (o varias).
// =====================================================================

/** Regla 5a: RETARDO — primera entrada más tarde que (entrada + tolerancia). */
function reglaRetardo(e: EntradaDia): Inconsistencia | null {
  const { horario, config, checadas } = e;
  if (!horario) return null;
  const entradaEsperada = minDeHora(horario.entrada);
  const entradaReal = primeraEntradaMin(checadas);
  if (entradaEsperada == null || entradaReal == null) return null;
  const tol = config.toleranciaRetardoMin != null
    ? config.toleranciaRetardoMin
    : (config.usarToleranciaHorario ? (horario.toleranciaMin || 0) : 0);
  const retardo = entradaReal - (entradaEsperada + tol);
  if (retardo <= 0) return null;
  const minutosTarde = entradaReal - entradaEsperada;
  return {
    regla: 'retardo',
    severidad: severidadPorMinutos(minutosTarde),
    detalle: `Entró ${hhmm(entradaReal)}; turno ${horario.entrada} (tolerancia ${tol} min). Retardo de ${minutosTarde} min.`,
    evidencia: {
      entradaReal: hhmm(entradaReal), entradaEsperada: horario.entrada,
      toleranciaMin: tol, minutosRetardo: minutosTarde,
      horario: horario.nombre, horarioAmbiguo: !!horario.ambiguo,
    },
    justificacionSugerida: `Retardo de ${minutosTarde} min. Confirmar motivo con el empleado (posibles: Tráfico, Personal, Permiso).`,
  };
}

/** Regla 5b: FALTA — día laborable (según el turno) sin ninguna checada. */
function reglaFalta(e: EntradaDia): Inconsistencia | null {
  const { horario, config, checadas, diaSemana, cerrado } = e;
  if (!config.marcarFaltas || !horario) return null;
  if (!horario.dias.includes(diaSemana)) return null; // no era día laborable
  if (config.soloDiasCerrados && !cerrado) return null;
  if (checadas.length > 0) return null;
  // Anti-ruido: si no checó NADA en todo el rango, no lo tratamos como falta
  // diaria (probablemente no trabajó ese periodo o no hay datos del reloj).
  if (config.faltaSoloConActividadEnRango && !e.empleadoConActividadRango) return null;
  return {
    regla: 'falta',
    severidad: 'alta',
    detalle: `Sin checadas en día laborable (turno ${horario.nombre}, ${horario.entrada}-${horario.salida}).`,
    evidencia: { horario: horario.nombre, entradaEsperada: horario.entrada, salidaEsperada: horario.salida, horarioAmbiguo: !!horario.ambiguo },
    justificacionSugerida: 'Posible falta. Verificar incapacidad, permiso o vacaciones antes de aplicar.',
  };
}

/** Regla 2: CHECADAS DUPLICADAS — dos marcas separadas por <= duplicadaMinutos. */
function reglaDuplicada(e: EntradaDia): Inconsistencia | null {
  const marcas = aMarcas(e.checadas);
  const pares: Array<{ a: string; b: string; diffMin: number }> = [];
  for (let i = 1; i < marcas.length; i++) {
    const diff = marcas[i].min - marcas[i - 1].min;
    if (diff <= e.config.duplicadaMinutos) {
      pares.push({ a: marcas[i - 1].hora, b: marcas[i].hora, diffMin: diff });
    }
  }
  if (!pares.length) return null;
  return {
    regla: 'checada_duplicada',
    severidad: 'baja',
    detalle: `${pares.length} par(es) de checadas muy cercanas (<= ${e.config.duplicadaMinutos} min): ${pares.map((p) => `${p.a}~${p.b}`).join(', ')}.`,
    evidencia: { pares, umbralMin: e.config.duplicadaMinutos },
    justificacionSugerida: 'Probable doble marca en el reloj. Confirmar y descartar la duplicada.',
  };
}

/** Regla 1: MÚLTIPLES ENTRADAS — dos entradas (tipo=0) separadas > saltoEntradasHoras. */
function reglaMultiplesEntradas(e: EntradaDia): Inconsistencia | null {
  if (!hayTipos(e.checadas)) return null; // sin `tipo` no se puede distinguir de comida/salida
  const entradas = aMarcas(e.checadas.filter((c) => c.tipo === 0));
  if (entradas.length < 2) return null;
  const salto = entradas[entradas.length - 1].min - entradas[0].min;
  if (salto <= e.config.saltoEntradasHoras * 60) return null;
  return {
    regla: 'multiples_entradas',
    severidad: 'media',
    detalle: `${entradas.length} entradas el mismo día, separadas ${Math.round(salto / 60 * 10) / 10} h (umbral ${e.config.saltoEntradasHoras} h): ${entradas.map((m) => m.hora).join(', ')}.`,
    evidencia: { entradas: entradas.map((m) => m.hora), horasSalto: Math.round(salto / 60 * 10) / 10, umbralHoras: e.config.saltoEntradasHoras },
    justificacionSugerida: 'Varias entradas en el día. Verificar si trabajó doble turno o si es marca errónea.',
  };
}

/** Regla 3: ENTRADA SIN SALIDA (o viceversa) al cerrar el día. */
function reglaEntradaSinSalida(e: EntradaDia): Inconsistencia | null {
  const { checadas, config, cerrado } = e;
  if (config.soloDiasCerrados && !cerrado) return null;
  if (!checadas.length) return null;
  const marcas = aMarcas(checadas);

  if (hayTipos(checadas)) {
    const nEnt = checadas.filter((c) => c.tipo === 0).length;
    const nSal = checadas.filter((c) => c.tipo === 1).length;
    if (nEnt > 0 && nSal === 0) {
      return {
        regla: 'entrada_sin_salida', severidad: 'media',
        detalle: `Marcó entrada (${marcas[0].hora}) pero no hay salida registrada.`,
        evidencia: { entradas: nEnt, salidas: nSal, marcas: marcas.map((m) => m.hora), inferido: false },
        justificacionSugerida: 'Falta marcar salida. Probable olvido de checada; confirmar hora real de salida.',
      };
    }
    if (nSal > 0 && nEnt === 0) {
      return {
        regla: 'salida_sin_entrada', severidad: 'media',
        detalle: `Hay salida (${marcas[marcas.length - 1].hora}) pero no se registró entrada.`,
        evidencia: { entradas: nEnt, salidas: nSal, marcas: marcas.map((m) => m.hora), inferido: false },
        justificacionSugerida: 'Falta marcar entrada. Probable olvido de checada; confirmar hora real de entrada.',
      };
    }
    return null;
  }

  // Sin tipos: número IMPAR de marcas => una entrada/salida quedó sin par.
  if (marcas.length % 2 === 1) {
    return {
      regla: 'entrada_sin_salida', severidad: 'media',
      detalle: `Número impar de checadas (${marcas.length}): ${marcas.map((m) => m.hora).join(', ')}. Falta una marca (probable salida).`,
      evidencia: { marcas: marcas.map((m) => m.hora), inferido: true },
      justificacionSugerida: 'Marca sin par (el reloj no envió tipo). Confirmar entrada/salida faltante.',
    };
  }
  return null;
}

/** Regla 4: FUERA DE TURNO — checada fuera de [entrada - X, salida + X]. */
function reglaFueraDeTurno(e: EntradaDia): Inconsistencia | null {
  const { horario, config, checadas } = e;
  if (!horario) return null;
  const entMin = minDeHora(horario.entrada);
  const salMin = minDeHora(horario.salida);
  if (entMin == null || salMin == null) return null;
  const desde = entMin - config.ventanaFueraTurnoMin;
  const hasta = salMin + config.ventanaFueraTurnoMin;
  const fuera = aMarcas(checadas).filter((m) => m.min < desde || m.min > hasta);
  if (!fuera.length) return null;
  return {
    regla: 'fuera_de_turno',
    severidad: 'media',
    detalle: `${fuera.length} checada(s) fuera del turno (${horario.entrada}-${horario.salida} ±${config.ventanaFueraTurnoMin} min): ${fuera.map((m) => m.hora).join(', ')}.`,
    evidencia: {
      fuera: fuera.map((m) => m.hora), ventanaMin: config.ventanaFueraTurnoMin,
      turno: `${horario.entrada}-${horario.salida}`, horario: horario.nombre, horarioAmbiguo: !!horario.ambiguo,
    },
    justificacionSugerida: 'Checadas fuera del horario asignado. Verificar tiempo extra o turno equivocado.',
  };
}

/**
 * Regla 6: DESAYUNO EXCEDIDO.
 *
 * ══ CUÁL DE LAS PAUSAS ES EL DESAYUNO ══
 *
 * Un día puede tener varias pausas. La primera y la última marca son la jornada;
 * las de en medio se emparejan salida→regreso. El desayuno es la PRIMERA pausa
 * emparejada que empieza antes de `desayunoHastaHora`.
 *
 * Se identifica por HORA y no por orden a propósito. Por orden parecería más
 * simple —"la pausa #1"— pero 25 de 139 días de corporativo tienen su primera
 * pausa después del mediodía: son personas que ese día solo comieron. Cobrarles
 * la comida contra el tope del desayuno sería marcar a quien no hizo nada malo.
 *
 * ══ UNA PAUSA SIN REGRESO NO CUENTA ══
 *
 * Si alguien marca salida y no hay regreso, no se sabe si se fue a desayunar dos
 * horas o si el lector no leyó el regreso. Medir contra el final del día sería
 * inventar. Se ignora aquí igual que en el cálculo de horas netas.
 *
 * ══ OJO CON EL ALCANCE (medido el 27/08/2026) ══
 *
 * En corporativo hay dos pausas reales (desayuno ~11:00 de 25 min y comida
 * ~15:00) y la regla mide lo que se quiso medir: 77 excesos de 224 desayunos.
 *
 * En las SUCURSALES no hay desayuno: el 96-100% de sus días tienen UNA SOLA
 * pausa, y es su comida. Donde esa pausa cae antes de las 13:00 —morelia-abastos
 * a las 11:22 con 59 min de mediana— esta regla la trata como un desayuno de una
 * hora y marca a la plaza entera: 192 de 208 días. Se implementó así porque es
 * la política que dio RH (25 corporativo / 30 el resto), pero si morelia resulta
 * ser una excepción, se apaga por sucursal sin tocar código:
 *
 *     INSERT INTO asistencia_config (sucursal_id, config) VALUES
 *       ('morelia-abastos', '{"reglasActivas":{"desayuno_excedido":false}}')
 *       ON CONFLICT (sucursal_id) DO UPDATE SET config = ...;
 */
function reglaDesayunoExcedido(e: EntradaDia): Inconsistencia | null {
  const { config } = e;
  const tope = config.desayunoTopeMin;
  if (!(tope > 0)) return null;
  const corte = minDeHora(config.desayunoHastaHora);
  if (corte == null) return null;

  // `[RH.1.5b]` (Mega Talento 14c2b60 y 091ea65, 08/10/2026). Dos cosas, las dos para decir lo mismo que la
  // pantalla (`detalle-dia.ts`):
  //  · Las lecturas repetidas del lector (a menos de DUPLICADA_MIN) son UNA sola, como en
  //    `colapsarDuplicadas`. Sin esto, una entrada marcada dos veces (07:29 y 07:29) se volvía «pausa» y la
  //    alerta decía «desayuno de 116 min (07:29–09:25)».
  //  · Con UNA sola pausa, esa pausa es la comida: el desayuno sólo existe si el día trae dos. Allá esta regla
  //    sola generaba 553 de las 584 alertas de desayuno excedido de un mes, todas comidas de tienda.
  const marcas = aMarcas(e.checadas).reduce<Marca[]>((out, m) => {
    if (!out.length || m.min - out[out.length - 1].min >= DUPLICADA_MIN) out.push(m);
    return out;
  }, []);
  if (marcas.length < 4) return null;            // sin jornada + una pausa entera
  const medio = marcas.slice(1, -1);
  if (Math.floor(medio.length / 2) < 2) return null;

  let pausa: { ini: Marca; fin: Marca } | null = null;
  for (let i = 0; i + 1 < medio.length; i += 2) {
    if (medio[i].min < corte) { pausa = { ini: medio[i], fin: medio[i + 1] }; break; }
  }
  if (!pausa) return null;                       // solo comió: no hay desayuno que medir

  const duracion = pausa.fin.min - pausa.ini.min;
  // Un "desayuno" de dos horas o más no es un desayuno: es una marca perdida.
  // Ver desayunoMaxPlausibleMin en tipos.ts.
  if (duracion > config.desayunoMaxPlausibleMin) return null;
  const exceso = duracion - tope;
  if (exceso < config.desayunoAlertaMin) return null;

  return {
    regla: 'desayuno_excedido',
    severidad: severidadPorMinutos(exceso),
    detalle: `Desayuno de ${duracion} min (${hhmm(pausa.ini.min)}–${hhmm(pausa.fin.min)}); ` +
             `el tope es ${tope} min. Se excedió ${exceso} min.`,
    evidencia: {
      salida: pausa.ini.hora, regreso: pausa.fin.hora,
      duracionMin: duracion, topeMin: tope, excesoMin: exceso,
      umbralAlertaMin: config.desayunoAlertaMin,
    },
    justificacionSugerida:
      `Desayuno ${exceso} min por encima del tope de ${tope}. Confirmar con el empleado ` +
      '(posibles: fila en el comedor, permiso del jefe, marca tardía al regresar).',
  };
}

/**
 * Punto de entrada del motor: aplica todas las reglas activas a un empleado-día.
 * Devuelve las inconsistencias encontradas (puede ser vacío).
 */
export function analizarDia(e: EntradaDia): Inconsistencia[] {
  const activas = e.config.reglasActivas;
  const salida: Inconsistencia[] = [];
  const push = (r: Inconsistencia | null) => { if (r) salida.push(r); };

  if (activas.falta) push(reglaFalta(e));
  // Si es falta (sin checadas), las demás reglas no aplican.
  if (!e.checadas.length) return salida;

  // Sin hora límite (sucursales, ver `medirRetardo`) no hay retardo ni
  // "fuera de turno" que alertar: entrar tarde puede ser su turno.
  const conHorario = e.config.medirRetardo !== false;
  if (activas.retardo && conHorario) push(reglaRetardo(e));
  if (activas.checada_duplicada) push(reglaDuplicada(e));
  if (activas.multiples_entradas) push(reglaMultiplesEntradas(e));
  if (activas.entrada_sin_salida) push(reglaEntradaSinSalida(e));
  if (activas.fuera_de_turno && conHorario) push(reglaFueraDeTurno(e));
  if (activas.desayuno_excedido) push(reglaDesayunoExcedido(e));

  return salida;
}
