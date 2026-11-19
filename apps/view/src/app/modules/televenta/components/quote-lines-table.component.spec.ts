/**
 * [E.29] Con % de cliente, la columna Importe pinta lo que dice la hoja (el neto) y de dónde sale.
 * Antes pintaba el renglón de Kepler, antes del %, mientras el PDF del mismo folio traía el neto:
 * GOMA PEELERZ × 1 CJA con 2 % se veía $739.20 en pantalla y $724.42 en el papel.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';

import { QuoteLinesTableComponent, RenglonTabla, cuentasRenglones, renglonesVisibles, RENGLONES_PARA_FILTRAR } from './quote-lines-table.component';

const PEELERZ: RenglonTabla = {
  id: 'r1', numero: 1, nombre: 'GOMA PEELERZ UVA 85G / 1', sku: '43103', sinCasar: false, regaloDe: null, notaRegalo: null,
  unidad: 'CJA', factor: 24, cantidad: 1, editable: false, admiteFraccion: false, existencia: null,
  lista: 739.21, precio: 739.2, desglose: [], fuente: 'list', dtoPct: null, pasos: '', explicacion: '',
  importe: 739.2, neto: null, sinRedondear: null,
};

function deDondeSale(renglones: RenglonTabla[], clientePct: number | null): string {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
  const f = TestBed.createComponent(QuoteLinesTableComponent);
  f.componentRef.setInput('renglones', renglones);
  f.componentRef.setInput('clientePct', clientePct);
  f.detectChanges();
  const celda = (f.nativeElement as HTMLElement).querySelector('td[data-label="De dónde sale"]');
  return Array.from(celda?.querySelectorAll('.p-tag-label, .dto, .pasos') ?? []).map((e) => (e.textContent ?? '').trim()).join(' | ');
}

function pintar(renglones: RenglonTabla[], clientePct: number | null): string {
  TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
  const f = TestBed.createComponent(QuoteLinesTableComponent);
  f.componentRef.setInput('renglones', renglones);
  f.componentRef.setInput('clientePct', clientePct);
  f.detectChanges();
  const celda = (f.nativeElement as HTMLElement).querySelector('td[data-label="Importe"]');
  const texto = (e: Element | null | undefined): string => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
  // El neto y el «antes» van en dos renglones (display:block): se leen por separado.
  const antes = celda?.querySelector('.imp-antes');
  return antes ? `${texto(celda?.querySelector('.p-unit-main'))} | ${texto(antes)}` : texto(celda);
}

describe('QuoteLinesTableComponent — Importe con el % del cliente', () => {
  it('con % de cliente pinta el neto y, abajo, el renglón de Kepler antes del %', () => {
    expect(pintar([{ ...PEELERZ, neto: 724.42 }], 2)).toBe('$724.42 | $739.20 − 2 % cliente');
  });

  it('sin % de cliente pinta el importe tal cual', () => {
    expect(pintar([PEELERZ], null)).toBe('$739.20');
  });

  it('«De dónde sale» dice el centavo de Kepler y, si hay, el descuento del cliente', () => {
    const r: RenglonTabla = {
      ...PEELERZ, neto: 724.42, sinRedondear: 739.21, desglose: [{ cantidad: 24, unidad: 'PAQ', precio: 30.8 }],
    };
    expect(deDondeSale([r], 2)).toBe(
      'Lista | Kepler redondea por PAQ a centavos: $739.21 → 24 × $30.80 = $739.20 | Descuento del cliente | −2%',
    );
    // Sin % de cliente: sólo la lista y el redondeo.
    expect(deDondeSale([{ ...r, neto: null }], null)).toBe(
      'Lista | Kepler redondea por PAQ a centavos: $739.21 → 24 × $30.80 = $739.20',
    );
  });
});

describe('QuoteLinesTableComponent — [E.30] el SKU va con el producto', () => {
  function celdaProducto(r: RenglonTabla): string {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
    const f = TestBed.createComponent(QuoteLinesTableComponent);
    f.componentRef.setInput('renglones', [r]);
    f.detectChanges();
    const celda = (f.nativeElement as HTMLElement).querySelector('td.dt-id');
    // Cada pieza por separado: Angular quita el espacio entre los <span>, y en pantalla van en renglones.
    return Array.from(celda?.querySelectorAll('.p-name, .p-sku, .sin-casar') ?? []).map((e) => (e.textContent ?? '').trim()).join(' | ');
  }

  it('un renglón del catálogo dice su SKU debajo del nombre', () => {
    expect(celdaProducto(PEELERZ)).toBe('GOMA PEELERZ UVA 85G / 1 | SKU 43103');
  });

  it('NEGATIVA: un renglón sin casar no inventa SKU', () => {
    expect(celdaProducto({ ...PEELERZ, sku: null, sinCasar: true, nombre: 'gomitas raras' })).toBe('gomitas raras | sin casar con el catálogo');
  });
});

describe('[COT.46] el último renglón agregado', () => {
  function filas(marcado: string | null, destello: string | null): HTMLTableRowElement[] {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
    const f = TestBed.createComponent(QuoteLinesTableComponent);
    f.componentRef.setInput('renglones', [PEELERZ, { ...PEELERZ, id: 'r2', numero: 2 }]);
    f.componentRef.setInput('marcado', marcado);
    f.componentRef.setInput('destello', destello);
    f.detectChanges();
    return Array.from((f.nativeElement as HTMLElement).querySelectorAll<HTMLTableRowElement>('tbody tr'));
  }
  it('cada fila lleva id para «Ver en la lista»; sólo la marcada lleva la franja y sólo la pedida se resalta', () => {
    const [a, b] = filas('r2', 'r2');
    expect(b.id).toBe('renglon-r2');
    expect(b.classList.contains('row-ultimo')).toBe(true);
    expect(b.classList.contains('row-destello')).toBe(true);
    expect(a.classList.contains('row-ultimo')).toBe(false);
    expect(a.classList.contains('row-destello')).toBe(false);
  });
  it('sin marcado no hay franja', () => {
    expect(filas(null, null).some((r) => r.classList.contains('row-ultimo'))).toBe(false);
  });
});

describe('[COT.47] buscar, filtrar y ordenar los renglones', () => {
  const r = (id: string, numero: number, nombre: string, sku: string, o: Partial<RenglonTabla> = {}): RenglonTabla =>
    ({ ...PEELERZ, id, numero, nombre, sku, ...o });
  const lista: RenglonTabla[] = [
    r('a', 1, 'GALL MINI MAMUT GAMESA', '44630', { importe: 2573.02, fuente: 'volume_qty' }),
    r('b', 2, 'CHOC PALETA PIÑA', '11111', { importe: 90, fuente: 'promo_qty', existencia: { cantidad: 2, unidad: 'CJA', faltan: 3 } }),
    r('c', 3, 'AGUA MEMBERS MARK 500ML', '59108', { importe: 500, fuente: 'list' }),
  ];
  it('buscar: palabras en cualquier orden y sin acentos, por nombre o SKU', () => {
    expect(renglonesVisibles(lista, 'mamut gall', 'todos', 'captura').map((x) => x.id)).toEqual(['a']);
    expect(renglonesVisibles(lista, 'pina', 'todos', 'captura').map((x) => x.id)).toEqual(['b']);
    expect(renglonesVisibles(lista, '59108', 'todos', 'captura').map((x) => x.id)).toEqual(['c']);
  });
  it('filtros con su cuenta: faltan existencias y con promoción', () => {
    expect(cuentasRenglones(lista)).toEqual({ todos: 3, faltan: 1, promo: 1 });
    expect(renglonesVisibles(lista, '', 'faltan', 'captura').map((x) => x.id)).toEqual(['b']);
    expect(renglonesVisibles(lista, '', 'promo', 'captura').map((x) => x.id)).toEqual(['b']);
  });
  it('ordenar no cambia el número de renglón (es el del pedido en Kepler)', () => {
    expect(renglonesVisibles(lista, '', 'todos', 'importe').map((x) => [x.id, x.numero])).toEqual([['a', 1], ['c', 3], ['b', 2]]);
    expect(renglonesVisibles(lista, '', 'todos', 'nombre').map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(renglonesVisibles(lista, '', 'todos', 'captura').map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('[COT.48] lo último arriba: lo recién agregado primero, sin tocar el número de renglón', () => {
    expect(renglonesVisibles(lista, '', 'todos', 'reciente').map((x) => [x.id, x.numero])).toEqual([['c', 3], ['b', 2], ['a', 1]]);
  });
  it('[COT.48] lo último arriba: el que se acaba de SUMAR (marcado) sube primero', () => {
    expect(renglonesVisibles(lista, '', 'todos', 'reciente', 'a').map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(renglonesVisibles(lista, '', 'todos', 'captura', 'a').map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('[COT.48] lo último arriba: el regalo del ERP viaja pegado debajo de su renglón', () => {
    const conRegalo = [...lista.slice(0, 2), r('g', 3, 'REGALO', '22222', { regaloDe: 1 }), r('d', 4, 'DULCE', '33333')];
    expect(renglonesVisibles(conRegalo, '', 'todos', 'reciente').map((x) => x.id)).toEqual(['d', 'b', 'a', 'g']);
    expect(renglonesVisibles(conRegalo, '', 'todos', 'reciente', 'a').map((x) => x.id)).toEqual(['a', 'g', 'd', 'b']);
  });

  function montar(n: number) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
    const f = TestBed.createComponent(QuoteLinesTableComponent);
    f.componentRef.setInput('renglones', Array.from({ length: n }, (_, i) => r('x' + i, i + 1, 'PRODUCTO ' + i, String(10000 + i))));
    f.componentRef.setInput('titulo', 'Renglones de la cotización COT-PRUEBA');
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }
  it('[COT.48] con ordenInicial «reciente» la primera fila pintada es la última agregada, aun sin barra', () => {
    const { f, el } = montar(3);
    expect(el.querySelector('tbody tr')?.id).toBe('renglon-x0');
    f.componentRef.setInput('ordenInicial', 'reciente');
    f.detectChanges();
    expect(Array.from(el.querySelectorAll('tbody tr')).map((t) => t.id)).toEqual(['renglon-x2', 'renglon-x1', 'renglon-x0']);
  });
  it('la barra sólo aparece desde 10 renglones (con menos todo cabe a la vista)', () => {
    expect(RENGLONES_PARA_FILTRAR).toBe(10);
    expect(montar(9).el.querySelector('.filtros')).toBeNull();
    expect(montar(10).el.querySelector('.filtros')).not.toBeNull();
  });
  it('con filtro dice «Mostrando X de Y» y «Quitar filtro» devuelve todo', () => {
    const { f, el } = montar(12);
    f.componentInstance.busqueda.set('producto 11');
    f.detectChanges();
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
    expect((el.querySelector('.mostrando')?.textContent ?? '').replace(/\s+/g, ' ')).toContain('Mostrando 1 de 12');
    el.querySelector<HTMLButtonElement>('.mostrando .quitar-filtro')!.click();
    f.detectChanges();
    expect(el.querySelectorAll('tbody tr').length).toBe(12);
  });
  it('semántica: encabezados con scope, producto como encabezado de fila y la tabla con nombre', () => {
    const { el } = montar(2);
    expect(Array.from(el.querySelectorAll('thead th')).every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    expect(el.querySelector('tbody td[role="rowheader"]')?.textContent).toContain('PRODUCTO 0');
    expect(el.querySelector('table')?.getAttribute('aria-label')).toBe('Renglones de la cotización COT-PRUEBA');
  });
  it('«Ver en la lista» de un renglón escondido por el filtro quita el filtro', () => {
    const { f, el } = montar(12);
    f.componentInstance.busqueda.set('producto 11');
    f.detectChanges();
    f.componentRef.setInput('destello', 'x0');
    f.detectChanges();
    expect(f.componentInstance.busqueda()).toBe('');
    expect(el.querySelector('#renglon-x0')).not.toBeNull();
  });
});
