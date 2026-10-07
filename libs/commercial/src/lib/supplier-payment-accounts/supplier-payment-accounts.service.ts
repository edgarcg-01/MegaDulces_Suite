import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ObjectStorageService } from '@megadulces/platform-core';

export interface CreateAccountChangeRequestDto {
  supplier_id: string;
  account_id?: string | null;           // null = alta de la primera cuenta / una cuenta nueva
  deactivate?: boolean;                 // solicitud de BAJA de `account_id` (no aplica si es alta)
  proposed_bank_name?: string | null;
  proposed_account_number?: string | null;
  proposed_clabe?: string | null;
  proposed_alias?: string | null;
  proposed_attachment_url?: string | null;
  proposed_attachment_kind?: 'pdf' | 'image' | null;
  proposed_es_favorita?: boolean;
  reason: string;
}

/**
 * Fase TP.7 (ADR-064) — Catálogo de cuentas de pago a proveedor + workflow de aprobación.
 * TODA alta o cambio pasa por una solicitud (`supplier_payment_account_change_requests`) — no
 * hay alta directa: la primera cuenta de un proveedor es tan sensible como cambiarla (control
 * anti-fraude). Mismo patrón que `finance.proposed_actions` (ADR-013): `requested_by` ≠
 * `decided_by`, nunca se auto-aplica. Aprobar exige `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`
 * (verificado en el controller) — el mismo permiso que libera el lote del Calendario de Pagos.
 */
@Injectable()
export class SupplierPaymentAccountsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  async listAccounts(supplierId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) =>
      trx('commercial.supplier_payment_accounts').where({ supplier_id: supplierId, status: 'activa' })
        .orderBy('es_favorita', 'desc').orderBy('created_at', 'asc'));
  }

  async listRequests(status?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('commercial.supplier_payment_account_change_requests as r')
        .join('catalog.suppliers as s', 's.id', 'r.supplier_id')
        .select('r.*', 's.name as supplier_name');
      if (status) b.where('r.status', status); else b.where('r.status', 'pending_approval');
      return b.orderBy('r.requested_at', 'desc');
    });
  }

  /** Sube el JPG/PDF de la solicitud de pago (evita errores de captura contra la factura/recibo). */
  async uploadAttachment(dataUri: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    try {
      const f = await this.storage.putFile(dataUri, `commercial/${tenantId}/supplier-payment-accounts`);
      return { url: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e;
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  async createRequest(dto: CreateAccountChangeRequestDto, username: string) {
    if (!dto.reason?.trim()) throw new BadRequestException('reason es requerido — el cambio de cuenta necesita justificación');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const supplier = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: dto.supplier_id }).first();
      if (!supplier) throw new NotFoundException('Proveedor no encontrado');
      if (dto.account_id) {
        const acc = await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, id: dto.account_id, supplier_id: dto.supplier_id }).first();
        if (!acc) throw new NotFoundException('Cuenta no encontrada para este proveedor');
      } else if (!dto.deactivate && !dto.proposed_bank_name?.trim()) {
        throw new BadRequestException('proposed_bank_name es requerido para dar de alta una cuenta');
      }
      const [row] = await trx('commercial.supplier_payment_account_change_requests').insert({
        tenant_id: tenantId, supplier_id: dto.supplier_id, account_id: dto.account_id ?? null,
        deactivate: !!dto.deactivate,
        proposed_bank_name: dto.proposed_bank_name ?? null, proposed_account_number: dto.proposed_account_number ?? null,
        proposed_clabe: dto.proposed_clabe ?? null, proposed_alias: dto.proposed_alias ?? null,
        proposed_attachment_url: dto.proposed_attachment_url ?? null, proposed_attachment_kind: dto.proposed_attachment_kind ?? null,
        proposed_es_favorita: !!dto.proposed_es_favorita, reason: dto.reason.trim(), requested_by: username,
      }).returning('*');
      return row;
    });
  }

  /** Desmarca cualquier otra cuenta favorita DE ESE PROVEEDOR (scope: supplier_id, no todo el tenant). */
  private async clearFavorita(trx: any, tenantId: string, supplierId: string) {
    await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, supplier_id: supplierId, es_favorita: true })
      .update({ es_favorita: false, updated_at: trx.fn.now() });
  }

  async approveRequest(id: string, username: string, decisionNotes: string | undefined) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const req = await trx('commercial.supplier_payment_account_change_requests').where({ tenant_id: tenantId, id }).first();
      if (!req) throw new NotFoundException('Solicitud no encontrada');
      if (req.status !== 'pending_approval') throw new BadRequestException('Solo se puede decidir una solicitud pendiente');

      if (req.deactivate && req.account_id) {
        await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, id: req.account_id }).update({ status: 'inactiva', updated_by: username, updated_at: trx.fn.now() });
      } else if (req.account_id) {
        if (req.proposed_es_favorita) await this.clearFavorita(trx, tenantId, req.supplier_id);
        await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, id: req.account_id }).update({
          bank_name: req.proposed_bank_name, account_number: req.proposed_account_number, clabe: req.proposed_clabe,
          alias: req.proposed_alias, attachment_url: req.proposed_attachment_url, attachment_kind: req.proposed_attachment_kind,
          es_favorita: req.proposed_es_favorita, updated_by: username, updated_at: trx.fn.now(),
        });
      } else {
        if (req.proposed_es_favorita) await this.clearFavorita(trx, tenantId, req.supplier_id);
        await trx('commercial.supplier_payment_accounts').insert({
          tenant_id: tenantId, supplier_id: req.supplier_id, bank_name: req.proposed_bank_name,
          account_number: req.proposed_account_number, clabe: req.proposed_clabe, alias: req.proposed_alias,
          attachment_url: req.proposed_attachment_url, attachment_kind: req.proposed_attachment_kind,
          es_favorita: req.proposed_es_favorita, created_by: username,
        });
      }

      const [updated] = await trx('commercial.supplier_payment_account_change_requests').where({ id }).update({
        status: 'applied', decided_by: username, decided_at: trx.fn.now(), decision_notes: decisionNotes ?? null, updated_at: trx.fn.now(),
      }).returning('*');
      return updated;
    });
  }

  async rejectRequest(id: string, username: string, decisionNotes: string | undefined) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const req = await trx('commercial.supplier_payment_account_change_requests').where({ tenant_id: tenantId, id }).first();
      if (!req) throw new NotFoundException('Solicitud no encontrada');
      if (req.status !== 'pending_approval') throw new BadRequestException('Solo se puede decidir una solicitud pendiente');
      const [updated] = await trx('commercial.supplier_payment_account_change_requests').where({ id }).update({
        status: 'rejected', decided_by: username, decided_at: trx.fn.now(), decision_notes: decisionNotes ?? null, updated_at: trx.fn.now(),
      }).returning('*');
      return updated;
    });
  }
}
