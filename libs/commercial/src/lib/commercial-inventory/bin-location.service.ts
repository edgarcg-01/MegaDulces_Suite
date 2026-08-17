import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase WMS-REC (Pieza 3 — Ubicación bin-level lote×posición, ADR-044).
 *
 * Administra los bins (posiciones físicas) y el AUXILIAR DE UBICACIONES
 * (commercial.stock_lot_locations): cuánta cantidad de cada (producto, lote,
 * caducidad) está en cada bin. Regla: SUM(ubicado por lote) ≤ stock_lots.quantity;
 * el remanente = "por ubicar". FEFO físico: dirige el surtido al bin que caduca antes.
 *
 * No mueve stock (el saldo/FEFO lógico lo lleva stock_lots). Esto es la capa física.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateBinDto {
  warehouse_id: string;
  aisle_id?: string;
  code: string;
  label?: string;
}

export interface PutAwayDto {
  warehouse_id: string;
  product_id: string;
  lot_code?: string;
  expiry_date?: string; // YYYY-MM-DD
  bin_id?: string;
  bin_code?: string; // alternativa a bin_id (escaneo de la etiqueta del bin)
  quantity: number;
}

@Injectable()
export class BinLocationService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ───── bins ─────

  async createBin(dto: CreateBinDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (dto.aisle_id && !UUID.test(dto.aisle_id)) throw new BadRequestException('aisle_id inválido');
    const code = (dto.code || '').trim();
    if (!code) throw new BadRequestException('code requerido');
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const wh = await trx('commercial.warehouses').where({ id: dto.warehouse_id }).first('id');
      if (!wh) throw new NotFoundException('Almacén no encontrado');
      if (dto.aisle_id) {
        const aisle = await trx('commercial.warehouse_aisles').where({ id: dto.aisle_id }).first('id');
        if (!aisle) throw new NotFoundException('Pasillo no encontrado');
      }
      const dup = await trx('commercial.warehouse_bins').where({ warehouse_id: dto.warehouse_id, code }).first('id');
      if (dup) throw new ConflictException(`Ya existe el bin '${code}' en ese almacén`);
      const [row] = await trx('commercial.warehouse_bins')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          aisle_id: dto.aisle_id || null,
          code,
          label: dto.label || null,
          updated_by: userId,
        })
        .returning('*');
      return row;
    });
  }

  async listBins(warehouseId?: string) {
    if (warehouseId && !UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      let q = trx('commercial.warehouse_bins as b')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'b.tenant_id').andOn('w.id', '=', 'b.warehouse_id');
        });
      if (warehouseId) q = q.where('b.warehouse_id', warehouseId);
      return q
        .select(
          'b.id', 'b.warehouse_id', 'w.code as warehouse_code', 'b.aisle_id', 'b.code', 'b.label', 'b.active',
          trx.raw(`(SELECT COALESCE(SUM(quantity),0) FROM commercial.stock_lot_locations l WHERE l.bin_id = b.id) AS units`),
        )
        .orderBy('w.code')
        .orderBy('b.code');
    });
  }

  async deleteBin(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const used = await trx('commercial.stock_lot_locations').where({ bin_id: id }).where('quantity', '>', 0).first('id');
      if (used) throw new ConflictException('El bin tiene inventario ubicado; vacialo antes de eliminarlo');
      const n = await trx('commercial.warehouse_bins').where({ id }).del();
      if (!n) throw new NotFoundException('Bin no encontrado');
      return { deleted: true };
    });
  }

  // ───── put-away ─────

  async putAway(dto: PutAwayDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
    if (typeof dto.quantity !== 'number' || dto.quantity <= 0) throw new BadRequestException('quantity debe ser > 0');
    if (dto.expiry_date && !ISO_DATE.test(dto.expiry_date)) throw new BadRequestException('expiry_date debe ser YYYY-MM-DD');
    const lot = (dto.lot_code || 'NA').trim() || 'NA';
    const expiry = dto.expiry_date || null;

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;

      // Resolver bin (por id o por code escaneado).
      let binId = dto.bin_id || null;
      if (!binId) {
        const code = (dto.bin_code || '').trim();
        if (!code) throw new BadRequestException('Se requiere bin_id o bin_code');
        const bin = await trx('commercial.warehouse_bins')
          .where({ warehouse_id: dto.warehouse_id, code }).first('id');
        if (!bin) throw new NotFoundException(`Sin bin '${code}' en ese almacén`);
        binId = bin.id;
      } else {
        if (!UUID.test(binId)) throw new BadRequestException('bin_id inválido');
        const bin = await trx('commercial.warehouse_bins').where({ id: binId, warehouse_id: dto.warehouse_id }).first('id');
        if (!bin) throw new NotFoundException('Bin no encontrado en ese almacén');
      }

      // El lote debe existir en stock_lots (recepción primero).
      const lotRow = await trx('commercial.stock_lots')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id, lot_code: lot })
        .where((qb: any) => (expiry ? qb.where('expiry_date', expiry) : qb.whereNull('expiry_date')))
        .first('quantity');
      if (!lotRow) throw new ConflictException('El lote no existe en stock (recibí la mercancía primero)');

      // SUM(ubicado del lote) + quantity ≤ lote.quantity.
      const locatedRow = await trx('commercial.stock_lot_locations')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id, lot_code: lot })
        .where((qb: any) => (expiry ? qb.where('expiry_date', expiry) : qb.whereNull('expiry_date')))
        .sum({ s: 'quantity' })
        .first();
      const located = Number(locatedRow?.s || 0);
      const lotQty = Number(lotRow.quantity);
      if (located + dto.quantity > lotQty) {
        throw new ConflictException(
          `No podés ubicar ${dto.quantity}: del lote quedan ${lotQty - located} por ubicar (lote ${lotQty}, ya ubicado ${located}).`,
        );
      }

      await trx.raw(
        `INSERT INTO commercial.stock_lot_locations
           (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id, quantity, updated_by)
         VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id)
         DO UPDATE SET quantity = commercial.stock_lot_locations.quantity + EXCLUDED.quantity,
                       updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [dto.warehouse_id, dto.product_id, lot, expiry, binId, dto.quantity, userId],
      );
      return { located: true, bin_id: binId, lot_code: lot, quantity: dto.quantity };
    });
  }

  // ───── reads ─────

  /** Contenido de un bin: qué lotes y cuánto. */
  async binContents(binId: string) {
    if (!UUID.test(binId)) throw new BadRequestException('bin_id inválido');
    return this.tk.run(async (trx) =>
      trx('commercial.stock_lot_locations as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('l.bin_id', binId)
        .where('l.quantity', '>', 0)
        .select('l.id', 'l.product_id', 'p.sku', 'p.nombre as product_name', 'l.lot_code', 'l.expiry_date', 'l.quantity')
        .orderByRaw('l.expiry_date ASC NULLS LAST'),
    );
  }

  /** Auxiliar de ubicaciones: dónde está cada lote (filtra por almacén/producto). */
  async locations(query: { warehouse_id?: string; product_id?: string }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (query.product_id && !UUID.test(query.product_id)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) => {
      let q = trx('commercial.stock_lot_locations as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .leftJoin('commercial.warehouse_bins as b', function () {
          this.on('b.tenant_id', '=', 'l.tenant_id').andOn('b.id', '=', 'l.bin_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'l.tenant_id').andOn('w.id', '=', 'l.warehouse_id');
        })
        .where('l.quantity', '>', 0);
      if (query.warehouse_id) q = q.where('l.warehouse_id', query.warehouse_id);
      if (query.product_id) q = q.where('l.product_id', query.product_id);
      return q
        .select(
          'l.id', 'l.warehouse_id', 'w.code as warehouse_code',
          'l.product_id', 'p.sku', 'p.nombre as product_name',
          'l.lot_code', 'l.expiry_date', 'l.bin_id', 'b.code as bin_code', 'b.label as bin_label', 'l.quantity',
          trx.raw('(l.expiry_date - CURRENT_DATE)::int as days_to_expiry'),
        )
        .orderBy('p.nombre')
        .orderByRaw('l.expiry_date ASC NULLS LAST')
        .limit(1000);
    });
  }

  /** Lotes con cantidad por ubicar (stock_lots.quantity − SUM ubicado > 0). */
  async unlocated(query: { warehouse_id?: string; product_id?: string }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (query.product_id && !UUID.test(query.product_id)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) => {
      const params: any[] = [];
      let where = 'sl.quantity > 0';
      if (query.warehouse_id) { where += ' AND sl.warehouse_id = ?'; params.push(query.warehouse_id); }
      if (query.product_id) { where += ' AND sl.product_id = ?'; params.push(query.product_id); }
      const res = await trx.raw(
        `SELECT sl.warehouse_id, w.code AS warehouse_code, sl.product_id, p.sku, p.nombre AS product_name,
                sl.lot_code, sl.expiry_date, sl.quantity AS lot_qty,
                COALESCE((SELECT SUM(loc.quantity) FROM commercial.stock_lot_locations loc
                           WHERE loc.warehouse_id = sl.warehouse_id AND loc.product_id = sl.product_id
                             AND loc.lot_code = sl.lot_code AND loc.expiry_date IS NOT DISTINCT FROM sl.expiry_date), 0) AS located,
                sl.quantity - COALESCE((SELECT SUM(loc.quantity) FROM commercial.stock_lot_locations loc
                           WHERE loc.warehouse_id = sl.warehouse_id AND loc.product_id = sl.product_id
                             AND loc.lot_code = sl.lot_code AND loc.expiry_date IS NOT DISTINCT FROM sl.expiry_date), 0) AS to_locate
           FROM commercial.stock_lots sl
           LEFT JOIN public.products p ON p.id = sl.product_id
           LEFT JOIN commercial.warehouses w ON w.tenant_id = sl.tenant_id AND w.id = sl.warehouse_id
          WHERE ${where}
          ORDER BY p.nombre, sl.expiry_date ASC NULLS LAST`,
        params,
      );
      return res.rows.filter((r: any) => Number(r.to_locate) > 0);
    });
  }

  /** FEFO físico: bins con este producto, ordenados por caducidad ascendente (surtí primero el 1º). */
  async pickSuggestion(warehouseId: string, productId: string) {
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(productId)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) =>
      trx('commercial.stock_lot_locations as l')
        .leftJoin('commercial.warehouse_bins as b', function () {
          this.on('b.tenant_id', '=', 'l.tenant_id').andOn('b.id', '=', 'l.bin_id');
        })
        .where({ 'l.warehouse_id': warehouseId, 'l.product_id': productId })
        .where('l.quantity', '>', 0)
        .select('l.bin_id', 'b.code as bin_code', 'b.label as bin_label', 'l.lot_code', 'l.expiry_date', 'l.quantity',
          trx.raw('(l.expiry_date - CURRENT_DATE)::int as days_to_expiry'))
        .orderByRaw('l.expiry_date ASC NULLS LAST')
        .limit(50),
    );
  }
}
