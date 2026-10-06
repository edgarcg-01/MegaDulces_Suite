import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import type { CortesSucursalesResponse } from '@megadulces/contracts';
import { armarRespuesta, type CorteCrudo } from './cortes-sucursales.engine';

/**
 * `[CSU.1]` Cortes/Sucursales — lectura pura sobre el ODS, sin importer (derive-no-copy).
 *
 *  · Corte  = `kepler_ods.kdue` cargo (`c29='C'`) del cliente `CONTADO`, grupo 23 tipo 1
 *             ("Corte de Caja POS"). `c7` fecha, `c11` importe, `c16` = `Caja <caja>-<folio>`.
 *  · Cobros = `kepler_ods.kdm5` aplicaciones cuyo cargo es el corte (`c8='D'`, `c9=23`, `c10=1`,
 *             `c11` = folio del corte). Forma de pago y concepto de `analytics.erp_collections`.
 *  · Arqueo = `analytics.cash_cuts` por (sucursal, caja, folio). ⚠️ El folio de arqueo se REPITE
 *             entre fechas (Hidalgo caja 1 folio 93 aparece 22-sep, 28-sep y 2-oct): se casa con
 *             la fecha más cercana dentro de ±3 días, nunca con cualquiera.
 *
 * Costo medido en prod (2026-10-05): un mes completo, 110 cortes, 421 ms.
 * `kepler_ods.*` no tiene tenant ni RLS; `analytics.*` sin RLS → filtro tenant explícito.
 */
const SQL = `
WITH co AS (
  SELECT DISTINCT ON (e.sucursal, btrim(e.c6))
         e.sucursal,
         btrim(e.c6)                                            AS folio,
         to_char(e.c7::date, 'YYYY-MM-DD')                      AS fecha,
         e.c7::date                                             AS fecha_d,
         btrim(e.c16)                                           AS referencia,
         substring(btrim(e.c16) from '^Caja ([0-9]+)-')         AS caja,
         substring(btrim(e.c16) from '^Caja [0-9]+-([0-9]+)$')  AS turno,
         round(e.c11::numeric, 2)                               AS monto
    FROM kepler_ods.kdue e
   WHERE btrim(e.c2) = 'CONTADO' AND e.c29 = 'C' AND e.c4 = 23 AND e.c5 = 1
     AND e.c7 >= ?::date AND e.c7 < (?::date + 1)
   ORDER BY e.sucursal, btrim(e.c6), (btrim(e.c1) = e.sucursal) DESC
),
ap AS (
  SELECT DISTINCT btrim(m.c1) AS sucursal, btrim(m.c11) AS corte_folio,
         'U' || btrim(m.c3) || lpad(btrim(m.c4::text), 2, '0') || lpad(btrim(m.c5::text), 2, '0') AS doc_prefix,
         btrim(m.c6) AS folio, round(m.c13::numeric, 2) AS monto
    FROM kepler_ods.kdm5 m
   WHERE m.c2 = 'U' AND btrim(m.c8) = 'D' AND btrim(m.c9::text) = '23' AND btrim(m.c10::text) = '1'
     AND btrim(m.c1) IN (SELECT DISTINCT sucursal FROM co)
)
SELECT co.sucursal, co.folio, co.fecha, co.referencia, co.caja, co.turno, co.monto,
       a.cobros, coalesce(a.cobrado, 0) AS cobrado,
       to_char(cc.business_date, 'YYYY-MM-DD') AS arqueo_fecha,
       cc.efectivo_esperado, cc.efectivo_contado,
       cc.tarjeta_esperado, cc.tarjeta_contado,
       cc.transfer_esperado, cc.transfer_contado,
       cc.cajero_cierre
  FROM co
  LEFT JOIN LATERAL (
    SELECT sum(ap.monto) AS cobrado,
           jsonb_agg(jsonb_build_object(
             'doc_prefix', ap.doc_prefix, 'folio', ap.folio, 'monto', ap.monto,
             'fecha', to_char(ec.cobro_date, 'YYYY-MM-DD'), 'forma_pago', ec.forma_pago, 'concepto', ec.concepto)
             ORDER BY ap.folio) AS cobros
      FROM ap
      LEFT JOIN analytics.erp_collections ec
        ON ec.tenant_id = ?::uuid AND ec.sucursal = ap.sucursal AND ec.doc_prefix = ap.doc_prefix AND ec.folio = ap.folio
     WHERE ap.sucursal = co.sucursal AND ap.corte_folio = co.folio
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT c.* FROM analytics.cash_cuts c
     WHERE c.tenant_id = ?::uuid AND c.warehouse_code = co.sucursal AND c.caja = co.caja AND c.folio = co.turno
       AND abs(c.business_date - co.fecha_d) <= 3
     ORDER BY abs(c.business_date - co.fecha_d), c.business_date DESC
     LIMIT 1
  ) cc ON true
 ORDER BY co.sucursal, co.folio`;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-\d{2}$/;

export interface CortesQuery { month?: string; from?: string; to?: string }

@Injectable()
export class CortesSucursalesService {
  private readonly logger = new Logger(CortesSucursalesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** `from`+`to` mandan sobre `month`; sin nada, el mes en curso (hora de México). */
  periodo(q: CortesQuery): { from: string; to: string } {
    if (q.from || q.to) {
      if (!q.from || !q.to || !ISO.test(q.from) || !ISO.test(q.to)) {
        throw new BadRequestException('El rango necesita "from" y "to" con formato AAAA-MM-DD.');
      }
      if (q.from > q.to) throw new BadRequestException('"from" no puede ser posterior a "to".');
      return { from: q.from, to: q.to };
    }
    const hoyMx = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const m = q.month && MES.test(q.month) ? q.month : hoyMx.slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { from: `${m}-01`, to: `${m}-${String(ultimo).padStart(2, '0')}` };
  }

  async list(q: CortesQuery): Promise<CortesSucursalesResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const periodo = this.periodo(q);
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(SQL, [periodo.from, periodo.to, tenantId, tenantId]);
      const nom = await trx.raw(
        `SELECT warehouse_code, max(warehouse_name) AS nombre FROM analytics.cash_cuts WHERE tenant_id = ?::uuid GROUP BY 1`,
        [tenantId],
      );
      const nombres: Record<string, string> = {};
      for (const x of nom.rows as Array<{ warehouse_code: string; nombre: string | null }>) {
        if (x.nombre) nombres[x.warehouse_code] = x.nombre;
      }
      const resp = armarRespuesta(r.rows as CorteCrudo[], nombres, periodo);
      this.logger.debug(`cortes ${periodo.from}..${periodo.to}: ${resp.totales.cortes} en ${Date.now() - t0} ms`);
      return resp;
    });
  }
}
