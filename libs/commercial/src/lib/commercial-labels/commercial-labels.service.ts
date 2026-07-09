import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

export interface LabelModel {
  code: string;                       // el código con el que se pidió (sku o barcode)
  product_id: string;
  sku: string | null;
  name: string;                       // products.nombre
  content: string | null;            // gramaje "50 g"
  barcode: string | null;            // número validado (o null si Kepler traía basura)
  barcode_format: string | null;     // EAN13 | UPC | EAN8
  piece_price: number | null;
  wholesale_piece_min_qty: number | null;
  wholesale_piece_price: number | null;
  pack_size: number | null;
  pack_price: number | null;
  wholesale_pack_price: number | null;
  box_size: number | null;
  box_price: number | null;
}

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Etiquetera (proyecto Tienda). Resuelve una lista de códigos (SKU o barcode) al
 * modelo de la etiqueta de anaquel. Datos de `commercial.product_label_prices`
 * (cargados por database/importers/kepler/import-label-data.js) + `public.products`.
 * RLS forzado → SIEMPRE vía TenantKnexService.run().
 */
@Injectable()
export class CommercialLabelsService {
  constructor(private readonly tk: TenantKnexService) {}

  /** Búsqueda de catálogo para el buscador de la etiquetera (nombre / sku / barcode). */
  async search(q: string): Promise<{ product_id: string; sku: string | null; name: string; barcode: string | null }[]> {
    const term = String(q ?? '').trim();
    if (term.length < 2) return [];
    return this.tk.run(async (trx) => {
      const like = `%${term}%`;
      return trx('products as p')
        .whereNull('p.deleted_at')
        .andWhere((b) =>
          b.where('p.nombre', 'ilike', like).orWhere('p.sku', 'ilike', like).orWhere('p.barcode', 'ilike', like),
        )
        .select('p.id as product_id', 'p.sku', 'p.nombre as name', 'p.barcode')
        .orderBy('p.nombre', 'asc')
        .limit(20);
    });
  }

  async resolveForLabels(codesRaw: string[]): Promise<{ labels: LabelModel[]; not_found: string[] }> {
    const codes = Array.from(
      new Set((codesRaw || []).map((c) => String(c ?? '').trim()).filter(Boolean)),
    );
    if (!codes.length) throw new BadRequestException('Envía al menos un código.');
    if (codes.length > 1000) throw new BadRequestException('Máximo 1000 códigos por lote.');

    return this.tk.run(async (trx) => {
      const rows = await trx('products as p')
        .leftJoin('commercial.product_label_prices as l', function () {
          this.on('l.product_id', '=', 'p.id').andOn('l.tenant_id', '=', 'p.tenant_id');
        })
        .whereNull('p.deleted_at')
        .andWhere((b) => b.whereIn('p.sku', codes).orWhereIn('p.barcode', codes))
        .select(
          'p.id as product_id', 'p.sku', 'p.barcode as product_barcode', 'p.nombre as name',
          'l.content', 'l.barcode', 'l.barcode_format', 'l.piece_price',
          'l.wholesale_piece_min_qty', 'l.wholesale_piece_price', 'l.pack_size', 'l.pack_price',
          'l.wholesale_pack_price', 'l.box_size', 'l.box_price',
        );

      // Índice por sku y por barcode del producto, para remapear al código pedido.
      const bySku = new Map<string, any>();
      const byBarcode = new Map<string, any>();
      for (const r of rows) {
        if (r.sku) bySku.set(String(r.sku), r);
        if (r.product_barcode) byBarcode.set(String(r.product_barcode), r);
      }

      const labels: LabelModel[] = [];
      const not_found: string[] = [];
      const seen = new Set<string>();
      for (const code of codes) {
        const r = bySku.get(code) || byBarcode.get(code);
        if (!r || seen.has(r.product_id)) {
          if (!r) not_found.push(code);
          continue;
        }
        seen.add(r.product_id);
        labels.push({
          code,
          product_id: r.product_id,
          sku: r.sku ?? null,
          name: r.name,
          content: r.content ?? null,
          barcode: r.barcode ?? null,
          barcode_format: r.barcode_format ?? null,
          piece_price: n(r.piece_price),
          wholesale_piece_min_qty: r.wholesale_piece_min_qty ?? null,
          wholesale_piece_price: n(r.wholesale_piece_price),
          pack_size: r.pack_size ?? null,
          pack_price: n(r.pack_price),
          wholesale_pack_price: n(r.wholesale_pack_price),
          box_size: r.box_size ?? null,
          box_price: n(r.box_price),
        });
      }
      return { labels, not_found };
    });
  }
}
