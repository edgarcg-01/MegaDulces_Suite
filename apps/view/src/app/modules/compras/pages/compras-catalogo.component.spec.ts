import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ProductosFlujoService } from '../productos-flujo.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { CatalogoLista, CatalogoListaDetallada, CatalogoProductosService } from '../catalogo-productos.service';
import { ComprasCatalogoComponent, claveVista, equivaleTexto, siguienteOrden } from './compras-catalogo.component';

const tick = async (fix: ComponentFixture<unknown>) => { fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };
const texto = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** La lista de Sencillo como la manda el servidor (conteos de la búsqueda entera). */
const LISTA_S = (over: Partial<CatalogoLista> = {}): CatalogoLista => ({
  sucursal: '01', total: 2, calculado_al: '2026-10-26T18:00:00Z', mostrar: 'todos',
  conteos: { todos: 2, variosCodigos: 1, sinCodigo: 0, sinPrecio: 1 },
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
    ],
  }).compileComponents();
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
    expect(Array.from(a.querySelectorAll('.cd-tag')).map((t) => texto(t))).toEqual(['Líder #4', 'Caducado']);
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
    });
    expect(document.querySelector('app-producto-ficha-detallada')).not.toBeNull();
    expect(document.querySelector('app-producto-ficha')).toBeNull();
    expect(flujo.detalle).toHaveBeenCalledWith('q-1');
    expect(catalogo.ficha).toHaveBeenCalledWith('q-1', null);
    expect(document.body.textContent).not.toContain('Editar producto');
    fix.componentInstance.cerrarFlujo();
    await pintar();
    filasD(fix)[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await pintar();
    expect(fix.componentInstance.abierto()?.id).toBe('q-2');
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
    expect(opciones(fix).map(opcionTexto)).toEqual(['Todos 2', 'Con varios códigos 1', 'Sin código de barras 0', 'Alguna unidad sin precio 1']);
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
    expect(fix.componentInstance.abierto()).toEqual({ id: 'q-1', nombre: 'La Rosa Mazapan /30', sku: '70001', proveedor: 'Distribuidora de la Rosa', tipo: 'ficha' });
    expect(catalogo.ficha).toHaveBeenCalledWith('q-1', null);
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
