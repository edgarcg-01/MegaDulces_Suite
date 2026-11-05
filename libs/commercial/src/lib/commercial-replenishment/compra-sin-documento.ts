/**
 * `[PQ.69]` + `[PQ.68]` **LA COMPRA APROBADA QUE NO TIENE DOCUMENTO EN KEPLER** (D32, PM 2026-11-04).
 *
 * ── Por qué existe, medido en prod el 2026-11-04 ────────────────────────────────────────────
 *
 * 85 compras `approved` sin `kepler_folio` ($7.31 M). PQ.25 sólo liga lo que **la Suite** escribió;
 * éstas son de antes del envío automático (27-oct) o fallaron, y la gente las capturó a mano en
 * Kepler. Nada las une, y se ven como pendientes para siempre.
 *
 * ── Ligar (`[PQ.69]`, regla permanente) ─────────────────────────────────────────────────────
 *
 * El árbitro es el **importe de cada renglón**: Kepler guarda la cantidad en otra unidad, pero el
 * importe (`kdm2.c13`) es invariante y cuadró al centavo 37 de 37 renglones (medido 2026-10-16).
 * Se liga a una OC (`X-A-35`) del mismo proveedor y sucursal sólo si:
 *  · **todos** sus renglones casan por producto e importe (±0.5 %);
 *  · es el **único** documento que casa así entre 90 días antes y 30 después de crearla, y cae en
 *    la ventana de la compra (desde 2 días antes). Un pedido idéntico que se repite casa por azar:
 *    con la ventana de 90 días se descarta;
 *  · la OC no está ligada a otra requisición, ni la reclaman dos a la vez (Compras a veces junta
 *    dos requisiciones en una OC: eso lo resuelve una persona).
 * Medido: 25 de 38 casaban con un solo documento; el placebo (30 a 90 días antes) casaba 2, las dos
 * de un renglón. Con la regla quedan 23 ($2.98 M aprox.). Pasa a `ordered` con la OC, igual que
 * PQ.25; la recepción la marca PQ.26 cuando Kepler cierra la OC.
 *
 * ── Cancelar (`[PQ.68]`, sólo el universo de D32) ───────────────────────────────────────────
 *
 * Aprobada **antes del 27-oct** (no había envío: o se hacía a mano o no se hacía), sin error de
 * envío, con **30 días** cumplidos y sin **nada** en Kepler: ni requisición/OC del proveedor, ni
 * requisición/OC/entrada de cualquier proveedor con alguno de sus productos. Antes de los 30 días
 * no se puede decir que no se hizo. Las que tienen `kepler_error` se quedan: alguien tiene que ver
 * por qué falló. Queda `cancelled`, con motivo, sin persona.
 *
 * Cada llamada toca a lo más `limite` renglones por regla.
 *
 * Módulo PURO (sin Nest): `database/tests/test-newdb-compra-sin-documento.js` corre ESTE SQL contra
 * una base real.
 */
import type { Knex } from 'knex';

/** Desde aquí la Suite escribe la compra en Kepler (PQ.26/PQ.27): antes, sólo a mano. */
export const INICIO_ENVIO_AUTOMATICO = '2026-10-27';
/** Días para decir que una compra no se hizo en Kepler. */
export const DIAS_SIN_DOCUMENTO = 30;
/** Tolerancia del importe por renglón. */
export const TOLERANCIA_IMPORTE = 0.005;
export const LIMITE_LIMPIEZA_COMPRAS = 200;
/** Inicio fijo del motivo de cancelación: separa los cierres automáticos de los de una persona. */
export const MOTIVO_COMPRA_SIN_DOCUMENTO = 'No se hizo en Kepler';

/**
 * Las claves del proveedor en el `kdxd` de la sucursal: la de la Suite y las que tengan su nombre
 * exacto. Se calcula UNA vez por compra (pide `r` con `id`, `suc`, `prov`, `pn`): resuelta por cada
 * renglón de `kdm1` costaba 4.2 s de 6.3 (medido 2026-11-04).
 */
const CLAVES_CTE = `
claves AS MATERIALIZED (
  SELECT r.id, r.prov AS clave FROM r WHERE r.prov IS NOT NULL
  UNION
  SELECT r.id, btrim(x.c2) FROM r JOIN kepler_ods.kdxd x ON x.sucursal = r.suc AND upper(btrim(x.c3)) = r.pn
)`;

/** `(id, suc, folio)` de cada compra que se liga a su OC hecha a mano. */
const LIGAR_SQL = `
WITH r AS (
  SELECT r.id, r.created_at::date AS d, w.kepler_code AS suc, btrim(s.code) AS prov, upper(btrim(s.name)) AS pn
    FROM commercial.purchase_requisitions r
    JOIN commercial.warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
    LEFT JOIN catalog.suppliers s ON s.tenant_id = r.tenant_id AND s.id = r.supplier_id
   WHERE r.tenant_id = :t AND r.estado = 'approved' AND r.source_type = 'supplier'
     AND r.kepler_folio IS NULL AND r.oc_folio IS NULL AND w.kepler_code IS NOT NULL
),
rl AS (
  SELECT l.requisition_id AS id, btrim(p.sku) AS sku, sum(l.line_cost) AS costo
    FROM commercial.purchase_requisition_lines l
    JOIN catalog.products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
   WHERE l.tenant_id = :t AND l.requisition_id IN (SELECT id FROM r) AND COALESCE(l.final_qty, 0) > 0
   GROUP BY 1, 2
),
n AS (SELECT id, count(*) AS n FROM rl GROUP BY 1 HAVING bool_and(costo > 0)),
${CLAVES_CTE},
h AS (
  SELECT DISTINCT r.id, r.d, k.sucursal, k.c1, k.c2, k.c3, k.c4, k.c6, k.c68::date AS f
    FROM r
    JOIN claves c ON c.id = r.id
    JOIN kepler_ods.kdm1 k ON k.sucursal = r.suc AND k.c2 = 'X' AND k.c3 = 'A' AND btrim(k.c4::text) = '35'
     AND k.c68::date >= r.d - 90 AND k.c68::date < r.d + ${DIAS_SIN_DOCUMENTO} AND btrim(k.c10) = c.clave
),
cabal AS (
  SELECT h.id, h.sucursal, btrim(h.c6) AS folio, h.f >= h.d - 2 AS en_ventana
    FROM h
    JOIN n ON n.id = h.id
    JOIN LATERAL (SELECT btrim(l.c8) AS sku, sum(l.c13) AS imp
                    FROM kepler_ods.kdm2 l
                   WHERE l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
                     AND l.c4 = h.c4 AND l.c6 = h.c6
                   GROUP BY 1) kl ON true
    JOIN rl ON rl.id = h.id AND rl.sku = kl.sku AND abs(kl.imp - rl.costo) <= ${TOLERANCIA_IMPORTE} * rl.costo
   GROUP BY h.id, h.sucursal, h.c6, h.f, h.d, n.n
  HAVING count(*) = n.n
),
uno AS (
  SELECT id, min(sucursal) AS suc, min(folio) AS folio
    FROM cabal GROUP BY id
  HAVING count(*) = 1 AND bool_and(en_ventana)
)
SELECT u.id, u.suc, u.folio
  FROM uno u
 WHERE (SELECT count(*) FROM uno u2 WHERE u2.suc = u.suc AND u2.folio = u.folio) = 1
   AND NOT EXISTS (SELECT 1 FROM commercial.purchase_requisitions o
                    WHERE o.tenant_id = :t AND o.oc_sucursal = u.suc AND o.oc_folio = u.folio)
 ORDER BY u.id
 LIMIT :lim`;

/** `(id)` de cada compra de D32 que se cancela: 30 días sin nada en Kepler. */
const CANCELAR_SQL = `
WITH r AS MATERIALIZED (
  SELECT r.id, r.created_at, r.created_at::date AS d, w.kepler_code AS suc, btrim(s.code) AS prov, upper(btrim(s.name)) AS pn
    FROM commercial.purchase_requisitions r
    JOIN commercial.warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
    LEFT JOIN catalog.suppliers s ON s.tenant_id = r.tenant_id AND s.id = r.supplier_id
   WHERE r.tenant_id = :t AND r.estado = 'approved' AND r.source_type = 'supplier'
     AND r.kepler_folio IS NULL AND r.oc_folio IS NULL AND r.kepler_error IS NULL AND w.kepler_code IS NOT NULL
     AND COALESCE(r.approved_at, r.created_at) < '${INICIO_ENVIO_AUTOMATICO}'::date
     AND r.created_at < :ahora::timestamptz - make_interval(days => ${DIAS_SIN_DOCUMENTO})
),
${CLAVES_CTE},
skus AS MATERIALIZED (
  SELECT DISTINCT r.id, r.suc, r.d, btrim(p.sku) AS sku
    FROM r
    JOIN commercial.purchase_requisition_lines l ON l.tenant_id = :t AND l.requisition_id = r.id AND COALESCE(l.final_qty, 0) > 0
    JOIN catalog.products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
),
del_proveedor AS (
  SELECT DISTINCT r.id
    FROM r
    JOIN claves c ON c.id = r.id
    JOIN kepler_ods.kdm1 k ON k.sucursal = r.suc AND k.c2 = 'X' AND k.c3 = 'A' AND btrim(k.c4::text) IN ('30', '35')
     AND k.c68::date >= r.d - 2 AND k.c68::date < r.d + ${DIAS_SIN_DOCUMENTO} AND btrim(k.c10) = c.clave
),
con_sus_productos AS (
  -- Por SKU (índice ix_kdm2_compra_sku). Unido como tabla, el planificador arrancaba por kdm1 por
  -- fecha y recorría 242 mil renglones: 3.2 s (medido 2026-11-04).
  SELECT DISTINCT s.id
    FROM skus s
   WHERE EXISTS (SELECT 1
                   FROM kepler_ods.kdm2 kl
                   JOIN kepler_ods.kdm1 k ON k.sucursal = kl.sucursal AND k.c1 = kl.c1 AND k.c2 = kl.c2 AND k.c3 = kl.c3
                                         AND k.c4 = kl.c4 AND k.c5 = kl.c5 AND k.c6 = kl.c6
                  WHERE btrim(kl.c8) = s.sku AND kl.c2 = 'X' AND kl.c3 = 'A'
                    AND kl.sucursal = s.suc AND btrim(kl.c4::text) IN ('30', '35', '40')
                    AND k.c68::date >= s.d - 2 AND k.c68::date < s.d + ${DIAS_SIN_DOCUMENTO})
)
SELECT r.id
  FROM r
 WHERE EXISTS (SELECT 1 FROM skus s WHERE s.id = r.id)
   AND NOT EXISTS (SELECT 1 FROM del_proveedor x WHERE x.id = r.id)
   AND NOT EXISTS (SELECT 1 FROM con_sus_productos x WHERE x.id = r.id)
 ORDER BY r.created_at, r.id
 LIMIT :lim`;

export interface LigaCompra { id: string; suc: string; folio: string }

type Db = Knex | Knex.Transaction;
const lim = (n: number) => Math.max(0, Math.floor(n));

/** Las compras que se ligarían, sin escribir. */
export async function compraSinDocumentoLigas(db: Db, tenantId: string, limite = LIMITE_LIMPIEZA_COMPRAS): Promise<LigaCompra[]> {
  return (await db.raw(LIGAR_SQL, { t: tenantId, lim: lim(limite) })).rows as LigaCompra[];
}

/** Las compras que se cancelarían, sin escribir. */
export async function compraSinDocumentoCancelables(db: Db, tenantId: string, ahora: Date = new Date(), limite = LIMITE_LIMPIEZA_COMPRAS): Promise<string[]> {
  return ((await db.raw(CANCELAR_SQL, { t: tenantId, ahora, lim: lim(limite) })).rows as Array<{ id: string }>).map((r) => r.id);
}

/** Liga y después cancela. Devuelve cuántas tocó de cada una. */
export async function limpiarComprasSinDocumento(
  db: Db,
  tenantId: string,
  ahora: Date = new Date(),
  limite = LIMITE_LIMPIEZA_COMPRAS,
): Promise<{ ligadas: number; canceladas: number }> {
  const ligas = await compraSinDocumentoLigas(db, tenantId, limite);
  let ligadas = 0;
  for (const g of ligas) {
    ligadas += await db('commercial.purchase_requisitions')
      .where({ tenant_id: tenantId, id: g.id, estado: 'approved' })
      .whereNull('kepler_folio').whereNull('oc_folio')
      .update({ estado: 'ordered', oc_sucursal: g.suc, oc_folio: g.folio, oc_capturada_at: ahora, ordered_at: ahora, updated_at: db.fn.now() });
  }
  const ids = await compraSinDocumentoCancelables(db, tenantId, ahora, limite);
  let canceladas = 0;
  if (ids.length) {
    const r = await db.raw(
      `UPDATE commercial.purchase_requisitions q
          SET estado = 'cancelled', rejected_at = :ahora::timestamptz, rejected_by = NULL, updated_at = now(),
              rejection_reason = '${MOTIVO_COMPRA_SIN_DOCUMENTO}: en ${DIAS_SIN_DOCUMENTO} días no apareció en Kepler '
                || 'ninguna requisición ni OC de este proveedor, ni requisición, OC o entrada con sus productos. '
                || 'Se cerró sola (D32).'
        WHERE q.tenant_id = :t AND q.id = ANY(:ids::uuid[]) AND q.estado = 'approved'`,
      { ahora, t: tenantId, ids });
    canceladas = r.rowCount ?? 0;
  }
  return { ligadas, canceladas };
}
