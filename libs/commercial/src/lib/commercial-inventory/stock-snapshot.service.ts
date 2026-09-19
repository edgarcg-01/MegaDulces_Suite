import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';

/** Lo que devuelve una corrida, por almacén. */
export interface SnapshotResult {
  warehouses: number;
  pares: number;
  pares_en_cero: number;
  pares_sin_costo: number;
  fecha_corte: string;
}

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * AB.0b — **La foto de inventario.** El reloj de la Fase AB.
 *
 * ── Por qué corre aunque no haya pantalla que la lea ─────────────────────────
 * La venta de un día que ya pasó se puede reconstruir del ERP. **La existencia no**:
 * `commercial.stock` es estado actual y se pisa a sí mismo. Medido antes de escribir
 * esto, no había ninguna serie histórica (`stock_ledger` y `floor_stockouts`: 1 fila
 * cada una). Cada día que este cron no corre es un día que no se recupera, así que se
 * entrega **antes** que las pantallas que lo van a consumir.
 *
 * Lo que desbloquea: el §5 del pedido exige descartar, antes de bajar un parámetro, que
 * la venta haya caído *porque no había producto*. Eso se cuenta con días-con-existencia,
 * y sin esta serie es incomputable.
 *
 * ── Una captura al día; las cadencias son banderas, no capturas ──────────────
 * Semana, mes, trimestre y año **son la foto diaria que cae en el último día del
 * periodo**. Capturarlas por separado permitiría que el cierre de mes no coincidiera con
 * el diario del día 31 — dos cifras oficiales del mismo hecho, que es el problema que la
 * Fase VP existe para cerrar.
 *
 * ── Hora: 23:50 MX, y no es arbitrario ───────────────────────────────────────
 * El corte del día tiene que ser el día. `feed_stock` refresca cada 15 min, así que a las
 * 23:50 la existencia ya es la de cierre de operación. Correrlo de madrugada obligaría a
 * fechar "ayer" una foto tomada hoy, y esa clase de desfase es la que después nadie puede
 * explicar.
 *
 * ── Lo que NO se dibuja como cero (ADR-056) ──────────────────────────────────
 *  · **Costo ausente → `costo_unitario` y `valor` quedan NULL**, y se cuenta en
 *    `pares_sin_costo`. El scanner de reabasto usa `COALESCE(..., 0)`, que sirve para
 *    ordenar una lista pero acá sumaría inventario valuado en cero al total del cierre.
 *  · **Saldo cero → no se guarda fila**, pero el almacén SÍ queda en `coverage`. Ausencia
 *    dentro de un almacén cubierto = cero real; ausencia del almacén = **no medido**.
 *
 * ── Unidad: se guarda CRUDA, a propósito ─────────────────────────────────────
 * `commercial.stock.quantity` viene en la unidad del ERP que manda en ese almacén, y
 * Kepler y Wincaja no son conmensurables sin el divisor de ADR-055. Convertir al
 * fotografiar congelaría un factor que todavía se está corrigiendo (`v_unit_truth`). Se
 * guarda crudo y se convierte al leer.
 *
 * El cron se apaga con `ENABLE_STOCK_SNAPSHOT=false`; el disparo manual siempre funciona.
 */
@Injectable()
export class StockSnapshotService {
  private readonly logger = new Logger(StockSnapshotService.name);
  private isRunning = false;

  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  /** 23:50 MX — cierre de operación del día que se está fotografiando. */
  @Cron('0 50 23 * * *', { timeZone: 'America/Mexico_City' })
  async scheduledSnapshot(): Promise<void> {
    if (process.env.ENABLE_STOCK_SNAPSHOT === 'false') return;
    if (this.isRunning) {
      this.logger.warn('Skip: la foto anterior sigue corriendo');
      return;
    }
    await this.snapshotAllTenants();
  }

  /**
   * Toma la foto de todos los tenants. `fecha` permite re-tomar un día concreto: la
   * escritura es idempotente (UPSERT por la PK), así que re-correr el mismo día corrige
   * en vez de duplicar.
   */
  async snapshotAllTenants(fecha?: string): Promise<SnapshotResult> {
    this.isRunning = true;
    const t0 = Date.now();
    const acc: SnapshotResult = { warehouses: 0, pares: 0, pares_en_cero: 0, pares_sin_costo: 0, fecha_corte: '' };
    let error: string | null = null;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        const r = await this.snapshotTenant(t.id, fecha);
        acc.warehouses += r.warehouses;
        acc.pares += r.pares;
        acc.pares_en_cero += r.pares_en_cero;
        acc.pares_sin_costo += r.pares_sin_costo;
        acc.fecha_corte = r.fecha_corte;
      }
      this.logger.log(
        `Foto ${acc.fecha_corte}: ${acc.warehouses} almacenes · ${acc.pares} pares · ` +
        `${acc.pares_en_cero} en cero · ${acc.pares_sin_costo} sin costo`,
      );
      return acc;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.isRunning = false;
      await this.latir(acc, Date.now() - t0, error);
    }
  }

  async snapshotTenant(tenantId: string, fecha?: string): Promise<SnapshotResult> {
    // La fecha de corte se calcula EN LA DB con la zona de México, no con el reloj del
    // proceso: la API puede correr en UTC y a las 23:50 MX ya es el día siguiente en UTC,
    // lo que fecharía la foto un día adelante. Es el bug de fecha que este repo ya pagó
    // cuatro veces (ver la nota de LC.16 sobre `String(fecha).slice(0,10)`).
    const { rows: fr } = await this.knex.raw(
      `SELECT COALESCE(?::date, (now() AT TIME ZONE 'America/Mexico_City')::date) AS f`,
      [fecha ?? null],
    );
    const f: string = fr[0].f instanceof Date
      ? fr[0].f.toISOString().slice(0, 10)
      : String(fr[0].f).slice(0, 10);

    // Banderas de cierre: se derivan de la fecha, una sola vez, en SQL.
    //   semana  = domingo (el corte semanal del negocio)
    //   mes     = último día del mes · trimestre = último día de mar/jun/sep/dic
    //   año     = 31 de diciembre
    const flags = `
      (EXTRACT(DOW FROM d.f) = 0)                                              AS cierre_semana,
      (d.f = (date_trunc('month', d.f) + interval '1 month - 1 day')::date)    AS cierre_mes,
      (d.f = (date_trunc('quarter', d.f) + interval '3 months - 1 day')::date) AS cierre_trimestre,
      (d.f = (date_trunc('year', d.f) + interval '1 year - 1 day')::date)      AS cierre_anio`;

    // Costo canónico = cost_with_tax (por PIEZA), fallback cost_base.
    // ⚠️ SIN `, 0` final, a diferencia del scanner de reabasto: acá un cero se sumaría al
    // valorizado del cierre como si la mercancía no valiera nada. Se deja NULL y se cuenta.
    const costo = `COALESCE(pr.cost_with_tax, pr.cost_base)`;

    const { rows: ins } = await this.knex.raw(
      `
      WITH d AS (SELECT ?::date AS f),
      base AS (
        SELECT s.tenant_id, s.warehouse_id, s.product_id,
               COALESCE(s.quantity, 0)                                   AS unidades,
               COALESCE(s.reserved_quantity, 0)                          AS reservadas,
               COALESCE(s.quantity, 0) - COALESCE(s.reserved_quantity,0) AS disponibles,
               ${costo}                                                  AS costo_unitario,
               CASE WHEN pr.cost_with_tax IS NOT NULL THEN 'cost_with_tax'
                    WHEN pr.cost_base     IS NOT NULL THEN 'cost_base'
                    ELSE NULL END                                        AS costo_fuente
          FROM commercial.stock s
          LEFT JOIN catalog.products pr
                 ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
         WHERE s.tenant_id = ?
      ),
      escritas AS (
        INSERT INTO analytics.stock_snapshots (
          tenant_id, warehouse_id, product_id, fecha_corte,
          unidades, reservadas, disponibles, costo_unitario, valor, costo_fuente,
          cierre_semana, cierre_mes, cierre_trimestre, cierre_anio)
        SELECT b.tenant_id, b.warehouse_id, b.product_id, d.f,
               b.unidades, b.reservadas, b.disponibles, b.costo_unitario,
               -- valor NULL (no 0) cuando no hay costo: se declara, no se dibuja.
               CASE WHEN b.costo_unitario IS NULL THEN NULL
                    ELSE b.unidades * b.costo_unitario END,
               b.costo_fuente, ${flags}
          FROM base b CROSS JOIN d
         WHERE b.unidades <> 0 OR b.reservadas <> 0
        ON CONFLICT (tenant_id, warehouse_id, product_id, fecha_corte) DO UPDATE
          SET unidades = EXCLUDED.unidades, reservadas = EXCLUDED.reservadas,
              disponibles = EXCLUDED.disponibles, costo_unitario = EXCLUDED.costo_unitario,
              valor = EXCLUDED.valor, costo_fuente = EXCLUDED.costo_fuente
        RETURNING warehouse_id, valor, unidades, costo_unitario
      )
      SELECT count(*)::int                                              AS pares,
             count(*) FILTER (WHERE costo_unitario IS NULL)::int        AS pares_sin_costo,
             count(DISTINCT warehouse_id)::int                          AS warehouses
        FROM escritas`,
      [f, tenantId],
    );

    // Cobertura: una fila por almacén fotografiado. ES la pieza que distingue
    // "tenía cero" de "no se midió" — sin ella, las filas ausentes mienten.
    const { rows: cov } = await this.knex.raw(
      `
      WITH d AS (SELECT ?::date AS f)
      INSERT INTO analytics.stock_snapshot_coverage (
        tenant_id, warehouse_id, fecha_corte, pares, pares_en_cero,
        unidades_total, valor_total, pares_sin_costo,
        cierre_semana, cierre_mes, cierre_trimestre, cierre_anio)
      SELECT s.tenant_id, s.warehouse_id, d.f,
             count(*) FILTER (WHERE COALESCE(s.quantity,0) <> 0 OR COALESCE(s.reserved_quantity,0) <> 0)::int,
             count(*) FILTER (WHERE COALESCE(s.quantity,0)  = 0 AND COALESCE(s.reserved_quantity,0) = 0)::int,
             sum(COALESCE(s.quantity,0)),
             -- Total NULL si ALGÚN par no se pudo costear: un total parcial presentado como
             -- total es una cifra falsa. El detalle de cuántos faltan va en pares_sin_costo.
             CASE WHEN count(*) FILTER (
                    WHERE COALESCE(s.quantity,0) <> 0 AND ${costo} IS NULL) > 0
                  THEN NULL
                  ELSE sum(COALESCE(s.quantity,0) * ${costo}) END,
             count(*) FILTER (WHERE COALESCE(s.quantity,0) <> 0 AND ${costo} IS NULL)::int,
             ${flags}
        FROM commercial.stock s
        CROSS JOIN d
        LEFT JOIN catalog.products pr
               ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
       WHERE s.tenant_id = ?
       GROUP BY s.tenant_id, s.warehouse_id, d.f
      ON CONFLICT (tenant_id, warehouse_id, fecha_corte) DO UPDATE
        SET pares = EXCLUDED.pares, pares_en_cero = EXCLUDED.pares_en_cero,
            unidades_total = EXCLUDED.unidades_total, valor_total = EXCLUDED.valor_total,
            pares_sin_costo = EXCLUDED.pares_sin_costo
      RETURNING warehouse_id, pares_en_cero`,
      [f, tenantId],
    );

    const r = ins[0] ?? { pares: 0, pares_sin_costo: 0, warehouses: 0 };
    return {
      warehouses: cov.length || r.warehouses,
      pares: r.pares,
      pares_en_cero: cov.reduce((a: number, c: { pares_en_cero: number }) => a + Number(c.pares_en_cero), 0),
      pares_sin_costo: r.pares_sin_costo,
      fecha_corte: f,
    };
  }

  /**
   * Qué almacén se fotografió qué día. Es la mitad del par que evita la mentira: sin esto,
   * un producto ausente en la foto se lee como "tenía cero" cuando pudo ser "ese almacén no
   * reportó". Devuelve la cobertura, no el detalle.
   */
  async coverage(desde?: string, hasta?: string) {
    const q = this.knex('analytics.stock_snapshot_coverage as c')
      .leftJoin('commercial.warehouses as w', 'w.id', 'c.warehouse_id')
      .select(
        'c.fecha_corte', 'c.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
        'c.pares', 'c.pares_en_cero', 'c.unidades_total', 'c.valor_total', 'c.pares_sin_costo',
        'c.cierre_semana', 'c.cierre_mes', 'c.cierre_trimestre', 'c.cierre_anio',
      )
      .orderBy([{ column: 'c.fecha_corte', order: 'desc' }, { column: 'w.code' }]);
    if (desde) q.where('c.fecha_corte', '>=', desde);
    if (hasta) q.where('c.fecha_corte', '<=', hasta);
    return q.limit(2000);
  }

  /**
   * Latido a `analytics.cron_runs`. Obligatorio, no cosmético: su umbral vive en
   * `CRON_JOBS` (`stock_snapshot`) y sin registrarlo el sensor de `db-health` cae en
   * `cfg ? classify : 'ok'` — **verde incondicional**, que es el bug que la Fase VP.0
   * salió a cazar. Y para un job cuyo valor es no perder días, un verde falso es lo peor
   * que puede pasar: nadie se enteraría hasta necesitar la historia que no se tomó.
   */
  private async latir(r: SnapshotResult, ms: number, error: string | null): Promise<void> {
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'stock_snapshot',
          label: 'Foto diaria de inventario',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          // Cero almacenes fotografiados es FALLA, no éxito silencioso: el caso real es
          // que la query corra bien contra una tabla que quedó vacía.
          status: error || r.warehouses === 0 ? 'error' : 'ok',
          rows_affected: r.pares,
          duration_ms: ms,
          note: error
            ? null
            : `${r.fecha_corte} · ${r.warehouses} almacenes · ${r.pares} pares · ${r.pares_sin_costo} sin costo`,
          error: error ? error.slice(0, 500) : r.warehouses === 0 ? 'cero almacenes fotografiados' : null,
          host: 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch {
      /* el latido nunca rompe al que late (criterio de cron-heartbeat.js) */
    }
  }
}
