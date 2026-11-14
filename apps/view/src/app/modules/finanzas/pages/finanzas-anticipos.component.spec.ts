import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { AnticipoDeudaRow, AnticipoRow, AnticipoSolicitadoRow } from '@megadulces/contracts';
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

const SOLICITADOS: AnticipoSolicitadoRow[] = [
  { obligation_id: 'o1', proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', sucursal: '00', monto: 5000, motivo: 'temporada', oc_folio: 'OC-9',
    creado_por: 'compras1', creado: '2026-11-10', fecha_deseada: '2026-11-12', estado_obligacion: 'pending', pagado: 0,
    programado_dia: null, allocation_id: null, kepler: null, posibles: 0, etapa: 'por_programar' },
  { obligation_id: 'o2', proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', sucursal: '00', monto: 3000, motivo: null, oc_folio: null,
    creado_por: 'compras1', creado: '2026-11-01', fecha_deseada: null, estado_obligacion: 'pending', pagado: 0, programado_dia: '2026-11-03', allocation_id: 'a2',
    kepler: { folio: '0000200', fecha: '2026-11-03', importe: 3000, remanente: 3000 }, posibles: 2, etapa: 'en_kepler' },
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

  it('[PGP.119] el seguimiento dice la etapa de cada pedido y avisa los que esperan día en el Calendario', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    fixture.detectChanges();
    const txt = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('Pedidos en la Suite');
    expect(txt).toContain('Por programar');
    expect(txt).toContain('En Kepler');
    expect(txt).toContain('1 anticipo pedido en la Suite espera su pago');
    expect(c.detalleSolicitud(SOLICITADOS[1])).toContain('Anticipo 0000200');
    expect(txt).toContain('2 anticipos de Kepler podían ser');
  });

  it('⛔ NEGATIVA [PGP.119] — el pedido no sale sin proveedor, sin motivo, con un importe ambiguo o sobre el saldo de la OC', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    c.abrirPedido();
    expect(c.pedFalta()).toMatch(/proveedor/);
    c.elegirProveedor({ id: '11111111-1111-1111-1111-111111111111', code: 'CA001', name: 'DULCES DEL NORTE' });
    http.expectOne((r) => r.url.endsWith('/anticipo/ocs')).flush([{ id: 'oc1', folio: 'OC-9', sucursal: '03', estado: 'open', total: 10000, anticipado: 8000, creada: '2026-11-01' }]);
    c.elegirOc('oc1');
    expect(c.pedSuc()).toBe('03');   // la sucursal pasa a ser la de la OC
    c.pedMonto.set('1166,40');
    expect(c.pedFalta()).toMatch(/centavos con punto/);   // ambiguo: no se adivina
    c.pedMonto.set('2,500.00');
    c.pedMotivo.set('temporada');
    expect(c.pedFalta()).toMatch(/quedan \$2000\.00/);    // OC de 10,000 con 8,000 ya anticipados
    c.pedMonto.set('2000');
    expect(c.pedFalta()).toBeNull();
    c.guardarPedido();
    const req = http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipo') && r.method === 'POST');
    expect(req.request.body).toMatchObject({ supplier_id: '11111111-1111-1111-1111-111111111111', sucursal: '03', monto: 2000, motivo: 'temporada', purchase_order_id: 'oc1' });
    req.flush({ obligation_id: 'n1', monto: 2000, concepto: 'Anticipo · OC OC-9 · 8 Esquinas' });
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush(SOLICITADOS);
  });

  it('más de 90 días cuenta sólo mercancía', () => {
    darLista();
    pedidoDeuda().flush(DEUDA);
    const viejos = c.kpis().find((k) => k.label === 'Mercancía con más de 90 días');
    expect(viejos?.value).toBe(2000);
  });
});
