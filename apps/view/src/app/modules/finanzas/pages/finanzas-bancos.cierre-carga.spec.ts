import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Component, input, provideZonelessChangeDetection, signal } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Subject, of } from 'rxjs';
import { FinanzasBancosComponent } from './finanzas-bancos.component';
import { BankService, Diagnostico } from '../bank.service';
import { BancosSocketService } from '../bancos-socket.service';
import { FinanceJobsClient } from '../finance-jobs.client';
import { AuthService } from '../../../core/services/auth.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { BancosCierreComponent } from './bancos/bancos-cierre.component';

@Component({ selector: 'app-page-tabs', standalone: true, template: '' })
class PestanasDelApartado { readonly tabs = input<unknown>(); }

/**
 * `[CB.68]` El Cierre espera al DIAGNÓSTICO, no al concentrado. Medido en prod el 2026-11-13: el concentrado llega en
 * ~80 ms y el diagnóstico en ~1 s; en ese hueco la pantalla decía «Sin datos para 2026-11. Sube un estado de cuenta»
 * con 1,785 movimientos en el mes. Datos inventados.
 */
function montar() {
  const diag$ = new Subject<Diagnostico>();
  const respuestas: Record<string, unknown> = {
    periods: ['2026-11'], accounts: [], categories: [], statements: [],
    concentrado: { accounts: [], groupTotals: {}, grand: {} },
  };
  const api = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === 'diagnostico') return () => diag$;
      return () => of(respuestas[k] ?? null);
    },
  });
  const q = convertToParamMap({ view: 'cierre', period: '2026-11' });
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
  return { fx, diag$, el: fx.nativeElement as HTMLElement };
}

const DIAG: Diagnostico = {
  period: '2026-11', ingresos: 100, egresos: 50, neto: 50, movimientos: 1785, cuadra: false,
  cuentas_ok: 16, cuentas_total: 17, total_descuadre: 0, tiene_balanza_kepler: true, items: [
    { tipo: 'cuenta_sin_cargar', severidad: 'warn', importe: 0, titulo: 'BB 3660: sin movimientos en 2026-11', detalle: 'x', accion: 'y' },
  ],
  movimientos_hasta: '2026-11-10',
};

describe('[CB.68] el Cierre no dice «Sin datos» mientras carga', () => {
  it('[negativa] con el diagnóstico pendiente: esqueleto, ni «Sin datos» ni veredicto', () => {
    const { el } = montar();
    expect(el.textContent).not.toContain('Sin datos');
    expect(el.querySelector('[aria-label="Cargando el cierre del periodo"]')).not.toBeNull();
    expect(el.querySelector('bancos-cierre')).toBeNull();
  });

  it('al llegar: el veredicto dice hasta qué día ve el cierre, y el botón dice lo que abre', () => {
    const { fx, diag$, el } = montar();
    diag$.next(DIAG);
    fx.detectChanges();
    expect(el.querySelector('[aria-label="Cargando el cierre del periodo"]')).toBeNull();
    expect(el.querySelector('.fb-diag-head h2')?.textContent).toBe('1 pendiente para que cuadre');
    expect(el.querySelector('.fb-diag-hasta')?.textContent).toBe('Cuenta los movimientos cargados hasta el 10/11.');
    expect(el.querySelector('.fb-diag-cta')?.textContent).toContain('Subir libro');
  });
});

describe('[CB.68] textos del Cierre', () => {
  const c = Object.create(BancosCierreComponent.prototype) as BancosCierreComponent;
  it('sin movimientos no inventa una fecha', () => {
    expect(c.hastaTexto({ movimientos_hasta: null })).toBeNull();
    expect(c.hastaTexto({})).toBeNull();
  });
  it('singular y plural sin «cosa(s)»', () => {
    expect(c.tituloPendientes(1)).toBe('1 pendiente para que cuadre');
    expect(c.tituloPendientes(4)).toBe('4 pendientes para que cuadre');
  });
});
