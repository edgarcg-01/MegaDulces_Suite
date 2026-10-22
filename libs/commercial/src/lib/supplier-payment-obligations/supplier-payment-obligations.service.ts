import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import type {
  DeudaProgramableResponse, ProgramarDocumentoDto, ProgramarDocumentoResultado,
} from '@megadulces/contracts';
import { armarDeudaProgramable, NOMBRE_DOCUMENTO_CXP, type FilaDeudaCruda } from './deuda-programable.engine';

export interface CreateSupplierObligationDto {
  supplier_id: string;
  purchase_order_id?: string | null;
  goods_receipt_id?: string | null;
  invoice_folio?: string | null;
  concept?: string | null;
  original_amount: number;
  original_due_date?: string | null;
  negotiated_date?: string | null;
  notes?: string | null;
}

/** `[PGP.6]` El nombre del documento, del mapa compartido del motor. */
const nombreDocumentoCxp = (tipo: number, sub: number): string =>
  NOMBRE_DOCUMENTO_CXP[`${tipo}/${sub}`] ?? `Documento ${tipo}/${sub}`;

/** Hoy en hora de México: la fecha de corte de «vencido» que publica el universo. */
const SQL_HOY = `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS al`;

/**
 * `[PGP.6]` La deuda viva de mercancía por documento, marcando cuál ya es obligación.
 *
 * El HAVING count(*) = 1 descarta los folios que aparecen con dos documentos distintos en la
 * misma sucursal: ahi no se puede saber cual se esta programando, y adivinar seria peor que
 * dejarlo fuera. Es el mismo criterio que usa TP.15.
 *
 * Orden: primero lo que no es dudoso (anterior_al_corte al final), despues lo mas vencido, y a
 * igualdad de dias lo de mas monto. Es el orden en que conviene decidir.
 */
const SQL_DEUDA_PROGRAMABLE = `
  WITH doc AS (
    SELECT p.sucursal, p.proveedor, max(p.proveedor_nombre) AS proveedor_nombre,
           min(p.doc_tipo) AS doc_tipo, min(p.doc_sub) AS doc_sub, p.folio,
           to_char(min(p.vencimiento), 'YYYY-MM-DD') AS vencimiento,
           min(p.dias_vencido) AS dias_vencido,
           bool_or(p.anterior_al_corte) AS anterior_al_corte,
           sum(p.pendiente) AS pendiente
      FROM analytics.v_supplier_payables p
     WHERE p.pendiente > 0 AND p.proveedor LIKE 'C%'
     GROUP BY p.sucursal, p.proveedor, p.folio
    HAVING count(*) = 1
  )
  SELECT d.sucursal, d.proveedor, d.proveedor_nombre, d.doc_tipo, d.doc_sub, d.folio,
         d.vencimiento, d.dias_vencido, d.anterior_al_corte, d.pendiente,
         s.id AS supplier_id,
         (o.id IS NOT NULL) AS programado
    FROM doc d
    LEFT JOIN catalog.suppliers s
           ON btrim(s.code) = btrim(d.proveedor) AND s.tenant_id = ?
    LEFT JOIN commercial.supplier_payment_obligations o
           ON o.tenant_id = ? AND o.status <> 'cancelled'
          AND o.kepler_sucursal = d.sucursal AND o.kepler_folio = d.folio
          AND o.kepler_doc_tipo = d.doc_tipo AND o.kepler_doc_sub = d.doc_sub
   ORDER BY d.anterior_al_corte ASC, d.dias_vencido DESC NULLS LAST, d.pendiente DESC`;

/**
 * `[PGP.6]` El saldo VIVO de un documento, leido en el momento de crear la obligacion.
 * Es la unica fuente del importe: el payload no lo trae.
 */
const SQL_SALDO_DOCUMENTO = `
  SELECT sum(p.pendiente) AS pendiente,
         to_char(min(p.vencimiento), 'YYYY-MM-DD') AS vencimiento
    FROM analytics.v_supplier_payables p
   WHERE p.sucursal = ? AND btrim(p.proveedor) = ? AND p.doc_tipo = ? AND p.doc_sub = ?
     AND btrim(p.folio) = ? AND p.pendiente > 0`;

/**
 * Fase TP.1 — Compras: obligaciones a proveedor de mercancía (ADR-064). La "cuenta por pagar"
 * que RA.15 no modela (esa cadena trackea unidades/costo pactado, no saldo con vencimiento
 * negociable). Opcionalmente ligada a `purchase_orders`/`goods_receipts`. El Calendario de Pagos
 * de Finanzas SOLO lee de acá.
 */
@Injectable()
export class SupplierPaymentObligationsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * `[PGP.6]` **La deuda viva que todavía no está programada**, para elegir qué pagar.
   *
   * No copia nada: lee el pendiente del ODS y marca cuál ya tiene obligación. La obligación se
   * crea de a una, en `programarDocumento()`.
   *
   * ⛔⛔ **Acá NO se filtra por sucursal, y no es un olvido.** Medido contra prod el 2026-10-22,
   * tres corridas de cada una: esta misma consulta sin filtro de sucursal cuesta **450–550 ms**;
   * agregándole `AND sucursal = <la del CEDIS>` cuesta **43.6–47.7 s**, y filtrando por sucursal
   * **afuera** de la vista cuesta **42.7–52.8 s**. O sea ~90x, y no es el predicado empujado
   * (afuera tarda igual). La causa exacta queda **NO DETERMINADA** y declarada en el plan de
   * fase; lo que está medido es que por ese camino no se pasa. Si alguna vez hace falta acotar
   * por sucursal, se acota **en TS sobre el resultado**, nunca en el SQL.
   *
   * ⚠️ **DEUDA DECLARADA, con nombre: esta consulta cuesta ~770 ms** sobre los 1,733 documentos
   * vivos, y el techo del proyecto para una pantalla es 500 ms. El costo **no es de esta
   * consulta**: medido por partes, `analytics.v_supplier_payables` sola ya cuesta 450–550 ms y
   * los joins agregan ~100 ms. Acelerarlo es trabajo sobre la vista —que tiene otros cuatro
   * consumidores— y va **aparte**, no escondido acá: optimizar es un commit distinto de cambiar
   * alcance de negocio. Mientras tanto la pantalla pagina y lo dice.
   */
  async listDeudaProgramable(q: { limit?: number }): Promise<DeudaProgramableResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit ?? 100)) || 100, 1), 1000);
    return this.tk.run(async (trx) => {
      const [{ rows: hoy }, r] = await Promise.all([
        trx.raw(SQL_HOY),
        trx.raw(SQL_DEUDA_PROGRAMABLE, [tenantId, tenantId]),
      ]);
      const filas: FilaDeudaCruda[] = r.rows ?? [];
      return armarDeudaProgramable(filas, { limit, al: String(hoy[0].al).slice(0, 10) });
    });
  }

  /**
   * `[PGP.6]` **Programa un documento del pendiente vivo**: crea su obligación para que el
   * Calendario pueda asignarle un día.
   *
   * ⭐⭐ **El importe NO viene del cliente: se lee del ODS dentro de la misma transacción.** Si
   * viniera en el payload, la pantalla podría mandar uno que ya no es cierto y nadie lo notaría
   * hasta pagar de más. `[TP.15]` midió esa trampa por la otra puerta: copiando el importe de la
   * entrega, **21 de 38 documentos ya no debían nada y 2 debían menos**.
   *
   * ⛔ Y no se crea una segunda obligación para el mismo documento: lo impide el índice
   * `ux_spo_kepler_doc` (`[PGP.5]`), y acá se devuelve `ya_existia` en vez de un error — dos
   * personas eligiendo la misma factura a la vez es un caso normal, no una falla.
   */
  async programarDocumento(dto: ProgramarDocumentoDto, username: string): Promise<ProgramarDocumentoResultado> {
    if (!dto?.sucursal?.trim()) throw new BadRequestException('sucursal es requerida');
    if (!dto?.proveedor?.trim()) throw new BadRequestException('proveedor es requerido');
    if (!dto?.folio?.trim()) throw new BadRequestException('folio es requerido');
    if (!Number.isFinite(Number(dto.doc_tipo)) || !Number.isFinite(Number(dto.doc_sub))) {
      throw new BadRequestException('doc_tipo y doc_sub son requeridos (la coordenada del documento en Kepler)');
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const args = [tenantId, dto.sucursal.trim(), dto.proveedor.trim(), Number(dto.doc_tipo), Number(dto.doc_sub), dto.folio.trim()];

    return this.tk.run(async (trx) => {
      const supplier = await trx('catalog.suppliers')
        .where({ tenant_id: tenantId })
        .whereRaw('btrim(code) = ?', [dto.proveedor.trim()])
        .first('id', 'name');
      if (!supplier) {
        throw new NotFoundException(
          `El acreedor ${dto.proveedor} no está en el catálogo de la suite: no se le puede crear una obligación. Se da de alta en Compras primero.`,
        );
      }

      const { rows: saldo } = await trx.raw(SQL_SALDO_DOCUMENTO, args.slice(1));
      if (saldo.length === 0 || !(Number(saldo[0].pendiente) > 0)) {
        // ⛔ Sin saldo NO es un error: el documento se pagó entre que se pintó la lista y el clic.
        return { resultado: 'sin_saldo', obligacion_id: null, importe: null, vencimiento: null };
      }
      const doc = saldo[0];

      const ya = await trx('commercial.supplier_payment_obligations')
        .where({ tenant_id: tenantId, kepler_sucursal: dto.sucursal.trim(), kepler_folio: dto.folio.trim(),
                 kepler_doc_tipo: Number(dto.doc_tipo), kepler_doc_sub: Number(dto.doc_sub) })
        .whereNot('status', 'cancelled')
        .first('id', 'original_amount', 'original_due_date');
      if (ya) {
        return {
          resultado: 'ya_existia', obligacion_id: ya.id,
          importe: Number(ya.original_amount),
          vencimiento: ya.original_due_date ? String(ya.original_due_date).slice(0, 10) : null,
        };
      }

      const [row] = await trx('commercial.supplier_payment_obligations')
        .insert({
          tenant_id: tenantId,
          supplier_id: supplier.id,
          invoice_folio: dto.folio.trim(),
          concept: `${nombreDocumentoCxp(Number(dto.doc_tipo), Number(dto.doc_sub))} ${dto.sucursal.trim()}-${dto.folio.trim()}`,
          original_amount: Number(doc.pendiente),
          original_due_date: doc.vencimiento ?? null,
          notes: dto.motivo?.trim() || 'Programado desde el pendiente vivo de Kepler',
          // Elegir el documento para pagarlo ES la autorización para programarlo (ADR-064),
          // igual que aceptar el renglón de entrega lo es en `[TP.15]`.
          authorized_by: username, authorized_at: trx.fn.now(), created_by: username,
          kepler_sucursal: dto.sucursal.trim(), kepler_doc_tipo: Number(dto.doc_tipo),
          kepler_doc_sub: Number(dto.doc_sub), kepler_folio: dto.folio.trim(),
        })
        .returning(['id', 'original_amount', 'original_due_date']);

      return {
        resultado: 'creada', obligacion_id: row.id,
        importe: Number(row.original_amount),
        vencimiento: row.original_due_date ? String(row.original_due_date).slice(0, 10) : null,
      };
    });
  }

  async list(q: { status?: string; search?: string; dueFrom?: string; dueTo?: string; supplier_id?: string; onlyCritical?: boolean }) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('commercial.supplier_payment_obligations as o')
        .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
        .select('o.*', 's.name as supplier_name', 's.code as supplier_code', 's.is_critical as supplier_critical', 's.critical_reason as supplier_critical_reason',
          trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'));
      if (q.status) b.where('o.status', q.status); else b.whereNotIn('o.status', ['cancelled']);
      if (q.supplier_id) b.where('o.supplier_id', q.supplier_id);
      if (q.onlyCritical) b.where('s.is_critical', true);
      if (q.search?.trim()) b.andWhere((w) => w.whereILike('s.name', `%${q.search!.trim()}%`).orWhereILike('o.invoice_folio', `%${q.search!.trim()}%`).orWhereILike('o.concept', `%${q.search!.trim()}%`));
      if (q.dueFrom) b.where('o.original_due_date', '>=', q.dueFrom);
      if (q.dueTo) b.where('o.original_due_date', '<=', q.dueTo);
      return b.orderByRaw('o.original_due_date ASC NULLS LAST');
    });
  }

  async get(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('commercial.supplier_payment_obligations').where({ id }).first());
    if (!row) throw new NotFoundException('Obligación a proveedor no encontrada');
    return row;
  }

  async create(dto: CreateSupplierObligationDto, username: string) {
    if (!dto.supplier_id) throw new BadRequestException('supplier_id es requerido');
    if (!(Number(dto.original_amount) > 0)) throw new BadRequestException('original_amount debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const supplier = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: dto.supplier_id }).first();
      if (!supplier) throw new NotFoundException('Proveedor no encontrado');
      const [row] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: tenantId,
        supplier_id: dto.supplier_id,
        purchase_order_id: dto.purchase_order_id ?? null,
        goods_receipt_id: dto.goods_receipt_id ?? null,
        invoice_folio: dto.invoice_folio ?? null,
        concept: dto.concept ?? null,
        original_amount: dto.original_amount,
        original_due_date: dto.original_due_date ?? null,
        negotiated_date: dto.negotiated_date ?? null,
        notes: dto.notes ?? null,
        authorized_by: username,
        created_by: username,
      }).returning('*');
      return row;
    });
  }

  async cancel(id: string, reason: string | undefined, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.supplier_payment_obligations').where({ tenant_id: tenantId, id }).first();
      if (!row) throw new NotFoundException('Obligación a proveedor no encontrada');
      if (Number(row.reserved_amount) > 0 || Number(row.paid_amount) > 0) {
        throw new BadRequestException('No se puede cancelar: tiene pagos reservados o ejecutados. Reprograma/cancela esos pagos primero.');
      }
      const [updated] = await trx('commercial.supplier_payment_obligations').where({ tenant_id: tenantId, id })
        .update({ status: 'cancelled', notes: reason ? `${row.notes ?? ''}\n[cancelado] ${reason}`.trim() : row.notes, updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return updated;
    });
  }

  /** Búsqueda ligera de proveedores para el selector de la obligación nueva. */
  async searchSuppliers(search?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('catalog.suppliers').select('id', 'name', 'code', 'is_critical', 'critical_reason').where('activo', true);
      if (search?.trim()) b.andWhereILike('name', `%${search.trim()}%`);
      return b.orderBy('name').limit(50);
    });
  }

  /**
   * Marca/desmarca un proveedor como crítico, SIEMPRE con motivo — nunca se infiere del importe
   * (regla explícita del pedido). Vive acá (no en `commercial-replenishment.service.ts`, código
   * vivo de RA en producción) para no arriesgar ese archivo bajo este cambio.
   */
  async setSupplierCritical(supplierId: string, isCritical: boolean, reason: string | undefined, username: string) {
    if (isCritical && !reason?.trim()) throw new BadRequestException('Marcar un proveedor como crítico requiere un motivo');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // NOTA: catalog.suppliers.updated_by es uuid (no texto) — no se toca desde acá, donde
      // solo tenemos el username. El motivo queda igual en critical_reason (auditable).
      const n = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId })
        .update({ is_critical: isCritical, critical_reason: isCritical ? reason!.trim() : null, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Proveedor no encontrado');
      return trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId }).select('id', 'name', 'is_critical', 'critical_reason').first();
    });
  }
}
