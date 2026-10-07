import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService } from '@megadulces/platform-core';
import { AREA_COTIZACIONES } from './quote-scope';
import type { Knex } from 'knex';

/**
 * `[COT.1]` — El motor de precio de una cotización.
 *
 * ── La regla de negocio que lo gobierna (Dirección, 2026-09-22) ─────────────────────────────
 * **El vendedor NO puede inventar un descuento.** El precio de un renglón es siempre la
 * derivación de los mecanismos que el ERP ya autoriza, y lo que no salga de ahí se rechaza —no
 * se "avisa". Por eso este servicio no acepta un `discount_pct` del request en ningún lado.
 *
 * ── ⭐ Las DOS capas, que no son la misma y no se explican entre sí ──────────────────────────
 * Decodificado en la Fase TK sobre 30,549 tickets (`ERP_KEPLER.md` §3.1) y respetado acá:
 *
 *   capa de PRECIO     → vive en el RENGLÓN  (`kdm2.c66` lista vs `c12` cobrado)
 *   capa de DOCUMENTO  → vive en la CABECERA (`kdm1.c13` importe + `c19` %), sólo telemarketing
 *                         y crédito — y es donde cae el descuento del CLIENTE
 *
 * ⛔ De 609 facturas, sólo 172 cuadran entre una capa y la otra: **435 difieren**. O sea que
 * **conviven**: no es "el mejor de los dos" ni una explica a la otra. Por eso el descuento del
 * cliente **NO toca `unit_price`** — se aplica sobre el subtotal, en `recalcTotals`. Meterlo en
 * el renglón daría un precio unitario que el ERP nunca cobró.
 *
 * ── De dónde sale cada número (verificado, no supuesto) ─────────────────────────────────────
 *   precio de lista y escalera  → `analytics.v_label_prices` (deriva `kdii` + `kdpv_prod_util`,
 *                                  la MISMA lógica que la etiqueta de anaquel: una sola fuente
 *                                  y una sola frescura, ~1-2 min del carril del ODS)
 *   descuento por volumen       → `wholesale_*` de esa misma vista (es `kdpv_prod_util`, el
 *                                  precio por volumen del propio Kepler)
 *   promos de producto          → `analytics.v_erp_discount_rules` (los 4 `kdpv_*`, `[COT.1.0]`)
 *   descuento del cliente       → `quotes.terms_discount_pct`, **congelado al crear** desde
 *                                  `kdud` por (código, sucursal) — no se vuelve a leer del ERP,
 *                                  porque una cotización tiene que ser reproducible
 *
 * ⛔ **No derivar el precio de lista del catálogo de la Suite.** Ya está refutado y medido:
 * comparar contra `kdii.c90/c91/c92` da 1.9% de renglones por ENCIMA de lista contra 0.10% con
 * la fuente del ERP (18× peor). `products.cost_base` tampoco sirve para nada de esto (ADR-051).
 *
 * ── Lo que este motor DECLARA en vez de inventar (ADR-056) ──────────────────────────────────
 *   · Sin precio en el ERP para ese peldaño → `unit_price = NULL` + `unpriced_reason`.
 *     **Jamás $0**: un cero se lee como "no cuesta nada" en algo que sí cuesta.
 *   · Los mecanismos por MONTO (`descuento_monto`, `gratis_monto`) **no se aplican**: su umbral
 *     no tiene testigo (cero reglas vigentes con qué cuadrarlo contra una venta). Se REPORTAN
 *     como `no_aplicado` con su motivo, para que la pantalla pueda decirlo.
 *   · El IVA: el precio del ERP **ya trae impuestos** (Σ`kdm2.c13` = `kdm1.c16`, 99.84%), así que
 *     `unit_price` los incluye y el desglose se hace hacia atrás. La tasa es la del renglón, y
 *     `tax_basis` dice si fue asumida — el IEPS por producto todavía no tiene resolvedor.
 */

/** Peldaño de la escalera de unidades. `base` siempre existe; `pack`/`box` sólo si el ERP los declara. */
export type Rung = 'base' | 'pack' | 'box';

/**
 * De dónde salió el precio de un renglón.
 *
 * ⛔ **El vocabulario NO lo elige este servicio: lo fija un CHECK del esquema**
 * (`commercial_quote_lines_price_source_valid`). El motor arrancó inventando etiquetas propias
 * —`lista_base`, `promo_cantidad`— y el INSERT murió con 23514 contra el API real. Si hace falta
 * un valor nuevo, se agrega **por migración** y recién después se usa acá.
 */
export type PriceSource =
  | 'list'          // precio de lista del peldaño (kdii.c90/c91/c92)
  | 'customer_terms'// descuento del cliente — capa DOCUMENTO, no se usa en el renglón
  | 'volume_qty'    // precio por volumen del ERP (kdpv_prod_util)
  | 'volume_amount'
  | 'promo_qty'     // promoción por cantidad (kdpv_descuxq)
  | 'promo_amount'  // promoción por monto (kdpv_descuxm) — hoy nunca se aplica, sin umbral verificado
  | 'free_goods'
  | 'manual'
  | 'unknown';      // sin precio o sin casar: el motivo va en `unpriced_reason` / `availability`

export interface LadderRung {
  rung: Rung;
  /** Rótulo del ERP: PAQ, CJA, PZA, KG… */
  label: string | null;
  /** Precio del peldaño, con impuestos incluidos. NULL = el ERP no lo declara. */
  price: number | null;
  /** Cuántas unidades base entran (1 para la base). */
  size: number | null;
  /** Precio por volumen del ERP para ESTE peldaño (`kdpv_prod_util`), si existe. */
  volume: { min_qty: number; price: number } | null;
}

/** `[VTK.1]` Fila de `analytics.v_label_presentations` con la unidad mayor (CJA/BTO/CUB) de un SKU. */
interface MayorRow {
  sku: string;
  unidad: string;
  factor: string | number | null;
  precio_lista: string | number | null;
  mayoreo_precio: string | number | null;
  mayoreo_desde: string | number | null;
}

/** `[VTK.1]` Escalón de volumen de la unidad mayor leído directo de `kepler_ods.kdpv_prod_util`. */
interface KdpvVolumeRow {
  sku: string;
  unidad: string;
  price: string | number;
  min_qty: number;
}

/** `[VTK.1]` La escalera de un SKU en una sucursal: base / paquete / caja, con su precio de lista y su volumen. */
export interface Ladder {
  name: string | null;
  unit_base: string | null;
  rungs: Record<Rung, LadderRung>;
}

export interface PriceStep {
  step: string;
  source: string;
  detail: string;
  before: number | null;
  after: number | null;
}

export interface PricedLine {
  sku: string;
  product_id: string | null;
  name: string | null;
  branch: string;
  rung: Rung;
  unit_label: string | null;
  /**
   * `[COT.1b]` Cuántas unidades BASE trae el peldaño cotizado. Es el `qty_factor` que se
   * persiste al lado de la cantidad: sin él, un `10` guardado no dice si eran 10 piezas o
   * 10 cajas. `null` en la base (no hubo conversión) y cuando no se pudo resolver — nunca 1
   * por relleno, que sería afirmar lo que no se sabe (VU.0).
   */
  unit_factor: number | null;
  quantity: number;
  list_price: number | null;
  unit_price: number | null;
  price_source: PriceSource;
  line_total: number | null;
  tax_rate: number;
  tax_basis: string;
  availability: string;
  /** El desglose completo: cada paso, con qué fuente y qué le hizo al precio. */
  applied: PriceStep[];
  /** Mecanismos que existían y NO se aplicaron, con el motivo. */
  not_applied: { mechanism: string; reason: string }[];
  /** Escalón de mayoreo / volumen configurado en el ERP (kdpv_prod_util / v_label_presentations) */
  volume_tier?: { min_qty: number; price: number } | null;
  free_goods: { sku: string; quantity: number; unit_label: string | null; product_id: string | null } | null;
  unpriced_reason: string | null;
  warnings: string[];
}

/** Lo que devuelve agregar un renglón: el conteo y el desglose de cómo se precificó. */
export interface AddLineResult {
  quote_id: string;
  lines: number;
  priced: PricedLine | null;
}

/** Lo que devuelve quitar un renglón: cuántas filas se fueron (el renglón + sus regalos). */
export interface RemoveLineResult {
  quote_id: string;
  removed: number;
}

export interface PriceLineInput {
  /** Sucursal Kepler desde la que se cotiza. Es parte de la identidad del precio. */
  branch: string;
  sku: string;
  quantity: number;
  /** Peldaño pedido. Si no viene, se usa la base (la unidad en la que el ERP tiene el precio). */
  rung?: Rung;
  /**
   * Rótulo guardado en el renglón (`quote_lines.qty_unit`) cuando no viene `rung` explícito.
   * Se resuelve CONTRA LA ESCALERA DE ESE SKU, no contra una lista de etiquetas: el mismo
   * rótulo puede ser la unidad base de un producto y la mayor de otro (medido: 13 SKUs tienen
   * `BTO`/`CUB` como unidad BASE). Ver `rungDeRotulo`.
   */
  rung_label?: string | null;
}

const RUNG_TO_APLICA_A: Record<Rung, string> = { base: 'base', pack: 'unidad2', box: 'unidad3' };
const DEFAULT_TAX_RATE = 0.16;

/** Lo mínimo de la escalera que hace falta para resolver un rótulo guardado. */
export interface LadderParaRotulo {
  unit_base: string | null;
  rungs: Record<Rung, LadderRung>;
}

const norm = (v: string | null | undefined): string => {
  const l = (v || '').trim().toUpperCase();
  if (l === 'CAJA') return 'CJA';
  if (l === 'BULTO') return 'BTO';
  if (l === 'CUBETA') return 'CUB';
  if (l === 'PAQUETE') return 'PAQ';
  return l;
};

/**
 * De vuelta del rótulo guardado al peldaño, para no mover la unidad cuando sólo se corrige la
 * cantidad.
 *
 * ⚠️ **El rótulo solo NO alcanza: el mismo rótulo es la unidad BASE de un producto y la MAYOR de
 * otro.** Medido en prod el 2026-10-01: 13 SKUs tienen `BTO`/`CUB` en `kdii.c11`, o sea que el
 * bulto es su unidad base — `15143` nace `BTO` a $89.39 y **no tiene** peldaño `box` (106 de sus
 * 115 filas sucursal×sku no lo tienen). Decidir por una lista global de etiquetas mandaba esos
 * renglones guardados a un peldaño inexistente al editarles la cantidad, que es justo el "el ERP
 * no declara esa presentación" que este cambio vino a borrar. Y no es simétrico: `99040` tiene
 * base `CUB` **y** una caja real de 14 ($756.00), así que tampoco sirve "si la base es CUB, nunca
 * hay caja".
 *
 * Por eso se resuelve CONTRA LA ESCALERA DE ESE SKU, en este orden: box → pack → base. El orden
 * preserva lo de antes para `CJA`/`PAQ` (si la base fuera CJA y la caja también, gana la caja,
 * como siempre). Lo que no casa con ningún peldaño cae a `base`, que es donde el ERP siempre
 * tiene precio: no se adivina un intermedio.
 *
 * Es una función pura y exportada a propósito: así se prueba con casos reales en vez de con un
 * doble (`quote-pricing.spec.ts`).
 */
export function rungDeRotulo(label: string | null, led: LadderParaRotulo | null): Rung {
  const l = norm(label);
  if (!l) return 'base';
  if (led) {
    if (led.rungs.box?.label && l === norm(led.rungs.box.label)) return 'box';
    if (led.rungs.pack?.label && l === norm(led.rungs.pack.label)) return 'pack';
    return 'base';
  }
  // Sin escalera (no debería pasar: `priceLine` la carga antes) se conserva el mapeo histórico,
  // que nunca mandó BTO/CUB a `box`.
  if (l === 'CJA') return 'box';
  if (l === 'PAQ') return 'pack';
  return 'base';
}

@Injectable()
export class QuotePricingService {
  private readonly logger = new Logger(QuotePricingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** COT.19: 403 si la sucursal de la cotización no está en el alcance de ESCRITURA del usuario. */
  private async assertEscribe(branch: string | null | undefined): Promise<void> {
    if (!branch) throw new BadRequestException('La cotización no tiene sucursal: no se puede editar.');
    await this.scope.assertCanWrite('warehouse', branch, AREA_COTIZACIONES);
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Escalera de precios del producto en esa tienda
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Arma la escalera desde `v_label_prices`. El mapeo NO es inventado: sale de la propia
   * definición de la vista — `piece_price` es `kdii.c90`, el precio de la unidad BASE (`c11`),
   * y el volumen de la base viaja en `wholesale_pack_*` cuando esa base es PAQ o CJA (la vista
   * lo llama `grouped`), o en `wholesale_piece_*` en el resto de los casos.
   */
  private async ladder(
    knex: Knex,
    branch: string,
    sku: string,
  ): Promise<Ladder | null> {
    const m = await this.ladders(knex, branch, [sku]);
    return m.get(sku) ?? null;
  }

  /**
   * `[VTK.1]` La escalera de MUCHOS productos de una sucursal en tres lecturas, con la MISMA
   * lógica que tenía `ladder` para un solo SKU (que ahora la llama). Existe para que la toma de
   * pedido del vendedor muestre las mismas unidades y precios que después cobra: una segunda
   * derivación a mano se separaría de ésta en silencio (es lo que se midió entre las ranuras de
   * `kdii` y `v_label_presentations`, ver abajo).
   *
   * `skus = null` = toda la sucursal (medido 2026-10-04: ~0.3 s para los ~9,400 SKUs de la 04).
   * Público a propósito y SIN validar alcance, igual que `priceLine`: el caller ya validó la
   * sucursal (la cotización, o el pedido con su almacén).
   */
  async ladders(knex: Knex, branch: string, skus: string[] | null): Promise<Map<string, Ladder>> {
    const out = new Map<string, Ladder>();
    const list = skus === null ? null : [...new Set(skus.map((x) => String(x).trim()).filter(Boolean))];
    if (list !== null && list.length === 0) return out;
    // knex.raw expande un arreglo en "?, ?, ...": los marcadores se arman a mano.
    const inSkus = (col: string) => (list === null ? '' : ' AND ' + col + ' IN (' + list.map(() => '?').join(', ') + ')');
    const args = list ?? [];

    const prices = await knex.raw(
      'SELECT sku, name, piece_price, wholesale_piece_min_qty, wholesale_piece_price,'
        + ' pack_size, pack_price, wholesale_pack_price, wholesale_pack_min_qty,'
        + ' box_size, box_price, unit_base'
        + ' FROM analytics.v_label_prices'
        + ' WHERE sucursal = ?' + inSkus('sku'),
      [branch, ...args],
    );
    if (!prices.rows.length) return out;

    // ── La unidad mayor NO siempre se llama CJA, y se resuelve en UNA sola lectura ───────────
    // Medido en prod (2026-09-30): 168 SKUs / 1,510 filas sucursal×sku tienen como unidad mayor
    // el BULTO (BTO) o la CUBETA (CUB) y ninguna CJA utilizable. Ej.: 17083 "ALTOS CAM CHICA
    // 1KG" = KG -> BTO de 20 kg a $1,169.91, y Kepler lo VENDE así: mv_kepler_unit_ladder da
    // factor 20.0000, ambiguo=false, 223 renglones, 8 sucursales, $410,403.40. Leer sólo 'CJA'
    // respondía "el ERP no declara esa presentación", que era falso.
    //
    // ⚠️ La fuente es analytics.v_label_presentations —la MISMA vista que ya resolvía la CJA—,
    // no una relectura de las ranuras de kdii. No es cosmético: medido el 2026-10-01, las
    // ranuras NO reproducen la vista (37 factores y 28 precios distintos sobre 75,397 comunes, y
    // 138 CJA que la vista ve y la ranura no), y la vista rellena 182 filas donde v_label_prices
    // no trae box_*. Una segunda derivación a mano se habría separado de la primera en silencio.
    //
    // Prioridad CJA -> BTO/CUB; sólo rótulos conocidos (500, 250, IND... son unidad desconocida,
    // UNIDADES_DE_MEDIDA §7.6). El criterio de la CJA queda EXACTAMENTE como estaba (precio o
    // factor declarado) para no mover el 99% del catálogo; a BTO/CUB se les exige además
    // factor > 1 y precio, porque con factor 1 el rótulo es la unidad BASE del producto y no una
    // presentación mayor (13 SKUs: 15143 nace BTO de 1). Efecto medido: **1,510 filas ganan
    // peldaño box, 0 lo pierden**.
    //
    // Costo (re-medido 2026-10-04): ~0.15–0.2 s por SKU y ~0.3 s la sucursal completa. El
    // "~3.6 s por SKU" que decía este comentario ya no se reproduce.
    const mayores = await knex.raw(
      'SELECT DISTINCT ON (sku) sku, upper(btrim(unidad)) AS unidad, factor, precio_lista, mayoreo_precio, mayoreo_desde'
        + ' FROM analytics.v_label_presentations'
        + ' WHERE sucursal = ?' + inSkus('sku')
        + " AND ( (upper(btrim(unidad)) = 'CJA' AND (precio_lista IS NOT NULL OR factor IS NOT NULL))"
        + "    OR (upper(btrim(unidad)) IN ('BTO', 'CUB') AND factor > 1 AND precio_lista IS NOT NULL) )"
        + " ORDER BY sku, CASE WHEN upper(btrim(unidad)) = 'CJA' THEN 0 ELSE 1 END, factor DESC NULLS LAST",
      [branch, ...args],
    );
    const mayorRows = mayores.rows as MayorRow[];
    const mayorBySku = new Map<string, MayorRow>(mayorRows.map((r) => [String(r.sku).trim(), r]));

    // Volumen de la caja directo de kdpv_prod_util cuando la vista no lo trae: el escalón más
    // chico (> 1) y, a igual escalón, el más barato, por SKU y rótulo.
    const kdpv = await knex.raw(
      'SELECT DISTINCT ON (btrim(u.c1), upper(btrim(u.c2::text)))'
        + ' btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,'
        + ' u.c7::numeric AS price, floor(u.c4::numeric)::int AS min_qty'
        + ' FROM kepler_ods.kdpv_prod_util u'
        + ' WHERE u.sucursal = ?' + inSkus('btrim(u.c1)')
        + " AND upper(btrim(u.c2::text)) IN ('CJA', 'BTO', 'CUB')"
        + ' AND u.c7::numeric > 0 AND floor(u.c4::numeric)::int > 1'
        + ' ORDER BY btrim(u.c1), upper(btrim(u.c2::text)), floor(u.c4::numeric)::int ASC, u.c7::numeric ASC',
      [branch, ...args],
    );
    const kdpvRows = kdpv.rows as KdpvVolumeRow[];
    const kdpvByKey = new Map<string, KdpvVolumeRow>(kdpvRows.map((r) => [r.sku + '|' + r.unidad, r]));

    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const volumeOf = (minQty: unknown, price: unknown) =>
      minQty !== null && minQty !== undefined && price !== null && price !== undefined
        ? { min_qty: Number(minQty), price: Number(price) }
        : null;

    for (const p of prices.rows) {
      const sku = String(p.sku).trim();
      const base = (p.unit_base || '').toUpperCase();
      const baseIsGrouped = base === 'PAQ' || base === 'CJA';

      let boxVolume: { min_qty: number; price: number } | null = null;
      let boxPrice = num(p.box_price);
      let boxSize = num(p.box_size);
      let boxLabel: string | null = null;

      const m = mayorBySku.get(sku);
      if (m) {
        boxLabel = m.unidad;
        if (m.unidad === 'CJA') {
          if (boxPrice === null && m.precio_lista !== null) boxPrice = num(m.precio_lista);
          if (boxSize === null && m.factor !== null) boxSize = num(m.factor);
        } else {
          // Otra unidad mayor: el precio y el factor son los SUYOS. No se heredan los de
          // v_label_prices, que son de la caja: pegarle el precio de una presentación al factor
          // de otra es el error de unidad que este proyecto ya pagó (ADR-055).
          boxPrice = num(m.precio_lista);
          boxSize = num(m.factor);
        }
        if (m.mayoreo_desde && m.mayoreo_precio) {
          boxVolume = volumeOf(m.mayoreo_desde, m.mayoreo_precio);
        }
      }
      if (boxLabel === null && (boxPrice !== null || boxSize !== null)) boxLabel = 'CJA';

      if (!boxVolume && boxPrice !== null) {
        const k = kdpvByKey.get(sku + '|' + (boxLabel ?? 'CJA'));
        if (k) boxVolume = volumeOf(k.min_qty, k.price);
      }

      out.set(sku, {
        name: p.name ?? null,
        unit_base: p.unit_base ?? null,
        rungs: {
          base: {
            rung: 'base',
            label: p.unit_base ?? null,
            price: num(p.piece_price),
            size: 1,
            volume: baseIsGrouped
              ? volumeOf(p.wholesale_pack_min_qty, p.wholesale_pack_price)
              : volumeOf(p.wholesale_piece_min_qty, p.wholesale_piece_price),
          },
          pack: {
            rung: 'pack',
            label: p.pack_size ? 'PAQ' : null,
            price: num(p.pack_price),
            size: num(p.pack_size),
            // El volumen de PAQ sólo está publicado aparte cuando la base es PZA.
            volume: base === 'PZA' ? volumeOf(p.wholesale_pack_min_qty, p.wholesale_pack_price) : null,
          },
          box: {
            rung: 'box',
            label: boxLabel ?? ((boxSize || p.box_size) ? 'CJA' : null),
            price: boxPrice,
            size: boxSize,
            volume: boxVolume,
          },
        },
      });
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // El cálculo de un renglón
  // ───────────────────────────────────────────────────────────────────────────────────────────

  async previewLine(input: PriceLineInput): Promise<PricedLine> {
    // COT.19: el precio de una sucursal que no te toca es la puerta por la que se cotizaba
    // Padre Hidalgo desde Morelia. `priceLine` NO valida: la usan addLine/updateLine, que ya
    // validaron la escritura sobre la sucursal de la cotización.
    const branch = (input.branch || '').trim();
    if (branch) await this.scope.assertCanRead('warehouse', branch, AREA_COTIZACIONES);
    return this.tk.run((knex) => this.priceLine(knex, input));
  }

  async priceLine(knex: Knex, input: PriceLineInput): Promise<PricedLine> {
    const branch = (input.branch || '').trim();
    const sku = (input.sku || '').trim();
    const quantity = Number(input.quantity);
    if (!branch) throw new BadRequestException('Falta la sucursal: el precio de un producto no es el mismo en todas.');
    if (!sku) throw new BadRequestException('Falta el SKU.');
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('La cantidad tiene que ser mayor que cero.');
    }

    const applied: PriceStep[] = [];
    const notApplied: { mechanism: string; reason: string }[] = [];
    const warnings: string[] = [];

    const prod = await knex.raw(
      // `catalog.products` es la canónica (la usan replenishment y el resto de commercial) y su
      // columna es `nombre`, no `name`. El primer intento contra el API real salió 42703: el
      // build compila igual, porque el nombre de una columna no lo valida TypeScript.
      `SELECT id, nombre AS name FROM catalog.products
        WHERE tenant_id = :tenant AND btrim(sku) = :sku AND deleted_at IS NULL
        LIMIT 1`,
      { tenant: this.tenantCtx.requireTenantId(), sku },
    );
    const productId: string | null = prod.rows.length ? prod.rows[0].id : null;

    const led = await this.ladder(knex, branch, sku);
    if (!led) {
      return this.unpriced({
        sku, productId, name: prod.rows[0]?.name ?? null, branch, quantity,
        rung: input.rung ?? 'base',
        reason: `El ERP no publica precio para ${sku} en la sucursal ${branch}.`,
        availability: productId ? 'unavailable' : 'not_carried',
        applied, notApplied, warnings,
      });
    }

    // El peldaño del renglón guardado se resuelve acá y no antes, porque necesita la escalera de
    // ESTE sku: el rótulo solo es ambiguo (ver `rungDeRotulo`).
    const rung: Rung = input.rung ?? this.rungDeRotulo(input.rung_label ?? null, led);
    const step = led.rungs[rung];
    if (!step || step.price === null) {
      return this.unpriced({
        sku, productId, name: led.name, branch, quantity, rung,
        reason:
          rung === 'base'
            ? `El ERP no publica precio base para ${sku} en la sucursal ${branch}.`
            : `El producto ${sku} no tiene el peldaño "${rung}" en la sucursal ${branch}: el ERP no declara esa presentación.`,
        availability: 'unavailable',
        applied, notApplied, warnings,
      });
    }

    const listPrice = step.price;
    let price = listPrice;
    let priceSource: PriceSource = 'list';
    applied.push({
      step: 'lista',
      source: 'analytics.v_label_prices (kdii.c90/c91/c92)',
      detail: `Precio de lista del peldaño ${rung}${step.label ? ` (${step.label})` : ''}`,
      before: null,
      after: price,
    });

    // ── Mecanismo 2a: el precio por VOLUMEN del propio ERP (kdpv_prod_util) ──────────────────
    // No es un descuento porcentual: es OTRO precio del mismo peldaño a partir de N unidades.
    if (step.volume) {
      if (quantity >= step.volume.min_qty) {
        if (step.volume.price < price) {
          applied.push({
            step: 'volumen',
            source: 'kdpv_prod_util (via v_label_prices.wholesale_*)',
            detail: `Precio por volumen desde ${step.volume.min_qty} ${step.label ?? 'u'}`,
            before: price,
            after: step.volume.price,
          });
          price = step.volume.price;
          priceSource = 'volume_qty';
        } else {
          // El ERP publica un "mayoreo" más caro que la lista. Pasa, y no se corrige en silencio.
          warnings.push(
            `El precio por volumen del ERP (${step.volume.price}) es MAYOR que el de lista (${price}): se conserva el de lista.`,
          );
        }
      } else {
        notApplied.push({
          mechanism: 'volumen',
          reason: `Precio por volumen de $${step.volume.price} disponible a partir de ${step.volume.min_qty} ${step.label ?? 'unidades'}.`,
        });
      }
    }

    // ── Mecanismos 2b–5: las reglas de descuento de producto ────────────────────────────────
    // El peldaño `box` ya no se llama siempre CJA: la regla se busca por el rótulo REAL. La
    // ranura (`aplica_a`) sigue saliendo del mapeo fijo y no del peldaño, porque medido el
    // 2026-10-01 **no existe ninguna regla sobre `BTO`/`CUB` atada a `unidad2`/`unidad3`** (las
    // de esas ranuras son PAQ 51, CJA 13, KG 1; la única de `CUB` cuelga de `base`), y la
    // cláusula por rótulo de abajo ya las alcanzaría si aparecieran. Un campo nuevo sin un caso
    // que lo exija es un primitivo inventado (ADR-056).
    const unitName = rung === 'box' ? (step.label || 'CJA') : (rung === 'pack' ? 'PAQ' : (step.label || 'PZA'));
    const rules = await knex.raw(
      `SELECT mecanismo, umbral_tipo, umbral, pct, free_sku, free_qty, free_unidad,
              umbral_verificado, aplica_a, saldo_estado, reglas_duplicadas, valid_to
         FROM analytics.v_erp_discount_rules
        WHERE tienda = :branch AND sku = :sku
          AND (aplica_a = :aplica_a OR upper(unidad) = upper(:unitName))`,
      { branch, sku, aplica_a: RUNG_TO_APLICA_A[rung], unitName },
    );

    let freeGoods: PricedLine['free_goods'] = null;

    for (const rule of rules.rows) {
      const umbral = rule.umbral === null ? null : Number(rule.umbral);

      if (!rule.umbral_verificado) {
        notApplied.push({
          mechanism: rule.mecanismo,
          reason:
            'El umbral por MONTO no está verificado: no hay ninguna regla vigente con qué cuadrarlo contra una venta. Se declara, no se aplica.',
        });
        continue;
      }
      if (umbral === null || quantity < umbral) {
        notApplied.push({
          mechanism: rule.mecanismo,
          reason: umbral === null ? 'La regla no declara umbral.' : `Requiere ${umbral} y se están cotizando ${quantity}.`,
        });
        continue;
      }
      if (Number(rule.reglas_duplicadas) > 1) {
        warnings.push(
          `El ERP tiene ${rule.reglas_duplicadas} reglas ${rule.mecanismo} vigentes para este SKU y presentación; se aplicó la de la propia tienda con vigencia más larga.`,
        );
      }
      if (rule.saldo_estado === 'agotada') {
        warnings.push(`La promoción ${rule.mecanismo} está marcada como AGOTADA en el ERP (saldo 0): el mostrador podría no darla.`);
      }

      if (rule.mecanismo === 'descuento_cantidad' && rule.pct !== null) {
        const pct = Number(rule.pct);
        const after = this.round(price * (1 - pct / 100), 4);
        applied.push({
          step: 'promo_cantidad',
          source: 'kdpv_descuxq (via v_erp_discount_rules)',
          detail: `${pct}% desde ${umbral} ${step.label ?? 'u'} · vigente hasta ${String(rule.valid_to).slice(0, 10)}`,
          before: price,
          after,
        });
        price = after;
        priceSource = 'promo_qty';
      }

      if (rule.mecanismo === 'gratis_cantidad' && rule.free_sku) {
        const freeProd = await knex.raw(
          `SELECT id FROM catalog.products WHERE tenant_id = :tenant AND btrim(sku) = :sku AND deleted_at IS NULL LIMIT 1`,
          { tenant: this.tenantCtx.requireTenantId(), sku: String(rule.free_sku).trim() },
        );
        freeGoods = {
          sku: String(rule.free_sku).trim(),
          quantity: rule.free_qty === null ? 0 : Number(rule.free_qty),
          unit_label: rule.free_unidad ?? null,
          product_id: freeProd.rows.length ? freeProd.rows[0].id : null,
        };
        applied.push({
          step: 'gratis_cantidad',
          source: 'kdpv_gratisxq (via v_erp_discount_rules)',
          detail: `Desde ${umbral} ${step.label ?? 'u'} se regalan ${freeGoods.quantity} de ${freeGoods.sku}`,
          before: price,
          after: price,
        });
        if (!freeGoods.product_id) {
          warnings.push(`El producto gratis ${freeGoods.sku} no está en el catálogo de la Suite: el renglón va sin product_id.`);
        }
      }
    }

    const unitPrice = this.round(price, 4);
    const lineTotal = this.round(unitPrice * quantity, 2);

    return {
      sku,
      product_id: productId,
      name: led.name,
      branch,
      rung,
      unit_label: step.label,
      // `[COT.1b]` El factor SÓLO cuando el peldaño no es la base: en la base no hubo conversión
      // y un `1` acá se leería como afirmación. `step.size` sale de v_label_prices, o sea de las
      // dos ranuras de unidad de kdii — por eso la fuente se rotula `kepler_ladder`, no `kepler_c84`.
      unit_factor: rung === 'base' ? null : (Number(step.size) > 0 ? Number(step.size) : null),
      quantity,
      list_price: listPrice,
      unit_price: unitPrice,
      price_source: priceSource,
      line_total: lineTotal,
      tax_rate: DEFAULT_TAX_RATE,
      // El precio del ERP ya trae impuestos; la tasa del renglón todavía no tiene resolvedor por
      // producto (el IEPS vive en el renglón de VENTA, `kdm2.c18`, no en el catálogo).
      tax_basis: 'iva_16_asumido_precio_con_impuestos',
      availability: productId ? 'available' : 'unmatched',
      applied,
      not_applied: notApplied,
      volume_tier: step.volume ? { min_qty: step.volume.min_qty, price: step.volume.price } : null,
      free_goods: freeGoods,
      unpriced_reason: null,
      warnings,
    };
  }

  private unpriced(a: {
    sku: string; productId: string | null; name: string | null; branch: string; quantity: number;
    rung: Rung; reason: string; availability: string;
    applied: PriceStep[]; notApplied: { mechanism: string; reason: string }[]; warnings: string[];
  }): PricedLine {
    return {
      sku: a.sku,
      product_id: a.productId,
      name: a.name,
      branch: a.branch,
      rung: a.rung,
      unit_label: null,
      // Sin precio no hay peldaño resuelto: el factor se DECLARA ausente, no se asume 1.
      unit_factor: null,
      quantity: a.quantity,
      list_price: null,
      // NULL, nunca 0: un cero acá se leería como "no cuesta nada" (ADR-056).
      unit_price: null,
      price_source: 'unknown',
      line_total: null,
      tax_rate: DEFAULT_TAX_RATE,
      tax_basis: 'no_aplica_sin_precio',
      availability: a.availability,
      applied: a.applied,
      not_applied: a.notApplied,
      volume_tier: null,
      free_goods: null,
      unpriced_reason: a.reason,
      warnings: a.warnings,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Renglones de una cotización
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Agrega un renglón cotizado. El precio lo calcula el SERVIDOR: el request dice qué y cuánto,
   * nunca a cuánto. Si la regla del ERP regala producto, nace también el renglón hijo.
   */
  async addLine(
    quoteId: string,
    input: { sku?: string | null; requested_text?: string | null; quantity: number; rung?: Rung },
  ): Promise<AddLineResult> {
    const userId = this.tenantCtx.get()?.userId ?? null;

    try {
      return await this.tk.run(async (trx) => {
        const q = await trx.raw(
          `SELECT id, status, source_branch FROM commercial.quotes
            WHERE id = :id AND deleted_at IS NULL`,
          { id: quoteId },
        );
        if (!q.rows.length) throw new NotFoundException('Cotización no encontrada.');
        const quote = q.rows[0];
        await this.assertEscribe(quote.source_branch);
        if (quote.status !== 'draft') {
          throw new BadRequestException(
            `Sólo se le agregan renglones a una cotización en borrador (ésta está "${quote.status}"). Una cotización enviada que cambia es otra versión, no la misma.`,
          );
        }

        const sku = (input.sku || '').trim();
        let priced: PricedLine | null = null;
        if (sku) {
          if (!quote.source_branch) {
            throw new BadRequestException(
              'La cotización no dice desde qué sucursal se arma, y el precio no es el mismo en todas.',
            );
          }
          priced = await this.priceLine(trx, {
            branch: quote.source_branch,
            sku,
            quantity: input.quantity,
            rung: input.rung,
          });
        } else if (!input.requested_text || !input.requested_text.trim()) {
          throw new BadRequestException(
            'Un renglón necesita un SKU o el texto de lo que pidió el cliente. Lo que no casó con el catálogo es información, no basura: se guarda.',
          );
        }

        /**
         * `[COT.1b]` El `max+1` iba SIN candado: dos `addLine` a la vez sobre la misma cotización
         * leían el mismo número y el segundo moría contra
         * `commercial_quote_lines_quote_linenum_unique`. No es teórico — la pantalla nueva agrega
         * renglones de a uno y rápido.
         *
         * El `FOR UPDATE` va sobre la fila de la COTIZACIÓN (que ya está en esta transacción), no
         * sobre los renglones: bloquear renglones no impide que otro inserte el primero. Serializa
         * los `addLine` de una misma cotización y no toca a las demás.
         */
        await trx.raw(`SELECT id FROM commercial.quotes WHERE id = :id FOR UPDATE`, { id: quoteId });
        const next = await trx.raw(
          `SELECT coalesce(max(line_number), 0) + 1 AS n FROM commercial.quote_lines WHERE quote_id = :id`,
          { id: quoteId },
        );
        let lineNumber = Number(next.rows[0].n);

        await this.insertLine(trx, quoteId, lineNumber, priced, input, userId, null);

        // El regalo es un renglón propio, a precio cero LEGÍTIMO, colgado del que se lo ganó.
        if (priced?.free_goods && priced.free_goods.quantity > 0) {
          const parent = lineNumber;
          lineNumber += 1;
          await trx.raw(
            // `[COT.1b]` El regalo lleva su rótulo pero NO factor: la regla del ERP dice qué unidad
            // se regala (`kdpv_gratisxq.c12`) y no cuántas bases trae. Se guarda lo que se sabe y
            // se declara ausente lo que no — rellenar con 1 sería inventar la conversión.
            `INSERT INTO commercial.quote_lines
               (tenant_id, quote_id, line_number, product_id, requested_text, quantity,
                unit_price, list_price, line_subtotal, line_total, price_source, parent_line_number,
                availability, notes, qty_unit, created_by, updated_by)
             VALUES
               (public.current_tenant_id(), :quote_id, :line_number, :product_id, :requested_text, :quantity,
                0, 0, 0, 0, 'free_goods', :parent,
                :availability, :notes, :qty_unit, :user_id, :user_id)`,
            {
              quote_id: quoteId,
              line_number: lineNumber,
              product_id: priced.free_goods.product_id,
              requested_text: priced.free_goods.product_id ? null : priced.free_goods.sku,
              quantity: priced.free_goods.quantity,
              parent,
              availability: priced.free_goods.product_id ? 'available' : 'unmatched',
              notes: `Producto gratis del ERP por el renglón ${parent}`,
              qty_unit: priced.free_goods.unit_label ?? null,
              user_id: userId,
            },
          );
        }

        await this.recalcTotals(trx, quoteId);
        const count = await trx.raw(`SELECT count(*)::int AS n FROM commercial.quote_lines WHERE quote_id = :id`, {
          id: quoteId,
        });
        return { quote_id: quoteId, lines: Number(count.rows[0].n), priced };
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === '25006' || code === '42501') {
        throw new ServiceUnavailableException(
          'Base de datos en modo solo lectura para este usuario (conexión de desarrollo local). La persistencia de renglones requiere permisos de escritura (app_runtime/producción).',
        );
      }
      throw err;
    }
  }

  private async insertLine(
    trx: Knex,
    quoteId: string,
    lineNumber: number,
    priced: PricedLine | null,
    input: { sku?: string | null; requested_text?: string | null; quantity: number },
    userId: string | null,
    parent: number | null,
  ): Promise<void> {
    const qty = Number(input.quantity);
    const unit = priced?.unit_price ?? null;
    const lineTotal = unit === null ? 0 : this.round(unit * qty, 2);
    const subtotal = unit === null ? 0 : this.round(lineTotal / (1 + DEFAULT_TAX_RATE), 2);

    await trx.raw(
      // `[COT.1b]` El sello de unidad (`qty_unit`/`qty_factor`/`qty_factor_source`) entra al
      // INSERT. Antes el `rung` se usaba para PRECIAR y se tiraba: la fila guardada no decía si
      // el 10 eran 10 piezas o 10 cajas. Mismas tres columnas que `commercial.order_lines`.
      `INSERT INTO commercial.quote_lines
         (tenant_id, quote_id, line_number, product_id, requested_text, requested_quantity, quantity,
          unit_price, list_price, tax_rate, line_subtotal, line_total, price_source, parent_line_number,
          availability, notes, qty_unit, qty_factor, qty_factor_source, created_by, updated_by)
       VALUES
         (public.current_tenant_id(), :quote_id, :line_number, :product_id, :requested_text, :requested_quantity, :quantity,
          :unit_price, :list_price, :tax_rate, :line_subtotal, :line_total, :price_source, :parent,
          :availability, :notes, :qty_unit, :qty_factor, :qty_factor_source, :user_id, :user_id)`,
      {
        quote_id: quoteId,
        line_number: lineNumber,
        product_id: priced?.product_id ?? null,
        // Si no casó con el catálogo se guarda lo que el cliente escribió: es demanda que
        // estamos rechazando, y desaparece si la tabla exige product_id.
        requested_text: priced?.product_id ? null : (input.requested_text ?? input.sku ?? null),
        requested_quantity: qty,
        quantity: qty,
        unit_price: unit,
        list_price: priced?.list_price ?? null,
        tax_rate: DEFAULT_TAX_RATE,
        line_subtotal: subtotal,
        line_total: lineTotal,
        price_source: priced?.price_source ?? 'unknown',
        parent,
        availability: priced?.availability ?? 'unmatched',
        notes: priced?.unpriced_reason ?? null,
        // `[COT.1b]` El peldaño cotizado, tal como el ERP lo rotula. Los tres van juntos o no van:
        // un rótulo sin factor, o un factor sin de-dónde-salió, es media afirmación.
        qty_unit: priced?.unit_label ?? null,
        qty_factor: priced?.unit_factor ?? null,
        qty_factor_source: priced?.unit_factor != null ? 'kepler_ladder' : null,
        user_id: userId,
      },
    );
  }

  /**
   * `[COT.1b]` Cambia la cantidad (y opcionalmente el peldaño) de un renglón ya cotizado.
   *
   * ── Por qué hacía falta un verbo propio ─────────────────────────────────────────────────────
   *
   * Sin esto, corregir un "10" por un "12" obligaba a borrar y volver a agregar. Y
   * `line_number` es `max+1` y **nunca se reusa**, así que el renglón corregido se iba al final:
   * la cotización dejaba de estar en el orden de la lista que mandó el cliente — que es
   * exactamente lo que este módulo existe para conservar.
   *
   * ── ⭐ Y acá cotizaciones DIFIERE de pedidos, a propósito ────────────────────────────────────
   *
   * `OrdersService.updateLine` **no re-tarifica** (`commercial-orders.service.ts:842`): conserva
   * el `unit_price` del snapshot. Por eso en `/vendor/take-order` el `+` del stepper nunca
   * dispara el precio de mayoreo, aunque la fila diga "Faltan N para mayoreo" — el PATCH pasa por
   * ahí y el precio se queda quieto.
   *
   * En una cotización ese comportamiento sería un defecto: el precio **es** el producto. Subir la
   * cantidad puede cruzar el umbral de volumen o activar una promo del ERP, y el operador tiene
   * que ver el precio nuevo antes de mandarlo. Así que esto **vuelve a correr el motor entero** y
   * devuelve el desglose.
   *
   * Los renglones de regalo se recalculan con él: la regla que los engendró depende de la
   * cantidad, así que cambiarla puede darlos de alta, de baja o cambiarles el número.
   */
  async updateLine(
    quoteId: string,
    lineId: string,
    input: { quantity: number; rung?: Rung },
  ): Promise<AddLineResult> {
    const userId = this.tenantCtx.get()?.userId ?? null;

    return this.tk.run(async (trx) => {
      const q = await trx.raw(
        `SELECT id, status, source_branch FROM commercial.quotes
          WHERE id = :id AND deleted_at IS NULL
          FOR UPDATE`,
        { id: quoteId },
      );
      if (!q.rows.length) throw new NotFoundException('Cotización no encontrada.');
      const quote = q.rows[0];
      await this.assertEscribe(quote.source_branch);
      if (quote.status !== 'draft') {
        throw new BadRequestException(
          `Sólo se editan renglones de una cotización en borrador (ésta está "${quote.status}").`,
        );
      }

      const cur = await trx.raw(
        `SELECT id, line_number, product_id, requested_text, parent_line_number, qty_unit
           FROM commercial.quote_lines
          WHERE id = :lid AND quote_id = :qid`,
        { lid: lineId, qid: quoteId },
      );
      if (!cur.rows.length) throw new NotFoundException('Renglón no encontrado.');
      const line = cur.rows[0];

      // Un regalo no se edita: lo pone y lo quita la regla del ERP sobre el renglón padre.
      // Dejar cambiarlo a mano convertiría un beneficio derivado en un dato inventado.
      if (line.parent_line_number !== null) {
        throw new BadRequestException(
          'Ese renglón es un producto gratis que puso la regla del ERP. Se cambia editando el renglón que se lo ganó, no él.',
        );
      }

      const qty = Number(input.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException('La cantidad tiene que ser mayor que cero. Para quitarlo, usá borrar el renglón.');
      }

      // El SKU sale del renglón, no del request: editar una cantidad no puede cambiar el producto.
      const sku = await this.skuDelRenglon(trx, line);
      let priced: PricedLine | null = null;
      if (sku) {
        if (!quote.source_branch) {
          throw new BadRequestException(
            'La cotización no dice desde qué sucursal se arma, y el precio no es el mismo en todas.',
          );
        }
        priced = await this.priceLine(trx, {
          branch: quote.source_branch,
          sku,
          quantity: qty,
          // Sin peldaño explícito se conserva el que ya tenía el renglón: una edición de cantidad
          // no debe mover la unidad en silencio. El rótulo se resuelve DENTRO de `priceLine`,
          // que es donde está la escalera de este sku (el rótulo solo no alcanza para decidir).
          rung: input.rung,
          rung_label: line.qty_unit,
        });
      }

      const n = Number(line.line_number);
      // Los regalos viejos se van: la regla se vuelve a evaluar con la cantidad nueva.
      await trx.raw(`DELETE FROM commercial.quote_lines WHERE quote_id = :qid AND parent_line_number = :n`, {
        qid: quoteId,
        n,
      });

      const unit = priced?.unit_price ?? null;
      const lineTotal = unit === null ? 0 : this.round(unit * qty, 2);
      const subtotal = unit === null ? 0 : this.round(lineTotal / (1 + DEFAULT_TAX_RATE), 2);

      await trx.raw(
        `UPDATE commercial.quote_lines
            SET quantity = :quantity,
                unit_price = :unit_price,
                list_price = :list_price,
                line_subtotal = :line_subtotal,
                line_total = :line_total,
                price_source = :price_source,
                availability = :availability,
                notes = :notes,
                qty_unit = :qty_unit,
                qty_factor = :qty_factor,
                qty_factor_source = :qty_factor_source,
                updated_at = now(),
                updated_by = :user_id
          WHERE id = :lid AND quote_id = :qid`,
        {
          lid: lineId,
          qid: quoteId,
          quantity: qty,
          unit_price: unit,
          list_price: priced?.list_price ?? null,
          line_subtotal: subtotal,
          line_total: lineTotal,
          price_source: priced?.price_source ?? 'unknown',
          availability: priced?.availability ?? 'unmatched',
          notes: priced?.unpriced_reason ?? null,
          qty_unit: priced?.unit_label ?? null,
          qty_factor: priced?.unit_factor ?? null,
          qty_factor_source: priced?.unit_factor != null ? 'kepler_ladder' : null,
          user_id: userId,
        },
      );

      // ⚠️ `requested_quantity` NO se toca: es lo que el cliente PIDIÓ, y la corrección del
      // operador no reescribe el pedido original. Es la misma distinción que `order_lines`.

      if (priced?.free_goods && priced.free_goods.quantity > 0) {
        const nextN = await trx.raw(
          `SELECT coalesce(max(line_number), 0) + 1 AS n FROM commercial.quote_lines WHERE quote_id = :id`,
          { id: quoteId },
        );
        await trx.raw(
          `INSERT INTO commercial.quote_lines
             (tenant_id, quote_id, line_number, product_id, requested_text, quantity,
              unit_price, list_price, line_subtotal, line_total, price_source, parent_line_number,
              availability, notes, qty_unit, created_by, updated_by)
           VALUES
             (public.current_tenant_id(), :quote_id, :line_number, :product_id, :requested_text, :quantity,
              0, 0, 0, 0, 'free_goods', :parent,
              :availability, :notes, :qty_unit, :user_id, :user_id)`,
          {
            quote_id: quoteId,
            line_number: Number(nextN.rows[0].n),
            product_id: priced.free_goods.product_id,
            requested_text: priced.free_goods.product_id ? null : priced.free_goods.sku,
            quantity: priced.free_goods.quantity,
            parent: n,
            availability: priced.free_goods.product_id ? 'available' : 'unmatched',
            notes: `Producto gratis del ERP por el renglón ${n}`,
            qty_unit: priced.free_goods.unit_label ?? null,
            user_id: userId,
          },
        );
      }

      await this.recalcTotals(trx, quoteId);
      const count = await trx.raw(`SELECT count(*)::int AS n FROM commercial.quote_lines WHERE quote_id = :id`, {
        id: quoteId,
      });
      return { quote_id: quoteId, lines: Number(count.rows[0].n), priced };
    });
  }

  /**
   * El SKU con el que se precia un renglón ya guardado. Sale del catálogo si casó, y del texto
   * crudo si no — que es el mismo orden que usa `addLine`. `null` = no hay con qué precia, y el
   * renglón se queda declarado sin precio (no es un error: es demanda que no manejamos).
   */
  private async skuDelRenglon(
    trx: Knex,
    line: { product_id: string | null; requested_text: string | null },
  ): Promise<string | null> {
    if (line.product_id) {
      const p = await trx.raw(`SELECT btrim(sku) AS sku FROM catalog.products WHERE id = :id`, {
        id: line.product_id,
      });
      return p.rows.length ? (p.rows[0].sku || null) : null;
    }
    return (line.requested_text || '').trim() || null;
  }

  /** Ver la función pura `rungDeRotulo` de este módulo: ahí está el porqué y ahí se prueba. */
  private rungDeRotulo(label: string | null, led: LadderParaRotulo | null): Rung {
    return rungDeRotulo(label, led);
  }

  async removeLine(quoteId: string, lineId: string): Promise<RemoveLineResult> {
    return this.tk.run(async (trx) => {
      const q = await trx.raw(`SELECT status, source_branch FROM commercial.quotes WHERE id = :id AND deleted_at IS NULL`, {
        id: quoteId,
      });
      if (!q.rows.length) throw new NotFoundException('Cotización no encontrada.');
      await this.assertEscribe(q.rows[0].source_branch);
      if (q.rows[0].status !== 'draft') {
        throw new BadRequestException('Sólo se editan renglones de una cotización en borrador.');
      }
      const line = await trx.raw(
        `SELECT line_number FROM commercial.quote_lines WHERE id = :lid AND quote_id = :qid`,
        { lid: lineId, qid: quoteId },
      );
      if (!line.rows.length) throw new NotFoundException('Renglón no encontrado.');
      const n = Number(line.rows[0].line_number);

      // Se va con sus hijos: un regalo huérfano parece un error de captura.
      const del = await trx.raw(
        `DELETE FROM commercial.quote_lines
          WHERE quote_id = :qid AND (id = :lid OR parent_line_number = :n)`,
        { qid: quoteId, lid: lineId, n },
      );
      await this.recalcTotals(trx, quoteId);
      return { quote_id: quoteId, removed: del.rowCount ?? 0 };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Totales: acá —y sólo acá— entra el descuento del CLIENTE
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Recalcula la cabecera. El descuento del cliente (`terms_discount_pct`) es la **capa
   * documento** y se aplica sobre el subtotal, nunca sobre el precio unitario (§3.1 de
   * `ERP_KEPLER.md`): en el ERP son dos números que conviven y no se explican entre sí.
   *
   * ⚠️ Un renglón sin precio (`unit_price IS NULL`) aporta **0 al total pero no lo invalida**: la
   * cotización se puede enviar con renglones declarados como "sin precio", que es justamente lo
   * que hoy se borra del Excel y nadie vuelve a ver.
   */
  async recalcTotals(trx: Knex, quoteId: string): Promise<{ subtotal: number; tax_total: number; total: number }> {
    const agg = await trx.raw(
      `SELECT coalesce(sum(line_total), 0) AS bruto
         FROM commercial.quote_lines
        WHERE quote_id = :id`,
      { id: quoteId },
    );
    const bruto = Number(agg.rows[0].bruto);

    const q = await trx.raw(
      `SELECT terms_discount_pct FROM commercial.quotes WHERE id = :id`,
      { id: quoteId },
    );
    // Sin fila (o sin descuento configurado) el porcentaje es NULL, no 0: "nadie configuró un
    // descuento" y "el descuento es cero" son cosas distintas, y `Number(undefined)` sería NaN
    // —que se propagaría al total y quedaría escrito en la cotización.
    const raw = q.rows.length ? q.rows[0].terms_discount_pct : null;
    const pct = raw === null || raw === undefined ? null : Number(raw);
    if (pct !== null && !Number.isFinite(pct)) {
      throw new BadRequestException('El descuento congelado de la cotización no es un número.');
    }

    const total = pct ? this.round(bruto * (1 - pct / 100), 2) : this.round(bruto, 2);
    const subtotal = this.round(total / (1 + DEFAULT_TAX_RATE), 2);
    const tax = this.round(total - subtotal, 2);

    await trx.raw(
      `UPDATE commercial.quotes
          SET subtotal = :subtotal, tax_total = :tax, total = :total, updated_at = now()
        WHERE id = :id`,
      { id: quoteId, subtotal, tax, total },
    );
    return { subtotal, tax_total: tax, total };
  }

  private round(n: number, decimals: number): number {
    const f = 10 ** decimals;
    return Math.round((n + Number.EPSILON) * f) / f;
  }
}
