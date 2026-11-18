import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { FinanzasCalendarioPagosComponent } from './finanzas-calendario-pagos.component';
import { PedirAnticipoDialogComponent } from '../components/pedir-anticipo-dialog.component';

/**
 * `[PGP.142]` **El anticipo vive en el Calendario de pagos** (pide Compras; Dirección programa, ADR-120). Monta la pantalla
 * entera (compila su plantilla) y cuida tres cosas: que el botón lo vea quien puede pedir —y sólo él—, que el
 * diálogo abra en el día que se está viendo, y que al pedir lleve a SU día, donde aparece en la franja.
 *
 * Las lecturas con que arranca la pantalla (semana, bandeja, obligaciones…) se descartan: aquí no se miden.
 */
function montar(llaves: string[]) {
  TestBed.configureTestingModule({
    imports: [FinanzasCalendarioPagosComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: {
        isAdmin: () => false, isSuperadmin: () => false,
        has: (k: string) => llaves.includes(k), hasExplicit: (k: string) => llaves.includes(k),
        hasAny: (...ks: string[]) => ks.some((k) => llaves.includes(k)),
      } },
      // `canAuthorize` lee la llave del usuario (no PermissionsService): la misma lista, para probar a Dirección de verdad.
      { provide: AuthService, useValue: { user: () => ({ permissions: Object.fromEntries(llaves.map((k) => [k, true])) }) } }],
  });
  const fixture = TestBed.createComponent(FinanzasCalendarioPagosComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.match(() => true);   // lo que la pantalla lee al entrar: no es de esta prueba
  return { fixture, c: fixture.componentInstance, http };
}
const botonPedir = (el: HTMLElement) => [...el.querySelectorAll('.pg-modo button')].find((b) => (b.textContent ?? '').includes('Pedir anticipo')) as HTMLButtonElement | undefined;
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('[PGP.142] el Calendario de pagos pide anticipos', () => {
  it('⛔ NEGATIVA [ADR-120] — quien sólo programa pagos (Tesorería, Finanzas) NO ve «Pedir anticipo»: no registra deuda', () => {
    const { fixture } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR]);
    expect(botonPedir(fixture.nativeElement as HTMLElement)).toBeUndefined();
  });

  it('Compras que entra al Calendario (gerente de compras) ve «Pedir anticipo» junto a la vista; el formulario compartido está en la pantalla', () => {
    const { fixture } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_GESTIONAR]);
    const el = fixture.nativeElement as HTMLElement;
    expect(botonPedir(el)).toBeDefined();
    expect(el.querySelector('app-pedir-anticipo-dialog')).not.toBeNull();
  });

  it('⛔ NEGATIVA [PGP.142] — quien autoriza (Dirección) no ve «Pedir anticipo»: tiene «Programar un anticipo en este día» de [PGP.138], una sola entrada', () => {
    const { fixture } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR, Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR]);
    expect(botonPedir(fixture.nativeElement as HTMLElement)).toBeUndefined();
    const dialogos = fixture.debugElement.queryAll((d) => d.componentInstance instanceof PedirAnticipoDialogComponent).map((d) => (d.componentInstance as PedirAnticipoDialogComponent).modo());
    expect(dialogos.sort()).toEqual(['pedir', 'programar']);
  });

  it('⛔ NEGATIVA — quien sólo VE el Calendario no recibe un botón que el servidor le rechazaría', () => {
    const { fixture } = montar([Permission.FINANCE_PAYMENTS_VER]);
    expect(botonPedir(fixture.nativeElement as HTMLElement)).toBeUndefined();
  });

  it('el diálogo abre en el día que se ve en «Por día»; en «Por etapa» o en un día pasado, en hoy', () => {
    const { fixture, c } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_GESTIONAR]);
    const hoy = c.todayIso;
    const futuro = ymdLocal(new Date(Date.now() + 3 * 86_400_000));
    expect(c.modo()).toBe('etapa');
    expect(c.diaParaAnticipo()).toBe(hoy);
    c.modo.set('dia');
    c.selectedDate.set(futuro);
    expect(c.diaParaAnticipo()).toBe(futuro);
    c.selectedDate.set('2020-01-06');
    expect(c.diaParaAnticipo()).toBe(hoy);
    // Y el clic lo abre de verdad, en ese día.
    c.selectedDate.set(futuro);
    fixture.detectChanges();
    botonPedir(fixture.nativeElement as HTMLElement)!.click();
    const dlg = fixture.debugElement.query((d) => d.componentInstance instanceof PedirAnticipoDialogComponent).componentInstance as PedirAnticipoDialogComponent;
    expect(dlg.visible()).toBe(true);
    expect(ymdLocal(dlg.dia()!)).toBe(futuro);
  });

  it('al pedir lleva a SU día en «Por día» y relee la franja; si ya estaba en ese día, sólo relee la franja', () => {
    const { c, http } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR]);
    const dia = ymdLocal(new Date(Date.now() + 2 * 86_400_000));
    c.alPedirAnticipo({ obligation_id: 'n1', monto: 100, concepto: 'Anticipo · OC 1', cuenta: 'pedida', proveedor: 'X', fecha: dia });
    expect(c.modo()).toBe('dia');
    expect(c.selectedDate()).toBe(dia);
    expect(http.match((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).length).toBe(1);
    http.match(() => true);
    c.alPedirAnticipo({ obligation_id: 'n2', monto: 50, concepto: 'Anticipo · OC 2', cuenta: 'aprobada', proveedor: 'X', fecha: dia });
    const pedidas = http.match(() => true);
    expect(pedidas.map((r) => r.request.url.replace(/^.*\/api/, ''))).toEqual(['/commercial/supplier-obligations/anticipos']);
  });
});

/**
 * `[PGP.145]` Lo que el recorrido de `[PGP.144]` vio en el pago de un anticipo: decía «1 factura» (Autorizar y
 * el desglose) y la sucursal dos veces en su renglón («CEDIS · Anticipo · OC 0001041 · CEDIS»).
 */
describe('[PGP.145] el pago de un anticipo se dice anticipo', () => {
  type Item = { concept: string; branch_code: string | null; es_anticipo?: boolean };
  const pago = (items: Item[]) => ({
    id: 'a1', beneficiary: 'SALSA MAGA', amount_assigned: 28663.25, discount_total: 0, payment_method: 'efectivo',
    cash_register_text: 'Caja general', status: 'pending', lot_date: '2026-11-18',
    items: items.map((it, i) => ({ id: `i${i}`, obligation_source: 'supplier_payable', obligation_id: `o${i}`, applied_amount: 1, beneficiary: 'SALSA MAGA', supplier_id: 's1', ...it })),
  }) as never;
  const ant: Item = { concept: 'Anticipo · OC 0001041 · CEDIS', branch_code: '00', es_anticipo: true };
  const fac: Item = { concept: 'Factura 00-1234', branch_code: '00' };

  it('cuenta anticipos y facturas por lo que son', () => {
    const { c } = montar([Permission.FINANCE_PAYMENTS_VER]);
    expect(c.documentos([ant])).toBe('1 anticipo');
    expect(c.documentos([ant, ant])).toBe('2 anticipos');
    expect(c.documentos([fac])).toBe('1 factura');
    expect(c.documentos([fac, fac, ant])).toBe('2 facturas y 1 anticipo');
    expect(c.itemsResumen(pago([fac, ant]))).toBe('1 factura y 1 anticipo');
  });

  it('el renglón no repite la sucursal del anticipo; el de una factura queda igual', () => {
    const { c } = montar([Permission.FINANCE_PAYMENTS_VER]);
    expect(c.branchLabel('00')).toBe('CEDIS');
    expect(c.itemsResumen(pago([ant]))).toBe('Anticipo · OC 0001041');
    // ⛔ NEGATIVA — sólo se recorta el anticipo y sólo si termina en SU sucursal.
    expect(c.itemsResumen(pago([{ ...fac, concept: 'Flete · CEDIS' }]))).toBe('Flete · CEDIS');
    expect(c.itemsResumen(pago([{ ...ant, branch_code: '05' }]))).toBe('Anticipo · OC 0001041 · CEDIS');
  });

  it('«Autorizar el pago» dice «1 anticipo», no «1 factura»', () => {
    const { fixture, c } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR]);
    c.autorizarObjetivo.set(pago([ant]));
    fixture.detectChanges();
    const textos = [...document.querySelectorAll('.cal-dlg-hint')].map((p) => (p.textContent ?? '').replace(/\s+/g, ' '));
    const hint = textos.find((t) => t.includes('sale el'));
    expect(hint).toContain('1 anticipo');
    expect(hint).not.toContain('factura');
  });
});

/**
 * `[PGP.129]` + revisión del PR: «Agregar» en la franja pone el anticipo como su PROPIO pago. Antes iba por «Agregar
 * facturas» y se SUMABA al pago abierto del mismo proveedor y sucursal: las facturas quedaban atadas a la CLABE de la
 * cotización y en Kepler salían mezcladas con el anticipo. Igual que `[PGP.138]`: «no se suma al pago de facturas».
 */
describe('[PGP.129] «Agregar» un anticipo pedido', () => {
  const SUP = '33333333-3333-3333-3333-333333333333';
  it('⛔ NEGATIVA — con un pago abierto del mismo proveedor y sucursal, el anticipo NO se suma: nace su propio pago', async () => {
    const { c, http } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR]);
    const dia = c.selectedDate();
    // El día ya tiene el pago de facturas de ese proveedor en la sucursal 03, abierto (sin folio).
    c.week.set({ days: [{ date: dia, summary: { lot_status: 'open' }, allocations: [{
      id: 'pago-facturas', status: 'pending', folio: null, classification: 'proveedor_mercancia',
      items: [{ obligation_source: 'kepler_payable', supplier_id: SUP, beneficiary: 'DULCES DEL NORTE', branch_code: '03' }],
    }] }] } as never);
    const s = { obligation_id: 'ant-1', proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', sucursal: '03', monto: 5000,
      pagado: 0, disponible: 5000, supplier_id: SUP, fecha_deseada: dia, ocs: [{ sucursal: '03', serie: '1', folio: '0000101' }] } as never;
    const hecho = c.agregarAnticipo(s);
    const alta = http.expectOne((r) => r.method === 'POST' && /\/allocations$/.test(r.url));
    expect(alta.request.body).toMatchObject({ date: dia, items: [{ obligation_source: 'supplier_payable', obligation_id: 'ant-1', applied_amount: 5000 }] });
    expect(http.match((r) => /\/allocations\/pago-facturas\/items$/.test(r.url))).toEqual([]);
    alta.flush({ id: 'pago-anticipo' });
    await new Promise((r) => setTimeout(r, 0));
    http.match(() => true).forEach((r) => r.flush([]));
    await hecho;
    expect(c.avisoAlta()).toMatch(/pago propio/);
  });
});

/**
 * `[PGP.129]` La propuesta del día agrupa la deuda por proveedor y sucursal: el anticipo pedido (que también es
 * deuda de ese proveedor) se sumaba al pago de sus facturas y se decía «1 factura». Ya no lo propone: entra como pago
 * propio desde su franja o desde «Programar».
 */
describe('[PGP.129] la propuesta del día no arma anticipos', () => {
  const SUP = '44444444-4444-4444-4444-444444444444';
  const ob = (id: string, source: string, vence: string) => ({
    obligation_source: source, obligation_id: id, beneficiary: 'DULCES DEL NORTE', concept: id, classification: 'proveedor_mercancia',
    subtype: 'mercancia', area_code: 'CA001', original_due_date: vence, negotiated_date: null, original_amount: 1000,
    reserved_amount: 0, paid_amount: 0, available_amount: 1000, is_critical: false, critical_reason: null, status: 'pending',
    branch_code: '03', payee_id: SUP, payee_code: 'CA001',
  });
  it('⛔ NEGATIVA — con una factura y un anticipo del mismo proveedor y sucursal, propone sólo la factura', async () => {
    const { c, http } = montar([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR]);
    const hoy = c.todayIso;
    c.selectedDate.set(hoy);
    c.week.set({ days: [{ date: hoy, summary: { lot_status: null, capacity_defined: false, remaining_amount: 0 }, allocations: [] }] } as never);
    const hecho = c.proponer();
    http.expectOne((r) => r.url.includes('/obligations?limit=5000')).flush({ rows: [ob('fac-1', 'kepler_payable', hoy), ob('ant-1', 'supplier_payable', hoy)], total: 2 });
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush([{ obligation_id: 'ant-1' }]);
    await hecho;
    const ids = (c.armado() ?? []).flatMap((g) => g.items.map((i) => i.obligation_id));
    expect(ids).toContain('fac-1');
    expect(ids).not.toContain('ant-1');
  });
});
