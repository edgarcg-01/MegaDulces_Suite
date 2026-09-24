import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KNEX_NEW_DB, latirCron } from '@megadulces/platform-core';
import { FINANCE_NOTIFIER_PORT, type FinanceNotifierPort } from '@megadulces/contracts';
import type { Knex } from 'knex';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * `[CC.10]` **El cruce banco↔cobro deja de ser mudo.**
 *
 * ── POR QUÉ EXISTE, Y POR QUÉ **NO** ESCRIBE HALLAZGOS ───────────────────────────────────
 * «Abonos sin cobro» (`/finanzas/cobranza`) sólo se veía si alguien se acordaba de abrir la
 * pestaña: sin cron, sin latido, sin bandeja, sin aviso. Si mañana `analytics.erp_collections`
 * o la carga de estados de cuenta se rompen, la pantalla mostraría «0 huérfanos» o «todo
 * huérfano» y **nadie se enteraría**.
 *
 * ⛔ El plan original decía empujar un hallazgo por depósito a `finance.findings`. **Se
 * descartó con medición**: son **5,244 huérfanos históricos por $118,935,974.22**, y la bandeja
 * `/finanzas/hallazgos` ya fue **retirada** (`[SN.18]`) justamente por acumular **82,377 filas
 * en `nuevo` sin triage**. Volcar ahí sería reconstruir el cementerio.
 *
 * ⭐ Y hay una razón estructural, no sólo de volumen: **acá el trabajo cierra el item solo**.
 * Ligar el abono lo saca de la consulta. `finance.findings` exige un triage manual aparte
 * («confirmar / descartar») que **duplicaría** la acción real y se quedaría sin hacer — que es
 * exactamente lo que pasó con los 82 mil. Por eso la bandeja de «Mi trabajo» cuenta **en vivo**
 * y este cron sólo **mide y late**.
 *
 * ── QUÉ VIGILA ──────────────────────────────────────────────────────────────────────────
 * Tres números por corrida: abonos de cobranza sin ligar, cuántos tienen un cobro candidato, y
 * cuántos no lo tienen. El latido se pinta **rojo** si el universo viene en cero — que no
 * significa «todo conciliado» sino «la fuente dejó de llegar», el modo de falla que hay que ver.
 *
 * ⚠️ Su umbral vive en `CRON_JOBS` (`db-health.service.ts`). Sin esa entrada el sensor cae en
 * `cfg ? classify : 'ok'` y un cron parado se ve **verde**.
 */
@Injectable()
export class CobranzaGapScannerService {
  private readonly logger = new Logger(CobranzaGapScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /** 07:45 MX — antes de que crédito y cobranza abra «Mi trabajo». */
  @Cron('0 45 7 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_COBRANZA_GAP_SCAN === 'false') return;
    if (this.running) { this.logger.warn('Skip: scan en curso'); return; }
    await this.scan().catch((e) => this.logger.error(`scan cobranza: ${e?.message ?? e}`));
  }

  /**
   * Mide la brecha y late. Devuelve lo medido para que el endpoint manual pueda mostrarlo.
   *
   * ⚠️ La consulta es la misma forma que `listUnmatchedBank` (`[CC.9]`: cubetas de monto y el
   * anti-join de ligados en su propia CTE). **No se reusa el método** porque aquél depende del
   * `TenantContextService` de un request y esto corre sin request — pero si una de las dos
   * cambia de criterio, la otra tiene que cambiar igual. El candado
   * `test-newdb-cobranza-match-universo.js` compara las dos.
   */
  async scan(): Promise<{ abonos: number; con_candidato: number; huerfanos: number; monto_huerfano: number }> {
    this.running = true;
    const t0 = Date.now();
    const fallas: string[] = [];
    let m = { abonos: 0, con_candidato: 0, huerfanos: 0, monto_huerfano: 0 };
    try {
      const r = await this.knex.raw(`
        WITH ligados AS MATERIALIZED (
          SELECT DISTINCT kepler_doc_folio AS folio FROM finance.bank_recon_matches
           WHERE tenant_id = ? AND kepler_doc_tipo = 'UA0501'
        ),
        mov AS MATERIALIZED (
          SELECT m.id, m.movement_date, m.amount_in::numeric AS amount_in,
                 round(m.amount_in)::bigint AS cubeta
            FROM finance.bank_movements m
            JOIN finance.movement_categories c ON c.id = m.category_id
           WHERE m.tenant_id = ? AND c.code = 'cobranza' AND m.amount_in > 0
             AND m.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM finance.bank_recon_matches r
                              WHERE r.bank_movement_id = m.id)
        ),
        cobx AS MATERIALIZED (
          SELECT ec.cobro_date, ec.monto, b.cubeta
            FROM analytics.erp_collections ec
            LEFT JOIN ligados l ON l.folio = ec.folio
            CROSS JOIN LATERAL (VALUES (round(ec.monto)::bigint - 1),
                                       (round(ec.monto)::bigint),
                                       (round(ec.monto)::bigint + 1)) AS b(cubeta)
           WHERE ec.tenant_id = ? AND l.folio IS NULL
        ),
        cand AS (
          SELECT DISTINCT m.id FROM mov m JOIN cobx k ON k.cubeta = m.cubeta
           WHERE abs(k.monto - m.amount_in) <= 1.0
             AND k.cobro_date BETWEEN m.movement_date - INTERVAL '6 days'
                                  AND m.movement_date + INTERVAL '1 days'
        )
        SELECT count(*)::int abonos,
               count(c.id)::int con_candidato,
               count(*) FILTER (WHERE c.id IS NULL)::int huerfanos,
               round(COALESCE(sum(m.amount_in) FILTER (WHERE c.id IS NULL), 0), 2)::float monto_huerfano
          FROM mov m LEFT JOIN cand c ON c.id = m.id`, [MEGA, MEGA, MEGA]);
      m = r.rows[0];
      this.logger.log(`cobranza gap: ${m.abonos} sin ligar · ${m.con_candidato} con candidato · `
        + `${m.huerfanos} huerfanos ($${m.monto_huerfano})`);
    } catch (e) {
      fallas.push(e instanceof Error ? e.message : String(e));
      this.logger.error(`cobranza gap: ${fallas[0]}`);
    } finally {
      this.running = false;
    }

    // ⛔ `rowsAffected` = los abonos MEDIDOS, y cero es rojo: un universo vacío no es «todo
    // conciliado», es que dejaron de llegar los estados de cuenta o se rompió la vista de cobros.
    await latirCron(this.knex, {
      jobKey: 'cobranza_gap',
      label: 'Brecha banco↔cobro (abonos sin ligar)',
      tenantId: MEGA,
      rowsAffected: m.abonos,
      durationMs: Date.now() - t0,
      fallas,
      note: `${m.abonos} sin ligar · ${m.con_candidato} con candidato · ${m.huerfanos} huerfanos`,
    });

    // Aviso sólo cuando hay algo que investigar, y por el puerto (best-effort, nunca rompe).
    if (!fallas.length && m.huerfanos > 0) {
      const notify = this.notifier?.notify?.bind(this.notifier);
      if (notify) {
        await notify(MEGA, {
          key: 'cobranza_gap',
          severity: 'info',
          title: 'Abonos de cobranza sin cobro en Kepler',
          message: `${m.huerfanos} abonos por $${Number(m.monto_huerfano).toLocaleString('es-MX')} `
            + 'entraron al banco y ningun cobro los explica.',
          route: '/finanzas/cobranza',
          data: { huerfanos: m.huerfanos, monto: m.monto_huerfano },
        }).catch((e: unknown) => this.logger.warn(`aviso cobranza_gap: ${e instanceof Error ? e.message : e}`));
      }
    }
    return m;
  }
}
