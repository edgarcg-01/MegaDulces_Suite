import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { MetricStripComponent } from '../../../../shared/components/metric-strip/metric-strip.component';
import { BancosIngresosComponent, barraDeEstado, renglonesDeEgresos, renglonesDeIngresos, totalDeFuera } from './bancos-ingresos.component';
import { BalanceRow, Balances, CoberturaCategoria, CoberturaPorArea, Diagnostico } from '../../bank.service';

/**
 * `[BFU.4.5.13]` Bancos › Ingresos y egresos: de dónde viene y a dónde va cada peso, separado de los saldos (Edgar,
 * 2026-11-25: «para no hacer tanto scroll»). `[BFU.4.5.14]` Y lo que la captura de la pantalla viva encontró: el subtotal
 * del grupo bajo «Falta explicar», «Total ingresos» sumando lo que no es ingreso, «falta explicar» con dos unidades y el
 * rojo sobre lo que cierra. Importes inventados.
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
  const ent = [g('traspaso', 1, 5000, 0, { nombre: 'Entre tus cuentas' }), g('sin_documento:otro', 2, 20, 2, { nombre: 'Otro depósito' }), tienda,
    g('cobranza', 3, 300, 0, { nombre: 'Cobranza de facturas' }), g('sin_documento:terminal', 4, 40, 4, { nombre: 'Venta con tarjeta', atrasados: 3,
      motivos: [{ motivo: 'deposito_sin_documento', n: 4, monto: 40 }] })];
  const sal = [g('en_plazo', 2, 90, 2, { nombre: 'En plazo de captura', motivos: [{ motivo: 'kepler_aun_no_lo_tiene', n: 2, monto: 90 }] }),
    g('compras', 2, 700, 0, { nombre: 'Compras' }), g('otros', 1, 60, 0, { nombre: 'Otros', atiende: 'tesoreria' }),
    g('tesoreria', 1, 100, 1, { nombre: 'Tesorería', motivos: [{ motivo: 'kepler_en_otra_cuenta', n: 1, monto: 100 }] }),
    g('traspaso', 2, 4700, 0, { nombre: 'Entre tus cuentas' })];
  return { evaluados: 25, suma_cuadra: true, por_area: [g('credito_cobranza', 14, 1740, 4), g('tesoreria', 3, 4800, 1, { nombre: 'Tesorería' })],
    explicado: { n: 16, monto: 11000, por_ligar: { n: 9, monto: 250 }, atrasados: 3 }, entradas: dir(ent), salidas: dir(sal),
    entre_cuentas: { entra: { n: 1, monto: 5000 }, sale: { n: 2, monto: 4700 } } };
};
const cuenta = (p: Partial<BalanceRow>): BalanceRow => ({ statement_id: p.account_label ?? 'x', bank: 'BBVA', account_label: '1', kind: 'bank',
  opening: 0, total_in: 0, total_out: 0, computed_closing: 0, closing: 0, delta: 0, cuadra: true, sin_saldo: false, ...p } as BalanceRow);
const saldos = (todasCierran = false): Balances => ({ period: '2026-11', traspasos: { entra: 0, sale: 0, delta: 0 },
  totals: { opening: 0, total_in: 0, total_out: 0, closing: 0, descuadre: 0 }, cuentas_descuadradas: todasCierran ? 0 : 1, cuentas_sin_saldo: 1,
  accounts: [cuenta({ account_label: 'a' }), cuenta({ account_label: 'b', cuadra: todasCierran, delta: todasCierran ? 0 : 9 }),
    cuenta({ account_label: 'c', sin_saldo: true })] } as Balances);

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
const celdas = (tr: Element | null | undefined) => Array.from(tr?.children ?? []).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());

describe('[BFU.4.5.13] renglonesDeIngresos / renglonesDeEgresos — el orden de lectura', () => {
  it('ingresos: con documento (lo que es ingreso primero) y sin documento (lo de más pesos primero)', () => {
    const r = renglonesDeIngresos(cob(), false);
    expect(r.map((x) => (x.tipo === 'grupo' ? `[${x.nombre}]` : x.clave))).toEqual([
      '[Con documento de Kepler]', 'venta_tienda', 'cobranza', '[Sin documento · lo que dice el banco]', 'sin_documento:terminal', 'sin_documento:otro']);
    expect(r[0]).toMatchObject({ n: 10, monto: 1700 });
    expect(r.find((x) => x.clave === 'venta_tienda')).toMatchObject({ desplegable: true, sub: 'cobro de un corte de caja' });
  });
  it('⛔ [BFU.4.5.14] [negativa] lo de entre tus cuentas no es un renglón de Ingresos ni de Egresos', () => {
    expect(renglonesDeIngresos(cob(), true).some((x) => x.clave === 'traspaso')).toBe(false);
    expect(renglonesDeEgresos(cob(), () => '').some((x) => x.clave === 'traspaso')).toBe(false);
  });
  it('la venta de tienda nace plegada; desplegada, sus sucursales van debajo de ella', () => {
    expect(renglonesDeIngresos(cob(), false).some((x) => x.tipo === 'suc')).toBe(false);
    const r = renglonesDeIngresos(cob(), true);
    const i = r.findIndex((x) => x.clave === 'venta_tienda');
    expect(r.slice(i + 1, i + 3).map((x) => x.clave)).toEqual(['venta_tienda|05', 'venta_tienda|08']);
  });
  it('egresos: de un área (lo de más pesos primero) y «todavía de nadie» aparte, con quién lo atiende', () => {
    const r = renglonesDeEgresos(cob(), () => 'Tesorería');
    expect(r.map((x) => (x.tipo === 'grupo' ? `[${x.nombre}]` : x.clave))).toEqual(['[De un área]', 'compras', 'tesoreria', 'otros', '[Todavía de nadie]', 'en_plazo']);
    expect(r.find((x) => x.clave === 'otros')).toMatchObject({ sub: 'lo atiende Tesorería' });
    expect(r.find((x) => x.clave === 'en_plazo')).toMatchObject({ sub: 'Kepler todavía puede capturarlo' });
  });
  it('[BFU.4.5.14] el motivo de lo que falta se dice sólo donde el grupo no lo dice ya', () => {
    const e = renglonesDeEgresos(cob(), () => 'Tesorería'), i = renglonesDeIngresos(cob(), false);
    expect(e.find((x) => x.clave === 'tesoreria')).toMatchObject({ falta: 'Kepler lo tiene en otra cuenta' });
    // [negativa] «sin documento» y «todavía de nadie» ya lo dicen en su nombre: no se repite en cada renglón.
    expect(i.find((x) => x.clave === 'sin_documento:terminal')).toMatchObject({ falta: '' });
    expect(e.find((x) => x.clave === 'en_plazo')).toMatchObject({ falta: '' });
    expect(e.find((x) => x.clave === 'compras')).toMatchObject({ falta: '' });
  });
  it('⛔ [negativa] sin direcciones no inventa renglones', () => {
    const { entradas, salidas, ...vieja } = cob();
    expect(renglonesDeIngresos(vieja as CoberturaCategoria, true)).toEqual([]);
    expect(renglonesDeEgresos(vieja as CoberturaCategoria, () => '')).toEqual([]);
  });
});

describe('[BFU.4.5.14] totalDeFuera — el total sin lo de entre tus cuentas', () => {
  it('⛔ total + entre tus cuentas = la dirección que manda el servidor, en movimientos, pesos y por explicar', () => {
    for (const d of [cob().entradas!, cob().salidas!]) {
      const t = totalDeFuera(d)!;
      expect(t.n + t.entre!.n).toBe(d.n);
      expect(t.monto + t.entre!.monto).toBe(d.monto);
      expect(t.por_ligar! + t.entre!.por_ligar!.n).toBe(d.por_ligar!.n);
    }
    expect(totalDeFuera(cob().entradas!)).toMatchObject({ n: 16, monto: 1760, por_ligar: 6 });
    expect(totalDeFuera(cob().salidas!)).toMatchObject({ n: 6, monto: 950, por_ligar: 3 });
  });
  it('⛔ [negativa] sin traspasos no resta nada; sin medir, «por explicar» es null, nunca cero', () => {
    const sin = dir([g('cobranza', 3, 300, 1)]);
    expect(totalDeFuera(sin)).toEqual({ n: 3, monto: 300, por_ligar: 1, entre: null });
    expect(totalDeFuera({ ...sin, por_ligar: null })!.por_ligar).toBeNull();
    expect(totalDeFuera(null)).toBeNull();
  });
});

describe('[BFU.4.5.15] barraDeEstado — los movimientos de cada tabla en tres estados, con color', () => {
  it('⛔ explicados + a tiempo + tarde = el total de la tabla (sin lo de entre tus cuentas)', () => {
    const d = cob().entradas!, b = barraDeEstado('Ingresos', d, totalDeFuera(d))!;
    expect(b.items.map((x) => [x.label, x.value, x.tone])).toEqual([['Explicados', 10, 'ok'], ['Por explicar, a tiempo', 3, 'warn'], ['Tarde', 3, 'bad']]);
    expect(b.items.reduce((t, x) => t + Number(x.value), 0)).toBe(totalDeFuera(d)!.n);
    expect(b.aria).toBe('Ingresos, 16 movimientos: 10 explicados, 3 por explicar a tiempo y 3 tarde');
  });
  it('⛔ [negativa] sin medir no hay barra: un estado no medido no se pinta como «todo explicado»', () => {
    const d = cob().salidas!;
    expect(barraDeEstado('Egresos', { ...d, atrasados: null }, totalDeFuera(d))).toBeNull();
    expect(barraDeEstado('Egresos', d, { ...totalDeFuera(d)!, por_ligar: null })).toBeNull();
    expect(barraDeEstado('Egresos', null, null)).toBeNull();
  });
});

describe('[BFU.4.5.13] Bancos › Ingresos y egresos', () => {
  it('[BFU.4.5.15] cada tabla abre con su barra; explicado es palomita verde, lo pendiente ámbar y lo tarde rojo, cada uno con su palabra', () => {
    const fx = montar(cob());
    const el = fx.nativeElement as HTMLElement;
    const barras = fx.debugElement.queryAll(By.directive(MetricStripComponent)).filter((d) => d.componentInstance.mode() === 'composition');
    expect(barras.length).toBe(2);
    expect(barras.every((d) => d.componentInstance.instant())).toBe(true);
    const fila = (t: string) => Array.from(el.querySelectorAll('tr.fb-row-click')).find((r) => r.querySelector('th')?.textContent?.includes(t))!;
    expect(fila('Cobranza de facturas').querySelector('i.pi-check.fb-ok')).not.toBeNull();
    expect(celdas(fila('Cobranza de facturas')).at(-1)).toBe('explicado');
    expect(fila('Venta con tarjeta').querySelector('.fb-pend')?.textContent?.trim()).toBe('todos');
    expect(fila('Venta con tarjeta').querySelector('.fb-tarde')?.textContent).toContain('tarde');
    // [negativa] lo explicado nunca lleva el tono de pendiente ni el de tarde.
    expect(fila('Cobranza de facturas').querySelector('.fb-pend, .fb-tarde')).toBeNull();
  });
  it('primero lo que falta explicar, luego Ingresos y Egresos lado a lado, cada uno con su total', () => {
    const el = montar(cob()).nativeElement as HTMLElement;
    const txt = el.textContent ?? '';
    expect(el.querySelector('.fb-ie-cifra')?.textContent?.trim()).toBe('$250');
    expect(txt).toContain('Falta explicar');
    expect(txt).toContain('Total ingresos');
    expect(txt).toContain('Total egresos');
    expect(txt).toContain('«terminales punto de venta»: falta su corte');
    expect(txt).toContain('3 tarde');
    expect(el.querySelectorAll('.fb-ie-panel').length).toBe(2);
  });
  it('⛔ [BFU.4.5.14] el subtotal del grupo va bajo Pesos y Movs., nunca bajo «Movs. por explicar»', () => {
    const el = montar(cob()).nativeElement as HTMLElement;
    const panel = el.querySelectorAll('.fb-ie-panel')[0];
    expect(celdas(panel.querySelector('tr:has(th[scope="col"])'))).toEqual(['De dónde vino', 'Pesos', 'Movs.', 'Movs. por explicar']);
    expect(celdas(panel.querySelector('tr.fb-ie-grupo'))).toEqual(['Con documento de Kepler', '$1,700', '10', '']);
  });
  it('⛔ [BFU.4.5.14] entre tus cuentas va debajo del total y fuera de él, en las DOS tablas; la cabecera no repite el total', () => {
    const el = montar(cob()).nativeElement as HTMLElement;
    const [ing, egr] = Array.from(el.querySelectorAll('.fb-ie-panel'));
    expect(celdas(ing.querySelector('tr.fb-ie-tot'))).toEqual(['Total ingresos', '$1,760', '16', '6']);
    expect(celdas(ing.querySelector('tr.fb-ie-tot + tr.fb-ie-entre'))[1]).toBe('$5,000');
    expect(ing.querySelector('tr.fb-ie-entre')?.textContent).toContain('vino de otra cuenta tuya: no es ingreso');
    expect(celdas(egr.querySelector('tr.fb-ie-tot'))).toEqual(['Total egresos', '$950', '6', '3']);
    expect(celdas(egr.querySelector('tr.fb-ie-tot + tr.fb-ie-entre'))[1]).toBe('$4,700');
    expect(egr.querySelector('tr.fb-ie-entre')?.textContent).toContain('fue a otra cuenta tuya: no es egreso');
    expect(el.querySelector('.fb-ie-ph')?.textContent).not.toContain('$');
  });
  it('[BFU.4.5.14] «todos» cuando no hay ninguno explicado; el motivo sólo donde el grupo no lo dice', () => {
    const el = montar(cob()).nativeElement as HTMLElement;
    const fila = (t: string) => Array.from(el.querySelectorAll('tr.fb-row-click')).find((r) => r.querySelector('th')?.textContent?.includes(t))!;
    expect(celdas(fila('Venta con tarjeta')).at(-1)).toBe('todos · 3 tarde');
    expect(celdas(fila('Tesorería')).at(-1)).toBe('1');
    expect(fila('Tesorería').textContent).toContain('por explicar: Kepler lo tiene en otra cuenta');
    expect(el.textContent).not.toContain('Depósitos sin documento de Kepler');
  });
  it('la tira: ingresos y egresos (los mismos que el total de cada tabla) y los saldos, con el rojo en lo que no cierra', () => {
    const fx = montar(cob());
    const c = fx.componentInstance;
    expect(c.cifras().map((x) => [x.label, x.value])).toEqual([['Ingresos', '$1,760'], ['Egresos', '$950'], ['Saldos', '1 no cierra']]);
    expect(c.cifras()[0].sub).toBe('16 depósitos de fuera');
    expect(c.cifras()[1].sub).toBe('6 retiros a fuera');
    expect(c.cifras()[2]).toMatchObject({ tone: 'bad', sub: '1 de 2 cierran · ver en Cuentas', drill: 'saldos' });
    expect(fx.debugElement.query(By.directive(MetricStripComponent)).componentInstance.instant()).toBe(true);
  });
  it('⛔ [negativa] si todas cierran no hay rojo', () => {
    const c = montar(cob(), { balances: saldos(true) }).componentInstance;
    const s = c.cifras().find((x) => x.label === 'Saldos')!;
    expect(s).toMatchObject({ value: '2 de 2 cierran', sub: 'ver en Cuentas' });
    expect(s.tone).toBeUndefined();
  });
  it('clic en un origen abre sus entradas; en un área, sus salidas; en entre tus cuentas, ese grupo; en «falta explicar», sólo lo pendiente', () => {
    const fx = montar(cob());
    const ev: unknown[] = []; fx.componentInstance.openGrupo.subscribe((e) => ev.push(e));
    const el = fx.nativeElement as HTMLElement;
    const filas = Array.from(el.querySelectorAll('tr.fb-row-click')) as HTMLElement[];
    filas.find((r) => r.textContent?.includes('Cobranza de facturas'))!.click();
    filas.find((r) => r.textContent?.includes('Compras'))!.click();
    (el.querySelectorAll('.fb-ie-panel')[1].querySelector('tr.fb-ie-entre') as HTMLElement).click();
    el.querySelector<HTMLButtonElement>('button.fb-ligar')!.click();
    fx.componentInstance.abrirPorLigar();
    expect(ev).toEqual([{ direccion: 'entra', origen: 'cobranza', porLigar: false }, { direccion: 'sale', area: 'compras', porLigar: false },
      { direccion: 'sale', area: 'traspaso', porLigar: false },
      { direccion: 'entra', origen: 'sin_documento:terminal', porLigar: true }, { porLigar: true }]);
  });
  it('la venta de tienda se despliega por sucursal desde «N sucursales»: cada una abre sus depósitos y liga a sus cortes del mes', async () => {
    const fx = montar(cob());
    const ev: unknown[] = []; fx.componentInstance.openGrupo.subscribe((e) => ev.push(e));
    const el = fx.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Sucursal Cinco');
    const tog = el.querySelector<HTMLButtonElement>('button.fb-tog')!;
    expect(tog.textContent?.trim()).toBe('2 sucursales');
    expect(tog.getAttribute('aria-label')).toContain('2 sucursales');
    expect(tog.getAttribute('aria-expanded')).toBe('false');
    tog.click();
    fx.detectChanges(); await fx.whenStable();
    expect(el.querySelector('button.fb-tog')!.getAttribute('aria-expanded')).toBe('true');
    expect(el.textContent).toContain('Sucursal Cinco');
    expect(el.querySelector<HTMLAnchorElement>('a.fb-cortes')!.getAttribute('href')).toBe('/finanzas/cortes-sucursales?month=2026-11&sucursal=05');
    (el.querySelector('tr.fb-ie-suc') as HTMLElement).click();
    expect(ev).toEqual([{ direccion: 'entra', origen: 'venta_tienda', sucursal: '05' }]);
  });
  it('las cifras abren ingresos y egresos SIN lo de entre tus cuentas y llevan a Cuentas; los botones de arriba abren todo o lo sin clasificar', () => {
    const fx = montar(cob());
    const c = fx.componentInstance;
    const ev: unknown[] = []; c.openGrupo.subscribe((e) => ev.push(e));
    let cuentas = 0, todos = 0, sinCls = 0;
    c.irACuentas.subscribe(() => cuentas++); c.verTodos.subscribe(() => todos++); c.verSinClasificar.subscribe(() => sinCls++);
    for (const k of ['entra', 'sale', 'saldos']) c.onDrill(k);
    const botones = Array.from((fx.nativeElement as HTMLElement).querySelectorAll('.fb-ie-head button')) as HTMLButtonElement[];
    botones.find((b) => b.textContent?.includes('Ver todos'))!.click();
    const sin = botones.find((b) => b.textContent?.includes('12 sin clasificar'))!;
    sin.click();
    expect(sin.className).toBe('fb-btn');
    expect(ev).toEqual([{ direccion: 'entra', deFuera: true }, { direccion: 'sale', deFuera: true }]);
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
