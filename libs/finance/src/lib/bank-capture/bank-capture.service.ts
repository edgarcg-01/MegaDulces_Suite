import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  CloudinaryService,
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
    private readonly ocr: LlmExtractorService,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /** ¿Teléfono en la allowlist activa? Da identidad para atribuir (o null = no autorizado). */
  async resolveSender(phone: string): Promise<BankCaptureSender | null> {
    const canonical = normalizeMxPhone(phone) || phone;
    return this.tk.run(async (trx) => {
      const row = await trx('finance.bank_capture_senders')
        .where({ phone: canonical, active: true })
        .first('id', 'full_name', 'sucursal', 'default_bank_account_id');
      if (!row) return null;
      return {
        id: row.id,
        full_name: row.full_name,
        sucursal: row.sucursal ?? null,
        default_bank_account_id: row.default_bank_account_id ?? null,
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
  }): Promise<BankCaptureResult> {
    const phone = normalizeMxPhone(input.fromPhone) || input.fromPhone;
    const mediaType = this.coerceMediaType(input.mime);

    // 1) Cloudinary (data URI con prefijo; detecta PDF vs imagen).
    let files: Array<{ url: string; public_id: string; kind: string }> = [];
    try {
      const up = await this.cloudinary.uploadDocumentBase64(
        `data:${mediaType};base64,${input.fileBase64}`,
        `finance/${this.TENANT}/bank-captures`,
      );
      files = [{ url: up.url, public_id: up.public_id, kind: up.kind }];
    } catch (e: any) {
      this.logger.error(`Cloudinary falló: ${e?.message}`);
    }

    // 2) OCR de la ficha (degrada a 'sin_key'/'ilegible' sin romper).
    const fields = await this.ocr.extractDepositSlip(input.fileBase64, mediaType);
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    const ocrStatus = !hasKey ? 'sin_key' : fields.monto != null ? 'ok' : 'ilegible';

    // 3) Resolver la cuenta: OCR (banco + últimos 4) → catálogo; fallback a la cuenta del remitente.
    const bankAccountId = await this.resolveAccount(fields.cuenta_dest, input.sender.default_bank_account_id);

    // 4) Insertar la captura en staging (pendiente_confirmacion).
    const concept = [input.sender.full_name, fields.ordenante].filter(Boolean).join(' — ') || 'Depósito WhatsApp';
    const amountIn = Number(fields.monto) > 0 ? Number(fields.monto) : 0;
    const captureId = await this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_capture_inbox')
        .insert({
          tenant_id: this.tenantId(),
          source: 'whatsapp',
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
          ocr_raw: JSON.stringify(fields),
          ocr_status: ocrStatus,
          bank_account_id: bankAccountId,
          sucursal: input.sender.sucursal,
          concept,
          amount_in: amountIn,
          amount_out: 0,
          movement_date: fields.fecha ?? null,
          status: 'pendiente_confirmacion',
        })
        .onConflict(['tenant_id', 'wa_message_id'])
        .merge({ updated_at: trx.fn.now() }) // reenvío del mismo mensaje = idempotente
        .returning('id');
      return row?.id as string;
    });

    return { reply: this.buildConfirmPrompt(fields, ocrStatus), capture_id: captureId ?? null };
  }

  /** CBW.3 — SÍ/NO sobre la última captura pendiente del teléfono. */
  async confirm(phone: string, decision: 'yes' | 'no'): Promise<BankCaptureResult | null> {
    const canonical = normalizeMxPhone(phone) || phone;
    const row = await this.tk.run(async (trx) => {
      const pending = await trx('finance.bank_capture_inbox')
        .where({ from_phone: canonical, status: 'pendiente_confirmacion' })
        .orderBy('created_at', 'desc')
        .first('id', 'amount_in', 'sucursal', 'ocr_banco');
      if (!pending) return null;
      const newStatus = decision === 'yes' ? 'confirmado' : 'descartado';
      await trx('finance.bank_capture_inbox')
        .where({ id: pending.id })
        .update({ status: newStatus, updated_at: trx.fn.now() });
      return { ...pending, newStatus };
    });
    if (!row) return null;
    if (row.newStatus === 'confirmado') {
      await this.notifyCobranza(row);
      return { reply: '✅ Registrado. Crédito y Cobranza lo revisará y aplicará al cliente. ¡Gracias!', capture_id: row.id };
    }
    return { reply: 'Ok, lo descarté. Si te equivocaste, vuelve a enviar la foto. 🙌', capture_id: row.id };
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
          'i.ocr_referencia', 'i.ocr_status', 'i.files', 'i.bank_movement_id', 'i.notified_at', 'i.created_at',
          's.full_name as sender_name',
          trx.raw(`COALESCE(a.bank || ' ' || a.account_label, NULL) as cuenta`),
        );
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
    return this.tk.run(async (trx) => {
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
      const [row] = await trx('finance.bank_capture_inbox')
        .where({ id })
        .update({ status: 'validado', bank_movement_id: movementId, validated_by: actor, validated_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning(['id', 'status', 'bank_movement_id']);
      return row;
    });
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
        .select('s.id', 's.phone', 's.full_name', 's.sucursal', 's.default_bank_account_id', 's.active', trx.raw(`a.bank || ' ' || a.account_label as cuenta`)),
    );
  }

  async createSender(dto: { phone: string; full_name: string; sucursal?: string; default_bank_account_id?: string; created_by?: string }): Promise<any> {
    const phone = normalizeMxPhone(dto.phone) || dto.phone;
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.bank_capture_senders')
        .insert({
          tenant_id: this.tenantId(),
          phone,
          full_name: dto.full_name,
          sucursal: dto.sucursal ?? null,
          default_bank_account_id: dto.default_bank_account_id ?? null,
          created_by: dto.created_by ?? null,
        })
        .onConflict(['tenant_id', 'phone'])
        .merge({ full_name: dto.full_name, sucursal: dto.sucursal ?? null, default_bank_account_id: dto.default_bank_account_id ?? null, active: true, updated_at: trx.fn.now() })
        .returning('*');
      return row;
    });
  }

  async updateSender(id: string, patch: Record<string, any>): Promise<any> {
    const allowed = ['full_name', 'sucursal', 'default_bank_account_id', 'active'];
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

  /** Texto de respuesta: lo leído + petición de confirmación SÍ/NO. */
  private buildConfirmPrompt(
    f: { monto: number | null; banco: string | null; referencia: string | null; cuenta_dest: string | null },
    ocrStatus: string,
  ): string {
    if (ocrStatus === 'sin_key') {
      return '📸 Recibí tu comprobante. Un compañero lo revisará en breve. ¡Gracias!';
    }
    if (ocrStatus === 'ilegible' || f.monto == null) {
      return '📸 Recibí tu comprobante pero no pude leer bien el monto. Lo revisará Crédito y Cobranza. ¿Aun así lo registro? Responde *SÍ* o *NO*.';
    }
    const money = `$${Number(f.monto).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const lines = [
      '📸 Recibí tu comprobante. Esto leí:',
      `• Monto: ${money}`,
      f.banco ? `• Banco: ${f.banco}` : null,
      f.cuenta_dest ? `• Cuenta: ${f.cuenta_dest}` : null,
      f.referencia ? `• Ref: ${f.referencia}` : null,
      '',
      '¿Lo registro? Responde *SÍ* o *NO*.',
    ].filter(Boolean);
    return lines.join('\n');
  }
}
