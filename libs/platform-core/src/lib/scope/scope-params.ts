import { Logger } from '@nestjs/common';
import { ScopeDimension, SCOPE_DIMENSIONS } from './scope.types';

/**
 * `[ID.5]` — Contrato canónico de parámetros de alcance (Fase ID / ADR-050).
 *
 * El problema medido: hay **16 nombres distintos de query param** para decir
 * "qué sucursal / zona / ruta", en 115 ocurrencias, en cuatro idiomas mezclados
 * (`sucursal` 20 · `warehouse_id` 45 · `branch` 4 · `almacen` 2 · `zona` 9 …)
 * contra la convención de CLAUDE.md (English snake_case). Cada nombre distinto
 * es un lugar donde el filtro se puede olvidar.
 *
 * Y hay una trampa peor que el nombre: **el mismo dominio usa dos tipos de
 * llave**. Verificado en `commercial-analytics.service`:
 *
 *     @Query('warehouse_id')  → `s.warehouse_id`               (UUID)
 *     @Query('warehouses')    → `commercial.warehouses.code`   (código '03')
 *
 * Por eso este módulo NO mapea alias a alias: normaliza a la **llave canónica
 * de la dimensión** (`scope_dimensions.ref_key`), y la coerción uuid↔código la
 * hace `ScopeService.readParam()`, que es quien tiene DB. Acá vive sólo la
 * parte pura: qué nombres se aceptan y cómo se parsea el valor.
 *
 * Nada se rompe: los 16 nombres viejos siguen funcionando y se loguea la
 * deprecación una vez por alias (no por request — si no, un dashboard que
 * pega 8 veces llena el log).
 */

/** El nombre que se documenta y se usa de ahora en más. Siempre plural: el alcance es una lista. */
export const CANONICAL_PARAM: Record<ScopeDimension, string> = {
  warehouse: 'warehouse_codes',
  zone: 'zone_ids',
  route: 'route_ids',
  brand: 'brand_ids',
  expense_area: 'expense_area_ids',
  customer: 'customer_ids',
};

/**
 * Alias aceptados, en orden de prioridad. Salen del conteo real de
 * `@Query(...)` en los controllers (2026-08-26), no de suposiciones.
 *
 * Ojo: acá conviven nombres que traen UUID (`warehouse_id`, `warehouse_ids`) y
 * nombres que traen código (`warehouses`, `sucursal`, `branch`). Eso es
 * deliberado — `ScopeService.readParam()` acepta ambas formas y las lleva a la
 * llave canónica. Meter el tipo de llave en el nombre del alias sería mentir
 * sobre lo que los endpoints realmente reciben hoy.
 */
export const PARAM_ALIASES: Record<ScopeDimension, string[]> = {
  warehouse: [
    'warehouse_code',   // 6 ocurrencias — código
    'warehouse_ids',    // 8            — CSV de uuid
    'warehouse_id',     // 45           — uuid
    'warehouses',       // 7            — CSV de código
    'sucursal',         // 20           — código
    'branch',           // 4            — código (Wincaja)
    'almacen',          // 2            — código
    'branch_store_id',  // 1
  ],
  zone: ['zone_ids', 'zone_id', 'zone', 'zona_id', 'zona'],
  route: ['route_ids', 'route_id', 'route', 'routes', 'ruta_id', 'ruta'],
  brand: ['brand_id', 'brand', 'brands', 'marca', 'marcas'],
  expense_area: ['expense_area_id', 'area_id', 'areas'],
  customer: ['customer_id', 'customer', 'customers', 'cliente_id', 'cliente'],
};

const logger = new Logger('ScopeParams');
/** Una línea por alias por proceso. Un tablero con 8 widgets no debe escribir 8 veces. */
const yaAvisado = new Set<string>();

/** Dedupe sin `[...new Set()]`: webpack lo baja a `[Set]` y termina bindeando `'{}'` → 22P02. */
const unicos = (v: string[]): string[] => v.filter((x, i, a) => a.indexOf(x) === i);

/**
 * Un valor de query puede venir como `?x=01,03`, `?x=01&x=03` (array) o `?x=01`.
 * Los tres significan lo mismo.
 */
function aLista(raw: unknown): string[] {
  if (raw == null) return [];
  const crudo = Array.isArray(raw) ? raw : [raw];
  return unicos(
    crudo
      .flatMap((v) => String(v).split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export interface ScopeParamLeido {
  /** `null` = el caller no pidió nada (≠ pidió una lista vacía). */
  values: string[] | null;
  /** Qué nombre usó, para poder avisar de la deprecación. */
  nombreUsado: string | null;
  esCanonico: boolean;
}

/**
 * Lee de la query el valor de una dimensión, probando el nombre canónico
 * primero y después los alias. Puro: no toca DB ni traduce llaves.
 *
 * @param ruta ruta del endpoint, sólo para que el aviso de deprecación diga dónde.
 */
export function parseScopeParam(
  query: Record<string, unknown> | undefined,
  dim: ScopeDimension,
  ruta?: string,
): ScopeParamLeido {
  if (!query) return { values: null, nombreUsado: null, esCanonico: true };

  const canonico = CANONICAL_PARAM[dim];
  const desdeCanonico = aLista(query[canonico]);
  if (desdeCanonico.length) {
    return { values: desdeCanonico, nombreUsado: canonico, esCanonico: true };
  }

  for (const alias of PARAM_ALIASES[dim]) {
    const v = aLista(query[alias]);
    if (!v.length) continue;
    const clave = `${dim}:${alias}`;
    if (!yaAvisado.has(clave)) {
      yaAvisado.add(clave);
      logger.warn(
        `Param deprecado '${alias}'${ruta ? ` en ${ruta}` : ''} → usar '${canonico}' (ADR-050 / [ID.5]). Se sigue aceptando.`,
      );
    }
    return { values: v, nombreUsado: alias, esCanonico: false };
  }

  return { values: null, nombreUsado: null, esCanonico: true };
}

/** Lee las 6 dimensiones de una sola query. Útil para endpoints con varios filtros. */
export function parseAllScopeParams(
  query: Record<string, unknown> | undefined,
  ruta?: string,
): Partial<Record<ScopeDimension, string[]>> {
  const out: Partial<Record<ScopeDimension, string[]>> = {};
  for (const dim of SCOPE_DIMENSIONS) {
    const { values } = parseScopeParam(query, dim, ruta);
    if (values) out[dim] = values;
  }
  return out;
}

/** Sólo para tests: vuelve a permitir el aviso de deprecación. */
export function resetAvisosDeprecacion(): void {
  yaAvisado.clear();
}
