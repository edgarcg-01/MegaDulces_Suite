import type { ColaSucursal, GrupoPendienteSucursal, PendienteSucursalFila } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';

/**
 * `[AB.45]` «Pendientes de la sucursal» — la parte pura de la pantalla: cómo se ordenan y resumen las
 * colas que manda el servidor. Qué es pendiente y cuánto hay lo decide el servidor (el registro); aquí
 * no se cuenta nada.
 */

export const GRUPO_LABEL: Record<GrupoPendienteSucursal, string> = {
  recibir: 'Recibir mercancía',
  surtir: 'Surtir y despachar',
  caja: 'Caja',
  inventario: 'Inventario',
  administracion: 'Administración',
};

const ORDEN_GRUPO: GrupoPendienteSucursal[] = ['recibir', 'surtir', 'caja', 'inventario', 'administracion'];

export interface Reparto {
  /** De la sucursal, con trabajo: la más vieja primero. */
  conTrabajo: ColaSucursal[];
  /** De la sucursal que no se pudieron leer: se dicen, no suman. */
  sinLeer: ColaSucursal[];
  /** De la sucursal, en cero. Una línea, no secciones. */
  alDia: ColaSucursal[];
  /** Abiertas de la sucursal que atiende otra área, con algo. */
  otraArea: ColaSucursal[];
}

export function repartir(colas: ColaSucursal[]): Reparto {
  const propias = colas.filter((c) => c.de === 'sucursal');
  return {
    conTrabajo: propias
      .filter((c) => c.estado === 'ok' && c.total > 0)
      .sort((a, b) => (b.mas_viejo_dias ?? -1) - (a.mas_viejo_dias ?? -1) || b.total - a.total),
    sinLeer: propias.filter((c) => c.estado === 'no_medido'),
    alDia: propias.filter((c) => c.estado === 'ok' && c.total === 0),
    otraArea: colas
      .filter((c) => c.de === 'otra_area' && (c.estado === 'no_medido' || c.total > 0))
      .sort((a, b) => ORDEN_GRUPO.indexOf(a.grupo) - ORDEN_GRUPO.indexOf(b.grupo) || b.total - a.total),
  };
}

export interface Veredicto {
  /** Pendientes de la sucursal en las colas que se pudieron leer. */
  total: number;
  /** En cuántas colas está ese total. */
  colas: number;
  masViejo: number | null;
  /** Colas de la sucursal que no se pudieron leer: el total NO las incluye. */
  sinLeer: number;
}

export function veredicto(colas: ColaSucursal[]): Veredicto {
  const r = repartir(colas);
  return {
    total: r.conTrabajo.reduce((n, c) => n + c.total, 0),
    colas: r.conTrabajo.length,
    masViejo: r.conTrabajo.reduce<number | null>((m, c) => (c.mas_viejo_dias != null && (m == null || c.mas_viejo_dias > m) ? c.mas_viejo_dias : m), null),
    sinLeer: r.sinLeer.length,
  };
}

/** Pendientes de la sucursal por grupo, en el orden del trabajo (para la franja de arriba). */
export function porGrupo(colas: ColaSucursal[]): Array<{ grupo: GrupoPendienteSucursal; total: number; sinLeer: boolean }> {
  const propias = colas.filter((c) => c.de === 'sucursal');
  return ORDEN_GRUPO
    .filter((g) => propias.some((c) => c.grupo === g))
    .map((g) => ({
      grupo: g,
      total: propias.filter((c) => c.grupo === g && c.estado === 'ok').reduce((n, c) => n + c.total, 0),
      sinLeer: propias.some((c) => c.grupo === g && c.estado === 'no_medido'),
    }));
}

// ── [AB.47] Filtros de la pantalla ─────────────────────────────────────────────────────────────

/** Quién lo tiene: todos, los que nadie ha tomado, o los que me atribuí. */
export type FiltroQuien = 'todos' | 'sin_tomar' | 'mios';

export interface Filtros {
  quien: FiltroQuien;
  grupo: GrupoPendienteSucursal | 'todos';
  /** Folio, detalle o nombre de quien lo tiene. Sin acentos y en cualquier orden (`coincideBusqueda`). */
  texto: string;
  /** Sólo las colas cuya pantalla abre mi puesto (las que puedo resolver yo). */
  soloPuedo: boolean;
}

export const SIN_FILTROS: Filtros = { quien: 'todos', grupo: 'todos', texto: '', soloPuedo: false };

export function hayFiltros(f: Filtros): boolean {
  return f.quien !== 'todos' || f.grupo !== 'todos' || !!f.texto.trim() || f.soloPuedo;
}

/** ¿La fila pasa los filtros de FILA (quién y texto)? Los de cola (grupo, puedo) van aparte. */
export function filaPasa(f: PendienteSucursalFila, quien: FiltroQuien, texto: string): boolean {
  if (quien === 'sin_tomar' && f.responsable) return false;
  if (quien === 'mios' && !f.responsable?.soy_yo) return false;
  return coincideBusqueda(texto, f.folio, f.detalle, f.responsable?.nombre);
}

export interface ColaFiltrada {
  cola: ColaSucursal;
  /** Las filas que pasan. Sin filtros de fila, todas las que viajaron. */
  filas: PendienteSucursalFila[];
  /** `true` = la cola trae menos filas que su total: el filtro miró sólo las más viejas. */
  recortada: boolean;
}

/**
 * Las colas de la sucursal con trabajo, ya filtradas, en el orden de `repartir` (lo que más espera
 * primero). Una cola que el filtro deja sin filas sale de la lista; `ocultas` dice cuántas salieron
 * por los filtros (no por estar al día).
 */
export function filtrarColas(colas: ColaSucursal[], f: Filtros): { colas: ColaFiltrada[]; ocultas: number } {
  const base = repartir(colas).conTrabajo;
  const filtraFila = f.quien !== 'todos' || !!f.texto.trim();
  const out: ColaFiltrada[] = [];
  for (const c of base) {
    if (f.grupo !== 'todos' && c.grupo !== f.grupo) continue;
    if (f.soloPuedo && !c.puede_abrir) continue;
    const filas = filtraFila ? c.filas.filter((x) => filaPasa(x, f.quien, f.texto)) : c.filas;
    if (filtraFila && !filas.length) continue;
    out.push({ cola: c, filas, recortada: c.total > c.filas.length });
  }
  return { colas: out, ocultas: base.length - out.length };
}

/**
 * Los conteos de cada opción, contando FILAS de la sucursal: cada control cuenta con los OTROS filtros
 * puestos (así el número dice cuántos verías al elegirlo). Sobre las filas que viajaron (hasta 200 por cola).
 */
export function conteosFiltros(colas: ColaSucursal[], f: Filtros): { quien: Record<FiltroQuien, number>; grupo: Record<string, number> } {
  const base = repartir(colas).conTrabajo.filter((c) => !f.soloPuedo || c.puede_abrir);
  const quien: Record<FiltroQuien, number> = { todos: 0, sin_tomar: 0, mios: 0 };
  const grupo: Record<string, number> = { todos: 0 };
  for (const c of base) {
    for (const x of c.filas) {
      if (!coincideBusqueda(f.texto, x.folio, x.detalle, x.responsable?.nombre)) continue;
      if (f.grupo === 'todos' || c.grupo === f.grupo) {
        quien.todos++;
        if (!x.responsable) quien.sin_tomar++;
        if (x.responsable?.soy_yo) quien.mios++;
      }
      if (filaPasa(x, f.quien, '')) {
        grupo['todos']++;
        grupo[c.grupo] = (grupo[c.grupo] ?? 0) + 1;
      }
    }
  }
  return { quien, grupo };
}
