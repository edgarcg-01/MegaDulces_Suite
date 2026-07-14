import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { SAT_LISTS } from './sat-lists.config';

export interface MatchFilter { lista?: string; situacion?: string; estado?: string; limit?: number; }
export interface IssueFilter { issue_type?: string; estado?: string; limit?: number; }

const SEVERITY_SQL = `CASE lower(situacion)
  WHEN 'definitivo' THEN 0 WHEN 'firme' THEN 0
  WHEN 'presunto' THEN 1 WHEN 'no localizado' THEN 1 WHEN 'exigible' THEN 1
  WHEN 'sentencia' THEN 2 WHEN 'desvirtuado' THEN 3 WHEN 'sentencia favorable' THEN 3
  ELSE 2 END`;

/**
 * FISCAL — Query-service de las bandejas de riesgo (listas SAT + RFC issues).
 * Lecturas tenant-scoped (RLS vía tk.run). Drill a documentos en vivo sobre
 * analytics.expense_documents (filtro de tenant explícito).
 */
@Injectable()
export class FiscalListasService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Bandeja de proveedores en listas SAT. */
  matches(f: MatchFilter = {}) {
    const limit = Math.min(f.limit ?? 200, 1000);
    return this.tk.run(async (trx) => {
      let q = trx('fiscal.sat_list_matches').select('*').select(trx.raw(`${SEVERITY_SQL} AS severidad`));
      if (f.lista) q = q.where({ lista: f.lista });
      if (f.situacion) q = q.whereRaw('lower(situacion) = lower(?)', [f.situacion]);
      if (f.estado) q = q.where({ estado: f.estado });
      return q.orderByRaw(SEVERITY_SQL).orderBy('importe_total', 'desc').limit(limit);
    });
  }

  /** KPIs: exposición en riesgo, conteos por lista/situación/estado. */
  stats() {
    return this.tk.run(async (trx) => {
      const porLista = await trx('fiscal.sat_list_matches')
        .select('lista', 'situacion').count({ n: '*' }).sum({ importe: 'importe_total' })
        .groupBy('lista', 'situacion');
      const riesgo = await trx('fiscal.sat_list_matches')
        .whereRaw(`lower(situacion) IN ('definitivo','presunto','firme','no localizado','exigible')`)
        .where({ estado: 'nuevo' })
        .count({ n: '*' }).sum({ importe: 'importe_total' }).first();
      const rfcIssues = await trx('fiscal.rfc_issues')
        .select('issue_type').count({ n: '*' }).groupBy('issue_type');
      return {
        exposicion_riesgo_mxn: Number(riesgo?.importe ?? 0),
        pendientes_riesgo: Number(riesgo?.n ?? 0),
        por_lista: porLista.map((r: any) => ({
          lista: r.lista, situacion: r.situacion, count: Number(r.n), importe: Number(r.importe ?? 0),
        })),
        rfc_issues: rfcIssues.map((r: any) => ({ issue_type: r.issue_type, count: Number(r.n) })),
      };
    });
  }

  /** Drill: documentos (pólizas) del tenant con ese proveedor. */
  documents(rfc: string, limit = 500) {
    const tenantId = this.tenantCtx.requireTenantId();
    const rfcNorm = rfc.trim().toUpperCase();
    return this.tk.run(async (trx) =>
      trx('analytics.expense_documents')
        .where({ tenant_id: tenantId })
        .whereRaw('upper(btrim(rfc)) = ?', [rfcNorm])
        .select('sucursal', 'doc_tipo', 'doc_folio', 'fecha', 'beneficiario', 'concepto', 'importe', 'iva', 'area')
        .orderBy('fecha', 'desc').limit(Math.min(limit, 2000)),
    );
  }

  /** Bandeja de RFC con problema estructural. */
  rfcIssues(f: IssueFilter = {}) {
    const limit = Math.min(f.limit ?? 200, 1000);
    return this.tk.run(async (trx) => {
      let q = trx('fiscal.rfc_issues').select('*');
      if (f.issue_type) q = q.where({ issue_type: f.issue_type });
      if (f.estado) q = q.where({ estado: f.estado });
      return q.orderBy('importe_total', 'desc').limit(limit);
    });
  }

  /** Triage humano de un match de lista. */
  setMatchEstado(id: string, estado: string, nota?: string) {
    return this.setEstado('fiscal.sat_list_matches', id, estado, nota);
  }

  /** Triage humano de un RFC issue. */
  setIssueEstado(id: string, estado: string, nota?: string) {
    return this.setEstado('fiscal.rfc_issues', id, estado, nota);
  }

  private setEstado(table: string, id: string, estado: string, nota?: string) {
    if (!['nuevo', 'en_revision', 'confirmado', 'descartado'].includes(estado)) {
      throw new Error(`estado inválido: ${estado}`);
    }
    return this.tk.run(async (trx) => {
      const patch: Record<string, unknown> = { estado, updated_at: trx.fn.now() };
      if (nota !== undefined) patch.nota = nota;
      return { updated: await trx(table).where({ id }).update(patch) };
    });
  }

  /** Estado de las listas cargadas (global): versión + total por lista. */
  async listStatus() {
    const knex = this.tk.global;
    const out: any[] = [];
    for (const lista of Object.keys(SAT_LISTS)) {
      const v = await knex('fiscal.sat_list_versions').where({ lista }).orderBy('processed_at', 'desc').first();
      const total = await knex('fiscal.sat_list_rfcs').where({ lista }).count({ n: '*' }).first();
      out.push({
        lista, label: SAT_LISTS[lista].label,
        cargada: !!v, list_hash: v?.list_hash ?? null, procesada_en: v?.processed_at ?? null,
        total_rfcs: Number(total?.n ?? 0),
        edad_horas: v?.processed_at ? Math.round((Date.now() - new Date(v.processed_at).getTime()) / 3.6e6) : null,
      });
    }
    return out;
  }
}
