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
      throw new BadRequestException('erp_receipt requiere erp_sucursal + erp_folio');

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const year = new Date().getFullYear();
      const seqRes = await trx.raw(
        `INSERT INTO commercial.receiving_session_sequences (tenant_id, year, last_seq)
           VALUES (public.current_tenant_id(), ?, 1)
         ON CONFLICT (tenant_id, year)
           DO UPDATE SET last_seq = commercial.receiving_session_sequences.last_seq + 1
         RETURNING last_seq`,
        [year],
      );
      const seq = seqRes.rows[0].last_seq;
      const folio = `VE-${year}-${String(seq).padStart(5, '0')}`;

      const [session] = await trx('commercial.receiving_sessions')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio,
          warehouse_id: dto.warehouse_id,
          supplier_code: dto.supplier_code || null,
          source_kind: sourceKind,
          source_ref: sourceKind === 'erp_receipt' ? `${dto.erp_sucursal}/${dto.erp_folio}` : null,
          status: 'open',
          notes: dto.notes || null,
          created_by: userId,
        })
        .returning('*');

      // Precarga de líneas esperadas desde el espejo ERP (best-effort: mapea SKU Kepler → catalog).
      if (sourceKind === 'erp_receipt') {
        const erpLines = await trx('analytics.erp_goods_receipt_lines')
          .where({ tenant_id: this.tenantCtx.get()?.tenantId || null, sucursal: dto.erp_sucursal, folio: dto.erp_folio })
          .select('sku', 'nombre', 'cantidad');
        for (const el of erpLines) {
          const prod = el.sku
            ? await trx('public.products').where({ sku: String(el.sku) }).first('id')
            : null;
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
      return this.detail(session.id);
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
        prod = await trx('public.products').where('barcode', code).orWhere('sku', code).first('id', 'sku', 'nombre');
        if (!prod) throw new NotFoundException(`Sin producto para '${code}'`);
        productId = prod.id;
      }

      // Buscar línea existente del producto en la sesión.
      let line = await trx('commercial.receiving_lines')
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
      return this.detail(sessionId);
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
      return this.detail(sessionId);
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
        const code = String(dto.barcode).trim();
        prod = await trx('public.products').where('barcode', code).orWhere('sku', code).first('id', 'sku', 'nombre');
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
      return this.detail(sessionId);
    });
  }

  /** Cierra la sesión: finaliza discrepancias (pending con expected>0 → faltante). */
  async close(sessionId: string) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);
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
      return this.detail(sessionId);
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
      return this.detail(sessionId);
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
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions as s')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        })
        .where('s.id', sessionId)
        .select('s.*', 'w.code as warehouse_code', 'w.name as warehouse_name')
        .first();
      if (!session) throw new NotFoundException('Sesión no encontrada');

      const lines = await trx('commercial.receiving_lines as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('l.session_id', sessionId)
        .select(
          'l.id', 'l.product_id', 'p.sku', 'p.nombre as product_name',
          'l.expected_sku', 'l.expected_name', 'l.expected_qty', 'l.received_qty',
          'l.barcode_scanned', 'l.discrepancy_kind', 'l.notes',
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
      };
      return { ...session, lines, progress };
    });
  }
}
