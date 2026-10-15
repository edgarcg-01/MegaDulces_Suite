import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { uuidV4 } from './uuid';
import { CashLedgerService } from '../../modules/finanzas/cash-ledger.service';

/**
 * `[CGP-V.10]` La llave de idempotencia no puede depender de un contexto seguro.
 *
 * `crypto.randomUUID` sólo existe en HTTPS o en localhost. Las sucursales abren la Suite por
 * `http://` en la LAN, donde es `undefined`: «Confirmar N» llamaba `crypto.randomUUID()` al armar
 * la petición, reventaba ANTES de emitirla y el botón se quedaba cargando para siempre.
 */
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('[CGP-V.10] uuidV4 sin contexto seguro', () => {
  const real = globalThis.crypto;
  const poner = (c: unknown) => Object.defineProperty(globalThis, 'crypto', { value: c, configurable: true });
  afterEach(() => poner(real));

  it('con randomUUID, lo usa', () => {
    poner({ randomUUID: () => '11111111-1111-4111-8111-111111111111' });
    expect(uuidV4()).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('⛔ sin randomUUID (http:// en la LAN) sale un v4 válido de getRandomValues', () => {
    poner({ getRandomValues: real.getRandomValues.bind(real) });
    const a = uuidV4();
    const b = uuidV4();
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
  });

  it('⛔ sin crypto en absoluto, igual sale un v4 válido', () => {
    poner(undefined);
    expect(uuidV4()).toMatch(V4);
  });

  it('⛔ «Confirmar N» arma la petición sin randomUUID, con una llave por fila', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const svc = TestBed.inject(CashLedgerService);
    const http = TestBed.inject(HttpTestingController);
    poner({ getRandomValues: real.getRandomValues.bind(real) });

    svc.confirmarLote([{ origen_ref: 'a' }, { origen_ref: 'b' }]).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/lote'));
    const items = req.request.body.items as Array<{ client_uuid: string }>;
    expect(items.map((i) => i.client_uuid).every((u) => V4.test(u))).toBe(true);
    expect(items[0].client_uuid).not.toBe(items[1].client_uuid);
    req.flush({});
    http.verify();
  });
});
