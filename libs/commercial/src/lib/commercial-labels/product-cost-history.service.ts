import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService } from '@megadulces/platform-core';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * `[ETQ-CAMBIOS.11]` La foto diaria del costo de la ficha.
 *
 * Kepler no guarda la historia del costo (`kdii.c77/c78/c79` sólo tienen el valor de hoy), así que el
 * «costo anterior» de «Cambios de precio» sólo puede existir si lo guardamos nosotros. Cada noche se lee el
 * costo estándar vigente de `analytics.v_kepler_standard_cost` (derivado del ODS, sin importer) y se
 * escribe una fila **sólo donde cambió** respecto de la última guardada. La primera noche siembra todo; de
 * ahí en adelante son los cambios reales.
 *
 * Corre en el WORKER (la API tiene los trabajos programados apagados, ADR-043). Latido en
 * `analytics.cron_runs` (`product_cost_history`, umbral en `CRON_JOBS`): sin él una foto parada se vería verde.
 */
@Injectable()
export class ProductCostHistoryService {
  private readonly logger = new Logger(ProductCostHistoryService.name);
  private enCurso = false;

  constructor(
    private readonly tk: TenantKnexService,
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
  ) {}

  @Cron('0 30 4 * * *', { timeZone: 'America/Mexico_City' })
  async tomarFoto(): Promise<{ vigentes: number; insertadas: number } | null> {
    if (this.enCurso) return null; // una pasada lenta no se encima con la siguiente
    this.enCurso = true;
    const t0 = Date.now();
    let error: string | null = null;
    let vigentes = 0;
    let insertadas = 0;
    try {
      await this.tk.run(MEGA, async (trx) => {
        await trx.raw(`SET LOCAL statement_timeout = '10min'`);
        const r = (await trx.raw(SQL_FOTO_COSTO)).rows[0] as { vigentes: string; insertadas: string };
        vigentes = Number(r.vigentes);
        insertadas = Number(r.insertadas);
      });
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
      this.logger.error(`Foto diaria del costo falló: ${error}`);
    } finally {
      this.enCurso = false;
      await this.latir(t0, insertadas, vigentes, error);
    }
    return error ? null : { vigentes, insertadas };
  }

  private async latir(t0: number, insertadas: number, vigentes: number, error: string | null): Promise<void> {
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA, job_key: 'product_cost_history', label: 'Foto diaria del costo (Cambios de precio)',
          last_start: new Date(t0), last_finish: this.knex.fn.now(), duration_ms: Date.now() - t0,
          // Cero filas NUEVAS es normal (ningún costo cambió); cero costos LEÍDOS es falla: la vista vino vacía.
          status: error || vigentes === 0 ? 'error' : 'ok',
          rows_affected: insertadas,
          error: error ?? (vigentes === 0 ? 'La vista de costo estándar no devolvió ningún costo' : null),
          host: 'worker', updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'duration_ms', 'status', 'rows_affected', 'error', 'host', 'updated_at']);
    } catch { /* el latido no debe romper la foto */ }
  }
}

/**
 * Los tres peldaños de la ficha como filas (plaza, SKU, unidad, costo sin impuesto). Si dos peldaños de
 * una misma ficha traen el MISMO rótulo (pasa con rótulos sucios), gana el costo menor: sin eso el
 * `ON CONFLICT` vería dos veces la misma llave y reventaría toda la foto.
 */
export const SQL_FOTO_COSTO = `
  WITH vig AS MATERIALIZED (
    SELECT DISTINCT ON (sucursal, sku, unidad) sucursal, sku, unidad, costo
      FROM (
        SELECT sucursal, sku, unidad_base AS unidad, costo_estandar    AS costo FROM analytics.v_kepler_standard_cost
         WHERE unidad_base IS NOT NULL AND costo_estandar    > 0
        UNION ALL
        SELECT sucursal, sku, unidad_dos,            costo_estandar_u2          FROM analytics.v_kepler_standard_cost
         WHERE unidad_dos  IS NOT NULL AND costo_estandar_u2 > 0
        UNION ALL
        SELECT sucursal, sku, unidad_tres,           costo_estandar_u3          FROM analytics.v_kepler_standard_cost
         WHERE unidad_tres IS NOT NULL AND costo_estandar_u3 > 0
      ) t
     ORDER BY sucursal, sku, unidad, costo
  ), ultimo AS (
    SELECT DISTINCT ON (sucursal, sku, unidad) sucursal, sku, unidad, costo_sin_impuesto
      FROM analytics.product_cost_history
     WHERE tenant_id = public.current_tenant_id()
     ORDER BY sucursal, sku, unidad, valid_from DESC
  ), ins AS (
    INSERT INTO analytics.product_cost_history (tenant_id, sucursal, sku, unidad, costo_sin_impuesto, valid_from)
    SELECT public.current_tenant_id(), v.sucursal, v.sku, v.unidad, round(v.costo::numeric, 4),
           (now() AT TIME ZONE 'America/Mexico_City')::date
      FROM vig v
      LEFT JOIN ultimo u ON u.sucursal = v.sucursal AND u.sku = v.sku AND u.unidad = v.unidad
     WHERE u.costo_sin_impuesto IS NULL OR u.costo_sin_impuesto <> round(v.costo::numeric, 4)
    ON CONFLICT (tenant_id, sucursal, sku, unidad, valid_from)
      DO UPDATE SET costo_sin_impuesto = EXCLUDED.costo_sin_impuesto
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM vig) AS vigentes, (SELECT count(*) FROM ins) AS insertadas`;
