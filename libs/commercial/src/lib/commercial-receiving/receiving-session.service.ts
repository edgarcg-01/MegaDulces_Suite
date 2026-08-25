import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase WMS-REC (Pieza 1 — Modo recepción por escaneo / Vale vivo, ADR-044).
 *
 * El operador abre una sesión (Vale) desde una orden de entrada del ERP o manual,
 * escanea caja/pieza contra lo esperado, y el sistema le dice qué falta validar +
 * faltantes/sobrantes. Captura CANTIDADES (identidad física); la caducidad/lote la
 * audita la Pieza 2 (enlazada por source_ref = folio del Vale).
 *
 * No escribe stock: es el registro de la realidad física recibida (reconciliable
 * contra el espejo ERP). El alta de stock/FEFO ocurre en la Pieza 2 al aceptar.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DiscrepancyKind = 'pending' | 'ok' | 'faltante' | 'sobrante' | 'producto_incorrecto' | 'dañado';

export interface OpenSessionDto {
  warehouse_id: string;
  supplier_code?: string;
  source_kind?: 'manual' | 'erp_receipt';
  /** Para source_kind='erp_receipt': (sucursal, folio) de analytics.erp_goods_receipts. */
  erp_sucursal?: string;
  erp_folio?: string;
  notes?: string;
}

export interface ScanDto {
  barcode?: string;
  product_id?: string;
  qty?: number; // default 1
}

@Injectable()
export class ReceivingSessionService {
  private readonly logger = new Logger(ReceivingSessionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Resuelve un código escaneado a UN producto SIN el anti-patrón "barcode OR sku + .first()"
   * (que en prod liga el producto equivocado: 279 barcodes dup + 57 colisiones sku↔barcode).
   * Prioridad: (1) barcode normalizado por unidad `catalog.product_barcodes` → sku (desambigua),
   * (2) sku exacto, (3) legacy products.barcode. Si el código sigue AMBIGUO (>1 producto), LANZA
   * en vez de tomar el primero. Ver feedback_everything_derivable_from_ods + auditoría 2026-08-25.
   */
  private async resolveProductByCode(trx: any, code: string): Promise<{ id: string; sku: string | null; nombre: string | null }> {
    const c = String(code || '').trim();
    if (!c) throw new BadRequestException('Se requiere barcode o sku');

    // (1) barcode normalizado por unidad → sku(s). La tabla puede no existir aún (no-regresivo).
    let bcSkus: string[] = [];
    const hasPB = (await trx.raw(`SELECT to_regclass('catalog.product_barcodes') IS NOT NULL AS ok`)).rows?.[0]?.ok;
    if (hasPB) {
      const rows = await trx('catalog.product_barcodes').where('barcode', c).whereNull('deleted_at').distinct('sku');
      bcSkus = rows.map((r: any) => String(r.sku));
    }

    // Candidatos = producto(s) por sku-del-barcode ∪ sku==code ∪ barcode==code.
    const cands = await trx('public.products')
      .whereNull('deleted_at')
      .andWhere((b: any) => {
        if (bcSkus.length) b.whereIn('sku', bcSkus);
        b.orWhere('sku', c).orWhere('barcode', c);
      })
      .distinct('id', 'sku', 'nombre');

    if (!cands.length) throw new NotFoundException(`Sin producto para '${c}'`);
    const distinct = Array.from(new Map(cands.map((r: any) => [r.id, r])).values());
    if (distinct.length > 1) {
      // El barcode normalizado manda: si apunta a UN solo producto, gana sobre la colisión sku.
      if (bcSkus.length === 1) {
        const only = distinct.filter((r: any) => r.sku === bcSkus[0]);
        if (only.length === 1) return only[0] as { id: string; sku: string | null; nombre: string | null };
      }
      throw new ConflictException(`Código '${c}' ambiguo: coincide con ${distinct.length} productos. Escaneá el código de barras específico o usá product_id.`);
    }
    return distinct[0] as { id: string; sku: string | null; nombre: string | null };
  }

  /** Recalcula la discrepancia de una línea desde expected vs received (no pisa overrides manuales). */
  static discrepancyFor(expected: number, received: number, manualOverride?: DiscrepancyKind): DiscrepancyKind {
    if (manualOverride === 'producto_incorrecto' || manualOverride === 'dañado') return manualOverride;
    if (received === 0 && expected > 0) return 'pending';
    if (received < expected) return 'faltante';
    if (received > expected) return 'sobrante';
    return 'ok'; // received === expected (y >0), o ambos 0
  }

  async open(dto: OpenSessionDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const sourceKind = dto.source_kind || 'manual';
    if (sourceKind === 'erp_receipt' && (!dto.erp_sucursal || !dto.erp_folio))
      throw new BadRequestException('erp_receipt requiere sucursal + folio de la orden');

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;

      // Para órdenes del ERP: resuelve la cabecera (folio completo + proveedor) desde el espejo.
      let erpHeader: any = null;
      if (sourceKind === 'erp_receipt') {
        erpHeader = await this.findErpHeader(trx, dto.erp_sucursal!, dto.erp_folio!);
        if (!erpHeader) throw new NotFoundException('No encontré una orden de entrada con ese folio en esa sucursal');
      }

      const year = new Date().getFullYear();
      const seqRes = await trx.raw(
        `INSERT INTO commercial.receiving_session_sequences (tenant_id, year, last_seq)
           VALUES (public.current_tenant_id(), ?, 1)
         ON CONFLICT (tenant_id, year)
           DO UPDATE SET last_seq = commercial.receiving_session_sequences.last_seq + 1
         RETURNING last_seq`,
        [year],
      );
      const folio = `VE-${year}-${String(seqRes.rows[0].last_seq).padStart(5, '0')}`;

      // El proveedor se AUTOLLENA desde la orden del ERP (código o razón social).
      const supplierCode = erpHeader
        ? (erpHeader.proveedor_code || erpHeader.proveedor_nombre || null)
        : (dto.supplier_code || null);

      const [session] = await trx('commercial.receiving_sessions')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio,
          warehouse_id: dto.warehouse_id,
          supplier_code: supplierCode,
          source_kind: sourceKind,
          source_ref: erpHeader ? `${erpHeader.sucursal}/${erpHeader.folio}` : null,
          status: 'open',
          notes: dto.notes || null,
          created_by: userId,
        })
        .returning('*');

      // Precarga de líneas esperadas desde el espejo ERP (mapea SKU Kepler → catálogo).
      if (erpHeader) {
        const tenantId = this.tenantCtx.get()?.tenantId || null;
        const erpLines = await trx('analytics.erp_goods_receipt_lines')
          .where({ tenant_id: tenantId, sucursal: erpHeader.sucursal, folio: erpHeader.folio })
          .select('sku', 'nombre', 'cantidad');
        for (const el of erpLines) {
          const prod = el.sku ? await trx('public.products').where({ sku: String(el.sku) }).first('id') : null;
          await trx('commercial.receiving_lines').insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            session_id: session.id,
            product_id: prod?.id || null,
            expected_sku: el.sku || null,
            expected_name: el.nombre || null,
            expected_qty: Number(el.cantidad) || 0,
            received_qty: 0,
            discrepancy_kind: 'pending',
          });
        }
      }
      return this.detailTx(trx, session.id);
    });
  }

  /**
   * Resuelve la cabecera de una orden de entrada del ERP por (sucursal, folio). Acepta
   * el folio COMPLETO o solo los últimos dígitos (búsqueda por sufijo, la más reciente).
   */
  private async findErpHeader(trx: any, sucursal: string, folioInput: string) {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const f = String(folioInput || '').trim();
    if (!f) return null;
    let row = await trx('analytics.erp_goods_receipts')
      .where({ tenant_id: tenantId, sucursal }).where('folio', f)
      .first('sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'monto', 'receipt_date');
    if (!row) {
      row = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, sucursal })
        .whereRaw('RIGHT(folio, ?) = ?', [f.length, f])
        .orderBy('receipt_date', 'desc')
        .first('sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'monto', 'receipt_date');
    }
    return row || null;
  }

  /**
   * Busca una orden de entrada del ERP (para el diálogo "Nueva sesión"): devuelve el
   * folio completo, el proveedor (autollenado) y cuántas líneas trae. Por últimos dígitos.
   */
  async lookupErpOrder(sucursal: string, folio: string) {
    const suc = String(sucursal || '').trim();
    const f = String(folio || '').trim();
    if (!suc) throw new BadRequestException('Indica la sucursal del ERP');
    if (!/^\d{2,}$/.test(f)) throw new BadRequestException('Indica al menos los últimos dígitos del folio');
    return this.tk.run(async (trx) => {
      const row = await this.findErpHeader(trx, suc, f);
      if (!row) throw new NotFoundException('No encontré una orden de entrada con ese folio en esa sucursal');
      const tenantId = this.tenantCtx.get()?.tenantId || null;
      const lc = await trx('analytics.erp_goods_receipt_lines')
        .where({ tenant_id: tenantId, sucursal: row.sucursal, folio: row.folio })
        .count('* as c').first();
      // Traspaso interno = código de "proveedor" con prefijo TI (sucursal propia,
      // Kepler 01-06 + Wincaja). Todo lo demás (prefijo C…) = compra a proveedor externo.
      const tipo = /^TI/i.test(row.proveedor_code || '') ? 'traspaso' : 'compra';
      // Almacén destino sugerido desde el crosswalk sucursal→almacén (si está configurado).
      const wh = await trx('commercial.erp_sucursal_warehouse as m')
        .join('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
        })
        .where('m.sucursal', row.sucursal)
        .first('w.id', 'w.code', 'w.name');
      return {
        sucursal: row.sucursal,
        folio: row.folio,
        proveedor_code: row.proveedor_code,
        proveedor_nombre: row.proveedor_nombre,
        monto: Number(row.monto) || 0,
        receipt_date: row.receipt_date,
        line_count: Number(lc?.c || 0),
        tipo,
        warehouse_id: wh?.id || null,
        warehouse_code: wh?.code || null,
        warehouse_name: wh?.name || null,
      };
    });
  }

  /** Mapa configurado sucursal ERP → almacén destino. */
  async getSucursalMap() {
    return this.tk.run(async (trx) =>
      trx('commercial.erp_sucursal_warehouse as m')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
        })
        .select('m.sucursal', 'm.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name')
        .orderBy('m.sucursal'),
    );
  }

  /** Configura (upsert) el almacén destino de una sucursal ERP. */
  async setSucursalMap(sucursal: string, warehouseId: string) {
    const suc = String(sucursal || '').trim();
    if (!suc) throw new BadRequestException('sucursal requerida');
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const wh = await trx('commercial.warehouses').where({ id: warehouseId }).first('id');
      if (!wh) throw new NotFoundException('Almacén no encontrado');
      await trx.raw(
        `INSERT INTO commercial.erp_sucursal_warehouse (tenant_id, sucursal, warehouse_id, updated_by)
           VALUES (public.current_tenant_id(), ?, ?, ?)
         ON CONFLICT (tenant_id, sucursal)
           DO UPDATE SET warehouse_id = EXCLUDED.warehouse_id, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [suc, warehouseId, userId],
      );
      return { sucursal: suc, warehouse_id: warehouseId };
    });
  }

  /** Escanea un código: resuelve producto y suma a su línea (o crea línea SOBRANTE). */
  async scan(sessionId: string, dto: ScanDto) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    const qty = Number(dto.qty) > 0 ? Number(dto.qty) : 1;
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);

      // Resolver producto por barcode o sku (public.products), o por product_id directo.
      let productId = dto.product_id || null;
      let prod: any = null;
      if (productId) {
        if (!UUID.test(productId)) throw new BadRequestException('product_id inválido');
        prod = await trx('public.products').where({ id: productId }).first('id', 'sku', 'nombre');
      } else {
        const code = String(dto.barcode || '').trim();
        if (!code) throw new BadRequestException('Se requiere barcode o product_id');
        prod = await this.resolveProductByCode(trx, code);
        productId = prod.id;
      }

      // Buscar línea existente del producto en la sesión.
      const line = await trx('commercial.receiving_lines')
        .where({ session_id: sessionId, product_id: productId })
        .forUpdate()
        .first();

      if (line) {
        const received = Number(line.received_qty) + qty;
        await trx('commercial.receiving_lines').where({ id: line.id }).update({
          received_qty: received,
          barcode_scanned: dto.barcode || line.barcode_scanned || null,
          discrepancy_kind: ReceivingSessionService.discrepancyFor(Number(line.expected_qty), received, line.discrepancy_kind),
          updated_at: trx.fn.now(),
        });
      } else {
        // No esperado → línea SOBRANTE.
        await trx('commercial.receiving_lines').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          session_id: sessionId,
          product_id: productId,
          expected_sku: prod?.sku || null,
          expected_name: prod?.nombre || null,
          expected_qty: 0,
          received_qty: qty,
          barcode_scanned: dto.barcode || null,
          discrepancy_kind: 'sobrante',
        });
      }
      return this.detailTx(trx, sessionId);
    });
  }

  /** Ajuste manual de una línea (cantidad recibida, discrepancia tipificada, notas). */
  async setLine(sessionId: string, lineId: string, patch: { received_qty?: number; discrepancy_kind?: DiscrepancyKind; notes?: string }) {
    if (!UUID.test(sessionId) || !UUID.test(lineId)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);
      const line = await trx('commercial.receiving_lines').where({ id: lineId, session_id: sessionId }).forUpdate().first();
      if (!line) throw new NotFoundException('Línea no encontrada');

      const received = patch.received_qty != null ? Number(patch.received_qty) : Number(line.received_qty);
      if (received < 0) throw new BadRequestException('received_qty no puede ser negativo');
      const manual = patch.discrepancy_kind && ['producto_incorrecto', 'dañado'].includes(patch.discrepancy_kind)
        ? patch.discrepancy_kind : undefined;
      await trx('commercial.receiving_lines').where({ id: lineId }).update({
        received_qty: received,
        discrepancy_kind: manual || ReceivingSessionService.discrepancyFor(Number(line.expected_qty), received),
        notes: patch.notes != null ? patch.notes : line.notes,
        updated_at: trx.fn.now(),
      });
      return this.detailTx(trx, sessionId);
    });
  }

  /** Agrega una línea ESPERADA manualmente (sesiones manuales). */
  async addLine(sessionId: string, dto: { product_id?: string; barcode?: string; expected_qty?: number }) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);

      let prod: any = null;
      if (dto.product_id) {
        if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
        prod = await trx('public.products').where({ id: dto.product_id }).first('id', 'sku', 'nombre');
      } else if (dto.barcode) {
        prod = await this.resolveProductByCode(trx, String(dto.barcode).trim());
      }
      if (!prod) throw new NotFoundException('Sin producto para la línea');

      const existing = await trx('commercial.receiving_lines').where({ session_id: sessionId, product_id: prod.id }).first();
      if (existing) throw new ConflictException('El producto ya está en la sesión');

      const expected = Number(dto.expected_qty) > 0 ? Number(dto.expected_qty) : 0;
      await trx('commercial.receiving_lines').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        session_id: sessionId,
        product_id: prod.id,
        expected_sku: prod.sku || null,
        expected_name: prod.nombre || null,
        expected_qty: expected,
        received_qty: 0,
        discrepancy_kind: 'pending',
      });
      return this.detailTx(trx, sessionId);
    });
  }

  /** Cierra la sesión: finaliza discrepancias (pending con expected>0 → faltante). */
  async close(sessionId: string) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);

      // ADR-044 — guard de cierre: un vale NO se cierra con mercancía retenida por un
      // rojo sin resolver. Cerrarlo declararía como recibido algo que nunca entró al
      // inventario (el rojo no escribe stock hasta que un supervisor autoriza).
      const held = await trx('commercial.receiving_lot_captures as c')
        .join('commercial.receiving_lines as l', function () {
          this.on('l.tenant_id', '=', 'c.tenant_id').andOn('l.id', '=', 'c.receiving_line_id');
        })
        .where('l.session_id', sessionId)
        .where('c.status', 'pending_authorization')
        .count({ n: '*' })
        .first();
      const heldCount = Number((held as any)?.n || 0);
      if (heldCount > 0)
        throw new ConflictException(
          `El vale tiene ${heldCount} captura(s) de lote pendientes de autorización: autorizá o rechazá antes de cerrar`,
        );

      const userId = this.tenantCtx.get()?.userId || null;

      await trx('commercial.receiving_lines')
        .where({ session_id: sessionId, discrepancy_kind: 'pending' })
        .where('expected_qty', '>', 0)
        .update({ discrepancy_kind: 'faltante', updated_at: trx.fn.now() });
      // pending con expected=0 y received=0 → ok (línea vacía)
      await trx('commercial.receiving_lines')
        .where({ session_id: sessionId, discrepancy_kind: 'pending' })
        .update({ discrepancy_kind: 'ok', updated_at: trx.fn.now() });

      await trx('commercial.receiving_sessions').where({ id: sessionId }).update({
        status: 'closed', closed_at: trx.fn.now(), closed_by: userId, updated_at: trx.fn.now(),
      });
      return this.detailTx(trx, sessionId);
    });
  }

  async cancel(sessionId: string) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status === 'closed') throw new ConflictException('No se puede cancelar una sesión cerrada');
      await trx('commercial.receiving_sessions').where({ id: sessionId }).update({
        status: 'cancelled', updated_at: trx.fn.now(),
      });
      return this.detailTx(trx, sessionId);
    });
  }

  async list(query: { status?: string; warehouse_id?: string; limit?: number }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
    return this.tk.run(async (trx) => {
      let q = trx('commercial.receiving_sessions as s')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        });
      if (query.status) q = q.where('s.status', query.status);
      if (query.warehouse_id) q = q.where('s.warehouse_id', query.warehouse_id);
      return q
        .select(
          's.id', 's.folio', 's.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          's.supplier_code', 's.source_kind', 's.source_ref', 's.status',
          's.created_at', 's.closed_at',
          trx.raw(`(SELECT COUNT(*) FROM commercial.receiving_lines l WHERE l.session_id = s.id) AS line_count`),
          trx.raw(`(SELECT COUNT(*) FROM commercial.receiving_lines l WHERE l.session_id = s.id AND l.discrepancy_kind IN ('faltante','sobrante','producto_incorrecto','dañado')) AS discrepancy_count`),
        )
        .orderBy('s.created_at', 'desc')
        .limit(limit);
    });
  }

  async detail(sessionId: string) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run((trx) => this.detailTx(trx, sessionId));
  }

  /**
   * Arma el detalle DENTRO de la transacción dada. Se usa desde open/scan/close/…
   * para no abrir una transacción anidada (otra conexión del pool NO vería los
   * cambios aún sin commitear → NotFoundException + rollback). Ver bug 2026-08-19.
   */
  private async detailTx(trx: any, sessionId: string) {
    {
      const session = await trx('commercial.receiving_sessions as s')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        })
        .where('s.id', sessionId)
        .select('s.*', 'w.code as warehouse_code', 'w.name as warehouse_name')
        .first();
      if (!session) throw new NotFoundException('Sesión no encontrada');

      // Cuadre de caducidad por renglón (ADR-044): `declared_qty` = Σ de las capturas
      // de lote ligadas al renglón, y `held_qty` = las que están retenidas por un rojo
      // sin autorizar (no entraron a stock). Se DERIVA, no se denormaliza.
      const lines = await trx('commercial.receiving_lines as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('l.session_id', sessionId)
        .select(
          'l.id', 'l.product_id', 'p.sku', 'p.nombre as product_name',
          'l.expected_sku', 'l.expected_name', 'l.expected_qty', 'l.received_qty',
          'l.barcode_scanned', 'l.discrepancy_kind', 'l.notes',
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status <> 'rejected'
          ), 0)::numeric AS declared_qty`),
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'pending_authorization'
          ), 0)::numeric AS held_qty`),
          trx.raw(`(
            SELECT COUNT(*) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'pending_authorization'
          )::int AS holds`),
        )
        .orderByRaw(`CASE l.discrepancy_kind WHEN 'pending' THEN 0 WHEN 'faltante' THEN 1 WHEN 'sobrante' THEN 2 ELSE 3 END`)
        .orderBy('l.created_at');

      const progress = {
        lines: lines.length,
        pending: lines.filter((l) => l.discrepancy_kind === 'pending').length,
        ok: lines.filter((l) => l.discrepancy_kind === 'ok').length,
        discrepancies: lines.filter((l) => ['faltante', 'sobrante', 'producto_incorrecto', 'dañado'].includes(l.discrepancy_kind)).length,
        expected_units: lines.reduce((a, l) => a + Number(l.expected_qty), 0),
        received_units: lines.reduce((a, l) => a + Number(l.received_qty), 0),
        // ADR-044 — el indicador que antes no existía: cuánto de lo recibido tiene
        // lote+caducidad declarados, y cuánto entró sin trazabilidad.
        declared_units: lines.reduce((a, l) => a + Number(l.declared_qty), 0),
        undeclared_units: lines.reduce(
          (a, l) => a + Math.max(0, Number(l.received_qty) - Number(l.declared_qty)),
          0,
        ),
        held_units: lines.reduce((a, l) => a + Number(l.held_qty), 0),
        holds: lines.reduce((a, l) => a + Number(l.holds), 0),
      };
      return { ...session, lines, progress };
    }
  }
}
