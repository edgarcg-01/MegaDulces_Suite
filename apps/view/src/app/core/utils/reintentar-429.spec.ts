import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { defer, of, throwError } from 'rxjs';
import { esperaDe429, reintentarSi429 } from './reintentar-429';
import { CashLedgerService } from '../../modules/finanzas/cash-ledger.service';

/**
 * `[CGP-V.4]` Una lectura que cae en el 429 se reintenta en la ventana siguiente.
 *
 * Medido el 2026-10-15: al entrar, Caja General lanza 10 GET a la vez (más los del marco de la app)
 * contra un límite de 10 por segundo por IP. El que caía en el 429 dejaba su bloque «sin medir» —y
 * si era el saldo, el cierre pedía «Reintentar»— sin que nada estuviera roto.
 */
const e429 = (h: Record<string, string> = {}) =>
  new HttpErrorResponse({ status: 429, headers: new HttpHeaders(h) });

describe('[CGP-V.4] esperaDe429', () => {
  it('sin cabecera espera un segundo por intento', () => {
    expect(esperaDe429(e429(), 1)).toBe(1000);
    expect(esperaDe429(e429(), 2)).toBe(2000);
  });

  it('respeta lo que dice el servidor, de cualquier tramo, y toma el mayor', () => {
    expect(esperaDe429(e429({ 'Retry-After-short': '1', 'Retry-After-medium': '3' }), 1)).toBe(3000);
  });

  it('⛔ si el tramo bloqueado pide más de 10 s no se reintenta: se declara', () => {
    expect(esperaDe429(e429({ 'Retry-After-long': '45' }), 1)).toBeNull();
  });

  it('⛔ otro error no es un 429: no se reintenta', () => {
    expect(esperaDe429(new HttpErrorResponse({ status: 500 }), 1)).toBeNull();
    expect(esperaDe429(new HttpErrorResponse({ status: 404 }), 1)).toBeNull();
    expect(esperaDe429(null, 1)).toBeNull();
  });
});

describe('[CGP-V.4] reintentarSi429', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('un 429 y después la respuesta: llega la respuesta', async () => {
    let n = 0;
    const fuente = defer(() => (++n === 1 ? throwError(() => e429()) : of('saldo')));
    const valores: string[] = [];
    fuente.pipe(reintentarSi429()).subscribe((v) => valores.push(v));
    await vi.advanceTimersByTimeAsync(1000);
    expect(valores).toEqual(['saldo']);
    expect(n).toBe(2);
  });

  it('⛔ tres 429 seguidos: a la tercera se rinde y entrega el error', async () => {
    let n = 0;
    const fuente = defer(() => { n++; return throwError(() => e429()); });
    let err: unknown = null;
    fuente.pipe(reintentarSi429()).subscribe({ error: (e) => (err = e) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBe(3);
    expect((err as HttpErrorResponse).status).toBe(429);
  });

  it('⛔ un 500 se entrega al instante, sin reintentar', () => {
    let n = 0;
    const fuente = defer(() => { n++; return throwError(() => new HttpErrorResponse({ status: 500 })); });
    let err: unknown = null;
    fuente.pipe(reintentarSi429()).subscribe({ error: (e) => (err = e) });
    expect(n).toBe(1);
    expect((err as HttpErrorResponse).status).toBe(500);
  });
});

describe('[CGP-V.4] las lecturas de caja reintentan; las escrituras no', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('el saldo que cae en el 429 se vuelve a pedir y llega', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const svc = TestBed.inject(CashLedgerService);
    const http = TestBed.inject(HttpTestingController);
    let saldo: unknown = null;
    svc.saldo('00').subscribe((r) => (saldo = r));
    http.expectOne((r) => r.url.endsWith('/saldo/00')).flush({}, { status: 429, statusText: 'Too Many Requests' });
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne((r) => r.url.endsWith('/saldo/00')).flush({ sucursal: '00' });
    expect(saldo).toEqual({ sucursal: '00' });
    http.verify();
  });

  it('⛔ una escritura (abrir el corte) NO se repite sola ante un 429', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const svc = TestBed.inject(CashLedgerService);
    const http = TestBed.inject(HttpTestingController);
    let err: unknown = null;
    svc.abrirCorte({ fecha: '2026-10-12', sucursal: '00' }).subscribe({ error: (e) => (err = e) });
    http.expectOne((r) => r.url.endsWith('/cortes')).flush({}, { status: 429, statusText: 'Too Many Requests' });
    await vi.advanceTimersByTimeAsync(5000);
    http.expectNone((r) => r.url.endsWith('/cortes'));
    expect((err as HttpErrorResponse).status).toBe(429);
    http.verify();
  });
});
