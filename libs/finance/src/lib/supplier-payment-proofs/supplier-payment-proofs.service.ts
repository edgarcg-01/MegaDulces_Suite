import { Injectable, BadRequestException, ForbiddenException, Logger, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, applySmartSearch } from '@megadulces/platform-core';
import { LlmExtractorService, OcrReadingsService, SupplierPaymentFields } from '@megadulces/platform-core';
import { Knex } from 'knex';
import { esDuenoDelVale, coincidenciasPago, coincidenTodas, diferenciasPago, cuentaEsClave, type IdentidadQueDecide, type CoincidenciasPago } from '@megadulces/contracts';
import { PagosComprobantesGateway } from './pagos-comprobantes.gateway';
import {
  hojaRelegible, motivoDeHoja, tipoLeible, base64De, lecturaSirve, camposQueCambiaron, pasadaVacia,
  type ResultadoRelectura,
} from './relectura.engine';

/**
 * Fase CC (extensión) — Comprobantes de PAGO A PROVEEDOR. Adjunta el comprobante
 * (imagen/PDF) a un pago de Kepler, le corre OCR (mismo shape que la ficha de depósito)
 * y guarda la evidencia en `finance.supplier_payment_proofs` ligada por
 * `(sucursal, doc_prefix, folio)`. El pago vive en DOS doctypes según el método:
 * `XD2601` (transferencia) y `XD2501` (cheque) — el folio NO es único entre ambos, por
 * eso `doc_prefix` es parte de la clave. NO escribe a Kepler: los pagos se leen del
 * espejo `analytics.erp_supplier_payments`. Flujo `recibido → validado | rechazado`.
 */

// `comprobante` = PDF del pago (SPEI/cheque, lo lee el OCR y liga el pago).
// `gasto` = foto(s) de lo comprado (factura/ticket/mercancía) — se valida su total vs el pago.
export const PAYMENT_FILE_ROLES = ['comprobante', 'gasto', 'evidencia_1', 'evidencia_2'] as const;
export type PaymentFileRole = (typeof PAYMENT_FILE_ROLES)[number];
const TOLERANCIA = 1.0; // pesos: |ocr_monto - pago_monto| <= 1 → cuadra (redondeo)
const BANK_TOL = 1.0;   // pesos: |monto comprobante - cargo banco| para casar el movimiento
const BANK_DAYS_BEFORE = 1; // el cargo puede postearse el día del pago o 1 antes
const BANK_DAYS_AFTER = 6;  // …o unos días después

/** `[PC.4]` Lo que lee quien intenta validar o rechazar el comprobante que él mismo adjuntó. */
export const MENSAJE_PROPIO_COMPROBANTE =
  'Este comprobante lo adjuntaste tú: lo tiene que validar otra persona con permiso de gestionar pagos.';

/**
 * `[PC.5]` El BANCO de un pago: de qué cuenta propia salió, según Kepler (`kdm1.c45` ⋈ `kdb1`). Se
 * lee de la vista canónica de tesorería, no de `kdm1` a mano. El doc_tipo de la vista es `X-D-26`;
 * el `doc_prefix` del pago es `XD2601` → letra-letra-número. LATERAL + LIMIT 1: la vista sólo se
 * consulta para los pagos que ya pasaron su filtro, nunca entera. Se usa con el alias `c` del pago.
 */
const LATERAL_BANCO_DEL_PAGO = `LEFT JOIN LATERAL (
    SELECT m.clave_banco, m.banco_nombre, m.account_label
      FROM analytics.kepler_bank_movements m
     WHERE m.tenant_id = c.tenant_id AND m.sucursal = c.sucursal AND m.folio = c.folio
       AND m.doc_tipo = substr(c.doc_prefix, 1, 1) || '-' || substr(c.doc_prefix, 2, 1) || '-' || substr(c.doc_prefix, 3, 2)
       AND m.flujo = 'salida'
     LIMIT 1) kb ON true`;

/** `[PC.6]` Lo que las cuatro coincidencias necesitan del pago de Kepler. */
type PagoParaCoincidir = {
  monto: string | null; pago_dia: string | null; proveedor_nombre: string | null; clave_banco: string | null; account_label: string | null; banco_nombre: string | null;
};

/** `[PC.6]` Quién firma una validación automática. */
export const VALIDADOR_AUTOMATICO = 'Sistema · 4 coincidencias';

/**
 * `[AT.1]` Cuántos comprobantes relee una pasada. Cada uno es una bajada del bucket + una llamada
 * al modelo (segundos), así que el tope es de **tiempo**, no de base: con 25 la pasada cierra
 * holgada dentro de su ventana y el rezago de 1,199 se drena en ~2 días de carril.
 */
export const LOTE_RELECTURA = 25;

/**
 * `[AT.1]` Lecturas vacías SEGUIDAS que abortan la pasada. Separa dos cosas que de otro modo se
 * cuentan igual: *«estos documentos no se entienden»* (disperso) y *«el lector está caído»*
 * (seguido). Sin este freno, un proveedor caído quema el lote entero y lo informa como si los
 * comprobantes fueran ilegibles.
 */
export const ILEGIBLES_SEGUIDAS = 5;

/** Clave de rastreo → alfanumérico (llave determinista de dedup). null si no hay. */
const normRef = (s: unknown): string | null => {
  const d = String(s ?? '').replace(/[^0-9A-Za-z]/g, '');
  return d || null;
};

export interface PaymentFile {
  role: string; url: string; public_id?: string; kind?: string; name?: string; ocr_monto?: number | null;
  /** Hash del contenido: con él `attach` recupera la lectura que hizo el servidor. */
  sha256?: string;
}

export interface ListPaymentsQuery {
  estado?: 'pendiente' | 'con_comprobante' | 'validado' | string;
  from?: string;
  to?: string;
  search?: string;
  metodo?: string;            // 'transferencia' | 'cheque' | 'anticipo' — el TIPO DE DOCUMENTO (c31)
  medio?: string;             // [PP.9] 'caja' | 'banco' | 'puente' | 'sin_declarar' — de dónde SALIÓ el dinero
  alertas?: string | boolean; // 'true' → solo pagos con alerta de control (cuenta ajena / clave repetida)
  limit?: number;
}

export interface AttachPaymentDto {
  sucursal?: string;
  folio?: string;
  doc_prefix?: string; // XD2601 (transferencia) | XD2501 (cheque) — desambigua el folio
  files?: PaymentFile[];
  ocr?: Partial<SupplierPaymentFields> & { ocr_status?: string };
  comentarios?: string;
}

@Injectable()
export class SupplierPaymentProofsService {
  private readonly logger = new Logger(SupplierPaymentProofsService.name);

  /**
   * `[TP.19.3]` ¿Están ya las columnas que ligan un pago con el Calendario (mig `20261016185746`)?
   *
   * ⚠️ **Sólo se cachea el `true`.** Si se guardara el `false`, la liga no aparecería hasta
   * reiniciar la API aunque la migración ya estuviera aplicada — el mismo cuidado que toma
   * `purchase-deliveries.service.ts`, y por la misma razón: una migración se aplica con la API
   * arriba.
   */
  private calendarioOk = false;
  private async calendarioListo(trx: Knex.Transaction): Promise<boolean> {
    if (this.calendarioOk) return true;
    const { rows } = await trx.raw(`
      SELECT EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = to_regclass('finance.payment_allocations')
                        AND attname = 'kepler_payment_folio' AND NOT attisdropped) AS ok`);
    this.calendarioOk = !!rows[0]?.ok;
    return this.calendarioOk;
  }

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
    private readonly readings: OcrReadingsService,
    @Optional() private readonly gateway?: PagosComprobantesGateway,
  ) {}

  /** Empuja un cambio de comprobante a la room del tenant (best-effort; nunca bloquea). */
  private emit(action: 'attached' | 'validated' | 'rejected' | 'bank_matched' | 'bank_unmatched',
    ev: { sucursal: string; doc_prefix: string | null; folio: string; status?: string | null; proveedor?: string | null; monto?: number | null; actor?: string | null }): void {
    try {
      this.gateway?.emitChange(this.tenantCtx.requireTenantId(), {
        action, sucursal: ev.sucursal, doc_prefix: ev.doc_prefix ?? null, folio: ev.folio,
        status: ev.status ?? null, proveedor: ev.proveedor ?? null, monto: ev.monto ?? null, actor: ev.actor ?? null,
      });
    } catch (e: any) { this.logger.warn(`WS emit ${action} falló: ${e?.message || e}`); }
  }

  /**
   * Lista los pagos a proveedor de Kepler (espejo `analytics.erp_supplier_payments`)
   * con el estado de su comprobante adjunto (LEFT JOIN a `finance.supplier_payment_proofs`).
   */
  async listPayments(q: ListPaymentsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 500));
    /**
     * `[PC.8]` Cuánto tarda CADA consulta. En prod la carga de la página tarda 5–6 s y no se pudo
     * reproducir: con 600k documentos sintéticos en kdm1 la consulta tarda ~110 ms (usa el PK por
     * sucursal + c2/c3) y la pantalla pinta en ~1.2 s con la API simulada. El dato que falta es de
     * prod, y viaja en la respuesta (`tiempos_ms` + encabezado `Server-Timing`, visible en DevTools)
     * y en el log cuando la carga pasa de 1 s (el umbral de «no funciona» del proyecto).
     */
    const reloj = Date.now();
    const tiempos: { duplicados: number; filas: number; kpis: number; total: number } = { duplicados: 0, filas: 0, kpis: 0, total: 0 };
    const medir = async <T>(k: 'duplicados' | 'filas' | 'kpis', p: PromiseLike<T>): Promise<T> => {
      const t0 = Date.now(); const r = await p; tiempos[k] = Date.now() - t0; return r;
    };

    const out = await this.tk.run(async (trx) => {
      // Claves de rastreo que aparecen en MÁS DE UN pago vivo → transferencia repetida.
      const dupRefs: string[] = await medir('duplicados', trx('finance.supplier_payment_proofs')
        .where('tenant_id', tenantId).whereNot('status', 'rechazado').whereNotNull('ref_norm')
        .groupBy('ref_norm')
        .havingRaw(`count(distinct doc_prefix || ' ' || sucursal || '/' || folio) > 1`)
        .pluck('ref_norm'));
      const dupSet = new Set(dupRefs);

      const dep = trx('finance.supplier_payment_proofs')
        .select('sucursal', 'doc_prefix', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        // [PC.6] Las marcas y el «lo validó el sistema» del comprobante más reciente.
        .select(trx.raw(`(array_agg(coincidencias ORDER BY created_at DESC))[1] AS last_coincidencias`))
        .select(trx.raw(`(array_agg(auto_validado ORDER BY created_at DESC))[1] AS last_auto`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .select(trx.raw(`bool_or(cuenta_propia = false) AS cuenta_ajena`))
        .select(trx.raw(`array_remove(array_agg(DISTINCT ref_norm) FILTER (WHERE status <> 'rechazado'), NULL) AS refs`))
        .groupBy('sucursal', 'doc_prefix', 'folio')
        .as('d');

      // Pagos con un CARGO del banco ya confirmado (bank_recon_matches). El estado de
      // cuenta es la fuente de verdad de que el dinero salió de una cuenta PROPIA →
      // suprime el falso "cuenta ajena" cuando el OCR leyó mal la cuenta de origen.
      const bank = trx('finance.bank_recon_matches')
        .where('tenant_id', tenantId).whereNotNull('kepler_doc_folio')
        .select('kepler_sucursal', 'kepler_doc_tipo', 'kepler_doc_folio')
        .groupBy('kepler_sucursal', 'kepler_doc_tipo', 'kepler_doc_folio')
        .as('bk');
      const joinBank = (j: any) => { j.on('c.sucursal', 'bk.kepler_sucursal').andOn('c.doc_prefix', 'bk.kepler_doc_tipo').andOn('c.folio', 'bk.kepler_doc_folio'); };

      /**
       * `[TP.19.3]` **De qué día del Calendario salió este pago** (objetivo O3).
       *
       * Hasta aquí esta pantalla mostraba el pago como un hecho sin origen: aparecía en Kepler y
       * nadie podía decir si venía de un día autorizado ni con qué folio de lote. La liga la
       * guarda `finance.payment_allocations` (`kepler_payment_*`).
       *
       * ⛔ **Condicional a propósito.** Esta pantalla está EN USO (1,350 comprobantes medidos) y
       * las columnas llegan con una migración que puede no estar aplicada todavía. Leerlas sin
       * preguntar la tumbaría entera por una función que es un extra. Es el mismo patrón que
       * `purchase-deliveries.service.ts` usa para sus columnas nuevas.
       */
      const conCalendario = await this.calendarioListo(trx);
      const cal = conCalendario
        ? trx('finance.payment_allocations as pa')
            .join('finance.payment_calendar_lots as pl', 'pl.id', 'pa.lot_id')
            .where('pa.tenant_id', tenantId).whereNotNull('pa.kepler_payment_folio')
            .select(
              'pa.kepler_payment_sucursal', 'pa.kepler_payment_doc_prefix', 'pa.kepler_payment_folio',
              'pa.folio as cal_folio', 'pl.lot_date as cal_fecha', 'pl.folio as cal_lote',
            ).as('cal')
        : null;

      const b = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.doc_prefix', 'd.doc_prefix').andOn('c.folio', 'd.folio'); })
        .leftJoin(bank, joinBank)
        .modify((q) => {
          if (!cal) return;
          q.leftJoin(cal, (j: Knex.JoinClause) => {
            j.on('c.sucursal', 'cal.kepler_payment_sucursal')
             .andOn('c.doc_prefix', 'cal.kepler_payment_doc_prefix')
             .andOn('c.folio', 'cal.kepler_payment_folio');
          });
          q.select('cal.cal_folio', 'cal.cal_fecha', 'cal.cal_lote');
        })
        .where('c.tenant_id', tenantId)
        .select(
          'c.sucursal', 'c.folio', 'c.doc_prefix', 'c.metodo_pago', 'c.pago_date', 'c.proveedor_code', 'c.proveedor_nombre',
          'c.proveedor_rfc', 'c.concepto', trx.raw('c.monto::numeric AS monto'),
          // [PP.9] El MEDIO real por el que salió el dinero (caja|banco|puente|sin_declarar).
          // `metodo_pago` es el TIPO DE DOCUMENTO de Kepler (c31) y rotula "transferencia" a
          // 2,684 pagos / $52.27M que salieron en EFECTIVO de la caja general: la pantalla no
          // podía responder "¿cuánto se pagó en efectivo?", que es la pregunta del negocio.
          'c.medio_pago', 'c.cuenta_tesoreria',
          trx.raw('COALESCE(d.n, 0)::int AS deposits'),
          trx.raw('d.last_id AS deposit_id'),
          trx.raw('d.last_status AS deposit_status'),
          trx.raw('COALESCE(d.any_match, false) AS monto_match'),
          // efectivo: ajena SOLO si el OCR no reconoce la cuenta Y no hay cargo bancario confirmado
          trx.raw('(COALESCE(d.cuenta_ajena, false) AND bk.kepler_doc_folio IS NULL) AS cuenta_ajena'),
          trx.raw('d.refs AS refs'),
          trx.raw('d.last_coincidencias AS coincidencias'),
          trx.raw('COALESCE(d.last_auto, false) AS auto_validado'),
        )
        .orderBy('c.pago_date', 'desc')
        .orderBy('c.folio', 'desc')
        .limit(limit);

      if (q.from) b.where('c.pago_date', '>=', q.from);
      if (q.to) b.where('c.pago_date', '<=', q.to);
      if (q.metodo) b.where('c.metodo_pago', q.metodo);
      // [PP.9] Filtro por el MEDIO real. Va aparte del de método a propósito: filtrar
      // "transferencia" seguía devolviendo pagos en efectivo, y no había forma de pedir
      // "mostrame lo que salió de la caja".
      if (q.medio) b.where('c.medio_pago', q.medio);
      if (q.estado === 'pendiente') b.whereRaw('d.n IS NULL');
      if (q.estado === 'con_comprobante') b.whereRaw('d.n > 0');
      if (q.estado === 'validado') b.whereRaw(`d.last_status = 'validado'`);
      // [PC.6] Lo único que espera a una persona: el comprobante más reciente sigue `recibido`
      // (las cuatro coincidencias validan solo lo demás).
      if (q.estado === 'con_diferencias') b.whereRaw(`d.last_status = 'recibido'`);
      // solo alertas de control: cuenta de origen ajena O clave de rastreo repetida
      if (q.alertas === true || q.alertas === 'true') {
        b.whereRaw('((COALESCE(d.cuenta_ajena, false) AND bk.kepler_doc_folio IS NULL) OR d.refs && ?::text[])', [dupRefs]);
      }
      applySmartSearch(b, q.search, {
        columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio'],
        numeric: ['c.monto'],
      });

      const rows = (await medir('filas', b)).map((r: Record<string, unknown>) => {
        const refs: string[] = Array.isArray(r.refs) ? r.refs : [];
        const refDup = refs.some((x) => dupSet.has(x));
        const cuentaAjena = r.cuenta_ajena === true;
        const { refs: _drop, cal_folio: _cf, cal_fecha: _cd, cal_lote: _cl, ...rest } = r;
        // `[TP.19.3]` El origen, cuando lo hay: de qué día autorizado salió este pago y con qué
        // folio. `null` es un estado legítimo y frecuente — la mayoría de los pagos de hoy no
        // nacieron en el Calendario. Se declara ausente, no se inventa (ADR-056).
        const origen = r.cal_folio
          ? { folio: String(r.cal_folio), fecha: r.cal_fecha as string | null, lote: (r.cal_lote as string | null) ?? null }
          : null;
        return { ...rest, monto: Number(r.monto), cuenta_ajena: cuentaAjena, ref_dup: refDup, alerta: cuentaAjena || refDup, origen_calendario: origen };
      });

      const kpiBase = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.doc_prefix', 'd.doc_prefix').andOn('c.folio', 'd.folio'); })
        .leftJoin(bank, joinBank)
        .where('c.tenant_id', tenantId);
      if (q.from) kpiBase.where('c.pago_date', '>=', q.from);
      if (q.to) kpiBase.where('c.pago_date', '<=', q.to);
      if (q.metodo) kpiBase.where('c.metodo_pago', q.metodo);
      const [k] = await medir('kpis', kpiBase.select(
        trx.raw('COUNT(*)::int AS pagos'),
        trx.raw('COUNT(d.n)::int AS con_comprobante'),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validado')::int AS validados`),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validado' AND d.last_auto)::int AS auto_validados`),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='recibido')::int AS con_diferencias`),
        trx.raw('COALESCE(SUM(c.monto::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente'),
        trx.raw('COUNT(*) FILTER (WHERE d.cuenta_ajena AND bk.kepler_doc_folio IS NULL)::int AS cuentas_ajenas'),
      ));

      return {
        kpis: {
          pagos: Number(k.pagos), con_comprobante: Number(k.con_comprobante),
          validados: Number(k.validados), monto_pendiente: Number(k.monto_pendiente),
          auto_validados: Number(k.auto_validados), con_diferencias: Number(k.con_diferencias),
          cuentas_ajenas: Number(k.cuentas_ajenas), refs_duplicadas: dupSet.size,
        },
        rows,
      };
    });
    tiempos.total = Date.now() - reloj;
    if (tiempos.total > 1000) {
      this.logger.warn(`lista de pagos lenta: ${tiempos.total} ms (duplicados ${tiempos.duplicados} · filas ${tiempos.filas} · kpis ${tiempos.kpis}) estado=${q.estado || '-'} desde=${q.from || '-'} buscar=${q.search ? 'sí' : 'no'}`);
    }
    return { ...out, tiempos_ms: tiempos };
  }

  /** Sube UN archivo al bucket. El `comprobante` de pago es **PDF** (SPEI/cheque);
   *  la(s) `gasto`/`evidencia` son FOTOS del gasto (imagen o PDF). */
  async uploadFile(dataUri: string, role = 'comprobante'): Promise<PaymentFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!PAYMENT_FILE_ROLES.includes(role as PaymentFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    const folder = `finance/${tenantId}/supplier-payments`;
    try {
      const f = role === 'comprobante'
        ? await this.storage.putPdf(dataUri, folder)   // comprobante = solo PDF
        : await this.storage.putFile(dataUri, folder);  // foto del gasto = imagen o PDF
      return { role, url: f.key, public_id: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e; // "Solo PDF" (comprobante) / "no configurado"
      this.logger.error(`fallo subiendo ${role}: ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /** Corre OCR. `comprobante` (PDF SPEI/cheque) → campos de pago (liga el pago).
   *  `gasto` (foto de factura/ticket) → se extrae el TOTAL (mapeado a `monto`) para
   *  validar Σ gastos ≈ pago. Preview, no guarda. */
  async runOcr(dataUri: string, role?: string): Promise<SupplierPaymentFields & { ocr_status: string; sha256: string }> {
    const scope = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    // El cliente echa de vuelta este hash al adjuntar, y `attach` recupera con él ESTA
    // lectura en vez de creerle al request. Ver `OcrReadingsService`.
    const sha256 = this.readings.hash(base64);
    const empty: SupplierPaymentFields & { ocr_status: string } = { monto: null, fecha: null, concepto: null, cuenta_origen: null, cuenta_destino: null, beneficiario: null, clave_rastreo: null, banco_destino: null, metodo: null, ocr_status: 'sin_key' };
    if (!process.env.ANTHROPIC_API_KEY) {
      this.readings.remember(scope, sha256, empty, 'sin_key');
      return { ...empty, sha256 };
    }
    if (role === 'gasto') {
      const r = await this.ocr.extractRemision(base64, mediaType); // factura/ticket del gasto
      const any = r.total != null || !!r.folio || !!r.proveedor;
      const campos = { ...empty, monto: r.total, fecha: r.fecha, concepto: r.folio, beneficiario: r.proveedor };
      const ocr_status = any ? 'ok' : 'ilegible';
      this.readings.remember(scope, sha256, campos, ocr_status);
      return { ...campos, ocr_status, sha256 };
    }
    const fields = await this.ocr.extractSupplierPayment(base64, mediaType);
    const any = fields.monto != null || fields.fecha || fields.concepto || fields.clave_rastreo;
    const ocr_status = any ? 'ok' : 'ilegible';
    this.readings.remember(scope, sha256, fields, ocr_status);
    return { ...fields, ocr_status, sha256 };
  }

  /** Crea el registro de evidencia ligado al pago Kepler. Calcula `monto_match`. */
  async attach(dto: AttachPaymentDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim();
    const folio = (dto.folio || '').trim();
    const docPrefix = (dto.doc_prefix || '').trim();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!sucursal || !folio) throw new BadRequestException('sucursal y folio del pago requeridos');
    if (!files.length) throw new BadRequestException('se requiere al menos el comprobante');

    let ev: { sucursal: string; doc_prefix: string | null; folio: string; status: string; proveedor: string | null; monto: number; actor: string | null } | null = null;
    const out = await this.tk.run(async (trx) => {
      const pagoQ = trx('analytics.erp_supplier_payments')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), sucursal, folio });
      if (docPrefix) pagoQ.where('doc_prefix', docPrefix); // desambigua transferencia vs cheque (folio compartido)
      const pago = await pagoQ.first('doc_prefix', 'metodo_pago', 'proveedor_nombre', 'proveedor_rfc', 'pago_date', trx.raw('monto::numeric AS monto'));
      if (!pago) throw new BadRequestException(`pago ${sucursal}/${folio} no existe en el espejo de Kepler`);

      // De `o` salen `monto_match`, el control de cuenta propia y el de clave repetida:
      // la lectura la pone el modelo, no el request. La hoja que liga el pago es la del
      // rol `comprobante` (la de rol `gasto` es la factura que se valida contra él).
      const scope = this.tenantCtx.requireTenantId();
      const hoja = files.find((f) => f.role === 'comprobante' && f.sha256) || files.find((f) => f.sha256);
      const verificada = this.readings.recall<SupplierPaymentFields>(scope, hoja?.sha256);
      const o: Partial<SupplierPaymentFields> & { ocr_status?: string } =
        verificada ? { ...verificada.fields, ocr_status: verificada.status } : (dto.ocr || {});
      if (!verificada && dto.ocr) {
        this.logger.warn(`pago ${sucursal}/${folio}: sin lectura verificada en memoria; se usa la del request`);
      }
      const pagoMonto = Number(pago.monto) || 0;
      const ocrMonto = o.monto != null ? Number(o.monto) : null;
      const montoMatch = ocrMonto != null ? Math.abs(ocrMonto - pagoMonto) <= TOLERANCIA : null;

      // Control: ¿el pago salió de una cuenta de banco PROPIA? (cuenta de origen/retiro)
      const tails = await this.ownBankTails(trx);
      const cuentaPropia = this.isOwnAccount(o.cuenta_origen, tails);

      // Control: ¿la clave de rastreo ya está en otro comprobante vivo? (transferencia repetida)
      const ref = normRef(o.clave_rastreo);
      const refOtros = ref
        ? await trx('finance.supplier_payment_proofs')
            .where('ref_norm', ref)
            .whereNot('status', 'rechazado')
            .whereNot((qb: any) => { qb.where('sucursal', sucursal).andWhere('doc_prefix', pago.doc_prefix).andWhere('folio', folio); })
            .distinct('sucursal', 'doc_prefix', 'folio')
            .then((rs: any[]) => rs.map((r) => `${r.doc_prefix} ${r.sucursal}/${r.folio}`))
        : [];

      // [PC.6] Las cuatro coincidencias y, si pasan todas con una lectura verificada, validado solo.
      const auto = await this.decidirAutomatico(trx, {
        sucursal, docPrefix: pago.doc_prefix || docPrefix, folio,
        lectura: { monto: ocrMonto, fecha: o.fecha, cuenta_origen: o.cuenta_origen, beneficiario: o.beneficiario },
        verificada: !!verificada, ocrStatus: (o.ocr_status as string) || 'manual', refDuplicada: refOtros.length > 0,
      });

      const [row] = await trx('finance.supplier_payment_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          sucursal, folio,
          doc_prefix: pago.doc_prefix || docPrefix || null,
          metodo_pago: pago.metodo_pago || null,
          proveedor_nombre: pago.proveedor_nombre || null,
          proveedor_rfc: pago.proveedor_rfc || null,
          pago_date: pago.pago_date || null,
          pago_monto: pagoMonto,
          files: JSON.stringify(files),
          ocr_monto: ocrMonto,
          ocr_fecha: o.fecha || null,
          ocr_banco: o.banco_destino || null,
          ocr_cuenta_dest: o.cuenta_destino || null,
          ocr_cuenta_origen: o.cuenta_origen || null,
          ocr_concepto: o.concepto || null,
          ocr_referencia: o.clave_rastreo || null,
          ocr_ordenante: o.beneficiario || null,
          ocr_metodo: o.metodo || null,
          ocr_raw: o ? JSON.stringify(o) : null,
          ocr_status: (o.ocr_status as string) || 'manual',
          monto_match: montoMatch,
          cuenta_propia: cuentaPropia,
          comentarios: (dto.comentarios || '').trim() || null,
          created_by: actor || null,
          coincidencias: JSON.stringify(auto.coincidencias),
          lectura_verificada: !!verificada,
          auto_validado: auto.validar,
          ...(auto.validar ? { status: 'validado', validated_by: VALIDADOR_AUTOMATICO, validated_at: trx.fn.now() } : {}),
        })
        .returning(['id', 'sucursal', 'folio', 'status', 'monto_match']);
      this.logger.log(`comprobante adjunto a pago ${sucursal}/${folio} (match=${montoMatch}, cuenta_propia=${cuentaPropia}, ref_dup=${refOtros.length}, auto=${auto.validar}${auto.validar ? '' : ` · ${auto.motivo}`}) por ${actor || '?'}`);
      ev = { sucursal, doc_prefix: pago.doc_prefix || docPrefix || null, folio, status: row.status, proveedor: pago.proveedor_nombre || null, monto: pagoMonto, actor: auto.validar ? VALIDADOR_AUTOMATICO : (actor || null) };
      return {
        ...row, cuenta_propia: cuentaPropia, ref_duplicada: refOtros.length > 0, ref_otros: refOtros,
        coincidencias: auto.coincidencias, auto_validado: auto.validar, diferencias: diferenciasPago(auto.coincidencias),
        motivo_no_automatico: auto.validar ? null : auto.motivo,
      };
    });
    // `ev` se asigna dentro del callback: TS lo estrecha a `null` acá, por eso el cast.
    const evt = ev as { sucursal: string; doc_prefix: string | null; folio: string; status: string; proveedor: string | null; monto: number; actor: string | null } | null;
    if (evt) this.emit(evt.status === 'validado' ? 'validated' : 'attached', evt);
    return out;
  }

  /**
   * `[PC.6]` **¿Este comprobante se valida solo?** Sí, únicamente si TODO esto se cumple:
   *  1. Las **cuatro coincidencias** exactas con el pago de Kepler (banco · fecha · monto ·
   *     proveedor), con la regla de `libs/contracts`.
   *  2. La lectura es **verificada**: el servidor la recuperó por el hash del archivo. Una lectura
   *     que vino en el request se puede alterar → nunca se valida sola.
   *  3. El OCR terminó `ok` (no `manual`, `ilegible` ni `sin_key`).
   *  4. La **clave de rastreo no está en otro pago** vivo (transferencia repetida).
   *  5. El pago **no tiene ya otro comprobante validado** (sería validar dos veces el mismo pago).
   * Si falla algo, el comprobante queda `recibido` y `motivo` dice qué, para la pantalla y el log.
   */
  private async decidirAutomatico(trx: Knex, a: {
    sucursal: string; docPrefix: string; folio: string;
    lectura: { monto: number | null; fecha: string | null | undefined; cuenta_origen: string | null | undefined; beneficiario: string | null | undefined };
    verificada: boolean; ocrStatus: string; refDuplicada: boolean; excluirProofId?: string;
    /** Pago ya leído en lote (`recheck`). `undefined` = leerlo aquí; `null` = no está en Kepler. */
    pago?: PagoParaCoincidir | null;
  }): Promise<{ coincidencias: CoincidenciasPago; validar: boolean; motivo: string }> {
    const pagoK = a.pago !== undefined ? a.pago : await this.pagoParaCoincidir(trx, a.sucursal, a.docPrefix, a.folio);
    const k = coincidenciasPago(a.lectura, pagoK ?? { monto: null });
    const faltan = diferenciasPago(k);
    if (!pagoK) return { coincidencias: k, validar: false, motivo: 'el pago no está en Kepler' };
    if (faltan.length) return { coincidencias: k, validar: false, motivo: `no coincide: ${faltan.join(', ')}` };
    if (!a.verificada) return { coincidencias: k, validar: false, motivo: 'la lectura no es verificada' };
    if (a.ocrStatus !== 'ok') return { coincidencias: k, validar: false, motivo: `OCR ${a.ocrStatus}` };
    if (a.refDuplicada) return { coincidencias: k, validar: false, motivo: 'clave de rastreo en otro pago' };
    const yaValidado = await trx('finance.supplier_payment_proofs')
      .where({ sucursal: a.sucursal, doc_prefix: a.docPrefix, folio: a.folio, status: 'validado' })
      .modify((qb: Knex.QueryBuilder) => { if (a.excluirProofId) qb.whereNot('id', a.excluirProofId); })
      .first('id');
    if (yaValidado) return { coincidencias: k, validar: false, motivo: 'el pago ya tiene un comprobante validado' };
    return { coincidencias: k, validar: coincidenTodas(k), motivo: '' };
  }

  /** `[PC.6]` Lo que las cuatro coincidencias necesitan del pago: monto, día, proveedor y banco. */
  private async pagoParaCoincidir(trx: Knex, sucursal: string, docPrefix: string, folio: string): Promise<PagoParaCoincidir | null> {
    const r = await trx('analytics.erp_supplier_payments as c')
      .joinRaw(LATERAL_BANCO_DEL_PAGO)
      .where({ 'c.tenant_id': this.tenantCtx.requireTenantId(), 'c.sucursal': sucursal, 'c.doc_prefix': docPrefix, 'c.folio': folio })
      .first(trx.raw('c.monto::numeric AS monto'), trx.raw(`to_char(c.pago_date, 'YYYY-MM-DD') AS pago_dia`),
        'c.proveedor_nombre', 'kb.clave_banco', 'kb.account_label', 'kb.banco_nombre');
    return r ?? null;
  }

  /**
   * `[OPS-AUD.4]` **Lo mismo que `pagoParaCoincidir`, para muchos pagos en UNA consulta.**
   * `recheck()` lo llamaba una vez por comprobante (hasta 500, cada 20 min desde el autopiloto):
   * medido en prod el 2026-10-27, **39,000 llamadas × 523 ms = 20,400 s** en ~3 días — la 2ª
   * consulta más cara de `pg-prod`. Llave `sucursal|doc_prefix|folio`; un pago que no vuelve no
   * está en Kepler. ⚠️ Sólo llaves con `doc_prefix`: una tupla con NULL no matchea en un `IN`,
   * mientras que `pagoParaCoincidir` la compara con `IS NULL` — esas se siguen leyendo una por una.
   */
  private async pagosParaCoincidir(trx: Knex, llaves: { sucursal: string; docPrefix: string; folio: string }[]): Promise<Map<string, PagoParaCoincidir>> {
    const out = new Map<string, PagoParaCoincidir>();
    if (!llaves.length) return out;
    const rows: (PagoParaCoincidir & { sucursal: string; doc_prefix: string; folio: string })[] = await trx('analytics.erp_supplier_payments as c')
      .joinRaw(LATERAL_BANCO_DEL_PAGO)
      .where('c.tenant_id', this.tenantCtx.requireTenantId())
      .whereIn(['c.sucursal', 'c.doc_prefix', 'c.folio'], llaves.map((l) => [l.sucursal, l.docPrefix, l.folio]))
      .select('c.sucursal', 'c.doc_prefix', 'c.folio',
        trx.raw('c.monto::numeric AS monto'), trx.raw(`to_char(c.pago_date, 'YYYY-MM-DD') AS pago_dia`),
        'c.proveedor_nombre', 'kb.clave_banco', 'kb.account_label', 'kb.banco_nombre');
    // `.first()` se quedaba con la primera fila: aquí también gana la primera por llave.
    for (const { sucursal, doc_prefix, folio, ...pago } of rows) {
      const k = `${sucursal}|${doc_prefix}|${folio}`;
      if (!out.has(k)) out.set(k, pago);
    }
    return out;
  }

  /**
   * `[PC.6]` **Vuelve a comparar con Kepler los comprobantes con diferencias.** «Arreglar» una
   * diferencia muchas veces es corregir el pago en Kepler (la fecha, el banco): esto recalcula las
   * cuatro coincidencias de cada comprobante `recibido` contra lo que Kepler dice HOY, y valida solo
   * el que ya cumple. Los anteriores a PC.6 (`lectura_verificada` NULL) ganan sus marcas, pero nunca
   * se validan solos.
   */
  async recheck(): Promise<{ revisados: number; validados: number; con_diferencias: number }> {
    this.tenantCtx.requireTenantId();
    const validadosEv: { sucursal: string; doc_prefix: string | null; folio: string; proveedor: string | null; monto: number | null }[] = [];
    const out = await this.tk.run(async (trx) => {
      const pendientes = await trx('finance.supplier_payment_proofs')
        .where('status', 'recibido')
        .orderBy('created_at', 'desc')
        .limit(500)
        .select('id', 'sucursal', 'doc_prefix', 'folio', 'proveedor_nombre', 'ocr_status', 'ref_norm', 'lectura_verificada',
          trx.raw('ocr_monto::numeric AS ocr_monto'), trx.raw(`to_char(ocr_fecha, 'YYYY-MM-DD') AS ocr_fecha`),
          'ocr_cuenta_origen', 'ocr_ordenante', trx.raw('pago_monto::numeric AS pago_monto'));
      let validados = 0;
      // [PC.7] La alerta «cuenta ajena» también se recalcula con la regla vigente (BanBajío lee la
      // cuenta en el CENTRO). Sin migración: con la lectura vieja (sólo «0201») no hay cuenta que
      // reconocer, y eso sigue saliendo como no verificable/ajena hasta que se relea el comprobante.
      const tails = await this.ownBankTails(trx);
      const pagos = await this.pagosParaCoincidir(trx, pendientes
        .filter((p: { doc_prefix: string | null }) => p.doc_prefix != null)
        .map((p: { sucursal: string; doc_prefix: string; folio: string }) => ({ sucursal: p.sucursal, docPrefix: p.doc_prefix, folio: p.folio })));
      for (const p of pendientes) {
        const refDuplicada = p.ref_norm
          ? !!(await trx('finance.supplier_payment_proofs').where('ref_norm', p.ref_norm).whereNot('status', 'rechazado')
              .whereNot((qb: Knex.QueryBuilder) => { qb.where('sucursal', p.sucursal).andWhere('doc_prefix', p.doc_prefix).andWhere('folio', p.folio); })
              .first('id'))
          : false;
        const auto = await this.decidirAutomatico(trx, {
          sucursal: p.sucursal, docPrefix: p.doc_prefix, folio: p.folio,
          lectura: { monto: p.ocr_monto != null ? Number(p.ocr_monto) : null, fecha: p.ocr_fecha, cuenta_origen: p.ocr_cuenta_origen, beneficiario: p.ocr_ordenante },
          verificada: p.lectura_verificada === true, ocrStatus: p.ocr_status, refDuplicada, excluirProofId: p.id,
          pago: p.doc_prefix != null ? (pagos.get(`${p.sucursal}|${p.doc_prefix}|${p.folio}`) ?? null) : undefined,
        });
        await trx('finance.supplier_payment_proofs').where({ id: p.id, status: 'recibido' }).update({
          coincidencias: JSON.stringify(auto.coincidencias), updated_at: trx.fn.now(),
          cuenta_propia: this.isOwnAccount(p.ocr_cuenta_origen, tails),
          ...(auto.validar ? { status: 'validado', auto_validado: true, validated_by: VALIDADOR_AUTOMATICO, validated_at: trx.fn.now() } : {}),
        });
        if (auto.validar) {
          validados++;
          validadosEv.push({ sucursal: p.sucursal, doc_prefix: p.doc_prefix, folio: p.folio, proveedor: p.proveedor_nombre, monto: Number(p.pago_monto) || null });
        }
      }
      this.logger.log(`recheck: ${pendientes.length} revisados, ${validados} validados solos`);
      return { revisados: pendientes.length, validados, con_diferencias: pendientes.length - validados };
    });
    for (const ev of validadosEv) this.emit('validated', { ...ev, status: 'validado', actor: VALIDADOR_AUTOMATICO });
    return out;
  }

  /**
   * `[AT.1]` **Relee el comprobante desde el archivo guardado y lo deja listo para decidir.**
   *
   * `recheck()` vuelve a comparar con Kepler, pero **no puede desbloquear nada**: la guarda 2 de
   * `[PC.6]` exige una lectura verificada, y la verificación vive en memoria (`OcrReadingsService`,
   * 8 h de TTL, se pierde en cada reinicio). Medido en prod el 2026-10-12: de los **1,259**
   * comprobantes `recibido`, **1,199** no tienen lectura verificable, entre ellos los **189 que ya
   * están en 4/4** — o sea que apretar «Volver a comparar» mil veces valida **cero**.
   *
   * Esto baja los bytes del bucket y **el servidor los lee él mismo**. Eso satisface la guarda por
   * su razón de ser (la lectura no la dicta el request) y de hecho con más fuerza que el recuerdo
   * en memoria, porque lo que se lee es la evidencia archivada.
   *
   * ## Cómo falla, que es donde está el riesgo
   *
   * ⛔⛔ `extractSupplierPayment` **se traga sus excepciones y devuelve todos los campos en
   * `null`**: sin API key, con el proveedor caído o con un PDF ilegible el retorno es idéntico.
   * Persistir eso **borraría la lectura guardada** de hasta 1,199 comprobantes y dejaría sus
   * cuatro señales en `sin_dato`. Por eso una lectura vacía no se escribe nunca (`lecturaSirve`),
   * y además hay dos frenos: sin `ANTHROPIC_API_KEY` la pasada **no arranca**, y
   * `ILEGIBLES_SEGUIDAS` ilegibles en fila la **abortan** — que es la diferencia entre *«estos
   * documentos no se entienden»* y *«el lector está caído»*, dos cosas que de otro modo se cuentan
   * igual.
   *
   * ⚠️ La lectura anterior **no se pierde**: queda en `ocr_raw.relectura.anterior` con la fecha y
   * los campos que cambiaron. La huella viaja EN LA FILA, no sólo en un log — una evidencia que se
   * reescribió sola tiene que poder explicar de dónde salió el cambio.
   *
   * ⚠️ El I/O (bucket + modelo) corre **fuera de toda transacción**: son segundos por documento y
   * sostener una transacción abierta mientras tanto frena a quien escribe. Cada fila se guarda en
   * su propia transacción corta, así que una que truene no revierte a las demás.
   *
   * ⛔ Esto NO afloja `[PC.6]`: las cinco guardas siguen mandando y la decisión la sigue tomando
   * el cruce exacto contra Kepler. Una relectura puede DESCALIFICAR a uno que hoy aparenta 4/4.
   */
  async relectura(limite = LOTE_RELECTURA): Promise<ResultadoRelectura> {
    const t0 = Date.now();
    const out = pasadaVacia();
    const validadosEv: { sucursal: string; doc_prefix: string | null; folio: string; proveedor: string | null; monto: number | null }[] = [];

    // ⛔ Sin lector no se arranca. Si se arrancara, las 25 lecturas volverían vacías, las 25
    // contarían como `ilegible` y el latido diría «los comprobantes no se entienden» sobre una
    // variable de entorno que falta. Declararlo cuesta una línea; confundirlo cuesta la cola.
    if (!process.env.ANTHROPIC_API_KEY) {
      out.errores.push('sin ANTHROPIC_API_KEY: no hay con qué releer el comprobante');
      out.ms = Date.now() - t0;
      return out;
    }

    // ⛔⛔ Los que tienen su evidencia en CLOUDINARY no entran al lote, y esto NO es cosmético:
    // el orden del lote es determinista, así que si entraran, las 25 filas serían SIEMPRE las
    // mismas 25 y la cola no avanzaría jamás. Fue exactamente lo que pasó en la primera pasada
    // real (2026-10-12 11:20): `0/25 releidos · sin releer: sin_archivo 25`, los 25 con
    // `Key not found` — porque **1,194 de 1,199** tienen un `public_id` de Cloudinary, no una
    // llave del bucket. Ver `esLlaveDeBucket()` para el error de medición que lo causó.
    //
    // Su rezago se CUENTA aparte (`bloqueados_en_cloudinary`) y se publica en cada latido: se
    // destraba migrando (`migrate-cloudinary-to-bucket.js`), que exige antes habilitar el
    // delivery de PDF en Cloudinary — una acción humana, no código.
    // ⛔⛔ SIN BARRA INVERTIDA, A PROPÓSITO. La primera versión de este predicado usaba
    // `~ '\.[a-zA-Z0-9]{1,8}$'` y **no filtraba nada**: la barra se pierde en el camino de JS a
    // Postgres, así que el motor recibía `.[a-zA-Z0-9]{1,8}$` — «cualquier carácter seguido de
    // alfanuméricos al final», que matchea TODO. Verificado contra prod:
    //
    //     'finance/a/b/uyil38hglpnz7zarmv8g' ~ '.[a-zA-Z0-9]{1,8}$'   →  true   ⛔
    //     'finance/a/b/uyil38hglpnz7zarmv8g' ~ '\.[a-zA-Z0-9]{1,8}$'  →  false  ✅
    //
    // Lo atrapó la prueba negativa («los 1,200 de Cloudinary NO deben pasar»): los 1,200 pasaban.
    // ⭐ El arreglo no es poner más barras —que es volver a depender de cuántas sobrevivan— sino
    // no usar ninguna: la regla «la última parte de la llave tiene extensión» se dice con `LIKE`,
    // que no escapa nada. Toda llave que escribe `ObjectStorageService` es `<carpeta>/<uuid>.<ext>`
    // y un uuid no lleva puntos, así que «el último segmento tiene un punto» es exacto.
    const esBucket = (col: string) => `${col} NOT LIKE 'http%' AND split_part(${col}, '/', -1) LIKE '%.%'`;
    const TIENE_ARCHIVO_PROPIO = `EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(files, '[]'::jsonb)) h
       WHERE h->>'role' = 'comprobante' AND ${esBucket(`(h->>'public_id')`)})`;

    const { lote, bloqueados } = await this.tk.run(async (trx) => {
      const base = () => trx('finance.supplier_payment_proofs')
        .where('status', 'recibido')
        .where((qb: Knex.QueryBuilder) => { qb.whereNull('lectura_verificada').orWhere('lectura_verificada', false); });
      const [{ n }] = await base().whereRaw(`NOT ${TIENE_ARCHIVO_PROPIO}`).count({ n: '*' });
      const filas = await base()
        .whereRaw(TIENE_ARCHIVO_PROPIO)
        .orderByRaw('(coincidencias IS NULL) DESC')
        .orderBy('created_at', 'desc')
        .limit(limite)
      .select('id', 'sucursal', 'doc_prefix', 'folio', 'proveedor_nombre', 'files', 'coincidencias', 'ocr_raw',
        trx.raw('ocr_monto::numeric AS ocr_monto'),
        // ⚠️ Como TEXTO: un `date` de pg serializado se corre un día en hora de México.
        trx.raw(`to_char(ocr_fecha, 'YYYY-MM-DD') AS ocr_fecha`),
        'ocr_cuenta_origen', 'ocr_ordenante', trx.raw('pago_monto::numeric AS pago_monto'));
      return { lote: filas, bloqueados: Number(n) || 0 };
    });
    out.revisados = lote.length;
    out.bloqueados_en_cloudinary = bloqueados;

    let ilegiblesSeguidas = 0;
    for (const p of lote) {
      const hoja = hojaRelegible(p.files);
      // El filtro del lote ya los excluyó; esto es el cinturón: si alguien afloja la consulta,
      // el motivo sale nombrado en vez de contarse como "archivo perdido".
      const veto = motivoDeHoja(hoja);
      // El `!hoja` no es redundante: `veto` no le dice al compilador que `hoja` dejó de ser null.
      if (veto || !hoja) { out.no_relegibles[veto ?? 'sin_hoja']++; continue; }

      let dataUri: string | null = null;
      try {
        dataUri = await this.storage.getDataUri(String(hoja.public_id));
      } catch (e) {
        out.errores.push(`${p.sucursal}/${p.folio}: bucket ${(e as Error)?.message || e}`);
        continue;
      }
      if (!dataUri) { out.no_relegibles.sin_archivo++; continue; }

      const tipo = tipoLeible(dataUri);
      if (!tipo) { out.no_relegibles.tipo_no_leible++; continue; }

      const fresca = await this.ocr.extractSupplierPayment(base64De(dataUri), tipo);
      if (!lecturaSirve(fresca)) {
        out.no_relegibles.ilegible++;
        if (++ilegiblesSeguidas >= ILEGIBLES_SEGUIDAS) {
          out.errores.push(`${ILEGIBLES_SEGUIDAS} lecturas vacías seguidas: el lector no responde (no son los documentos)`);
          break;
        }
        continue;
      }
      ilegiblesSeguidas = 0;

      const cambios = camposQueCambiaron(
        { monto: p.ocr_monto, fecha: p.ocr_fecha, cuenta_origen: p.ocr_cuenta_origen, beneficiario: p.ocr_ordenante },
        { monto: fresca.monto, fecha: fresca.fecha, cuenta_origen: fresca.cuenta_origen, beneficiario: fresca.beneficiario },
      );
      const teniaSenales = p.coincidencias != null;

      try {
        const escrito = await this.tk.run(async (trx) => {
          const ref = normRef(fresca.clave_rastreo);
          const refDuplicada = ref
            ? !!(await trx('finance.supplier_payment_proofs').where('ref_norm', ref).whereNot('status', 'rechazado')
                .whereNot('id', p.id)
                .whereNot((qb: Knex.QueryBuilder) => { qb.where('sucursal', p.sucursal).andWhere('doc_prefix', p.doc_prefix).andWhere('folio', p.folio); })
                .first('id'))
            : false;
          const auto = await this.decidirAutomatico(trx, {
            sucursal: p.sucursal, docPrefix: p.doc_prefix, folio: p.folio,
            lectura: {
              monto: fresca.monto != null ? Number(fresca.monto) : null, fecha: fresca.fecha,
              cuenta_origen: fresca.cuenta_origen, beneficiario: fresca.beneficiario,
            },
            // ⭐ Acá está el desbloqueo: la lectura la produjo el servidor, bajando la evidencia.
            verificada: true, ocrStatus: 'ok', refDuplicada, excluirProofId: p.id,
          });
          const pagoMonto = Number(p.pago_monto) || 0;
          const ocrMonto = fresca.monto != null ? Number(fresca.monto) : null;
          const tails = await this.ownBankTails(trx);
          // ⚠️ `.where(status:'recibido')` otra vez: entre que se leyó el lote y se escribe pudo
          // pasar una persona y validarlo o rechazarlo. Si pasó, esta fila no se toca.
          const n = await trx('finance.supplier_payment_proofs').where({ id: p.id, status: 'recibido' }).update({
            ocr_monto: ocrMonto, ocr_fecha: fresca.fecha || null, ocr_concepto: fresca.concepto || null,
            ocr_cuenta_origen: fresca.cuenta_origen || null, ocr_cuenta_dest: fresca.cuenta_destino || null,
            ocr_ordenante: fresca.beneficiario || null, ocr_referencia: fresca.clave_rastreo || null,
            ocr_banco: fresca.banco_destino || null, ocr_metodo: fresca.metodo || null,
            // ⛔⛔ `ref_norm` NO se escribe: es `GENERATED ALWAYS AS` sobre `ocr_referencia`
            // (verificado en prod), y Postgres rechaza el UPDATE entero con
            // «column "ref_norm" can only be updated to DEFAULT». Se actualiza SOLA al escribir
            // `ocr_referencia`, que sí va arriba.
            //
            // ⭐ Esto costó una pasada completa: la del 2026-10-12 12:01 duró **90,910 ms** —o sea
            // bajó y leyó los 25 comprobantes con el modelo, pagándolos— y después **cada** fila
            // falló al escribir. Trabajo hecho y tirado, 25 veces.
            //
            // ⚠️ Es la misma trampa que el repo ya tenía documentada con la columna `activo`
            // (`GENERATED` + `update({ activo })` = error en runtime que ningún build ve). Que
            // esté en GOTCHAS no alcanza: lo que la atrapa es que el latido mida ENTREGA. Con un
            // `status: ok` por «la pasada terminó», esto se repetía cada 20 minutos en silencio.
            ocr_status: 'ok',
            // La lectura ANTERIOR no se tira: queda con la fecha y qué campos se movieron.
            ocr_raw: JSON.stringify({
              ...fresca,
              ocr_status: 'ok',
              relectura: {
                at: new Date().toISOString(), origen: 'archivo_guardado', cambios,
                anterior: {
                  monto: p.ocr_monto, fecha: p.ocr_fecha,
                  cuenta_origen: p.ocr_cuenta_origen, beneficiario: p.ocr_ordenante,
                },
              },
            }),
            lectura_verificada: true,
            monto_match: ocrMonto != null ? Math.abs(ocrMonto - pagoMonto) <= TOLERANCIA : null,
            cuenta_propia: this.isOwnAccount(fresca.cuenta_origen, tails),
            coincidencias: JSON.stringify(auto.coincidencias),
            updated_at: trx.fn.now(),
            ...(auto.validar ? { status: 'validado', auto_validado: true, validated_by: VALIDADOR_AUTOMATICO, validated_at: trx.fn.now() } : {}),
          });
          return { filas: Number(n) || 0, validado: auto.validar };
        });

        if (!escrito.filas) continue; // alguien decidió primero: ni se cuenta como releído
        out.releidos++;
        if (cambios.length) out.cambiaron++;
        if (!teniaSenales) out.clasificados++;
        if (escrito.validado) {
          out.validados++;
          validadosEv.push({ sucursal: p.sucursal, doc_prefix: p.doc_prefix, folio: p.folio, proveedor: p.proveedor_nombre, monto: Number(p.pago_monto) || null });
        }
      } catch (e) {
        // ⛔ Acumula, no `continue` mudo: una falla que se traga deja la pasada diciendo «ok»
        // con menos trabajo hecho del que informa — la lección de `[OBS.1]`.
        out.errores.push(`${p.sucursal}/${p.folio}: ${(e as Error)?.message || e}`);
      }
    }

    out.ms = Date.now() - t0;
    this.logger.log(`relectura: ${out.releidos}/${out.revisados} releídos, ${out.clasificados} clasificados, ${out.validados} validados solos, ${out.cambiaron} cambiaron`);
    for (const ev of validadosEv) this.emit('validated', { ...ev, status: 'validado', actor: VALIDADOR_AUTOMATICO });
    return out;
  }

  /** Detalle: el pago + sus comprobantes adjuntos (con flags de control + three-way). */
  async detail(sucursal: string, folio: string, docPrefix?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const dp = (docPrefix || '').trim();
    return this.tk.run(async (trx) => {
      const pagoQ = trx('analytics.erp_supplier_payments')
        .where({ tenant_id: tenantId, sucursal, folio });
      if (dp) pagoQ.where('doc_prefix', dp);
      const pago = await pagoQ
        .first('sucursal', 'folio', 'doc_prefix', 'metodo_pago', 'pago_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc', 'concepto', trx.raw('monto::numeric AS monto'));
      if (!pago) throw new BadRequestException('pago no encontrado');
      const depQ = trx('finance.supplier_payment_proofs').where({ sucursal, folio });
      if (dp) depQ.where('doc_prefix', dp);
      const deposits = await depQ
        .orderBy('created_at', 'desc')
        .select('id', 'files', trx.raw('ocr_monto::numeric AS ocr_monto'), 'ocr_fecha', 'ocr_banco', 'ocr_cuenta_dest',
          'ocr_cuenta_origen', 'ocr_concepto', 'ocr_referencia', 'ocr_ordenante', 'ocr_metodo', 'ocr_status',
          'monto_match', 'cuenta_propia', 'ref_norm', 'status', 'coincidencias', 'auto_validado', 'lectura_verificada',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      // URL de lectura prefirmada (bucket privado); legacy Cloudinary (url http) queda igual.
      for (const d of deposits) d.files = await this.storage.signFiles(typeof d.files === 'string' ? JSON.parse(d.files || '[]') : (d.files || []));

      // referencia duplicada (misma clave de rastreo en otro pago)
      const refs = deposits.map((d: any) => d.ref_norm).filter(Boolean)
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
      const otrosPorRef: Record<string, string[]> = {};
      if (refs.length) {
        const otros = await trx('finance.supplier_payment_proofs')
          .whereIn('ref_norm', refs).whereNot('status', 'rechazado')
          .whereNot((qb: any) => { qb.where('sucursal', sucursal).andWhere('folio', folio).andWhere('doc_prefix', pago.doc_prefix); })
          .distinct('ref_norm', 'sucursal', 'doc_prefix', 'folio')
          .select('ref_norm', 'sucursal', 'doc_prefix', 'folio');
        for (const r of otros) (otrosPorRef[r.ref_norm] ||= []).push(`${r.doc_prefix} ${r.sucursal}/${r.folio}`);
      }

      // three-way: conciliación persistida + candidatos de cargo en banco
      const matched = await this.linkedBankMovements(trx, pago.doc_prefix, sucursal, folio);
      const conciliado = matched.length > 0;

      // descuentos/apoyos que explican el delta factura vs pago (X-D-40/X-D-55 del proveedor)
      const adjustments = await this.relatedAdjustments(trx, pago);

      const enriched = [] as any[];
      for (const d of deposits) {
        const otros = d.ref_norm ? otrosPorRef[d.ref_norm] || [] : [];
        const cand = conciliado ? { estado: 'confirmado' as const, movimientos: [] } : await this.bankMatch(trx, {
          cuenta_origen: d.ocr_cuenta_origen,
          monto: d.ocr_monto != null ? Number(d.ocr_monto) : Number(pago.monto),
          fecha: d.ocr_fecha || pago.pago_date,
        });
        // Cargo confirmado en el banco ⇒ el dinero salió de una cuenta PROPIA (el estado
        // de cuenta manda). Suprime el falso "cuenta ajena" que dejó un OCR que leyó mal
        // la cuenta de origen (p.ej. 5712 → 7712); la caja verde del banco lo explica.
        const cuentaPropiaEff = (conciliado && d.cuenta_propia === false) ? null : d.cuenta_propia;
        enriched.push({
          ...d, cuenta_propia: cuentaPropiaEff,
          ref_duplicada: otros.length > 0, ref_otros: otros,
          banco: { conciliado, estado: cand.estado, matched, candidatos: cand.movimientos },
        });
      }
      return { pago: { ...pago, monto: Number(pago.monto) }, deposits: enriched, adjustments };
    });
  }

  /**
   * Descuentos y apoyos del proveedor que explican por qué el banco pagó ≠ factura:
   * notas de crédito (X-D-55) y devoluciones de compra (X-D-40) de Kepler
   * (`analytics.erp_purchase_adjustments`, RE.10). Liga por `proveedor_code` (fallback
   * nombre) en una ventana alrededor de la fecha del pago; marca `factura_match` cuando
   * la factura de la nota coincide con algún folio del concepto del pago. NO es cuadre al
   * peso — es el contexto que /compras/descuentos ya contabiliza. Read-only.
   */
  private async relatedAdjustments(trx: any, pago: any) {
    const tenantId = this.tenantCtx.requireTenantId();
    const code = (pago.proveedor_code || '').trim();
    const nombre = (pago.proveedor_nombre || '').trim();
    if (!code && !nombre) return { rows: [], total_monto: 0, total_factura: 0, deep_link_q: null };
    // folios de factura del concepto del pago ("F 906 907" → ['906','907'])
    const tokens = String(pago.concepto || '').match(/\d{2,}/g) || [];
    const WINDOW = 60; // días alrededor del pago (la nota puede emitirse antes o después)
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const q = trx('analytics.erp_purchase_adjustments')
      .where('tenant_id', tenantId)
      .select('doctype', 'adjustment_date', 'factura_ref', 'motivo', 'categoria',
        trx.raw('monto::numeric AS monto'))
      .orderBy('adjustment_date', 'desc')
      .limit(25);
    if (code) q.where('proveedor_code', code);
    else q.whereRaw('proveedor_nombre ILIKE ?', [nombre]);
    if (pago.pago_date) {
      const base = new Date(pago.pago_date);
      if (!isNaN(base.getTime())) {
        const from = new Date(base); from.setDate(from.getDate() - WINDOW);
        const to = new Date(base); to.setDate(to.getDate() + WINDOW);
        q.whereBetween('adjustment_date', [iso(from), iso(to)]);
      }
    }
    const rows = (await q).map((r: any) => {
      const hay = `${r.factura_ref || ''} ${r.motivo || ''}`;
      const facturaMatch = tokens.length > 0 && tokens.some((t) => hay.includes(t));
      return { ...r, monto: Number(r.monto) || 0, factura_match: facturaMatch };
    }).sort((a: any, b: any) => Number(b.factura_match) - Number(a.factura_match));
    const total = rows.reduce((s: number, r: any) => s + r.monto, 0);
    const totalFactura = rows.filter((r: any) => r.factura_match).reduce((s: number, r: any) => s + r.monto, 0);
    return { rows, total_monto: total, total_factura: totalFactura, deep_link_q: nombre || code };
  }

  /**
   * FICHA-FIRST — dado el OCR de un comprobante (monto + fecha + concepto), busca el
   * pago de Kepler que le corresponde. El `concepto` (folio de factura "F 451") casa
   * contra el `concepto` del pago; el monto es la señal fuerte. Prioriza sin comprobante.
   */
  /**
   * `[PC.5]` Cada candidato trae también su BANCO (`clave_banco`, `banco_nombre`, `account_label`)
   * para que la pantalla compare banco · fecha · monto · proveedor contra lo que leyó la IA. La
   * búsqueda sigue siendo amplia (±$1, ±7 días): encontrar candidatos no es lo mismo que darlos
   * por buenos — eso lo decide la regla `clasificar` de la pantalla, con coincidencia exacta.
   */
  async matchPaymentsByOcr(q: { monto?: number; fecha?: string; concepto?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const target = q.monto != null ? Number(q.monto) : NaN;
    if (!isFinite(target) || target <= 0) return { pagos: [] };
    const limit = Math.min(20, Math.max(1, Number(q.limit) || 12));
    // tokens del concepto (folios de factura): "F 906 907 908" → ['906','907','908']
    const tokens = String(q.concepto || '').match(/\d{2,}/g) || [];
    return this.tk.run(async (trx) => {
      const dep = trx('finance.supplier_payment_proofs')
        .select('sucursal', 'doc_prefix', 'folio').count('* as n')
        .groupBy('sucursal', 'doc_prefix', 'folio').as('d');
      const b = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.doc_prefix', 'd.doc_prefix').andOn('c.folio', 'd.folio'); })
        .joinRaw(LATERAL_BANCO_DEL_PAGO) // [PC.5] el banco del pago, para las cuatro coincidencias
        .where('c.tenant_id', tenantId)
        .whereRaw('c.monto BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
        .select('c.sucursal', 'c.folio', 'c.doc_prefix', 'c.metodo_pago', 'c.pago_date', 'c.proveedor_code',
          'c.proveedor_nombre', 'c.proveedor_rfc', 'c.concepto', trx.raw('c.monto::numeric AS monto'),
          trx.raw('COALESCE(d.n,0)::int AS deposits'),
          // El día como texto: un `date` de pg llega como Date en UTC y se corre un día (LC.16).
          trx.raw(`to_char(c.pago_date, 'YYYY-MM-DD') AS pago_dia`),
          'kb.clave_banco', 'kb.banco_nombre', 'kb.account_label')
        .orderByRaw('COALESCE(d.n,0) ASC')
        .orderBy('c.pago_date', 'desc')
        .limit(limit);
      const base = q.fecha ? new Date(q.fecha) : null;
      if (base && !isNaN(base.getTime())) {
        const from = new Date(base); from.setDate(from.getDate() - 7);
        const to = new Date(base); to.setDate(to.getDate() + 7);
        b.whereBetween('c.pago_date', [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
      }
      const pagos = (await b).map((r: any) => {
        // boost: el concepto del pago contiene alguno de los folios de la ficha
        const conc = String(r.concepto || '');
        const conceptoMatch = tokens.length > 0 && tokens.some((t) => conc.includes(t));
        return { ...r, monto: Number(r.monto), concepto_match: conceptoMatch };
      }).sort((a: any, b2: any) => Number(b2.concepto_match) - Number(a.concepto_match));
      return { pagos };
    });
  }

  /**
   * `[PC.4]` **Nadie valida ni rechaza el comprobante que él mismo adjuntó.** Misma regla que
   * GX.65.4a en gastos (`esDuenoDelVale`, en `libs/contracts`), una sola guarda para las dos
   * decisiones. Con la captura por lote ([PC.3]) entran más comprobantes más rápido, y sin esto
   * quien captura con permiso de gestionar se los valida solo.
   *
   * ⛔ También el RECHAZO: un comprobante rechazado sale de los controles (la clave de rastreo
   * repetida ignora los rechazados), así que rechazarse el propio sería una forma de esconder
   * una alerta.
   *
   * ⛔ Sin identidad NO pasa. El token no trae `full_name`: el nombre se lee del padrón, porque
   * `created_by` se guarda como `full_name || username` (el bug que encontró GX.65.4a).
   * Si el comprobante no existe no se dice nada aquí: cada método responde «no encontrado».
   */
  private async asegurarQueNoEsSuyo(trx: Knex, id: string, quien?: IdentidadQueDecide): Promise<void> {
    if (!quien || (!String(quien.username ?? '').trim() && !String(quien.full_name ?? '').trim())) {
      throw new ForbiddenException('No se pudo identificar quién decide sobre el comprobante.');
    }
    const proof = await trx('finance.supplier_payment_proofs').where({ id }).first('created_by');
    if (!proof) return;
    let nombre = String(quien.full_name ?? '').trim();
    const usuario = String(quien.username ?? '').trim();
    if (!nombre && usuario) {
      const u = await trx('users')
        .where({ tenant_id: this.tenantCtx.requireTenantId() })
        .whereRaw('lower(username) = lower(?)', [usuario])
        .first('nombre');
      nombre = String(u?.nombre ?? '').trim();
    }
    if (esDuenoDelVale({ created_by: proof.created_by }, { username: usuario, full_name: nombre })) {
      throw new ForbiddenException(MENSAJE_PROPIO_COMPROBANTE);
    }
  }

  /** El revisor valida la evidencia. Auditado. */
  async validate(id: string, actor?: string, quien?: IdentidadQueDecide): Promise<{ id: string; status: string }> {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run(async (trx) => {
      await this.asegurarQueNoEsSuyo(trx, id, quien);
      const [r] = await trx('finance.supplier_payment_proofs').where({ id }).whereIn('status', ['recibido', 'rechazado'])
        .update({ status: 'validado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null, updated_at: trx.fn.now() })
        .returning(['id', 'status', 'sucursal', 'doc_prefix', 'folio', 'proveedor_nombre', 'pago_monto']);
      if (!r) throw new BadRequestException('evidencia no encontrada o ya validada');
      return r;
    });
    this.emit('validated', { sucursal: row.sucursal, doc_prefix: row.doc_prefix, folio: row.folio, status: row.status, proveedor: row.proveedor_nombre, monto: Number(row.pago_monto) || null, actor: actor || null });
    return { id: row.id, status: row.status };
  }

  /** Rechaza (con motivo). Auditado. */
  async reject(id: string, actor?: string, motivo?: string, quien?: IdentidadQueDecide): Promise<{ id: string; status: string }> {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run(async (trx) => {
      await this.asegurarQueNoEsSuyo(trx, id, quien);
      const [r] = await trx('finance.supplier_payment_proofs').where({ id }).whereIn('status', ['recibido', 'validado'])
        .update({ status: 'rechazado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status', 'sucursal', 'doc_prefix', 'folio', 'proveedor_nombre', 'pago_monto']);
      if (!r) throw new BadRequestException('evidencia no encontrada o ya rechazada');
      return r;
    });
    this.emit('rejected', { sucursal: row.sucursal, doc_prefix: row.doc_prefix, folio: row.folio, status: row.status, proveedor: row.proveedor_nombre, monto: Number(row.pago_monto) || null, actor: actor || null });
    return { id: row.id, status: row.status };
  }

  /**
   * Three-way match: busca en el estado de cuenta (finance.bank_movements) el CARGO
   * real (amount_out) de este pago — por cuenta de origen propia + monto (tol $1) +
   * fecha cercana. Prueba que el dinero SALIÓ. Read-only.
   */
  private async bankMatch(
    trx: any,
    dep: { cuenta_origen?: string | null; monto?: number | null; fecha?: string | Date | null },
  ): Promise<{ estado: 'confirmado' | 'multiple' | 'sin_match' | 'sin_dato'; movimientos: any[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const target = dep.monto != null ? Number(dep.monto) : NaN;
    if (!isFinite(target) || target <= 0 || !dep.fecha) return { estado: 'sin_dato', movimientos: [] };
    const base = new Date(dep.fecha as any);
    if (isNaN(base.getTime())) return { estado: 'sin_dato', movimientos: [] };
    const from = new Date(base); from.setDate(from.getDate() - BANK_DAYS_BEFORE);
    const to = new Date(base); to.setDate(to.getDate() + BANK_DAYS_AFTER);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const acctId = await this.findOwnAccountId(trx, dep.cuenta_origen);

    const q = trx('finance.bank_movements as m')
      .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
      .leftJoin('finance.movement_categories as cat', 'cat.id', 'm.category_id')
      .where('m.tenant_id', tenantId)
      .whereRaw('m.amount_out BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
      .whereBetween('m.movement_date', [iso(from), iso(to)])
      .select('m.id', 'm.movement_date', trx.raw('m.amount_out::numeric AS amount_out'),
        'm.concept', 'a.bank', 'a.account_label', trx.raw('cat.code AS categoria'))
      .orderBy('m.movement_date', 'asc').limit(6);
    if (acctId) q.where('m.bank_account_id', acctId);
    const movimientos = (await q).map((r: any) => ({ ...r, amount_out: Number(r.amount_out) }));
    const estado = movimientos.length === 1 ? 'confirmado' : movimientos.length > 1 ? 'multiple' : 'sin_match';
    return { estado, movimientos };
  }

  /** Cargos ya ligados a este pago (bank_recon_matches, kepler_doc_tipo = doc_prefix). */
  private async linkedBankMovements(trx: any, docPrefix: string, sucursal: string, folio: string): Promise<any[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const recon = await trx('finance.bank_recon_matches')
      .where({ tenant_id: tenantId, kepler_doc_tipo: docPrefix, kepler_doc_folio: folio, kepler_sucursal: sucursal })
      .select('bank_movement_id', 'match_type', 'matched_by', 'created_at', trx.raw('kepler_amount::numeric AS kepler_amount'));
    if (!recon.length) return [];
    const byId = new Map(recon.map((r: any) => [r.bank_movement_id, r]));
    const movs = await trx('finance.bank_movements as m')
      .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
      .where('m.tenant_id', tenantId)
      .whereIn('m.id', recon.map((r: any) => r.bank_movement_id))
      .select('m.id', 'm.movement_date', trx.raw('m.amount_out::numeric AS amount_out'), 'm.concept', 'a.bank', 'a.account_label');
    return movs.map((m: any) => {
      const r: any = byId.get(m.id) || {};
      return { ...m, amount_out: Number(m.amount_out), match_type: r.match_type, matched_by: r.matched_by, matched_at: r.created_at, kepler_amount: r.kepler_amount != null ? Number(r.kepler_amount) : null };
    });
  }

  /** El revisor confirma que un cargo del banco corresponde a este pago. Persiste en CB. */
  async confirmBank(proofId: string, bankMovementId: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!bankMovementId) throw new BadRequestException('bank_movement_id requerido');
    let ev: { sucursal: string; doc_prefix: string | null; folio: string; monto: number; actor: string | null } | null = null;
    const out = await this.tk.run(async (trx) => {
      const p = await trx('finance.supplier_payment_proofs').where({ id: proofId })
        .first('sucursal', 'doc_prefix', 'folio', trx.raw('pago_monto::numeric AS pago_monto'));
      if (!p) throw new BadRequestException('comprobante no encontrado');
      const mov = await trx('finance.bank_movements').where({ id: bankMovementId }).first('id', trx.raw('amount_out::numeric AS amount_out'));
      if (!mov) throw new BadRequestException('movimiento bancario no encontrado');
      const pagoMonto = Number(p.pago_monto) || 0;
      const matchType = Math.abs(Number(mov.amount_out) - pagoMonto) <= BANK_TOL ? 'exact' : 'manual';
      await trx('finance.bank_recon_matches')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          bank_movement_id: bankMovementId,
          kepler_sucursal: p.sucursal, kepler_doc_tipo: p.doc_prefix, kepler_doc_folio: p.folio,
          kepler_cuenta: '102', kepler_amount: pagoMonto,
          match_type: matchType, match_confidence: matchType === 'exact' ? 1 : 0.5, matched_by: actor || null,
        })
        .onConflict(['tenant_id', 'bank_movement_id', 'kepler_doc_tipo', 'kepler_doc_folio'])
        .merge({ kepler_amount: pagoMonto, match_type: matchType, matched_by: actor || null });
      await trx('finance.bank_movements').where({ id: bankMovementId }).update({ recon_status: 'matched', updated_at: trx.fn.now() });
      this.logger.log(`pago ${p.doc_prefix} ${p.sucursal}/${p.folio} conciliado con cargo ${bankMovementId} (${matchType}) por ${actor || '?'}`);
      ev = { sucursal: p.sucursal, doc_prefix: p.doc_prefix, folio: p.folio, monto: pagoMonto, actor: actor || null };
      return { ok: true, pago: `${p.doc_prefix} ${p.sucursal}/${p.folio}`, bank_movement_id: bankMovementId, match_type: matchType };
    });
    if (ev) this.emit('bank_matched', ev);
    return out;
  }

  /** Deshace la conciliación pago↔cargo. */
  async unlinkBank(proofId: string, bankMovementId: string) {
    this.tenantCtx.requireTenantId();
    let ev: { sucursal: string; doc_prefix: string | null; folio: string } | null = null;
    const out = await this.tk.run(async (trx) => {
      const p = await trx('finance.supplier_payment_proofs').where({ id: proofId }).first('sucursal', 'doc_prefix', 'folio');
      if (!p) throw new BadRequestException('comprobante no encontrado');
      await trx('finance.bank_recon_matches')
        .where({ kepler_doc_tipo: p.doc_prefix, kepler_doc_folio: p.folio, kepler_sucursal: p.sucursal, bank_movement_id: bankMovementId }).del();
      const [rest] = await trx('finance.bank_recon_matches').where({ bank_movement_id: bankMovementId }).count('* as n');
      if (Number(rest.n) === 0) await trx('finance.bank_movements').where({ id: bankMovementId }).update({ recon_status: 'pending', updated_at: trx.fn.now() });
      ev = { sucursal: p.sucursal, doc_prefix: p.doc_prefix, folio: p.folio };
      return { ok: true };
    });
    if (ev) this.emit('bank_unmatched', { ...(ev as { sucursal: string; doc_prefix: string | null; folio: string }) });
    return out;
  }

  /**
   * ID de la cuenta de banco propia que corresponde a la cuenta de origen.
   * `[PC.7]` Se lee con `cuentaEsClave` (libs/contracts): en BanBajío la clave va en el CENTRO del
   * número (`2457` + `6506` + `0201`); comparar por el final no reconocía ninguna cuenta Bajío.
   */
  private async findOwnAccountId(trx: Knex, cuenta?: string | null): Promise<string | null> {
    if (!String(cuenta ?? '').replace(/\D/g, '')) return null;
    const accts: { id: string; bank: string; account_label: string }[] = await trx('finance.bank_accounts')
      .where({ tenant_id: this.tenantCtx.requireTenantId(), kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`).select('id', 'bank', 'account_label');
    // La etiqueta más larga primero: `4166` antes que un `166` que también calzaría.
    const hit = accts.sort((a, b) => b.account_label.length - a.account_label.length)
      .find((a) => cuentaEsClave(cuenta, a.account_label, a.bank));
    return hit ? hit.id : null;
  }

  /** Cuentas de banco propias (banco + etiqueta: el banco decide cómo se lee el número). */
  private async ownBankTails(trx: Knex): Promise<{ bank: string; account_label: string }[]> {
    return trx('finance.bank_accounts')
      .where({ tenant_id: this.tenantCtx.requireTenantId(), kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`).select('bank', 'account_label');
  }

  /**
   * ¿La cuenta de origen del pago es una cuenta propia? null = no verificable.
   * `[PC.7]` Antes comparaba por el final y TODA cuenta BanBajío (`…0201`) salía «cuenta ajena».
   */
  private isOwnAccount(cuenta: unknown, tails: { bank: string; account_label: string }[]): boolean | null {
    const c = String(cuenta ?? '');
    if (!c.replace(/\D/g, '') || !tails.length) return null;
    return tails.some((t) => cuentaEsClave(c, t.account_label, t.bank));
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
