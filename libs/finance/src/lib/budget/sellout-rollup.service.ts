import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';

/**
 * [PU.V1] Rollup del sell-out para Presupuestos — servido de `analytics.mv_sellout_budget_rollup`.
 *
 * ── Qué cambió respecto de ADR-075, y por qué ──────────────────────────────────────────────
 *
 * Este servicio nació sirviendo el rollup desde un Parquet en disco consultado con DuckDB
 * embebido. La idea era buena —precomputar ~520 filas en vez de agregar 1.7 GB por request— pero
 * el SUSTRATO no sobrevivió a producción. Medido el 2026-10-07:
 *
 *   · `BUDGET_ROLLUP_DIR` no está definida en NINGÚN lado (ni `ops/`, ni el `.env` de prod) →
 *     cae al default `os.tmpdir()`, dentro del contenedor.
 *   · El Deployment `api` corre `replicas: 2` y **no monta ningún volumen** (`ops/k3s/41-...yaml`:
 *     el único `volumeMounts` del archivo es el `/data` de redis) → dos pods, dos Parquets
 *     construidos por separado, y la cifra que ve el usuario depende de a qué pod lo mandó el
 *     balanceador.
 *   · El archivo se pierde en cada despliegue → el primer request después de cada deploy devuelve
 *     503 «El histórico de ventas se está generando». Le pasó a una persona real.
 *   · El rebuild cuesta **25 s** y lo dispara un request de usuario, ×2 pods.
 *
 * En este repo hay **20 agregados pesados** servidos por matvista + refresco nocturno + latido con
 * umbral en `CRON_JOBS`. Éste era el único que no. Ahora se alinea: la MV la refresca
 * `AnalyticsRefreshService` (job `analytics_refresh_sellout_budget`), vive en Postgres —o sea que
 * los dos pods leen EXACTAMENTE lo mismo—, sobrevive a los despliegues y ya no hay primer request
 * que falle. La API pública de esta clase no cambió: sus consumidores no se enteran.
 *
 * ⭐ Y de paso se arregló el número: la MV joinea el canal del sell-out contra el catálogo de
 * entidades PASANDO POR `sellout_channel_map`, que es lo que este servicio no hacía — y por eso
 * tiraba $314,428,861 (28.70 % del sell-out), con tres celdas publicando $0 sobre $208M. El
 * detalle, con el antes/después medido, está en la migración `20261007202137`.
 *
 * ⚠️ Las MV no soportan RLS (limitación de Postgres, vivida en C.1): el filtro por `tenant_id` va
 *    EXPLÍCITO en cada lectura de acá, igual que antes había un Parquet por tenant. Se usa
 *    `KNEX_NEW_DB` directo (sin contexto de request) porque esto también sirve a procesos de fondo.
 *
 * ⚠️ Frescura DECLARADA (ADR-056): `dataAsOf()` devuelve el `refreshed_at` de la MV, no `now()`.
 *    Es un snapshot nocturno — el periodo en curso va atrás, y quien lo publique tiene que decirlo.
 */

export interface RollupRealRow { entity_key: string; channel: string; year: number; period: number; monto: number }

const MV = 'analytics.mv_sellout_budget_rollup';

@Injectable()
export class SelloutRollupService {
  private readonly log = new Logger('SelloutRollup');

  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  /** Frescura declarada del snapshot (ISO) o null si la MV nunca se pobló. */
  async dataAsOf(tenantId: string): Promise<string | null> {
    try {
      const r = await this.knex(MV).where({ tenant_id: tenantId }).max({ mx: 'refreshed_at' }).first();
      return r?.mx ? new Date(r.mx as Date).toISOString() : null;
    } catch (e: unknown) {
      this.log.warn(`dataAsOf: ${(e as Error)?.message}`);
      return null; // «no se pudo medir» se DECLARA (null), no se dibuja como fresco
    }
  }

  // ── API que consumen los motores de Presupuestos (misma forma que antes) ──

  /** Años fiscales con real, anteriores a `fy`. */
  async yearsWithRealBefore(tenantId: string, fy: number): Promise<number[]> {
    const rows = await this.knex(MV)
      .where({ tenant_id: tenantId })
      .andWhere('fiscal_year', '<', Number(fy))
      .distinct('fiscal_year')
      .orderBy('fiscal_year', 'asc');
    return rows.map((r: { fiscal_year: number }) => Number(r.fiscal_year));
  }

  /** Real por entidad × canal × año × periodo para N años. */
  async realByEntityYearPeriod(tenantId: string, years: number[]): Promise<RollupRealRow[]> {
    const ys = years.map((y) => Number(y)).filter(Number.isFinite);
    if (!ys.length) return [];
    const rows = await this.knex(MV)
      .where({ tenant_id: tenantId })
      .whereIn('fiscal_year', ys)
      .select('entity_key', 'channel', 'fiscal_year', 'period_no', 'monto');
    return rows.map((r: { entity_key: string; channel: string; fiscal_year: number; period_no: number; monto: string | number }) => ({
      entity_key: r.entity_key, channel: r.channel,
      year: Number(r.fiscal_year), period: Number(r.period_no), monto: Number(r.monto) || 0,
    }));
  }

  /** Real del año `priorYear` rolado a entidad → { periodo → monto } (agrega sobre canal). */
  async priorYearByEntityPeriod(tenantId: string, priorYear: number): Promise<Map<string, Map<number, number>>> {
    const rows = await this.knex(MV)
      .where({ tenant_id: tenantId, fiscal_year: Number(priorYear) })
      .groupBy('entity_key', 'period_no')
      .select('entity_key', 'period_no')
      .sum({ monto: 'monto' });
    const map = new Map<string, Map<number, number>>();
    for (const r of rows as Array<{ entity_key: string; period_no: number; monto: string | number }>) {
      if (!map.has(r.entity_key)) map.set(r.entity_key, new Map());
      map.get(r.entity_key)!.set(Number(r.period_no), Number(r.monto) || 0);
    }
    return map;
  }
}
