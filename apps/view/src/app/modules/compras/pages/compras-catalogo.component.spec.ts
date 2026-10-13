import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ComercialService } from '../../comercial/comercial.service';
import { ProductosNuevosService } from '../productos-nuevos.service';
import {
  CuidarRespuesta, FilaProveedor, FlujoLista, FlujoResumen, ProductosFlujoService, ProductosProveedorRespuesta, ProveedoresRespuesta,
} from '../productos-flujo.service';
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

const PROVEEDORES: ProveedoresRespuesta = {
  periodos: PERIODOS,
  proveedores: [
    { supplier_id: 's-rosa', nombre: 'DULCES LA ROSA, S.A. DE C.V.', productos: 269, mes: 1_250_000, mes_anterior_mismo: 1_000_000, variacion: 0.25, con_venta: 200 },
    { supplier_id: 's-barcel', nombre: 'BARCEL SA DE CV', productos: 50, mes: 300_000, mes_anterior_mismo: 400_000, variacion: -0.25, con_venta: 40 },
  ],
  sin_proveedor: { supplier_id: null, nombre: 'Sin proveedor asignado', productos: 591, mes: 8401, mes_anterior_mismo: 0, variacion: null, con_venta: 13 },
};

const fila = (id: string, over: Partial<FilaProveedor> = {}): FilaProveedor => ({
  product_id: id, sku: id.toUpperCase(), nombre: 'PALETA DE DULCE 40G', mes: 15000, variacion: 0.25, cobertura_dias: 40,
  veredicto: 'esperar', titulo: 'Esperar: alcanza para 40 días', motivo: 'Revisar en unos 25 días', lider: null, margen_real: null, caducidad: null,
  ...over,
});

const DE = (supplierId: string | null, productos: FilaProveedor[], over: Partial<ProductosProveedorRespuesta> = {}): ProductosProveedorRespuesta => ({
  periodos: PERIODOS, corte: '2026-10-09', en_vivo_al: '2026-10-09T18:00:00Z', costo_visible: false, criterio: CRITERIO,
  proveedor: { supplier_id: supplierId, nombre: supplierId ? 'DULCES LA ROSA, S.A. DE C.V.' : 'Sin proveedor asignado' },
  resumen: {
    productos: productos.length, mes: productos.reduce((a, f) => a + f.mes, 0), mes_anterior_mismo: 0, variacion: 0.12,
    por_veredicto: { comprar: productos.filter((f) => f.veredicto === 'comprar').length, traspasar: 0, esperar: 0, sobra: 0, no_comprar: 0, sin_movimiento: 0 },
    lideres: productos.filter((f) => f.lider).length, agotados: 1, estancados: 0,
  },
  productos,
  ...over,
});

const ROSA = DE('s-rosa', [
  fila('p-1', { nombre: 'MAZAPAN DE LA ROSA 30G', mes: 90000, veredicto: 'comprar', titulo: 'Comprar: alcanza para 5 días', motivo: 'Agotado en Yurécuaro',
    cobertura_dias: 5, lider: { rank: 2, participacion: 0.02 } }),
  fila('p-2', { nombre: 'PALETA PICOSITA', mes: 15000, veredicto: 'sobra', titulo: 'Sobra', motivo: 'Hay para 120 días', cobertura_dias: 120 }),
  fila('p-3', { nombre: 'BOMBON GIGANTE', mes: 0, variacion: null, veredicto: 'no_comprar', titulo: 'No comprar', motivo: 'No se vende y hay existencia', cobertura_dias: null }),
]);

const tick = async (fix: ComponentFixture<unknown>) => { fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };
const texto = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

type Flujo = Partial<Record<'listar' | 'detalle' | 'cuidar' | 'proveedores' | 'productosProveedor', ReturnType<typeof vi.fn>>>;

async function montar(over: Flujo = {}) {
  const flujo = {
    cuidar: vi.fn(() => of(CUIDAR)),
    proveedores: vi.fn(() => of(PROVEEDORES)),
    productosProveedor: vi.fn((id: string) => of(id === 'sin' ? DE(null, [fila('x-1', { nombre: 'SUELTO' })]) : ROSA)),
    listar: vi.fn(() => of(LISTA([]))),
    detalle: vi.fn(() => NEVER),
    ...over,
  };
  const comercial = {
    listProducts: vi.fn(() => of({ data: [producto('p-9', 'KINDER DELICE')], pagination: { total: 1 } })),
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
  return { fix, comercial, flujo };
}

const filas = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.cp-fila')) as HTMLElement[];
const limpiar = () => { TestBed.resetTestingModule(); try { localStorage.clear(); } catch { /* */ } };

describe('[PF.9] Catálogo por proveedor', () => {
  afterEach(limpiar);

  it('⭐ la barra trae los proveedores por venta, con nombre legible y aparte los sin proveedor', async () => {
    const { fix } = await montar();
    const provs = Array.from(fix.nativeElement.querySelectorAll('.cp-prov')) as HTMLElement[];
    expect(texto(provs[0])).toContain('Sin proveedor asignado');
    expect(texto(provs[0])).toContain('591 productos · 13 vendieron este mes');
    expect(texto(provs[1].querySelector('.cp-prov-nom'))).toBe('Dulces la Rosa');
    expect(texto(provs[2].querySelector('.cp-prov-nom'))).toBe('Barcel');
    expect(texto(provs[2].querySelector('.cp-prov-var'))).toBe('−25%');
  });

  it('⭐ sin elección previa abre el que más vende y pide sus productos', async () => {
    const { fix, flujo } = await montar();
    expect(flujo.productosProveedor).toHaveBeenCalledWith('s-rosa');
    expect(texto(fix.nativeElement.querySelector('.cp-h2'))).toBe('Dulces la Rosa');
    expect(fix.nativeElement.querySelector('.cp-prov.is-on .cp-prov-nom')?.textContent).toBe('Dulces la Rosa');
  });

  it('⭐ cada renglón dice en palabras: nombre, venta del mes, para cuántos días alcanza y qué hacer con el porqué', async () => {
    const { fix } = await montar();
    const [a, , c] = filas(fix);
    expect(texto(a.querySelector('.cp-prod-nom'))).toBe('Mazapan de la Rosa 30G');
    expect(texto(a.querySelector('.cp-tag.is-lider'))).toBe('Líder #2');
    expect(texto(a.querySelector('.cp-mes'))).toContain('$90,000');
    expect(texto(a.querySelector('.cp-cob-txt'))).toBe('5 días');
    expect(texto(a.querySelector('.cp-ver'))).toBe('Comprar');
    expect(texto(a.querySelector('.cp-motivo'))).toBe('Agotado en Yurécuaro');
    // Sin venta no hay ritmo: se dice, no se dibuja una barra vacía.
    expect(texto(c.querySelector('.cp-cob-txt'))).toBe('No se vende');
    expect(c.querySelector('.cp-cob-barra')).toBeNull();
    expect(texto(c.querySelector('.cp-mes'))).toBe('—');
  });

  it('los chips cuentan por situación y filtran; los que no tienen productos no se ofrecen', async () => {
    const { fix } = await montar();
    const chips = () => Array.from(fix.nativeElement.querySelectorAll('.cp-chip')) as HTMLButtonElement[];
    expect(chips().map((c) => texto(c))).toEqual(['Todos 3', 'Comprar 1', 'No comprar 2', 'Líderes 1']);
    chips()[2].click();
    await tick(fix);
    expect(filas(fix).map((f) => texto(f.querySelector('.cp-prod-nom')))).toEqual(['Paleta Picosita', 'Bombon Gigante']);
  });

  it('elegir otro proveedor lo pide, lo recuerda y no muestra los productos del anterior mientras carga', async () => {
    let n = 0;
    const { fix, flujo } = await montar({ productosProveedor: vi.fn((id: string) => (id === 's-rosa' ? of(ROSA) : (n++, NEVER))) });
    (fix.nativeElement.querySelectorAll('.cp-prov')[2] as HTMLButtonElement).click();
    // El nuevo nunca llega (NEVER): whenStable no se cumpliría; basta con pintar.
    fix.detectChanges();
    await Promise.resolve();
    fix.detectChanges();
    expect(flujo.productosProveedor).toHaveBeenLastCalledWith('s-barcel');
    expect(filas(fix)).toHaveLength(0);
    expect(fix.nativeElement.querySelectorAll('.cp-sk').length).toBeGreaterThan(0);
    expect(localStorage.getItem('compras.catalogo.proveedor')).toBe('s-barcel');
  });

  it('⛔ si falla la carga del proveedor, lo dice (no una tabla vacía que parezca "sin productos")', async () => {
    const { fix } = await montar({ productosProveedor: vi.fn(() => throwError(() => new Error('x'))) });
    expect(fix.nativeElement.textContent).toContain('No se pudieron cargar los productos de este proveedor');
  });

  it('⭐ una recarga que falla no borra lo que ya se veía', async () => {
    let n = 0;
    const { fix, flujo } = await montar({ productosProveedor: vi.fn(() => (++n === 1 ? of(ROSA) : throwError(() => new Error('x')))) });
    fix.componentInstance.refresh();
    await tick(fix);
    expect(flujo.productosProveedor).toHaveBeenCalledTimes(2);
    expect(filas(fix)).toHaveLength(3);
  });

  it('los sin proveedor se avisan como lo que son: nadie los está pidiendo', async () => {
    const { fix } = await montar();
    (fix.nativeElement.querySelector('.cp-prov.is-sin') as HTMLButtonElement).click();
    await tick(fix);
    expect(texto(fix.nativeElement.querySelector('.cp-h2'))).toBe('Sin proveedor asignado');
    expect(fix.nativeElement.querySelector('.cp-alerta-sin')?.textContent).toContain('nadie los está pidiendo');
  });

  it('⭐ el clic en el renglón abre el panel del producto con su proveedor; editar va dentro', async () => {
    const { fix, flujo, comercial } = await montar();
    filas(fix)[0].click();
    fix.detectChanges();
    expect(fix.componentInstance.abierto()).toEqual({ id: 'p-1', nombre: 'Mazapan de la Rosa 30G', sku: 'P-1', proveedor: 'Dulces la Rosa' });
    expect(flujo.detalle).toHaveBeenCalledWith('p-1');
    expect(comercial.findProduct).not.toHaveBeenCalled();
    fix.componentInstance.openEdit('p-1');
    expect(comercial.findProduct).toHaveBeenCalledWith('p-1');
  });

  it('[PF.5] con permiso de costo sale la columna de margen con su cobertura; sin permiso no', async () => {
    const conCosto = DE('s-rosa', [fila('p-1', { margen_real: { pct: 13.6, cobertura: 0.64 } }), fila('p-2', { margen_real: null })], { costo_visible: true });
    const { fix } = await montar({ productosProveedor: vi.fn(() => of(conCosto)) });
    const th = Array.from(fix.nativeElement.querySelectorAll('.cp-th [role=columnheader]')).map((t) => texto(t as Element));
    expect(th).toContain('Margen');
    expect(texto(filas(fix)[0].querySelector('.cp-margen'))).toBe('13.6%');
    expect(filas(fix)[0].textContent).toContain('cubre 64%');
    limpiar();
    const sin = await montar();
    expect(Array.from(sin.fix.nativeElement.querySelectorAll('.cp-th [role=columnheader]')).map((t) => texto(t as Element))).not.toContain('Margen');
  });
});

describe('[PF.9] Buscar en todo el catálogo', () => {
  afterEach(limpiar);

  it('⭐ con texto, la tabla muestra lo encontrado con su flujo (no el proveedor)', async () => {
    vi.useFakeTimers();
    try {
      const { fix, comercial, flujo } = await montar({ listar: vi.fn(() => of(LISTA([
        resumen('p-9', { agotadas: [{ plaza: '04', nombre: 'Yurécuaro', venta_dia: 10 }] }),
      ]))) });
      fix.componentInstance.onBusqueda('kinder');
      vi.advanceTimersByTime(1000);
      vi.useRealTimers();
      await tick(fix);
      expect(comercial.listProducts).toHaveBeenCalledWith({ page: 1, pageSize: 50, search: 'kinder' });
      expect(flujo.listar).toHaveBeenCalledWith(['p-9']);
      expect(texto(fix.nativeElement.querySelector('.cp-h2'))).toBe('Resultados de «kinder»');
      expect(filas(fix).map((f) => texto(f.querySelector('.cp-prod-nom')))).toEqual(['Kinder Delice']);
      expect(texto(filas(fix)[0].querySelector('.cp-motivo'))).toBe('Agotado en 1');
      fix.componentInstance.limpiarBusqueda();
      await tick(fix);
      expect(texto(fix.nativeElement.querySelector('.cp-h2'))).toBe('Dulces la Rosa');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('[PF.2]/[PF.4] Para cuidar hoy: líderes de un lado, lo que no se vende del otro', () => {
  afterEach(limpiar);
  const enCuidar = async (over: Flujo = {}) => {
    const r = await montar(over);
    r.fix.componentInstance.vista.set('cuidar');
    await tick(r.fix);
    return r;
  };
  const tarjetas = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.pc-card')) as HTMLElement[];

  it('es una vista aparte: no estorba al trabajo por proveedor', async () => {
    const { fix } = await montar();
    // El número de la pestaña: 2 líderes con motivo + 1 que caduca (no los 245 líderes).
    expect(texto(fix.nativeElement.querySelector('.cp-seg-n'))).toBe('3');
    expect(tarjetas(fix)).toHaveLength(0);
    fix.componentInstance.vista.set('cuidar');
    await tick(fix);
    expect(tarjetas(fix).map((t) => texto(t.querySelector('.pc-t')))).toEqual(['Líderes', 'No se venden']);
    expect(fix.nativeElement.querySelector('.cp-rail')).toBeNull();
  });

  it('⭐ los líderes, TODOS y por su lugar, con su venta del mes y lo que piden', async () => {
    const { fix } = await enCuidar();
    const [lid] = tarjetas(fix);
    expect(texto(lid.querySelector('.pc-n'))).toBe('245 productos hacen la mitad de la venta');
    const items = Array.from(lid.querySelectorAll('.pc-item')) as HTMLElement[];
    expect(items.map((i) => i.querySelector('.pc-rank')?.textContent)).toEqual(['#2', '#7']);
    expect(texto(items[0].querySelector('.pc-nom'))).toBe('Mazapan');
    expect(items[0].textContent).toContain('Agotado en Yurécuaro');
    expect(texto(items[0].querySelector('.pc-dinero'))).toContain('+25% este mes');
  });

  it('el filtro de líderes por motivo; los motivos sin líderes no se ofrecen', async () => {
    const { fix } = await enCuidar();
    const [lid] = tarjetas(fix);
    const chips = Array.from(lid.querySelectorAll('.pc-chip')) as HTMLButtonElement[];
    expect(chips.map((c) => texto(c))).toEqual(['Todos · 2', 'Agotado en alguna sucursal · 1', 'Comprar · 1']);
    chips[2].click();
    fix.detectChanges();
    expect(Array.from(lid.querySelectorAll('.pc-rank')).map((r) => r.textContent)).toEqual(['#7']);
  });

  it('⭐ lo que no se vende: cuánto lleva sin venderse, dónde hay, en cajas, y si además caduca', async () => {
    const { fix } = await enCuidar();
    const [, nv] = tarjetas(fix);
    expect(texto(nv.querySelector('.pc-n'))).toBe('3 productos');
    const items = Array.from(nv.querySelectorAll('.pc-item')) as HTMLElement[];
    expect(texto(items[0].querySelector('.pc-sin'))).toBe('Sin una venta en el último año');
    expect(items[0].textContent).toContain('Hay en Padre Hidalgo');
    expect(texto(items[0].querySelector('.pc-dinero'))).toBe('2 cajas y 10 piezas');
    expect(texto(items[1].querySelector('.pc-cad'))).toBe('No alcanza a venderse en Canindo');
  });

  it('el filtro por tramo; y «Caducan antes de venderse» muestra los lotes con su fecha y la cobertura', async () => {
    const { fix } = await enCuidar();
    const [, nv] = tarjetas(fix);
    const chips = () => Array.from(nv.querySelectorAll('.pc-chip')) as HTMLButtonElement[];
    expect(chips().map((c) => texto(c))).toEqual(['Todos · 3', '30 a 89 días · 1', 'Sin venta en el año · 2', 'Caducan antes de venderse · 1']);
    chips()[1].click();
    fix.detectChanges();
    expect(Array.from(nv.querySelectorAll('.pc-nom')).map((n) => n.textContent)).toEqual(['Pelota']);
    chips()[3].click();
    fix.detectChanges();
    const item = nv.querySelector('.pc-item') as HTMLElement;
    expect(texto(item.querySelector('.pc-cad'))).toBe('No alcanza a venderse en Padre Hidalgo');
    expect(texto(item.querySelector('.pc-fecha'))).toContain('en 25 días');
    expect(texto(nv.querySelector('.pc-meta'))).toContain('60 lotes de 60 productos en CEDIS, Padre Hidalgo');
  });

  it('⭐ el clic abre el mismo panel del producto', async () => {
    const { fix, flujo } = await enCuidar();
    (tarjetas(fix)[1].querySelector('.pc-item') as HTMLElement).click();
    fix.detectChanges();
    expect(fix.componentInstance.abierto()).toEqual({ id: 'n-1', nombre: 'Bota Tutsi', sku: '90037' });
    expect(flujo.detalle).toHaveBeenCalledWith('n-1');
  });

  it('[PF.6] dice si salió de la foto del servidor o del cálculo en vivo', async () => {
    const foto = await enCuidar({ cuidar: vi.fn(() => of({ ...CUIDAR, origen: { fuente: 'foto' as const, calculado_at: '2026-10-09T18:05:00-06:00' } })) });
    expect(texto(foto.fix.nativeElement.querySelector('.pc-origen'))).toMatch(/^Calculado a las .*se actualiza cada minuto\.$/);
    limpiar();
    const vivo = await enCuidar({ cuidar: vi.fn(() => of({ ...CUIDAR, origen: { fuente: 'en_vivo' as const, calculado_at: '2026-10-09T18:05:00-06:00' } })) });
    const el = vivo.fix.nativeElement.querySelector('.pc-origen') as HTMLElement;
    expect(el.classList).toContain('is-vivo');
    expect(el.textContent).toContain('la foto del servidor no está al día');
  });

  it('[negativa] si falla, lo dice; el catálogo por proveedor sigue', async () => {
    const { fix } = await enCuidar({ cuidar: vi.fn(() => throwError(() => new Error('x'))) });
    expect(tarjetas(fix)).toHaveLength(0);
    expect(fix.nativeElement.textContent).toContain('No se pudo cargar «Para cuidar hoy»');
    fix.componentInstance.vista.set('proveedor');
    await tick(fix);
    expect(filas(fix)).toHaveLength(3);
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

describe('[PF.1] alertas', () => {
  it('dice en cuántas sucursales está estancado, agotado o se frenó; si todo se mueve, nada', () => {
    expect(alertasTexto({ estancadas: [], agotadas: [], frenadas: [] })).toBeNull();
    expect(alertasTexto({ estancadas: [{ plaza: '06', nombre: null, dias_sin_venta: 20 }], agotadas: [],
      frenadas: [{ plaza: '01', nombre: null, variacion: -0.6 }] })).toBe('Estancado en 1 · Se frenó en 1');
  });
});
