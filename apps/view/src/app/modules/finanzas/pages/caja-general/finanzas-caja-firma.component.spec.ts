import { describe, expect, it, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FinanzasCajaFirmaComponent } from './finanzas-caja-firma.component';
import { CajaFirmaApiService, type ResultadoFirma } from '../../caja-firma-api.service';
import type { FirmaSolicitudTelefono } from '@megadulces/contracts';

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar el boton. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

/**
 * ⭐⭐ `[CG.204]` **El teléfono por HTTP: no se rinde por la red y no miente.**
 *
 * Lo que esto clava, cada caso contra un defecto vivido (Edgar: *«a veces tienen que firmar hasta
 * 3 veces»*):
 *   · sin QR no hay campo para teclear un código (`[CG.207]`);
 *   · sin red, abrir y enviar se REINTENTAN solos, con techo, y se dice en qué intento va;
 *   · «Firma enviada» sólo con el acuse del servidor;
 *   · un fallo del servidor (vencido, otro teléfono) NO se reintenta: reintentarlo no lo cambia;
 *   · el teléfono que vuelve a abrir un QR ya firmado oye «ya quedó», no «firma otra vez».
 *
 * ⚠️ PRUEBA NEGATIVA (corrida el 2026-10-23): con `enviar()` sin bucle (un solo intento), se ponen
 * rojas la 6 y la 7.
 */
const CTX: FirmaSolicitudTelefono = {
  estado: 'tomada',
  contexto: { tipo: 'gasto', monto: 1250.5, beneficiario: 'Juan Pérez', documento: 'X-D-26 1234' },
};
type Ver = ResultadoFirma<FirmaSolicitudTelefono>;
type Firmar = ResultadoFirma<{ ok: true; repetida: boolean }>;
const RED = { ok: false as const, fallo: 'red' as const };

function montar(url: string, ver: Ver[] = [{ ok: true, v: CTX }], firmar: Firmar[] = [{ ok: true, v: { ok: true, repetida: false } }]) {
  const colaVer = [...ver];
  const colaFirmar = [...firmar];
  const api = {
    ver: vi.fn(async (): Promise<Ver> => colaVer.length > 1 ? colaVer.shift()! : colaVer[0]),
    firmar: vi.fn(async (): Promise<Firmar> => colaFirmar.length > 1 ? colaFirmar.shift()! : colaFirmar[0]),
  };
  window.history.replaceState({}, '', url);
  TestBed.configureTestingModule({
    imports: [FinanzasCajaFirmaComponent],
    providers: [provideZonelessChangeDetection(), { provide: CajaFirmaApiService, useValue: api }],
  });
  const fx = TestBed.createComponent(FinanzasCajaFirmaComponent);
  const comp = fx.componentInstance;
  comp.esperaMs = () => 0;   // el reloj real haría esperar ~30 s por caso
  fx.detectChanges();
  return { fx, comp, api };
}

/** El trazo, sin canvas: jsdom no dibuja. Lo que se prueba es qué se hace con él. */
function conTrazo(comp: FinanzasCajaFirmaComponent): void {
  (comp as unknown as { pad: () => { aPng: () => string } }).pad = () => ({ aPng: () => 'data:image/png;base64,AAA' });
  comp.hecha.set(true);
}

const txt = (fx: { nativeElement: HTMLElement }) => fx.nativeElement.textContent ?? '';
const boton = (fx: { nativeElement: HTMLElement }, rotulo: string) =>
  [...fx.nativeElement.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(rotulo));
const listo = async (fx: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 0)); }
  await fx.whenStable();
  fx.detectChanges();
};

describe('[CG.204] el teléfono que firma, por HTTP', () => {
  afterEach(() => { TestBed.resetTestingModule(); window.history.replaceState({}, '', '/'); });

  it('1 · ⭐ [CG.207] sin QR no hay campo para teclear un código, y explica que hay que escanear', () => {
    const { fx, api } = montar('/firmar');
    expect(fx.nativeElement.querySelector('input'), 'sigue habiendo un campo para teclear').toBeNull();
    expect(txt(fx)).toContain('apunta al QR');
    expect(api.ver).not.toHaveBeenCalled();
  });

  it('2 · con el QR abre el pedido con el token y ESTE teléfono, y muestra qué se firma', async () => {
    const { fx, comp, api } = montar('/firmar?t=TOK');
    await listo(fx);
    expect(api.ver).toHaveBeenCalledWith('TOK', comp.telefono);
    expect(comp.telefono).toMatch(/^tel_[0-9a-f]{32}$/);
    expect(txt(fx)).toContain('Juan Pérez');
    expect(txt(fx)).toContain('1,250.50');
  });

  it('3 · sin red al abrir: reintenta SOLO hasta el techo, y después ofrece Reintentar', async () => {
    const { fx, comp, api } = montar('/firmar?t=TOK', [RED]);
    await listo(fx);
    expect(api.ver).toHaveBeenCalledTimes(comp.maxIntentos);
    expect(comp.aviso()).toContain('No hay conexión');
    expect(boton(fx, 'Reintentar'), 'sin Reintentar, la persona sólo puede pedir otro QR').toBeTruthy();
  });

  it('4 · un fallo del SERVIDOR (vencido) no se reintenta: se dice qué hacer', async () => {
    const { fx, comp, api } = montar('/firmar?t=TOK', [{ ok: false, fallo: 'vencida' }]);
    await listo(fx);
    expect(api.ver).toHaveBeenCalledTimes(1);
    expect(comp.aviso()).toContain('venció');
    expect(boton(fx, 'Reintentar'), 'reintentar un vencido no lo arregla').toBeFalsy();
  });

  it('5 · el MISMO teléfono que vuelve a abrir un QR ya firmado oye «ya quedó», no «firma otra vez»', async () => {
    const { fx, comp } = montar('/firmar?t=TOK', [{ ok: true, v: { ...CTX, estado: 'firmada' } }]);
    await listo(fx);
    expect(comp.enviada()).toBe(true);
    expect(txt(fx)).toContain('Firma enviada');
    expect(fx.nativeElement.querySelector('canvas'), 'le pidió firmar otra vez').toBeNull();
  });

  it('6 · ⭐ sin red al enviar: reintenta con el MISMO trazo y dice «enviada» sólo con el acuse', async () => {
    const { fx, comp, api } = montar('/firmar?t=TOK', undefined, [RED, RED, { ok: true, v: { ok: true, repetida: false } }]);
    await listo(fx);
    conTrazo(comp);
    await comp.enviar();
    fx.detectChanges();
    expect(api.firmar).toHaveBeenCalledTimes(3);
    for (const c of api.firmar.mock.calls) expect((c as unknown[])[2]).toBe('data:image/png;base64,AAA');
    expect(comp.enviada()).toBe(true);
  });

  it('7 · ⛔ si la red nunca vuelve NO dice «enviada», y la firma sigue ahí para mandarla después', async () => {
    const { fx, comp, api } = montar('/firmar?t=TOK', undefined, [RED]);
    await listo(fx);
    conTrazo(comp);
    await comp.enviar();
    fx.detectChanges();
    expect(api.firmar).toHaveBeenCalledTimes(comp.maxIntentos);
    expect(comp.enviada(), 'dijo enviada sin acuse').toBe(false);
    expect(comp.hecha(), 'se perdió el trazo').toBe(true);
    expect(comp.aviso()).toContain('Tu firma sigue acá');
  });

  it('8 · otro teléfono: el servidor dice que no, y no se reintenta', async () => {
    const { fx, comp, api } = montar('/firmar?t=TOK', undefined, [{ ok: false, fallo: 'otro_telefono' }]);
    await listo(fx);
    conTrazo(comp);
    await comp.enviar();
    expect(api.firmar).toHaveBeenCalledTimes(1);
    expect(comp.aviso()).toContain('otro teléfono');
    expect(comp.enviada()).toBe(false);
  });

  it('9 · el id del teléfono es ESTABLE: volver a abrir la pantalla es el mismo teléfono', async () => {
    const a = montar('/firmar?t=TOK');
    const id = a.comp.telefono;
    TestBed.resetTestingModule();
    const b = montar('/firmar?t=TOK');
    expect(b.comp.telefono).toBe(id);
  });
});
