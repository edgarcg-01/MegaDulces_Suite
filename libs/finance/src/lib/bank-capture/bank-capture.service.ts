import * as crypto from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  CloudinaryService,
  ObjectStorageService,
  LlmExtractorService,
  normalizeMxPhone,
} from '@megadulces/platform-core';
import {
  FINANCE_NOTIFIER_PORT,
  type FinanceNotifierPort,
  type BankCaptureSender,
  type BankCaptureResult,
} from '@megadulces/contracts';

/**
 * Fase CBW (ADR-042) — Captura bancaria por WhatsApp.
 *
 * Un remitente autorizado (encargado de plaza) manda la foto de una ficha de
 * depósito. Este servicio: sube el archivo a Cloudinary, corre OCR
 * (extractDepositSlip), resuelve la cuenta y deja la captura en STAGING
 * (`finance.bank_capture_inbox`, estado `pendiente_confirmacion`). NUNCA escribe
 * en `finance.bank_movements` (ADR-042: la foto es comprobante, no asiento).
 *
 * El humano confirma en el chat (CBW.3) y luego valida/cuadra en /finanzas/bancos.
 * Al confirmar se avisa a Crédito y Cobranza (best-effort, FINANCE_NOTIFIER_PORT).
 */
@Injectable()
export class BankCaptureService {
  private readonly logger = new Logger(BankCaptureService.name);
  private readonly TENANT = '00000000-0000-0000-0000-00000000d01c';

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /** ¿Teléfono en la allowlist activa? Da identidad para atribuir (o null = no autorizado). */
  async resolveSender(phone: string): Promise<BankCaptureSender | null> {
    const canonical = normalizeMxPhone(phone) || phone;
    return this.tk.run(async (trx) => {
      const row = await trx('finance.bank_capture_senders')
        .where({ phone: canonical, active: true })
        .first('id', 'full_name', 'sucursal', 'default_bank_account_id', 'customer_code', 'rfc');
      if (!row) return null;
      return {
        id: row.id,
        full_name: row.full_name,
        sucursal: row.sucursal ?? null,
        default_bank_account_id: row.default_bank_account_id ?? null,
        customer_code: row.customer_code ?? null,
        rfc: row.rfc ?? null,
      };
    });
  }

  /** Sube + OCR + resuelve cuenta + inserta captura en staging. Devuelve el texto a responder. */
  async capture(input: {
    fromPhone: string;
    sender: BankCaptureSender;
    waMessageId: string;
    fileBase64: string;
    mime: string;
    caption?: string | null;
    source?: 'whatsapp' | 'web';
  }): Promise<BankCaptureResult> {
    const source = input.source ?? 'whatsapp';
    // from_phone es NOT NULL → para web queda '' (no hay teléfono). El resto igual.
    const phone = normalizeMxPhone(input.fromPhone) || input.fromPhone || '';
    const mediaType = this.coerceMediaType(input.mime);
    let errorDetail: string | null = null;

    // 1) Railway Bucket (WhatsApp manda imagen o PDF → putFile acepta ambos). Defensivo:
    //    si no sube, guardamos la captura igual (con el error) — no se pierde la evidencia.
    //    url = key (placeholder); la lectura la firma (signFiles).
    let files: Array<{ url: string; public_id: string; kind: string }> = [];
    try {
      const up = await this.storage.putFile(
        `data:${mediaType};base64,${input.fileBase64}`,
        `finance/${this.TENANT}/bank-captures`,
      );
      files = [{ url: up.key, public_id: up.key, kind: up.kind }];
    } catch (e: any) {
      this.logger.error(`Storage falló: ${e?.message}`);
      errorDetail = 'No se pudo subir el archivo (almacenamiento). Reenviar.';
    }

    // 2) OCR de la ficha. Nunca lanza (el extractor degrada), pero lo blindamos igual.
    let fields: any = {};
    try {
      fields = await this.ocr.extractDepositSlip(input.fileBase64, mediaType);
    } catch (e: any) {
      this.logger.error(`OCR falló: ${e?.message}`);
      errorDetail = errorDetail || 'No se pudo leer la imagen (OCR).';
    }
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    const ocrStatus = !hasKey ? 'sin_key' : fields.monto != null ? 'ok' : 'ilegible';

    // 2b) ¿Es realmente un comprobante? Sin monto NI banco NI referencia → no válido.
    const looksInvalid = ocrStatus === 'ilegible' && !fields.banco && !fields.referencia && !fields.cuenta_dest;
    if (looksInvalid && !errorDetail) errorDetail = 'La imagen no parece un comprobante de depósito.';

    // 3) Resolver la cuenta: OCR (banco + últimos 4) → catálogo; fallback al remitente.
    let bankAccountId: string | null = null;
    try {
      bankAccountId = await this.resolveAccount(fields.cuenta_dest, input.sender.default_bank_account_id);
    } catch (e: any) {
      this.logger.warn(`resolveAccount falló: ${e?.message}`);
    }

    // 4) Insertar la captura en staging (SIEMPRE — aunque haya error, para no perderla).
    const concept = [input.sender.full_name, fields.ordenante].filter(Boolean).join(' — ') || 'Depósito WhatsApp';
    const amountIn = Number(fields.monto) > 0 ? Number(fields.monto) : 0;
    let captureId: string | null = null;
    try {
      captureId = await this.tk.run(async (trx) => {
        const [row] = await trx('finance.bank_capture_inbox')
          .insert({
            tenant_id: this.tenantId(),
            source,
            from_phone: phone,
            sender_id: input.sender.id,
            wa_message_id: input.waMessageId,
            files: JSON.stringify(files),
            ocr_monto: fields.monto ?? null,
            ocr_fecha: fields.fecha ?? null,
            ocr_banco: fields.banco ?? null,
            ocr_cuenta_dest: fields.cuenta_dest ?? null,
            ocr_referencia: fields.referencia ?? null,
            ocr_ordenante: fields.ordenante ?? null,
            ocr_metodo: fields.metodo ?? null,
            ocr_raw: JSON.stringify(fields ?? {}),
            ocr_status: ocrStatus,
            bank_account_id: bankAccountId,
            sucursal: input.sender.sucursal,
            // CBW.6 — cobranza dura: el depósito queda atribuido al cliente que lo mandó.
            customer_code: input.sender.customer_code,
            rfc: input.sender.rfc,
            concept,
            amount_in: amountIn,
            amount_out: 0,
            movement_date: fields.fecha ?? null,
            // CBW.5: sin SÍ/NO — la foto entra directa a la bandeja como "por validar".
            // Cobranza es el único gate humano (valida → materializa en el libro).
            status: 'confirmado',
            error_detail: errorDetail,
          })
          .onConflict(['tenant_id', 'wa_message_id'])
          .merge({ updated_at: trx.fn.now() }) // reenvío del mismo mensaje = idempotente
          .returning('id');
        return (row?.id as string) ?? null;
      });
    } catch (e: any) {
      // Falla al guardar la captura misma: avisamos a Cobranza y respondemos honesto.
      this.logger.error(`No se pudo guardar la captura: ${e?.message}`);
      await this.notifyError('No se pudo guardar una captura de depósito por WhatsApp', 0, input.sender.sucursal);
      return { reply: '⚠️ Recibí tu comprobante pero tuve un problema al guardarlo. Un compañero de Crédito y Cobranza fue avisado. Puedes reenviarlo en un momento.', capture_id: null };
    }

    // 5) Avisar a Crédito y Cobranza: cada depósito nuevo (o con problema) llega a la bandeja.
    if (errorDetail) {
      await this.notifyError(`Captura con problema: ${errorDetail}`, amountIn, input.sender.sucursal);
    } else if (captureId) {
      await this.notifyCobranza({ id: captureId, amount_in: amountIn, sucursal: input.sender.sucursal, ocr_banco: fields.banco ?? null });
    }

    return { reply: this.buildAckReply(fields, ocrStatus, errorDetail), capture_id: captureId };
  }

  /**
   * CBW.8 — Subida WEB de una ficha (sin WhatsApp): mismo pipeline que `capture()`
   * (storage + OCR + staging + aviso a Cobranza), atribuida a un remitente existente
   * o a una sucursal/cuenta capturada a mano. Canal vivo que no depende del BSP.
   */
  async captureWeb(input: {
    fileBase64: string;
    mime: string;
    sender_id?: string | null;
    sucursal?: string | null;
    bank_account_id?: string | null;
    caption?: string | null;
  }): Promise<BankCaptureResult> {
    if (!input.fileBase64) throw new BadRequestException('file_base64 requerido');
    let sender: BankCaptureSender;
    if (input.sender_id) {
      const found = await this.tk.run((trx) =>
        trx('finance.bank_capture_senders').where({ id: input.sender_id }).first());
      if (!found) throw new BadRequestException('remitente no encontrado');
      sender = found as BankCaptureSender;
    } else {
      // Remitente sintético: sin fila en la allowlist (sender_id = null), atribución
      // por sucursal/cuenta elegida en la subida. El OCR resuelve el banco de la ficha.
      sender = {
        id: null,
        full_name: 'Captura web',
        sucursal: input.sucursal ?? null,
        default_bank_account_id: input.bank_account_id ?? null,
        customer_code: null,
        rfc: null,
      } as unknown as BankCaptureSender;
    }
    return this.capture({
      fromPhone: '',
      sender,
      waMessageId: `web:${crypto.randomUUID()}`,
      fileBase64: input.fileBase64,
      mime: input.mime || 'image/jpeg',
      caption: input.caption ?? null,
      source: 'web',
    });
  }

  // ── Bandeja / backend (CBW.4) ──────────────────────────────────────────────

  /** Lista las capturas con filtros + KPIs por estado (para /finanzas/bancos › Capturas WhatsApp). */
  async list(q: { status?: string; from?: string; to?: string; search?: string; limit?: number }): Promise<{ rows: any[]; kpis: any }> {
    return this.tk.run(async (trx) => {
      const base = trx('finance.bank_capture_inbox as i')
        .leftJoin('finance.bank_capture_senders as s', 's.id', 'i.sender_id')
        .leftJoin('finance.bank_accounts as a', 'a.id', 'i.bank_account_id');
      if (q.status) base.where('i.status', q.status);
      if (q.from) base.where('i.created_at', '>=', `${q.from} 00:00:00`);
      if (q.to) base.where('i.created_at', '<=', `${q.to} 23:59:59`);
      if (q.search) {
        const s = `%${q.search}%`;
        base.where((b: any) =>
          b.whereILike('s.full_name', s).orWhereILike('i.ocr_banco', s).orWhereILike('i.concept', s).orWhereILike('i.from_phone', s),
        );
      }
      const rows = await base
        .clone()
        .orderBy('i.created_at', 'desc')
        .limit(Math.min(500, q.limit || 200))
        .select(
          'i.id', 'i.status', 'i.from_phone', 'i.sucursal', 'i.concept',
          'i.amount_in', 'i.amount_out', 'i.movement_date', 'i.ocr_banco', 'i.ocr_cuenta_dest',
          'i.ocr_referencia', 'i.ocr_status', 'i.files', 'i.bank_movement_id', 'i.notified_at', 'i.error_detail', 'i.created_at',
          'i.customer_code', 'i.rfc',
          's.full_name as sender_name',
          trx.raw(`COALESCE(a.bank || ' ' || a.account_label, NULL) as cuenta`),
        );
      // URL de lectura prefirmada (bucket privado); legacy Cloudinary queda igual.
      for (const r of rows) r.files = await this.storage.signFiles(typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []));
      const kpiRows = await trx('finance.bank_capture_inbox')
        .groupBy('status')
        .select('status')
        .count('* as n')
        .sum('amount_in as monto');
      const kpis: any = { pendiente_confirmacion: 0, confirmado: 0, validado: 0, rechazado: 0, descartado: 0, total_monto: 0 };
      for (const r of kpiRows) {
        kpis[r.status] = Number(r.n);
        if (r.status === 'confirmado' || r.status === 'validado') kpis.total_monto += Number(r.monto) || 0;
      }
      return { rows, kpis };
    });
  }

  /** Detalle de una captura. */
  async get(id: string): Promise<any> {
    return this.tk.run((trx) =>
      trx('finance.bank_capture_inbox as i')
        .leftJoin('finance.bank_capture_senders as s', 's.id', 'i.sender_id')
        .leftJoin('finance.bank_accounts as a', 'a.id', 'i.bank_account_id')
        .where('i.id', id)
        .first('i.*', 's.full_name as sender_name', trx.raw(`COALESCE(a.bank || ' ' || a.account_label, NULL) as cuenta`)),
    );
  }

  /** Corrige la atribución (humano) antes de validar: cuenta/sucursal/concepto/monto/fecha. */
  async updateAttribution(id: string, patch: Record<string, any>): Promise<any> {
    const allowed = ['bank_account_id', 'sucursal', 'concept', 'amount_in', 'amount_out', 'movement_date', 'comentarios'];
    return this.tk.run(async (trx) => {
      const upd: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of allowed) if (k in patch) upd[k] = patch[k];
      const [row] = await trx('finance.bank_capture_inbox').where({ id }).update(upd).returning('*');
      return row;
    });
  }

  /**
   * Valida la captura (revisor) Y la **materializa como renglón de depósito en el
   * libro** (`finance.bank_movements`) — sin teclear nada. Requiere cuenta resuelta
   * (ADR-042: el motor pone los números, el humano da el visto bueno; recién ahí
   * toca el libro). Idempotente: `client_uuid = whatsapp:<captureId>`.
   */
  async validate(id: string, actor: string): Promise<any> {
    try {
      return await this.tk.run(async (trx) => {
        const cap = await trx('finance.bank_capture_inbox')
          .where({ id })
          .whereIn('status', ['pendiente_confirmacion', 'confirmado'])
          .first();
        if (!cap) {
          return trx('finance.bank_capture_inbox').where({ id }).first('id', 'status', 'bank_movement_id');
        }
        if (!cap.bank_account_id) {
          throw new BadRequestException('Asigna la cuenta antes de validar (el OCR no la identificó).');
        }
        const movementId = await this.postToLedger(trx, cap);
        if (!movementId) throw new Error('El libro no devolvió el renglón (postToLedger).');
        const [row] = await trx('finance.bank_capture_inbox')
          .where({ id })
          // éxito → limpiamos cualquier error previo.
          .update({ status: 'validado', bank_movement_id: movementId, error_detail: null, validated_by: actor, validated_at: trx.fn.now(), updated_at: trx.fn.now() })
          .returning(['id', 'status', 'bank_movement_id']);
        return row;
      });
    } catch (e: any) {
      // Error CONOCIDO y accionable por el usuario (falta cuenta) → pasa tal cual, sin molestar a Perla.
      if (e instanceof BadRequestException) throw e;
      // Error inesperado escribiendo el libro ("el workbook no se actualiza") → registrar + avisar a Cobranza.
      this.logger.error(`validate/postToLedger falló (${id}): ${e?.message}`);
      await this.recordError(id, `No se pudo escribir en el libro: ${e?.message || e}`).catch(() => undefined);
      const cap = await this.get(id).catch(() => null);
      await this.notifyError('No se pudo agregar un depósito al libro', Number(cap?.amount_in) || 0, cap?.sucursal ?? null);
      throw new BadRequestException('No se pudo agregar el depósito al libro. Crédito y Cobranza fue notificada para revisarlo.');
    }
  }

  /** Registra el detalle de un error en la captura (fuera de la trx que pudo hacer rollback). */
  private async recordError(id: string, detail: string): Promise<void> {
    await this.tk.run((trx) => trx('finance.bank_capture_inbox').where({ id }).update({ error_detail: detail, updated_at: trx.fn.now() }));
  }

  /**
   * Escribe el depósito en el libro: encuentra/crea el estado de cuenta del mes de
   * la cuenta, inserta el movimiento (ingreso cobranza / código 102) y actualiza los
   * totales del statement. Devuelve el id del movimiento. Corre dentro de la trx de
   * validate() (mismo scope de tenant).
   */
  private async postToLedger(trx: any, cap: any): Promise<string> {
    const tid = this.tenantId();
    const movementDate = this.ymd(cap.movement_date) || this.ymd(cap.created_at) || new Date().toISOString().slice(0, 10);
    const period = movementDate.slice(0, 7); // YYYY-MM

    // 1) Statement (cuenta × periodo) — encuentra o crea.
    let stmt = await trx('finance.bank_statements')
      .where({ tenant_id: tid, bank_account_id: cap.bank_account_id, period })
      .first('id');
    if (!stmt) {
      [stmt] = await trx('finance.bank_statements')
        .insert({ tenant_id: tid, bank_account_id: cap.bank_account_id, period, status: 'reconciling', source_file: 'whatsapp', imported_by: 'whatsapp', imported_at: trx.fn.now() })
        .returning('id');
    }

    // 2) Categoría cobranza (ingreso / código 102).
    const cat = await trx('finance.movement_categories').where({ tenant_id: tid, code: 'cobranza' }).first('id');

    // 3) Movimiento (idempotente por captura).
    const amount = Number(cap.amount_in) || 0;
    const [mov] = await trx('finance.bank_movements')
      .insert({
        tenant_id: tid,
        statement_id: stmt.id,
        bank_account_id: cap.bank_account_id,
        movement_date: movementDate,
        category_id: cat?.id ?? null,
        raw_type: 'I',
        raw_code: '102',
        sucursal: cap.sucursal,
        concept: cap.concept,
        amount_in: amount,
        amount_out: 0,
        recon_status: 'pending',
        client_uuid: `whatsapp:${cap.id}`,
        source_file: 'whatsapp',
        classified_by: 'manual',
      })
      .onConflict(['tenant_id', 'client_uuid'])
      .merge({ amount_in: amount, sucursal: cap.sucursal, concept: cap.concept, bank_account_id: cap.bank_account_id, updated_at: trx.fn.now() })
      .returning('id');

    // 4) Totales del statement (RHS usa valores viejos → nuevo cierre correcto).
    await trx('finance.bank_statements')
      .where({ id: stmt.id })
      .update({
        total_in: trx.raw('total_in + ?', [amount]),
        closing_balance: trx.raw('opening_balance + total_in + ? - total_out', [amount]),
        updated_at: trx.fn.now(),
      });

    return mov.id as string;
  }

  /** Coerción a 'YYYY-MM-DD' (Date o string), o null. */
  private ymd(v: any): string | null {
    if (!v) return null;
    if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
  }

  /** Rechaza la captura (revisor) con motivo. */
  async reject(id: string, actor: string, motivo?: string): Promise<any> {
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_capture_inbox')
        .where({ id })
        .whereNotIn('status', ['rechazado'])
        .update({ status: 'rechazado', motivo_rechazo: motivo ?? null, validated_by: actor, validated_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      return row;
    });
  }

  /**
   * Candidatos de movimiento del estado de cuenta para cuadrar una captura
   * (mismo monto ±$1, fecha ±7d). Reusa el criterio del matcher de CB.
   */
  async matchCandidates(id: string): Promise<any[]> {
    return this.tk.run(async (trx) => {
      const cap = await trx('finance.bank_capture_inbox').where({ id }).first('amount_in', 'movement_date', 'bank_account_id');
      if (!cap) return [];
      const amt = Number(cap.amount_in) || 0;
      const q = trx('finance.bank_movements as m')
        .leftJoin('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
        .whereRaw('m.amount_in BETWEEN ? AND ?', [amt - 1, amt + 1])
        .andWhere('m.recon_status', '!=', 'ignored');
      if (cap.movement_date) {
        q.whereRaw(`m.movement_date BETWEEN ?::date - INTERVAL '7 days' AND ?::date + INTERVAL '7 days'`, [cap.movement_date, cap.movement_date]);
      }
      if (cap.bank_account_id) q.andWhere('m.bank_account_id', cap.bank_account_id);
      return q.orderBy('m.movement_date', 'desc').limit(20)
        .select('m.id', 'm.movement_date', 'm.amount_in', 'm.concept', trx.raw(`a.bank || ' ' || a.account_label as cuenta`));
    });
  }

  /** Cuadra la captura contra un movimiento real del estado de cuenta + la valida. */
  async matchMovement(id: string, bankMovementId: string, actor: string): Promise<any> {
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_capture_inbox')
        .where({ id })
        .update({ bank_movement_id: bankMovementId, status: 'validado', validated_by: actor, validated_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning(['id', 'status', 'bank_movement_id']);
      return row;
    });
  }

  // ── Admin de remitentes (allowlist) ────────────────────────────────────────

  async listSenders(): Promise<any[]> {
    return this.tk.run((trx) =>
      trx('finance.bank_capture_senders as s')
        .leftJoin('finance.bank_accounts as a', 'a.id', 's.default_bank_account_id')
        .orderBy('s.full_name', 'asc')
        .select('s.id', 's.phone', 's.full_name', 's.sucursal', 's.default_bank_account_id', 's.customer_code', 's.rfc', 's.active', trx.raw(`a.bank || ' ' || a.account_label as cuenta`)),
    );
  }

  async createSender(dto: { phone: string; full_name: string; sucursal?: string; default_bank_account_id?: string; customer_code?: string; rfc?: string; created_by?: string }): Promise<any> {
    const phone = normalizeMxPhone(dto.phone) || dto.phone;
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_capture_senders')
        .insert({
          tenant_id: this.tenantId(),
          phone,
          full_name: dto.full_name,
          sucursal: dto.sucursal ?? null,
          default_bank_account_id: dto.default_bank_account_id ?? null,
          customer_code: dto.customer_code ?? null,
          rfc: dto.rfc ?? null,
          created_by: dto.created_by ?? null,
        })
        .onConflict(['tenant_id', 'phone'])
        .merge({ full_name: dto.full_name, sucursal: dto.sucursal ?? null, default_bank_account_id: dto.default_bank_account_id ?? null, customer_code: dto.customer_code ?? null, rfc: dto.rfc ?? null, active: true, updated_at: trx.fn.now() })
        .returning('*');
      return row;
    });
  }

  async updateSender(id: string, patch: Record<string, any>): Promise<any> {
    const allowed = ['full_name', 'sucursal', 'default_bank_account_id', 'customer_code', 'rfc', 'active'];
    return this.tk.run(async (trx) => {
      const upd: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of allowed) if (k in patch) upd[k] = patch[k];
      if ('phone' in patch) upd.phone = normalizeMxPhone(patch.phone) || patch.phone;
      const [row] = await trx('finance.bank_capture_senders').where({ id }).update(upd).returning('*');
      return row;
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private tenantId(): string {
    return this.tenantCtx.get()?.tenantId || this.TENANT;
  }

  /** Notifica a Crédito y Cobranza que llegó un nuevo depósito (best-effort, CBW.4.1). */
  private async notifyCobranza(row: { id: string; amount_in: number; sucursal: string | null; ocr_banco: string | null }): Promise<void> {
    if (!this.notifier) return;
    try {
      await this.notifier.notifyCritical(this.tenantId(), [
        {
          rule_key: 'nuevo_deposito_whatsapp',
          titulo: `Nuevo depósito por WhatsApp${row.sucursal ? ` · Suc ${row.sucursal}` : ''}${row.ocr_banco ? ` · ${row.ocr_banco}` : ''}`,
          importe: Number(row.amount_in) || 0,
        },
      ]);
      await this.tk.run((trx) =>
        trx('finance.bank_capture_inbox').where({ id: row.id }).update({ notified_at: trx.fn.now() }),
      );
    } catch (e: any) {
      this.logger.warn(`notifyCobranza best-effort falló: ${e?.message}`);
    }
  }

  /**
   * Avisa a Crédito y Cobranza que una captura tuvo un PROBLEMA y necesita revisión
   * manual (no se subió / no es válida / no se pudo escribir en el libro). Best-effort.
   */
  private async notifyError(titulo: string, importe: number, sucursal: string | null): Promise<void> {
    if (!this.notifier) return;
    try {
      await this.notifier.notifyCritical(this.tenantId(), [
        { rule_key: 'deposito_whatsapp_error', titulo: `⚠️ ${titulo}${sucursal ? ` · Suc ${sucursal}` : ''}`, importe: Number(importe) || 0 },
      ]);
    } catch (e: any) {
      this.logger.warn(`notifyError best-effort falló: ${e?.message}`);
    }
  }

  /** OCR banco+últimos-4 → bank_account por account_label (tail 4 dígitos); fallback default del remitente. */
  private async resolveAccount(cuentaDest: string | null, fallbackId: string | null): Promise<string | null> {
    const digits = (cuentaDest || '').replace(/\D/g, '');
    const last4 = digits.slice(-4);
    if (last4.length === 4) {
      const match = await this.tk.run((trx) =>
        trx('finance.bank_accounts').where({ account_label: last4, active: true }).first('id'),
      );
      if (match?.id) return match.id as string;
    }
    return fallbackId;
  }

  /** Normaliza el mime a los tipos que acepta extractDepositSlip. */
  private coerceMediaType(
    mime: string,
  ): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf' {
    const m = (mime || '').toLowerCase();
    if (m.includes('pdf')) return 'application/pdf';
    if (m.includes('png')) return 'image/png';
    if (m.includes('webp')) return 'image/webp';
    if (m.includes('gif')) return 'image/gif';
    return 'image/jpeg';
  }

  /**
   * CBW.5 — Acuse de recibo (sin SÍ/NO). La foto ya entró a la bandeja como "por
   * validar"; el bot solo confirma lo que leyó (o el problema). Cobranza valida.
   */
  private buildAckReply(
    f: { monto: number | null; banco: string | null; referencia: string | null; cuenta_dest: string | null },
    ocrStatus: string,
    errorDetail?: string | null,
  ): string {
    // Problema de subida o imagen no válida → honesto.
    if (errorDetail && /no se pudo subir/i.test(errorDetail)) {
      return '⚠️ No pude guardar bien tu imagen. ¿Puedes reenviarla? Si sigue fallando, avisa a Crédito y Cobranza.';
    }
    if (errorDetail && /no parece un comprobante/i.test(errorDetail)) {
      return '🤔 Esta imagen no parece un comprobante de depósito. Si sí lo es, mándala más clara. La revisará Crédito y Cobranza.';
    }
    if (ocrStatus === 'sin_key') {
      return '📸 Recibí tu comprobante. Crédito y Cobranza lo revisará y aplicará. ¡Gracias!';
    }
    if (ocrStatus === 'ilegible' || f.monto == null) {
      return '📸 Recibí tu comprobante, pero no pude leer el monto — Crédito y Cobranza lo revisará y aplicará. ¡Gracias!';
    }
    const money = `$${Number(f.monto).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const banco = f.banco ? ` (${f.banco})` : '';
    return `✅ Recibí tu depósito de ${money}${banco}. Crédito y Cobranza lo aplicará. ¡Gracias! 🙌`;
  }
}
