/**
 * `[OR.4]` — El contrato ÚNICO de tarea asignada.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * ADR-056 lo nombró: **un primitivo inventado en una fase no cierra la fase hasta que vive en
 * `libs/`**. El reparto de trabajo se construyó **cuatro veces**, cada una en su fase, y ninguna
 * subió acá. Medido en prod (2026-09-11), con el discriminador honesto de una tarea —que alguien
 * **se la asignó a otro**, o sea alguna columna `assigned_(to|by|at)`— son exactamente cuatro:
 *
 *     finance.recon_tasks                    22 filas   modelo completo (9 campos del núcleo)
 *     trade.daily_assignments               119 filas   ruta por día de la semana
 *     commercial.inventory_count_assignments 18 filas   quién cuenta qué pasillo
 *     commercial.supervisor_tasks             2 filas   modelo completo, otro dialecto
 *
 * (`public.daily_assignments` es la vista passthrough de `trade.daily_assignments`, no una quinta.)
 *
 * ⛔ **Esto NO crea una tabla.** Una quinta tabla de tareas sería repetir el error que el contrato
 * viene a cerrar. Lo que crea es el **vocabulario común** y el **mapeo declarado** de cada tabla a
 * ese vocabulario: mismo criterio que la regla «derivar, no copiar» del proyecto.
 *
 * ── Las divergencias que había que reconciliar (medidas, no supuestas) ───────────────────────
 *
 * | rol            | recon_tasks              | supervisor_tasks   | count_assignments | daily_assignments |
 * |----------------|--------------------------|--------------------|-------------------|-------------------|
 * | asignado a     | `assigned_to` uuid       | `assigned_to_user` | `user_id`         | `user_id`         |
 * | quién asignó   | `assigned_by` **TEXT**   | `created_by` uuid  | `assigned_by` uuid| `assigned_by` uuid|
 * | cuándo         | `assigned_at`            | `created_at`       | `created_at`      | `created_at`      |
 * | vence          | `due_at` timestamptz     | `due_date` **date**| —                 | `day_of_week`     |
 * | estado         | pendiente/en_proceso/…   | pending/done/…     | **—**             | pendiente (fijo)  |
 * | quién cerró    | `resolved_by` **TEXT**   | **—**              | —                 | —                 |
 * | con qué nota   | `resolution_note`        | **—**              | —                 | —                 |
 *
 * Tres cosas que eso destapa y que el contrato NO disimula:
 *
 *  1. **Dos lenguas para los mismos estados.** `pendiente` vs `pending`, `resuelto` vs `done`.
 *     El canónico va en inglés (CLAUDE.md: columnas y campos nuevos en English snake_case) y cada
 *     tabla declara su dialecto. **Nada se migra en la base**: un `UPDATE` masivo de estados no
 *     agrega información y sí agrega riesgo.
 *  2. **`assigned_by` es TEXT en `recon_tasks` y UUID en las otras tres**, y `resolved_by` también
 *     es TEXT. Por eso el contrato tipa a la persona como `PersonaRef`, que admite las dos formas
 *     y **declara cuál trae cada tabla** — colapsarlas a `string` escondería que una no se puede
 *     unir contra `identity.users`.
 *  3. **`commercial.supervisor_tasks` registra `done_at` y no registra QUIÉN cerró ni con qué
 *     nota.** No es un campo que falte llenar: la columna no existe. Se declara en `no_responde`.
 *
 * ── La regla que ordena todo esto ───────────────────────────────────────────────────────────
 * ⛔ **El PERMISO decide si podés abrirlo; la RESPONSABILIDAD decide si es tuyo; la TAREA dice que
 * alguien te lo asignó a vos, con nombre y fecha.** Son tres preguntas distintas y ninguna
 * reemplaza a las otras. Una cola sin `assigned_to` no es una tarea: es una bandeja.
 */

/**
 * Los estados canónicos. **No son una invención**: son la unión de lo que los dos CHECK de prod
 * ya admiten (`recon_tasks`: pendiente/en_proceso/resuelto/no_aplica · `supervisor_tasks`:
 * pending/done/cancelled), traducidos a una sola lengua.
 *
 * ⚠️ `cancelled` y `not_applicable` **NO son lo mismo** y no se colapsan: «se canceló» es que la
 * tarea se dio de baja; «no aplica» es que el hallazgo que la originó no era real. Fundirlos
 * borraría justo la señal que alimenta el feedback de precisión de Maat (`[MAAT.2]`).
 */
export const ESTADOS_TAREA = [
  'pending',
  'in_progress',
  'done',
  'cancelled',
  'not_applicable',
] as const;
export type EstadoTarea = (typeof ESTADOS_TAREA)[number];

/** Estados que cuentan como trabajo VIVO. Lo demás ya no le toca a nadie. */
export const ESTADOS_ABIERTOS: readonly EstadoTarea[] = ['pending', 'in_progress'];

/**
 * Quién. `id` cuando la tabla guarda un uuid unible contra `identity.users`; `label` cuando sólo
 * guarda texto (el caso de `recon_tasks.assigned_by` y `resolved_by`).
 *
 * ⚠️ Un `label` sin `id` **no se puede unir al padrón**: sirve para mostrar, no para filtrar por
 * persona ni para preguntar «¿qué le toca a Fulano?». Que el tipo lo haga visible es el punto.
 */
export interface PersonaRef {
  id: string | null;
  label: string | null;
}

/** De dónde nació la tarea. */
export type OrigenTarea =
  /** La disparó una regla, un detector o un barrido. */
  | 'derivada'
  /** La creó una persona — típicamente un jefe (`positions.reports_to_position_code`). */
  | 'manual';

/**
 * La forma canónica de una tarea asignada. Es un tipo de LECTURA: cada tabla se proyecta a esto
 * con su adaptador. No hay una tabla con estas columnas y no debe haberla.
 */
export interface TareaAsignada {
  /** `<schema>.<tabla>:<id>` — único entre las cuatro fuentes. */
  readonly ref: string;
  readonly fuente: FuenteTarea;
  readonly id: string;
  readonly tenant_id: string;
  /** Qué hay que hacer, en una línea. */
  readonly titulo: string;
  readonly asignado_a: PersonaRef;
  readonly asignado_por: PersonaRef;
  readonly asignado_at: string | null;
  /** `null` = la fuente no maneja vencimiento. NO es «no vence». */
  readonly vence_at: string | null;
  readonly estado: EstadoTarea;
  readonly origen: OrigenTarea;
  readonly cerrado_at: string | null;
  readonly cerrado_por: PersonaRef;
  readonly nota_cierre: string | null;
}

/** Las cuatro fuentes registradas. Una quinta tiene que declararse acá o el gate falla. */
export const FUENTES_TAREA = [
  'finance.recon_tasks',
  'commercial.supervisor_tasks',
  'commercial.inventory_count_assignments',
  'trade.daily_assignments',
] as const;
export type FuenteTarea = (typeof FUENTES_TAREA)[number];

/**
 * El mapeo declarado de cada tabla al vocabulario común.
 *
 * `no_responde` es la parte que más importa: enumera lo que esa fuente **no puede contestar**.
 * Sin eso, un `null` en `vence_at` se lee igual que «no vence» y un `estado` fijo se lee igual que
 * «nadie lo movió» (ADR-056: lo que no se puede medir se DECLARA).
 */
export interface AdaptadorTarea {
  readonly fuente: FuenteTarea;
  /** Columna con el uuid de la persona asignada. */
  readonly col_asignado_a: string;
  /** Columna de quién asignó, y si es uuid o texto suelto. */
  readonly col_asignado_por: string;
  readonly asignado_por_es_uuid: boolean;
  readonly col_asignado_at: string;
  readonly col_vence: string | null;
  readonly col_estado: string | null;
  /** dialecto de la tabla -> canónico. */
  readonly estados: Readonly<Record<string, EstadoTarea>>;
  /** Estado a usar cuando la tabla no tiene columna de estado. */
  readonly estado_fijo: EstadoTarea | null;
  readonly origen: OrigenTarea;
  /** Lo que esta fuente NO puede contestar, con el motivo. */
  readonly no_responde: readonly string[];
}

export const ADAPTADORES: readonly AdaptadorTarea[] = [
  {
    fuente: 'finance.recon_tasks',
    col_asignado_a: 'assigned_to',
    col_asignado_por: 'assigned_by',
    // ⚠️ TEXT, no uuid: no se puede unir contra identity.users.
    asignado_por_es_uuid: false,
    col_asignado_at: 'assigned_at',
    col_vence: 'due_at',
    col_estado: 'status',
    estados: {
      pendiente: 'pending',
      en_proceso: 'in_progress',
      resuelto: 'done',
      no_aplica: 'not_applicable',
    },
    estado_fijo: null,
    origen: 'derivada',
    no_responde: [
      'quien asigno y quien resolvio son TEXT: se muestran, no se unen al padron',
      'no admite `cancelled`: su CHECK no lo declara',
    ],
  },
  {
    fuente: 'commercial.supervisor_tasks',
    col_asignado_a: 'assigned_to_user',
    // No tiene `assigned_by`: quien la creo es lo mas cerca que hay.
    col_asignado_por: 'created_by',
    asignado_por_es_uuid: true,
    col_asignado_at: 'created_at',
    col_vence: 'due_date',
    col_estado: 'status',
    estados: { pending: 'pending', done: 'done', cancelled: 'cancelled' },
    estado_fijo: null,
    origen: 'manual',
    no_responde: [
      'QUIEN cerro la tarea: solo guarda `done_at`. La columna no existe',
      'con QUE nota se cerro: no hay `resolution_note`',
      'no admite `in_progress` ni `not_applicable`: su CHECK no los declara',
      '`due_date` es DATE: la hora del vencimiento no existe',
    ],
  },
  {
    fuente: 'commercial.inventory_count_assignments',
    col_asignado_a: 'user_id',
    col_asignado_por: 'assigned_by',
    asignado_por_es_uuid: true,
    col_asignado_at: 'created_at',
    col_vence: null,
    col_estado: null,
    estados: {},
    // El ciclo de vida vive en `commercial.inventory_counts.status`, no en la
    // asignacion: la fila dice quien cuenta, la sesion dice como va.
    estado_fijo: 'pending',
    origen: 'manual',
    no_responde: [
      'estado propio: el ciclo de vida esta en commercial.inventory_counts.status',
      'vencimiento: lo fija la sesion de conteo, no la asignacion',
      'cierre: no hay `done_at` ni quien ni nota',
    ],
  },
  {
    fuente: 'trade.daily_assignments',
    col_asignado_a: 'user_id',
    col_asignado_por: 'assigned_by',
    asignado_por_es_uuid: true,
    col_asignado_at: 'created_at',
    // `day_of_week` NO es un vencimiento: es una recurrencia semanal.
    col_vence: null,
    col_estado: 'status',
    estados: { pendiente: 'pending' },
    estado_fijo: null,
    origen: 'manual',
    no_responde: [
      'su `status` NO es una maquina de estados: 119 de 119 filas estan en `pendiente`, sin CHECK que declare otros valores. Es decoracion, no ciclo de vida',
      '`day_of_week` es recurrencia semanal, no fecha limite: por eso `vence_at` va NULL',
      'cierre: no hay `done_at` ni quien ni nota',
    ],
  },
];

/** El adaptador de una fuente. Lanza si la fuente no está registrada — el gate en tiempo de uso. */
export function adaptadorDe(fuente: FuenteTarea): AdaptadorTarea {
  const a = ADAPTADORES.find((x) => x.fuente === fuente);
  if (!a) {
    throw new Error(
      `[OR.4] "${fuente}" no esta en ADAPTADORES. Una fuente de tareas nueva se DECLARA aca; ` +
        `no se crea una quinta tabla ni se la consume sin mapeo.`,
    );
  }
  return a;
}

/**
 * Traduce el estado de una fuente al canónico.
 *
 * ⚠️ Un valor que el adaptador no declara **no se adivina**: devuelve `null`. Mapearlo a `pending`
 * por defecto convertiría un dato desconocido en trabajo vivo, que es la clase de default
 * disfrazado que ADR-056 prohíbe.
 */
export function estadoCanonico(
  fuente: FuenteTarea,
  valor: string | null | undefined,
): EstadoTarea | null {
  const a = adaptadorDe(fuente);
  if (a.col_estado === null) return a.estado_fijo;
  if (valor == null) return null;
  return a.estados[valor] ?? null;
}

/** ¿Le toca a alguien todavía? */
export function estaAbierta(estado: EstadoTarea | null): boolean {
  return estado !== null && ESTADOS_ABIERTOS.includes(estado);
}

/**
 * Lo que NINGUNA de las cuatro fuentes puede contestar hoy. Se declara junto al contrato para que
 * quien lo lea no lo descubra a los tres meses.
 */
export const LIMITES_DEL_CONTRATO: readonly string[] = [
  'Tres de las cuatro fuentes no registran quien cerro la tarea; dos no registran nota de cierre.',
  'Solo `finance.recon_tasks` tiene las cuatro puntas del ciclo (asignar, vencer, cerrar, explicar).',
  'Ninguna fuente tiene columna de RESPONSABILIDAD: el enlace tarea -> identity.responsibilities es [OR.3].',
  'El contrato es de LECTURA. Crear tareas sigue siendo cosa de cada modulo; unificarlo exigiria tocar cuatro escrituras vivas y no lo pide nadie todavia.',
];
