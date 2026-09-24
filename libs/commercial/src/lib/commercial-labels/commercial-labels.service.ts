import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  FRESHNESS_UNKNOWN, Freshness, composeFreshness, evalInput, laneAt,
} from '../shared/freshness';
// `[ETQ-PRES.2]` La forma la define el contrato, no este archivo (ADR-056: un primitivo vive en
// `libs/` o no existe). `PresentacionPrecio` extiende al `QtyUnitLabel` de VU.0 al PRECIO.
import type { PresentacionPrecio } from '@megadulces/contracts';

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
  /**
   * `[ETQ-PRES.4]` El RÓTULO del ERP de la presentación en promo (`PAQ`, `CJA`, `KG`, `CUB`…).
   *
   * Lo que `promo_aplica` no puede decir: medido sobre las 275 promos vigentes, **1 está
   * declarada en `CUB`** y ninguno de los tres cajones la representa, así que ese campo la
   * devuelve `null` y la oferta no se imprime. Éste viaja sin traducir.
   */
  promo_unidad?: string | null;
  /**
   * `[ETQ-PRES.2]` LA LISTA DE PRESENTACIONES — cada precio con SU unidad.
   *
   * Los campos `piece_*` / `pack_*` / `box_*` de arriba son el modelo VIEJO: tres cajones con
   * nombre fijo sobre los que se apoyaba todo, y la causa unica de los cinco defectos medidos el
   * 2026-09-24 (1,980 ranuras perdidas por elegir el cajon comparando el NOMBRE contra 'PAQ' y
   * 'CJA', 6,826 SKUs sin el peldano de caja, 61 con el mayoreo en otra escala, 111 con el
   * contenido 50x equivocado). Quedan mientras el componente termina de migrar; despues se
   * retiran. Ver `libs/contracts/src/http/price-presentation.contract.ts`.
   *
   * Vacia sin plaza, y la pantalla lo DECLARA: el precio de Kepler es por tienda, asi que sin
   * saber cual no hay lista que sea verdad.
   */
  presentaciones?: PresentacionPrecio[];
}

/**
 * `[ETQ-CAMBIOS.2]` Un cambio de precio, con su ANTES y su DESPUÉS.
 *
 * Sale de `analytics.v_label_price_changes`, derivada de la bitácora nativa de Kepler — la única
 * fuente del sistema que guarda el precio anterior. La primera versión de esta pantalla no podía
 * traerlo (ninguna tabla propia lo tiene, deuda `VP.3`) y por eso mostraba sólo el precio nuevo.
 *
 * `es_baja` = el precio nuevo es cero. No es una rebaja: el ERP le quitó el precio, y la etiqueta
 * de ese producto diría SIN PRECIO. Viaja como bandera para que la pantalla lo diga.
 */
export interface LabelPriceChange {
  sku: string;
  name: string | null;
  unidad: string | null;
  precio_anterior: number | null;
  precio_nuevo: number | null;
  delta: number | null;
  es_baja: boolean;
  hora: string | null;
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
  /**
   * `[ETQ-CAMBIOS.1]` Tope de filas de la lista de cambios. No es una estética: la etiquetera
   * misma tiene un tope de cola, y una lista de miles con "imprimir todas" al lado es una
   * promesa que la impresión no puede cumplir. Cuando se alcanza, la respuesta lo DICE
   * (`truncado: true`) en vez de recortar en silencio.
   */
  private static readonly TOPE_CAMBIOS = 300;

  /**
   * `[ETQ-CAMBIOS.4]` Piso del cambio que vale la pena reimprimir, en pesos. Se ocultan los de
   * **exactamente un centavo** (`abs(delta) <= 0.01`), que son el 41.9% de la semana y el 93% de
   * un domingo, producidos por 116 SKUs que oscilan ~36 veces cada uno. Interpolado en el SQL —
   * no es binding, es una constante numérica de esta clase; `?` acá chocaría con el conteo.
   *
   * ⚠️ Subirlo es una decisión de NEGOCIO ("$0.50 tampoco vale la pena"), no una optimización:
   * cambia qué etiqueta se reimprime. Si se toca, se mide el antes/después como cualquier `WHERE`
   * de negocio, y se dice cuántas filas se movieron.
   */
  private static readonly PISO_DELTA = 0.01;

  /**
   * `[ETQ-CAMBIOS.6]` Las TRES cosas que la pantalla necesita, en **un solo viaje**.
   *
   * ── Por qué una y no tres ───────────────────────────────────────────────────────────────────
   * El índice parcial (`20260921180000`) bajó el trabajo del servidor de **172,133 bloques a
   * 260** por carga. Con eso, lo que quedaba dominando ya no era Postgres: era la **latencia**.
   * Prod vive en Railway, cada consulta es un viaje de ida y vuelta por internet (~150 ms
   * medidos, ver `feedback_measure_the_real_service_query_not_a_similar_one`), y esto hacía
   * cuatro. Tres de ellos se responden con los MISMOS datos del mismo día: se fusionan.
   *
   * `dia` va `MATERIALIZED` a propósito: sin eso el planificador la inserta dos veces (una por
   * la lista, otra por el conteo del centavo) y se paga el índice dos veces por gusto.
   *
   * ⚠️ El orden va DENTRO de `jsonb_agg`, no sólo en la CTE: una CTE con `LIMIT` no garantiza
   * en qué orden la lee el agregado, y el renglón de mayor diferencia tiene que quedar arriba.
   *
   * `fuente_al` se queda como subconsulta aparte porque pregunta otra cosa —hasta qué día llegó
   * la bitácora, sin importar el día elegido— y con el índice cuesta **4 bloques**.
   */
  private static readonly SQL_CAMBIOS = `
    WITH dia AS MATERIALIZED (
      SELECT sku, nombre AS name, unidad, precio_anterior, precio_nuevo, delta, es_baja, hora
        FROM analytics.v_label_price_changes
       WHERE sucursal = ? AND fecha = ?::date
    ), lista AS (
      SELECT to_jsonb(d) AS fila, abs(d.delta) AS orden, d.sku
        FROM dia d
       WHERE abs(d.delta) > ${CommercialLabelsService.PISO_DELTA}
       ORDER BY abs(d.delta) DESC, d.sku
       LIMIT ?
    )
    SELECT
      (SELECT coalesce(jsonb_agg(fila ORDER BY orden DESC, sku), '[]'::jsonb) FROM lista) AS items,
      (SELECT count(*)::int FROM dia WHERE abs(delta) <= ${CommercialLabelsService.PISO_DELTA}) AS ocultos_centavo,
      (SELECT max(fecha)::text FROM analytics.v_label_price_changes WHERE sucursal = ?) AS fuente_al`;

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

  /**
   * ⭐ `[ETQ-CAMBIOS.1]` Los productos cuyo PRECIO CAMBIÓ, para reimprimir su etiqueta.
   *
   * ── ⛔ De dónde sale "cambió", y por qué NO de donde debería ────────────────────────────────
   * La fuente correcta sería `kepler_ods.kdpv_bitacora_precios`: es la bitácora NATIVA de Kepler,
   * trae precio anterior, nuevo y delta, está por plaza y su índice responde en 0.1 ms. **No se
   * usa porque no está llegando.** Medido en prod el 2026-09-21:
   *
   *   `_sync_status.last_push_at` de esa tabla ... 2026-09-02 02:35 (19 días), `rows_last` = 2
   *   última fila de CADA una de las 7 sucursales .. 2026-09-01   · la sucursal 08 no existe ahí
   *   y los dos carriles del ODS estaban VERDES     (`ods_live_hot` 0 min, `ods_live_mirror` 4 min)
   *
   * O sea que no es un carril caído: esa tabla simplemente no se shipea, aunque es append-only y
   * los precios sí cambiaron (la copia se actualizó ese mismo día). `replicate-ods-live.js:87` la
   * nombra entre las que "un full-mirror viejo dejó CONGELADAS".
   *
   * ⚠️ Y aunque llegara, el 92% sería ruido: de 165,421 filas en 90 días de la plaza 05,
   * **153,115 son cambios de menos de UN CENTAVO** (`3.3500 → 3.3480`), residuo de recálculo.
   *
   * ── `[ETQ-CAMBIOS.2]` Resuelto: se usa la bitácora ──────────────────────────────────────────
   * La tabla estaba **excluida a propósito** de los dos carriles del ODS (`ops/vl/docker-compose.yml`,
   * `ODS_EXCLUDE_TABLES`, desde la migración del servidor). Se sacó de ahí, y esta consulta lee
   * `analytics.v_label_price_changes`, que filtra a los cambios que mueven el precio IMPRESO.
   *
   * ⛔ La primera versión leía `commercial.product_label_prices.updated_at` y **no podía dar lo
   * que se pedía**: esa columna guarda el ÚLTIMO toque, no un registro, así que un selector de
   * fechas sólo acierta por casualidad (si el producto cambió el 15 y otra vez el 20, sólo queda
   * el 20) y el precio anterior no existe en ninguna tabla propia.
   *
   * ⚠️ `fuente_al` viaja SIEMPRE, incluso con la lista vacía: sin él, *"ese día no cambió nada"* y
   * *"ese día todavía no llegó al ODS"* se ven idénticos en pantalla, y son lo contrario.
   *
   * ── ⭐ `[ETQ-CAMBIOS.4]` El centavo se OCULTA, y se DICE cuánto se ocultó ────────────────────
   * La vista ya filtra el ruido sub-centavo (`round(c6,2) <> round(c7,2)`: si el papel sale igual,
   * no es un cambio). Queda un escalón más, y **es de negocio, no de redondeo**: un movimiento de
   * **exactamente $0.01** sí cambia el número impreso, pero no justifica caminar al anaquel.
   *
   * No es una corazonada — medido en prod el 2026-09-21, 7 días × 9 plazas:
   *
   *   de 9,969 cambios, **4,176 (41.9%) son de un centavo** · 5,311 (53.3%) son de $1 o más
   *   esos 4,176 salen de **116 SKUs distintos = 36 apariciones cada uno en 7 días**
   *   el domingo 20-sep fueron **437 de 469 (93%)**: la pantalla mostraba casi puro ruido
   *
   * 36 apariciones del mismo SKU en una semana no es "el precio cambió": es el ERP oscilando entre
   * dos valores. La lista existe para decidir qué reimprimir, y con eso adentro no se puede.
   *
   * ⛔ El filtro va ACÁ, no en la vista. `analytics.v_label_price_changes` responde *"qué registró
   * Kepler que mueve el precio impreso"* — eso es un hecho y otros consumidores lo van a querer
   * entero. *"Qué vale la pena reimprimir"* es criterio de ESTA pantalla, y un criterio de pantalla
   * que se hornea en la fuente deja de poder discutirse.
   *
   * ⚠️ Y se **declara**: `ocultos_centavo` viaja en la respuesta. Un filtro mudo que se lleva el
   * 93% de un domingo se lee como "no pasó nada" — exactamente lo que ADR-056 prohíbe.
   */
  async priceChanges(sucursal: string | null, fecha: string | null): Promise<{
    items: LabelPriceChange[]; fecha: string; truncado: boolean; fuente_al: string | null;
    ocultos_centavo: number; freshness: LabelsFreshness;
  }> {
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : null;
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha ?? '')) ? String(fecha) : CommercialLabelsService.ayer();
    return this.tk.run(async (trx) => {
      const freshness = await this.freshness(trx);
      // Sin plaza no hay nada que mostrar: la bitácora es por tienda y mezclarlas diría que
      // cambió algo que en TU tienda no cambió.
      if (!suc) return { items: [], fecha: dia, truncado: false, fuente_al: null, ocultos_centavo: 0, freshness };
      const r = await trx.raw(CommercialLabelsService.SQL_CAMBIOS,
        [suc, dia, CommercialLabelsService.TOPE_CAMBIOS + 1, suc]);
      const row = r?.rows?.[0] ?? {};
      const filas = (row.items ?? []) as LabelPriceChange[];
      // Un tope que recorta en silencio se lee como "no hubo más". Se pide uno de más para poder
      // DECIRLO, y recién ahí se recorta.
      const truncado = filas.length > CommercialLabelsService.TOPE_CAMBIOS;
      return {
        items: truncado ? filas.slice(0, CommercialLabelsService.TOPE_CAMBIOS) : filas,
        fecha: dia,
        truncado,
        fuente_al: (row.fuente_al ?? null) as string | null,
        ocultos_centavo: Number(row.ocultos_centavo ?? 0),
        freshness,
      };
    });
  }

  /** Ayer en hora de México, que es el día que el operador quiere revisar al abrir la tienda. */
  private static ayer(): string {
    const hoyMx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    hoyMx.setDate(hoyMx.getDate() - 1);
    return `${hoyMx.getFullYear()}-${String(hoyMx.getMonth() + 1).padStart(2, '0')}-${String(hoyMx.getDate()).padStart(2, '0')}`;
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

      /**
       * `[ETQ-PRES.2]` La LISTA de presentaciones de esos SKUs, en una sola consulta.
       *
       * ⚠️ Va aparte y NO como join: `v_label_presentations` tiene una fila por unidad (hasta 3
       * por SKU), así que unirla al SELECT de arriba multiplicaría cada producto por sus
       * presentaciones — la misma trampa que ya obligó a meter `DISTINCT ON` en el join de
       * promociones. Un viaje más es más barato que desduplicar a mano.
       *
       * ⛔ Sólo con plaza. La vista es por (sucursal, sku) porque el precio de Kepler es por
       * tienda; sin plaza no hay una lista que sea verdad, y **declararlo vacío es mejor que
       * promediar nueve tiendas**.
       */
      const presPorSku = new Map<string, PresentacionPrecio[]>();
      if (suc && skuMatch.length) {
        const pr = await trx.raw(
          `SELECT sku, unidad, factor, origen, contenido, precio_lista,
                  mayoreo_precio, mayoreo_desde, mayoreo_veredicto
             FROM analytics.v_label_presentations
            WHERE sucursal = ? AND sku = ANY(?)
            ORDER BY sku, factor NULLS LAST`,
          [suc, skuMatch],
        );
        for (const p of (pr?.rows ?? []) as any[]) {
          const k = String(p.sku);
          if (!presPorSku.has(k)) presPorSku.set(k, []);
          presPorSku.get(k)!.push({
            unidad: String(p.unidad),
            factor: Number(p.factor ?? 1),
            origen: p.origen,
            contenido: p.contenido ?? null,
            precio_lista: n(p.precio_lista),
            mayoreo_precio: n(p.mayoreo_precio),
            mayoreo_desde: p.mayoreo_desde == null ? null : Number(p.mayoreo_desde),
            mayoreo_veredicto: p.mayoreo_veredicto,
          });
        }
      }

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
          /**
           * `[ETQ-PRES.4]` El RÓTULO crudo de la presentación en promo. Va además de
           * `promo_aplica` —que lo traduce a los tres cajones y por eso pierde lo que no entra—
           * porque la etiqueta ahora compara rótulo contra rótulo. Medido: de las 275 promos
           * vigentes, **1 está declarada en `CUB`** y `promo_aplica` la devuelve `null`.
           */
          promo_unidad: suc && r.promo_unidad ? String(r.promo_unidad).trim().toUpperCase() : null,
          /**
           * `[ETQ-PRES.2]` La lista. Cada precio viaja con SU unidad, su factor y su contenido
           * derivado — por eso aparear el precio de una con el contenido de otra deja de ser
           * posible, en vez de quedar atajado por una guarda.
           *
           * Vacía sin plaza, y eso se DECLARA: la pantalla debe decir "sin tienda no hay lista",
           * no dibujar cero presentaciones como si el producto tuviera una sola.
           */
          presentaciones: presPorSku.get(String(r.sku ?? '')) ?? [],
        });
      }
      return { labels, not_found, freshness: await this.freshness(trx) };
    });
  }
}
