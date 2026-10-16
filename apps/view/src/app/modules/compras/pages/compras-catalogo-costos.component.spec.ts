import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { BehaviorSubject, of } from 'rxjs';
import { vi } from 'vitest';
import type { RespuestaMatrizCostos } from '@megadulces/contracts';
import { CostoEstandarService } from '../costo-estandar.service';
import { ComprasCatalogoCostosComponent } from './compras-catalogo-costos.component';

const MATRIZ: RespuestaMatrizCostos = {
  disponible: true,
  tipo: 'estandar',
  fecha: '2026-10-15',
  primera_fecha: '2025-01-09',
  calculado_al: '2026-10-15T12:20:00.000Z',
  tolerancia_pct: 0.5,
  sucursales: [{ codigo: '00', nombre: 'CEDIS', desde: '2024-08-09' }, { codigo: '01', nombre: 'Padre Hidalgo', desde: '2026-06-27' }],
  resumen: { distinto: 0, sin_mayoria: 0, unidad_distinta: 0, igual: 1, una_plaza: 0 },
  proveedores: [],
  total: 0,
  filas: [],
};

const tick = async (fix: ComponentFixture<unknown>) => {
  fix.detectChanges();
  await fix.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fix.detectChanges();
};

describe('[CAT-COSTO.10] ComprasCatalogoCostosComponent (contenedor de las vistas)', () => {
  let fix: ComponentFixture<ComprasCatalogoCostosComponent>;
  let api: { matriz: ReturnType<typeof vi.fn>; contraUltimo: ReturnType<typeof vi.fn>; historial: ReturnType<typeof vi.fn>; listar: ReturnType<typeof vi.fn> };
  let query: BehaviorSubject<ReturnType<typeof convertToParamMap>>;

  async function montar(params: Record<string, string> = {}) {
    query = new BehaviorSubject(convertToParamMap(params));
    api = {
      matriz: vi.fn(() => of(MATRIZ)),
      contraUltimo: vi.fn(() => of({ disponible: false })),
      historial: vi.fn(() => of(null)),
      listar: vi.fn(() => of({ filas: [], total: 0 })),
    };
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoCostosComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CostoEstandarService, useValue: api },
        { provide: ActivatedRoute, useValue: { queryParamMap: query.asObservable() } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCatalogoCostosComponent);
    await tick(fix);
    return fix.nativeElement as HTMLElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('sin vista en la URL abre la matriz del COSTO ESTÁNDAR (la que antes era «Entre sucursales»)', async () => {
    const el = await montar();
    expect(el.querySelector('app-compras-costos-matriz')).not.toBeNull();
    expect(api.matriz.mock.calls[0][0].tipo).toBe('estandar');
  });

  it('cada vista de la URL pinta su componente', async () => {
    const el = await montar({ vista: 'promedio' });
    expect(api.matriz.mock.calls[0][0].tipo).toBe('promedio');
    query.next(convertToParamMap({ vista: 'contra' }));
    await tick(fix);
    expect(el.querySelector('app-compras-costos-ultimo')).not.toBeNull();
    expect(el.querySelector('app-compras-costos-matriz')).toBeNull();
    query.next(convertToParamMap({ vista: 'historial' }));
    await tick(fix);
    expect(el.querySelector('app-compras-costos-historial')).not.toBeNull();
  });

  it('NEGATIVA: una vista que no existe cae a la matriz del estándar, no a una pantalla vacía', async () => {
    await montar({ vista: 'sucursales' });
    expect(api.matriz.mock.calls[0][0].tipo).toBe('estandar');
  });

  // [CAT-COSTO.11] El clic en un producto abre su historial EN EL COSTO de la pestaña donde se estaba.
  for (const tipo of ['estandar', 'promedio', 'ultimo'] as const) {
    it('desde la pestaña ' + tipo + ', el historial abre en el costo ' + tipo, async () => {
      const el = await montar(tipo === 'estandar' ? {} : { vista: tipo });
      const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const hijo = fix.debugElement.query((d) => d.name === 'app-compras-costos-matriz');
      hijo.componentInstance.skuElegido.emit('70001');
      expect(el).toBeTruthy();
      expect(nav).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { vista: 'historial', sku: '70001', costo: tipo } }));
    });
  }

  it('el historial recibe el costo de la URL; uno inventado no filtra', async () => {
    await montar({ vista: 'historial', sku: '70001', costo: 'promedio' });
    expect(fix.componentInstance.costoHistorial()).toBe('promedio');
    query.next(convertToParamMap({ vista: 'historial', sku: '70001', costo: 'inventado' }));
    fix.detectChanges();
    expect(fix.componentInstance.costoHistorial()).toBeNull();
  });

  it('el selector ofrece las cinco vistas, en el orden de la hoja de Compras', async () => {
    await montar();
    expect(fix.componentInstance.vistas.map((v) => v.label)).toEqual([
      'Costo estándar', 'Costo promedio', 'Último costo', 'Contra último costo', 'Historial por producto',
    ]);
  });
});
