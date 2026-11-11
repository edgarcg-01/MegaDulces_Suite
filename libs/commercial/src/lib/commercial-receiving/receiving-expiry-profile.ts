import type { Knex } from 'knex';

/**
 * `[CE.1.1]` **Perfil de caducidad de un producto**: si caduca, cuánto dura y qué vida mínima se
 * le acepta al recibirlo. Anexo CE de la Fase WMS (`FASE_WMS_ANEXO_CADUCIDAD_EN_ENTRADA.md`).
 *
 * Se resuelve en cascada sobre `commercial.expiry_receiving_policy`:
 *   producto → departamento → proveedor → (sin política)
 * y la vida útil, si ninguna política la dice, sale de Kepler (`kdii.c101`, «Días de caducidad»).
 *
 * ⚠️ El departamento NO sale de `catalog.products.department`: esa columna está vacía en los
 * 14,945 productos (medido 2026-11-11), así que la política por departamento nunca pudo aplicar.
 * Se DERIVA del ODS: `kdii.c4` → `kdie.c1` (99.4 % de los SKUs del CEDIS casan; medido el mismo día).
 *
 * ⚠️ `kdii.c101` está lleno en 87 de 9,594 SKUs y su unidad (días) no está probada contra una
 * etiqueta (item CE.0.6). Por eso sólo se usa para SOSPECHAR de una fecha, nunca para rechazarla.
 */

export interface PoliticaCaducidad {
  product_id: string | null;
  category: string | null;
  supplier_code: string | null;
  min_shelf_life_days: number | null;
  allow_older_than_existing: boolean;
  tracks_expiry: boolean | null;
  shelf_life_days: number | null;
}

export type FuentePerfil = 'producto' | 'departamento' | 'proveedor' | 'ninguna';

export interface PerfilCaducidad {
  /** `false` = el producto NO caduca (no se le pide fecha). `null` = nadie lo ha dicho: se pide. */
  tracks_expiry: boolean | null;
  shelf_life_days: number | null;
  shelf_life_source: 'politica' | 'kepler' | null;
  min_shelf_life_days: number | null;
  allow_older_than_existing: boolean;
  /** Qué ámbito de la política decidió. */
  fuente: FuentePerfil;
  department: string | null;
}

/**
 * La cascada, pura. Cada campo se toma del PRIMER ámbito que lo dice, no de la primera fila que
 * existe: una política de producto que sólo fija la vida mínima no borra el «no caduca» del
 * departamento. `fuente` es el ámbito de la primera fila encontrada.
 */
export function resolverPerfil(args: {
  producto: PoliticaCaducidad | null;
  departamento: PoliticaCaducidad | null;
  proveedor: PoliticaCaducidad | null;
  department: string | null;
  diasKepler: number | null;
}): PerfilCaducidad {
  const capas = [args.producto, args.departamento, args.proveedor].filter(
    (p): p is PoliticaCaducidad => !!p,
  );
  const primero = <K extends keyof PoliticaCaducidad>(k: K): PoliticaCaducidad[K] | null => {
    for (const p of capas) if (p[k] !== null && p[k] !== undefined) return p[k];
    return null;
  };
  const fuente: FuentePerfil = args.producto
    ? 'producto'
    : args.departamento
      ? 'departamento'
      : args.proveedor
        ? 'proveedor'
        : 'ninguna';

  const vidaPolitica = primero('shelf_life_days');
  const vidaKepler = args.diasKepler != null && args.diasKepler > 0 ? args.diasKepler : null;
  const shelf_life_days = vidaPolitica ?? vidaKepler;

  return {
    tracks_expiry: primero('tracks_expiry'),
    shelf_life_days,
    shelf_life_source: vidaPolitica != null ? 'politica' : vidaKepler != null ? 'kepler' : null,
    min_shelf_life_days: primero('min_shelf_life_days'),
    // La primera fila manda en este booleano (no es nullable en la tabla).
    allow_older_than_existing: capas[0]?.allow_older_than_existing ?? false,
    fuente,
    department: args.department,
  };
}

const COLS = [
  'product_id',
  'category',
  'supplier_code',
  'min_shelf_life_days',
  'allow_older_than_existing',
  'tracks_expiry',
  'shelf_life_days',
] as const;

function norm(r: any): PoliticaCaducidad {
  return {
    product_id: r.product_id ?? null,
    category: r.category ?? null,
    supplier_code: r.supplier_code ?? null,
    min_shelf_life_days: r.min_shelf_life_days != null ? Number(r.min_shelf_life_days) : null,
    allow_older_than_existing: !!r.allow_older_than_existing,
    tracks_expiry: r.tracks_expiry === null || r.tracks_expiry === undefined ? null : !!r.tracks_expiry,
    shelf_life_days: r.shelf_life_days != null ? Number(r.shelf_life_days) : null,
  };
}

/**
 * Departamento y días de caducidad de Kepler por SKU, derivados del ODS (sin copiar).
 * Primero el maestro del CEDIS (`00`, por la llave primaria); lo que no esté ahí, de cualquier sucursal.
 */
export async function keplerPorSku(
  trx: Knex | Knex.Transaction,
  skus: string[],
): Promise<Map<string, { department: string | null; dias: number | null }>> {
  const out = new Map<string, { department: string | null; dias: number | null }>();
  const limpios = [...new Set(skus.map((s) => String(s || '').trim()).filter(Boolean))];
  if (!limpios.length) return out;

  const leer = async (sucursalFija: boolean, lista: string[]) => {
    const { rows } = await trx.raw(
      `SELECT DISTINCT ON (btrim(i.c1))
              btrim(i.c1) AS sku,
              NULLIF(btrim(e.c2), '') AS department,
              NULLIF(i.c101::text, '')::numeric AS dias
         FROM kepler_ods.kdii i
         LEFT JOIN kepler_ods.kdie e ON e.sucursal = i.sucursal AND e.c1 = i.c4
        WHERE btrim(i.c1) = ANY(?::text[])
          ${sucursalFija ? `AND btrim(i.sucursal) = '00'` : ''}
        ORDER BY btrim(i.c1), (NULLIF(btrim(e.c2), '') IS NULL), i.sucursal`,
      [lista],
    );
    for (const r of rows) {
      const dias = r.dias != null ? Number(r.dias) : null;
      out.set(r.sku, {
        department: r.department && r.department !== 'NO APLICA' ? r.department : null,
        dias: dias != null && dias > 0 ? dias : null,
      });
    }
  };
  await leer(true, limpios);
  const faltan = limpios.filter((s) => !out.has(s));
  if (faltan.length) await leer(false, faltan);
  return out;
}

/**
 * Perfiles de caducidad para varios productos de una sola vez (el vale entero, el paquete sin red).
 * Dos consultas a Kepler + una a la política, sin importar cuántos productos.
 */
export async function perfilesDeCaducidad(
  trx: Knex | Knex.Transaction,
  productos: Array<{ product_id: string; sku: string | null }>,
  supplierCode: string | null,
): Promise<Map<string, PerfilCaducidad>> {
  const out = new Map<string, PerfilCaducidad>();
  if (!productos.length) return out;

  const kepler = await keplerPorSku(
    trx,
    productos.map((p) => p.sku || ''),
  );
  const ids = [...new Set(productos.map((p) => p.product_id))];
  const deptos = [
    ...new Set(
      productos
        .map((p) => kepler.get(String(p.sku || '').trim())?.department)
        .filter((d): d is string => !!d),
    ),
  ];

  const filas = (await trx('commercial.expiry_receiving_policy')
    .where((q) => {
      q.whereIn('product_id', ids);
      if (deptos.length) q.orWhere((w) => w.whereNull('product_id').whereIn('category', deptos).whereNull('supplier_code'));
      if (supplierCode)
        q.orWhere((w) => w.whereNull('product_id').whereNull('category').where('supplier_code', supplierCode));
    })
    .select(...COLS)) as any[];
  const pols = filas.map(norm);

  for (const p of productos) {
    const k = kepler.get(String(p.sku || '').trim()) ?? { department: null, dias: null };
    out.set(
      p.product_id,
      resolverPerfil({
        producto: pols.find((x) => x.product_id === p.product_id) ?? null,
        departamento:
          (k.department && pols.find((x) => !x.product_id && x.category === k.department && !x.supplier_code)) || null,
        proveedor:
          (supplierCode && pols.find((x) => !x.product_id && !x.category && x.supplier_code === supplierCode)) || null,
        department: k.department,
        diasKepler: k.dias,
      }),
    );
  }
  return out;
}

/** Los departamentos de Kepler, para elegir el ámbito de una política. Derivado del ODS. */
export async function departamentosKepler(trx: Knex | Knex.Transaction): Promise<string[]> {
  const { rows } = await trx.raw(
    `SELECT DISTINCT btrim(c2) AS d FROM kepler_ods.kdie
      WHERE btrim(c2) <> '' AND btrim(c2) <> 'NO APLICA' ORDER BY 1`,
  );
  return rows.map((r: any) => r.d as string);
}
