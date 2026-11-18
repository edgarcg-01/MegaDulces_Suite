import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { AnticipoSolicitadoRow } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ComprasOcAbiertasComponent } from './compras-oc-abiertas.component';
import { PedirAnticipoDialogComponent } from '../../finanzas/components/pedir-anticipo-dialog.component';

/**
 * `[PGP.143]` Francisco (2026-11-17): *«falta que se conecte con una orden de compra del departamento de
 * compras»* → la OC de Kepler, en *Compras › OC abiertas*, dice sus anticipos y desde su detalle se pide uno
 * con el proveedor y esa orden ya elegidos. Monta la pantalla entera (compila la plantilla).
 *
 * Vectores SINTÉTICOS (el repo es público).
 */
const fila = (folio: string, estatus = 'N', codigo: string | null = 'CA001') => ({
  almacen: '03', folio, fecha_oc: '2026-11-10', proveedor: 'DULCES DEL NORTE', proveedor_codigo: codigo, estatus,
  dias: 7, lineas: 2, valor: 10000, prob: 80, seguimiento: null, estado_cadena: null, pendiente_en_erp: true, requisicion: null,
});
const RESP = (rows: unknown[]) => ({ rows, total: rows.length, mostradas: rows.length, truncado: false, total_minimo: false, total_valor: 0, valor_esperado: 0,
  seguimiento_habilitado: true, curva: [], por_clase: {}, por_seguimiento: {} });
const ant = (id: string, monto: number, ocs: Array<{ sucursal: string; folio: string }>, etapa: AnticipoSolicitadoRow['etapa'] = 'por_programar') => ({
  obligation_id: id, proveedor: 'CA001', proveedor_nombre: 'DULCES DEL NORTE', sucursal: '03', monto, motivo: 'temporada', oc_folio: null,
  creado_por: 'compras1', creado: '2026-11-12', fecha_deseada: '2026-11-20', estado_obligacion: 'pending', pagado: 0, programado_dia: null,
  allocation_id: null, kepler: null, posibles: 0, etapa, supplier_id: 's1', disponible: monto,
  ocs: ocs.map((o) => ({ ...o, serie: '1' })), tiene_cotizacion: true, cuenta: { estado: 'efectivo', clabe: null, banco: null },
}) as AnticipoSolicitadoRow;
const DETALLE = (folio: string) => ({
  orden: { sucursal: '03', folio, fecha: '2026-11-10', vence: null, dias: 7, proveedor: 'DULCES DEL NORTE', proveedor_rfc: null, condicion_pago: null,
    concepto: null, referencia: null, estatus_kepler: 'N', monto: 10000 },
  recibido: 0, lineas: [], recepciones: [], recepciones_descartadas: { n: 0, monto: 0 }, historia: [],
});

function montar(llaves: string[], anticipos: AnticipoSolicitadoRow[] | 'falla' | null, rows: unknown[]) {
  TestBed.configureTestingModule({
    imports: [ComprasOcAbiertasComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: {
        isAdmin: () => false, isSuperadmin: () => false,
        has: (k: string) => llaves.includes(k), hasExplicit: (k: string) => llaves.includes(k),
        hasAny: (...ks: string[]) => ks.some((k) => llaves.includes(k)),
      } }],
  });
  const fixture = TestBed.createComponent(ComprasOcAbiertasComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  const pedidasAnt = http.match((r) => r.url.endsWith('/commercial/supplier-obligations/anticipos'));
  if (anticipos === 'falla') pedidasAnt.forEach((r) => r.flush({ message: 'x' }, { status: 500, statusText: 'Error' }));
  else if (anticipos) pedidasAnt.forEach((r) => r.flush(anticipos));
  http.match((r) => /open-purchase-orders(\?|$)/.test(r.url)).forEach((r) => r.flush(RESP(rows)));
  http.match(() => true);   // filtros, sucursales: no son de esta prueba
  fixture.detectChanges();
  const c = fixture.componentInstance;
  const el = fixture.nativeElement as HTMLElement;
  const abrir = (folio: string) => {
    c.abrirDetalle(c.filas().find((f) => f.folio === folio)!);
    http.match((r) => r.url.includes(`open-purchase-orders/03/${folio}`)).forEach((r) => r.flush(DETALLE(folio)));
    http.match(() => true);
    fixture.detectChanges();
  };
  const dialogo = () => fixture.debugElement.query((d) => d.componentInstance instanceof PedirAnticipoDialogComponent).componentInstance as PedirAnticipoDialogComponent;
  return { fixture, c, el, http, abrir, dialogo, pedidasAnt: pedidasAnt.length };
}
const COMPRAS = [Permission.COMPRAS_PEDIDO_VER, Permission.COMPRAS_OBLIGACIONES_VER, Permission.COMPRAS_OBLIGACIONES_GESTIONAR];
const texto = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('[PGP.143] OC abiertas: la orden de Compras y sus anticipos', () => {
  it('la fila con anticipo lo dice bajo su total; la que no tiene, no dice nada', () => {
    const { c, el } = montar(COMPRAS, [ant('a1', 4000, [{ sucursal: '03', folio: '0000101' }]), ant('a2', 999, [{ sucursal: '03', folio: '0000101' }], 'cancelado')],
      [fila('0000101'), fila('0000102')]);
    expect(c.anticipoPorOc().get('03|0000101')).toBe(4000);      // el cancelado no cuenta
    expect(c.anticipoPorOc().has('03|0000102')).toBe(false);
    expect(el.querySelectorAll('.oa-ant')).toHaveLength(1);
    expect(texto(el)).toMatch(/anticipo \$4,000/);
  });

  it('el detalle lista sus anticipos (etapa, quién, importe) y ofrece «Pedir anticipo»', () => {
    const { el, abrir } = montar(COMPRAS, [ant('a1', 4000, [{ sucursal: '03', folio: '0000101' }, { sucursal: '03', folio: '0000102' }], 'pagado')], [fila('0000101')]);
    abrir('0000101');
    const t = texto(document.body);
    expect(t).toMatch(/Anticipos \(1\)/);
    expect(t).toMatch(/Cubierto/);           // [PGP.144] «Pagado» ahora se dice «Cubierto»
    expect(t).toMatch(/pidió compras1/);
    expect(t).toMatch(/junto con la OC 0000102/);
    expect([...document.body.querySelectorAll('button')].some((b) => /Pedir anticipo/.test(b.textContent ?? ''))).toBe(true);
    expect(el).toBeTruthy();
  });

  it('«Pedir anticipo» abre el MISMO formulario con el proveedor (por su código exacto) y esa orden', () => {
    const { c, http, abrir, dialogo } = montar(COMPRAS, [], [fila('0000101', 'R', 'CA001')]);
    abrir('0000101');
    c.pedirAnticipo(c.filas()[0], dialogo());
    const d = dialogo();
    expect(d.visible()).toBe(true);
    expect(d.deOc()).toEqual({ sucursal: '03', folio: '0000101' });
    const busca = http.expectOne((r) => r.url.endsWith('/anticipo/proveedores'));
    expect(busca.request.params.get('search')).toBe('CA001');
    // Un código PARECIDO no se toma: sólo el exacto.
    busca.flush([{ id: 's9', code: 'CA0011', name: 'OTRO' }, { id: 's1', code: 'CA001', name: 'DULCES DEL NORTE' }]);
    expect(d.prov()?.id).toBe('s1');
    http.expectOne((r) => r.url.endsWith('/anticipo/ocs')).flush([
      { sucursal: '03', serie: '1', folio: '0000099', fecha: '2026-11-01', estado: 'N', total: 5000, pedidos: [] },
      { sucursal: '03', serie: '1', folio: '0000101', fecha: '2026-11-10', estado: 'R', total: 10000, pedidos: [] },
    ]);
    http.expectOne((r) => r.url.includes('/by-supplier/s1')).flush([]);
    expect(d.ocsElegidas().map((o) => o.folio)).toEqual(['0000101']);   // ésa, no «la única» ni ninguna
    expect(d.ocAviso()).toBeNull();
  });

  it('⛔ NEGATIVA — si esa orden no acepta anticipo (no está entre las pendientes), el formulario lo DICE y no marca otra', () => {
    const { c, http, abrir, dialogo } = montar(COMPRAS, [], [fila('0000101')]);
    abrir('0000101');
    c.pedirAnticipo(c.filas()[0], dialogo());
    http.expectOne((r) => r.url.endsWith('/anticipo/proveedores')).flush([{ id: 's1', code: 'CA001', name: 'DULCES DEL NORTE' }]);
    http.expectOne((r) => r.url.endsWith('/anticipo/ocs')).flush([{ sucursal: '03', serie: '1', folio: '0000099', fecha: '2026-11-01', estado: 'N', total: 5000, pedidos: [] }]);
    http.expectOne((r) => r.url.includes('/by-supplier/s1')).flush([]);
    expect(dialogo().ocsElegidas()).toEqual([]);                            // ni siquiera la única que hay
    expect(dialogo().ocAviso()).toMatch(/La OC 0000101 no está entre las que aceptan anticipo/);
  });

  it('⛔ NEGATIVA — un proveedor que no es de mercancía activo no se elige a ciegas: se dice', () => {
    const { c, http, abrir, dialogo } = montar(COMPRAS, [], [fila('0000101', 'N', 'GL003')]);
    abrir('0000101');
    c.pedirAnticipo(c.filas()[0], dialogo());
    http.expectOne((r) => r.url.endsWith('/anticipo/proveedores')).flush([]);
    expect(dialogo().prov()).toBeNull();
    expect(dialogo().provAviso()).toMatch(/GL003\) no recibe anticipo/);
    http.expectNone((r) => r.url.endsWith('/anticipo/ocs'));
  });

  it('⛔ NEGATIVA — una orden ya finalizada en Kepler no ofrece el botón: dice por qué', () => {
    const { abrir } = montar(COMPRAS, [], [fila('0000101', 'F')]);
    abrir('0000101');
    expect([...document.body.querySelectorAll('button')].some((b) => /Pedir anticipo/.test(b.textContent ?? ''))).toBe(false);
    expect(texto(document.body)).toMatch(/Sólo se pide anticipo sobre una orden pendiente o recibida en parte/);
  });

  it('⛔ NEGATIVA — quien ve pero no pide (encargado de tienda) ve los anticipos, sin botón', () => {
    const { abrir } = montar([Permission.COMPRAS_PEDIDO_VER, Permission.COMPRAS_OBLIGACIONES_VER], [ant('a1', 4000, [{ sucursal: '03', folio: '0000101' }])], [fila('0000101')]);
    abrir('0000101');
    expect(texto(document.body)).toMatch(/Anticipos \(1\)/);
    expect([...document.body.querySelectorAll('button')].some((b) => /Pedir anticipo/.test(b.textContent ?? ''))).toBe(false);
  });

  it('⛔ NEGATIVA — sin permiso de ver anticipos no se piden ni se muestran', () => {
    const { pedidasAnt, abrir } = montar([Permission.COMPRAS_PEDIDO_VER], null, [fila('0000101')]);
    expect(pedidasAnt).toBe(0);
    abrir('0000101');
    expect(texto(document.body)).not.toMatch(/Anticipos \(/);
  });

  it('⛔ NEGATIVA — si los anticipos no se pudieron leer, el detalle lo dice; la fila no inventa «sin anticipo»', () => {
    const { c, el, abrir } = montar(COMPRAS, 'falla', [fila('0000101')]);
    expect(c.anticiposError()).toBe(true);
    expect(el.querySelectorAll('.oa-ant')).toHaveLength(0);
    abrir('0000101');
    expect(texto(document.body)).toMatch(/No se pudieron leer los anticipos: no se sabe si esta orden tiene/);
    expect(texto(document.body)).not.toMatch(/no tiene anticipos pedidos/);
  });
});
