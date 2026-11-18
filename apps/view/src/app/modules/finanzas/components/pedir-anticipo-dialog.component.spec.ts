import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import { PERMISOS_PEDIR_ANTICIPO } from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { PedirAnticipoDialogComponent, diaInicialDelAnticipo, type AnticipoPedido } from './pedir-anticipo-dialog.component';

/**
 * `[PGP.119]` · `[PGP.127]` · `[PGP.138]` · `[PGP.142]` El diálogo «Pedir / Programar anticipo», el MISMO para el
 * Calendario de pagos, Compras › Anticipos, OC abiertas y «Anticipos solicitados». Monta el componente (compila la
 * plantilla) y cuida lo que puede mandar un pedido sin sus papeles —sin OC de Kepler, sobre su saldo, sin
 * cotización o con la CLABE mal no sale— y lo que encontró la auditoría de `[PGP.138]` (un error no se lee como
 * vacío, cerrar no tira lo capturado sin preguntar, el error del servidor se dice en el diálogo).
 *
 * Vectores SINTÉTICOS (el repo es público).
 */
const SUP = '11111111-1111-1111-1111-111111111111';
const PROV = { id: SUP, code: 'CA001', name: 'DULCES DEL NORTE' };
const CLABE = '012180001234567899';   // sintética, con su dígito de control bien
const OCS = [
  { sucursal: '03', serie: '1', folio: '0000101', fecha: '2026-11-10', estado: 'N', total: 6000, pedidos: [{ id: 'p1', monto: 3000 }] },
  { sucursal: '03', serie: '1', folio: '0000102', fecha: '2026-11-09', estado: 'R', total: 4000, pedidos: [{ id: 'p1', monto: 3000 }] },
  { sucursal: '08', serie: '1', folio: '0000500', fecha: '2026-11-08', estado: 'N', total: 9000, pedidos: [] },
];
const ymd = (d: Date | null) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

describe('[PGP.138][PGP.142] PedirAnticipoDialogComponent', () => {
  let fixture: ComponentFixture<PedirAnticipoDialogComponent>;
  let c: PedirAnticipoDialogComponent;
  let http: HttpTestingController;
  let toast: MessageService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PedirAnticipoDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), MessageService],
    });
    fixture = TestBed.createComponent(PedirAnticipoDialogComponent);
    c = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    toast = TestBed.inject(MessageService);
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  const ocsDe = () => http.expectOne((r) => r.url.endsWith('/anticipo/ocs'));
  const cuentasDe = () => http.expectOne((r) => r.url.endsWith(`/finance/supplier-payment-accounts/by-supplier/${SUP}`));
  const provs = () => http.expectOne((r) => r.url.endsWith('/anticipo/proveedores'));
  const elegirConOcs = (ocs: unknown[], cuentas: unknown[]) => {
    c.elegirProveedor(PROV);
    ocsDe().flush(ocs);
    cuentasDe().flush(cuentas);
  };
  /** Todo lo que pide la regla, con una OC: el pedido ya puede salir. */
  const completo = () => {
    elegirConOcs([OCS[0]], []);
    c.monto.set('100'); c.motivo.set('temporada');
    c.cot.set({ key: 'commercial/t/anticipos/x.pdf', kind: 'pdf', nombre: 'c.pdf' });
    c.clabe.set(CLABE); c.banco.set('BBVA');
  };

  it('quién lo pide: Compras, quien programa pagos (D14, Francisco) o Dirección (ADR-120, Edgar) — la lista que comparten pantalla y servidor', () => {
    expect([...PERMISOS_PEDIR_ANTICIPO].sort()).toEqual([
      Permission.COMPRAS_OBLIGACIONES_GESTIONAR, Permission.FINANCE_PAYMENTS_GESTIONAR, Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR,
    ].sort());
  });

  it('⛔ NEGATIVA — el día con que abre: el que se ve si no pasó; uno pasado, vacío o mal escrito abre en hoy', () => {
    expect(diaInicialDelAnticipo('2026-11-20', '2026-11-17')).toBe('2026-11-20');
    expect(diaInicialDelAnticipo('2026-11-17', '2026-11-17')).toBe('2026-11-17');
    expect(diaInicialDelAnticipo('2026-11-10', '2026-11-17')).toBe('2026-11-17');
    expect(diaInicialDelAnticipo(null, '2026-11-17')).toBe('2026-11-17');
    expect(diaInicialDelAnticipo('20-11-2026', '2026-11-17')).toBe('2026-11-17');
  });

  it('abrir(día) lo abre en blanco en ese día; otra vez, sin lo que quedó del pedido anterior', () => {
    const hoy = ymd(new Date())!;
    const manana = ymd(new Date(Date.now() + 86_400_000))!;
    c.abrir(manana);
    expect(c.visible()).toBe(true);
    expect(ymd(c.dia())).toBe(manana);
    elegirConOcs([OCS[0]], []);
    c.monto.set('500');
    c.abrir('2020-01-01');
    expect(ymd(c.dia())).toBe(hoy);
    expect(c.prov()).toBeNull();
    expect(c.ocs()).toEqual([]);
    expect(c.monto()).toBe('');
  });

  it('⛔ NEGATIVA — abrirlo con su contexto (abrir / abrirParaOc) no se borra al mostrarse; por [(visible)] sí arranca limpio', () => {
    c.abrirParaOc({ sucursal: '03', folio: '0000101', codigo: 'ca001', nombre: 'DULCES DEL NORTE' });
    c.alAbrir();                                   // el (onShow) del p-dialog
    expect(c.deOc()).toEqual({ sucursal: '03', folio: '0000101' });
    provs().flush([PROV]);
    ocsDe().flush(OCS);
    cuentasDe().flush([]);
    expect(c.ocsElegidas().map((o) => o.folio)).toEqual(['0000101']);
    c.cerrar();
    c.visible.set(true);                           // por [(visible)], como el Calendario en «programar»
    c.alAbrir();
    expect(c.deOc()).toBeNull();
    expect(c.prov()).toBeNull();
  });

  it('⛔ NEGATIVA [PGP.127] — sin OC de Kepler, sobre su saldo, sin cotización o con la CLABE mal no sale; con todo, manda los papeles y avisa a la pantalla', () => {
    const emitidos: AnticipoPedido[] = [];
    c.pedido.subscribe((p) => emitidos.push(p));
    const avisos = vi.spyOn(toast, 'add');
    c.abrir();
    expect(c.falta()).toMatch(/proveedor/);
    elegirConOcs(OCS, []);
    expect(c.ctaTipo()).toBe('nueva');                     // sin cuenta aprobada: se captura la de la cotización
    c.monto.set('1166,40');
    expect(c.falta()).toMatch(/centavos con punto/);       // ambiguo: no se adivina
    c.monto.set('7,000.01');
    c.motivo.set('temporada');
    expect(c.falta()).toMatch(/orden de compra de Kepler/);
    c.alternarOc(c.ocs()[0], true);
    c.alternarOc(c.ocs()[1], true);
    expect(c.sucursal()).toBe('03');                       // la sucursal es la de la OC
    expect(c.ocBloqueada(c.ocs()[2])).toBe(true);          // la de otra sucursal se apaga
    expect(c.falta()).toMatch(/quedan \$7000\.00/);        // 6,000 + 4,000 − 3,000 (el pedido p1, UNA vez)
    c.monto.set('7000');
    expect(c.falta()).toMatch(/cotización/);
    c.cot.set({ key: 'commercial/t/anticipos/x.pdf', kind: 'pdf', nombre: 'cotizacion.pdf' });
    c.clabe.set('012180001234567890');
    c.banco.set('BBVA');
    expect(c.falta()).toMatch(/dígito de control/);
    c.clabe.set('0121 8000 1234 5678 99');                 // pegada con espacios, como viene en la cotización
    expect(c.falta()).toBeNull();
    c.guardar();
    const req = http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipo') && r.method === 'POST');
    expect(req.request.body).toMatchObject({
      supplier_id: SUP, sucursal: '03', monto: 7000, motivo: 'temporada', fecha: ymd(new Date()),
      kepler_ocs: [{ sucursal: '03', serie: '1', folio: '0000101' }, { sucursal: '03', serie: '1', folio: '0000102' }],
      cotizacion: { key: 'commercial/t/anticipos/x.pdf', kind: 'pdf' },
      cuenta: { tipo: 'nueva', clabe: CLABE, banco: 'BBVA' },
    });
    expect(req.request.body.purchase_order_id).toBeUndefined();   // la OC de la Suite ya no se ofrece
    req.flush({ obligation_id: 'n1', monto: 7000, concepto: 'Anticipo · OC 0000101, 0000102 · 8 Esquinas', cuenta: 'pedida' });
    expect(c.visible()).toBe(false);
    expect(emitidos).toEqual([{ obligation_id: 'n1', monto: 7000, concepto: 'Anticipo · OC 0000101, 0000102 · 8 Esquinas', cuenta: 'pedida',
      proveedor: 'DULCES DEL NORTE', fecha: ymd(new Date()) }]);
    expect(avisos).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success', detail: expect.stringMatching(/quedó pedida de alta/) }));
  });

  it('⛔ NEGATIVA — si el servidor lo rechaza, el diálogo queda abierto, lo dice EN el diálogo y no avisa «pedido» a la pantalla', () => {
    const emitidos: AnticipoPedido[] = [];
    c.pedido.subscribe((p) => emitidos.push(p));
    c.abrir();
    completo();
    expect(c.falta()).toBeNull();
    c.guardar();
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipo'))
      .flush({ message: 'La OC 0000101 no es de este proveedor o ya no está pendiente en Kepler: vuelve a elegirla.' }, { status: 400, statusText: 'Bad Request' });
    expect(c.visible()).toBe(true);
    expect(emitidos).toEqual([]);
    expect(c.errorGuardar()).toMatch(/ya no está pendiente en Kepler/);
    expect(c.monto()).toBe('100');                         // lo capturado sigue ahí
  });

  it('⛔ [PGP.138] si las órdenes de compra no se pudieron leer, lo dice y NO deja pedir (no se lee como «sin OC»); reintentar las trae', () => {
    c.abrir();
    c.elegirProveedor(PROV);
    ocsDe().flush({ message: 'caído' }, { status: 500, statusText: 'Server Error' });
    cuentasDe().flush([]);
    expect(c.ocsError()).toBe(true);
    c.monto.set('500'); c.motivo.set('temporada');
    expect(c.falta()).toMatch(/Faltan sus órdenes de compra/);
    c.cargarOcs(PROV);
    expect(c.falta()).toMatch(/Leyendo/);
    ocsDe().flush([OCS[0]]);
    expect(c.ocsError()).toBe(false);
    expect(c.ocsElegidas().map((o) => o.folio)).toEqual(['0000101']);
  });

  it('⛔ [PGP.138] la búsqueda de proveedor distingue buscando, sin coincidencias y falló', () => {
    c.abrir();
    c.busca.set('dulc');
    c.buscarAhora();
    expect(c.estadoBusqueda()).toBe('buscando');
    provs().flush([]);
    expect(c.estadoBusqueda()).toBe('vacio');
    c.buscarAhora();
    provs().flush({ message: 'caído' }, { status: 500, statusText: 'Server Error' });
    expect(c.estadoBusqueda()).toBe('error');
    expect(c.opciones()).toEqual([]);
    c.buscarAhora();
    provs().flush([PROV]);
    expect(c.estadoBusqueda()).toBe('hay');
    fixture.detectChanges();
    expect(document.querySelector('.pa-opciones[role="listbox"]')).toBeNull();   // sin listbox falso
  });

  it('⛔ [PGP.138] cerrar con algo capturado pregunta antes de tirarlo; sin nada capturado, cierra', () => {
    c.abrir();
    c.motivo.set('temporada');
    c.pedirCerrar();
    expect(c.visible()).toBe(true);
    expect(c.confirmarDescarte()).toBe(true);
    c.confirmarDescarte.set(false);            // «Seguir capturando»
    expect(c.motivo()).toBe('temporada');      // lo capturado sigue ahí
    c.pedirCerrar();
    c.cerrar();                                // «Descartar»
    expect(c.visible()).toBe(false);
    c.abrir();
    c.pedirCerrar();
    expect(c.visible()).toBe(false);
  });

  it('[PGP.138] por [(visible)], «Pagar el» arranca en el día que trae la pantalla; un día pasado no, se usa hoy', () => {
    const futuro = new Date(); futuro.setDate(futuro.getDate() + 3); futuro.setHours(12, 0, 0, 0);
    fixture.componentRef.setInput('fechaInicial', futuro);
    c.limpiar();
    expect(c.dia()?.toDateString()).toBe(futuro.toDateString());
    const pasado = new Date(); pasado.setDate(pasado.getDate() - 10);
    fixture.componentRef.setInput('fechaInicial', pasado);
    c.limpiar();
    expect(c.dia()?.toDateString()).toBe(new Date().toDateString());
  });

  it('[PGP.138] en modo «programar» dice programar, no pedir; la pantalla avisa dónde quedó (aquí sólo lo que falta de la cuenta)', () => {
    expect(c.accion()).toBe('Pedir anticipo');
    fixture.componentRef.setInput('modo', 'programar');
    expect(c.titulo()).toBe('Programar anticipo a proveedor');
    expect(c.accion()).toBe('Programar anticipo');
    expect(c.ayuda()).toMatch(/día que estás viendo/);
    const avisos = vi.spyOn(toast, 'add');
    c.abrir();
    completo();
    c.guardar();
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipo')).flush({ obligation_id: 'n2', monto: 100, concepto: 'Anticipo · OC 0000101 · 8 Esquinas', cuenta: 'aprobada' });
    expect(avisos).not.toHaveBeenCalled();
  });

  it('⛔ NEGATIVA [PGP.144] — el proveedor elegido no sale pegado a su código («SALSA MAGA SA DE CVCS001», visto en el recorrido)', () => {
    c.abrir();
    elegirConOcs([OCS[0]], []);
    fixture.detectChanges();
    const t = (document.querySelector('.pa-elegido')?.textContent ?? '').replace(/ /g, ' ');
    expect(t).toContain('DULCES DEL NORTE CA001');
  });

  it('[PGP.127] con cuentas aprobadas se propone la favorita (sólo las que tienen CLABE); una sola OC se marca sola', () => {
    c.abrir();
    const A1 = '00000000-0000-0000-0000-0000000000a1', A2 = '00000000-0000-0000-0000-0000000000a2';
    elegirConOcs([OCS[0]], [
      { id: A1, bank_name: 'BANORTE', clabe: '072180009999999993', alias: null, es_favorita: false },
      { id: A2, bank_name: 'BBVA', clabe: CLABE, alias: 'principal', es_favorita: true },
      { id: '00000000-0000-0000-0000-0000000000a3', bank_name: 'SANTANDER', clabe: null, alias: null, es_favorita: false },
    ]);
    expect(c.ocsElegidas().map((o) => o.folio)).toEqual(['0000101']);
    expect(c.ctaTipo()).toBe('aprobada');
    expect(c.cuentaId()).toBe(A2);
    expect(c.cuentaOpciones().map((o) => o.value)).toEqual([A1, A2]);   // la que no tiene CLABE no sirve para transferir
    expect(c.cuenta()).toEqual({ tipo: 'aprobada', account_id: A2 });
  });
  // ── Revisión independiente del PR: lo que llega tarde, después de cerrar, reabrir o cambiar de proveedor ──
  it('⛔ NEGATIVA (revisión) — una búsqueda que llega después de cerrar y reabrir no pinta proveedores bajo un buscador vacío', () => {
    c.abrir();
    c.busca.set('dulc');
    c.buscarAhora();
    const vieja = provs();
    c.cerrar();
    c.abrir();
    vieja.flush([PROV]);
    expect(c.opciones()).toEqual([]);
    expect(c.estadoBusqueda()).toBe('nada');
  });

  it('⛔ NEGATIVA (revisión) — la cotización que subía cuando se descartó el pedido no aparece en el siguiente', async () => {
    c.abrir();
    c.elegirCotizacion({ target: { files: [new File(['%PDF-1.4'], 'vieja.pdf', { type: 'application/pdf' })], value: '' } } as unknown as Event);
    await new Promise((r) => setTimeout(r, 20));               // el FileReader termina y sale el POST
    const subida = http.expectOne((r) => r.url.endsWith('/anticipo/cotizacion'));
    c.cerrar();
    c.abrir();
    subida.flush({ key: 'commercial/t/anticipos/vieja.pdf', kind: 'pdf' });
    expect(c.cot()).toBeNull();
    expect(c.cotSubiendo()).toBe(false);
  });

  it('⛔ NEGATIVA (revisión) — «Cambiar» de proveedor suelta la OC desde la que se abrió y la cotización del anterior', () => {
    c.abrirParaOc({ sucursal: '03', folio: '0000101', codigo: 'CA001', nombre: 'DULCES DEL NORTE' });
    provs().flush([PROV]);
    ocsDe().flush(OCS);
    cuentasDe().flush([]);
    c.cot.set({ key: 'commercial/t/anticipos/x.pdf', kind: 'pdf', nombre: 'de-CA001.pdf' });
    expect(c.deOc()).not.toBeNull();
    c.quitarProveedor();
    expect(c.deOc()).toBeNull();
    expect(c.cot()).toBeNull();
  });

  it('⛔ NEGATIVA (revisión) — si ya eligió «Efectivo» antes de que lleguen sus cuentas, la respuesta no se lo cambia', () => {
    c.abrir();
    c.elegirProveedor(PROV);
    ocsDe().flush([OCS[0]]);
    c.ctaTipo.set('efectivo');
    cuentasDe().flush([{ id: '00000000-0000-0000-0000-0000000000a2', bank_name: 'BBVA', clabe: CLABE, alias: null, es_favorita: true }]);
    expect(c.ctaTipo()).toBe('efectivo');
    expect(c.cuentaOpciones()).toHaveLength(1);                 // la cuenta sí queda ofrecida
  });

  it('⛔ NEGATIVA (revisión) — abierto desde la OC 0000123 de una sucursal, la búsqueda vieja de OTRA sucursal (mismo folio) no elige a su proveedor', () => {
    c.abrirParaOc({ sucursal: '01', folio: '0000123', codigo: 'CA001', nombre: 'DULCES DEL NORTE' });
    const deA = provs();
    c.cerrar();
    c.abrirParaOc({ sucursal: '05', folio: '0000123', codigo: 'CB002', nombre: 'CHOCOLATES SUR' });
    const deB = provs();
    deA.flush([PROV]);
    expect(c.prov()).toBeNull();                               // el de la apertura anterior se descarta
    deB.flush([{ id: '22222222-2222-2222-2222-222222222222', code: 'CB002', name: 'CHOCOLATES SUR' }]);
    expect(c.prov()?.code).toBe('CB002');
    ocsDe().flush([]);
    http.expectOne((r) => r.url.includes('/by-supplier/22222222')).flush([]);
  });
});
