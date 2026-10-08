/**
 * Tipos del Agente de Horarios (Fase 1).
 * Dominio puro: NO importa Express ni pg. Se usa en reglas.ts (lógica testeable).
 *
 * Fase RH · `[RH.1.5]` — copia de `mega-talento-90/api/src/agente-horarios/tipos.ts` @ 63de029.
 * Cambios: `any` → `unknown` en la evidencia; los nombres de empleados de los comentarios se
 * quitaron (este repositorio es público). `esPromotora` queda igual, pero en la Suite su
 * `es_promotora` llega siempre vacío y manda el departamento de la persona
 * (`identity.users.department_code` + el nombre del departamento): la marca manual de Mega
 * Talento no se trae, porque su propia nota dice que derivaba (51 personas sin marcar el
 * 27/08) y el departamento ya era la segunda fuente que la corregía.
 */

/**
 * ¿Esta ficha es de una PROMOTORA?
 *
 * Una promotora no checa como el personal de planta: anda entre plazas y marca
 * donde le toca ese día. Medida con la misma vara sale con falta a diario, así
 * que va en su propia pantalla y fuera de la detección de alertas.
 *
 * ══ POR QUÉ TAMBIÉN SE MIRA EL DEPARTAMENTO ══
 *
 * `es_promotora` es una marca que alguien tiene que poner a mano, con
 * `tools/marcar-promotoras.js` y el concentrado de RH. El 27/08/2026 había
 * **51 personas activas** cuyo departamento decía PROMOTORA / PROMOTORIA /
 * ZONA PROMOTORIA y que NO estaban marcadas: salían mezcladas con el personal
 * de piso y no aparecían en su sección. Y la incoherencia convivía dentro de la
 * misma plaza —en zamora-canindo, una promotora de una marca marcada y otra de
 * la misma marca no—, o sea que no era un olvido puntual sino deriva: cada alta nueva
 * volvía a entrar sin marcar.
 *
 * El departamento no es un dato nuestro, viene del padrón de RH, y es la
 * clasificación que ellos mismos hacen. Usarlo como segunda fuente cierra la
 * deriva sin depender de que alguien se acuerde de correr una herramienta.
 *
 * Ojo con el sentido de un falso positivo: marcar de más SACA a una persona de
 * la medición de asistencia. Por eso el patrón es `promotor` y no algo más
 * amplio: no atrapa a nadie por parecido de nombre, solo a quien RH puso en un
 * departamento de promotoría.
 */
export function esPromotora(
  ficha: { es_promotora?: boolean | null; departamento?: string | null } | null | undefined
): boolean {
  if (!ficha) return false;
  if (ficha.es_promotora === true) return true;
  return esDeptoDePromotoria(ficha.departamento);
}

/**
 * `[RH.1.5c]` ¿Es un departamento de PROMOTORÍA DE MARCA? (la promotora la paga la marca y no se mide en la
 * asistencia de piso). «PROMOTORIA MEGA DULCES» NO lo es: a esas las paga Mega Dulces y se miden como personal.
 * Regla de RH en Mega Talento (3938723, 08/10/2026); es la única regla, la que usan `esPromotora` y el directorio.
 */
export function esDeptoDePromotoria(departamento: string | null | undefined): boolean {
  const d = String(departamento || '');
  return /promotor/i.test(d) && !/mega\s*dulces/i.test(d);
}

/** Reglas soportadas por el detector. */
export type Regla =
  | 'retardo'
  | 'falta'
  | 'checada_duplicada'
  | 'multiples_entradas'
  | 'entrada_sin_salida'
  | 'salida_sin_entrada'
  | 'fuera_de_turno'
  | 'desayuno_excedido';

export type Severidad = 'baja' | 'media' | 'alta';

/** Configuración de umbrales de las reglas (NO hardcodeada; viene de asistencia_config). */
export interface ReglaConfig {
  /** Regla 2: dos checadas separadas por <= X minutos se consideran duplicadas. */
  duplicadaMinutos: number;
  /** Regla 1: dos "entradas" (tipo=0) separadas por > X horas el mismo día. */
  saltoEntradasHoras: number;
  /** Regla 4: una checada fuera de [entrada - X, salida + X] es "fuera de turno". */
  ventanaFueraTurnoMin: number;
  /** Regla 5: si true, usa horarios_sucursal.tolerancia_min por turno. */
  usarToleranciaHorario: boolean;
  /** Regla 5: override global de tolerancia (min). Si null, usa la del horario. */
  toleranciaRetardoMin: number | null;
  /** Regla 5: marcar FALTA en día laborable sin ninguna checada. */
  marcarFaltas: boolean;
  /**
   * Regla 5 (anti-ruido): si true, NO marca falta a un empleado que no tuvo
   * NINGUNA checada en todo el rango analizado (probablemente no trabajó / sin
   * datos). Sigue marcando la falta de quien sí checó otros días del rango.
   */
  faltaSoloConActividadEnRango: boolean;
  /** Regla 3: "entrada sin salida" solo se marca en días ya cerrados (fecha < hoy). */
  soloDiasCerrados: boolean;

  // ── Regla 6: DESAYUNO EXCEDIDO ────────────────────────────────────
  //
  // Política de RH (27/08/2026): 25 min en corporativo, 30 en las demás plazas.
  // El tope vive aquí y no en código porque `asistencia_config` ya permite
  // override por sucursal, que es justo lo que hace falta: corporativo lleva su
  // propia fila con 25.
  /** Minutos permitidos de desayuno. */
  desayunoTopeMin: number;
  /**
   * A partir de cuántos minutos de EXCESO se genera alerta. El exceso siempre se
   * ve en la pantalla; esto solo decide qué llega al flujo de alertas.
   *
   * No es adorno: con umbral 1 min serían ~284 alertas por semana y este módulo
   * ya se ahogó una vez —2,510 alertas enterraron a las de quien sí importaba—.
   * Con 10, son ~149. Medido sobre 857 desayunos reales (10-23/08/2026).
   */
  desayunoAlertaMin: number;
  /**
   * Hasta qué hora una pausa cuenta como DESAYUNO ('HH:mm'). Lo que empieza
   * después es comida, y la comida NO tiene tope.
   *
   * 13:00 no es un número redondo elegido a ojo: los inicios de pausa de toda la
   * empresa forman dos jorobas —una que pica a las 11:00 y otra a las 15:00— y
   * 13:00 es el valle entre ellas (110 casos contra 321 y 353).
   */
  desayunoHastaHora: string;
  /**
   * Por encima de esto, la pausa NO se trata como desayuno: ni se reporta el
   * exceso ni se alerta.
   *
   * Nadie desayuna dos horas. Un hueco así es una marca de regreso que el lector
   * no leyó, y cobrarla como desayuno produce el peor tipo de alerta: la que es
   * grande, falsa y sale hasta arriba. Medido del 10 al 23/08/2026 sobre 857
   * pausas matutinas, el corte es limpio — p97 = 66 min y p99 = 240 min—: las 15
   * que pasan de 120 min (1.8%) son todas dato roto, no gente desayunando.
   *
   * Esos días no se ocultan: sus marcas siguen en la columna Comida y los
   * atrapan las reglas que sí son suyas (`entrada_sin_salida`, día `atipico`).
   */
  desayunoMaxPlausibleMin: number;
  /**
   * ¿El desayuno cuenta como tiempo TRABAJADO? (25/09/2026, política de RH)
   *
   * En corporativo se checa dos veces a media jornada: el desayuno (25-30 min)
   * y la comida. RH pidió que las horas netas descuenten SOLO la comida; el
   * desayuno se paga. En las demás plazas hay una sola pausa y es la comida, y
   * esa sí se descuenta.
   *
   * Solo aplica cuando el día trae las DOS pausas: si alguien de corporativo
   * checó una sola pausa, no se puede saber si fue desayuno o comida, y se
   * descuenta —equivocarse del lado de pagar una comida sería peor—.
   */
  desayunoCuentaComoJornada: boolean;
  /**
   * ¿Se mide el RETARDO en esta plaza? true en todas (28/09/2026): cada
   * persona se mide contra SU turno, y el día que entra en otro turno se mide
   * contra ese (ver retardosPorSemana). Se conserva el interruptor por plaza.
   */
  medirRetardo: boolean;
  /** Interruptores por regla (permite apagar reglas por sucursal). */
  reglasActivas: Record<Regla, boolean>;
}

/** Checada mínima que necesita la lógica pura. */
export interface ChecadaMin {
  fechaHora: string;        // 'yyyy-MM-ddTHH:mm:ss' (hora local del reloj)
  hora: string;             // 'HH:mm:ss'
  tipo: number | null;      // 0=Entrada, 1=Salida, 2=Salida a comer, 3=Regreso (o null si el reloj no lo manda)
}

/** Turno aplicable a un empleado-día (derivado de horarios_sucursal). */
export interface HorarioMin {
  nombre: string;
  dias: number[];           // 0=domingo .. 6=sábado
  entrada: string;          // 'HH:mm'
  salida: string;           // 'HH:mm'
  inicioComida?: string | null;
  finComida?: string | null;
  toleranciaMin: number;
  /** true si hubo más de un horario candidato y se eligió por heurística. */
  ambiguo?: boolean;
}

/** Empleado bajo análisis. */
export interface EmpleadoMin {
  sucursalId: string;
  codigo: string;
  nombre: string;
}

/** Entrada de la lógica pura: todo lo necesario para analizar UN empleado en UN día. */
export interface EntradaDia {
  empleado: EmpleadoMin;
  fecha: string;            // 'yyyy-MM-dd'
  diaSemana: number;        // 0=domingo .. 6=sábado
  cerrado: boolean;         // fecha < hoy (día ya terminó)
  checadas: ChecadaMin[];   // ordenadas ascendente por hora
  horario: HorarioMin | null;
  config: ReglaConfig;
  /** ¿El empleado tuvo AL MENOS una checada en todo el rango analizado? (anti-ruido de faltas) */
  empleadoConActividadRango: boolean;
}

/** Inconsistencia detectada (aún sin persistir). */
export interface Inconsistencia {
  regla: Regla;
  severidad: Severidad;
  detalle: string;
  evidencia: Record<string, unknown>;
  justificacionSugerida: string;
}

/** Borrador listo para persistir en asistencia_alertas. */
export interface BorradorAlerta extends Inconsistencia {
  sucursalId: string;
  empleadoCodigo: string;
  empleadoNombre: string;
  fecha: string;
}
