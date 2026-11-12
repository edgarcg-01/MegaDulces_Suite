import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Component, input, provideZonelessChangeDetection, signal } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Subject, of } from 'rxjs';
import { FinanzasBancosComponent } from './finanzas-bancos.component';
import { BankService } from '../bank.service';
import { BancosSocketService } from '../bancos-socket.service';
import { FinanceJobsClient } from '../finance-jobs.client';
import { AuthService } from '../../../core/services/auth.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';

/** Las pestañas del apartado (Conciliación/Bancos/…) necesitan el router de verdad; aquí no se prueban. */
@Component({ selector: 'app-page-tabs', standalone: true, template: '' })
class PestanasDelApartado { readonly tabs = input<unknown>(); }

/**
 * `[CB.64]` «Movimientos» ya no es pestaña: es una VENTANA (Edgar, 2026-11-12: «solo existe cuentas y los movimientos
 * sea ahora una ventana»). Se abre desde Cuentas, el Cierre o un archivo subido, sin cambiar la vista de abajo; cerrada,
 * no se piden movimientos. Datos inventados.
 */
function montar(query: Record<string, string> = {}) {
  const pedidos: Record<string, unknown>[] = [];
  const respuestas: Record<string, unknown> = {
    periods: ['2026-11'],
    accounts: [{ id: 'a1', bank: 'BBVA', account_label: '4885', alias: 'BBVA 4885', kind: 'bank' }],
    categories: [],
    statements: [],
    diagnostico: { cuadra: false, items: [], sin_clasificar_n: 12, movimientos: 100 },
  };
  const api = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === 'movements') return (q: Record<string, unknown>) => { pedidos.push(q); return of({ total: 1, rows: [], descarga: null }); };
      return () => of(respuestas[k] ?? null);
    },
  });
  const q = convertToParamMap(query);
  TestBed.configureTestingModule({
    imports: [FinanzasBancosComponent],
    providers: [provideZonelessChangeDetection(), MessageService,
      { provide: BankService, useValue: api },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: q }, queryParamMap: of(q) } },
      { provide: Router, useValue: { navigate: () => Promise.resolve(true), events: new Subject() } },
      { provide: BancosSocketService, useValue: { connected: signal(false), connect() {}, disconnect() {}, change$: new Subject(), job$: new Subject() } },
      { provide: FinanceJobsClient, useValue: { watch: () => new Subject() } },
      { provide: AuthService, useValue: { user: () => ({ username: 'prueba' }), hasPermission: () => true, can: () => true } },
    ],
  });
  TestBed.overrideComponent(FinanzasBancosComponent, { remove: { imports: [PageTabsComponent] }, add: { imports: [PestanasDelApartado] } });
  const fx = TestBed.createComponent(FinanzasBancosComponent);
  fx.detectChanges();
  return { fx, cmp: fx.componentInstance, pedidos, el: fx.nativeElement as HTMLElement };
}

describe('[CB.64] Movimientos es una ventana de Cuentas', () => {
  it('la barra ya no tiene la pestaña Movimientos, y Cuentas sigue', () => {
    const { el } = montar();
    const pestanas = Array.from(el.querySelectorAll('nav.fb-nav button')).map((b) => b.textContent?.trim() ?? '');
    expect(pestanas.some((p) => p.startsWith('Movimientos'))).toBe(false);
    expect(pestanas.some((p) => p.startsWith('Cuentas'))).toBe(true);
  });

  it('[negativa] cerrada, no se piden movimientos al cargar el periodo', () => {
    const { cmp, pedidos } = montar();
    expect(cmp.movAbierta()).toBe(false);
    expect(pedidos).toEqual([]);
  });

  it('clic en una cuenta: abre la ventana con esa cuenta y la vista de abajo no cambia', () => {
    const { fx, cmp, pedidos } = montar({ view: 'cuentas' });
    cmp.verCuentaMovs({ bank: 'BBVA', account_label: '4885' });
    fx.detectChanges();
    expect(cmp.view()).toBe('cuentas');
    expect(cmp.movAbierta()).toBe(true);
    expect(pedidos.at(-1)).toMatchObject({ period: '2026-11', account_id: 'a1' });
    expect(cmp.tituloMovimientos()).toBe('Movimientos · BBVA 4885 · noviembre de 2026');
    // La lista vive DENTRO de la ventana, no colgada de la vista.
    const lista = fx.nativeElement.querySelector('bancos-movimientos');
    expect(lista?.closest('app-side-peek')).not.toBeNull();
  });

  it('desde Cuentas: todos los movimientos, y los sin clasificar con su número', () => {
    const { fx, cmp, el, pedidos } = montar({ view: 'cuentas' });
    const botones = Array.from(el.querySelectorAll('.fb-cuentas-acc button')) as HTMLButtonElement[];
    expect(botones.map((b) => b.textContent?.trim())).toEqual(['Ver todos los movimientos', '12 sin clasificar']);
    botones[1].click();
    fx.detectChanges();
    expect(pedidos.at(-1)).toMatchObject({ uncategorized: true });
    expect(pedidos.at(-1)?.['account_id']).toBeUndefined();
    expect(cmp.tituloMovimientos()).toBe('Movimientos · todas las cuentas · sin clasificar · noviembre de 2026');
  });

  it('el Cierre y un archivo subido también abren la ventana, sin brincar de pestaña', () => {
    const { cmp, pedidos } = montar();
    cmp.itemAction({ tipo: 'traspaso_descuadre' });
    expect(cmp.view()).toBe('cierre');
    expect(pedidos.at(-1)).toMatchObject({ group_key: 'traspaso' });
    cmp.cerrarMovimientos();
    cmp.verMovimientosDeCuenta('a1');
    expect(cmp.view()).toBe('cierre');
    expect(pedidos.at(-1)).toMatchObject({ account_id: 'a1' });
    // Al reabrir, los filtros de antes no se arrastran.
    expect(pedidos.at(-1)?.['group_key']).toBeUndefined();
  });

  it('un enlace viejo con ?view=movimientos cae en Cuentas con la ventana abierta', () => {
    const { cmp, pedidos } = montar({ view: 'movimientos' });
    expect(cmp.view()).toBe('cuentas');
    expect(cmp.movAbierta()).toBe(true);
    expect(pedidos.length).toBeGreaterThan(0);
  });
});
