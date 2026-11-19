import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';

import { MktRankingComponent } from './mkt-ranking.component';
import { PromoVenta, VendedorVenta, VentaSemana } from '../mkt-ranking.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { environment } from '../../../../environments/environment';

/**
 * `[MKT.30]`/`[MKT.31]` La pantalla de los dos rankings (maqueta v14). Lo que se prueba: lo que ve
 * Mercadotecnia, lo que pide al servidor y lo que escribe (objetivos), con datos sintéticos.
 */
const VENTA = `${environment.apiUrl}/commercial/mkt-ranking/venta`;
const OBJ = (id: string) => `${environment.apiUrl}/commercial/mkt-ranking/promos/${id}/objetivos`;

const promo = (over: Partial<PromoVenta>): PromoVenta => ({
  promo_id: 'k-62253', code: '62253', nombre: '3 PROD LA ROSA', paquetes: 157, dinero: 27464.8, objetivo: 200, avance: 0.785,
  por_canal: [{ canal: 'mostrador', paquetes: 100, dinero: 17000 }, { canal: 'preventa', paquetes: 57, dinero: 10464.8 }],
  por_sucursal: [
    { warehouse_code: '01', nombre: 'Padre Hidalgo', zona: 'LA PIEDAD RD', paquetes: 90, dinero: 15000, objetivo: 100 },
    { warehouse_code: '02', nombre: 'Abastos', zona: 'LA PIEDAD RD', paquetes: 40, dinero: 7000, objetivo: 60 },
    { warehouse_code: '04', nombre: 'Yurécuaro', zona: 'Sin zona', paquetes: 27, dinero: 5464.8, objetivo: null },
  ],
  productos_nombres: ['PELLERZ LA ROSA'], productos_skus: ['R1'], proveedor: 'DULCES DEMO SA', productos_metodo: 'ticket_y_nombre',
  objetivo_sucursal: { fijo: null, mixto: false, automatico: 25, sucursales: ['01', '02'] },
  ...over,
});
const vendedor = (over: Partial<VendedorVenta>): VendedorVenta => ({
  clave: 'mostrador|01|P7', canal: 'mostrador', warehouse_code: '01', warehouse_name: 'Padre Hidalgo', vendedor: 'P7',
  nombre: 'VENDEDORA DEMO', detalle: 'Padre Hidalgo · le asignaron 3 tickets', fuente: 'cajera',
  paquetes: 9, tickets: 3, total: 1574.46, promos_sin_dato: 0,
  promos: [{ code: '62253', nombre: '3 PROD LA ROSA', paquetes: 9, precio: 174.94, total: 1574.46 }],
  ...over,
});
const venta = (over: Partial<VentaSemana> = {}): VentaSemana => ({
  semana: { lunes: '2026-11-09', domingo: '2026-11-15', numero: 46, hasta: '2026-11-15', en_curso: false },
  filtro: { canal: null, sucursal: null, zona: null },
  sucursales_lista: [{ code: '01', nombre: 'Padre Hidalgo', zona: 'LA PIEDAD RD' }, { code: '04', nombre: 'Yurécuaro', zona: 'Sin zona' }],
  zonas_lista: ['LA PIEDAD RD', 'Sin zona'],
  totales: { paquetes: 186, objetivo: 200, dinero: 27464.8, promos: 2, promos_sin_dato: 1 },
  sucursal_top: { warehouse_code: '01', nombre: 'Padre Hidalgo', zona: 'LA PIEDAD RD', paquetes: 90 },
  promos: [
    promo({}),
    promo({ promo_id: 'k-00126', code: '00126', nombre: 'KISSES = GRATIS 1', paquetes: 29, dinero: null, objetivo: null, avance: null,
      productos_nombres: [], productos_skus: [], proveedor: null, productos_metodo: 'sin_identificar', por_canal: [{ canal: 'mostrador', paquetes: 29, dinero: null }],
      por_sucursal: [{ warehouse_code: '01', nombre: 'Padre Hidalgo', zona: 'LA PIEDAD RD', paquetes: 29, dinero: null, objetivo: null }],
      objetivo_sucursal: { fijo: 4, mixto: false, automatico: 3, sucursales: ['01'] } }),
  ],
  codigos_barras: { R1: ['7501000000017'] },
  vendedores: [
    vendedor({ clave: 'preventa|06|06:1V001', canal: 'preventa', nombre: 'VENDEDOR VECINAL DEMO', detalle: 'Ruta 1V001 · Canindo', fuente: 'asignacion', paquetes: 30, total: 5000 }),
    vendedor({}),
  ],
  mostrador: { tickets_con_promo: 10, tickets_asignados: 4 },
  dinero_contrastado: { mostrador: true, preventa: false, ruta: false, mayoreo: false },
  criterio: 'criterio', consultado_at: '2026-11-19T06:00:00Z',
  ...over,
});

/** Lo que la pantalla y sus piezas le preguntan a los permisos (page-tabs pregunta isAdmin y hasAny). */
const permisos = (gestiona: boolean) => ({
  has: () => gestiona, hasAny: () => gestiona, hasExplicit: () => gestiona, isAdmin: () => false, isSuperadmin: () => false, cargado: () => true,
});

async function montar(d: VentaSemana, gestiona = true) {
  TestBed.configureTestingModule({
    imports: [MktRankingComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), MessageService,
      { provide: PermissionsService, useValue: permisos(gestiona) }],
  });
  const fixture = TestBed.createComponent(MktRankingComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne((req) => req.url === VENTA).flush(d);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, http, comp: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
}
const texto = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('[MKT.30] Ranking de promociones: toda la venta', () => {
  it('pide la semana GLOBAL (sin canal) y ordena por paquetes, con dinero y objetivo', async () => {
    TestBed.configureTestingModule({
      imports: [MktRankingComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), MessageService, { provide: PermissionsService, useValue: permisos(true) }],
    });
    const fixture = TestBed.createComponent(MktRankingComponent);
    fixture.detectChanges();
    const req = TestBed.inject(HttpTestingController).expectOne((r) => r.url === VENTA);
    expect(req.request.params.keys()).toEqual([]);
    req.flush(venta());
    await fixture.whenStable(); fixture.detectChanges();
    const filas = [...(fixture.nativeElement as HTMLElement).querySelectorAll('tr.vt-fila')].map(texto);
    expect(filas[0]).toContain('3 PROD LA ROSA');
    expect(filas[0]).toContain('157');
    expect(filas[0]).toContain('$27,464.80');
    expect(filas[0]).toContain('79 %');
  });

  it('[MKT.31] sin producto identificado dice «sin dato», nunca $0', async () => {
    const { el } = await montar(venta());
    const kisses = [...el.querySelectorAll('tr.vt-fila')].map(texto).find((t) => t.includes('KISSES'))!;
    expect(kisses).toContain('sin dato');
    expect(kisses).not.toContain('$0.00');
    expect(kisses).toContain('Producto sin identificar');
  });

  it('[MKT.31] declara el dinero de los canales sin contrastar; filtrando Sucursales ya no', async () => {
    const { el, comp, fixture, http } = await montar(venta());
    expect(texto(el)).toContain('Dinero de Ruta vecinal, Ruta directa, Telemarketing: todavía sin contrastar');
    comp.elegirCanal('mostrador');
    fixture.detectChanges();
    http.expectOne((r) => r.url === VENTA && r.params.get('canal') === 'mostrador').flush(venta({ filtro: { canal: 'mostrador', sucursal: null, zona: null } }));
    await fixture.whenStable(); fixture.detectChanges();
    expect(texto(el)).not.toContain('todavía sin contrastar');
  });

  it('los filtros los aplica el servidor: canal, sucursal y zona viajan como parámetros', async () => {
    const { comp, fixture, http } = await montar(venta());
    comp.elegirCanal('preventa'); comp.elegirSucursal('01'); comp.elegirZona('Sin zona');
    fixture.detectChanges();
    const req = http.expectOne((r) => r.url === VENTA && r.params.get('canal') === 'preventa');
    expect(req.request.params.get('sucursal')).toBe('01');
    expect(req.request.params.get('zona')).toBe('Sin zona');
    req.flush(venta());
  });

  it('buscar filtra filas pero NO renumera: el lugar es el de la semana', async () => {
    const { el, comp, fixture } = await montar(venta());
    comp.busqueda.set('kisses');
    fixture.detectChanges();
    const filas = [...el.querySelectorAll('tr.vt-fila')].map(texto);
    expect(filas).toHaveLength(1);
    expect(filas[0].trim().startsWith('2')).toBe(true);
  });

  it('[MKT.27] la pistola: un código de barras encuentra la promo de su producto; también el proveedor', async () => {
    const { el, comp, fixture } = await montar(venta());
    comp.busqueda.set('7501000000017');
    fixture.detectChanges();
    expect([...el.querySelectorAll('tr.vt-fila')].map(texto)).toEqual([expect.stringContaining('3 PROD LA ROSA')]);
    comp.busqueda.set('dulces demo');
    expect(comp.filasPromos().map((p) => p.code)).toEqual(['62253']);
  });

  it('[negativa] sin códigos de barras leídos, lo dice en vez de «ninguna coincide»', async () => {
    const { el, comp, fixture } = await montar(venta({ codigos_barras: null }));
    comp.busqueda.set('7501000000017');
    fixture.detectChanges();
    expect(texto(el)).toContain('No se pudieron leer los códigos de barras');
  });

  it('la promo abre DÓNDE se vendió: por canal y, por zona, suma sus sucursales', async () => {
    const { el, comp, fixture } = await montar(venta());
    comp.abrirPromo(comp.datos()!.promos[0]);
    fixture.detectChanges();
    expect(texto(el)).toContain('Dónde se vendió');
    expect(texto(el)).toContain('Ruta vecinal');
    expect(texto(el)).not.toContain('Quién la vendió');
    comp.desglose.set('zona');
    expect(comp.filasDesglose()).toEqual([
      { clave: 'LA PIEDAD RD', nombre: 'LA PIEDAD RD', zona: 'LA PIEDAD RD', paquetes: 130, objetivo: 160, dinero: 22000 },
      { clave: 'Sin zona', nombre: 'Sin zona', zona: 'Sin zona', paquetes: 27, objetivo: null, dinero: 5464.8 },
    ]);
  });
});

describe('[MKT.30] Ranking de vendedores: lo que se le cargó', () => {
  it('lista a los vendedores de todos los canales y dice lo que la cajera no asignó', async () => {
    const { el, comp, fixture } = await montar(venta());
    comp.elegirVista('vendedores');
    fixture.detectChanges();
    const filas = [...el.querySelectorAll('tr.vt-fila')].map(texto);
    expect(filas[0]).toContain('VENDEDOR VECINAL DEMO');
    expect(filas[0]).toContain('Ruta vecinal');
    expect(filas[1]).toContain('VENDEDORA DEMO');
    expect(texto(el)).toContain('6 de 10 tickets con promoción no se le cargaron a nadie');
  });

  it('el vendedor abre sus promociones con precio por paquete y total', async () => {
    const { el, comp, fixture } = await montar(venta());
    comp.elegirVista('vendedores');
    comp.abrirVendedor(comp.datos()!.vendedores[1]);
    fixture.detectChanges();
    const t = texto(el);
    expect(t).toContain('Lo que vendió');
    expect(t).toContain('$174.94');
    expect(t).toContain('$1,574.46');
    expect(t).toContain('Se lo asignó la cajera en su arqueo: 3 tickets');
  });
});

describe('[MKT.30] Objetivos: en un solo lugar', () => {
  it('guarda el mismo objetivo en cada sucursal donde se vende (mostrador) con el endpoint de siempre', async () => {
    const { comp, http, fixture } = await montar(venta());
    const rosa = comp.datos()!.promos[0];
    comp.editarObjetivo(rosa, '30');
    expect(comp.cambios().size).toBe(1);
    const p = comp.guardarObjetivos();
    const req = http.expectOne(OBJ('k-62253'));
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ items: [
      { warehouse_code: '01', canal: 'mostrador', vendor_code: '', objetivo_semanal: 30 },
      { warehouse_code: '02', canal: 'mostrador', vendor_code: '', objetivo_semanal: 30 },
    ] });
    req.flush({ guardados: 2, quitados: 0 });
    await p;
    fixture.detectChanges();
    http.expectOne((r) => r.url === VENTA).flush(venta()); // recarga
    expect(comp.cambios().size).toBe(0);
  });

  it('borrar el número = volver al automático (se manda null)', async () => {
    const { comp, http, fixture } = await montar(venta());
    const kisses = comp.datos()!.promos[1];
    expect(comp.valorObjetivo(kisses)).toBe('4');
    comp.editarObjetivo(kisses, '');
    const p = comp.guardarObjetivos();
    const req = http.expectOne(OBJ('k-00126'));
    expect(req.request.body.items[0].objetivo_semanal).toBeNull();
    req.flush({ guardados: 0, quitados: 1 });
    await p;
    fixture.detectChanges();
    http.expectOne((r) => r.url === VENTA).flush(venta()); // recarga
  });

  it('[negativa] escribir lo mismo que ya tenía no cuenta como cambio', async () => {
    const { comp } = await montar(venta());
    comp.editarObjetivo(comp.datos()!.promos[1], '4');
    expect(comp.cambios().size).toBe(0);
  });

  it('[negativa] si falla el guardado, lo escrito se queda', async () => {
    const { comp, http } = await montar(venta());
    comp.editarObjetivo(comp.datos()!.promos[0], '30');
    const p = comp.guardarObjetivos();
    http.expectOne(OBJ('k-62253')).flush({ message: 'x' }, { status: 500, statusText: 'Error' });
    await p;
    expect(comp.cambios().get('k-62253')).toBe('30');
  });

  it('[negativa] sin permiso de Mercadotecnia, los objetivos se ven pero no se cambian', async () => {
    const { el, comp, fixture } = await montar(venta(), false);
    comp.objetivosAbierto.set(true);
    fixture.detectChanges();
    await fixture.whenStable(); fixture.detectChanges();
    const inputs = [...el.querySelectorAll<HTMLInputElement>('input.vt-obj')];
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => i.disabled)).toBe(true);
    expect(texto(el)).toContain('hace falta permiso de Mercadotecnia');
  });
});
