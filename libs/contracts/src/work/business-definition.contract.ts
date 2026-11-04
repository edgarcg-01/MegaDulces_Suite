/**
 * `[DP.1.1]` — Definiciones de negocio: **la pregunta vive en el sistema** (Fase DP).
 *
 * Una regla que sólo el negocio conoce —un tabulador, un monto, cuántas faltas pierden un bono— se
 * PREGUNTA como fila de `platform.business_definitions`, con dueño y tipo de respuesta. Contestarla es
 * insertar una vigencia en `platform.business_definition_answers`. El consumidor (el motor de
 * comisiones, un indicador) la lee por `key` con `resolverDefinicion()`.
 *
 * ⛔ ADR-056: **lo que nadie contestó se DECLARA `sin_definir`**, nunca se rellena con un default ni
 * con la propuesta. Una propuesta (`suggested_value`) es lo que alguien dijo FUERA del sistema —un
 * chat, una junta— y no tiene usuario, fecha ni motivo: se muestra al lado, no se usa (D2).
 *
 * Sólo tipos y funciones puras: no pega al bundle.
 */

export const TIPOS_DEFINICION = [
  'number', 'money', 'percent', 'boolean', 'text', 'date', 'choice', 'choices', 'config_ref',
] as const;
export type TipoDefinicion = (typeof TIPOS_DEFINICION)[number];

/** Los tres estados del CHECK de `platform.business_definitions.status`. */
export const ESTADOS_DEFINICION = ['pendiente', 'respondida', 'descartada'] as const;
export type EstadoDefinicion = (typeof ESTADOS_DEFINICION)[number];

export interface OpcionDefinicion {
  readonly value: string;
  readonly label: string;
}

export interface DefinicionNegocio {
  readonly id: string;
  readonly key: string;
  readonly area: string;
  /** Quién la lee (`commercial.commissions`). */
  readonly consumer: string;
  readonly question: string;
  /** Qué decide, o qué queda frenado mientras no se conteste. */
  readonly decides: string;
  readonly value_type: TipoDefinicion;
  readonly choices: readonly OpcionDefinicion[] | null;
  readonly unit: string | null;
  /** Para `config_ref`: la pantalla donde se configura la respuesta. */
  readonly config_route: string | null;
  readonly suggested_value: unknown;
  readonly suggested_source: string | null;
  readonly status: EstadoDefinicion;
  readonly assigned_to: string | null;
  readonly due_at: string | null;
}

export interface RespuestaDefinicion {
  readonly id: string;
  readonly definition_id: string;
  readonly value: unknown;
  /** `YYYY-MM-DD`. Desde cuándo rige. */
  readonly valid_from: string;
  readonly note: string;
  readonly answered_by: string;
  readonly answered_at: string;
}

export type DefinicionResuelta =
  | { readonly estado: 'definida'; readonly valor: unknown; readonly respuesta: RespuestaDefinicion }
  /**
   * `motivo` dice POR QUÉ no hay valor, porque no es lo mismo que nadie haya contestado a que la
   * respuesta todavía no rija en la fecha pedida, o que la pregunta se haya descartado.
   */
  | { readonly estado: 'sin_definir'; readonly motivo: 'sin_respuesta' | 'no_rige_aun' | 'descartada' };

/**
 * `[DP.2.1]` Lo que la API devuelve de una pregunta: la definición, su dueño con nombre y la
 * respuesta que rige HOY (o «sin definir» con su motivo). La pantalla y el servidor leen esta forma.
 */
export interface DefinicionVista extends DefinicionNegocio {
  /** Nombre de quien la contesta. `null` = sin dueño (D4). */
  readonly asignado_nombre: string | null;
  readonly answered_at: string | null;
  readonly discard_reason: string | null;
  readonly vigente: DefinicionResuelta;
  /** Cuántas respuestas tiene, contando las que ya no rigen. */
  readonly respuestas: number;
}

/** Body de `POST /definitions/:id/answers`. */
export interface ContestarDefinicion {
  value: unknown;
  /** `YYYY-MM-DD`. Desde cuándo rige. */
  valid_from: string;
  /** Por qué: obligatorio. Es lo único que explica la regla seis meses después. */
  note: string;
}

/** Body de `PATCH /definitions/:id`. Sólo lo que se manda cambia. */
export interface ActualizarDefinicion {
  /** uuid de la persona que la contesta; `null` la deja sin dueño. */
  assigned_to?: string | null;
  /** ISO; `null` quita el plazo. */
  due_at?: string | null;
  /** Descarta la pregunta con este motivo. Sólo una `pendiente`. */
  discard_reason?: string;
}

/** A quién se le puede asignar una pregunta (`GET /definitions/assignable`). */
export interface PersonaAsignable {
  readonly id: string;
  readonly nombre: string;
  readonly puesto: string | null;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El valor de una respuesta tiene que corresponder al tipo de la pregunta. El CHECK de la base no
 * lo puede revisar (está en otra tabla): esto se llama ANTES de insertar. Devuelve el motivo del
 * rechazo, o `null` si el valor sirve.
 */
export function validarRespuesta(def: Pick<DefinicionNegocio, 'value_type' | 'choices'>, valor: unknown): string | null {
  const opciones = new Set((def.choices ?? []).map((c) => c.value));
  switch (def.value_type) {
    case 'number':
    case 'money':
      return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0
        ? null : 'tiene que ser un número mayor o igual a cero';
    case 'percent':
      return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 && valor <= 100
        ? null : 'tiene que ser un porcentaje entre 0 y 100';
    case 'boolean':
      return typeof valor === 'boolean' ? null : 'tiene que ser sí o no';
    case 'text':
      return typeof valor === 'string' && valor.trim().length > 0 ? null : 'no puede ir vacío';
    case 'date':
      return typeof valor === 'string' && FECHA.test(valor) && !Number.isNaN(Date.parse(valor))
        ? null : 'tiene que ser una fecha AAAA-MM-DD';
    case 'choice':
      return typeof valor === 'string' && opciones.has(valor) ? null : 'tiene que ser una de las opciones';
    case 'choices':
      return Array.isArray(valor) && valor.length > 0 && valor.every((v) => typeof v === 'string' && opciones.has(v))
        && new Set(valor).size === valor.length
        ? null : 'tiene que ser una o varias de las opciones, sin repetir';
    case 'config_ref':
      // Se contesta configurando en `config_route`; la respuesta guarda a qué configuración apunta.
      return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
        && typeof (valor as Record<string, unknown>)['ref'] === 'string'
        && ((valor as Record<string, unknown>)['ref'] as string).trim().length > 0
        ? null : 'tiene que apuntar a la configuración que la contesta ({ ref })';
    default:
      return 'tipo de pregunta desconocido';
  }
}

/**
 * La respuesta VIGENTE a una fecha: entre las que ya rigen (`valid_from` ≤ fecha), la contestada MÁS
 * TARDE — una respuesta nueva reescribe la regla desde su vigencia en adelante, también hacia atrás
 * (una reversa retroactiva). Si dos se contestaron a la vez, la de vigencia más alta. Nunca cae a la
 * propuesta ni a un default.
 */
export function resolverDefinicion(
  def: Pick<DefinicionNegocio, 'id' | 'status'>,
  respuestas: readonly RespuestaDefinicion[],
  fecha: string,
): DefinicionResuelta {
  if (def.status === 'descartada') return { estado: 'sin_definir', motivo: 'descartada' };
  const propias = respuestas.filter((r) => r.definition_id === def.id);
  if (!propias.length) return { estado: 'sin_definir', motivo: 'sin_respuesta' };
  // ⭐ Manda la CONTESTADA MÁS TARDE entre las que ya rigen, no la de vigencia más alta. Con «la
  // vigencia más alta», una reversa retroactiva perdía: «sigue al tipo de ruta» (contestada el
  // 20-oct, rige desde jul) le ganaba a «sigue al chofer» (contestada el 3-nov, rige desde sep)
  // para toda fecha posterior al 20-oct. Una respuesta nueva reescribe la regla desde su vigencia.
  const vigentes = propias
    .filter((r) => r.valid_from <= fecha)
    .sort((a, b) => (a.answered_at === b.answered_at
      ? (a.valid_from < b.valid_from ? 1 : -1)
      : Date.parse(b.answered_at) - Date.parse(a.answered_at)));
  const r = vigentes[0];
  if (!r) return { estado: 'sin_definir', motivo: 'no_rige_aun' };
  return { estado: 'definida', valor: r.value, respuesta: r };
}
