import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { SAT_LISTS } from './sat-lists.config';

export interface SatListCrossResult {
  tenantId: string;
  lista: string;
  matched: number;
  nuevos: number;
}

/**
 * FISCAL — Cruce de una lista SAT contra los RFCs de proveedores del tenant.
 *
 * `[PGP.161]` El universo son TRES fuentes, cada RFC una sola vez: los CFDI recibidos
 * (`fiscal.cfdis`, tipo I, no cancelados), los gastos (`analytics.expense_documents`) y el
 * catálogo de acreedores de Kepler (`analytics.v_supplier_rfc`). Hasta el 2026-11-20 miraba sólo
 * los gastos: 318 RFC de 2,278 que nos facturan, y un proveedor en la 69-B definitiva (32 CFDI)
 * nunca apareció. `doc_count`/`importe_total`/`iva_total` son de los CFDI cuando los hay.
 *
 * Escribe fiscal.sat_list_matches (RLS forzado → dentro de tk.run, SET LOCAL); las lecturas
 * filtran el tenant explícito.
 * El triage humano (estado/nota) se PRESERVA en el UPSERT.
 */
@Injectable()
export class SatListCrossService {
  private readonly logger = new Logger(SatListCrossService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Cruza TODAS las listas para el tenant del contexto actual. */
  async crossAllCurrent(): Promise<SatListCrossResult[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const out: SatListCrossResult[] = [];
    for (const lista of Object.keys(SAT_LISTS)) {
      out.push(await this.crossCheckForTenant(tenantId, lista));
    }
    return out;
  }

  /** Cruza una lista específica para un tenant explícito (scanner cron). */
  async crossCheckForTenant(tenantId: string, lista: string, listHash?: string): Promise<SatListCrossResult> {
    const hash =
      listHash ??
      (await this.tk.global('fiscal.sat_list_versions').where({ lista }).orderBy('processed_at', 'desc').first())?.list_hash ??
      null;

    return this.tk.run(tenantId, async (trx) => {
      const res = await trx.raw(
        `WITH cf AS (
           -- [PGP.161] Todo lo que nos facturaron (descarga masiva del SAT): el universo de proveedores.
           SELECT upper(btrim(c.emisor_rfc)) AS rfc, count(*) AS doc_count,
                  coalesce(sum(c.total),0) AS importe_total,
                  coalesce(sum(nullif(c.impuestos ->> 'iva_trasladado','')::numeric),0) AS iva_total,
                  min(c.fecha)::date AS primera_fecha, max(c.fecha)::date AS ultima_fecha
             FROM fiscal.cfdis c
            WHERE c.tenant_id = ? AND c.rol = 'recibidas' AND c.tipo_comprobante = 'I'
              AND c.estatus_sat <> 'cancelado' AND c.emisor_rfc IS NOT NULL AND btrim(c.emisor_rfc) <> ''
              AND upper(btrim(c.emisor_rfc)) NOT IN ('XAXX010101000','XEXX010101000')
            GROUP BY 1
         ), ed AS (
           SELECT upper(trim(ed.rfc)) AS rfc, count(*) AS doc_count,
                  coalesce(sum(ed.importe),0) AS importe_total, coalesce(sum(ed.iva),0) AS iva_total,
                  min(ed.fecha) AS primera_fecha, max(ed.fecha) AS ultima_fecha
             FROM analytics.expense_documents ed
            WHERE ed.tenant_id = ? AND ed.rfc IS NOT NULL AND btrim(ed.rfc) <> ''
              -- RFC genéricos (público en general / extranjero) no son proveedores
              -- reales; ya se reportan aparte en rfc_issues. Fuera de la bandeja de listas.
              AND upper(btrim(ed.rfc)) NOT IN ('XAXX010101000','XEXX010101000')
            GROUP BY upper(trim(ed.rfc))
         ), kp AS (
           -- [PGP.161] El catálogo de acreedores de Kepler: el proveedor al que se le paga aunque no haya CFDI descargado.
           SELECT DISTINCT upper(btrim(s.rfc)) AS rfc FROM analytics.v_supplier_rfc s
            WHERE s.rfc IS NOT NULL AND btrim(s.rfc) <> '' AND upper(btrim(s.rfc)) NOT IN ('XAXX010101000','XEXX010101000')
         ), agg AS (
           -- Cada RFC UNA vez: sus CFDI si los hay; si no, sus gastos; si no, sólo el catálogo (sin documentos).
           SELECT * FROM cf
           UNION ALL SELECT * FROM ed WHERE rfc NOT IN (SELECT rfc FROM cf)
           UNION ALL SELECT rfc, 0, 0, 0, NULL::date, NULL::date FROM kp
                      WHERE rfc NOT IN (SELECT rfc FROM cf) AND rfc NOT IN (SELECT rfc FROM ed)
         )
         INSERT INTO fiscal.sat_list_matches
           (tenant_id, lista, rfc, nombre, situacion, doc_count, importe_total, iva_total,
            primera_fecha, ultima_fecha, list_hash, updated_at)
         SELECT ?, e.lista, e.rfc, e.nombre, e.situacion, a.doc_count, a.importe_total, a.iva_total,
                a.primera_fecha, a.ultima_fecha, ?, now()
           FROM fiscal.sat_list_rfcs e
           JOIN agg a ON a.rfc = e.rfc
          WHERE e.lista = ?
         ON CONFLICT (tenant_id, lista, rfc) DO UPDATE
           SET nombre=EXCLUDED.nombre, situacion=EXCLUDED.situacion, doc_count=EXCLUDED.doc_count,
               importe_total=EXCLUDED.importe_total, iva_total=EXCLUDED.iva_total,
               primera_fecha=EXCLUDED.primera_fecha, ultima_fecha=EXCLUDED.ultima_fecha,
               list_hash=EXCLUDED.list_hash, updated_at=now()
         RETURNING (xmax = 0) AS es_nuevo`,
        [tenantId, tenantId, tenantId, hash, lista],
      );
      const rows: Array<{ es_nuevo: boolean }> = res.rows ?? [];
      const nuevos = rows.filter((r) => r.es_nuevo).length;
      if (rows.length) {
        this.logger.warn(`Tenant ${tenantId} · lista ${lista}: ${rows.length} proveedores (${nuevos} nuevos).`);
      }
      return { tenantId, lista, matched: rows.length, nuevos };
    });
  }
}
