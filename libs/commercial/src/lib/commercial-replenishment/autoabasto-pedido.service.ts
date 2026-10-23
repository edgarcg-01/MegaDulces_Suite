import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, MX_TZ, toMxDateKey } from '@megadulces/platform-core';
import {
  armarRenglon,
  surteDe,
  coberturaAutoabasto,
  COBERTURA_AUTOABASTO,
  COBERTURA_AUTOABASTO_DEFAULT,
  necesitaMotivo,
  normalizarPosiciones,
  MOTIVOS_AJUSTE,
  POSICIONES_PEDIDO_DEFAULT,
  type PosicionPedido,
  type AutoabastoPosicionesRequest,
  type MotivoAjuste,
  type AjusteLinea,
  type EscaleraUnidades,
  type AutoabastoPedidoGrupo,
  type VieneBase,
  type RenglonArmado,
  filtrarRenglones,
  ordenarRenglones,
  resumirRenglones,
  type FiltroMesa,
  type OrdenMesa,
  type AutoabastoMesaRenglon,
  type AutoabastoRenglonesResponse,
  type AutoabastoPedidoResponse,
  type AutoabastoAjusteRequest,
  type AutoabastoAjusteResponse,
  type AutoabastoRestablecerRequest,
  type AutoabastoAceptarGrupoRequest,
  type AutoabastoAbrirRequest,
} from '@megadulces/contracts';
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/** Abiertos de esta antigüedad o menos cuentan como «ya pedido» (decisión de Francisco, 2026-10-12). */
const VENTANA_YA_PEDIDO_DIAS = 7;
/** Lo negado se mira sobre este periodo. Sólo informa: no cambia el sugerido (decisión 2026-10-12). */
const VENTANA_NEGADO_DIAS = 30;
/**
 * `[AB.23]` Lo EMBARCADO sin recibir de esta antigüedad o menos se resta. Medido 2026-10-22 sobre
 * 1,081 embarques recibidos en 30 días: del embarque a la recepción, mediana 1 día, p90 4, máximo 11.
 * Lo de más días se muestra (probablemente se recibió sin capturar la recepción), no se resta: es
 * la misma regla que «atorado» para los pedidos abiertos.
 */
const VENTANA_EN_CAMINO_DIAS = 7;
/** `[AB.23]` Lo que se le muestra a la sucursal como «viene»: pedidos y embarques de este periodo. */
const VENTANA_VIENE_DIAS = 30;

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
const PEDIDOS_SUCURSAL_SQL = `
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
const EMBARCADO_SIN_RECIBIR_SQL = `
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

/**
 * `[AB.23]` Los DOCUMENTOS que le van a llegar: pedidos de traspaso abiertos (versión vigente, como
 * `PEDIDOS_SUCURSAL_SQL`) y embarques sin recibir, de `VENTANA_VIENE_DIAS`. Es lo que la sucursal
 * lee arriba para no pedir dos veces; el detalle por producto va en cada renglón.
 */
const VIENE_DOCS_SQL = `
WITH dest AS (
  SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc
),
ped AS (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6)
         'pedido'::text AS tipo, btrim(k.sucursal) AS origen, (k.c5)::int AS serie, btrim(k.c6::text) AS folio,
         upper(btrim(k.c11::text)) AS estado, (k.c9)::date AS f,
         NULLIF(regexp_replace(k.c16::text, '[^0-9.-]', '', 'g'), '')::numeric AS monto,
         k.sucursal AS s_raw, k.c2, k.c3, k.c4, k.c5, k.c6
    FROM kepler_ods.kdm1 k
   WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = 40 AND btrim(k.c1) = btrim(k.sucursal)
     AND k.c9 >= current_date - ${VENTANA_VIENE_DIAS} AND upper(btrim(k.c27::text)) = 'SUCURSAL'
     AND btrim(k.c10::text) IN (SELECT dest_code FROM dest)
   ORDER BY k.sucursal, k.c5, k.c6, k.c9 DESC
),
emb AS (
  SELECT 'embarque'::text AS tipo, btrim(h.sucursal) AS origen, (h.c5)::int AS serie, btrim(h.c6::text) AS folio,
         'EMBARCADO'::text AS estado, (h.c9)::date AS f,
         NULLIF(regexp_replace(h.c16::text, '[^0-9.-]', '', 'g'), '')::numeric AS monto,
         h.sucursal AS s_raw, h.c2, h.c3, h.c4, h.c5, h.c6
    FROM kepler_ods.kdm1 h
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 41 AND btrim(h.c1) = btrim(h.sucursal)
     AND btrim(COALESCE(h.c43, '')) <> 'C'
     AND (h.c9)::date >= current_date - ${VENTANA_VIENE_DIAS}
     AND btrim(h.c10::text) IN (SELECT dest_code FROM dest)
     AND NOT EXISTS (
       SELECT 1 FROM kepler_ods.kdm1 x
        WHERE x.c2 = 'U' AND x.c3 = 'A' AND (x.c4)::int = 50
          AND btrim(x.sucursal) = :suc AND btrim(x.c1) = :suc
          AND x.c37 = 41 AND x.c38 = h.c5 AND btrim(x.c39::text) = btrim(h.c6::text)
          AND btrim(COALESCE(x.c43, '')) <> 'C' AND (x.c9)::date >= (h.c9)::date - 1)
),
docs AS (
  SELECT * FROM ped WHERE estado IN ('AUTORIZADO', 'SURTIDO', 'CHECADO')
  UNION ALL SELECT * FROM emb
)
SELECT d.tipo, d.origen, d.serie, d.folio, d.estado, to_char(d.f, 'YYYY-MM-DD') AS fecha,
       (current_date - d.f)::int AS dias, d.monto,
       (SELECT count(*) FROM kepler_ods.kdm2 x
         WHERE x.sucursal = d.s_raw AND x.c2 = d.c2 AND x.c3 = d.c3 AND x.c4 = d.c4 AND x.c5 = d.c5 AND x.c6 = d.c6
           AND btrim(x.c1) = btrim(x.sucursal) AND NULLIF(btrim(x.c8::text), '') IS NOT NULL)::int AS renglones
  FROM docs d
 ORDER BY d.f DESC, d.origen, d.folio DESC`;

/**
 * `[AB.24]` Lo que Compras planeó mandarle a ESTA sucursal desde `/compras/pedido` (requisición de
 * traspaso, `source_type='branch'`) que todavía no llegó a Kepler. Medido 2026-10-22: de 788, ninguna
 * llegó (el envío está apagado: `KEPLER_PUSH_URL sin configurar`). Sólo lo reciente: 306 aprobadas
 * tienen más de 7 días y son planes que nadie ejecutó.
 */
const PLANEADO_COMPRAS_SQL = `
SELECT r.id, r.folio, r.estado, coalesce(wo.kepler_code, wo.code) AS origen, to_char(r.created_at::date, 'YYYY-MM-DD') AS fecha,
       (current_date - r.created_at::date)::int AS dias, r.total_cost AS monto, l.product_id, l.final_qty
  FROM commercial.purchase_requisitions r
  JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
  LEFT JOIN commercial.warehouses wo ON wo.id = r.source_warehouse_id AND wo.tenant_id = r.tenant_id
 WHERE r.tenant_id = :t AND r.warehouse_id = :wh AND r.source_type = 'branch'
   AND r.estado IN ('pending_approval', 'approved') AND r.kepler_folio IS NULL
   AND r.created_at >= now() - interval '${VENTANA_YA_PEDIDO_DIAS} days'
   AND COALESCE(l.final_qty, 0) > 0`;

/** ¿Hay cliente de traspaso para esta sucursal? Sin él, lo pedido NO se mide (≠ «cero»). */
const TIENE_DESTINO_SQL = `SELECT 1 FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc LIMIT 1`;


interface FilaPedidos { sku: string; unidad: string | null; ya_pedido: string | number; atorado: string | number; negado: string | number }
interface FilaEnCamino { sku: string; unidad: string | null; en_camino: string | number }
interface FilaPlan { id: string; folio: string | null; estado: string; origen: string | null; fecha: string; dias: number; monto: string | number | null; product_id: string; final_qty: string | number }
interface FilaDoc { tipo: 'pedido' | 'embarque'; origen: string; serie: number; folio: string; estado: string; fecha: string; dias: number; monto: string | number | null; renglones: number }
interface FilaEscalera {
  sku: string; unit_base: string | null; u2_label: string | null; u3_label: string | null;
  f2: string | number | null; f3: string | number | null; is_weight: boolean | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numONull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
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
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `[AB.16]` Fase AB — **«Mi pedido»** de una sucursal.
 *
 * NO calcula el reabasto: toma los renglones de la mesa (`criticalStock` con la base 'demanda',
 * los mismos que valida AB.15 contra /compras/pedido) y les agrega lo que la mesa no sabe —lo ya
 * pedido a la matriz, lo atorado, lo negado— y la cantidad a capturar en Kepler, redondeada con
 * la regla de §15.2 (`redondearPedido`, en `libs/contracts`).
 *
 * Sólo LEE. La Suite no escribe en Kepler: el almacenista captura el pedido allá con lo que ve acá.
 */
@Injectable()
export class AutoabastoPedidoService {
  constructor(
    private readonly motor: CommercialReplenishmentService,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * `[AB.27]` Lo que «Mi pedido» y la mesa leen de UN almacén, armado una sola vez y de una sola
   * forma: los renglones del motor, lo que ya viene, lo planeado por Compras y lo ajustado, pasados
   * por `armarRenglon` (AB.26). Las dos pantallas salen de aquí: si una cambiara la cuenta, cambiarían
   * las dos.
   */
  private async armarAlmacen(almacen: Almacen, area: string): Promise<AlmacenArmado> {
    const tenantId = this.tenantCtx.requireTenantId();
    const mesa = await this.motor.criticalStock(
      { warehouse_id: almacen.id, target_basis: 'demanda', export: true }, area,
    );
    const filas = mesa.rows;
    const skus = [...new Set(filas.map((f) => String(f['sku'])))];

    const { pedidos, enCamino, docs, planes, escaleras, medidos, borrador, ajustes, guardable, posiciones } = await this.tk.run(async (trx: Knex.Transaction) => {
      // `[AB.18]` El borrador guardado y lo que la persona ya ajustó. Sólo LEE: abrir el pedido no
      // escribe nada (el borrador nace con el primer ajuste). Si la migración del borrador todavía
      // no llegó a esta base, el pedido se sirve igual y lo declara (`guardado_disponible`); se pregunta con
      // `to_regclass` porque un SELECT fallido abortaría la transacción entera.
      const guardable = await this.borradorDisponible(trx);
      const borrador = guardable ? await this.borradorDe(trx, tenantId, almacen.id) : null;
      // `[AB.19]` Hasta dónde pide: lo guardado en el borrador; sin borrador, el default.
      let posiciones: PosicionPedido[] = [...POSICIONES_PEDIDO_DEFAULT];
      if (borrador) {
        const b = await trx('commercial.autoabasto_pedidos').where({ tenant_id: tenantId, id: borrador }).first('posiciones');
        posiciones = normalizarPosiciones(b?.posiciones);
      }
      const ajustes = new Map<string, AjusteLinea & { cantidad_base: number }>();
      if (borrador) {
        const ls: FilaLinea[] = await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: borrador })
          .select('product_id', 'cantidad', 'unidad', 'cantidad_base', 'motivo', 'ajustado_por_username', 'ajustado_at');
        for (const l of ls) {
          ajustes.set(l.product_id, {
            cantidad: num(l.cantidad), unidad: l.unidad, motivo: (l.motivo as MotivoAjuste | null) ?? null,
            ajustado_por: l.ajustado_por_username, ajustado_at: new Date(l.ajustado_at).toISOString(),
            cantidad_base: num(l.cantidad_base),
          });
        }
      }
      const binds = { t: tenantId, suc: almacen.code };
      const destino = await trx.raw(TIENE_DESTINO_SQL, binds);
      const medidos = (destino.rows ?? []).length > 0;
      // `[AB.23]` Por (producto, unidad): se convierte a base más abajo, con la escalera.
      const pedidos: FilaPedidos[] = [];
      const enCamino: FilaEnCamino[] = [];
      let docs: FilaDoc[] = [];
      if (medidos) {
        pedidos.push(...(((await trx.raw(PEDIDOS_SUCURSAL_SQL, binds)).rows ?? []) as FilaPedidos[]));
        enCamino.push(...(((await trx.raw(EMBARCADO_SIN_RECIBIR_SQL, binds)).rows ?? []) as FilaEnCamino[]));
        docs = ((await trx.raw(VIENE_DOCS_SQL, binds)).rows ?? []) as FilaDoc[];
      }
      // `[AB.24]` Lo planeado por Compras no depende de Kepler: se lee siempre.
      const planes = ((await trx.raw(PLANEADO_COMPRAS_SQL, { t: tenantId, wh: almacen.id })).rows ?? []) as FilaPlan[];
      const escaleras = new Map<string, EscaleraUnidades>();
      if (skus.length) {
        // Escalera de unidades de Kepler (vista sobre kdii), sólo de los productos de la mesa.
        const e: FilaEscalera[] = await trx('analytics.v_product_unit_ladder')
          .select('sku', 'unit_base', 'u2_label', 'u3_label', 'f2', 'f3', 'is_weight')
          .whereIn('sku', skus);
        for (const x of e) {
          escaleras.set(x.sku, {
            unit_base: x.unit_base, u2_label: x.u2_label, u3_label: x.u3_label,
            f2: numONull(x.f2), f3: numONull(x.f3), is_weight: !!x.is_weight,
          });
        }
      }
      return { pedidos, enCamino, docs, planes, escaleras, medidos, borrador, ajustes, guardable, posiciones };
    });

    // `[AB.23]` Lo que viene, por producto y en BASE. Una unidad que la escalera no conoce no se suma: se cuenta.
    const viene = new Map<string, VieneBase>();
    let sinUnidad = 0;
    const enMesa = new Set(skus);   // lo que no está en la mesa no se pinta: ni se suma ni se cuenta
    const sumar = (sku: string, unidad: string | null, campo: keyof VieneBase, qty: number) => {
      if (!(qty > 0) || !enMesa.has(sku)) return;
      const k = factorBaseDe(unidad, escaleras.get(sku) ?? null);
      if (k == null) { sinUnidad++; return; }
      const v = viene.get(sku) ?? { ya: 0, atorado: 0, negado: 0, camino: 0 };
      v[campo] += qty * k;
      viene.set(sku, v);
    };
    for (const p of pedidos) {
      sumar(p.sku, p.unidad, 'ya', num(p.ya_pedido));
      sumar(p.sku, p.unidad, 'atorado', num(p.atorado));
      sumar(p.sku, p.unidad, 'negado', num(p.negado));
    }
    for (const e of enCamino) sumar(e.sku, e.unidad, 'camino', num(e.en_camino));
    // `[AB.24]` Lo planeado por Compras, por producto (cajas) y por documento.
    const planPorProducto = new Map<string, number>();
    const planDocs = new Map<string, FilaPlan & { renglones: number }>();
    for (const p of planes) {
      planPorProducto.set(p.product_id, (planPorProducto.get(p.product_id) ?? 0) + num(p.final_qty));
      const d = planDocs.get(p.id);
      if (d) d.renglones++; else planDocs.set(p.id, { ...p, renglones: 1 });
    }
    const renglones: RenglonInterno[] = filas.map((f) => {
      const sku = String(f['sku']);
      // El factor del almacén: las cantidades "_nat" vienen en unidad base, las de la mesa en cajas.
      const cf = Math.max(1, num(f['caja_factor']));
      const productId = String(f['product_id']);
      // `[AB.26]` La cuenta del renglón vive en `libs/contracts` (`armarRenglon`). Acá sólo se le pasa
      // lo que el servidor leyó; ninguna resta se escribe aquí.
      return { fila: f, cf, ...armarRenglon({
        product_id: productId,
        sku,
        nombre: String(f['nombre'] ?? ''),
        venta_30d: numONull(f['venta_30d']),
        existencia: num(f['on_hand']),
        objetivo: numONull(f['target_qty']),
        falta: num(f['suggested_qty']),
        falta_base: num(f['suggested_qty_nat']),
        caja_factor: cf,
        costo_base: numONull(f['unit_cost']),
        rung_veredicto: f['rung_veredicto'] == null ? null : String(f['rung_veredicto']),
        posicion: String(f['bucket'] ?? ''),
        viene: viene.get(sku) ?? null,
        planeado_compras: planPorProducto.get(productId) ?? 0,
        escalera: escaleras.get(sku) ?? null,
        ajuste: ajustes.get(productId) ?? null,
        surte: surteDe(f['replenish_via'], f['source_warehouse_code'], f['supplier_id'], f['supplier_name']),
      }) };
    });
    return { renglones, docs, planDocs, sinUnidad, medidos, borrador, guardable, posiciones };
  }

  async pedido(almacen: Almacen, area: string, puedeAjustar = false): Promise<AutoabastoPedidoResponse> {
    const { renglones, docs, planDocs, sinUnidad, medidos, borrador, guardable, posiciones } = await this.armarAlmacen(almacen, area);
    const grupos = new Map<string, AutoabastoPedidoGrupo>();
    for (const { fila: f, cf, linea, efectivo_base: efectivoBase, efectivo_cantidad: efectivoCant } of renglones) {
      const aPedir = linea.a_pedir;

      const { tipo, clave, nombre } = linea.surte;
      const llave = `${tipo}:${clave ?? ''}`;
      let g = grupos.get(llave);
      if (!g) {
        g = {
          tipo,
          clave,
          nombre,
          lineas: [],
          renglones_a_pedir: 0,
          total_cajas: 0,
          renglones_sin_caja: 0,
          total_valor: null,
          sin_valuar: 0,
          minimo_cajas: tipo === 'proveedor' ? numONull(f['supplier_min_boxes']) : null,
          minimo_valor: tipo === 'proveedor' ? numONull(f['supplier_min_amount']) : null,
        };
        grupos.set(llave, g);
      }
      g.lineas.push(linea);
      if (efectivoCant > 0) {
        g.renglones_a_pedir++;
        // Cajas sólo de lo que tiene caja: lo pedido en cajas, o en la menor con un factor de caja
        // real en el almacén. Lo demás (piezas sin caja, kilos) se cuenta aparte, no se suma.
        if (aPedir.regla === 'cajas' || (aPedir.regla === 'nada' && cf > 1 && aPedir.factor === cf)) g.total_cajas += efectivoBase / cf;
        else if (aPedir.regla === 'menor' && cf > 1) g.total_cajas += efectivoBase / cf;
        else g.renglones_sin_caja++;
        if (linea.valor != null) g.total_valor = (g.total_valor ?? 0) + linea.valor;
        else g.sin_valuar++;
      }
    }

    const orden: Record<AutoabastoPedidoGrupo['tipo'], number> = { matriz: 0, proveedor: 1, sin_ruta: 2 };
    const lista = [...grupos.values()]
      .map((g) => ({
        ...g,
        total_cajas: r1(g.total_cajas),
        total_valor: g.total_valor == null ? null : r2(g.total_valor),
        // Primero lo que hay que pedir, por valor; lo cubierto por lo ya pedido queda abajo.
        lineas: g.lineas.sort((a, b) =>
          (b.a_pedir.cantidad > 0 ? 1 : 0) - (a.a_pedir.cantidad > 0 ? 1 : 0)
          || (b.valor ?? 0) - (a.valor ?? 0)
          || a.sku.localeCompare(b.sku)),
      }))
      .sort((a, b) => orden[a.tipo] - orden[b.tipo] || (b.total_valor ?? 0) - (a.total_valor ?? 0));

    const ahora = new Date();
    return {
      almacen,
      fecha_mx: toMxDateKey(ahora),
      hora_mx: new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora),
      cobertura_dias: coberturaAutoabasto(almacen.code),
      ventana_ya_pedido_dias: VENTANA_YA_PEDIDO_DIAS,
      ventana_negado_dias: VENTANA_NEGADO_DIAS,
      ventana_en_camino_dias: VENTANA_EN_CAMINO_DIAS,
      viene: medidos || planDocs.size ? {
        documentos: [
          ...docs.map((d) => ({
            tipo: d.tipo, origen: d.origen, serie: Number(d.serie), folio: d.folio, estado: d.estado, fecha: d.fecha,
            dias: Number(d.dias), renglones: Number(d.renglones), monto: numONull(d.monto),
            se_resta: d.tipo === 'embarque' ? Number(d.dias) <= VENTANA_EN_CAMINO_DIAS : Number(d.dias) <= VENTANA_YA_PEDIDO_DIAS,
          })),
          ...[...planDocs.values()].map((p) => ({
            tipo: 'plan' as const, origen: p.origen ?? '', serie: 0, folio: p.folio ?? '', estado: 'PLANEADO', fecha: p.fecha,
            dias: Number(p.dias), renglones: p.renglones, monto: numONull(p.monto), se_resta: false,
          })),
        ],
        renglones_sin_unidad: sinUnidad,
      } : null,
      grupos: lista,
      pedidos_medidos: medidos,
      pedido_id: borrador,
      puede_ajustar: puedeAjustar,
      guardado_disponible: guardable,
      posiciones,
    };
  }

  /**
   * `[AB.27]` La mesa de UN almacén sobre la cuenta única: cada renglón es el de «Mi pedido» más lo
   * que sólo la mesa muestra (mínimo, reorden, máximo, entrega). El resumen es del almacén entero y se
   * suma con la misma regla que los grupos de «Mi pedido»; el filtro sólo recorta la lista.
   *
   * ⚠️ Cuesta lo mismo que «Mi pedido» (3.7 s medidos el 2026-10-12 en AB.16, sin re-medir): arma el
   * almacén entero en cada llamada y pagina después. Bajarlo es un commit aparte (regla: optimizar no
   * va junto con cambiar la cuenta).
   */
  async renglones(
    almacen: Almacen, area: string,
    q: FiltroMesa & { sort_by?: OrdenMesa; sort_dir?: 'asc' | 'desc'; page?: number; pageSize?: number; todos?: boolean },
  ): Promise<AutoabastoRenglonesResponse> {
    const { renglones, medidos } = await this.armarAlmacen(almacen, area);
    const todos: AutoabastoMesaRenglon[] = renglones.map(({ fila: f, linea }) => ({
      ...linea,
      diagnostico: {
        min_stock: num(f['min_stock']),
        reorder_point: num(f['reorder_point']),
        max_stock: num(f['max_stock']),
        oc_en_camino: num(f['in_transit']),
        venta_diaria: numONull(f['avg_daily_units']),
        next_due_date: fechaDe(f['next_due_date']),
        lead_time_days: numONull(f['lead_time_days']),
        cadence_days: numONull(f['cadence_days']),
        abc_class: f['abc_class'] == null ? null : String(f['abc_class']),
        rung_veredicto: f['rung_veredicto'] == null ? null : String(f['rung_veredicto']),
        sales_rank: numONull(f['sales_rank']),
      },
    }));
    const lista = ordenarRenglones(filtrarRenglones(todos, q), q.sort_by ?? 'lectura', q.sort_dir ?? 'desc');
    // `todos` = el papel: el almacén completo con el filtro, sin paginar (ya se armó entero de todos modos).
    const pageSize = q.todos ? Math.max(1, lista.length) : Math.min(500, Math.max(1, Math.floor(Number(q.pageSize) || 50)));
    const page = q.todos ? 1 : Math.max(1, Math.floor(Number(q.page) || 1));
    const ahora = new Date();
    return {
      almacen,
      fecha_mx: toMxDateKey(ahora),
      hora_mx: new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora),
      cobertura_dias: coberturaAutoabasto(almacen.code),
      pedidos_medidos: medidos,
      total: lista.length,
      page,
      pageSize,
      resumen: resumirRenglones(todos),
      renglones: lista.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  /**
   * `[AB.19]` Hasta dónde pide el almacenista (agotado, bajo mínimo, bajo reorden, otros). Se
   * guarda en el borrador y deja huella con lo que había antes: elegir sólo lo agotado es una
   * decisión que el aprendizaje tiene que ver, no un filtro de pantalla.
   */
  async guardarPosiciones(warehouseId: string, req: AutoabastoPosicionesRequest): Promise<{ posiciones: PosicionPedido[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const posiciones = normalizarPosiciones(req.posiciones);
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      const previo = await trx('commercial.autoabasto_pedidos').where({ tenant_id: tenantId, id: pedidoId }).first('posiciones');
      await trx('commercial.autoabasto_pedidos')
        .where({ tenant_id: tenantId, id: pedidoId })
        .update({ posiciones: trx.raw('?::text[]', [posiciones]), updated_at: trx.fn.now() });
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'posiciones',
        datos: JSON.stringify({ antes: normalizarPosiciones(previo?.posiciones), despues: posiciones }),
      });
      return { posiciones };
    });
  }

  // ── [AB.18] Ajustes del almacenista y su huella ─────────────────────────────────────────────

  /**
   * ¿Se puede guardar el borrador en esta base? Hacen falta DOS cosas: que la tabla exista
   * (`[AB.18]` se migra antes que el código) y que la conexión pueda escribir. La segunda se
   * agregó al probar contra prod con un usuario de sólo lectura (2026-10-13): la tabla existía, la
   * pantalla creía que podía guardar y cada casilla terminaba en un 500 que parecía una falla.
   */
  private async borradorDisponible(trx: Knex.Transaction): Promise<boolean> {
    const r = await trx.raw(
      `SELECT to_regclass('commercial.autoabasto_pedidos') IS NOT NULL
              AND current_setting('transaction_read_only') = 'off' AS ok`);
    return Boolean(r.rows?.[0]?.ok);
  }

  /** Antes de escribir: sin tablas o en una base de sólo lectura, un mensaje que se entiende en vez de un 500. */
  private async exigeBorrador(trx: Knex.Transaction): Promise<void> {
    if (!(await this.borradorDisponible(trx))) {
      throw new ServiceUnavailableException(
        'Esta base no permite guardar el pedido: le falta su migración o la conexión es de sólo lectura.');
    }
  }

  /** El borrador vivo del almacén, o `null`. Un solo borrador por almacén (índice único parcial). */
  private async borradorDe(trx: Knex.Transaction, tenantId: string, warehouseId: string): Promise<string | null> {
    const r = await trx('commercial.autoabasto_pedidos')
      .where({ tenant_id: tenantId, warehouse_id: warehouseId, estado: 'borrador' })
      .first('id');
    return r ? String(r.id) : null;
  }

  /** El borrador vivo, creándolo si no existe. Dos clics simultáneos no crean dos: ON CONFLICT. */
  private async borradorOCrea(trx: Knex.Transaction, tenantId: string, warehouseId: string): Promise<string> {
    const actual = await this.borradorDe(trx, tenantId, warehouseId);
    if (actual) return actual;
    const ctx = this.tenantCtx.get();
    await trx.raw(
      `INSERT INTO commercial.autoabasto_pedidos (tenant_id, warehouse_id, motor, abierto_por, abierto_por_username)
       VALUES (?, ?, ?::jsonb, ?, ?)
       ON CONFLICT (tenant_id, warehouse_id) WHERE estado = 'borrador' DO NOTHING`,
      [tenantId, warehouseId, JSON.stringify({ base: 'demanda', cobertura_por_almacen: COBERTURA_AUTOABASTO, cobertura_default: COBERTURA_AUTOABASTO_DEFAULT,
        ventana_ya_pedido_dias: VENTANA_YA_PEDIDO_DIAS, ventana_negado_dias: VENTANA_NEGADO_DIAS }),
      ctx?.userId ?? null, ctx?.username ?? null]);
    const creado = await this.borradorDe(trx, tenantId, warehouseId);
    if (!creado) throw new Error('No se pudo abrir el borrador del pedido.');
    return creado;
  }

  private async huella(trx: Knex.Transaction, fila: Record<string, unknown>): Promise<void> {
    const ctx = this.tenantCtx.get();
    await trx('commercial.autoabasto_huella').insert({
      ...fila,
      user_id: ctx?.userId ?? null,
      username: ctx?.username ?? null,
    });
  }

  /**
   * Guarda lo que la persona dejó en un renglón. La foto (sugerido, unidad, factor, contexto) viene
   * de la pantalla: es lo que la persona VIO, que es justo lo que la huella necesita, y evita
   * recalcular el pedido entero en cada clic. Se validan los números y el motivo (±20%).
   */
  async ajustar(warehouseId: string, req: AutoabastoAjusteRequest): Promise<AutoabastoAjusteResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const cantidad = Number(req.cantidad), sugerido = Number(req.sugerido), factor = Number(req.factor);
    if (!Number.isFinite(cantidad) || cantidad < 0 || !Number.isInteger(cantidad)) {
      throw new BadRequestException('La cantidad tiene que ser un entero de 0 en adelante.');
    }
    if (!Number.isFinite(sugerido) || sugerido < 0) throw new BadRequestException('Falta el sugerido que se vio.');
    if (!Number.isFinite(factor) || factor <= 0) throw new BadRequestException('El renglón no trae factor de unidad: no se puede ajustar.');
    if (!['matriz', 'proveedor', 'sin_ruta'].includes(req.origen_tipo)) throw new BadRequestException('Origen inválido.');
    const motivo = req.motivo ?? null;
    if (motivo != null && !(MOTIVOS_AJUSTE as readonly string[]).includes(motivo)) throw new BadRequestException('Motivo fuera de la lista.');
    if (necesitaMotivo(sugerido, cantidad) && !motivo) {
      throw new BadRequestException('El ajuste se aleja más de 20% de lo sugerido: elige un motivo.');
    }
    const ms = req.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0));
    const ctx = this.tenantCtx.get();

    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      const previo = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id }).first('cantidad');
      const antes = previo ? num(previo.cantidad) : sugerido;
      const ahora = new Date();
      await trx.raw(
        `INSERT INTO commercial.autoabasto_pedido_lineas
           (tenant_id, pedido_id, product_id, sku, origen_tipo, origen_clave, sugerido, sugerido_unidad, sugerido_base,
            cantidad, unidad, cantidad_base, motivo, contexto, ajustado_por, ajustado_por_username, ajustado_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?)
         ON CONFLICT (tenant_id, pedido_id, product_id) DO UPDATE SET
           sugerido = EXCLUDED.sugerido, sugerido_unidad = EXCLUDED.sugerido_unidad, sugerido_base = EXCLUDED.sugerido_base,
           cantidad = EXCLUDED.cantidad, unidad = EXCLUDED.unidad, cantidad_base = EXCLUDED.cantidad_base,
           motivo = EXCLUDED.motivo, contexto = EXCLUDED.contexto, ajustado_por = EXCLUDED.ajustado_por,
           ajustado_por_username = EXCLUDED.ajustado_por_username, ajustado_at = EXCLUDED.ajustado_at, updated_at = now()`,
        [tenantId, pedidoId, req.product_id, req.sku ?? null, req.origen_tipo, req.origen_clave ?? null,
          sugerido, req.unidad ?? null, sugerido * factor, cantidad, req.unidad ?? null, cantidad * factor,
          motivo, JSON.stringify(req.contexto ?? {}), ctx?.userId ?? null, ctx?.username ?? null, ahora]);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, product_id: req.product_id,
        evento: 'ajustar', sugerido, antes, despues: cantidad, unidad: req.unidad ?? null, motivo, ms_en_renglon: ms,
        datos: JSON.stringify({ origen_tipo: req.origen_tipo, origen_clave: req.origen_clave ?? null, factor }),
      });
      return {
        pedido_id: pedidoId,
        product_id: req.product_id,
        ajuste: { cantidad, unidad: req.unidad ?? null, motivo, ajustado_por: ctx?.username ?? null, ajustado_at: ahora.toISOString() },
      };
    });
  }

  /** Vuelve el renglón al sugerido: borra el ajuste y deja la huella. */
  async restablecer(warehouseId: string, req: AutoabastoRestablecerRequest): Promise<AutoabastoAjusteResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorDe(trx, tenantId, warehouseId);
      if (!pedidoId) throw new BadRequestException('No hay ajustes que restablecer.');
      const previo = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id })
        .first('cantidad', 'sugerido', 'unidad');
      if (previo) {
        await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id }).delete();
        await this.huella(trx, {
          tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, product_id: req.product_id,
          evento: 'restablecer', sugerido: previo.sugerido, antes: previo.cantidad, despues: previo.sugerido,
          unidad: previo.unidad, ms_en_renglon: req.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0)),
        });
      }
      return { pedido_id: pedidoId, product_id: req.product_id, ajuste: null };
    });
  }

  /** La persona revisó un grupo y lo acepta como está. Sólo huella: no cambia cantidades. */
  async aceptarGrupo(warehouseId: string, req: AutoabastoAceptarGrupoRequest): Promise<{ ok: true }> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!['matriz', 'proveedor', 'sin_ruta'].includes(req.origen_tipo)) throw new BadRequestException('Origen inválido.');
    await this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'aceptar_grupo',
        datos: JSON.stringify({ origen_tipo: req.origen_tipo, origen_clave: req.origen_clave ?? null, renglones: Math.max(0, Number(req.renglones) || 0) }),
      });
    });
    return { ok: true };
  }

  /** La persona abrió su pedido. Huella de cuándo y cuánto tenía enfrente; no crea borrador. */
  async abrir(warehouseId: string, req: AutoabastoAbrirRequest): Promise<{ ok: true }> {
    const tenantId = this.tenantCtx.requireTenantId();
    await this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorDe(trx, tenantId, warehouseId);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'abrir',
        datos: JSON.stringify({ renglones: Math.max(0, Number(req.renglones) || 0) }),
      });
    });
    return { ok: true };
  }
}

interface FilaLinea {
  product_id: string; cantidad: string | number; unidad: string | null; cantidad_base: string | number;
  motivo: string | null; ajustado_por_username: string | null; ajustado_at: string | Date;
}

type Almacen = { id: string; code: string; name: string };

/** `[AB.27]` Un renglón ya armado, con la fila del motor de la que salió y el factor de caja del almacén. */
interface RenglonInterno extends RenglonArmado {
  fila: Record<string, unknown>;
  cf: number;
}

/** `[AB.27]` Lo que `armarAlmacen` deja listo para «Mi pedido» y para la mesa. */
interface AlmacenArmado {
  renglones: RenglonInterno[];
  docs: FilaDoc[];
  planDocs: Map<string, FilaPlan & { renglones: number }>;
  sinUnidad: number;
  medidos: boolean;
  borrador: string | null;
  guardable: boolean;
  posiciones: PosicionPedido[];
}

/** Una fecha del motor como AAAA-MM-DD (el driver puede devolver `Date` o texto). `null` = sin fecha. */
function fechaDe(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : toMxDateKey(v);
  return String(v).slice(0, 10);
}
