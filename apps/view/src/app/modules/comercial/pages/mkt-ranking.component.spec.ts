import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';

import { MktRankingComponent } from './mkt-ranking.component';
import { ParticipanteRanking, RankingSemana } from '../mkt-ranking.service';
import { environment } from '../../../../environments/environment';

const BASE = `${environment.apiUrl}/commercial/mkt-ranking`;

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
  promos_lista: [{ id: 'a', code: 'DM001', mecanica: '3 leches = gratis 1' }], promo_filtrada: null,
  promos_ranking: [{ promo_id: 'a', code: 'DM001', nombre: '3 leches = gratis 1', productos: ['LECHE ENTERA LT /12'], productos_metodo: 'ticket_y_nombre',
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

  it('[MKT.18] por vendedora: dice cuánto está atribuido y dónde no hay captura (no lo dibuja como cero)', async () => {
    const { comp } = await montar(ranking());
    expect(comp.opcionesVista().map((o) => o.value)).toContain('vendedoras');
    comp.elegirVista('vendedoras');
    expect(comp.filasVendedora().map((x) => x.nombre)).toEqual(['VENDEDORA DEMO A', 'VENDEDORA DEMO B']);
    expect(comp.coberturaTexto()).toContain('4 de 10 tickets con promoción tienen vendedora (40 %)');
    expect(comp.coberturaTexto()).toContain('Sin captura: Yurécuaro');
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
