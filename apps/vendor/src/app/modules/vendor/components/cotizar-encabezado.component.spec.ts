import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { VendorCotizarEncabezadoComponent } from './cotizar-encabezado.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { VendorService } from '../vendor.service';

/**
 * `[MCP.16]` «Cotizar» en el encabezado de todas las pantallas (David, 2026-11-10: «a la mano 24/7»).
 * Se prueba por la pantalla: quién ve el botón, qué abre, a dónde lleva y cuándo se cierra.
 */
function montar(o: { puede?: boolean; clientes?: unknown; falla?: unknown } = {}) {
  const eventos = new Subject<unknown>();
  const router = { navigate: vi.fn(() => Promise.resolve(true)), events: eventos.asObservable() };
  const vendor = {
    listCustomers: vi.fn(() => (o.falla ? throwError(() => o.falla) : of(o.clientes ?? { data: [], total: 0 }))),
  };
  TestBed.configureTestingModule({
    imports: [VendorCotizarEncabezadoComponent],
    providers: [
      { provide: PermissionsService, useValue: { has: (p: string) => (o.puede ?? true) && p === 'COMMERCIAL_QUOTES_GESTIONAR' } },
      { provide: Router, useValue: router },
      { provide: VendorService, useValue: vendor },
    ],
  });
  const fix = TestBed.createComponent(VendorCotizarEncabezadoComponent);
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => (el.textContent || '').replace(/\s+/g, ' ');
  const boton = (t: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => (b.textContent || '').includes(t) || b.getAttribute('aria-label') === t) as
      | HTMLButtonElement
      | undefined;
  const abrir = () => {
    boton('Cotizar')!.click();
    fix.detectChanges();
    vi.advanceTimersByTime(300); // la búsqueda espera 250 ms a que se deje de escribir
    fix.detectChanges();
  };
  return { fix, el, texto, boton, abrir, router, vendor, eventos, cmp: fix.componentInstance };
}

describe('VendorCotizarEncabezadoComponent · «Cotizar» a la mano en todas las pantallas (MCP.16)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('⭐ abre bajo el encabezado el elegir cliente (los de SU ruta) y lleva a cotizar con el elegido', () => {
    const { abrir, texto, boton, router, vendor, fix, cmp } = montar({
      clientes: { data: [{ id: 'cli-1', code: 'C0001', name: 'Cliente Prueba' }], total: 1 },
    });
    expect(texto()).not.toContain('¿A qué cliente le cotizas?');
    abrir();
    expect(texto()).toContain('¿A qué cliente le cotizas?');
    expect(boton('Cotizar')!.getAttribute('aria-expanded')).toBe('true');
    expect(vendor.listCustomers).toHaveBeenCalledWith({ search: undefined, pageSize: 30, scope: 'mine' });
    boton('C0001')!.click();
    fix.detectChanges();
    expect(router.navigate).toHaveBeenCalledWith(['/vendor/cotizar', 'cli-1'], { queryParams: { desde: 'cotizaciones' } });
    expect(cmp.abierta()).toBe(false);
  });

  it('«Ver mis cotizaciones» lleva a la pestaña de Pedidos', () => {
    const { abrir, boton, router } = montar();
    abrir();
    boton('Ver mis cotizaciones')!.click();
    expect(router.navigate).toHaveBeenCalledWith(['/vendor/mis-pedidos'], { queryParams: { ver: 'cotizaciones' } });
  });

  it('⛔ [negativa] sin permiso de cotizar no hay botón (sería uno que siempre termina en «no tienes permiso»)', () => {
    const { boton, el } = montar({ puede: false });
    expect(boton('Cotizar')).toBeUndefined();
    expect(el.querySelector('.cz-flota')).toBeNull();
  });

  it('tocar fuera la cierra; tocar dentro, no', () => {
    const { abrir, el, fix, cmp } = montar();
    abrir();
    const dentro = el.querySelector('.cz-flota input') as HTMLElement;
    dentro.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(cmp.abierta()).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fix.detectChanges();
    expect(cmp.abierta()).toBe(false);
    expect(el.querySelector('.cz-flota')).toBeNull();
  });

  it('al cambiar de pantalla se cierra (no se queda abierta encima de otra cosa)', () => {
    const { abrir, eventos, cmp } = montar();
    abrir();
    eventos.next(new NavigationEnd(1, '/vendor/today', '/vendor/today'));
    expect(cmp.abierta()).toBe(false);
  });

  it('sin señal al buscar clientes lo dice como «sin señal», no como error del servidor, y deja reintentar', () => {
    // La forma de un HttpErrorResponse con la red caída.
    const { abrir, texto, boton } = montar({ falla: { status: 0 } });
    abrir();
    expect(texto()).toMatch(/sin señal/i);
    expect(boton('Reintentar')).toBeTruthy();
  });
});
