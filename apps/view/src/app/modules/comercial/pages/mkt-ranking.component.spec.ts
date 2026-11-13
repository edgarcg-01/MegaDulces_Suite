import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';

import { MktRankingComponent } from './mkt-ranking.component';
import { ParticipanteRanking, RankingSemana } from '../mkt-ranking.service';
import { environment } from '../../../../environments/environment';

const BASE = `${environment.apiUrl}/commercial/mkt-ranking`;
const PROV = '11111111-2222-4333-8444-555555555555';

const p = (over: Partial<ParticipanteRanking>): ParticipanteRanking => ({
  clave: '01|', warehouse_code: '01', warehouse_name: 'Padre Hidalgo', vendor_code: '', nombre: 'Padre Hidalgo',
  lugar: 1, puntaje: 0.9, con_objetivo: 3, sin_objetivo: 0, cumplidas: 2, sin_venta: 0,
  promos: [{ promo_id: 'a', code: 'DM001', mecanica: '3 leches = gratis 1', objetivo: 10, objetivo_fuente: 'dinamico', venta: 9, cubrimiento: 0.9, existencia: 4, descripcion_distinta: true,
    productos: [{ sku: 'DM201', nombre: 'LECHE ENTERA LT /12', unidades: 24, cajas: 2 }], productos_metodo: 'ticket_y_nombre', productos_nota: '' }],
  ...over,
});

const ranking = (over: Partial<RankingSemana> = {}): RankingSemana => ({
  semana: { lunes: '2026-11-02', domingo: '2026-11-08', numero: 45, hasta: '2026-11-08', en_curso: false },
  canal: 'mostrador', canal_texto: 'Sucursales (mostrador)', promos_vigentes: 3, promedio_general: 0.6,
  participantes: [
    p({}),
    p({ clave: '04|', warehouse_code: '04', warehouse_name: 'Yurécuaro', nombre: 'Yurécuaro', lugar: null, puntaje: null, con_objetivo: 0, sin_objetivo: 3, cumplidas: 0,
      promos: [{ ...p({}).promos[0], objetivo: null, objetivo_fuente: null, cubrimiento: null }] }),
  ],
  promos_lista: [{ id: 'a', code: 'DM001', mecanica: '3 leches = gratis 1', proveedor_id: PROV }], promo_filtrada: null,
  proveedores_lista: [{ id: PROV, code: 'CD015', name: 'DULCES DEMO SA', promos: 1 }], proveedor_filtrado: null,
  promos_ranking: [{ promo_id: 'a', code: 'DM001', nombre: '3 leches = gratis 1', proveedor: { id: PROV, code: 'CD015', name: 'DULCES DEMO SA' }, proveedor_fuente: 'asignado',
    productos: ['LECHE ENTERA LT /12'], productos_metodo: 'ticket_y_nombre',
    participantes: 2, venta_total: 18, objetivo_total: 10, lugar: 1, puntaje: 0.9, con_objetivo: 1, sin_objetivo: 1, cumplidas: 0, sin_venta: 0 }],
  vendedoras: {
    tickets_con_promo: 10, tickets_con_vendedora: 4,
    personas: [{ lugar: 1, warehouse_code: '01', warehouse_name: 'Padre Hidalgo', person_code: '901', nombre: 'VENDEDORA DEMO A', tickets: 3, aplicaciones: 7,
      promos: [{ code: 'DM001', mecanica: '3 leches = gratis 1', cantidad: 7 }] },
      { lugar: 2, warehouse_code: '04', warehouse_name: 'Yurécuaro', person_code: '902', nombre: 'VENDEDORA DEMO B', tickets: 1, aplicaciones: 2,
      promos: [{ code: 'DM001', mecanica: '3 leches = gratis 1', cantidad: 2 }] }],
    por_sucursal: [{ warehouse_code: '01', tickets_con_promo: 6, tickets_con_vendedora: 4 }, { warehouse_code: '04', tickets_con_promo: 4, tickets_con_vendedora: 0 }],
  },
  criterio: 'Cubrimiento con tope', consultado_at: '2026-11-11T18:00:00Z',
  ...over,
});

async function montar(r: RankingSemana) {
  TestBed.configureTestingModule({
    imports: [MktRankingComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), MessageService],
  });
  const fixture = TestBed.createComponent(MktRankingComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne((req) => req.url === BASE && req.params.get('canal') === 'mostrador').flush(r);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, http, comp: fixture.componentInstance };
}

describe('[MKT.11] MktRankingComponent', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('monta y pinta el ranking en el orden del servidor, con la semana en palabras', async () => {
    const { fixture } = await montar(ranking());
    await fixture.whenStable();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(texto).toContain('Ranking de promociones');
    expect(texto).toContain('Semana 45 · 2 al 8 nov');
    expect(texto.indexOf('Padre Hidalgo')).toBeLessThan(texto.indexOf('Yurécuaro'));
  });

  it('⭐ NEGATIVA: quien no tiene objetivos NO sale con 0 %: se dice que no se puede medir', async () => {
    const { fixture } = await montar(ranking());
    await fixture.whenStable();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(texto).toContain('Sin objetivos: no se puede medir');
    expect(texto).not.toMatch(/Yurécuaro[^]*?\b0 %/);
  });

  it('el promedio general va a la franja en 0–100 (no la fracción)', async () => {
    const { comp } = await montar(ranking());
    const prom = comp.kpis().find((k) => k.label === 'Promedio general')!;
    expect(prom.value).toBe(60);
    expect(prom.format).toBe('percent');
  });

  it('sin ningún objetivo, el promedio general se DECLARA no medido', async () => {
    const { comp } = await montar(ranking({ promedio_general: null }));
    const prom = comp.kpis().find((k) => k.label === 'Promedio general')!;
    expect(prom.state).toBe('no_medido');
    expect(prom.value).toBe('Sin medir');
  });

  it('la búsqueda filtra por nombre sin acentos; abrir una fila muestra su detalle con el aviso del código', async () => {
    const { comp } = await montar(ranking());
    comp.busqueda.set('yurecuaro');
    expect(comp.filas().map((x) => x.nombre)).toEqual(['Yurécuaro']);
    comp.abrir(ranking().participantes[0]);
    expect(comp.subtitulo()).toContain('Lugar 1 de 1');
  });

  it('cambiar de canal pide ese canal y cierra el detalle abierto', async () => {
    const { comp, http } = await montar(ranking());
    comp.abrir(ranking().participantes[0]);
    comp.elegirCanal('ruta');
    TestBed.tick();
    http.expectOne((req) => req.url === BASE && req.params.get('canal') === 'ruta').flush(ranking({ canal: 'ruta', participantes: [] }));
    expect(comp.abierto()).toBeNull();
  });

  it('[MKT.16] estado «cumplidas»: Padre Hidalgo (90 %) sale; «no cumplidas» lo deja con su renglón', async () => {
    const { comp } = await montar(ranking());
    comp.elegirEstado('cumplida');
    expect(comp.filas().map((x) => x.nombre)).toEqual([]);
    comp.elegirEstado('no_cumplida');
    expect(comp.filas().map((x) => x.nombre)).toEqual(['Padre Hidalgo']);
    expect(comp.promosVisibles(comp.filas()[0]).map((x) => x.code)).toEqual(['DM001']);
  });

  it('[MKT.16] sucursal: filtra filas aquí y la pide al servidor (el ranking de promos se recalcula allá)', async () => {
    const { comp, http, fixture } = await montar(ranking());
    comp.elegirSucursales(['04']);
    fixture.detectChanges();
    const req = http.expectOne((q) => q.url === BASE && q.params.get('sucursales') === '04');
    req.flush(ranking());
    await fixture.whenStable();
    expect(comp.filas().map((x) => x.nombre)).toEqual(['Yurécuaro']);
  });

  it('[MKT.16] promoción: el servidor recalcula el lugar sólo con ella; quitar filtros la suelta', async () => {
    const { comp, http, fixture } = await montar(ranking());
    comp.elegirPromo('a');
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('promo') === 'a').flush(ranking({ promo_filtrada: 'a' }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('El lugar se calcula sólo con «3 leches = gratis 1»');
    comp.limpiarFiltros();
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && !q.params.has('promo')).flush(ranking());
    await fixture.whenStable();
    expect(comp.hayFiltros()).toBe(false);
  });

  it('[MKT.16] por promoción: la fila abre quién la vendió, mejor cubrimiento primero', async () => {
    const { comp } = await montar(ranking());
    comp.elegirVista('promociones');
    expect(comp.filasPromo().map((x) => x.code)).toEqual(['DM001']);
    comp.abrirPromo(comp.filasPromo()[0]);
    expect(comp.filasDePromo().map((f) => f.nombre)).toEqual(['Padre Hidalgo', 'Yurécuaro']);
    comp.elegirEstado('sin_venta');
    expect(comp.filasPromo()).toEqual([]);
  });

  it('[MKT.24] proveedor: lo pide al servidor, se ve como etiqueta y la portada del PDF lo nombra; quitarlo lo suelta', async () => {
    const { comp, http, fixture } = await montar(ranking());
    expect(comp.opcionesProveedor()).toEqual([{ label: 'CD015 · DULCES DEMO SA (1)', value: PROV }]);
    comp.elegirProveedor(PROV);
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('proveedor') === PROV).flush(ranking({ proveedor_filtrado: PROV }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(comp.chips().map((c) => c.texto)).toContain('DULCES DEMO SA');
    expect(comp.filtrosTexto()).toContain('Proveedor: DULCES DEMO SA');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('El lugar se calcula sólo con las promociones de DULCES DEMO SA');
    comp.quitarFiltro('proveedor');
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && !q.params.has('proveedor')).flush(ranking());
    await fixture.whenStable();
    expect(comp.hayFiltros()).toBe(false);
  });

  it('[MKT.24] «Sin proveedor asignado» se ofrece como filtro y se pide como «sin»', async () => {
    const { comp, http, fixture } = await montar(ranking({ proveedores_lista: [{ id: null, code: null, name: 'Sin proveedor asignado', promos: 3 }] }));
    expect(comp.opcionesProveedor()).toEqual([{ label: 'Sin proveedor asignado (3)', value: 'sin' }]);
    comp.elegirProveedor('sin');
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('proveedor') === 'sin').flush(ranking());
    await fixture.whenStable();
    expect(comp.chips().map((c) => c.texto)).toContain('Sin proveedor asignado');
  });

  it('⭐ [MKT.25] la promoción abierta dice su proveedor y QUIÉN la vendió, con lo atribuido contra el total', async () => {
    const { comp, fixture } = await montar(ranking());
    comp.elegirVista('promociones');
    comp.abrirPromo(comp.filasPromo()[0]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(comp.vendedorasDePromo().map((v) => [v.nombre, v.cantidad])).toEqual([['VENDEDORA DEMO A', 7], ['VENDEDORA DEMO B', 2]]);
    // 7 + 2 = 9 con vendedora, de 9 + 9 = 18 vendidas: lo atribuido no se presenta como el total.
    expect(comp.textoAtribuido()).toBe('Con vendedora: 9 de 18 piezas. El resto, la cajera aún no lo asigna en el arqueo.');
    const texto = document.body.textContent || '';
    expect(texto).toContain('CD015 · DULCES DEMO SA');
    expect(texto).toContain('Quién la vendió');
    expect(texto).toContain('VENDEDORA DEMO A');
    // con el filtro de sucursal, sólo las de esa sucursal
    comp.sucursales.set(['01']);
    expect(comp.vendedorasDePromo().map((v) => v.nombre)).toEqual(['VENDEDORA DEMO A']);
  });

  it('[negativa MKT.25] si ninguna cajera la asignó, lo dice en vez de una tabla vacía', async () => {
    const { comp, fixture } = await montar(ranking({ vendedoras: { ...ranking().vendedoras!, personas: [] } }));
    comp.elegirVista('promociones');
    comp.abrirPromo(comp.filasPromo()[0]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(comp.vendedorasDePromo()).toEqual([]);
    expect(document.body.textContent).toContain('Ninguna cajera ha escrito quién vendió esta promoción esta semana.');
  });

  it('[MKT.18] por vendedora: dice cuánto está atribuido y dónde no hay captura (no lo dibuja como cero)', async () => {
    const { comp } = await montar(ranking());
    expect(comp.opcionesVista().map((o) => o.value)).toContain('vendedoras');
    comp.elegirVista('vendedoras');
    expect(comp.filasVendedora().map((x) => x.nombre)).toEqual(['VENDEDORA DEMO A', 'VENDEDORA DEMO B']);
    const tickets = comp.kpis().find((k) => k.label === 'Tickets con vendedora')!;
    expect(tickets.value).toBe('4 de 10');
    expect(tickets.state).toBe('parcial');
    expect(comp.coberturaTexto()).toContain('cuenta sólo los tickets que ya tienen vendedora');
    expect(comp.coberturaTexto()).toContain('Sin captura: Yurécuaro');
  });

  it('⭐ NEGATIVA (auditoría 2026-11-12): al recargar, la franja NO vuelve a cero — se queda lo anterior y dice «Actualizando…»', async () => {
    const { comp, http, fixture } = await montar(ranking());
    comp.elegirSucursales(['04']);
    fixture.detectChanges();
    const req = http.expectOne((q) => q.url === BASE && q.params.get('sucursales') === '04');
    // Mientras viaja la respuesta: los datos siguen ahí y la pantalla lo declara.
    expect(comp.datos()?.promedio_general).toBe(0.6);
    expect(comp.actualizando()).toBe(true);
    expect(comp.kpis().find((k) => k.label === 'Promedio general')?.value).toBe(60);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Actualizando el ranking…');
    req.flush(ranking({ promedio_general: 0.5 }));
    await fixture.whenStable();
    expect(comp.actualizando()).toBe(false);
    expect(comp.kpis().find((k) => k.label === 'Promedio general')?.value).toBe(50);
  });

  it('si la recarga FALLA, lo anterior se suelta (no se finge vigente)', async () => {
    const { comp, http, fixture } = await montar(ranking());
    comp.elegirSucursales(['04']);
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('sucursales') === '04').flush({ message: 'x' }, { status: 500, statusText: 'Error' });
    await fixture.whenStable();
    expect(comp.datos()).toBeUndefined();
    expect(comp.error()).toContain('No se pudo cargar');
  });

  it('⭐ la franja habla de la vista: «Primer lugar» es una sucursal, una promoción o una vendedora según lo que se ve', async () => {
    const { comp } = await montar(ranking());
    expect(comp.kpis()[0]).toMatchObject({ label: 'Primer lugar', value: 'Padre Hidalgo' });
    comp.elegirVista('promociones');
    expect(comp.kpis()[0]).toMatchObject({ label: 'Mejor promoción', value: '3 leches = gratis 1' });
    comp.elegirVista('vendedoras');
    expect(comp.kpis()[0]).toMatchObject({ label: 'Primer lugar', value: 'VENDEDORA DEMO A' });
    expect(comp.kpis().find((k) => k.label === 'Sucursales sin captura')?.value).toBe(1);
    // Con filtro de sucursal, el primero visible no es el 1.º de la semana: se dice.
    comp.sucursales.set(['04']);
    expect(comp.kpis()[0]).toMatchObject({ label: 'Arriba en el filtro', value: 'VENDEDORA DEMO B' });
  });

  it('por vendedora: la fila abre todo lo que vendió y el estado «cumplida» no se ofrece', async () => {
    const { comp, fixture } = await montar(ranking());
    comp.filtrosAbiertos.set(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No cumplidas'); // control: en sucursales sí se ofrece
    comp.elegirVista('vendedoras');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('No cumplidas');
    expect(comp.textoBuscar()).toBe('Buscar vendedora, sucursal o promoción');
    comp.abrirVendedora(comp.filasVendedora()[0]);
    expect(comp.subtituloVendedora()).toContain('Lugar 1 de 2');
    comp.elegirVista('participantes');
    expect(comp.abiertaVendedora()).toBeNull();
  });

  it('⭐ diseño limpio: los filtros nacen plegados, pero lo filtrado SIEMPRE se ve como etiqueta y se quita de un clic', async () => {
    const { comp, fixture, http } = await montar(ranking());
    const texto = () => (fixture.nativeElement as HTMLElement).textContent || '';
    expect(comp.filtrosAbiertos()).toBe(false);
    expect(texto()).not.toContain('Todas las promociones');
    comp.busqueda.set('yure');
    comp.elegirEstado('no_cumplida');
    fixture.detectChanges();
    expect(comp.chips().map((c) => c.texto)).toEqual(['No cumplidas', '«yure»']);
    expect(texto()).toContain('Filtros (2)');
    expect(texto()).toContain('«yure»');
    comp.quitarFiltro('busqueda');
    expect(comp.chips().map((c) => c.id)).toEqual(['estado']);
    comp.quitarFiltro('estado');
    expect(comp.hayFiltros()).toBe(false);
    http.verify();
  });

  it('calendario: cualquier día abre SU semana (lunes); el domingo es de la semana que termina, no de la siguiente', async () => {
    const { comp, http, fixture } = await montar(ranking());
    expect(comp.lunesFecha()?.getDate()).toBe(2);
    comp.elegirDia(new Date(2026, 9, 1)); // jueves 1-oct
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('semana') === '2026-09-28').flush(ranking());
    comp.elegirDia(new Date(2026, 10, 8)); // domingo 8-nov → semana del 2-nov
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('semana') === '2026-11-02').flush(ranking());
    await fixture.whenStable();
  });

  it('[MKT.21] reporte filtrado: lleva SÓLO lo que se ve, y la portada nombra cada filtro', async () => {
    const { comp, fixture, http } = await montar(ranking());
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Reporte de la semana');
    comp.sucursales.set(['04']);
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('sucursales') === '04').flush(ranking());
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Reporte filtrado');
    const r = comp.rankingFiltrado(comp.datos()!);
    expect(r.participantes.map((p) => p.nombre)).toEqual(['Yurécuaro']);
    expect(r.vendedoras?.personas.map((x) => x.nombre)).toEqual(['VENDEDORA DEMO B']);
    // La cobertura se recalcula con la sucursal filtrada: 0 de 4, no «4 de 10» de toda la semana.
    expect([r.vendedoras?.tickets_con_vendedora, r.vendedoras?.tickets_con_promo]).toEqual([0, 4]);
    expect(comp.filtrosTexto()).toEqual(['Canal: Sucursales (mostrador)', 'Sucursal: Yurécuaro']);
  });

  it('[MKT.21] con estado «no cumplidas», el detalle de cada sucursal trae sólo esas promociones', async () => {
    const { comp } = await montar(ranking());
    comp.elegirEstado('no_cumplida');
    const r = comp.rankingFiltrado(comp.datos()!);
    expect(r.participantes.map((p) => [p.nombre, p.promos.length])).toEqual([['Padre Hidalgo', 1]]);
    expect(comp.filtrosTexto()).toContain('Estado: No cumplidas');
  });

  it('una columna que es cero en todas las filas no se pinta; aparece en cuanto alguien la tiene', async () => {
    const { comp } = await montar(ranking());
    expect(comp.colSinVenta()).toBe(false);
    expect(comp.colSinObjetivo()).toBe(true); // Yurécuaro tiene 3 sin objetivo
    expect(comp.kpis().map((k) => k.label)).toEqual(['Primer lugar', 'Promedio general', 'Cumplieron todas', 'Sin objetivo']);
  });

  it('[MKT.18] la vista por vendedora sólo existe en mostrador; cambiar de canal la suelta', async () => {
    const { comp, http, fixture } = await montar(ranking());
    comp.elegirVista('vendedoras');
    comp.elegirCanal('ruta');
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('canal') === 'ruta').flush(ranking({ canal: 'ruta', vendedoras: null }));
    await fixture.whenStable();
    expect(comp.vista()).toBe('participantes');
    expect(comp.opcionesVista().map((o) => o.value)).not.toContain('vendedoras');
  });
});
