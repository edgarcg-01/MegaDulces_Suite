import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { AnticipoKeplerSinSolicitudRow, AnticipoSolicitadoRow } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { FinanzasAnticiposSolicitadosComponent } from './finanzas-anticipos-solicitados.component';

/**
 * `[PGP.144]` **El embudo de los anticipos que pide Compras** (Francisco, 2026-11-17). Monta la pantalla entera
 * (compila la plantilla) y cuida lo que puede mentir: que un paso cuente a quien no llegó, que una lectura que
 * falla se pinte como «0 sin solicitud», que el periodo no filtre, y que la lista mudada (cuenta, cotización,
 * cancelar) siga haciendo lo que hacía en Deuda › Anticipos.
 *
 * Vectores SINTÉTICOS (el repo es público). Las fechas van relativas a hoy: la pantalla filtra por periodo.
 */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hace = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const SUP = '11111111-1111-1111-1111-111111111111';
const CLABE = '012180001234567899';
const sol = (id: string, p: Partial<AnticipoSolicitadoRow>): AnticipoSolicitadoRow => ({
  obligation_id: id, proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', sucursal: '03', monto: 1000, motivo: 'temporada', oc_folio: null,
  creado_por: 'compras1', creado: hace(5), fecha_deseada: hace(3), estado_obligacion: 'pending', pagado: 0, programado_dia: null, cubierto_el: null,
  allocation_id: null, kepler: null, posibles: 0, etapa: 'por_programar', supplier_id: SUP, disponible: 1000,
  ocs: [{ sucursal: '03', serie: '1', folio: '0000101' }], tiene_cotizacion: true, cuenta: { estado: 'en_aprobacion', clabe: CLABE, banco: 'BBVA' }, ...p,
});
const SOLICITUDES: AnticipoSolicitadoRow[] = [
  sol('s1', { creado: hace(12) }),                                                                     // solicitado, 12 días
  sol('s2', { etapa: 'programado', programado_dia: hace(-2), monto: 2000 }),
  sol('s3', { etapa: 'pagado', programado_dia: hace(9), cubierto_el: hace(9), pagado: 3000, monto: 3000, proveedor: 'CB002', proveedor_nombre: 'CHOCOLATES SUR' }),
  sol('s4', { etapa: 'en_kepler', cubierto_el: hace(20), monto: 4000, kepler: { folio: '0000700', fecha: hace(18), importe: 4000, remanente: 4000 }, posibles: 2 }),
  sol('s5', { etapa: 'aplicado', monto: 5000, kepler: { folio: '0000701', fecha: hace(40), importe: 5000, remanente: 0 } }),
  sol('s6', { etapa: 'cancelado', estado_obligacion: 'cancelled', motivo: 'temporada\n[cancelado] ya no lo pide' }),
  sol('viejo', { creado: hace(60), monto: 777 }),                                                       // fuera de 30 días, dentro de 90
];
const KEPLER: AnticipoKeplerSinSolicitudRow[] = [
  { sucursal: '00', proveedor: 'CF009', proveedor_nombre: 'FERRERO DE PRUEBA', folio: '0000900', fecha: hace(4), importe: 9000, remanente: 9000, referencia: null },
];

function montar(llaves: string[], opciones: { kepler?: 'falla' } = {}) {
  TestBed.configureTestingModule({
    imports: [FinanzasAnticiposSolicitadosComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: {
        isAdmin: () => false, isSuperadmin: () => false,
        has: (k: string) => llaves.includes(k), hasExplicit: (k: string) => llaves.includes(k),
        hasAny: (...ks: string[]) => ks.some((k) => llaves.includes(k)),
      } }],
  });
  const fixture = TestBed.createComponent(FinanzasAnticiposSolicitadosComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush(SOLICITUDES);
  const k = http.expectOne((r) => r.url.endsWith('/anticipos/kepler-sin-solicitud'));
  expect(k.request.params.get('dias')).toBe('90');
  if (opciones.kepler === 'falla') k.flush({ message: 'x' }, { status: 500, statusText: 'Error' }); else k.flush(KEPLER);
  http.match(() => true);   // lo que pinten las pestañas: no es de esta prueba
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, c: fixture.componentInstance, http, el, texto: () => (el.textContent ?? '').replace(/\s+/g, ' ') };
}
const FINANZAS = [Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR];

describe('[PGP.144] Anticipos solicitados — el embudo', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('el embudo: cada paso con los que LLEGARON; abre con el veredicto de dónde se juntan', () => {
    const { c, texto } = montar(FINANZAS);
    const pasos = c.pasosItems();
    expect(pasos.map((p) => [p.label, p.value])).toEqual([
      ['Solicitados', 6], ['Programados', 4], ['Cubiertos', 3], ['En Kepler', 2], ['Aplicados', 1],
    ]);
    expect(pasos[0].sub).toMatch(/2 aquí · el más viejo 60 d/);           // s1 (12 d) y «viejo» (60 d) siguen solicitados
    expect(texto()).toMatch(/De 6 anticipos solicitados en 90 días .* 3 ya se cubrieron\. Donde más se juntan: «Solicitado» \(2, el más viejo de 60 días\)/);
    expect(texto()).toMatch(/1 en Kepler sin solicitud/);
    expect(texto()).toMatch(/1 cancelado/);
  });

  it('⛔ NEGATIVA — el periodo filtra: a 30 días la solicitud de hace 60 sale del embudo, y Kepler se vuelve a pedir con 30', () => {
    const { c, http } = montar(FINANZAS);
    c.cambiarPeriodo('30');
    http.expectOne((r) => r.url.endsWith('/anticipos/kepler-sin-solicitud') && r.params.get('dias') === '30').flush(KEPLER);
    expect(c.pasosItems()[0].value).toBe(5);
    expect(c.enPeriodo().some((s) => s.obligation_id === 'viejo')).toBe(false);
  });

  it('tocar un paso muestra sólo los que ESTÁN ahí; tocarlo otra vez lo quita', () => {
    const { c, fixture, texto } = montar(FINANZAS);
    c.alternarPaso('pagado');
    fixture.detectChanges();
    expect(c.visibles().map((s) => s.obligation_id)).toEqual(['s3']);
    expect(texto()).toMatch(/Cubierto sin anticipo en Kepler/);
    expect(texto()).toMatch(/Cubierto el/);
    c.alternarPaso('pagado');
    expect(c.filtroPaso()).toBeNull();
    expect(c.visibles().length).toBe(7);
  });

  it('⛔ NEGATIVA — un programado cuyo día no llega no está «atorado»: nunca «el más viejo de 0 días»', () => {
    const { c } = montar(FINANZAS);
    c.filas.set([sol('p1', { etapa: 'programado', programado_dia: hace(-3) }), sol('p2', { etapa: 'programado', programado_dia: hace(-1) })]);
    expect(c.veredicto()).toMatch(/2 están programados y esperan su día de pago\./);
    expect(c.veredicto()).not.toMatch(/más viejo de 0 días/);
    expect(c.pasosItems()[1].sub).not.toMatch(/el más viejo/);
  });

  it('⛔ NEGATIVA — si lo de Kepler no se pudo leer, lo dice; no pinta «0 en Kepler sin solicitud»', () => {
    const { texto } = montar(FINANZAS, { kepler: 'falla' });
    expect(texto()).toMatch(/no se pudo leer lo que Kepler tiene sin solicitud/);
    expect(texto()).not.toMatch(/0 en Kepler sin solicitud/);
  });

  it('fuera del embudo: lo que Kepler tiene sin solicitud, con su proveedor y su saldo', () => {
    const { texto } = montar(FINANZAS);
    expect(texto()).toMatch(/En Kepler sin solicitud en la Suite 1 · \$9,000/);
    expect(texto()).toMatch(/FERRERO DE PRUEBA/);
    expect(texto()).toMatch(/sin referencia en Kepler/);
  });

  it('por proveedor: agrupa con lo solicitado y lo cubierto de cada uno', () => {
    const { c, fixture, el } = montar(FINANZAS);
    c.cambiarVista('proveedor');
    fixture.detectChanges();
    expect(c.visibles()[0].proveedor_nombre).toBe('CHOCOLATES SUR');
    const grupos = [...el.querySelectorAll('.as-grupo')].map((g) => (g.textContent ?? '').replace(/\s+/g, ' '));
    expect(grupos.some((g) => /CHOCOLATES SUR .* 1 solicitado por \$3,000 · cubierto \$3,000/.test(g))).toBe(true);
  });

  it('lo que se mudó de Deuda › Anticipos: la cuenta, el motivo y la cotización a un clic', () => {
    const { c, http } = montar(FINANZAS);
    expect(c.cuentaTexto(SOLICITUDES[0])).toBe('A BBVA · CLABE terminación 7899: espera la aprobación de Dirección en Cuentas de pago.');
    expect(c.motivoDe(SOLICITUDES[5])).toBe('temporada');
    expect(c.pagoTexto(SOLICITUDES[5])).toBe('Cancelado: ya no lo pide');
    const pestana = { closed: false, location: { href: '' }, document: { write: () => undefined, close: () => undefined } };
    const open = vi.spyOn(window, 'open').mockReturnValue(pestana as unknown as Window);
    c.verCotizacion(SOLICITUDES[0]);
    expect(open).toHaveBeenCalledTimes(1);                 // la pestaña nace DENTRO del clic
    http.expectOne((r) => r.url.endsWith('/anticipos/s1/cotizacion')).flush({ url: 'https://s3.example/firmada', kind: 'pdf' });
    expect(pestana.location.href).toBe('https://s3.example/firmada');
    open.mockRestore();
  });

  it('⛔ NEGATIVA — cancelar exige razón; va al cancelar DE ANTICIPOS y vuelve a leer', () => {
    const { c, http } = montar(FINANZAS);
    c.abrirCancelar(SOLICITUDES[0]);
    expect(c.cancFalta()).toMatch(/por qué/);
    c.confirmarCancelar();                                  // sin razón no sale nada (lo verifica afterEach)
    c.cancRazon.set('el proveedor ya no lo pide');
    c.confirmarCancelar();
    const req = http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos/s1/cancelar') && r.method === 'POST');
    expect(req.request.body).toEqual({ reason: 'el proveedor ya no lo pide' });
    req.flush({});
    http.expectOne((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos')).flush(SOLICITUDES);
    http.expectOne((r) => r.url.endsWith('/anticipos/kepler-sin-solicitud')).flush(KEPLER);
    expect(c.cancelando()).toBeNull();
  });

  it('⛔ NEGATIVA [ADR-120] — quien sólo programa pagos (Finanzas) ve el embudo pero no recibe «Pedir anticipo» ni «Cancelar»', () => {
    const { el } = montar(FINANZAS);
    const botones = [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    expect(botones).not.toContain('Pedir anticipo');
    expect(botones).not.toContain('Cancelar');
  });

  it('⛔ NEGATIVA — quien sólo VE no recibe «Pedir anticipo» ni «Cancelar»', () => {
    const { el } = montar([Permission.FINANCE_PAYMENTS_VER]);
    const botones = [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    expect(botones).not.toContain('Pedir anticipo');
    expect(botones).not.toContain('Cancelar');
  });
});

describe('[PGP.144] la puerta de Compras (/compras/anticipos-solicitados)', () => {
  it('pestañas de Pago a proveedor (no las de Pagos, a las que 8 de Compras no entran)', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(),
        provideRouter([{ path: 'compras/anticipos-solicitados', component: FinanzasAnticiposSolicitadosComponent, data: { puerta: 'compras' } }])],
    });
    const harness = await RouterTestingHarness.create();
    const c = await harness.navigateByUrl('/compras/anticipos-solicitados', FinanzasAnticiposSolicitadosComponent);
    const http = TestBed.inject(HttpTestingController);
    http.match(() => true).forEach((r) => r.flush([]));
    harness.detectChanges();
    expect(c.deCompras).toBe(true);
    const el = harness.routeNativeElement as HTMLElement;
    expect(el.querySelector('app-page-tabs')).not.toBeNull();
    expect(el.querySelector('app-pagos-tabs')).toBeNull();
  });
});
