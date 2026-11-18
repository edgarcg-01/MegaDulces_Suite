import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { AnticipoDeudaRow, AnticipoRow, AnticipoSolicitadoRow } from '@megadulces/contracts';
import { FinanzasAnticiposComponent } from './finanzas-anticipos.component';
import { PedirAnticipoDialogComponent } from '../components/pedir-anticipo-dialog.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[PGP.118]` Candado del submódulo de Anticipos. Monta el componente (compila la plantilla) y cuida
 * lo que puede publicar un número falso: que la deuda que todavía no llega NO se lea como «sin contra
 * qué», que lo aplicable hoy nunca pase ni el anticipo ni la deuda, y que los grupos sumen el total.
 *
 * Vectores SINTÉTICOS (el repo es público).
 */
const fila = (p: Partial<AnticipoRow>): AnticipoRow => ({
  sucursal: '00', proveedor: 'CA001', proveedor_nombre: 'ACREEDOR UNO', folio: '0000001', referencia: null,
  fecha: '2026-11-01', dias: 12, importe: 1000, aplicado: 0, a_favor: 1000, apartado: 0, ...p,
});
const FILAS: AnticipoRow[] = [
  fila({ proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', folio: '0000001', a_favor: 1000, importe: 1000 }),
  fila({ proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', folio: '0000002', a_favor: 500, importe: 800, aplicado: 300, referencia: 'OC 77' }),
  fila({ proveedor: 'CB002', proveedor_nombre: 'CHOCOLATES SUR', folio: '0000003', a_favor: 2000, dias: 120 }),
  fila({ proveedor: 'GL003', proveedor_nombre: 'RENTA LOCAL', folio: '0000004', a_favor: 700 }),
  fila({ proveedor: 'TC004', proveedor_nombre: 'TARJETA EMPRESA', folio: '0000005', a_favor: 300 }),
];
const TOTAL = FILAS.reduce((s, r) => s + r.a_favor, 0);
// CA001 debe 1,200 en la MISMA sucursal (menos que su anticipo de 1,500). CB002 sólo debe en OTRA sucursal:
// en Kepler un anticipo no se aplica contra facturas de otra sucursal, así que para CB002 no hay contra qué.
const DEUDA: AnticipoDeudaRow[] = [
  { proveedor: 'CA001', sucursal: '00', facturas: 2, deuda: 1200, vence_primero: '2026-11-20' },
  { proveedor: 'CB002', sucursal: '03', facturas: 4, deuda: 9000, vence_primero: '2026-11-25' },
];

const SUP = '11111111-1111-1111-1111-111111111111';
const CLABE = '012180001234567899';   // sintética, con su dígito de control bien
const SOLICITADOS: AnticipoSolicitadoRow[] = [
  { obligation_id: 'o1', proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', sucursal: '00', monto: 5000, motivo: 'temporada', oc_folio: null,
    creado_por: 'compras1', creado: '2026-11-10', fecha_deseada: '2026-11-12', estado_obligacion: 'pending', pagado: 0,
    programado_dia: null, allocation_id: null, kepler: null, posibles: 0, etapa: 'por_programar',
    // `[PGP.127]` Pedido con sus papeles: OC de Kepler, cotización y una CLABE que espera a Dirección.
    supplier_id: SUP, disponible: 5000, ocs: [{ sucursal: '00', serie: '1', folio: '0000101' }], tiene_cotizacion: true,
    cuenta: { estado: 'en_aprobacion', clabe: CLABE, banco: 'BBVA' } },
  { obligation_id: 'o2', proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', sucursal: '00', monto: 3000, motivo: null, oc_folio: 'OC-9',
    creado_por: 'compras1', creado: '2026-11-01', fecha_deseada: null, estado_obligacion: 'pending', pagado: 0, programado_dia: '2026-11-03', allocation_id: 'a2',
    kepler: { folio: '0000200', fecha: '2026-11-03', importe: 3000, remanente: 3000 }, posibles: 2, etapa: 'en_kepler',
    // Pedido de antes de PGP.127: sin cotización ni cuenta (no se inventa una).
    supplier_id: SUP, disponible: 0, ocs: [], tiene_cotizacion: false, cuenta: { estado: 'sin_dato', clabe: null, banco: null } },
];

describe('[PGP.118] FinanzasAnticiposComponent', () => {
  let fixture: ComponentFixture<FinanzasAnticiposComponent>;
  let c: FinanzasAnticiposComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FinanzasAnticiposComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    fixture = TestBed.createComponent(FinanzasAnticiposComponent);
    c = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    // `[PGP.119]` El seguimiento de lo pedido en la Suite se pide aparte al cargar.
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush(SOLICITADOS);
  });
  afterEach(() => http.verify());

  const darLista = () => {
    http.expectOne((r) => r.url.endsWith('/finance/payment-calendar/anticipos')).flush(FILAS);
    fixture.detectChanges();
  };
  const pedidoDeuda = () => http.expectOne((r) => r.url.endsWith('/finance/payment-calendar/anticipos/deuda'));

  it('⛔ NEGATIVA — mientras la deuda no llega, la mercancía dice «calculando», nunca «sin contra qué» ni $0', () => {
    darLista();
    const req = pedidoDeuda();
    expect(c.grupos().map((g) => g.key)).toEqual(['calculando', 'no_mercancia']);
    expect(c.grupos().some((g) => g.key === 'sin_contra_que')).toBe(false);
    expect(c.neteable()).toBeNull();
    const k = c.kpis()[0];
    expect(k.state).toBe('no_medido');
    expect(c.veredicto()).toContain('calculando');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Calculando');
    req.flush(DEUDA);
  });

  it('pide la deuda SÓLO de los acreedores de mercancía (gasto y tarjeta no se aplican contra compras)', () => {
    darLista();
    const req = pedidoDeuda();
    expect(req.request.params.get('proveedores')?.split(',').sort()).toEqual(['CA001', 'CB002']);
    req.flush(DEUDA);
  });

  it('con la deuda: tres grupos, y entre los tres suman TODO lo que Kepler tiene sin aplicar', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    fixture.detectChanges();
    const g = new Map(c.grupos().map((x) => [x.key, x]));
    expect([...g.keys()]).toEqual(['aplicable', 'sin_contra_que', 'no_mercancia']);
    expect(g.get('aplicable')?.filas.map((r) => r.folio)).toEqual(['0000001', '0000002']); // por monto
    expect(g.get('sin_contra_que')?.filas.map((r) => r.folio)).toEqual(['0000003']);
    expect(g.get('no_mercancia')?.filas.map((r) => r.folio).sort()).toEqual(['0000004', '0000005']);
    const suma = c.grupos().reduce((s, x) => s + x.monto, 0);
    expect(suma).toBe(TOTAL);
  });

  it('lo aplicable hoy es por ACREEDOR y nunca pasa lo que le debemos (1,500 a favor contra 1,200 de deuda → 1,200)', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    expect(c.neteable()).toBe(1200);
    expect(c.kpis()[0].value).toBe(1200);
    expect(c.veredicto()).toMatch(/se pueden aplicar hoy/);
  });

  it('⛔ NEGATIVA — si la deuda falla, se dice que no se pudo leer; no se inventa «sin contra qué»', () => {
    darLista();
    pedidoDeuda().flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(c.deudaError()).toBe(true);
    expect(c.grupos().some((g) => g.key === 'sin_contra_que')).toBe(false);
    expect(c.veredicto()).toContain('no se pudo leer');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Reintentar');
  });

  it('la búsqueda es por tokens en cualquier orden y no cambia las cifras de arriba', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    const antes = c.kpis().map((k) => k.value);
    c.q.set('sur chocolates');
    expect(c.visibles()).toBe(1);
    expect(c.grupos().find((g) => g.key === 'sin_contra_que')?.filas).toHaveLength(1);
    expect(c.kpis().map((k) => k.value)).toEqual(antes);
  });

  it('⛔ NEGATIVA [PGP.120] — la deuda en OTRA sucursal no vuelve aplicable un anticipo (Kepler no lo cruza)', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    const cb = c.conGrupo().find((r) => r.proveedor === 'CB002');
    expect(cb?.grupo).toBe('sin_contra_que');
    expect(c.neteable()).toBe(1200); // los 9,000 que debemos a CB002 en otra sucursal no suman
    expect(c.contraQue(cb!)).toContain('Ninguna factura abierta en');
  });

  it('[PGP.120] lo apartado en el Calendario se dice en la fila', () => {
    http.expectOne((r) => r.url.endsWith('/finance/payment-calendar/anticipos')).flush([fila({ apartado: 400 })]);
    fixture.detectChanges();
    pedidoDeuda().flush([]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ya apartado en el Calendario de pagos');
  });

  // `[PGP.144]` D17: la lista de solicitados (con su cuenta, su cotización y cancelar) se mudó al embudo de
  // «Anticipos solicitados» (`finanzas-anticipos-solicitados.component.spec.ts`). Aquí queda el saldo de Kepler.
  it('[PGP.144] los solicitados ya no se listan aquí: un aviso con su cuenta y el enlace al embudo', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const txt = el.textContent ?? '';
    expect(txt).not.toContain('Pedidos en la Suite');
    expect(txt).toContain('1 anticipo solicitado en la Suite espera su pago');
    expect(txt).toContain('2 anticipos solicitados en la Suite en 180 días');
    const ligas = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(ligas).toContain('/finanzas/anticipos-solicitados');
    expect(c.rutaEmbudo).toBe('/finanzas/anticipos-solicitados');
  });

  // `[PGP.127]` El formulario de pedir (OC de Kepler, cotización, cuenta) se prueba en su componente compartido,
  // `pedir-anticipo-dialog.component.spec.ts` (`[PGP.142]`). Aquí: que la pantalla lo contiene y relee al pedir.
  it('[PGP.142] el formulario compartido vive en la pantalla; al pedir, relee los solicitados', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    const dlg = fixture.debugElement.query((d) => d.componentInstance instanceof PedirAnticipoDialogComponent);
    expect(dlg).not.toBeNull();
    // Por el evento del diálogo, como en la pantalla (revisión del PR: llamar a cargarSolicitados() directo no prueba el enlace).
    (dlg.componentInstance as PedirAnticipoDialogComponent).pedido.emit({ obligation_id: 'n1', monto: 100, concepto: 'Anticipo · OC 1', cuenta: 'aprobada', proveedor: 'X', fecha: '2026-11-20' });
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush(SOLICITADOS);
  });
  it('más de 90 días cuenta sólo mercancía', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    const viejos = c.kpis().find((k) => k.label === 'Mercancía con más de 90 días');
    expect(viejos?.value).toBe(2000);
    // `[PGP.123]` Y no dice «pedir factura o reembolso» de todos: sólo de los que no tienen contra qué.
    expect(viejos?.sub).toBe('1 documentos; 1 sin factura contra qué aplicarse');
  });

  it('[PGP.123] por la puerta de Finanzas: sus pestañas, y gasto y tarjeta a la vista', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    expect(c.deCompras).toBe(false);
    expect(c.apartadoTabs.some((t) => t.route === '/finanzas/anticipos')).toBe(true);
    expect(c.grupos().some((g) => g.key === 'no_mercancia')).toBe(true);
  });
});

describe('[PGP.123] la puerta de Compras (/compras/anticipos)', () => {
  it('⛔ NEGATIVA — pestañas de Pago a proveedor; gasto y tarjeta fuera de la vista pero DECLARADOS, nunca escondidos en silencio', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(),
        provideRouter([{ path: 'compras/anticipos', component: FinanzasAnticiposComponent, data: { puerta: 'compras' } }])],
    });
    const harness = await RouterTestingHarness.create();
    const c = await harness.navigateByUrl('/compras/anticipos', FinanzasAnticiposComponent);
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush(SOLICITADOS);
    http.expectOne((r) => r.url.endsWith('/finance/payment-calendar/anticipos')).flush(FILAS);
    http.expectOne((r) => r.url.endsWith('/finance/payment-calendar/anticipos/deuda')).flush(DEUDA);
    harness.detectChanges();
    expect(c.deCompras).toBe(true);
    expect(c.apartadoTabs.map((t) => t.route)).toContain('/compras/anticipos');
    expect(c.grupos().map((g) => g.key)).toEqual(['aplicable', 'sin_contra_que']);
    expect(c.kpis().some((k) => k.label === 'No es de mercancía')).toBe(false);
    expect(c.fueraDeCompras()).toEqual({ n: 2, monto: 1000 });
    const txt = (harness.routeNativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('2 anticipos de gasto o tarjeta');
    expect(txt).not.toContain('Además, 2 de gasto o tarjeta');
    http.verify();
  });
});

// `[PGP.144]` «Cancelar» se mudó con la lista al embudo (D17): aquí queda «Pedir anticipo».
describe('[PGP.142] D14 — quién ve «Pedir anticipo» en esta pantalla', () => {
  const montar = (llaves: string[]) => {
    TestBed.configureTestingModule({
      imports: [FinanzasAnticiposComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: (k: string) => llaves.includes(k), hasAny: (...ks: string[]) => ks.some((k) => llaves.includes(k)) } }],
    });
    const fixture = TestBed.createComponent(FinanzasAnticiposComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush(SOLICITADOS);
    http.expectOne((r) => r.url.endsWith('/finance/payment-calendar/anticipos')).flush(FILAS);
    http.expectOne((r) => r.url.endsWith('/finance/payment-calendar/anticipos/deuda')).flush(DEUDA);
    fixture.detectChanges();
    const botones = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    http.verify();
    return botones;
  };

  it('quien programa pagos (Finanzas) pide aquí también; cancelar ya no vive aquí (embudo)', () => {
    const b = montar([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR]);
    expect(b).toContain('Pedir anticipo');
    expect(b).not.toContain('Cancelar');
  });

  it('Compras, igual que antes', () => {
    const b = montar([Permission.COMPRAS_OBLIGACIONES_VER, Permission.COMPRAS_OBLIGACIONES_GESTIONAR]);
    expect(b).toContain('Pedir anticipo');
  });

  it('⛔ NEGATIVA — quien sólo VE pagos no recibe un botón que el servidor le rechazaría', () => {
    const b = montar([Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_VER]);
    expect(b).not.toContain('Pedir anticipo');
    expect(b).not.toContain('Cancelar');
  });
});
