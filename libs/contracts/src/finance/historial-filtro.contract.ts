/**
 * `[GX.78]` — **Los filtros del Historial de levantamientos.**
 *
 * El Historial de «Todos» junta ~400 levantamientos al mes y hasta 90 en un día, y no había
 * forma de ver sólo los que importan: los que esperan firma, los de una sucursal, los de una
 * persona. Esta regla la leen DOS lados y por eso vive acá:
 *
 *  · el **servidor**, que acota el calendario (las cifras de cada casilla y del mes);
 *  · la **pantalla**, que acota la lista del día abierto.
 *
 * ⚠️ Si divergieran, el calendario diría «3» y la lista del día mostraría 5. La consulta del
 * servidor usa las MISMAS tres igualdades que `pasaFiltroHistorial` (estado, sucursal, quien
 * levantó), y el candado de cada lado lo comprueba.
 *
 * ⛔ **Un filtro sólo puede ACHICAR lo que se ve, nunca agrandarlo.** El alcance («Míos» o
 * «Todos») lo decide el servidor por el permiso; filtrar por persona dentro de «Míos» no abre
 * el vale de nadie más.
 */

/** Los estados de un levantamiento, en el orden en que avanza el trámite. */
export const ESTADOS_LEVANTAMIENTO = ['recibida', 'aprobada', 'revision', 'validada', 'rechazada'] as const;
export type EstadoLevantamiento = (typeof ESTADOS_LEVANTAMIENTO)[number];

export interface FiltroHistorial {
  /** Vacío = todos los estados. */
  estados: EstadoLevantamiento[];
  /** Clave de sucursal (`'00'`..). `null` = todas. */
  sucursal: string | null;
  /** Quien levantó el vale (`created_by`, tal cual). `null` = todas las personas. */
  persona: string | null;
}

export const FILTRO_HISTORIAL_VACIO: FiltroHistorial = { estados: [], sucursal: null, persona: null };

/** Los parámetros tal como llegan por la URL. */
export interface FiltroHistorialCrudo {
  estado?: string | null;
  sucursal?: string | null;
  persona?: string | null;
}

export type FiltroHistorialLeido = { ok: true; filtro: FiltroHistorial } | { ok: false; motivo: string };

const LARGO_MAX_PERSONA = 160;

/**
 * Lee los parámetros del filtro.
 *
 * ⛔ Un valor que no se entiende es un ERROR, no «sin filtro». Ignorarlo en silencio haría que
 * un `estado=firmada` mal escrito devuelva el mes ENTERO mientras la pantalla cree que filtró:
 * vería 392 levantamientos donde esperaba los que esperan firma.
 */
export function leerFiltroHistorial(crudo: FiltroHistorialCrudo | null | undefined): FiltroHistorialLeido {
  const c = crudo ?? {};
  const estados: EstadoLevantamiento[] = [];
  for (const parte of String(c.estado ?? '').split(',')) {
    const e = parte.trim();
    if (!e) continue;
    if (!(ESTADOS_LEVANTAMIENTO as readonly string[]).includes(e)) {
      return { ok: false, motivo: `estado desconocido: «${e}». Válidos: ${ESTADOS_LEVANTAMIENTO.join(', ')}` };
    }
    if (!estados.includes(e as EstadoLevantamiento)) estados.push(e as EstadoLevantamiento);
  }

  const suc = String(c.sucursal ?? '').trim();
  if (suc && !/^\d{2}$/.test(suc)) return { ok: false, motivo: `sucursal ilegible: «${suc}» (se espera la clave de dos dígitos)` };

  const persona = String(c.persona ?? '').trim();
  if (persona.length > LARGO_MAX_PERSONA) return { ok: false, motivo: 'persona demasiado larga' };

  return {
    ok: true,
    filtro: {
      // Orden fijo: dos filtros iguales escritos en distinto orden son el mismo filtro.
      estados: ESTADOS_LEVANTAMIENTO.filter((e) => estados.includes(e)),
      sucursal: suc || null,
      persona: persona || null,
    },
  };
}

/** ¿Hay algo filtrando? */
export function filtroHistorialActivo(f: FiltroHistorial | null | undefined): boolean {
  return !!f && (f.estados.length > 0 || !!f.sucursal || !!f.persona);
}

/** Lo único que la regla mira de un levantamiento. */
export interface FilaFiltrable {
  status?: string | null;
  sucursal?: string | null;
  created_by?: string | null;
}

/**
 * ¿Este levantamiento pasa el filtro? Tres igualdades exactas — las mismas tres que el
 * servidor pone en el `WHERE` del calendario.
 */
export function pasaFiltroHistorial(fila: FilaFiltrable, f: FiltroHistorial | null | undefined): boolean {
  if (!f) return true;
  if (f.estados.length && !f.estados.includes(String(fila.status ?? '') as EstadoLevantamiento)) return false;
  if (f.sucursal && String(fila.sucursal ?? '') !== f.sucursal) return false;
  if (f.persona && String(fila.created_by ?? '') !== f.persona) return false;
  return true;
}

/** Cómo viaja el filtro por la URL. Sólo lo que está puesto. */
export function filtroHistorialAParams(f: FiltroHistorial | null | undefined): Record<string, string> {
  const p: Record<string, string> = {};
  if (!f) return p;
  if (f.estados.length) p['estado'] = f.estados.join(',');
  if (f.sucursal) p['sucursal'] = f.sucursal;
  if (f.persona) p['persona'] = f.persona;
  return p;
}

/** Una opción del filtro con lo que hay detrás: «Espera firma · 58». */
export interface FacetaHistorial {
  valor: string;
  n: number;
  monto: number;
}

/**
 * Las opciones de cada filtro, contadas.
 *
 * Cada lista se cuenta con los OTROS filtros puestos, no con el suyo: con «Sucursal 00»
 * elegida, los estados dicen cuántos hay en la 00 de cada uno — y la lista de sucursales sigue
 * mostrando todas, para poder cambiar de una a otra sin quitar el filtro primero.
 *
 * `personas` es `null` en «Míos»: ahí la única persona es quien mira.
 */
export interface FacetasHistorial {
  estados: FacetaHistorial[];
  sucursales: FacetaHistorial[];
  personas: FacetaHistorial[] | null;
}
