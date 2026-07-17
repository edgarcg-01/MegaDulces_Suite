import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/** Misma tolerancia heurística que la conciliación póliza↔CFDI (Kepler no guarda
 *  el UUID → se casa por RFC + importe ± $1 + fecha ± 5 días). */
const TOL_IMPORTE = 1.0;
const VENTANA_DIAS = 5;

export interface AssignmentInput {
  cfdi_id: string;
  sucursal: string;
  doc_tipo?: string;
  doc_folio: string;
  note?: string;
}

/**
 * MAT.1 — Asignación CFDI ↔ operación (documento Kepler), confirmada por humano.
 *
 * El motor SUGIERE (heurística RFC+importe+fecha, reusada de la conciliación) y la
 * persona CONFIRMA o DESCARTA (ADR-016: LLM fuera del camino). La asignación
 * confirmada es la evidencia dura de materialidad que consume MAT.3.
 *
 * `fiscal.*` con RLS (tk.run) · `analytics.expense_documents` sin RLS (tenant explícito).
 */
@Injectable()
export class MaterialidadAssignmentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private assertRfc(rfc: string) {
    if (!/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfc)) throw new BadRequestException('RFC inválido');
  }

  /**
   * Vista de conciliación por proveedor: cada CFDI recibido con su asignación
   * confirmada (si hay) o, si no, la mejor operación sugerida. Excluye del
   * sugeridor las operaciones ya confirmadas a otro CFDI y los pares descartados.
   */
  async reconcile(rfcInput: string) {
    const rfc = (rfcInput || '').trim().toUpperCase();
    this.assertRfc(rfc);
    const tid = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(
        `SELECT c.id AS cfdi_id, c.uuid, c.serie, c.folio, c.fecha, c.total,
                c.tipo_comprobante, c.metodo_pago, c.estatus_sat,
                (c.xml IS NOT NULL) AS has_xml,
                a.id AS assign_id, a.sucursal AS a_sucursal, a.doc_tipo AS a_doc_tipo, a.doc_folio AS a_doc_folio,
                a.importe_operacion AS a_importe, a.diff_importe AS a_diff_importe, a.diff_days AS a_diff_days,
                a.match_source AS a_source, a.created_by_username AS a_by, a.created_at AS a_at,
                s.sucursal AS s_sucursal, s.doc_tipo AS s_doc_tipo, s.doc_folio AS s_doc_folio,
                s.importe AS s_importe, s.fecha AS s_fecha, s.diff_importe AS s_diff_importe, s.diff_days AS s_diff_days
           FROM fiscal.cfdis c
           LEFT JOIN fiscal.cfdi_assignments a ON a.cfdi_id = c.id AND a.status = 'confirmed'
           LEFT JOIN LATERAL (
             SELECT e.sucursal, e.doc_tipo, e.doc_folio, e.importe, e.fecha,
                    abs(COALESCE(e.importe,0) - COALESCE(c.total,0)) AS diff_importe,
                    abs(e.fecha - c.fecha::date) AS diff_days
               FROM analytics.expense_documents e
              WHERE e.tenant_id = :tid AND e.doc_tipo = 'XA2001'
                AND UPPER(e.rfc) = UPPER(c.emisor_rfc)
                AND abs(COALESCE(e.importe,0) - COALESCE(c.total,0)) <= :tol
                AND e.fecha BETWEEN (c.fecha::date - :dias) AND (c.fecha::date + :dias)
                AND NOT EXISTS (
                  SELECT 1 FROM fiscal.cfdi_assignments a2
                   WHERE a2.status = 'confirmed' AND a2.sucursal = e.sucursal
                     AND a2.doc_tipo = e.doc_tipo AND a2.doc_folio = e.doc_folio AND a2.cfdi_id <> c.id)
                AND NOT EXISTS (
                  SELECT 1 FROM fiscal.cfdi_assignments a3
                   WHERE a3.status = 'rejected' AND a3.cfdi_id = c.id
                     AND a3.sucursal = e.sucursal AND a3.doc_tipo = e.doc_tipo AND a3.doc_folio = e.doc_folio)
              ORDER BY diff_importe ASC, diff_days ASC
              LIMIT 1
           ) s ON true
          WHERE c.rol = 'recibidas' AND UPPER(c.emisor_rfc) = :rfc AND c.estatus_sat <> 'cancelado'
          ORDER BY c.fecha DESC
          LIMIT 1000`,
        { tid, rfc, tol: TOL_IMPORTE, dias: VENTANA_DIAS },
      );
      return (r.rows as any[]).map((row) => this.mapRow(row));
    });
  }

  /** Confirma la asignación CFDI↔operación (evidencia). 1:1 en ambos sentidos. */
  async confirm(input: AssignmentInput) {
    const tid = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const cfdiId = String(input.cfdi_id || '').trim();
    const sucursal = String(input.sucursal || '').trim();
    const docTipo = String(input.doc_tipo || 'XA2001').trim();
    const docFolio = String(input.doc_folio || '').trim();
    if (!cfdiId || !sucursal || !docFolio) throw new BadRequestException('cfdi_id, sucursal y doc_folio son obligatorios');

    return this.tk.run(async (trx) => {
      const cfdi = await trx('fiscal.cfdis').where({ id: cfdiId }).select('id', 'uuid', 'emisor_rfc', 'total', 'fecha').first();
      if (!cfdi) throw new NotFoundException('CFDI no encontrado');

      const clash = await trx('fiscal.cfdi_assignments')
        .where({ tenant_id: tid, status: 'confirmed', sucursal, doc_tipo: docTipo, doc_folio: docFolio })
        .whereNot('cfdi_id', cfdiId).first();
      if (clash) throw new ConflictException('Esa operación ya está asignada a otro CFDI.');

      const op = await trx('analytics.expense_documents')
        .where({ tenant_id: tid, sucursal, doc_tipo: docTipo, doc_folio: docFolio })
        .select('importe', 'fecha').first();
      const importeCfdi = Number(cfdi.total || 0);
      const importeOp = op ? Number(op.importe || 0) : null;
      const diffImporte = importeOp != null ? Math.abs(importeOp - importeCfdi) : null;
      const diffDays = op?.fecha && cfdi.fecha
        ? Math.abs(Math.round((Date.parse(String(cfdi.fecha)) - Date.parse(String(op.fecha))) / 86400000)) : null;

      // Un confirm reemplaza cualquier estado previo de este CFDI (confirmado o rechazos).
      await trx('fiscal.cfdi_assignments').where({ tenant_id: tid, cfdi_id: cfdiId }).del();
      const [ins] = await trx('fiscal.cfdi_assignments').insert({
        tenant_id: tid, cfdi_id: cfdiId, cfdi_uuid: cfdi.uuid, rfc: String(cfdi.emisor_rfc || '').toUpperCase(),
        sucursal, doc_tipo: docTipo, doc_folio: docFolio,
        importe_cfdi: importeCfdi, importe_operacion: importeOp, diff_importe: diffImporte, diff_days: diffDays,
        status: 'confirmed', match_source: 'importe_fecha', note: input.note || null,
        created_by: ctx?.userId ?? null, created_by_username: ctx?.username ?? null, updated_at: trx.fn.now(),
      }).returning('*');
      return this.mapAssignment(ins);
    });
  }

  /** Descarta un par sugerido para que no vuelva a proponerse (deja rastro). */
  async reject(input: AssignmentInput) {
    const tid = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const cfdiId = String(input.cfdi_id || '').trim();
    const sucursal = String(input.sucursal || '').trim();
    const docTipo = String(input.doc_tipo || 'XA2001').trim();
    const docFolio = String(input.doc_folio || '').trim();
    if (!cfdiId || !sucursal || !docFolio) throw new BadRequestException('cfdi_id, sucursal y doc_folio son obligatorios');

    return this.tk.run(async (trx) => {
      const cfdi = await trx('fiscal.cfdis').where({ id: cfdiId }).select('uuid', 'emisor_rfc').first();
      if (!cfdi) throw new NotFoundException('CFDI no encontrado');
      const exists = await trx('fiscal.cfdi_assignments')
        .where({ tenant_id: tid, cfdi_id: cfdiId, status: 'rejected', sucursal, doc_tipo: docTipo, doc_folio: docFolio }).first();
      if (!exists) {
        await trx('fiscal.cfdi_assignments').insert({
          tenant_id: tid, cfdi_id: cfdiId, cfdi_uuid: cfdi.uuid, rfc: String(cfdi.emisor_rfc || '').toUpperCase(),
          sucursal, doc_tipo: docTipo, doc_folio: docFolio,
          status: 'rejected', match_source: 'importe_fecha',
          created_by: ctx?.userId ?? null, created_by_username: ctx?.username ?? null, updated_at: trx.fn.now(),
        });
      }
      return { ok: true };
    });
  }

  /** Revierte una asignación confirmada (la borra). */
  async unassign(id: string) {
    const tid = this.tenantCtx.requireTenantId();
    const n = await this.tk.run((trx) => trx('fiscal.cfdi_assignments').where({ tenant_id: tid, id }).del());
    if (!n) throw new NotFoundException('Asignación no encontrada');
    return { deleted: n };
  }

  private mapRow(row: any) {
    const assignment = row.assign_id ? {
      id: row.assign_id, sucursal: row.a_sucursal, doc_tipo: row.a_doc_tipo, doc_folio: row.a_doc_folio,
      importe_operacion: row.a_importe != null ? Number(row.a_importe) : null,
      diff_importe: row.a_diff_importe != null ? Number(row.a_diff_importe) : null,
      diff_days: row.a_diff_days != null ? Number(row.a_diff_days) : null,
      match_source: row.a_source, by: row.a_by, at: row.a_at,
    } : null;
    const suggestion = (!assignment && row.s_doc_folio) ? {
      sucursal: row.s_sucursal, doc_tipo: row.s_doc_tipo, doc_folio: row.s_doc_folio,
      importe: row.s_importe != null ? Number(row.s_importe) : null, fecha: row.s_fecha,
      diff_importe: row.s_diff_importe != null ? Number(row.s_diff_importe) : null,
      diff_days: row.s_diff_days != null ? Number(row.s_diff_days) : null,
    } : null;
    return {
      cfdi_id: row.cfdi_id, uuid: row.uuid, serie: row.serie, folio: row.folio, fecha: row.fecha,
      total: Number(row.total || 0), tipo_comprobante: row.tipo_comprobante, metodo_pago: row.metodo_pago,
      estatus_sat: row.estatus_sat, has_xml: !!row.has_xml,
      status: assignment ? 'confirmed' : (suggestion ? 'suggested' : 'unmatched'),
      assignment, suggestion,
    };
  }

  private mapAssignment(a: any) {
    return {
      id: a.id, cfdi_id: a.cfdi_id, cfdi_uuid: a.cfdi_uuid, rfc: a.rfc,
      sucursal: a.sucursal, doc_tipo: a.doc_tipo, doc_folio: a.doc_folio,
      importe_cfdi: a.importe_cfdi != null ? Number(a.importe_cfdi) : null,
      importe_operacion: a.importe_operacion != null ? Number(a.importe_operacion) : null,
      diff_importe: a.diff_importe != null ? Number(a.diff_importe) : null,
      diff_days: a.diff_days != null ? Number(a.diff_days) : null,
      status: a.status, by: a.created_by_username, at: a.created_at,
    };
  }
}
