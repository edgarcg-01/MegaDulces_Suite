import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { AnticipoPorEntregarRow } from '@megadulces/contracts';
import { CajaAnticiposPorEntregarComponent } from './caja-anticipos-por-entregar.component';

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar el botón. */
class ResizeObserverStub { observe(): void { /* no-op */ } unobserve(): void { /* no-op */ } disconnect(): void { /* no-op */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const URL = '/commercial/supplier-obligations/anticipos/por-entregar';

/** Un anticipo de una compra de Morelia Abastos: sale de la Caja General de la 08 (datos de prueba). */
function fila(p: Partial<AnticipoPorEntregarRow> = {}): AnticipoPorEntregarRow {
  return {
    obligation_id: 'o1', allocation_id: 'a1', pago_folio: '261120-01-01', programado_dia: '2026-11-20',
    proveedor: 'CIT157', proveedor_nombre: 'DULCES DE PRUEBA', sucursal: '08', monto: 4800, monto_anticipo: 4800,
    motivo: 'chile en polvo', ocs: [{ sucursal: '08', serie: '1', folio: '0000157' }],
    autorizado_por: 'direccion', autorizado_el: '2026-11-19T16:40', kepler_previo: null, ...p,
  };
}

/**
 * `[PGP.157]` Como «Reposición»: un botón en la barra (cuántos y cuánto) y una ventana encima con la lista. El
 * recorrido visual del 2026-11-19 lo pidió así: en línea, 3 anticipos empujaban la cola fuera de la primera pantalla.
 */
describe('[PGP.157] Captura: anticipos en efectivo por entregar', () => {
  const montar = () => {
    TestBed.configureTestingModule({
      imports: [CajaAnticiposPorEntregarComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    });
    const f = TestBed.createComponent(CajaAnticiposPorEntregarComponent);
    f.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const req = http.expectOne((r) => r.url.endsWith(URL));
    return { f, c: f.componentInstance, http, req };
  };
  const texto = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
  /** Abre la ventana (relee) y contesta con `filas`. */
  const abrir = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }, c: CajaAnticiposPorEntregarComponent, http: HttpTestingController, filas: AnticipoPorEntregarRow[]) => {
    c.abrirVentana();
    http.expectOne((r) => r.url.endsWith(URL)).flush(filas);
    f.detectChanges(); await f.whenStable(); f.detectChanges();
  };
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('⭐ el botón de la barra: cuántos y cuánto; sin anticipos no hay botón', async () => {
    const { f, c, req } = montar();
    req.flush([fila(), fila({ obligation_id: 'o2', allocation_id: 'a2', monto: 1200, monto_anticipo: 1200 })]);
    await f.whenStable();
    expect(c.hay()).toBe(true);
    expect(c.resumen()).toBe('2 anticipos · $6,000.00');
    c.filas.set([fila()]);
    expect(c.resumen()).toBe('1 anticipo · $4,800.00');
    c.filas.set([]);
    expect(c.hay()).toBe(false);
    // ⛔ La pantalla no pinta nada por sí sola: todo vive en la ventana, que nace cerrada.
    expect(c.abierta()).toBe(false);
  });

  it('⭐ la ventana dice de qué Caja General sale (la base del anticipo), quién lo autorizó y con qué se ubica', async () => {
    const { f, c, http, req } = montar();
    req.flush([]);
    await abrir(f, c, http, [fila()]);
    const t = texto();
    expect(t).toContain('Anticipos en efectivo por entregar');
    expect(t).toContain('1 anticipo · $4,800.00');
    expect(t).toContain('Cada uno sale de la Caja General de su base');
    expect(t).toContain('DULCES DE PRUEBA');
    expect(t).toContain('Caja General de Morelia Abastos');
    expect(t).toContain('autorizó direccion el 19/11 16:40');
    expect(t).toContain('pago 261120-01-01');
    expect(t).toContain('OC 0000157');
    // Ya no hay «préstamo» entre cajas: cada base cuadra sola.
    expect(t).not.toContain('por cuenta de');
  });

  it('la 00 se llama Oficinas; un pago partido dice de cuánto es el anticipo', async () => {
    const { f, c, http, req } = montar();
    req.flush([]);
    await abrir(f, c, http, [fila({ sucursal: '00', monto: 2400 })]);
    const t = texto();
    expect(t).toContain('Caja General de Oficinas');
    expect(t).toContain('$2,400.00');
    expect(t).toContain('en este pago, de un anticipo de $4,800.00');
  });

  it('⛔ un X-D-60 de antes de la autorización no lo saca: lo dice para que se revise', async () => {
    const { f, c, http, req } = montar();
    req.flush([]);
    await abrir(f, c, http, [fila({ kepler_previo: { folio: '0000190', fecha: '2026-11-17', importe: 4800, remanente: 4800 } })]);
    expect(texto()).toContain('Kepler ya tiene un X-D-60 de este proveedor por ese importe del 17/11/26 (0000190), de antes de la autorización');
  });

  it('⛔ una respuesta vieja no pisa a una nueva: al releer, el pedido anterior se cancela', async () => {
    const { f, c, http, req: viejo } = montar();
    c.cargar();
    const nuevo = http.expectOne((r) => r.url.endsWith(URL));
    expect(viejo.cancelled).toBe(true);
    nuevo.flush([fila()]);
    await f.whenStable();
    expect(c.resumen()).toBe('1 anticipo · $4,800.00');
  });

  it('⛔ NEGATIVA — una lectura fallida se DICE: el botón sale con «no se pudo leer» y la ventana lo explica, nunca «no hay»', async () => {
    const { f, c, http, req } = montar();
    req.flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    await f.whenStable();
    expect(c.hay()).toBe(true);
    expect(c.resumen()).toBe('no se pudo leer');
    c.abrirVentana();
    http.expectOne((r) => r.url.endsWith(URL)).flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect(texto()).toContain('No se pudieron leer los anticipos en efectivo autorizados');
    expect(texto()).toContain('Puede haber alguno por entregar');
    expect(texto()).not.toContain('No hay anticipos en efectivo autorizados por entregar');
  });
});
