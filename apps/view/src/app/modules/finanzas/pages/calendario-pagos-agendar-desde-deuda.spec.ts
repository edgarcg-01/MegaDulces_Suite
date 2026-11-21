import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { FinanzasCalendarioPagosComponent } from './finanzas-calendario-pagos.component';

/**
 * `[ECA.9]` «Agendar» desde Deuda con proveedores abre el Calendario con `?fecha=…&buscar=<clave> <folio>`.
 * El día abre en «Por día», con «Agregar facturas» abierto y la PRIMERA lectura de la deuda ya filtrada por
 * esa factura: nadie vuelve a teclear el folio.
 */
function montar(query: Record<string, string>) {
  const llaves = [Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR];
  TestBed.configureTestingModule({
    imports: [FinanzasCalendarioPagosComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
      { provide: PermissionsService, useValue: {
        isAdmin: () => false, isSuperadmin: () => false,
        has: (k: string) => llaves.includes(k as Permission), hasExplicit: (k: string) => llaves.includes(k as Permission),
        hasAny: (...ks: string[]) => ks.some((k) => llaves.includes(k as Permission)),
      } },
      { provide: AuthService, useValue: { user: () => ({ permissions: Object.fromEntries(llaves.map((k) => [k, true])) }) } }],
  });
  const fixture = TestBed.createComponent(FinanzasCalendarioPagosComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  const obligaciones = http.match((r) => r.url.includes('/finance/payment-calendar/obligations'));
  http.match(() => true); // el resto de lo que lee al entrar no es de esta prueba
  return { c: fixture.componentInstance, obligaciones };
}

describe('[ECA.9] el Calendario abre la factura que se agenda desde Deuda con proveedores', () => {
  it('con ?fecha y ?buscar: «Por día», ese día, «Agregar facturas» abierto y la deuda ya filtrada por la factura', () => {
    const { c, obligaciones } = montar({ fecha: '2026-11-27', buscar: 'CB005 0003499' });
    expect(c.modo()).toBe('dia');
    expect(c.selectedDate()).toBe('2026-11-27');
    expect(c.panelAgregar()).toBe(true);
    expect(c.busqueda()).toBe('CB005 0003499');
    expect(obligaciones.length).toBe(1);
    expect(new URL(obligaciones[0].request.url, 'http://x').searchParams.get('search')).toBe('CB005 0003499');
  });

  it('⛔ NEGATIVA — sin ?buscar nada se abre ni se filtra (el enlace «Ver el 13/11» de ECA.8 sigue igual)', () => {
    const { c, obligaciones } = montar({ fecha: '2026-11-27' });
    expect(c.modo()).toBe('dia');
    expect(c.panelAgregar()).toBe(false);
    expect(c.busqueda()).toBe('');
    expect(new URL(obligaciones[0].request.url, 'http://x').searchParams.get('search')).toBeNull();
  });

  it('un ?buscar enorme se recorta: la URL no mete 2,000 caracteres al buscador', () => {
    const { c } = montar({ buscar: 'x'.repeat(2000) });
    expect(c.busqueda().length).toBe(80);
  });
});
