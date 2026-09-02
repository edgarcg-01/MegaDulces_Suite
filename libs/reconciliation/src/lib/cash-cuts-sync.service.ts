import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * SM.20 — Jala solo el arqueo que genera Kepler.
 *
 * Hasta ahora `analytics.cash_cuts` se llenaba **a mano**, corriendo
 * `database/importers/kepler/load-cash-cuts-from-ods.js`. El costo se vio en
 * vivo (2026-09-02): 20 cortes de la sucursal 02, con $300k+ de efectivo
 * declarado, existían en el ODS y no en nuestra tabla — la pantalla los mostraba
 * como si el turno nunca hubiera cerrado. Un dato que llega cuando alguien se
 * acuerda de correr un script no es un dato: Kepler genera el corte solo, así
 * que traerlo también tiene que ser solo.
 *
 * El origen (`kepler_ods.kdpv_folio_caja`) vive en **la misma base** que el
 * destino, así que el sync es un UPSERT de una sentencia: no viajan filas por la
 * red y no depende de la máquina de feeds. Por eso puede correr cada pocos
 * minutos sin costo, y por eso la frescura del corte pasa a ser la del CDC.
 *
 * ── Decode (verificado sobre 3,048 cortes cerrados)
 *   `c15` esperado · `c25` contado (DECLARADO, no verificado) · `c35` = c15 − c25
 *   `c43` billetes · `c44` monedas · `c48` retirado → c43+c44+c48 = c25 en 63.6%
 *   `c45` NO es parte del efectivo contado.
 * Kepler **no** guarda el conteo por denominación: eso solo existe en nuestro
 * arqueo ciego. Por eso el corte de Kepler nunca reemplaza al conteo físico —
 * el 74.6% cierra al centavo exacto, que es el patrón de arqueo no ciego (SM.7).
 *
 * La sentencia es **gemela** de la del CLI, que sigue siendo el camino para
 * backfills largos y para cuando el ODS no tenga una sucursal. Si se toca una,
 * tocar la otra: el smoke compara el conteo del ODS contra el de la tabla, así
 * que una divergencia se ve como hueco, no como silencio.
 */
@Injectable()
export class CashCutsSyncService {
  private readonly logger = new Logger(CashCutsSyncService.name);
  private running = false;

  /**
   * Ventana del sync continuo. Un corte puede corregirse en Kepler después de
   * cerrado, así que no alcanza con mirar hoy; 3 días cubre reaperturas y el
   * turno que cruza medianoche sin volver el UPSERT caro.
   */
  private static readonly DIAS = 3;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantKnex: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Sync del tenant de la request, para llamar desde una pantalla antes de leer.
   * **Best-effort**: si el ODS no responde, la pantalla debe mostrar lo que ya
   * había en vez de romperse — un corte viejo es peor que ninguno, pero un error
   * 500 es peor que los dos.
   */
  async syncCurrentTenant(): Promise<number> {
    try {
      return await this.syncTenant(this.tenantCtx.requireTenantId());
    } catch (e: any) {
      this.logger.warn(`sync on-read falló: ${e?.message || e}`);
      return 0;
    }
  }

  /** Cada 10 min. El CDC del ODS trae minutos de retraso; afinar más no compra nada. */
  @Cron('0 */10 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: sync previo aún corriendo'); return; }
    await this.syncAllTenants('cron');
  }

  async syncAllTenants(source = 'cron', dias = CashCutsSyncService.DIAS): Promise<{ tenants: number; cortes: number }> {
    this.running = true;
    let cortes = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          cortes += await this.syncTenant(t.id, dias);
        } catch (e: any) {
          this.logger.warn(`sync tenant ${t.id} falló: ${e?.message || e}`);
        }
      }
      if (cortes) this.logger.log(`sync ${source}: ${cortes} cortes de Kepler al día (${dias}d, ${tenants.length} tenants).`);
      return { tenants: tenants.length, cortes };
    } finally {
      this.running = false;
    }
  }

  /**
   * Devuelve cuántos cortes quedaron sincronizados. El scope es por tenant y la
   * pertenencia la decide `commercial.warehouses`: un corte del ODS es de quien
   * sea dueño de esa sucursal, no de quien corra el job.
   */
  async syncTenant(tenantId: string, dias = CashCutsSyncService.DIAS): Promise<number> {
    return this.tenantKnex.run(tenantId, async (trx) => {
      const r: any = await trx.raw(UPSERT, [dias, tenantId]);
      return r?.rowCount ?? 0;
    });
  }

  /**
   * Hueco entre lo que Kepler cerró y lo que tenemos. Debe ser 0; si no lo es,
   * el sync se quedó atrás y la pantalla está mintiendo por omisión.
   */
  async gap(tenantId: string, dias = CashCutsSyncService.DIAS): Promise<{ kepler: number; nuestro: number; faltan: number }> {
    return this.tenantKnex.run(tenantId, async (trx) => {
      const r: any = await trx.raw(GAP, [dias, tenantId]);
      const g = r.rows[0];
      return { kepler: Number(g.kepler), nuestro: Number(g.nuestro), faltan: Number(g.faltan) };
    });
  }
}

/**
 * Cortes de Kepler normalizados.
 *
 * `DISTINCT ON` porque el CDC puede re-emitir la misma fila: sin esto el
 * `ON CONFLICT` revienta con "cannot affect row a second time". Gana el cierre
 * más reciente.
 *
 * El filtro deja fuera dos cosas y solo dos: la caja **abierta** (Kepler la marca
 * con `c10 = 1800-01-01`, no es un arqueo sino una caja en operación) y el turno
 * que abrió y cerró en cero, sin un peso (32 en los últimos 30 días, todos de
 * segundos de duración: aperturas fallidas). Todo lo demás entra, incluido el
 * corte descuadrado — sobre todo el corte descuadrado.
 */
const SRC = `
  SELECT DISTINCT ON (k.sucursal, k.c2, k.c5::date, k.c3)
         k.sucursal, k.c2 AS caja, k.c3::bigint::text AS folio, k.c5::date AS business_date,
         k.c5 AS opened_at,
         CASE WHEN k.c10::date = DATE '1800-01-01' THEN NULL ELSE k.c10 END AS closed_at,
         NULLIF(btrim(k.c7), '')  AS cajero_apertura,
         NULLIF(btrim(k.c8), '')  AS cajero_cierre,
         NULLIF(btrim(k.c13), '') AS turno,
         NULLIF(btrim(k.c6), '')  AS hora_apertura,
         NULLIF(btrim(k.c11), '') AS hora_cierre,
         round(COALESCE(k.c15, 0), 2) AS ef_esp,
         round(COALESCE(k.c25, 0), 2) AS ef_cont,
         round(COALESCE(k.c35, 0), 2) AS ef_diff,
         round(COALESCE(k.c16, 0), 2) AS tj_esp,
         round(COALESCE(k.c26, 0), 2) AS tj_cont,
         round(COALESCE(k.c36, 0), 2) AS tj_diff,
         round(COALESCE(k.c17, 0), 2) AS tr_esp,
         round(COALESCE(k.c27, 0), 2) AS tr_cont,
         round(COALESCE(k.c37, 0), 2) AS tr_diff,
         round(COALESCE(k.c43, 0), 2) AS arq_bil,
         round(COALESCE(k.c44, 0), 2) AS arq_mon,
         round(COALESCE(k.c45, 0), 2) AS arq_otros,
         round(COALESCE(k.c48, 0), 2) AS retirado,
         round(COALESCE(k.c49, 0), 2) AS total_venta,
         round(COALESCE(k.c15, 0) + COALESCE(k.c16, 0) + COALESCE(k.c17, 0), 2) AS venta_total,
         h.dur AS duracion_horas
    FROM kepler_ods.kdpv_folio_caja k
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN ha IS NULL OR hc IS NULL THEN NULL
               WHEN hc - ha < 0 THEN hc - ha + 24
               ELSE hc - ha
             END AS dur
        FROM (SELECT substring(btrim(k.c6)  from '^[0-9]{1,2}')::int AS ha,
                     substring(btrim(k.c11) from '^[0-9]{1,2}')::int AS hc) t
    ) h
   WHERE (COALESCE(k.c25, 0) <> 0 OR COALESCE(k.c35, 0) <> 0)
     AND k.c5::date >= current_date - ($1::int)
   ORDER BY k.sucursal, k.c2, k.c5::date, k.c3, k.c10 DESC NULLS LAST
`;

// `handoff` NO se lista: es GENERATED ALWAYS (cajero_apertura IS DISTINCT FROM cajero_cierre).
// El JOIN a warehouses es INNER a propósito: un corte de una sucursal que este
// tenant no tiene no es suyo y no debe entrar a su tabla.
const UPSERT = `
INSERT INTO analytics.cash_cuts (
  tenant_id, warehouse_code, warehouse_name, caja, folio, business_date,
  opened_at, closed_at, cajero_apertura, cajero_cierre, turno,
  efectivo_esperado, efectivo_contado, efectivo_diff,
  tarjeta_esperado, tarjeta_contado, tarjeta_diff,
  transfer_esperado, transfer_contado, transfer_diff,
  arqueo_billetes, arqueo_monedas, arqueo_otros,
  efectivo_retirado, total_venta, venta_total,
  hora_apertura, hora_cierre, duracion_horas,
  warehouse_id, cerrado, source
)
SELECT $2::uuid, s.sucursal, w.name, s.caja, s.folio, s.business_date,
       s.opened_at, s.closed_at, s.cajero_apertura, s.cajero_cierre, s.turno,
       s.ef_esp, s.ef_cont, s.ef_diff,
       s.tj_esp, s.tj_cont, s.tj_diff,
       s.tr_esp, s.tr_cont, s.tr_diff,
       s.arq_bil, s.arq_mon, s.arq_otros,
       s.retirado, s.total_venta, s.venta_total,
       s.hora_apertura, s.hora_cierre, s.duracion_horas,
       w.id, true, 'kepler'
  FROM (${SRC}) s
  JOIN commercial.warehouses w
    ON w.tenant_id = $2::uuid AND w.code = s.sucursal AND w.deleted_at IS NULL
ON CONFLICT (tenant_id, warehouse_code, caja, business_date, folio) DO UPDATE SET
  warehouse_name    = EXCLUDED.warehouse_name,
  warehouse_id      = EXCLUDED.warehouse_id,
  opened_at         = EXCLUDED.opened_at,
  closed_at         = EXCLUDED.closed_at,
  cajero_apertura   = EXCLUDED.cajero_apertura,
  cajero_cierre     = EXCLUDED.cajero_cierre,
  turno             = EXCLUDED.turno,
  efectivo_esperado = EXCLUDED.efectivo_esperado,
  efectivo_contado  = EXCLUDED.efectivo_contado,
  efectivo_diff     = EXCLUDED.efectivo_diff,
  tarjeta_esperado  = EXCLUDED.tarjeta_esperado,
  tarjeta_contado   = EXCLUDED.tarjeta_contado,
  tarjeta_diff      = EXCLUDED.tarjeta_diff,
  transfer_esperado = EXCLUDED.transfer_esperado,
  transfer_contado  = EXCLUDED.transfer_contado,
  transfer_diff     = EXCLUDED.transfer_diff,
  arqueo_billetes   = EXCLUDED.arqueo_billetes,
  arqueo_monedas    = EXCLUDED.arqueo_monedas,
  arqueo_otros      = EXCLUDED.arqueo_otros,
  efectivo_retirado = EXCLUDED.efectivo_retirado,
  total_venta       = EXCLUDED.total_venta,
  venta_total       = EXCLUDED.venta_total,
  hora_apertura     = EXCLUDED.hora_apertura,
  hora_cierre       = EXCLUDED.hora_cierre,
  duracion_horas    = EXCLUDED.duracion_horas,
  cerrado           = true,
  source            = 'kepler',
  updated_at        = now()
`;

const GAP = `
  WITH src AS (${SRC})
  SELECT (SELECT count(*) FROM src s
            JOIN commercial.warehouses w ON w.tenant_id = $2::uuid AND w.code = s.sucursal AND w.deleted_at IS NULL) kepler,
         (SELECT count(*) FROM analytics.cash_cuts
           WHERE tenant_id = $2::uuid AND business_date >= current_date - ($1::int)) nuestro,
         (SELECT count(*) FROM src s
            JOIN commercial.warehouses w ON w.tenant_id = $2::uuid AND w.code = s.sucursal AND w.deleted_at IS NULL
            LEFT JOIN analytics.cash_cuts c
              ON c.tenant_id = $2::uuid AND c.warehouse_code = s.sucursal
             AND c.caja = s.caja AND c.business_date = s.business_date AND c.folio = s.folio
           WHERE c.id IS NULL) faltan
`;
