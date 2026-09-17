/**
 * WMS-BI.4.7 — Candado del componente real (no de la regla suelta: eso está en
 * `almacen-analisis-bi.reactividad.spec.ts`).
 *
 * Prueba las tres cosas que esta entrega arregló, contra la clase de verdad:
 *
 *   1. **La carrera al paginar.** Medido contra prod, la pestaña tardaba 19.4 s en frío y 3–5 s
 *      en caliente. Cada `loadMovements()` abría su propio `subscribe()`, así que tocar el
 *      paginador varias veces dejaba N requests en vuelo y pintaba **la que contestara última**.
 *      Acá se emiten 3 respuestas FUERA DE ORDEN a propósito (la vieja llega al final) y se exige
 *      que la tabla termine mostrando la ÚLTIMA PEDIDA. Sin `switchMap` esta prueba se pone roja.
 *
 *   2. **El desplegable de Almacén sigue a la Zona.** `warehouseOptsFiltered` era un `computed()`
 *      sobre un campo plano: servía caché para siempre.
 *
 *   3. **Las columnas de "Explorar datos" siguen a las casillas.** Mismo defecto, versión peor:
 *      ese `computed` no tenía NINGUNA dependencia de señal.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { MessageService } from 'primeng/api';
import { Subject, of } from 'rxjs';

import { AlmacenAnalisisBiComponent } from './almacen-analisis-bi.component';
import { AlmacenBiService, BiFilters, BiMovementPage } from '../almacen-bi.service';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';

const FILTROS: BiFilters = {
  zones: [
    {
      zone_id: 'z1', zone_name: 'Bajío', warehouses: [
        { id: 'w1', code: '01', name: 'PH', zone_id: 'z1', zone_name: 'Bajío', has_movements_feed: true },
        { id: 'w2', code: '02', name: 'La Piedad', zone_id: 'z1', zone_name: 'Bajío', has_movements_feed: true },
      ],
    },
    {
      zone_id: 'z2', zone_name: 'Morelia', warehouses: [
        { id: 'w3', code: 'MD-30', name: 'Abastos', zone_id: 'z2', zone_name: 'Morelia', has_movements_feed: false },
      ],
    },
  ],
  doc_types: [],
  scope: { mode: 'all', resolvable: true, warehouse_count: null },
  movements_as_of: { max_doc_date: '2026-09-14', max_imported_at: '2026-09-14T21:24:08Z', total_rows: 3699345, total_rows_estimated: true },
  inventory_as_of: '2026-09-14T22:00:00Z',
};

const pagina = (page: number): BiMovementPage => ({
  page, pageSize: 50, total: 136242,
  rows: [{ folio: `F-${page}` } as never],
  unit_provenance: { source: 'mv', refreshed_at: '2026-09-14T12:00:00Z' },
});

/** La fila real que destapó WMS-BI.4.2: una orden de compra del CEDIS. */
const COMPRA = {
  doc_date: '2026-09-14', doc_code: 'ApEntOr1', movement_label: 'Aplicación de orden de entrada',
  warehouse_code: '00', zone_name: null, folio: '0009659', sku: '00022',
  aplica_venta: false, source_branch: '00', source_system: 'kepler',
  canal: null, vendedor: null, importe_venta: null, iva_valor: null, ieps_valor: null, venta_neta: null,
} as unknown as import('../almacen-bi.service').BiMovementRow;

/** Una venta de Wincaja: el bloque que antes caía entero del lado del costo. */
const VENTA_WIN = {
  ...COMPRA, doc_code: 'WIN_V', movement_label: 'Venta', warehouse_code: 'MD-30',
  aplica_venta: true, source_branch: 'W30', source_system: 'wincaja',
  canal: null, vendedor: null,
} as unknown as import('../almacen-bi.service').BiMovementRow;

/**
 * jsdom no implementa `ResizeObserver` y `p-tablist` de PrimeNG lo usa en `ngAfterViewInit`.
 * Es una carencia del entorno de prueba, no del componente — se stubea acá en vez de dejar de
 * montar el componente de verdad (que es justo lo que esta suite existe para hacer).
 */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

describe('AlmacenAnalisisBiComponent · WMS-BI.4.7', () => {
  let movSubjects: Subject<BiMovementPage>[];
  let biMock: Partial<AlmacenBiService>;

  beforeEach(() => {
    movSubjects = [];
    biMock = {
      filters: () => of(FILTROS),
      fields: () => of([]),
      summary: () => of(null as never),
      explore: () => of({ page: 1, pageSize: 25, total: 0, rows: [] }),
      movements: () => {
        const s = new Subject<BiMovementPage>();
        movSubjects.push(s);
        return s.asObservable();
      },
    };

    TestBed.configureTestingModule({
      imports: [AlmacenAnalisisBiComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        MessageService,
        { provide: AlmacenBiService, useValue: biMock },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: ThemeService, useValue: { isMonochrome: () => false } },
      ],
    });
  });

  function crear() {
    const f = TestBed.createComponent(AlmacenAnalisisBiComponent);
    f.detectChanges();
    return f.componentInstance;
  }

  it('la ÚLTIMA página pedida es la que pinta, aunque una anterior conteste después', () => {
    const c = crear();
    movSubjects.length = 0;                      // descarta la carga inicial

    c.movPage.set(2); c.loadMovements();
    c.movPage.set(3); c.loadMovements();
    c.movPage.set(4); c.loadMovements();

    // `switchMap` desuscribe las dos primeras: sólo la última sigue viva.
    expect(movSubjects.length).toBe(3);
    expect(movSubjects[0].observed).toBe(false);
    expect(movSubjects[1].observed).toBe(false);
    expect(movSubjects[2].observed).toBe(true);

    // La respuesta VIEJA llega primero (el servidor tardó más con ella) y NO debe pintar.
    movSubjects[0].next(pagina(2));
    expect(c.movRows().length).toBe(0);

    movSubjects[2].next(pagina(4));
    expect((c.movRows()[0] as { folio: string }).folio).toBe('F-4');

    // Y una rezagada que llega al final tampoco pisa a la buena.
    movSubjects[1].next(pagina(3));
    expect((c.movRows()[0] as { folio: string }).folio).toBe('F-4');
  });

  it('elegir una Zona vuelve a filtrar el desplegable de Almacén', () => {
    const c = crear();
    expect(c.warehouseOptsFiltered().length).toBe(3);

    c.selectedZoneIds.set(['z2']);
    expect(c.warehouseOptsFiltered().length).toBe(1);
    expect(c.warehouseOptsFiltered()[0].label).toContain('MD-30');

    c.selectedZoneIds.set([]);
    expect(c.warehouseOptsFiltered().length).toBe(3);
  });

  it('tildar un campo en Explorar cambia las columnas de la tabla', () => {
    const c = crear();
    const antes = c.selectedFields().length;

    c.toggleField('unidad_base');
    expect(c.selectedFields().length).not.toBe(antes);
    expect(c.isFieldSelected('unidad_base')).toBe(false);   // venía por default

    c.toggleField('unidad_base');
    expect(c.selectedFields().length).toBe(antes);
    expect(c.isFieldSelected('unidad_base')).toBe(true);
  });

  it('la edad del resolvedor de unidad se IMPRIME, no se supone', () => {
    const c = crear();
    expect(c.unitProvenanceNota()).toBe('');                 // sin respuesta todavía: no inventa

    movSubjects.length = 0;
    c.loadMovements();
    movSubjects[0].next(pagina(1));
    expect(c.unitProvenanceNota()).toContain('copia materializada');

    movSubjects.length = 0;
    c.loadMovements();
    movSubjects[0].next({ ...pagina(1), unit_provenance: { source: 'view', refreshed_at: null } });
    expect(c.unitProvenanceNota()).toContain('en vivo');
  });

  it('WMS-BI.4.2 · "No aplica" no se confunde con "No disponible"', () => {
    const c = crear();
    // Una orden de compra: canal, vendedor, IVA y venta neta NO corresponden.
    expect(c.faltaVenta(COMPRA)).toBe('No aplica');
    expect(c.tituloVenta(COMPRA)).toContain('no es una venta');
    // Una venta a la que el feed no le trajo el dato: ahí SÍ falta.
    expect(c.faltaVenta(VENTA_WIN)).toBe('No disponible');
    expect(c.tituloVenta(VENTA_WIN)).toContain('no vino en el feed');
  });

  it('WMS-BI.4.2 · la columna Sistema deja de decir "Kepler" sobre filas de Wincaja', () => {
    const c = crear();
    expect(c.sistemaDe(COMPRA)).toBe('Kepler');
    expect(c.sistemaDe(VENTA_WIN)).toBe('Wincaja');
  });

  it('el folio arma un enlace real al documento (no un window.open simulado)', () => {
    const c = crear();
    const href = c.docHref(COMPRA);
    expect(href).toContain('/almacen/analisis-bi/documento');
    expect(href).toContain('folio=0009659');
    expect(href).toContain('doc_code=ApEntOr1');
  });

  it('colOn() usa el Set y sigue a la selección de columnas', () => {
    const c = crear();
    expect(c.colOn('folio')).toBe(true);
    c.visibleMovCols.set(['doc_date']);
    expect(c.colOn('folio')).toBe(false);
    expect(c.colOn('doc_date')).toBe(true);
  });
});
