import { Knex } from 'knex';
import type { EscaleraUnidades, VieneBase } from '@megadulces/contracts';

/**
 * `[AB.34]` **Lo que la sucursal ya pidió**: la cuenta compartida de «lo que ya viene» de una
 * sucursal (pedido de traspaso abierto a su matriz + embarque sin recibir), en unidad base.
 *
 * Vive aquí, junto a `transito.ts`, por la misma razón que aquél (FASE_AB D14, acordado con PQ el
 * 2026-10-23): «qué se le resta al sugerido» tiene que decidirse en UN solo lugar. La consumen
 * «Mi pedido» y la mesa (por sucursal) y `/compras/pedido` (para toda la red). Si una de las tres la
 * reescribiera, dirían cifras distintas del mismo traspaso (ADR-056).
 *
 * Reglas, todas ya medidas antes de AB.34:
 *  · Cuenta el DOCUMENTO DE KEPLER, nunca la requisición aprobada en la Suite (PQ M2: el 55 % de esas
 *    no tiene ningún `U-D-40`; restarlas restaría mercancía que no existe).
 *  · Pedido abierto de 7 días o menos y embarque sin recibir de 7 días o menos: se RESTAN. Lo más
 *    viejo (atorado) y lo negado se MUESTRAN, no se restan.
 *  · La cantidad del renglón viene en su unidad (`kdm2.c11`) y se lleva a base con la escalera (AB.23:
 *    44 renglones en 30 días venían en CAJAS). Una unidad que la escalera no conoce no se adivina: se cuenta.
 *
 * ⚠️ Las dos consultas por sucursal (`PEDIDOS_SUCURSAL_SQL`, `EMBARCADO_SIN_RECIBIR_SQL`) se movieron
 * TAL CUAL desde `autoabasto-pedido.service.ts`: «Mi pedido» no cambia. Las de red (`*_RED_SQL`) son
 * las mismas reglas para todas las sucursales a la vez; `database/tests/test-newdb-ya-pedido-red.js`
 * prueba contra prod, en sólo lectura, que dan lo mismo que la suma sucursal por sucursal.
 */

/** Abiertos de esta antigüedad o menos cuentan como «ya pedido» (decisión de Francisco, 2026-10-12). */
export const VENTANA_YA_PEDIDO_DIAS = 7;
/** Lo negado se mira sobre este periodo. Sólo informa: no cambia el sugerido (decisión 2026-10-12). */
export const VENTANA_NEGADO_DIAS = 30;
/**
 * `[AB.23]` Lo EMBARCADO sin recibir de esta antigüedad o menos se resta. Medido 2026-10-22 sobre
 * 1,081 embarques recibidos en 30 días: del embarque a la recepción, mediana 1 día, p90 4, máximo 11.
 * Lo de más días se muestra (probablemente se recibió sin capturar la recepción), no se resta: es
 * la misma regla que «atorado» para los pedidos abiertos.
 */
export const VENTANA_EN_CAMINO_DIAS = 7;
/** `[AB.23]` Lo que se le muestra a la sucursal como «viene»: pedidos y embarques de este periodo. */
export const VENTANA_VIENE_DIAS = 30;

/**
 * Lo pedido a otra sucursal y lo que no le surtieron, por producto, para UNA sucursal destino.
 *
 * El pedido de una sucursal a su matriz vive en Kepler como un pedido `U-D-40` de la MATRIZ con
 * cliente interno `TI…` de la sucursal (`c27='SUCURSAL'`). Medido 2026-10-12: 01→02 152 pedidos,
 * 01→03 119, 01→04 138, 06→05 87, 08→07 90 en 60 días. El código `TI` de cada sucursal lo da
 * Kepler (`analytics.v_erp_branch_catalog`).
 *
 * Se toma la versión VIGENTE de cada pedido (`DISTINCT ON … ORDER BY c9 DESC`, mismo criterio que
 * `warehouse-orders.service.ts`) y el renglón ancla `c1`: la base de una plaza guarda copias de
 * pedidos de otra con la misma serie y folio.
 *
 *  · `ya_pedido` — abiertos (AUTORIZADO / SURTIDO / CHECADO) de `VENTANA_YA_PEDIDO_DIAS` o menos,
 *    en unidad base (`kdm2.c9`).
 *  · `atorado`   — abiertos más viejos: se muestran para reclamarlos, NO se restan. Medido: 29 de
 *    77 abiertos tenían más de 7 días.
 *  · `negado`    — en los EMBARCADOS del periodo, `pedido − embarcado` (`c51 − c54`, en la
 *    presentación `c55`) llevado a unidad base con el factor del renglón (`c9 / c56`). ⚠️ Que
 *    `c51` sea siempre lo pedido originalmente es la hipótesis de FASE_DN, todavía sin arbitrar.
 *
 * ⚠️ Un pedido abierto sin renglones no suma nada: medido en La Piedad, los 2 abiertos de la 01
 * estaban vacíos (en la práctica, cancelados). Kepler no decodifica «cancelado» en `c11`.
 */
export const PEDIDOS_SUCURSAL_SQL = `
WITH dest AS (
  SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc
),
h AS MATERIALIZED (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6)
         k.sucursal, k.c2, k.c3, k.c4, k.c5, k.c6, upper(btrim(k.c11::text)) AS est, k.c9::date AS f
    FROM kepler_ods.kdm1 k
   WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = 40
     AND btrim(k.c1) = btrim(k.sucursal)
     AND k.c9 >= current_date - 60
     AND upper(btrim(k.c27::text)) = 'SUCURSAL'
     AND btrim(k.c10::text) IN (SELECT dest_code FROM dest)
   ORDER BY k.sucursal, k.c5, k.c6, k.c9 DESC
),
l AS (
  SELECT h.est, h.f, btrim(x.c8::text) AS sku, NULLIF(upper(btrim(x.c11::text)), '') AS unidad,
         NULLIF(btrim(x.c9::text), '')::numeric  AS base_qty,
         NULLIF(btrim(x.c51::text), '')::numeric AS ped,
         NULLIF(btrim(x.c54::text), '')::numeric AS emb,
         NULLIF(btrim(x.c56::text), '')::numeric AS fin
    FROM h
    JOIN kepler_ods.kdm2 x
      ON x.sucursal = h.sucursal AND x.c2 = h.c2 AND x.c3 = h.c3 AND x.c4 = h.c4 AND x.c5 = h.c5 AND x.c6 = h.c6
     AND btrim(x.c1) = btrim(x.sucursal)
)
SELECT sku, unidad,
       COALESCE(sum(base_qty) FILTER (WHERE est IN ('AUTORIZADO','SURTIDO','CHECADO') AND f >= current_date - ${VENTANA_YA_PEDIDO_DIAS}), 0) AS ya_pedido,
       COALESCE(sum(base_qty) FILTER (WHERE est IN ('AUTORIZADO','SURTIDO','CHECADO') AND f <  current_date - ${VENTANA_YA_PEDIDO_DIAS}), 0) AS atorado,
       COALESCE(sum(GREATEST(ped - emb, 0) * base_qty / NULLIF(fin, 0))
                FILTER (WHERE est = 'EMBARCADO' AND f >= current_date - ${VENTANA_NEGADO_DIAS}), 0) AS negado
  FROM l
 GROUP BY sku, unidad`;

/**
 * `[AB.23]` Lo EMBARCADO a esta sucursal (U-D-41 en la sucursal que manda, cliente `TI…` de ésta)
 * que todavía no tiene su recepción (U-A-50 en ESTA sucursal que apunta al embarque: `c37=41`,
 * `c38`/`c39` = serie/folio). Mismo emparejamiento que el Andén (`receiving-session.service.ts`).
 * Cantidad por renglón en su unidad (`c9`, `c11`): se convierte a base con la escalera.
 */
export const EMBARCADO_SIN_RECIBIR_SQL = `
WITH dest AS (
  SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc
),
e AS MATERIALIZED (
  SELECT h.sucursal, h.c2, h.c3, h.c4, h.c5, h.c6, (h.c9)::date AS f
    FROM kepler_ods.kdm1 h
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 41 AND btrim(h.c1) = btrim(h.sucursal)
     AND btrim(COALESCE(h.c43, '')) <> 'C'
     AND (h.c9)::date >= current_date - ${VENTANA_EN_CAMINO_DIAS}
     AND btrim(h.c10::text) IN (SELECT dest_code FROM dest)
     AND NOT EXISTS (
       SELECT 1 FROM kepler_ods.kdm1 x
        WHERE x.c2 = 'U' AND x.c3 = 'A' AND (x.c4)::int = 50
          AND btrim(x.sucursal) = :suc AND btrim(x.c1) = :suc
          AND x.c37 = 41 AND x.c38 = h.c5 AND btrim(x.c39::text) = btrim(h.c6::text)
          AND btrim(COALESCE(x.c43, '')) <> 'C' AND (x.c9)::date >= (h.c9)::date - 1)
)
SELECT btrim(x.c8::text) AS sku, NULLIF(upper(btrim(x.c11::text)), '') AS unidad,
       COALESCE(sum(NULLIF(btrim(x.c9::text), '')::numeric), 0) AS en_camino
  FROM e
  JOIN kepler_ods.kdm2 x
    ON x.sucursal = e.sucursal AND x.c2 = e.c2 AND x.c3 = e.c3 AND x.c4 = e.c4 AND x.c5 = e.c5 AND x.c6 = e.c6
   AND btrim(x.c1) = btrim(x.sucursal)
 WHERE NULLIF(btrim(x.c8::text), '') IS NOT NULL
 GROUP BY 1, 2`;

export interface FilaPedidos { sku: string; unidad: string | null; ya_pedido: string | number; atorado: string | number; negado: string | number }
export interface FilaEnCamino { sku: string; unidad: string | null; en_camino: string | number }
/**
 * `[AB.23]` Unidades BASE por unidad del renglón, con la escalera de Kepler. Antes se asumía que
 * `kdm2.c9` venía en base, y casi siempre es así — pero medido el 2026-10-22, 44 renglones de pedidos
 * de traspaso en 30 días venían en CAJAS (y 44 de embarques en 15): un pedido de 2 cajas restaba 2
 * paquetes. `null` = la escalera EXISTE y no conoce la unidad: no se adivina.
 */
export function factorBaseDe(unidad: string | null, e: EscaleraUnidades | null): number | null {
  const u = (unidad ?? '').trim().toUpperCase();
  // Sin escalera se toma la base, como antes de `[AB.23]`: no restar nada sería peor que restar en base.
  if (!e) return 1;
  if (!u || u === (e.unit_base ?? '').trim().toUpperCase()) return 1;
  if (u === (e.u2_label ?? '').trim().toUpperCase() && Number(e.f2) > 0) return Number(e.f2);
  if (u === (e.u3_label ?? '').trim().toUpperCase() && Number(e.f3) > 0) return Number(e.f3);
  // La base con rótulo de GRAMAJE (`500`, `250`) llega sin nombre a la escalera (`unit_base` null).
  // Medido 2026-10-22 con 02972 OREO GRANEL: el embarque venía en «500» a $47.79, que es el costo por
  // unidad base. Lo cazó el testigo de test-newdb-autoabasto-en-camino.js.
  if (!e.unit_base && /^[0-9]+$/.test(u)) return 1;
  return null;
}

const numero = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `[AB.34]` La suma PURA de «lo que ya viene» de una sucursal, por producto y en unidad BASE.
 *
 * Es el bucle que vivía dentro de «Mi pedido», movido sin cambios: pedidos abiertos (ya, atorado,
 * negado) y embarques sin recibir (camino), cada renglón convertido a base con su escalera.
 *
 * @param enMesa si se da, sólo suma esos SKU (lo que no está en la pantalla ni se suma ni se cuenta).
 */
export function sumarYaPedido(
  pedidos: readonly FilaPedidos[],
  enCamino: readonly FilaEnCamino[],
  escaleras: ReadonlyMap<string, EscaleraUnidades>,
  enMesa?: ReadonlySet<string>,
): { viene: Map<string, VieneBase>; sinUnidad: number } {
  const viene = new Map<string, VieneBase>();
  let sinUnidad = 0;
  const sumar = (sku: string, unidad: string | null, campo: keyof VieneBase, qty: number) => {
    if (!(qty > 0) || (enMesa && !enMesa.has(sku))) return;
    const k = factorBaseDe(unidad, escaleras.get(sku) ?? null);
    if (k == null) { sinUnidad++; return; }
    const v = viene.get(sku) ?? { ya: 0, atorado: 0, negado: 0, camino: 0 };
    v[campo] += qty * k;
    viene.set(sku, v);
  };
  for (const p of pedidos) {
    sumar(p.sku, p.unidad, 'ya', numero(p.ya_pedido));
    sumar(p.sku, p.unidad, 'atorado', numero(p.atorado));
    sumar(p.sku, p.unidad, 'negado', numero(p.negado));
  }
  for (const e of enCamino) sumar(e.sku, e.unidad, 'camino', numero(e.en_camino));
  return { viene, sinUnidad };
}

/**
 * `[AB.34]` Lo mismo que `PEDIDOS_SUCURSAL_SQL`, para TODAS las sucursales con cliente de traspaso a
 * la vez (lo que necesita `/compras/pedido`, que arma la red entera). Mismas ventanas, misma versión
 * vigente de cada pedido, mismo renglón ancla; agrega la sucursal destino (`suc`).
 */
export const PEDIDOS_SUCURSAL_RED_SQL = `
WITH cat AS (
  SELECT dest_code, suc_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t
),
h AS MATERIALIZED (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6)
         k.sucursal, k.c2, k.c3, k.c4, k.c5, k.c6, upper(btrim(k.c11::text)) AS est, k.c9::date AS f,
         btrim(k.c10::text) AS dest
    FROM kepler_ods.kdm1 k
   WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = 40
     AND btrim(k.c1) = btrim(k.sucursal)
     AND k.c9 >= current_date - 60
     AND upper(btrim(k.c27::text)) = 'SUCURSAL'
     AND btrim(k.c10::text) IN (SELECT dest_code FROM cat)
   ORDER BY k.sucursal, k.c5, k.c6, k.c9 DESC
),
l AS (
  SELECT c.suc_code AS suc, h.est, h.f, btrim(x.c8::text) AS sku, NULLIF(upper(btrim(x.c11::text)), '') AS unidad,
         NULLIF(btrim(x.c9::text), '')::numeric  AS base_qty,
         NULLIF(btrim(x.c51::text), '')::numeric AS ped,
         NULLIF(btrim(x.c54::text), '')::numeric AS emb,
         NULLIF(btrim(x.c56::text), '')::numeric AS fin
    FROM h
    JOIN cat c ON c.dest_code = h.dest
    JOIN kepler_ods.kdm2 x
      ON x.sucursal = h.sucursal AND x.c2 = h.c2 AND x.c3 = h.c3 AND x.c4 = h.c4 AND x.c5 = h.c5 AND x.c6 = h.c6
     AND btrim(x.c1) = btrim(x.sucursal)
)
SELECT suc, sku, unidad,
       COALESCE(sum(base_qty) FILTER (WHERE est IN ('AUTORIZADO','SURTIDO','CHECADO') AND f >= current_date - ${VENTANA_YA_PEDIDO_DIAS}), 0) AS ya_pedido,
       COALESCE(sum(base_qty) FILTER (WHERE est IN ('AUTORIZADO','SURTIDO','CHECADO') AND f <  current_date - ${VENTANA_YA_PEDIDO_DIAS}), 0) AS atorado,
       COALESCE(sum(GREATEST(ped - emb, 0) * base_qty / NULLIF(fin, 0))
                FILTER (WHERE est = 'EMBARCADO' AND f >= current_date - ${VENTANA_NEGADO_DIAS}), 0) AS negado
  FROM l
 GROUP BY suc, sku, unidad`;

/** `[AB.34]` Lo mismo que `EMBARCADO_SIN_RECIBIR_SQL`, para todas las sucursales a la vez. */
export const EMBARCADO_SIN_RECIBIR_RED_SQL = `
WITH cat AS (
  SELECT dest_code, suc_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t
),
e AS MATERIALIZED (
  SELECT c.suc_code AS suc, h.sucursal, h.c2, h.c3, h.c4, h.c5, h.c6, (h.c9)::date AS f
    FROM kepler_ods.kdm1 h
    JOIN cat c ON c.dest_code = btrim(h.c10::text)
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 41 AND btrim(h.c1) = btrim(h.sucursal)
     AND btrim(COALESCE(h.c43, '')) <> 'C'
     AND (h.c9)::date >= current_date - ${VENTANA_EN_CAMINO_DIAS}
     AND NOT EXISTS (
       SELECT 1 FROM kepler_ods.kdm1 x
        WHERE x.c2 = 'U' AND x.c3 = 'A' AND (x.c4)::int = 50
          AND btrim(x.sucursal) = c.suc_code AND btrim(x.c1) = c.suc_code
          AND x.c37 = 41 AND x.c38 = h.c5 AND btrim(x.c39::text) = btrim(h.c6::text)
          AND btrim(COALESCE(x.c43, '')) <> 'C' AND (x.c9)::date >= (h.c9)::date - 1)
)
SELECT e.suc, btrim(x.c8::text) AS sku, NULLIF(upper(btrim(x.c11::text)), '') AS unidad,
       COALESCE(sum(NULLIF(btrim(x.c9::text), '')::numeric), 0) AS en_camino
  FROM e
  JOIN kepler_ods.kdm2 x
    ON x.sucursal = e.sucursal AND x.c2 = e.c2 AND x.c3 = e.c3 AND x.c4 = e.c4 AND x.c5 = e.c5 AND x.c6 = e.c6
   AND btrim(x.c1) = btrim(x.sucursal)
 WHERE NULLIF(btrim(x.c8::text), '') IS NOT NULL
 GROUP BY 1, 2, 3`;

/** `[AB.34]` Lo que ya viene a cada sucursal, por producto y en BASE. La llave es el código de la sucursal. */
export type YaPedidoRed = Map<string, { viene: Map<string, VieneBase>; sinUnidad: number }>;

/**
 * `[AB.34]` Lee y suma lo que ya viene a TODAS las sucursales con cliente de traspaso, en una sola
 * pasada (dos consultas + la escalera de los SKU que aparecieron). Una sucursal sin cliente de
 * traspaso NO aparece: para ella lo ya pedido no se pudo medir, que no es «cero» (lo declara quien consume).
 *
 * Recibe la transacción: no abre la suya (anidar `tk.run()` es un error conocido del repo).
 */
export async function leerYaPedidoRed(trx: Knex.Transaction, tenantId: string): Promise<YaPedidoRed> {
  type ConSuc<T> = T & { suc: string };
  const pedidos = ((await trx.raw(PEDIDOS_SUCURSAL_RED_SQL, { t: tenantId })).rows ?? []) as ConSuc<FilaPedidos>[];
  const camino = ((await trx.raw(EMBARCADO_SIN_RECIBIR_RED_SQL, { t: tenantId })).rows ?? []) as ConSuc<FilaEnCamino>[];
  const skus = [...new Set([...pedidos, ...camino].map((r) => r.sku))];
  const escaleras = new Map<string, EscaleraUnidades>();
  if (skus.length) {
    const e: Array<{ sku: string; unit_base: string | null; u2_label: string | null; u3_label: string | null;
      f2: string | number | null; f3: string | number | null; is_weight: boolean | null }> = await trx('analytics.v_product_unit_ladder')
      .select('sku', 'unit_base', 'u2_label', 'u3_label', 'f2', 'f3', 'is_weight')
      .whereIn('sku', skus);
    const nn = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    for (const x of e) {
      escaleras.set(x.sku, { unit_base: x.unit_base, u2_label: x.u2_label, u3_label: x.u3_label, f2: nn(x.f2), f3: nn(x.f3), is_weight: !!x.is_weight });
    }
  }
  const out: YaPedidoRed = new Map();
  const sucs = new Set([...pedidos, ...camino].map((r) => r.suc));
  for (const suc of sucs) {
    out.set(suc, sumarYaPedido(pedidos.filter((r) => r.suc === suc), camino.filter((r) => r.suc === suc), escaleras));
  }
  return out;
}
