import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';

import { ComercialService, PriceReportResponse, PriceReportRow } from '../../comercial/comercial.service';
import { ComprasCatalogoReporteComponent } from './compras-catalogo-reporte.component';

// `p-table` observa su tamaño con ResizeObserver, que jsdom no trae. El doble no hace nada a
// propósito: acá no se mide layout, se mide qué llega al DOM.
if (typeof (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] === 'undefined') {
  (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = class {
    observe(): void { /* jsdom no hace layout */ }
    unobserve(): void { /* jsdom no hace layout */ }
    disconnect(): void { /* jsdom no hace layout */ }
  };
}

/**
 * `[CAT.7]` — **La pantalla del reporte de precios, montada.**
 *
 * Por qué montarla y no probar sólo la lógica: `tsc` no mira dentro de una plantilla de Angular.
 * Un `@for` sobre una señal que no existe, un binding mal escrito o un `p-tableCheckbox` sin su
 * `dataKey` compilan perfecto y revientan recién en el navegador. Montar el componente ES la
 * compuerta del template.
 *
 * Lo que se comprueba, en este orden:
 *  1. Que NO pida datos hasta que haya un proveedor elegido (son 8,700 productos).
 *  2. Que las columnas tildadas sean las que salen en la tabla **y** en la hoja.
 *  3. Que la hoja impresa DECLARE de qué plaza es el precio y de cuándo — las dos cosas que en
 *     papel no se pueden deducir.
 *  4. Que un renglón sin precio salga con guion, nunca con `$0.00`.
 */

const FECHA = '2026-09-12T01:32:16.492Z';

const fila = (extra: Partial<PriceReportRow> = {}): PriceReportRow => ({
  product_id: 'p1',
  sku: '70002',
  nombre: 'LA ROSA MAZAPAN 12',
  activo: true,
  cost_base: '18.9000',
  supplier_id: 's1',
  supplier_name: 'DISTRIBUIDORA DE LA ROSA',
  brand_name: 'LA ROSA',
  sucursal: '01',
  unit_base: 'PAQ',
  content: null,
  barcode: '7501030470014',
  sold_by_kg: false,
  piece_price: '32.7600',
  wholesale_piece_min_qty: null,
  wholesale_piece_price: null,
  pack_size: null,
  pack_price: null,
  wholesale_pack_min_qty: 3,
  wholesale_pack_price: '30.4200',
  box_size: 48,
  box_price: '1459.9300',
  computed_at: FECHA,
  ...extra,
});

const respuesta = (rows: PriceReportRow[], meta: Partial<PriceReportResponse['meta']> = {}): PriceReportResponse => ({
  rows,
  meta: {
    total: rows.length,
    mostrados: rows.length,
    truncado: false,
    limite: 3000,
    sucursal: null,
    sucursal_nombre: null,
    consolidado: true,
    sin_precio: rows.filter((r) => r.piece_price == null).length,
    precios_al: FECHA,
    ...meta,
  },
});

/** Lo que el componente le pide al servicio, con la forma que de verdad manda. */
interface PedidoReporte {
  supplier_ids?: string[];
  sucursal?: string | null;
  search?: string;
  only_with_price?: boolean;
}

class ApiStub {
  llamadasReporte = 0;
  ultimoPedido: PedidoReporte | null = null;
  proximo: PriceReportResponse = respuesta([fila()]);
  falla = false;

  productSuppliers() {
    return of([{ id: 's1', name: 'DISTRIBUIDORA DE LA ROSA', product_count: 310 }]);
  }
  priceReportBranches() {
    return of([{ sucursal: '03', nombre: '8ESQ', productos: 8687, computed_at: FECHA }]);
  }
  priceReport(opts: PedidoReporte) {
    this.llamadasReporte++;
    this.ultimoPedido = opts;
    return this.falla ? throwError(() => new Error('boom')) : of(this.proximo);
  }
}

describe('[CAT.7] ComprasCatalogoReporteComponent', () => {
  let fix: ComponentFixture<ComprasCatalogoReporteComponent>;
  let cmp: ComprasCatalogoReporteComponent;
  let api: ApiStub;

  const texto = (): string => (fix.nativeElement as HTMLElement).textContent ?? '';
  const hoja = (): HTMLElement | null => (fix.nativeElement as HTMLElement).querySelector('.rp-hoja');
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  beforeEach(async () => {
    api = new ApiStub();
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoReporteComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ComercialService, useValue: api },
      ],
    }).compileComponents();

    fix = TestBed.createComponent(ComprasCatalogoReporteComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  });

  afterEach(() => TestBed.resetTestingModule());

  /** Elige el proveedor y espera a que el recurso resuelva. */
  const elegirProveedor = async (): Promise<void> => {
    cmp.onProveedores(['s1']);
    fix.detectChanges();
    await tick();
  };

  it('monta sin proveedor elegido y NO pide el catálogo entero', async () => {
    expect(api.llamadasReporte).toBe(0);
    expect(texto()).toContain('Elegí un proveedor para empezar');
  });

  it('al elegir proveedor pide el reporte de ESE proveedor', async () => {
    await elegirProveedor();
    expect(api.llamadasReporte).toBe(1);
    expect(api.ultimoPedido.supplier_ids).toEqual(['s1']);
    expect(texto()).toContain('LA ROSA MAZAPAN 12');
  });

  it('los renglones entran seleccionados: elegir proveedor ya es decir "quiero lo de éste"', async () => {
    await elegirProveedor();
    expect(cmp.seleccion().length).toBe(1);
  });

  it('la tabla recibe de verdad las clases del sistema de diseño', async () => {
    // PrimeNG 22 le quitó `styleClass` a `p-table`: como atributo estático es un no-op silencioso
    // (284 tablas del repo están así, medido por `check-primeng-api.js`). Acá la clase va en el
    // HOST, y esto comprueba que efectivamente llegó al DOM en vez de suponerlo.
    await elegirProveedor();
    expect((fix.nativeElement as HTMLElement).querySelector('.surf-table')).not.toBeNull();
  });

  it('la plaza elegida viaja en el pedido — es lo que cambia el precio', async () => {
    await elegirProveedor();
    cmp.onSucursal('03');
    fix.detectChanges();
    await tick();
    expect(api.ultimoPedido.sucursal).toBe('03');
  });

  // ── Columnas ───────────────────────────────────────────────────────────
  it('las columnas por default incluyen la matriz de precios y NO el costo', async () => {
    await elegirProveedor();
    const labels = cmp.columnasVisibles().map((c) => c.label);
    expect(labels).toContain('Precio unidad');
    expect(labels).toContain('Caja');
    expect(labels).not.toContain('Costo');
    expect(texto()).not.toContain('$18.90');
  });

  it('tildar un apartado lo agrega a la tabla Y a la hoja', async () => {
    await elegirProveedor();
    cmp.toggleColumna('costo', true);
    cmp.previa.set(true);
    fix.detectChanges();
    await tick();

    expect(cmp.columnasVisibles().some((c) => c.id === 'costo')).toBe(true);
    expect(hoja()?.textContent).toContain('Costo');
    expect(hoja()?.textContent).toContain('18.90');
  });

  it('destildar un apartado lo saca de las dos', async () => {
    await elegirProveedor();
    cmp.previa.set(true);
    fix.detectChanges();
    await tick();
    expect(hoja()?.textContent).toContain('1,459.93');

    cmp.toggleColumna('caja', false);
    fix.detectChanges();
    await tick();
    expect(cmp.columnasVisibles().some((c) => c.id === 'caja')).toBe(false);
    expect(hoja()?.textContent).not.toContain('1,459.93');
  });

  it('destildar dos veces el mismo apartado no lo duplica al volver a tildarlo', async () => {
    await elegirProveedor();
    cmp.toggleColumna('caja', false);
    cmp.toggleColumna('caja', true);
    cmp.toggleColumna('caja', true);
    expect(cmp.columnasVisibles().filter((c) => c.id === 'caja').length).toBe(1);
  });

  // ── Selección de productos ─────────────────────────────────────────────
  it('sin ningún producto seleccionado no hay hoja que imprimir', async () => {
    await elegirProveedor();
    cmp.seleccionarNinguno();
    fix.detectChanges();
    await tick();
    expect(hoja()).toBeNull();
  });

  it('la hoja lleva sólo los productos seleccionados, agrupados por proveedor', async () => {
    api.proximo = respuesta([
      fila({ product_id: 'p1', nombre: 'MAZAPAN', supplier_name: 'LA ROSA' }),
      fila({ product_id: 'p2', nombre: 'PALETA', supplier_name: 'SANDOVAL' }),
    ]);
    await elegirProveedor();

    cmp.seleccion.set(cmp.filas().filter((r) => r.product_id === 'p1'));
    cmp.previa.set(true);
    fix.detectChanges();
    await tick();

    const grupos = cmp.gruposImpresion();
    expect(grupos.length).toBe(1);
    expect(grupos[0].proveedor).toBe('LA ROSA');
    // Legible, no la caja alta del ERP: el humanizador de [PF.9].
    expect(hoja()?.textContent).toContain('Mazapan');
    expect(hoja()?.textContent).not.toContain('PALETA');
  });

  // ── Lo que la hoja tiene que DECLARAR ──────────────────────────────────
  it('⛔ la hoja dice que el precio es CONSOLIDADO cuando no hay plaza elegida', async () => {
    await elegirProveedor();
    cmp.previa.set(true);
    fix.detectChanges();
    await tick();
    expect(hoja()?.textContent).toContain('Consolidado');
    expect(hoja()?.textContent).toContain('no distingue sucursal');
  });

  it('con plaza elegida, la hoja lleva el NOMBRE de esa plaza', async () => {
    api.proximo = respuesta([fila()], { consolidado: false, sucursal: '03', sucursal_nombre: '8ESQ' });
    await elegirProveedor();
    cmp.previa.set(true);
    fix.detectChanges();
    await tick();
    expect(hoja()?.textContent).toContain('8ESQ');
    expect(hoja()?.textContent).not.toContain('Consolidado');
  });

  it('⛔ sin fecha de cómputo, la hoja lo DICE en vez de dar a entender que es de hoy', async () => {
    api.proximo = respuesta([fila({ computed_at: null })], { precios_al: null });
    await elegirProveedor();
    cmp.previa.set(true);
    fix.detectChanges();
    await tick();
    expect(hoja()?.textContent).toContain('sin fecha declarada');
    expect(cmp.procedencia().alerta).toBe(true);
    expect(cmp.procedencia().titulo).toContain('No se sabe de cuándo');
  });

  it('un precio viejo se marca como viejo, con sus días', async () => {
    const hace30 = new Date(Date.now() - 30 * 86400000).toISOString();
    api.proximo = respuesta([fila()], { precios_al: hace30 });
    await elegirProveedor();
    expect(cmp.procedencia().alerta).toBe(true);
    expect(cmp.procedencia().titulo).toMatch(/30 días sin recalcularse/);
  });

  it('un precio reciente no grita', async () => {
    api.proximo = respuesta([fila()], { precios_al: new Date().toISOString() });
    await elegirProveedor();
    expect(cmp.procedencia().alerta).toBe(false);
  });

  it('el recorte por tope se declara: un corte mudo se lee como "no hay más"', async () => {
    api.proximo = respuesta([fila()], { truncado: true, total: 4200, limite: 3000 });
    await elegirProveedor();
    expect(texto()).toContain('La lista se cortó');
    expect(texto()).toContain('4200');
  });

  // ── El hueco de datos ──────────────────────────────────────────────────
  it('⛔ un producto sin precio sale con guion, jamás con $0.00', async () => {
    api.proximo = respuesta([
      fila({ piece_price: null, wholesale_pack_price: null, box_price: null }),
    ]);
    await elegirProveedor();
    cmp.previa.set(true);
    fix.detectChanges();
    await tick();

    expect(hoja()?.textContent).toContain('—');
    expect(hoja()?.textContent).not.toContain('$0.00');
    expect(cmp.procedencia().detalle).toContain('no tienen precio cargado');
  });

  // ── Errores ────────────────────────────────────────────────────────────
  it('un fallo de red muestra el banner con reintento, no una tabla vacía', async () => {
    api.falla = true;
    await elegirProveedor();
    expect(cmp.error()).toBe(true);
    expect(texto()).toContain('No se pudo cargar el reporte');
  });

  // ── Impresión ──────────────────────────────────────────────────────────
  //
  // El 2026-10-13 la hoja salía de la impresora como una captura de pantalla: la migaja
  // "Comercial / Compras / Reabastecimiento / Catálogo", el aviso de "hay una versión nueva" y
  // los botones, todo encima de la tabla de precios. La causa no era una regla que faltara: era
  // que las reglas estaban en los estilos del COMPONENTE, que Angular encapsula, así que no
  // podían alcanzar a nada de afuera. Estos cuatro candados vigilan el mecanismo que lo
  // reemplazó, no su resultado visual — lo visual no se puede medir desde acá.
  const FUENTE = readFileSync(join(__dirname, 'compras-catalogo-reporte.component.ts'), 'utf8');
  /**
   * Los comentarios fuera: la cabecera de ese archivo EXPLICA el metodo viejo para que nadie lo
   * reintroduzca, y un candado que lee prosa se pondria rojo justo por documentar bien. Lo que se
   * vigila es el codigo.
   */
  const CODIGO = FUENTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('⛔ NO imprime con window.print(): eso arrastra la app entera a la hoja', () => {
    expect(CODIGO).not.toMatch(/window\.print\(\)/);
    expect(CODIGO).toContain('printIsolated({');
  });

  it('⛔ y tampoco vuelve a confiar en un @media print del componente, que está encapsulado', () => {
    // La prueba negativa de la de arriba: si alguien reintroduce el bloque, esto se pone rojo
    // aunque printIsolated siga en el archivo.
    expect(CODIGO).not.toMatch(/@media print/);
  });

  it('el membrete y el pie viven en thead/tfoot: es lo que los repite en cada hoja', async () => {
    await elegirProveedor();
    expect(hoja()?.querySelector('.rp-doc > thead .rp-run-org')?.textContent).toContain('MEGA DULCES');
    expect(hoja()?.querySelector('.rp-doc > tfoot .rp-run-pie')).not.toBeNull();
  });

  it('la carátula nombra al PROVEEDOR, no repite el nombre del reporte', async () => {
    await elegirProveedor();
    const h1 = hoja()?.querySelector('.rp-portada-h1');
    expect(h1?.textContent).toContain('DISTRIBUIDORA DE LA ROSA');
    // El membrete ya dice qué documento es; repetirlo gastaba el renglón más visible de la hoja.
    expect(h1?.textContent).not.toMatch(/Reporte de precios/i);
  });

  it('las columnas de dinero se agrupan por peldaño, y los tramos cubren TODA la fila', async () => {
    await elegirProveedor();
    const fam = [...(hoja()?.querySelectorAll('.rp-hoja-tr-fam th') ?? [])];
    expect(fam.map((t) => t.textContent?.trim())).toContain('Por unidad');
    // Un colspan que no suma deja la tabla corrida una columna, en silencio.
    const suma = fam.reduce((n, t) => n + Number(t.getAttribute('colspan') ?? 1), 0);
    expect(suma).toBe(cmp.dineroVisibles().length + 1);
  });

  it('SKU y unidad viajan bajo el nombre, no como columnas propias', async () => {
    await elegirProveedor();
    // Con ocho columnas en 176 mm el nombre se partía en cuatro renglones. La identidad baja a un
    // renglón debajo y la tabla queda con las de dinero.
    const ident = hoja()?.querySelector('.rp-td-nombre .rp-ident');
    expect(ident?.textContent).toContain('70002');
    const titulos = [...(hoja()?.querySelectorAll('.rp-hoja-tbl thead th.col') ?? [])]
      .map((t) => t.textContent?.trim());
    expect(titulos).not.toContain('SKU');
    expect(titulos).toContain('Precio unidad');
  });

  it('⛔ el hueco se cuenta sobre lo que SE IMPRIME, no sobre lo que trajo la consulta', async () => {
    api.proximo = {
      ...api.proximo,
      rows: [
        fila({ product_id: 'p1', nombre: 'CON PRECIO' }),
        fila({ product_id: 'p2', nombre: 'SIN PRECIO', piece_price: null }),
      ],
      // La consulta dice 9; en la hoja entran 2, y uno es el que falta.
      meta: { ...api.proximo.meta, sin_precio: 9, mostrados: 2 },
    };
    await elegirProveedor();
    expect(cmp.sinPrecioImpresos()).toBe(1);
    expect(hoja()?.textContent).toContain('1 salen con guion');
    expect(hoja()?.textContent).not.toContain('9 salen con guion');
  });

  it('el proveedor va DENTRO del thead de su tabla, o la página 2 no dice de quién es', async () => {
    await elegirProveedor();
    const prov = hoja()?.querySelector('.rp-hoja-tbl thead .rp-hoja-prov');
    expect(prov?.textContent).toContain('DISTRIBUIDORA DE LA ROSA');
    // Y no quedó una copia suelta afuera, que se imprimiría una sola vez y mentiría por omisión.
    expect(hoja()?.querySelector('.rp-hoja-grupo > .rp-hoja-h2')).toBeNull();
  });
});
