import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { Observable, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { CatalogoProductosService, ComprasProducto, FichaProducto } from '../catalogo-productos.service';
import { FlujoDetalle, MargenesProducto, PlazaFlujo, ProductosFlujoService } from '../productos-flujo.service';
import { ProductoFichaDetalladaComponent } from './producto-ficha-detallada.component';
import { ProductosNuevosService } from '../productos-nuevos.service';
import { DETALLE as DETALLE_NUEVO, producto as productoNuevo } from '../../../../testing/productos-nuevos.fixture';

// Mazapán: base PAQ, caja de 20 PAQ.
const FICHA: FichaProducto = {
  id: 'p-1', sku: '70001', nombre: 'MAZAPAN DE LA ROSA 30G', descripcion: null, activo: true,
  proveedor: { id: 'pr-1', nombre: 'DULCES DE LA ROSA SA DE CV' },
  codigos: ['7501234567890'],
  unidadBase: 'PAQ',
  unidades: [
    { unidad: 'PAQ', equivale: null, factorBase: 1, precio: 84.5, mayoreo: null },
    { unidad: 'CJA', equivale: { cantidad: 20, unidad: 'PAQ' }, factorBase: 20, precio: 1594.96, mayoreo: null },
  ],
  precioRed: { sucursales: 8, min: 84.5, max: 84.5 },
  sucursales: [
    { codigo: '01', nombre: 'PADRE HIDALGO', vendidoMes: { monto: 12000, unidadesBase: 142 }, existenciaBase: 1305 },
    { codigo: '04', nombre: 'YURECUARO', vendidoMes: { monto: 3000, unidadesBase: 35 }, existenciaBase: 0 },
  ],
  corteVenta: '2026-10-25',
  ultimaEntrada: null,
  costo_visible: false,
  calculado_al: '2026-10-26T15:00:00.000Z',
};

const plaza = (p: string, over: Partial<PlazaFlujo> = {}): PlazaFlujo => ({
  plaza: p, nombre: null, mes: 0, mes_anterior_mismo: 0, mes_anterior_total: 0, variacion: null, venta_dia: 0, unidades_dia: 0,
  ultima_venta: null, dias_sin_venta: 2, existencia: null, existencia_duda: null, existencia_usada: null, cobertura_dias: null,
  estado: 'se_mueve', motivo: '', escalera: null, inmovilizado: null, ...over,
});

const DETALLE = (over: Partial<FlujoDetalle> = {}): FlujoDetalle => ({
  product_id: 'p-1', sku: '70001', nombre: 'MAZAPAN', corte: '2026-10-25', en_vivo_al: '2026-10-26T15:00:00Z', costo_visible: false,
  periodos: { hoy: '2026-10-26', mesIni: '2026-10-01', dias: 26, prevIni: '2026-09-01', prevFin: '2026-09-27', desde30: '2026-09-27', desdeHistoria: '2026-06-28' },
  criterio: { ventanaRitmo: 30, ventanaHistoria: 120, diasEstancado: 14, caidaFrenado: 0.5, diasMinimosComparar: 7, coberturaComprar: 15,
    coberturaSobra: 60, coberturaQueSeQueda: 30, ventanaReparto: 90, lideresCorte: 0.5, coberturaComprarLider: 21, caducidadAviso: 30,
    diasSinVenta: 30, ventanaSinVenta: 365, ventanaNuevos: 90, limiteNoSeVenden: 300, ventanaMargen: 30 } as FlujoDetalle['criterio'],
  resumen: {
    product_id: 'p-1', mes: 15000, mes_anterior_mismo: 12000, mes_anterior_total: 40000, variacion: 0.25, venta_dia: 500,
    estancadas: [], frenadas: [], agotadas: [{ plaza: '04', nombre: 'YURECUARO', venta_dia: 100 }],
    compra: { veredicto: 'traspasar', titulo: 'No comprar: mover entre sucursales', motivos: ['Agotado en Yurécuaro y sobra en Padre Hidalgo'],
      impacto: [], traspasos: [{ desde: '01', desde_nombre: 'PADRE HIDALGO', hacia: '04', hacia_nombre: 'YURECUARO', cantidad: 45 }],
      cobertura_dias: 40, se_acaba: null, venta_en_riesgo_dia: 100, inmovilizado: null },
    lider: { rank: 4, participacion: 0.02 }, caducidad: null,
  },
  serie: { dias: [], actual: [], anterior: [] },
  plazas: [plaza('01', { dias_sin_venta: 0 }), plaza('04', { dias_sin_venta: 3, estado: 'agotado' })],
  llegada: { primera_compra: null, primera_compra_plazas: [], ultima_compra: null, ultima_compra_plazas: [] },
  reparto: [], escalera: null, lotes: [],
  ...over,
});

const COMPRAS: ComprasProducto = {
  desde: '2026-07-29', dias: 90, entradas: 3, primera: '2026-08-02', costo_visible: false,
  comprado: [{ unidad: 'CJA', cantidad: 10 }],
  ultima: { fecha: '2026-10-21', sucursal: '01', nombreSucursal: 'PADRE HIDALGO', cantidad: 4, unidad: 'CJA', costo: null },
};

const tick = async (fix: ComponentFixture<unknown>) => {
  for (let i = 0; i < 3; i++) { fix.detectChanges(); await fix.whenStable(); }
  fix.detectChanges();
};
/** El texto como lo lee una persona: cada nodo de texto separado (las celdas no se pegan). */
const texto = (el: Element | null | undefined) => {
  if (!el) return '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const xs: string[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) xs.push(n.textContent ?? '');
  return xs.join(' ').replace(/\s+/g, ' ').trim();
};

/** [PF.22] La ficha con la última entrada (CJA) y su costo en cada unidad. */
const CON_COSTO = (costo: number | null, impuesto: 'neto' | 'descontado' | 'sin_dato' = 'neto'): FichaProducto => ({
  ...FICHA, costo_visible: true,
  ultimaEntrada: { sucursal: '01', nombreSucursal: 'PADRE HIDALGO', fecha: '2026-10-21', cantidad: 4, unidad: 'CJA', costo, impuesto,
    porUnidad: costo === null ? [] : [
      { unidad: 'PAQ', costo: costo / 20, precioSinImpuestos: null, bajoCosto: null },
      { unidad: 'CJA', costo, precioSinImpuestos: null, bajoCosto: null },
    ] },
});

async function montar(opts: {
  detalle?: () => Observable<FlujoDetalle>; margenes?: () => Observable<MargenesProducto>; compras?: () => Observable<ComprasProducto>;
  /** [PF.22] La ficha: de ella sale el último costo (por cada unidad), igual que en Sencillo. */
  ficha?: () => Observable<FichaProducto>;
  etiquetas?: { lider: number | null; nuevo: string | null; caducidad: 'caducado' | 'pronto' | null } | null;
  /** Las claves que tiene el usuario (por defecto, la de Pedido). */
  permisos?: string[];
  /** [NP.22] GET new-products/:id. Por default 404: el producto no es nuevo y «Lanzamiento» no pinta nada. */
  nuevo?: () => Observable<unknown>; esNuevo?: boolean | null;
} = {}) {
  const permisos = new Set(opts.permisos ?? [Permission.COMPRAS_PEDIDO_VER]);
  const flujo = { detalle: vi.fn(opts.detalle ?? (() => of(DETALLE()))), margenes: vi.fn(opts.margenes ?? (() => of({ total: null } as unknown as MargenesProducto))) };
  const catalogo = { ficha: vi.fn(opts.ficha ?? (() => of(FICHA))), compras: vi.fn(opts.compras ?? (() => of(COMPRAS))), lista: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [ProductoFichaDetalladaComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: { has: (k: string) => permisos.has(k) } },
      { provide: CatalogoProductosService, useValue: catalogo },
      { provide: ProductosFlujoService, useValue: flujo },
      { provide: ProductosNuevosService, useValue: { listar: vi.fn(),
        detalle: vi.fn(opts.nuevo ?? (() => throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' })))) } },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(ProductoFichaDetalladaComponent);
  fix.componentRef.setInput('productId', 'p-1');
  fix.componentRef.setInput('etiquetas', opts.etiquetas === undefined ? { lider: 4, nuevo: null, caducidad: 'caducado' } : opts.etiquetas);
  if (opts.esNuevo !== undefined) fix.componentRef.setInput('esNuevo', opts.esNuevo);
  await tick(fix);
  return { fix, flujo, catalogo };
}

describe('Ficha detallada (Compras › Catálogo › Detallado)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('[PF.UI.1] «Ir a Pedido con este producto» abre Pedido con el SKU buscado; sin permiso de Pedido no aparece', async () => {
    const { fix } = await montar();
    const a = (fix.nativeElement as HTMLElement).querySelector('.compra a.ir-pedido') as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(texto(a)).toBe('Ir a Pedido con este producto');
    expect(a!.getAttribute('href')).toBe('/compras/pedido?search=70001');
    TestBed.resetTestingModule();
    // [negativa] sin la clave de Pedido el enlace llevaría a una pantalla que el guard rechaza: no se pinta.
    const sin = await montar({ permisos: [] });
    expect((sin.fix.nativeElement as HTMLElement).querySelector('a.ir-pedido')).toBeNull();
  });

  it('⭐ el orden aprobado: etiquetas, identidad, unidades, qué hacer, sucursales, cómo va, compras; sin «Editar producto»', async () => {
    const { fix } = await montar();
    const el = fix.nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('.tag')).map((t) => texto(t))).toEqual(['Top venta #4', 'Caducado']);
    expect(Array.from(el.querySelectorAll('.bloque-t')).map((h) => texto(h))).toEqual([
      'Unidades y precio', 'Qué hacer', 'Dónde se mueve y dónde se estancó', '¿Cómo va la venta este mes?', 'Compras', // [PF.23] el periodo lo dice su selector
    ]);
    // Etiquetas antes que la identidad.
    expect(el.querySelector('.tags')!.compareDocumentPosition(el.querySelector('.ident')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.textContent).not.toContain('Editar producto');
    // [negativa] sin lotes no hay bloque de caducidad; sin permiso de costo no hay margen.
    expect(el.textContent).not.toContain('Caducidad por lote');
    expect(el.textContent).not.toContain('Margen real');
  });

  /**
   * `[NP.22]` Un producto NUEVO trae «Lanzamiento» (lo que era el panel de Productos nuevos) justo después de Qué hacer,
   * y no repite «¿Hay que comprar?». Si el lanzamiento dice «Sacar» y Qué hacer pide mover o comprar, se explica.
   */
  it('⭐ [NP.22] producto nuevo: «Lanzamiento» después de Qué hacer, sin repetir la compra; el cruce se explica', async () => {
    const sacar = { ...DETALLE_NUEVO, producto: productoNuevo({ recomendacion: { veredicto: 'sacar', motivos: ['Lleva 25 días sin venderse'] } }) };
    const { fix } = await montar({ nuevo: () => of(sacar), esNuevo: true });
    const el = fix.nativeElement as HTMLElement;
    const lz = el.querySelector('app-producto-lanzamiento .lz')!;
    expect(lz).not.toBeNull();
    expect(el.querySelector('.compra')!.compareDocumentPosition(lz) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // La tarjeta del resultado se retiró (David): el «Sacar» está en la lista. Qué hacer de este DETALLE es «traspasar»:
    // tiran en contra, y queda UNA línea que lo explica.
    expect(lz.querySelector('.lz-ver')).toBeNull();
    expect(texto(lz.querySelector('.lz-cruce'))).toContain('Antes de reponer');
    expect(lz.querySelectorAll('.lz-corte').length).toBe(3);
    expect(el.textContent).not.toContain('¿Hay que comprar?');
  });

  it('[negativa] [NP.22] un producto que no es nuevo (404) no trae «Lanzamiento» ni un error', async () => {
    const { fix } = await montar();
    const el = fix.nativeElement as HTMLElement;
    expect(el.querySelector('app-producto-lanzamiento .lz')).toBeNull();
    expect(el.textContent).not.toContain('No se pudo leer el lanzamiento');
  });

  it('⭐ Qué hacer: el veredicto del motor, su porqué y los traspasos en cajas y paquetes', async () => {
    const { fix } = await montar();
    const q = fix.nativeElement.querySelector('.compra') as HTMLElement;
    expect(q.classList.contains('q-traspasar')).toBe(true);
    expect(texto(q.querySelector('.q-chip'))).toBe('Mover entre sucursales');
    expect(texto(q.querySelector('.q-titulo'))).toBe('No comprar: mover entre sucursales');
    expect(texto(q)).toContain('Mover antes de comprar');
    expect(texto(q)).toContain('2 CJA 5 PAQ de Padre Hidalgo a Yurecuaro');
  });

  it('⭐ sucursales: Vendido este mes, Existencia y Sin vender (compuestos), con la etiqueta correcta en cada celda', async () => {
    const { fix } = await montar();
    const tabla = fix.nativeElement.querySelector('.fd-suc') as HTMLElement;
    expect(Array.from(tabla.querySelectorAll('thead th')).map((t) => texto(t))).toEqual(['Sucursal', 'Vendido este mes', 'Existencia', 'Sin vender']);
    const [a, b] = Array.from(tabla.querySelectorAll('tbody tr')) as HTMLElement[];
    expect(Array.from(a.querySelectorAll('td[data-label]')).map((t) => t.getAttribute('data-label'))).toEqual(['Vendido este mes', 'Existencia', 'Sin vender']);
    expect(texto(a)).toBe('Padre Hidalgo $12,000 7 CJA 2 PAQ 65 CJA 5 PAQ Hoy vendió');
    expect(texto(b)).toBe('Yurecuaro $3,000 1 CJA 15 PAQ Agotado 3 días');
    // Quitadas por el usuario: Estado y Alcanza.
    expect(texto(tabla)).not.toContain('Alcanza');
    expect(texto(tabla)).not.toContain('Estado');
  });

  it('⭐ cómo va la venta: título con flecha, una frase y dos barras con su monto (sin gráfica)', async () => {
    const { fix } = await montar();
    const vb = fix.nativeElement.querySelector('.vb') as HTMLElement;
    expect(texto(vb.querySelector('.vb-titulo'))).toBe('▲ Vende más que el mes pasado');
    expect(vb.querySelector('.vb-sube')).not.toBeNull();
    // [PF.UI.4] la frase termina diciendo la base de la venta: con impuestos y sin camionetas.
    expect(texto(vb.querySelector('.vb-frase'))).toBe('Del 1 al 26 lleva $15,000: $3,000 más que en los mismos días de septiembre. Venta con IVA e IEPS registrada en Kepler (sin lo que venden las camionetas).');
    expect(Array.from(vb.querySelectorAll('.vb-fila')).map((f) => texto(f))).toEqual(['Octubre (1 al 26) $15,000', 'Septiembre (1 al 26) $12,000']);
    expect(vb.querySelector('svg')).toBeNull();
  });

  it('⭐ con permiso de costo: margen real con la venta sin impuestos y lo que cubre el costo; y el costo de la última compra', async () => {
    const { fix, flujo } = await montar({
      detalle: () => of(DETALLE({ costo_visible: true })),
      margenes: () => of({ total: { venta_neta: 10500, real: { pct: 13.6, utilidad: 1428, cobertura: 0.82, nota: null } } } as unknown as MargenesProducto),
      ficha: () => of(CON_COSTO(1250)),
    });
    const t = texto(fix.nativeElement);
    expect(flujo.margenes).toHaveBeenCalledWith('p-1');
    expect(t).toContain('Margen real (últimos 30 días)');
    expect(t).toContain('13.6%');
    expect(t).toContain('$10,500');
    expect(t).toContain('el costo cubre el 82 %');
    expect(t).toContain('Último costo $62.50 por PAQ $1,250.00 por CJA');
  });

  it('⭐ [PF.12.3] el costo de la última se ve con la regla del CATÁLOGO, separado del margen: sin permiso de costo no hay margen, pero sí el costo sin IVA ni IEPS', async () => {
    const { fix, flujo } = await montar({
      // El flujo (margen) dice que no; la ficha (regla del catálogo) dice que sí.
      ficha: () => of(CON_COSTO(1250, 'neto')),
    });
    const t = texto(fix.nativeElement);
    expect(flujo.margenes).not.toHaveBeenCalled();
    expect(t).not.toContain('Margen real');
    // [PF.22] Por paquete Y por caja, a un lado (como Sencillo).
    expect(t).toContain('Último costo $62.50 por PAQ $1,250.00 por CJA sin IVA ni IEPS');
    // El candado de «sólo con permiso de costo» ya no aplica a este dato.
    expect(t).not.toContain('sólo con permiso de costo');
  });

  it('⭐ [PF.23] Compras con periodo: lo dice, pide ese periodo al servidor y declara las sucursales que no lo tienen completo en Kepler', async () => {
    const compras = vi.fn((_id: string, p?: { desde: string; hasta: string } | null) => of({
      ...COMPRAS,
      ...(p ? { desde: p.desde, hasta: p.hasta, dias: 365 } : {}),
      incompletas: p ? [{ codigo: '01', nombre: 'PADRE HIDALGO', corte: '2026-07-01' }, { codigo: '09', nombre: null, corte: null }] : [],
    }));
    const { fix, catalogo } = await montar({ compras: compras as unknown as () => Observable<ComprasProducto> });
    const el = fix.nativeElement as HTMLElement;
    // Por omisión: sin fechas (el servidor usa los últimos 90 días) y sin aviso de incompletas.
    expect(catalogo.compras).toHaveBeenCalledWith('p-1');
    expect(el.querySelector('app-periodo-ficha')).not.toBeNull();
    expect(texto(el)).not.toContain('No incluye lo que compraron');
    // Elegir «Año pasado» manda las fechas.
    const sel = fix.debugElement.query((d) => d.name === 'app-periodo-ficha').componentInstance as { cambio: { emit: (p: unknown) => void } };
    sel.cambio.emit({ desde: '2025-01-01', hasta: '2025-12-31' });
    fix.detectChanges(); await Promise.resolve(); await Promise.resolve(); fix.detectChanges();
    expect(catalogo.compras).toHaveBeenLastCalledWith('p-1', { desde: '2025-01-01', hasta: '2025-12-31' });
    const t = texto(el);
    expect(t).toContain('Del 1 ene 2025 al 31 dic 2025');
    expect(t).toContain('No incluye lo que compraron antes de entrar a Kepler: Padre Hidalgo (en Kepler desde el 1 jul 2026)');
    expect(t).toContain('(sin corte a Kepler)');
  });

  it('⛔ [PF.12.3] visible pero la entrada no trae costo: lo dice (nunca $0)', async () => {
    const { fix } = await montar({ ficha: () => of(CON_COSTO(null)) });
    const t = texto(fix.nativeElement);
    expect(t).toContain('Último costo Sin costo en la entrada');
    expect(t).not.toContain('$0.00');
  });

  it('[negativa] sin permiso de costo NO se pide el margen ni se pinta un costo', async () => {
    const { fix, flujo } = await montar();
    expect(flujo.margenes).not.toHaveBeenCalled();
    expect(texto(fix.nativeElement)).not.toContain('Último costo');
    expect(texto(fix.nativeElement)).toContain('Entradas 3');
    expect(texto(fix.nativeElement)).toContain('Comprado 10 CJA');
  });

  it('caducidad por lote: sólo si tiene lotes; «Caducó … hace N días» con lo registrado compuesto', async () => {
    const lote = { plaza: '01', nombre: 'PADRE HIDALGO', lote: 'L7', caduca: '2026-10-05', dias: -21, registrado: 45, en_existencia: 45,
      se_vende_antes: 0, queda: 45, estado: 'caducado' as const, accion: '', mover_a: [], sin_destino: 0, escalera: null };
    const { fix } = await montar({ detalle: () => of(DETALLE({ lotes: [lote] })) });
    const t = texto(fix.nativeElement);
    expect(t).toContain('Caducidad por lote');
    expect(t).toContain('Padre Hidalgo Lote L7 Caducó 5 oct hace 21 días 2 CJA 5 PAQ');
  });

  it('⛔ si el flujo falla, lo dice en su bloque (no un veredicto inventado); la identidad y el precio siguen', async () => {
    const { fix } = await montar({ detalle: () => throwError(() => ({ error: { message: 'El producto no tiene código de Kepler' } })) });
    const t = texto(fix.nativeElement);
    expect(t).toContain('El producto no tiene código de Kepler');
    expect(t).toContain('Unidades y precio');
    expect(t).not.toContain('Mover entre sucursales');
  });
});
