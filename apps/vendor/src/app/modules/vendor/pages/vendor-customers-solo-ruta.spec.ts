// `[VS.2]` «Buscar cliente» muestra SÓLO los clientes de la ruta del vendedor (decisión de David,
// 2026-11-04). Antes (VS.1) la pestaña «Clientes otras rutas» abría a todos los clientes con ficha de
// la empresa. Monta la pantalla real con un doble de VendorService y mira lo que pide y lo que pinta.
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Observable, of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { VendorCustomersComponent } from './vendor-customers.component';
import { OfflineSyncService } from '../../../core/services/offline-sync.service';
import { AuthService } from '../../../core/services/auth.service';

function montar() {
  const llamadas: Record<string, unknown[][]> = {};
  const respuestas: Record<string, unknown> = {
    listCustomers: { data: [{ id: 'c1', code: 'CLI-1', name: 'ABARROTES CARMELITA' }], total: 1 },
  };
  const api = new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...a: unknown[]): Observable<unknown> => {
        (llamadas[prop] ??= []).push(a);
        return of(prop in respuestas ? respuestas[prop] : null);
      };
    },
  }) as unknown as VendorService;
  TestBed.configureTestingModule({
    imports: [VendorCustomersComponent],
    providers: [provideRouter([]), { provide: VendorService, useValue: api }, { provide: MessageService, useValue: { add: vi.fn() } },
      { provide: OfflineSyncService, useValue: { guardarClienteOffline: vi.fn() } },
      { provide: AuthService, useValue: { user: () => ({ sub: 'v1' }) } }],
  });
  const fix = TestBed.createComponent(VendorCustomersComponent);
  fix.detectChanges();
  return { fix, llamadas, el: fix.nativeElement as HTMLElement };
}

describe('Buscar cliente · sólo los de su ruta [VS.2]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ la lista y la búsqueda piden sólo la cartera de su ruta (scope mine)', async () => {
    const { fix, llamadas } = montar();
    await new Promise((r) => setTimeout(r, 450));
    fix.detectChanges();
    const scopes = (llamadas['listCustomers'] ?? []).map((a) => (a[0] as { scope?: string }).scope);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((s) => s === 'mine')).toBe(true);
  });

  it('⛔ ya no existe la pestaña «Clientes otras rutas»', () => {
    const { el } = montar();
    expect(el.textContent).not.toContain('otras rutas');
    expect(el.querySelector('[role="tablist"]')).toBeNull();
  });
});
