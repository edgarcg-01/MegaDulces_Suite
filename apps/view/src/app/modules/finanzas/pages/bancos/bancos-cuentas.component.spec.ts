import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { MetricStripComponent } from '../../../../shared/components/metric-strip/metric-strip.component';
import { BancosCuentasComponent } from './bancos-cuentas.component';
import { BalanceRow, Balances, Diagnostico } from '../../bank.service';

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

/**
 * `[BFU.4.5.13]` Cuentas contesta UNA pregunta —¿cierran los saldos?— y lo que entró y salió se fue a «Ingresos y
 * egresos» (Edgar, 2026-11-25: «para no hacer tanto scroll»). Importes inventados.
 */
describe('[BFU.4.5.13] Cuentas: los saldos en una tira, lo que pide algo primero', () => {
  const tres = bal([
    fila({ account_label: '1111', fuente: 'banco', hasta: '2026-11-24', banco_hasta: '2026-11-24' }),
    fila({ account_label: '2222', fuente: 'banco', cuadra: false, delta: 150, hasta: '2026-11-24', banco_hasta: '2026-11-24' }),
    fila({ account_label: '3333', sin_saldo: true, fuente: undefined }),
    fila({ account_label: '4444', fuente: 'libro', hasta: '2026-11-10', banco_hasta: '2026-11-18' }),
  ]);
  it('la tira dice cuántas cierran, cuántas no y cuántas no tienen movimientos, sin animar', () => {
    const fx = montar(tres);
    const c = fx.componentInstance;
    expect(c.cifrasSaldos().map((x) => [x.label, x.value])).toEqual([['Saldos', '2 de 3 cierran'], ['No cierran', 1], ['Sin movimientos', 1]]);
    expect(fx.debugElement.query(By.directive(MetricStripComponent)).componentInstance.instant()).toBe(true);
  });
  it('la tabla pone primero la que no cierra, luego la que sale del libro, la sin saldo y al final las que cierran', () => {
    const c = montar(tres).componentInstance;
    expect(c.cuentasOrdenadas().map((a) => a.account_label)).toEqual(['2222', '4444', '3333', '1111']);
  });
  it('lo que cierra no lleva color ni repite «$0.00»; lo que no cierra, sí dice cuánto', () => {
    const el = montar(tres).nativeElement as HTMLElement;
    // La columna Δ (la 9a: desplegar, cuenta, fuente, inicial, depósitos, retiros, calculado, final, Δ, cierra).
    const deltas = Array.from(el.querySelectorAll('.fb-bal tbody tr')).map((tr) => tr.querySelectorAll('td')[8]?.textContent?.trim());
    expect(deltas).toEqual(['$150.00', '—', '—', '—']);
    expect(el.querySelector('.ok')).toBeNull();
  });
  it('«Falta explicar» lleva a Ingresos y egresos', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [BancosCuentasComponent], providers: [provideZonelessChangeDetection()] });
    const fx = TestBed.createComponent(BancosCuentasComponent);
    fx.componentRef.setInput('balances', tres);
    fx.componentRef.setInput('statements', []);
    fx.componentRef.setInput('diagnostico', { items: [], cobertura_categoria: { explicado: { n: 10, monto: 1, por_ligar: { n: 565, monto: 35_400_000 }, atrasados: 216 } } } as unknown as Diagnostico);
    fx.componentRef.setInput('period', '2026-11');
    fx.detectChanges();
    const c = fx.componentInstance;
    const falta = c.cifrasSaldos().find((x) => x.label === 'Falta explicar');
    expect(falta).toMatchObject({ value: '$35.4 M', drill: 'ingresos' });
    let n = 0; c.irAIngresos.subscribe(() => n++);
    c.onDrill('ingresos');
    expect(n).toBe(1);
  });
});
