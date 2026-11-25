import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { MetricStripComponent } from '../../../../shared/components/metric-strip/metric-strip.component';
import { BancosIngresosComponent, renglonesDeEgresos, renglonesDeIngresos } from './bancos-ingresos.component';
import { BalanceRow, Balances, CoberturaCategoria, CoberturaPorArea, Diagnostico } from '../../bank.service';

/**
 * `[BFU.4.5.13]` Bancos › Ingresos y egresos: de dónde viene y a dónde va cada peso, separado de los saldos (Edgar,
 * 2026-11-25: «para no hacer tanto scroll»). Viene de `[BFU.4.5.12]` («falta si es ingreso o egreso, y las ventas de la
 * tienda»), que vivía arriba de Cuentas. Importes inventados.
 */
const g = (area: string, n: number, monto: number, ligar = 0, extra: Partial<CoberturaPorArea> = {}): CoberturaPorArea => ({
  area, nombre: extra.nombre ?? area, atiende: null, n, monto, sin_categoria: { n: 0, monto: 0 },
  explicado: { n: n - ligar, monto: ligar ? 0 : monto }, por_ligar: { n: ligar, monto: ligar ? monto : 0 }, atrasados: 0, motivos: [], ...extra,
});
const dir = (gs: CoberturaPorArea[]) => ({ n: gs.reduce((t, x) => t + x.n, 0), monto: gs.reduce((t, x) => t + x.monto, 0),
  explicado: { n: gs.reduce((t, x) => t + x.explicado!.n, 0), monto: gs.reduce((t, x) => t + x.explicado!.monto, 0) },
  por_ligar: { n: gs.reduce((t, x) => t + x.por_ligar!.n, 0), monto: gs.reduce((t, x) => t + x.por_ligar!.monto, 0) },
  atrasados: gs.reduce((t, x) => t + (x.atrasados ?? 0), 0), grupos: gs });
const cob = (): CoberturaCategoria => {
  const tienda = g('venta_tienda', 7, 1400, 0, { nombre: 'Venta de tienda',
    sucursales: [{ sucursal: '05', nombre: 'Sucursal Cinco', n: 2, monto: 900 }, { sucursal: '08', nombre: 'Sucursal Ocho', n: 5, monto: 500 }] });
  const ent = [g('traspaso', 1, 5000, 0, { nombre: 'Traspasos entre cuentas' }), g('sin_documento:otro', 2, 20, 2, { nombre: 'Otro depósito' }), tienda,
    g('cobranza', 3, 300, 0, { nombre: 'Cobranza de facturas' }), g('sin_documento:terminal', 4, 40, 4, { nombre: 'Venta con tarjeta', atrasados: 3,
      motivos: [{ motivo: 'deposito_sin_documento', n: 4, monto: 40 }] })];
  const sal = [g('en_plazo', 2, 90, 2, { nombre: 'En plazo de captura' }), g('compras', 2, 700, 0, { nombre: 'Compras' }),
    g('otros', 1, 60, 0, { nombre: 'Otros', atiende: 'tesoreria' }), g('tesoreria', 3, 4800, 0, { nombre: 'Tesorería' })];
  return { evaluados: 25, suma_cuadra: true, por_area: [g('credito_cobranza', 14, 1740, 4), g('tesoreria', 3, 4800, 0, { nombre: 'Tesorería' })],
    explicado: { n: 17, monto: 11000, por_ligar: { n: 8, monto: 150 }, atrasados: 3 }, entradas: dir(ent), salidas: dir(sal),
    entre_cuentas: { entra: { n: 1, monto: 5000 }, sale: { n: 2, monto: 4700 } } };
};
const cuenta = (p: Partial<BalanceRow>): BalanceRow => ({ statement_id: p.account_label ?? 'x', bank: 'BBVA', account_label: '1', kind: 'bank',
  opening: 0, total_in: 0, total_out: 0, computed_closing: 0, closing: 0, delta: 0, cuadra: true, sin_saldo: false, ...p } as BalanceRow);
const saldos = (): Balances => ({ period: '2026-11', traspasos: { entra: 0, sale: 0, delta: 0 },
  totals: { opening: 0, total_in: 0, total_out: 0, closing: 0, descuadre: 0 }, cuentas_descuadradas: 1, cuentas_sin_saldo: 1,
  accounts: [cuenta({ account_label: 'a' }), cuenta({ account_label: 'b', cuadra: false, delta: 9 }), cuenta({ account_label: 'c', sin_saldo: true })] } as Balances);

function montar(c: CoberturaCategoria | null, extra: { balances?: Balances | null; cargando?: boolean; error?: string | null } = {}) {
  TestBed.configureTestingModule({ imports: [BancosIngresosComponent], providers: [provideZonelessChangeDetection(), provideRouter([])] });
  const fx = TestBed.createComponent(BancosIngresosComponent);
  fx.componentRef.setInput('diagnostico', c ? ({ items: [], sin_clasificar_n: 12, cobertura_categoria: c } as unknown as Diagnostico) : null);
  fx.componentRef.setInput('balances', extra.balances === undefined ? saldos() : extra.balances);
  fx.componentRef.setInput('period', '2026-11');
  fx.componentRef.setInput('cargando', extra.cargando ?? false);
  fx.componentRef.setInput('error', extra.error ?? null);
  fx.detectChanges();
  return fx;
}

describe('[BFU.4.5.13] renglonesDeIngresos / renglonesDeEgresos — el orden de lectura', () => {
  it('ingresos: con documento (lo que es ingreso primero, el traspaso al final) y sin documento (lo de más pesos primero)', () => {
    const r = renglonesDeIngresos(cob(), false);
    expect(r.map((x) => (x.tipo === 'grupo' ? `[${x.nombre}]` : x.clave))).toEqual([
      '[Con documento de Kepler]', 'venta_tienda', 'cobranza', 'traspaso', '[Sin documento · lo que dice el banco]', 'sin_documento:terminal', 'sin_documento:otro']);
    expect(r[0]).toMatchObject({ n: 11, monto: 6700 });
    expect(r.find((x) => x.clave === 'traspaso')).toMatchObject({ tenue: true });
    expect(r.find((x) => x.clave === 'venta_tienda')).toMatchObject({ desplegable: true, sub: 'cobro de un corte de caja · 2 sucursales' });
  });
  it('la venta de tienda nace plegada; desplegada, sus sucursales van debajo de ella', () => {
    expect(renglonesDeIngresos(cob(), false).some((x) => x.tipo === 'suc')).toBe(false);
    const r = renglonesDeIngresos(cob(), true);
    const i = r.findIndex((x) => x.clave === 'venta_tienda');
    expect(r.slice(i + 1, i + 3).map((x) => x.clave)).toEqual(['venta_tienda|05', 'venta_tienda|08']);
  });
  it('egresos: de un área (lo de más pesos primero) y «todavía de nadie» aparte, con quién lo atiende', () => {
    const r = renglonesDeEgresos(cob(), () => 'Tesorería');
    expect(r.map((x) => (x.tipo === 'grupo' ? `[${x.nombre}]` : x.clave))).toEqual(['[De un área]', 'tesoreria', 'compras', 'otros', '[Todavía de nadie]', 'en_plazo']);
    expect(r.find((x) => x.clave === 'otros')).toMatchObject({ sub: 'lo atiende Tesorería' });
    expect(r.find((x) => x.clave === 'en_plazo')).toMatchObject({ sub: 'Kepler todavía puede capturarlo' });
  });
  it('⛔ [negativa] sin direcciones no inventa renglones', () => {
    const { entradas, salidas, ...vieja } = cob();
    expect(renglonesDeIngresos(vieja as CoberturaCategoria, true)).toEqual([]);
    expect(renglonesDeEgresos(vieja as CoberturaCategoria, () => '')).toEqual([]);
  });
});

describe('[BFU.4.5.13] Bancos › Ingresos y egresos', () => {
  it('primero lo que falta explicar, luego Ingresos y Egresos lado a lado, cada uno con su total', () => {
    const el = montar(cob()).nativeElement as HTMLElement;
    const txt = el.textContent ?? '';
    expect(el.querySelector('.fb-ie-cifra')?.textContent?.trim()).toBe('$150');
    expect(txt).toContain('Falta explicar');
    expect(txt).toContain('Total ingresos');
    expect(txt).toContain('Total egresos');
    expect(txt).toContain('«terminales punto de venta»: falta su corte');
    expect(txt).toContain('3 tarde');
    expect(el.querySelectorAll('.fb-ie-panel').length).toBe(2);
  });
  it('la tira: entró y salió con lo de fuera, entre tus cuentas aparte, y los saldos; nace con su valor (sin conteo)', () => {
    const fx = montar(cob());
    const c = fx.componentInstance;
    expect(c.cifras().map((x) => [x.label, x.value])).toEqual([['Entró', '$6,760'], ['Salió', '$5,650'], ['Entre tus cuentas', '$5,000'], ['Saldos', '1 de 2 cierran']]);
    expect(c.cifras()[0].sub).toBe('17 depósitos · de fuera $1,760');
    expect(c.cifras()[1].sub).toBe('8 retiros · a fuera $950');
    expect(c.cifras()[3]).toMatchObject({ tone: 'bad', drill: 'saldos' });
    expect(fx.debugElement.query(By.directive(MetricStripComponent)).componentInstance.instant()).toBe(true);
  });
  it('clic en un origen abre sus entradas; en un área, sus salidas; en «falta explicar», sólo lo pendiente', () => {
    const fx = montar(cob());
    const ev: unknown[] = []; fx.componentInstance.openGrupo.subscribe((e) => ev.push(e));
    const filas = Array.from((fx.nativeElement as HTMLElement).querySelectorAll('tr.fb-row-click')) as HTMLElement[];
    filas.find((r) => r.textContent?.includes('Cobranza de facturas'))!.click();
    filas.find((r) => r.textContent?.includes('Compras'))!.click();
    (fx.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.fb-ligar')!.click();
    fx.componentInstance.abrirPorLigar();
    expect(ev).toEqual([{ direccion: 'entra', origen: 'cobranza', porLigar: false }, { direccion: 'sale', area: 'compras', porLigar: false },
      { direccion: 'entra', origen: 'sin_documento:terminal', porLigar: true }, { porLigar: true }]);
  });
  it('la venta de tienda se despliega por sucursal: cada una abre sus depósitos y liga a sus cortes del mes', async () => {
    const fx = montar(cob());
    const ev: unknown[] = []; fx.componentInstance.openGrupo.subscribe((e) => ev.push(e));
    const el = fx.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Sucursal Cinco');
    const tog = el.querySelector<HTMLButtonElement>('button.fb-tog')!;
    expect(tog.getAttribute('aria-expanded')).toBe('false');
    tog.click();
    fx.detectChanges(); await fx.whenStable();
    expect(el.querySelector('button.fb-tog')!.getAttribute('aria-expanded')).toBe('true');
    expect(el.textContent).toContain('Sucursal Cinco');
    expect(el.querySelector<HTMLAnchorElement>('a.fb-cortes')!.getAttribute('href')).toBe('/finanzas/cortes-sucursales?month=2026-11&sucursal=05');
    (el.querySelector('tr.fb-ie-suc') as HTMLElement).click();
    expect(ev).toEqual([{ direccion: 'entra', origen: 'venta_tienda', sucursal: '05' }]);
  });
  it('las cifras abren entradas, salidas y llevan a Cuentas; los botones de arriba abren todo o lo sin clasificar', () => {
    const fx = montar(cob());
    const c = fx.componentInstance;
    const ev: unknown[] = []; c.openGrupo.subscribe((e) => ev.push(e));
    let cuentas = 0, todos = 0, sinCls = 0;
    c.irACuentas.subscribe(() => cuentas++); c.verTodos.subscribe(() => todos++); c.verSinClasificar.subscribe(() => sinCls++);
    for (const k of ['entra', 'sale', 'saldos']) c.onDrill(k);
    const botones = Array.from((fx.nativeElement as HTMLElement).querySelectorAll('.fb-ie-head button')) as HTMLButtonElement[];
    botones.find((b) => b.textContent?.includes('Ver todos'))!.click();
    botones.find((b) => b.textContent?.includes('12 sin clasificar'))!.click();
    expect(ev).toEqual([{ direccion: 'entra' }, { direccion: 'sale' }]);
    expect([cuentas, todos, sinCls]).toEqual([1, 1, 1]);
  });
  it('⛔ [negativa] sin saldos leídos no dice «0 de 0 cierran»: dice que no se leyeron', () => {
    const c = montar(cob(), { balances: null }).componentInstance;
    expect(c.cifras().find((x) => x.label === 'Saldos')).toMatchObject({ value: '—', sub: 'sin leer todavía' });
  });
  it('⛔ [negativa] una API sin direcciones no inventa ingresos ni egresos: lo dice', () => {
    const { entradas, salidas, ...vieja } = cob();
    const el = montar(vieja as CoberturaCategoria).nativeElement as HTMLElement;
    expect(el.textContent).toContain('no separó lo que entró de lo que salió');
    expect(el.textContent).not.toContain('Total ingresos');
  });
  it('⛔ [negativa] lo explicado no medido no se dibuja como cero', () => {
    const el = montar({ ...cob(), explicado: null }).nativeElement as HTMLElement;
    expect(el.querySelector('.fb-ie-cifra')).toBeNull();
    expect(el.textContent).toContain('No se pudo medir en este periodo');
  });
  it('cargando y con error usa el estado del sistema, con Reintentar', () => {
    expect((montar(cob(), { cargando: true }).nativeElement as HTMLElement).querySelector('[aria-busy="true"]')).not.toBeNull();
    TestBed.resetTestingModule();
    const fx = montar(cob(), { error: 'No se pudo cargar el diagnóstico del periodo.' });
    let n = 0; fx.componentInstance.reintentar.subscribe(() => n++);
    const btn = Array.from((fx.nativeElement as HTMLElement).querySelectorAll('button')).find((b) => b.textContent?.includes('Reintentar'))!;
    btn.click();
    expect(n).toBe(1);
  });
});
