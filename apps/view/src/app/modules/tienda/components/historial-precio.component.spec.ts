import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { PriceHistoryResult, PriceHistoryRow } from '@megadulces/contracts';
import { EtiquetasService, SearchHit } from '../etiquetas.service';
import { ETIQUETAS_TABS } from '../etiquetas-tabs';
import { HistorialPrecioComponent } from './historial-precio.component';

/**
 * [ETQ-HISTORIAL.3] Buscador + historial, visto como lo ve quien revisa precios.
 * Los datos copian lo medido en prod: Kepler reescribe el mismo cambio varias veces.
 */
const fila = (sucursal: string, fecha: string, hora: string, unidad: string | null, ant: number, nvo: number): PriceHistoryRow => ({
  sucursal, fecha, hora, unidad, precio_anterior: ant, precio_nuevo: nvo, delta: Math.round((nvo - ant) * 100) / 100, es_baja: nvo === 0,
});
const FRESCO = { status: 'fresh', data_as_of: '2026-10-28T10:00:00Z', age_human: '5 min', sources: [] } as never;
const resultado = (items: PriceHistoryRow[], over: Partial<PriceHistoryResult> = {}): PriceHistoryResult => ({
  sku: '99001', items, dias: 365, truncado: false, tope: 8000, freshness: FRESCO, ...over,
});
const REPETIDAS = [
  fila('06', '2026-10-28', '08:07:48.56', 'CJA', 1152.44, 1152.45),
  fila('06', '2026-10-28', '06:33:08.41', 'CJA', 1152.44, 1152.45),
  fila('06', '2026-10-27', '12:09:30.74', 'CJA', 1152.44, 1152.45),
  fila('02', '2026-10-27', '09:00:00.00', 'PAQ', 24, 25),
];
const HITS: SearchHit[] = [
  { product_id: 'p1', sku: '99001', name: 'SEED VASO REPETIDO 25P', barcode: null },
  { product_id: 'p2', sku: '31081', name: 'PROMO = GRATIS', barcode: null, es_promocion: true },
];

class SvcStub {
  busquedas: string[] = [];
  pedidos: Array<[string, number]> = [];
  respuesta: PriceHistoryResult = resultado(REPETIDAS);
  falla = false;
  search(q: string) { this.busquedas.push(q); return of(HITS); }
  priceHistory(sku: string, dias: number) {
    this.pedidos.push([sku, dias]);
    return this.falla ? throwError(() => new Error('boom')) : of(this.respuesta);
  }
}

describe('[ETQ-HISTORIAL.3] HistorialPrecioComponent', () => {
  let fix: ComponentFixture<HistorialPrecioComponent>;
  let svc: SvcStub;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const cuerpo = (): string => `${el().textContent} ${document.body.textContent}`;
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };
  async function montar(): Promise<void> {
    svc = new SvcStub();
    await TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: EtiquetasService, useValue: svc }] }).compileComponents();
    fix = TestBed.createComponent(HistorialPrecioComponent);
    fix.detectChanges();
    await tick();
  }
  async function buscarYElegir(): Promise<void> {
    const c = fix.componentInstance;
    c.consulta.set('vaso');
    await tick();
    await tick();
    c.elegir(HITS[0]);
    await tick();
    await tick();
  }

  it('escribir busca con retraso y NO consulta con menos de 2 letras', async () => {
    await montar();
    fix.componentInstance.consulta.set('v');
    await tick();
    expect(svc.busquedas).toEqual([]);
    fix.componentInstance.consulta.set('vaso');
    await tick();
    expect(svc.busquedas).toEqual(['vaso']);
    expect(el().textContent).toContain('SEED VASO REPETIDO 25P');
  });

  it('⛔ NEGATIVA — una promoción de Kepler no se puede elegir: no es un producto', async () => {
    await montar();
    fix.componentInstance.consulta.set('gratis');
    await tick();
    await tick();
    const botones = Array.from(el().querySelectorAll('button.hp-hit')) as HTMLButtonElement[];
    expect(botones.find((b) => b.textContent?.includes('31081'))?.disabled).toBe(true);
    fix.componentInstance.elegir(HITS[1]);
    await tick();
    expect(svc.pedidos).toEqual([]);
  });

  it('⭐ elegir un producto pide su historial UNA vez, con el código y 1 año por omisión', async () => {
    await montar();
    await buscarYElegir();
    expect(svc.pedidos).toEqual([['99001', 365]]);
  });

  it('⭐ D2: arranca en TODAS LAS FILAS (4 renglones), con la lectura filas contra tramos arriba', async () => {
    await montar();
    await buscarYElegir();
    expect(fix.componentInstance.vista()).toBe('filas');
    expect(document.body.querySelectorAll('p-table tbody tr').length).toBe(4);
    expect(fix.componentInstance.filtradas()).toHaveLength(4);
    expect(fix.componentInstance.tramos()).toHaveLength(2); // el CJA repetido es UN tramo + el PAQ
    expect(fix.componentInstance.metricas().map((m) => m.value)).toEqual([4, 2, 2]);
  });

  it('agrupar repetidos muestra los TRAMOS y dice cuántas veces se escribió', async () => {
    await montar();
    await buscarYElegir();
    fix.componentInstance.vista.set('tramos');
    await tick();
    expect(document.body.querySelectorAll('p-table tbody tr').length).toBe(2);
    expect(cuerpo()).toContain('Veces escrito');
  });

  it('⭐ la plaza se NOMBRA, nunca se numera (no hay «06» ni «02» sueltos en la tabla)', async () => {
    await montar();
    await buscarYElegir();
    const celdas = Array.from(document.body.querySelectorAll('p-table tbody tr td:first-child')).map((c) => c.textContent?.trim());
    expect(celdas.length).toBeGreaterThan(0);
    for (const c of celdas) expect(c).not.toMatch(/^\d{2}$/);
  });

  it('filtrar por plaza y por presentación recorta las filas y los conteos', async () => {
    await montar();
    await buscarYElegir();
    fix.componentInstance.plaza.set('06');
    await tick();
    expect(fix.componentInstance.filtradas()).toHaveLength(3);
    fix.componentInstance.unidad.set('PAQ');
    await tick();
    expect(fix.componentInstance.filtradas()).toHaveLength(0);
    expect(cuerpo()).toContain('Sin cambios registrados en este rango');
  });

  it('⭐ error ≠ vacío: si no se pudo leer NO dice «sin cambios»', async () => {
    await montar();
    svc.falla = true;
    await buscarYElegir();
    expect(cuerpo()).toContain('No se pudo leer el historial');
    expect(cuerpo()).not.toContain('Sin cambios registrados en este rango');
  });

  it('⛔ NEGATIVA — si el servidor recortó, la pantalla lo DICE (no se lee como «no hubo más»)', async () => {
    await montar();
    svc.respuesta = resultado(REPETIDAS, { truncado: true, tope: 8000 });
    await buscarYElegir();
    expect(cuerpo()).toContain('Se muestran las 8000 más recientes');
  });

  it('sin filas en el rango: «sin cambios registrados», con la aclaración de que no dice que el producto no exista', async () => {
    await montar();
    svc.respuesta = resultado([]);
    await buscarYElegir();
    expect(cuerpo()).toContain('Sin cambios registrados en este rango');
    expect(cuerpo()).toContain('su precio no se movió');
  });

  it('cambiar el rango vuelve a pedir con los días nuevos', async () => {
    await montar();
    await buscarYElegir();
    fix.componentInstance.rango.set('0');
    await tick();
    await tick();
    expect(svc.pedidos.at(-1)).toEqual(['99001', 0]);
  });

  it('una presentación vacía se muestra «—», no se inventa «pieza»', async () => {
    await montar();
    svc.respuesta = resultado([fila('06', '2026-10-28', '08:00:00.00', null, 1, 2)]);
    await buscarYElegir();
    const celdas = Array.from(document.body.querySelectorAll('p-table tbody tr td')).map((c) => c.textContent?.trim());
    expect(celdas).toContain('—');
  });

  it('⭐ [.4] «Historial de precios» es una pestaña junto a «Cambios de precio», con el mismo permiso', () => {
    expect(ETIQUETAS_TABS.map((t) => t.route)).toEqual(['/tienda/etiquetas', '/tienda/etiquetas/cambios', '/tienda/etiquetas/historial']);
    expect(new Set(ETIQUETAS_TABS.map((t) => t.permission)).size).toBe(1);
  });

  it('[.4] sin producto elegido dice qué hacer (no una tabla vacía) y, al elegir, el historial sale EN LÍNEA', async () => {
    await montar();
    expect(el().textContent).toContain('aquí aparece todo su historial');
    expect(el().querySelector('p-table')).toBeNull();
    await buscarYElegir();
    expect(el().querySelector('p-table')).toBeTruthy();
    expect(el().textContent).not.toContain('aquí aparece todo su historial');
  });

  afterEach(() => { document.body.querySelectorAll('.sp-root, .p-overlay').forEach((e) => e.remove()); document.body.style.overflow = ''; });
});
