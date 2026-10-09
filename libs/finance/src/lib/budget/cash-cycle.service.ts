import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService, evalInput, composeFreshness } from '@megadulces/platform-core';
import type { Coverage } from '@megadulces/contracts';

const round1 = (n: number) => Math.round(Number(n) * 10) / 10;
const round2 = (n: number) => Math.round(Number(n) * 100) / 100;
const VENTANA_DIAS = 90;

/**
 * `[TES.13]` **El ciclo de conversión de efectivo — las tres métricas que todo CFO pide primero
 * y que esta plataforma no publicaba.**
 *
 * Los tres insumos ya existían y nadie los había dividido:
 *
 *     DSO = cartera / venta diaria      ¿cuánto tardamos en cobrar?
 *     DPO = deuda proveedor / compra    ¿cuánto tardamos en pagar?
 *     DIO = inventario / COGS diario    ¿cuánto tarda en salir la mercancía?
 *
 * Medido contra prod el 2026-10-09 (90 días): venta $161,245,354.02 · COGS $142,967,835.62
 * (margen implícito **11.3 %**, que coincide con el ~11.5 % que el negocio reporta) · compra
 * $172,314,861.75 → **DSO 34.7** y **DPO 77.3**.
 *
 * ⛔ **El DPO se publica DOS veces, y no es redundancia.** Los $148.1M de deuda incluyen
 * **$52.4M de facturas de sucursal anteriores al corte del 1-oct**, cuya apertura puede ser un
 * artefacto de captura (`kdxf` no casa pagos previos al corte). Con ellos el DPO da 77.3 días;
 * sin ellos, **50.0**. No se sabe cuál es el bueno, así que **van los dos con su etiqueta** en
 * vez de elegir uno y que el lector no se entere de que hubo elección.
 *
 * ⚠️ **El DIO NO se calcula acá, a propósito.** Necesita el valor del inventario, y esa
 * valuación está **en disputa declarada por la Fase MR**: 564 SKUs valúan $11.4M con un costo
 * que el punto de venta contradice. Publicar un DIO sobre un denominador que otro carril marcó
 * como no confiable sería fabricar precisión. Se declara con dueño.
 */
@Injectable()
export class CashCycleService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async cycle() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [m] = await trx.raw(
        `WITH venta AS (
           SELECT sum(revenue) v, sum(cost) c, count(*) n, count(cost) nc, max(sale_date) at
             FROM analytics.sales_daily
            WHERE tenant_id = ? AND sale_date >= current_date - ?::int
         ), compra AS (
           SELECT sum(monto) m, max(receipt_date) at FROM analytics.erp_goods_receipts
            WHERE tenant_id = ? AND receipt_date >= current_date - ?::int
         ), cxc AS (
           SELECT sum(saldo_ajustado) s, max(computed_at) at FROM analytics.customer_receivables
            WHERE tenant_id = ? AND saldo_ajustado > 0
         ), cxp AS (
           SELECT sum(pendiente) s,
                  sum(pendiente) FILTER (WHERE vencido AND anterior_al_corte AND sucursal <> '00') AS en_disputa
             FROM analytics.v_supplier_payables
            WHERE tenant_id = ? AND NOT upper(btrim(proveedor)) LIKE 'TI%'
         )
         SELECT venta.v, venta.c, venta.n, venta.nc, venta.at AS venta_at,
                compra.m, compra.at AS compra_at,
                cxc.s AS cartera, cxc.at AS cxc_at,
                cxp.s AS deuda, cxp.en_disputa
           FROM venta, compra, cxc, cxp`,
        [tenantId, VENTANA_DIAS, tenantId, VENTANA_DIAS, tenantId, tenantId],
      ).then((r: { rows?: unknown[] }) => (r.rows ?? r) as Record<string, unknown>[]);

      const num = (x: unknown) => (x == null ? null : Number(x));
      const ventaDia = num(m.v) ? (num(m.v) as number) / VENTANA_DIAS : null;
      const compraDia = num(m.m) ? (num(m.m) as number) / VENTANA_DIAS : null;
      const cartera = num(m.cartera);
      const deuda = num(m.deuda);
      const disputa = num(m.en_disputa) ?? 0;

      // `null`, nunca 0: sin denominador no se puede medir, y un 0 se leería como «cobramos al
      // contado» — que es lo contrario de «no sé».
      const dias = (n: number | null, den: number | null) =>
        (n != null && den != null && den > 0 ? round1(n / den) : null);

      const filas = Number(m.n) || 0;
      const conCosto = Number(m.nc) || 0;
      const cobCosto = filas > 0 ? round1((conCosto / filas) * 100) : null;

      return {
        ventana_dias: VENTANA_DIAS,
        insumos: {
          venta: round2(num(m.v) ?? 0), cogs: round2(num(m.c) ?? 0), compra: round2(num(m.m) ?? 0),
          cartera: round2(cartera ?? 0), deuda: round2(deuda ?? 0),
          margen_implicito_pct: num(m.v) ? round1((1 - (num(m.c) as number) / (num(m.v) as number)) * 100) : null,
        },
        dso_dias: dias(cartera, ventaDia),
        // ⛔ Los dos, con su etiqueta. Elegir uno escondería que hubo elección.
        dpo_dias: dias(deuda, compraDia),
        dpo_dias_sin_disputa: dias(deuda != null ? deuda - disputa : null, compraDia),
        dpo_masa_en_disputa: round2(disputa),
        dpo_nota: disputa > 0
          ? 'La deuda incluye facturas de sucursal anteriores al corte del 1-oct cuya apertura puede ser artefacto de captura (kdxf no casa pagos previos). Por eso el DPO va con y sin esa masa.'
          : 'Sin masa en disputa en esta medición.',
        // El tercer lado del ciclo, declarado y con dueño — no calculado sobre un denominador
        // que otro carril marcó como no confiable.
        dio_dias: null,
        dio_motivo: 'Requiere el valor del inventario, cuya valuación está en disputa declarada por la Fase MR (564 SKUs con costo que el punto de venta contradice). Publicarlo sería fabricar precisión.',
        ciclo_dias: null,
        ciclo_motivo: 'DSO − DPO + DIO. Sin DIO el ciclo queda incompleto: se publican sus dos lados medidos, no una resta a la que le falta un término.',
        freshness: composeFreshness([
          evalInput('venta', 'Venta (analytics.sales_daily)', (m.venta_at as string) ?? null, 48),
          evalInput('compra', 'Compra (erp_goods_receipts)', (m.compra_at as string) ?? null, 48),
          evalInput('cartera', 'Cartera (CxC)', (m.cxc_at as string) ?? null, 48),
        ]),
        coverage: {
          measured: cobCosto != null,
          pct: cobCosto,
          note: cobCosto == null
            ? 'Sin renglones de venta en la ventana: la cobertura del costo queda SIN MEDIR, no en cero.'
            : `El COGS cubre ${cobCosto}% de los renglones de venta. ⚠️ Y su calidad tiene salvedad propia (ADR-051): la mitad Kepler se deriva por álgebra ciega al precio, no es costo observado.`,
        } as Coverage,
      };
    });
  }
}
