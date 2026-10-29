import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ObjectStorageService } from '@megadulces/platform-core';
import type { CuentasPagoFaltantesResponse, CuentaPagoPropuesta } from '@megadulces/contracts';
import { repartirFaltantes } from './missing-accounts.engine';

/**
 * `[PGP.20]` Tipos del boundary. Nacen al mudar el modulo de `commercial` a `finance`: el gate
 * ve el archivo renombrado como nuevo y exige tipar lo que antes pasaba como deuda heredada.
 * Se declara lo que la tabla tiene y la pantalla usa; `select *` puede traer mas columnas.
 */
export interface SupplierPaymentAccountRow {
  id: string;
  supplier_id: string;
  bank_name: string | null;
  account_number: string | null;
  clabe: string | null;
  alias: string | null;
  notes: string | null;
  attachment_url: string | null;
  attachment_kind: string | null;
  es_favorita: boolean;
  status: string;
  created_at: string;
}

/** Una solicitud de alta/cambio/baja, con el nombre del proveedor ya resuelto para la bandeja. */
export interface SupplierPaymentAccountRequestRow {
  id: string;
  supplier_id: string;
  supplier_name: string | null;
  account_id: string | null;
  status: string;
  reason: string | null;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
}

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

/** La ventana real que se midió, para que la pantalla la pueda decir. Siempre devuelve una fila. */
export const SQL_RANGO = `
  SELECT to_char(((now() AT TIME ZONE 'America/Mexico_City')::date - (?::int || ' days')::interval)::date, 'YYYY-MM-DD') AS desde,
         to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD')                                          AS hasta`;

/**
 * `[PGP.1]` Un renglón por proveedor al que se le pagó **por banco** en la ventana, diga o no
 * el catálogo quién es, tenga o no cuenta. El filtrado y los porcentajes se hacen arriba, en TS,
 * porque el denominador es el total de TODOS y no se puede recortar acá sin inflarlo.
 *
 * ⛔ `medio_pago` (de `c45`, la cuenta de tesorería), NUNCA `metodo_pago` (de `c31`, el tipo de
 * documento): `metodo_pago` marca "Transferencia" 2,682 pagos / $52.26M que salieron en efectivo.
 *
 * ⚠️ `LEFT JOIN` a propósito: el proveedor que no resuelve al catálogo se CUENTA y se declara.
 * Con `JOIN` desaparecería en silencio y la lista diría que no falta nadie más.
 */
export const SQL_FALTANTES = `
  WITH pagos AS (
    SELECT p.proveedor_code,
           max(p.proveedor_nombre)                                        AS nombre,
           sum(p.monto)                                                   AS monto,
           count(*)                                                       AS pagos,
           to_char(max(p.pago_date), 'YYYY-MM-DD')                        AS ultimo_pago_date,
           max(p.computed_at)                                             AS computed_at,
           (array_agg(p.monto ORDER BY p.pago_date DESC, p.folio DESC))[1] AS ultimo_pago_monto
      FROM analytics.erp_supplier_payments p
     WHERE p.pago_date >= ((now() AT TIME ZONE 'America/Mexico_City')::date - (?::int || ' days')::interval)::date
       AND p.pago_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
       AND p.medio_pago = 'banco'
     GROUP BY 1
  )
  SELECT pg.proveedor_code, pg.nombre, pg.monto, pg.pagos, pg.ultimo_pago_date, pg.ultimo_pago_monto, pg.computed_at,
         s.id AS supplier_id,
         EXISTS (SELECT 1 FROM commercial.supplier_payment_accounts a
                  WHERE a.supplier_id = s.id AND a.status = 'activa') AS tiene_cuenta
    FROM pagos pg
    LEFT JOIN catalog.suppliers s
           ON btrim(s.code) = btrim(pg.proveedor_code) AND s.tenant_id = ?
   ORDER BY pg.monto DESC`;

/**
 * `[PGP.29]` Una fila por ACREEDOR (no por sucursal: `kdxd` está replicado ×9) con la cuenta que
 * él mismo declaró. `DISTINCT ON` se queda con la sucursal que SÍ pudo proponer, para que una
 * copia muda de la ficha no tape a la que trae el dato.
 *
 * ⛔ Se deja fuera `sin_rep`: son 431 acreedores que nunca timbraron un comprobante de pago, y
 *    listarlos acá sería repetir la tabla de «a quién le falta cuenta» con una columna vacía.
 */
export const SQL_PROPUESTAS = `
  SELECT DISTINCT ON (p.proveedor_code)
         btrim(p.proveedor_code)                                   AS codigo,
         s.id                                                      AS supplier_id,
         coalesce(s.name, p.proveedor_nombre)                      AS nombre,
         p.estado, p.clabe_propuesta, p.banco_codigo, p.banco_rfc,
         p.rep_uuid,
         p.veces_declarada::int                                    AS veces_declarada,
         to_char(p.ultima_vez, 'YYYY-MM-DD')                       AS ultima_vez,
         p.rfc, p.rfc_fuente, p.rfc_discrepa, p.rfc_via, p.motivo
    FROM analytics.v_supplier_account_proposal p
    LEFT JOIN catalog.suppliers s
           ON btrim(s.code) = btrim(p.proveedor_code) AND s.tenant_id = ?
   WHERE p.estado <> 'sin_rep'
   ORDER BY p.proveedor_code,
            (p.estado = 'propuesta') DESC,
            p.veces_declarada DESC NULLS LAST,
            p.sucursal`;

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

  /**
   * `[PGP.1]` **A quién le falta cuenta de pago, ordenado por el dinero que destraba.**
   *
   * El medio de pago sale de `medio_pago` (derivado de `c45`, la cuenta de tesorería), **no de
   * `metodo_pago`**: ése viene de `c31`, que es el TIPO DE DOCUMENTO, y marca como
   * "Transferencia" 2,682 pagos / $52.26M que salieron en efectivo.
   *
   * El universo se publica entero (ADR-056): sin él, «faltan 169» no se puede verificar. Los
   * proveedores que no resuelven al catálogo **se cuentan aparte** en vez de desaparecer en el
   * `LEFT JOIN` — son trabajo que esta pantalla no puede destrabar.
   */
  /**
   * `[PGP.29]` (objetivo **O6**) — **La cuenta que cada acreedor YA declaró en su propio REP.**
   *
   * ⭐ Lo que esto resuelve es por qué el catálogo tiene 0 filas: el botón «Solicitar cuenta»
   * abría un formulario vacío y alguien tenía que ir a conseguir la CLABE. Acá ya está, firmada
   * por el proveedor ante el SAT, con su evidencia.
   *
   * ⛔ **Una fila por acreedor, no por sucursal.** `kepler_ods.kdxd` está replicado ×9, así que
   *    la vista trae 221 filas para 22 acreedores proponibles. Agrupar acá y no allá es a
   *    propósito: la vista responde «por acreedor Y sucursal», que es lo que el Calendario
   *    necesita; esta pantalla trabaja por acreedor.
   * ⛔ **Se devuelve sólo lo que tiene algo que decir** (`estado <> 'sin_rep'`): los 431 que
   *    nunca timbraron un REP no son trabajo, son ruido, y la pantalla ya los lista en
   *    «a quién le falta cuenta».
   * ⚠️ **Es una llamada DIFERIDA**: la vista encadena `analytics.v_supplier_rfc`, que recorre
   *    los CFDI recibidos. Medida el 2026-10-28 **sin** el índice de `[PGP.27]`: **9.2 s**.
   *    **NO MEDIDO** con el índice puesto. Por eso la pantalla pinta primero y la propuesta
   *    aparece después, sin bloquear nada.
   */
  async listAccountProposals(): Promise<CuentaPagoPropuesta[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(SQL_PROPUESTAS, [tenantId]);
      return rows as CuentaPagoPropuesta[];
    });
  }

  async listMissingAccounts(dias = 120): Promise<CuentasPagoFaltantesResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const d = Number.isFinite(dias) ? Math.min(Math.max(Math.trunc(dias), 1), 1095) : 120;
    return this.tk.run(async (trx) => {
      const [rango, r] = await Promise.all([trx.raw(SQL_RANGO, [d]), trx.raw(SQL_FALTANTES, [d, tenantId])]);
      const { desde, hasta } = rango.rows[0];
      return repartirFaltantes(r.rows ?? [], { dias: d, desde, hasta });
    });
  }

  async listAccounts(supplierId: string): Promise<SupplierPaymentAccountRow[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) =>
      trx('commercial.supplier_payment_accounts').where({ supplier_id: supplierId, status: 'activa' })
        .orderBy('es_favorita', 'desc').orderBy('created_at', 'asc'));
  }

  async listRequests(status?: string): Promise<SupplierPaymentAccountRequestRow[]> {
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
  async uploadAttachment(dataUri: string): Promise<{ url: string; kind: string }> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    try {
      const f = await this.storage.putFile(dataUri, `commercial/${tenantId}/supplier-payment-accounts`);
      return { url: f.key, kind: f.kind };
    } catch (e: unknown) {
      if ((e as { status?: number } | null)?.status === 400) throw e;
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  async createRequest(dto: CreateAccountChangeRequestDto, username: string): Promise<SupplierPaymentAccountRequestRow> {
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
  private async clearFavorita(trx: Knex.Transaction, tenantId: string, supplierId: string): Promise<void> {
    await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, supplier_id: supplierId, es_favorita: true })
      .update({ es_favorita: false, updated_at: trx.fn.now() });
  }

  async approveRequest(id: string, username: string, decisionNotes: string | undefined): Promise<SupplierPaymentAccountRequestRow> {
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

  async rejectRequest(id: string, username: string, decisionNotes: string | undefined): Promise<SupplierPaymentAccountRequestRow> {
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
