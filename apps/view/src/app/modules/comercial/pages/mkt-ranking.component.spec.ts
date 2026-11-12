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
  promos: [{ promo_id: 'a', code: 'DM001', mecanica: '3 leches = gratis 1', objetivo: 10, objetivo_fuente: 'sugerido', venta: 9, cubrimiento: 0.9, existencia: 4, descripcion_distinta: true,
    productos: [{ sku: 'DM201', nombre: 'LECHE ENTERA LT /12', unidades: 24, cajas: 2 }], productos_metodo: 'ticket_y_nombre', productos_nota: '' }],
  ...over,
});

const ranking = (over: Partial<RankingSemana> = {}): RankingSemana => ({
  semana: { lunes: '2026-11-02', domingo: '2026-11-08', numero: 45, hasta: '2026-11-08', en_curso: false },
  canal: 'mostrador', canal_texto: 'Sucursales (mostrador)', promos_vigentes: 3, promedio_general: 0.6,
  participantes: [
    p({}),
    p({ clave: '04|', warehouse_code: '04', warehouse_name: 'Yurécuaro', nombre: 'Yurécuaro', lugar: null, puntaje: null, con_objetivo: 0, sin_objetivo: 3, cumplidas: 0 }),
  ],
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
});
