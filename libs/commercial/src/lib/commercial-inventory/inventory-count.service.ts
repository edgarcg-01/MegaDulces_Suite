import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TenantKnexService, TenantContextService, applySmartSearch } from '@megadulces/platform-core';
import { InventoryMonitorGateway } from './inventory-monitor.gateway';

/**
 * `[IC.15]` Los estados en los que un folio está VIVO, o sea que ocupa su lugar en la llave
 * `(almacén, ritmo)` y sus SKUs no pueden estar en otro folio. Es la MISMA lista que el índice
 * parcial `commercial_inv_counts_one_open_per_wh_ritmo`: si las dos se separan, el servicio
 * dejaría pasar lo que la base rechaza (o al revés), y el error saldría como una violación de
 * índice sin explicación en vez de como un mensaje que se entiende.
 */
const VIVOS = ['open', 'counting', 'review', 'ready_to_reconcile'] as const;

/**
 * Un renglón de la lista del supervisor, tal como sale de `listItems`. Se declara acá y no en
 * `libs/contracts` porque todavía no hay contrato de inventario físico: es **deuda con nombre**
 * (ADR-056), no un tipo inventado para callar la compuerta. Cuando el contrato exista, esto se
 * borra y se importa de ahí.
 */
export interface InventoryCountItemRow {
  id: string;
  product_id: string | null;
  sku: string | null;
  product_name: string | null;
  brand_name: string | null;
  /** `[IC.UB1]` Del catálogo de `/almacen/ubicaciones`, no de `public.products`. */
  location: string | null;
  /**
   * `[ICR.0.3]` El pedazo de recorrido donde el producto se encuentra **primero** al caminar
   * (`zona-pasillo`: `T-A`). `null` = no tiene ubicación asignada — el tramo «sin ubicar», que es
   * trabajo real y hoy se lleva la enorme mayoría del folio.
   */
  tramo: string | null;
  /**
   * `[ICR.0.4]` Cuántos tramos distintos ocupa. `0` = ninguno. ⭐ **`> 1` importa**: contar sólo
   * donde dice `tramo` dejaría mercancía del mismo producto sin contar en otra parte.
   */
  tramos: number;
  expected_qty: string | number | null;
  count_1: string | number | null;
  count_2: string | number | null;
  count_3: string | number | null;
  final_qty: string | number | null;
  variance: string | number | null;
  status: string;
  notes: string | null;
  reason_code: string | null;
  cost_base: string | number | null;
  /**
   * `[IC.F24]` En qué unidad DIJO contar cada persona. `count_N` ya viene normalizado a la
   * unidad del teórico; esto es el testigo de la conversión. `null` = no se declaró.
   */
  count_1_unit: string | null;
  count_2_unit: string | null;
  count_3_unit: string | null;
}

/**
 * Lo mínimo que `codigosDeUbicacion` necesita de la transacción. Se tipa estructuralmente en vez
 * de `any` para que el compilador vea la forma de lo que devuelve `raw` — que es de dónde sale el
 * `codigos` de más abajo.
 */
interface TrxConRaw {
  raw(sql: string, bindings?: unknown[]): Promise<{ rows?: { codigos: string | null }[] }>;
}

/**
 * `[ICR.M10]` Lo mínimo que `resolverProductoPorCodigo` le pide a la transacción, tipado
 * estructuralmente en vez de `any` para que el compilador vea la forma de lo que devuelve
 * (igual que `TrxConRaw`, y por el mismo motivo: ADR-052 / el boundary gate).
 */
export interface FilaDeProducto {
  id: string;
  sku: string | null;
  nombre: string | null;
  barcode: string | null;
  /** `[ICR.M11]` Sólo cuando la fila salió de `catalog.product_barcodes`. */
  unit?: string | null;
  factor?: string | number | null;
  is_primary?: boolean | null;
}

/**
 * `[ICR.M11]` Lo que se sabe del código que se escaneó, no sólo a qué producto apunta.
 *
 * ⭐ `unidad_del_codigo` es lo que vuelve contable una CAJA: el código de la caja **dice** que
 * es una caja. Pero el factor casi nunca está (medido: **248 de 254** códigos `CJA` del folio de
 * Yurécuaro tienen `factor` NULL), así que esto se **informa y no se aplica**.
 */
export interface CodigoResuelto {
  product_id: string;
  fuente: string;
  unidad_del_codigo: string | null;
  factor_del_codigo: number | null;
  /** `true` = es el código que viene con el SKU, o sea la unidad NATIVA. `null` = no se sabe. */
  es_codigo_nativo: boolean | null;
}

/** El sub-builder que arma el `WHERE` de un nivel de resolución. */
export interface FiltroDeCodigoBuilder {
  where(columna: string, valor: unknown): FiltroDeCodigoBuilder;
  orWhere(columna: string, valor: unknown): FiltroDeCodigoBuilder;
  whereRaw(sql: string, bindings: unknown[]): FiltroDeCodigoBuilder;
}
export type FiltroDeCodigo = (qb: FiltroDeCodigoBuilder) => unknown;

interface ConsultaDeProductos {
  join(tabla: string, a: string, b: string): ConsultaDeProductos;
  where(columnaOFiltro: string | FiltroDeCodigo, valor?: unknown): ConsultaDeProductos;
  andWhere(filtro: FiltroDeCodigo): ConsultaDeProductos;
  whereNull(columna: string): ConsultaDeProductos;
  orderBy(columna: string, direccion?: string): ConsultaDeProductos;
  distinct(...columnas: string[]): Promise<FilaDeProducto[]>;
}
export type TrxConsultable = (tabla: string) => ConsultaDeProductos;

/**
 * ⛔⛔ `[IC.UB1]` **La ubicación que se publica sale del catálogo de `/almacen/ubicaciones`,
 * no de `public.products.location`.**
 *
 * Medido en prod el 2026-11-27: `public.products.location` tiene **UN SOLO valor distinto**
 * en los 11,816 productos que la traen — la cadena `Z000` — y el folio la copiaba al abrir:
 * **3,005 de los 3,364 artículos de `INV-2026-00010` decían `Z000`**. O sea que la columna
 * «Ubic.» del supervisor y el renglón que ve el contador no mostraban una ubicación: mostraban
 * una constante con cara de dato. Es el defecto del rótulo que miente (Cruce 2), agravado
 * porque la columna se veía **llena** y por eso nadie la cuestionaba.
 *
 * El catálogo real existe y es el de la fase UB (ADR-090): **476 ubicaciones** en
 * `commercial.warehouse_bins` (471 de Padre Hidalgo) y **52 asignaciones** producto↔ubicación
 * en `commercial.bin_assignments`. De las 51 vivas, **0 coincidían** con `p.location` y 50
 * discrepaban (`Z000` contra `TA011`, por ejemplo): no eran dos versiones del mismo dato,
 * eran un dato y un relleno.
 *
 * ⚠️ El cambio BAJA la cobertura aparente de 3,005 a 51, y así debe ser (regla 11): lo que
 * no está asignado se declara vacío en vez de dibujarse. El trabajo de asignar las otras
 * 3,313 es de `/almacen/ubicaciones/asignacion`, y ahora se ve cuánto falta.
 *
 * Un producto puede estar en varias ubicaciones (medido: 5 en dos y 3 en tres), así que se
 * devuelven todas, en el orden en que se recorre el almacén (`pick_sequence`).
 *
 * ── `[ICR.0.2]` De dónde sale ahora ──────────────────────────────────────────────────────
 * De la vista `commercial.v_product_bin_location`, no de las dos tablas: la consulta de acá se
 * había escrito aparte de la del surtido y ya se estaban separando —ésta **no excluía las
 * ubicaciones dadas de baja**—, que es lo que ADR-056 cobra. Hoy no cambia ningún número (476 de
 * 476 están `activa`); la que cambiaba era la siguiente.
 *
 * ── `[ICR.0.3][ICR.0.4]` El tramo, y por qué se declara en vez de resolverse ─────────────
 * `tramo` es el pedazo de recorrido donde el producto **se encuentra primero al caminar**
 * (`pick_sequence` más chico), y `tramos` **cuántos pedazos distintos** ocupa. Se publican los dos
 * a propósito: con `tramos > 1`, decir sólo el primero escondería que hay mercancía del mismo
 * producto en otra parte, y quien contara ese tramo reportaría de menos sin saberlo. El renglón
 * **dice** que está en dos lugares; repartir el conteo por ubicación en vez de por producto es
 * `[ICR.1.1]`, y hasta que esa decisión se tome, esto no se resuelve en silencio (regla 11).
 *
 * ⛔ Acá NO se aplica la prioridad de `papel` (lugar fijo > exhibición > reserva). Esa regla vive
 * en `warehouse-locations/ubicacion-del-producto.ts` y sirve para decidir **a dónde mandar a
 * alguien**; el conteo no manda a un lugar: tiene que recorrerlos todos.
 */
const UBICACION_DEL_PRODUCTO = `
  SELECT string_agg(v.bin_code, ' · ' ORDER BY v.pick_sequence NULLS LAST, v.bin_code) AS codigos,
         (array_agg(v.tramo ORDER BY v.pick_sequence NULLS LAST, v.bin_code))[1] AS tramo,
         count(DISTINCT v.tramo)::int AS tramos
    FROM commercial.v_product_bin_location v
   WHERE v.warehouse_id = ?::uuid
`;

/**
 * Fase I — Inventario físico (conteo cíclico/total por almacén).
 *
 * Modela el proceso "hacer inventario" como sesión digital con conteo CIEGO,
 * doble conteo por contadores distintos y reconciliación auditable.
 *
 * Jerarquía (permisos):
 *   contador     (CONTAR)      → cuenta a ciegas; nunca ve el teórico ni la varianza.
 *   supervisor   (SUPERVISAR)  → abre folio, analiza avance, resuelve discrepancias.
 *   reconciliador(RECONCILIAR) → autoriza el ajuste del saldo (mueve dinero) y cierra.
 *
 * Controles embebidos:
 *   - Conteo ciego: submitCount NUNCA devuelve expected_qty.
 *   - Segregación de funciones: count_2 lo hace un usuario != count_1; el
 *     reconciliador no puede ser quien contó ningún item del folio.
 *   - Coverage guard: no se reconcilia si hay SKUs sin ningún conteo
 *     (un "no contado" jamás se trata como cero → no se destruye stock real).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `[IC.15]` Cada cuándo y para qué se cuenta. Eje **ortogonal** a `type`, que dice
 * todo-vs-subconjunto: el diario es `cycle`+`diario`, el físico de Kepler es `full`+`trimestral`.
 * `adhoc` es el default y es honesto: un folio que alguien abrió a mano no pertenece a un ritmo.
 */
export type RitmoConteo = 'diario' | 'mensual' | 'trimestral' | 'adhoc';

export interface OpenCountDto {
  warehouse_id: string;
  type?: 'full' | 'cycle';
  /** `[IC.15]` La llave del folio vivo es (almacén, ritmo): dos ritmos pueden coexistir. */
  ritmo?: RitmoConteo;
  freeze_movements?: boolean;
  blind_double_count?: boolean;
  /**
   * ⛔ `[ICR.M7]` Umbral % de varianza que fuerza recuento (count-back). **OBLIGATORIO**: sin
   * él no se abre folio. `0` = red apagada, y entonces hace falta `recount_threshold_ack`.
   */
  recount_threshold_pct?: number;
  /**
   * `[ICR.M7]` «Sí, quiero abrirlo con la red apagada y sé qué apaga.» Sólo se mira cuando el
   * umbral es 0; es lo que distingue un cero **decidido** del cero por omisión de un formulario.
   */
  recount_threshold_ack?: boolean;
  notes?: string;
  /** ABC.2 — si se pasa, el folio cuenta SOLO estos productos (folio cíclico acotado). */
  product_ids?: string[];
}

export interface OpenCycleCountDto {
  warehouse_id: string;
  /** `[IC.15]` El ritmo al que pertenece este folio cíclico. Default `adhoc`. */
  ritmo?: RitmoConteo;
  /** Clase ABC a contar (A|B|C). Toma los productos de esa clase del almacén. */
  abc_class?: string;
  /** Lista explícita de productos (alternativa a abc_class). */
  product_ids?: string[];
  /** Tope de SKUs en el folio (default 100). */
  max_items?: number;
  freeze_movements?: boolean;
  blind_double_count?: boolean;
  /** ⛔ `[ICR.M7]` Obligatorio, igual que en `openCount`: el folio cíclico tampoco nace sin red. */
  recount_threshold_pct?: number;
  /** `[ICR.M7]` Ver `OpenCountDto.recount_threshold_ack`. */
  recount_threshold_ack?: boolean;
  notes?: string;
}

export interface SubmitCountDto {
  product_id?: string;
  barcode?: string;
  quantity: number;
  /** Forzar tercer conteo (reconteo ordenado por supervisor). */
  recount?: boolean;
  /** OFF.0 — idempotencia offline: UUID del escaneo generado en el cliente.
   *  Si ya se aplicó (replay de la cola), submitCount es no-op. */
  scan_uuid?: string;
  /** OFF.0 — fase (1|2) en que se CAPTURÓ el escaneo, para colocar el slot
   *  correcto al sincronizar aunque el folio ya haya avanzado de fase. */
  capture_pass?: number;
  /**
   * `[IC.F24]` La unidad en que la persona dice haber contado (`PAQ`, `CJA`, `PZA`…).
   * Si no viene, se usa la del código que trae el SKU — que es la unidad NATIVA, la misma
   * del teórico. Si viene otra, la cantidad se normaliza con su factor antes de guardarse.
   */
  unit?: string;
  /**
   * ⭐ `[ICR.M3]` **El rack DONDE SE ESTÁ PARADO**, no donde el catálogo dice que va el
   * producto. Es la tercera pata de la identidad de la captura `(renglón, rack, persona,
   * vuelta)`: el mismo producto en dos racks **suma** en vez de perderse (F35).
   *
   * Opcional a propósito: hoy casi ningún almacén tiene pasillos dados de alta (Yurécuaro
   * tiene **0**), y sin rack todas las capturas caen en el montón «sin rack», que es un rack
   * más. Si no viene y la persona está acotada a UN pasillo, se usa ése.
   */
  aisle_id?: string;
}

/**
 * `[ICR.M3]` Una captura de la bitácora, tal como se lee para recomponer `count_N`.
 *
 * Su **identidad** es `(item_id, slot, aisle_id, applied_by)`. De cada identidad vive **la más
 * reciente**: por eso una recaptura de la misma persona en el mismo rack **corrige** y una
 * captura en otro rack (o de otra persona) **suma**.
 */
export interface CapturaDeConteo {
  scan_uuid: string;
  item_id: string;
  slot: string;
  aisle_id: string | null;
  applied_by: string | null;
  applied_at: string | Date;
  quantity_native: string | number;
}

/** `[IC.F24]` Una unidad en que se puede contar un producto, con su factor contra la nativa. */
export interface UnidadDeConteo {
  unit: string;
  /** Unidades NATIVAS por cada una de ésta. La nativa vale 1. */
  factor: number;
  /** `true` si es la del código que viene con el SKU (`is_primary`): la nativa. */
  es_nativa: boolean;
}

export interface ResolveItemDto {
  final_qty: number;
  notes?: string;
  reason_code?: string;
}

/**
 * Taxonomía de motivos de varianza (clasificación de la diferencia físico vs
 * teórico). Validada a nivel servicio — el negocio puede extenderla sin migración.
 * `caducado` es clave para dulcería (producto vencido).
 */
export const VARIANCE_REASONS: { code: string; label: string }[] = [
  { code: 'merma', label: 'Merma (pérdida no explicada)' },
  { code: 'caducado', label: 'Caducado / vencido' },
  { code: 'dañado', label: 'Dañado' },
  { code: 'robo', label: 'Robo / hurto' },
  { code: 'error_conteo', label: 'Error de conteo previo' },
  { code: 'error_sistema', label: 'Error de sistema / captura (venta no registrada)' },
  { code: 'devolucion', label: 'Devolución no registrada' },
  { code: 'transferencia', label: 'Transferencia no registrada' },
  { code: 'encontrado', label: 'Encontrado / sobrante' },
  { code: 'otro', label: 'Otro (detallar en notas)' },
];
export const VARIANCE_REASON_CODES = VARIANCE_REASONS.map((r) => r.code);

@Injectable()
export class InventoryCountService {
  private readonly logger = new Logger(InventoryCountService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly monitor: InventoryMonitorGateway,
  ) {}

  private userId(): string | null {
    return this.tenantCtx.get()?.userId || null;
  }

  /**
   * Resuelve un código en `inventory.products` SIN el anti-patrón "codigo_barras OR sku + .first()"
   * (liga el producto equivocado en las colisiones sku↔codigo_barras). Prefiere match exacto por sku;
   * si el código es AMBIGUO (>1 producto), LANZA en vez de tomar el primero. Devuelve null si no existe.
   */
  private async resolveInvByCode(trx: any, code: string): Promise<any | null> {
    const c = String(code || '').trim();
    if (!c) return null;
    let cands = await trx('inventory.products')
      .where((b: any) => b.where('codigo_barras', c).orWhere('sku', c))
      .distinct('sku', 'nombre', 'codigo_barras', 'unidad_venta', 'categoria');
    // `[ICR.M10]` Segundo intento, SÓLO si el exacto no encontró nada: el escáner en modo
    // EAN-13 agrega un cero adelante al UPC-A y la comparación de cadena falla. El SKU no
    // entra acá a propósito (ver `normalizarCodigoDeBarras`).
    const norm = InventoryCountService.normalizarCodigoDeBarras(c);
    if (!cands.length && norm) {
      cands = await trx('inventory.products')
        .whereRaw(
          `codigo_barras ~ '^[0-9]{8,14}$' AND COALESCE(NULLIF(ltrim(codigo_barras, '0'), ''), '0') = ?`,
          [norm],
        )
        .distinct('sku', 'nombre', 'codigo_barras', 'unidad_venta', 'categoria');
    }
    if (!cands.length) return null;
    const bySku = Array.from(new Map(cands.map((r: any) => [String(r.sku), r])).values());
    if (bySku.length === 1) return bySku[0];
    const exact = bySku.filter((r: any) => String(r.sku) === c);
    if (exact.length === 1) return exact[0];
    throw new ConflictException(`Código '${c}' ambiguo: coincide con ${bySku.length} productos. Escanea el código de barras específico.`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // `[ICR.M10]` El código que el escáner EMITE no es, carácter por carácter, el que está guardado
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * ⛔⛔ **Un escáner en modo EAN-13 le pone un cero adelante a un UPC-A de 12 dígitos**, y la
   * comparación exacta de cadena deja de machear: la pantalla dice «producto no encontrado»
   * para un producto que sí está en el folio. Al revés también pasa.
   *
   * ── Lo medido (pg-prod, sólo lectura, 2026-11-27; universo = los 2,024 artículos con
   *    existencia de Yurécuaro, `system_identifier` 7688376744939610156) ─────────────────────
   *
   *  · 2,313 códigos distintos: **1,468 de 13 dígitos** (EAN-13) y **786 de 12** (UPC-A), 36 de
   *    8 y 20 de 14. Todos numéricos. O sea que **el 39 % del folio es UPC-A** y queda expuesto.
   *  · **117 de los de 12 dígitos ya empiezan con cero**, y **21 códigos existen en las dos
   *    formas a la vez** (el de 12 y el mismo con un cero adelante): no es un riesgo teórico,
   *    está en los datos.
   *
   * ── El control negativo, que es lo que vuelve barato el arreglo ───────────────────────────
   *
   * Normalizar quitando ceros a la izquierda **crea ambigüedad nueva**, y hay que saber cuánta:
   * en `public.products`, los códigos que apuntan a más de un producto pasan de **713 a 718**
   * globales (+5) y de **8 a 10** dentro del universo de Yurécuaro (+2). Es barato —y por eso
   * la normalización se acota a `^[0-9]{8,14}$`: sin ese recorte el salto global era de +12,
   * porque arrastraba los 336 códigos internos de 5 dígitos, donde un cero adelante no
   * significa nada.
   *
   * ⛔ **El SKU NO se normaliza**, sólo el código de barras. El cero de más lo pone el escáner
   * leyendo un EAN/UPC; un SKU como `00182` lo teclea una persona y quitarle los ceros lo
   * confundiría con el `182` de otro producto.
   *
   * Devuelve `null` cuando el código no tiene forma de EAN/UPC: ahí no hay nada que normalizar.
   */
  private static normalizarCodigoDeBarras(code: string): string | null {
    const c = String(code ?? '').trim();
    if (!/^[0-9]{8,14}$/.test(c)) return null;
    return c.replace(/^0+/, '') || '0';
  }

  /**
   * ⛔ `[ICR.M10]` Un código que apunta a más de un producto **no se resuelve solo**.
   *
   * Tomar la primera fila elige un producto al azar y el conteo sale mal **sin que nadie lo
   * note**: la mercancía contada entra en el renglón equivocado y el verdadero sale como
   * faltante. Se devuelve 409 con los candidatos para que la pantalla pregunte, y quien
   * contesta reenvía con `product_id`.
   */
  private codigoAmbiguo(code: string, filas: FilaDeProducto[]): never {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      /** Llave estable para que la pantalla lo distinga de los demás 409. */
      code: 'CODIGO_AMBIGUO',
      message:
        `El código '${code}' coincide con ${filas.length} productos distintos. `
        + 'Elegí cuál contaste y reenvía con product_id.',
      barcode: code,
      candidates: filas.map((p) => ({
        product_id: p.id,
        sku: p.sku,
        product_name: p.nombre,
        barcode: p.barcode,
      })),
    });
  }

  /**
   * `[ICR.M10]` Resuelve un código escaneado a **UN** `product_id`, por niveles.
   *
   * El orden importa y es el que ya tenía `[IC.F1]`: **primero el folio, después el catálogo**
   * —el catálogo tiene el mismo producto más de una vez y buscar ahí primero devolvía la fila
   * duplicada, creando un renglón nuevo con teórico 0 que impedía cerrar el folio para
   * siempre—. Lo que se agrega es un segundo intento **normalizado** dentro de cada nivel:
   *
   *   1. folio · exacto (barcode o sku) · 2. folio · barcode normalizado
   *   3. catálogo · exacto · 4. catálogo · barcode normalizado
   *
   * ⭐ **Exacta antes que normalizada, siempre**: si el código tal cual existe, ése gana, y la
   * normalización nunca puede desviar un escaneo que hoy funciona.
   *
   * `conSkuGlobal` separa a los dos llamadores: `submitCount` nunca buscó por SKU fuera del
   * folio (un SKU suelto que casa con otro producto sería un sobrante falso) y `resolveProduct`
   * sí. Se mantiene cada uno como estaba.
   */
  private async resolverProductoPorCodigo(
    trx: TrxConsultable,
    countId: string | null,
    code: string,
    conSkuGlobal = false,
  ): Promise<CodigoResuelto | null> {
    const c = String(code ?? '').trim();
    if (!c) return null;
    const norm = InventoryCountService.normalizarCodigoDeBarras(c);
    // `NULLIF(...,'0')` cubre el borde: un código de puros ceros deja la cadena vacía al
    // quitarlos, y '' no es lo mismo que '0'.
    const NORM_PP = `p.barcode ~ '^[0-9]{8,14}$' AND COALESCE(NULLIF(ltrim(p.barcode, '0'), ''), '0') = ?`;
    const NORM_PB = `b.barcode ~ '^[0-9]{8,14}$' AND COALESCE(NULLIF(ltrim(b.barcode, '0'), ''), '0') = ?`;

    // ── Las dos fuentes ───────────────────────────────────────────────────────────────────
    const enElFolio = (donde: FiltroDeCodigo) =>
      trx('commercial.inventory_count_items as i')
        .join('public.products as p', 'p.id', 'i.product_id')
        .where('i.count_id', countId)
        .andWhere(donde)
        .distinct('p.id', 'p.sku', 'p.nombre', 'p.barcode');
    const enElCatalogo = (donde: FiltroDeCodigo) =>
      trx('public.products as p').where(donde).distinct('p.id', 'p.sku', 'p.nombre', 'p.barcode');
    /**
     * `[ICR.M11]` La tabla de CÓDIGOS, que es donde están los que la gente escanea de verdad:
     * varios por producto, incluido el de la **caja**. El orden de desempate es el mismo que
     * usa `unidadesDeConteo` —primario primero, después el factor más chico—, para que dos
     * filas del mismo producto no devuelvan una unidad u otra según el humor del planner.
     */
    const enLosCodigosDelFolio = (donde: FiltroDeCodigo) =>
      trx('catalog.product_barcodes as b')
        .join('commercial.inventory_count_items as i', 'i.product_id', 'b.product_id')
        .join('public.products as p', 'p.id', 'b.product_id')
        .where('i.count_id', countId)
        .whereNull('b.deleted_at')
        .andWhere(donde)
        .orderBy('b.is_primary', 'desc')
        .orderBy('b.factor', 'asc')
        .distinct('p.id', 'p.sku', 'p.nombre', 'b.barcode', 'b.unit', 'b.factor', 'b.is_primary');
    const enLosCodigosDelCatalogo = (donde: FiltroDeCodigo) =>
      trx('catalog.product_barcodes as b')
        .join('public.products as p', 'p.id', 'b.product_id')
        .whereNull('b.deleted_at')
        .andWhere(donde)
        .orderBy('b.is_primary', 'desc')
        .orderBy('b.factor', 'asc')
        .distinct('p.id', 'p.sku', 'p.nombre', 'b.barcode', 'b.unit', 'b.factor', 'b.is_primary');

    // ── La escalera ───────────────────────────────────────────────────────────────────────
    //
    // ⭐ Dos ejes, y el orden de los dos importa:
    //   · **folio antes que catálogo** — `[IC.F1]`: el catálogo tiene el mismo producto más de
    //     una vez y resolver ahí primero devuelve la fila duplicada, que crea un renglón nuevo
    //     con teórico 0 y deja el folio sin poder cerrarse nunca;
    //   · **exacta antes que normalizada** — `[ICR.M10]`: un código que existe tal cual gana.
    //
    // Y dentro de cada casilla, **`public.products` antes que `catalog.product_barcodes`**: así
    // ningún escaneo que hoy funciona puede cambiar de respuesta. Medido (prod, 2026-11-27,
    // 2,313 códigos del folio de Yurécuaro): **0 cambian de identidad hacia un producto
    // equivocado y 0 se vuelven sobrante fantasma**; 649 pasan de «no encontrado» a resolver
    // dentro del folio y 17 dejan de resolver a un producto de FUERA del folio (que es el daño
    // de `[IC.F1]` ocurriendo hoy).
    const niveles: [string, () => Promise<FilaDeProducto[]>][] = [];
    if (countId) {
      niveles.push([
        'folio-exacto',
        () => enElFolio((qb) => qb.where('p.barcode', c).orWhere('p.sku', c)),
      ]);
      niveles.push([
        'folio-exacto-codigos',
        () => enLosCodigosDelFolio((qb) => qb.where('b.barcode', c)),
      ]);
      if (norm) {
        niveles.push(['folio-normalizado', () => enElFolio((qb) => qb.whereRaw(NORM_PP, [norm]))]);
        niveles.push([
          'folio-normalizado-codigos',
          () => enLosCodigosDelFolio((qb) => qb.whereRaw(NORM_PB, [norm])),
        ]);
      }
    }
    niveles.push([
      'catalogo-exacto',
      () =>
        enElCatalogo((qb) =>
          conSkuGlobal ? qb.where('p.barcode', c).orWhere('p.sku', c) : qb.where('p.barcode', c),
        ),
    ]);
    niveles.push([
      'catalogo-exacto-codigos',
      () => enLosCodigosDelCatalogo((qb) => qb.where('b.barcode', c)),
    ]);
    if (norm) {
      niveles.push([
        'catalogo-normalizado',
        () => enElCatalogo((qb) => qb.whereRaw(NORM_PP, [norm])),
      ]);
      niveles.push([
        'catalogo-normalizado-codigos',
        () => enLosCodigosDelCatalogo((qb) => qb.whereRaw(NORM_PB, [norm])),
      ]);
    }

    for (const [fuente, consulta] of niveles) {
      const filas = await consulta();
      const unicos = Array.from(new Map(filas.map((p) => [String(p.id), p])).values());
      if (unicos.length > 1) this.codigoAmbiguo(c, unicos);
      if (unicos.length === 1) {
        const f = unicos[0];
        const factor = f.factor == null ? null : Number(f.factor);
        return {
          product_id: f.id,
          fuente,
          unidad_del_codigo: f.unit ?? null,
          factor_del_codigo: Number.isFinite(factor as number) ? (factor as number) : null,
          es_codigo_nativo: f.is_primary === undefined ? null : f.is_primary === true,
        };
      }
    }
    return null;
  }

  /** Push de monitoreo en vivo al supervisor que mira el folio (best-effort). */
  private emitMonitor(folioId: string, event: Record<string, any>): void {
    try {
      const tenantId = this.tenantCtx.get()?.tenantId;
      if (!tenantId || !folioId) return;
      this.monitor.emitFolioEvent(tenantId, folioId, {
        ...event,
        folio_id: folioId,
        at: new Date().toISOString(),
      } as any);
    } catch {
      /* el monitoreo nunca rompe la operación */
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Apertura: snapshot del teórico + folio. (SUPERVISAR)
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * ⛔⛔ `[ICR.M7]` **El umbral de recuento se DECIDE al abrir el folio. No nace en cero por
   * omisión.**
   *
   * ── El defecto, medido (prod, 2026-11-27, sólo lectura) ────────────────────────────────
   *
   * `recount_threshold_pct` es `notNullable().defaultTo(0)` (migración `20260618190000`) y los
   * dos guards que lo usan son `if (umbral > 0)`. Resultado: **8 de 8 folios de toda la
   * historia tienen umbral 0.00** — la red de seguridad nunca estuvo encendida. Con cero:
   *
   *   1. no corre el **count-back**: dos conteos que coinciden pero quedan lejísimos del
   *      teórico se auto-resuelven en vez de ir a revisión (y dos personas que escanearon el
   *      producto de al lado coinciden perfectamente);
   *   2. no se exige **motivo**: una diferencia material cierra el folio **sin que nadie
   *      escriba por qué**, y el ajuste se aplica igual.
   *
   * ── Lo que este freno hace, y lo que NO hace ──────────────────────────────────────────
   *
   * ⛔ **No inventa un número de tolerancia**: ése es del negocio y lo firma Edgar. Lo único
   * que exige es que alguien lo **decida**, y que elegir 0 sea una decisión escrita
   * (`recount_threshold_ack: true`) y no el default de un `signal(0)` en una pantalla.
   *
   * ⚠️ Esto **rompe a propósito** a cualquier cliente que abría folios sin mandar el campo:
   * el 400 nombra lo que se apaga. Es el punto.
   */
  private umbralDeRecuento(dto: {
    recount_threshold_pct?: number;
    recount_threshold_ack?: boolean;
  }): number {
    const QUE_APAGA =
      'Con umbral 0 se apagan DOS protecciones: (1) el recuento por tolerancia '
      + '—dos conteos que coinciden pero quedan lejos del teórico se auto-resuelven en vez de ir '
      + 'a revisión— y (2) la exigencia de motivo: una diferencia material cierra el folio sin '
      + 'que nadie escriba por qué.';
    const crudo = dto.recount_threshold_pct;
    if (crudo === undefined || crudo === null || (crudo as unknown) === '')
      throw new BadRequestException(
        `Falta decidir el umbral de tolerancia (recount_threshold_pct, 0-100). ${QUE_APAGA} `
        + 'Si querés abrirlo igual con la red apagada, mandá recount_threshold_pct: 0 y '
        + 'recount_threshold_ack: true.',
      );
    const n = Number(crudo);
    if (!Number.isFinite(n) || n < 0 || n > 100)
      throw new BadRequestException(
        'recount_threshold_pct debe ser un número entre 0 y 100 (por ciento de varianza contra el teórico).',
      );
    if (n === 0 && dto.recount_threshold_ack !== true)
      throw new BadRequestException(
        `Umbral 0 = sin red. ${QUE_APAGA} Si es lo que querés, mandá recount_threshold_ack: true.`,
      );
    if (n === 0)
      this.logger.warn(
        '[ICR.M7] Folio abierto con umbral de tolerancia 0 (declarado): sin count-back y sin '
        + 'exigencia de motivo para una diferencia material.',
      );
    return n;
  }

  async openCount(dto: OpenCountDto) {
    if (!UUID.test(dto.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    const type = dto.type || 'full';
    const freeze = dto.freeze_movements !== false; // default true
    const blind = dto.blind_double_count !== false; // default true

    // ── [IC.13] Un folio `cycle` SIN subconjunto es un folio TOTAL con otra etiqueta ──────
    //
    // El snapshot de más abajo NO se ramifica por `type`: sin `product_ids` siembra el
    // almacén entero. O sea que `type:'cycle'` solo pinta la palabra "Cíclico" en la lista
    // y en nada más — y como `freeze_movements` default es `true`, ese "parcial" además
    // CONGELA la sucursal, que es exactamente lo que `openCycleCount` evita a propósito
    // (su default de freeze es `false`).
    //
    // Medido: el diálogo de `/almacen/inventory/sessions` ofrecía "Cíclico (parcial)" y
    // mandaba justo esto — rótulo que miente y almacén congelado. El freno va acá y no en
    // la pantalla porque la pantalla es un cliente entre varios: así ningún otro puede
    // volver a pedir lo imposible. El camino del cíclico es `openCycleCount`, que resuelve
    // el subconjunto (clase ABC o lista) ANTES de llamar acá.
    const subset = Array.isArray(dto.product_ids) && dto.product_ids.length > 0;
    if (type === 'cycle' && !subset)
      throw new BadRequestException(
        'Un conteo cíclico necesita el subconjunto a contar (clase ABC o product_ids). '
          + 'Usa POST /commercial/inventory/counts/open-cycle. Sin subconjunto el folio sería TOTAL.',
      );

    // `[ICR.M7]` Va DESPUÉS de los frenos estructurales (un folio mal formado se rechaza por lo
    // que tiene mal, no por el umbral) y ANTES de tocar la base: un folio abierto no se puede
    // «volver a decidir».
    const recountThreshold = this.umbralDeRecuento(dto);

    return this.tk.run(async (trx) => {
      const uid = this.userId();

      const wh = await trx('commercial.warehouses')
        .where({ id: dto.warehouse_id })
        .first();
      if (!wh) throw new NotFoundException('Almacén no encontrado');

      // ── [IC.15] La llave del folio vivo pasa de (almacén) a (almacén, RITMO) ─────────
      //
      // Antes el índice parcial permitía UN folio vivo por almacén, punto — así que el
      // diario y el mensual no podían coexistir y los tres ritmos de esta fase eran
      // imposibles. Ahora conviven, uno por ritmo.
      const ritmo = dto.ritmo || 'adhoc';
      const openExisting = await trx('commercial.inventory_counts')
        .where({ warehouse_id: dto.warehouse_id, ritmo })
        .whereIn('status', VIVOS)
        .first();
      if (openExisting)
        throw new ConflictException(
          `Ya existe un folio ${ritmo} abierto para este almacén (${openExisting.folio}). Ciérralo o cancélalo primero.`,
        );

      // ── [IC.15] ⛔ Y el freno que aflojar el índice OBLIGA a poner ────────────────────
      //
      // Permitir N folios vivos abre una puerta que antes estaba cerrada **por accidente**:
      // que el MISMO SKU esté en dos folios vivos a la vez. Dos personas lo cuentan por
      // separado, los dos folios se resuelven, y el segundo ajuste pisa al primero — un
      // descuadre fabricado por el sistema, imposible de distinguir de una merma real.
      //
      // No puede ser un índice: tendría que mirar la tabla de ítems Y el estado del folio
      // padre, y un índice parcial no cruza tablas. Va acá, antes de crear nada.
      const choque = await trx('commercial.inventory_count_items as i')
        .join('commercial.inventory_counts as c', 'c.id', 'i.count_id')
        .where('c.warehouse_id', dto.warehouse_id)
        .whereIn('c.status', VIVOS)
        .modify((qb) => { if (subset) qb.whereIn('i.product_id', dto.product_ids as string[]); })
        .select('c.folio')
        .count<{ folio: string; n: string }[]>('* as n')
        .groupBy('c.folio')
        .first();
      if (choque)
        throw new ConflictException(
          `${choque.n} de los productos a contar ya están en el folio vivo ${choque.folio}. `
            + 'Un SKU no puede estar en dos conteos a la vez: el segundo ajuste pisaría al primero.',
        );

      // ── [IC.1] De dónde sale el TEÓRICO contra el que se va a contar ──────────────────
      //
      // El ODS es la fuente correcta por CONSTRUCCIÓN: se deriva del CDC, así que no puede
      // arrastrar valores fantasma. `commercial.stock` sí — su importer es un delta contra un
      // snapshot en disco que se desincroniza, y esas filas no se corrigen nunca (el caso
      // documentado: SKU 88009 en la 01, POS 2485 / ODS 2487 / tabla 3547).
      //
      // ⚠️ HONESTIDAD SOBRE EL TAMAÑO DEL BENEFICIO, medido hoy (2026-09-28): las dos fuentes
      // difieren en **90 SKUs de 21,941 (0.4%)**, 2,355 unidades en total — no en el ~9% que
      // sugeriría la brecha histórica contra el POS. El importer está mucho mejor que cuando
      // se midió aquello. El cambio se hace igual, porque un conteo se juzga SKU por SKU y
      // cada diferencia falsa cuesta el tiempo de alguien yendo al anaquel — pero no se
      // promete una mejora que no se midió.
      //
      // Preferencia: ERP (derivado del ODS) → inventory → commercial.
      // ⚠️ Se usa `v_erp_stock_on_hand` y NO `v_erp_stock_truth`: medido, la segunda hace
      //    timeout incluso acotada a un almacén (arbitra costo, que acá no hace falta — para
      //    contar se necesita la CANTIDAD). `v_erp_stock_on_hand` responde en ~312 ms para
      //    2,988 SKUs, que es aceptable en una operación puntual como abrir un folio.
      let stockSource: 'erp' | 'inventory' | 'commercial';
      const erpCnt = await trx('analytics.v_erp_stock_on_hand')
        .where({ warehouse_id: dto.warehouse_id })
        .andWhere('qty_stock_units', '>', 0)
        .count<{ n: string }[]>('* as n');
      if (Number(erpCnt[0]?.n || 0) > 0) {
        stockSource = 'erp';
      } else {
        const invCnt = await trx('inventory.warehouse_stock')
          .where({ warehouse_id: dto.warehouse_id })
          .count<{ n: string }[]>('* as n');
        stockSource = Number(invCnt[0]?.n || 0) > 0 ? 'inventory' : 'commercial';
      }

      const folio = await this.nextFolio(trx);

      const [count] = await trx('commercial.inventory_counts')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          folio,
          type,
          ritmo,
          status: 'counting',
          freeze_movements: freeze,
          blind_double_count: blind,
          recount_threshold_pct: recountThreshold,
          stock_source: stockSource,
          notes: dto.notes || null,
          started_at: trx.fn.now(),
          created_by: uid,
          updated_by: uid,
        })
        .returning('*');

      // Snapshot del teórico al abrir. Si `product_ids` viene (folio cíclico
      // acotado, ABC.2), siembra SOLO ese subset; si no, todo el almacén (full).
      // `subset` se calcula arriba, junto al freno de `[IC.13]` que lo exige para `cycle`.
      let snapInserted: any;
      if (stockSource === 'erp') {
        // [IC.1] El teórico sale del ERP (derivado del ODS, 100% contra el POS) y de paso
        // ESTAMPA la unidad: `display_box_factor` y `unit_source` vienen de la misma fila que
        // la cantidad, así que no hay que re-resolverlos después contra otra tabla y arriesgar
        // que no sean conmensurables (ADR-057: la unidad se resuelve una vez, con testigo).
        // ⚠️ `unit_source` puede venir NULL y se guarda NULL — no se rellena con 1. Un factor
        //    inventado es peor que un factor ausente: el ausente se ve.
        snapInserted = await trx.raw(
          `INSERT INTO commercial.inventory_count_items
             (tenant_id, count_id, product_id, aisle_id, location, expected_qty, status,
              unit_label, unit_factor, unit_source)
           SELECT e.tenant_id, ?, e.product_id, s.aisle_id, NULL::text, e.qty_stock_units, 'pending',
                  NULL, NULLIF(e.display_box_factor, 0), e.unit_source
             FROM analytics.v_erp_stock_on_hand e
             LEFT JOIN commercial.stock s
               ON s.warehouse_id = e.warehouse_id AND s.product_id = e.product_id
              AND s.tenant_id = e.tenant_id
            WHERE e.warehouse_id = ? AND e.tenant_id = public.current_tenant_id()
              AND e.qty_stock_units > 0
            ${subset ? 'AND e.product_id = ANY(?::uuid[])' : ''}`,
          subset ? [count.id, dto.warehouse_id, dto.product_ids] : [count.id, dto.warehouse_id],
        );
      } else if (stockSource === 'inventory') {
        // por sku desde inventory.warehouse_stock (catálogo del almacén)
        snapInserted = await trx.raw(
          `INSERT INTO commercial.inventory_count_items
             (tenant_id, count_id, product_sku, location, expected_qty, status)
           SELECT ws.tenant_id, ?, ws.sku, NULL, ws.quantity, 'pending'
             FROM inventory.warehouse_stock ws
            WHERE ws.warehouse_id = ? AND ws.tenant_id = public.current_tenant_id()
            ${subset ? 'AND ws.sku IN (SELECT cp.sku FROM catalog.products cp WHERE cp.id = ANY(?::uuid[]) AND cp.tenant_id = public.current_tenant_id())' : ''}`,
          subset ? [count.id, dto.warehouse_id, dto.product_ids] : [count.id, dto.warehouse_id],
        );
      } else {
        // por product_id desde commercial.stock. PA.4: foto del pasillo (s.aisle_id)
        // al abrir → particiona el conteo por pasillo.
        snapInserted = await trx.raw(
          `INSERT INTO commercial.inventory_count_items
             (tenant_id, count_id, product_id, aisle_id, location, expected_qty, status)
           SELECT s.tenant_id, ?, s.product_id, s.aisle_id, NULL::text, s.quantity, 'pending'
             FROM commercial.stock s
            WHERE s.warehouse_id = ? AND s.tenant_id = public.current_tenant_id()
            ${subset ? 'AND s.product_id = ANY(?::uuid[])' : ''}`,
          subset ? [count.id, dto.warehouse_id, dto.product_ids] : [count.id, dto.warehouse_id],
        );
      }

      const expectedItems = snapInserted.rowCount ?? 0;
      if (expectedItems === 0)
        throw new BadRequestException(
          `El almacén no tiene productos con stock para contar${subset ? ' en el subconjunto indicado' : ''}; no se abrió folio.`,
        );
      this.logger.log(
        `Folio ${folio} abierto para almacén ${wh.code} con ${expectedItems} SKUs snapshot (freeze=${freeze}, blind=${blind}, umbral=${recountThreshold}%).`,
      );

      return {
        id: count.id,
        folio,
        warehouse_id: dto.warehouse_id,
        warehouse_code: wh.code,
        status: count.status,
        type,
        freeze_movements: freeze,
        blind_double_count: blind,
        /** `[ICR.M7]` Lo que se decidió, de vuelta: un folio no debería «enterarse después». */
        recount_threshold_pct: recountThreshold,
        /** `[ICR.M7]` `true` = se abrió a propósito sin count-back y sin exigencia de motivo. */
        recount_threshold_off: recountThreshold === 0,
        expected_items: expectedItems,
      };
    });
  }

  /**
   * ABC.2 — abre un folio CÍCLICO acotado: cuenta solo los productos de una clase
   * ABC (o una lista explícita), no todo el almacén. Default freeze=false (un
   * cíclico no congela el almacén; el guard de integridad ya está scopeado a los
   * productos del folio). Ver FASE_ABC_CYCLE_COUNT.md.
   */
  async openCycleCount(dto: OpenCycleCountDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const maxItems = Math.min(2000, Math.max(1, Number(dto.max_items) || 100));

    let productIds: string[];
    if (Array.isArray(dto.product_ids) && dto.product_ids.length) {
      productIds = dto.product_ids.slice(0, maxItems);
    } else if (dto.abc_class) {
      const cls = String(dto.abc_class).toUpperCase();
      if (!['A', 'B', 'C'].includes(cls)) throw new BadRequestException('abc_class debe ser A, B o C');
      productIds = await this.tk.run((trx) =>
        trx('commercial.abc_classification')
          .where({ warehouse_id: dto.warehouse_id, abc_class: cls })
          .orderBy('annual_value', 'desc')
          .limit(maxItems)
          .pluck('product_id'),
      );
      if (!productIds.length)
        throw new ConflictException(
          `No hay productos clase ${cls} en este almacén. Corre "Recalcular ABC" primero (POST /commercial/inventory/abc/refresh).`,
        );
    } else {
      throw new BadRequestException('Especifica abc_class o product_ids.');
    }

    return this.openCount({
      warehouse_id: dto.warehouse_id,
      type: 'cycle',
      ritmo: dto.ritmo,
      freeze_movements: dto.freeze_movements ?? false, // cíclico NO congela el almacén por default
      blind_double_count: dto.blind_double_count,
      recount_threshold_pct: dto.recount_threshold_pct,
      recount_threshold_ack: dto.recount_threshold_ack,
      notes: dto.notes || `Conteo cíclico${dto.abc_class ? ` clase ${String(dto.abc_class).toUpperCase()}` : ''}`,
      product_ids: productIds,
    });
  }

  private async nextFolio(trx: any): Promise<string> {
    // Año en TZ MX (no la del server) para que el folio no cambie de año ~6h antes.
    const year = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric' }).format(new Date()),
    );
    const [{ current_value }] = await trx.raw(
      `INSERT INTO commercial.inventory_count_sequences (tenant_id, year, current_value)
       VALUES (public.current_tenant_id(), ?, 1)
       ON CONFLICT (tenant_id, year) DO UPDATE
         SET current_value = inventory_count_sequences.current_value + 1,
             updated_at = now()
       RETURNING current_value`,
      [year],
    ).then((r: any) => r.rows);
    return `INV-${year}-${String(current_value).padStart(5, '0')}`;
  }

  /** Baseline de la varianza: en folios NO congelados, el libro AL MOMENTO DEL
   *  CONTEO (book_at_count) para no contar las ventas del período como merma;
   *  congelados (o sin snapshot) usan el teórico de apertura. */
  private varianceBaseline(count: any, item: any): number {
    if (!count.freeze_movements && item.book_at_count != null) return Number(item.book_at_count);
    return Number(item.expected_qty);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // `[ICR.M3]` La CAPTURA es la unidad del conteo
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * La llave de IDENTIDAD de una captura dentro de una vuelta: **el rack y la persona**.
   *
   * `null` es un valor con significado en las dos: «sin rack» es el montón que alguien tiene
   * que cerrar y es un rack más, no la ausencia de uno. Por eso se mapea a una cadena fija y
   * no se descarta — si dos capturas sin rack de la misma persona cayeran en identidades
   * distintas, una corrección se volvería una suma y el inventario se duplicaría.
   */
  private static llaveDeCaptura(c: { aisle_id: string | null; applied_by: string | null }): string {
    return `${c.aisle_id ?? '@sin-rack'}|${c.applied_by ?? '@sin-persona'}`;
  }

  /**
   * Las capturas **vivas** de una vuelta: una por identidad, **la más reciente**.
   *
   * ⚠️ `filas` tiene que venir ordenada ASC por `(applied_at, scan_uuid)`: el `set` posterior
   * pisa al anterior, así que gana la última. Una captura sin `quantity_native` (las 11 filas
   * de bitácora anteriores a `[ICR.M3]`) **no entra**: no se sabe cuánto fue, y un NULL no se
   * rellena con cero.
   */
  private capturasVivas(filas: CapturaDeConteo[], slot: string): Map<string, CapturaDeConteo> {
    const vivas = new Map<string, CapturaDeConteo>();
    for (const f of filas) {
      if (f.slot !== slot) continue;
      if (f.quantity_native == null) continue;
      vivas.set(InventoryCountService.llaveDeCaptura(f), f);
    }
    return vivas;
  }

  /**
   * ⭐ `count_N` = la **SUMA** de las capturas vivas de esa vuelta. Sigue viviendo en la unidad
   * del teórico (cada captura se guarda ya normalizada), así que todo lo que compara contra
   * `expected_qty` —varianza, cobertura, cierre— no se entera. Lo que cambia es que ya no se
   * teclea: se **deriva**.
   */
  private sumaDeCapturas(vivas: Map<string, CapturaDeConteo>): number {
    let s = 0;
    for (const c of vivas.values()) s += Number(c.quantity_native);
    return +s.toFixed(3);
  }

  /**
   * ¿Esta persona participó en esta vuelta de este renglón?
   *
   * ⛔ Mira **todas** las filas, no sólo las vivas: para la segregación de funciones lo que
   * importa es haber sido testigo, y una captura corregida después igual se hizo. Es lo que
   * impide que alguien sea su propio segundo conteo ahora que `counted_by_N` guarda sólo a
   * quien capturó **último** y ya no a quien capturó **único**.
   */
  private contribuyo(filas: CapturaDeConteo[], slot: string, uid: string | null): boolean {
    if (!uid) return false;
    return filas.some((f) => f.slot === slot && f.applied_by === uid);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Conteo CIEGO. (CONTAR) — nunca devuelve expected_qty.
  // ─────────────────────────────────────────────────────────────────────────
  async submitCount(countId: string, dto: SubmitCountDto) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    if (typeof dto.quantity !== 'number' || dto.quantity < 0)
      throw new BadRequestException('quantity debe ser número >= 0');
    if (!dto.product_id && !dto.barcode)
      throw new BadRequestException('Se requiere product_id o barcode');

    const result = await this.tk.run(async (trx) => {
      const uid = this.userId();
      // Fail-closed: sin usuario no se puede atribuir el conteo (rompería la
      // segregación de funciones aguas abajo).
      if (!uid) throw new ForbiddenException('Sesión sin usuario; no se puede registrar el conteo.');

      // OFF.0 — FOR UPDATE: serializa por folio (excluye con reconcile) → ni el
      // status ni current_pass cambian entre la lectura y la escritura. A ritmo
      // humano de conteo la serialización por folio es imperceptible.
      const count = await trx('commercial.inventory_counts')
        .where({ id: countId })
        .forUpdate()
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');

      // OFF.0 — idempotencia: si este escaneo ya se aplicó (replay de la cola
      // offline), no-op. Se chequea ANTES de los guards: un escaneo ya aplicado
      // no debe re-evaluarse (p. ej. si el folio avanzó o cerró después).
      if (dto.scan_uuid) {
        const prior = await trx('commercial.inventory_count_scan_log')
          .where({ count_id: countId, scan_uuid: dto.scan_uuid })
          .first();
        if (prior)
          return { ok: true, duplicate: true, item_id: prior.item_id, slot: prior.slot, quantity: dto.quantity } as any;
      }

      if (count.status !== 'counting' && count.status !== 'review')
        throw new ConflictException(
          `El folio está en estado '${count.status}'; no admite conteos.`,
        );

      // Opt-in (Fase I.4): si el folio tiene contadores asignados, solo ellos cuentan.
      // PA.4b: si además están asignados a pasillos específicos (tablero PA.3),
      // cada contador solo cuenta SKUs de SU(S) pasillo(s).
      const counters = await trx('commercial.inventory_count_assignments')
        .where({ count_id: countId, assignment_role: 'counter' })
        .select('user_id', 'aisle_id');
      if (counters.length && !counters.some((a) => a.user_id === uid)) {
        throw new ForbiddenException(
          'No estás asignado como contador de este folio.',
        );
      }
      // Scoped solo si TODAS mis filas son aisle-scoped; una fila aisle_id NULL =
      // contador folio-wide (modo I.4) → sin restricción de pasillo.
      const myAisles = counters.filter((a) => a.user_id === uid).map((a) => a.aisle_id);
      const aisleScoped = myAisles.length > 0 && myAisles.every((x) => x != null);
      const myAisleSet = new Set<string>(myAisles.filter(Boolean));

      // Resolver producto según la fuente del folio.
      const isInv = count.stock_source === 'inventory';
      let productId: string | null = dto.product_id || null;
      let productSku: string | null = null;
      // `[IC.UB1]` Ya no hay una variable `location` arrastrada desde `public.products`: esa
      // columna es la constante `Z000` en los 11,816 productos que la traen. La ubicación se
      // resuelve contra el catálogo de `/almacen/ubicaciones`, más abajo y por almacén.
      let prodName: string | null = null;
      /** `[ICR.M11]` Lo que se supo del código escaneado; `null` si vino `product_id` directo. */
      let codigoResuelto: CodigoResuelto | null = null;

      if (isInv) {
        // inventory.products por barcode o sku
        const code = String(dto.barcode || dto.product_id || '').trim();
        if (!code) throw new BadRequestException('Se requiere barcode o sku');
        const prod = await this.resolveInvByCode(trx, code);
        if (!prod) throw new NotFoundException(`Sin producto para '${code}'`);
        productSku = prod.sku;
        prodName = prod.nombre;
      } else {
        if (!productId && dto.barcode) {
          // ⛔⛔ [IC.F1] PRIMERO el folio, DESPUÉS el catálogo global. No al revés.
          //
          // El catálogo tiene el mismo producto más de una vez (medido en prod el
          // 2026-11-26: de 14,986 filas de `public.products`, **1,162 sin SKU**, **887 SKUs
          // repetidos** y **1,017 nombres con más de un `product_id`**). Buscar el código
          // directo en `public.products` devolvía la fila DUPLICADA —la que no tiene SKU—,
          // su `product_id` no coincidía con el que el folio sembró, y más abajo el
          // `if (!item)` daba de alta un **renglón nuevo con `expected_qty: 0`**.
          //
          // El daño era total y silencioso: el artículo original quedaba `pending` para
          // siempre (el folio **no podía cerrarse jamás**), el total crecía con cada
          // escaneo (el 100 % se alejaba a cada paso) y lo contado entraba como **sobrante
          // puro** contra un teórico cero. Es lo que explica los 6 folios cancelados y 0
          // reconciliados de toda la historia del módulo.
          //
          // ⭐ El testigo de que ésta es la resolución correcta ya existía: el camino SIN
          // CONEXIÓN nunca tuvo el defecto, porque resuelve contra la caché de
          // `/counts/:id/catalog` —que son los productos DEL FOLIO—. Acá se hace lo mismo
          // del lado del servidor. Medido el 2026-11-26: offline acertó (`sku 00182`,
          // teórico 19, sin crear renglón) y online falló (sku vacío, teórico 0, renglón
          // nuevo) sobre el MISMO folio.
          //
          // ⚠️ El `else` se conserva a propósito: un código que de verdad no está en el
          // folio es un **sobrante legítimo** y debe seguir dándose de alta. Lo que se
          // corrige es el sobrante FALSO, el que nace de que un producto tenga dos
          // identidades en el catálogo.
          // ⭐ `[ICR.M10]` Los cuatro niveles (folio exacto → folio normalizado → catálogo
          // exacto → catálogo normalizado) viven en `resolverProductoPorCodigo`, junto con la
          // medición que los justifica. Lo que cambia acá respecto de antes: ya no hay un
          // `.first()` que elija al azar entre varios candidatos —eso contaba la mercancía en
          // el renglón equivocado y nadie lo notaba— y un UPC-A que el escáner emitió como
          // EAN-13 (con un cero adelante) ya no sale como «producto no encontrado».
          const hallado = await this.resolverProductoPorCodigo(trx, countId, dto.barcode);
          if (!hallado) throw new NotFoundException(`Sin producto para el código '${dto.barcode}'`);
          productId = hallado.product_id;
          codigoResuelto = hallado;
        }
        if (!UUID.test(productId!)) throw new BadRequestException('product_id inválido');
      }

      // Lock del item (o crear SOBRANTE no esperado en el snapshot).
      const itemWhere: any = isInv
        ? { count_id: countId, product_sku: productSku }
        : { count_id: countId, product_id: productId };
      let item = await trx('commercial.inventory_count_items')
        .where(itemWhere)
        .forUpdate()
        .first();

      // PA.4b — scoping por pasillo del contador.
      if (aisleScoped) {
        if (item) {
          if (!item.aisle_id || !myAisleSet.has(item.aisle_id))
            throw new ForbiddenException(
              'Este SKU no pertenece a tu pasillo asignado. Si está mal mapeado, avisa al supervisor.',
            );
        } else if (myAisleSet.size !== 1) {
          // sobrante no listado: solo lo da de alta un contador de UN pasillo (sin
          // ambigüedad de a cuál pertenece). Multi-pasillo → que el supervisor lo mapee.
          throw new ForbiddenException(
            'SKU no listado en el conteo y cubres varios pasillos: pide al supervisor que lo mapee a un pasillo.',
          );
        }
      }

      if (!item) {
        const insertRow: any = {
          tenant_id: trx.raw('public.current_tenant_id()'),
          count_id: countId,
          expected_qty: 0,
          status: 'pending',
          updated_by: uid,
        };
        // sobrante de un contador aisle-scoped → se atribuye a su (único) pasillo.
        if (aisleScoped) insertRow.aisle_id = Array.from(myAisleSet)[0];
        if (isInv) {
          insertRow.product_sku = productSku;
        } else {
          const prod = await trx('public.products').where({ id: productId }).first();
          if (!prod) throw new NotFoundException('Producto no encontrado');
          insertRow.product_id = productId;
          // `[IC.UB1]` La columna guardada nace vacía: la ubicación se resuelve al leer,
          // contra el catálogo de UB. Copiar `p.location` era copiar la constante `Z000`.
          insertRow.location = null;
        }
        [item] = await trx('commercial.inventory_count_items').insert(insertRow).returning('*');
      }

      // ── ⭐⭐ `[ICR.M3]` LA CAPTURA ES LA UNIDAD DEL CONTEO ────────────────────────────────
      //
      // Hasta acá el renglón guardaba **un número por producto**. Por eso el mismo producto en
      // dos racks se perdía (**F35**): el segundo que lo encontraba recibía «ya tiene un primer
      // conteo de otra persona» y esa mercancía salía como faltante. En una distribuidora de
      // dulces, producto en anaquel **y** en bodega es lo normal.
      //
      // La identidad de una captura es **(renglón, rack, persona, vuelta)**:
      //   · mismo rack, misma persona → **corrige** (gana la más reciente);
      //   · otro rack, u otra persona → **suma**.
      //
      // Las filas vienen ASC por `(applied_at, scan_uuid)` porque `capturasVivas` se apoya en
      // ese orden para quedarse con la última de cada identidad.
      const capturas: CapturaDeConteo[] = await trx('commercial.inventory_count_scan_log')
        .where({ count_id: countId, item_id: item.id })
        .orderBy('applied_at', 'asc')
        .orderBy('scan_uuid', 'asc')
        .select(
          'scan_uuid',
          'item_id',
          'slot',
          'aisle_id',
          'applied_by',
          'applied_at',
          'quantity_native',
        );

      // ⛔ El rack de la captura es **donde está parada la persona**, nunca `item.aisle_id`
      // —que es a dónde el CATÁLOGO dice que va el producto—. Si el mapa está mal, manda el
      // que está parado ahí (§5.2 del anexo): se cuenta igual y el mapa se corrige después.
      // Sin rack declarado y sin pasillo único asignado, la captura cae en el montón «sin
      // rack», que es un rack más y alguien tiene que cerrarlo.
      let aisleDeLaCaptura: string | null = null;
      const rackPedido = String(dto.aisle_id ?? '').trim();
      if (rackPedido) {
        if (!UUID.test(rackPedido)) throw new BadRequestException('aisle_id inválido');
        const rack = await trx('commercial.warehouse_aisles')
          .where({ id: rackPedido, warehouse_id: count.warehouse_id })
          .first();
        // Se valida contra el almacén del folio a propósito: un rack inventado crearía una
        // identidad de captura fantasma, y una corrección se volvería una suma en silencio.
        if (!rack) throw new NotFoundException('Ese rack no existe en este almacén.');
        aisleDeLaCaptura = rack.id;
      } else if (aisleScoped && myAisleSet.size === 1) {
        aisleDeLaCaptura = Array.from(myAisleSet)[0];
      }

      // Selección de slot. OFF.0: si el escaneo trae capture_pass (cola offline),
      // se coloca según la fase EN QUE SE CAPTURÓ, no la fase actual del folio →
      // un count_1 encolado no se desvía a count_2 si el folio avanzó (preserva el
      // doble-conteo ciego en replay). Online (sin capture_pass) = igual que antes.
      const patch: Record<string, any> = { updated_at: trx.fn.now(), updated_by: uid };

      // ⛔⛔ `[IC.F24]` **La cantidad se normaliza a la unidad NATIVA antes de guardarse.**
      //
      // `count_N` sigue viviendo en la misma unidad que `expected_qty`, así que todo lo que
      // compara contra el teórico —varianza, cobertura, el valor en riesgo, el cierre— sigue
      // funcionando sin tocarse. Lo que se agrega es el TESTIGO: qué unidad declaró la
      // persona y con qué factor se convirtió.
      //
      // Sin unidad declarada y sin nativa conocida, el factor es 1 y la unidad queda NULL:
      // se comporta exactamente como antes y **se ve** que nadie declaró nada.
      const { nativa, opciones } = await this.unidadesDeConteo(trx, productId, productSku);
      const pedida = (dto.unit ?? '').trim().toUpperCase();

      // ── ⛔⛔ `[ICR.M11]` Escanear la CAJA no puede contar piezas en silencio ───────────────
      //
      // Agregar `catalog.product_barcodes` a la resolución **rescata 649 códigos** que hoy dan
      // «producto no encontrado»… y **335 de ellos son el código de la caja o del paquete**, no
      // el de la unidad nativa. Si se aceptaran sin más, alguien escanea una caja, teclea `3` y
      // el folio guarda **3 piezas en vez de 3 cajas**. Eso es peor que el 404 que reemplaza:
      // el 404 se ve, el undercount no.
      //
      // Y no se puede resolver adivinando el factor: medido en prod el 2026-11-27, **248 de los
      // 254 códigos `CJA` del folio de Yurécuaro tienen `factor` NULL**. No hay con qué
      // convertir, así que lo honesto es **pedir la unidad**, no inventarla (ADR-057 / `[IC.F24]`:
      // sin unidad conocida NO se inventa una).
      //
      // ⭐ Esto **no puede romper nada que hoy funcione**: sólo se dispara cuando la resolución
      // vino de la tabla de códigos, y esos niveles únicamente corren cuando `public.products`
      // no encontró nada — o sea, exactamente sobre los escaneos que hoy devuelven 404.
      if (
        !pedida
        && codigoResuelto?.es_codigo_nativo === false
        && codigoResuelto.unidad_del_codigo
        && nativa?.unit
        && codigoResuelto.unidad_del_codigo.toUpperCase() !== nativa.unit.toUpperCase()
      ) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'UNIDAD_NO_DECLARADA',
          message:
            `El código que escaneaste es el de ${codigoResuelto.unidad_del_codigo}, y el conteo `
            + `de este producto se lleva en ${nativa.unit}. Decí en qué unidad contaste.`,
          barcode: dto.barcode ?? null,
          scanned_unit: codigoResuelto.unidad_del_codigo,
          /** ⚠️ Puede venir `null`: 248 de 254 códigos de caja no tienen factor declarado. */
          scanned_factor: codigoResuelto.factor_del_codigo,
          native_unit: nativa.unit,
          units_available: opciones,
        });
      }
      let unidadUsada: string | null = nativa?.unit ?? null;
      let factorUsado = 1;
      if (pedida) {
        const elegida = opciones.find((o) => o.unit.toUpperCase() === pedida);
        if (!elegida)
          throw new BadRequestException(
            opciones.length
              ? `Este producto no se cuenta en '${pedida}'. Sus unidades son: ${opciones.map((o) => o.unit).join(', ')}.`
              : `Este producto no tiene unidades declaradas, así que no se puede contar en '${pedida}'.`,
          );
        unidadUsada = elegida.unit;
        factorUsado = elegida.factor;
      }
      const cantidad = +(dto.quantity * factorUsado).toFixed(3);
      const livePass = Number(count.current_pass) || 1;
      const cp = dto.capture_pass === 1 || dto.capture_pass === 2 ? dto.capture_pass : null;
      const effectivePass = cp ?? livePass;
      // ⛔⛔ `[ICR.M3]` **«No negarlo, sólo advertirlo»** (Edgar, 2026-11-27), con UNA excepción.
      //
      // Se RETIRAN los dos rechazos de «ya lo contó otro» (en `count_1` y en `count_2`): los dos
      // eran el mismo defecto **F35** por dos puertas, y en la segunda vuelta además fabricaban
      // una discrepancia por cada producto partido entre anaquel y bodega. Ahora esa captura
      // **suma** y la respuesta lo **avisa** diciendo DÓNDE —nunca cuánto— (§4.3).
      //
      // ⭐ Se CONSERVA la negación de que una misma persona haga el 1.º y el 2.º conteo del
      // mismo producto. Ésa no previene una confusión: previene que el doble conteo ciego sea
      // teatro. Con una sola persona no hay dos testigos, hay uno escribiendo dos veces.
      //
      // ⚠️ El testigo de quién contó pasa a ser la BITÁCORA, no `counted_by_N`: con varias
      // capturas por renglón, la columna guarda a quien capturó **último**. Si el guard siguiera
      // mirando sólo la columna, el que contó primero y fue «desplazado» podría hacer el segundo
      // conteo — justo el agujero que este guard existe para tapar.
      let slot: string;
      if (dto.recount || (count.status === 'review' && cp == null)) {
        // Segregación del desempate: el 3er conteo no lo puede hacer quien ya contó este SKU en
        // la 1ra o 2da pasada (si no, no rompe el empate de forma independiente). Que lo cuente
        // otra persona, o que el supervisor lo resuelva manualmente (resolveItem).
        if (
          uid &&
          (item.counted_by_1 === uid ||
            item.counted_by_2 === uid ||
            this.contribuyo(capturas, 'count_1', uid) ||
            this.contribuyo(capturas, 'count_2', uid))
        )
          throw new ConflictException(
            'No puedes hacer el tercer conteo (desempate) de un SKU que tú mismo contaste antes.',
          );
        slot = 'count_3';
        patch.count_3_unit = unidadUsada;
        patch.count_3_factor = factorUsado;
        patch.counted_by_3 = uid;
        patch.counted_at_3 = trx.fn.now();
      } else if (effectivePass >= 2) {
        // Segundo conteo ciego: lo hace alguien DISTINTO al de la 1ra pasada.
        if (uid && (item.counted_by_1 === uid || this.contribuyo(capturas, 'count_1', uid)))
          throw new ConflictException(
            'No puedes hacer el segundo conteo de un SKU que tú mismo contaste en la primera pasada.',
          );
        slot = 'count_2';
        patch.count_2_unit = unidadUsada;
        patch.count_2_factor = factorUsado;
        patch.counted_by_2 = uid;
        patch.counted_at_2 = trx.fn.now();
      } else {
        slot = 'count_1';
        patch.count_1_unit = unidadUsada;
        patch.count_1_factor = factorUsado;
        patch.counted_by_1 = uid;
        patch.counted_at_1 = trx.fn.now();
      }

      // ── La captura, y el aviso que la acompaña ────────────────────────────────────────────
      //
      // Se decide ANTES de escribir, contra las capturas que ya estaban: después de insertar la
      // propia, «¿había algo acá?» ya no se puede contestar.
      const vivasAntes = this.capturasVivas(capturas, slot);
      const miLlave = InventoryCountService.llaveDeCaptura({
        aisle_id: aisleDeLaCaptura,
        applied_by: uid,
      });
      const miPrevia = vivasAntes.get(miLlave) ?? null;
      const ajenas = [...vivasAntes.entries()]
        .filter(([k]) => k !== miLlave)
        .map(([, c]) => c);
      const capturaModo: 'first' | 'correction' | 'added' = miPrevia
        ? 'correction'
        : ajenas.length
          ? 'added'
          : 'first';

      // Folio NO congelado (cíclico): fotografía el saldo en libros al PRIMER
      // conteo. reconcile usa este baseline (no el de apertura) para el delta, así
      // las ventas ocurridas durante el conteo no se borran.
      if (slot === 'count_1' && !count.freeze_movements && item.book_at_count == null) {
        let book = 0;
        if (isInv) {
          const ws = await trx('inventory.warehouse_stock')
            .where({ warehouse_id: count.warehouse_id, sku: productSku })
            .first();
          book = ws ? Number(ws.quantity) : 0;
        } else {
          const sr = await trx('commercial.stock')
            .where({ warehouse_id: count.warehouse_id, product_id: productId })
            .first();
          book = sr ? Number(sr.quantity) : 0;
        }
        patch.book_at_count = book;
      }

      // ── ⭐ `[ICR.M3]` La captura se escribe SIEMPRE, y `count_N` se RECOMPONE ─────────────
      //
      // Antes la bitácora sólo se escribía si el cliente mandaba `scan_uuid` (o sea: sólo la
      // cola sin conexión), y guardaba quién y cuándo pero **ni la cantidad ni el rack**
      // (**F34**). Ahora toda captura deja fila, con su cantidad normalizada y su rack, y el
      // número del renglón sale de sumarlas. Sin `scan_uuid` del cliente se genera uno acá: la
      // bitácora no puede tener huecos sólo porque el escaneo vino por el camino con red.
      //
      // ⚠️ `applied_at` usa `clock_timestamp()` y no `now()`: `now()` es la hora de ARRANQUE de
      // la transacción, así que dos capturas podrían empatar y «la más reciente gana» quedaría
      // decidido por el desempate arbitrario del `scan_uuid`.
      const capturaUuid = dto.scan_uuid ?? randomUUID();
      await trx('commercial.inventory_count_scan_log')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          count_id: countId,
          scan_uuid: capturaUuid,
          item_id: item.id,
          slot,
          applied_by: uid,
          applied_at: trx.raw('clock_timestamp()'),
          quantity: dto.quantity,
          quantity_native: cantidad,
          unit: unidadUsada,
          unit_factor: factorUsado,
          aisle_id: aisleDeLaCaptura,
        })
        .onConflict(['tenant_id', 'count_id', 'scan_uuid'])
        .ignore();

      // La suma sale de releer la bitácora, no de sumarle a lo que había en memoria: así el
      // número del renglón es **derivado de lo escrito** y no de lo que este proceso creía.
      const capturasAhora: CapturaDeConteo[] = await trx('commercial.inventory_count_scan_log')
        .where({ count_id: countId, item_id: item.id })
        .orderBy('applied_at', 'asc')
        .orderBy('scan_uuid', 'asc')
        .select(
          'scan_uuid',
          'item_id',
          'slot',
          'aisle_id',
          'applied_by',
          'applied_at',
          'quantity_native',
        );
      const vivasDespues = this.capturasVivas(capturasAhora, slot);
      patch[slot] = this.sumaDeCapturas(vivasDespues);

      patch.status = 'counted';
      await trx('commercial.inventory_count_items')
        .where({ id: item.id })
        .update(patch);

      // Identificación del producto para confirmar qué escaneó (no es dato ciego).
      let sku = productSku;
      let name = prodName;
      let loc: string | null = null;
      if (!isInv) {
        const prodInfo = await trx('public.products')
          .where({ id: productId })
          .select('sku', 'nombre')
          .first();
        sku = prodInfo?.sku ?? null;
        name = prodInfo?.nombre ?? null;
        // `[IC.UB1]` La ubicación del catálogo de UB para ESTE almacén, o nada.
        loc = await this.codigosDeUbicacion(trx, count.warehouse_id, productId);
      }

      // ── `[ICR.M3]` El aviso: DÓNDE sí, CUÁNTO no ─────────────────────────────────────────
      //
      // ⛔⛔ La cantidad AJENA no se devuelve nunca, a propósito: el conteo es ciego, y decirle
      // «ya hay 24» le da un número al que anclarse. Saber que el producto ya se contó en otro
      // lado —y quién— es lo que necesita para decidir si lo suyo se agrega (§4.3).
      // ⭐ La propia sí: es el número que esa misma persona tecleó, y sin él una recaptura pisa
      // en silencio (**F33**) — no distingue «me corrijo» de «le di sin querer».
      const idsRacks = [...new Set([aisleDeLaCaptura, ...ajenas.map((c) => c.aisle_id)])].filter(
        (x): x is string => !!x,
      );
      const idsPersonas = [...new Set(ajenas.map((c) => c.applied_by))].filter(
        (x): x is string => !!x,
      );
      const racks = idsRacks.length
        ? await trx('commercial.warehouse_aisles')
            .whereIn('id', idsRacks)
            .select('id', 'code', 'name')
        : [];
      const personas = idsPersonas.length
        ? await trx('identity.users').whereIn('id', idsPersonas).select('id', 'username', 'nombre')
        : [];
      const rotuloRack = (id: string | null): string | null =>
        (id && (racks as { id: string; code: string | null }[]).find((r) => r.id === id)?.code)
        || null;
      const nombrePersona = (id: string | null): string | null => {
        const lista = personas as { id: string; username: string | null; nombre: string | null }[];
        const u = id ? lista.find((p) => p.id === id) : null;
        return u ? u.nombre || u.username || null : null;
      };

      // Respuesta CIEGA: ni expected_qty ni varianza.
      return {
        ok: true,
        item_id: item.id,
        slot,
        scan_uuid: dto.scan_uuid ?? null,
        /** `[ICR.M3]` El `scan_uuid` con el que quedó la captura (generado si el cliente no mandó). */
        capture_uuid: capturaUuid,
        /** `[ICR.M3]` El rack donde quedó ESTA captura. `null` = el montón «sin rack». */
        aisle_id: aisleDeLaCaptura,
        aisle_code: rotuloRack(aisleDeLaCaptura),
        /**
         * `[ICR.M3]` Qué fue esto: `first` nadie había contado este producto en esta vuelta ·
         * `correction` reemplaza TU captura anterior en ESTE mismo rack · `added` se SUMA a lo
         * que ya había en otro rack o de otra persona.
         */
        capture_mode: capturaModo,
        /** `[ICR.M3]` Tu propio número anterior en este mismo rack, para confirmar antes de pisarlo. */
        previous_own_qty: miPrevia ? Number(miPrevia.quantity_native) : null,
        /** ⛔ `[ICR.M3]` Dónde y quién contó antes. **Sin la cantidad**: el conteo es ciego. */
        other_captures: ajenas.map((c) => ({
          aisle_id: c.aisle_id,
          aisle_code: rotuloRack(c.aisle_id),
          counted_by: c.applied_by,
          counted_by_name: nombrePersona(c.applied_by),
          counted_at: c.applied_at,
        })),
        product_id: productId,
        sku,
        product_name: name,
        location: loc,
        quantity: dto.quantity,
        /** `[IC.F24]` Lo que se guardó, y en qué unidad: el testigo de la conversión. */
        unit: unidadUsada,
        unit_factor: factorUsado,
        quantity_native: cantidad,
        units_available: opciones,
        /**
         * ⭐ `[ICR.M11]` La unidad **del código que se escaneó** (`[ICR.M6]`: con esto la
         * pantalla preselecciona «cajas» sola). ⛔ Se informa y **no se aplica**: el factor
         * falta en 248 de 254 códigos de caja, así que aplicarlo sería inventar el número.
         */
        scanned_unit: codigoResuelto?.unidad_del_codigo ?? null,
        scanned_unit_factor: codigoResuelto?.factor_del_codigo ?? null,
        scanned_code_is_native: codigoResuelto?.es_codigo_nativo ?? null,
      };
    });
    // OFF.0 — no re-emitimos en replays idempotentes (ya se emitió la 1ra vez).
    if (!(result as any).duplicate) {
      this.emitMonitor(countId, {
        type: 'count',
        slot: result.slot,
        sku: (result as any).sku,
        product_name: (result as any).product_name,
        qty: result.quantity,
        username: this.tenantCtx.get()?.username ?? null,
      });
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cómputo de discrepancias + paso a 'review'. (SUPERVISAR)
  // ─────────────────────────────────────────────────────────────────────────
  async computeDiscrepancies(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');

    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const threshold = Number(count.recount_threshold_pct) || 0;
      const items = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .select('*');

      let discrepancies = 0;
      let resolved = 0;
      for (const it of items) {
        // No re-procesar lo ya resuelto: re-correr "calcular discrepancias" no
        // debe pisar la resolución manual del supervisor ni revertir un item
        // 'resolved' de vuelta a 'discrepancy' (bloquearía el reconcile).
        if (it.status === 'resolved') continue;
        const c1 = it.count_1 != null ? Number(it.count_1) : null;
        const c2 = it.count_2 != null ? Number(it.count_2) : null;
        const c3 = it.count_3 != null ? Number(it.count_3) : null;
        if (c1 == null) continue; // sin contar — lo atrapa el coverage guard

        let finalQty: number | null = null;
        let status = 'counted';

        if (count.blind_double_count) {
          if (c2 == null) {
            // falta segundo conteo
            status = 'counted';
          } else if (c1 === c2) {
            finalQty = c1;
          } else if (c3 != null && (c3 === c1 || c3 === c2)) {
            finalQty = c3; // el tercero rompe el empate
          } else {
            status = 'discrepancy';
            discrepancies++;
          }
        } else {
          finalQty = c1;
        }

        if (finalQty != null) {
          const baseline = this.varianceBaseline(count, it);
          const variance = +(finalQty - baseline).toFixed(3);
          // Count-back: conteos coincidentes pero |varianza| fuera de tolerancia
          // → NO auto-resolver; queda en discrepancy para recuento/revisión.
          if (threshold > 0 && Math.abs(variance) > Math.abs(baseline) * threshold / 100) {
            discrepancies++;
            await trx('commercial.inventory_count_items')
              .where({ id: it.id })
              .update({
                status: 'discrepancy',
                variance,
                notes: it.notes || `Fuera de tolerancia (±${threshold}%): requiere recuento o resolución manual.`,
                updated_at: trx.fn.now(),
              });
          } else {
            status = 'resolved';
            resolved++;
            await trx('commercial.inventory_count_items')
              .where({ id: it.id })
              .update({ final_qty: finalQty, variance, status, updated_at: trx.fn.now() });
          }
        } else if (status === 'discrepancy') {
          await trx('commercial.inventory_count_items')
            .where({ id: it.id })
            .update({ status, updated_at: trx.fn.now() });
        }
      }

      await trx('commercial.inventory_counts')
        .where({ id: countId })
        .update({ status: 'review', updated_at: trx.fn.now(), updated_by: this.userId() });

      return { status: 'review', resolved, discrepancies };
    });
  }

  // Resolución manual de un item (supervisor decide el valor final). (SUPERVISAR)
  async resolveItem(countId: string, itemId: string, dto: ResolveItemDto) {
    if (!UUID.test(countId) || !UUID.test(itemId))
      throw new BadRequestException('id inválido');
    if (typeof dto.final_qty !== 'number' || dto.final_qty < 0)
      throw new BadRequestException('final_qty debe ser >= 0');
    if (dto.reason_code && !VARIANCE_REASON_CODES.includes(dto.reason_code))
      throw new BadRequestException(
        `reason_code inválido. Usar uno de: ${VARIANCE_REASON_CODES.join(', ')}`,
      );

    return this.tk.run(async (trx) => {
      const item = await trx('commercial.inventory_count_items')
        .where({ id: itemId, count_id: countId })
        .first();
      if (!item) throw new NotFoundException('Item no encontrado');
      const count = await this.getCountOrThrow(trx, countId);

      // ⛔⛔ [IC.F3] CUÁNDO se puede fijar a mano una cantidad final. Decidido por Edgar el
      // 2026-11-26 sobre la auditoría (`docs/MODULOS/inventario-fisico.md` §9d, F3/F4).
      //
      // Antes no había ninguna condición: este método aceptaba cualquier artículo en
      // cualquier momento. En un folio de doble conteo CIEGO eso es una puerta que anula el
      // control que define al módulo — y encima el diálogo imprime el teórico justo arriba
      // del campo, o sea que le sopla la respuesta a quien la usa. Medido en prod: la pueden
      // abrir 21 personas y sólo 17 pueden reconciliar. Había más gente capaz de anular el
      // control que de cerrar el inventario.
      //
      // Las cuatro condiciones, en el orden en que la persona las puede resolver:
      if (['reconciled', 'cancelled'].includes(count.status))
        throw new ConflictException(
          `El folio está en estado '${count.status}'; su cantidad final ya no se toca.`,
        );
      // El mismo compromiso que defiende `reconcile()`: un no-contado NO se trata como cero,
      // y tampoco se le pone un número a mano para esquivarlo.
      if (item.count_1 == null)
        throw new ConflictException(
          'Nadie contó este artículo. No se le puede fijar una cantidad final: cuéntalo '
            + '(un no-contado NO se trata como cero).',
        );
      if (count.blind_double_count && item.count_2 == null)
        throw new ConflictException(
          'Falta el segundo conteo de este artículo. En un conteo ciego la cantidad final no '
            + 'se fija antes de C1 y C2.',
        );
      // Lo que coincide lo resuelve «calcular discrepancias» solo. Acá se tocan los que NO
      // coincidieron, y los ya resueltos — corregir una resolución equivocada tiene que poder
      // hacerse; lo que no puede es fijar la primera cifra sin pasar por el conteo.
      if (item.status !== 'discrepancy' && item.status !== 'resolved')
        throw new ConflictException(
          `Este artículo está en '${item.status}', no en discrepancia. Corre «calcular `
            + 'discrepancias»: lo que coincide se resuelve solo, y acá sólo se tocan los que no.',
        );

      const variance = +(dto.final_qty - this.varianceBaseline(count, item)).toFixed(3);
      await trx('commercial.inventory_count_items')
        .where({ id: itemId })
        .update({
          final_qty: dto.final_qty,
          variance,
          status: 'resolved',
          notes: dto.notes || item.notes,
          reason_code: dto.reason_code || item.reason_code,
          resolved_by: this.userId(),
          updated_at: trx.fn.now(),
          updated_by: this.userId(),
        });
      return { ok: true, item_id: itemId, final_qty: dto.final_qty, variance, reason_code: dto.reason_code || item.reason_code || null };
    });
  }

  /** Catálogo de motivos de varianza para el dropdown del supervisor. */
  varianceReasons() {
    return VARIANCE_REASONS;
  }

  /**
   * KPI de exactitud de inventario (IRA) sobre folios RECONCILIADOS.
   *   - ira_pct: exactitud por piezas (items dentro de tolerancia / total).
   *   - value_accuracy_pct: 1 − (Σ|varianza|·costo / Σ teórico·costo).
   *   - net_variance_value: merma (−) o sobrante (+) neto en $.
   *   - by_reason: desglose del shrinkage por causa (habilitado por reason_code).
   *   - recent_folios: IRA + merma neta por folio.
   * Tolerancia (default 0 = exacto): item exacto si |varianza| ≤ teórico·tol%/100.
   * Costo: `i.unit_cost` congelado al reconciliar; si no, [KE.3] el resolvedor unico
   * `analytics.v_erp_unit_cost` (testigo del MISMO ERP y almacen); ultimo recurso el proxy
   * de `inventory.products`. Antes el fallback era `cost_base` del catalogo. (SUPERVISAR)
   *
   * ── `[IRA.1]` TRES COSAS QUE ESTA PANTALLA CALLABA (medidas en prod, 2026-09-30) ────────
   *
   * 1. ⛔ **No decía que el proceso nunca corrió.** El IRA sólo mira `status='reconciled'`, y
   *    en prod hay **CERO**. Los 6 folios que existen están `cancelled`: se abrieron entre el
   *    15 y el 19-jun-2026 en los almacenes `01` y `02` con **18,845 renglones**, de los que
   *    se contaron **9 (0.05%)**. La pantalla mostraba «—», «$0», «0 folios» y dos mensajes de
   *    vacío distintos — nadie podía deducir de ahí que lo que falta no es descuadre sino el
   *    proceso entero. Ahora se devuelve `sin_reconciliar` con ese censo, y es lo primero que
   *    la pantalla dice.
   *
   * 2. ⛔ **`net_variance_value` salía en `$0` sin base.** Cero pesos de variación y "no hay
   *    con qué calcular la variación" son cosas distintas, y en una tarjeta de dinero se leen
   *    igual. Los tres importes salen **NULL** cuando no hay un solo ítem (ADR-056).
   *
   * 3. ⛔ **El costo ausente entraba como CERO.** El `COALESCE(...)` termina en `0`, así que un
   *    SKU sin testigo de costo aporta 0 al teórico **y** 0 a la varianza — o sea que una
   *    diferencia sin costo se ve como si no hubiera diferencia, e **infla**
   *    `value_accuracy_pct`. Hoy `v_erp_unit_cost` cubre el **100%** de las celdas con
   *    existencia, así que el daño es potencial y no actual; pero eso es una medición de hoy,
   *    no una garantía. Se cuenta y se devuelve `items_sin_costo` para que la pantalla pueda
   *    declararlo en vez de que el porcentaje suba solo.
   */
  async iraMetrics(q: { warehouse_id?: string; from?: string; to?: string; tolerance_pct?: number }) {
    if (q.warehouse_id && !UUID.test(q.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    const tolPct = Number.isFinite(Number(q.tolerance_pct)) ? Math.max(0, Number(q.tolerance_pct)) : 0;

    return this.tk.run(async (trx) => {
      const filters = [`c.status = 'reconciled'`];
      const binds: any[] = [];
      if (q.warehouse_id) { filters.push(`c.warehouse_id = ?`); binds.push(q.warehouse_id); }
      if (q.from) { filters.push(`c.reconciled_at >= ?`); binds.push(q.from); }
      if (q.to) { filters.push(`c.reconciled_at < ?`); binds.push(q.to); }
      const cost = `COALESCE(i.unit_cost, uc.costo_unitario, ip.venta_valor_costo_anual / NULLIF(ip.venta_unidad_anual, 0), 0)`;
      const accurate = `ABS(COALESCE(i.variance, 0)) <= (i.expected_qty * ${tolPct} / 100.0)`;
      const baseFrom = `
        FROM commercial.inventory_counts c
        JOIN commercial.inventory_count_items i ON i.tenant_id = c.tenant_id AND i.count_id = c.id
        LEFT JOIN public.products p ON p.id = i.product_id
        LEFT JOIN inventory.products ip ON ip.sku = i.product_sku
        LEFT JOIN analytics.v_erp_unit_cost uc ON uc.tenant_id = c.tenant_id
             AND uc.warehouse_id = c.warehouse_id AND uc.product_id = i.product_id
        LEFT JOIN commercial.warehouses w ON w.tenant_id = c.tenant_id AND w.id = c.warehouse_id
        WHERE ${filters.join(' AND ')}`;

      // `costoCrudo` es la misma cadena SIN el `0` final: sirve para CONTAR los que no tienen
      // testigo, que es lo que el COALESCE con cero vuelve invisible.
      const costoCrudo = `COALESCE(i.unit_cost, uc.costo_unitario,
        ip.venta_valor_costo_anual / NULLIF(ip.venta_unidad_anual, 0))`;
      const ov = (await trx.raw(
        `SELECT COUNT(*)::int AS total_items,
                COUNT(*) FILTER (WHERE ${accurate})::int AS accurate_items,
                COUNT(DISTINCT c.id)::int AS folios,
                COUNT(*) FILTER (WHERE ${costoCrudo} IS NULL)::int AS items_sin_costo,
                COALESCE(SUM(i.expected_qty * ${cost}), 0)::numeric AS expected_value,
                COALESCE(SUM(ABS(COALESCE(i.variance,0)) * ${cost}), 0)::numeric AS abs_variance_value,
                COALESCE(SUM(COALESCE(i.variance,0) * ${cost}), 0)::numeric AS net_variance_value
         ${baseFrom}`, binds)).rows[0];

      // ⛔ EL CENSO DE LO QUE EL IRA NO MIRA. Un folio cancelado desaparece del universo, y con
      // el proceso sin arrancar eso es TODO lo que hay: sin esto la pantalla no puede distinguir
      // "no hay descuadre" de "nunca se reconcilió un conteo".
      const otros = (await trx.raw(
        `SELECT c.status, COUNT(DISTINCT c.id)::int AS folios, COUNT(i.*)::int AS renglones,
                COUNT(i.*) FILTER (WHERE i.status <> 'pending')::int AS tocados,
                MIN(c.created_at)::date AS desde, MAX(c.created_at)::date AS hasta,
                COALESCE(string_agg(DISTINCT w.code, ', ' ORDER BY w.code), '') AS almacenes
           FROM commercial.inventory_counts c
           LEFT JOIN commercial.inventory_count_items i
             ON i.count_id = c.id AND i.tenant_id = c.tenant_id
           LEFT JOIN commercial.warehouses w ON w.id = c.warehouse_id
          WHERE c.status <> 'reconciled'
            ${q.warehouse_id ? 'AND c.warehouse_id = ?' : ''}
          GROUP BY 1 ORDER BY 2 DESC`,
        q.warehouse_id ? [q.warehouse_id] : [])).rows;

      const byReason = (await trx.raw(
        `SELECT COALESCE(i.reason_code, 'sin_clasificar') AS reason_code,
                COUNT(*)::int AS items,
                COALESCE(SUM(ABS(COALESCE(i.variance,0))), 0)::numeric AS units,
                COALESCE(SUM(ABS(COALESCE(i.variance,0)) * ${cost}), 0)::numeric AS value
         ${baseFrom} AND COALESCE(i.variance,0) <> 0
         GROUP BY 1 ORDER BY value DESC`, binds)).rows;

      const recent = (await trx.raw(
        `SELECT c.id AS count_id, c.folio, c.warehouse_id, w.code AS warehouse_code, c.reconciled_at,
                COUNT(*)::int AS items,
                COUNT(*) FILTER (WHERE ${accurate})::int AS accurate,
                COALESCE(SUM(COALESCE(i.variance,0) * ${cost}), 0)::numeric AS net_variance_value
         ${baseFrom}
         GROUP BY c.id, c.folio, c.warehouse_id, w.code, c.reconciled_at
         ORDER BY c.reconciled_at DESC LIMIT 50`, binds)).rows;

      const total = Number(ov.total_items) || 0;
      const accurateN = Number(ov.accurate_items) || 0;
      const expVal = Number(ov.expected_value) || 0;
      const absVar = Number(ov.abs_variance_value) || 0;
      return {
        tolerance_pct: tolPct,
        folios: Number(ov.folios) || 0,
        total_items: total,
        accurate_items: accurateN,
        ira_pct: total ? +((accurateN / total) * 100).toFixed(2) : null,
        value_accuracy_pct: expVal ? +((1 - absVar / expVal) * 100).toFixed(2) : null,
        // ⛔ NULL y no 0 cuando no hay un solo item: "cero pesos de variacion" y "no hay con que
        // calcularla" se leen igual en una tarjeta de dinero, y son cosas distintas (ADR-056).
        net_variance_value: total ? +Number(ov.net_variance_value).toFixed(2) : null,
        abs_variance_value: total ? +absVar.toFixed(2) : null,
        expected_value: total ? +expVal.toFixed(2) : null,
        /** Items cuyo costo no resolvio: entran al calculo valuados en CERO, o sea que una
         *  diferencia sin costo se ve como si no hubiera diferencia e infla la exactitud. */
        items_sin_costo: Number(ov.items_sin_costo) || 0,
        /** Lo que el IRA NO mira: todo folio que no llego a `reconciled`. Con el proceso sin
         *  arrancar, esto es lo unico que hay que contar. */
        sin_reconciliar: otros.map((r: any) => ({
          status: r.status,
          folios: Number(r.folios), renglones: Number(r.renglones), tocados: Number(r.tocados),
          desde: r.desde, hasta: r.hasta, almacenes: r.almacenes,
        })),
        by_reason: byReason.map((r: any) => ({
          reason_code: r.reason_code,
          items: Number(r.items),
          units: +Number(r.units).toFixed(3),
          value: +Number(r.value).toFixed(2),
        })),
        recent_folios: recent.map((r: any) => ({
          count_id: r.count_id, folio: r.folio,
          warehouse_id: r.warehouse_id, warehouse_code: r.warehouse_code,
          reconciled_at: r.reconciled_at,
          items: Number(r.items), accurate: Number(r.accurate),
          ira_pct: Number(r.items) ? +((Number(r.accurate) / Number(r.items)) * 100).toFixed(2) : null,
          net_variance_value: +Number(r.net_variance_value).toFixed(2),
        })),
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tablero del supervisor: avance, discrepancias, valor en riesgo. (SUPERVISAR)
  // ─────────────────────────────────────────────────────────────────────────
  async getProgress(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');

    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const pass = Number(count.current_pass) || 1;
      const passCol = pass >= 2 ? 'count_2' : 'count_1';

      const [agg] = await trx('commercial.inventory_count_items as i')
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        // Costo en modo inventory (item por sku, sin product_id): proxy = costo
        // anual / unidades anuales del catálogo ERP. Así value_at_variance deja
        // de salir 0 en folios inventory-source.
        .leftJoin('inventory.products as ip', 'ip.sku', 'i.product_sku')
        // [KE.3] mismo resolvedor de costo que iraMetrics y que el congelado al reconciliar.
        .leftJoin('analytics.v_erp_unit_cost as uc', function () {
          this.on('uc.tenant_id', '=', 'i.tenant_id')
            .andOn('uc.product_id', '=', 'i.product_id')
            .andOnVal('uc.warehouse_id', '=', count.warehouse_id);
        })
        .where('i.count_id', countId)
        .select(
          trx.raw('COUNT(*)::int AS total'),
          trx.raw(`COUNT(*) FILTER (WHERE i.count_1 IS NOT NULL)::int AS counted_once`),
          trx.raw(`COUNT(*) FILTER (WHERE i.count_1 IS NULL)::int AS uncounted`),
          trx.raw(`COUNT(*) FILTER (WHERE i.${passCol} IS NOT NULL)::int AS counted_pass`),
          trx.raw(`COUNT(*) FILTER (WHERE i.status = 'discrepancy')::int AS discrepancies`),
          trx.raw(`COUNT(*) FILTER (WHERE i.status = 'resolved')::int AS resolved`),
          trx.raw(
            `COALESCE(SUM(ABS(COALESCE(i.variance,0)) * COALESCE(uc.costo_unitario, ip.venta_valor_costo_anual / NULLIF(ip.venta_unidad_anual, 0), 0)) FILTER (WHERE i.status='resolved'), 0)::numeric AS value_at_variance`,
          ),
        );

      /**
       * `[IC.UB1]` **Cuántos artículos del folio tienen ubicación asignada.**
       *
       * Va en el tablero y no se calcula en la pantalla a propósito: la lista se topa en
       * 2,000 de 3,364, así que contar ahí daría una cobertura sobre una muestra y la
       * publicaría como si fuera del folio. El denominador tiene que ser el folio entero.
       */
      const [ubic] = await trx('commercial.inventory_count_items as i')
        .joinRaw(
          `LEFT JOIN LATERAL (${UBICACION_DEL_PRODUCTO} AND v.product_id = i.product_id) ub ON TRUE`,
          [count.warehouse_id],
        )
        .where('i.count_id', countId)
        .select(trx.raw('COUNT(ub.codigos)::int AS located'));

      // ── Productividad por contador (1.ª vuelta) ───────────────────────────────────────
      //
      // ⚠️ `[ICR.M3]` Ya no se agrupa por `counted_by_1`: con la captura como unidad, un
      // renglón puede tener capturas de varias personas y esa columna guarda sólo a **quien
      // capturó último**. Agrupando por ahí, quien contó y fue «desplazado» desaparecía del
      // tablero — el crédito se lo llevaba el último en pasar. La bitácora los tiene a todos.
      //
      // `counts` cuenta **renglones tocados**, no capturas: dos capturas del mismo producto en
      // dos racks son un artículo contado, no dos.
      const { rows: byCounter } = await trx.raw(
        `SELECT l.applied_by AS user_id,
                COUNT(DISTINCT l.item_id)::int AS counts,
                COUNT(DISTINCT l.item_id) FILTER (WHERE i.status = 'discrepancy')::int AS discrepancies
           FROM commercial.inventory_count_scan_log l
           JOIN commercial.inventory_count_items i ON i.id = l.item_id
          WHERE l.count_id = ? AND l.slot = 'count_1' AND l.applied_by IS NOT NULL
          GROUP BY l.applied_by`,
        [countId],
      );

      const total = Number(agg.total) || 0;
      const counted = Number(agg.counted_once) || 0;
      const countedPass = Number(agg.counted_pass) || 0;

      // [CNT.1] ⛔ ¿SE PUEDE CERRAR, Y SI NO, QUE FALTA? Con el MISMO metodo que usa
      // `reconcile()` para rechazar. Antes esto solo se sabia apretando el boton y recibiendo
      // un 409 -- despues de haber contado, o de haber abandonado. Los 6 folios de prod estan
      // cancelados justo por eso: 18,845 renglones y 9 contados.
      const itemsGuard = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .select('count_1', 'status', 'final_qty', 'reason_code', 'expected_qty', 'book_at_count');
      const bloqueos = ['reconciled', 'cancelled'].includes(count.status)
        ? [] : this.bloqueosParaReconciliar(count, itemsGuard);

      return {
        folio: count.folio,
        status: count.status,
        current_pass: pass,
        blind_double_count: count.blind_double_count,
        coverage_pct: total ? +((counted / total) * 100).toFixed(1) : 0,
        pass_coverage_pct: total ? +((countedPass / total) * 100).toFixed(1) : 0,
        /** `[IC.UB1]` Artículos con ubicación en el catálogo de `/almacen/ubicaciones`. */
        located: Number(ubic?.located) || 0,
        ...agg,
        /** Lo que impide cerrar, en el orden en que `reconcile()` los evalua. */
        bloqueos,
        /** Vacio + folio abierto = se puede reconciliar. No es una opinion de la pantalla. */
        puede_reconciliar: bloqueos.length === 0
          && !['reconciled', 'cancelled'].includes(count.status),
        by_counter: byCounter,
      };
    });
  }

  /**
   * Resuelve un código de barras (o product_id) a la identificación del producto
   * — nombre/sku/marca/ubicación — para que el contador confirme QUÉ escaneó.
   * CIEGO: no devuelve existencia ni teórico. (CONTAR)
   */
  async resolveProduct(barcode?: string, productId?: string) {
    const code = barcode?.trim();
    if (!code && !(productId && UUID.test(productId)))
      throw new BadRequestException('Se requiere barcode o product_id');

    return this.tk.run(async (trx) => {
      // 1) inventory.products = catálogo del almacén (TODOS los productos, con
      //    codigo_barras). Es la fuente real en prod. Sin tenant_id ni id uuid;
      //    se identifica por sku → product_id queda null (el conteo por sku es
      //    parte del rework pendiente; acá solo reconocemos el producto).
      if (code) {
        const inv = await this.resolveInvByCode(trx, code);
        if (inv) {
          // [IC.F13] `inventory.products.categoria` NO es la marca: es un CÓDIGO de categoría.
          // Viajaba en `brand_name` y la pantalla del contador lo pintaba junto al SKU como si
          // fuera un dato del producto — «00203 · 341».
          //
          // Medido en prod el 2026-11-26: de 10,266 productos, 9,321 traen categoría y los
          // 9,321 son NUMÉRICOS (492 códigos distintos) — nunca fue un nombre de marca. El
          // 97.1 % sí casa con `catalog.categories.code`, y ahí «341» resulta ser
          // «PROMOCIONES», que es exactamente lo que era ese producto.
          //
          // Entonces se manda el NOMBRE, en un campo que dice lo que trae. Si el código no
          // casa (2.9 %) no se manda nada: un «341» suelto no le dice nada a quien cuenta.
          const cat = inv.categoria
            ? await trx('catalog.categories').where({ code: inv.categoria }).first('name')
            : null;
          // `[IC.F24]` En qué unidad se cuenta: la del código que trae el SKU, y las demás
          // como opción. Sin primario no se inventa una — la pantalla lo declara.
          const un = await this.unidadesDeConteo(trx, null, inv.sku);
          return {
            product_id: null,
            sku: inv.sku,
            product_name: inv.nombre,
            barcode: inv.codigo_barras,
            brand_name: null,
            category_name: cat?.name ?? null,
            unit_default: un.nativa?.unit ?? null,
            units_available: un.opciones,
            location: null,
            unit_sale: inv.unidad_venta ?? null,
            source: 'inventory',
          };
        }
      }

      // 2) Fallback: catalog.products (catálogo comercial; poblado en local).
      let prod: any = null;
      /** `[ICR.M11]` Lo que se supo del codigo escaneado, para que la pantalla preseleccione. */
      let codigoResuelto: CodigoResuelto | null = null;
      if (productId && UUID.test(productId)) {
        prod = await trx('public.products').where({ id: productId }).first();
      } else if (code) {
        // `[ICR.M10]` Mismo resolvedor que `submitCount` (sin folio: este endpoint no sabe de
        // cuál viene). Si identificar y contar usaran reglas distintas, la pantalla diría
        // «no encontrado» para algo que después sí se cuenta — o peor, al revés.
        const hallado = await this.resolverProductoPorCodigo(trx, null, code, true);
        codigoResuelto = hallado;
        if (hallado) prod = await trx('public.products').where({ id: hallado.product_id }).first();
      }
      if (!prod) throw new NotFoundException('Sin producto para ese código');
      const brand = prod.brand_id
        ? await trx('public.brands').where({ id: prod.brand_id }).first()
        : null;
      // `[IC.F24]` Misma regla en las dos ramas, para que la pantalla no tenga que adivinar.
      const un = await this.unidadesDeConteo(trx, prod.id, prod.sku);
      return {
        product_id: prod.id,
        sku: prod.sku,
        product_name: prod.nombre,
        brand_name: brand?.nombre ?? null,
        unit_default: un.nativa?.unit ?? null,
        units_available: un.opciones,
        // Acá `brand_name` SÍ es la marca (`public.brands`). La categoría se manda en su
        // propio campo para que las dos ramas tengan la misma forma y nadie lea una por otra.
        category_name: null,
        // `[IC.UB1]` NO se manda `prod.location`: es la constante `Z000`. Y acá tampoco se
        // puede resolver la de verdad, porque este endpoint no sabe de qué folio viene y
        // una ubicación depende del almacén. Vacío declarado antes que un relleno.
        location: null,
        unit_sale: prod.unit_sale ?? null,
        source: 'catalog',
        /**
         * ⭐ `[ICR.M11]` En qué unidad está el código que se escaneó. Es lo que le permite a la
         * pantalla de `[ICR.M6]` preseleccionar «cajas» sin que nadie lo teclee. ⛔ Informativo:
         * el factor falta en 248 de 254 códigos de caja, así que no se aplica solo.
         */
        scanned_unit: codigoResuelto?.unidad_del_codigo ?? null,
        scanned_unit_factor: codigoResuelto?.factor_del_codigo ?? null,
        scanned_code_is_native: codigoResuelto?.es_codigo_nativo ?? null,
      };
    });
  }

  // Progreso CIEGO para el contador: avance sin teórico ni varianza. (CONTAR)
  async counterProgress(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const uid = this.userId();
      // El avance ciego se mide contra la pasada activa (count_1 o count_2).
      const pass = Number(count.current_pass) || 1;
      const col = pass >= 2 ? 'count_2' : 'count_1';
      const [agg] = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .select(
          trx.raw('COUNT(*)::int AS total'),
          trx.raw(`COUNT(*) FILTER (WHERE ${col} IS NOT NULL)::int AS counted`),
          trx.raw(`COUNT(*) FILTER (WHERE ${col} IS NULL)::int AS remaining`),
          trx.raw(`COUNT(*) FILTER (WHERE counted_by_1 = ? OR counted_by_2 = ? OR counted_by_3 = ?)::int AS mine`, [uid, uid, uid]),
        );
      return { folio: count.folio, status: count.status, current_pass: pass, ...agg };
    });
  }

  /** Catálogo blind-safe del folio para pre-cache offline del contador: identifica
   *  cada SKU del folio (barcode/sku/nombre/ubic.) SIN existencia ni teórico. (CONTAR) */
  async counterCatalog(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      if (count.stock_source === 'inventory') {
        return trx('commercial.inventory_count_items as i')
          .leftJoin('inventory.products as ip', 'ip.sku', 'i.product_sku')
          .where('i.count_id', countId)
          .select(
            trx.raw('NULL::uuid AS product_id'),
            'i.product_sku as sku',
            trx.raw('ip.codigo_barras AS barcode'),
            'ip.nombre as product_name',
            trx.raw('NULL::text AS location'),
          )
          .limit(20000);
      }
      // `[IC.UB1]` La ubicación del catálogo de UB, no la columna sembrada (constante `Z000`).
      return trx('commercial.inventory_count_items as i')
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        .joinRaw(
          `LEFT JOIN LATERAL (${UBICACION_DEL_PRODUCTO} AND v.product_id = i.product_id) ub ON TRUE`,
          [count.warehouse_id],
        )
        .where('i.count_id', countId)
        .select(
          'i.product_id',
          'p.sku',
          'p.barcode',
          'p.nombre as product_name',
          trx.raw('ub.codigos AS location'),
        )
        .limit(20000);
    });
  }

  /**
   * `[IC.F24]` **En qué unidades se puede contar este producto, y cuál es la de por defecto.**
   *
   * Sale de `catalog.product_barcodes`, que tiene una fila por código de barras con su unidad
   * y su factor. Lo medido en prod el 2026-11-27, que es lo que autoriza a usarla así:
   *   · los **7,109** códigos `is_primary` son **TODOS** `kepler_base` y **TODOS** con factor 1
   *     ⇒ el código que viene con el SKU **nombra la unidad nativa**, la misma del teórico;
   *   · de los 55 productos con dos primarios, **0 difieren en unidad** ⇒ el desempate no es
   *     una moneda al aire;
   *   · cobertura: **2,849 de 3,364** artículos del folio tienen primario, y **556** tienen
   *     más de una unidad — ésos son los que hoy se podían contar mal en silencio.
   *
   * ⚠️ El factor de acá **NO** es el `display_box_factor` del ERP: se cruzaron y coinciden en
   * 21 de 511 (4.1 %). Por eso sólo se usan las razones INTERNAS de esta tabla, que sí son
   * consistentes entre sí, y nunca se mezclan las dos fuentes.
   *
   * Sin primario (15 % de los artículos) **no se inventa una unidad**: se devuelve `null` y
   * la pantalla lo declara. Un relleno sería el mismo defecto que esto arregla.
   */
  async unidadesDeConteo(
    trx: TrxConRaw,
    productId: string | null | undefined,
    sku: string | null | undefined,
  ): Promise<{ nativa: UnidadDeConteo | null; opciones: UnidadDeConteo[] }> {
    if (!productId && !sku) return { nativa: null, opciones: [] };
    const { rows } = await trx.raw(
      `SELECT DISTINCT ON (b.unit) b.unit, b.factor::float8 AS factor, b.is_primary
         FROM catalog.product_barcodes b
        WHERE b.deleted_at IS NULL AND b.unit IS NOT NULL
          AND (b.product_id = ?::uuid OR (?::uuid IS NULL AND b.sku = ?))
        ORDER BY b.unit, b.is_primary DESC NULLS LAST, b.factor ASC`,
      [productId ?? null, productId ?? null, sku ?? null],
    );
    const filas = (rows ?? []) as unknown as { unit: string; factor: number; is_primary: boolean }[];
    const opciones: UnidadDeConteo[] = filas.map((f) => ({
      unit: f.unit,
      factor: Number(f.factor) > 0 ? Number(f.factor) : 1,
      es_nativa: f.is_primary === true,
    }));
    return { nativa: opciones.find((o) => o.es_nativa) ?? null, opciones };
  }

  /**
   * `[IC.UB1]` **Los códigos** de las ubicaciones de UN producto en UN almacén, del catálogo de
   * `/almacen/ubicaciones`, en el orden en que se caminan. Devuelve `null` cuando no está
   * asignado — que hoy es casi siempre, y es justo lo que hay que poder ver.
   *
   * ⚠️ No confundir con `ubicacionDe` de `warehouse-locations/ubicacion-del-producto.ts`, que
   * elige **UNA** por prioridad de `papel` para mandar a alguien ahí. Acá se devuelven todas,
   * porque quien cuenta tiene que recorrerlas todas; de ahí el nombre distinto.
   */
  private async codigosDeUbicacion(
    trx: TrxConRaw,
    warehouseId: string | null | undefined,
    productId: string | null | undefined,
  ): Promise<string | null> {
    if (!warehouseId || !productId) return null;
    const { rows } = await trx.raw(
      `${UBICACION_DEL_PRODUCTO} AND v.product_id = ?::uuid`,
      [warehouseId, productId],
    );
    return rows?.[0]?.codigos ?? null;
  }

  /**
   * Lista de items con teórico + varianza (NO la usa el contador). (SUPERVISAR/VER)
   *
   * ⛔ `[IC.F5]` **La otra mitad del tope: poder ALCANZAR lo que no cabe.**
   *
   * El `LIMIT 2000` se queda —bajar 3,364 filas con su costo en cada carga no es gratis— y
   * la pantalla ya lo declara. Lo que faltaba era la salida: con `search` el supervisor
   * llega a CUALQUIER artículo del folio por nombre, SKU, código de barras o ubicación,
   * aunque el orden alfabético lo haya dejado del otro lado del corte.
   *
   * Se usa `applySmartSearch` (ADR-056, fase BU: un solo buscador para toda la suite) en vez
   * de un `ILIKE` propio: multi-token en cualquier orden, sin acentos y con tolerancia a
   * typos. El filtro se aplica ANTES del `limit`, que es lo único que lo vuelve una salida
   * real y no un filtro sobre las 2,000 que ya habían pasado.
   */
  async listItems(countId: string, status?: string, search?: string): Promise<InventoryCountItemRow[]> {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      let q = trx('commercial.inventory_count_items as i')
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .leftJoin('inventory.products as ip', 'ip.sku', 'i.product_sku')
        // `[IC.UB1]` La ubicación REAL, del catálogo de `/almacen/ubicaciones`.
        .joinRaw(
          `LEFT JOIN LATERAL (${UBICACION_DEL_PRODUCTO} AND v.product_id = i.product_id) ub ON TRUE`,
          [count.warehouse_id],
        )
        .where('i.count_id', countId);
      if (status) q = q.where('i.status', status);
      // Columnas simples a propósito: applySmartSearch valida cada una como identificador,
      // así que un COALESCE(...) se descartaría en silencio. Se listan los dos lados del
      // catálogo (public.products y inventory.products) porque la lista ya los mezcla.
      applySmartSearch(q, search, {
        columns: ['p.sku', 'i.product_sku', 'p.nombre', 'ip.nombre', 'p.barcode', 'ub.codigos'],
      });
      return q
        .select(
          'i.id',
          'i.product_id',
          trx.raw('COALESCE(p.sku, i.product_sku) AS sku'),
          trx.raw('COALESCE(p.nombre, ip.nombre) AS product_name'),
          trx.raw('COALESCE(b.nombre, ip.categoria) AS brand_name'),
          trx.raw('ub.codigos AS location'),
          // `[ICR.0.3][ICR.0.4]` El tramo del recorrido donde el producto se encuentra PRIMERO, y
          // cuántos ocupa. `NULL` = sin ubicación asignada, que es trabajo real: la pantalla lo
          // nombra «sin ubicar» en vez de dejar un hueco (regla 11).
          trx.raw('ub.tramo AS tramo'),
          trx.raw('COALESCE(ub.tramos, 0)::int AS tramos'),
          'i.expected_qty',
          'i.count_1',
          'i.count_2',
          'i.count_3',
          'i.final_qty',
          'i.variance',
          'i.status',
          'i.notes',
          'i.reason_code',
          'p.cost_base',
          // `[IC.F24]` El testigo de en qué unidad se contó, para que el supervisor no
          // resuelva una diferencia sin saber que alguien contó en cajas.
          'i.count_1_unit',
          'i.count_2_unit',
          'i.count_3_unit',
        )
        .orderByRaw(`CASE i.status WHEN 'discrepancy' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END`)
        .orderByRaw('COALESCE(p.nombre, ip.nombre) ASC')
        .limit(2000);
    });
  }

  /**
   * `[IC.13]` Lista de folios **con avance y última actividad real**.
   *
   * Antes devolvía sólo la cabecera, y por eso la pantalla no podía responder la única
   * pregunta que importa en un tablero de folios: *¿esto avanza?*. Lo medido en prod el
   * 2026-10-06: `INV-2026-00009` congeló Padre Hidalgo **100 días** con **3 escaneos sobre
   * 2,094 artículos**, y la lista no lo decía — el badge "Estancado" se calculaba contra
   * `started_at`, o sea contra *cuándo se abrió*, no contra *cuándo se contó por última vez*.
   *
   * Se devuelven **dos ausencias distintas a propósito** (ADR-056): `items_counted = 0` es
   * "nadie contó nunca" y lo arregla quien asigna personal; `last_count_at` viejo con
   * `items_counted > 0` es "se frenó" y lo arregla quien supervisa. Colapsarlas en un solo
   * badge es justo lo que escondía el caso de arriba. `last_count_at` llega **NULL** cuando
   * no hay un solo escaneo — nunca se rellena con `started_at`, que daría un "última
   * actividad" inventado para un folio en el que no pasó nada.
   *
   * ⚠️ El `LIMIT` va DENTRO del CTE a propósito: con el LATERAL sobre la tabla completa el
   * plan agregaba los ítems de **todos** los folios y recién después recortaba a 200. Con 6
   * folios no se nota; con 200 × ~3k ítems son 600k filas por cada carga de la pantalla.
   * Medido contra prod: 58 ms en frío, 5-8 ms en caliente (gate 500 ms).
   */
  async listCounts(warehouseId?: string) {
    // El filtro ahora viaja como bind `::uuid`: un valor basura reventaría en Postgres
    // con un 500 en vez del 400 que corresponde.
    if (warehouseId && !UUID.test(warehouseId))
      throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `WITH f AS (
           SELECT c.id, c.folio, c.warehouse_id, c.type, c.status, c.freeze_movements,
                  c.started_at, c.closed_at, c.created_at, c.updated_at
             FROM commercial.inventory_counts c
            WHERE (?::uuid IS NULL OR c.warehouse_id = ?::uuid)
            ORDER BY c.created_at DESC
            LIMIT 200
         )
         SELECT f.id, f.folio, f.warehouse_id,
                w.code AS warehouse_code, w.name AS warehouse_name,
                f.type, f.status, f.freeze_movements,
                f.started_at, f.closed_at, f.created_at, f.updated_at,
                COALESCE(prog.items_total, 0)   AS items_total,
                COALESCE(prog.items_counted, 0) AS items_counted,
                prog.last_count_at
           FROM f
           LEFT JOIN commercial.warehouses w ON w.id = f.warehouse_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS items_total,
                    COUNT(*) FILTER (WHERE i.count_1 IS NOT NULL)::int AS items_counted,
                    MAX(GREATEST(i.counted_at_1, i.counted_at_2, i.counted_at_3)) AS last_count_at
               FROM commercial.inventory_count_items i
              WHERE i.count_id = f.id
           ) prog ON true
          ORDER BY f.created_at DESC`,
        [warehouseId || null, warehouseId || null],
      );
      return rows;
    });
  }

  // ───── Asignaciones de personas al folio (Fase I.4) ─────

  /** PA.4 — avance del conteo POR PASILLO (cobertura/discrepancias). (SUPERVISAR) */
  async aisleProgress(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const byAisle = await trx.raw(
        `SELECT a.id AS aisle_id, a.code, a.name, a.grid_row, a.grid_col,
                COUNT(i.id)::int AS total,
                COUNT(i.id) FILTER (WHERE i.count_1 IS NOT NULL)::int AS counted,
                COUNT(i.id) FILTER (WHERE i.count_1 IS NULL)::int AS uncounted,
                COUNT(i.id) FILTER (WHERE i.status = 'discrepancy')::int AS discrepancies,
                COUNT(i.id) FILTER (WHERE i.status = 'resolved')::int AS resolved
           FROM commercial.warehouse_aisles a
           LEFT JOIN commercial.inventory_count_items i ON i.aisle_id = a.id AND i.count_id = ?
          WHERE a.warehouse_id = ? AND a.active = true
          GROUP BY a.id, a.code, a.name, a.grid_row, a.grid_col
          ORDER BY a.grid_row, a.grid_col`,
        [countId, count.warehouse_id],
      );
      const un = await trx.raw(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE count_1 IS NOT NULL)::int AS counted,
                COUNT(*) FILTER (WHERE count_1 IS NULL)::int AS uncounted,
                COUNT(*) FILTER (WHERE status = 'discrepancy')::int AS discrepancies
           FROM commercial.inventory_count_items
          WHERE count_id = ? AND aisle_id IS NULL`,
        [countId],
      );
      return { status: count.status, aisles: byAisle.rows, unassigned: un.rows[0] };
    });
  }

  /** Usuarios asignables como contador (CONTAR) o supervisor (SUPERVISAR). */
  /**
   * `[IC.27]` **Quién puede entrar al equipo de un conteo.**
   *
   * ── Contadores: la lista es UNIVERSAL (Edgar, 2026-11-24) ────────────────────────────────
   *
   * El equipo de un inventario físico no sale de un puesto: se trae gente de otras sucursales
   * y de oficinas, **promotoras incluidas**. Así que el catálogo de `counter` son **todos los
   * activos internos**, se elijan uno a uno. La llave para contar la da la asignación
   * (`ContarOAsignadoGuard`), no el rol — por eso acá ya no se filtra por la clave.
   *
   * *Cifra que lo motivó (prod, 2026-11-24): de 263 personas activas, **96 son promotoras** y
   * ninguna tiene `COMMERCIAL_INVENTORY_CONTAR`; el catálogo viejo ofrecía 24 nombres.*
   *
   * ── Supervisores: siguen filtrados, y a propósito ───────────────────────────────────────
   *
   * El supervisor responsable **abre el detalle del folio**, que exige `SUPERVISAR` y muestra
   * el teórico. Ofrecer ahí a alguien sin la clave sería prometer una responsabilidad que la
   * pantalla no lo deja ejercer.
   *
   * ⛔ El filtro se hace por la UNIÓN de roles (perfil base + complementos de
   * `identity.user_roles`), que es lo que de verdad enforcea `RolesGuard`. Antes sólo miraba
   * `u.role_name`: medido en prod, eso dejaba fuera a **7 de 31** personas que sí podían contar
   * —entre ellas el único surtidor que usa el módulo— y a quien supervisa por complemento.
   *
   * Devuelve además lo que la pantalla necesita para elegir con criterio: `warehouse_code`
   * (para subir a los del almacén que se cuenta), `puede_contar` (informativo) y `folio_vivo`
   * (si la persona YA está comprometida en otro conteo abierto).
   */
  async assignableUsers(role: 'counter' | 'supervisor') {
    const perm = role === 'supervisor'
      ? 'COMMERCIAL_INVENTORY_SUPERVISAR'
      : 'COMMERCIAL_INVENTORY_CONTAR';
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `WITH clave AS (
           SELECT u.id,
                  EXISTS (
                    SELECT 1 FROM identity.role_permissions rp
                     WHERE rp.tenant_id = u.tenant_id
                       AND (rp.permissions ->> ?) = 'true'
                       AND (rp.role_name = u.role_name
                            OR rp.role_name IN (SELECT ur.role_name
                                                  FROM identity.user_roles ur
                                                 WHERE ur.user_id = u.id))
                  ) AS tiene
             FROM identity.users u
            WHERE u.activo = true
         )
         SELECT u.id, u.username, u.nombre, u.role_name, u.warehouse_code,
                k.tiene AS puede_contar,
                fv.folio AS folio_vivo
           FROM identity.users u
           JOIN clave k ON k.id = u.id
           LEFT JOIN LATERAL (
             SELECT c.folio
               FROM commercial.inventory_count_assignments a
               JOIN commercial.inventory_counts c ON c.id = a.count_id
              WHERE a.user_id = u.id
                AND a.assignment_role = 'counter'
                AND c.status IN ('counting', 'review')
              ORDER BY c.created_at DESC
              LIMIT 1
           ) fv ON true
          WHERE u.activo = true
            -- Personas, no cuentas de sistema: fuera clientes del portal, dispositivos y
            -- cuentas de servicio. Medido: 263 internos de 286 activos.
            AND COALESCE(u.kind, 'interno') = 'interno'
            AND u.deleted_at IS NULL
            -- El supervisor responsable abre el detalle (teórico): sólo quien tenga la clave.
            AND (?::boolean OR k.tiene)
          ORDER BY u.nombre NULLS LAST, u.username`,
        [perm, role === 'counter'],
      );
      return rows;
    });
  }

  async listAssignments(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      await this.getCountOrThrow(trx, countId);
      return trx('commercial.inventory_count_assignments as a')
        .leftJoin('identity.users as u', 'u.id', 'a.user_id')
        .where('a.count_id', countId)
        .select('a.user_id', 'a.assignment_role', 'u.username', 'u.nombre');
    });
  }

  /** Reemplaza la lista de asignados de un rol en el folio. (ASIGNAR) */
  async setAssignments(countId: string, role: 'counter' | 'supervisor', userIds: string[]) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    if (role !== 'counter' && role !== 'supervisor')
      throw new BadRequestException('role inválido');
    const ids = (userIds || []).filter((id) => UUID.test(id));
    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      if (count.status === 'reconciled' || count.status === 'cancelled')
        throw new ConflictException('El folio ya está cerrado.');
      const uid = this.userId();

      /**
       * `[IC.27]` **Asignar es dar la llave, así que se verifica a quién.**
       *
       * Desde que el catálogo es universal, la asignación ya no la respalda un permiso de rol:
       * `ContarOAsignadoGuard` deja contar a quien esté en esta lista. Un id de alguien
       * inactivo, borrado o de otro tenant entraría como fila válida y habilitaría una cuenta
       * que no debería entrar — por eso el universo se vuelve a comprobar acá, del lado que
       * escribe, y no se confía en lo que mandó la pantalla.
       */
      if (ids.length) {
        const vivos = await trx('identity.users')
          .whereIn('id', ids)
          .andWhere('activo', true)
          .andWhere(function () {
            this.whereNull('kind').orWhere('kind', 'interno');
          })
          .whereNull('deleted_at')
          .pluck('id');
        const fuera = ids.filter((id) => !vivos.includes(id));
        if (fuera.length)
          throw new BadRequestException(
            `${fuera.length} de los ${ids.length} seleccionados no es una cuenta de persona activa.`,
          );
      }
      await trx('commercial.inventory_count_assignments')
        .where({ count_id: countId, assignment_role: role })
        .del();
      if (ids.length) {
        await trx('commercial.inventory_count_assignments').insert(
          ids.map((userId) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            count_id: countId,
            user_id: userId,
            assignment_role: role,
            assigned_by: uid,
          })),
        );
      }
      return { ok: true, role, count: ids.length };
    });
  }

  /** Folios que puede contar el usuario actual: asignado como contador, o
   *  folios sin contadores asignados (modo abierto). (CONTAR) */
  async myCountingFolios() {
    return this.tk.run(async (trx) => {
      const uid = this.userId();
      return trx('commercial.inventory_counts as c')
        .leftJoin('commercial.warehouses as w', 'w.id', 'c.warehouse_id')
        .whereIn('c.status', ['counting', 'review'])
        .andWhere(function () {
          this.whereExists(function () {
            this.select(trx.raw('1'))
              .from('commercial.inventory_count_assignments as a')
              .whereRaw('a.count_id = c.id AND a.assignment_role = ? AND a.user_id = ?', ['counter', uid]);
          }).orWhereNotExists(function () {
            this.select(trx.raw('1'))
              .from('commercial.inventory_count_assignments as a2')
              .whereRaw(`a2.count_id = c.id AND a2.assignment_role = 'counter'`);
          });
        })
        .select('c.id', 'c.folio', 'c.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name', 'c.type', 'c.status')
        .orderBy('c.created_at', 'desc')
        .limit(100);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reconciliación: ajusta stock al físico + genera movimientos. (RECONCILIAR)
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * ⚠️ [IC.1] DÓNDE CAE EL AJUSTE, Y POR QUÉ NO ES DONDE SE CONTÓ.
   *
   * Desde IC.1 el teórico sale del ERP (`v_erp_stock_on_hand`, derivado del ODS), pero el
   * ajuste se escribe en `commercial.stock` — NO en Kepler. No es un descuido: **no escribimos
   * al system of record** (ADR-040). El ERP se entera por el archivo que emite
   * `keplerAdjustmentExport` y que alguien captura allá.
   *
   * Consecuencia que hay que tener presente: hasta que ese archivo se capture, el ERP sigue
   * con su saldo viejo y el siguiente folio va a volver a encontrar la misma diferencia. El
   * ajuste local no la cierra del lado del ERP.
   */
  /**
   * `[CNT.1]` **LO QUE FALTA PARA PODER CERRAR EL FOLIO — una sola definición.**
   *
   * ⛔ Por qué existe, medido en prod el 2026-09-30: hay **6 folios y los 6 están
   * `cancelled`**. Se abrieron entre el 15 y el 19-jun-2026 con **18,845 renglones** y se
   * contaron **9 (0.05%)**. La razón es el *coverage guard* de `reconcile()`, que es correcto y
   * de diseño —*un no-contado NO se trata como cero*— pero **sólo se entera de que no puede
   * cerrar quien aprieta el botón al final**, y para entonces ya contó 3,664 SKUs o abandonó.
   *
   * Un folio completo de 3,664 SKUs exige contar los 3,664 para cerrarse. Operativamente eso no
   * pasa en una tienda: por eso existe el folio cíclico de 50. Lo que faltaba no era el
   * mecanismo, era **decirlo ANTES**.
   *
   * ⭐ Y va acá, compartido, por una razón concreta: la primera versión de esta revisión duplicó
   * un criterio que ya existía (ABC.6, `clase_motivo`) y publicó una segunda verdad. Acá el
   * mismo array lo consume `reconcile()` para rechazar y `getProgress()` para avisar: si un día
   * divergen, es porque alguien tocó UNA línea, no dos.
   */
  private bloqueosParaReconciliar(
    count: Record<string, any>,
    items: Record<string, any>[],
  ): { code: string; items: number; mensaje: string }[] {
    const b: { code: string; items: number; mensaje: string }[] = [];

    const uncounted = items.filter((it) => it.count_1 == null);
    if (uncounted.length) b.push({
      code: 'sin_contar', items: uncounted.length,
      mensaje: `${uncounted.length} SKU(s) sin ningún conteo. Cuéntalos o cancela el folio `
        + '(un no-contado NO se trata como cero).',
    });

    const disc = items.filter((it) => it.status === 'discrepancy');
    if (disc.length) b.push({
      code: 'discrepancias', items: disc.length,
      mensaje: `${disc.length} discrepancia(s) sin resolver.`,
    });

    const unresolved = items.filter((it) => it.final_qty == null);
    if (unresolved.length) b.push({
      code: 'sin_valor_final', items: unresolved.length,
      mensaje: `${unresolved.length} item(s) sin valor final. Corre "calcular discrepancias" o resolvelos.`,
    });

    // Opt-in: sólo si el folio define umbral de recuento. Una merma grande no se postea al
    // ledger sin clasificar — alimenta el shrinkage por causa del IRA.
    const umbral = Number(count.recount_threshold_pct) || 0;
    if (umbral > 0) {
      const sinMotivo = items.filter((it) => {
        if (it.final_qty == null) return false;
        const baseline = this.varianceBaseline(count, it);
        const v = Number(it.final_qty) - baseline;
        return Math.abs(v) > Math.abs(baseline) * umbral / 100 && !it.reason_code;
      });
      if (sinMotivo.length) b.push({
        code: 'varianza_sin_motivo', items: sinMotivo.length,
        mensaje: `${sinMotivo.length} ítem(s) con varianza material sin motivo. `
          + 'Clasifica la causa (reason_code) al resolverlos.',
      });
    }
    return b;
  }

  async reconcile(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');

    return this.tk.run(async (trx) => {
      const t0 = Date.now();
      // Acota cualquier statement patológico (p. ej. lock contention en un full
      // count de ~9k SKUs) en vez de colgar la conexión indefinidamente.
      await trx.raw(`SET LOCAL statement_timeout = '60s'`);
      const uid = this.userId();
      // Fail-closed: la reconciliación mueve stock; exige usuario para la SoD.
      if (!uid) throw new ForbiddenException('Sesión sin usuario; no se puede autorizar la reconciliación.');
      const count = await trx('commercial.inventory_counts')
        .where({ id: countId })
        .forUpdate()
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status === 'reconciled')
        throw new ConflictException('El folio ya fue reconciliado.');
      if (count.status === 'cancelled')
        throw new ConflictException('El folio fue cancelado.');

      const items = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .select('*');

      // ── LOS GUARDS DE VALIDEZ ── Se evaluan con `bloqueosParaReconciliar`, el MISMO metodo
      // que consume `getProgress()` para avisar antes. Una sola definicion: si divergieran, el
      // supervisor veria "listo para cerrar" y el boton devolveria 409.
      const bloqueos = this.bloqueosParaReconciliar(count, items);
      if (bloqueos.length)
        throw new ConflictException(`No se puede reconciliar: ${bloqueos[0].mensaje}`);

      // ── FREEZE INTEGRITY GUARD ── (validez del conteo; va con los demás guards
      // de validez, ANTES del de autoridad). El ajuste fija el saldo de forma
      // ABSOLUTA al físico contado contra un teórico (expected_qty) fotografiado
      // al abrir. Si el almacén NO quedó congelado y hubo movimientos desde
      // entonces (ventas, ajustes, carga de ruta), ese set absoluto BORRARÍA esos
      // movimientos y la varianza estaría mal atribuida → bloquear, no corromper.
      // (Solo modo commercial: inventory.warehouse_stock no lo mueven los pedidos.)
      // Solo CONGELADOS: los no-congelados (cíclicos) reconcilian con delta relativo
      // contra book_at_count y por eso ya no se bloquean por movimientos.
      if (count.freeze_movements && count.stock_source !== 'inventory') {
        const since = count.started_at || count.created_at;
        // Scopeado a los productos DEL FOLIO: un movimiento de un SKU no contado no
        // invalida este conteo. Para un full count los items = todo el snapshot, así
        // que el comportamiento es el mismo; para un cíclico acotado, solo importan
        // los movimientos de los productos que sí se están contando.
        const countedProductIds = items.map((it) => it.product_id).filter(Boolean);
        const moved = await trx('commercial.stock_movements')
          .where({ warehouse_id: count.warehouse_id })
          .whereIn('product_id', countedProductIds)
          .whereRaw(`reference_type IS DISTINCT FROM 'inventory_count'`) // null-safe: cuenta también movimientos sin ref
          .where('created_at', '>=', since)
          .count<{ n: string }[]>('* as n');
        if (Number(moved[0]?.n || 0) > 0)
          throw new ConflictException(
            `No se puede reconciliar: hubo ${moved[0].n} movimiento(s) de stock de los productos del folio ${count.folio} desde que se abrió. El conteo no es confiable porque no quedaron congelados. Cancela el folio y vuelve a contarlo con "Congelar movimientos" activo.`,
          );
      }

      // ── SEGREGACIÓN DE FUNCIONES: el reconciliador no puede ser quien contó ──
      //
      // ⛔ `[ICR.M3]` La bitácora entra acá **porque sin ella este candado se abriría**: con la
      // captura como unidad, un renglón puede tener capturas de varias personas y
      // `counted_by_N` guarda sólo a quien capturó ÚLTIMO. Quien contó y fue «desplazado» por
      // una captura posterior desaparecería de la lista de participantes y podría autorizar su
      // propio conteo. La bitácora es append-only: ahí están todos.
      const participants = new Set<string>();
      items.forEach((it) => {
        [it.counted_by_1, it.counted_by_2, it.counted_by_3, it.resolved_by].forEach(
          (c) => c && participants.add(c),
        );
      });
      const capturadores = await trx('commercial.inventory_count_scan_log')
        .where({ count_id: countId })
        .whereNotNull('applied_by')
        .distinct('applied_by');
      (capturadores as { applied_by: string | null }[]).forEach(
        (c) => c.applied_by && participants.add(c.applied_by),
      );
      if (uid && participants.has(uid))
        throw new ForbiddenException(
          'Segregación de funciones: quien contó o resolvió ítems del folio no puede autorizar la reconciliación.',
        );

      // ── Aplicar ajustes en la MISMA transacción ──
      const isInv = count.stock_source === 'inventory';
      let adjusted = 0;
      let totalDelta = 0;
      const skippedReserved: string[] = [];

      // #14 — costo congelado AL RECONCILIAR (la merma no debe derivar si cambia
      // el costo después). Batch del costo de los productos del folio + acumulado
      // del valor de varianza por folio.
      //
      // [KE.3] ⭐ Este es el costo que QUEDA ESCRITO, asi que es el que mas importaba: salia de
      // `public.products.cost_base` (la base legacy, costo por PRODUCTO y global). Ahora sale del
      // resolvedor unico, al grano almacen x producto y con el testigo del MISMO ERP que la
      // existencia que se esta contando.
      // [KE.3] `number | null` a proposito: un SKU sin costo en ningun ERP ni en el catalogo NO
      // vale cero -- no se pudo valuar. Antes el `|| 0` congelaba un 0 en unit_cost y publicaba
      // la merma de ese renglon como $0.00, indistinguible de "no hubo merma" (ADR-056).
      const costMap = new Map<string, number | null>();
      let sinCosto = 0;
      if (isInv) {
        const skuList = items.map((it) => it.product_sku).filter(Boolean);
        if (skuList.length) {
          const rows = await trx('inventory.products')
            .whereIn('sku', skuList)
            .select('sku', trx.raw('venta_valor_costo_anual / NULLIF(venta_unidad_anual, 0) AS cost'));
          rows.forEach((r: any) => costMap.set(r.sku, r.cost != null ? Number(r.cost) : null));
        }
      } else {
        const idList = items.map((it) => it.product_id).filter(Boolean);
        if (idList.length) {
          const rows = await trx('analytics.v_erp_unit_cost')
            .where('warehouse_id', count.warehouse_id)
            .whereIn('product_id', idList)
            .select('product_id', 'costo_unitario');
          rows.forEach((r: any) => costMap.set(r.product_id,
            r.costo_unitario != null ? Number(r.costo_unitario) : null));
        }
      }
      let netVarValue = 0;
      let absVarValue = 0;

      for (const it of items) {
        // ⛔⛔ [IC.F20] DEFENSA EN PROFUNDIDAD: un no-contado NUNCA es cero.
        //
        // `Number(null)` es **0**. Sin esta línea, un artículo sin valor final entra al bucle
        // como cero, da `delta = −expected`, NO cae en el `if (delta === 0) continue` de abajo
        // y **se aplica**: dejaría la existencia del SKU en cero. En un folio total eso es
        // **el almacén entero a cero**.
        //
        // Hoy no ocurre porque `bloqueosParaReconciliar` frena antes por `final_qty == null`,
        // y ese guard está bien hecho — es lo que cumple la promesa que la pantalla le hace al
        // usuario: «un no-contado NO se trata como cero». ⚠️ Pero era **una sola capa**: un
        // camino nuevo, un «reconciliar parcial» o un filtro distinto entre el guard y este
        // bucle reintroducen el desastre sin que nada avise. La promesa se cumple ahora también
        // acá, donde se escribe.
        if (it.final_qty == null) continue;
        const finalQty = Number(it.final_qty);
        const expected = Number(it.expected_qty);

        // Modo inventory: set absoluto (inventory.warehouse_stock no lo mueven los
        // pedidos → no hay ventas durante el conteo que preservar).
        if (isInv) {
          const delta = +(finalQty - expected).toFixed(3);
          if (delta === 0) continue;
          const wsRow = await trx('inventory.warehouse_stock')
            .where({ warehouse_id: count.warehouse_id, sku: it.product_sku })
            .forUpdate()
            .first();
          const wsBefore = wsRow ? Number(wsRow.quantity) : 0;
          // Defensa: el saldo no puede quedar bajo lo reservado (CHECK en la tabla).
          const wsReserved = wsRow ? Number(wsRow.reserved_quantity) : 0;
          if (finalQty < wsReserved) {
            skippedReserved.push(it.product_sku);
            await trx('commercial.inventory_count_items')
              .where({ id: it.id })
              .update({
                status: 'discrepancy',
                notes: `Saldo ${finalQty} < reservado ${wsReserved}; ajuste bloqueado.`,
                updated_at: trx.fn.now(),
              });
            continue;
          }
          await trx('inventory.warehouse_stock')
            .insert({
              tenant_id: trx.raw('public.current_tenant_id()'),
              warehouse_id: count.warehouse_id,
              sku: it.product_sku,
              quantity: finalQty,
              updated_by: uid,
            })
            .onConflict(['tenant_id', 'warehouse_id', 'sku'])
            .merge({ quantity: finalQty, updated_at: trx.fn.now(), updated_by: uid });
          await trx('inventory.warehouse_stock_movements').insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            warehouse_id: count.warehouse_id,
            sku: it.product_sku,
            movement_type: 'adjust',
            quantity: Math.abs(+(finalQty - wsBefore).toFixed(3)),
            quantity_before: wsBefore,
            quantity_after: finalQty,
            reference_type: 'inventory_count',
            reference_id: countId,
            reason_code: it.reason_code || null,
            notes: `Inventario físico ${count.folio}. ${it.notes || ''}`.trim(),
            created_by: uid,
          });
          const unitCost = costMap.get(it.product_sku) ?? null;
          if (unitCost === null) sinCosto++;
          await trx('commercial.inventory_count_items').where({ id: it.id }).update({ unit_cost: unitCost });
          netVarValue += delta * (unitCost ?? 0);
          absVarValue += Math.abs(delta) * (unitCost ?? 0);
          adjusted++;
          totalDelta = +(totalDelta + delta).toFixed(3);
          continue;
        }

        // Modo commercial. Lock del saldo ANTES de calcular (cierra el TOCTOU del
        // path no-congelado).
        const stockRow = await trx('commercial.stock')
          .where({ warehouse_id: count.warehouse_id, product_id: it.product_id })
          .forUpdate()
          .first();

        const qtyBefore = stockRow ? Number(stockRow.quantity) : 0;
        const reservedBefore = stockRow ? Number(stockRow.reserved_quantity) : 0;

        // Frozen → set absoluto (el freeze guard garantiza que el saldo no se movió
        // desde la apertura). No-frozen (cíclico) → delta RELATIVO contra el libro
        // al momento del conteo (book_at_count): así las ventas ocurridas durante el
        // conteo se conservan en vez de borrarse por un set absoluto.
        const baseline = count.freeze_movements
          ? expected
          : it.book_at_count != null
            ? Number(it.book_at_count)
            : expected;
        const newQty = count.freeze_movements
          ? finalQty
          : +(qtyBefore + (finalQty - baseline)).toFixed(3);
        const appliedDelta = +(newQty - qtyBefore).toFixed(3);
        if (appliedDelta === 0) continue;

        // El saldo resultante no puede quedar por debajo de lo reservado (viola CHECK
        // quantity >= reserved). Lo dejamos pendiente para revisión manual.
        if (newQty < reservedBefore) {
          skippedReserved.push(it.product_id);
          await trx('commercial.inventory_count_items')
            .where({ id: it.id })
            .update({
              status: 'discrepancy',
              notes: `Saldo resultante ${newQty} < reservado ${reservedBefore}; ajuste bloqueado, requiere liberar reservas.`,
              updated_at: trx.fn.now(),
            });
          continue;
        }

        if (stockRow) {
          await trx('commercial.stock')
            .where({ id: stockRow.id })
            .update({ quantity: newQty, updated_at: trx.fn.now(), updated_by: uid });
        } else {
          await trx('commercial.stock').insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            warehouse_id: count.warehouse_id,
            product_id: it.product_id,
            quantity: newQty,
            reserved_quantity: 0,
            updated_by: uid,
          });
        }

        await trx('commercial.stock_movements').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: count.warehouse_id,
          product_id: it.product_id,
          movement_type: 'adjust',
          quantity: Math.abs(appliedDelta),
          quantity_before: qtyBefore,
          quantity_after: newQty,
          reference_type: 'inventory_count',
          reference_id: countId,
          reason_code: it.reason_code || null,
          notes: `Inventario físico ${count.folio}. ${it.notes || ''}`.trim(),
          created_by: uid,
        });
        const unitCost = costMap.get(it.product_id) ?? null;
        if (unitCost === null) sinCosto++;
        await trx('commercial.inventory_count_items').where({ id: it.id }).update({ unit_cost: unitCost });
        netVarValue += appliedDelta * (unitCost ?? 0);
        absVarValue += Math.abs(appliedDelta) * (unitCost ?? 0);
        adjusted++;
        totalDelta = +(totalDelta + appliedDelta).toFixed(3);
      }

      if (skippedReserved.length) {
        // En modo inventory skippedReserved trae SKUs; en commercial, product_ids
        // (uuid) que resolvemos a SKU. No mezclar (evita 22P02 al buscar por id).
        let label = skippedReserved.join(', ');
        if (!isInv) {
          const skus = await trx('public.products').whereIn('id', skippedReserved).pluck('sku');
          if (skus.filter(Boolean).length) label = skus.filter(Boolean).join(', ');
        }
        throw new ConflictException(
          `${skippedReserved.length} SKU(s) con saldo resultante < reservado (${label}): libera las reservas (pedidos) antes de reconciliar.`,
        );
      }

      await trx('commercial.inventory_counts')
        .where({ id: countId })
        .update({
          status: 'reconciled',
          reconciled_at: trx.fn.now(),
          reconciled_by: uid,
          closed_at: trx.fn.now(),
          net_variance_value: +netVarValue.toFixed(2),
          variance_value_abs: +absVarValue.toFixed(2),
          updated_at: trx.fn.now(),
          updated_by: uid,
        });

      this.logger.log(
        `Folio ${count.folio} reconciliado: ${adjusted} ajustes, delta neto ${totalDelta} (${items.length} ítems, ${Date.now() - t0}ms).`,
      );
      return {
        status: 'reconciled',
        folio: count.folio,
        items_adjusted: adjusted,
        net_delta: totalDelta,
        net_variance_value: +netVarValue.toFixed(2),
        /** [KE.3] Renglones ajustados que NO se pudieron valuar (ningun ERP ni el catalogo dan
         *  costo): su `unit_cost` queda NULL y NO suman a la merma. Sin este conteo, una merma
         *  de $0 se lee como "no hubo merma" en vez de "no se pudo medir". */
        items_sin_costo: sinCosto,
        costo_resolver: 'analytics.v_erp_unit_cost',
      };
    });
  }

  /**
   * Dias sin un solo escaneo tras los cuales un folio se considera ABANDONADO.
   *
   * Es el umbral que separa "nadie lo esta trabajando" de "hay gente contando ahora".
   * Un conteo real se hace en horas o en un par de dias; el que motivo esta regla
   * (`INV-2026-00009`) llevaba **67 dias sin escaneos y 3 articulos contados de 2,094**.
   */
  static readonly DIAS_ABANDONADO = 7;

  /**
   * **¿Este folio está abandonado?** Pura a propósito: es la regla que decide si alguien
   * sin la llave de reconciliar puede tirarlo, así que tiene que poder probarse con
   * fechas y sin base de datos (mismo criterio que `ReceivingAuditorService.computeVerdict`).
   *
   * `ultimoMovimiento` es el último escaneo del folio; cuando no hubo ninguno, el llamador
   * pasa la fecha de apertura — un folio abierto hoy y todavía vacío es trabajo por empezar,
   * no basura. Una fecha ausente o ilegible devuelve **false**: ante la duda no se deja
   * cancelar, que es el lado seguro (el dueño del conteo siempre puede).
   */
  static estaAbandonado(ultimoMovimiento: Date | string | null | undefined, ahora = Date.now()): boolean {
    if (!ultimoMovimiento) return false;
    const t = new Date(ultimoMovimiento).getTime();
    if (Number.isNaN(t)) return false;
    return ahora - t >= InventoryCountService.DIAS_ABANDONADO * 86400000;
  }

  /**
   * Cancelar = ABANDONAR el folio. No ajusta stock (eso es `reconcile`).
   *
   * `soloSiEstaAbandonado` lo manda el controller cuando quien llama tiene la llave
   * acotada (`CANCELAR_CONTEO`) y NO la de reconciliar. Es lo que vuelve segura esa
   * llave: el del Anden puede destrabar un conteo que nadie toca hace una semana,
   * pero NO puede tirar el trabajo de un equipo que esta contando ahora mismo.
   * Quien tiene `RECONCILIAR` cancela sin restriccion, igual que siempre.
   */
  async cancel(
    countId: string,
    reason?: string,
    opts?: { soloSiEstaAbandonado?: boolean },
  ): Promise<{ status: string; folio: string }> {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    const acotado = opts?.soloSiEstaAbandonado === true;
    if (acotado && !String(reason || '').trim())
      throw new BadRequestException('Escribe el motivo: es lo único que explica por qué se descartó el conteo.');
    return this.tk.run(async (trx) => {
      const count = await trx('commercial.inventory_counts')
        .where({ id: countId })
        .forUpdate()
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status === 'reconciled')
        throw new ConflictException('No se puede cancelar un folio reconciliado.');

      if (acotado) {
        const { rows } = await trx.raw(
          `SELECT max(GREATEST(i.counted_at_1, i.counted_at_2, i.counted_at_3)) AS ultimo
             FROM commercial.inventory_count_items i
            WHERE i.count_id = ? AND i.tenant_id = ?`,
          [countId, count.tenant_id],
        );
        // Sin ningun escaneo, la referencia es la apertura del folio: uno abierto hoy y
        // todavia vacio es trabajo por empezar, no basura.
        const desde = rows?.[0]?.ultimo ?? count.created_at;
        if (!InventoryCountService.estaAbandonado(desde)) {
          throw new ConflictException(
            `El folio ${count.folio} tuvo movimiento hace menos de ${InventoryCountService.DIAS_ABANDONADO} días: ` +
            'parece un conteo en curso. Sólo quien reconcilia puede cancelarlo.',
          );
        }
      }
      await trx('commercial.inventory_counts')
        .where({ id: countId })
        .update({
          status: 'cancelled',
          closed_at: trx.fn.now(),
          notes: reason ? `Cancelado: ${reason}. ${count.notes || ''}`.trim() : count.notes,
          updated_at: trx.fn.now(),
          updated_by: this.userId(),
        });
      return { status: 'cancelled', folio: count.folio };
    });
  }

  /**
   * Export del ajuste de un folio reconciliado al formato del ERP Kepler.
   *
   * Mapea las varianzas a documentos de inventario Kepler:
   *   variance < 0 (merma)    → InvOut (nature N, dirección D)
   *   variance > 0 (sobrante) → InvIn  (nature N, dirección A)
   * (alternativamente un único PhysInv con la cantidad contada).
   *
   * NO escribe en Kepler (es el ERP de producción; estructura kdm1 de 200 cols,
   * folio/sequencing/triggers propios). Devuelve el documento para importar o
   * capturar en Kepler. La sucursal sale del código del almacén (KEPLER-NN → NN).
   */
  /**
   * [IC.7] Confirmar que el archivo YA se capturó en Kepler.
   *
   * ⚠️ Lo declara una PERSONA: no tenemos forma de comprobar contra el ERP que el documento
   * entró. Por eso queda firmado con usuario y hora — un acuse anónimo no deja a quién
   * preguntarle cuando el conteo siguiente vuelva a encontrar la misma diferencia.
   */
  async keplerExportAck(countId: string, body: { kepler_folio?: string; notas?: string }) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    const uid = this.userId();
    if (!uid) throw new ForbiddenException('Sesión sin usuario; el acuse tiene que ir firmado.');
    return this.tk.run(async (trx) => {
      const count = await trx('commercial.inventory_counts').where({ id: countId }).first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status !== 'reconciled')
        throw new ConflictException('Sólo se acusa un folio reconciliado.');

      const [row] = await trx('commercial.inventory_kepler_exports')
        .insert({
          tenant_id: count.tenant_id,
          count_id: countId,
          estado: 'capturado',
          capturado_at: trx.fn.now(),
          capturado_por: uid,
          kepler_folio: body.kepler_folio || null,
          notas: body.notas || null,
          exportado_por: uid,
        })
        .onConflict(trx.raw(`(tenant_id, count_id) WHERE estado <> 'descartado'`))
        .merge({
          estado: 'capturado',
          capturado_at: trx.fn.now(),
          capturado_por: uid,
          kepler_folio: body.kepler_folio || null,
          notas: body.notas || null,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      this.logger.log(`Folio ${count.folio}: acuse de captura en Kepler por ${uid}.`);
      return row;
    });
  }

  /** [IC.7] Estado del archivo. `sin_emitir` NO es `capturado`: son cosas distintas. */
  async keplerExportStatus(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.inventory_kepler_exports')
        .where({ count_id: countId })
        .whereNot('estado', 'descartado')
        .first();
      if (!row) {
        return {
          estado: 'sin_emitir',
          // Declararlo explícitamente: un folio reconciliado sin archivo emitido se ve
          // cerrado de nuestro lado y NO lo está del lado del ERP.
          advertencia: 'El ajuste no salió a Kepler. El ERP sigue con su saldo anterior.',
        };
      }
      return row;
    });
  }

  async keplerAdjustmentExport(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await trx('commercial.inventory_counts as c')
        .leftJoin('commercial.warehouses as w', 'w.id', 'c.warehouse_id')
        .where('c.id', countId)
        .select('c.*', 'w.code as warehouse_code', 'w.kepler_code')
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status !== 'reconciled')
        throw new ConflictException('Solo se exporta un folio reconciliado.');

      // ⛔ `[ICR.M12]` La sucursal de Kepler sale de `warehouses.kepler_code`, **no de parsear
      // el código del almacén**. Lo que había era `/^KEPLER-(\w+)$/` sobre `w.code`, y medido en
      // prod el 2026-11-27 **ninguno de los 28 almacenes empieza con `KEPLER-`**: los códigos
      // son `00`…`08`, `MD-32`, `RUTA-21`… O sea que `kepler_branch` venía **null siempre**, en
      // todos los folios de todas las sucursales. Para Yurécuaro el valor correcto es `04`.
      const branch = count.kepler_code || null;

      const items = await trx('commercial.inventory_count_items as i')
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        .leftJoin('inventory.products as ip', 'ip.sku', 'i.product_sku')
        // [KE.3] mismo resolvedor unico; `i.unit_cost` (congelado) sigue mandando cuando existe.
        .leftJoin('analytics.v_erp_unit_cost as uc', function () {
          this.on('uc.tenant_id', '=', 'i.tenant_id')
            .andOn('uc.product_id', '=', 'i.product_id')
            .andOnVal('uc.warehouse_id', '=', count.warehouse_id);
        })
        .where('i.count_id', countId)
        .whereRaw('COALESCE(i.variance, 0) <> 0')
        .select(
          trx.raw('COALESCE(p.sku, i.product_sku) AS sku'),
          trx.raw('COALESCE(p.nombre, ip.nombre) AS product_name'),
          trx.raw('COALESCE(p.unit_sale, ip.unidad_venta) AS unit_sale'),
          trx.raw('COALESCE(i.unit_cost, uc.costo_unitario, ip.venta_valor_costo_anual / NULLIF(ip.venta_unidad_anual, 0), 0) AS cost_base'),
          'i.expected_qty', 'i.final_qty', 'i.variance',
        );

      let mermaValue = 0, sobranteValue = 0;
      const lines = items.map((it: any) => {
        const variance = Number(it.variance);
        const cost = Number(it.cost_base) || 0;
        const value = +(Math.abs(variance) * cost).toFixed(2);
        if (variance < 0) mermaValue += value; else sobranteValue += value;
        return {
          sku: it.sku,
          product_name: it.product_name,
          unit: it.unit_sale || 'PZA',
          counted_qty: Number(it.final_qty),
          expected_qty: Number(it.expected_qty),
          variance,
          // ⛔ `[ICR.M12]` Los documentos de Kepler se LEEN del catálogo, no se inventan en
          // inglés. `InvIn`/`InvOut` no existen en el ERP: quien recibiera este archivo no
          // tendría qué capturar. Medido en `kepler_ods.kdmm` el 2026-11-27, en las 9
          // sucursales: un faltante es una **salida** (`N-D-30`) y un sobrante una **entrada**
          // (`N-A-30`), que son los dos que mueven existencia (`c8='S'`).
          kepler_doc: variance < 0 ? 'N-D-30' : 'N-A-30',
          kepler_doc_name:
            variance < 0 ? 'Salida inventario físico' : 'Entrada Inventario físico',
          adjust_qty: Math.abs(variance),
          unit_cost: cost,
          line_value: value,
        };
      });

      return {
        folio: count.folio,
        kepler_branch: branch,
        warehouse_code: count.warehouse_code,
        date: count.reconciled_at,
        /**
         * `[ICR.M12]` Los tres documentos reales del inventario físico en Kepler, tal como los
         * nombra `kepler_ods.kdmm` (medido el 2026-11-27, iguales en las 9 sucursales).
         *
         * ⚠️ `N-A-45` tiene `c8 = 'N'`: **no mueve existencia**, es la captura. Los que la
         * mueven son `N-A-30` y `N-D-30` (`c8 = 'S'`). Se listan los tres porque quien captura
         * del otro lado necesita saber cuál es cuál; esta exportación **no escribe en el ERP**.
         */
        kepler_docs: [
          { doc: 'N-A-45', nombre: 'Captura inventario físico', afecta_inventario: false },
          { doc: 'N-A-30', nombre: 'Entrada Inventario físico', afecta_inventario: true },
          { doc: 'N-D-30', nombre: 'Salida inventario físico', afecta_inventario: true },
        ],
        lines,
        summary: {
          total_lines: lines.length,
          merma_value: +mermaValue.toFixed(2),
          sobrante_value: +sobranteValue.toFixed(2),
          net_value: +(sobranteValue - mermaValue).toFixed(2),
        },
        note: 'Para importar/capturar en Kepler. No se escribe en el ERP automáticamente.',
      };
    });
  }

  private async getCountOrThrow(trx: any, countId: string) {
    const count = await trx('commercial.inventory_counts')
      .where({ id: countId })
      .first();
    if (!count) throw new NotFoundException('Folio no encontrado');
    return count;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Integridad: bitácora de interrupciones del contador. (CONTAR escribe,
  // SUPERVISAR lee). Auditoría — no bloquea el conteo.
  // ─────────────────────────────────────────────────────────────────────────
  async recordInterruption(
    countId: string,
    dto: { left_at: string; returned_at?: string; duration_seconds?: number; source?: string },
  ) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    if (!dto?.left_at) throw new BadRequestException('left_at requerido');
    const result = await this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      // Solo tiene sentido auditar mientras el folio está vivo.
      if (!['open', 'counting', 'review'].includes(count.status)) {
        return { recorded: false, reason: 'folio no activo' };
      }
      const ctx = this.tenantCtx.get();
      const [row] = await trx('commercial.inventory_count_interruptions')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          count_id: countId,
          user_id: ctx?.userId ?? null,
          username: ctx?.username ?? null,
          left_at: new Date(dto.left_at),
          returned_at: dto.returned_at ? new Date(dto.returned_at) : null,
          duration_seconds:
            dto.duration_seconds != null ? Math.max(0, Math.round(dto.duration_seconds)) : null,
          source: dto.source === 'appstate' ? 'appstate' : 'visibility',
        })
        .returning(['id']);
      return { recorded: true, id: row.id };
    });
    if (result?.recorded) {
      this.emitMonitor(countId, {
        type: 'interruption',
        username: this.tenantCtx.get()?.username ?? null,
        seconds: dto.duration_seconds ?? null,
      });
    }
    return result;
  }

  /** Timeline de interrupciones del folio + resumen por contador. (SUPERVISAR) */
  async listInterruptions(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      await this.getCountOrThrow(trx, countId);
      const events = await trx('commercial.inventory_count_interruptions')
        .where({ count_id: countId })
        .orderBy('left_at', 'desc')
        .select('id', 'user_id', 'username', 'left_at', 'returned_at', 'duration_seconds', 'source');

      const byUser = new Map<
        string,
        { user_id: string; username: string | null; count: number; total_seconds: number; max_seconds: number }
      >();
      for (const e of events) {
        const key = e.user_id || 'unknown';
        const agg = byUser.get(key) || {
          user_id: e.user_id,
          username: e.username,
          count: 0,
          total_seconds: 0,
          max_seconds: 0,
        };
        agg.count += 1;
        const s = e.duration_seconds || 0;
        agg.total_seconds += s;
        agg.max_seconds = Math.max(agg.max_seconds, s);
        byUser.set(key, agg);
      }
      return { events, by_user: Array.from(byUser.values()) };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sesiones de jornada por contador (Fase I.6) + avance de fase estricta.
  // ─────────────────────────────────────────────────────────────────────────

  /** El contador abre su jornada de conteo (modo foco en el front). (CONTAR) */
  async startSession(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    const result = await this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const uid = this.userId();
      if (['reconciled', 'cancelled'].includes(count.status))
        throw new ConflictException('El folio está cerrado.');

      const counters = await trx('commercial.inventory_count_assignments')
        .where({ count_id: countId, assignment_role: 'counter' })
        .select('user_id');
      if (counters.length && !counters.some((a) => a.user_id === uid))
        throw new ForbiddenException('No estás asignado como contador de este folio.');

      const pass = Number(count.current_pass) || 1;
      const ctx = this.tenantCtx.get();
      await trx('commercial.inventory_count_sessions')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          count_id: countId,
          user_id: uid,
          username: ctx?.username ?? null,
          pass,
          started_at: trx.fn.now(),
          status: 'active',
        })
        .onConflict(['tenant_id', 'count_id', 'user_id', 'pass'])
        .merge({ finished_at: null, status: 'active' });

      return { ok: true, current_pass: pass, status: 'counting' };
    });
    this.emitMonitor(countId, {
      type: 'session',
      action: 'start',
      username: this.tenantCtx.get()?.username ?? null,
      pass: result.current_pass,
    });
    return result;
  }

  /** El contador cierra su jornada (botón Terminar). (CONTAR) */
  async finishSession(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    const result = await this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const uid = this.userId();
      const pass = Number(count.current_pass) || 1;
      const n = await trx('commercial.inventory_count_sessions')
        .where({ count_id: countId, user_id: uid, pass })
        .update({ finished_at: trx.fn.now(), status: 'finished' });
      return { ok: n > 0, pass };
    });
    this.emitMonitor(countId, {
      type: 'session',
      action: 'finish',
      username: this.tenantCtx.get()?.username ?? null,
      pass: result.pass,
    });
    return result;
  }

  /**
   * Avanza la fase del folio. Solo si la pasada actual está 100% cubierta.
   *   fase 1 (con doble conteo) → fase 2
   *   última pasada            → review (el supervisor calcula discrepancias)
   * (SUPERVISAR)
   */
  async advancePass(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    const result = await this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      if (count.status !== 'counting')
        throw new ConflictException(`El folio está en '${count.status}'; no admite avanzar de fase.`);
      const pass = Number(count.current_pass) || 1;
      const col = pass >= 2 ? 'count_2' : 'count_1';
      const [{ n }] = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .whereNull(col)
        .count('* as n');
      const uncounted = Number(n) || 0;
      if (uncounted > 0)
        throw new ConflictException(`Fase ${pass} incompleta: faltan ${uncounted} SKU(s) por contar.`);

      if (pass === 1 && count.blind_double_count) {
        await trx('commercial.inventory_counts').where({ id: countId }).update({ current_pass: 2 });
        return { current_pass: 2, status: 'counting', next: 'count_pass_2' };
      }
      await trx('commercial.inventory_counts').where({ id: countId }).update({ status: 'review' });
      return { current_pass: pass, status: 'review', next: 'review' };
    });
    this.emitMonitor(countId, {
      type: 'phase',
      current_pass: result.current_pass,
      status: result.status,
      next: result.next,
    });
    return result;
  }

  /** Control del supervisor: jornadas de su personal + productividad + interrupciones. (SUPERVISAR) */
  async listSessions(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      await this.getCountOrThrow(trx, countId);
      const sessions = await trx('commercial.inventory_count_sessions')
        .where({ count_id: countId })
        .orderBy([{ column: 'pass' }, { column: 'started_at' }]);

      const out = [] as any[];
      for (const s of sessions) {
        // `[ICR.M3]` Igual que en `getProgress`: la jornada de una persona se mide por **sus
        // capturas**, no por `counted_by_N` —que guarda a quien capturó último—. `DISTINCT ON`
        // se queda con la captura VIVA de cada `(renglón, rack)` de esa persona: si se corrigió
        // a sí misma, cuenta la corrección, no las dos.
        const slotDeLaJornada = s.pass >= 2 ? 'count_2' : 'count_1';
        const { rows: aggRows } = await trx.raw(
          `SELECT COUNT(DISTINCT item_id)::int AS items_counted,
                  COALESCE(SUM(q), 0)::numeric AS units_counted
             FROM (
               SELECT DISTINCT ON (item_id, aisle_id) item_id, quantity_native AS q
                 FROM commercial.inventory_count_scan_log
                WHERE count_id = ? AND slot = ? AND applied_by = ?
                  AND quantity_native IS NOT NULL
                ORDER BY item_id, aisle_id, applied_at DESC, scan_uuid DESC
             ) t`,
          [countId, slotDeLaJornada, s.user_id],
        );
        const agg = aggRows[0];
        const [intr] = await trx('commercial.inventory_count_interruptions')
          .where({ count_id: countId, user_id: s.user_id })
          .select(
            trx.raw('COUNT(*)::int AS interruptions'),
            trx.raw('COALESCE(SUM(duration_seconds),0)::int AS interrupt_seconds'),
          );
        out.push({
          ...s,
          items_counted: Number(agg.items_counted),
          units_counted: Number(agg.units_counted),
          interruptions: Number(intr.interruptions),
          interrupt_seconds: Number(intr.interrupt_seconds),
        });
      }
      return out;
    });
  }
}
