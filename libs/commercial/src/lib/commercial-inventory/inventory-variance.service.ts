import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * [IC.0] El descuadre del conteo físico de Kepler, visible.
 *
 * Kepler hace el inventario completo cada trimestre y emite el ajuste. El dato existe desde
 * nov-2025 y **no se ve en ninguna pantalla**: medido en sep-2026, $6.60M de sobrante contra
 * $2.26M de faltante sobre $34.1M contados, con el sobrante entre 6.5% y 31% del valor
 * contado según la sucursal. No falta información: falta dónde mirarla.
 *
 * Lee de `analytics.v_erp_physical_count_variance` (derivada del ODS, cero importers).
 *
 * ── Dos cosas que este servicio NO puede dejar de declarar ──────────────────────────────
 *
 * 1. **Una carga inicial no es un descuadre.** Cuando una sucursal migra de Wincaja a Kepler
 *    emite, el día antes del corte, una captura y una entrada que cuadran línea por línea con
 *    faltante cero. Son **$30.8M** en el histórico. Se excluyen del descuadre por default y
 *    se informan aparte — mezclarlos convierte cualquier promedio en ruido.
 *
 * 2. **La cobertura.** El trimestral deja fuera SKUs con existencia (4,022 en sep-2026, entre
 *    7% y 31% por sucursal). Un tablero que muestre sólo lo contado se lee como si eso fuera
 *    todo el almacén. Ver `coverage()`.
 */
@Injectable()
export class InventoryVarianceService {
  private readonly logger = new Logger(InventoryVarianceService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * Resumen por evento de conteo: una fila por (almacén, fecha), con su descuadre.
   * `include_initial_load` existe para poder VER las cargas iniciales, no para mezclarlas:
   * vienen con `tipo_evento` y el consumidor las pinta distinto.
   */
  async summary(params: {
    warehouse_id?: string;
    date_from?: string;
    date_to?: string;
    include_initial_load?: boolean;
  }) {
    return this.tk.run(async (knex) => {
      const q = knex('analytics.v_erp_physical_count_variance as v')
        .select(
          'v.warehouse_id',
          'v.warehouse_code',
          'v.warehouse_name',
          'v.fecha',
          'v.tipo_evento',
          knex.raw("count(*) filter (where v.signo = 'sobrante')::int as skus_sobrante"),
          knex.raw("count(*) filter (where v.signo = 'faltante')::int as skus_faltante"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.signo = 'sobrante'), 2), 0) as pesos_sobrante"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.signo = 'faltante'), 2), 0) as pesos_faltante"),
          knex.raw("coalesce(round(sum(case when v.signo = 'sobrante' then v.importe else -v.importe end), 2), 0) as pesos_neto"),
        )
        .groupBy('v.warehouse_id', 'v.warehouse_code', 'v.warehouse_name', 'v.fecha', 'v.tipo_evento')
        .orderBy([{ column: 'v.fecha', order: 'desc' }, { column: 'v.warehouse_code' }]);

      if (!params.include_initial_load) q.where('v.tipo_evento', 'conteo');
      if (params.warehouse_id) q.where('v.warehouse_id', params.warehouse_id);
      if (params.date_from) q.where('v.fecha', '>=', params.date_from);
      if (params.date_to) q.where('v.fecha', '<=', params.date_to);

      const rows = await q;
      return rows.map((r: Record<string, unknown>) => ({
        ...r,
        // El % se calcula sobre lo que se contó, no sobre el total del almacén: es la
        // pregunta que el supervisor hace ("de lo que conté, cuánto bailó").
        pesos_sobrante: Number(r['pesos_sobrante']),
        pesos_faltante: Number(r['pesos_faltante']),
        pesos_neto: Number(r['pesos_neto']),
      }));
    });
  }

  /** Detalle SKU por SKU de un evento (almacén + fecha). Es la lista accionable. */
  async detail(params: {
    warehouse_id: string;
    fecha: string;
    signo?: 'sobrante' | 'faltante';
    limit?: number;
  }) {
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 2000);
    return this.tk.run(async (knex) => {
      const q = knex('analytics.v_erp_physical_count_variance as v')
        .select(
          'v.sku', 'v.product_id', 'v.descripcion', 'v.unidad_erp', 'v.signo',
          'v.cantidad', 'v.costo_unitario', 'v.importe', 'v.folio',
          'v.kepler_sucursal', 'v.kepler_almacen', 'v.tipo_evento',
        )
        .where('v.warehouse_id', params.warehouse_id)
        .andWhere('v.fecha', params.fecha)
        .orderBy('v.importe', 'desc')
        .limit(limit);
      if (params.signo) q.andWhere('v.signo', params.signo);
      return q;
    });
  }

  /**
   * ⛔ LA COBERTURA — lo que el conteo NO tocó.
   *
   * Sin esto el tablero miente por omisión: muestra el descuadre de lo contado y el lector
   * asume que eso es el almacén. Medido en sep-2026: entre 192 y 923 SKUs **con existencia**
   * quedaron fuera por sucursal.
   *
   * ⚠️ Se compara contra la existencia de HOY (`v_erp_stock_on_hand`), no contra la del día
   * del conteo — el ODS no guarda historia de saldos. Para un conteo reciente es una buena
   * aproximación; para uno viejo es orientativo, y por eso se devuelve `dias_desde_conteo`
   * en vez de dejar que el número se lea con la misma confianza en los dos casos.
   */
  async coverage(params: { warehouse_id: string; fecha: string }) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH contado AS (
           SELECT DISTINCT v.sku
             FROM analytics.v_erp_physical_count_variance v
            WHERE v.warehouse_id = ? AND v.fecha = ?
         ),
         -- La captura incluye SKUs que NO descuadraron y por eso no están en la vista de
         -- varianza. Para la cobertura hace falta el universo CONTADO, no el DESCUADRADO.
         capturado AS (
           SELECT DISTINCT btrim(l.c8) AS sku
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
              AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
             JOIN commercial.warehouses w
               ON w.kepler_code = m.sucursal AND w.id = ? AND w.deleted_at IS NULL
            WHERE m.c2 = 'N' AND m.c3 = 'A' AND m.c4 = '45' AND m.c9::date = ?
         )
         SELECT count(*) FILTER (WHERE s.sku IN (SELECT sku FROM capturado))::int AS contados,
                count(*) FILTER (WHERE s.sku NOT IN (SELECT sku FROM capturado))::int AS sin_contar,
                count(*)::int AS con_existencia,
                (SELECT count(*) FROM contado)::int AS con_diferencia,
                (current_date - ?::date) AS dias_desde_conteo
           FROM analytics.v_erp_stock_on_hand s
          WHERE s.warehouse_id = ? AND s.qty_stock_units > 0`,
        [params.warehouse_id, params.fecha, params.warehouse_id, params.fecha,
          params.fecha, params.warehouse_id],
      );
      const r = rows[0] || {};
      const conExistencia = Number(r.con_existencia || 0);
      return {
        ...r,
        pct_cubierto: conExistencia > 0
          ? Number((100 * Number(r.contados || 0) / conExistencia).toFixed(1))
          : null,   // NULL, no 0: "no se pudo medir" no es "cobertura cero"
      };
    });
  }

  /** Almacenes y fechas con conteo, para poblar los filtros sin adivinar. */
  async events() {
    return this.tk.run(async (knex) =>
      knex('analytics.v_erp_physical_count_variance as v')
        .distinct('v.warehouse_id', 'v.warehouse_code', 'v.warehouse_name', 'v.fecha', 'v.tipo_evento')
        .orderBy([{ column: 'v.fecha', order: 'desc' }, { column: 'v.warehouse_code' }])
        .limit(200),
    );
  }
}
