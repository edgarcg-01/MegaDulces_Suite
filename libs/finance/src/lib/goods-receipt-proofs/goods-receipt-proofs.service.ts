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
   */
  orden?: 'antiguedad' | 'reciente' | 'monto' | 'riesgo';
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
          reception_start: String(row.reception_start).slice(0, 10),
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
      const dep = trx('finance.goods_receipt_proofs')
        .select('sucursal', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`(array_agg(created_at ORDER BY created_at DESC))[1] AS last_at`))
        .select(trx.raw(`(array_agg(discrepancy_amount ORDER BY created_at DESC))[1] AS last_disc`))
        // Quién la subió (para la segregación de funciones: el revisor no valida lo propio) y
        // por qué se devolvió (la sucursal necesita ver el motivo en su worklist).
        .select(trx.raw(`(array_agg(created_by ORDER BY created_at DESC))[1] AS last_by`))
        .select(trx.raw(`(array_agg(motivo_rechazo ORDER BY created_at DESC))[1] AS last_motivo`))
        .select(trx.raw(conMotivoCol
          ? `(array_agg(motivo_codigo ORDER BY created_at DESC))[1] AS last_motivo_codigo`
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
          b.whereRaw(`right(regexp_replace(c.folio, '\\D', '', 'g'), 4) = ?`, [term.padStart(4, '0')]);
        } else {
          applySmartSearch(b, q.search, {
            columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio', 'c.oc_folio'],
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
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      // El orden ES la herramienta de trabajo, así que es explícito por vista:
      //  - antiguedad (default) → worklist del capturista: lo más viejo primero.
      //  - riesgo               → cola del revisor: el descuadre más grande primero.
      // Las de fecha futura van DESPUÉS de las de hoy en el orden "reciente" (hay una de
      // CEDIS con 29/12/2026 que si no se quedaba clavada arriba para siempre).
      if (q.orden === 'monto') b.orderByRaw('c.monto::numeric DESC');
      else if (q.orden === 'riesgo') {
        b.orderByRaw('COALESCE(ABS(d.last_disc), 0) DESC')
          .orderByRaw('c.monto::numeric DESC')
          .orderByRaw('LEAST(c.receipt_date, current_date) ASC');
      } else if (q.orden === 'reciente') {
        b.orderByRaw('LEAST(c.receipt_date, current_date) DESC')
          .orderByRaw('(c.receipt_date > current_date) ASC');
      } else {
        b.orderByRaw('LEAST(c.receipt_date, current_date) ASC');
      }
      b.orderBy('c.folio', 'desc');

      const rows = (await b).map((r: any) => ({
        ...r,
        monto: Number(r.monto),
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
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .groupBy('sucursal', 'folio').as('d');
      const sel = () => {
        const qb = trx('analytics.erp_goods_receipts as c')
          .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
          .where('c.tenant_id', tenantId)
          .whereRaw('c.dup_of_folio IS NULL') // RE.12 — enlaza a la CANÓNICA (sucursal), no a la copia CEDIS
          .where('c.receipt_date', '>=', cfg.reception_start) // no enlazar a histórico previo al arranque
          .select('c.sucursal', 'c.folio', 'c.receipt_date', 'c.proveedor_code', 'c.proveedor_nombre',
            'c.proveedor_rfc', 'c.oc_folio', 'c.concepto', 'c.source_branch', trx.raw('c.monto::numeric AS monto'),
            trx.raw('COALESCE(d.n,0)::int AS deposits'), trx.raw('d.last_id AS deposit_id'),
            trx.raw('d.last_status AS deposit_status'));
        if (alcance) { if (alcance.length) qb.whereIn('c.sucursal', alcance); else qb.whereRaw('false'); }
        return qb;
      };
      const order = (qb: any) => qb.orderByRaw('COALESCE(d.n,0) ASC').orderBy('c.receipt_date', 'desc').limit(limit);
      let rows: any[] = [];
      if (search) {
        const b = sel();
        // Prioridad: últimos 4 dígitos del folio (término de 1–4 dígitos = sufijo exacto).
        if (/^\d{1,4}$/.test(search)) {
          b.whereRaw(`right(regexp_replace(c.folio, '\\D', '', 'g'), 4) = ?`, [search.padStart(4, '0')]);
        } else {
          applySmartSearch(b, search, { columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio', 'c.oc_folio'], numeric: ['c.monto'] });
        }
        rows = await order(b);
      } else {
        // FOLIO primero (preciso, evita falsos positivos). Solo si NO hay match por folio, cae a MONTO (±$2).
        if (cands.length) rows = await order(sel().whereIn('c.folio', cands));
        if (!rows.length && total != null) rows = await order(sel().whereRaw('c.monto BETWEEN ? AND ?', [total - 2, total + 2]));
      }
      const entradas = rows.map((r: any) => ({
        ...r, monto: Number(r.monto), monto_match: false,
        folio_match: cands.length ? cands.indexOf(String(r.folio).trim()) >= 0 : false,
        total_match: total != null ? Math.abs(Number(r.monto) - total) <= 2 : false,
      }));
      return { entradas };
    });
  }

  /**
   * Sube UN archivo (remisión/factura/evidencia) al bucket privado. **Imagen o PDF.**
   *
   * RE.13.1 — antes era `putPdf`, que rechaza imágenes. Eso venía de la migración de
   * Cloudinary (donde el problema era servir PDFs), pero dejaba al capturista de sucursal
   * sin poder subir NADA desde el celular: tiene el papel en la mano y una cámara, no un
   * escáner. `putFile` es el mismo camino que ya usa `bank-capture` para las fotos de ficha
   * que llegan por WhatsApp; guarda el ContentType real y `signFiles` firma la lectura igual.
   * El OCR ya aceptaba imagen desde siempre — el tapón estaba sólo en el almacenamiento.
   */
  async uploadFile(dataUri: string, role = 'remision'): Promise<ReceiptFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!RECEIPT_FILE_ROLES.includes(role as ReceiptFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      // Bucket PRIVADO. Se guarda la KEY en public_id; la URL de lectura es prefirmada al
      // mostrar (signFiles), no permanente.
      const f = await this.storage.putFile(dataUri, `finance/${tenantId}/goods-receipts`);
      // url = key (placeholder truthy para no romper filtros `f.url`); la lectura la firma (signFiles).
      return { role, url: f.key, public_id: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e; // "no configurado" → mensaje directo al usuario
      this.logger.error(`fallo subiendo remisión (${role}): ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /**
   * Corre OCR sobre CUALQUIER hoja (imagen/PDF) — ahora cada archivo se lee, no solo la ★.
   * Además detecta DUPLICADOS: la misma hoja (hash de contenido) o un folio de remisión/factura
   * ya subido antes. Preview, no guarda. `role` afina el dedup de folio (solo remisión/factura).
   */
  async runOcr(dataUri: string, role?: string): Promise<RemisionFields & { ocr_status: string; sha256: string; duplicate: DuplicateHit | null }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
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
      // Cuadra si el total O el subtotal de la remisión ≈ el valor Kepler (IVA
      // puede o no estar incluido según el producto — dulce a granel suele ser 0%).
      const near = (v: number | null) => v != null && Math.abs(v - receiptMonto) <= cfg.match_tolerance;
      const montoMatch = ocrTotal != null || ocrSubtotal != null ? (near(ocrTotal) || near(ocrSubtotal)) : null;
      // RE.2 — clasifica y persiste el descuadre factura-vs-entrada (antes solo en vivo).
      const disc = this.classifyDiscrepancy(receiptMonto, ocrTotal, ocrSubtotal, montoMatch);

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
      this.logger.log(`remisión adjunta a entrada ${sucursal}/${folio} (match=${montoMatch}) por ${actor || '?'}`);
      return row;
    });
  }

  /** Detalle: la entrada + sus remisiones adjuntas. */
  async detail(sucursal: string, folio: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    // RE.13.0 — el detalle es una URL adivinable (`/:sucursal/:folio`): sin esto, el alcance de
    // la lista era decorativo. `canRead` es la misma resolución que filtra la lista.
    const alcance = await this.scope.current();
    if (!this.scope.canRead(alcance, 'warehouse', sucursal)) {
      throw new BadRequestException(`la entrada ${sucursal}/${folio} no está en tu alcance`);
    }
    return this.tk.run(async (trx) => {
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
      const twins = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, dup_of_sucursal: sucursal, dup_of_folio: folio })
        .select('sucursal', 'folio', 'receipt_date', 'oc_folio', 'vale_folio', trx.raw('monto::numeric AS monto'));
      const cedis_twins = twins.map((t: any) => ({ ...t, monto: Number(t.monto) }));
      // RE.13.2 — la cadena de decisiones. El expediente que justifica un pago necesita el
      // recorrido (quién subió, quién devolvió y por qué, quién validó), no el último estado.
      const history = (await this.existeTabla(trx, 'finance', 'goods_receipt_proof_history'))
        ? await trx('finance.goods_receipt_proof_history')
            .where({ tenant_id: tenantId, sucursal, folio })
            .orderBy('changed_at', 'asc')
            .select('status_from', 'status_to', 'motivo_codigo', 'motivo', 'changed_by', 'changed_at')
        : [];
      return { entrada: { ...entrada, monto: Number(entrada.monto) }, lineas, deposits: depSigned, cedis_twins, history };
    });
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
