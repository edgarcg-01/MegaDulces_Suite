import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { MessageService } from 'primeng/api';
import { sucursalPropuesta, type BandejaDeFacturasSat, type DetalleDeFacturaSat, type FacturaPorRegistrar } from '@megadulces/contracts';
import { FacturasSatBandejaComponent, esDelProveedor, type ProveedorDeLaBandeja } from './facturas-sat-bandeja.component';

/**
 * `[PGP.122]` S.13 + S.17 — Candado de **las facturas del SAT sin gasto dentro del paso «Proveedor»** (anexo S §14 y
 * §15). Lo que cuida: sin proveedor, ofrece a los proveedores con facturas (el más antiguo primero) y elegir uno lo
 * entrega al formulario (DS28); con proveedor, sólo SUS facturas, y «Usar esta factura» las entrega sólo cuando
 * «Mandar a firma» la aceptaría y nunca mientras se manda otra; que vacío y error no se confundan; que «No es de esta
 * sucursal» y «Sacar para todas» manden lo que el servidor espera; y que el detalle de una factura no se pinte en el
 * panel de otra. Datos sintéticos (repo público).
 */
const ACREEDOR = { clave: 'GZS13A', nombre: 'GASOLINERA DE PRUEBA', via: 'tal_cual' as const, en_la_sucursal: true, registrable: true, por_que_no: null };
const RECIBO = { clave: 'GRE01', nombre: 'RECIBO DE PRUEBA', via: 'tal_cual' as const, en_la_sucursal: true, registrable: true, por_que_no: null };
const GASOLINERA: ProveedorDeLaBandeja = { clave: 'GZS13A', nombre: 'GASOLINERA DE PRUEBA', rfc: 'QZA991231AA1' };
const F = (over: Partial<FacturaPorRegistrar> = {}): FacturaPorRegistrar => ({
  uuid: '5a5a0001-0000-4000-8000-000000000001', emisor_rfc: 'QZA991231AA1', emisor_nombre: 'GASOLINERA DE PRUEBA SA DE CV', serie_folio: 'A-501',
  fecha: '2026-11-05', dias: 10, total: 500, subtotal: 431.03, descuento: 0, iva: 68.97, metodo_pago: 'PUE', forma_pago: '04',
  acreedores: [ACREEDOR], sucursal: sucursalPropuesta(new Map([['06', 5]])), contabilizada: false, motivo: 'En Kepler no hay una X-A-15…', avisos: [], ...over,
});
const B = (over: Partial<BandejaDeFacturasSat> = {}): BandejaDeFacturasSat => ({
  sucursal: '06', desde: '2026-10-01', ultima_llegada: '2026-11-15T05:52:00.000Z', horas_sin_llegadas: 3,
  por_registrar: [F(), F({ uuid: '5a5a0002-0000-4000-8000-000000000002', serie_folio: 'A-502', total: 250, fecha: '2026-11-07' }),
    F({ uuid: '5a5a0003-0000-4000-8000-000000000003', emisor_rfc: 'QZC991231CC3', emisor_nombre: 'RECIBO DE PRUEBA', serie_folio: '7001', total: 1240, fecha: '2026-11-09', acreedores: [RECIBO] })],
  registradas: [], descartadas: [], sin_sucursal_clara: 0, declarado: ['Una solicitud que junta varias facturas no se reconoce todavía.'],
  ...over,
});
const D = (uuid: string, over: Partial<DetalleDeFacturaSat> = {}): DetalleDeFacturaSat => ({
  uuid, por_registrar: F({ uuid }), registrada: null, descartada: null, conceptos: [], tiene_xml: false, ...over,
});

describe('[PGP.122] S.13 + S.17 FacturasSatBandejaComponent', () => {
  let fix: ComponentFixture<FacturasSatBandejaComponent>;
  let c: FacturasSatBandejaComponent;
  let http: HttpTestingController;

  beforeAll(() => registerLocaleData(localeEsMx));
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FacturasSatBandejaComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), MessageService, { provide: LOCALE_ID, useValue: 'es-MX' }],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const montar = (sucursal = '06', acreedor: ProveedorDeLaBandeja | null = null) => {
    fix = TestBed.createComponent(FacturasSatBandejaComponent);
    c = fix.componentInstance;
    fix.componentRef.setInput('sucursal', sucursal);
    fix.componentRef.setInput('acreedor', acreedor);
    fix.detectChanges();
  };
  const bandeja = () => http.expectOne((r) => r.url.endsWith('/finance/expenses/solicitudes/facturas-sat'));
  const txt = () => fix.nativeElement.textContent as string;
  const botones = (texto: string) => (Array.from(fix.nativeElement.querySelectorAll('button')) as HTMLButtonElement[]).filter((b) => b.textContent?.includes(texto));

  // ── Sin proveedor: a quién le llegó una factura que nadie ha registrado (DS28) ──

  it('sin proveedor: pide la bandeja de SU base y ofrece a los proveedores con facturas sin gasto, el más antiguo primero', () => {
    montar('06');
    const req = bandeja();
    expect(req.request.params.get('sucursal')).toBe('06');
    req.flush(B());
    fix.detectChanges();
    expect(c.emisores().map((e) => [e.nombre, e.n])).toEqual([['GASOLINERA DE PRUEBA', 2], ['RECIBO DE PRUEBA', 1]]);
    // El nombre es el de Kepler (el que aparece en «Proveedor»), no la razón social del SAT.
    expect(botones('GASOLINERA DE PRUEBA').length).toBe(1);
    expect(txt()).toContain('Con facturas del SAT sin gasto');
    expect(txt()).toContain('3 · $1,990.00');
    // Sin proveedor no se listan facturas sueltas.
    expect(fix.nativeElement.querySelectorAll('li.fs-f').length).toBe(0);
  });

  it('DS28 · elegir a un proveedor desde sus facturas lo entrega al formulario (con su clave y su RFC); bloqueado, no', () => {
    montar();
    bandeja().flush(B());
    fix.detectChanges();
    const elegidos: ProveedorDeLaBandeja[] = [];
    c.elegirProveedor.subscribe((p) => elegidos.push(p));
    botones('GASOLINERA DE PRUEBA')[0].click();
    expect(elegidos).toEqual([GASOLINERA]);
    fix.componentRef.setInput('bloqueado', true);
    fix.detectChanges();
    c.elegirEmisor(c.emisores()[1]);
    expect(elegidos.length).toBe(1);
  });

  it('con más de 6 proveedores se ven 6 y «Ver los N»; el aviso de los que no están en el catálogo va aparte', () => {
    const muchos = Array.from({ length: 8 }, (_, i) => F({
      uuid: `5a5a00${10 + i}-0000-4000-8000-0000000000${10 + i}`, emisor_rfc: `QZE99123${i}EE${i}`, emisor_nombre: `EMISOR ${i}`,
      fecha: `2026-11-0${i + 1}`, acreedores: [{ ...ACREEDOR, clave: `GE0${i}`, nombre: `PROVEEDOR ${i}` }],
    }));
    montar();
    bandeja().flush(B({ por_registrar: muchos }));
    fix.detectChanges();
    expect(c.emisoresVisibles().map((e) => e.nombre)).toEqual(['PROVEEDOR 0', 'PROVEEDOR 1', 'PROVEEDOR 2', 'PROVEEDOR 3', 'PROVEEDOR 4', 'PROVEEDOR 5']);
    botones('Ver los 8')[0].click();
    fix.detectChanges();
    expect(c.emisoresVisibles().length).toBe(8);
  });

  it('⛔ un proveedor sin acreedor en esta base no se ofrece, y se dice por qué', () => {
    montar();
    bandeja().flush(B({ por_registrar: [F({ acreedores: [{ ...ACREEDOR, via: 'parecido', en_la_sucursal: false }] })] }));
    fix.detectChanges();
    expect(botones('GASOLINERA').length).toBe(0);
    expect(txt()).toContain('no está en el catálogo de Kepler de esta base');
  });

  it('vacía no es error: lo dice, y conserva las registradas (con su documento) plegadas', () => {
    montar();
    bandeja().flush(B({ por_registrar: [], registradas: [{ uuid: 'r1', emisor_nombre: 'X', serie_folio: 'B-1', fecha: '2026-11-02', total: 9,
      registro: { senal: 'referencia_otro', documento: { sucursal: '06', tipo: 'X-A-15', folio: '0000100', fecha: '2026-11-03', total: 9 }, vale: null, acreedor: 'GEMPL99', gasto: '06|0000100', dias: 1 } }] }));
    fix.detectChanges();
    expect(txt()).toContain('Sin facturas del SAT por registrar en esta base');
    expect(txt()).toContain('Ya registradas: 1');
    expect(txt()).toContain('X-A-15 0000100');
    expect(txt()).toContain('a nombre de GEMPL99');
  });

  it('⛔ un error de red se DICE (no se ve como «sin facturas»)', () => {
    montar();
    bandeja().flush({ message: 'se cayó' }, { status: 500, statusText: 'Error' });
    fix.detectChanges();
    expect(c.error()).toBe('se cayó');
    expect(txt()).not.toContain('Sin facturas del SAT');
  });

  it('quien no ve las facturas de esta base (403 del servidor) no ve el bloque, y tampoco un error', () => {
    montar();
    bandeja().flush({ message: 'No tienes acceso a la sucursal 06' }, { status: 403, statusText: 'Forbidden' });
    fix.detectChanges();
    expect(c.sinAcceso()).toBe(true);
    expect(c.error()).toBeNull();
    expect(fix.nativeElement.querySelector('section.fs')).toBeNull();
  });

  // ── Con proveedor: SUS facturas sin gasto ──

  it('con proveedor: sólo SUS facturas, la más antigua primero, con «Usar esta factura»', () => {
    montar('06', GASOLINERA);
    bandeja().flush(B());
    fix.detectChanges();
    expect(c.delProveedor().map((f) => f.serie_folio)).toEqual(['A-501', 'A-502']);
    expect(txt()).toContain('Facturas de GASOLINERA DE PRUEBA en el SAT sin gasto');
    expect(txt()).not.toContain('7001');
    expect(botones('Usar esta factura').length).toBe(2);
  });

  it('el proveedor se reconoce por su clave de Kepler o, si no casa, por su RFC (sin guiones ni espacios)', () => {
    expect(esDelProveedor(F(), { clave: 'GZS13A', nombre: 'X', rfc: null })).toBe(true);
    expect(esDelProveedor(F({ acreedores: [] }), { clave: 'OTRA', nombre: 'X', rfc: 'QZA-991231-AA1' })).toBe(true);
    expect(esDelProveedor(F({ acreedores: [] }), { clave: 'OTRA', nombre: 'X', rfc: null })).toBe(false);
    expect(esDelProveedor(F(), { clave: 'GRE01', nombre: 'X', rfc: 'QZC991231CC3' })).toBe(false);
  });

  it('«Usar esta factura» entrega la factura al formulario; mientras se manda otra, no', () => {
    montar('06', GASOLINERA);
    bandeja().flush(B());
    fix.detectChanges();
    const emitidas: FacturaPorRegistrar[] = [];
    c.registrar.subscribe((f) => emitidas.push(f));
    botones('Usar esta factura')[0].click();
    expect(emitidas.map((f) => f.serie_folio)).toEqual(['A-501']);
    fix.componentRef.setInput('bloqueado', true);
    fix.detectChanges();
    c.registrarFactura(c.delProveedor()[1]);
    expect(emitidas.length).toBe(1);
  });

  it('la factura que ya usa la solicitud dice «En esta solicitud» y no se ofrece otra vez', () => {
    montar('06', GASOLINERA);
    bandeja().flush(B());
    fix.componentRef.setInput('enUso', '5a5a0001-0000-4000-8000-000000000001');
    fix.detectChanges();
    expect(txt()).toContain('En esta solicitud');
    expect(botones('Usar esta factura').length).toBe(1);
  });

  it('sin facturas del proveedor lo dice, con lo que sigue (su ticket, su nota o su cotización)', () => {
    montar('06', { clave: 'GSIN1', nombre: 'PROVEEDOR SIN FACTURAS', rfc: 'QZS991231SS1' });
    bandeja().flush(B());
    fix.detectChanges();
    expect(txt()).toContain('Sin facturas de PROVEEDOR SIN FACTURAS en el SAT por registrar en esta base');
    expect(botones('Usar esta factura').length).toBe(0);
  });

  it('⛔ con el RFC de Kepler de otra razón social no se ofrece usarla (fallaría al mandar a firma), y dice qué corregir', () => {
    montar('06', GASOLINERA);
    bandeja().flush(B({ por_registrar: [F({ acreedores: [{ ...ACREEDOR, via: 'por_nombre', registrable: false, por_que_no: 'Kepler tiene para GZS13A el RFC QZF991231ZZ9…' }] })] }));
    fix.detectChanges();
    expect(botones('Usar esta factura').length).toBe(0);
    expect(txt()).toContain('Kepler tiene para GZS13A el RFC QZF991231ZZ9');
  });

  it('la sucursal se nombra («06 Canindo»), no sólo su clave', () => {
    montar();
    bandeja().flush(B());
    const f = { ...F(), sucursal: sucursalPropuesta(new Map([['06', 2], ['08', 2]])) };
    expect(c.nombreSucursal('06')).toBe('06 Canindo');
    expect(c.otrasQueLaVen(f)).toBe('08 Morelia Abastos, 00 CEDIS');
    expect(c.sucursalTexto(f)).toBe('Su historia empata entre dos sucursales: elige la sucursal. En su historia: 06 Canindo y 08 Morelia Abastos.');
    expect(c.sucursalTexto(F())).toContain('06 Canindo: 5 documentos');
  });

  it('al cerrar el panel, el foco vuelve a la factura que lo abrió (no se pierde el lugar en la lista)', async () => {
    montar('06', GASOLINERA);
    bandeja().flush(B());
    fix.detectChanges();
    const fila = fix.nativeElement.querySelector('.fs-f-ver') as HTMLButtonElement;
    fila.focus();
    fila.click();
    http.expectOne((r) => r.url.includes('/facturas-sat/5a5a0001')).flush(D('5a5a0001-0000-4000-8000-000000000001'));
    fix.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).not.toBe(fila); // el panel se lleva el foco al abrir
    c.cambioPeek(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(fila);
  });

  it('⛔ si la factura se sacó, el foco va al título del bloque (su fila ya no existe)', async () => {
    montar('06', GASOLINERA);
    bandeja().flush(B());
    fix.detectChanges();
    (fix.nativeElement.querySelector('.fs-f-ver') as HTMLButtonElement).focus();
    c.abrirDescarte(c.delProveedor()[0]);
    c.descartar('sucursal');
    http.expectOne((r) => r.url.includes('/descartar')).flush({});
    bandeja().flush(B({ por_registrar: [] }));
    fix.detectChanges();
    c.devolverFoco(); // lo llama el (onHide) del diálogo
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement?.id).toBe('fs-t');
  });

  it('«Sacar para todas»: sin motivo no se manda; con motivo manda sucursal, alcance y motivo, y vuelve a leer la bandeja', () => {
    montar('06', GASOLINERA);
    bandeja().flush(B());
    fix.detectChanges();
    c.abrirDescarte(c.delProveedor()[0]);
    c.motivo.set('  ');
    c.descartar('todas');
    http.expectNone((r) => r.url.includes('/descartar'));
    c.motivo.set('No es un gasto de la empresa');
    c.descartar('todas');
    const req = http.expectOne((r) => r.url.endsWith('/facturas-sat/5a5a0001-0000-4000-8000-000000000001/descartar'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ sucursal: '06', alcance: 'todas', motivo: 'No es un gasto de la empresa' });
    req.flush({});
    bandeja().flush(B({ por_registrar: [] }));
    expect(c.dialogo()).toBe(false);
  });

  it('«No es de esta sucursal» no pide motivo y manda el alcance de sucursal', () => {
    montar('08', GASOLINERA);
    bandeja().flush(B({ sucursal: '08' }));
    c.abrirDescarte(c.delProveedor()[0]);
    c.descartar('sucursal');
    const req = http.expectOne((r) => r.url.includes('/descartar'));
    expect(req.request.body).toEqual({ sucursal: '08', alcance: 'sucursal', motivo: '' });
    req.flush({});
    bandeja().flush(B({ sucursal: '08', por_registrar: [] }));
  });

  it('⛔ mientras se manda el descarte el diálogo no se cierra (y si falla, se puede volver a intentar)', () => {
    montar('06', GASOLINERA);
    bandeja().flush(B());
    c.abrirDescarte(c.delProveedor()[0]);
    c.motivo.set('No es un gasto de la empresa');
    c.descartar('todas');
    c.cerrarDescarte();
    expect(c.dialogo()).toBe(true);
    http.expectOne((r) => r.url.includes('/descartar')).flush({ message: 'sin red' }, { status: 0, statusText: 'Error' });
    expect(c.dialogo()).toBe(true);
    expect(c.descartandoEnvio()).toBe(false);
    c.cerrarDescarte();
    expect(c.dialogo()).toBe(false);
  });

  it('⛔ el detalle de una factura que llega TARDE no se pinta en el panel de otra', () => {
    montar();
    bandeja().flush(B());
    c.ver('5a5a0001-0000-4000-8000-000000000001');
    c.ver('5a5a0002-0000-4000-8000-000000000002');
    const [a, b] = http.match((r) => r.url.includes('/facturas-sat/5a5a'));
    b.flush(D('5a5a0002-0000-4000-8000-000000000002'));
    a.flush(D('5a5a0001-0000-4000-8000-000000000001'));
    expect(c.detalle()?.uuid).toBe('5a5a0002-0000-4000-8000-000000000002');
  });

  it('cuando se manda una solicitud (refrescar sube), la bandeja se vuelve a leer', () => {
    montar();
    bandeja().flush(B());
    fix.componentRef.setInput('refrescar', 1);
    fix.detectChanges();
    bandeja().flush(B({ por_registrar: [] }));
    expect(c.bandeja()?.por_registrar.length).toBe(0);
  });
});
