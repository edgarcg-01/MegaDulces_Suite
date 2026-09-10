import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { RECON_NOTIFIER_PORT, ReconNotifierPort } from '@megadulces/contracts';

/**
 * SM.34 — **El arqueo se hace cuando se puede contar, no contra un reloj.**
 *
 * Esto era el SLA del arqueo (SM.21): Kepler cerraba el turno, arrancaba un plazo
 * de 45 min y, vencido, el corte caía como hallazgo a la bandeja del supervisor
 * (a las 12 h subía a `critical`, "ya no se puede contar"). La idea era buena en
 * su momento: 76 de 78 cortes cerrados no tenían conteo físico y nada lo pedía.
 *
 * **Por qué se retira el reloj (decisión de Edgar, 2026-09-10):** el plazo asumía
 * que contar es un trámite de después del cierre, y en el mostrador no lo es. La
 * cajera puede arquear **con el turno abierto** — el backend siempre lo permitió
 * (`anclarAlTurno` acepta el turno que Kepler tenga abierto) — así que penalizar
 * los minutos posteriores al cierre castigaba el momento equivocado: el efectivo
 * ya salió en sangrías antes de cerrar.
 *
 * ── Qué se fue y qué se queda
 *
 * **Se fue:** el plazo (`SLA_MIN`/`CRITICO_MIN`), los hallazgos
 * `arqueo_no_realizado` que emitía por reloj, la alerta al supervisor por corte
 * vencido, y el aviso "haz tu arqueo" que salía a los 5 min de cerrar.
 *
 * **Se queda, a propósito:**
 *  - **`cumplimiento()`** — el tablero de qué cortes llegaron a tener conteo y
 *    cuánto tardaron. Quitar el reloj no es dejar de mirar: sin esto volveríamos
 *    a no saber que 76 de 78 no se contaron. Es reporte, no cronómetro.
 *  - **`avisarRetiros()`** — "contá lo que estás sacando" cuando Kepler pide el
 *    retiro, **con el turno todavía abierto**. Es exactamente la ventana que esta
 *    decisión abre: contar al cierre verifica ~$9,000 de $27,000 cobrados porque
 *    el resto ya salió en sangrías.
 *
 * La regla `arqueo_no_realizado` sigue registrada en el motor (`movement-reconcile`)
 * porque los hallazgos históricos la referencian — pero **ya nadie la emite**.
 *
 * ⚠️ El archivo y la clase conservan el nombre `…Sla…` para no arrastrar el
 * rename por el módulo y el controller en el mismo cambio; ya no hay SLA acá.
 */
@Injectable()
export class CashCountSlaService {
  private readonly logger = new Logger(CashCountSlaService.name);
  private running = false;

  /**
   * A partir de acá el efectivo **ya se movió** (se depositó, se mezcló, salió en
   * sangrías) y el corte no se puede contar. No es un plazo que alguien incumple:
   * es un hecho físico, y el tablero de cumplimiento lo usa para separar
   * "pendiente" de "ya no verificable". 12 h = el turno cambió de día.
   */
  static readonly NO_CONTABLE_MIN = 720;

  private static readonly DIAS = 7;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(RECON_NOTIFIER_PORT) private readonly notifier?: ReconNotifierPort,
  ) {}

  /**
   * Cada 5 min, y ahora sólo para una cosa: avisarle a la cajera que cuente lo
   * que está sacando **mientras el turno sigue abierto**. Ya no hay plazo que
   * vencer, así que no hay nada que escalar.
   */
  @Cron('0 */5 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: barrido previo aún corriendo'); return; }
    await this.scanAllTenants('cron');
  }

  async scanAllTenants(source = 'cron'): Promise<{ tenants: number; avisados: number }> {
    this.running = true;
    let avisados = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          avisados += await this.avisarRetiros(t.id);
        } catch (e: any) {
          this.logger.warn(`barrido tenant ${t.id} falló: ${e?.message || e}`);
        }
      }
      if (avisados) this.logger.log(`Arqueo ${source}: ${avisados} avisos "contá lo que estás sacando".`);
      return { tenants: tenants.length, avisados };
    } finally {
      this.running = false;
    }
  }

  /**
   * "Cuenta lo que estás sacando", cuando Kepler pidió el retiro.
   *
   * Esto es lo que faltaba para cubrir el dinero completo: contar solo al cierre
   * verifica ~$9,000 de $27,000 cobrados, porque el resto ya salió en sangrías.
   * El aviso llega en el momento en que el efectivo sale del cajón, que es la
   * única ventana en que todavía se puede contar.
   */
  private async avisarRetiros(tenantId: string): Promise<number> {
    if (!this.notifier?.notifyArqueoDue) return 0;
    const filas = await this.tk.run(tenantId, async (trx) => {
      const r: any = await trx.raw(RETIROS_PENDIENTES, { tenant: tenantId });
      return r.rows as RetiroPendienteRow[];
    }).catch((e: any) => { this.logger.warn(`retiros pendientes falló: ${e?.message || e}`); return [] as RetiroPendienteRow[]; });

    let n = 0;
    for (const f of filas) {
      const cajero = (f.cajero_cierre || '').trim();
      if (!cajero) continue;
      await this.notifier.notifyArqueoDue(tenantId, {
        cajero_code: cajero,
        warehouse_code: f.warehouse_code, caja: f.caja,
        business_date: f.business_date, folio: f.folio,
        hora_cierre: null,                       // el turno sigue abierto: no hay hora de cierre
        cerrado_hace_min: Number(f.sin_contar_min),
        vencido: false,
        motivo: 'retiro',
      } as any).then(() => { n++; })
        .catch((e: any) => this.logger.warn(`aviso de retiro a ${cajero} falló: ${e?.message || e}`));
    }
    return n;
  }

  /**
   * Tablero de cumplimiento: qué porcentaje de los cortes llegó a tener conteo
   * físico, y cuánto tardó. Es la métrica que hace que la cola sirva — sin ella
   * el hallazgo se acumula y nadie rinde cuentas.
   *
   * `mediana_min` se calcula solo sobre los arqueados: promediar los pendientes
   * como "infinito" daría un número que no significa nada.
   */
  async cumplimiento(q: { desde?: string; warehouseCodes?: string[] | null }): Promise<CumplimientoRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (q.warehouseCodes && !q.warehouseCodes.length) return [];
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(CUMPLIMIENTO, {
        tenant: tenantId,
        desde: q.desde || null,
        sucs: q.warehouseCodes ?? null,
        critico: CashCountSlaService.NO_CONTABLE_MIN,
      });
      return rows as CumplimientoRow[];
    });
  }
}

interface RetiroPendienteRow {
  warehouse_code: string; caja: string; folio: string; business_date: string;
  cajero_cierre: string | null;
  retirado_kepler: string; contado_nuestro: string; sin_contar: string; sin_contar_min: string;
}

export interface CumplimientoRow {
  warehouse_code: string; warehouse_name: string | null;
  cortes: number; arqueados: number; pct: number;
  pendientes: number; no_verificables: number;
  mediana_min: number | null; monto_sin_verificar: number;
}


/**
 * Retiros que Kepler ya pidió y todavía nadie contó.
 *
 * El disparador NO lo inventamos: cuando la caja junta su límite (`c46`, típicamente
 * $15,000) Kepler le pide a la cajera sacar el dinero, y al hacerlo **sube `c48`**
 * en el turno ABIERTO. Verificado en vivo: suc 01 caja 1 con `c48 = 15,000.00`
 * contra `c46 = 15,000.00`, turno sin cerrar.
 *
 * Kepler guarda el ACUMULADO, no cada sangría. Así que la señal es la diferencia:
 * lo que el ERP dice que salió menos lo que nosotros ya contamos. Mientras esa
 * brecha sea de más de un peso, hay efectivo que salió del cajón sin registro de
 * qué billetes era — y eso es lo que se le pide contar.
 *
 * Es **stateless a propósito**: no guarda "último visto" en memoria ni en tabla.
 * Al reiniciar la API no se pierde ni se duplica nada, porque la pregunta se
 * responde entera contra la base cada vez.
 */
const RETIROS_PENDIENTES = `
  SELECT k.sucursal            AS warehouse_code,
         k.c2                  AS caja,
         k.c3::bigint::text    AS folio,
         k.c5::date::text      AS business_date,
         NULLIF(btrim(k.c8), '') AS cajero_cierre,
         NULLIF(btrim(k.c6), '') AS hora_cierre,
         round(k.c48, 2)       AS retirado_kepler,
         COALESCE(b.contado, 0) AS contado_nuestro,
         round(k.c48 - COALESCE(b.contado, 0), 2) AS sin_contar,
         GREATEST(0, floor(EXTRACT(EPOCH FROM (
           (now() AT TIME ZONE 'America/Mexico_City')
           - (k.c5::date + COALESCE(NULLIF(btrim(k.c6), ''), '00:00:00')::time)
         )) / 60))::int AS sin_contar_min
    FROM kepler_ods.kdpv_folio_caja k
    LEFT JOIN LATERAL (
      SELECT sum(bc.total_contado) AS contado
        FROM reconciliation.blind_counts bc
       WHERE bc.tenant_id = CAST(:tenant AS uuid)
         AND bc.tipo = 'retiro'
         AND bc.warehouse_code = k.sucursal
         AND bc.cash_cut_folio = k.c3::bigint::text
    ) b ON true
   WHERE k.c10::date = DATE '1800-01-01'            -- turno ABIERTO: la caja sigue cobrando
     AND k.c5::date >= current_date - 1
     AND COALESCE(k.c48, 0) > 0                     -- Kepler ya pidió al menos un retiro
     AND (k.c48 - COALESCE(b.contado, 0)) > 1       -- y falta contar parte de eso
   ORDER BY (k.c48 - COALESCE(b.contado, 0)) DESC
   LIMIT 200
`;

const CUMPLIMIENTO = `
  WITH base AS (
    SELECT cc.warehouse_code, cc.warehouse_name, cc.folio, cc.efectivo_contado,
           GREATEST(0, floor(EXTRACT(EPOCH FROM (
             (now() AT TIME ZONE 'America/Mexico_City')
             - (cc.business_date + COALESCE(NULLIF(btrim(cc.hora_cierre), ''), '23:59:00')::time)
           )) / 60))::int AS edad_min,
           b.id AS arqueo_id,
           CASE WHEN b.id IS NULL THEN NULL ELSE
             GREATEST(0, floor(EXTRACT(EPOCH FROM (
               (b.created_at AT TIME ZONE 'America/Mexico_City')
               - (cc.business_date + COALESCE(NULLIF(btrim(cc.hora_cierre), ''), '23:59:00')::time)
             )) / 60))::int
           END AS tardo_min
      FROM analytics.cash_cuts cc
      LEFT JOIN reconciliation.blind_counts b
        ON b.tenant_id = cc.tenant_id AND b.warehouse_code = cc.warehouse_code
       AND b.tipo = 'cierre' AND b.cash_cut_folio = cc.folio
     WHERE cc.tenant_id = CAST(:tenant AS uuid)
       AND COALESCE(cc.efectivo_contado, 0) <> 0
       AND (CAST(:desde AS date) IS NULL OR cc.business_date >= CAST(:desde AS date))
       AND (CAST(:sucs AS text[]) IS NULL OR cc.warehouse_code = ANY(CAST(:sucs AS text[])))
  )
  SELECT warehouse_code, max(warehouse_name) AS warehouse_name,
         count(*)::int                                             AS cortes,
         count(arqueo_id)::int                                     AS arqueados,
         round(100.0 * count(arqueo_id) / NULLIF(count(*), 0), 1)::float AS pct,
         count(*) FILTER (WHERE arqueo_id IS NULL AND edad_min <  CAST(:critico AS int))::int AS pendientes,
         count(*) FILTER (WHERE arqueo_id IS NULL AND edad_min >= CAST(:critico AS int))::int AS no_verificables,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY tardo_min)::int AS mediana_min,
         COALESCE(round(sum(efectivo_contado) FILTER (WHERE arqueo_id IS NULL), 2), 0)::float AS monto_sin_verificar
    FROM base
   GROUP BY warehouse_code
   ORDER BY monto_sin_verificar DESC
`;
