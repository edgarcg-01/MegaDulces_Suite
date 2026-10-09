import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService, branchName } from '@megadulces/platform-core';
import type { CortesAlcance, CortesSucursalesResponse } from '@megadulces/contracts';
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
 *  · `[CSU.7]` Devoluciones = `kepler_ods.kdm1` notas de crédito POS (`U-A-21-1` fiscal, `U-A-25-1`
 *             no fiscal) no canceladas, ligadas al turno por `c81` (caja) + `c80` (folio de turno)
 *             y ±1 día. El corte ya las resta; el arqueo no — el motor juzga contra el neto.
 *
 * Costo medido en prod (2026-10-05): un mes completo, 106 cortes, 630-750 ms en caliente; casi todo
 * el tiempo es la vista analytics.erp_collections (forma de pago del cobro).
 * Replica cruzada (un corte de otra plaza en la replica de esta): medido 0 en las 8 sucursales;
 * igual se filtra c1 = sucursal para que el dia que aparezca no fabrique un corte fantasma.
 * `kepler_ods.*` no tiene tenant ni RLS; `analytics.*` sin RLS → filtro tenant explícito.
 *
 * `[CSU.6]` ALCANCE POR SUCURSAL (decisión de Francisco, 2026-10-05): Finanzas ve todas;
 * encargados y auxiliares de tienda, sólo la suya. Lo resuelve `ScopeService` (ADR-050) con
 * `role_scopes`/`user_scopes` — el mismo mecanismo del arqueo de tienda —, no un `if` por rol.
 * Medido en prod con el servicio real: 31 de las 32 personas de Finanzas resuelven `all`, los
 * encargados/auxiliares `own` = su `warehouse_code`, y quien no tiene sucursal asignada, ninguna.
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
     AND btrim(e.c1) = e.sucursal                 -- el documento es de SU plaza (filtro canonico, Fase PO)
     AND e.c7 >= ?::date AND e.c7 < (?::date + 1)
     AND (?::boolean OR e.sucursal = ANY(?::text[]))   -- alcance: todas, o sólo las permitidas
   ORDER BY e.sucursal, btrim(e.c6)
),
ap AS (
  SELECT DISTINCT btrim(m.c1) AS sucursal, btrim(m.c11) AS corte_folio,
         'U' || btrim(m.c3) || lpad(btrim(m.c4::text), 2, '0') || lpad(btrim(m.c5::text), 2, '0') AS doc_prefix,
         btrim(m.c6) AS folio, round(m.c13::numeric, 2) AS monto
    FROM kepler_ods.kdm5 m
   WHERE m.c2 = 'U' AND btrim(m.c1) = m.sucursal AND btrim(m.c8) = 'D' AND btrim(m.c9::text) = '23' AND btrim(m.c10::text) = '1'
     AND btrim(m.c1) IN (SELECT DISTINCT sucursal FROM co)
),
dv AS (
  -- [CSU.7] Notas de crédito POS pagadas en caja (UA2101 fiscal, UA2501 no fiscal), con su turno.
  SELECT m.sucursal, btrim(m.c81) AS caja, btrim(m.c80::text) AS turno, m.c9::date AS fecha_d,
         'UA' || lpad(btrim(m.c4::text), 2, '0') || lpad(btrim(m.c5::text), 2, '0') AS doc_prefix,
         btrim(m.c6) AS folio, round(m.c16::numeric, 2) AS monto,
         nullif(btrim(m.c32), '') AS cliente, nullif(btrim(m.c24), '') AS motivo, nullif(btrim(m.c67), '') AS cajero
    FROM kepler_ods.kdm1 m
   WHERE m.c2 = 'U' AND m.c3 = 'A' AND m.c4::text IN ('21', '25') AND m.c5::text = '1'
     AND btrim(m.c1) = m.sucursal AND coalesce(m.c43, '') <> 'C'
     AND m.c9 >= (?::date - 1) AND m.c9 < (?::date + 2)
     AND m.sucursal IN (SELECT DISTINCT sucursal FROM co)
)
SELECT co.sucursal, co.folio, co.fecha, co.referencia, co.caja, co.turno, co.monto,
       a.cobros, coalesce(a.cobrado, 0) AS cobrado, d.devoluciones,
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
             'fecha', to_char(ec.cobro_date, 'YYYY-MM-DD'), 'forma_pago', ec.forma_pago, 'concepto', ec.concepto,
             -- [CSU.8] A qué cuenta entró el dinero. Van las DOS: la clase (para no pintar
             -- 'CAJA GENERAL' como si fuera un banco) y el nombre. Si el cobro no está en la
             -- vista, las dos llegan null y la pantalla no inventa.
             'medio_cobro', ec.medio_cobro, 'cuenta_tesoreria', ec.cuenta_tesoreria)
             ORDER BY ap.folio) AS cobros
      FROM ap
      LEFT JOIN analytics.erp_collections ec
        ON ec.tenant_id = ?::uuid AND ec.sucursal = ap.sucursal AND ec.doc_prefix = ap.doc_prefix AND ec.folio = ap.folio
     WHERE ap.sucursal = co.sucursal AND ap.corte_folio = co.folio
  ) a ON true
  LEFT JOIN LATERAL (
    -- El folio de turno se repite entre fechas: sólo la devolución del día del corte (±1 por medianoche).
    SELECT jsonb_agg(jsonb_build_object(
             'doc_prefix', dv.doc_prefix, 'folio', dv.folio, 'fecha', to_char(dv.fecha_d, 'YYYY-MM-DD'), 'monto', dv.monto,
             'cliente', dv.cliente, 'motivo', dv.motivo, 'cajero', dv.cajero) ORDER BY dv.doc_prefix, dv.folio) AS devoluciones
      FROM dv
     WHERE dv.sucursal = co.sucursal AND dv.caja = co.caja AND dv.turno = co.turno AND abs(dv.fecha_d - co.fecha_d) <= 1
  ) d ON true
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
    private readonly scope: ScopeService,
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

  /**
   * Sucursales que puede ver quien consulta. Se resuelve FUERA de `tk.run` (ScopeService usa su
   * propia conexión), igual que en goods-receipt-proofs.
   */
  private async alcance(): Promise<CortesAlcance> {
    const s = await this.scope.current('finanzas');
    const visibles = this.scope.intersect(s, 'warehouse', null);
    if (visibles === null) return { todas: true, sucursales: [] };
    return {
      todas: false,
      sucursales: [...visibles].sort().map((codigo) => ({ codigo, nombre: branchName(codigo) })),
    };
  }

  async list(q: CortesQuery): Promise<CortesSucursalesResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const periodo = this.periodo(q);
    const alcance = await this.alcance();
    // Sin sucursal asignada: no hay nada que consultar. Se declara en `alcance`, no se pinta vacío a secas.
    if (!alcance.todas && alcance.sucursales.length === 0) return armarRespuesta([], {}, periodo, alcance);
    const codigos = alcance.sucursales.map((x) => x.codigo);
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(SQL, [periodo.from, periodo.to, alcance.todas, codigos, periodo.from, periodo.to, tenantId, tenantId]);
      const nom = await trx.raw(
        `SELECT warehouse_code, max(warehouse_name) AS nombre FROM analytics.cash_cuts WHERE tenant_id = ?::uuid GROUP BY 1`,
        [tenantId],
      );
      const nombres: Record<string, string> = {};
      for (const x of nom.rows as Array<{ warehouse_code: string; nombre: string | null }>) {
        if (x.nombre) nombres[x.warehouse_code] = x.nombre;
      }
      const resp = armarRespuesta(r.rows as CorteCrudo[], nombres, periodo, alcance);
      this.logger.debug(`cortes ${periodo.from}..${periodo.to}: ${resp.totales.cortes} en ${Date.now() - t0} ms`);
      return resp;
    });
  }
}
