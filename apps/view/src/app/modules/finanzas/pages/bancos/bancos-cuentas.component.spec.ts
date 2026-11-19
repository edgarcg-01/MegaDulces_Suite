import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { BancosCuentasComponent } from './bancos-cuentas.component';
import { BalanceRow, Balances } from '../../bank.service';

/**
 * `[BFU.0.1]` Cuentas dice de dónde sale cada saldo y hasta qué día. Caso real que lo motivó (2026-11-19): las 16
 * cuentas «cuadraban» con el libro de Tesorería al 10-nov y la pantalla no lo decía. Importes inventados.
 */
const fila = (p: Partial<BalanceRow>): BalanceRow => ({
  statement_id: p.account_label ?? 'x', bank: 'BBVA', account_label: '6721', kind: 'bank',
  opening: 100, total_in: 50, total_out: 0, computed_closing: 150, closing: 150, delta: 0, cuadra: true, sin_saldo: false,
  fuente: 'libro', banco_desde: null, hasta: '2026-11-10', banco_hasta: '2026-11-18', ...p,
});
const bal = (accounts: BalanceRow[]): Balances => ({
  period: '2026-11', accounts, traspasos: { entra: 0, sale: 0, delta: 0 },
  totals: { opening: 0, total_in: 0, total_out: 0, closing: 0, descuadre: 0 },
  cuentas_descuadradas: accounts.filter((a) => !a.cuadra && !a.sin_saldo).length,
  cuentas_sin_saldo: accounts.filter((a) => a.sin_saldo).length,
});

function montar(b: Balances) {
  TestBed.configureTestingModule({ imports: [BancosCuentasComponent], providers: [provideZonelessChangeDetection()] });
  const fx = TestBed.createComponent(BancosCuentasComponent);
  fx.componentRef.setInput('balances', b);
  fx.componentRef.setInput('statements', []);
  fx.componentRef.setInput('diagnostico', null);
  fx.componentRef.setInput('period', '2026-11');
  fx.detectChanges();
  return fx;
}

describe('[BFU.0.1] Cuentas dice la fuente y el día de cada saldo', () => {
  it('una cuenta con el libro dice «Libro de Tesorería al 10/11» y que el banco ya trae más', () => {
    const fx = montar(bal([fila({})]));
    const txt = (fx.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('Libro de Tesorería');
    expect(txt).toContain('al 10/11');
    expect(txt).toContain('el banco ya trae al 18/11');
    expect(txt).toContain('1 con el libro de Tesorería');
  });

  it('control: ya no afirma «todo cuadra» ni «cuadran N» cuando la fuente es el libro', () => {
    const txt = (montar(bal([fila({}), fila({ account_label: '4176' })])).nativeElement as HTMLElement).textContent ?? '';
    expect(txt).not.toContain('todo cuadra');
    expect(txt).not.toMatch(/cuadran \d/);
  });

  it('una cuenta que ya usa el banco no ofrece pasarla, y el resumen lo cuenta aparte', () => {
    const fx = montar(bal([fila({ fuente: 'banco', banco_desde: '2026-11-01', hasta: '2026-11-18', banco_hasta: '2026-11-18' }), fila({ account_label: '4176' })]));
    const c = fx.componentInstance;
    expect(c.bancoAdelante(fila({ fuente: 'banco', hasta: '2026-11-10', banco_hasta: '2026-11-18' }))).toBeNull();
    expect(c.adelantadas(bal([fila({ fuente: 'banco' }), fila({})]))).toBe(1);
    expect((fx.nativeElement as HTMLElement).textContent).toContain('1 con el banco · 1 con el libro de Tesorería');
  });

  it('control: con el libro al mismo día que el banco no dice que el banco va adelante', () => {
    const c = montar(bal([fila({ hasta: '2026-11-18', banco_hasta: '2026-11-18' })])).componentInstance;
    expect(c.adelantadas(bal([fila({ hasta: '2026-11-18', banco_hasta: '2026-11-18' })]))).toBe(0);
  });

  it('«Ir a Estados de cuenta» avisa al shell', () => {
    const fx = montar(bal([fila({})]));
    let n = 0; fx.componentInstance.irAEstados.subscribe(() => n++);
    const btn = Array.from((fx.nativeElement as HTMLElement).querySelectorAll('button')).find((b) => b.textContent?.includes('Ir a Estados de cuenta'));
    btn?.click();
    expect(n).toBe(1);
  });

  it('una API vieja sin fuente se declara «no medido», no se pinta como libro ni como banco', () => {
    const txt = (montar(bal([fila({ fuente: undefined, hasta: undefined, banco_hasta: undefined })])).nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('no medido');
    expect(txt).not.toContain('Libro de Tesorería');
  });
});
