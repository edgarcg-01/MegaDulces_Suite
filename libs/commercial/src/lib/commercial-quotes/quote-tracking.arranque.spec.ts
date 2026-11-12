import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Permission } from '@megadulces/platform-core';
import { CommercialQuotesModule } from './commercial-quotes.module';
import { CommercialQuotesService } from './commercial-quotes.service';
import { QuoteTrackingController } from './quote-tracking.controller';
import { QuoteTrackingService } from './quote-tracking.service';

/**
 * `[GP.9.1]` Que compile no es que arranque (`#414`): vitest no emite `design:paramtypes`, así que el
 * grafo se lee de los decoradores. Y la ruta se verifica por su metadata, no por suposición.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

describe('[GP.9.1] el seguimiento entra al módulo de cotizaciones sin mover lo que ya está en prod', () => {
  it('servicio con 3 dependencias y controlador con 1 (si cambia, revisar el arranque)', () => {
    expect(QuoteTrackingService.length).toBe(3);
    expect(QuoteTrackingController.length).toBe(1);
  });

  it('controlador y servicio registrados; CommercialQuotesService (su dependencia) es provider del mismo módulo', () => {
    expect(meta('controllers', CommercialQuotesModule)).toContain(QuoteTrackingController);
    const prov = meta('providers', CommercialQuotesModule);
    expect(prov).toContain(QuoteTrackingService);
    expect(prov).toContain(CommercialQuotesService);
  });

  it('GET commercial/quotes/:id/tracking — dos segmentos, no choca con GET :id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, QuoteTrackingController)).toBe('commercial/quotes');
    const h = QuoteTrackingController.prototype.seguimiento;
    expect(Reflect.getMetadata(PATH_METADATA, h)).toBe(':id/tracking');
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
  });

  it('exige el permiso de VER cotizaciones (no el de gestionar)', () => {
    const h = QuoteTrackingController.prototype.seguimiento;
    const valores = Reflect.getMetadataKeys(h).flatMap((k) => {
      const v = Reflect.getMetadata(k, h);
      return Array.isArray(v) ? v : [v];
    });
    expect(valores).toContain(Permission.COMMERCIAL_QUOTES_VER);
    expect(valores).not.toContain(Permission.COMMERCIAL_QUOTES_GESTIONAR);
  });

  it('PRUEBA NEGATIVA: un controlador sin el decorador de permiso no lleva la clave', () => {
    class Desnudo { seguimiento(): void { /* nada */ } }
    const h = Desnudo.prototype.seguimiento;
    const valores = Reflect.getMetadataKeys(h).flatMap((k) => [Reflect.getMetadata(k, h)].flat());
    expect(valores).not.toContain(Permission.COMMERCIAL_QUOTES_VER);
  });
});

describe('[GP.9.1] el seguimiento respeta de quién es la cotización y no consulta de más', () => {
  it('si assertPuedeAbrir rechaza, no se toca la base', async () => {
    const run = vi.fn();
    const s = new QuoteTrackingService({ run } as never, { requireTenantId: () => 't' } as never,
      { assertPuedeAbrir: vi.fn().mockRejectedValue(new Error('ajena')) } as never);
    await expect(s.seguimiento('00000000-0000-0000-0000-000000000001', null)).rejects.toThrow('ajena');
    expect(run).not.toHaveBeenCalled();
  });

  it('id que no es UUID → 400 antes de cualquier consulta', async () => {
    const assert = vi.fn();
    const s = new QuoteTrackingService({ run: vi.fn() } as never, { requireTenantId: () => 't' } as never, { assertPuedeAbrir: assert } as never);
    await expect(s.seguimiento('1; drop', null)).rejects.toThrow('id inválido');
    expect(assert).not.toHaveBeenCalled();
  });

  it('cotización sin folio de Kepler → en_kepler:false y UNA sola consulta (la cabecera)', async () => {
    const raw = vi.fn().mockResolvedValue({ rows: [{ code: 'COT-2026-00001', erp_customer_code: 'C1', kepler_sucursal: null, kepler_folio: null }] });
    const s = new QuoteTrackingService({ run: async (fn: (k: unknown) => unknown) => fn({ raw }) } as never,
      { requireTenantId: () => 't' } as never, { assertPuedeAbrir: vi.fn() } as never);
    const r = await s.seguimiento('00000000-0000-0000-0000-000000000001', null);
    expect(r).toMatchObject({ en_kepler: false, pendiente_replica: false, pasos: [] });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('con folio pero sin el pedido en la réplica → pendiente_replica, sin inventar pasos', async () => {
    const raw = vi.fn()
      .mockResolvedValueOnce({ rows: [{ code: 'COT-2026-00275', erp_customer_code: 'C1', kepler_sucursal: '01', kepler_folio: '3987' }] })
      .mockResolvedValueOnce({ rows: [] });
    const s = new QuoteTrackingService({ run: async (fn: (k: unknown) => unknown) => fn({ raw }) } as never,
      { requireTenantId: () => 't' } as never, { assertPuedeAbrir: vi.fn() } as never);
    const r = await s.seguimiento('00000000-0000-0000-0000-000000000001', null);
    expect(r).toMatchObject({ en_kepler: true, pendiente_replica: true, pasos: [] });
    // el folio se rellena a 7 dígitos y el código va dos veces (trae_cotizacion y el orden)
    expect(raw.mock.calls[1][1]).toEqual(['COT-2026-00275', '01', '0003987', 'COT-2026-00275']);
  });
});
