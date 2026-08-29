import { Injectable, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, applySmartSearch, ScopeService } from '@megadulces/platform-core';
import { LlmExtractorService, OcrReadingsService, RemisionFields, RemisionLine } from '@megadulces/platform-core';

/**
 * Fase CC (extensión) — Comprobantes de ORDEN DE ENTRADA. Adjunta la REMISIÓN/
 * FACTURA del proveedor (imagen/PDF) a una orden de entrada de Kepler (documento
 * `X-A-40` "Orden de entrada", enriquecida con su vale `X-A-37`), le corre OCR de
 * remisión y guarda la evidencia en `finance.goods_receipt_proofs` ligada por
 * `(sucursal, folio)`. NO escribe a Kepler: las entradas se leen del espejo
 * `analytics.erp_goods_receipts`. Flujo `recibido → validado | rechazado`.
 */

// Set de evidencia de una recepción: lo normal son 3–4 fotos (remisión/factura del
// proveedor + vale de recepción firmado + Aplica Orden Entrada de Kepler + ticket de compra).
// `evidencia_1` se mantiene por compatibilidad con registros viejos.
export const RECEIPT_FILE_ROLES = ['remision', 'factura', 'vale', 'orden_entrada', 'orden_recepcion', 'ticket', 'evidencia', 'evidencia_1'] as const;
export type ReceiptFileRole = (typeof RECEIPT_FILE_ROLES)[number];

/**
 * RE.13.2 — catálogo de motivos de rechazo. Con texto libre no se puede contestar "¿por qué
 * se devuelve el 30% de lo que sube la sucursal 01?", que es justo el dato que le dice a la
 * sucursal qué corregir. El front tiene su propia copia para las etiquetas.
 */
export const MOTIVOS_RECHAZO = ['ilegible', 'no_corresponde', 'total_no_cuadra', 'falta_hoja', 'duplicada', 'otro'] as const;
export type MotivoRechazo = (typeof MOTIVOS_RECHAZO)[number];
// RE.13.0 — estos dos eran constantes de módulo y son decisiones de NEGOCIO: la fecha de
// arranque del proceso (mover el rezago fuera del SLA) y cuándo se considera que la factura
// cuadra. Viven en `finance.receipt_settings` por tenant; acá quedan sólo como default para
// que el service funcione antes de la migración o si falta la fila.
const TOLERANCIA_DEFAULT = 1.0; // pesos: cuadra si el total (o subtotal) de la remisión ≈ el valor Kepler
// El proceso de recepción arranca en AGOSTO 2026: las entradas de Kepler anteriores son
// histórico que nunca tendrá comprobante y no debe listarse/contarse ni enlazarse.
const RECEPTION_START_DEFAULT = '2026-08-01';
const SLA_CAPTURE_DEFAULT = 3; // días sin evidencia antes de marcar atrasada (semáforo del capturista)
const SLA_REVIEW_DEFAULT = 3;  // días esperando decisión antes de marcar atrasada (semáforo del revisor)

/** Parámetros del proceso de recepción, resueltos por tenant (`finance.receipt_settings`). */
export interface ReceiptSettings {
  reception_start: string;
  match_tolerance: number;
  sla_capture_days: number;
  sla_review_days: number;
  bulk_max_files: number;
}

const SETTINGS_DEFAULT: ReceiptSettings = {
  reception_start: RECEPTION_START_DEFAULT,
  match_tolerance: TOLERANCIA_DEFAULT,
  sla_capture_days: SLA_CAPTURE_DEFAULT,
  sla_review_days: SLA_REVIEW_DEFAULT,
  bulk_max_files: 50,
};
const SETTINGS_TTL_MS = 60_000;

/**
 * Normaliza una columna `date` de Postgres a `'AAAA-MM-DD'`.
 *
 * `node-pg` devuelve `date` como **objeto `Date`** (no como string), así que el
 * `String(row.reception_start).slice(0, 10)` que vivía acá producía `'Sat Aug 01'` — y ese
 * texto volvía al SQL como parámetro de fecha: `22007 la sintaxis de entrada no es válida para
 * tipo date`, con toda la lista de entradas devolviendo 500. Pasó desapercibido porque mientras
 * `finance.receipt_settings` no tuvo fila, `settings()` caía al default (que ya era un string).
 *
 * Se arma con los componentes **locales**, no con `toISOString()`: pg parsea el `date` como
 * medianoche local, y en un huso positivo el ISO devolvería el día anterior.
 */
function soloFecha(v: unknown, fallback: string): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

/**
 * Cómo se elige "la última evidencia" de una entrada. **No es cosmético**: de esto sale si la
 * entrada está en la cola del revisor, si el capturista la ve como devuelta y qué motivo se le
 * muestra.
 *
 * El desempate existe porque `created_at` **empata de verdad**: `now()` en Postgres es el
 * instante de INICIO DE LA TRANSACCIÓN, y en esta app **todo el request corre en una sola
 * transacción**, así que dos evidencias insertadas en el mismo request comparten `created_at`
 * al microsegundo y `ORDER BY created_at DESC` queda indefinido — verificado: devolvía
 * 'rechazado' para una entrada que acababa de recibir una recaptura.
 *
 * En empate gana la **pendiente**: una evidencia esperando decisión tiene que quedar en la
 * cola. El `id` cierra el orden para que la respuesta sea siempre la misma.
 */
const PROOF_ORDER = `created_at DESC, (status = 'recibido') DESC, id DESC`;

/**
 * `[RE.14.3]` — **La misma recepción está capturada dos veces**: en el Kepler de la sucursal y
 * otra vez en el servidor de oficinas (9.95, sucursal `'00'`). La canónica es la de sucursal —
 * es la que trae los productos; la de oficinas es la captura contable (un renglón de concepto
 * con el total).
 *
 * Estos son los estados de par que **valen como espejo**: `'propuesto'` (el detector duda) y
 * `'rechazado'` (una persona dijo que no lo es) NO cuentan, porque tratar un par dudoso como
 * espejo esconde una compra que sí existe. Ver `analytics.erp_goods_receipt_dedup`.
 */
const PAR_VIGENTE = ['auto', 'confirmado'];
/** Columnas del par + de qué servidor viene la fila. Se comparten entre la lista y el enlace. */
const GEMELA_SELECT = [
  'gem.cedis_folio AS gemela_folio',
  'gem.cedis_date AS gemela_date',
  'gem.cedis_monto::numeric AS gemela_monto',
  'gem.delta_monto::numeric AS gemela_delta',
  'gem.match_rule AS gemela_regla',
  'gem.match_score::numeric AS gemela_score',
];
/** Sin la tabla de pares al día (prod puede correr el código antes de la migración) → NULLs. */
const GEMELA_NULLS = [
  'NULL::text AS gemela_folio', 'NULL::date AS gemela_date', 'NULL::numeric AS gemela_monto',
  'NULL::numeric AS gemela_delta', 'NULL::text AS gemela_regla', 'NULL::numeric AS gemela_score',
];
const ORIGEN_SELECT = `(CASE WHEN c.sucursal = '00' THEN 'oficinas' ELSE 'sucursal' END) AS origen`;

export interface ReceiptFile {
  role: string; url: string; public_id?: string; kind?: string; name?: string;
  // Por-archivo (RE.5.2): hash del contenido (anti-hoja-duplicada) + OCR propio (cada hoja se lee).
  sha256?: string;
  ocr_folio?: string | null;
  ocr_total?: number | null;
  ocr_fecha?: string | null;
  ocr_rfc?: string | null;
}

/** Coincidencia de duplicado (misma hoja por hash, o folio ya subido). */
export interface DuplicateHit { reason: 'file' | 'folio'; sucursal: string; folio: string; proveedor?: string | null; }

export interface ListReceiptsQuery {
  /** `pendiente` = sin evidencia · `por_validar` = evidencia esperando decisión (la cola del revisor). */
  estado?: 'pendiente' | 'con_comprobante' | 'por_validar' | 'validado' | 'rechazado' | string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  /** RE.13.0 — alcance: códigos de sucursal ya intersectados con lo que el usuario puede ver. */
  warehouse_codes?: string[] | null;
  /** Antigüedad mínima en días (worklist del capturista: "mostrame lo atrasado"). */
  dias_min?: number;
  /** `rezago` = lo anterior a `reception_start` · `al_dia` (default) = de la fecha de arranque en adelante. */
  carril?: 'al_dia' | 'rezago' | 'todo';
  /**
   * `antiguedad` (default) = lo más viejo primero, que es el orden de trabajo ·
   * `reciente` = el orden anterior · `monto` · `riesgo` = descuadre y monto primero (cola del revisor).
   *
   * RE.20.2 — `fecha` y `proveedor` son las que se alternan desde el encabezado de la tabla.
   * `antiguedad`/`reciente` son las dos direcciones de `fecha` con nombre propio: quedan porque
   * las pide el control segmentado y viven en estado guardado.
   */
  orden?: 'antiguedad' | 'reciente' | 'monto' | 'riesgo' | 'fecha' | 'proveedor';
  /**
   * Dirección del orden. Sin esto un encabezado clickeable **miente**: dibuja la flecha de
   * "descendente" y no puede invertirse. Si no viene, cada clave usa la suya
   * (fecha↑ · proveedor↑ · monto↓ · riesgo↓).
   */
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface AttachReceiptDto {
  sucursal?: string;
  folio?: string;
  files?: ReceiptFile[];
  ocr?: Partial<RemisionFields> & { ocr_status?: string };
  comentarios?: string;
}

/** RE.11.2 — un renglón conciliado: remisión del proveedor ↔ línea Kepler ↔ SKU resuelto. */
export interface ReconciledLine {
  idx: number;                       // orden del renglón de la remisión
  remision: RemisionLine;            // lo que dijo el proveedor
  kepler: {                          // la línea Kepler con la que empató (null si sin_match)
    linea: string; sku: string | null; nombre: string | null; unidad: string | null;
    cantidad: number; costo_unitario: number; importe: number;
  } | null;
  resolved_sku: string | null;       // SKU interno resuelto
  resolved_nombre: string | null;
  method: 'alias' | 'barcode' | 'descripcion' | 'sin_match';
  score: number;                     // 0..1 confianza del match
  box_factor: number;                // piezas por unidad usadas para normalizar
  qty_remision_pz: number | null;    // cantidad de la remisión normalizada a piezas
  qty_kepler: number | null;
  qty_match: boolean | null;
  price_match: boolean | null;
  status: 'cuadra' | 'difiere_cantidad' | 'difiere_precio' | 'revisar' | 'sin_match';
  alias_hit: boolean;                // ya venía aprendido (no requiere confirmar)
}

const QTY_TOL = 0.02;   // 2% de tolerancia en cantidad (normalizada a piezas)
const PRICE_TOL = 0.05; // 5% de tolerancia en precio unitario

@Injectable()
export class GoodsReceiptProofsService {
  private readonly logger = new Logger(GoodsReceiptProofsService.name);

  /**
   * La lectura que el servidor hizo de la hoja FISCAL del paquete: primero factura o
   * remisión, y dentro de ésas la que traiga importe. La preferencia es de dominio y por
   * eso vive acá; el almacén de lecturas es compartido (`OcrReadingsService`).
   */
  private pickVerifiedReading(files: ReceiptFile[]) {
    const scope = this.tenantCtx.requireTenantId();
    const esFiscal = (f: ReceiptFile) => f.role === 'factura' || f.role === 'remision';
    const orden = [...files.filter(esFiscal), ...files.filter((f) => !esFiscal(f))];
    let suplente: { fields: RemisionFields; status: string } | null = null;
    for (const f of orden) {
      const hit = this.readings.recall<RemisionFields>(scope, f.sha256);
      if (!hit) continue;
      if (hit.fields.total != null || hit.fields.subtotal != null) return hit;
      if (!suplente) suplente = hit;
    }
    return suplente;
  }

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
    private readonly readings: OcrReadingsService,
    private readonly scope: ScopeService,
  ) {}

  // ─────────────────── RE.13.0 — parámetros del proceso ───────────────────

  /** Cache por tenant con TTL corto: esto se lee en cada request y cambia una vez al mes. */
  private settingsCache = new Map<string, { at: number; v: ReceiptSettings }>();

  /**
   * Parámetros del tenant. Si la tabla no existe todavía (entorno sin la migración) o no hay
   * fila, devuelve los defaults — nunca revienta. El `hasTable` evita el `try/catch` que
   * envenenaría la transacción del request (gotcha 25P02).
   */
  private async settings(trx: any): Promise<ReceiptSettings> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hit = this.settingsCache.get(tenantId);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.v;
    let v = SETTINGS_DEFAULT;
    if (await trx.schema.withSchema('finance').hasTable('receipt_settings')) {
      const row = await trx('finance.receipt_settings').where({ tenant_id: tenantId }).first();
      if (row) {
        v = {
          reception_start: soloFecha(row.reception_start, RECEPTION_START_DEFAULT),
          match_tolerance: Number(row.match_tolerance),
          sla_capture_days: Number(row.sla_capture_days),
          sla_review_days: Number(row.sla_review_days),
          bulk_max_files: Number(row.bulk_max_files),
        };
      }
    }
    this.settingsCache.set(tenantId, { at: Date.now(), v });
    return v;
  }

  /** Para el front: los parámetros vigentes (semáforo, tolerancia, tope de lote). */
  async getSettings(): Promise<ReceiptSettings> {
    return this.tk.run(async (trx) => this.settings(trx));
  }

  /**
   * Guarda los parámetros del proceso. Existía el GET desde RE.13.0 pero **no el PUT**: la
   * fecha de arranque y el SLA sólo se podían mover con un UPDATE a mano en la DB, contra la
   * regla de que el dato operativo se administra desde la interfaz. Esto es la pestaña
   * "Ajustes" del Centro de control.
   *
   * Los rangos se validan acá porque cada uno rompe algo distinto si se va de rango:
   * `reception_start` hacia atrás mete el rezago histórico (que nunca tendrá comprobante) al
   * % de cobertura y el número deja de servir para exigirle a nadie; una tolerancia grande
   * hace que "cuadra" deje de significar algo.
   */
  async saveSettings(p: Partial<ReceiptSettings>, actor?: string): Promise<ReceiptSettings> {
    const tenantId = this.tenantCtx.requireTenantId();
    const cur = await this.getSettings();
    const next: ReceiptSettings = {
      reception_start: (p.reception_start ?? cur.reception_start).slice(0, 10),
      match_tolerance: p.match_tolerance != null ? Number(p.match_tolerance) : cur.match_tolerance,
      sla_capture_days: p.sla_capture_days != null ? Number(p.sla_capture_days) : cur.sla_capture_days,
      sla_review_days: p.sla_review_days != null ? Number(p.sla_review_days) : cur.sla_review_days,
      bulk_max_files: p.bulk_max_files != null ? Number(p.bulk_max_files) : cur.bulk_max_files,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.reception_start)) {
      throw new BadRequestException('reception_start debe ser una fecha AAAA-MM-DD');
    }
    const rango = (v: number, min: number, max: number, campo: string) => {
      if (!Number.isFinite(v) || v < min || v > max) {
        throw new BadRequestException(`${campo} fuera de rango (${min}–${max})`);
      }
    };
    rango(next.match_tolerance, 0, 500, 'match_tolerance');
    rango(next.sla_capture_days, 1, 60, 'sla_capture_days');
    rango(next.sla_review_days, 1, 60, 'sla_review_days');
    rango(next.bulk_max_files, 1, 200, 'bulk_max_files');

    await this.tk.run(async (trx) => {
      await trx('finance.receipt_settings')
        .insert({ tenant_id: tenantId, ...next, updated_at: trx.fn.now(), updated_by: actor || null })
        .onConflict('tenant_id')
        .merge();
    });
    // El cache es por proceso y tiene TTL de 1 min; se invalida acá para que el cambio se vea
    // en el mismo click (en varias instancias, el TTL cierra la diferencia).
    this.settingsCache.delete(tenantId);
    this.logger.log(`receipt_settings actualizados por ${actor || 'sistema'}: arranque=${next.reception_start} tol=${next.match_tolerance} sla=${next.sla_capture_days}/${next.sla_review_days} lote=${next.bulk_max_files}`);
    return next;
  }

  /**
   * ¿Existe la columna/tabla? Cacheado por proceso. Sirve para que el código funcione en un
   * entorno donde la migración de la fase todavía no corrió, **sin** un `try/catch` que
   * envenenaría la transacción del request (25P02).
   */
  private objCache = new Map<string, boolean>();
  private async existeCol(trx: any, schema: string, table: string, col: string): Promise<boolean> {
    const k = `${schema}.${table}.${col}`;
    const hit = this.objCache.get(k);
    if (hit !== undefined) return hit;
    const v = await trx.schema.withSchema(schema).hasColumn(table, col);
    this.objCache.set(k, v);
    return v;
  }
  /**
   * `[RE.14.3]` — ¿está la tabla de pares con las columnas de RE.14? Si no (prod desplegado
   * antes de la migración), las vistas siguen funcionando sin la columna de gemela en vez de
   * tronar con «column gem.cedis_monto does not exist».
   */
  private async hayPares(trx: any): Promise<boolean> {
    return this.existeCol(trx, 'analytics', 'erp_goods_receipt_dedup', 'cedis_monto');
  }

  /**
   * LEFT JOIN al par de la misma recepción capturada en oficinas. Alias `gem`, colgado de la
   * CANÓNICA (`c` = la de sucursal). No abre filas: el índice único parcial
   * `ux_grd_canonica_viva` garantiza a lo más un par vigente por canónica.
   */
  private conGemela(qb: any, trx: any, tenantId: string) {
    return qb.leftJoin('analytics.erp_goods_receipt_dedup as gem', (j: any) => {
      j.on('gem.dup_of_sucursal', 'c.sucursal')
        .andOn('gem.dup_of_folio', 'c.folio')
        .andOn('gem.tenant_id', trx.raw('?', [tenantId]))
        .andOnIn('gem.status', PAR_VIGENTE);
    });
  }

  private async existeTabla(trx: any, schema: string, table: string): Promise<boolean> {
    const k = `${schema}.${table}`;
    const hit = this.objCache.get(k);
    if (hit !== undefined) return hit;
    const v = await trx.schema.withSchema(schema).hasTable(table);
    this.objCache.set(k, v);
    return v;
  }

  /**
   * RE.13.2 — deja la decisión en el historial append-only. Best-effort a propósito: si la
   * tabla no existe (entorno sin la migración), la decisión igual se aplica. Perder una línea
   * de historial es malo; no poder validar una factura es peor.
   */
  private async registrarHistorial(
    trx: any,
    p: { proof_id: string; sucursal: string; folio: string; status_from?: string | null; status_to: string; motivo_codigo?: string | null; motivo?: string | null; actor?: string },
  ): Promise<void> {
    if (!(await this.existeTabla(trx, 'finance', 'goods_receipt_proof_history'))) return;
    await trx('finance.goods_receipt_proof_history').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      proof_id: p.proof_id, sucursal: p.sucursal, folio: p.folio,
      status_from: p.status_from ?? null, status_to: p.status_to,
      motivo_codigo: p.motivo_codigo ?? null, motivo: p.motivo ?? null,
      changed_by: p.actor ?? null,
    });
  }

  /**
   * Sucursales que el usuario puede LEER, ya intersectadas con lo que pidió por query param.
   * `null` = sin filtro (alcance `all` y no pidió nada) · `[]` = no ve ninguna (fail-closed).
   *
   * Se resuelve FUERA de `tk.run`: `ScopeService` usa su propia conexión y no tiene sentido
   * tenerla dentro de la transacción del request.
   */
  private async sucursalesVisibles(pedido?: string[] | null): Promise<string[] | null> {
    const s = await this.scope.current();
    return this.scope.intersect(s, 'warehouse', pedido ?? null);
  }

  /**
   * Lista las órdenes de entrada de Kepler (espejo `analytics.erp_goods_receipts`)
   * con el estado de su remisión adjunta (LEFT JOIN a `finance.goods_receipt_proofs`).
   *
   * RE.13.0 — tres cosas que antes no hacía y que sostienen las tres vistas:
   *   1. **Alcance**: filtra por las sucursales que el usuario puede ver (`ScopeService`).
   *      El de Yurécuaro (16 entradas) ya no navega entre las 815 de CEDIS.
   *   2. **Paginación real** con `total`: antes cortaba en 300 filas en silencio mientras
   *      el KPI contaba 1,096 — el usuario no tenía forma de saber qué le faltaba.
   *   3. **Antigüedad y orden de trabajo**: `dias` + `atrasada` por fila, y el orden por
   *      defecto pasa a ser lo MÁS VIEJO primero (una worklist), no lo más reciente.
   */
  async listReceipts(q: ListReceiptsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const alcance = await this.sucursalesVisibles(q.warehouse_codes);
    const pageSize = Math.min(1000, Math.max(1, Number(q.pageSize) || Number(q.limit) || 300));
    const page = Math.max(1, Number(q.page) || 1);

    return this.tk.run(async (trx) => {
      const cfg = await this.settings(trx);
      const conMotivoCol = await this.existeCol(trx, 'finance', 'goods_receipt_proofs', 'motivo_codigo');
      const hayPares = await this.hayPares(trx);
      // TODOS los `array_agg` de este subquery comparten EL MISMO orden (`PROOF_ORDER`): si
      // cada campo se ordenara por su cuenta, la fila podía decir "Rechazado" y traer el
      // `monto_match` de otro depósito. Y el desempate no es cosmético — ver `PROOF_ORDER`.
      const dep = trx('finance.goods_receipt_proofs')
        .select('sucursal', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY ${PROOF_ORDER}))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY ${PROOF_ORDER}))[1] AS last_status`))
        .select(trx.raw(`(array_agg(created_at ORDER BY ${PROOF_ORDER}))[1] AS last_at`))
        .select(trx.raw(`(array_agg(discrepancy_amount ORDER BY ${PROOF_ORDER}))[1] AS last_disc`))
        // Quién la subió (para la segregación de funciones: el revisor no valida lo propio) y
        // por qué se devolvió (la sucursal necesita ver el motivo en su worklist).
        .select(trx.raw(`(array_agg(created_by ORDER BY ${PROOF_ORDER}))[1] AS last_by`))
        .select(trx.raw(`(array_agg(motivo_rechazo ORDER BY ${PROOF_ORDER}))[1] AS last_motivo`))
        .select(trx.raw(conMotivoCol
          ? `(array_agg(motivo_codigo ORDER BY ${PROOF_ORDER}))[1] AS last_motivo_codigo`
          : `NULL::text AS last_motivo_codigo`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .groupBy('sucursal', 'folio')
        .as('d');

      /** Todos los filtros, sin select ni orden: lo comparten las filas, el total y los KPIs. */
      const base = () => {
        const b = trx('analytics.erp_goods_receipts as c')
          .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
          .where('c.tenant_id', tenantId)
          .whereRaw('c.dup_of_folio IS NULL'); // RE.12 — oculta la copia CEDIS ('00'); evidencia una sola vez en la canónica
        // RE.14.3 — el par entra en el `base()` y no sólo en el select porque **también se busca
        // por él**: el usuario tiene en la mano el folio de oficinas tan seguido como el suyo.
        if (hayPares) this.conGemela(b, trx, tenantId);
        // Alcance: `null` = sin filtro (alcance `all`) · `[]` = no ve ninguna (fail-closed).
        if (alcance) { if (alcance.length) b.whereIn('c.sucursal', alcance); else b.whereRaw('false'); }
        // Carril: el rezago anterior al arranque se trabaja aparte para que el semáforo del
        // día siga significando algo (ver §7.1 del plan de la fase).
        if (q.carril === 'rezago') b.where('c.receipt_date', '<', cfg.reception_start);
        else if (q.carril !== 'todo') b.where('c.receipt_date', '>=', cfg.reception_start);
        if (q.from) b.where('c.receipt_date', '>=', q.from);
        if (q.to) b.where('c.receipt_date', '<=', q.to);
        if (q.estado === 'pendiente') b.whereRaw('d.n IS NULL');
        else if (q.estado === 'con_comprobante') b.whereRaw('d.n > 0');
        else if (q.estado === 'por_validar') b.whereRaw(`d.last_status = 'recibido'`);
        else if (q.estado === 'validado') b.whereRaw(`d.last_status = 'validado'`);
        else if (q.estado === 'rechazado') b.whereRaw(`d.last_status = 'rechazado'`);
        // Antigüedad acotada a hoy: una entrada con fecha futura no tiene días negativos.
        if (Number(q.dias_min) > 0) {
          b.whereRaw('(current_date - LEAST(c.receipt_date, current_date)) >= ?', [Number(q.dias_min)]);
        }
        // Prioridad de identificación: los ÚLTIMOS 4 DÍGITOS del folio de la orden de entrada.
        // Un término de 1–4 dígitos matchea el sufijo del folio (exacto); lo demás va al buscador
        // difuso (proveedor/RFC/OC).
        const term = (q.search || '').trim();
        if (/^\d{1,4}$/.test(term)) {
          // Los últimos 4 dígitos matchean el folio de la sucursal **o el de oficinas**: los dos
          // son "el folio de esa orden" para quien pregunta. Paréntesis obligatorios — sin ellos
          // el OR se lleva por delante el resto de los filtros del WHERE.
          const suf = term.padStart(4, '0');
          b.whereRaw(
            hayPares
              ? `(right(regexp_replace(c.folio, '\\D', '', 'g'), 4) = ? OR right(regexp_replace(gem.cedis_folio, '\\D', '', 'g'), 4) = ?)`
              : `right(regexp_replace(c.folio, '\\D', '', 'g'), 4) = ?`,
            hayPares ? [suf, suf] : [suf],
          );
        } else {
          applySmartSearch(b, q.search, {
            columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio', 'c.oc_folio',
              ...(hayPares ? ['gem.cedis_folio'] : [])],
            numeric: ['c.monto'],
          });
        }
        return b;
      };

      const b = base()
        .select(
          'c.sucursal', 'c.folio', 'c.receipt_date', 'c.proveedor_code', 'c.proveedor_nombre',
          'c.proveedor_rfc', 'c.oc_folio', 'c.concepto', 'c.source_branch', trx.raw('c.monto::numeric AS monto'),
          trx.raw('COALESCE(d.n, 0)::int AS deposits'),
          trx.raw('d.last_id AS deposit_id'),
          trx.raw('d.last_status AS deposit_status'),
          trx.raw('COALESCE(d.any_match, false) AS monto_match'),
          trx.raw('d.last_disc::numeric AS discrepancy_amount'),
          trx.raw('d.last_by AS deposit_by'),
          trx.raw('d.last_motivo AS motivo_rechazo'),
          trx.raw('d.last_motivo_codigo AS motivo_codigo'),
          trx.raw('(c.receipt_date > current_date) AS fecha_futura'),
          // Días de antigüedad de la recepción (acotados a hoy) y días que la evidencia
          // lleva esperando decisión: son los dos relojes del proceso.
          trx.raw('(current_date - LEAST(c.receipt_date, current_date))::int AS dias'),
          trx.raw(`(current_date - (d.last_at AT TIME ZONE 'America/Mexico_City')::date)::int AS dias_espera`),
          // RE.14.3 — de qué servidor salió la fila y, si la recepción está capturada dos veces,
          // el folio y el importe de la otra copia. Sin esto el usuario ve un folio que no
          // reconoce y no tiene con qué saber que es la misma orden.
          trx.raw(ORIGEN_SELECT),
          ...(hayPares ? GEMELA_SELECT : GEMELA_NULLS).map((c) => trx.raw(c)),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      // El orden ES la herramienta de trabajo, así que es explícito por vista:
      //  - antiguedad (default) → worklist del capturista: lo más viejo primero.
      //  - riesgo               → cola del revisor: el descuadre más grande primero.
      //
      // RE.20.2 — `dir` llega del encabezado clickeable. NUNCA entra a la SQL el string del
      // usuario: el ternario resuelve a uno de dos literales, y lo demás cae en el default de
      // la columna. Cada clave tiene el suyo porque el primer clic útil no es el mismo:
      // en dinero se busca lo más grande, en un nombre se busca la A.
      const asc = (porDefecto: 'ASC' | 'DESC') =>
        q.dir === 'asc' ? 'ASC' : q.dir === 'desc' ? 'DESC' : porDefecto;

      // Las de fecha futura van SIEMPRE al final, en las dos direcciones. Hay una de CEDIS con
      // 29/12/2026 mal capturada en el ERP, y `LEAST(receipt_date, current_date)` la aplasta a
      // hoy — o sea, al primer lugar del orden descendente.
      //
      // RE.19 puso el flag de futuro como DESEMPATE, y eso sólo la baja si además hay entradas
      // de HOY con las que empatar. Verificado 2026-08-29: la más reciente de verdad era del 26,
      // así que la de diciembre llevaba tres días encabezando la pantalla de los dos que suben.
      // Como PRIMERA clave no depende de que exista con qué empatar.
      const porFecha = (d: 'ASC' | 'DESC') => {
        b.orderByRaw('(c.receipt_date > current_date) ASC')
          .orderByRaw(`LEAST(c.receipt_date, current_date) ${d}`);
      };

      if (q.orden === 'monto') b.orderByRaw(`c.monto::numeric ${asc('DESC')}`);
      else if (q.orden === 'proveedor') {
        // Sin proveedor al final en las dos direcciones: un dato ausente no compite por el
        // primer lugar. `lower()` y no una colación con nombre: `es-MX` depende de que el
        // servidor tenga ICU y un nombre que no falla en local puede ser un 500 en Railway.
        b.orderByRaw(`lower(NULLIF(TRIM(c.proveedor_nombre), '')) ${asc('ASC')} NULLS LAST`);
        porFecha('ASC');
      } else if (q.orden === 'riesgo') {
        b.orderByRaw(`COALESCE(ABS(d.last_disc), 0) ${asc('DESC')}`)
          .orderByRaw('c.monto::numeric DESC');
        porFecha('ASC');
      } else if (q.orden === 'reciente') porFecha(asc('DESC'));
      else porFecha(asc('ASC')); // `antiguedad` (default) y `fecha`
      b.orderBy('c.folio', 'desc');

      const rows = (await b).map((r: any) => ({
        ...r,
        monto: Number(r.monto),
        gemela_monto: r.gemela_monto == null ? null : Number(r.gemela_monto),
        gemela_delta: r.gemela_delta == null ? null : Number(r.gemela_delta),
        gemela_score: r.gemela_score == null ? null : Number(r.gemela_score),
        discrepancy_amount: r.discrepancy_amount == null ? null : Number(r.discrepancy_amount),
        dias: Number(r.dias),
        dias_espera: r.dias_espera == null ? null : Number(r.dias_espera),
        // Un solo lugar decide "atrasada": el reloj que aplica según tenga o no evidencia.
        atrasada: r.deposits > 0
          ? (r.dias_espera != null && Number(r.dias_espera) > cfg.sla_review_days)
          : Number(r.dias) > cfg.sla_capture_days,
      }));

      const [{ total }] = await base().count({ total: '*' });

      // KPIs = el universo del alcance + carril + rango de fecha (NO se le aplica `estado`
      // ni `search`: son el denominador contra el que se lee la lista filtrada).
      const kpiBase = () => {
        const k = trx('analytics.erp_goods_receipts as c')
          .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
          .where('c.tenant_id', tenantId)
          .whereRaw('c.dup_of_folio IS NULL'); // RE.12 — KPIs sobre canónicas (sin doble conteo CEDIS)
        if (alcance) { if (alcance.length) k.whereIn('c.sucursal', alcance); else k.whereRaw('false'); }
        if (q.carril === 'rezago') k.where('c.receipt_date', '<', cfg.reception_start);
        else if (q.carril !== 'todo') k.where('c.receipt_date', '>=', cfg.reception_start);
        if (q.from) k.where('c.receipt_date', '>=', q.from);
        if (q.to) k.where('c.receipt_date', '<=', q.to);
        return k;
      };
      const [k] = await kpiBase().select(
        trx.raw('COUNT(*)::int AS entradas'),
        trx.raw('COUNT(d.n)::int AS con_comprobante'),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validado')::int AS validados`),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='recibido')::int AS por_validar`),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='rechazado')::int AS rechazados`),
        trx.raw('COALESCE(SUM(c.monto::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente'),
        trx.raw(
          `COUNT(*) FILTER (WHERE d.n IS NULL AND (current_date - LEAST(c.receipt_date, current_date)) > ?)::int AS atrasadas`,
          [cfg.sla_capture_days],
        ),
        // El SLA del REVISOR: evidencia esperando decisión más de lo permitido. Es el número
        // que le dice a la bandeja si va al día, y no se puede derivar del anterior.
        trx.raw(
          `COUNT(*) FILTER (WHERE d.last_status = 'recibido'
             AND (current_date - (d.last_at AT TIME ZONE 'America/Mexico_City')::date) > ?)::int AS por_validar_atrasadas`,
          [cfg.sla_review_days],
        ),
      );

      return {
        kpis: {
          entradas: Number(k.entradas), con_comprobante: Number(k.con_comprobante),
          validados: Number(k.validados), por_validar: Number(k.por_validar),
          rechazados: Number(k.rechazados), monto_pendiente: Number(k.monto_pendiente),
          atrasadas: Number(k.atrasadas), por_validar_atrasadas: Number(k.por_validar_atrasadas),
        },
        // El alcance viaja al front para que la vista sepa si mostrar el selector de
        // sucursal (más de una) o el aviso de "no tenés sucursal asignada" (ninguna).
        alcance: { sucursales: alcance, total_visibles: alcance ? alcance.length : null },
        settings: cfg,
        total: Number(total), page, pageSize,
        frescura: await this.frescuraPorFuente(trx, tenantId),
        rows,
      };
    });
  }

  /**
   * `[RE.13.4]` — **Cobertura por sucursal**: la tabla que contesta *"¿quién no está subiendo?"*.
   *
   * Un `%` de evidencia global no sirve para actuar: con CEDIS pesando el 74% del volumen, la
   * red puede verse "al 70%" mientras una sucursal chica lleva tres semanas sin subir nada.
   * Acá cada sucursal responde por lo suyo, con la **antigüedad p50/p90 de lo pendiente** —
   * el promedio esconde justo la cola larga que hay que perseguir.
   *
   * Respeta el alcance: un revisor local ve su renglón, el central ve la red.
   */
  /**
   * Quién puede subir en cada sucursal, resuelto igual que `ScopeService` pero para TODOS a
   * la vez: rol con `COMPRAS_ENTRADAS_GESTIONAR` × alcance de escritura sobre `warehouse`
   * (override del usuario > default del rol; `own` = su propia sucursal).
   *
   * Por qué está en el Centro de control y no es cosmético: una sucursal con 0% de cobertura
   * y **cero responsables** no es gente que no trabaja, es un permiso que falta — y son dos
   * conversaciones completamente distintas. Sin esta columna, el tablero acusa al inocente.
   *
   * Los de alcance `red` (mode `all`) se cuentan aparte: aparecen en las 7 sucursales y si
   * se mezclan, ninguna se ve nunca huérfana.
   */
  private async responsablesPorSucursal(trx: any): Promise<Map<string, { username: string; nombre: string | null; alcance: 'propio' | 'asignado' }[]> & { red?: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    // `permissions -> 'KEY' IS NOT NULL` y NO el operador `?` de JSONB: knex no lo escapa (42P18).
    const r = await trx.raw(`
      WITH puede AS (
        SELECT lower(role_name) AS rn
          FROM identity.role_permissions
         WHERE tenant_id = ?
           AND permissions -> 'COMPRAS_ENTRADAS_GESTIONAR' IS NOT NULL
           AND (permissions -> 'COMPRAS_ENTRADAS_GESTIONAR')::text = 'true'
      )
      SELECT u.username, u.nombre, u.warehouse_code,
             COALESCE(us.mode_write, us.mode, rs.mode_write, rs.mode, 'none') AS modo,
             COALESCE(us.values, rs.values)                                   AS vals
        FROM identity.users u
        JOIN puede p ON p.rn = lower(u.role_name)
        LEFT JOIN identity.user_scopes us
               ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = 'warehouse'
        LEFT JOIN identity.role_scopes rs
               ON rs.tenant_id = u.tenant_id AND lower(rs.role_name) = lower(u.role_name) AND rs.dimension = 'warehouse'
       WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
       ORDER BY u.username`,
      [tenantId, tenantId]);

    const out = new Map<string, { username: string; nombre: string | null; alcance: 'propio' | 'asignado' }[]>() as any;
    let red = 0;
    const push = (suc: string, x: any, alcance: 'propio' | 'asignado') => {
      const k = String(suc).trim();
      if (!k) return;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ username: x.username, nombre: x.nombre ?? null, alcance });
    };
    for (const x of r.rows || []) {
      if (x.modo === 'all') { red++; continue; }
      if (x.modo === 'own') { if (x.warehouse_code) push(x.warehouse_code, x, 'propio'); continue; }
      if (x.modo === 'listed') { for (const v of x.vals || []) push(v, x, 'asignado'); }
    }
    out.red = red;
    return out;
  }

  async coverage(q: { warehouse_codes?: string[] | null; from?: string; to?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const alcance = await this.sucursalesVisibles(q.warehouse_codes);
    return this.tk.run(async (trx) => {
      const cfg = await this.settings(trx);
      // Los `?` van en el orden en que aparecen en la SQL: sla → tenant → arranque → filtros.
      let filtro = '';
      const filtroParams: any[] = [];
      if (alcance) {
        if (!alcance.length) return { settings: cfg, rows: [], rezago: { entradas: 0, monto: 0 } };
        filtro += ` AND c.sucursal = ANY(?)`; filtroParams.push(alcance);
      }
      if (q.from) { filtro += ` AND c.receipt_date >= ?`; filtroParams.push(q.from); }
      if (q.to) { filtro += ` AND c.receipt_date <= ?`; filtroParams.push(q.to); }

      const r = await trx.raw(`
        WITH d AS (
          SELECT sucursal, folio, count(*) AS n,
                 (array_agg(status ORDER BY created_at DESC))[1] AS last_status
            FROM finance.goods_receipt_proofs GROUP BY sucursal, folio
        )
        SELECT c.sucursal,
               COUNT(*)::int                                                     AS entradas,
               COUNT(d.n)::int                                                   AS con_evidencia,
               COUNT(*) FILTER (WHERE d.last_status = 'validado')::int            AS validadas,
               COUNT(*) FILTER (WHERE d.last_status = 'recibido')::int            AS por_validar,
               COUNT(*) FILTER (WHERE d.last_status = 'rechazado')::int           AS rechazadas,
               COALESCE(SUM(c.monto::numeric), 0)::numeric                        AS monto,
               COALESCE(SUM(c.monto::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente,
               COUNT(*) FILTER (
                 WHERE d.n IS NULL
                   AND (current_date - LEAST(c.receipt_date, current_date)) > ?
               )::int                                                            AS atrasadas,
               -- p50/p90 de la ANTIGÜEDAD de lo que falta subir. El promedio esconde la cola
               -- larga, que es exactamente lo que hay que perseguir.
               COALESCE(percentile_disc(0.5) WITHIN GROUP (
                 ORDER BY (current_date - LEAST(c.receipt_date, current_date))
               ) FILTER (WHERE d.n IS NULL), 0)::int                              AS dias_p50,
               COALESCE(percentile_disc(0.9) WITHIN GROUP (
                 ORDER BY (current_date - LEAST(c.receipt_date, current_date))
               ) FILTER (WHERE d.n IS NULL), 0)::int                              AS dias_p90
          FROM analytics.erp_goods_receipts c
          LEFT JOIN d ON d.sucursal = c.sucursal AND d.folio = c.folio
         WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL
           AND c.receipt_date >= ?${filtro}
         GROUP BY c.sucursal
         ORDER BY c.sucursal`,
        [cfg.sla_capture_days, tenantId, cfg.reception_start, ...filtroParams]);

      // El rezago (anterior al arranque) va aparte y NO se mezcla: si entra al mismo `%` de
      // cobertura, el número deja de servir para exigirle a nadie.
      const resp = await this.responsablesPorSucursal(trx);

      const rez = await trx.raw(`
        SELECT COUNT(*)::int AS entradas, COALESCE(SUM(monto::numeric), 0)::numeric AS monto
          FROM analytics.erp_goods_receipts c
         WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.receipt_date < ?
           ${alcance ? 'AND c.sucursal = ANY(?)' : ''}`,
        alcance ? [tenantId, cfg.reception_start, alcance] : [tenantId, cfg.reception_start]);

      return {
        settings: cfg,
        // `responsables_red` es uno solo para todo el tablero: son los que ven la red entera.
        responsables_red: (resp as any).red ?? 0,
        rows: (r.rows || []).map((x: any) => ({
          sucursal: x.sucursal,
          responsables: resp.get(String(x.sucursal)) ?? [],
          entradas: Number(x.entradas),
          con_evidencia: Number(x.con_evidencia),
          validadas: Number(x.validadas),
          por_validar: Number(x.por_validar),
          rechazadas: Number(x.rechazadas),
          monto: Number(x.monto),
          monto_pendiente: Number(x.monto_pendiente),
          atrasadas: Number(x.atrasadas),
          dias_p50: Number(x.dias_p50),
          dias_p90: Number(x.dias_p90),
          pct_evidencia: Number(x.entradas) ? Math.round((Number(x.con_evidencia) / Number(x.entradas)) * 100) : 0,
          pct_validadas: Number(x.entradas) ? Math.round((Number(x.validadas) / Number(x.entradas)) * 100) : 0,
        })),
        rezago: { entradas: Number(rez.rows?.[0]?.entradas || 0), monto: Number(rez.rows?.[0]?.monto || 0) },
      };
    });
  }

  /**
   * Frescura POR FUENTE de la lista de entradas.
   *
   * La pantalla mezcla dos orígenes (Kepler ODS, al segundo · Wincaja, copia periódica desde los
   * .mdb) y no distinguía **"esta sucursal no recibió nada"** de **"su feed dejó de traer datos"**.
   * El 24/08/2026 eso costó medio día de diagnóstico: Wincaja se veía "3 días atrás" y en realidad
   * el archivo estaba fresco y no había habido recepciones.
   *
   * El umbral es POR FUENTE, no global: cada rama tiene su propia cadencia (CEDIS recibe a diario,
   * una sucursal chica cada varios días). Se compara los días sin recepción contra la **mediana de
   * su propio hueco** en 90 días, con piso de 3 días, así una rama de bajo volumen no grita sola.
   */
  private async frescuraPorFuente(trx: any, tenantId: string) {
    const r = await trx.raw(`
      WITH d AS (
        SELECT source_branch, receipt_date::date AS f
          FROM analytics.erp_goods_receipts
         WHERE tenant_id = ? AND dup_of_folio IS NULL
           AND receipt_date <= current_date          -- las fechas futuras no cuentan como frescura
           AND receipt_date >= current_date - 90
         GROUP BY 1, 2
      ), gaps AS (
        SELECT source_branch, f - lag(f) OVER (PARTITION BY source_branch ORDER BY f) AS gap FROM d
      ), cadencia AS (
        SELECT source_branch,
               COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY gap), 1) AS gap_mediano
          FROM gaps WHERE gap IS NOT NULL GROUP BY 1
      )
      SELECT d.source_branch,
             max(d.f) AS ultima,
             (current_date - max(d.f))::int AS dias,
             COALESCE(c.gap_mediano, 1)::int AS cadencia_dias,
             GREATEST(3, COALESCE(c.gap_mediano, 1) * 2)::int AS tolerancia_dias,
             ((current_date - max(d.f)) > GREATEST(3, COALESCE(c.gap_mediano, 1) * 2)) AS atrasada
        FROM d LEFT JOIN cadencia c USING (source_branch)
       GROUP BY d.source_branch, c.gap_mediano
       ORDER BY d.source_branch`, [tenantId]);
    return (r.rows || []).map((x: any) => ({
      source_branch: x.source_branch,
      origen: String(x.source_branch || '').startsWith('md_') ? 'kepler' : 'wincaja',
      ultima: x.ultima,
      dias: Number(x.dias),
      cadencia_dias: Number(x.cadencia_dias),
      tolerancia_dias: Number(x.tolerancia_dias),
      atrasada: !!x.atrasada,
    }));
  }

  /**
   * FOTO-PRIMERO — dado el OCR de la **Aplica Orden Entrada** (folio + total), busca la(s)
   * entrada(s) de Kepler que le corresponden, para enlazar sin elegir a mano. Match por
   * FOLIO (tolerante a ceros: "8625"="0008625") ∪ por MONTO (±$2). Si `search` viene (pick
   * manual), busca por proveedor/folio/OC. Prioriza las que aún NO tienen comprobante.
   */
  async matchByOcr(q: { folio?: string; total?: number; fecha?: string; search?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(30, Math.max(1, Number(q.limit) || 15));
    // RE.13.0 — el enlace también se scopea: no se le puede colgar evidencia a la entrada
    // de otra sucursal por escribir su folio en el buscador.
    const alcance = await this.sucursalesVisibles(null);
    const folio = (q.folio || '').trim();
    const total = q.total != null && isFinite(Number(q.total)) ? Number(q.total) : null;
    const search = (q.search || '').trim();
    if (!folio && total == null && !search) return { entradas: [] as any[] };
    // candidatos de folio (igualdad tolerante a ceros; dedup filter+indexOf, NO Set-spread)
    const cands: string[] = [];
    if (folio) {
      const stripped = folio.replace(/^0+/, '') || folio;
      const forms = [folio, stripped, stripped.padStart(6, '0'), stripped.padStart(7, '0'), stripped.padStart(8, '0')];
      for (const v of forms) if (v && cands.indexOf(v) < 0) cands.push(v);
    }
    return this.tk.run(async (trx) => {
      const cfg = await this.settings(trx);
      const dep = trx('finance.goods_receipt_proofs')
        .select('sucursal', 'folio').count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY ${PROOF_ORDER}))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY ${PROOF_ORDER}))[1] AS last_status`))
        .groupBy('sucursal', 'folio').as('d');
      const hayPares = await this.hayPares(trx);
      const sel = () => {
        const qb = trx('analytics.erp_goods_receipts as c')
          .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
          .where('c.tenant_id', tenantId)
          .whereRaw('c.dup_of_folio IS NULL') // RE.12 — enlaza a la CANÓNICA (sucursal), no a la copia CEDIS
          .where('c.receipt_date', '>=', cfg.reception_start) // no enlazar a histórico previo al arranque
          .select('c.sucursal', 'c.folio', 'c.receipt_date', 'c.proveedor_code', 'c.proveedor_nombre',
            'c.proveedor_rfc', 'c.oc_folio', 'c.concepto', 'c.source_branch', trx.raw('c.monto::numeric AS monto'),
            trx.raw('COALESCE(d.n,0)::int AS deposits'), trx.raw('d.last_id AS deposit_id'),
            trx.raw('d.last_status AS deposit_status'), trx.raw(ORIGEN_SELECT),
            ...(hayPares ? GEMELA_SELECT : GEMELA_NULLS).map((c) => trx.raw(c)));
        // RE.14.3 — el par viaja en el enlace porque el folio y el importe de oficinas son llaves
        // de búsqueda tan válidas como los de la sucursal: la factura que tiene el capturista en
        // la mano puede casar con cualquiera de las dos capturas.
        if (hayPares) this.conGemela(qb, trx, tenantId);
        if (alcance) { if (alcance.length) qb.whereIn('c.sucursal', alcance); else qb.whereRaw('false'); }
        return qb;
      };
      const order = (qb: any) => qb.orderByRaw('COALESCE(d.n,0) ASC').orderBy('c.receipt_date', 'desc').limit(limit);
      let rows: any[] = [];
      if (search) {
        const b = sel();
        // Prioridad: últimos 4 dígitos del folio (término de 1–4 dígitos = sufijo exacto).
        if (/^\d{1,4}$/.test(search)) {
          const suf = search.padStart(4, '0');
          b.whereRaw(
            hayPares
              ? `(right(regexp_replace(c.folio, '\\D', '', 'g'), 4) = ? OR right(regexp_replace(gem.cedis_folio, '\\D', '', 'g'), 4) = ?)`
              : `right(regexp_replace(c.folio, '\\D', '', 'g'), 4) = ?`,
            hayPares ? [suf, suf] : [suf],
          );
        } else {
          applySmartSearch(b, search, {
            columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio', 'c.oc_folio',
              ...(hayPares ? ['gem.cedis_folio'] : [])],
            numeric: ['c.monto'],
          });
        }
        rows = await order(b);
      } else {
        // FOLIO primero (preciso, evita falsos positivos). Solo si NO hay match por folio, cae a MONTO (±$2).
        // El folio y el importe se buscan en las DOS capturas de la misma recepción (la de
        // sucursal y la de oficinas): si no, una factura que casa con la copia de oficinas no
        // encuentra nada y el capturista concluye que "la orden no existe".
        if (cands.length) {
          rows = await order(sel().where((w: any) => {
            w.whereIn('c.folio', cands);
            if (hayPares) w.orWhereIn('gem.cedis_folio', cands);
          }));
        }
        if (!rows.length && total != null) {
          rows = await order(sel().where((w: any) => {
            w.whereRaw('c.monto BETWEEN ? AND ?', [total - 2, total + 2]);
            if (hayPares) w.orWhereRaw('gem.cedis_monto BETWEEN ? AND ?', [total - 2, total + 2]);
          }));
        }
      }
      const entradas = rows.map((r: any) => ({
        ...r, monto: Number(r.monto), monto_match: false,
        gemela_monto: r.gemela_monto == null ? null : Number(r.gemela_monto),
        gemela_delta: r.gemela_delta == null ? null : Number(r.gemela_delta),
        gemela_score: r.gemela_score == null ? null : Number(r.gemela_score),
        folio_match: cands.length
          ? (cands.indexOf(String(r.folio).trim()) >= 0 || cands.indexOf(String(r.gemela_folio || '').trim()) >= 0)
          : false,
        total_match: total != null
          ? (Math.abs(Number(r.monto) - total) <= 2
            || (r.gemela_monto != null && Math.abs(Number(r.gemela_monto) - total) <= 2))
          : false,
      }));
      return { entradas };
    });
  }

  /**
   * Sube UN archivo (remisión/factura/evidencia) al bucket privado. **Sólo PDF.**
   *
   * Historia de la decisión, porque va y viene: RE.13.1 lo abrió a imágenes (`putFile`)
   * pensando en el capturista con el papel en la mano y sólo un celular. **2026-08-27 se
   * vuelve a cerrar a PDF por decisión de Edgar**: todos los que capturan trabajan en lap
   * con el escáner al lado, el expediente sostiene un pago (una foto torcida de una hoja
   * de tres no lo sostiene) y el PDF junta las hojas en UN archivo. La cámara no se pierde:
   * la app de Archivos/Cámara del celular escanea a PDF, endereza y agrupa.
   *
   * El rechazo vive en TRES lugares a propósito — `accept` del input (sugerencia), el front
   * (mensaje que dice la salida) y acá (la única frontera que no se puede saltar).
   */
  async uploadFile(dataUri: string, role = 'remision'): Promise<ReceiptFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!RECEIPT_FILE_ROLES.includes(role as ReceiptFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      // Bucket PRIVADO. Se guarda la KEY en public_id; la URL de lectura es prefirmada al
      // mostrar (signFiles), no permanente.
      // putPdf ya rechaza cualquier cosa que no sea PDF con 400 "Solo se aceptan archivos PDF."
      const f = await this.storage.putPdf(dataUri, `finance/${tenantId}/goods-receipts`);
      // url = key (placeholder truthy para no romper filtros `f.url`); la lectura la firma (signFiles).
      return { role, url: f.key, public_id: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e; // "no configurado" → mensaje directo al usuario
      this.logger.error(`fallo subiendo remisión (${role}): ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /**
   * Corre OCR sobre la hoja (**sólo PDF**, igual que `uploadFile`) — cada archivo se lee, no solo la ★.
   * Además detecta DUPLICADOS: la misma hoja (hash de contenido) o un folio de remisión/factura
   * ya subido antes. Preview, no guarda. `role` afina el dedup de folio (solo remisión/factura).
   */
  async runOcr(dataUri: string, role?: string): Promise<RemisionFields & { ocr_status: string; sha256: string; duplicate: DuplicateHit | null }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    // Mismo criterio que `uploadFile`: si no se va a poder guardar, no se gasta una llamada
    // a Claude leyéndolo. El mensaje dice la salida, no sólo el "no".
    if (mediaType !== 'application/pdf') {
      throw new BadRequestException('Solo se aceptan PDF. Escaneá la factura a PDF y volvé a subirla.');
    }
    const sha256 = createHash('sha256').update(base64).digest('hex');
    let fields: RemisionFields;
    let ocr_status: string;
    if (!process.env.ANTHROPIC_API_KEY) {
      fields = { folio: null, fecha: null, proveedor: null, rfc: null, subtotal: null, iva: null, total: null, documents_present: [], lines: [] };
      ocr_status = 'sin_key';
    } else {
      fields = await this.ocr.extractRemision(base64, mediaType);
      const any = fields.total != null || fields.folio || fields.proveedor || fields.rfc;
      ocr_status = any ? 'ok' : 'ilegible';
    }
    // Queda registrada para que `attach` guarde ESTO y no lo que traiga el request.
    this.readings.remember(this.tenantCtx.requireTenantId(), sha256, fields, ocr_status);
    // El dedup por FOLIO aplica al documento del proveedor (remisión/factura); el de HASH, a cualquier hoja.
    const checkFolio = !role || role === 'remision' || role === 'factura';
    const duplicate = await this.findDuplicate({ sha256, folio: checkFolio ? fields.folio : null, rfc: fields.rfc });
    return { ...fields, ocr_status, sha256, duplicate };
  }

  /**
   * ¿Esta hoja ya se subió? Por HASH de contenido (misma imagen/PDF) o por FOLIO de
   * remisión/factura ya capturado. Devuelve la entrada donde ya vive, o null.
   */
  private async findDuplicate(q: { sha256?: string | null; folio?: string | null; rfc?: string | null }): Promise<DuplicateHit | null> {
    const sha = (q.sha256 || '').trim();
    const folio = (q.folio || '').trim().toLowerCase();
    const rfc = (q.rfc || '').trim().toLowerCase();
    const folioOk = folio.length >= 3 && /[^0]/.test(folio); // evita folios triviales ("1", "000")
    if (!sha && !folioOk) return null;
    return this.tk.run(async (trx) => {
      if (sha) {
        const hit = await trx.raw(
          `SELECT sucursal, folio, proveedor_nombre
             FROM finance.goods_receipt_proofs
            WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(files,'[]'::jsonb)) e WHERE e->>'sha256' = ?)
            ORDER BY created_at DESC LIMIT 1`, [sha]);
        const r = hit.rows?.[0];
        if (r) return { reason: 'file' as const, sucursal: r.sucursal, folio: r.folio, proveedor: r.proveedor_nombre };
      }
      if (folioOk) {
        const hit = await trx.raw(
          `SELECT sucursal, folio, proveedor_nombre
             FROM finance.goods_receipt_proofs p
            WHERE (
                    lower(btrim(COALESCE(p.ocr_folio,''))) = ?
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.files,'[]'::jsonb)) e
                             WHERE (e->>'role') IN ('remision','factura')
                               AND lower(btrim(COALESCE(e->>'ocr_folio',''))) = ?)
                  )
              AND ( ? = '' OR lower(btrim(COALESCE(p.proveedor_rfc,''))) IN ('', ?) )
            ORDER BY p.created_at DESC LIMIT 1`, [folio, folio, rfc, rfc]);
        const r = hit.rows?.[0];
        if (r) return { reason: 'folio' as const, sucursal: r.sucursal, folio: r.folio, proveedor: r.proveedor_nombre };
      }
      return null;
    });
  }

  /** Crea el registro de evidencia ligado a la entrada Kepler. Calcula `monto_match`. */
  async attach(dto: AttachReceiptDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim();
    const folio = (dto.folio || '').trim();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!sucursal || !folio) throw new BadRequestException('sucursal y folio de la entrada requeridos');
    if (!files.length) throw new BadRequestException('se requiere al menos la remisión/factura');
    // RE.13.0 — alcance de ESCRITURA: `_GESTIONAR` dice que puede capturar evidencia, no que
    // pueda capturarla en cualquier sucursal. `mode_write` es lo que permite "ve las 3 de su
    // zona, captura sólo en la suya". 403 explicando la dimensión y el valor, no un Forbidden mudo.
    await this.scope.assertCanWrite('warehouse', sucursal);

    // Backstop server-side: rechaza si alguna hoja ya se había subido (misma imagen o folio ya capturado).
    for (const f of files) {
      const dup = await this.findDuplicate({
        sha256: f.sha256,
        folio: f.role === 'remision' || f.role === 'factura' ? f.ocr_folio : null,
        rfc: f.ocr_rfc,
      });
      if (dup) {
        throw new BadRequestException(
          dup.reason === 'file'
            ? `Una de las hojas ya se había subido (entrada ${dup.sucursal}/${dup.folio}). Quitala.`
            : `El folio ${f.ocr_folio} ya se subió (entrada ${dup.sucursal}/${dup.folio}${dup.proveedor ? ' · ' + dup.proveedor : ''}). Quitá esa hoja.`,
        );
      }
    }

    return this.tk.run(async (trx) => {
      const cfg = await this.settings(trx);
      const entrada = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), sucursal, folio })
        .first('proveedor_nombre', 'proveedor_rfc', 'oc_folio', 'receipt_date', trx.raw('monto::numeric AS monto'));
      if (!entrada) throw new BadRequestException(`entrada ${sucursal}/${folio} no existe en el espejo de Kepler`);

      // La lectura del modelo manda sobre lo que venga en el request: de `o` salen
      // `ocr_monto`, `monto_match` y el descuadre, o sea el control entero. Ver
      // `OcrReadingsService` para el porqué y para la caída cuando no hay lectura.
      const verificada = this.pickVerifiedReading(files);
      const o: Partial<RemisionFields> & { ocr_status?: string } =
        verificada ? { ...verificada.fields, ocr_status: verificada.status } : (dto.ocr || {});
      if (!verificada && dto.ocr) {
        this.logger.warn(`entrada ${sucursal}/${folio}: sin lectura verificada en memoria; se usa la del request`);
      }
      const receiptMonto = Number(entrada.monto) || 0;
      const ocrTotal = o.total != null ? Number(o.total) : null;
      const ocrSubtotal = o.subtotal != null ? Number(o.subtotal) : null;
      // RE.14.3 — **el cuadre es contra las DOS capturas.** La misma recepción está en el Kepler
      // de la sucursal y en el de oficinas, y los dos importes no siempre coinciden al centavo
      // (HERSHEY: $79,009.21 vs $79,007.79). Si la factura casa con cualquiera de los dos, el
      // documento cuadra: la diferencia es entre nuestras dos capturas, no con el proveedor, y
      // no tiene por qué frenarle la subida a la sucursal.
      const gem = (await this.hayPares(trx))
        ? await trx('analytics.erp_goods_receipt_dedup')
            .where({ tenant_id: this.tenantCtx.requireTenantId(), dup_of_sucursal: sucursal, dup_of_folio: folio })
            .whereIn('status', PAR_VIGENTE)
            .first('cedis_folio', trx.raw('cedis_monto::numeric AS cedis_monto'))
        : null;
      const gemelaMonto = gem?.cedis_monto != null ? Number(gem.cedis_monto) : null;
      // Cuadra si el total O el subtotal de la remisión ≈ el valor Kepler (IVA
      // puede o no estar incluido según el producto — dulce a granel suele ser 0%).
      const cerca = (v: number | null, ref: number | null) =>
        v != null && ref != null && Math.abs(v - ref) <= cfg.match_tolerance;
      const hayLectura = ocrTotal != null || ocrSubtotal != null;
      const cuadraCanonica = hayLectura ? (cerca(ocrTotal, receiptMonto) || cerca(ocrSubtotal, receiptMonto)) : null;
      const cuadraGemela = hayLectura ? (cerca(ocrTotal, gemelaMonto) || cerca(ocrSubtotal, gemelaMonto)) : null;
      const montoMatch = cuadraCanonica === null ? null : (cuadraCanonica || cuadraGemela === true);
      // RE.2 — clasifica y persiste el descuadre factura-vs-entrada (antes solo en vivo).
      // RE.14.3 — cuando cuadra sólo con la copia de oficinas, el descuadre contra la de sucursal
      // NO se borra: se etiqueta `gemela` con su monto, que es lo que le dice al revisor "esto no
      // es problema de la factura, es que nuestras dos capturas difieren".
      const disc = (cuadraCanonica === false && cuadraGemela === true)
        ? { kind: 'gemela', amount: Math.min(...[ocrTotal, ocrSubtotal].filter((v): v is number => v != null).map((v) => Math.abs(v - receiptMonto))) }
        : this.classifyDiscrepancy(receiptMonto, ocrTotal, ocrSubtotal, montoMatch);

      const [row] = await trx('finance.goods_receipt_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          sucursal, folio,
          proveedor_nombre: entrada.proveedor_nombre || null,
          proveedor_rfc: entrada.proveedor_rfc || null,
          oc_folio: entrada.oc_folio || null,
          receipt_date: entrada.receipt_date || null,
          receipt_monto: receiptMonto,
          files: JSON.stringify(files),
          ocr_folio: o.folio || null,
          ocr_fecha: o.fecha || null,
          ocr_proveedor: o.proveedor || null,
          ocr_rfc: o.rfc || null,
          ocr_subtotal: ocrSubtotal,
          ocr_iva: o.iva != null ? Number(o.iva) : null,
          ocr_monto: ocrTotal,
          ocr_raw: o ? JSON.stringify(o) : null,
          ocr_status: (o.ocr_status as string) || 'manual',
          monto_match: montoMatch,
          discrepancy_kind: disc.kind,
          discrepancy_amount: disc.amount,
          comentarios: (dto.comentarios || '').trim() || null,
          created_by: actor || null,
        })
        .returning(['id', 'sucursal', 'folio', 'status', 'monto_match']);
      this.logger.log(
        `remisión adjunta a entrada ${sucursal}/${folio} (match=${montoMatch}` +
        `${gem ? `, gemela oficinas 00/${gem.cedis_folio}${cuadraCanonica === false ? ' — cuadró con ella' : ''}` : ''}) por ${actor || '?'}`,
      );
      return row;
    });
  }

  /** Detalle: la entrada + sus remisiones adjuntas. */
  async detail(sucursal: string, folio: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    // RE.14.3 — **se puede pedir por el folio de oficinas.** La misma recepción está capturada
    // dos veces y el usuario llega con el folio que tiene en la mano; si es el de oficinas ('00')
    // y es espejo de una canónica, el detalle es el de la canónica (la que trae los productos y
    // la que lleva la evidencia). `redirigido_de` deja dicho de dónde vino, para que la pantalla
    // pueda explicar "el 00/0009136 que buscaste es el 03/0000909 de 8 Esquinas".
    let redirigido_de: { sucursal: string; folio: string } | null = null;
    // El alcance se resuelve FUERA de `tk.run` (regla del repo: `ScopeService` no vive dentro de
    // la transacción con RLS). El chequeo se hace más abajo, cuando ya sabemos qué entrada es.
    const alcance = await this.scope.current();
    return this.tk.run(async (trx) => {
      if (sucursal === '00' && await this.hayPares(trx)) {
        const par = await trx('analytics.erp_goods_receipt_dedup')
          .where({ tenant_id: tenantId, cedis_folio: folio })
          .whereIn('status', PAR_VIGENTE)
          .first('dup_of_sucursal', 'dup_of_folio');
        if (par?.dup_of_folio) {
          redirigido_de = { sucursal, folio };
          sucursal = par.dup_of_sucursal;
          folio = par.dup_of_folio;
        }
      }
      // RE.13.0 — el detalle es una URL adivinable (`/:sucursal/:folio`): sin esto, el alcance de
      // la lista era decorativo. `canRead` es la misma resolución que filtra la lista.
      if (!this.scope.canRead(alcance, 'warehouse', sucursal)) {
        // El mensaje dice a dónde apuntaba el folio de oficinas: sin eso, el capturista de CEDIS
        // ve un 403 sobre una sucursal que él no escribió en ningún lado.
        throw new BadRequestException(redirigido_de
          ? `la orden ${redirigido_de.sucursal}/${redirigido_de.folio} de oficinas es copia de ${sucursal}/${folio}, que no está en tu alcance`
          : `la entrada ${sucursal}/${folio} no está en tu alcance`);
      }
      const entrada = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, sucursal, folio })
        .first('sucursal', 'folio', 'receipt_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc',
          'oc_folio', 'vale_folio', 'concepto', trx.raw('monto::numeric AS monto'));
      if (!entrada) throw new BadRequestException('entrada no encontrada');
      // Detalle por renglón (auditoría): qué SKU/cantidad/costo entró en este documento.
      const lineasRaw = await trx('analytics.erp_goods_receipt_lines')
        .where({ tenant_id: tenantId, sucursal, folio })
        .orderByRaw(`NULLIF(regexp_replace(linea, '[^0-9]', '', 'g'), '')::int NULLS LAST, linea`)
        .select('linea', 'sku', 'nombre', 'unidad',
          trx.raw('cantidad::numeric AS cantidad'),
          trx.raw('costo_unitario::numeric AS costo_unitario'),
          trx.raw('importe::numeric AS importe'));
      const lineas = lineasRaw.map((l: any) => ({
        ...l, cantidad: Number(l.cantidad), costo_unitario: Number(l.costo_unitario), importe: Number(l.importe),
      }));
      const deposits = await trx('finance.goods_receipt_proofs')
        .where({ sucursal, folio })
        .orderBy('created_at', 'desc')
        .select('id', 'files', 'ocr_folio', 'ocr_fecha', 'ocr_proveedor', 'ocr_rfc',
          trx.raw('ocr_subtotal::numeric AS ocr_subtotal'), trx.raw('ocr_iva::numeric AS ocr_iva'),
          trx.raw('ocr_monto::numeric AS ocr_monto'), 'ocr_status', 'ocr_raw', 'monto_match',
          'discrepancy_kind', trx.raw('discrepancy_amount::numeric AS discrepancy_amount'), 'status',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      // URL de lectura prefirmada (bucket privado). Legacy Cloudinary (url http) se deja como está.
      // RE.11 — expone los renglones OCR (persistidos en ocr_raw.lines) para la conciliación por línea.
      const depSigned = await Promise.all(deposits.map(async (d: any) => {
        const files = typeof d.files === 'string' ? JSON.parse(d.files || '[]') : (d.files || []);
        let ocr_lines: RemisionLine[] = [];
        try {
          const raw = typeof d.ocr_raw === 'string' ? JSON.parse(d.ocr_raw || '{}') : (d.ocr_raw || {});
          if (Array.isArray(raw?.lines)) ocr_lines = raw.lines;
        } catch { /* ocr_raw no-JSON legacy → sin líneas */ }
        const { ocr_raw: _omit, ...rest } = d;
        return { ...rest, ocr_lines, files: await this.storage.signFiles(files) };
      }));
      // RE.12 — copia(s) CEDIS ('00') que son espejo de esta canónica: se muestran en su vista
      // (misma recepción, otra póliza) para que no se pida evidencia por separado.
      // RE.14.3 — sale de la tabla de pares y no de la vista, por dos razones: la vista sólo
      // expone `dup_of_*` de los pares VIGENTES (una propuesta sin dictaminar no aparecería, y es
      // justo la que hay que poder confirmar acá), y los importes/fechas ya están denormalizados
      // → no hay que volver a barrer la vista viva sobre `kepler_ods`.
      const pares = (await this.hayPares(trx))
        ? await trx('analytics.erp_goods_receipt_dedup')
            .where({ tenant_id: tenantId, dup_of_sucursal: sucursal, dup_of_folio: folio })
            .whereNot('status', 'rechazado')
            .select('cedis_folio', 'cedis_date', 'match_rule', 'status', 'decided_by', 'decided_at',
              trx.raw('cedis_monto::numeric AS cedis_monto'),
              trx.raw('delta_monto::numeric AS delta_monto'),
              trx.raw('match_score::numeric AS match_score'), 'delta_dias')
        : [];
      const cedis_twins = pares.map((p: any) => ({
        sucursal: '00', folio: p.cedis_folio, receipt_date: p.cedis_date,
        oc_folio: null, vale_folio: null,
        monto: p.cedis_monto == null ? null : Number(p.cedis_monto),
        delta_monto: p.delta_monto == null ? null : Number(p.delta_monto),
        delta_dias: p.delta_dias == null ? null : Number(p.delta_dias),
        match_rule: p.match_rule, match_score: p.match_score == null ? null : Number(p.match_score),
        status: p.status, decided_by: p.decided_by, decided_at: p.decided_at,
      }));
      // RE.13.2 — la cadena de decisiones. El expediente que justifica un pago necesita el
      // recorrido (quién subió, quién devolvió y por qué, quién validó), no el último estado.
      const history = (await this.existeTabla(trx, 'finance', 'goods_receipt_proof_history'))
        ? await trx('finance.goods_receipt_proof_history')
            .where({ tenant_id: tenantId, sucursal, folio })
            .orderBy('changed_at', 'asc')
            .select('status_from', 'status_to', 'motivo_codigo', 'motivo', 'changed_by', 'changed_at')
        : [];
      return {
        entrada: { ...entrada, monto: Number(entrada.monto), origen: sucursal === '00' ? 'oficinas' : 'sucursal' },
        lineas, deposits: depSigned, cedis_twins, history, redirigido_de,
      };
    });
  }

  /**
   * `[RE.14.3]` — **Los pares sucursal ↔ oficinas**: la lista de la misma recepción capturada dos
   * veces, con el importe de cada lado y la regla con la que se apareó.
   *
   * Es a la vez una vista de consulta ("¿cuál es el de oficinas de esta orden?") y una bandeja de
   * trabajo: los `'propuesto'` son los que el detector NO se animó a dar por espejo —importe y
   * fecha casan pero el proveedor no coincide entre catálogos, o la copia de oficinas trae
   * productos propios— y mientras nadie dictamine, **esa recepción se sigue contando dos veces**.
   *
   * Se sirve de la tabla de pares y no de la vista: los importes, fechas y proveedores de los dos
   * lados están denormalizados ahí, así que la bandeja no vuelve a barrer `kepler_ods`.
   *
   * Alcance: se filtra por la **canónica** (la de sucursal), que es la dueña del documento.
   */
  async twins(q: { estado?: 'propuesto' | 'vigente' | 'todos'; warehouse_codes?: string[] | null; search?: string; limit?: number } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const alcance = await this.sucursalesVisibles(q.warehouse_codes);
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return this.tk.run(async (trx) => {
      if (!(await this.hayPares(trx))) return { rows: [], kpis: { propuestos: 0, vigentes: 0, monto_propuesto: 0 }, total: 0 };
      const base = () => {
        const b = trx('analytics.erp_goods_receipt_dedup as p')
          .where('p.tenant_id', tenantId)
          .whereNotNull('p.dup_of_folio');
        if (alcance) { if (alcance.length) b.whereIn('p.dup_of_sucursal', alcance); else b.whereRaw('false'); }
        if (q.estado === 'propuesto') b.where('p.status', 'propuesto');
        else if (q.estado === 'vigente') b.whereIn('p.status', PAR_VIGENTE);
        else b.whereNot('p.status', 'rechazado');
        applySmartSearch(b, q.search, {
          columns: ['p.cedis_folio', 'p.dup_of_folio', 'p.suc_prov', 'p.cedis_prov'],
          numeric: ['p.cedis_monto'],
        });
        return b;
      };
      const rows = (await base()
        .select('p.cedis_folio', 'p.dup_of_sucursal as sucursal', 'p.dup_of_folio as folio',
          'p.suc_date', 'p.cedis_date', 'p.suc_prov', 'p.cedis_prov', 'p.match_rule', 'p.status',
          'p.decided_by', 'p.decided_at', 'p.delta_dias',
          trx.raw('p.suc_monto::numeric AS suc_monto'), trx.raw('p.cedis_monto::numeric AS cedis_monto'),
          trx.raw('p.delta_monto::numeric AS delta_monto'), trx.raw('p.match_score::numeric AS match_score'))
        // Lo dudoso primero, y dentro de eso el dinero más grande: es el orden en que conviene
        // gastar la atención de la persona que dictamina.
        .orderByRaw(`(p.status = 'propuesto') DESC`)
        .orderByRaw('ABS(p.cedis_monto) DESC NULLS LAST')
        .limit(limit))
        .map((r: any) => ({
          ...r,
          suc_monto: r.suc_monto == null ? null : Number(r.suc_monto),
          cedis_monto: r.cedis_monto == null ? null : Number(r.cedis_monto),
          delta_monto: r.delta_monto == null ? null : Number(r.delta_monto),
          match_score: r.match_score == null ? null : Number(r.match_score),
          delta_dias: r.delta_dias == null ? null : Number(r.delta_dias),
        }));
      const [k] = await base().select(
        trx.raw(`COUNT(*) FILTER (WHERE p.status = 'propuesto')::int AS propuestos`),
        trx.raw(`COUNT(*) FILTER (WHERE p.status IN ('auto','confirmado'))::int AS vigentes`),
        trx.raw(`COALESCE(SUM(p.cedis_monto::numeric) FILTER (WHERE p.status = 'propuesto'), 0)::numeric AS monto_propuesto`),
        trx.raw('COUNT(*)::int AS total'),
      );
      // RE.17.3 — cuántos renglones tiene cada lado. Es **el** dato de la decisión y no estaba:
      // la copia de sucursal trae los productos (12–20 renglones) y la de oficinas casi siempre
      // uno solo de concepto. Va en UNA consulta agregada sobre los folios de la página, no un
      // conteo por fila (serían 400 viajes contra el ODS).
      const conteos = await this.renglonesPorFolio(trx, tenantId, [
        ...rows.map((r: any) => [String(r.sucursal), String(r.folio)] as [string, string]),
        ...rows.map((r: any) => ['00', String(r.cedis_folio)] as [string, string]),
      ]);
      for (const r of rows as any[]) {
        r.suc_lineas = conteos.get(`${r.sucursal}|${r.folio}`) ?? null;
        r.cedis_lineas = conteos.get(`00|${r.cedis_folio}`) ?? null;
      }
      return {
        rows,
        kpis: {
          propuestos: Number(k.propuestos), vigentes: Number(k.vigentes),
          // Lo que hoy está contado dos veces por falta de dictamen. Es el costo de no decidir.
          monto_propuesto: Number(k.monto_propuesto),
        },
        total: Number(k.total),
        alcance: { sucursales: alcance, total_visibles: alcance ? alcance.length : null },
      };
    });
  }

  /**
   * `[RE.17.3]` — Cuenta renglones de varios documentos de una sola pasada. Row-constructor
   * `(sucursal, folio) IN ((?,?),…)`: una consulta agrupada en vez de un `count` por fila.
   */
  private async renglonesPorFolio(trx: any, tenantId: string, claves: [string, string][]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const únicas = [...new Map(claves.filter(([s, f]) => s && f).map((k) => [`${k[0]}|${k[1]}`, k])).values()];
    if (!únicas.length) return out;
    const tuplas = únicas.map(() => '(?,?)').join(',');
    const r = await trx.raw(
      `SELECT sucursal, folio, COUNT(*)::int AS n
         FROM analytics.erp_goods_receipt_lines
        WHERE tenant_id = ? AND (sucursal, folio) IN (${tuplas})
        GROUP BY sucursal, folio`,
      [tenantId, ...únicas.flat()],
    );
    for (const x of r.rows || []) out.set(`${x.sucursal}|${x.folio}`, Number(x.n));
    return out;
  }

  /**
   * `[RE.17.3]` — **Los renglones de los dos lados de un par**, para dictaminarlo mirando la
   * evidencia y no un score. La pantalla pedía decidir si dos capturas son la misma compra
   * mostrando folio, importe, fecha y proveedor — y lo que lo resuelve está un nivel más abajo:
   * la copia de sucursal lista los productos y la de oficinas suele traer un único renglón de
   * concepto (`VENTAS AL 0 %`) con el total. Se pide al expandir la fila, no con la lista.
   */
  async twinLines(cedisFolio: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const folio = (cedisFolio || '').trim();
    if (!folio) throw new BadRequestException('folio requerido');
    return this.tk.run(async (trx) => {
      if (!(await this.hayPares(trx))) throw new BadRequestException('el apareo no está disponible en este entorno');
      const par = await trx('analytics.erp_goods_receipt_dedup')
        .where({ tenant_id: tenantId, cedis_folio: folio })
        .first('cedis_folio', 'dup_of_sucursal', 'dup_of_folio');
      if (!par?.dup_of_folio) throw new BadRequestException(`no hay par para el folio ${folio}`);
      // El alcance se comprueba sobre la canónica, igual que en la lista: la dueña del documento
      // es la sucursal, no oficinas.
      const alcance = await this.sucursalesVisibles(null);
      if (alcance && !alcance.includes(String(par.dup_of_sucursal))) {
        throw new ForbiddenException('esa recepción no está en tu alcance de sucursal');
      }
      const lineas = async (sucursal: string, f: string) =>
        trx('analytics.erp_goods_receipt_lines')
          .where({ tenant_id: tenantId, sucursal, folio: f })
          .orderBy('linea')
          .limit(200)
          .select('linea', 'sku', 'nombre', 'unidad',
            trx.raw('cantidad::numeric AS cantidad'),
            trx.raw('costo_unitario::numeric AS costo_unitario'),
            trx.raw('importe::numeric AS importe'));
      const num = (rs: any[]) => rs.map((l) => ({
        ...l, cantidad: Number(l.cantidad), costo_unitario: Number(l.costo_unitario), importe: Number(l.importe),
      }));
      const [suc, ofi] = await Promise.all([
        lineas(String(par.dup_of_sucursal), String(par.dup_of_folio)),
        lineas('00', folio),
      ]);
      return {
        sucursal: { sucursal: String(par.dup_of_sucursal), folio: String(par.dup_of_folio), lineas: num(suc) },
        oficinas: { sucursal: '00', folio, lineas: num(ofi) },
      };
    });
  }

  /**
   * `[RE.14.3]` — Dictamina un par: **sí es la misma recepción** (`confirmar`) o **no lo es**
   * (`rechazar`). Confirmar oculta la copia de oficinas del conteo; rechazar la devuelve a la
   * lista como compra propia y **la saca de la rueda del detector**, que no la vuelve a proponer.
   *
   * Es una decisión sobre dinero (mueve lo que se cuenta), así que va con `_VALIDAR` y queda
   * firmada. El alcance de ESCRITURA se exige sobre la canónica: la orden es de esa sucursal.
   */
  async decideTwin(cedisFolio: string, decision: 'confirmar' | 'rechazar', actor?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const folio = (cedisFolio || '').trim();
    if (!folio) throw new BadRequestException('folio de oficinas requerido');
    if (decision !== 'confirmar' && decision !== 'rechazar') throw new BadRequestException('decisión inválida');
    const par = await this.tk.run(async (trx) => (await this.hayPares(trx))
      ? trx('analytics.erp_goods_receipt_dedup')
          .where({ tenant_id: tenantId, cedis_folio: folio })
          .first('dup_of_sucursal', 'dup_of_folio', 'status')
      : null);
    if (!par) throw new BadRequestException(`no hay par registrado para la orden de oficinas 00/${folio}`);
    await this.scope.assertCanWrite('warehouse', par.dup_of_sucursal);
    return this.tk.run(async (trx) => {
      const [row] = await trx('analytics.erp_goods_receipt_dedup')
        .where({ tenant_id: tenantId, cedis_folio: folio })
        .update({
          status: decision === 'confirmar' ? 'confirmado' : 'rechazado',
          decided_by: actor || null,
          decided_at: trx.fn.now(),
        })
        .returning(['cedis_folio', 'dup_of_sucursal', 'dup_of_folio', 'status']);
      this.logger.log(`par 00/${folio} ↔ ${par.dup_of_sucursal}/${par.dup_of_folio}: ${row.status} por ${actor || '?'}`);
      return row;
    });
  }

  /**
   * `[RE.13.3]` — Adjunta VARIOS expedientes de una pasada (captura por lote de CEDIS).
   *
   * CEDIS son ~30 entradas/día hábil (74% del volumen de la red) y las facturas llegan ya
   * digitales. Con el flujo de a una —dos pasos, diálogo modal, buscar el folio a mano— son
   * unas 8 interacciones por entrada: **240 al día**. Acá el humano suelta el bonche, el
   * servidor lo enlaza por folio y él sólo confirma.
   *
   * **Cada item en su propia transacción**, a propósito: si el archivo 12 trae un duplicado o
   * un folio que no existe, los 11 anteriores tienen que quedar guardados. Devuelve el
   * resultado por item — el capturista tiene que ver qué se quedó afuera y por qué.
   *
   * Reusa `attach()` tal cual (dedup por hash, alcance de escritura, cuadre con la tolerancia
   * del tenant): el lote no es un camino paralelo con reglas propias, es el mismo camino N veces.
   */
  async attachBulk(items: AttachReceiptDto[], actor?: string) {
    this.tenantCtx.requireTenantId();
    const lista = Array.isArray(items) ? items.filter((i) => i && i.sucursal && i.folio) : [];
    if (!lista.length) throw new BadRequestException('no llegó ningún expediente');
    const cfg = await this.tk.run(async (trx) => this.settings(trx));
    if (lista.length > cfg.bulk_max_files) {
      throw new BadRequestException(`el lote no puede pasar de ${cfg.bulk_max_files} archivos (llegaron ${lista.length})`);
    }
    const detalle: { sucursal: string; folio: string; ok: boolean; monto_match?: boolean; motivo?: string }[] = [];
    for (const item of lista) {
      const ref = { sucursal: String(item.sucursal), folio: String(item.folio) };
      try {
        const r = await this.attach(item, actor);
        detalle.push({ ...ref, ok: true, monto_match: !!r.monto_match });
      } catch (e: any) {
        detalle.push({ ...ref, ok: false, motivo: e?.message || 'no se pudo adjuntar' });
      }
    }
    const guardadas = detalle.filter((d) => d.ok);
    return {
      guardadas: guardadas.length,
      omitidas: detalle.length - guardadas.length,
      cuadran: guardadas.filter((d) => d.monto_match).length,
      detalle,
    };
  }

  /**
   * RE.11.2 — Conciliación POR LÍNEA: empata cada renglón de la remisión del proveedor
   * (OCR) contra las líneas de la orden de entrada de Kepler (`erp_goods_receipt_lines`,
   * que ya traen el SKU interno + nombre + cantidad). Resuelve el SKU en cascada:
   *
   *   1. ALIAS aprendido  — descripción ya vista para este proveedor (RFC) → SKU directo.
   *   2. CÓDIGO DE BARRAS  — EAN impreso en el renglón → catalog.product_barcodes → SKU.
   *   3. DESCRIPCIÓN       — similitud de tokens contra el `nombre` de las líneas Kepler.
   *
   * Asignación greedy (cada línea Kepler se consume una sola vez), priorizando alias/barcode
   * (certeros) y luego descripción por score. La cantidad se normaliza a PIEZAS con el
   * box_factor canónico (`analytics.v_product_box_factor`) para que caja↔pieza cuadre.
   * NO escribe nada; devuelve el resultado para el panel + los sobrantes (huérfanos).
   */
  async reconcileLines(sucursal: string, folio: string, ocrLines: RemisionLine[]) {
    const tenantId = this.tenantCtx.requireTenantId();
    const suc = (sucursal || '').trim();
    const fol = (folio || '').trim();
    if (!suc || !fol) throw new BadRequestException('sucursal y folio requeridos');
    const remLines = Array.isArray(ocrLines) ? ocrLines.filter((l) => l && l.descripcion) : [];

    return this.tk.run(async (trx) => {
      const entrada = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
        .first('proveedor_rfc', 'proveedor_nombre');
      if (!entrada) throw new BadRequestException(`entrada ${suc}/${fol} no existe en el espejo de Kepler`);
      const rfc = (entrada.proveedor_rfc || '').trim().toUpperCase();

      // Líneas Kepler de ESTA entrada (candidatos del match).
      const kepRaw = await trx('analytics.erp_goods_receipt_lines')
        .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
        .orderByRaw(`NULLIF(regexp_replace(linea, '[^0-9]', '', 'g'), '')::int NULLS LAST, linea`)
        .select('linea', 'sku', 'nombre', 'unidad',
          trx.raw('cantidad::numeric AS cantidad'),
          trx.raw('costo_unitario::numeric AS costo_unitario'),
          trx.raw('importe::numeric AS importe'));
      const kepler = kepRaw.map((l: any, i: number) => ({
        _i: i, linea: l.linea, sku: l.sku, nombre: l.nombre, unidad: l.unidad,
        cantidad: Number(l.cantidad), costo_unitario: Number(l.costo_unitario), importe: Number(l.importe),
        _tokens: this.tokenize(this.normStr(l.nombre || '')),
        _used: false,
      }));

      // box_factor canónico por SKU de las líneas (para normalizar cantidad a piezas).
      const skus = kepler.map((k) => k.sku).filter((s): s is string => !!s);
      const bfMap = new Map<string, number>();
      if (skus.length) {
        const bf = await trx.raw(
          `SELECT p.sku, COALESCE(vbf.box_factor, 1)::numeric AS box_factor
             FROM catalog.products p
             LEFT JOIN analytics.v_product_box_factor vbf
                    ON vbf.tenant_id = p.tenant_id AND vbf.product_id = p.id
            WHERE p.tenant_id = ? AND p.sku = ANY(?)`, [tenantId, skus]);
        for (const r of bf.rows || []) bfMap.set(String(r.sku), Number(r.box_factor) || 1);
      }

      // Aliases aprendidos para este proveedor.
      const aliasMap = new Map<string, { sku: string; nombre_interno: string | null; box_factor: number | null }>();
      if (rfc) {
        const al = await trx('commercial.supplier_item_aliases')
          .where({ tenant_id: tenantId, proveedor_rfc: rfc }).whereNull('deleted_at')
          .select('descripcion_norm', 'sku', 'nombre_interno', trx.raw('box_factor::numeric AS box_factor'));
        for (const a of al) aliasMap.set(a.descripcion_norm, { sku: a.sku, nombre_interno: a.nombre_interno, box_factor: a.box_factor != null ? Number(a.box_factor) : null });
      }

      // Barcodes → sku (solo los que aparecen en la remisión).
      const barcodes = remLines.map((l) => (l.codigo_barras || '').trim()).filter((b) => b.length >= 8);
      const bcMap = new Map<string, string>();
      if (barcodes.length) {
        const bc = await trx('catalog.product_barcodes')
          .where({ tenant_id: tenantId }).whereNull('deleted_at').whereIn('barcode', barcodes)
          .select('barcode', 'sku');
        for (const r of bc) if (!bcMap.has(r.barcode)) bcMap.set(r.barcode, r.sku);
      }

      const kepBySku = new Map<string, typeof kepler[number]>();
      for (const k of kepler) if (k.sku && !kepBySku.has(k.sku)) kepBySku.set(k.sku, k);

      // ── Resolver cada renglón de la remisión ────────────────────────────────
      const results: ReconciledLine[] = remLines.map((rem, idx) => {
        const descNorm = this.normStr(rem.descripcion || '');
        const remTokens = this.tokenize(descNorm);
        let kep: typeof kepler[number] | null = null;
        let method: ReconciledLine['method'] = 'sin_match';
        let score = 0;
        let alias_hit = false;
        let resolvedSku: string | null = null;
        let resolvedNombre: string | null = null;

        // 1) Alias aprendido.
        const alias = aliasMap.get(descNorm);
        if (alias) {
          resolvedSku = alias.sku; resolvedNombre = alias.nombre_interno; method = 'alias'; score = 1; alias_hit = true;
          const k = kepBySku.get(alias.sku);
          if (k && !k._used) { kep = k; k._used = true; }
        }
        // 2) Código de barras.
        if (!resolvedSku && rem.codigo_barras) {
          const sku = bcMap.get((rem.codigo_barras || '').trim());
          if (sku) {
            resolvedSku = sku; method = 'barcode'; score = 0.95;
            const k = kepBySku.get(sku);
            if (k && !k._used) { kep = k; k._used = true; resolvedNombre = k.nombre; }
          }
        }
        // 3) Descripción contra líneas Kepler libres.
        if (!resolvedSku) {
          let best: typeof kepler[number] | null = null; let bestScore = 0;
          for (const k of kepler) {
            if (k._used) continue;
            const s = this.lineSimilarity(remTokens, k._tokens);
            if (s > bestScore) { bestScore = s; best = k; }
          }
          if (best && bestScore >= 0.34) {
            kep = best; best._used = true; method = 'descripcion'; score = Number(bestScore.toFixed(3));
            resolvedSku = best.sku; resolvedNombre = best.nombre;
          }
        }

        // Normalización de cantidad a piezas + comparaciones.
        const bf = (resolvedSku && bfMap.get(resolvedSku)) || alias?.box_factor || 1;
        const unidad = (rem.unidad || '').toUpperCase();
        const isBox = /(CJA|CAJA|CJ|BULTO|PAQ|DISPLAY|MASTER)/.test(unidad);
        const qtyPz = rem.cantidad != null ? (isBox ? rem.cantidad * bf : rem.cantidad) : null;
        const qtyKep = kep ? kep.cantidad : null;
        let qty_match: boolean | null = null;
        if (qtyPz != null && qtyKep != null) {
          const denom = Math.max(Math.abs(qtyKep), 1);
          qty_match = Math.abs(qtyPz - qtyKep) / denom <= QTY_TOL;
        }
        let price_match: boolean | null = null;
        if (rem.precio_unitario != null && kep && kep.costo_unitario > 0) {
          // Precio de la remisión suele ser por unidad facturada (caja); Kepler por pieza.
          const remUnitPz = isBox && bf > 1 ? rem.precio_unitario / bf : rem.precio_unitario;
          const denom = Math.max(kep.costo_unitario, 0.01);
          price_match = Math.abs(remUnitPz - kep.costo_unitario) / denom <= PRICE_TOL;
        }

        let status: ReconciledLine['status'];
        if (!resolvedSku || !kep) status = 'sin_match';
        else if (qty_match === false) status = 'difiere_cantidad';
        else if (price_match === false) status = 'difiere_precio';
        else if (qty_match === true) status = 'cuadra';
        else status = 'revisar';

        return {
          idx, remision: rem, kepler: kep ? {
            linea: kep.linea, sku: kep.sku, nombre: kep.nombre, unidad: kep.unidad,
            cantidad: kep.cantidad, costo_unitario: kep.costo_unitario, importe: kep.importe,
          } : null,
          resolved_sku: resolvedSku, resolved_nombre: resolvedNombre, method, score,
          box_factor: bf, qty_remision_pz: qtyPz, qty_kepler: qtyKep, qty_match, price_match,
          status, alias_hit,
        };
      });

      const kepler_orphans = kepler.filter((k) => !k._used).map((k) => ({
        linea: k.linea, sku: k.sku, nombre: k.nombre, unidad: k.unidad,
        cantidad: k.cantidad, costo_unitario: k.costo_unitario, importe: k.importe,
      }));

      const totals = {
        lineas_remision: results.length,
        lineas_kepler: kepler.length,
        cuadran: results.filter((r) => r.status === 'cuadra').length,
        difieren: results.filter((r) => r.status === 'difiere_cantidad' || r.status === 'difiere_precio').length,
        sin_match: results.filter((r) => r.status === 'sin_match').length,
        revisar: results.filter((r) => r.status === 'revisar').length,
        kepler_orphans: kepler_orphans.length,
      };

      return {
        sucursal: suc, folio: fol, proveedor_rfc: rfc || null, proveedor_nombre: entrada.proveedor_nombre || null,
        lines: results, kepler_orphans, totals,
      };
    });
  }

  /**
   * RE.11.4 — APRENDER un match: el humano confirmó (o corrigió) que la descripción del
   * proveedor corresponde a un SKU interno. UPSERT en `commercial.supplier_item_aliases`
   * por `(tenant, proveedor_rfc, descripcion_norm)`: +1 veces_confirmado, confianza sube,
   * refresca `last_seen`. La próxima remisión del mismo proveedor resuelve sola.
   */
  async confirmLineMatch(
    dto: { proveedor_rfc?: string; descripcion?: string; sku?: string; nombre_interno?: string; unidad_proveedor?: string; box_factor?: number },
    actor?: string,
  ) {
    this.tenantCtx.requireTenantId();
    const rfc = (dto.proveedor_rfc || '').trim().toUpperCase();
    const descRaw = (dto.descripcion || '').trim();
    const sku = (dto.sku || '').trim();
    if (!rfc || !descRaw || !sku) throw new BadRequestException('proveedor_rfc, descripcion y sku requeridos');
    const descNorm = this.normStr(descRaw);
    if (!descNorm) throw new BadRequestException('descripcion vacía tras normalizar');

    return this.tk.run(async (trx) => {
      const bf = dto.box_factor != null && isFinite(Number(dto.box_factor)) ? Number(dto.box_factor) : null;
      const res = await trx.raw(
        `INSERT INTO commercial.supplier_item_aliases
           (tenant_id, proveedor_rfc, descripcion_norm, descripcion_raw, sku, nombre_interno, unidad_proveedor, box_factor, veces_confirmado, confianza, last_seen, created_by, updated_by)
         VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?, ?, 1, 0.7, now(), ?, ?)
         ON CONFLICT (tenant_id, proveedor_rfc, descripcion_norm) WHERE deleted_at IS NULL
         DO UPDATE SET
           sku = EXCLUDED.sku,
           nombre_interno = COALESCE(EXCLUDED.nombre_interno, commercial.supplier_item_aliases.nombre_interno),
           unidad_proveedor = COALESCE(EXCLUDED.unidad_proveedor, commercial.supplier_item_aliases.unidad_proveedor),
           box_factor = COALESCE(EXCLUDED.box_factor, commercial.supplier_item_aliases.box_factor),
           veces_confirmado = commercial.supplier_item_aliases.veces_confirmado + 1,
           confianza = LEAST(1.0, 0.6 + 0.1 * (commercial.supplier_item_aliases.veces_confirmado + 1)),
           last_seen = now(), updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING id, sku, veces_confirmado, confianza::numeric AS confianza`,
        [rfc, descNorm, descRaw, sku, dto.nombre_interno || null, (dto.unidad_proveedor || '').toUpperCase() || null, bf, actor || null, actor || null],
      );
      const row = res.rows?.[0];
      this.logger.log(`alias aprendido: [${rfc}] "${descNorm}" → SKU ${sku} (x${row?.veces_confirmado}) por ${actor || '?'}`);
      return { id: row?.id, sku: row?.sku, veces_confirmado: Number(row?.veces_confirmado), confianza: Number(row?.confianza) };
    });
  }

  /**
   * El revisor valida la evidencia. Auditado + historial.
   *
   * RE.13.2 — **segregación de funciones**: quien subió la evidencia no puede validarla. Dejó
   * de ser un lujo cuando se aceptó que hay revisor POR SUCURSAL además del central: en una
   * sucursal chica el que sube y el que revisa son el mismo puñado de gente, y sin esto el
   * control documental no existe.
   *
   * La comparación es por el nombre con el que se firmó el `attach` (`created_by` es texto,
   * no FK a usuario). Es lo que hay hoy; cuando `identity.people` esté (Fase ID.11) esto
   * debería comparar ids.
   */
  async validate(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const prev = await trx('finance.goods_receipt_proofs').where({ id })
        .first('id', 'status', 'created_by', 'sucursal', 'folio');
      if (!prev) throw new BadRequestException('evidencia no encontrada');
      if (prev.status === 'validado') throw new BadRequestException('esta evidencia ya está validada');
      if (this.mismaPersona(prev.created_by, actor)) {
        throw new ForbiddenException('No podés validar la evidencia que vos mismo subiste — que la revise otra persona.');
      }
      const [row] = await trx('finance.goods_receipt_proofs').where({ id }).whereIn('status', ['recibido', 'rechazado'])
        .update({ status: 'validado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null, updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      // Otra sesión decidió entre el SELECT y el UPDATE (revisor central + local mirando la
      // misma fila). No es un 500: es "alguien te ganó", y la UI avanza a la siguiente.
      if (!row) throw new BadRequestException('otra persona ya decidió sobre esta evidencia');
      await this.registrarHistorial(trx, {
        proof_id: id, sucursal: prev.sucursal, folio: prev.folio,
        status_from: prev.status, status_to: 'validado', actor,
      });
      return row;
    });
  }

  /** ¿El actor es quien subió? Normaliza espacios/caso porque los dos lados son texto libre. */
  private mismaPersona(a?: string | null, b?: string | null): boolean {
    const n = (v?: string | null) => (v || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return !!n(a) && n(a) === n(b);
  }

  /**
   * Rechaza (con motivo TIPIFICADO). Auditado + historial.
   *
   * RE.13.2 — el motivo pasa a ser del catálogo: con texto libre no se puede contestar
   * "¿por qué se devuelve el 30% de lo que sube la 01?", que es justo lo que le dice a la
   * sucursal qué corregir. El texto libre sigue existiendo como detalle.
   */
  async reject(id: string, actor?: string, motivo?: string, motivoCodigo?: string) {
    this.tenantCtx.requireTenantId();
    const code = (motivoCodigo || '').trim() || null;
    if (code && !MOTIVOS_RECHAZO.includes(code as MotivoRechazo)) {
      throw new BadRequestException(`motivo inválido: ${code}`);
    }
    const texto = (motivo || '').trim();
    if ((!code || code === 'otro') && !texto) {
      throw new BadRequestException('hace falta el motivo: elegí uno del catálogo o escribilo.');
    }
    return this.tk.run(async (trx) => {
      const prev = await trx('finance.goods_receipt_proofs').where({ id })
        .first('id', 'status', 'sucursal', 'folio');
      if (!prev) throw new BadRequestException('evidencia no encontrada');
      if (prev.status === 'rechazado') throw new BadRequestException('esta evidencia ya está rechazada');
      const patch: Record<string, unknown> = {
        status: 'rechazado', validated_by: actor || null, validated_at: trx.fn.now(),
        motivo_rechazo: texto || null, updated_at: trx.fn.now(),
      };
      if (code && await this.existeCol(trx, 'finance', 'goods_receipt_proofs', 'motivo_codigo')) {
        patch['motivo_codigo'] = code;
      }
      const [row] = await trx('finance.goods_receipt_proofs').where({ id }).whereIn('status', ['recibido', 'validado'])
        .update(patch).returning(['id', 'status']);
      if (!row) throw new BadRequestException('otra persona ya decidió sobre esta evidencia');
      await this.registrarHistorial(trx, {
        proof_id: id, sucursal: prev.sucursal, folio: prev.folio,
        status_from: prev.status, status_to: 'rechazado', motivo_codigo: code, motivo: texto || null, actor,
      });
      return row;
    });
  }

  /**
   * RE.13.2 — valida VARIAS de una pasada, pero **sólo el caso limpio**: la factura cuadra al
   * peso (tolerancia del tenant) y no la subió el propio revisor. El server vuelve a
   * comprobarlo por id — la UI no es la que decide qué es "limpio". Devuelve el resultado por
   * id, no un booleano: el revisor tiene que poder ver qué se saltó y por qué.
   */
  async validateBulk(ids: string[], actor?: string) {
    this.tenantCtx.requireTenantId();
    const lista = (ids || []).map(String).filter(Boolean).slice(0, 200);
    if (!lista.length) throw new BadRequestException('no llegó ninguna evidencia');
    const out: { id: string; ok: boolean; motivo?: string }[] = [];
    for (const id of lista) {
      try {
        // Cada una en su propia trx: un descuadre en la 7ª no puede tumbar las 6 anteriores.
        await this.tk.run(async (trx) => {
          const prev = await trx('finance.goods_receipt_proofs').where({ id })
            .first('id', 'status', 'created_by', 'sucursal', 'folio', 'monto_match');
          if (!prev) throw new BadRequestException('no existe');
          if (prev.status !== 'recibido') throw new BadRequestException(`ya está ${prev.status}`);
          if (prev.monto_match !== true) throw new BadRequestException('el total no cuadra — se revisa a mano');
          if (this.mismaPersona(prev.created_by, actor)) throw new BadRequestException('la subiste vos');
          const [row] = await trx('finance.goods_receipt_proofs').where({ id }).where('status', 'recibido')
            .update({ status: 'validado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null, updated_at: trx.fn.now() })
            .returning(['id']);
          if (!row) throw new BadRequestException('otra persona ya decidió');
          await this.registrarHistorial(trx, {
            proof_id: id, sucursal: prev.sucursal, folio: prev.folio,
            status_from: prev.status, status_to: 'validado', motivo: 'aprobación en lote (cuadra al peso)', actor,
          });
        });
        out.push({ id, ok: true });
      } catch (e: any) {
        out.push({ id, ok: false, motivo: e?.message || 'no se pudo validar' });
      }
    }
    return { validadas: out.filter((r) => r.ok).length, omitidas: out.filter((r) => !r.ok).length, detalle: out };
  }

  /**
   * RE.2 — clasifica el descuadre factura/remisión vs valor de la entrada (Kepler),
   * a partir de lo que hoy ya se calcula al adjuntar (no llama al auto-explain de
   * ajustes, que es un paso aparte). Devuelve el `kind` + el monto de la diferencia:
   *   - sin OCR (montoMatch null)     → sin clasificar (null/null)
   *   - cuadra                        → 'cuadra', 0
   *   - Δ ≈ 16% del valor             → 'iva'   (remisión con/ sin IVA vs entrada)
   *   - Δ > 70% del valor             → 'typo'  (error de captura grueso)
   *   - resto                         → 'otro'  (faltante/devolución/descuento → auto-explain)
   */
  private classifyDiscrepancy(receipt: number, ocrTotal: number | null, ocrSubtotal: number | null, montoMatch: boolean | null): { kind: string | null; amount: number | null } {
    if (montoMatch === null) return { kind: null, amount: null };
    if (montoMatch === true) return { kind: 'cuadra', amount: 0 };
    const cands = [ocrTotal, ocrSubtotal].filter((v): v is number => v != null);
    if (!cands.length) return { kind: null, amount: null };
    const amount = Math.min(...cands.map((v) => Math.abs(v - receipt)));
    const ratio = receipt > 0 ? amount / receipt : 0;
    if (ratio >= 0.14 && ratio <= 0.175) return { kind: 'iva', amount };
    if (ratio > 0.7) return { kind: 'typo', amount };
    return { kind: 'otro', amount };
  }

  /** Normaliza texto para comparar: lower + sin acentos + puntuación→espacio + colapsa. */
  private normStr(s: string): string {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Tokeniza: descarta tokens de 1 char, stopwords y unidades sueltas (ruido para el match). */
  private tokenize(s: string): string[] {
    const stop = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'con', 'sin', 'para',
      'pz', 'pza', 'pzs', 'pzas', 'gr', 'grs', 'kg', 'ml', 'lt', 'cja', 'caja', 'paq', 'c', 'pieza', 'piezas']);
    return this.normStr(s).split(/\s+/).filter((t) => t.length >= 2 && !stop.has(t));
  }

  /**
   * Similitud entre la descripción del proveedor y el nombre Kepler: cobertura de tokens
   * (fracción de tokens de la remisión presentes en el nombre Kepler) con un pequeño bonus
   * por el primer token (marca/identidad). 0..1. Universo chico (líneas de UNA entrada) →
   * token-overlap alcanza; sin embeddings ni costo por recepción.
   */
  private lineSimilarity(remTokens: string[], kepTokens: string[]): number {
    if (!remTokens.length || !kepTokens.length) return 0;
    const kepSet = new Set(kepTokens);
    const matched = remTokens.filter((t) => kepSet.has(t)).length;
    const coverage = matched / remTokens.length;
    // Jaccard suave para no premiar coincidencias por descripciones muy largas.
    const union = new Set([...remTokens, ...kepTokens]).size;
    const jaccard = matched / union;
    let score = 0.7 * coverage + 0.3 * jaccard;
    if (remTokens[0] && kepSet.has(remTokens[0])) score = Math.min(1, score + 0.1);
    return score;
  }

  private parseDataUri(dataUri: string): { mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf'; base64: string } {
    const m = /^data:([^;,]+)[;,]/.exec(dataUri || '');
    const raw = (m ? m[1] : 'image/jpeg').toLowerCase();
    const base64 = String(dataUri || '').replace(/^data:[^,]*,/, '');
    const mediaType = raw === 'application/pdf' ? 'application/pdf'
      : /^image\/(jpeg|png|webp|gif)$/.test(raw) ? (raw as any) : 'image/jpeg';
    return { mediaType, base64 };
  }
}
