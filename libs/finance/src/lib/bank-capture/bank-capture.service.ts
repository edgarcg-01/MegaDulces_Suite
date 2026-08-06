import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
