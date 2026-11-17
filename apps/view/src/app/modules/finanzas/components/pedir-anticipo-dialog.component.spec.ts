import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PedirAnticipoDialogComponent, type AnticipoPedido } from './pedir-anticipo-dialog.component';

/**
 * `[PGP.119]` + `[PGP.138]` El diálogo «Pedir / Programar anticipo», compartido por Anticipos y el Calendario de pagos.
 * Vectores SINTÉTICOS (el repo es público).
 */
const PROV = { id: '11111111-1111-1111-1111-111111111111', code: 'CA001', name: 'DULCES DEL NORTE' };
const ocsDe = (http: HttpTestingController) => http.expectOne((r) => r.url.endsWith('/anticipo/ocs'));
const provs = (http: HttpTestingController) => http.expectOne((r) => r.url.endsWith('/anticipo/proveedores'));

describe('[PGP.138] PedirAnticipoDialogComponent', () => {
  let fixture: ComponentFixture<PedirAnticipoDialogComponent>;
  let c: PedirAnticipoDialogComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PedirAnticipoDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(PedirAnticipoDialogComponent);
    c = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    c.visible.set(true);
    c.limpiar();
  });
  afterEach(() => http.verify());

  it('⛔ NEGATIVA [PGP.119] — el pedido no sale sin proveedor, sin motivo, con un importe ambiguo o sobre el saldo de la OC', () => {
    const emitidos: AnticipoPedido[] = [];
    c.pedido.subscribe((r) => emitidos.push(r));
    expect(c.falta()).toMatch(/proveedor/);
    c.elegirProveedor(PROV);
    ocsDe(http).flush([{ id: 'oc1', folio: 'OC-9', sucursal: '03', estado: 'open', total: 10000, anticipado: 8000, creada: '2026-11-01' }]);
    c.elegirOc('oc1');
    expect(c.suc()).toBe('03');   // la sucursal pasa a ser la de la OC
    c.monto.set('1166,40');
    expect(c.falta()).toMatch(/centavos con punto/);   // ambiguo: no se adivina
    c.monto.set('2,500.00');
    c.motivo.set('temporada');
    expect(c.falta()).toMatch(/quedan \$2000\.00/);    // OC de 10,000 con 8,000 ya anticipados
    c.monto.set('2000');
    expect(c.falta()).toBeNull();
    c.guardar();
    const req = http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipo') && r.method === 'POST');
    expect(req.request.body).toMatchObject({ supplier_id: PROV.id, sucursal: '03', monto: 2000, motivo: 'temporada', purchase_order_id: 'oc1' });
    req.flush({ obligation_id: 'n1', monto: 2000, concepto: 'Anticipo · OC OC-9 · 8 Esquinas' });
    expect(c.visible()).toBe(false);
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toMatchObject({ obligation_id: 'n1', monto: 2000, proveedor: 'DULCES DEL NORTE' });
  });

  it('⛔ si las órdenes de compra no se pudieron leer, lo dice y NO deja pedir (no se lee como «sin OC»); reintentar las trae', () => {
    c.elegirProveedor(PROV);
    ocsDe(http).flush({ message: 'caído' }, { status: 500, statusText: 'Server Error' });
    expect(c.ocsError()).toBe(true);
    c.suc.set('00'); c.monto.set('500'); c.motivo.set('temporada');
    expect(c.falta()).toMatch(/órdenes de compra/);
    c.cargarOcs();
    expect(c.falta()).toMatch(/Leyendo/);
    ocsDe(http).flush([]);
    expect(c.ocsError()).toBe(false);
    expect(c.falta()).toBeNull();
  });

  it('⛔ la búsqueda de proveedor distingue buscando, sin coincidencias y falló', () => {
    c.busca.set('dulc');
    c.buscarAhora();
    expect(c.estadoBusqueda()).toBe('buscando');
    provs(http).flush([]);
    expect(c.estadoBusqueda()).toBe('vacio');
    c.buscarAhora();
    provs(http).flush({ message: 'caído' }, { status: 500, statusText: 'Server Error' });
    expect(c.estadoBusqueda()).toBe('error');
    expect(c.opciones()).toEqual([]);
    c.buscarAhora();
    provs(http).flush([PROV]);
    expect(c.estadoBusqueda()).toBe('hay');
  });

  it('⛔ cerrar con algo capturado pregunta antes de tirarlo; sin nada capturado, cierra', () => {
    c.motivo.set('temporada');
    c.pedirCerrar();
    expect(c.visible()).toBe(true);
    expect(c.confirmarDescarte()).toBe(true);
    c.confirmarDescarte.set(false);            // «Seguir capturando»
    expect(c.motivo()).toBe('temporada');      // lo capturado sigue ahí
    c.pedirCerrar();
    c.cerrar();                                // «Descartar»
    expect(c.visible()).toBe(false);
    c.visible.set(true);
    c.limpiar();
    c.pedirCerrar();
    expect(c.visible()).toBe(false);
  });

  it('[PGP.138] «Pagar el» arranca en el día que trae la pantalla; un día pasado no, se usa hoy', () => {
    const futuro = new Date(); futuro.setDate(futuro.getDate() + 3); futuro.setHours(12, 0, 0, 0);
    fixture.componentRef.setInput('fechaInicial', futuro);
    c.limpiar();
    expect(c.fecha()?.toDateString()).toBe(futuro.toDateString());
    const pasado = new Date(); pasado.setDate(pasado.getDate() - 10);
    fixture.componentRef.setInput('fechaInicial', pasado);
    c.limpiar();
    expect(c.fecha()?.toDateString()).toBe(new Date().toDateString());
  });

  it('[PGP.138] en modo «programar» dice programar, no pedir, y el día no se elige', () => {
    expect(c.accion()).toBe('Pedir anticipo');
    fixture.componentRef.setInput('modo', 'programar');
    expect(c.titulo()).toBe('Programar anticipo a proveedor');
    expect(c.accion()).toBe('Programar anticipo');
    expect(c.ayuda()).toMatch(/día que estás viendo/);
  });

  it('⛔ si el servidor rechaza, el diálogo sigue abierto, dice por qué y no avisa a la pantalla', () => {
    const emitidos: AnticipoPedido[] = [];
    c.pedido.subscribe((r) => emitidos.push(r));
    c.elegirProveedor({ id: '22222222-2222-2222-2222-222222222222', code: 'CB002', name: 'CHOCOLATES SUR' });
    ocsDe(http).flush([]);
    c.suc.set('00'); c.monto.set('500'); c.motivo.set('temporada');
    expect(c.falta()).toBeNull();
    c.guardar();
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipo') && r.method === 'POST')
      .flush({ message: 'el proveedor no es de mercancía' }, { status: 400, statusText: 'Bad Request' });
    expect(c.visible()).toBe(true);
    expect(c.errorGuardar()).toContain('no es de mercancía');
    expect(emitidos).toHaveLength(0);
  });
});
