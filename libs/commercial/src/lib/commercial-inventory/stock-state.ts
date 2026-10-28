import type { Knex } from 'knex';
import {
  estadoDeExistencia,
  mensajeSinExistencia,
  ODS_HOT_TOLERANCIA_H,
  type StockBlockError,
  type StockState,
} from '@megadulces/contracts';

/**
 * `[MCP.3.16]` EL resolvedor del estado de existencia por (sucursal, producto). Lo usan los TRES
 * caminos que necesitan la regla —el catálogo del vendedor, la tira de la zona y el bloqueo al
 * agregar un renglón— para que no haya tres versiones de lo mismo (ADR-056 regla 16: un primitivo,
 * no tres caminos). La regla pura vive en `@megadulces/contracts` (`estadoDeExistencia`).
 *
 * ── LA FUENTE ───────────────────────────────────────────────────────────────────────────────────
 * `analytics.v_erp_stock_on_hand`, la canónica de ADR-055 (vista sobre `kepler_ods.kdil`).
 * `commercial.stock` es la copia deprecada (acierta 91.0% contra el POS; la vista 100.0%, ver
 * `existencia.service.ts`): NO se construye encima. Se suma `qty_stock_units` por
 * (warehouse_id, product_id).
 *
 * ⚠️ NO se descuentan apartados: la vista no los tiene y traer la copia que miente sólo para eso
 * sería peor (medido en prod: 1 fila de 53,223 con apartado, igual que declara
 * `existencia.service.ts`). Lo que el vendedor ve es la existencia del ERP, no «disponible».
 *
 * ── LOS DUPLICADOS LEGADOS ──────────────────────────────────────────────────────────────────────
 * La vista une por `sku`, así que es CIEGA a un producto con `sku` NULL. En el catálogo hay pares
 * legado (`sku` NULL, `articulo` X) + gemelo vivo (`sku` = X): medido 2026-10-27, 572 pares en el
 * catálogo con precio y 834 en toda la tabla, cada legado con UN solo gemelo (0 con dos).
 * `commercial.product_aliases` tiene 1 fila y no los cubre. Por eso el legado toma la existencia de
 * su gemelo (regla `sku = btrim(articulo)`), y un legado SIN gemelo no se puede medir: es
 * `sin_dato`, nunca «no se maneja» (la vista no lo ve, no es que la sucursal no lo tenga).
 *
 * ── LA FRESCURA ─────────────────────────────────────────────────────────────────────────────────
 * `kdil` viaja en el carril `ods_live_hot` (ops/k3s/20-ods-live-hot.deployment.yaml) y el shipper
 * escribe `analytics.ods_branch_checks` al cerrar la pasada de CADA sucursal, haya o no filas: una
 * fila vieja significa «nadie miró esa sucursal». Al día = sin `last_error` y revisada hace menos
 * de `ODS_HOT_TOLERANCIA_H` horas. Se cruza por `commercial.warehouses.code` ('01'..'08'). Sin
 * fila, con error o con la consulta caída (SAVEPOINT), todo lo de esa sucursal es `sin_dato`.
 */

/** El carril que trae `kepler_ods.kdil` (la existencia). */
export const CARRIL_EXISTENCIA = 'ods_live_hot';

type Db = Knex | Knex.Transaction;

/** Una sucursal a leer: su id y su clave (`commercial.warehouses.code`). */
export interface SucursalStock {
  id: string;
  code: string | null;
}

/** De cuándo es la lectura de una sucursal y si alcanza para afirmar. */
export interface LecturaSucursal {
  warehouse_id: string;
  /** Al día: se puede afirmar «agotado» o «no se maneja». */
  medido: boolean;
  /** ISO de `ods_branch_checks.last_check_at`; `null` = nunca se revisó o no se pudo leer. */
  checked_at: string | null;
  /** Por qué no está al día (`null` si `medido`). */
  motivo: string | null;
}

/** El estado de un producto en una sucursal. */
export interface EstadoEnSucursal {
  warehouse_id: string;
  product_id: string;
  state: StockState;
  /** Existencia en unidad BASE; `null` = sin registro o sin dato. */
  qty: number | null;
  checked_at: string | null;
  /** El gemelo vivo cuya existencia se usó (el producto es un legado); `null` si no aplica. */
  twin_product_id: string | null;
}

const isoONull = (v: unknown): string | null => {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/**
 * Lectura de cada sucursal en `ods_branch_checks`. Va en SAVEPOINT: si la tabla no existe o la
 * consulta falla, no aborta la transacción del que llama y todas quedan `medido: false`.
 */
export async function lecturaDeSucursales(
  trx: Db,
  sucursales: readonly SucursalStock[],
): Promise<Map<string, LecturaSucursal>> {
  const out = new Map<string, LecturaSucursal>();
  const sinMedir = (motivo: string) => {
    for (const s of sucursales) out.set(s.id, { warehouse_id: s.id, medido: false, checked_at: null, motivo });
    return out;
  };
  if (!sucursales.length) return out;
  const codigos = [...new Set(sucursales.map((s) => String(s.code ?? '').trim()).filter(Boolean))];
  if (!codigos.length) return sinMedir('La sucursal no tiene clave.');

  let filas: Array<{ sucursal: string; last_check_at: unknown; al_dia: boolean; last_error: string | null }>;
  try {
    filas = await trx.transaction(async (sp) => {
      const { rows } = await sp.raw(
        `SELECT DISTINCT ON (btrim(c.sucursal))
                btrim(c.sucursal) AS sucursal, c.last_check_at, c.last_error,
                (c.last_error IS NULL
                 AND c.last_check_at > now() - make_interval(hours => ?::int)) AS al_dia
           FROM analytics.ods_branch_checks c
          WHERE c.lane = ?
            AND c.tenant_id = public.current_tenant_id()
            AND btrim(c.sucursal) = ANY(?::text[])
          ORDER BY btrim(c.sucursal), c.last_check_at DESC NULLS LAST`,
        [ODS_HOT_TOLERANCIA_H, CARRIL_EXISTENCIA, codigos],
      );
      return rows as Array<{ sucursal: string; last_check_at: unknown; al_dia: boolean; last_error: string | null }>;
    });
  } catch {
    return sinMedir('No se pudo leer de cuándo es la existencia.');
  }

  const porCodigo = new Map(filas.map((f) => [f.sucursal, f]));
  for (const s of sucursales) {
    const f = porCodigo.get(String(s.code ?? '').trim());
    const checked = isoONull(f?.last_check_at);
    if (!f) {
      out.set(s.id, { warehouse_id: s.id, medido: false, checked_at: null, motivo: 'Esa sucursal nunca se revisó.' });
    } else if (f.al_dia === true) {
      out.set(s.id, { warehouse_id: s.id, medido: true, checked_at: checked, motivo: null });
    } else {
      out.set(s.id, {
        warehouse_id: s.id, medido: false, checked_at: checked,
        motivo: f.last_error ? 'La última lectura de esa sucursal falló.' : `La lectura tiene más de ${ODS_HOT_TOLERANCIA_H} h.`,
      });
    }
  }
  return out;
}

/** ¿Existe la vista canónica? Sin ella nada se puede afirmar (todo `sin_dato`), pero nada se rompe. */
export async function vistaCanonicaLista(trx: Db): Promise<boolean> {
  try {
    const { rows } = await trx.raw(`SELECT to_regclass('analytics.v_erp_stock_on_hand') IS NOT NULL AS ok`);
    return (rows as Array<{ ok: boolean }>)[0]?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Existencia canónica por (sucursal, producto), en unidad BASE, SIN el gemelo (eso lo resuelve quien
 * llama con `gemelosDe`). `productIds` null = todos los de esas sucursales. Va en SAVEPOINT y
 * devuelve `null` si la consulta falla: una lectura caída no es «cero existencias».
 *
 * Siempre filtrada por sucursal: sin filtro la vista tarda más de un minuto (medido en
 * `quote-pricing.service.ts`); con una sucursal ~0.5 s y con las 4 de La Piedad ~0.45 s
 * (medido en prod 2026-10-27).
 */
export async function leerExistencia(
  trx: Db,
  warehouseIds: readonly string[],
  productIds: readonly string[] | null,
): Promise<Map<string, Map<string, number>> | null> {
  const out = new Map<string, Map<string, number>>();
  if (!warehouseIds.length || (productIds && !productIds.length)) return out;
  try {
    const filas = await trx.transaction(async (sp) => {
      const porProducto = productIds ? 'AND e.product_id = ANY(?::uuid[])' : '';
      const { rows } = await sp.raw(
        `SELECT e.warehouse_id, e.product_id, sum(e.qty_stock_units)::float8 AS qty
           FROM analytics.v_erp_stock_on_hand e
          WHERE e.warehouse_id = ANY(?::uuid[]) ${porProducto}
          GROUP BY e.warehouse_id, e.product_id`,
        productIds ? [[...warehouseIds], [...productIds]] : [[...warehouseIds]],
      );
      return rows as Array<{ warehouse_id: string; product_id: string; qty: number | string | null }>;
    });
    for (const r of filas) {
      const m = out.get(r.warehouse_id) ?? out.set(r.warehouse_id, new Map()).get(r.warehouse_id)!;
      m.set(r.product_id, Number(r.qty) || 0);
    }
    return out;
  } catch {
    return null;
  }
}

/** Lo que el resolvedor sabe de un producto para leer su existencia. */
export interface IdentidadExistencia {
  /** El producto cuya existencia se lee: el gemelo si es un legado con gemelo, si no él mismo. */
  efectivo: string;
  twin_product_id: string | null;
  /** `false` = legado sin gemelo: la vista no lo puede ver (→ `sin_dato`). */
  medible: boolean;
}

/**
 * El gemelo de cada producto legado. `productIds` null = todos los pares del catálogo (para la
 * matriz de la zona); con lista, la identidad de cada uno (incluidos los que no son legados).
 */
export async function gemelosDe(
  trx: Db,
  productIds: readonly string[] | null,
): Promise<Map<string, IdentidadExistencia>> {
  const out = new Map<string, IdentidadExistencia>();
  if (productIds && !productIds.length) return out;
  const { rows } = await trx.raw(
    `SELECT p.id, (p.sku IS NOT NULL) AS con_sku, tw.id AS twin_id
       FROM catalog.products p
       ${GEMELO_JOIN_SQL}
      WHERE ${productIds ? 'p.id = ANY(?::uuid[])' : 'p.sku IS NULL AND p.deleted_at IS NULL AND tw.id IS NOT NULL'}`,
    productIds ? [[...productIds]] : [],
  );
  for (const r of rows as Array<{ id: string; con_sku: boolean; twin_id: string | null }>) {
    out.set(r.id, {
      efectivo: r.twin_id ?? r.id,
      twin_product_id: r.twin_id ?? null,
      medible: r.con_sku === true || !!r.twin_id,
    });
  }
  return out;
}

/**
 * El estado de cada producto en cada sucursal (para el bloqueo al agregar). Una sola pasada: la
 * lectura de las sucursales, la identidad (gemelo) de los productos y la existencia canónica.
 * Si la existencia no se pudo leer, todo es `sin_dato` (no bloquea).
 */
export async function estadoDeProductos(
  trx: Db,
  sucursales: readonly SucursalStock[],
  productIds: readonly string[],
): Promise<{ lecturas: Map<string, LecturaSucursal>; estado: (warehouseId: string, productId: string) => EstadoEnSucursal }> {
  const lecturas = await lecturaDeSucursales(trx, sucursales);
  const ids = [...new Set(productIds)];
  const identidad = await gemelosDe(trx, ids);
  const medidas = sucursales.filter((s) => lecturas.get(s.id)?.medido);
  const efectivos = [...new Set(ids.map((id) => identidad.get(id)?.efectivo ?? id))];
  const existencia = medidas.length && (await vistaCanonicaLista(trx))
    ? await leerExistencia(trx, medidas.map((s) => s.id), efectivos)
    : null;
  const estado = (warehouseId: string, productId: string): EstadoEnSucursal => {
    const lec = lecturas.get(warehouseId);
    const ide = identidad.get(productId);
    const efectivo = ide?.efectivo ?? productId;
    const qty = existencia?.get(warehouseId)?.get(efectivo);
    const medido = !!lec?.medido && existencia !== null && (ide?.medible ?? false);
    const state = estadoDeExistencia({ medido, conRegistro: qty !== undefined, qty: qty ?? null });
    return {
      warehouse_id: warehouseId,
      product_id: productId,
      state,
      qty: state === 'sin_dato' || qty === undefined ? null : qty,
      checked_at: lec?.checked_at ?? null,
      twin_product_id: ide?.twin_product_id ?? null,
    };
  };
  return { lecturas, estado };
}

// ─────────── el bloqueo al agregar ───────────

/** Un renglón que se quiere agregar: el producto y la sucursal de la que se va a surtir. */
export interface DestinoRenglon {
  product_id: string;
  warehouse_id: string;
}

/** Llave de `bloqueosAlAgregar`. */
export const llaveDestino = (d: DestinoRenglon): string => `${d.product_id}|${d.warehouse_id}`;

const cantidadLegible = (q: number): string => q.toLocaleString('es-MX', { maximumFractionDigits: 2 });

/**
 * `[MCP.3.16]` Qué renglones NO se pueden agregar y por qué. Bloquea sólo si la sucursal de surtido
 * está en `agotado` o `no_se_maneja` (lectura al día); `sin_dato` NO bloquea, y pedir más de lo que
 * hay (con existencia > 0) tampoco. Las alternativas son las OTRAS sucursales centrales activas de
 * la zona de la sucursal del pedido (`purchase_zone`, la misma regla que `origenDelRenglon`) con
 * existencia > 0, mayor primero, máximo 3.
 *
 * Devuelve llave (`llaveDestino`) → el cuerpo del 409. Sólo lectura.
 */
export async function bloqueosAlAgregar(
  trx: Db,
  orderWarehouseId: string,
  destinos: readonly DestinoRenglon[],
): Promise<Map<string, StockBlockError>> {
  const out = new Map<string, StockBlockError>();
  if (!destinos.length) return out;
  type Wh = { id: string; code: string | null; short_label: string | null; name: string; purchase_zone: string | null };
  const destinoIds = [...new Set(destinos.map((d) => d.warehouse_id))];
  const propias = (await trx('commercial.warehouses')
    .whereIn('id', [...new Set([orderWarehouseId, ...destinoIds])])
    .select('id', 'code', 'short_label', 'name', 'purchase_zone')) as Wh[];
  const zona = String(propias.find((w) => w.id === orderWarehouseId)?.purchase_zone ?? '').trim();
  const deZona = zona
    ? ((await trx('commercial.warehouses')
        .where({ kind: 'central', active: true, purchase_zone: zona })
        .whereNull('deleted_at')
        .select('id', 'code', 'short_label', 'name', 'purchase_zone')) as Wh[])
    : [];
  const sucursales = new Map<string, Wh>();
  for (const w of [...propias, ...deZona]) sucursales.set(w.id, w);
  const corto = (w: Wh | undefined) => (w?.short_label || '').trim() || w?.name || '';

  const productIds = [...new Set(destinos.map((d) => d.product_id))];
  const { estado } = await estadoDeProductos(trx, [...sucursales.values()].map((w) => ({ id: w.id, code: w.code })), productIds);
  const nombres = new Map(
    ((await trx('catalog.products').whereIn('id', productIds).select('id', 'nombre')) as Array<{ id: string; nombre: string | null }>)
      .map((p) => [p.id, (p.nombre || '').trim()]),
  );

  for (const d of destinos) {
    const e = estado(d.warehouse_id, d.product_id);
    if (e.state !== 'agotado' && e.state !== 'no_se_maneja') continue;
    const alternatives = deZona
      .filter((w) => w.id !== d.warehouse_id)
      .map((w) => ({ w, x: estado(w.id, d.product_id) }))
      .filter(({ x }) => x.state === 'con_existencia' && (x.qty ?? 0) > 0)
      .sort((a, b) => (b.x.qty ?? 0) - (a.x.qty ?? 0))
      .slice(0, 3)
      .map(({ w, x }) => ({ warehouse_id: w.id, short: corto(w), qty: x.qty as number }));
    const short = corto(sucursales.get(d.warehouse_id));
    const productName = nombres.get(d.product_id) || 'este producto';
    // [MCP.3.16] «No hay en tu zona» sólo si se MIDIÓ la zona entera: la zona se resolvió, la
    // sucursal bloqueada es de ella y ninguna otra quedó `sin_dato` (lectura vieja o caída). Sin eso
    // se dice sólo lo que se sabe y qué sucursales faltaron (ADR-056), igual que la pantalla.
    const otrasZona = deZona.filter((w) => w.id !== d.warehouse_id);
    const sinDato = otrasZona.filter((w) => estado(w.id, d.product_id).state === 'sin_dato').map(corto);
    const zonaCompleta = deZona.some((w) => w.id === d.warehouse_id) && !sinDato.length;
    out.set(llaveDestino(d), {
      code: 'SIN_EXISTENCIA',
      message: mensajeSinExistencia({
        surtido: short,
        alternativas: alternatives.map((a) => ({ short: a.short, texto: cantidadLegible(a.qty) })),
        zonaCompleta,
        sinDato,
      }),
      product_id: d.product_id,
      product_name: productName,
      warehouse_id: d.warehouse_id,
      warehouse_short: short,
      state: e.state,
      alternatives,
    });
  }
  return out;
}

// ─────────── fragmentos SQL para el catálogo ───────────
//
// El catálogo ordena «no se maneja al final» ANTES de paginar, así que esa parte de la regla tiene
// que estar en SQL. Para no tener dos versiones de la regla, el SQL sólo trae los hechos
// (`stock_medible`, `stock_con_registro`, `stock_qty`) y el estado se calcula con la MISMA
// `estadoDeExistencia`; el único predicado en SQL es el del orden, y la prueba de base cruza que
// los que quedan al final sean exactamente los que la regla llama `no_se_maneja`.

/** Une el producto `p` con su gemelo vivo `tw` (sólo si `p` es un legado sin `sku`). */
export const GEMELO_JOIN_SQL = `LEFT JOIN catalog.products tw
         ON p.sku IS NULL AND tw.tenant_id = p.tenant_id AND tw.sku = btrim(p.articulo)
        AND tw.deleted_at IS NULL AND tw.id <> p.id`;

/** La existencia canónica de UNA sucursal, como `ex`, contra el efectivo (gemelo o el producto). */
export function existenciaDeSucursalJoin(warehouseId: string): { sql: string; bindings: string[] } {
  return {
    sql: `LEFT JOIN (
            SELECT e.product_id, sum(e.qty_stock_units)::float8 AS qty
              FROM analytics.v_erp_stock_on_hand e
             WHERE e.warehouse_id = ?::uuid
             GROUP BY e.product_id
          ) ex ON ex.product_id = COALESCE(tw.id, p.id)`,
    bindings: [warehouseId],
  };
}

/** Columnas con los HECHOS que lee `estadoDeExistencia` (se quitan de la respuesta al resolver). */
export const HECHOS_EXISTENCIA_SQL = [
  `(p.sku IS NOT NULL OR tw.id IS NOT NULL) AS stock_medible`,
  `(ex.product_id IS NOT NULL) AS stock_con_registro`,
  `ex.qty AS stock_qty`,
  `tw.id AS stock_twin_product_id`,
];

/**
 * Prefijo del ORDER BY: los `no_se_maneja` al final. `medido` es la lectura de la sucursal (sin
 * lectura al día no hay «no se maneja»: devuelve `null` y el orden queda como el pedido; un `0`
 * constante NO sirve, Postgres lo leería como «columna 0»).
 */
export function noSeManejaAlFinalSql(medido: boolean): string | null {
  return medido
    ? `(CASE WHEN (p.sku IS NOT NULL OR tw.id IS NOT NULL) AND ex.product_id IS NULL THEN 1 ELSE 0 END) ASC`
    : null;
}

/** Una fila del catálogo con los hechos de `HECHOS_EXISTENCIA_SQL`. */
export interface FilaConHechos {
  stock_medible?: boolean | null;
  stock_con_registro?: boolean | null;
  stock_qty?: number | string | null;
  stock_twin_product_id?: string | null;
  stock_available?: number | string | null;
  stock_state?: StockState | null;
  stock_checked_at?: string | null;
}

/**
 * Convierte los hechos de una fila en lo que viaja (`CatalogStockStateFields` + `stock_available`)
 * y quita las columnas auxiliares. `lectura` = la de la sucursal del catálogo.
 */
export function resolverFilaCatalogo(fila: FilaConHechos, lectura: LecturaSucursal | null | undefined): void {
  const medido = !!lectura?.medido && fila.stock_medible === true;
  const conRegistro = fila.stock_con_registro === true;
  const qty = fila.stock_qty == null ? null : Number(fila.stock_qty);
  const state = estadoDeExistencia({ medido, conRegistro, qty });
  fila.stock_state = state;
  fila.stock_available = state === 'sin_dato' || !conRegistro ? null : qty;
  fila.stock_checked_at = lectura?.checked_at ?? null;
  fila.stock_twin_product_id = fila.stock_twin_product_id ?? null;
  delete fila.stock_medible;
  delete fila.stock_con_registro;
  delete fila.stock_qty;
}
