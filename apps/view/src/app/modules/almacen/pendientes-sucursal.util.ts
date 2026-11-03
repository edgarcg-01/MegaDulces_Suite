import type { ColaSucursal, GrupoPendienteSucursal } from '@megadulces/contracts';

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
