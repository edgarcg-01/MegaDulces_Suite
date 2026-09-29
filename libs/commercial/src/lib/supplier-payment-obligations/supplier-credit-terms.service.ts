import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import type {
  CreditTermBase, CreditTermsFilter, CreditTermsStatus, SupplierCreditTermsHistoryRow,
  SupplierCreditTermsResponse, SupplierCreditTermsRow, SupplierCreditTermsUpdated,
  UpdateSupplierCreditTermsDto,
} from '@megadulces/contracts';

/** Fila cruda del SQL (numeric/int llegan como string desde pg según el tipo). */
interface RawTermsRow {
  id: string; code: string; name: string;
  credit_days: number | string | null; credit_term_base: CreditTermBase | null;
  credit_terms_updated_by: string | null; credit_terms_updated_at: string | null;
  is_internal: boolean; internal_reason: string | null;
  monto: string | number | null; n: number | null; ultima: string | null;
  kepler_condicion: string | null; kepler_dias: number | string | null; kepler_variantes: number | null;
}

/** Tolerancia al comparar contra Kepler: su "30 días" es un MES de calendario (28–31), medido en RE.1. */
const KEPLER_TOLERANCE_DAYS = 3;
/** Ventana de lo recibido que ordena la lista de trabajo. */
const WINDOW_DAYS = 365;
/** Mismo rango que el CHECK `chk_suppliers_credit_days_range` de la migración. */
const MAX_CREDIT_DAYS = 365;

/**
 * `[RE.30]` — Plazo de pago por proveedor: cuántos días EXACTOS y desde cuándo corren (factura o
 * recepción). Es la mitad del vencimiento que Kepler no tiene bien: su condición sale "de contado" en
 * el 68% de las recepciones porque el plazo nunca se capturó allá.
 *
 * La lista es una LISTA DE TRABAJO de quien negocia (comprador / dirección): sólo proveedores con
 * recepciones en los últimos 12 meses, ordenados por lo recibido, con lo que Kepler dice al lado.
 * Lo recibido sale de `analytics.erp_goods_receipts` (vista viva sobre `kepler_ods`, 246 ms medido
 * en prod) y se limita a Kepler: los proveedores de Wincaja usan otro espacio de códigos y no casan
 * con el catálogo — declarado en la respuesta (`wincaja_excluded`), no escondido.
 */
@Injectable()
export class SupplierCreditTermsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async list(q: { filter?: CreditTermsFilter; search?: string }): Promise<SupplierCreditTermsResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const raw = await this.tk.run(async (trx) => {
      const res = await trx.raw(
        `WITH rec AS (
           SELECT r.proveedor_code,
                  sum(r.monto)                                        AS monto,
                  count(*)::int                                       AS n,
                  to_char(max(r.receipt_date), 'YYYY-MM-DD')          AS ultima,
                  mode() WITHIN GROUP (ORDER BY r.condicion_pago)     AS kepler_condicion,
                  mode() WITHIN GROUP (ORDER BY r.dias_credito)       AS kepler_dias,
                  count(DISTINCT r.condicion_pago)::int               AS kepler_variantes
             FROM analytics.erp_goods_receipts r
            WHERE r.tenant_id = :t
              AND r.source_branch LIKE 'md\\_%'
              AND r.dup_of_folio IS NULL
              AND r.receipt_date >= current_date - :win::int
            GROUP BY r.proveedor_code
         )
         SELECT s.id, btrim(s.code) AS code, s.name,
                s.credit_days, s.credit_term_base, s.credit_terms_updated_by, s.credit_terms_updated_at,
                s.is_internal, s.internal_reason,
                rec.monto, rec.n, rec.ultima, rec.kepler_condicion, rec.kepler_dias, rec.kepler_variantes
           FROM catalog.suppliers s
           JOIN rec ON rec.proveedor_code = btrim(s.code)
          WHERE s.tenant_id = :t AND s.deleted_at IS NULL
          ORDER BY rec.monto DESC NULLS LAST`,
        { t: tenantId, win: WINDOW_DAYS },
      );
      return res.rows as RawTermsRow[];
    });

    const all: SupplierCreditTermsRow[] = raw.map((r) => {
      const credit_days = r.credit_days == null ? null : Number(r.credit_days);
      const kepler_dias = r.kepler_dias == null ? null : Number(r.kepler_dias);
      const status: CreditTermsStatus = r.is_internal ? 'interno'
        : credit_days == null ? 'sin_plazo'
        : r.credit_terms_updated_at == null ? 'sin_confirmar'
        : 'confirmado';
      // Sólo se compara lo confirmado: comparar un valor que nadie validó no dice nada.
      const differs_from_kepler = status === 'confirmado' && credit_days != null && kepler_dias != null
        && ((credit_days === 0) !== (kepler_dias <= 0) || Math.abs(credit_days - kepler_dias) > KEPLER_TOLERANCE_DAYS);
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        credit_days,
        credit_term_base: r.credit_term_base ?? null,
        credit_terms_updated_by: r.credit_terms_updated_by ?? null,
        credit_terms_updated_at: r.credit_terms_updated_at ?? null,
        is_internal: !!r.is_internal,
        internal_reason: r.internal_reason ?? null,
        received_amount: Number(r.monto || 0),
        received_count: Number(r.n || 0),
        last_receipt: r.ultima ?? null,
        kepler_condition: r.kepler_condicion ?? null,
        kepler_days: kepler_dias,
        kepler_variants: Number(r.kepler_variantes || 0),
        status,
        differs_from_kepler,
      };
    });

    // Resumen sobre el universo COMPLETO (no el filtrado): es lo que dimensiona el trabajo.
    const pending = all.filter((r) => r.status === 'sin_plazo' || r.status === 'sin_confirmar');
    const pendingAmount = pending.reduce((a, r) => a + r.received_amount, 0);
    let acc = 0, to80 = 0;
    for (const r of pending) { if (acc >= pendingAmount * 0.8) break; acc += r.received_amount; to80++; }
    const count = (s: CreditTermsStatus) => all.filter((r) => r.status === s).length;

    const f: CreditTermsFilter = q.filter || 'pendientes';
    const term = q.search?.trim().toLowerCase();
    const rows = all.filter((r) => {
      if (f === 'pendientes' && !(r.status === 'sin_plazo' || r.status === 'sin_confirmar')) return false;
      if (f === 'difiere' && !r.differs_from_kepler) return false;
      if (f !== 'pendientes' && f !== 'difiere' && f !== 'todos' && r.status !== f) return false;
      if (term && !(r.name?.toLowerCase().includes(term) || r.code?.toLowerCase().includes(term))) return false;
      return true;
    });

    return {
      summary: {
        window_days: WINDOW_DAYS,
        suppliers: all.length,
        received_amount: all.reduce((a, r) => a + r.received_amount, 0),
        sin_plazo: count('sin_plazo'),
        sin_confirmar: count('sin_confirmar'),
        confirmado: count('confirmado'),
        interno: count('interno'),
        differs_from_kepler: all.filter((r) => r.differs_from_kepler).length,
        pending_amount: pendingAmount,
        pending_suppliers_for_80pct: to80,
        wincaja_excluded: true,
      },
      rows,
    };
  }

  async history(supplierId: string): Promise<SupplierCreditTermsHistoryRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('catalog.supplier_credit_terms_history')
      .where({ tenant_id: tenantId, supplier_id: supplierId })
      .select('id', 'supplier_id', 'old_credit_days', 'new_credit_days', 'old_credit_term_base', 'new_credit_term_base',
        'old_is_internal', 'new_is_internal', 'note', 'created_by', 'created_at')
      .orderBy('created_at', 'desc').limit(100));
  }

  async update(supplierId: string, dto: UpdateSupplierCreditTermsDto, username: string): Promise<SupplierCreditTermsUpdated> {
    const isInternal = !!dto.is_internal;
    const reason = dto.internal_reason?.trim() || null;
    let days: number | null = null;
    let base: CreditTermBase | null = null;

    if (isInternal) {
      if (!reason) throw new BadRequestException('Marcar un proveedor como interno requiere un motivo.');
    } else {
      if (dto.credit_days == null) throw new BadRequestException('Captura los días de crédito (0 = de contado).');
      days = Number(dto.credit_days);
      if (!Number.isInteger(days) || days < 0 || days > MAX_CREDIT_DAYS) {
        throw new BadRequestException(`Los días de crédito deben ser un entero entre 0 y ${MAX_CREDIT_DAYS}.`);
      }
      if (days > 0) {
        if (dto.credit_term_base !== 'factura' && dto.credit_term_base !== 'recepcion') {
          throw new BadRequestException('Indica desde cuándo corre el plazo: fecha de factura o fecha de recepción.');
        }
        base = dto.credit_term_base;
      }
    }

    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const prev = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId }).forUpdate().first();
      if (!prev) throw new NotFoundException('Proveedor no encontrado');

      // Interno: los días se CONSERVAN (no se borra un dato para marcar otro); no se usan mientras sea interno.
      const next = {
        credit_days: isInternal ? prev.credit_days : days,
        credit_term_base: isInternal ? prev.credit_term_base : base,
        is_internal: isInternal,
        internal_reason: isInternal ? reason : null,
      };
      const [row] = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId })
        .update({ ...next, credit_terms_updated_by: username, credit_terms_updated_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning(['id', 'code', 'name', 'credit_days', 'credit_term_base', 'credit_terms_updated_by', 'credit_terms_updated_at', 'is_internal', 'internal_reason']);

      // Mismo trx: si el historial no se escribe, el cambio tampoco (GOTCHAS §2).
      await trx('catalog.supplier_credit_terms_history').insert({
        tenant_id: tenantId,
        supplier_id: supplierId,
        old_credit_days: prev.credit_days,
        new_credit_days: next.credit_days,
        old_credit_term_base: prev.credit_term_base,
        new_credit_term_base: next.credit_term_base,
        old_is_internal: !!prev.is_internal,
        new_is_internal: next.is_internal,
        note: dto.note?.trim() || (isInternal ? reason : null),
        created_by: username,
      });
      return row as SupplierCreditTermsUpdated;
    });
  }
}
