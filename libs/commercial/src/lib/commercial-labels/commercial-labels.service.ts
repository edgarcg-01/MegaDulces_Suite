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
  wholesale_pack_min_qty: number | null;
  box_size: number | null;
  box_price: number | null;
  unit_base: string | null;
  sold_by_kg: boolean;
  scanned_unit: string | null;         // unidad del barcode con que se resolvió (PZA/CJA/…) o null
}

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Simbología por longitud del código del PRODUCTO (`products.barcode`). Se usa `p.barcode`
 * (no `l.barcode`) porque es lo que el lector matchea en resolve — así lo impreso == lo escaneable.
 * Longitudes no-EAN (5 díg = SKU, basura) → null; el frontend cae a CODE128 del SKU.
 */
const barcodeFmt = (v: unknown): string | null => {
  const c = String(v ?? '').trim();
  if (/^\d{13}$/.test(c)) return 'EAN13';
  if (/^\d{12}$/.test(c)) return 'UPC';
  if (/^\d{8}$/.test(c)) return 'EAN8';
  return null;
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

  /**
   * ¿Existe `catalog.product_barcodes` (barcodes por unidad, 1 SKU→N)? Se consulta antes de usarla
   * para no romper si la migración aún no se aplicó (comportamiento no-regresivo: cae a p.barcode).
   */
  private async hasUnitBarcodes(trx: any): Promise<boolean> {
    const r = await trx.raw(`SELECT to_regclass('catalog.product_barcodes') IS NOT NULL AS ok`);
    return !!(r?.rows?.[0]?.ok);
  }

  /** Búsqueda de catálogo para el buscador de la etiquetera (nombre / sku / barcode de CUALQUIER unidad). */
  async search(q: string): Promise<{ product_id: string; sku: string | null; name: string; barcode: string | null }[]> {
    const term = String(q ?? '').trim();
    if (term.length < 2) return [];
    return this.tk.run(async (trx) => {
      const like = `%${term}%`;
      const hasBc = await this.hasUnitBarcodes(trx);
      return trx('products as p')
        .whereNull('p.deleted_at')
        .andWhere((b) => {
          b.where('p.nombre', 'ilike', like).orWhere('p.sku', 'ilike', like).orWhere('p.barcode', 'ilike', like);
          // Además: cualquier producto cuyo barcode de OTRA unidad (caja/paquete) matchee el término.
          if (hasBc) {
            b.orWhereExists(function () {
              this.select(trx.raw('1')).from('catalog.product_barcodes as pb')
                .whereRaw('pb.sku = p.sku').andWhere('pb.barcode', 'ilike', like).whereNull('pb.deleted_at');
            });
          }
        })
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
      // Barcodes por UNIDAD (caja/paquete): mapea el código escaneado → SKU + unidad, para que
      // escanear la caja resuelva al producto e imprima SU barcode (no el de pieza).
      const codeToUnit = new Map<string, { sku: string; unit: string | null }>();
      let extraSkus: string[] = [];
      if (await this.hasUnitBarcodes(trx)) {
        const bcRows = await trx('catalog.product_barcodes')
          .whereIn('barcode', codes).whereNull('deleted_at')
          .select('barcode', 'sku', 'unit');
        for (const b of bcRows) {
          codeToUnit.set(String(b.barcode), { sku: String(b.sku), unit: b.unit ?? null });
        }
        extraSkus = Array.from(new Set(bcRows.map((b: any) => String(b.sku))));
      }
      const skuMatch = Array.from(new Set([...codes, ...extraSkus]));

      const rows = await trx('products as p')
        .leftJoin('commercial.product_label_prices as l', function () {
          this.on('l.product_id', '=', 'p.id').andOn('l.tenant_id', '=', 'p.tenant_id');
        })
        .whereNull('p.deleted_at')
        .andWhere((b) => b.whereIn('p.sku', skuMatch).orWhereIn('p.barcode', codes))
        .select(
          'p.id as product_id', 'p.sku', 'p.barcode as product_barcode', 'p.nombre as name',
          'l.content', 'l.barcode', 'l.barcode_format', 'l.piece_price',
          'l.wholesale_piece_min_qty', 'l.wholesale_piece_price', 'l.pack_size', 'l.pack_price',
          'l.wholesale_pack_price', 'l.wholesale_pack_min_qty', 'l.box_size', 'l.box_price', 'l.unit_base', 'l.sold_by_kg',
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
        const unitHit = codeToUnit.get(code); // se escaneó el barcode de una unidad (caja/paquete/pieza)
        const r = bySku.get(code) || byBarcode.get(code) || (unitHit ? bySku.get(unitHit.sku) : undefined);
        if (!r || seen.has(r.product_id)) {
          if (!r) not_found.push(code);
          continue;
        }
        seen.add(r.product_id);
        // El barcode del label = el escaneado si vino por una unidad (lo impreso == lo escaneable de
        // ESA unidad); si no, p.barcode (pieza). EAN/UPC/EAN8 válido se imprime; si no, null → CODE128 del SKU.
        const rawBc = unitHit ? code : String(r.product_barcode ?? '').trim();
        const fmt = barcodeFmt(rawBc);
        labels.push({
          code,
          product_id: r.product_id,
          sku: r.sku ?? null,
          name: r.name,
          content: r.content ?? null,
          barcode: fmt ? rawBc : null,
          barcode_format: fmt,
          piece_price: n(r.piece_price),
          wholesale_piece_min_qty: r.wholesale_piece_min_qty ?? null,
          wholesale_piece_price: n(r.wholesale_piece_price),
          pack_size: r.pack_size ?? null,
          pack_price: n(r.pack_price),
          wholesale_pack_price: n(r.wholesale_pack_price),
          wholesale_pack_min_qty: r.wholesale_pack_min_qty ?? null,
          box_size: r.box_size ?? null,
          box_price: n(r.box_price),
          unit_base: r.unit_base ?? null,
          sold_by_kg: r.sold_by_kg === true,
          scanned_unit: unitHit?.unit ?? null,
        });
      }
      return { labels, not_found };
    });
  }
}
