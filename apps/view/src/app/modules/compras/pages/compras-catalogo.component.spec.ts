import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ProductosFlujoService } from '../productos-flujo.service';
import { ProductosNuevosService } from '../productos-nuevos.service';
import { RESPUESTA } from '../../../../testing/productos-nuevos.fixture';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { CatalogoLista, CatalogoListaDetallada, CatalogoProductosService } from '../catalogo-productos.service';
import { ComprasCatalogoComponent, celdaCosto, claveVista, equivaleTexto, listaSencilloDeDetallado, siguienteOrden, vacioNuevos } from './compras-catalogo.component';

const tick = async (fix: ComponentFixture<unknown>) => { fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };
const texto = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** La lista de Sencillo como la manda el servidor (conteos de la búsqueda entera). */
const LISTA_S = (over: Partial<CatalogoLista> = {}): CatalogoLista => ({
  sucursal: '01', total: 2, calculado_al: '2026-10-26T18:00:00Z', mostrar: 'todos',
  conteos: { todos: 2, variosCodigos: 1, sinCodigo: 0, sinPrecio: 1, nuevos: 1 },
  filas: [
    { id: 'q-1', sku: '70001', nombre: 'LA ROSA MAZAPAN /30', proveedor: { id: 's-rosa', nombre: 'DISTRIBUIDORA DE LA ROSA SA DE CV' },
      nCodigos: 1, razon: null,
      unidades: [
        { unidad: 'PAQ', equivale: null, factorBase: 1, precio: 87.14, mayoreo: null },
        { unidad: 'CJA', equivale: { cantidad: 20, unidad: 'PAQ' }, factorBase: 20, precio: 1594.96, mayoreo: null },
      ] },
    { id: 'q-2', sku: '17083', nombre: 'ALTOS CAM CHICA COLOR 1KG', proveedor: null, nCodigos: 2, razon: 'código de barras adicional 4510000170833',
      unidades: [
        { unidad: 'KG', equivale: null, factorBase: 1, precio: 63.99, mayoreo: null },
        { unidad: 'BTO', equivale: { cantidad: 20, unidad: 'KG' }, factorBase: 20, precio: null, mayoreo: null },
      ] },
  ],
  ...over,
});

const CONTEOS_D: CatalogoListaDetallada['conteos'] = {
  comprar: null, traspasar: null, esperar: null, sobra: null, no_comprar: null,
  lideres_pendiente: 51, no_se_venden: 300, caducidad: 5, nuevos: 140,
  todos: 3, varios_codigos: 1, sin_codigo: 0, sin_precio: null, sin_proveedor: 1,
};
const NOTA_GRANDE = 'Busca un proveedor, una marca o un producto: se calcula para 200 productos o menos (la búsqueda tiene 11,008)';

/** La lista de Detallado: las mismas filas de Sencillo + venta del mes y etiquetas. */
const LISTA_D = (over: Partial<CatalogoListaDetallada> = {}): CatalogoListaDetallada => {
  const [a, b] = LISTA_S().filas;
  return {
    vista: 'detallado', sucursal: '01', total: 3, calculado_al: '2026-10-26T18:00:00Z', mostrar: 'todos', orden: 'mes', dir: 'desc',
    conteos: CONTEOS_D,
    notas: { comprar: NOTA_GRANDE, traspasar: NOTA_GRANDE, esperar: NOTA_GRANDE, sobra: NOTA_GRANDE, no_comprar: NOTA_GRANDE,
      sin_precio: 'No se puede medir: esta base no tiene el precio por sucursal', no_se_venden: 'Los 300 de más dinero detenido, de 969 en la red' },
    venta: { medida: true, calculado_al: '2026-10-26T17:59:00Z', periodos: { hoy: '2026-10-26', mesIni: '2026-10-01', prevIni: '2026-09-01', prevFin: '2026-09-27', dias: 26 } },
    etiquetas: { lider: true, caducidad: true, nuevo: true },
    cuidar: { fuente: 'foto', calculado_at: '2026-10-26T17:59:00Z' },
    filas: [
      { ...a, mes: 138483, mesAnterior: 261288, variacion: -0.47, lider: 4, nuevo: null, caducidad: 'caducado' },
      { ...b, mes: 0, mesAnterior: 0, variacion: null, lider: null, nuevo: 'Nuevo · día 12', caducidad: null },
      { ...a, id: 'q-3', sku: '99940', nombre: 'SET WEATHER STORM / 1 ROSI', mes: null, mesAnterior: null, variacion: null, lider: null, nuevo: null, caducidad: 'pronto' },
    ],
    ...over,
  };
};

/** Monta en Sencillo (modo null: sin elección previa) o en Detallado. */
async function montar(_over: Record<string, never> = {}, opts: {
  modo?: 'sencillo' | 'detallado' | null; lista?: ReturnType<typeof vi.fn>; detallado?: ReturnType<typeof vi.fn>;
  /** [NP.22] La URL con la que se entra (p. ej. ?mostrar=nuevos). */
  url?: string; nuevos?: ReturnType<typeof vi.fn>;
} = {}) {
  const modo = opts.modo === undefined ? 'detallado' : opts.modo;
  if (modo) localStorage.setItem(claveVista('u-1'), modo);
  const catalogo = {
    lista: opts.lista ?? vi.fn(() => of(LISTA_S())),
    detallado: opts.detallado ?? vi.fn(() => of(LISTA_D())),
    ficha: vi.fn(() => NEVER as unknown as ReturnType<CatalogoProductosService['ficha']>),
    compras: vi.fn(() => NEVER),
  };
  const flujo = { detalle: vi.fn(() => NEVER), margenes: vi.fn(() => NEVER) };
  await TestBed.configureTestingModule({
    imports: [ComprasCatalogoComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: ProductosFlujoService, useValue: flujo },
      { provide: CatalogoProductosService, useValue: catalogo },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u-1', permissions: { COMMERCIAL_PRODUCTS_VER: true } }) } },
      { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => true } },
      { provide: ProductosNuevosService, useValue: { listar: opts.nuevos ?? vi.fn(() => of(RESPUESTA)), detalle: vi.fn(() => NEVER) } },
    ],
  }).compileComponents();
  if (opts.url) await TestBed.inject(Router).navigateByUrl(opts.url);
  const fix = TestBed.createComponent(ComprasCatalogoComponent);
  await tick(fix);
  return { fix, flujo, catalogo };
}

const limpiar = () => { TestBed.resetTestingModule(); try { localStorage.clear(); } catch { /* */ } };

describe('Detallado (rediseño aprobado): lo de Sencillo + Este mes, etiquetas y «Mostrar» de compra', () => {
  afterEach(limpiar);
  const filasD = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.cd .cs-fila')) as HTMLElement[];
  const opciones = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.cs-op')) as HTMLButtonElement[];
  const abrirMostrar = async (fix: ComponentFixture<ComprasCatalogoComponent>) => {
    (fix.nativeElement.querySelector('.cs-sel') as HTMLButtonElement).click();
    await tick(fix);
  };

  it('⭐ pide la lista al servidor (vista=detallado, lo que más vende primero) y quita lo que el usuario pidió quitar', async () => {
    const { fix, catalogo } = await montar();
    const el = fix.nativeElement as HTMLElement;
    expect(catalogo.detallado).toHaveBeenCalledWith({ search: '', mostrar: 'todos', orden: 'mes', dir: 'desc', page: 1, pageSize: 50 });
    expect(catalogo.lista).not.toHaveBeenCalled();
    // Quitados: renglón de conteos, aviso BASE-MXN, barra de proveedores, selector Por proveedor / Para cuidar hoy.
    for (const sel of ['.surf-page-sub', '.cp-aviso', '.cp-rail', '.cp-seg', '[role="tablist"]', 'app-producto-flujo-panel']) expect(el.querySelector(sel)).toBeNull();
    expect(texto(el.querySelector('.cp-vista-btn'))).toBe('Sencillo');
    expect(el.querySelector('.cp-buscar input')).not.toBeNull();
  });

  it('⭐ columnas: Producto, Proveedor, Unidades, Precio y Este mes — sin Alcanza para, Margen ni Qué hacer', async () => {
    const { fix } = await montar();
    const ths = Array.from(fix.nativeElement.querySelectorAll('.cd thead th')).map((th) => texto(th as Element));
    expect(ths).toEqual(['Producto', 'Proveedor', 'Unidades de medida', 'Precio', 'Este mes']);
  });

  it('⭐ el renglón: nombre + SKU + etiquetas, y las MISMAS celdas de unidades y precio que Sencillo', async () => {
    const { fix } = await montar();
    const [a, b, c] = filasD(fix);
    expect(texto(a.querySelector('.cs-nom'))).toBe('La Rosa Mazapan /30');
    expect(texto(a.querySelector('.cs-sku'))).toBe('70001');
    expect(Array.from(a.querySelectorAll('.cd-tag')).map((t) => texto(t))).toEqual(['Top venta #4', 'Caducado']);
    expect(Array.from(b.querySelectorAll('.cd-tag')).map((t) => texto(t))).toEqual(['Nuevo · día 12']);
    expect(Array.from(c.querySelectorAll('.cd-tag')).map((t) => texto(t))).toEqual(['Caduca pronto']);
    expect(texto(a.querySelector('.cs-prov'))).toBe('Distribuidora de la Rosa');
    expect(Array.from(a.querySelectorAll('.cs-ud .cs-lin')).map((l) => texto(l.querySelector('.cs-chip')) + ' ' + texto(l.querySelector('.cs-eq'))))
      .toEqual(['PAQ base', 'CJA 20 PAQ']);
    expect(Array.from(b.querySelectorAll('.cs-pre .cs-lin')).map((l) => texto(l))).toEqual(['$63.99', 'Sin precio']);
    expect(texto(b.querySelector('.cs-razon'))).toBe('Coincide por código de barras adicional 4510000170833');
  });

  it('⭐ Este mes: monto y ▲▼% contra los mismos días; ⛔ sin venta y sin dato se dicen, nunca $0', async () => {
    const { fix } = await montar();
    const [a, b, c] = filasD(fix);
    expect(texto(a.querySelector('.cd-mes-v'))).toBe('$138,483');
    expect(texto(a.querySelector('.cd-var'))).toBe('▼ 47%');
    expect(a.querySelector('.cd-var--baja')).not.toBeNull();
    expect(a.querySelector('.cd-mes')?.getAttribute('title')).toBe('Contra los mismos días de septiembre (1 al 26): $261,288');
    expect(texto(b.querySelector('.cd-mes'))).toBe('Sin venta');
    expect(texto(c.querySelector('.cd-mes'))).toBe('Sin dato');
    for (const f of [b, c]) expect(texto(f.querySelector('.cd-mes'))).not.toContain('$0');
  });

  it('⭐ orden por columna con aria-sort: Este mes se invierte, Producto empieza de la A; vuelve a la página 1', async () => {
    const { fix, catalogo } = await montar();
    const [thProd, , , , thMes] = Array.from(fix.nativeElement.querySelectorAll('.cd thead th')) as HTMLElement[];
    expect(thMes.getAttribute('aria-sort')).toBe('descending');
    expect(thProd.getAttribute('aria-sort')).toBe('none');
    fix.componentInstance.paginaD.set(3);
    (thMes.querySelector('button') as HTMLButtonElement).click();
    await tick(fix);
    expect(catalogo.detallado).toHaveBeenLastCalledWith({ search: '', mostrar: 'todos', orden: 'mes', dir: 'asc', page: 1, pageSize: 50 });
    (thProd.querySelector('button') as HTMLButtonElement).click();
    await tick(fix);
    expect(catalogo.detallado).toHaveBeenLastCalledWith({ search: '', mostrar: 'todos', orden: 'producto', dir: 'asc', page: 1, pageSize: 50 });
    expect(siguienteOrden({ col: 'producto', dir: 'asc' }, 'mes')).toEqual({ col: 'mes', dir: 'desc' });
  });

  it('⛔ sin venta medida, Este mes no se ofrece para ordenar (el servidor ya cayó a Producto)', async () => {
    const { fix } = await montar({}, { detallado: vi.fn(() => of(LISTA_D({ orden: 'producto', dir: 'asc', venta: { medida: false, calculado_al: null, periodos: null } }))) });
    const ths = Array.from(fix.nativeElement.querySelectorAll('.cd thead th')) as HTMLElement[];
    expect(ths[4].querySelector('button')).toBeNull();
    expect(ths[0].getAttribute('aria-sort')).toBe('ascending');
  });

  it('⭐ «Mostrar» agrupado con conteos; lo sin medir dice por qué UNA vez y no se elige; lo medido filtra en el servidor', async () => {
    const { fix, catalogo } = await montar();
    await abrirMostrar(fix);
    const el = fix.nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('.cd-grupo-t')).map((g) => texto(g))).toEqual(['Qué hacer', 'Para cuidar hoy', 'Catálogo']);
    // La nota de «Qué hacer» va una sola vez, bajo su título (no cinco veces).
    expect(Array.from(el.querySelectorAll('.cd-menu .cd-nota')).filter((n) => texto(n) === NOTA_GRANDE)).toHaveLength(1);
    const comprar = opciones(fix)[0];
    expect(texto(comprar)).toBe('Comprar sin medir');
    expect(comprar.getAttribute('aria-disabled')).toBe('true');
    const n = catalogo.detallado.mock.calls.length;
    comprar.click();
    await tick(fix);
    expect(catalogo.detallado.mock.calls.length).toBe(n);
    const noVenden = opciones(fix).find((o) => texto(o).startsWith('No se venden'))!;
    expect(texto(noVenden.querySelector('.cd-nota'))).toBe('Los 300 de más dinero detenido, de 969 en la red');
    expect(texto(noVenden.querySelector('.cs-n'))).toBe('300');
    const cad = opciones(fix).find((o) => texto(o).startsWith('Por caducar'))!;
    cad.click();
    await tick(fix);
    expect(catalogo.detallado).toHaveBeenLastCalledWith({ search: '', mostrar: 'caducidad', orden: 'mes', dir: 'desc', page: 1, pageSize: 50 });
    expect(fix.nativeElement.querySelector('.cs-menu')).toBeNull();
  });

  it('⭐ clic (o Enter) abre la ficha DETALLADA con las etiquetas del renglón; sin «Editar producto»', async () => {
    const { fix, flujo, catalogo } = await montar();
    const pintar = async () => { fix.detectChanges(); await Promise.resolve(); fix.detectChanges(); };
    filasD(fix)[0].click();
    await pintar();
    expect(fix.componentInstance.abierto()).toEqual({
      id: 'q-1', nombre: 'La Rosa Mazapan /30', sku: '70001', proveedor: 'Distribuidora de la Rosa', tipo: 'detallado',
      etiquetas: { lider: 4, nuevo: null, caducidad: 'caducado' },
      // [NP.22] Un servidor anterior (renglón sin la llave lanzamiento): la ficha no sabe si es nuevo y lo pregunta.
      esNuevo: null,
    });
    expect(document.querySelector('app-producto-ficha-detallada')).not.toBeNull();
    expect(document.querySelector('app-producto-ficha')).toBeNull();
    expect(flujo.detalle).toHaveBeenCalledWith('q-1');
    expect(catalogo.ficha).toHaveBeenCalledWith('q-1', '01'); // [PF.21] la sucursal de la lista
    expect(document.body.textContent).not.toContain('Editar producto');
    fix.componentInstance.cerrarFlujo();
    await pintar();
    filasD(fix)[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await pintar();
    expect(fix.componentInstance.abierto()?.id).toBe('q-2');
  });

  it('⭐ [PF.21] «Precios de»: con varias sucursales en tu alcance se elige; pide esa al servidor, vuelve a la página 1 y la ficha la sigue', async () => {
    const detallado = vi.fn((p: { sucursal?: string | null }) => of(LISTA_D({
      sucursal: p.sucursal ?? '01',
      sucursales: [{ codigo: '01', nombre: 'PADRE HIDALGO' }, { codigo: '05', nombre: 'YURECUARO' }],
    })));
    const { fix, catalogo } = await montar({}, { detallado });
    const el = fix.nativeElement as HTMLElement;
    expect(el.querySelector('.cd-suc p-select')).not.toBeNull();
    expect(texto(el.querySelector('.cd-suc'))).toContain('Precios de');
    expect(fix.componentInstance.opcionesSucursalD()).toEqual([
      { label: '01 · Padre Hidalgo', value: '01' }, { label: '05 · Yurecuaro', value: '05' },
    ]);
    fix.componentInstance.elegirSucursalD('05');
    await tick(fix);
    expect(detallado).toHaveBeenLastCalledWith(expect.objectContaining({ sucursal: '05', page: 1 }));
    filasD(fix)[0].click();
    fix.detectChanges(); await Promise.resolve(); fix.detectChanges();
    expect(catalogo.ficha).toHaveBeenCalledWith('q-1', '05');
  });

  it('⛔ [PF.21] [negativa] con una sola sucursal en tu alcance no hay selector: se dice de cuál es el precio', async () => {
    const { fix } = await montar({}, { detallado: vi.fn(() => of(LISTA_D({ sucursal: '03', sucursales: [{ codigo: '03', nombre: 'CANINDO' }] }))) });
    const el = fix.nativeElement as HTMLElement;
    expect(el.querySelector('.cd-suc p-select')).toBeNull();
    expect(texto(el.querySelector('.cd-suc'))).toBe('Precios de 03 · Canindo');
  });

  it('⛔ si una familia de etiquetas no se pudo medir, lo dice (un renglón sin etiqueta no quiere decir «no es»)', async () => {
    const { fix } = await montar({}, { detallado: vi.fn(() => of(LISTA_D({ etiquetas: { lider: false, caducidad: false, nuevo: true } }))) });
    expect(texto(fix.nativeElement.querySelector('.cd-aviso'))).toContain('Sin etiquetas de líder, caducidad');
    limpiar();
    const bien = await montar();
    expect(bien.fix.nativeElement.querySelector('.cd-aviso')).toBeNull();
  });

  it('⛔ error sin datos se dice como error (no una tabla vacía)', async () => {
    const { fix } = await montar({}, { detallado: vi.fn(() => throwError(() => new Error('x'))) });
    expect(fix.nativeElement.textContent).toContain('No se pudo cargar el catálogo');
  });

  it('el buscador es el mismo: lo escrito pasa a Detallado y vuelve a la página 1', async () => {
    vi.useFakeTimers();
    try {
      const { fix, catalogo } = await montar();
      fix.componentInstance.paginaD.set(4);
      fix.componentInstance.onBusqueda('mazapan');
      vi.advanceTimersByTime(1000);
      vi.useRealTimers();
      await tick(fix);
      expect(catalogo.detallado).toHaveBeenLastCalledWith({ search: 'mazapan', mostrar: 'todos', orden: 'mes', dir: 'desc', page: 1, pageSize: 50 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Sencillo (la vista nueva, la de default)', () => {
  afterEach(limpiar);
  const sencillo = (lista?: ReturnType<typeof vi.fn>) => montar({}, { modo: null, lista });
  const filasS = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.cs-fila')) as HTMLElement[];
  const opciones = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.cs-op')) as HTMLButtonElement[];
  const opcionTexto = (o: HTMLElement) => Array.from(o.children).map((c) => texto(c)).join(' ');
  const abrirMostrar = async (fix: ComponentFixture<ComprasCatalogoComponent>) => {
    (fix.nativeElement.querySelector('.cs-sel') as HTMLButtonElement).click();
    await tick(fix);
  };

  it('⭐ sin elección previa abre en Sencillo, sin lo que el usuario pidió quitar, y no pide lo de Detallado', async () => {
    const { fix, catalogo } = await sencillo();
    const el = fix.nativeElement as HTMLElement;
    expect(el.querySelector('.cs')).not.toBeNull();
    expect(texto(el.querySelector('.cp-vista-btn'))).toBe('Detallado');
    expect(el.querySelector('.cp-vista-btn')?.getAttribute('aria-pressed')).toBe('false');
    // Quitados: renglón de conteos, aviso BASE-MXN, barra de proveedores, selector Por proveedor / Para cuidar hoy, pestañas.
    for (const sel of ['.surf-page-sub', '.cp-aviso', '.cp-rail', '.cp-seg', 'app-page-tabs']) expect(el.querySelector(sel)).toBeNull();
    expect(el.querySelector('app-catalogo-menu')).not.toBeNull();
    expect(catalogo.lista).toHaveBeenCalledWith({ search: '', mostrar: 'todos', page: 1, pageSize: 50 });
    expect(catalogo.detallado).not.toHaveBeenCalled();
  });

  it('⭐ cada renglón: nombre legible + SKU, proveedor, una línea por unidad y su precio alineado; «Sin precio» nunca $0', async () => {
    const { fix } = await sencillo();
    const [a, b] = filasS(fix);
    expect(texto(a.querySelector('.cs-nom'))).toBe('La Rosa Mazapan /30');
    expect(texto(a.querySelector('.cs-sku'))).toBe('70001');
    expect(texto(a.querySelector('.cs-prov'))).toBe('Distribuidora de la Rosa');
    expect(Array.from(a.querySelectorAll('.cs-ud .cs-lin')).map((l) => texto(l.querySelector('.cs-chip')) + ' ' + texto(l.querySelector('.cs-eq'))))
      .toEqual(['PAQ base', 'CJA 20 PAQ']);
    expect(Array.from(a.querySelectorAll('.cs-pre .cs-lin')).map((l) => texto(l))).toEqual(['$87.14', '$1,594.96']);
    expect(Array.from(b.querySelectorAll('.cs-pre .cs-lin')).map((l) => texto(l))).toEqual(['$63.99', 'Sin precio']);
    expect(texto(b.querySelector('.cs-razon'))).toBe('Coincide por código de barras adicional 4510000170833');
    expect(texto(b.querySelector('.cs-prov'))).toBe('Sin proveedor');
    expect(b.textContent).not.toContain('$0');
  });

  it('⭐ [PF.20] descontinuado: la etiqueta en vez de «* DESCONTINUADO»; si Kepler no dejó otro nombre, se dice', async () => {
    const [a, b] = LISTA_S().filas;
    const lista = vi.fn(() => of(LISTA_S({ filas: [
      { ...a, id: 'd-1', sku: '89063', nombre: '* DESCONTINUADO' },
      { ...b, id: 'd-2', sku: '38024', nombre: '***DESCONTINUADO PAL CHUPA CHUPS BOLSA CHOCO /40' },
      a,
    ] })));
    const { fix } = await sencillo(lista);
    const [d1, d2, normal] = filasS(fix);
    expect(texto(d1.querySelector('.cs-nom .cd-tag--desc'))).toBe('Descontinuado');
    expect(texto(d1.querySelector('.cs-nom'))).toBe('Descontinuado Sin nombre en Kepler');
    expect(texto(d2.querySelector('.cs-nom'))).toBe('Descontinuado Pal Chupa Chups Bolsa Choco /40');
    expect(d1.textContent).not.toContain('*');
    // [negativa] un producto normal no lleva la etiqueta ni cambia su nombre.
    expect(normal.querySelector('.cd-tag--desc')).toBeNull();
    expect(texto(normal.querySelector('.cs-nom'))).toBe('La Rosa Mazapan /30');
  });

  it('⭐ el botón cambia a Detallado, lo recuerda por persona, y al volver a entrar abre en Detallado', async () => {
    const { fix, catalogo } = await sencillo();
    (fix.nativeElement.querySelector('.cp-vista-btn') as HTMLButtonElement).click();
    await tick(fix);
    expect(texto(fix.nativeElement.querySelector('.cp-vista-btn'))).toBe('Sencillo');
    expect(fix.nativeElement.querySelector('.cp-vista-btn')?.getAttribute('aria-pressed')).toBe('true');
    expect(fix.nativeElement.querySelector('.cd')).not.toBeNull();
    expect(fix.nativeElement.querySelector('.cs:not(.cd)')).toBeNull();
    expect(catalogo.detallado).toHaveBeenCalled();
    expect(localStorage.getItem(claveVista('u-1'))).toBe('detallado');
    TestBed.resetTestingModule();
    const otra = await montar({}, { modo: null });
    expect(otra.fix.nativeElement.querySelector('.cd')).not.toBeNull();
    expect(texto(otra.fix.nativeElement.querySelector('.cp-vista-btn'))).toBe('Sencillo');
  });

  it('⭐ el buscador (uno solo, con debounce) manda search al servidor y vuelve a la página 1', async () => {
    vi.useFakeTimers();
    try {
      const { fix, catalogo } = await sencillo();
      const input = fix.nativeElement.querySelector('.cp-buscar input') as HTMLInputElement;
      expect(input.placeholder).toBe('Busca por nombre, SKU, cualquier código de barras, proveedor o unidad (caja, kilo…)');
      fix.componentInstance.pagina.set(3);
      fix.componentInstance.onBusqueda('mazapan rosa');
      vi.advanceTimersByTime(1000);
      vi.useRealTimers();
      await tick(fix);
      expect(catalogo.lista).toHaveBeenLastCalledWith({ search: 'mazapan rosa', mostrar: 'todos', page: 1, pageSize: 50 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ «Mostrar» pinta los conteos de la búsqueda y filtra EN EL SERVIDOR', async () => {
    const { fix, catalogo } = await sencillo();
    await abrirMostrar(fix);
    expect(opciones(fix).map(opcionTexto)).toEqual(['Todos 2', 'Con varios códigos 1', 'Sin código de barras 0', 'Alguna unidad sin precio 1', 'Productos nuevos 1']);
    opciones(fix)[1].click();
    await tick(fix);
    expect(catalogo.lista).toHaveBeenLastCalledWith({ search: '', mostrar: 'varios_codigos', page: 1, pageSize: 50 });
    expect(fix.nativeElement.querySelector('.cs-menu')).toBeNull();
    expect(texto(fix.nativeElement.querySelector('.cs-sel'))).toContain('Con varios códigos');
  });

  it('⛔ sin precio por sucursal, «Alguna unidad sin precio» dice «sin medir» (no 0) y no se puede elegir', async () => {
    const { fix, catalogo } = await sencillo(vi.fn(() => of(LISTA_S({ conteos: { todos: 2, variosCodigos: 1, sinCodigo: 0, sinPrecio: null } }))));
    await abrirMostrar(fix);
    const sp = opciones(fix)[3];
    expect(opcionTexto(sp)).toBe('Alguna unidad sin precio sin medir');
    expect(sp.getAttribute('aria-disabled')).toBe('true');
    const n = catalogo.lista.mock.calls.length;
    sp.click();
    await tick(fix);
    expect(catalogo.lista.mock.calls.length).toBe(n);
    expect(fix.componentInstance.mostrar()).toBe('todos');
  });

  it('el menú «Mostrar» se maneja con teclado: flechas y Esc (que devuelve el foco al botón)', async () => {
    const { fix } = await sencillo();
    await abrirMostrar(fix);
    await new Promise((r) => setTimeout(r));
    const menu = fix.nativeElement.querySelector('.cs-menu') as HTMLElement;
    expect(document.activeElement).toBe(opciones(fix)[0]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(opciones(fix)[1]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(fix);
    expect(fix.nativeElement.querySelector('.cs-menu')).toBeNull();
    expect(document.activeElement).toBe(fix.nativeElement.querySelector('.cs-sel'));
  });

  it('⭐ clic (o Enter) en un renglón abre la ficha del producto en el panel, sin «Editar producto»', async () => {
    const { fix, catalogo } = await sencillo();
    // La ficha nunca llega (NEVER): whenStable no se cumpliría; basta con pintar.
    const pintar = async () => { fix.detectChanges(); await Promise.resolve(); fix.detectChanges(); };
    filasS(fix)[0].click();
    await pintar();
    expect(fix.componentInstance.abierto()).toEqual({ id: 'q-1', nombre: 'La Rosa Mazapan /30', sku: '70001', proveedor: 'Distribuidora de la Rosa', tipo: 'ficha', esNuevo: null });
    expect(catalogo.ficha).toHaveBeenCalledWith('q-1', null); // Sencillo: sin selector, el servidor elige
    expect(document.body.textContent).not.toContain('Editar producto');
    fix.componentInstance.cerrarFlujo();
    await pintar();
    filasS(fix)[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await pintar();
    expect(fix.componentInstance.abierto()?.id).toBe('q-2');
  });

  it('⛔ error sin datos se dice como error; búsqueda sin resultados se dice como tal (no una tabla vacía)', async () => {
    const mal = await sencillo(vi.fn(() => throwError(() => new Error('x'))));
    expect(mal.fix.nativeElement.textContent).toContain('No se pudo cargar el catálogo');
    limpiar();
    vi.useFakeTimers();
    try {
      const { fix } = await sencillo(vi.fn((p: { search?: string }) => of(p.search
        ? LISTA_S({ total: 0, filas: [], conteos: { todos: 0, variosCodigos: 0, sinCodigo: 0, sinPrecio: 0 } })
        : LISTA_S())));
      fix.componentInstance.onBusqueda('zzz');
      vi.advanceTimersByTime(1000);
      vi.useRealTimers();
      await tick(fix);
      expect(fix.nativeElement.textContent).toContain('«zzz» no está en el catálogo');
    } finally {
      vi.useRealTimers();
    }
  });

  it('equivale: la base dice «base»; las demás, a cuánto equivalen', () => {
    expect(equivaleTexto({ equivale: null })).toBe('base');
    expect(equivaleTexto({ equivale: { cantidad: 18, unidad: 'PAQ' } })).toBe('18 PAQ');
  });
});

/**
 * `[PF.12.3]` La columna «Último costo» de Sencillo: lo que se pagó en la última entrada, sin IVA ni IEPS, en la
 * MISMA unidad que cada precio. Controles: 70977 (PAQ $2.52 contra $86.55 de costo) se marca; 70001 no.
 */
const LISTA_C = (): CatalogoLista => {
  const [rosa, altos] = LISTA_S().filas;
  return LISTA_S({
    total: 4, costo_visible: true,
    filas: [
      { ...rosa, ultimoCosto: { fecha: '2026-10-08', sucursal: '08', unidad: 'PAQ', costo: 66.52, impuesto: 'neto', porUnidad: [
        { unidad: 'PAQ', costo: 66.52, precioSinImpuestos: 80.69, bajoCosto: false },
        { unidad: 'CJA', costo: 1330.4, precioSinImpuestos: 1476.81, bajoCosto: false },
      ] } },
      { id: 'q-9', sku: '70977', nombre: 'LA ROSA MAZAPAN / 40', proveedor: null, nCodigos: 1, razon: null,
        unidades: [
          { unidad: 'PAQ', equivale: null, factorBase: 1, precio: 2.52, mayoreo: null },
          { unidad: 'CJA', equivale: { cantidad: 40, unidad: 'PAQ' }, factorBase: 40, precio: 94.54, mayoreo: null },
        ],
        ultimoCosto: { fecha: '2026-10-21', sucursal: '02', unidad: 'PAQ', costo: 86.55, impuesto: 'neto', porUnidad: [
          { unidad: 'PAQ', costo: 86.55, precioSinImpuestos: 2.33, bajoCosto: true },
          { unidad: 'CJA', costo: 3462, precioSinImpuestos: 87.54, bajoCosto: true },
        ] } },
      { ...altos, ultimoCosto: null },
      { id: 'q-4', sku: '55555', nombre: 'GRANEL SIN ESCALERA', proveedor: null, nCodigos: 0, razon: null,
        unidades: [{ unidad: 'PZA', equivale: null, factorBase: 1, precio: 12, mayoreo: null }],
        ultimoCosto: { fecha: '2026-09-02', sucursal: '00', unidad: 'KG', costo: 50, impuesto: 'sin_dato', porUnidad: [] } },
    ],
  });
};

describe('[PF.12.3] Sencillo › Último costo', () => {
  afterEach(limpiar);
  const conCosto = (lista = LISTA_C()) => montar({}, { modo: null, lista: vi.fn(() => of(lista)) });
  const filas = (fix: ComponentFixture<ComprasCatalogoComponent>) => Array.from(fix.nativeElement.querySelectorAll('.cs-fila')) as HTMLElement[];
  const lineas = (f: HTMLElement) => Array.from(f.querySelectorAll('.cs-cos .cs-lin')).map((l) => texto(l));

  it('⭐ encabezado «Último costo» que declara el impuesto, después de Precio', async () => {
    const { fix } = await conCosto();
    const ths = Array.from(fix.nativeElement.querySelectorAll('.cs thead th')).map((th) => texto(th as Element));
    expect(ths).toEqual(['Producto', 'Proveedor', 'Unidades de medida', 'Precio', 'Último costo sin IVA ni IEPS']);
  });

  it('⭐ una línea por unidad, en la MISMA unidad que su precio, con cuándo y dónde (la sucursal por nombre, nunca el número)', async () => {
    const { fix } = await conCosto();
    const [rosa] = filas(fix);
    expect(Array.from(rosa.querySelectorAll('.cs-pre .cs-lin')).map((l) => texto(l))).toEqual(['$87.14', '$1,594.96']);
    expect(lineas(rosa)).toEqual(['PAQ $66.52', 'CJA $1,330.40']);
    expect(texto(rosa.querySelector('.cs-cos-org'))).toBe('8 oct 2026 · Morelia Abastos');
    expect(texto(rosa.querySelector('.cs-cos-org'))).not.toMatch(/\b08\b/);
    expect(rosa.querySelector('.cs-bajo')).toBeNull();
  });

  it('⭐ CONTROL 70977: precio 34× debajo del costo → «Precio bajo costo» (p-tag warn) con su evidencia; 70001 no', async () => {
    const { fix } = await conCosto();
    const [rosa, r40] = filas(fix);
    expect(texto(r40.querySelector('.cs-bajo'))).toBe('Precio bajo costo');
    expect(r40.querySelector('.cs-bajo p-tag')).not.toBeNull();
    expect(r40.querySelector('.cs-bajo')?.getAttribute('title')).toBe(
      'PAQ: precio sin impuestos $2.33, último costo $86.55 · CJA: precio sin impuestos $87.54, último costo $3,462.00');
    expect(r40.querySelectorAll('.cs-cos .cs-lin.is-bajo')).toHaveLength(2);
    expect(rosa.querySelector('.cs-bajo')).toBeNull();
    expect(rosa.querySelectorAll('.cs-cos .is-bajo')).toHaveLength(0);
  });

  it('⛔ sin entradas dice «Sin compras», nunca $0', async () => {
    const { fix } = await conCosto();
    const altos = filas(fix)[2];
    expect(texto(altos.querySelector('.cs-cos'))).toBe('Sin compras');
    expect(texto(altos.querySelector('.cs-cos'))).not.toContain('$');
  });

  it('⛔ la unidad de la entrada fuera de la escalera: el costo se queda en SU unidad y se dice «sin convertir»', async () => {
    const { fix } = await conCosto();
    const granel = filas(fix)[3];
    expect(lineas(granel)).toEqual(['KG $50.00']);
    expect(Array.from(granel.querySelectorAll('.cs-cos-nota')).map((n) => texto(n))).toEqual([
      'Sin convertir: KG no está entre sus unidades', 'Sin saber si trae impuestos',
    ]);
    // La unidad se ve aun en ancho: no se alinea con ningún precio.
    expect(granel.querySelector('.cs-cos .cs-chip')?.classList.contains('cs-m-ud')).toBe(false);
    expect(texto(granel.querySelector('.cs-cos-org'))).toBe('2 sep 2026 · CEDIS');
  });

  it('las definiciones están a la vista bajo la tabla (no en un title)', async () => {
    const { fix } = await conCosto();
    const pie = texto(fix.nativeElement.querySelector('.cs .cd-pie'));
    expect(pie).toContain('Último costo: lo que se pagó en la última entrada de compra de cualquier sucursal');
    expect(pie).toContain('Precio bajo costo: el precio de lista, sin sus impuestos, queda debajo de ese costo.');
  });

  it('⛔ si el servidor no pudo leer el costo (costo_medido=false) cada celda dice «Sin dato», nunca «Sin compras», y el pie lo explica', async () => {
    const sinLeer = LISTA_C();
    const { fix } = await conCosto({ ...sinLeer, costo_medido: false, filas: sinLeer.filas.map(({ ultimoCosto: _u, ...f }) => f) });
    const celdas = Array.from(fix.nativeElement.querySelectorAll('.cs-cos')).map((c) => texto(c as Element));
    expect(celdas).toEqual(['Sin dato', 'Sin dato', 'Sin dato', 'Sin dato']);
    expect(texto(fix.nativeElement.querySelector('.cs .cd-pie'))).toContain('no se pudo leer ahora: dice «Sin dato» (no quiere decir que no haya compras)');
    expect(fix.nativeElement.querySelector('.cs-bajo')).toBeNull();
  });

  it('⛔ [negativa] sin costo_visible del servidor no hay columna, ni celda, ni pie', async () => {
    const { fix } = await montar({}, { modo: null });
    const ths = Array.from(fix.nativeElement.querySelectorAll('.cs thead th')).map((th) => texto(th as Element));
    expect(ths).toEqual(['Producto', 'Proveedor', 'Unidades de medida', 'Precio']);
    expect(fix.nativeElement.querySelector('.cs-cos')).toBeNull();
    expect(fix.nativeElement.querySelector('.cs .cd-pie')).toBeNull();
  });

  it('celdaCosto: bajo costo sólo en una unidad lo nombra; sin costo en la entrada lo dice', () => {
    const base = LISTA_C().filas[0].ultimoCosto!;
    const parcial = celdaCosto({ ...base, porUnidad: [
      { unidad: 'PAQ', costo: 66.52, precioSinImpuestos: 80.69, bajoCosto: false },
      { unidad: 'CJA', costo: 1330.4, precioSinImpuestos: 1300, bajoCosto: true },
    ] });
    expect(parcial.bajoCosto?.texto).toBe('Precio bajo costo en CJA');
    expect(parcial.lineas.map((l) => l.bajo)).toEqual([false, true]);
    // Una unidad sin precio no se compara: si la única comparable está bajo costo, es «Precio bajo costo».
    const unaSinPrecio = celdaCosto({ ...base, porUnidad: [
      { unidad: 'PAQ', costo: 66.52, precioSinImpuestos: 50, bajoCosto: true },
      { unidad: 'CJA', costo: 1330.4, precioSinImpuestos: null, bajoCosto: null },
    ] });
    expect(unaSinPrecio.bajoCosto?.texto).toBe('Precio bajo costo');
    expect(celdaCosto({ ...base, costo: null, porUnidad: [] })).toMatchObject({ tipo: 'sin_costo', lineas: [], origen: '8 oct 2026 · Morelia Abastos' });
    expect(celdaCosto(null).tipo).toBe('sin_compras');
    expect(celdaCosto(undefined).tipo).toBe('sin_compras');
    // Sin leer manda sobre todo lo demás: ni un costo viejo ni «Sin compras».
    expect(celdaCosto(base, false)).toMatchObject({ tipo: 'sin_dato', lineas: [], bajoCosto: null });
    expect(celdaCosto(null, false).tipo).toBe('sin_dato');
  });
});

/**
 * `[PF.12.3]` Detallado (pedido de David, 2026-11-03): la MISMA columna «Último costo» que Sencillo, con la misma
 * celda, junto al precio y antes de «Este mes». Los renglones son los de LISTA_C + lo de Detallado.
 */
const LISTA_DC = (over: Partial<CatalogoListaDetallada> = {}): CatalogoListaDetallada => LISTA_D({
  total: 4, costo_visible: true, costo_medido: true, orden: 'mes', dir: 'desc',
  filas: LISTA_C().filas.map((f, i) => ({ ...f, mes: 1000 * (4 - i), mesAnterior: 900, variacion: 0.1, lider: null, nuevo: null, caducidad: null })),
  ...over,
});

describe('[PF.12.3] Detallado › Último costo', () => {
  afterEach(limpiar);
  const detallado = (lista = LISTA_DC()) => montar({}, { detallado: vi.fn(() => of(lista)) });
  const celdas = (el: HTMLElement, sel: string) => Array.from(el.querySelectorAll(sel + ' .cs-cos')).map((c) => texto(c as Element));

  it('⭐ la columna va junto al precio y antes de «Este mes», con su impuesto declarado', async () => {
    const { fix } = await detallado();
    const ths = Array.from(fix.nativeElement.querySelectorAll('.cd thead th')).map((th) => texto(th as Element));
    expect(ths).toEqual(['Producto', 'Proveedor', 'Unidades de medida', 'Precio', 'Último costo sin IVA ni IEPS', 'Este mes']);
    // «Este mes» sigue en cada renglón, con su orden de siempre.
    expect(fix.nativeElement.querySelectorAll('.cd .cd-mes')).toHaveLength(4);
    expect(texto(fix.nativeElement.querySelector('.cd .cd-mes-v'))).toBe('$4,000');
  });

  it('⭐ el MISMO texto que Sencillo, celda por celda, para los mismos productos', async () => {
    const s = await montar({}, { modo: null, lista: vi.fn(() => of(LISTA_C())) });
    const enSencillo = celdas(s.fix.nativeElement, '.cs');
    limpiar();
    const d = await detallado();
    const enDetallado = celdas(d.fix.nativeElement, '.cd');
    expect(enSencillo).toHaveLength(4);
    expect(enDetallado).toEqual(enSencillo);
    expect(enDetallado[0]).toContain('PAQ $66.52');
    expect(enDetallado[0]).toContain('CJA $1,330.40');
    expect(enDetallado[0]).toContain('8 oct 2026 · Morelia Abastos');
  });

  it('⭐ CONTROL en Detallado: 70977 se marca «Precio bajo costo»; 70001 no', async () => {
    const { fix } = await detallado();
    const filas = Array.from(fix.nativeElement.querySelectorAll('.cd .cs-fila')) as HTMLElement[];
    expect(texto(filas[1].querySelector('.cs-bajo'))).toBe('Precio bajo costo');
    expect(filas[1].querySelector('.cs-bajo p-tag')).not.toBeNull();
    expect(filas[0].querySelector('.cs-bajo')).toBeNull();
    expect(texto(filas[2].querySelector('.cs-cos'))).toBe('Sin compras');
  });

  it('el pie de Detallado suma la definición del costo a la de «Este mes»', async () => {
    const { fix } = await detallado();
    const pie = texto(fix.nativeElement.querySelector('.cd .cd-pie'));
    expect(pie).toContain('Este mes: venta con impuestos del 1 a hoy');
    expect(pie).toContain('Último costo: lo que se pagó en la última entrada de compra de cualquier sucursal');
  });

  it('⛔ sin leer (costo_medido=false) dice «Sin dato» en cada renglón, también en Detallado', async () => {
    const sinLeer = LISTA_DC();
    const { fix } = await detallado({ ...sinLeer, costo_medido: false, filas: sinLeer.filas.map(({ ultimoCosto: _u, ...f }) => f) });
    expect(celdas(fix.nativeElement, '.cd')).toEqual(['Sin dato', 'Sin dato', 'Sin dato', 'Sin dato']);
    expect(texto(fix.nativeElement.querySelector('.cd .cd-pie'))).toContain('no se pudo leer ahora');
  });
});

/**
 * `[NP.22]` «Productos nuevos» dentro de Productos (decisión de David, 2026-11-04): un «Mostrar» más, en Sencillo y en
 * Detallado, partido por el resultado del lanzamiento, en la URL (sin bloque de resumen: lo retiró David).
 */
describe('[NP.22] Mostrar › Productos nuevos', () => {
  afterEach(limpiar);
  const LZ = (over: Record<string, unknown> = {}) => ({
    estado: 'seguimiento' as const, etapa: 'mes_2', dia: 45, veredicto: 'sacar' as const, motivo: 'Lleva 30 días sin venderse',
    posible_recodificacion: false, sin_venta_30: false, orden: 0, etiqueta: 'Nuevo · día 45', ...over,
  });
  const CONTEOS_LZ = { seguimiento: 2, sacar: 1, revisar: 0, agotado: 0, se_queda: 1, pronto: 0, sin_venta_30: 0, sin_movimiento: 5, no_medible: 0, excluido: 0 };
  const LISTA_NUEVOS = (over: Partial<CatalogoListaDetallada> = {}) => {
    const base = LISTA_D();
    return LISTA_D({
      mostrar: 'nuevos', orden: 'lanzamiento', dir: 'asc', total: 2, resultado: 'seguimiento', conteos_lanzamiento: CONTEOS_LZ,
      filas: [
        { ...base.filas[1], lanzamiento: LZ({ posible_recodificacion: true }) },
        { ...base.filas[0], nuevo: null, lanzamiento: LZ({ veredicto: 'se_queda', motivo: 'Se vendió 27 de los últimos 28 días', dia: 120, etapa: 'graduado', etiqueta: null, orden: 1 }) },
      ],
      ...over,
    });
  };
  const partes = (o: Element) => Array.from(o.children).map((c) => texto(c)).filter(Boolean).join(' ');
  const ths = (el: HTMLElement, sel: string) => Array.from(el.querySelectorAll(`${sel} thead th`)).map((th) => texto(th as Element));
  const url = () => TestBed.inject(Router).url;
  const settle = async (fix: ComponentFixture<unknown>) => { for (let i = 0; i < 3; i++) { await tick(fix); await new Promise((r) => setTimeout(r, 0)); } };

  it('⭐ Sencillo: «Productos nuevos» es un Mostrar más, con su conteo; lo filtra el servidor de Detallado y la URL lo guarda', async () => {
    const detallado = vi.fn(() => of(LISTA_NUEVOS()));
    const { fix, catalogo } = await montar({}, { modo: null, detallado });
    const el = fix.nativeElement as HTMLElement;
    // Sin el filtro: ni resumen, ni columnas del lanzamiento.
    expect(el.querySelector('app-productos-nuevos-resumen')).toBeNull();
    expect(ths(el, '.cs')).not.toContain('¿Funcionó?');
    (el.querySelector('.cs-sel') as HTMLButtonElement).click();
    await tick(fix);
    const op = Array.from(el.querySelectorAll('.cs-op')).find((o) => texto(o).startsWith('Productos nuevos')) as HTMLButtonElement;
    expect(partes(op)).toBe('Productos nuevos 1');
    op.click();
    await settle(fix);
    expect(catalogo.detallado).toHaveBeenLastCalledWith({
      search: '', mostrar: 'nuevos', resultado: 'seguimiento', orden: 'lanzamiento', dir: 'asc', page: 1, pageSize: 50,
    });
    expect(url()).toBe('/?mostrar=nuevos');
    // Las columnas de Sencillo + ¿Funcionó? y Día, junto al producto.
    expect(ths(el, '.cs')).toEqual(['Producto', '¿Funcionó?', 'Día', 'Proveedor', 'Unidades de medida', 'Precio']);
    const [a, b] = Array.from(el.querySelectorAll('.cs-fila')) as HTMLElement[];
    expect(partes(a.querySelector('.cn-fun')!)).toBe('Sacar Lleva 30 días sin venderse');
    expect(partes(a.querySelector('.cn-d')!)).toBe('Día 45');
    expect(partes(b.querySelector('.cn-d')!)).toBe('Día 120 Cumplió 90 días');
    expect(texto(a.querySelector('.cd-tag--recod'))).toBe('Posible recodificación');
    // David retiró el bloque de resumen (2026-11-04): no hay titular ni cifras; lo indispensable va en UNA línea con su ayuda.
    expect(el.querySelector('app-productos-nuevos-resumen')).toBeNull();
    expect(el.textContent).not.toContain('¿funcionó el lanzamiento?');
    const nota = el.querySelector('.cn-nota')!;
    expect(texto(nota)).toContain('Preliminar');
    expect(texto(nota)).toContain('fecha de alta no está decodificada');
    expect(texto(nota)).toContain('sin impuestos');
    expect(nota.querySelector('app-context-help')).not.toBeNull();
  });

  it('⭐ los resultados del lanzamiento, con cuántos de la búsqueda van en cada uno; elegir uno filtra en el servidor y va a la URL', async () => {
    const detallado = vi.fn(() => of(LISTA_NUEVOS()));
    const { fix, catalogo } = await montar({}, { modo: 'detallado', detallado, url: '/?mostrar=nuevos' });
    const el = fix.nativeElement as HTMLElement;
    const chips = Array.from(el.querySelectorAll('.cn-chip')) as HTMLButtonElement[];
    expect(chips.map((c) => partes(c))).toEqual([
      'Todos en seguimiento 2', 'Sacar 1', 'Revisar 0', 'Agotado: no se juzga 0', 'Se queda 1', 'Aún es pronto 0',
      'Sin venta en su primer mes 0', 'Dados de alta, sin movimiento 5', 'No medibles 0', 'Excluidos 0',
    ]);
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
    chips[1].click();
    await settle(fix);
    expect(catalogo.detallado).toHaveBeenLastCalledWith(expect.objectContaining({ mostrar: 'nuevos', resultado: 'sacar', page: 1 }));
    expect(url()).toBe('/?mostrar=nuevos&resultado=sacar');
    // Detallado: ¿Funcionó? se puede ordenar (el orden de Productos nuevos) y la etiqueta «Nuevo · día N» no se repite.
    expect(ths(el, '.cd')).toEqual(['Producto', '¿Funcionó?', 'Día', 'Proveedor', 'Unidades de medida', 'Precio', 'Este mes']);
    expect(Array.from(el.querySelectorAll('.cd .cd-tag')).map((t) => texto(t))).not.toContain('Nuevo · día 12');
  });

  it('⭐ un enlace con ?mostrar=nuevos&resultado=sacar (el de la pantalla vieja redirigido) abre la lista con ese filtro', async () => {
    const detallado = vi.fn(() => of(LISTA_NUEVOS()));
    const { fix, catalogo } = await montar({}, { modo: 'detallado', detallado, url: '/?mostrar=nuevos&resultado=sacar' });
    expect(catalogo.detallado).toHaveBeenCalledWith(expect.objectContaining({ mostrar: 'nuevos', resultado: 'sacar', orden: 'lanzamiento', dir: 'asc' }));
    expect(fix.componentInstance.resultado()).toBe('sacar');
  });

  it('[negativa] salir de Productos nuevos quita la nota, las columnas, los resultados y el filtro de la URL', async () => {
    const detallado = vi.fn((p: { mostrar?: string }) => of(p.mostrar === 'nuevos' ? LISTA_NUEVOS() : LISTA_D()));
    const { fix, catalogo } = await montar({}, { modo: 'detallado', detallado, url: '/?mostrar=nuevos&resultado=sacar' });
    const el = fix.nativeElement as HTMLElement;
    fix.componentInstance.elegirMostrarD('todos');
    await settle(fix);
    expect(catalogo.detallado).toHaveBeenLastCalledWith({ search: '', mostrar: 'todos', orden: 'mes', dir: 'desc', page: 1, pageSize: 50 });
    expect(url()).toBe('/');
    expect(el.querySelector('app-productos-nuevos-resumen')).toBeNull();
    expect(el.querySelector('.cn-nota')).toBeNull();
    expect(el.querySelector('.cn-res')).toBeNull();
    expect(ths(el, '.cd')).not.toContain('¿Funcionó?');
    expect(fix.componentInstance.resultado()).toBe('seguimiento');
  });

  it('cambiar de vista NO pierde el filtro: Detallado → Sencillo sigue en Productos nuevos', async () => {
    const detallado = vi.fn(() => of(LISTA_NUEVOS()));
    const { fix } = await montar({}, { modo: 'detallado', detallado, url: '/?mostrar=nuevos' });
    fix.componentInstance.alternarVista();
    await settle(fix);
    expect(fix.componentInstance.nuevosActivo()).toBe(true);
    expect(ths(fix.nativeElement, '.cs')).toContain('¿Funcionó?');
  });

  it('⛔ si el servidor no pudo aplicar Productos nuevos (sin calcular), se DICE: la lista no se hace pasar por él', async () => {
    const detallado = vi.fn(() => of(LISTA_D({ mostrar: 'todos', resultado: null, conteos_lanzamiento: null })));
    const { fix } = await montar({}, { modo: 'detallado', detallado, url: '/?mostrar=nuevos' });
    expect(texto(fix.nativeElement.querySelector('.cd-aviso[role="status"]'))).toContain('Productos nuevos se está calculando');
  });

  it('⭐ la ficha de un producto nuevo sabe que lo es (la sección «Lanzamiento» no pregunta de más)', async () => {
    const detallado = vi.fn(() => of(LISTA_NUEVOS()));
    const { fix } = await montar({}, { modo: 'detallado', detallado, url: '/?mostrar=nuevos' });
    fix.componentInstance.abrirDetallada(LISTA_NUEVOS().filas[0]);
    expect(fix.componentInstance.abierto()?.esNuevo).toBe(true);
    // Sin el filtro, un renglón que el servidor midió y no es nuevo: la ficha ni lo pide.
    fix.componentInstance.abrirDetallada({ ...LISTA_D().filas[0], lanzamiento: null });
    expect(fix.componentInstance.abierto()?.esNuevo).toBe(false);
    // Un servidor anterior (sin la llave): no se sabe.
    fix.componentInstance.abrirDetallada(LISTA_D().filas[0]);
    expect(fix.componentInstance.abierto()?.esNuevo).toBeNull();
  });

  it('listaSencilloDeDetallado: los mismos renglones, los conteos con sus nombres de Sencillo y lo que se aplicó', () => {
    const l = listaSencilloDeDetallado(LISTA_NUEVOS());
    expect(l.mostrar).toBe('nuevos');
    expect(l.conteos).toEqual({ todos: 3, variosCodigos: 1, sinCodigo: 0, sinPrecio: null, nuevos: 140 });
    expect(l.conteos_lanzamiento).toEqual(CONTEOS_LZ);
    expect(listaSencilloDeDetallado(LISTA_D()).mostrar).toBe('todos');
  });

  it('vacioNuevos: dice qué resultado quedó vacío y a dónde ir', () => {
    expect(vacioNuevos('nuevos', 'sacar')?.titulo).toBe('Ningún producto nuevo en «Sacar»');
    expect(vacioNuevos('nuevos', 'seguimiento')?.pista).toContain('sin movimiento');
    expect(vacioNuevos('todos', 'sacar')).toBeNull();
  });
});
