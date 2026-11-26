import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { FinanzasCalendarioPagosComponent } from './finanzas-calendario-pagos.component';
import type { PaymentCalendarAllocation } from '@megadulces/contracts';

/**
 * `[PGP.190.2]` La ✕ que quita una transferencia de un pago partido (PGP.190) **se ve**. En PrimeNG 22 el directivo
 * `pButton` ya no tiene la entrada `icon`: el atributo se quedaba como HTML muerto y el botón salía vacío (AUD-UI.5).
 * Monta la pantalla entera (compila su plantilla), abre «Preparar pago» con tres transferencias y revisa cada ✕.
 */
function montar() {
  const llaves = [Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR];
  TestBed.configureTestingModule({
    imports: [FinanzasCalendarioPagosComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: {
        isAdmin: () => false, isSuperadmin: () => false,
        has: (k: string) => llaves.includes(k), hasExplicit: (k: string) => llaves.includes(k),
        hasAny: (...ks: string[]) => ks.some((k) => llaves.includes(k)),
      } },
      { provide: AuthService, useValue: { user: () => ({ permissions: Object.fromEntries(llaves.map((k) => [k, true])) }) } }],
  });
  const fixture = TestBed.createComponent(FinanzasCalendarioPagosComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.match(() => true);   // lo que la pantalla lee al entrar: no es de esta prueba
  // La pantalla es OnPush: lo que la prueba cambia a mano se marca para que la plantilla lo vuelva a pintar.
  const pintar = () => { fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges(); };
  return { fixture, c: fixture.componentInstance, pintar };
}

/** Un pago a proveedor que NO es anticipo: ése se puede partir en varias transferencias. */
const PAGO = { id: 'A-1', amount_assigned: 300000, items: [{ es_anticipo: false }] } as unknown as PaymentCalendarAllocation;

describe('[PGP.190.2] la ✕ para quitar una transferencia se ve', () => {
  it('con tres transferencias, cada ✕ trae su ícono dentro (y no el atributo «icon» que PrimeNG 22 ignora)', () => {
    const { c, pintar } = montar();
    c.prepAllocation = PAGO;
    c.prepMethod = 'transferencia';
    c.prepareVisible = true;
    c.activarVarias(true);
    c.agregarTransferencia();
    pintar();
    const xs = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Quitar la transferencia"]')];
    expect(xs.map((b) => b.getAttribute('aria-label'))).toEqual(['Quitar la transferencia 1', 'Quitar la transferencia 2', 'Quitar la transferencia 3']);
    for (const b of xs) {
      expect(b.querySelector('.pi.pi-times')).not.toBeNull();
      expect(b.querySelector('.pi')?.getAttribute('aria-hidden')).toBe('true');
      expect(b.getAttribute('icon')).toBeNull();
      // pg-ico: la misma clase de las flechas de semana, que con el dedo llega a 44 px.
      expect(b.classList.contains('pg-ico')).toBe(true);
    }
  });

  it('con dos transferencias no hay ✕ (un pago partido lleva al menos dos)', () => {
    const { c, pintar } = montar();
    c.prepAllocation = PAGO;
    c.prepMethod = 'transferencia';
    c.prepareVisible = true;
    c.activarVarias(true);
    pintar();
    expect(document.querySelectorAll('button[aria-label^="Quitar la transferencia"]').length).toBe(0);
    expect(document.querySelectorAll('.cal-prep-tr').length).toBe(2);
  });
});
