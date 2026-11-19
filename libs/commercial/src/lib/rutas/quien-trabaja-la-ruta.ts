import type { Knex } from 'knex';

/**
 * `[MKT.29]` Quién trabaja cada ruta — UNA respuesta para toda la Suite (ADR-056: antes había dos,
 * `routeDrivers` en Ventas por ruta y `vendedoresAsignados` en el ranking de promociones, y cada una
 * miraba una fuente distinta).
 *
 * Kepler (y el push de las camionetas) guardan la RUTA, no a la persona. La persona sale de tres
 * fuentes de la Suite, en este orden, y ninguna se inventa:
 *
 *  1. **comisión** — `commercial.commission_route_config.chofer_nombre`: a quien se le paga la
 *     comisión de la ruta. La edita Comercial; es quien responde por la ruta.
 *  2. **asignación** — la plantilla semanal (`public.daily_assignments`) de la ruta del catálogo
 *     `trade.catalogs` (`rutas`). Las vecinales se ligan por `erp_source_branch` + `erp_vendor_code`
 *     (`[VK.1]`); las de ruta directa NO tienen esa liga (medido 2026-11-18: 0 de 15) y se ligan por
 *     el número de su etiqueta («RUTA 501», o «502» a secas).
 *  3. **kepler** — el nombre que Kepler le da a una ruta vecinal, sólo si es una persona (en
 *     Michoacán la ruta se llama como su vendedor; «RUTA VECINAL PH 01» no es un chofer).
 *
 * ⚠️ Las tres son el estado de HOY: no hay historial. En una semana pasada pueden no ser quien vendió.
 * Medido el 2026-11-18: la comisión y la asignación nombran a personas distintas en la ruta 21 y en la
 * 1V002; por eso, cuando manda la comisión, las personas asignadas que no son ella se devuelven en
 * `otros` (se ven, no se esconden).
 */

export type FuenteQuien = 'comision' | 'asignacion' | 'kepler';

export interface QuienDeRuta {
  nombre: string;
  fuente: FuenteQuien;
  /** Otras personas asignadas a la ruta en la Suite (apoyo, o asignadas distinto de la comisión). */
  otros: string[];
}

export interface PersonaAsignada { nombre: string; dias: number }

/** Para comparar nombres capturados a mano en dos lugares (acentos, mayúsculas, espacios). */
export const normalNombre = (s: string | null | undefined): string =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Dos capturas de la misma persona: iguales, o una es el principio de la otra («JUAN PEREZ» / «JUAN PEREZ LOPEZ»). */
export const mismaPersona = (a: string, b: string): boolean => {
  const x = normalNombre(a); const y = normalNombre(b);
  return !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' '));
};

/**
 * `[MKT.28]` De las personas asignadas a una ruta, la principal es la de más días en la semana
 * (empate: orden alfabético, para que no cambie entre consultas); las demás, apoyo.
 */
export function vendedorDeRuta(personas: PersonaAsignada[]): { principal: string; otros: string[] } | null {
  const vistos = new Map<string, PersonaAsignada>();
  for (const p of personas) {
    const nombre = String(p.nombre ?? '').trim();
    if (!nombre) continue;
    const ya = vistos.get(nombre);
    vistos.set(nombre, { nombre, dias: Math.max(ya?.dias ?? 0, Number(p.dias) || 0) });
  }
  const l = [...vistos.values()].sort((a, b) => b.dias - a.dias || a.nombre.localeCompare(b.nombre, 'es'));
  if (!l.length) return null;
  return { principal: l[0].nombre, otros: l.slice(1).map((x) => x.nombre) };
}

/** El orden de las fuentes, como función pura (lo que se prueba). */
export function elegirQuienDeRuta(f: { comision?: string | null; asignados?: PersonaAsignada[]; kepler?: string | null }): QuienDeRuta | null {
  const comision = String(f.comision ?? '').trim();
  const asignados = vendedorDeRuta(f.asignados ?? []);
  if (comision) {
    const todos = asignados ? [asignados.principal, ...asignados.otros] : [];
    return { nombre: comision, fuente: 'comision', otros: todos.filter((x) => !mismaPersona(x, comision)) };
  }
  if (asignados) return { nombre: asignados.principal, fuente: 'asignacion', otros: asignados.otros };
  const kepler = String(f.kepler ?? '').trim();
  return kepler ? { nombre: kepler, fuente: 'kepler', otros: [] } : null;
}

/** El número de ruta de una etiqueta del catálogo: «RUTA 501» o «502» → «501»/«502»; otra cosa → null. */
export function numeroDeEtiqueta(etiqueta: string | null | undefined): string | null {
  const m = /^\s*(?:RUTA\s*)?(\d{1,4})\s*$/i.exec(String(etiqueta ?? ''));
  return m ? m[1] : null;
}

export interface QuienTrabajaLasRutas {
  /**
   * `ruta` = el código de la ruta tal como lo traen la venta y la comisión (`501`, `21`, `1V002`);
   * `sucursal` (opcional) desempata una clave de Kepler que existiera en dos sucursales.
   */
  de(ruta: string, sucursal?: string | null): QuienDeRuta | null;
}

/**
 * Lee las tres fuentes. Si una consulta falla, falla todo (la transacción ya quedó abortada): quien
 * llame decide si cae o sigue sin nombres — el ranking sigue, y lo dice.
 */
export async function leerQuienTrabajaLasRutas(trx: Knex.Transaction, tenantId: string): Promise<QuienTrabajaLasRutas> {
  const comision = (await trx.raw(
    `SELECT btrim(route_code) AS ruta, btrim(chofer_nombre) AS nombre
       FROM commercial.commission_route_config
      WHERE tenant_id = ? AND deleted_at IS NULL AND NULLIF(btrim(chofer_nombre), '') IS NOT NULL`, [tenantId])).rows as Array<{ ruta: string; nombre: string }>;
  const asignacion = (await trx.raw(
    `SELECT NULLIF(btrim(cat.erp_source_branch), '') AS sucursal, NULLIF(btrim(cat.erp_vendor_code), '') AS codigo,
            btrim(cat.value) AS etiqueta,
            COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS nombre,
            count(DISTINCT da.day_of_week)::int AS dias
       FROM trade.catalogs cat
       JOIN public.daily_assignments da ON da.route_id = cat.id AND da.deleted_at IS NULL AND COALESCE(da.activo, true)
       JOIN public.users u ON u.id = da.user_id AND u.deleted_at IS NULL
      WHERE cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
      GROUP BY 1, 2, 3, 4`)).rows as Array<{ sucursal: string | null; codigo: string | null; etiqueta: string; nombre: string | null; dias: number }>;
  const kepler = (await trx.raw(
    `SELECT DISTINCT ON (route_no) route_no AS ruta, btrim(route_name) AS nombre
       FROM analytics.mv_kepler_vecinal_monthly
      WHERE tenant_id = ? AND NULLIF(btrim(route_name), '') IS NOT NULL AND btrim(route_name) !~* '^RUTA'
      ORDER BY route_no, month DESC`, [tenantId])).rows as Array<{ ruta: string; nombre: string }>;
  return armarQuienTrabajaLasRutas(comision, asignacion, kepler);
}

/** Separado de la lectura para poder probar las ligas sin base. */
export function armarQuienTrabajaLasRutas(
  comision: Array<{ ruta: string; nombre: string }>,
  asignacion: Array<{ sucursal: string | null; codigo: string | null; etiqueta: string; nombre: string | null; dias: number }>,
  kepler: Array<{ ruta: string; nombre: string }>,
): QuienTrabajaLasRutas {
  const comisionDe = new Map(comision.map((x) => [String(x.ruta).trim(), x.nombre]));
  const keplerDe = new Map(kepler.map((x) => [String(x.ruta).trim(), x.nombre]));
  // código de ruta → sucursal ('' = ligada por etiqueta, sin sucursal) → personas
  const asignadosDe = new Map<string, Map<string, PersonaAsignada[]>>();
  for (const a of asignacion) {
    if (!a.nombre) continue;
    const codigo = a.codigo ?? numeroDeEtiqueta(a.etiqueta);
    if (!codigo) continue;
    const suc = a.codigo ? (a.sucursal ?? '') : '';
    const porSuc = asignadosDe.get(codigo) ?? new Map<string, PersonaAsignada[]>();
    const l = porSuc.get(suc) ?? [];
    l.push({ nombre: a.nombre, dias: Number(a.dias) || 0 });
    porSuc.set(suc, l);
    asignadosDe.set(codigo, porSuc);
  }
  const asignadosA = (ruta: string, sucursal?: string | null): PersonaAsignada[] => {
    const porSuc = asignadosDe.get(ruta);
    if (!porSuc) return [];
    if (sucursal) {
      // Una clave de Kepler (con sucursal) sólo casa con la liga `erp_*`, nunca con una etiqueta: el
      // vendedor «21» de una sucursal no es la camioneta «RUTA 21».
      if (porSuc.has(sucursal)) return porSuc.get(sucursal)!;
      const ligadas = [...porSuc].filter(([s]) => s !== '');
      return ligadas.length === 1 ? ligadas[0][1] : [];
    }
    // Sin sucursal (camioneta): la liga por etiqueta; si no hay, la única liga `erp_*` con esa clave.
    if (porSuc.has('')) return porSuc.get('')!;
    // Con dos sucursales y nada para desempatar, no se adivina.
    return porSuc.size === 1 ? [...porSuc.values()][0] : [];
  };
  return {
    de: (ruta, sucursal) => {
      const r = String(ruta ?? '').trim();
      if (!r) return null;
      return elegirQuienDeRuta({ comision: comisionDe.get(r), asignados: asignadosA(r, sucursal), kepler: keplerDe.get(r) });
    },
  };
}
