import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { BancosCuentasComponent } from './bancos-cuentas.component';
import { BalanceRow, Balances, CoberturaCategoria, CoberturaPorArea, Diagnostico } from '../../bank.service';

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
 * `[BFU.4.5.12]` Lo que entró por su origen y lo que salió por su área (Edgar, 2026-11-25: «a simple vista le falta si es
 * ingreso o egreso, y faltan las ventas de la tienda»). Importes inventados.
 */
const g = (area: string, n: number, monto: number, ligar = 0, extra: Partial<CoberturaPorArea> = {}): CoberturaPorArea => ({
  area, nombre: extra.nombre ?? area, atiende: null, n, monto, sin_categoria: { n: 0, monto: 0 },
  explicado: { n: n - ligar, monto: ligar ? 0 : monto }, por_ligar: { n: ligar, monto: ligar ? monto : 0 }, atrasados: 0, motivos: [], ...extra,
});
const cob = (): CoberturaCategoria => {
  const tienda = g('venta_tienda', 7, 1400, 0, { nombre: 'Venta de tienda',
    sucursales: [{ sucursal: '05', nombre: 'Sucursal Cinco', n: 2, monto: 900 }, { sucursal: '08', nombre: 'Sucursal Ocho', n: 5, monto: 500 }] });
  const ent = [tienda, g('cobranza', 3, 300, 0, { nombre: 'Cobranza de facturas' }), g('sin_documento:terminal', 4, 40, 4, { nombre: 'Venta con tarjeta' })];
  const sal = [g('compras', 2, 700, 0, { nombre: 'Compras' })];
  const dir = (gs: CoberturaPorArea[]) => ({ n: gs.reduce((t, x) => t + x.n, 0), monto: gs.reduce((t, x) => t + x.monto, 0),
    explicado: { n: gs.reduce((t, x) => t + x.explicado!.n, 0), monto: gs.reduce((t, x) => t + x.explicado!.monto, 0) },
    por_ligar: { n: gs.reduce((t, x) => t + x.por_ligar!.n, 0), monto: gs.reduce((t, x) => t + x.por_ligar!.monto, 0) }, atrasados: 0, grupos: gs });
  return { evaluados: 16, suma_cuadra: true, por_area: [g('credito_cobranza', 14, 1740, 4), g('compras', 2, 700)],
    explicado: { n: 12, monto: 2400, por_ligar: { n: 4, monto: 40 }, atrasados: 0 }, entradas: dir(ent), salidas: dir(sal) };
};
function montarConCobertura(c: CoberturaCategoria) {
  TestBed.configureTestingModule({ imports: [BancosCuentasComponent], providers: [provideZonelessChangeDetection(), provideRouter([])] });
  const fx = TestBed.createComponent(BancosCuentasComponent);
  fx.componentRef.setInput('balances', null);
  fx.componentRef.setInput('statements', []);
  fx.componentRef.setInput('diagnostico', { cobertura_categoria: c } as unknown as Diagnostico);
  fx.componentRef.setInput('period', '2026-11');
  fx.detectChanges();
  return fx;
}

describe('[BFU.4.5.12] Cuentas separa lo que entró de lo que salió, y dice la venta de tienda', () => {
  it('dos tablas: Entradas por origen y Salidas por área, cada una con su total', () => {
    const fx = montarConCobertura(cob());
    const txt = (fx.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('Entradas');
    expect(txt).toContain('Salidas');
    expect(txt).toContain('Venta de tienda');
    expect(txt).toContain('cobro de un corte de caja de la sucursal');
    expect(txt).toContain('Venta con tarjeta');
    expect(txt).toContain('sin documento de Kepler · así lo nombra el banco');
    expect(txt).toContain('Total entradas');
    expect(txt).toContain('Total salidas');
    // la tabla de áreas lleva SÓLO las salidas: el área de cobranza (que juntaba todos los depósitos) ya no sale ahí
    expect(fx.componentInstance.tablaDeAreas().map((a) => a.area)).toEqual(['compras']);
  });
  it('clic en un origen abre sus entradas; en «por ligar», sólo lo pendiente', () => {
    const fx = montarConCobertura(cob());
    const ev: unknown[] = []; fx.componentInstance.openGrupo.subscribe((e) => ev.push(e));
    const filas = Array.from((fx.nativeElement as HTMLElement).querySelectorAll('tr.fb-row-click')) as HTMLElement[];
    filas.find((r) => r.textContent?.includes('Cobranza de facturas'))!.click();
    (fx.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.fb-ligar')!.click();
    expect(ev).toEqual([{ direccion: 'entra', origen: 'cobranza', porLigar: false }, { direccion: 'entra', origen: 'sin_documento:terminal', porLigar: true }]);
  });
  it('la venta de tienda se abre por sucursal: cada una abre sus depósitos y liga a sus cortes del mes', async () => {
    const fx = montarConCobertura(cob());
    const ev: unknown[] = []; fx.componentInstance.openGrupo.subscribe((e) => ev.push(e));
    const el = fx.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Sucursal Cinco');
    el.querySelector<HTMLButtonElement>('button.fb-tog')!.click();
    fx.detectChanges(); await fx.whenStable();
    expect(el.textContent).toContain('Sucursal Cinco');
    const liga = el.querySelector<HTMLAnchorElement>('a.fb-cortes')!;
    expect(liga.getAttribute('href')).toBe('/finanzas/cortes-sucursales?month=2026-11&sucursal=05');
    (el.querySelector('tr.fb-suc') as HTMLElement).click();
    expect(ev).toEqual([{ direccion: 'entra', origen: 'venta_tienda', sucursal: '05' }]);
  });
  it('las cifras de arriba abren entradas, salidas, la venta de tienda y lo que falta ligar', () => {
    const c = montarConCobertura(cob()).componentInstance;
    const ev: unknown[] = []; c.openGrupo.subscribe((e) => ev.push(e));
    expect(c.cifras().map((x) => x.label)).toEqual(['Entró', 'Salió', 'Venta de tienda', 'Por ligar', 'Más de 5 días hábiles']);
    for (const k of ['entra', 'sale', 'venta_tienda', 'por_ligar']) c.onDrill(k);
    expect(ev).toEqual([{ direccion: 'entra' }, { direccion: 'sale' }, { direccion: 'entra', origen: 'venta_tienda' }, { porLigar: true }]);
  });
  it('⛔ [negativa] una API sin direcciones no inventa entradas/salidas: lo dice y deja la tabla por área de antes', () => {
    const { entradas, salidas, ...vieja } = cob();
    const fx = montarConCobertura(vieja as CoberturaCategoria);
    const txt = (fx.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('No se pudo separar lo que entró de lo que salió');
    expect(txt).not.toContain('Total entradas');
    expect(fx.componentInstance.tablaDeAreas().map((a) => a.area)).toEqual(['credito_cobranza', 'compras']);
    expect(fx.componentInstance.cifras()).toEqual([]);
  });
});
