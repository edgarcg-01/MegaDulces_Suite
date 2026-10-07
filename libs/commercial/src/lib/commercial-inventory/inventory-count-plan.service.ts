import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * [IC.5] Qué toca contar este mes — el plan del ritmo PARCIAL, más el TOP.
 *
 * Decisión D3 de Edgar: el parcial es **rotativo**. Cada mes toca un tercio del catálogo del
 * almacén, de modo que al llegar el conteo trimestral de Kepler ya se cubrió todo y el
 * descuadre es chico. Y encima de eso, el **top** (D2) se cuenta todos los meses.
 *
 * ── Por qué la ola sale de un hash y no del score ───────────────────────────────────────
 *
 * La ola tiene que ser **estable**: si se derivara del score, un SKU que baja de percentil
 * cambiaría de ola y podría **saltarse el trimestre entero** sin que nadie lo note — que es
 * exactamente el agujero que el rotativo existe para cerrar. `hashtext(sku) % 3` es
 * determinista, reparte parejo y no se mueve cuando cambian las ventas.
 *
 * El score NO decide la ola: decide el **top**, que se cuenta además de la ola que toque.
 * Resultado: lo caro o riesgoso se cuenta 3 veces por trimestre y el resto 1 vez.
 *
 * ⚠️ La ola se calcula sobre el **SKU**, no sobre el `product_id`: el SKU es el identificador
 * que sobrevive a un re-alta de producto. Con `product_id` (un UUID), un producto recreado
 * saltaría de ola y perdería su turno.
 */
@Injectable()
export class InventoryCountPlanService {
  private readonly logger = new Logger(InventoryCountPlanService.name);

  /** Tercio del trimestre: 1, 2 o 3. Derivado del mes para no depender de un calendario. */
  static olaDelMes(fecha = new Date()): number {
    return (fecha.getMonth() % 3) + 1;
  }

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * El plan del mes para un almacén: la ola rotativa + el top.
   *
   * `top_n` sale del score de IC.4. Los SKUs marcados `sin_datos` se **excluyen del top**
   * pero NO de la ola: no hay con qué priorizarlos, pero sí hay que contarlos alguna vez —
   * y en el CEDIS son casi todos.
   */
  async monthlyPlan(params: {
    warehouse_id: string;
    ola?: number;
    top_n?: number;
    limit?: number;
  }) {
    if (!params.warehouse_id) throw new BadRequestException('warehouse_id requerido');
    const ola = params.ola != null
      ? Number(params.ola)
      : InventoryCountPlanService.olaDelMes();
    if (![1, 2, 3].includes(ola)) throw new BadRequestException('ola debe ser 1, 2 o 3');
    const topN = Math.min(Math.max(Number(params.top_n) || 100, 0), 2000);
    const limit = Math.min(Math.max(Number(params.limit) || 800, 1), 5000);

    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH marcado AS (
           SELECT s.product_id, p.sku, s.score, s.senales_usadas, s.score_salvedad,
                  s.abc_class,
                  -- ⚠️ abs(): hashtext puede ser negativo y el módulo de un negativo en
                  -- Postgres también lo es — sin esto, la ola 0 y las negativas nunca
                  -- existirían y un tercio del catálogo no se contaría NUNCA.
                  (abs(hashtext(p.sku)) % 3) + 1 AS ola,
                  row_number() OVER (ORDER BY s.score DESC NULLS LAST) AS rk
             FROM analytics.v_count_priority_score s
             JOIN catalog.products p
               ON p.id = s.product_id AND p.deleted_at IS NULL
            WHERE s.warehouse_id = ?
         )
         SELECT product_id, sku, abc_class,
                round(score, 4) AS score, senales_usadas, score_salvedad, ola,
                (rk <= ? AND score_salvedad IS DISTINCT FROM 'sin_datos') AS es_top,
                CASE WHEN rk <= ? AND score_salvedad IS DISTINCT FROM 'sin_datos'
                     THEN 'top' ELSE 'ola' END AS motivo
           FROM marcado
          WHERE ola = ?
             OR (rk <= ? AND score_salvedad IS DISTINCT FROM 'sin_datos')
          ORDER BY es_top DESC, score DESC NULLS LAST
          LIMIT ?`,
        [params.warehouse_id, topN, topN, ola, topN, limit],
      );

      const top = rows.filter((r: { es_top: boolean }) => r.es_top).length;
      return {
        ola,
        ola_origen: params.ola != null ? 'explicita' : 'del_mes',
        total: rows.length,
        del_top: top,
        de_la_ola: rows.length - top,
        // Si el LIMIT recortó, hay que decirlo: un plan truncado en silencio deja SKUs sin
        // contar y el trimestre no queda cubierto, que es justo lo que el rotativo evita.
        truncado: rows.length >= limit,
        items: rows,
      };
    });
  }

  /**
   * Cobertura del trimestre: ¿las 3 olas cubren TODO el catálogo del almacén?
   *
   * Es la pregunta que hace válido al rotativo. Si una ola quedara vacía o el hash repartiera
   * mal, un tercio del catálogo no se contaría nunca — y nadie lo notaría, porque cada mes
   * el plan se vería normal.
   */
  async waveCoverage(warehouseId: string) {
    if (!warehouseId) throw new BadRequestException('warehouse_id requerido');
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `SELECT (abs(hashtext(p.sku)) % 3) + 1 AS ola, count(*)::int AS skus
           FROM analytics.v_count_priority_score s
           JOIN catalog.products p ON p.id = s.product_id AND p.deleted_at IS NULL
          WHERE s.warehouse_id = ?
          GROUP BY 1 ORDER BY 1`, [warehouseId]);
      const total = rows.reduce((a: number, r: { skus: number }) => a + Number(r.skus), 0);
      const olas = rows.map((r: { ola: number; skus: number }) => ({
        ola: Number(r.ola),
        skus: Number(r.skus),
        pct: total > 0 ? Number((100 * Number(r.skus) / total).toFixed(1)) : null,
      }));
      return {
        total,
        olas,
        cubre_todo: olas.length === 3 && total > 0,
        // Reparto parejo esperado ~33.3% cada una. Se expone el desvío en vez de afirmar
        // que está balanceado.
        desvio_max_pct: olas.length
          ? Number(Math.max(...olas.map((o) => Math.abs((o.pct ?? 0) - 100 / 3))).toFixed(1))
          : null,
      };
    });
  }
}
