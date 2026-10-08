import { createHash } from 'node:crypto';

/**
 * `[GP.2]` El pedido de Kepler (`U-D-40`) como origen del motor de surtido (ADR-086, ADR-067).
 *
 * Todo lo de este archivo que decide algo es **puro** (sin base, sin reloj) para poder probarlo
 * por unidad. Las consultas viven acá también para que el servicio no tenga SQL de Kepler
 * regado entre métodos que hablan de olas.
 *
 * Decode del pedido: `docs/ERP_KEPLER.md` §3.y.3 y `FASE_GP` §2. Mismo filtro canónico que el
 * tablero de GP.1 (`btrim(c1) = sucursal`): sin él, la réplica de la `03` trae copias de pedidos
 * de la `02` con la misma serie y folio y se mezclarían.
 */

/** Llave natural de un pedido Kepler. `folio` siempre con 7 dígitos, como lo guarda Kepler. */
export interface PedidoKeplerLlave {
  sucursal: string;
  serie: number;
  folio: string;
}

const SUC = /^\d{2}$/;
const FOLIO = /^\d{1,10}$/;

/**
 * Normaliza y valida la llave. Devuelve `null` si no es válida: el llamador decide si eso es un
 * 400 (entrada del usuario) o un dato a declarar.
 */
export function normalizarLlave(x: unknown): PedidoKeplerLlave | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const sucursal = String(o['sucursal'] ?? '').trim();
  const serie = Number(o['serie']);
  const folioTxt = String(o['folio'] ?? '').trim();
  if (!SUC.test(sucursal) || !Number.isInteger(serie) || serie < 0 || serie > 99 || !FOLIO.test(folioTxt)) {
    return null;
  }
  return { sucursal, serie, folio: folioTxt.padStart(7, '0') };
}

/**
 * El `order_id` de un pedido Kepler: UUID **determinista** derivado de su llave.
 *
 * ⚠️ Tiene que dar EXACTAMENTE lo mismo que la expresión del CHECK
 * `wave_orders_kepler_id_derivado` (migración `20261007260100`):
 * `md5('kepler/UD40/' || sucursal || '/' || serie || '/' || folio)::uuid`.
 * Postgres convierte los 32 hex del md5 a uuid partiéndolos 8-4-4-4-12; acá se hace igual. Si
 * algún día difieren, el INSERT revienta por el CHECK en vez de guardar un id que no resuelve.
 */
export function keplerOrderId(k: PedidoKeplerLlave): string {
  const hex = createHash('md5').update(`kepler/UD40/${k.sucursal}/${k.serie}/${k.folio}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Folio legible del pedido, el mismo que muestra el tablero de GP.1: `UD4001-0002781`. */
export function documentoKepler(k: Pick<PedidoKeplerLlave, 'serie' | 'folio'>): string {
  return `UD40${String(k.serie).padStart(2, '0')}-${k.folio}`;
}

/**
 * Umbral de la tanda (Francisco, 2026-10-07, `FASE_GP` §5.1): los pedidos de **1 a 5 renglones**
 * se surten juntos; de 6 en adelante, cada uno por su lado.
 */
export const UMBRAL_TANDA = 5;

export interface PedidoParaPlanear {
  id: string;
  renglones: number;
}

export interface PlanDeOlas {
  /** Pedidos chicos que van juntos en UNA ola. Vacío si no hay. */
  tanda: string[];
  /** Pedidos grandes: una ola cada uno. */
  individuales: string[];
  /** Pedidos sin renglones: no se arma ola para ellos (no hay nada que caminar). */
  vacios: string[];
}

/**
 * Reparte los pedidos en olas según su tamaño. Función pura.
 *
 * ⚠️ Un pedido SIN renglones no entra a ninguna ola: medido en prod, existen (`U-D-40`
 * autorizado con 0 renglones, 2026-08-05). Meterlo en la tanda produciría una ola que al
 * arrancar dice "no tiene renglones"; se separa para que se vea.
 *
 * ⚠️ El reparto de UN pedido grande entre varios surtidores (por rango de pasillos) NO se hace
 * acá: necesita la ubicación de cada producto, que todavía no existe (`FASE_WMS` §12.5).
 */
export function planearOlas(pedidos: readonly PedidoParaPlanear[], umbral = UMBRAL_TANDA): PlanDeOlas {
  const plan: PlanDeOlas = { tanda: [], individuales: [], vacios: [] };
  for (const p of pedidos) {
    const n = Number(p.renglones) || 0;
    if (n <= 0) plan.vacios.push(p.id);
    else if (n <= umbral) plan.tanda.push(p.id);
    else plan.individuales.push(p.id);
  }
  return plan;
}

/** Lo mínimo de un renglón para saber si su producto viene en unidades mezcladas. */
export interface RenglonConUnidad {
  source: 'suite' | 'kepler';
  product_id: string | null;
  sku: string | null;
  qty_unit: string | null;
}

/**
 * Productos que, entre los renglones de una ola, llegan de Kepler en MÁS DE UNA unidad.
 * Función pura.
 *
 * Medido en prod (2026-10-07): 248 pares sucursal×clave con más de una unidad en `kdm2.c11`
 * (p. ej. `02135` en PAQ y en PZA). El motor de surtido suma por producto; sumar paquetes con
 * piezas da un número que no se puede surtir ni repartir, así que la ola se frena y se nombra.
 *
 * Sólo cuenta si el producto trae al menos un renglón de Kepler: en los pedidos de la Suite la
 * cantidad ya está en la unidad base y la unidad es sólo el sello de captura.
 */
export function unidadesMezcladas(renglones: readonly RenglonConUnidad[]): string[] {
  const porProducto = new Map<string, { sku: string | null; us: Set<string | null>; kepler: boolean }>();
  for (const r of renglones) {
    if (!r.product_id) continue;
    const g = porProducto.get(r.product_id) ?? { sku: r.sku, us: new Set<string | null>(), kepler: false };
    g.us.add(r.qty_unit);
    if (r.source === 'kepler') g.kepler = true;
    porProducto.set(r.product_id, g);
  }
  const out: string[] = [];
  for (const g of porProducto.values()) {
    if (g.kepler && g.us.size > 1) {
      out.push(`clave ${g.sku} pedida en unidades distintas (${[...g.us].map((u) => u ?? 'sin unidad').join(', ')})`);
    }
  }
  return out;
}

// ─── Consultas ────────────────────────────────────────────────────────────────────────────

/**
 * Pedidos `U-D-40` cuyo estatus VIGENTE es `AUTORIZADO`, de una sucursal, desde una fecha.
 *
 * ⚠️ El estatus se filtra DESPUÉS de quedarse con la versión más reciente de cada pedido
 * (`DISTINCT ON ... ORDER BY c9 DESC`). Filtrarlo antes haría aparecer como "autorizado" un
 * pedido que ya avanzó, por una versión vieja que quedó en el ODS.
 *
 * Renglones y unidades con un LATERAL por pedido, como GP.1 (con JOIN + GROUP BY el planner
 * re-agregaba kdm2 por pedido: 10–12 s contra 130–215 ms medidos).
 *
 * `sin_catalogo` = renglones cuya clave no existe en `catalog.products`. Un renglón así no puede
 * entrar a una ola (`wave_lines.product_id` es NOT NULL), así que se cuenta y se declara.
 *
 * Parámetros: [sucursal, desde (YYYY-MM-DD), origen | null, origen | null].
 */
export const POOL_KEPLER_SQL = `
WITH h AS MATERIALIZED (
  SELECT DISTINCT ON (h.sucursal, h.c5, h.c6)
         h.sucursal, h.c2 AS k2, h.c3 AS k3, h.c4 AS k4, h.c5 AS k5, h.c6 AS k6,
         (h.c5)::int                                         AS serie,
         btrim(h.c6::text)                                   AS folio,
         to_char(h.c9::date, 'YYYY-MM-DD')                   AS fecha,
         NULLIF(btrim(h.c62::text), '')                      AS hora,
         upper(NULLIF(btrim(h.c27::text), ''))               AS origen,
         upper(NULLIF(btrim(h.c11::text), ''))               AS estatus,
         NULLIF(btrim(h.c10::text), '')                      AS cliente_code,
         NULLIF(btrim(h.c32::text), '')                      AS destino_nombre,
         round(NULLIF(btrim(h.c16::text), '')::numeric, 2)   AS importe
    FROM kepler_ods.kdm1 h
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 40
     AND btrim(h.c1) = btrim(h.sucursal)
     AND h.sucursal = ?
     AND h.c9 >= ?::date
   ORDER BY h.sucursal, h.c5, h.c6, h.c9 DESC
)
SELECT h.sucursal, h.serie, h.folio, h.fecha, h.hora, h.origen, h.estatus, h.cliente_code,
       h.destino_nombre, h.importe,
       coalesce(lc.renglones, 0) AS renglones, coalesce(lc.unidades, 0) AS unidades,
       coalesce(lc.sin_catalogo, 0) AS sin_catalogo
  FROM h
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS renglones,
           sum(coalesce(NULLIF(btrim(l.c9::text), '')::numeric, 0)) AS unidades,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM catalog.products p
              WHERE p.tenant_id = public.current_tenant_id()
                AND p.sku = btrim(l.c8::text) AND p.deleted_at IS NULL))::int AS sin_catalogo
      FROM kepler_ods.kdm2 l
     WHERE l.sucursal = h.sucursal AND l.c2 = h.k2 AND l.c3 = h.k3 AND l.c4 = h.k4 AND l.c5 = h.k5 AND l.c6 = h.k6
       AND btrim(l.c1) = btrim(l.sucursal)
  ) lc ON true
 WHERE h.estatus = 'AUTORIZADO'
   AND (?::text IS NULL OR h.origen = ?::text)
 ORDER BY h.fecha, h.hora NULLS LAST, h.folio`;

/**
 * Cuántos pedidos siguen `AUTORIZADO` con fecha ANTERIOR a la ventana del pool. No se muestran
 * en el pool (medido: hay autorizados de julio y agosto que nadie va a surtir), pero tampoco se
 * esconden: se cuentan, para que alguien los cierre en Kepler.
 *
 * Parámetros: [sucursal, desde, origen | null, origen | null].
 */
export const ATORADOS_KEPLER_SQL = `
SELECT count(*)::int AS n, min(fecha) AS desde
  FROM (
    SELECT DISTINCT ON (h.c5, h.c6)
           to_char(h.c9::date, 'YYYY-MM-DD') AS fecha,
           upper(NULLIF(btrim(h.c11::text), '')) AS estatus,
           upper(NULLIF(btrim(h.c27::text), '')) AS origen
      FROM kepler_ods.kdm1 h
     WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 40
       AND btrim(h.c1) = btrim(h.sucursal)
       AND h.sucursal = ?
     ORDER BY h.c5, h.c6, h.c9 DESC
  ) x
 WHERE x.estatus = 'AUTORIZADO' AND x.fecha < ?
   AND (?::text IS NULL OR x.origen = ?::text)`;

/**
 * Cabecera VIGENTE de pedidos Kepler dados por llave. Parámetro: un arreglo JSON
 * `[{"sucursal":"01","serie":1,"folio":"0002781"}, ...]`.
 */
export const CABECERAS_POR_LLAVE_SQL = `
SELECT k.sucursal, k.serie, k.folio, hh.fecha, hh.estatus, hh.origen, hh.cliente_code, hh.destino_nombre, hh.importe
  FROM jsonb_to_recordset(?::jsonb) AS k(sucursal text, serie int, folio text)
  LEFT JOIN LATERAL (
    SELECT to_char(h.c9::date, 'YYYY-MM-DD') AS fecha,
           upper(NULLIF(btrim(h.c11::text), '')) AS estatus,
           upper(NULLIF(btrim(h.c27::text), '')) AS origen,
           NULLIF(btrim(h.c10::text), '') AS cliente_code,
           NULLIF(btrim(h.c32::text), '') AS destino_nombre,
           round(NULLIF(btrim(h.c16::text), '')::numeric, 2) AS importe
      FROM kepler_ods.kdm1 h
     WHERE h.sucursal = k.sucursal AND h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 40
       AND (h.c5)::int = k.serie AND btrim(h.c6::text) = k.folio
       AND btrim(h.c1) = btrim(h.sucursal)
     ORDER BY h.c9 DESC
     LIMIT 1
  ) hh ON true`;

/**
 * Renglones de los pedidos Kepler de una ola, con el producto del catálogo resuelto por clave.
 *
 * ⭐ Dos cantidades, a propósito (medido en prod 2026-10-07, telemarketing PH, 30 días):
 *   · `quantity` = `c9` en la unidad BASE `c11` (75 KG). Es la que se suma por producto y se
 *     reparte: el motor exige UNA unidad para sumar pedidos.
 *   · `qty_presentacion` = `c56` en la presentación `c55` (3 BTO). Es lo que dice la hoja impresa
 *     y lo que va a contar el surtidor (GP.3). Viaja para mostrarse, no se suma.
 * Coinciden en el caso más común (PAQ/PAQ, 2,046 renglones), pero miles no: PAQ/CJA 1,729,
 * PZA/CJA 382, KG/BTO 262, PZA/PAQ 246…
 *
 * El producto se toma con LIMIT 1 y orden fijo: medido, hay 1 clave viva duplicada en el
 * catálogo. Sin el LATERAL ese renglón saldría dos veces y se pediría el doble.
 *
 * Parámetro: [wave_id].
 */
export const LINEAS_KEPLER_DE_OLA_SQL = `
SELECT wo.order_id, wo.kepler_sucursal AS sucursal, wo.kepler_serie AS serie, wo.kepler_folio AS folio,
       (l.c7)::int                                          AS renglon,
       btrim(l.c8::text)                                    AS sku,
       NULLIF(btrim(l.c10::text), '')                       AS descripcion,
       pr.id                                                AS product_id,
       pr.nombre                                            AS product_name,
       coalesce(NULLIF(btrim(l.c9::text), '')::numeric, 0)  AS quantity,
       upper(NULLIF(btrim(l.c11::text), ''))                AS qty_unit,
       NULLIF(btrim(l.c56::text), '')::numeric              AS qty_presentacion,
       upper(NULLIF(btrim(l.c55::text), ''))                AS unidad_presentacion,
       to_char(h.c9::date, 'YYYY-MM-DD')                    AS fecha
  FROM commercial.wave_orders wo
  JOIN kepler_ods.kdm2 l
    ON l.sucursal = wo.kepler_sucursal AND l.c2 = 'U' AND l.c3 = 'D' AND (l.c4)::int = 40
   AND (l.c5)::int = wo.kepler_serie AND btrim(l.c6::text) = wo.kepler_folio
   AND btrim(l.c1) = btrim(l.sucursal)
  LEFT JOIN LATERAL (
    SELECT h.c9 FROM kepler_ods.kdm1 h
     WHERE h.sucursal = l.sucursal AND h.c2 = l.c2 AND h.c3 = l.c3 AND h.c4 = l.c4 AND h.c5 = l.c5 AND h.c6 = l.c6
       AND btrim(h.c1) = btrim(h.sucursal)
     ORDER BY h.c9 DESC LIMIT 1
  ) h ON true
  LEFT JOIN LATERAL (
    SELECT p.id, p.nombre FROM catalog.products p
     WHERE p.tenant_id = wo.tenant_id AND p.sku = btrim(l.c8::text) AND p.deleted_at IS NULL
     ORDER BY p.id
     LIMIT 1
  ) pr ON true
 WHERE wo.wave_id = ? AND wo.source = 'kepler'
 ORDER BY wo.kepler_folio, (l.c7)::int`;
