import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { AnticipoDeudaRow, AnticipoRow } from '@megadulces/contracts';
import { FinanzasAnticiposComponent } from './finanzas-anticipos.component';

/**
 * `[PGP.118]` Candado del submódulo de Anticipos. Monta el componente (compila la plantilla) y cuida
 * lo que puede publicar un número falso: que la deuda que todavía no llega NO se lea como «sin contra
 * qué», que lo aplicable hoy nunca pase ni el anticipo ni la deuda, y que los grupos sumen el total.
 *
 * Vectores SINTÉTICOS (el repo es público).
 */
const fila = (p: Partial<AnticipoRow>): AnticipoRow => ({
  sucursal: '00', proveedor: 'CA001', proveedor_nombre: 'ACREEDOR UNO', folio: '0000001', referencia: null,
  fecha: '2026-11-01', dias: 12, importe: 1000, aplicado: 0, a_favor: 1000, ...p,
});
const FILAS: AnticipoRow[] = [
  fila({ proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', folio: '0000001', a_favor: 1000, importe: 1000 }),
  fila({ proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', folio: '0000002', a_favor: 500, importe: 800, aplicado: 300, referencia: 'OC 77' }),
  fila({ proveedor: 'CB002', proveedor_nombre: 'CHOCOLATES SUR', folio: '0000003', a_favor: 2000, dias: 120 }),
  fila({ proveedor: 'GL003', proveedor_nombre: 'RENTA LOCAL', folio: '0000004', a_favor: 700 }),
  fila({ proveedor: 'TC004', proveedor_nombre: 'TARJETA EMPRESA', folio: '0000005', a_favor: 300 }),
];
const TOTAL = FILAS.reduce((s, r) => s + r.a_favor, 0);
// CA001 debe 1,200 (menos que su anticipo de 1,500); CB002 no debe nada (no viene en la respuesta).
const DEUDA: AnticipoDeudaRow[] = [{ proveedor: 'CA001', facturas: 2, deuda: 1200, vence_primero: '2026-11-20' }];

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

  it('más de 90 días cuenta sólo mercancía', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    const viejos = c.kpis().find((k) => k.label === 'Mercancía con más de 90 días');
    expect(viejos?.value).toBe(2000);
  });
});
