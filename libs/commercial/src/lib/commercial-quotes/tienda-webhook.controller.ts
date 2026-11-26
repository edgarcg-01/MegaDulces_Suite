import { Controller, ForbiddenException, Headers, HttpCode, Logger, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { Public, TenantContextService } from '@megadulces/platform-core';

import { TiendaPedidoService } from './tienda-pedido.service';
import { pedidoWixAPedidoTienda, type PedidoWix, type RespuestaWebhookTienda } from './pedido-wix';

/**
 * `[COT.7.50]` — **La puerta por la que entra un pedido de la tienda de marca.**
 *
 * `POST /api/webhooks/tienda/pedido`. Lo llama Wix cuando un pedido se paga; de ahí sale una
 * cotización y, por el camino de siempre (`[COT.7]`), un Pedido Telemarketing en Kepler. Hoy eso
 * lo teclea una persona: 45 de 45 pedidos en línea desde el 2026-11-12.
 *
 * ── Quién puede llamar ──────────────────────────────────────────────────────
 * ⛔⛔ **Falla CERRADO, siempre.** Sin `TIENDA_WEBHOOK_TOKEN` configurado el endpoint devuelve 503
 * y no mira el cuerpo. Es más estricto que el webhook de WhatsApp —que en dev tolera la falta de
 * secreto—, y a propósito: esto **escribe un pedido en el ERP**, y en esta máquina el `.env`
 * apunta a producción viva. Un endpoint público sin secreto es cualquiera creando pedidos.
 *
 * ⚠️ **El token por `?t=` queda escrito en los registros del servidor y del proxy.** Se acepta
 * porque no está medido que el panel de Wix permita encabezados personalizados, y quedarse sin
 * camino costaría una vuelta entera. Se prefiere el encabezado y el uso de la URL se avisa.
 *
 * ── Qué contesta ────────────────────────────────────────────────────────────
 * **200 siempre que la decisión sea nuestra**, incluso al rechazar: un rechazo de negocio —pedido
 * cancelado, sin pagar, SKU que no está en el mostrador— no se arregla reintentando, y un 4xx haría
 * que Wix reintente en círculos. Un error inesperado SÍ se deja subir: ese sí conviene reintentarlo,
 * y el servicio es idempotente, así que el reintento no duplica nada.
 */

/** El tenant del piloto (`mega_dulces`). Wix no manda tenant: el pedido es de esta casa. */
const TENANT_MEGA_DULCES = '00000000-0000-0000-0000-00000000d01c';

/** Compara sin filtrar por tiempo. Dos textos de largo distinto no llegan a `timingSafeEqual`. */
function mismoToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Saca el pedido del cuerpo, venga envuelto o no. Wix manda el pedido directo cuando el aviso es
 * del webhook de la app, y envuelto en `data` cuando lo arma una automatización del panel.
 * **No se adivina cuál es: se aceptan los dos y se deja el crudo si ninguno aplica.**
 */
export function pedidoDelCuerpo(cuerpo: unknown): PedidoWix {
  const c = (cuerpo ?? {}) as Record<string, unknown>;
  for (const candidato of [c['order'], (c['data'] as Record<string, unknown> | undefined)?.['order'], c['data'], c]) {
    const p = candidato as PedidoWix | undefined;
    if (p && typeof p === 'object' && (p.number != null || Array.isArray(p.lineItems))) return p;
  }
  return c as PedidoWix;
}

@ApiExcludeController()
@Controller('webhooks/tienda')
export class TiendaWebhookController {
  private readonly logger = new Logger(TiendaWebhookController.name);

  constructor(
    private readonly tenantCtx: TenantContextService,
    private readonly pedidos: TiendaPedidoService,
  ) {}

  @Public()
  @Post('pedido')
  @HttpCode(200)
  async pedido(
    @Req() req: { body?: unknown },
    @Headers('x-tienda-token') enCabecera?: string,
    @Query('t') enUrl?: string,
  ): Promise<RespuestaWebhookTienda> {
    const esperado = (process.env['TIENDA_WEBHOOK_TOKEN'] ?? '').trim();
    if (!esperado) {
      this.logger.error('Pedido de la tienda rechazado: falta TIENDA_WEBHOOK_TOKEN. El webhook está CERRADO.');
      throw new ServiceUnavailableException('Webhook de la tienda no configurado.');
    }
    const recibido = (enCabecera ?? enUrl ?? '').trim();
    if (!recibido || !mismoToken(recibido, esperado)) {
      this.logger.warn('Pedido de la tienda rechazado: token ausente o inválido.');
      throw new ForbiddenException('Token inválido.');
    }
    if (!enCabecera && enUrl) {
      this.logger.warn('El token de la tienda viajó en la URL: queda en los registros. Mejor el encabezado x-tienda-token.');
    }

    const pedido = pedidoWixAPedidoTienda(pedidoDelCuerpo(req?.body));
    const tenantId = (process.env['TIENDA_TENANT_ID'] ?? process.env['DEFAULT_TENANT_ID'] ?? TENANT_MEGA_DULCES).trim();

    return this.tenantCtx.run({ tenantId }, async () => {
      const r = await this.pedidos.registrar(pedido);
      const nivel = r.estado === 'rechazado' ? 'warn' : 'log';
      this.logger[nivel](
        `Pedido ${pedido.numero || '(sin número)'} de la tienda: ${r.estado}`
        + (r.quote_code ? ` · cotización ${r.quote_code}` : '')
        + (r.kepler_folio ? ` · Kepler ${r.kepler_sucursal ?? ''}-${r.kepler_folio}` : '')
        + (r.motivo ? ` · ${r.motivo}` : ''),
      );
      return {
        recibido: true,
        numero: pedido.numero,
        estado: r.estado,
        ...(r.motivo ? { motivo: r.motivo } : {}),
        ...(r.quote_code ? { quote_code: r.quote_code } : {}),
        ...(r.kepler_folio ? { kepler_folio: r.kepler_folio } : {}),
      };
    });
  }
}
