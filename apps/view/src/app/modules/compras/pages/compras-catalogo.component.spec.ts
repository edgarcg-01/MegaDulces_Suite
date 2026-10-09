import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ComercialService } from '../../comercial/comercial.service';
import { ProductosNuevosService } from '../productos-nuevos.service';
import { FlujoLista, FlujoResumen, ProductosFlujoService } from '../productos-flujo.service';
import { ComprasCatalogoComponent, alertasTexto } from './compras-catalogo.component';

const producto = (id: string, nombre: string) => ({
  id, nombre, sku: id.toUpperCase(), barcode: null, brand_name: 'FERRERO', supplier_name: 'FERRERO SA', category_name: null,
  location: null, cost_base: null, price_customer: 18, price_min_qty: 1, unit_sale: 'PZA', factor_sale: 1, activo: true, description: null,
});

const resumen = (id: string, over: Partial<FlujoResumen> = {}): FlujoResumen => ({
  product_id: id, mes: 15000, mes_anterior_mismo: 12000, mes_anterior_total: 46000, variacion: 0.25, venta_dia: 1500,
  estancadas: [], frenadas: [], agotadas: [],
  compra: { veredicto: 'esperar', titulo: 'Esperar: alcanza para 40 días', motivos: [], impacto: [], traspasos: [],
    cobertura_dias: 40, se_acaba: null, venta_en_riesgo_dia: 1500, inmovilizado: null },
  ...over,
});

const LISTA = (productos: FlujoResumen[]): FlujoLista => ({
  periodos: { hoy: '2026-10-09', mesIni: '2026-10-01', dias: 9, prevIni: '2026-09-01', prevFin: '2026-09-10', desde30: '2026-09-10', desdeHistoria: '2026-06-11' },
  corte: '2026-10-09', en_vivo_al: '2026-10-09T18:00:00Z', costo_visible: false,
  criterio: { ventanaRitmo: 30, ventanaHistoria: 120, diasEstancado: 14, caidaFrenado: 0.5, diasMinimosComparar: 7,
    coberturaComprar: 15, coberturaSobra: 60, coberturaQueSeQueda: 30, ventanaReparto: 90 },
  productos,
});

const tick = async (fix: ComponentFixture<unknown>) => { fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };

async function montar(flujo: { listar: ReturnType<typeof vi.fn>; detalle: ReturnType<typeof vi.fn> }) {
  const comercial = {
    listProducts: vi.fn(() => of({ data: [producto('p-1', 'KINDER DELICE'), producto('p-2', 'MAZAPAN')], pagination: { total: 2 } })),
    productStats: vi.fn(() => of({ total: 2, brands: 1, categories: 0, active: 2, with_cost: 0, with_price: 2, top_brands: [], price_updated_at: null })),
    productSuppliers: vi.fn(() => of([])),
    findProduct: vi.fn((id: string) => of(producto(id, 'KINDER DELICE'))),
    updateProduct: vi.fn(() => of({})),
  };
  await TestBed.configureTestingModule({
    imports: [ComprasCatalogoComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: ComercialService, useValue: comercial },
      { provide: ProductosNuevosService, useValue: { listar: vi.fn(() => of(null)) } },
      { provide: ProductosFlujoService, useValue: flujo },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(ComprasCatalogoComponent);
  await tick(fix);
  return { fix, comercial };
}

describe('[PF.1] Productos: flujo de venta en la tabla', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ cada producto trae su venta del mes contra el anterior y su situación de compra', async () => {
    const flujo = { listar: vi.fn(() => of(LISTA([
      resumen('p-1', { compra: { ...resumen('p-1').compra, veredicto: 'comprar', titulo: 'Comprar: alcanza para 5 días' },
        agotadas: [{ plaza: '04', nombre: 'Yurécuaro' }], estancadas: [{ plaza: '06', nombre: 'Canindo', dias_sin_venta: 20 }] }),
      resumen('p-2', { mes: 0, mes_anterior_mismo: 0, variacion: null }),
    ]))), detalle: vi.fn(() => NEVER) };
    const { fix } = await montar(flujo);
    expect(flujo.listar).toHaveBeenCalledWith(['p-1', 'p-2']);
    const filas = Array.from(fix.nativeElement.querySelectorAll('tbody tr')) as HTMLElement[];
    expect(filas[0].querySelector('.pp-mes')?.textContent).toContain('15,000');
    expect(filas[0].querySelector('.pp-var')?.textContent).toBe('+25%');
    expect(filas[0].querySelector('.pp-ver')?.textContent).toBe('Comprar');
    expect(filas[0].querySelector('.pp-ver')?.classList).toContain('is-comprar');
    expect(filas[0].querySelector('.pp-alerta')?.textContent).toBe('Estancado en 1 · Agotado en 1');
    // Sin venta el mes anterior: guion, no +100%.
    expect(filas[1].querySelector('.pp-var')?.textContent).toBe('—');
  });

  it('⭐ el clic en el renglón abre cómo se vende (no el editor); editar sigue en el lápiz', async () => {
    const flujo = { listar: vi.fn(() => of(LISTA([resumen('p-1')]))), detalle: vi.fn(() => NEVER) };
    const { fix, comercial } = await montar(flujo);
    (fix.nativeElement.querySelector('tbody tr') as HTMLElement).click();
    fix.detectChanges();
    expect(fix.componentInstance.abierto()?.id).toBe('p-1');
    expect(comercial.findProduct).not.toHaveBeenCalled();
    expect(flujo.detalle).toHaveBeenCalledWith('p-1');
  });

  it('⛔ si el flujo falla, la tabla sigue y la columna dice guion (no ceros)', async () => {
    const flujo = { listar: vi.fn(() => throwError(() => new Error('x'))), detalle: vi.fn(() => NEVER) };
    const { fix } = await montar(flujo);
    const filas = Array.from(fix.nativeElement.querySelectorAll('tbody tr')) as HTMLElement[];
    expect(filas.length).toBe(2);
    expect(filas[0].querySelector('.pp-mes')).toBeNull();
  });

  it('⭐ una recarga que falla no borra lo que ya se veía', async () => {
    let n = 0;
    const flujo = { listar: vi.fn(() => (++n === 1 ? of(LISTA([resumen('p-1')])) : throwError(() => new Error('x')))), detalle: vi.fn(() => NEVER) };
    const { fix } = await montar(flujo);
    (fix.componentInstance as unknown as { recargaFlujo: { update: (f: (x: number) => number) => void } }).recargaFlujo.update((x) => x + 1);
    await tick(fix);
    expect(flujo.listar).toHaveBeenCalledTimes(2);
    expect(fix.nativeElement.querySelector('tbody tr .pp-mes')?.textContent).toContain('15,000');
  });
});

describe('[PF.1] alertas de la tabla', () => {
  it('dice en cuántas sucursales está estancado, agotado o se frenó; si todo se mueve, nada', () => {
    expect(alertasTexto({ estancadas: [], agotadas: [], frenadas: [] })).toBeNull();
    expect(alertasTexto({ estancadas: [{ plaza: '06', nombre: null, dias_sin_venta: 20 }], agotadas: [],
      frenadas: [{ plaza: '01', nombre: null, variacion: -0.6 }] })).toBe('Estancado en 1 · Se frenó en 1');
  });
});
