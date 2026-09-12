// [SN.2] Contexto de la persona en sesión — lo que "Mi trabajo" muestra en su bloque "Mi contexto"
// (ADR-052 / ADR-061). Backend (`GET /users/me/context`) y frontend importan la MISMA forma.
//
// ── Por qué existe ───────────────────────────────────────────────────────────────────────────
// La landing necesita decir quién sos, qué puesto tenés y en qué sucursal/zona estás. Nada de eso
// llegaba al front: el JWT no trae `nombre` (auth-mt.service.ts), `loginMt()` descarta
// `response.user`, y los únicos endpoints con puesto/departamento (`GET /users/positions`,
// `/users/:id`) exigen `USUARIOS_VER` — o sea que un cajero recibía 403 preguntando por SU puesto.
// Un endpoint self-scoped, sin permiso, es el mismo criterio que `me/scope` y `me/access`.
//
// ── Lo que un consumidor NO debe deducir mal ────────────────────────────────────────────────
//  · `position === null` NO es un error ni un default: ~77 usuarios no tienen puesto asignado, y
//    para `jefe_marketing`/`customer_b2b` es NULL a propósito (mig 20260820201000). La pantalla dice
//    "Sin puesto asignado"; jamás lo deriva del rol.
//  · El puesto y el departamento son eje ORGANIZACIONAL: NO otorgan permisos (el gate sigue siendo
//    `role_name` + mapa de claves). Se muestran, no gatean.
//  · `zona`/`warehouse_code` son la ficha de la persona, no su alcance efectivo: el alcance sale de
//    `GET /users/me/scope` (ADR-050), que además declara `resolvable: false` cuando la ficha no basta.

import type { UserKind } from './identity.contract';

/** Referencia a un catálogo organizacional (`identity.departments` / `identity.positions`). */
export interface MeContextRef {
  code: string;
  name: string;
}

/**
 * `[SN.7]` — Una bandeja de trabajo pendiente que le toca a esta persona.
 *
 * `alcance` distingue las dos cosas que la suite tiene hoy, y NO se deben mezclar:
 *  · `'mio'`    — la fila trae el `user_id` de esta persona (una revisión que ella misma inició).
 *  · `'bandeja'`— cola COMPARTIDA que esta persona puede trabajar por su permiso. Nadie la repartió.
 *
 * ⚠️ `[SN.15]` **Corrección de una medición vencida.** Acá decía que las tres tablas de asignación
 * nominal estaban en CERO filas (medición del 2026-09-10) y la landing publicaba esa conclusión
 * como «Nadie te asignó trabajo hoy». Medido de nuevo el 2026-09-11 contra prod: hay **151 tareas
 * abiertas con dueño activo, repartidas sobre 38 de 118 personas (32%)**. La frase era falsa para
 * un tercio del padrón. Lo que SÍ sigue vacío es `identity.position_responsibilities` (0 filas, a
 * propósito), o sea la pregunta *«¿de qué respondés?»* — que es distinta de *«¿qué te asignaron?»*.
 * Lo asignado va ahora en `MeWork.tareas`; esto sigue siendo el conteo de colas.
 */
export interface MePendiente {
  id: string;
  /** "Descuadres por revisar". Lo que hay que hacer, no el nombre de la tabla. */
  label: string;
  /** Segunda línea: de dónde sale el número. */
  detalle: string;
  /** Ruta que RESUELVE el pendiente. Gateada con el permiso que abrió esta bandeja. */
  ruta: string;
  icono: string;
  total: number;
  /**
   * `[SN.12]` Cuándo entró el pendiente MÁS VIEJO de esta cola (ISO). Es el dato que convierte la
   * lista en una prioridad: el volumen mide tamaño, no urgencia — una cola de 1,865 puede llevar
   * meses estable y una de 5 puede ser de ayer. `null` = no se pudo medir, y entonces la bandeja
   * NO se asume reciente: se ordena al final y se dice (ADR-056).
   */
  mas_viejo_at: string | null;
  alcance: 'mio' | 'bandeja';
  /**
   * `[SN.15]` **Sobre qué universo se contó.** Un número sin universo se lee como "lo mío", y no
   * siempre lo es. Tres valores, y el tercero es el que ADR-056 obliga a no disfrazar:
   *  · `'sucursal'`      — acotado a la sucursal de esta persona.
   *  · `'red'`           — toda la red porque la cola NO tiene columna de sucursal (medido: 5 de
   *                        las 8 no tienen ninguna columna de ruteo). No hay nada que acotar.
   *  · `'red_sin_ficha'` — la cola SÍ se podría acotar, pero la ficha de esta persona no tiene
   *                        sucursal, así que se cuenta toda la red y **se dice**. Acotar a `[]`
   *                        daría 0 y se leería como "estás al día": medido, le pasaría al 74% de
   *                        quienes ven la bandeja de reabasto.
   */
  ambito: 'red' | 'sucursal' | 'red_sin_ficha';
}

/**
 * `[SN.15]` — Trabajo que ALGUIEN te asignó, con nombre y fecha.
 *
 * Es la otra mitad de `MePendiente`, y la diferencia no es cosmética: una tarea tiene un
 * `assigned_to`, una bandeja no. Fundirlas es el error que `work/task.contract.ts` vino a cerrar
 * («una cola sin `assigned_to` no es una tarea: es una bandeja»). Se lee de las cuatro tablas que
 * ya existen, vía sus `ADAPTADORES` — **no hay una quinta tabla y no debe haberla**.
 */
export interface MeTarea {
  /** La fuente, tal cual la registra `FUENTES_TAREA`: `'finance.recon_tasks'`, etc. */
  fuente: string;
  label: string;
  detalle: string;
  /**
   * Ruta que resuelve la tarea, o `null` si esta persona NO tiene el permiso que la abre. En ese
   * caso la fila se muestra sin enlace: esconderla taparía la discrepancia entre quién reparte y
   * quién puede abrir; enlazarla invitaría a un 403 (medido: 2 casos reales en prod).
   */
  ruta: string | null;
  /** Por qué no hay enlace. `null` cuando sí lo hay. */
  sin_acceso: string | null;
  icono: string;
  total: number;
  /** Cuándo te asignaron la más vieja (ISO). `null` = no se pudo medir. */
  mas_viejo_at: string | null;
  /** El vencimiento más próximo. `null` = **la fuente no maneja vencimiento**, no "no vence". */
  vence_at: string | null;
  /** Cuántas pasaron su fecha. `null` cuando la fuente no puede contestarlo. */
  vencidas: number | null;
  /** Lo que esta fuente NO puede contestar, copiado de su adaptador (ADR-056). */
  no_responde: readonly string[];
}

/**
 * `[SN.16]` — El estado de UN periodo dentro de un trabajo cíclico.
 *
 * ⛔ Los cuatro valores son distintos y NO se colapsan a "listo / no listo":
 *  · `sin_datos`   — **no hay con qué trabajar** ese mes (medido: 2026-06 y 2026-07 no tienen
 *                    estado de cuenta cargado). No es pendiente, no es clickeable, y pintarlo como
 *                    "sin conciliar" sería inventarle trabajo a alguien que no puede hacerlo.
 *  · `sin_empezar` — hay trabajo y nadie lo tocó.
 *  · `en_proceso`  — empezó y falta.
 *  · `al_dia`      — cerrado.
 */
export type EstadoPeriodo = 'sin_datos' | 'sin_empezar' | 'en_proceso' | 'al_dia';

export interface MePeriodo {
  /** `'YYYY-MM'`. */
  periodo: string;
  estado: EstadoPeriodo;
  /** Cuántas cosas faltan. `null` = **no se pudo contar**, que no es cero (ADR-056). */
  faltan: number | null;
  /** Por qué está así, en una línea. */
  motivo: string;
  /** Ruta que resuelve ESE mes; `null` cuando no hay a dónde ir (`sin_datos`). */
  ruta: string | null;
  /** Query params que aterrizan en el mes exacto (`?view=cuadre&period=2026-02`). */
  queryParams: Record<string, string> | null;
}

/**
 * `[SN.16]` — Un trabajo que se cierra **mes por mes**, no una cola.
 *
 * Es el tercer organismo de la landing, junto a `MeTarea` (te lo asignaron) y `MePendiente` (cola
 * que abre tu permiso). Éste es una cola compartida **con calendario**: la abre el permiso, nadie
 * la repartió, y su unidad de avance es el periodo.
 *
 * ⛔ **No trae el veredicto de cierre.** Para bancos, "¿cuadra el mes?" lo contesta
 * `GET /finance/bank/diagnostico` (pestaña Cierre) y cuesta ~8 consultas por mes. Acá van los
 * hechos baratos del avance y el veredicto queda a un clic, con un solo dueño.
 */
export interface MeCiclo {
  id: string;
  label: string;
  detalle: string;
  icono: string;
  /** Del más viejo al más nuevo. Siempre los 12; un mes sin datos viene declarado, no ausente. */
  periodos: MePeriodo[];
  /** Periodos que esperan trabajo (`sin_empezar` + `en_proceso`). `sin_datos` NO cuenta. */
  pendientes: number;
  /**
   * `[SN.17]` **¿Este ciclo es TUYO?** Sale de `identity.responsibilities` — del puesto
   * (`position_responsibilities`) o de una excepción por persona (`user_responsibilities`).
   *
   * ⛔ **No gatea: ordena.** Es la regla que `[OR.1b]` dejó escrita — *"el PERMISO decide si podés
   * ABRIRLO; la RESPONSABILIDAD decide si es TUYO… si también gateara habría un cuarto sistema de
   * autorización"*. Quien tiene el permiso sigue viendo y abriendo todos los ciclos; `es_mio` sólo
   * decide cuál va arriba y marcado.
   */
  es_mio: boolean;
}

/**
 * `[SN.7]` — Respuesta de `GET /users/me/work`.
 *
 * Sólo se cuentan las bandejas cuyo permiso tiene esta persona: un conteo es información, y una
 * cola que no podés abrir no es tu trabajo. Lo que no se pudo contar va a `no_medido` con motivo
 * — NUNCA baja a cero (ADR-056: un cero dibujado se lee igual que "estás al día").
 */
/**
 * `[SN.21]` — **Qué le hizo el reparto a «Mi trabajo».**
 *
 * La regla que implementa: *si algo de lo que ves está declarado como TUYO, se muestra sólo eso;
 * si nada de lo que ves es tuyo, no se filtra nada.* Es la frase de Edgar («Ivonne es SOLO
 * INGRESOS») convertida en condición, y **es auto-limitada por construcción**: sólo se enciende
 * cuando al menos un elemento visible sobrevive, así que no puede vaciar la pantalla.
 *
 * ⚠️ La versión ingenua —«tenés alguna responsabilidad ⇒ filtrá»— se midió antes de escribirla y
 * dejaba a **6 personas sin nada**: su única delegación es `finanzas.hallazgos`, cuya bandeja está
 * RETIRADA desde `[SN.18]`, o sea que apunta a una superficie apagada. Filtrar por una delegación
 * que no puede mostrar nada es esconder todo a cambio de nada.
 *
 * ⛔ Esto NO es autorización: la responsabilidad ordena «Mi trabajo», no abre ni cierra módulos
 * (regla de `[OR.1b]`). Quien pierde una cola de esta lista entra igual a su pantalla por el menú.
 */
export interface MeDelegacion {
  /** `true` = la lista está recortada a lo tuyo. `false` = se muestra todo lo que abre tu permiso. */
  activa: boolean;
  /** Las responsabilidades vigentes de esta persona (puesto + ficha), para poder decir POR QUÉ. */
  claves: string[];
  /**
   * Cuántas colas y ciclos que tu permiso SÍ abre quedaron fuera por no ser tuyos. Se dice en
   * pantalla: una lista recortada en silencio se lee igual que una lista completa.
   */
  ocultas: number;
}

export interface MeWork {
  /** `[SN.15]` Lo que alguien te asignó. Separado de `pendientes` a propósito. */
  tareas: MeTarea[];
  pendientes: MePendiente[];
  /** `[SN.16]` Trabajo que se cierra mes por mes. Tercer organismo, ni tarea ni cola simple. */
  ciclos: MeCiclo[];
  no_medido: { id: string; label: string; motivo: string }[];
  /**
   * `[SN.15]` ¿Existe un mapa de responsabilidades para el puesto de esta persona?
   * `false` = ni su puesto ni su ficha declaran de qué responde, así que «es tuyo» NO se puede
   * calcular y la pantalla lo declara en vez de derivarlo del permiso. `null` = no se pudo
   * consultar.
   *
   * ⚠️ `[SN.21]` Acá decía que era el caso de TODOS porque `[OR.1b]` dejó
   * `identity.position_responsibilities` vacía. **Medido de nuevo el 2026-09-12: 42 filas sobre 28
   * de 122 personas activas (23%).** Alguien la sembró después. Es el mismo defecto que corrigió
   * `[SN.15]`: una medición vencida congelada en un comentario.
   */
  tiene_responsabilidades: boolean | null;
  /**
   * `[SN.21]` Qué le hizo el reparto a esta lista. La pantalla no esconde en silencio.
   * `null` = las responsabilidades no se pudieron leer (ADR-056: se declara, no se asume vacío).
   */
  delegacion: MeDelegacion | null;
  /** ISO del momento en que se contó (el número es de ahora, no de un rollup nocturno). */
  medido_at: string;
}

export interface MeContext {
  user_id: string;
  username: string;
  /** Nombre de la persona en `identity.users.nombre`; `null` si nunca se capturó. */
  nombre: string | null;
  role_name: string | null;
  kind: UserKind | null;
  /** Sucursal Kepler de la ficha ('00'..'06'), o `null`. */
  warehouse_code: string | null;
  /** Nombre de la zona de la ficha (`trade.zones.name`), o `null`. */
  zona: string | null;
  department: MeContextRef | null;
  /** `null` = "Sin puesto asignado". Nunca se rellena desde el rol. */
  position: MeContextRef | null;
}
