import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialInventoryService } from '../commercial-inventory/commercial-inventory.service';
import { classifyReceivingOrigin } from './receiving-origin';

/**
 * Fase WMS-REC (Pieza 1 — Modo recepción por escaneo / Vale vivo, ADR-044).
 *
 * El operador abre una sesión (Vale) desde una orden de entrada del ERP o manual,
 * escanea caja/pieza contra lo esperado, y el sistema le dice qué falta validar +
 * faltantes/sobrantes. Captura CANTIDADES (identidad física); la caducidad/lote la
 * audita la Pieza 2 (enlazada por source_ref = folio del Vale).
 *
 * **Al CERRAR el vale ("luz verde") la mercancía entra a inventario** en el lote
 * `NA` (sin fecha). La caducidad se captura después, en la bandeja de Caducidades:
 * poner la fecha RECLASIFICA ese `NA` a un lote fechado sin cambiar el total, así
 * que el invariante `SUM(stock_lots) = stock.quantity` nunca se rompe.
 *
 * El orden importa y es deliberado: el inventario refleja lo que está físicamente
 * en la bodega **desde que se aprueba la recepción**, no desde que alguien encuentra
 * tiempo para capturar fechas. La ventana sin caducidad no se esconde: se mide con
 * `undeclared_qty` y es justo la cola de trabajo del bodeguero.
 * (Cambio de ADR-044 — antes el alta ocurría al capturar el lote.)
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DiscrepancyKind = 'pending' | 'ok' | 'faltante' | 'sobrante' | 'producto_incorrecto' | 'dañado';

export interface OpenSessionDto {
  /** Opcional cuando source_kind='erp_receipt': se deriva de la orden. */
  warehouse_id?: string;
  /** Rehacer un folio ya recibido (el vale anterior quedó mal). Salta el guard. */
  force?: boolean;
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
    private readonly inventory: CommercialInventoryService,
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
    const sourceKind = dto.source_kind || 'manual';
    if (sourceKind === 'erp_receipt' && (!dto.erp_sucursal || !dto.erp_folio))
      throw new BadRequestException('erp_receipt requiere sucursal + folio de la orden');
    // Desde una orden del ERP el almacén se DERIVA (crosswalk → espejo): el
    // operador no elige nada, solo teclea el folio. En modo manual sigue siendo
    // obligatorio porque no hay de dónde sacarlo.
    if (sourceKind !== 'erp_receipt' && !UUID.test(dto.warehouse_id || ''))
      throw new BadRequestException('warehouse_id inválido');
    if (dto.warehouse_id && !UUID.test(dto.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;

      // Para órdenes del ERP: resuelve la cabecera (folio completo + proveedor) desde el espejo.
      let erpHeader: any = null;
      if (sourceKind === 'erp_receipt') {
        erpHeader = await this.findErpHeader(trx, dto.erp_sucursal!, dto.erp_folio!);
        if (!erpHeader) throw new NotFoundException('No encontré una orden de entrada con ese folio en esa sucursal');
      }

      // Almacén: lo que mande el cliente, y si no, el que dice la orden del ERP.
      // GUARD: un folio del ERP se recibe UNA vez.
      //
      // El vale no escribe stock, pero la captura de lotes (Pieza 2) sí: si el mismo
      // folio se abre dos veces y ambos se capturan, entra el DOBLE de mercancía y no
      // se detecta hasta un conteo físico. No había nada que lo impidiera —ni unique
      // ni validación— y buscar por folio bajó tanto la fricción de abrir un vale que
      // el error pasó de improbable a fácil.
      //
      // Es un aviso, no un candado de schema: se puede forzar con `force: true` para
      // el caso legítimo (el vale anterior se canceló y hay que rehacerlo).
      if (erpHeader && !dto.force) {
        const previo = await trx('commercial.receiving_sessions')
          .where({ source_ref: `${erpHeader.sucursal}/${erpHeader.folio}` })
          .whereNot('status', 'cancelled')
          .orderBy('created_at', 'desc')
          .first('folio', 'status', 'created_at');
        if (previo)
          throw new ConflictException(
            `El folio ${erpHeader.sucursal}/${erpHeader.folio} ya se recibió en el vale ${previo.folio} (${previo.status}). ` +
              'Revisalo antes de volver a recibirlo; si de verdad hay que rehacerlo, cancelá el anterior.',
          );
      }

      const warehouseId = dto.warehouse_id || (erpHeader ? await this.resolveWarehouse(trx, erpHeader) : null);
      if (!warehouseId)
        throw new BadRequestException(
          'No pude determinar el almacén de destino: configurá el mapa sucursal→almacén ("Almacenes×sucursal")',
        );

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
          warehouse_id: warehouseId,
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
        // Los renglones `SER` son servicios (flete, maniobra): no son mercancía, no
        // se reciben ni se ubican. Se excluyen del vale y se muestran aparte en la ficha.
        const erpLines = await trx('analytics.erp_goods_receipt_lines')
          .where({ tenant_id: tenantId, sucursal: erpHeader.sucursal, folio: erpHeader.folio })
          .whereRaw(`COALESCE(TRIM(unidad),'') <> 'SER'`)
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
  /**
   * Almacén destino de una orden del ERP: primero el crosswalk configurado, si no
   * el que ya trae el espejo.
   *
   * Valida que el almacén EXISTA para este tenant antes de devolverlo: el espejo
   * `analytics.*` no tiene RLS y su `warehouse_id` puede haber quedado apuntando a
   * un almacén borrado o de otro tenant. Sin esta comprobación el insert reventaba
   * con un 500 por violación de FK en vez de un mensaje que se entienda.
   */
  private async resolveWarehouse(trx: any, erpHeader: any): Promise<string | null> {
    const exists = async (id: string | null | undefined) => {
      if (!id || !UUID.test(id)) return null;
      const w = await trx('commercial.warehouses').where({ id }).first('id');
      return w?.id || null;
    };
    const map = await trx('commercial.erp_sucursal_warehouse')
      .where('sucursal', erpHeader.sucursal)
      .first('warehouse_id');
    return (await exists(map?.warehouse_id)) || (await exists(erpHeader.warehouse_id));
  }

  private async findErpHeader(trx: any, sucursal: string, folioInput: string) {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const f = String(folioInput || '').trim();
    if (!f) return null;
    let row = await trx('analytics.erp_goods_receipts')
      .where({ tenant_id: tenantId, sucursal }).where('folio', f)
      .first('sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'monto', 'receipt_date', 'warehouse_id');
    if (!row) {
      row = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, sucursal })
        .whereRaw('RIGHT(folio, ?) = ?', [f.length, f])
        .orderBy('receipt_date', 'desc')
        .first('sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'monto', 'receipt_date', 'warehouse_id');
    }
    return row || null;
  }

  /**
   * Busca una orden de entrada del ERP (para el diálogo "Nueva sesión"): devuelve el
   * folio completo, el proveedor (autollenado) y cuántas líneas trae. Por últimos dígitos.
   */
  /**
   * Busca órdenes de entrada del ERP **solo por folio**, en todas las sucursales.
   *
   * El folio de Kepler es por sucursal, así que el mismo número existe en varias
   * (verificado en prod: `0000001` vive en 7). Por eso devuelve una LISTA para que
   * el operador elija, en vez de adivinar una. Excluye los vales marcados como
   * duplicado (`dup_of_folio`), que son réplicas del feed y no entradas reales.
   *
   * Todo lo que necesita el vale sale de acá: no hace falta preguntar sucursal ni
   * almacén — se derivan de la orden elegida.
   */
  async searchErpOrders(folio: string, limit = 20) {
    const f = String(folio || '').trim();
    if (!/^\d{1,}$/.test(f)) throw new BadRequestException('Escribí el folio (solo dígitos)');
    const tenantId = this.tenantCtx.get()?.tenantId || null;

    return this.tk.run(async (trx) => {
      // `analytics.*` no tiene RLS → el tenant va explícito (GOTCHAS §1).
      const rows = await trx('analytics.erp_goods_receipts as r')
        .where({ 'r.tenant_id': tenantId })
        .whereNull('r.dup_of_folio')
        .where((b: any) => b.where('r.folio', f).orWhereRaw('RIGHT(r.folio, ?) = ?', [f.length, f]))
        .leftJoin('commercial.erp_sucursal_warehouse as m', function () {
          this.on('m.tenant_id', '=', 'r.tenant_id').andOn('m.sucursal', '=', 'r.sucursal');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'r.tenant_id').andOn('w.id', '=', trx.raw('COALESCE(m.warehouse_id, r.warehouse_id)'));
        })
        .orderBy('r.receipt_date', 'desc')
        .limit(Math.min(50, Math.max(1, Number(limit) || 20)))
        .select(
          'r.sucursal', 'r.folio', 'r.receipt_date',
          'r.proveedor_code', 'r.proveedor_nombre', 'r.proveedor_rfc',
          'r.oc_folio', 'r.vale_folio', 'r.concepto', 'r.monto',
          'w.id as warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          // Renglones de MERCANCÍA (los `SER` son fletes/maniobras, no se reciben).
          trx.raw(`(SELECT COUNT(*) FROM analytics.erp_goods_receipt_lines l
                     WHERE l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal
                       AND l.folio = r.folio AND COALESCE(TRIM(l.unidad),'') <> 'SER')::int AS line_count`),
          trx.raw(`(SELECT COUNT(*) FROM analytics.erp_goods_receipt_lines l
                     WHERE l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal
                       AND l.folio = r.folio AND TRIM(l.unidad) = 'SER')::int AS service_count`),
        );

      return rows.map((r: any) => {
        // Una sola definición de "de dónde viene" (receiving-origin.ts), acá y en
        // el detalle del vale. Antes vivía inline sólo en esta búsqueda, así que
        // al ABRIR el vale la pantalla ya no sabía si era traspaso o compra —
        // justo cuando el operario lo necesita para saber a quién reclamar.
        const origin = classifyReceivingOrigin(r.proveedor_code, r.proveedor_nombre);
        return {
          ...r,
          monto: Number(r.monto) || 0,
          origin,
          // `tipo` se conserva por compatibilidad con lo que ya lo consume.
          tipo: origin.kind === 'transfer' ? 'traspaso' : 'compra',
        };
      });
    });
  }

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

      // ── LUZ VERDE: la mercancía confirmada entra a inventario ──────────────
      //
      // Un movimiento 'in' por renglón recibido, en el lote 'NA' (sin fecha). El
      // trigger trg_rebalance_stock_lots mantiene el invariante solo; la fecha se
      // agrega después en Caducidades reclasificando NA → lote fechado.
      //
      // Idempotente sin columna nueva: si ya existen movimientos de esta sesión en
      // el ledger, el stock ya se dio de alta y no se repite. Así un reintento del
      // cierre (timeout, doble clic) no duplica existencia.
      const yaDadoDeAlta = await trx('commercial.stock_movements')
        .where({ reference_type: 'receiving_session', reference_id: sessionId })
        .first('id');

      if (!yaDadoDeAlta) {
        // Se descuenta lo que una captura de lote ya haya dado de alta ANTES del
        // cierre (la pantalla del auditor permite capturar con el vale abierto). Sin
        // esto, capturar primero y cerrar después contaría la mercancía dos veces.
        const recibidos = await trx('commercial.receiving_lines as l')
          .where('l.session_id', sessionId)
          .whereNotNull('l.product_id')
          .where('l.received_qty', '>', 0)
          .select(
            'l.product_id',
            'l.received_qty',
            trx.raw(`COALESCE((
              SELECT SUM(c.quantity)
                FROM commercial.receiving_lot_captures c
                JOIN commercial.stock_movements m ON m.id = c.stock_movement_id
               WHERE c.receiving_line_id = l.id
                 AND m.movement_type = 'in'
            ), 0)::numeric AS ya_dado_de_alta`),
          );

        for (const l of recibidos) {
          const falta = Number(l.received_qty) - Number(l.ya_dado_de_alta || 0);
          if (falta <= 0) continue;
          await this.inventory.recordMovementInTx(trx, {
            warehouse_id: session.warehouse_id,
            product_id: l.product_id,
            movement_type: 'in',
            quantity: falta,
            reference_type: 'receiving_session',
            reference_id: sessionId,
            notes: `Recepción ${session.folio}${session.source_ref ? ` · ERP ${session.source_ref}` : ''}`,
          });
        }
        this.logger.log(
          `Vale ${session.folio}: ${recibidos.length} renglón(es) dados de alta en ${session.warehouse_id}`,
        );

        // Lo que se recibió pero no tiene producto del catálogo queda FUERA del alta.
        // Se avisa fuerte: es mercancía física que el inventario no va a conocer.
        const huerfanos = await trx('commercial.receiving_lines')
          .where({ session_id: sessionId })
          .whereNull('product_id')
          .where('received_qty', '>', 0)
          .count({ n: '*' })
          .first();
        const nHuerfanos = Number((huerfanos as any)?.n || 0);
        if (nHuerfanos > 0)
          this.logger.warn(
            `Vale ${session.folio}: ${nHuerfanos} renglón(es) recibidos SIN producto en el catálogo — ` +
              'esa mercancía NO entró a inventario. Hay que darla de alta en el catálogo y recibirla aparte.',
          );
      }

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

  /**
   * BANDEJA DE CADUCIDADES — la mercancía que ya pasó la luz verde y no tiene fecha.
   *
   * Un renglón entra a la bandeja cuando la recepción se aprobó (`closed`) pero
   * `SUM(capturas de lote) < received_qty`: eso es existencia real en la bodega SIN
   * trazabilidad de caducidad, y es exactamente la cola de trabajo del bodeguero.
   *
   * Se ordena por antigüedad: lo que lleva más días esperando primero, porque el
   * riesgo crece con el tiempo (mercancía en anaquel de la que nadie sabe cuándo vence).
   *
   * Todo derivado: ni tabla ni columna nuevas.
   */
  async pendingExpiry(query: { warehouse_id?: string; limit?: number } = {}) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));

    return this.tk.run(async (trx) => {
      let q = trx('commercial.receiving_lines as l')
        .join('commercial.receiving_sessions as s', function () {
          this.on('s.tenant_id', '=', 'l.tenant_id').andOn('s.id', '=', 'l.session_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('s.status', 'closed')
        .whereNotNull('l.product_id')
        .where('l.received_qty', '>', 0);
      if (query.warehouse_id) q = q.where('s.warehouse_id', query.warehouse_id);

      const rows = await q
        .select(
          'l.id as line_id',
          'l.product_id',
          'p.sku',
          'p.nombre as product_name',
          'l.received_qty',
          's.id as session_id',
          's.folio as vale_folio',
          's.source_ref',
          's.supplier_code',
          's.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          's.closed_at',
          // Declarado = SÓLO lo aceptado, que es lo que de verdad quedó con lote
          // fechado en existencia. Contar también lo retenido haría que la bandeja
          // dijera "ya está fechado" sobre mercancía que ningún lote registra.
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'accepted'
          ), 0)::numeric AS declared_qty`),
          // Retenido = capturado con fecha pero 🔴, esperando que un supervisor
          // autorice. No se le vuelve a pedir fecha al bodeguero (ya la puso) pero
          // tampoco se declara resuelto: se muestra para que alguien lo persiga.
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'pending_authorization'
          ), 0)::numeric AS held_qty`),
          trx.raw(`GREATEST(0, (CURRENT_DATE - s.closed_at::date))::int AS dias_esperando`),
        )
        .orderBy('s.closed_at', 'asc')
        .limit(limit);

      // El filtro "le falta fecha" se aplica sobre el derivado (no se puede en WHERE
      // sin repetir la subconsulta) y se calcula el faltante real por renglón.
      return rows
        .map((r: any) => {
          const recibido = Number(r.received_qty) || 0;
          const declarado = Number(r.declared_qty) || 0;
          const retenido = Number(r.held_qty) || 0;
          return {
            ...r,
            received_qty: recibido,
            declared_qty: declarado,
            held_qty: retenido,
            pending_qty: Math.max(0, recibido - declarado - retenido),
          };
        })
        // Un renglón sale de la bandeja cuando ya no le falta fecha a nadie, pero
        // sigue apareciendo si tiene retenidos: eso es trabajo abierto de otra persona.
        .filter((r: any) => r.pending_qty > 0 || r.held_qty > 0);
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
          // Unidad TAL CUAL la manda el vale del ERP (PAQ/PZA/KG/CJA/BTO/CUB…).
          // Se DERIVA del espejo en vez de copiarla a una columna: el vale ya guarda
          // `source_ref = sucursal/folio` y el renglón su `expected_sku`, y se verificó
          // en prod que un mismo SKU dentro de un vale nunca trae dos unidades
          // distintas (0 casos ambiguos de 89,167), así que el join es determinista.
          // El centinela de ambigüedad es la palabra 'ambigua', NO un signo de
          // interrogación: knex trata ese signo como binding aunque esté entre
          // comillas SQL — y también dentro de un comentario `--` del propio raw
          // (GOTCHAS §5). Ambas variantes tiraban "Expected 2 bindings, saw 3".
          trx.raw(
            `(SELECT CASE
                       -- Si ese SKU trae MÁS DE UNA unidad dentro del mismo vale, el join
                       -- deja de ser determinista. Hoy no pasa (0 casos de 89,167 pares
                       -- en prod), pero es una propiedad del DATO, no del modelo: llega el
                       -- día que un vale traiga 2 cajas + 5 piezas del mismo producto.
                       -- Antes que elegir una en silencio, se declara ambigua y se ve.
                       WHEN COUNT(DISTINCT TRIM(el.unidad)) > 1 THEN 'ambigua'
                       ELSE MIN(TRIM(el.unidad))
                     END
                FROM analytics.erp_goods_receipt_lines el
               WHERE el.tenant_id = l.tenant_id
                 AND el.sucursal = split_part(?, '/', 1)
                 AND el.folio    = split_part(?, '/', 2)
                 AND el.sku      = l.expected_sku) AS expected_unit`,
            [session.source_ref || '', session.source_ref || ''],
          ),
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
        // Renglones recibidos cuyo SKU no existe en el catálogo: al dar luz verde
        // esa mercancía NO entra a inventario. En prod es raro (23 de 89,257
        // renglones históricos) pero pasa, y callarlo deja existencia física que el
        // sistema no conoce. Se cuenta para poder decirlo.
        sin_catalogo: lines.filter((l) => !l.product_id && Number(l.received_qty) > 0).length,
      };
      // Ficha del vale del ERP — DERIVADA, no copiada (ERP_KEPLER §5.1): con el
      // `source_ref` alcanza para traer proveedor/RFC/OC/concepto/monto al vuelo.
      let erp: Record<string, unknown> | null = null;
      if (session.source_kind === 'erp_receipt' && session.source_ref) {
        const [suc, fol] = String(session.source_ref).split('/');
        const tenantId = this.tenantCtx.get()?.tenantId || null;
        const h = await trx('analytics.erp_goods_receipts')
          .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
          .first(
            'sucursal', 'folio', 'doc_prefix', 'receipt_date', 'proveedor_code',
            'proveedor_nombre', 'proveedor_rfc', 'oc_folio', 'vale_folio',
            'concepto', 'monto',
          );
        if (h) {
          // Servicios del vale (flete/maniobra): se muestran, pero NO se reciben.
          const services = await trx('analytics.erp_goods_receipt_lines')
            .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
            .whereRaw(`TRIM(unidad) = 'SER'`)
            .select('nombre', 'cantidad', 'importe');
          erp = {
            ...h,
            monto: Number(h.monto) || 0,
            tipo: /^TI/i.test(h.proveedor_code || '') ? 'traspaso' : 'compra',
            services,
          };
        }
      }

      // De dónde viene la mercancía. En el andén son dos cosas distintas aunque
      // lleguen por la misma puerta: un faltante de PROVEEDOR se le reclama a él
      // y le pega en su scorecard; uno de TRASPASO se le reclama a la sucursal
      // que embarcó, y es de la casa.
      const origin = classifyReceivingOrigin(
        session.supplier_code,
        (erp as any)?.proveedor_nombre ?? null,
      );

      return { ...session, lines, progress, erp, origin };
    }
  }
}
