import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Observable, Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { CatalogoProductosService, FichaProducto } from '../catalogo-productos.service';
import { ProductoFichaComponent, armarFicha } from './producto-ficha.component';
import { ProductosNuevosService } from '../productos-nuevos.service';
import { DETALLE as DETALLE_NUEVO } from '../../../../testing/productos-nuevos.fixture';

/** [NP.22] Por default el producto NO es nuevo (404): la sección «Lanzamiento» no pinta nada. */
const NO_NUEVO = () => throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }));

// Mazapán: base PAQ, caja de 20 PAQ.
const FICHA: FichaProducto = {
  id: 'p-1', sku: '70001', nombre: 'MAZAPAN DE LA ROSA 30G', descripcion: null, activo: true,
  proveedor: { id: 'pr-1', nombre: 'DULCES DE LA ROSA SA DE CV' },
  codigos: ['7501234567890', '7509999999999'],
  unidadBase: 'PAQ',
  unidades: [
    { unidad: 'PAQ', equivale: null, factorBase: 1, precio: 84.5, mayoreo: { precio: 80.47, desde: 3 } },
    { unidad: 'CJA', equivale: { cantidad: 20, unidad: 'PAQ' }, factorBase: 20, precio: null, mayoreo: null },
  ],
  precioRed: { sucursales: 8, min: 84.5, max: 84.5 },
  sucursales: [
    { codigo: '01', nombre: 'PADRE HIDALGO', vendidoMes: { monto: 12000, unidadesBase: 142 }, existenciaBase: 1305 },
    { codigo: '04', nombre: 'YURECUARO', vendidoMes: { monto: 3000, unidadesBase: 35 }, existenciaBase: 0 },
    { codigo: '06', nombre: 'CANINDO', vendidoMes: null, existenciaBase: null },
  ],
  corteVenta: '2026-10-25',
  ultimaEntrada: { sucursal: '01', nombreSucursal: 'PADRE HIDALGO', fecha: '2026-10-21', cantidad: 40, unidad: 'CJA', costo: null },
  costo_visible: false,
  calculado_al: '2026-10-26T15:00:00.000Z',
};

const tick = async (fix: ComponentFixture<unknown>) => {
  for (let i = 0; i < 3; i++) { fix.detectChanges(); await fix.whenStable(); }
  fix.detectChanges();
};

async function montar(ficha: (id: string, suc?: string | null) => Observable<FichaProducto>, nuevo: () => Observable<unknown> = NO_NUEVO) {
  await TestBed.configureTestingModule({
    imports: [ProductoFichaComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CatalogoProductosService, useValue: { ficha: vi.fn(ficha), lista: vi.fn() } },
      { provide: ProductosNuevosService, useValue: { detalle: vi.fn(nuevo), listar: vi.fn() } }],
  }).compileComponents();
  const fix = TestBed.createComponent(ProductoFichaComponent);
  fix.componentRef.setInput('productId', 'p-1');
  await tick(fix);
  return fix;
}
const texto = (fix: ComponentFixture<unknown>) => (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';

describe('ficha de producto (Sencillo)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ [PF.23] «Última entrada» va arriba (junto al Último costo), antes de «Unidades y precio»; el CEDIS se nombra', async () => {
    const fix = await montar(() => of({ ...FICHA, ultimaEntrada: { ...FICHA.ultimaEntrada!, sucursal: '00', nombreSucursal: null } }));
    const el = fix.nativeElement as HTMLElement;
    const titulos = Array.from(el.querySelectorAll('.bloque-t')).map((h) => h.textContent!.trim());
    expect(titulos.indexOf('Última entrada')).toBeGreaterThanOrEqual(0);
    expect(titulos.indexOf('Última entrada')).toBeLessThan(titulos.indexOf('Unidades y precio'));
    const ent = el.querySelector('[aria-labelledby="ficha-ent-t"]')!.textContent!.replace(/\s+/g, ' ');
    expect(ent).toContain('CEDIS');
    expect(ent).not.toContain('Sucursal 00');
    // [negativa] con nombre del servidor, se usa ése.
    TestBed.resetTestingModule();
    const fix2 = await montar(() => of(FICHA));
    expect((fix2.nativeElement as HTMLElement).querySelector('[aria-labelledby="ficha-ent-t"]')!.textContent).toContain('Padre Hidalgo');
  });

  it('⭐ [PF.23] opción A: en un producto NUEVO la tabla por sucursal no se repite; sus tarjetas traen la venta del periodo', async () => {
    const fix = await montar(() => of(FICHA), () => of(DETALLE_NUEVO));
    const el = fix.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Venta y existencia por sucursal');
    expect(el.querySelector('[aria-labelledby="ficha-suc-t"]')).toBeNull();
    const tarjetas = Array.from(el.querySelectorAll('.lz-sucs > li')).map((li) => li.textContent!.replace(/\s+/g, ' '));
    const ph = tarjetas.find((t) => t.includes('Padre Hidalgo'))!;
    expect(ph).toMatch(/En el periodo\s*\$12,000\.00/);
    expect(ph).toContain('Desde que llegó');
    // El calendario de arriba sigue mandando: su nota sigue diciendo a qué aplica.
    expect(el.querySelector('.periodo-top app-periodo-ficha')).not.toBeNull();
    // [negativa] un producto que NO es nuevo conserva su tabla, y no hay «En el periodo» de tarjetas.
    TestBed.resetTestingModule();
    const otro = await montar(() => of(FICHA));
    const el2 = otro.nativeElement as HTMLElement;
    expect(el2.textContent).toContain('Venta y existencia por sucursal');
    expect(el2.textContent).not.toContain('En el periodo');
  });

  it('⭐ [NP.22] un producto nuevo trae «Lanzamiento» después de «Unidades y precio»; [negativa] uno que no lo es (404), nada', async () => {
    const fix = await montar(() => of(FICHA), () => of(DETALLE_NUEVO));
    const el = fix.nativeElement as HTMLElement;
    const lz = el.querySelector('app-producto-lanzamiento .lz')!;
    expect(lz).not.toBeNull();
    expect(lz.textContent).toContain('Cortes de 30, 60 y 90 días');
    expect(lz.querySelectorAll('.lz-corte').length).toBe(3);
    // Sencillo no tiene «Qué hacer»: no se inventa un cruce con la compra.
    expect(lz.textContent).not.toContain('Antes de reponer');
    TestBed.resetTestingModule();
    const otro = await montar(() => of(FICHA));
    expect((otro.nativeElement as HTMLElement).querySelector('app-producto-lanzamiento .lz')).toBeNull();
  });

  it('pinta la identidad: SKU copiable, estado, todos los códigos con el principal, proveedor legible', async () => {
    const fix = await montar(() => of(FICHA));
    const t = texto(fix);
    expect(t).toContain('70001');
    expect(t).toContain('copiar');
    expect(t).toContain('Activo');
    expect(t).toContain('Códigos de barras');
    expect(t).toContain('7501234567890 principal');
    expect(t).toContain('7509999999999');
    expect(t).toContain('Dulces de la Rosa');
    expect(t).not.toMatch(/SA DE CV/i);
    expect(t).not.toContain('Descripción');
  });

  it('unidades: precio, mayoreo «desde» y «Sin precio» donde no hay lista (nunca $0)', async () => {
    const fix = await montar(() => of(FICHA));
    const t = texto(fix);
    expect(t).toContain('unidad base');
    expect(t).toContain('20 PAQ');
    expect(t).toMatch(/\$84\.50/);
    expect(t).toMatch(/\$80\.47\s*desde 3/);
    expect(t).toContain('Sin precio');
    expect(t).not.toMatch(/\$0\.00/);
    expect(t).toContain('Mismo precio en las 8 sucursales');
  });

  it('existencia compuesta, Agotado si vendió sin existencia, Sin dato si no se midió', async () => {
    const fix = await montar(() => of(FICHA));
    const t = texto(fix);
    expect(t).toMatch(/65 CJA\s*5 PAQ/);
    expect(t).toMatch(/7 CJA\s*2 PAQ/); // vendido 142 PAQ
    expect(t).toContain('Agotado');
    expect(t).toContain('Sin dato');
    expect(t).toContain('Total');
    expect(t).toContain('La existencia total no incluye 1 sucursal sin dato: Canindo');
    expect(t).toContain('Agotado en 1 sucursal que sí lo vende');
  });

  it('⭐ [PF.23] venta por periodo: dice el periodo, la falta de una sucursal en el total y POR QUÉ no tiene dato (nunca $0)', async () => {
    const ficha = vi.fn((_id: string, _suc?: string | null, p?: { desde: string; hasta: string } | null) => of({
      ...FICHA,
      periodo: p ?? { desde: '2026-11-01', hasta: '2026-11-04' },
      sucursales: [
        { ...FICHA.sucursales[0] },
        { codigo: '06', nombre: 'CANINDO', vendidoMes: null, existenciaBase: 3, corteKepler: '2026-08-15', sinCorte: false },
        { codigo: '09', nombre: 'NUEVA', vendidoMes: null, existenciaBase: null, corteKepler: null, sinCorte: true },
      ],
    } as FichaProducto));
    const fix = await montar(ficha as unknown as (id: string) => Observable<FichaProducto>);
    let t = texto(fix);
    expect(t).toContain('Vendido del 1 nov 2026 al 4 nov 2026');
    expect(t).toContain('la existencia es la de hoy');
    expect(t).toContain('Sin dato: en Kepler desde el 15 ago 2026');
    expect(t).toContain('Sin dato: sin corte a Kepler');
    expect(t).toContain('La venta total no incluye 2 sucursales sin dato en el periodo: Canindo, Nueva');
    expect(t).not.toContain('Vendido este mes');
    // Por omisión no manda fechas (el servidor usa el mes en curso).
    expect(ficha).toHaveBeenCalledWith('p-1', null);
    // Elegir otro periodo lo pide, SIN desmontar la ficha mientras la respuesta viene en camino: si se desmontara,
    // el selector renacería en «Este mes» con los datos de otro periodo. La respuesta se queda PENDIENTE a propósito
    // (con `of` la recarga es instantánea y la prueba no ve el hueco: así pasó en verde sin la retención).
    const pendiente = new Subject<FichaProducto>();
    const base = ficha.getMockImplementation()!;
    ficha.mockImplementation((id, suc, p) => (p ? pendiente.asObservable() : base(id, suc, p)));
    const sel = fix.debugElement.query((d) => d.name === 'app-periodo-ficha');
    (sel.componentInstance as { cambio: { emit: (p: unknown) => void } }).cambio.emit({ desde: '2025-01-01', hasta: '2025-12-31' });
    // Con la respuesta pendiente la página nunca «se estabiliza»: se pinta a mano (tick esperaría para siempre).
    for (let i = 0; i < 3; i++) { fix.detectChanges(); await Promise.resolve(); }
    expect(ficha).toHaveBeenLastCalledWith('p-1', null, { desde: '2025-01-01', hasta: '2025-12-31' });
    expect(fix.debugElement.query((d) => d.name === 'app-periodo-ficha')?.componentInstance).toBe(sel.componentInstance);
    expect(texto(fix)).toContain('Vendido del 1 nov 2026 al 4 nov 2026'); // lo anterior sigue a la vista…
    expect(fix.nativeElement.querySelector('[aria-labelledby="ficha-suc-t"]')?.getAttribute('aria-busy')).toBe('true'); // …marcado
    pendiente.next({ ...FICHA, periodo: { desde: '2025-01-01', hasta: '2025-12-31' } } as FichaProducto);
    pendiente.complete();
    await tick(fix);
    t = texto(fix);
    expect(t).toContain('Vendido del 1 ene 2025 al 31 dic 2025');
  });

  it('⛔ [PF.23] [negativa] con todas las sucursales medibles NO aparece el aviso de faltantes en el total', async () => {
    const fix = await montar(() => of({ ...FICHA, sucursales: FICHA.sucursales.filter((s) => s.vendidoMes) }));
    expect(texto(fix)).not.toContain('La venta total no incluye');
  });

  it('⭐ [PF.22] Último costo por paquete Y por caja (como el renglón); sin escalera, sólo el de la entrada', async () => {
    const porUnidad = [
      { unidad: 'PAQ', costo: 52.68, precioSinImpuestos: null, bajoCosto: null },
      { unidad: 'CJA', costo: 1053.6, precioSinImpuestos: null, bajoCosto: null },
    ];
    const fix = await montar(() => of({ ...FICHA, costo_visible: true,
      ultimaEntrada: { ...FICHA.ultimaEntrada!, unidad: 'PAQ', costo: 52.68, impuesto: 'descontado', porUnidad } }));
    expect(texto(fix)).toMatch(/Último costo\s*\$52\.68 por PAQ\s*\$1,053\.60 por CJA\s*sin IVA ni IEPS/);
    // [negativa] sin conversión (porUnidad vacío): sólo el de la entrada, en su unidad; nunca un costo inventado.
    TestBed.resetTestingModule();
    const fix2 = await montar(() => of({ ...FICHA, costo_visible: true,
      ultimaEntrada: { ...FICHA.ultimaEntrada!, unidad: 'PAQ', costo: 52.68, impuesto: 'descontado', porUnidad: [] } }));
    expect(texto(fix2)).toMatch(/Último costo\s*\$52\.68 por PAQ/);
    expect(texto(fix2)).not.toContain('por CJA');
  });

  it('⭐ [PF.20] Estado: «Descontinuado» manda sobre «Activo» cuando Kepler lo marcó en el nombre', async () => {
    const fix = await montar(() => of({ ...FICHA, nombre: '* DESCONTINUADO', activo: true }));
    expect(texto(fix)).toMatch(/Estado\s*Descontinuado/);
    expect(texto(fix)).not.toMatch(/Estado\s*Activo/);
    // [negativa] el producto normal sigue «Activo».
    TestBed.resetTestingModule();
    const fix2 = await montar(() => of(FICHA));
    expect(texto(fix2)).toMatch(/Estado\s*Activo/);
    expect(texto(fix2)).not.toContain('Descontinuado');
  });

  it('oculta el costo de la última entrada si el servidor no lo deja ver; si lo deja, sin IVA ni IEPS (sin candado)', async () => {
    const fix = await montar(() => of(FICHA));
    expect(texto(fix)).toContain('Última entrada');
    expect(texto(fix)).toContain('40 CJA');
    expect(texto(fix)).not.toContain('Último costo');
    TestBed.resetTestingModule();
    const fix2 = await montar(() => of({ ...FICHA, costo_visible: true, ultimaEntrada: { ...FICHA.ultimaEntrada!, costo: 312.4, impuesto: 'descontado' } }));
    expect(texto(fix2)).toMatch(/Último costo\s*\$312\.40 por CJA/);
    expect(texto(fix2)).toMatch(/\$312\.40 por CJA\s*sin IVA ni IEPS/);
    // `[PF.12.3]` Ya no es «sólo con permiso de costo»: lo ve quien ve el catálogo (la regla de la lista).
    expect(texto(fix2)).not.toContain('sólo con permiso de costo');
  });

  it('⛔ [PF.12.3] con permiso pero sin costo en la entrada lo dice (nunca $0); sin tasa, dice que no se sabe el impuesto', async () => {
    const fix = await montar(() => of({ ...FICHA, costo_visible: true, ultimaEntrada: { ...FICHA.ultimaEntrada!, costo: null, impuesto: 'neto' } }));
    expect(texto(fix)).toMatch(/Último costo\s*Sin costo en la entrada/);
    expect(texto(fix)).not.toMatch(/\$0\.00/);
    const v = armarFicha({ ...FICHA, costo_visible: true, ultimaEntrada: { ...FICHA.ultimaEntrada!, costo: 50, impuesto: 'sin_dato' } });
    expect(v.entrada?.costoNota).toBe('sin saber si trae impuestos');
    expect(v.costoVisible).toBe(true);
  });

  it('estado de error: lo dice y ofrece reintentar, sin pintar una ficha vacía', async () => {
    const fix = await montar(() => throwError(() => ({ status: 500, error: { message: 'boom' } })));
    const t = texto(fix);
    expect(t).toContain('No se pudo cargar la ficha del producto');
    expect(t).toContain('Reintentar');
    expect(t).not.toContain('Unidades y precio');
  });

  it('armarFicha: precio que varía, inactivo, sin código y sin entrada', () => {
    const v = armarFicha({ ...FICHA, activo: false, codigos: [], ultimaEntrada: null, precioRed: { sucursales: 8, min: 80, max: 90 } });
    expect(v.activo).toBe(false);
    expect(v.codigos).toEqual([]);
    expect(v.entrada).toBeNull();
    expect(v.red.tipo).toBe('varia');
    expect(v.red.texto).toMatch(/Varía entre sucursales: \$80\.00 a \$90\.00/);
  });
});
