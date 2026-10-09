import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ComercialService } from '../../comercial/comercial.service';
import { ProductosNuevosService } from '../productos-nuevos.service';
import { CuidarRespuesta, FlujoLista, FlujoResumen, ProductosFlujoService } from '../productos-flujo.service';
import { ComprasCatalogoComponent, alertasTexto, caducidadTexto } from './compras-catalogo.component';

const producto = (id: string, nombre: string) => ({
  id, nombre, sku: id.toUpperCase(), barcode: null, brand_name: 'FERRERO', supplier_name: 'FERRERO SA', category_name: null,
  location: null, cost_base: null, price_customer: 18, price_min_qty: 1, unit_sale: 'PZA', factor_sale: 1, activo: true, description: null,
});

const resumen = (id: string, over: Partial<FlujoResumen> = {}): FlujoResumen => ({
  product_id: id, mes: 15000, mes_anterior_mismo: 12000, mes_anterior_total: 46000, variacion: 0.25, venta_dia: 1500,
  estancadas: [], frenadas: [], agotadas: [],
  compra: { veredicto: 'esperar', titulo: 'Esperar: alcanza para 40 días', motivos: [], impacto: [], traspasos: [],
    cobertura_dias: 40, se_acaba: null, venta_en_riesgo_dia: 1500, inmovilizado: null },
  lider: null, caducidad: null,
  ...over,
});

const CRITERIO = { ventanaRitmo: 30, ventanaHistoria: 120, diasEstancado: 14, caidaFrenado: 0.5, diasMinimosComparar: 7,
  coberturaComprar: 15, coberturaSobra: 60, coberturaQueSeQueda: 30, ventanaReparto: 90,
  lideresCorte: 0.5, coberturaComprarLider: 21, caducidadAviso: 30 };
const PERIODOS = { hoy: '2026-10-09', mesIni: '2026-10-01', dias: 9, prevIni: '2026-09-01', prevFin: '2026-09-10', desde30: '2026-09-10', desdeHistoria: '2026-06-11' };

/** Para cuidar hoy: dos líderes (uno agotado, uno que se acaba) y un producto con un lote que no alcanza. */
const CUIDAR: CuidarRespuesta = {
  periodos: PERIODOS, corte: '2026-10-09', en_vivo_al: '2026-10-09T18:00:00Z', costo_visible: false, criterio: CRITERIO,
  lideres: {
    total: 245, calculado: '2026-10-09T17:30:00Z',
    por_motivo: { agotado: 1, comprar: 1, mover: 0, se_freno: 0 },
    piden_atencion: [
      { sku: '70001', nombre: 'MAZAPAN', motivos: ['agotado'], en_juego_dia: 900,
        resumen: resumen('l-1', { lider: { rank: 2, participacion: 0.02 }, agotadas: [{ plaza: '04', nombre: 'Yurécuaro', venta_dia: 900 }],
          compra: { ...resumen('l-1').compra, veredicto: 'traspasar', titulo: 'No comprar: mover entre sucursales' } }) },
      { sku: '17085', nombre: 'ALTOS CAM', motivos: ['comprar'], en_juego_dia: 0,
        resumen: resumen('l-2', { lider: { rank: 7, participacion: 0.01 },
          compra: { ...resumen('l-2').compra, veredicto: 'comprar', titulo: 'Comprar: alcanza para 12 días' } }) },
    ],
  },
  caducidad: {
    productos: [{ sku: '88219', nombre: 'GALLETAS KREMAS', resumen: resumen('c-1', { caducidad: {
      vencido: 0, en_riesgo: 59, por_caducar: 1, proxima: '2026-11-03', plazas_vencido: [], plazas_en_riesgo: ['Padre Hidalgo'], lotes: 1 } }) }],
    cobertura: { lotes: 60, productos: 60, sucursales: [{ plaza: '00', nombre: 'CEDIS' }, { plaza: '01', nombre: 'Padre Hidalgo' }] },
  },
};

const LISTA = (productos: FlujoResumen[]): FlujoLista => ({
  periodos: { hoy: '2026-10-09', mesIni: '2026-10-01', dias: 9, prevIni: '2026-09-01', prevFin: '2026-09-10', desde30: '2026-09-10', desdeHistoria: '2026-06-11' },
  corte: '2026-10-09', en_vivo_al: '2026-10-09T18:00:00Z', costo_visible: false,
  criterio: CRITERIO,
  productos,
});

const tick = async (fix: ComponentFixture<unknown>) => { fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };

async function montar(flujoSinCuidar: { listar: ReturnType<typeof vi.fn>; detalle: ReturnType<typeof vi.fn>; cuidar?: ReturnType<typeof vi.fn> }) {
  const flujo = { cuidar: vi.fn(() => of(CUIDAR)), ...flujoSinCuidar };
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
        agotadas: [{ plaza: '04', nombre: 'Yurécuaro', venta_dia: 100 }], estancadas: [{ plaza: '06', nombre: 'Canindo', dias_sin_venta: 20 }] }),
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

describe('[PF.2]/[PF.3] Para cuidar hoy', () => {
  afterEach(() => TestBed.resetTestingModule());
  const sinTabla = () => ({ listar: vi.fn(() => of(LISTA([]))), detalle: vi.fn(() => NEVER) });
  const tarjetas = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.pc-card')) as HTMLElement[];

  it('⭐ los líderes que piden atención, en el orden del servidor (lo que más se juega primero), con su lugar y lo que se pierde por día', async () => {
    const { fix } = await montar(sinTabla());
    const [lid] = tarjetas(fix);
    expect(lid.querySelector('.pc-n')?.textContent).toBe('2 de 245 líderes');
    const items = Array.from(lid.querySelectorAll('.pc-item')) as HTMLElement[];
    expect(items.map((i) => i.querySelector('.pc-rank')?.textContent)).toEqual(['#2', '#7']);
    expect(items[0].textContent).toContain('Agotado en Yurécuaro');
    expect(items[0].querySelector('.pc-dinero')?.textContent).toContain('$900');
    // Sin nada en juego por día no se dibuja un $0.
    expect(items[1].querySelector('.pc-dinero')).toBeNull();
  });

  it('el filtro por motivo deja sólo los de ese motivo; los motivos sin líderes no se ofrecen', async () => {
    const { fix } = await montar(sinTabla());
    const [lid] = tarjetas(fix);
    const chips = Array.from(lid.querySelectorAll('.pc-chip')) as HTMLButtonElement[];
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['Todos · 2', 'Agotado en alguna sucursal · 1', 'Comprar · 1']);
    chips[2].click();
    fix.detectChanges();
    expect(Array.from(lid.querySelectorAll('.pc-rank')).map((r) => r.textContent)).toEqual(['#7']);
  });

  it('⭐ lo que caduca antes de venderse, con la sucursal y la fecha; y declara qué tanto se ha registrado', async () => {
    const { fix } = await montar(sinTabla());
    const [, cad] = tarjetas(fix);
    const item = cad.querySelector('.pc-item') as HTMLElement;
    expect(item.querySelector('.pc-cad')?.textContent).toBe('No alcanza a venderse en Padre Hidalgo');
    expect(item.querySelector('.pc-fecha')?.textContent?.replace(/\s+/g, ' ')).toContain('en 25 días');
    expect(cad.querySelector('.pc-meta')?.textContent?.replace(/\s+/g, ' ')).toContain('60 lotes de 60 productos en CEDIS, Padre Hidalgo');
    expect(cad.textContent).toContain('no quiere decir que no caduque');
  });

  it('⭐ el clic abre el mismo panel del producto, sin el botón de editar (no viene de la tabla)', async () => {
    const flujo = sinTabla();
    const { fix } = await montar(flujo);
    (tarjetas(fix)[1].querySelector('.pc-item') as HTMLElement).click();
    fix.detectChanges();
    expect(fix.componentInstance.abierto()).toEqual({ id: 'c-1', nombre: 'GALLETAS KREMAS', sku: '88219' });
    expect(flujo.detalle).toHaveBeenCalledWith('c-1');
    expect(document.querySelector('.pp-peek-acciones')).toBeNull();
  });

  it('[negativa] si falla, lo dice y la tabla sigue', async () => {
    const { fix } = await montar({ listar: vi.fn(() => of(LISTA([resumen('p-1')]))), detalle: vi.fn(() => NEVER),
      cuidar: vi.fn(() => throwError(() => new Error('x'))) });
    expect(tarjetas(fix)).toHaveLength(0);
    expect(fix.nativeElement.textContent).toContain('No se pudo cargar «Para cuidar hoy»');
    expect(fix.nativeElement.querySelectorAll('tbody tr').length).toBe(2);
  });

  it('en la tabla, el líder lleva su marca y la caducidad aparece entre las alertas', async () => {
    const { fix } = await montar({ listar: vi.fn(() => of(LISTA([
      resumen('p-1', { lider: { rank: 4, participacion: 0.015 }, caducidad: { vencido: 12, en_riesgo: 0, por_caducar: 0, proxima: '2026-10-01',
        plazas_vencido: ['Padre Hidalgo'], plazas_en_riesgo: [], lotes: 1 } }),
    ]))), detalle: vi.fn(() => NEVER) });
    const fila = fix.nativeElement.querySelector('tbody tr') as HTMLElement;
    expect(fila.querySelector('.pp-lider')?.textContent).toBe('Líder #4');
    expect(fila.querySelector('.pp-alerta')?.textContent).toBe('Caducado en 1');
    expect((fix.nativeElement.querySelectorAll('tbody tr')[1] as HTMLElement).querySelector('.pp-lider')).toBeNull();
  });
});

describe('[PF.3] caducidad en una frase', () => {
  it('primero lo caducado, luego lo que no alcanza, luego lo que caduca pronto', () => {
    const base = { vencido: 0, en_riesgo: 0, por_caducar: 0, proxima: null, plazas_vencido: [], plazas_en_riesgo: [], lotes: 1 };
    expect(caducidadTexto({ ...base, vencido: 5, en_riesgo: 3, plazas_vencido: ['CEDIS'], plazas_en_riesgo: ['8 Esquinas'] }).texto)
      .toBe('Caducado según el registro en CEDIS');
    expect(caducidadTexto({ ...base, en_riesgo: 3, plazas_en_riesgo: ['8 Esquinas'] })).toEqual({ estado: 'no_alcanza', texto: 'No alcanza a venderse en 8 Esquinas' });
    expect(caducidadTexto({ ...base, por_caducar: 1 }).estado).toBe('justo');
  });
});

describe('[PF.1] alertas de la tabla', () => {
  it('dice en cuántas sucursales está estancado, agotado o se frenó; si todo se mueve, nada', () => {
    expect(alertasTexto({ estancadas: [], agotadas: [], frenadas: [] })).toBeNull();
    expect(alertasTexto({ estancadas: [{ plaza: '06', nombre: null, dias_sin_venta: 20 }], agotadas: [],
      frenadas: [{ plaza: '01', nombre: null, variacion: -0.6 }] })).toBe('Estancado en 1 · Se frenó en 1');
  });
});
