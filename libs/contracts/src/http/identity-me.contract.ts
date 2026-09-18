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
  /**
   * `[CDRP.1]` **«Mi trabajo se llama…»** — para qué existe el puesto, en una línea, en términos de
   * resultado de negocio (CDRP §1.1). Sólo los puestos lo traen; los departamentos, no.
   *
   * ⛔ Es texto **DECLARADO** por Dirección en `identity.positions.proposito`, no derivado: no se
   * calcula ni se valida contra nada. `null`/ausente = ese puesto todavía no la tiene, y se muestra
   * como ausencia — **nunca repitiendo el nombre del puesto**, que diría algo distinto («Gerencia
   * de Zona» no es un resultado). Medido el 2026-09-18: 9 de 20 puestos de mando la tienen.
   */
  proposito?: string | null;
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
/**
 * `[SN.29]` **El veredicto de una cola: qué hay que hacer con ella, no cuánto tiene.**
 *
 * ── Por qué hacía falta ─────────────────────────────────────────────────────────────────────
 * Hasta acá una bandeja reportaba dos cosas —`total` y `mas_viejo_at`— y la pantalla las pintaba
 * iguales para todas. Medido contra prod el 2026-09-14, eso le daba el MISMO tratamiento a:
 *
 *   · `logistics.fleet_alerts` — 9 abiertas, todas de hoy, **10,339 resueltas**; y
 *   · `reconciliation.discrepancies` — 2,409 abiertas de 2,409 filas, **cero resueltas jamás**,
 *     con la más vieja del 8-jul (68 días).
 *
 * Un número y una edad no distinguen un flujo de trabajo de un vertedero. Y el orden por
 * antigüedad que introdujo `[SN.12]` **premia el abandono**: una cola que nadie trabaja siempre
 * tiene el más viejo antiguo, así que el criterio sube al tope justo las colas donde hacer clic
 * no sirve de nada.
 *
 * ── El primitivo, y de dónde sale ───────────────────────────────────────────────────────────
 * Es el mismo que `db-health` aplica a los feeds desde ADR-053: **una fuente declara su umbral y
 * el sistema emite un veredicto**. La Fase VP midió que sin umbral registrado el clasificador
 * caía en `cfg ? classify : 'ok'` — verde incondicional. Las bandejas estaban en ese estado
 * exacto: sin `umbral_dias`, nada podía estar tarde, y entonces todo se veía igual de bien.
 *
 * ⛔ **`sin_medir` no es `al_dia`.** Lo que no se pudo medir se declara y NO se ordena junto a lo
 * sano (ADR-056). Y `cerradas_30d: null` («esta fuente no puede contestarlo») nunca se colapsa a
 * `0` («nadie cerró ninguna»), que es la afirmación opuesta.
 */
export type MeVeredicto =
  /** Entran más de las que salen: la cola crece. Es lo único que el clic de hoy puede frenar. */
  | 'se_acumula'
  /** Se trabaja, pero el más viejo pasó el umbral declarado: hay cola vieja atorada. */
  | 'atrasada'
  /**
   * **Cero salidas en 30 días, medido.** No es trabajo pendiente: es una decisión que nadie tomó
   * — o se le asigna dueño, o se apaga con `BandejaDef.retirada` (precedente `[SN.18]`).
   * Se ordena DEBAJO de lo accionable a propósito: nadie la va a drenar con un clic.
   */
  | 'congelada'
  /** El flujo o la fecha no se pudieron medir. Nunca se asume sana. */
  | 'sin_medir'
  /** Sale al menos tanto como entra y nada pasó su umbral. */
  | 'al_dia';

/** `[SN.29]` Orden de atención. Índice más chico = más arriba en la lista. */
export const ORDEN_VEREDICTO: Readonly<Record<MeVeredicto, number>> = {
  se_acumula: 0,
  atrasada: 1,
  congelada: 2,
  sin_medir: 3,
  al_dia: 4,
};

/**
 * `[SN.29]` El FLUJO de una cola: entradas contra salidas, en la MISMA ventana.
 *
 * ⚠️ `entradas_30d` y `cerradas_30d` comparten ventana a propósito. La primera versión comparaba
 * `entradas_7d` contra `cerradas_30d` normalizando por día, y eso mezcla dos regímenes: una cola
 * con un pico de ayer se declaraba «se acumula» aunque el mes entero fuera a la baja.
 * `entradas_7d` queda **sólo** para la línea de contexto («+209 esta semana»), no para el veredicto.
 */
export interface MeFlujo {
  /** Abiertas que ENTRARON en los últimos 7 días. `null` = la cola no se pudo fechar. */
  entradas_7d: number | null;
  /** Filas creadas en 30 días, **en cualquier estado**: lo que llegó, se haya resuelto o no. */
  entradas_30d: number | null;
  /**
   * Filas que SALIERON del estado abierto en 30 días, según la columna de cierre que declara cada
   * bandeja. ⛔ `null` = **la fuente no puede contestarlo**, nunca «nadie cerró ninguna».
   */
  cerradas_30d: number | null;
}

/** Lo mínimo que `veredictoDe` necesita: la medición cruda, sin el resto de la fila. */
export interface ColaMedida {
  total: number;
  mas_viejo_at: string | null;
  flujo: MeFlujo;
}

/** Días transcurridos desde `iso`, o `null` si no vino fechado. `ahora` se inyecta para poder probar. */
function diasDesde(iso: string | null, ahora: number): number | null {
  if (!iso) return null;
  const ms = ahora - Date.parse(iso);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 86_400_000) : null;
}

/**
 * `[SN.29]` **Qué fracción de lo que llegó tiene que resolverse para que la cola «lleve el ritmo».**
 *
 * ⚠️ Este número existe porque la regla obvia —`entradas > cerradas` ⇒ se acumula— **la refutó su
 * propia prueba en la primera corrida**, con datos reales: `logistics.fleet_alerts` recibió 7,205
 * y resolvió 7,202 en 30 días, y salía *«crece»*. Tenía 9 abiertas de 10,339 filas; es la cola más
 * sana de la empresa. La resta cruda no distingue una tendencia de la fluctuación normal de una
 * cola en régimen, porque el saldo de una cola sana nunca es exactamente cero.
 *
 * La razón `cerradas / entradas` sí las separa, y con margen: flota **99.96 %**, reabasto **179 %**,
 * Thot **129 %** · descuadres **0 %**, Maat **0 %**. Cualquier corte entre 5 % y 95 % daba el mismo
 * veredicto para las cinco; **0.9** deja 10 puntos de tolerancia a la fluctuación sin acercarse a
 * ninguna de las dos poblaciones.
 *
 * Es política declarada, como `umbral_dias`: se cambia acá y se mide en `veredicto.spec.ts`.
 */
const RITMO_MINIMO = 0.9;

/**
 * `[SN.29]` **El veredicto.** Cinco reglas en orden; la primera que aplica gana.
 *
 * ⛔ Vive en `libs/contracts` y NO junto al registro de bandejas, que es donde nació. Motivo: es
 * lógica PURA sobre el contrato —no toca knex ni Nest— y `libs/trade` **no tiene runner de
 * pruebas** (sólo `lint`), así que ahí habría sido un primitivo sin candado. ADR-056 es explícito:
 * un mecanismo genérico no cierra su item hasta vivir en `libs/` compartido. Acá sí corre el runner de pruebas.
 *
 * ⛔ El orden NO es por urgencia percibida sino por **qué puede hacer la persona que está mirando**:
 *
 *  1. `sin_medir`  — no hay con qué opinar. No se asume sana (ADR-056) y no se ordena con `al_dia`.
 *  2. `congelada`  — cero salidas en 30 días, MEDIDO (`cerradas_30d === 0`, no `null`). Ordena
 *     TERCERA a propósito: nadie drena con un clic una cola sin dueño. Lo que necesita es una
 *     decisión —asignar o apagar—, y `[SN.18]` ya sentó el precedente.
 *  3. `se_acumula` — entran más de las que salen en la MISMA ventana. Es lo único que el trabajo
 *     de hoy puede frenar, así que encabeza la lista.
 *  4. `atrasada`   — se trabaja, pero el más viejo pasó el umbral declarado.
 *  5. `al_dia`     — todo lo demás.
 *
 * ⚠️ Una cola sin `umbral_dias` no puede salir `atrasada`, y eso es deliberado y peligroso: si
 * alguien agrega una bandeja sin umbral, la pantalla la pintaría `al_dia` para siempre — el
 * `cfg ? classify : 'ok'` que la Fase VP encontró dando verde incondicional en `db-health`. Por eso
 * `BandejaDef.umbral_dias` es obligatorio y el bloque 4g del smoke lo verifica con prueba negativa.
 */
export function veredictoDe(
  m: ColaMedida,
  umbralDias: number | null,
  ahora: number = Date.now(),
): MeVeredicto {
  const { entradas_30d, cerradas_30d } = m.flujo;
  const dias = diasDesde(m.mas_viejo_at, ahora);

  // Sin flujo Y sin fecha no hay nada que decir. Con una de las dos sí se puede opinar.
  if (cerradas_30d === null && entradas_30d === null && dias === null) return 'sin_medir';

  // Cero salidas MEDIDAS en 30 días, teniendo abiertos: nadie la trabaja.
  if (cerradas_30d === 0 && m.total > 0) return 'congelada';

  /*
   * No alcanza con `entradas > cerradas`: el saldo de una cola sana nunca es exactamente cero y esa
   * resta la declaraba «crece» por tres filas sobre siete mil (ver `RITMO_MINIMO`). Lo que se mide
   * es si LLEVA EL RITMO de lo que le llega. Si no llegó nada, no puede estar creciendo.
   */
  if (
    entradas_30d !== null &&
    cerradas_30d !== null &&
    entradas_30d > 0 &&
    cerradas_30d / entradas_30d < RITMO_MINIMO
  ) {
    return 'se_acumula';
  }

  if (umbralDias !== null && dias !== null && dias > umbralDias) return 'atrasada';

  // Si el flujo no se pudo medir y el umbral no alcanzó para condenarla, NO se declara sana.
  if (cerradas_30d === null && entradas_30d === null) return 'sin_medir';

  return 'al_dia';
}

export interface MePendiente {
  id: string;
  /** "Descuadres por revisar". Lo que hay que hacer, no el nombre de la tabla. */
  label: string;
  /** Segunda línea: de dónde sale el número. */
  detalle: string;
  /**
   * Ruta que RESUELVE el pendiente. Gateada con el permiso que abrió esta bandeja.
   *
   * `[SN.24]` `null` = la actividad **es tuya** pero tu permiso no abre su pantalla. La fila se
   * muestra igual, con el motivo en `sin_acceso` y sin enlace — mismo criterio que `MeTarea`:
   * esconderla taparía la discrepancia entre quién reparte y quién puede abrir; enlazarla
   * invitaría a un 403. Medido en prod: 3 supervisores responden de `comercial.thot` sin tener
   * `COMMERCIAL_THOT_GESTIONAR`.
   */
  ruta: string | null;
  /** `[SN.24]` Por qué no hay enlace. `null` cuando sí lo hay. Nunca las dos cosas a la vez. */
  sin_acceso: string | null;
  icono: string;
  total: number;
  /**
   * `[SN.12]` Cuándo entró el pendiente MÁS VIEJO de esta cola (ISO). Es el dato que convierte la
   * lista en una prioridad: el volumen mide tamaño, no urgencia — una cola de 1,865 puede llevar
   * meses estable y una de 5 puede ser de ayer. `null` = no se pudo medir, y entonces la bandeja
   * NO se asume reciente: se ordena al final y se dice (ADR-056).
   */
  mas_viejo_at: string | null;
  /**
   * `[SN.29]` Días que esta cola puede tener su más viejo abierto antes de contar como atrasada.
   * Es **política declarada**, no medición: vive en `BANDEJAS` con su motivo y se cambia en una
   * línea. `null` = esta cola no declaró umbral, y entonces NUNCA puede salir `atrasada` — que es
   * exactamente el verde incondicional que ADR-053 y la Fase VP vinieron a cerrar; por eso el
   * candado exige que toda bandeja viva lo traiga.
   */
  umbral_dias: number | null;
  /** `[SN.29]` Entradas contra salidas. Lo que distingue un flujo de trabajo de un vertedero. */
  flujo: MeFlujo;
  /** `[SN.29]` El veredicto derivado de `flujo` + `mas_viejo_at` + `umbral_dias`. Ordena la lista. */
  veredicto: MeVeredicto;
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
   * ⚠️ `[SN.24]` **Acá decía "no gatea: ordena", y eso cambió por decisión de Edgar
   * (2026-09-14):** *"ese trabajo sólo lo puede ver quien tiene designada esa actividad"*. Hoy una
   * actividad **con dueño** sólo le llega a su dueño; una **sin dueño** sigue siendo cola
   * compartida para quien la abra su permiso.
   *
   * ⛔ Sigue sin ser un cuarto sistema de AUTORIZACIÓN, que es lo que `[OR.1b]` quería evitar: el
   * módulo no se cierra. Quien deja de ver un ciclo acá entra igual a `/finanzas/bancos` por el
   * menú y lo trabaja. Lo que se recorta es **la lista de lo que te toca**, no el acceso.
   */
  es_mio: boolean;
  /**
   * `[SN.24]` Por qué este ciclo no lleva a ningún lado: es TUYO pero tu permiso no abre su
   * pantalla. `null` cuando sí la abre. Cuando trae texto, ningún mes de la tira navega.
   */
  sin_acceso: string | null;
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
  /**
   * `[SN.30]` **Responsabilidades tuyas cuya superficie está APAGADA** (`BandejaDef.retirada`).
   *
   * Sin esto la pantalla le diría *«no tienes trabajo a tu nombre»* a alguien que sí tiene
   * reparto — sólo que su cola está retirada. Son dos hechos distintos y confundirlos es la
   * clase de mentira que esta fase existe para no cometer (ADR-056).
   *
   * Medido en prod el 2026-09-14: **6 personas** (`diana_rodriguez`, `ernesto_zarate`,
   * `maria_rodriguez`, `jesus_carrillo`, `perla_garcia`, `julio_torres`) tienen como ÚNICA
   * responsabilidad `finanzas.hallazgos`, retirada desde `[SN.18]` por 82,377 sin triage. Con la
   * regla de `[SN.30]` su columna queda vacía, y sin este campo no sabrían por qué.
   */
  retiradas: string[];
}

/**
 * `[JZ.3]` — **Un canal de venta de la zona: una tienda o una ruta.**
 *
 * ── Por qué es un organismo NUEVO y no una bandeja ──────────────────────────────────────────
 * Los tres que había miden trabajo PENDIENTE: una cola que drenar (`MePendiente`), algo que
 * alguien te repartió (`MeTarea`), un mes que cerrar (`MeCiclo`). Un jefe de zona no tiene una
 * cola: tiene un resultado. La pregunta que le contesta su portada es *«¿cómo voy?»*, y eso no
 * se cuenta en filas pendientes — se mide en pesos contra un tramo comparable.
 *
 * ⛔ No se fuerza dentro de `MePendiente`: su `total` es «cuántas faltan» y el veredicto de
 * `[SN.29]` mide entradas contra salidas. Meter pesos ahí haría que `veredictoDe` opine sobre un
 * número que no es una cola, y la pantalla ordenaría una venta junto a un descuadre.
 *
 * ── ⛔ La regla que este tipo existe para hacer cumplir ──────────────────────────────────────
 * **Sin venta en el tramo NO es −100%.** Medido en prod el 2026-09-15: las cinco rutas de ZAMORA
 * (`RUTA-501`…`505`) vendieron $824k en julio y **cero desde el 11-12 de agosto** — y no es una
 * caída, es la pierna Wincaja del sell-out que dejó de llegar (las seis de LA PIEDAD, que venden
 * por otro canal, llegan al día sin hueco).
 *
 * Un jefe que ve **−100%** sale a buscar al vendedor. Uno que ve **«sin venta registrada desde el
 * 12-ago»** le habla a Sistemas. Por eso `monto: null` ⇒ `variacion_pct: null` **siempre**, y el
 * motivo viaja en `sin_medir` (ADR-056: lo que no se puede medir se declara, nunca se dibuja).
 */
export interface MeCanal {
  /** Código del almacén (`'01'`, `'RUTA-28'`). Estable: es con lo que se enruta. */
  id: string;
  label: string;
  /** Segunda línea: contra qué se compara, o por qué no hay cifra. */
  detalle: string;
  grupo: MeCanalGrupo;
  /**
   * Venta del tramo corrido del mes, en pesos. ⛔ `null` = **no hubo ninguna fila**, que NO es
   * cero: no se puede distinguir «no vendió» de «no llegó el dato», y las dos llevan a acciones
   * opuestas. Cuando es `null`, `sin_medir` dice desde cuándo.
   */
  monto: number | null;
  /** El MISMO tramo del mes anterior (días 1..N contra días 1..N). `null` = sin comparador. */
  comparado: number | null;
  /**
   * Variación relativa (`0.084` = +8.4 %). `null` si falta cualquiera de los dos lados o si el
   * comparador es 0 — dividir entre cero publicaría un infinito como si fuera un crecimiento.
   */
  variacion_pct: number | null;
  /** Último día con venta registrada (`'YYYY-MM-DD'`). Es lo que separa «bajó» de «se cortó». */
  ultima_venta: string | null;
  /** Por qué no hay cifra, en una línea. `null` cuando sí la hay. Nunca las dos cosas. */
  sin_medir: string | null;
  /**
   * Pantalla que muestra el detalle de ESTE canal. `null` = tu permiso no la abre, y entonces
   * `sin_acceso` dice cuál falta — mismo criterio que `MePendiente`/`MeTarea`: la fila se muestra
   * igual, sin enlace, porque esconderla taparía la discrepancia y enlazarla invitaría a un 403.
   * Medido: la jefa de zona de LA PIEDAD no tiene `COMMERCIAL_ROUTE_SALES_VER`.
   */
  ruta: string | null;
  /** Los params que aterrizan la pantalla ya filtrada (`[JZ.1]`). `null` cuando no hay ruta. */
  queryParams: Record<string, string> | null;
  sin_acceso: string | null;
}

/**
 * `[JZ.3]`/`[JZ.6]` Los canales por los que vende una zona.
 *
 * ⭐ `vecinal` entró por pedido de Edgar (*«hay que mostrar vecinal aparte»*) y es un canal, no
 * una zona: las rutas vecinales cuelgan de la sucursal MADRE, así que viven dentro de la misma
 * zona que las tiendas. Las zonas `LA PIEDAD VECINAL` / `ZAMORA VECINAL` de `trade.zones` son eje
 * de PERSONAS —5 vendedores tienen su ficha ahí— y no tienen un solo almacén.
 *
 * Hasta `[JZ.6]` no aparecían en ninguna parte: no tienen almacén `RUTA-*` propio, así que
 * `[JZ.2]` las declaraba `sin_almacen`. Son **$944,740 en LA PIEDAD** del 1 al 16 de septiembre.
 */
export type MeCanalGrupo = 'tienda' | 'ruta' | 'vecinal';

/**
 * `[JZ.3]` — Un canal agrupado: sus filas, su subtotal, y **lo que quedó fuera de la suma**.
 *
 * ⛔ `excluidos` no es adorno. Una ruta ambigua —la misma clave reclamada por dos zonas— no se
 * puede sumar a ninguna sin contarla dos veces (`[JZ.2]`: `RUTA-501`/`502` valen $1.04M y las
 * reclaman ZAMORA y CANINDO). Sumarla mentiría; omitirla en silencio haría que el subtotal no
 * cuadre con lo que el jefe sabe de su zona y nadie podría explicar la diferencia.
 */
export interface MeZonaBloque {
  grupo: MeCanalGrupo;
  label: string;
  /** Suma de los canales MEDIDOS. `null` si ninguno se pudo medir. */
  monto: number | null;
  comparado: number | null;
  variacion_pct: number | null;
  /**
   * `[JZ.3]` **Lo que quedó FUERA de la comparación por no tener cifra este mes.**
   *
   * ⛔ Este campo nació de un defecto medido contra prod: ZAMORA publicaba **−42.2 %**. Sus 3
   * rutas vendieron ~$480k del 1 al 15 de agosto y cero en septiembre —porque dejó de llegar el
   * dato, no porque dejaran de vender—, y el total sumaba **un** canal de este mes contra **dos**
   * del anterior. Un número verosímil y falso, que es peor que el −100 % que ya se había cerrado.
   *
   * La regla es que un canal entra en los dos lados o en ninguno. Pero omitirlo en silencio haría
   * que el subtotal no cuadre con lo que el jefe sabe de su zona, así que lo que sale se cuenta
   * acá: cuántos canales y cuánto valían. `null` = no quedó nada afuera.
   */
  no_comparado: { canales: number; monto_anterior: number } | null;
  /** Qué porción de la venta de la zona es este canal (`0.79`). `null` si el total no se midió. */
  peso: number | null;
  /**
   * `[CDRP.1]` **Margen del canal** (`0.1094` = 10.94 %), CDRP §7 KPI 2 y §3 KPI 3.
   *
   * ⛔ Va en el BLOQUE y no en la zona, y no es cosmético: medido el 2026-09-18 contra prod, la
   * venta por ruta **no tiene costo** — `analytics.v_rd_route_daily.costo_status` dice
   * `sin_dato_en_la_fuente` en el **100 %** de las filas del tramo ($3.16 M). Un «margen de la
   * zona» que sumara los dos canales taparía que un 11 % de la venta no tiene con qué calcularlo.
   *
   * ⚠️ Y donde SÍ hay costo, el costo tiene dos escritores: Wincaja lo trae real y Kepler lo deriva
   * como `ingreso / (1 + margen)`, que es ciego al precio y subdeclara ~2 pp (ADR-051 enmendado).
   * Por eso viaja `margen_cobertura`: sin ella, un margen con el 89 % de la venta se lee igual que
   * uno con el 100 %.
   */
  margen_pct: number | null;
  /** Fracción de la venta del bloque que SÍ tiene costo (`0.999`). `null` = no se pudo medir. */
  margen_cobertura: number | null;
  /**
   * `[CDRP.1]` **Ticket promedio del canal** (CDRP §3 KPI 5, §7 KPI 5) y su conteo.
   *
   * ⛔ Por canal, nunca agregado: medido, el ticket de tienda es **$105.04** y el de ruta
   * **$726.90** — mostrador contra venta a detallista. El promedio de los dos ($115.99) no es el
   * ticket de nadie.
   */
  ticket_promedio: number | null;
  tickets: number | null;
  canales: MeCanal[];
  /** Lo que NO entró en el subtotal, con su motivo. Se dice, no se calla. */
  excluidos: { label: string; motivo: string }[];
}

/**
 * `[JZ.3]` — **Cómo va la zona de esta persona.**
 *
 * ── El sujeto sale de la RESPONSABILIDAD, no del alcance ─────────────────────────────────────
 * Con `comercial.venta_tiendas|_rutas|_vecinal` la zona sale de `identity.users.zona_id` (la misma
 * que publica `MeContext.zona`), **no** de `ScopeService`. Motivo medido: de los 3 `jefe_zona` de
 * prod, **2 son `superadmin`** y su alcance de zona es `all` — mostrarles las 9 zonas convertiría
 * *su* portada en la de la empresa. El alcance dice qué PODÉS ver; la responsabilidad, de qué
 * respondés.
 *
 * `[JZ.7]` Con `comercial.venta_zonas` (dirección) el sujeto son **todas** las zonas con canal de
 * venta, y entonces `MeWorkZona.zonas` trae N. La clave es otra justamente para que «ver todo» no
 * se pueda heredar de un `superadmin` distraído: hay que repartirla a un puesto.
 *
 * ⚠️ **Límite conocido:** un jefe = una zona. `LA PIEDAD RD` y `LA PIEDAD VECINAL` son la misma
 * plaza y hoy son dos filas de `trade.zones` sin nada arriba; hasta que exista el agrupador de
 * plaza, un jefe con dos zonas ve una. Queda dicho acá para que no se descubra por accidente.
 */
export interface MeZona {
  /** Nombre de la zona (`trade.zones.name`). */
  zona: string;
  /** `[JZ.4]` El grano que eligió la persona. Cada uno trae su propio comparador. */
  periodo: MeZonaPeriodo;
  /**
   * `[JZ.4]` **El tramo se recortó porque una fuente va atrasada.** `null` = no hizo falta.
   *
   * ⛔ Nace de una mentira publicada: MORELIA ABASTOS decía **−26.1 %** comparando 10 días de
   * septiembre contra 15 de agosto, porque su fuente (`wincaja_*`) no entregaba desde el 10.
   * Con el tramo parejo la zona **sube 17.1 %**. Recortar sin decirlo cambiaría una mentira por
   * un silencio: la pantalla tiene que poder decir «al 10-sep, faltan 5 días de Wincaja».
   */
  corte: { hasta_nominal: string; dias_sin_entregar: number; fuentes: string[] } | null;
  /** Tramo medido, inclusive (`'2026-09-01'` … `'2026-09-15'`). */
  desde: string;
  hasta: string;
  /**
   * `[JZ.4]` El tramo llega a HOY, que va a medias (sólo puede pasar en `mes`). Se declara para
   * que la pantalla lo diga: el comparador es un tramo completo y éste no, y el desnivel se
   * achica solo con las horas. `dia` y `semana` terminan en el último día cerrado.
   */
  incluye_dia_en_curso: boolean;
  /** El MISMO número de días del mes anterior. El comparador se declara, no se adivina. */
  desde_comparado: string;
  hasta_comparado: string;
  /** Total de la zona = suma de los subtotales medidos. `null` = nada medible. */
  monto: number | null;
  comparado: number | null;
  variacion_pct: number | null;
  /** `[JZ.3]` Lo que quedó fuera de la comparación de la ZONA. Ver `MeZonaBloque.no_comparado`. */
  no_comparado: { canales: number; monto_anterior: number } | null;
  /** Un bloque por canal del que esta persona responde. Vacío = no responde de ninguno. */
  bloques: MeZonaBloque[];
}

/**
 * `[JZ.3]` — **La variación, o `null`.** Pura, en el contrato, para poder probarla.
 *
 * Las tres ramas que devuelven `null` son las tres formas de mentir que esto evita:
 *  · `monto === null`      → *«sin datos»* se dibujaría como **−100 %** (el caso ZAMORA/Wincaja).
 *  · `comparado === null`  → no hay contra qué, y un `+∞` se lee como un crecimiento récord.
 *  · `comparado === 0`     → división entre cero. `Infinity` sobrevive a `JSON.stringify` como
 *                            `null`, así que el bug llegaría al front disfrazado de dato ausente.
 */
export function variacionPct(monto: number | null, comparado: number | null): number | null {
  if (monto === null || comparado === null || comparado === 0) return null;
  return (monto - comparado) / comparado;
}

/**
 * `[JZ.4]` — **Con qué se compara, y en qué grano.** El jefe de zona elige día, semana o mes.
 *
 * ⛔ **Cada grano tiene su propio comparador, y NO son intercambiables.** Medido en prod sobre
 * 60 días, el día de la semana manda más que la tendencia:
 *
 *     rutas    lunes 162,470  ·  sábado 115,765     → 40 % de diferencia
 *     tiendas  martes 756,969 ·  domingo 345,281    → 2.2 ×
 *
 * Por eso `dia` **no compara contra ayer**: un lunes contra un domingo publicaría un salto que es
 * puro calendario. Compara contra el **mismo día de la semana anterior**, que es lo único
 * conmensurable. Lo mismo con `semana`: lunes-a-hoy contra lunes-a-mismo-día.
 *
 * ⛔ **`dia` y `semana` terminan en el último día CERRADO, no en hoy.** `analytics.sales_daily`
 * tiene grano de DÍA —no hay hora— así que un «hoy» parcial contra un día completo da una caída
 * falsa que se achica sola con las horas. Medido: con `semana` de lunes-a-hoy, LA PIEDAD salía
 * **−31.9 %** un martes por la tarde, porque el día en curso era la MITAD de la ventana.
 *
 * ⚠️ `mes` **sí** incluye el día en curso, y es una decisión, no un descuido: «mes corrido» es la
 * convención que todo el mundo lee, y ahí el día parcial pesa 1/N (hoy, 1 de 15 ≈ 3 %) en vez de
 * 1/2. Se DECLARA con `incluye_dia_en_curso` para que la pantalla lo pueda decir. Excluirlo
 * además abriría un hueco el día 1 de cada mes, cuando no hay ningún día cerrado todavía.
 *
 * Para el pulso de hoy en vivo está `/tienda/live`, que es la pantalla que existe para eso.
 */
export type MeZonaPeriodo = 'dia' | 'semana' | 'mes';

export interface VentanaComparable {
  periodo: MeZonaPeriodo;
  desde: string;
  hasta: string;
  desde_comparado: string;
  hasta_comparado: string;
  /** `true` sólo en `mes`: el tramo llega a hoy, que va a medias. La pantalla lo dice. */
  incluye_dia_en_curso: boolean;
}

/** Suma días a `'YYYY-MM-DD'` sin tocar husos: todo en UTC, que acá es sólo aritmética. */
function masDias(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Días entre dos fechas `'YYYY-MM-DD'` (b − a). */
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * `[JZ.3]`/`[JZ.4]` El tramo y su comparador, según el grano.
 *
 * ⛔ **El recorte del mes corto** (sólo aplica a `mes`). El 31 de marzo, «los mismos 31 días de
 * febrero» no existen: `2026-02-01 + 30 días` es el **3 de marzo**, y el comparador se comería
 * tres días del mes que se está midiendo — inflándolo y bajando la variación de todos los canales
 * a la vez. El tope es el último día real del mes anterior, y entonces el tramo comparado queda
 * más corto: es un hecho del calendario, no un error, y por eso las cuatro fechas viajan en la
 * respuesta para que la pantalla pueda decir contra qué se comparó.
 *
 * @param hoy Fecha en hora de México (`'YYYY-MM-DD'`), tal como la devuelve `todayMx()`.
 */
export function ventanaComparable(
  hoy: string,
  periodo: MeZonaPeriodo = 'mes',
  hastaDato: string | null = null,
): VentanaComparable {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ayer = masDias(hoy, -1);
  /*
   * `[JZ.6]` **El ancla: el último día CERRADO que además tiene dato.**
   *
   * ⛔ Antes esto era un recorte aplicado DESPUÉS de armar la ventana, y con `dia` se rompía: el
   * tramo era el 16-sep, la venta por ruta había entregado hasta el 15, y como la fuente «no
   * entregó nada del tramo» se la leía como MUERTA en vez de atrasada — los 9 canales de ruta de
   * LA PIEDAD salieron «sin medir» por un día de rezago. Resolver el ancla ANTES lo arregla para
   * los tres granos a la vez, y de paso conserva la alineación por día de la semana: si el tramo
   * de un día se corre del martes al lunes, su comparador se corre con él.
   *
   * ⚠️ `hastaDato` sólo puede ACORTAR. Las dos fuentes tienen filas fechadas en el FUTURO
   * (`sales_daily` 4 del 6-dic-2026; la ruta 22 llega al 6-dic), y una fuente adelantada no puede
   * estirar el tramo hasta ahí.
   */
  const tope = (d: string) => (hastaDato && hastaDato < d ? hastaDato : d);

  if (periodo === 'dia') {
    // El último día CERRADO con dato, y contra el mismo día de la semana: martes contra martes.
    const dia = tope(ayer);
    return {
      periodo,
      desde: dia,
      hasta: dia,
      desde_comparado: masDias(dia, -7),
      hasta_comparado: masDias(dia, -7),
      incluye_dia_en_curso: false,
    };
  }

  if (periodo === 'semana') {
    /*
     * ⚠️ **7 días CERRADOS que ruedan, no la semana del calendario.** La semana natural
     * (lunes-a-hoy) tiene dos defectos que se suman: el día en curso puede ser la mitad del tramo
     * —medido, −31.9 % falso un martes— y el lunes el tramo se queda sin un solo día cerrado.
     * Los últimos 7 cerrados siempre traen **los siete días de la semana, una vez cada uno**, así
     * que el par es conmensurable por construcción: ni un sábado de más ni un domingo de menos.
     */
    const fin = tope(ayer);
    return {
      periodo,
      desde: masDias(fin, -6),
      hasta: fin,
      desde_comparado: masDias(fin, -13),
      hasta_comparado: masDias(fin, -7),
      incluye_dia_en_curso: false,
    };
  }

  /*
   * `mes` no se puede correr hacia atrás —empieza el día 1 y punto—, así que acá el ancla sí actúa
   * como RECORTE: `hasta` se topa en el último día con dato y el comparador se acorta al MISMO
   * número de días. Es el caso que destapó MORELIA ABASTOS: publicaba −26.1 % comparando 10 días
   * de septiembre contra 15 de agosto porque `wincaja_*` no entregaba desde el 10; con el tramo
   * parejo la zona sube 17.1 %. Recortar sólo arriba cambiaría una mentira por la opuesta.
   */
  const hasta = tope(hoy);
  const [y, m] = hoy.split('-').map(Number);
  const dias = diasEntre(`${y}-${pad(m)}-01`, hasta); // 0 el día 1
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  // Día 0 del mes siguiente = último día de `pm`. Cubre febrero y los bisiestos sin tabla.
  const ultimoPrev = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const desde_comparado = `${py}-${pad(pm)}-01`;
  return {
    periodo,
    desde: `${y}-${pad(m)}-01`,
    hasta,
    desde_comparado,
    hasta_comparado: masDias(desde_comparado, Math.min(dias, ultimoPrev - 1)),
    incluye_dia_en_curso: hasta === hoy,
  };
}

/**
 * `[JZ.5]` — Respuesta de `GET /users/me/work/zona`: **sólo** el bloque de zona.
 *
 * ── Por qué existe un endpoint aparte ───────────────────────────────────────────────────────
 * El WebSocket de tienda (`/store`, evento `ticket`) avisa cuando entra una venta. `me/work`
 * cuesta **14 mediciones** —6 bandejas + 4 fuentes de tarea + 4 ciclos— y un ticket sólo puede
 * mover UNA: la venta de la zona. En una zona de tres sucursales entra un ticket cada ~45 s
 * (medido: 18,958 en 30 días sólo en la sucursal 01), así que refrescar todo sería pagar el
 * reporte completo por cada venta.
 *
 * ⛔ `medido_at` no es decorativo: es lo único que distingue «el número está fresco» de «el
 * refresco falló y quedó el de antes». Cuando falla, `zona` viaja `null` con su `motivo` — no se
 * deja en pantalla un número viejo haciéndose pasar por nuevo (ADR-056).
 */
/**
 * `[JZ.7]` — **El total de las zonas de las que respondés, sobre UN SOLO tramo.**
 *
 * ⛔ Existe por la misma trampa que `[JZ.4]` corrigió una zona más abajo, ahora entre zonas: si
 * cada zona se midiera hasta donde llega SU fuente, el consolidado sumaría 15 días de LA PIEDAD
 * con 14 de MORELIA ABASTOS, y las zonas no serían comparables entre sí —que es exactamente lo
 * que un director hace con esta pantalla—. Por eso, **con más de una zona el tramo es el de la
 * fuente más lenta de TODAS**, y el recorte se declara en `MeZona.corte` de cada una.
 *
 * ⚠️ Consecuencia buscada y declarada: un director puede ver de LA PIEDAD una cifra **menor** que
 * su jefa de zona, porque ella la ve hasta donde llega su propio dato y él la ve hasta donde
 * llegan todas. Son dos preguntas distintas: *«¿cuánto llevo?»* contra *«¿cuál va mejor?»*.
 *
 * `null` cuando hay una sola zona: no hay nada que consolidar y un total idéntico al único bloque
 * sería ruido.
 */
export interface MeZonaConsolidado {
  /** Cuántas zonas entraron. */
  zonas: number;
  /** Suma de las zonas MEDIDAS. `null` si ninguna se pudo medir (ADR-056: nunca cero). */
  monto: number | null;
  comparado: number | null;
  variacion_pct: number | null;
  /** Mismo pareo que `MeZonaBloque.no_comparado`, un nivel más arriba: zonas que salieron. */
  no_comparado: { canales: number; monto_anterior: number } | null;
}

export interface MeWorkZona {
  /**
   * `[JZ.7]` Una entrada por zona de la que responde esta persona, de mayor a menor venta.
   * **1 para un jefe de zona; N para dirección.** Vacío = no responde de ninguna (o no se pudo
   * medir, y entonces `motivo` lo dice).
   */
  zonas: MeZona[];
  consolidado: MeZonaConsolidado | null;
  motivo: string | null;
  medido_at: string;
}

export interface MeWork {
  /** `[SN.15]` Lo que alguien te asignó. Separado de `pendientes` a propósito. */
  tareas: MeTarea[];
  pendientes: MePendiente[];
  /** `[SN.16]` Trabajo que se cierra mes por mes. Tercer organismo, ni tarea ni cola simple. */
  ciclos: MeCiclo[];
  /**
   * `[JZ.3]`/`[JZ.7]` Cómo van las zonas de esta persona. **Cuarto organismo**: no es trabajo
   * pendiente, es resultado. Vacío = no responde de ningún canal de venta, o su ficha no tiene
   * zona — las dos cosas se declaran en `no_medido` con su motivo, nunca se dibujan en cero.
   */
  zonas: MeZona[];
  /** `[JZ.7]` El total sobre un solo tramo. `null` con una sola zona. */
  consolidado: MeZonaConsolidado | null;
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
