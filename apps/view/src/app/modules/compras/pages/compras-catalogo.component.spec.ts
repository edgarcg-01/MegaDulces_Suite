import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ComercialService } from '../../comercial/comercial.service';
import { ProductosNuevosService } from '../productos-nuevos.service';
import { CuidarRespuesta, FlujoLista, FlujoResumen, ProductosFlujoService } from '../productos-flujo.service';
import { ComprasCatalogoComponent, alertasTexto, caducidadTexto, sinVenderTexto } from './compras-catalogo.component';

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
  lideresCorte: 0.5, coberturaComprarLider: 21, caducidadAviso: 30,
  diasSinVenta: 30, ventanaSinVenta: 365, ventanaNuevos: 90, limiteNoSeVenden: 300, ventanaMargen: 30 };
const PERIODOS = { hoy: '2026-10-09', mesIni: '2026-10-01', dias: 9, prevIni: '2026-09-01', prevFin: '2026-09-10', desde30: '2026-09-10', desdeHistoria: '2026-06-11' };

/** Para cuidar hoy: dos líderes (por su lugar), dos que no se venden y un producto con un lote que no alcanza. */
const CUIDAR: CuidarRespuesta = {
  periodos: PERIODOS, corte: '2026-10-09', en_vivo_al: '2026-10-09T18:00:00Z', costo_visible: false, criterio: CRITERIO,
  lideres: {
    total: 245, calculado: '2026-10-09T17:30:00Z',
    por_motivo: { agotado: 1, comprar: 1, mover: 0, se_freno: 0 },
    lista: [
      { sku: '70001', nombre: 'MAZAPAN', motivos: ['agotado'], en_juego_dia: 900,
        resumen: resumen('l-1', { lider: { rank: 2, participacion: 0.02 }, agotadas: [{ plaza: '04', nombre: 'Yurécuaro', venta_dia: 900 }],
          compra: { ...resumen('l-1').compra, veredicto: 'traspasar', titulo: 'No comprar: mover entre sucursales' } }) },
      { sku: '17085', nombre: 'ALTOS CAM', motivos: ['comprar'], en_juego_dia: 0,
        resumen: resumen('l-2', { lider: { rank: 7, participacion: 0.01 },
          compra: { ...resumen('l-2').compra, veredicto: 'comprar', titulo: 'Comprar: alcanza para 12 días' } }) },
    ],
  },
  no_se_venden: {
    nuevos_excluidos: true, total: 3, valor_total: null, por_tramo: { mes: 1, trimestre: 0, anio: 2 },
    productos: [
      { product_id: 'n-1', sku: '90037', nombre: 'BOTA TUTSI', existencia: 130, valor: null, valor_incompleto: false,
        plazas: [{ plaza: '01', nombre: 'Padre Hidalgo' }], ultima_venta: null, dias_sin_venta: null, tramo: 'anio',
        escalera: [{ abr: 'pz', nombre: 'Pieza', factor: 1, rotulo: 'PZA' }, { abr: 'cj', nombre: 'Caja', factor: 60, rotulo: 'CJA' }],
        caducidad: null },
      { product_id: 'n-2', sku: '40115', nombre: 'PELOTA', existencia: 7, valor: null, valor_incompleto: false,
        plazas: [{ plaza: '06', nombre: 'Canindo' }, { plaza: '08', nombre: 'Morelia Abastos' }], ultima_venta: '2026-09-02', dias_sin_venta: 37,
        tramo: 'mes', escalera: null,
        caducidad: { vencido: 0, en_riesgo: 5, por_caducar: 0, proxima: '2026-10-20', plazas_vencido: [], plazas_en_riesgo: ['Canindo'], lotes: 1 } },
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

describe('[PF.2]/[PF.4] Para cuidar hoy: líderes de un lado, lo que no se vende del otro', () => {
  afterEach(() => TestBed.resetTestingModule());
  const sinTabla = () => ({ listar: vi.fn(() => of(LISTA([]))), detalle: vi.fn(() => NEVER) });
  const tarjetas = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.pc-card')) as HTMLElement[];
  const texto = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('⭐ los dos lados: Líderes y No se venden', async () => {
    const { fix } = await montar(sinTabla());
    expect(tarjetas(fix).map((t) => texto(t.querySelector('.pc-t')))).toEqual(['Líderes', 'No se venden']);
  });

  it('⭐ los líderes, TODOS y por su lugar, con su venta del mes y lo que piden', async () => {
    const { fix } = await montar(sinTabla());
    const [lid] = tarjetas(fix);
    expect(texto(lid.querySelector('.pc-n'))).toBe('245 productos hacen la mitad de la venta');
    const items = Array.from(lid.querySelectorAll('.pc-item')) as HTMLElement[];
    expect(items.map((i) => i.querySelector('.pc-rank')?.textContent)).toEqual(['#2', '#7']);
    expect(items[0].textContent).toContain('Agotado en Yurécuaro');
    expect(texto(items[0].querySelector('.pc-dinero'))).toContain('$15,000');
    expect(texto(items[0].querySelector('.pc-dinero'))).toContain('+25% este mes');
  });

  it('el filtro de líderes por motivo; los motivos sin líderes no se ofrecen', async () => {
    const { fix } = await montar(sinTabla());
    const [lid] = tarjetas(fix);
    const chips = Array.from(lid.querySelectorAll('.pc-chip')) as HTMLButtonElement[];
    expect(chips.map((c) => texto(c))).toEqual(['Todos · 2', 'Agotado en alguna sucursal · 1', 'Comprar · 1']);
    chips[2].click();
    fix.detectChanges();
    expect(Array.from(lid.querySelectorAll('.pc-rank')).map((r) => r.textContent)).toEqual(['#7']);
  });

  it('⭐ lo que no se vende: cuánto lleva sin venderse, dónde hay, en cajas, y si además caduca', async () => {
    const { fix } = await montar(sinTabla());
    const [, nv] = tarjetas(fix);
    expect(texto(nv.querySelector('.pc-n'))).toBe('3 productos');
    const items = Array.from(nv.querySelectorAll('.pc-item')) as HTMLElement[];
    expect(texto(items[0].querySelector('.pc-sin'))).toBe('Sin una venta en el último año');
    expect(items[0].textContent).toContain('Hay en Padre Hidalgo');
    // 130 piezas de una caja de 60 = 2 cajas y 10 piezas. Sin permiso de costo, no hay pesos.
    expect(texto(items[0].querySelector('.pc-dinero'))).toBe('2 cajas y 10 piezas');
    expect(texto(items[1].querySelector('.pc-sin'))).toBe('Sin vender hace 37 días');
    expect(texto(items[1].querySelector('.pc-cad'))).toBe('No alcanza a venderse en Canindo');
  });

  it('el filtro por tramo; y «Caducan antes de venderse» muestra los lotes con su fecha y la cobertura', async () => {
    const { fix } = await montar(sinTabla());
    const [, nv] = tarjetas(fix);
    const chips = () => Array.from(nv.querySelectorAll('.pc-chip')) as HTMLButtonElement[];
    expect(chips().map((c) => texto(c))).toEqual(['Todos · 3', '30 a 89 días · 1', 'Sin venta en el año · 2', 'Caducan antes de venderse · 1']);
    chips()[1].click();
    fix.detectChanges();
    expect(Array.from(nv.querySelectorAll('.pc-nom')).map((n) => n.textContent)).toEqual(['PELOTA']);
    chips()[3].click();
    fix.detectChanges();
    const item = nv.querySelector('.pc-item') as HTMLElement;
    expect(texto(item.querySelector('.pc-cad'))).toBe('No alcanza a venderse en Padre Hidalgo');
    expect(texto(item.querySelector('.pc-fecha'))).toContain('en 25 días');
    expect(texto(nv.querySelector('.pc-meta'))).toContain('60 lotes de 60 productos en CEDIS, Padre Hidalgo');
  });

  it('⭐ el clic abre el mismo panel del producto, sin el botón de editar (no viene de la tabla)', async () => {
    const flujo = sinTabla();
    const { fix } = await montar(flujo);
    (tarjetas(fix)[1].querySelector('.pc-item') as HTMLElement).click();
    fix.detectChanges();
    expect(fix.componentInstance.abierto()).toEqual({ id: 'n-1', nombre: 'BOTA TUTSI', sku: '90037' });
    expect(flujo.detalle).toHaveBeenCalledWith('n-1');
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

describe('[PF.5] margen en la tabla', () => {
  afterEach(() => TestBed.resetTestingModule());
  const conCosto = (productos: FlujoResumen[]) => ({ ...LISTA(productos), costo_visible: true });

  it('⭐ con permiso de costo: columna «Margen 30 d» con su cobertura; sin costo registrado se dice', async () => {
    const { fix } = await montar({ listar: vi.fn(() => of(conCosto([
      resumen('p-1', { margen_real: { pct: 13.6, utilidad: 100, cobertura: 0.64, nota: 'Kepler no registró el costo en el 36% de la venta' } }),
      resumen('p-2', { margen_real: { pct: null, utilidad: null, cobertura: 0, nota: 'Kepler no registró el costo en ninguna venta' } }),
    ]))), detalle: vi.fn(() => NEVER) });
    const ths = Array.from(fix.nativeElement.querySelectorAll('thead th')).map((t) => (t as HTMLElement).textContent?.trim());
    expect(ths).toContain('Margen 30 d');
    const filas = Array.from(fix.nativeElement.querySelectorAll('tbody tr')) as HTMLElement[];
    expect(filas[0].querySelector('.pp-margen')?.textContent).toBe('13.6%');
    expect(filas[0].textContent).toContain('cubre 64%');
    expect(filas[1].textContent).toContain('sin costo');
  });

  it('[negativa] sin permiso de costo no hay columna de margen', async () => {
    const { fix } = await montar({ listar: vi.fn(() => of(LISTA([resumen('p-1')]))), detalle: vi.fn(() => NEVER) });
    const ths = Array.from(fix.nativeElement.querySelectorAll('thead th')).map((t) => (t as HTMLElement).textContent?.trim());
    expect(ths).not.toContain('Margen 30 d');
    expect(fix.nativeElement.querySelector('.pp-margen')).toBeNull();
  });
});

describe('[PF.4] días sin vender en palabras', () => {
  it('con fecha, cuántos días; sin venta en el año, se dice', () => {
    expect(sinVenderTexto({ dias_sin_venta: 45 }, 365)).toBe('Sin vender hace 45 días');
    expect(sinVenderTexto({ dias_sin_venta: null }, 365)).toBe('Sin una venta en el último año');
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
