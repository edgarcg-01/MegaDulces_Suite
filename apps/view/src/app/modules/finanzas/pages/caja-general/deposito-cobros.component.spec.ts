import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import type { DepositoCobros, LigarCobrosResultado } from '@megadulces/contracts';
import { CaosService } from '../../caos.service';
import { DepositoCobrosComponent } from './deposito-cobros.component';

/**
 * ⭐ `[LE.6.37]` «¿De qué cobros es este depósito?», con el caso que lo pidió: el depósito «rd can
 * 13/11» de $51,770 y los cobros de las rutas 501, 502 y 503 de Canindo, más ruido de Morelia.
 */
const DATOS: DepositoCobros = {
  deposito: { device: 'AST700-19758', external_id: 1954, fecha: '2026-11-18', ref: 'rd can 13/11', total: 51770, libre: 51770 },
  desde: '2026-10-28',
  has_more: false,
  rows: [
    { cash_ledger_id: 'c501', folio: 'CI-2026-00495', fecha: '2026-11-17', sucursal: '06-001', ruta: '501', glosa: 'U-A-5 0000040 · CONTADO', monto: 13414.29, falta: 13414.29 },
    { cash_ledger_id: 'c502', folio: 'CI-2026-00496', fecha: '2026-11-13', sucursal: '06-002', ruta: '502', glosa: 'U-A-5 0000043 · CONTADO', monto: 13260.58, falta: 13260.58 },
    { cash_ledger_id: 'c503', folio: 'CI-2026-00497', fecha: '2026-11-13', sucursal: '06-003', ruta: '503', glosa: 'U-A-5 0000037 · CONTADO', monto: 25154.77, falta: 25154.77 },
    { cash_ledger_id: 'm01', folio: 'CI-2026-00441', fecha: '2026-11-12', sucursal: '01', ruta: null, glosa: 'U-A-5 0000508 · CONTADO', monto: 24813, falta: 24813 },
  ],
};

@Component({
  standalone: true,
  imports: [DepositoCobrosComponent],
  template: `<app-deposito-cobros device="AST700-19758" [externalId]="1954" refTexto="rd can 13/11" (ligado)="r.set($event)" />`,
})
class HostComponent { readonly r = signal<LigarCobrosResultado | null>(null); }

function montar(caos: Partial<CaosService>) {
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [provideZonelessChangeDetection(), { provide: CaosService, useValue: caos }],
  });
  const fx = TestBed.createComponent(HostComponent);
  fx.detectChanges();
  const el = fx.nativeElement as HTMLElement;
  const q = (s: string) => el.querySelector(s) as HTMLElement | null;
  const marcar = (folio: string) => {
    (el.querySelector(`tr[data-folio="${folio}"] td:nth-child(3)`) as HTMLElement).click();
    fx.detectChanges();
  };
  const toma = (folio: string) => (el.querySelector(`tr[data-folio="${folio}"] td:last-child`)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { fx, el, q, marcar, toma };
}

describe('[LE.6.37] DepositoCobros — ligar cobros ya capturados a un depósito', () => {
  it('⭐ Canindo: marcar 501, 502, 503 reparte igual que el servidor y dice lo que se queda en caja', () => {
    const { q, marcar, toma } = montar({ cobrosParaDeposito: vi.fn(() => of(DATOS)) });
    marcar('CI-2026-00495'); marcar('CI-2026-00496'); marcar('CI-2026-00497');
    expect(toma('CI-2026-00495')).toContain('$13,414.29');
    expect(toma('CI-2026-00497')).toContain('$25,095.13');
    expect(toma('CI-2026-00497')).toContain('$59.64 se queda en caja');
    const resumen = q('[data-testid="dc-resumen"]')!.textContent!.replace(/\s+/g, ' ');
    expect(resumen).toMatch(/Ligas.*\$51,770\.00/);
    expect(resumen).toMatch(/Se queda en caja.*\$59\.64/);
    expect(resumen).not.toContain('faltan cobros');
    expect(q('[data-testid="dc-ligar"] button')!.textContent).toContain('Ligar 3 cobros');
  });

  it('manda los ids en el orden marcado y entrega el resultado al padre', () => {
    const r: LigarCobrosResultado = { ok: true, vinculos: [], ligado: 51770, libre: 0, sin_depositar: 59.64 };
    const ligarCobros = vi.fn(() => of(r));
    const { fx, q, marcar } = montar({ cobrosParaDeposito: vi.fn(() => of(DATOS)), ligarCobros });
    marcar('CI-2026-00496'); marcar('CI-2026-00495'); marcar('CI-2026-00497');
    (q('[data-testid="dc-ligar"] button') as HTMLButtonElement).click(); fx.detectChanges();
    expect(ligarCobros).toHaveBeenCalledWith('AST700-19758', 1954, { cash_ledger_ids: ['c502', 'c501', 'c503'] });
    expect(fx.componentInstance.r()).toEqual(r);
  });

  it('CONTROL: con menos cobros que el depósito dice cuánto le falta, y deja ligar', () => {
    const { q, marcar } = montar({ cobrosParaDeposito: vi.fn(() => of(DATOS)) });
    marcar('CI-2026-00495');
    expect(q('[data-testid="dc-resumen"]')!.textContent).toContain('faltan cobros por $38,355.71');
    expect((q('[data-testid="dc-ligar"] button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('D.7 con teclado: Espacio sobre la fila la marca (sin mouse)', () => {
    const { fx, el, toma } = montar({ cobrosParaDeposito: vi.fn(() => of(DATOS)) });
    const fila = el.querySelector('tr[data-folio="CI-2026-00495"]') as HTMLElement;
    fila.focus();
    fila.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
    fx.detectChanges();
    expect(toma('CI-2026-00495')).toContain('$13,414.29');
  });

  it('NEGATIVA: un cobro marcado al que ya no le alcanza nada apaga «Ligar» y lo dice en su fila', () => {
    const { q, marcar, toma } = montar({ cobrosParaDeposito: vi.fn(() => of(DATOS)) });
    marcar('CI-2026-00495'); marcar('CI-2026-00496'); marcar('CI-2026-00497'); marcar('CI-2026-00441');
    expect(toma('CI-2026-00441')).toContain('ya no alcanza');
    expect((q('[data-testid="dc-ligar"] button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('el buscador encuentra por ruta y por nombre de sucursal (no sólo por código)', () => {
    const { fx, el, q } = montar({ cobrosParaDeposito: vi.fn(() => of(DATOS)) });
    const buscar = q('[data-testid="dc-buscar"]') as HTMLInputElement;
    buscar.value = 'ruta 503'; buscar.dispatchEvent(new Event('input')); fx.detectChanges();
    expect([...el.querySelectorAll('tr[data-folio]')].map((t) => t.getAttribute('data-folio'))).toEqual(['CI-2026-00497']);
    buscar.value = 'canindo'; buscar.dispatchEvent(new Event('input')); fx.detectChanges();
    expect(el.querySelectorAll('tr[data-folio]').length).toBe(3);
  });

  it('NEGATIVA: si la lectura falla se dice como error, no como «no hay cobros»', () => {
    const { el } = montar({ cobrosParaDeposito: vi.fn(() => throwError(() => ({ error: { message: 'sin permiso' } }))) });
    expect(el.textContent).toContain('No se pudieron leer los cobros');
    expect(el.textContent).not.toContain('No hay cobros capturados sin depósito');
  });
});
