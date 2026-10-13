// EMB.32 — Alta rápida de una persona del padrón de logística desde donde se necesita (la guía, los
// cargadores del cierre), sin ir a Logística › Personal.
//
// Medido en prod el 2026-10-13: 0 ayudantes y 0 cargadores activos (los 31 «chofer + ayudante» se
// dieron de baja a mano en mayo-junio), así que la guía no se podía completar con ayudante. Y quien
// completa guías no siempre puede dar de alta personal (el rol repartidor tiene
// LOGISTICS_GUIDES_GESTIONAR pero no LOGISTICS_FLEET_GESTIONAR): por eso esta alta es aparte y sólo
// recibe nombre y papel.
//
// ⛔ Nunca crea un duplicado: si ya existe alguien con el mismo nombre (sin importar acentos,
// mayúsculas ni espacios) se usa ese y se le agrega el papel; si estaba dado de baja, se reactiva.

/** Los papeles que se pueden dar de alta así. Chofer no: el chofer viene de Kepler o del padrón. */
export type RolAltaRapida = 'ayudante' | 'cargador';

/** `POST /logistics/fleet/drivers/alta-rapida` */
export interface AltaRapidaBody {
  full_name: string;
  rol: RolAltaRapida;
}

/** Qué pasó con la persona. */
export type AccionAltaRapida =
  | 'creada'          // no existía: se dio de alta
  | 'ya_existia'      // ya estaba activa con ese papel: no se tocó
  | 'papel_agregado'  // estaba activa con otro papel (p. ej. chofer): se le agregó éste
  | 'reactivada';     // estaba dada de baja o inactiva: se reactivó con este papel

export interface AltaRapidaResultado {
  accion: AccionAltaRapida;
  driver: { id: string; full_name: string; roles: string[]; active: boolean; status: string };
}

export const NOMBRE_MIN = 5;
export const NOMBRE_MAX = 120;

/** Mayúsculas, sin acentos y con un solo espacio: así se comparan dos nombres. */
export function nombreComparable(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9Ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Cómo se guarda: mayúsculas y un solo espacio, conservando acentos (así está el padrón). */
export function nombreParaGuardar(s: string): string {
  return String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Todo lo que impide el alta. Vacío = se puede. */
export function erroresDeAltaRapida(body: Partial<AltaRapidaBody> | null | undefined): string[] {
  const e: string[] = [];
  const b = body ?? {};
  const n = nombreParaGuardar(b.full_name ?? '');
  if (n.length < NOMBRE_MIN) e.push('Escribe el nombre completo.');
  else if (n.length > NOMBRE_MAX) e.push('El nombre es demasiado largo.');
  else if (!n.includes(' ')) e.push('Escribe nombre y apellido.');
  else if (!/[A-ZÁÉÍÓÚÜÑ]/.test(n)) e.push('El nombre debe tener letras.');
  if (b.rol !== 'ayudante' && b.rol !== 'cargador') e.push('El papel debe ser ayudante o cargador.');
  return e;
}

export interface PersonaPadron {
  id: string;
  full_name: string;
  roles: string[] | null;
  active: boolean;
  status: string;
  deleted_at: string | Date | null;
  updated_at?: string | Date | null;
}

/**
 * Qué hacer con un alta: usar a alguien que ya existe o crear. Entre varios con el mismo nombre
 * gana el activo; entre los dados de baja, el más reciente.
 */
export function decidirAltaRapida(
  padron: readonly PersonaPadron[], nombre: string, rol: RolAltaRapida,
): { accion: AccionAltaRapida; persona: PersonaPadron | null } {
  const clave = nombreComparable(nombre);
  const iguales = padron.filter((p) => nombreComparable(p.full_name) === clave);
  const vigente = (p: PersonaPadron) => !p.deleted_at && p.active && p.status === 'activo';
  const activa = iguales.find(vigente);
  if (activa) {
    return { accion: (activa.roles ?? []).includes(rol) ? 'ya_existia' : 'papel_agregado', persona: activa };
  }
  const t = (p: PersonaPadron) => new Date((p.updated_at ?? p.deleted_at ?? 0) as string).getTime() || 0;
  const baja = [...iguales].sort((a, b) => t(b) - t(a))[0];
  if (baja) return { accion: 'reactivada', persona: baja };
  return { accion: 'creada', persona: null };
}
