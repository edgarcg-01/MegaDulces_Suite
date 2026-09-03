import { Global, Inject, Injectable, Logger, Module, Optional } from '@nestjs/common';
import { HEALTH_NOTIFIER_PORT, HealthNotifierPort, HealthAlertItem } from '@megadulces/contracts';
import { WHATSAPP_PORT, WhatsAppModule, WhatsAppPort } from '@megadulces/whatsapp';

/**
 * OBS.5.2 — Composition root del aviso de Salud BD por WhatsApp.
 *
 * Único lugar que conoce ambos lados: liga `HEALTH_NOTIFIER_PORT` (declarado en contracts,
 * inyectado `@Optional` por `DbHealthScannerService`) al canal de WhatsApp. `@Global()` para que el
 * token resuelva sin que db-health importe la lib de WhatsApp.
 *
 * ── POR QUÉ UN SEGUNDO CANAL ─────────────────────────────────────────────────────────────
 * El correo (DBH.3) sacó la alerta de la pestaña, pero no la hace llegar RÁPIDO: el incidente del
 * 2026-08-27 tardó seis días en descubrirse y el objetivo de la fase es < 15 minutos. Un correo se
 * lee cuando se abre el correo; un WhatsApp vibra.
 *
 * ── PLANTILLA (por qué no es texto plano) ────────────────────────────────────────────────
 * Meta sólo permite iniciar conversación fuera de la ventana de 24 h con una **plantilla aprobada**.
 * Una alerta de madrugada cae siempre fuera de esa ventana, así que texto plano **no llegaría** —
 * y peor: fallaría en silencio justo cuando más importa. Por eso `sendTemplate`.
 *
 * La plantilla es de categoría **Utilidad** (no Marketing: Marketing se degrada por calidad y esto
 * es una alarma), con tres variables — fuente, motivo, antigüedad:
 *
 *     Alerta de sistema: *{{1}}* está en estado *{{2}}* desde hace {{3}}. Revisá el tablero de salud.
 *
 * Env:
 *   DB_HEALTH_ALERT_PHONES  destinatarios E.164 sin '+', separados por coma (ej. 5214771234567)
 *   DB_HEALTH_WA_TEMPLATE   nombre de la plantilla aprobada en Meta
 *   DB_HEALTH_WA_LANG       idioma de la plantilla (default 'es_MX')
 *
 * Sin teléfonos o sin nombre de plantilla queda **apagado**: `isConfigured()` false y no-op con
 * warning. Convención de la casa (`SmtpMailerAdapter`, `CommercialPushService`, `FleetProviderPort`):
 * sin credenciales, no-op, nunca crash — importa porque este módulo es `@Global()` y lo carga todo
 * el API, así que un throw acá tumbaría el arranque.
 *
 * ⚠️ `WHATSAPP_PROVIDER` por default es `simulator`, así que esto se prueba end-to-end sin Meta:
 * el simulador loguea el envío en vez de mandarlo.
 */
@Injectable()
class WhatsAppHealthNotifierAdapter implements HealthNotifierPort {
  private readonly logger = new Logger('HealthNotifier');
  private readonly phones = (process.env.DB_HEALTH_ALERT_PHONES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  private readonly template = (process.env.DB_HEALTH_WA_TEMPLATE || '').trim();
  private readonly lang = (process.env.DB_HEALTH_WA_LANG || 'es_MX').trim();

  constructor(@Optional() @Inject(WHATSAPP_PORT) private readonly wa?: WhatsAppPort) {
    if (!this.isConfigured()) {
      this.logger.warn('WhatsApp de Salud BD sin configurar (falta DB_HEALTH_ALERT_PHONES o DB_HEALTH_WA_TEMPLATE) — el canal queda apagado');
    }
  }

  isConfigured(): boolean {
    return Boolean(this.wa && this.phones.length && this.template);
  }

  async notifyCritical(items: HealthAlertItem[]): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) return { ok: false, error: 'WhatsApp de Salud BD sin configurar' };
    if (!items?.length) return { ok: false, error: 'sin items' };

    // UN mensaje, no uno por fuente. Una cascada (el 2026-09-01 fueron 3 réplicas + el CDC a la vez)
    // tiene que llegar como un aviso, no como cuatro vibraciones — el mismo criterio que ya usa el
    // correo. La plantilla tiene 3 huecos, así que el detalle se comprime en ellos.
    const primera = items[0];
    const fuente = items.length === 1
      ? primera.label
      : `${primera.label} +${items.length - 1} más`;
    const antiguedad = primera.age_human || 'hace rato';

    let enviados = 0;
    const errores: string[] = [];
    for (const to of this.phones) {
      try {
        await this.wa!.sendTemplate(to, {
          name: this.template,
          language: this.lang,
          // Los parámetros de plantilla de Meta no admiten saltos de línea ni tabs, y un texto
          // demasiado largo la rechaza entera. Se limpia y se corta ANTES de mandar: un aviso
          // truncado sirve, uno rechazado no llega.
          bodyParams: [fuente, primera.motivo, antiguedad].map((t) =>
            String(t).replace(/\s+/g, ' ').trim().slice(0, 120)),
        });
        enviados++;
      } catch (e) {
        errores.push(`${to.slice(-4)}: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    if (enviados) {
      this.logger.log(`aviso crítico enviado a ${enviados}/${this.phones.length} (${items.length} fuente(s))`);
      return { ok: true, ...(errores.length ? { error: errores.join(' · ') } : {}) };
    }
    // Nunca lanza: el que avisa no puede caerse porque el aviso no salió.
    this.logger.error(`no se pudo avisar por WhatsApp: ${errores.join(' · ')}`);
    return { ok: false, error: errores.join(' · ') };
  }
}

@Global()
@Module({
  imports: [WhatsAppModule],
  providers: [
    WhatsAppHealthNotifierAdapter,
    { provide: HEALTH_NOTIFIER_PORT, useExisting: WhatsAppHealthNotifierAdapter },
  ],
  exports: [HEALTH_NOTIFIER_PORT],
})
export class HealthNotifierBindingModule {}
