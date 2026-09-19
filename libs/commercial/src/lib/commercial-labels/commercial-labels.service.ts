import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  FRESHNESS_UNKNOWN, Freshness, composeFreshness, evalInput, laneAt,
} from '../shared/freshness';

export interface LabelModel {
  code: string;                       // el código con el que se pidió (sku o barcode)
  product_id: string;
  sku: string | null;
  name: string;                       // products.nombre
  content: string | null;            // gramaje "50 g"
  barcode: string | null;            // número validado (o null si Kepler traía basura)
  barcode_format: string | null;     // EAN13 | UPC | EAN8
  piece_price: number | null;
  /**
   * `[ET.3]` De dónde salió `piece_price`. `erp_vivo` = de `kepler_ods.kdii` en el momento ·
   * `erp_sin_precio` = el ERP no lo cotiza en esa plaza y por eso va `null` (no se imprime un
   * precio viejo) · `copia` = no se pidió plaza, así que se conserva la vista consolidada.
   */
  piece_price_origen?: 'erp_vivo' | 'erp_sin_precio' | 'copia';
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
  /**
   * `[ETQ-PROMO.1]` Descuento por cantidad VIGENTE de Kepler (`kdpv_descuxq`, pantalla
   * `PV_descuxq.kpl`). `promo_pct` es un **porcentaje**, no un precio — verificado contra lo que
   * cobró el mostrador (113 SKUs casan con `c90*(1-pct/100)`, 2 casarían si fuera precio) y
   * contra la propia UI del ERP, que rotula esa columna "% Descuento".
   *
   * `promo_aplica` dice a CUÁL de los tres precios de la etiqueta le toca: la promo apunta a una
   * sola presentación y en el 43% de los casos NO es la base. `null` = la unidad de la promo no
   * existe en el producto (ej. BTO sobre base KG, 16% de las vigentes) → **no se imprime**.
   */
  promo_pct?: number | null;
  promo_min_qty?: number | null;
  promo_hasta?: string | null;
  promo_aplica?: 'pieza' | 'paquete' | 'caja' | null;
}

/**
 * [OBS.6.2] Qué tan viejo es el precio que se está por IMPRIMIR.
 *
 * Existe por el incidente del 2026-09-02: el carril de catálogos del ODS estuvo parado 6 días y la
 * etiquetera siguió imprimiendo precios de hace una semana con total confianza. Uno de ellos
 * (SKU 88222) salió a $54.00 contra un costo de $117.46 — 54% bajo costo. Nadie tenía cómo saberlo
 * mirando la pantalla.
 *
 * NO bloquea la impresión (decisión de Edgar): declara y sigue. Un operador que ve "el precio tiene
 * 3 días" puede decidir; uno que no ve nada, no.
 */
export type LabelsFreshness = Freshness;

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

  /**
   * [OBS.6.2] Tolerancia de CADA eslabón, en horas. No son los umbrales de `db-health`, y la
   * diferencia es deliberada: `db-health` responde "¿hay que despertar a alguien?", esto responde
   * "¿puedo confiar en este número para pegarlo en el anaquel?". Son preguntas distintas, con
   * audiencias distintas, y merecen números distintos.
   *
   * Los dos eslabones tienen ritmo VIVO (minutos), así que 1 h y 12 h son holgados a propósito:
   * el objetivo es cazar un caño roto, no hacer parpadear la pantalla por un hipo de red.
   */
  private static readonly TOLERANCIA_H: Record<string, number> = {
    ods_live_hot: 1,
    // `[ETQ-ODS.1]` `recalculo: 12` se retiró con su paso: la etiqueta ya no pasa por
    // `commercial.product_label_prices`. Una tolerancia sin carril que la use es config muerta,
    // y config muerta es lo que hace creer que algo se está vigilando.
  };

  /**
   * `[ETQ-ODS.1]` La cadena del precio de etiqueta tiene UN solo paso.
   *
   *   1. `ods_live_hot` shipea `kdii`/`kdpv_prod_util` del ERP al ODS → si muere, el ERP cambia
   *      el precio y acá nunca llega. **Es lo que pasó el 27-ago.**
   *
   * Tenía DOS: el segundo era el recálculo de `commercial.product_label_prices`, y se midió con
   * `max(computed_at)` de esa tabla. Ese paso **desapareció** cuando la etiqueta pasó a leer
   * `analytics.v_label_prices`, que deriva del ODS sin tabla intermedia.
   *
   * ⛔ Y seguir midiéndolo sería peor que no medir nada: la píldora reportaría el rezago de una
   * tabla que esta pantalla ya no lee, poniéndose roja por algo que no le afecta o —peor— verde
   * porque ese importer corrió, mientras el carril que SÍ la alimenta está muerto. Es la familia
   * exacta de defecto que VP.0 midió en 21 de 24 píldoras.
   *
   * ⚠️ Tampoco se usa el `computed_at` de la FILA: se movería sólo cuando ESE producto cambia de
   * precio, así que un SKU estable daría semanas de "edad" estando perfectamente al día.
   */
  private async freshness(trx: any): Promise<LabelsFreshness> {
    try {
      const carril = await laneAt(trx, 'ods_live_hot');
      return composeFreshness([
        evalInput('ods_live_hot', 'Carril del ODS (precios del ERP)', carril,
          CommercialLabelsService.TOLERANCIA_H['ods_live_hot']),
      ]);
    } catch {
      // Que no se pueda MEDIR la frescura no puede impedir imprimir. Se declara desconocida —
      // nunca se afirma "está fresco", que es la mentira que esta función existe para evitar.
      return FRESHNESS_UNKNOWN;
    }
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

  /**
   * `[NORM.3]` `sucursal` = la plaza cuya etiqueta se está imprimiendo.
   *
   * `commercial.product_label_prices` pasó a tener grano por sucursal porque el precio de Kepler
   * **es** por tienda: 1,039 de 9,365 SKUs (11.1 %) tienen precio de pieza distinto entre plazas
   * retail y 1,164 grupos de mayoreo de paquete (6.3 %) también. La etiqueta de anaquel de una
   * tienda estaba imprimiendo la moda entre las ocho.
   *
   * ⚠️ Sin `sucursal` se lee `commercial.v_product_label_prices`, la vista consolidada que
   * reproduce exactamente la fila que se publicaba hasta hoy. Es compatibilidad, no el camino
   * bueno: un `leftJoin` a la TABLA sin filtrar por plaza devolvería 8 filas por producto.
   */
  // `[ETQ-ODS.1]` Acá vivía `precioVivoDe()`, que leía `kdii.c90` por un join aparte y aplicaba
  // el umbral `> 0.05` a mano. Se retiró: ese umbral ahora vive UNA sola vez, dentro de
  // `analytics.v_label_prices`, que es la misma frontera que usa `label-compute.js`. Tenerlo en
  // dos lugares era la forma de que la etiqueta y su fuente discreparan por el borde.

  /**
   * `[ETQ-PROMO.1]` A CUÁL de los tres precios de la etiqueta le toca el descuento.
   *
   * La unidad base se pregunta PRIMERO: cuando `unit_base` es PAQ —el 73.5% del catálogo— una
   * promo sobre PAQ está descontando el precio BASE, no un renglón de paquete aparte. Invertir
   * el orden le pondría el descuento al precio equivocado en la mayoría de los casos.
   */
  private promoAplicaA(unidad: unknown, unitBase: unknown): 'pieza' | 'paquete' | 'caja' | null {
    const u = String(unidad ?? '').trim().toUpperCase();
    if (!u) return null;
    if (u === String(unitBase ?? '').trim().toUpperCase()) return 'pieza';
    if (u === 'PAQ') return 'paquete';
    if (u === 'CJA') return 'caja';
    return null;
  }

  async resolveForLabels(
    codesRaw: string[],
    sucursal: string | null = null,
  ): Promise<{ labels: LabelModel[]; not_found: string[]; freshness: LabelsFreshness }> {
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : null;
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
        // ── `[ETQ-ODS.1]` UNA sola fuente, y por lo tanto UNA sola frescura ────────────────
        //
        // Con plaza, TODO sale de `analytics.v_label_prices`: vista derivada de
        // `kepler_ods.kdii` + `kdpv_prod_util`, sin tabla intermedia ni importer.
        //
        // Antes esta consulta mezclaba dos orígenes en el mismo papel: el precio base venía del
        // ODS en vivo (~1-2 min) y el mayoreo, la caja, el paquete y la unidad de
        // `commercial.product_label_prices`, que puebla un importer cada 30 min. Desde
        // `[ETQ-AIDA.1]` el precio GRANDE es `mayoreo x (1 - pct)`, así que el número más grande
        // de la etiqueta quedó colgando de la copia batch mientras el tachado de al lado venía
        // del ODS. Medido antes de cambiarlo: 2 SKUs en las 9 plazas tenían en la tabla un
        // precio que el ERP ya había bajado a la mitad (`84234`: $71.51 contra $40.37 vivo).
        //
        // ⚠️ El filtro de plaza va en el ON, no en el WHERE: en un LEFT JOIN, mandarlo al WHERE
        // convierte el LEFT en INNER y los productos sin etiqueta en esa tienda dejarían de
        // aparecer — pasarían a `not_found` en vez de salir con los campos en null.
        //
        // ⚠️ Sin plaza se conserva el camino de antes (la vista consolidada, por `product_id`):
        // `kdii` trae una fila por (sku, sucursal), así que sin plaza multiplicaría cada
        // producto por nueve. Ese camino sigue siendo una copia y lo declara `piece_price_origen`.
        .modify((qb) => {
          if (suc) {
            qb.leftJoin('analytics.v_label_prices as l', function (this: any) {
              this.on(trx.raw('l.sku = btrim(p.sku)')).andOn(trx.raw('l.sucursal = ?', [suc]));
            });
          } else {
            qb.leftJoin('commercial.v_product_label_prices as l', function (this: any) {
              this.on('l.product_id', '=', 'p.id').andOn('l.tenant_id', '=', 'p.tenant_id');
            });
          }
        })
        // ── `[ET.3]` EL PRECIO SALE DE LA FUENTE, NO DE LA COPIA ───────────────────────────
        //
        // Edgar (2026-09-14): *"hay que usar fuentes principal y ver que esta interfaz tome
        // información correcta"*.
        //
        // `commercial.product_label_prices` es una COPIA que mantiene un importer cada 30 min, y
        // su UPSERT es *churn-free*: sólo toca la fila cuando cambia. Consecuencia medida — no hay
        // señal de frescura por fila, así que *"fresca y sin cambios"* y *"abandonada"* se ven
        // idénticas. Y el cómputo filtra `c90 > 0.05` con un merge que NO borra, así que **cuando
        // el ERP baja un precio a cero, la fila vieja sobrevive con su último valor**: medido en
        // prod, el SKU `71077` en la plaza `07` seguía imprimiendo **$55.55** con el ERP en 0.
        //
        // El verificador de mostrador NO tenía este problema porque su precio base ya salía de
        // `kepler_ods.kdii` en vivo. La etiqueta —la que se imprime en papel y queda en el
        // anaquel— era la única que lo tomaba de la copia. Ahora las dos leen lo mismo.
        //
        // ⚠️ El JOIN va SÓLO con plaza: `kdii` trae una fila por (sku, sucursal), así que sin
        // plaza multiplicaría cada producto por ocho. Sin plaza se conserva el camino de antes
        // (la vista consolidada), que es lo que ya se publicaba.
        .modify((qb) => {
          if (!suc) return;
          // `[ETQ-ODS.1]` El join suelto a `kepler_ods.kdii` se RETIRÓ: `v_label_prices` ya trae
          // `piece_price` del mismo `c90`, y leerlo por dos caminos era justamente la mezcla de
          // fuentes que esta fase vino a cerrar.
          // `[ETQ-PROMO.1]` El descuento por cantidad vigente de ESA tienda.
          //
          // ⚠️ UNA sola fila por producto, con `DISTINCT ON`. Un mismo SKU puede tener promo en
          // DOS presentaciones a la vez (medido: el 20021 en la plaza 05 tiene 10% en PAQ y 3% en
          // CJA), y un LEFT JOIN plano multiplicaría el renglón — la misma trampa que ya obligó a
          // meter la plaza en el ON del join de `kdii`. Se elige la de la unidad BASE, que es la
          // que lleva el precio grande en el 85% de las etiquetas, y a igualdad la de mayor
          // descuento; `promo_unidad` viaja igual para que la etiqueta sólo la aplique al precio
          // que de verdad le toca.
          qb.leftJoin(
            trx.raw(
              `(SELECT DISTINCT ON (sucursal, sku) sucursal, sku, pct, min_qty, unidad, valid_to
                  FROM analytics.v_label_promotions
                 WHERE sucursal = ? AND aplica_a IS NOT NULL
                 ORDER BY sucursal, sku, (aplica_a = 'base') DESC, pct DESC) AS pr`,
              [suc],
            ) as any,
            trx.raw('pr.sku = btrim(p.sku)') as any,
          ).select(
            'pr.pct as promo_pct', 'pr.min_qty as promo_min_qty',
            'pr.unidad as promo_unidad', 'pr.valid_to as promo_hasta',
          );
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
          // `[ET.3]` Con plaza, el precio es el del ERP EN VIVO. `null` cuando el ERP no lo
          // cotiza (0 o ausente) — y `null` es correcto: la etiqueta deja de imprimir un precio
          // en vez de imprimir el que el ERP ya retiró. Sin plaza se conserva el de la copia.
          piece_price: n(r.piece_price),
          // `[ET.3]` De dónde salió, para que la pantalla lo pueda decir y no lo tenga que suponer.
          // `[ETQ-ODS.1]` Con plaza el origen es el ODS por construcción: `v_label_prices` sólo
          // emite filas con `c90 > 0.05`, así que ausencia = el ERP no lo cotiza en esa tienda.
          piece_price_origen: suc ? (n(r.piece_price) == null ? 'erp_sin_precio' : 'erp_vivo') : 'copia',
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
          // `[ETQ-PROMO.1]` Sin plaza no hay promo: el descuento es POR TIENDA, así que sin
          // saber cuál no se puede afirmar ninguno. Va `null`, no 0 — "no sé" no es "no hay".
          promo_pct: suc ? n(r.promo_pct) : null,
          promo_min_qty: suc ? n(r.promo_min_qty) : null,
          promo_hasta: suc && r.promo_hasta ? String(r.promo_hasta).slice(0, 10) : null,
          promo_aplica: suc ? this.promoAplicaA(r.promo_unidad, r.unit_base) : null,
        });
      }
      return { labels, not_found, freshness: await this.freshness(trx) };
    });
  }
}
