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
 * `[PGP.221]` BBVA no deja pasar de $1,000,000.00 por transferencia (Francisco, 2026-11-26). «Preparar pago» parte SOLA la
 * transferencia de BBVA que pasa del tope, dice por qué, y no deja guardarla entera. El caso: Effem, $1,020,891.81 que
 * salió en dos SPEI sin estar partido en la Suite. Monta la pantalla entera (compila su plantilla).
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
  const c = fixture.componentInstance;
  c.originOpts.set([
    { id: 'BBVA-5712', label: 'BBVA 5712', bank: 'BBVA', kind: 'bank' },
    { id: 'SANT-2169', label: 'SANTANDER 2169', bank: 'SANTANDER', kind: 'bank' },
  ]);
  const pintar = () => { fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges(); };
  return { fixture, c, http, pintar };
}

const pago = (importe: number, extra: Partial<PaymentCalendarAllocation> = {}, anticipo = false) =>
  ({ id: 'P-1', status: 'pending', amount_assigned: importe, items: [{ es_anticipo: anticipo }], payment_method: null, bank_account_id: null, ...extra }) as unknown as PaymentCalendarAllocation;

/** Abre «Preparar pago» con transferencia y ese origen, como lo hace la persona al elegirlo. */
function preparar(c: FinanzasCalendarioPagosComponent, a: PaymentCalendarAllocation, origen: string) {
  c.prepAllocation = a;
  c.prepMethod = 'transferencia';
  c.prepOriginId = origen;
  c.prepVarias = false;
  c.prepPartes = [];
  c.prepPartidoPorTope.set(null);
  c.prepareVisible = true;
  c.partirSiPasaDelTope();
}

describe('[PGP.221] «Preparar pago» parte sola lo que pasa del tope del banco', () => {
  it('Effem: $1,020,891.81 desde BBVA abre partido en $1,000,000.00 + el resto, y dice por qué', () => {
    const { c, pintar } = montar();
    preparar(c, pago(1020891.81), 'BBVA-5712');
    pintar();
    expect(c.prepVarias).toBe(true);
    expect(c.prepPartes.map((p) => [p.amount, p.origin])).toEqual([['1,000,000.00', 'BBVA-5712'], ['20,891.81', 'BBVA-5712']]);
    expect(c.restoDeTransferencias()).toBe(20891.81);
    const texto = document.body.textContent ?? '';
    expect(texto).toMatch(/BBVA no deja pasar de \$1,000,000\.00 por transferencia: el pago ya va partido en 2\./);
    expect(texto).toContain('Partir en 2 y preparar');
  });

  it('lo partido solo se ve con comas y viaja como números: 1000000 + 20891.81', () => {
    const { c, http } = montar();
    preparar(c, pago(1020891.81), 'BBVA-5712');
    c.prepAccountId = null;
    c.prepDestination = 'CITI · CLABE 002180001234567893';
    c.confirmPrepare();
    const envios = http.match(() => true).filter((r) => /preparar-en-transferencias/.test(r.request.url));
    expect(envios).toHaveLength(1);
    expect(envios[0].request.body.transferencias).toEqual([{ amount: 1000000, bank_account_id: 'BBVA-5712' }, { amount: 20891.81, bank_account_id: 'BBVA-5712' }]);
  });

  it('el borde y el control: $1,000,000.00 exactos desde BBVA, o cualquier importe desde Santander, no se parten', () => {
    const { c, pintar } = montar();
    preparar(c, pago(1000000), 'BBVA-5712');
    expect(c.prepVarias).toBe(false);
    preparar(c, pago(1020891.81), 'SANT-2169');
    pintar();
    expect(c.prepVarias).toBe(false);
    expect(c.avisoTopeUnaSola()).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/no deja pasar/);
  });

  it('cambiar el origen a BBVA lo parte; lo que la persona ya partió no se toca', () => {
    const { c } = montar();
    preparar(c, pago(1020891.81), 'SANT-2169');
    c.prepOriginId = 'BBVA-5712';
    c.partirSiPasaDelTope();
    expect(c.prepPartes.map((p) => p.amount)).toEqual(['1,000,000.00', '20,891.81']);
    c.prepPartes = [{ amount: '600000', origin: 'BBVA-5712' }, { amount: '', origin: 'SANT-2169' }];
    c.partirSiPasaDelTope();
    expect(c.prepPartes.map((p) => p.amount)).toEqual(['600000', '']);
  });

  it('⛔ si la persona quita «varias», el aviso sale bajo el origen y entera no se guarda (ni se manda)', () => {
    const { c, http, pintar } = montar();
    preparar(c, pago(1020891.81), 'BBVA-5712');
    c.activarVarias(false);
    pintar();
    const alerta = [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent ?? '').join(' ');
    expect(alerta).toMatch(/BBVA no deja pasar de \$1,000,000\.00 por transferencia y este pago es de \$1,020,891\.81: sale en 2 transferencias/);
    c.confirmPrepare();
    expect(http.match(() => true).filter((r) => /\/preparar/.test(r.request.url))).toHaveLength(0);
  });

  it('⛔ una transferencia de BBVA de $1,500,000.00 en un pago partido a mano: lo dice y no se manda', () => {
    const { c, http } = montar();
    preparar(c, pago(2000000), 'SANT-2169');
    c.activarVarias(true);
    c.prepPartes = [{ amount: '1500000', origin: 'BBVA-5712' }, { amount: '', origin: 'BBVA-5712' }];
    c.prepAccountId = null;
    c.prepDestination = 'CITI · CLABE 002180001234567893';
    c.confirmPrepare();
    expect(c.prepPartesError()).toBe('La transferencia 1 es de $1,500,000.00 y sale de BBVA, que no deja pasar de $1,000,000.00 por operación: pártela en más transferencias.');
    expect(http.match(() => true).filter((r) => /preparar-en-transferencias/.test(r.request.url))).toHaveLength(0);
  });

  it('⛔ un anticipo no se parte: desde BBVA el aviso pide otra cuenta de origen', () => {
    const { c, pintar } = montar();
    preparar(c, pago(1200000, {}, true), 'BBVA-5712');
    pintar();
    expect(c.prepVarias).toBe(false);
    expect(c.avisoTopeUnaSola()).toMatch(/anticipo sale en una sola transferencia, así que elige una cuenta de origen de otro banco/);
  });

  it('el renglón: preparado ENTERO desde BBVA dice que falta partirla; desde Santander o ya pagado, no', () => {
    const { c } = montar();
    const prep = { payment_method: 'transferencia', bank_account_id: 'BBVA-5712', destination_account_text: 'CITI · CLABE x' } as Partial<PaymentCalendarAllocation>;
    expect(c.comoSale(pago(1020891.81, prep)).falta).toBe('partirla: BBVA no deja pasar de $1,000,000.00 por transferencia');
    expect(c.comoSale(pago(1020891.81, { ...prep, bank_account_id: 'SANT-2169' })).falta).toBeNull();
    expect(c.comoSale(pago(1020891.81, { ...prep, status: 'executed' })).falta).toBeNull();
    expect(c.comoSale(pago(1000000, prep)).falta).toBeNull();
  });
});
