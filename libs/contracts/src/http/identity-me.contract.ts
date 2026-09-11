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
 *  · `'mio'`    — la fila trae el `user_id` de esta persona (conteo asignado, revisión a su nombre).
 *  · `'bandeja'`— cola COMPARTIDA que esta persona puede trabajar por su permiso. Nadie la repartió.
 *
 * Medido en prod 2026-09-10: la asignación por persona existe como tabla en tres lugares
 * (`finance.recon_tasks`, `commercial.supervisor_tasks`, `trade.daily_assignments`) y las tres
 * están en CERO filas. O sea: hoy nadie reparte trabajo. La pantalla lo dice con estas dos
 * etiquetas en vez de fingir que una cola compartida es una asignación personal.
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
}

/**
 * `[SN.7]` — Respuesta de `GET /users/me/work`.
 *
 * Sólo se cuentan las bandejas cuyo permiso tiene esta persona: un conteo es información, y una
 * cola que no podés abrir no es tu trabajo. Lo que no se pudo contar va a `no_medido` con motivo
 * — NUNCA baja a cero (ADR-056: un cero dibujado se lee igual que "estás al día").
 */
export interface MeWork {
  pendientes: MePendiente[];
  no_medido: { id: string; label: string; motivo: string }[];
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
