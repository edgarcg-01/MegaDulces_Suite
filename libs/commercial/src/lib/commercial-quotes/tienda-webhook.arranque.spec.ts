import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '@megadulces/platform-core';
import { CommercialQuotesModule } from './commercial-quotes.module';
import { CommercialQuotesService } from './commercial-quotes.service';
import { QuotePricingService } from './quote-pricing.service';
import { QuoteKeplerService } from './quote-kepler.service';
import { TiendaPedidoService } from './tienda-pedido.service';
import { TiendaWebhookController, pedidoDelCuerpo } from './tienda-webhook.controller';

/**
 * `[COT.7.50]` Que compile no es que arranque (`#414`: la API se cayó en prod con el CI en verde).
 * vitest no emite `design:paramtypes`, así que el grafo se lee de los decoradores y de la aridad.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

describe('[COT.7.50] el webhook de la tienda arranca dentro del módulo de cotizaciones', () => {
  it('controlador con 2 dependencias y servicio con 5 (si cambia, revisar el arranque)', () => {
    expect(TiendaWebhookController.length).toBe(2);
    expect(TiendaPedidoService.length).toBe(5);
  });

  it('el controlador está registrado y el servicio también', () => {
    expect(meta('controllers', CommercialQuotesModule)).toContain(TiendaWebhookController);
    expect(meta('providers', CommercialQuotesModule)).toContain(TiendaPedidoService);
  });

  it('⭐ y las tres dependencias del servicio son providers del MISMO módulo', () => {
    // Sin esto Nest no arranca: «Nest can't resolve dependencies of TiendaPedidoService».
    const prov = meta('providers', CommercialQuotesModule);
    for (const dep of [CommercialQuotesService, QuotePricingService, QuoteKeplerService]) {
      expect(prov).toContain(dep);
    }
  });

  it('POST webhooks/tienda/pedido, y contesta 200', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TiendaWebhookController)).toBe('webhooks/tienda');
    const h = TiendaWebhookController.prototype.pedido;
    expect(Reflect.getMetadata(PATH_METADATA, h)).toBe('pedido');
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, h)).toBe(200);
  });

  it('⛔ es público: Wix no manda Bearer, y sin esto el JwtAuthGuard global lo tapa', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, TiendaWebhookController.prototype.pedido)).toBe(true);
  });

  it('PRUEBA NEGATIVA: un método sin el decorador NO lleva la marca de público', () => {
    class Desnudo { pedido(): void { /* nada */ } }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, Desnudo.prototype.pedido)).toBeUndefined();
  });
});

describe('[COT.7.50] el webhook falla CERRADO', () => {
  const armar = (registrar = vi.fn()) =>
    new TiendaWebhookController(
      { run: (_c: unknown, f: () => unknown) => f() } as never,
      { registrar } as never,
    );
  const conToken = async <T>(valor: string | undefined, f: () => Promise<T>): Promise<T> => {
    const antes = process.env['TIENDA_WEBHOOK_TOKEN'];
    if (valor === undefined) delete process.env['TIENDA_WEBHOOK_TOKEN'];
    else process.env['TIENDA_WEBHOOK_TOKEN'] = valor;
    try { return await f(); } finally {
      if (antes === undefined) delete process.env['TIENDA_WEBHOOK_TOKEN'];
      else process.env['TIENDA_WEBHOOK_TOKEN'] = antes;
    }
  };
  const CUERPO = { body: { number: '11229', status: 'APPROVED', paymentStatus: 'PAID', lineItems: [] } };

  it('⛔⛔ sin TIENDA_WEBHOOK_TOKEN: 503 y NO mira el cuerpo', async () => {
    const registrar = vi.fn();
    await conToken(undefined, async () => {
      await expect(armar(registrar).pedido(CUERPO, 'loquesea')).rejects.toThrow(/no configurado/i);
    });
    expect(registrar).not.toHaveBeenCalled();
  });

  it('token equivocado: 403 y no se registra nada', async () => {
    const registrar = vi.fn();
    await conToken('secreto-bueno', async () => {
      await expect(armar(registrar).pedido(CUERPO, 'secreto-malo')).rejects.toThrow(/inválido/i);
    });
    expect(registrar).not.toHaveBeenCalled();
  });

  it('sin token en la llamada: 403', async () => {
    const registrar = vi.fn();
    await conToken('secreto-bueno', async () => {
      await expect(armar(registrar).pedido(CUERPO)).rejects.toThrow(/inválido/i);
    });
    expect(registrar).not.toHaveBeenCalled();
  });

  it('⭐ un token de otro LARGO no revienta la comparación, sólo rechaza', async () => {
    await conToken('secreto-bueno', async () => {
      await expect(armar().pedido(CUERPO, 'x')).rejects.toThrow(/inválido/i);
    });
  });

  it('con el token correcto en el encabezado: pasa y responde el resultado', async () => {
    const registrar = vi.fn().mockResolvedValue({ estado: 'creado', quote_code: 'COT-2026-00300', kepler_folio: '3991', kepler_sucursal: '01' });
    const r = await conToken('secreto-bueno', () => armar(registrar).pedido(CUERPO, 'secreto-bueno'));
    expect(r).toEqual({ recibido: true, numero: '11229', estado: 'creado', quote_code: 'COT-2026-00300', kepler_folio: '3991' });
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar.mock.calls[0][0]).toMatchObject({ numero: '11229', pago: 'PAID' });
  });

  it('el token también se acepta por la URL (declarado: queda en los registros)', async () => {
    const registrar = vi.fn().mockResolvedValue({ estado: 'rechazado', motivo: 'el pedido no tiene renglones' });
    const r = await conToken('secreto-bueno', () => armar(registrar).pedido(CUERPO, undefined, 'secreto-bueno'));
    expect(r).toMatchObject({ recibido: true, estado: 'rechazado', motivo: 'el pedido no tiene renglones' });
  });

  it('⭐ un rechazo de negocio contesta 200, no un 4xx que haría a Wix reintentar en círculos', async () => {
    const registrar = vi.fn().mockResolvedValue({ estado: 'rechazado', motivo: 'el pedido está cancelado' });
    const r = await conToken('secreto-bueno', () => armar(registrar).pedido(CUERPO, 'secreto-bueno'));
    expect(r.recibido).toBe(true);
    expect(r.estado).toBe('rechazado');
  });
});

describe('[COT.7.50] el pedido se encuentra venga envuelto o no', () => {
  const PED = { number: '11229', lineItems: [] };
  it('crudo', () => expect(pedidoDelCuerpo(PED)).toBe(PED));
  it('dentro de order', () => expect(pedidoDelCuerpo({ order: PED })).toBe(PED));
  it('dentro de data.order', () => expect(pedidoDelCuerpo({ data: { order: PED } })).toBe(PED));
  it('dentro de data', () => expect(pedidoDelCuerpo({ data: PED })).toBe(PED));
  it('⭐ un envoltorio que NO tiene pedido devuelve el crudo, no un objeto inventado', () => {
    const raro = { hola: 1 };
    expect(pedidoDelCuerpo(raro)).toBe(raro);
  });
});
