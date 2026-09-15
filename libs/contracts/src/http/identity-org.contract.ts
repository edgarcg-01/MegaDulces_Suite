/**
 * `[AU.0]` — El vocabulario de la ORGANIZACIÓN en el boundary REST.
 *
 * Puesto, cadena de mando, responsabilidad e historia. Producer (`OrgController`)
 * y consumer (`/admin/*`) importan de acá, así que un cambio de forma es error de
 * compilación en los dos lados en vez de dos definiciones que se separan solas.
 *
 * No es una precaución teórica: `[VP.2.1]` documenta que el contrato de
 * procedencia **nació el 02-sep y a los tres días ya estaba copiado a mano** en
 * el frontend. La pantalla de usuarios que esto viene a reemplazar tiene sus 12
 * tipos de dominio declarados dentro de su propio `users.service.ts`.
 *
 * SIN deps de runtime: sólo tipos y constantes string.
 */

/** Los ejes que admite el CHECK `positions_scope_axis_check`. */
export const EJES_DE_ALCANCE = ['ruta', 'zona', 'sucursal', 'red', 'cartera', 'cliente'] as const;
export type EjeDeAlcance = (typeof EJES_DE_ALCANCE)[number];

/** `identity.user_responsibilities.accion`. */
export const ACCIONES_RESPONSABILIDAD = ['suma', 'resta'] as const;
export type AccionResponsabilidad = (typeof ACCIONES_RESPONSABILIDAD)[number];

/**
 * De dónde salió la fecha de inicio de un tramo de historia.
 *
 * ⚠️ Se muestran DISTINTO a propósito: `cambio` es un cambio observado de verdad,
 * `registro_sistema` es cuándo se creó la cuenta y `estimado_alta` es una
 * estimación. Pintarlos igual sería dar por medido lo que está estimado.
 */
export const ORIGENES_DE_TRAMO = ['cambio', 'registro_sistema', 'estimado_alta'] as const;
export type OrigenDeTramo = (typeof ORIGENES_DE_TRAMO)[number];

/** Una fila del catálogo de puestos, con lo que la pantalla necesita sin un segundo viaje. */
export interface PuestoFila {
  code: string;
  name: string;
  department_code: string | null;
  department_name: string | null;
  department_scope_axis: EjeDeAlcance | null;
  /** El rol que el puesto PROPONE. ⛔ No otorga: `role_permissions` + `user_roles` conceden. */
  default_role: string | null;
  default_complements: string[];
  /** Override del eje. `null` = hereda el del departamento. */
  scope_axis: EjeDeAlcance | null;
  /** `coalesce(positions.scope_axis, departments.scope_axis)` — la precedencia de `[ID.24.2]`. */
  eje_efectivo: EjeDeAlcance | null;
  orden: number;
  org_labels: string[];
  reports_to_position_code: string | null;
  reports_to_name: string | null;
  personas: number;
  responsabilidades: number;
  puestos_a_cargo: number;
}

export interface OcupanteDePuesto {
  id: string;
  username: string;
  nombre: string | null;
  role_name: string | null;
  warehouse_code: string | null;
  status: string;
}

export interface PuestoDetalle extends PuestoFila {
  responsabilidades_detalle: ResponsabilidadDePuesto[];
  ocupantes: OcupanteDePuesto[];
}

/** El catálogo de producto de responsabilidades (sin `tenant_id`, patrón `scope_dimensions`). */
export interface ResponsabilidadFila {
  key: string;
  label: string;
  descripcion: string;
  /** Dimensión de `ScopeService` por la que se enruta, o `null` si la cola no tiene eje. */
  dimension: string | null;
  orden: number;
  permission_keys: string[];
  /**
   * ⚠️ `false` NO significa «no necesita permiso»: significa que **nadie declaró
   * cuál la abre**, y entonces el cruce responsabilidad × permiso no la puede
   * juzgar. La pantalla lo dice en vez de pintarlo verde.
   */
  claves_declaradas: boolean;
  puestos: number;
  personas_directas: number;
}

export interface ResponsabilidadDePuesto {
  responsibility_key: string;
  label: string;
  dimension: string | null;
  permission_keys: string[];
  es_principal: boolean;
  claves_declaradas: boolean;
  /**
   * ⛔ **Diagnóstico, no compuerta.** `true` = el perfil del puesto abre alguna de
   * las claves. `false` = responde de algo que no puede abrir → la respuesta es
   * arreglar el ROL, no que la responsabilidad conceda el permiso (ADR-054).
   * `null` = no se puede juzgar porque la responsabilidad no declara claves.
   */
  abre: boolean | null;
}

/** La excepción por persona. `nota` es obligatoria y el CHECK de la base la exige no-vacía. */
export interface ResponsabilidadDePersona {
  id: string;
  responsibility_key: string;
  label: string;
  dimension: string | null;
  accion: AccionResponsabilidad;
  nota: string;
  valid_from: string;
  valid_to: string | null;
  vigente: boolean;
  created_at: string;
  created_by: string | null;
}

/**
 * Heredadas y propias van SEPARADAS a propósito: mezclarlas haría invisible la
 * única pregunta que importa al auditar — *¿le toca por el puesto, o alguien se
 * lo asignó a ella con nombre y fecha?*
 */
/** El inverso de `ResponsabilidadDePuesto`: quién responde de una responsabilidad. */
export interface PuestoQueResponde {
  position_code: string;
  position_name: string;
  es_principal: boolean;
  personas: number;
  /** ⛔ Diagnóstico, no compuerta. `null` = la responsabilidad no declara permisos. */
  abre: boolean | null;
}

export interface ResponsabilidadesDePersona {
  user_id: string;
  username: string;
  position_code: string | null;
  heredadas: Array<Pick<ResponsabilidadDePuesto, 'responsibility_key' | 'label' | 'dimension' | 'es_principal'>>;
  propias: ResponsabilidadDePersona[];
  /** El resultado: el puesto pone la base, la excepción por persona gana. */
  efectivo: string[];
}

export interface TramoDePuesto {
  position_code: string | null;
  department_code: string | null;
  desde: string;
  hasta: string | null;
  vigente: boolean;
  desde_origen: OrigenDeTramo;
  motivo: string | null;
  actor_username: string | null;
  registrado_at: string;
}

export interface HistoriaDePuesto {
  user_id: string;
  tramos: TramoDePuesto[];
}

/** Un desacuerdo entre los tres ejes. `dice` ya viene redactado por la vista. */
export interface FilaDeCoherencia {
  tipo: string;
  sujeto: string;
  detalle: string | null;
  cuantos: number;
  de_cuantos: number | null;
  /** La frase en castellano, lista para mostrar. La pantalla no reescribe el diagnóstico. */
  dice: string;
}

export interface Coherencia {
  total: number;
  por_tipo: Record<string, number>;
  filas: FilaDeCoherencia[];
  medido_at: string;
}

/**
 * Una fila del padrón — exactamente lo que el `SELECT` de `UsersService.findAll`
 * devuelve. Está acá y no dentro del servicio de la pantalla porque es la
 * respuesta de un endpoint, no una vista del cliente.
 */
export interface PersonaFila {
  id: string;
  username: string;
  nombre: string | null;
  warehouse_name: string | null;
  zona: string | null;
  zona_id: string | null;
  role_name: string | null;
  /** @deprecated usar `status`: un booleano no distingue `suspended` de `terminated`. */
  activo: boolean;
  /** El ciclo de vida. `[ID.8]` lo declaró fuente de verdad y `activo` se deriva. */
  status: EstadoDePersona;
  supervisor_id: string | null;
  warehouse_code: string | null;
  route_id: string | null;
  department_code: string | null;
  department_name: string | null;
  position_code: string | null;
  position_name: string | null;
  finance_expense_area_ids: string[] | null;
  created_at: string;
  last_login_at: string | null;
  last_login_ip: string | null;
  /** `[CH.1.7]` Cuánto vive el token: la lista auditable de «quién tiene sesión larga». */
  token_ttl_days: number | null;
  kind: string;
  has_route_today: boolean;
  route_name_today: string | null;
}

/**
 * Los cuatro estados de una cuenta (`[ID.8]`). `activo` es el booleano deprecado
 * que no distingue una baja temporal de una definitiva.
 */
export const ESTADOS_DE_PERSONA = ['invited', 'active', 'suspended', 'terminated'] as const;
export type EstadoDePersona = (typeof ESTADOS_DE_PERSONA)[number];

/**
 * Lo que el padrón cuenta sobre SÍ MISMO: mismo alcance, mismos filtros, antes de
 * paginar. `[AU.12]` — la tira de KPI se calculaba en el navegador sobre la
 * página y se leía como el padrón entero.
 */
export interface ResumenDelPadron {
  sin_puesto: number;
  sin_jefe: number;
  sesion_larga: number;
  nunca_entraron: number;
}

/**
 * `[AU.21]` — El alcance de una persona, dimensión por dimensión.
 *
 * Lo devuelve `GET /users/:id/scope` vía `ScopeService.describe()`. Trae todo lo
 * que hace falta para EDITARLO, no sólo para mostrarlo: qué modo tiene, de dónde
 * sale, qué valores están marcados hoy y **cuáles se pueden elegir**.
 */
export const MODOS_DE_ALCANCE = ['none', 'own', 'listed', 'all'] as const;
export type ModoDeAlcance = (typeof MODOS_DE_ALCANCE)[number];

export interface DimensionDeAlcance {
  mode: ModoDeAlcance;
  modeWrite: ModoDeAlcance;
  /** `user` = override propio · `role` = lo hereda · `default` = no hay regla. */
  source: 'user' | 'role' | 'default';
  nota: string | null;
  values: string[];
  valuesWrite: string[];
  /** `own` sólo se ofrece donde la dimensión lo admite (`identity.scope_dimensions`). */
  supportsOwn: boolean;
  /** `[ID.26]` `false` = no se sabe qué ve, que NO es lo mismo que «no ve nada». */
  resolvable: boolean;
  options: Array<{ value: string; label: string }>;
}

export interface AlcanceDePersona {
  user_id: string;
  role_name: string | null;
  dimensions: Record<string, DimensionDeAlcance>;
}

/** El sobre paginado de `GET /users` (`[AU.0b]`). */
export interface PadronPagina<T> {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
  /** Contado sobre el mismo builder que `total`, no sobre `rows`. */
  resumen: ResumenDelPadron;
  medido_at: string;
}

/**
 * Lo que el puesto PROPONE al dar de alta (`GET /users/positions/:code/propuesta`).
 *
 * ⛔ Propone, no otorga. Y la pantalla vieja **no llamaba este endpoint**:
 * recalculaba la propuesta en el cliente desde `GET /users/positions`, así que
 * sólo veía `default_role` — el jefe, las responsabilidades y los complementos
 * que `[OR.2]` agregó eran invisibles.
 */
export interface PropuestaDePuesto {
  position_code: string;
  position_name: string;
  department_code: string | null;
  department_name: string | null;
  /** El perfil base propuesto. Se llama `role_name`, no `default_role`. */
  role_name: string | null;
  /** `true` cuando el puesto no propone perfil: 20 de 57 están así. */
  sin_perfil: boolean;
  /** `[OR.7.0b]` Complementos. ⛔ Propone; quien concede es `identity.user_roles`. */
  complementos: string[];
  /**
   * `[OR.1a]` El jefe que propone el PUESTO, con quién lo ocupa hoy.
   * `ocupantes: []` + `jefe_sin_ocupante` = la cadena es correcta pero el
   * escalamiento no llega a nadie, y eso hay que poder verlo.
   */
  reports_to: {
    code: string;
    name: string;
    ocupantes: Array<{ id: string; username: string; nombre: string | null }>;
  } | null;
  jefe_sin_ocupante: boolean;
  /**
   * ⚠️ Vacío **no** se lee como «no responde de nada»: por eso viaja
   * `sin_responsabilidades` al lado.
   */
  responsabilidades: Array<{
    key: string;
    label: string;
    dimension: string | null;
    es_principal: boolean;
  }>;
  sin_responsabilidades: boolean;
  /** Resolución puesto → departamento (`[ID.24]`). */
  scope_axis: EjeDeAlcance | null;
  /**
   * El alcance que hoy tiene el ROL propuesto. Se muestra, pero la fuente sigue
   * siendo una sola (`identity.role_scopes`): el puesto no gobierna el alcance.
   */
  alcance: Array<{
    dimension: string;
    mode: string;
    values: string[] | null;
    mode_write: string | null;
  }>;
}
