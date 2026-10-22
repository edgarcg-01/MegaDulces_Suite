import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { TenantCacheService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { NegociacionProveedor, PedidoNegociacionDto } from '@megadulces/contracts';
import { DIAS_RECIENTE, type EntradaFila, type EscaleraFicha, factorBase, type FichaCostoFila, resumirCosto, resumirPagado } from './pedido-negociacion';

const NUM = (col: string) => `nullif(regexp_replace(${col}::text, '[^0-9.-]', '', 'g'), '')::numeric`;
const n = (v: unknown): number => Number(v) || 0;

/**
 * `[RA-NEG.1]` Costo y negociación de UN producto para el desglose de `/compras/pedido`.
 * Contrato, fuentes y reglas: `libs/contracts/src/http/pedido-negociacion.contract.ts`.
 *
 * ── Por qué consultas propias y no los servicios que ya publican esto ────────────────────────
 * Medido contra prod el 2026-10-22 (70056): `StandardCostService.historial` 3.4 s,
 * `supplierOrderHistory` 6.5 s, `landedCost` 2.0 s, `SupplierCreditTerms.list` 1.7 s. Calculan
 * para TODOS los proveedores o traen el historial completo, y después filtran. Acá se pregunta por
 * un producto y un proveedor.
 *
 * ── Lo que todavía es lento, y por qué ───────────────────────────────────────────────────────
 * Los renglones de compra de `kepler_ods.kdm2` no tienen índice por producto (sí lo tiene la
 * venta: `ix_kdm2_sku_venta`). Sin él, leer los de un SKU barre los ~514 mil renglones `X/A`:
 * 300–460 ms medidos. La migración `ix_kdm2_compra_sku` lo crea, y va en ventana nocturna. Mientras
 * tanto lo pesado queda en caché una hora: lo pagado no cambia minuto a minuto.
 *
 * ⛔ El encabezado se busca por `(sucursal, c4, c6)` con LATERAL: unido en la misma consulta, el
 * planificador barría todos los `X-A-20` (514 ms); así usa `idx_kdm1_xa_doc` (21 ms).
 */
@Injectable()
export class PedidoNegociacionService {
  private readonly logger = new Logger(PedidoNegociacionService.name);
  /** Lo que se recibió y se pagó no cambia minuto a minuto; el costo y el precio sí, y no se guardan. */
  static readonly CACHE_MS = 60 * 60_000;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() private readonly cache?: TenantCacheService,
  ) {}

  private conCache<T>(clave: string, fn: () => Promise<T>): Promise<T> {
    return this.cache ? this.cache.getOrSet(clave, PedidoNegociacionService.CACHE_MS, fn) : fn();
  }

  /**
   * @param verDescuentos `[RA-NEG.3]` si quien consulta puede ver Descuentos (`COMPRAS_DESCUENTOS_VER`). Sin él, la
   *   lista de pagos sin descuento no viaja y se declara `null`; los totales sí (ya los publica el panel).
   */
  async negociacion(productId: string, verDescuentos = false): Promise<PedidoNegociacionDto> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new NotFoundException('Producto no encontrado');
    const prod = await this.tk.run(async (trx) => (await trx.raw(
      `SELECT p.id, p.sku, s.id AS sup_id, s.code AS sup_code, s.name AS sup_name, s.credit_days, s.credit_term_base, s.lead_time_days
         FROM catalog.products p
         LEFT JOIN catalog.suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
        WHERE p.tenant_id = ? AND p.id = ? AND p.deleted_at IS NULL`,
      [tenantId, productId],
    )).rows[0] as { id: string; sku: string; sup_id: string | null; sup_code: string | null; sup_name: string | null;
      credit_days: number | null; credit_term_base: string | null; lead_time_days: number | null } | undefined);
    if (!prod) throw new NotFoundException('Producto no encontrado');
    const sku = String(prod.sku).trim();

    // Producto y proveedor en paralelo: son transacciones (conexiones) distintas.
    const supId = prod.sup_id, supCode = prod.sup_code;
    const [producto, proveedor] = await Promise.all([
      this.producto(sku, supCode),
      supId && supCode
        ? this.conCache(`pedido:neg:prov:v2:${supId}:${verDescuentos ? 1 : 0}`, () => this.proveedor(tenantId, verDescuentos, {
            sup_id: supId, sup_code: supCode, sup_name: prod.sup_name ?? supCode, credit_days: prod.credit_days,
            credit_term_base: prod.credit_term_base, lead_time_days: prod.lead_time_days,
          }))
        : Promise.resolve(null),
    ]);
    return { product_id: prod.id, sku, ...producto, proveedor, generado_at: new Date().toISOString() };
  }

  /** Costo (siempre fresco) + lo pagado (en caché). */
  private async producto(sku: string, supCode: string | null) {
    const fichas = await this.tk.run(async (trx) => (await trx.raw(
      `SELECT sucursal, costo_estandar, costo_estandar_u3, costo_reposicion_base, precio_ficha, impuesto_pct, margen_ficha_pct, precio_si_conserva_margen,
              impacto_cogs_30d, venta_neta_30d, veredicto, unidad_base, unidad_dos, unidad_tres, factor_dos, factor_tres
         FROM analytics.v_kepler_standard_cost WHERE sku = ?`,
      [sku],
    )).rows as (FichaCostoFila & { unidad_base: string | null; unidad_dos: string | null; unidad_tres: string | null; factor_dos: string | null; factor_tres: string | null })[]);
    const costo = resumirCosto(fichas);
    const f0 = fichas.find((f) => f.unidad_base) ?? null;
    const esc: EscaleraFicha = { u1: f0?.unidad_base ?? null, u2: f0?.unidad_dos ?? null, u3: f0?.unidad_tres ?? null,
      f2: f0?.factor_dos != null ? Number(f0.factor_dos) : null, f3: f0?.factor_tres != null ? Number(f0.factor_tres) : null };
    const basePorCaja = esc.f3 && esc.f3 > 1 ? esc.f3 : esc.f2 && esc.f2 > 1 ? esc.f2 : null;

    const hasta = new Date().toISOString().slice(0, 10);
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 365);
    const desde = d.toISOString().slice(0, 10);
    // Lo pagado, en caché: la clave lleva el día y el estándar, que es contra lo que se compara.
    const pagado = await this.conCache(`pedido:neg:pagado:v3:${sku}:${supCode ?? '-'}:${hasta}:${costo.estandar_base ?? '-'}`, async () => {
      const filas = supCode ? await this.entradas(sku, supCode, desde) : [];
      await this.resolverPlazas(filas, esc, hasta);
      return resumirPagado(filas, esc, costo.estandar_base, desde, hasta);
    });
    return { unidad_base: esc.u1, base_por_caja: basePorCaja, costo, pagado };
  }

  /**
   * Lo capturado en oficinas (`00`) se recibió en alguna plaza. Se lee de `erp_goods_receipts`
   * filtrando por folio (82–133 ms medidos); la vista `v_erp_goods_receipt_origin` da lo mismo pero
   * se calcula entera: 1.3–1.7 s aunque se le pidan tres folios. Sólo se pregunta por los que la
   * pantalla NOMBRA — los recientes (último, al estándar) y el más barato —: los demás sólo suman
   * a su mes y no necesitan plaza. Lo que no resuelva queda `00` y la pantalla lo dice así.
   */
  private async resolverPlazas(filas: EntradaFila[], esc: EscaleraFicha, hasta: string): Promise<void> {
    const corte = new Date(hasta + 'T12:00:00Z');
    corte.setUTCDate(corte.getUTCDate() - DIAS_RECIENTE);
    const desdeReciente = corte.toISOString().slice(0, 10);
    const cb = (x: EntradaFila) => { const k = factorBase(x.unidad, esc); return k ? x.costo / k : null; };
    const vals = filas.map(cb).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
    const med = vals.length ? vals[vals.length >> 1] : 0;
    let barato: EntradaFila | null = null;
    for (const x of filas) {
      const v = cb(x);
      if (v != null && v >= med * 0.2 && (!barato || v < (cb(barato) ?? Infinity))) barato = x;
    }
    const pedir = [...new Set(filas.filter((x) => x.plaza === '00' && x.folio && (x.fecha >= desdeReciente || x === barato))
      .map((x) => x.folio as string))];
    if (!pedir.length) return;
    const og = await this.tk.run(async (trx) => (await trx.raw(
      `SELECT folio, origen_warehouse_code AS plaza FROM analytics.erp_goods_receipts
        WHERE tenant_id = ? AND sucursal = '00' AND folio = ANY(?::text[])`,
      [this.tenantCtx.requireTenantId(), pedir],
    )).rows as { folio: string; plaza: string | null }[]);
    const plaza = new Map<string, string>();
    for (const o of og) if (o.plaza && !plaza.has(o.folio)) plaza.set(o.folio, o.plaza);
    for (const x of filas) if (x.plaza === '00' && x.folio && plaza.has(x.folio)) x.plaza = plaza.get(x.folio) as string;
  }

  /**
   * Renglones `X-A-20` de este producto a este proveedor. La plaza de lo capturado en oficinas queda
   * `'00'` hasta `resolverPlazas`.
   * Excluye lo cancelado, las réplicas de otra plaza (`c1 ≠ sucursal`) y las capturas en oficinas
   * que duplican la de la sucursal (`erp_goods_receipt_dedup`, la misma regla que
   * `analytics.erp_goods_receipts`): medido para La Rosa, 74 de 692 recepciones ($6.9 M).
   */
  private async entradas(sku: string, supCode: string, desde: string): Promise<EntradaFila[]> {
    return this.tk.run(async (trx) => {
      const renglones = (await trx.raw(
        `SELECT l.sucursal, btrim(l.c6::text) AS folio, NULLIF(upper(btrim(l.c11::text)), '') AS unidad,
                ${NUM('l.c9')} AS cantidad, ${NUM('l.c12')} AS costo
           FROM kepler_ods.kdm2 l
          WHERE btrim(l.c8) = ? AND l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20'
            -- El renglón es del almacén de la propia sucursal, como su encabezado: sin esto, un
            -- renglón de otro almacén (01-006…) con el mismo folio se casaba con un encabezado que no
            -- es el suyo. Lo cazó el testigo de test-newdb-pedido-negociacion.js (339 contra 338).
            AND btrim(l.c1::text) = l.sucursal::text`,
        [sku],
      )).rows as { sucursal: string; folio: string; unidad: string | null; cantidad: string; costo: string }[];
      if (!renglones.length) return [];
      const enc = (await trx.raw(
        `SELECT x.s AS sucursal, x.f AS folio, h.fecha, h.prov
           FROM unnest(?::text[], ?::text[]) AS x(s, f)
           CROSS JOIN LATERAL (
             SELECT ap.c68::date::text AS fecha, btrim(ap.c10::text) AS prov
               FROM kepler_ods.kdm1 ap
              WHERE ap.sucursal = x.s AND ap.c2 = 'X' AND ap.c3 = 'A' AND btrim(ap.c4::text) = '20' AND btrim(ap.c6) = x.f
                AND btrim(ap.c1::text) = ap.sucursal::text AND btrim(coalesce(ap.c43::text, '')) <> 'C'
                AND ap.c68::date >= ?::date
              LIMIT 1) h
          WHERE NOT EXISTS (SELECT 1 FROM analytics.erp_goods_receipt_dedup dd
                             WHERE x.s = '00' AND dd.cedis_folio = x.f AND dd.status IN ('auto', 'confirmado'))`,
        [renglones.map((r) => r.sucursal), renglones.map((r) => r.folio), desde],
      )).rows as { sucursal: string; folio: string; fecha: string; prov: string | null }[];
      const deEste = new Map(enc.filter((e) => e.prov === supCode).map((e) => [`${e.sucursal}|${e.folio}`, e]));
      return renglones.flatMap((r) => {
        const e = deEste.get(`${r.sucursal}|${r.folio}`);
        if (!e) return [];
        return [{ fecha: e.fecha, plaza: r.sucursal, folio: r.folio, unidad: r.unidad, cantidad: n(r.cantidad), costo: n(r.costo) }];
      });
    });
  }

  /** El proveedor en 12 meses: lo que le compramos, lo que nos descontó y lo que dejamos en la mesa. */
  private async proveedor(tenantId: string, verDescuentos: boolean, p: { sup_id: string; sup_code: string; sup_name: string; credit_days: number | null;
    credit_term_base: string | null; lead_time_days: number | null }): Promise<NegociacionProveedor> {
    return this.tk.run(async (trx) => {
      // En secuencia: comparten la conexión de la transacción.
      const rec = await trx.raw(`SELECT dias_credito, count(*)::int AS n, COALESCE(sum(monto), 0)::numeric AS monto
                   FROM analytics.erp_goods_receipts
                  WHERE tenant_id = ? AND proveedor_code = ? AND receipt_date >= current_date - 365 AND dup_of_sucursal IS NULL
                  GROUP BY 1 ORDER BY 2 DESC`, [tenantId, p.sup_code]);
      const pago = await trx.raw(`SELECT COALESCE(sum(descuento), 0)::numeric AS desc_pago, count(*)::int AS pagos,
                        count(*) FILTER (WHERE descuento = 0)::int AS sin,
                        COALESCE(sum(monto) FILTER (WHERE descuento = 0), 0)::numeric AS monto_sin,
                        max(pago_date) FILTER (WHERE descuento = 0)::text AS ult_sin
                   FROM analytics.erp_supplier_payments
                  WHERE tenant_id = ? AND proveedor_code = ? AND pago_date >= current_date - 365`, [tenantId, p.sup_code]);
      const nota = await trx.raw(`SELECT COALESCE(sum(monto), 0)::numeric AS desc_nota FROM analytics.erp_purchase_adjustments
                  WHERE tenant_id = ? AND proveedor_code = ? AND adjustment_date >= current_date - 365
                    AND categoria IN ('pronto_pago', 'descuento_comercial', 'apoyo_marca')`, [tenantId, p.sup_code]);
      const pol = await trx.raw(`SELECT expected_discount_rate::numeric AS tasa, source FROM commercial.supplier_discount_policy
                  WHERE tenant_id = ? AND proveedor_code = ? AND active AND expected_discount_rate > 0 LIMIT 1`, [tenantId, p.sup_code]);
      const recl = await trx.raw(`SELECT count(*) FILTER (WHERE supplier_id = ?)::int AS del_proveedor, count(*)::int AS en_la_base
                   FROM commercial.receiving_claims WHERE tenant_id = ?`, [p.sup_id, tenantId]);
      const recs = rec.rows as { dias_credito: number | null; n: number; monto: string }[];
      const compras = recs.reduce((s, r) => s + n(r.monto), 0);
      const pg = pago.rows[0] as { desc_pago: string; pagos: number; sin: number; monto_sin: string; ult_sin: string | null };
      const descNota = n((nota.rows[0] as { desc_nota: string }).desc_nota);
      const pl = pol.rows[0] as { tasa: string; source: string | null } | undefined;
      const sinDesc = pl && verDescuentos ? (await trx.raw(
        `SELECT pago_date::text AS fecha, folio, sucursal, monto::numeric AS monto FROM analytics.erp_supplier_payments
          WHERE tenant_id = ? AND proveedor_code = ? AND pago_date >= current_date - 365 AND descuento = 0
          ORDER BY pago_date DESC, folio DESC LIMIT 15`, [tenantId, p.sup_code])).rows as { fecha: string; folio: string; sucursal: string; monto: string }[] : null;
      const rc = recl.rows[0] as { del_proveedor: number; en_la_base: number };
      return {
        supplier_id: p.sup_id, nombre: p.sup_name,
        compras_12m: Math.round(compras * 100) / 100,
        recepciones_12m: recs.reduce((s, r) => s + r.n, 0),
        descuento_pago_12m: n(pg.desc_pago), descuento_notas_12m: descNota,
        descuento_pct: compras > 0 ? Math.round(((n(pg.desc_pago) + descNota) / compras) * 10000) / 100 : null,
        pronto_pago: pl ? {
          tasa: n(pl.tasa), fuente: pl.source, pagos: pg.pagos, sin_descuento: pg.sin, monto_sin_descuento: n(pg.monto_sin),
          estimado_perdido: Math.round(n(pl.tasa) * n(pg.monto_sin) * 100) / 100, ultimo_sin_descuento: pg.ult_sin,
          ultimos_sin_descuento: sinDesc ? sinDesc.map((x) => ({ fecha: x.fecha, folio: String(x.folio).trim(), sucursal: String(x.sucursal).trim(), monto: n(x.monto) })) : null,
        } : null,
        plazo_dias: p.credit_days, plazo_base: p.credit_term_base,
        plazo_kepler: recs.map((r) => ({ dias: r.dias_credito, recepciones: r.n })),
        tiempo_entrega_dias: p.lead_time_days,
        reclamos: { del_proveedor: rc.del_proveedor, en_la_base: rc.en_la_base },
      };
    });
  }
}
