import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { MAILER_PORT, MailerPort, MailMessage } from '@megadulces/contracts';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * DBH.3 — Composition root del correo saliente.
 *
 * Adapter SMTP porque la organización ya opera Google Workspace (`@megadulces.com.mx`), así que no
 * hace falta contratar ni configurar un proveedor nuevo para que esto funcione hoy. El emisor sólo
 * conoce `MAILER_PORT`: cambiar a Resend/SendGrid después es reemplazar esta clase, sin tocar a
 * quien manda.
 *
 * Env (documentadas en `.env.example`):
 *   SMTP_HOST · SMTP_PORT (465 implica TLS directo) · SMTP_USER · SMTP_PASS · SMTP_FROM
 *
 * Sin `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` el adapter queda **apagado**: `isConfigured()` devuelve
 * false y `send()` es no-op con warning. Es la convención de la casa (`CommercialPushService`,
 * `FleetProviderPort`, el simulador de WhatsApp): sin credenciales, no-op, nunca crash. Importa
 * porque este módulo es `@Global()` y lo carga TODO el API — un throw acá tumbaría el arranque.
 */
@Injectable()
class SmtpMailerAdapter implements MailerPort {
  private readonly logger = new Logger('SmtpMailer');
  private readonly host = process.env.SMTP_HOST || '';
  private readonly user = process.env.SMTP_USER || '';
  private readonly pass = process.env.SMTP_PASS || '';
  private readonly port = Number(process.env.SMTP_PORT || 465);
  private readonly from = process.env.SMTP_FROM || this.user;
  private transporter: Transporter | null = null;

  constructor() {
    if (!this.isConfigured()) {
      this.logger.warn('SMTP sin configurar (falta SMTP_HOST/USER/PASS) — el correo queda apagado');
      return;
    }
    // `secure: true` sólo en 465 (TLS directo); en 587 se negocia STARTTLS, que es lo que espera
    // Google Workspace. Ponerlo al revés da un timeout mudo, no un error claro.
    this.transporter = nodemailer.createTransport({
      host: this.host, port: this.port, secure: this.port === 465,
      auth: { user: this.user, pass: this.pass },
    });
    this.logger.log(`SMTP listo (${this.host}:${this.port})`);
  }

  isConfigured(): boolean {
    return Boolean(this.host && this.user && this.pass);
  }

  async send(msg: MailMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.transporter) return { ok: false, error: 'SMTP sin configurar' };
    const to = (msg.to || []).map((s) => s.trim()).filter(Boolean);
    if (!to.length) return { ok: false, error: 'sin destinatarios' };
    try {
      await this.transporter.sendMail({
        from: this.from, to: to.join(', '),
        subject: msg.subject, text: msg.text, html: msg.html,
      });
      this.logger.log(`enviado "${msg.subject}" → ${to.length} destinatario(s)`);
      return { ok: true };
    } catch (e) {
      // Nunca lanza: el que avisa no puede caerse porque el aviso no salió.
      const error = (e as Error).message;
      this.logger.error(`falló el envío "${msg.subject}": ${error}`);
      return { ok: false, error };
    }
  }
}

@Global()
@Module({
  providers: [
    SmtpMailerAdapter,
    { provide: MAILER_PORT, useExisting: SmtpMailerAdapter },
  ],
  exports: [MAILER_PORT],
})
export class MailerBindingModule {}
