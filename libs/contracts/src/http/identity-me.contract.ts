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
 * un mecanismo genérico no cierra su item hasta vivir en `libs/` compartido. Acá sí corre jest.
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
