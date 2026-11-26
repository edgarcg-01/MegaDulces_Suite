import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { LocationCaptureBatch } from '@megadulces/contracts';
import { UbicacionesCapturaComponent } from './ubicaciones-captura.component';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';

/**
 * `[UB.RF.4]` «Últimas capturas» distingue leyendo, falló y vacío.
 *
 * El caso (medido en prod el 2026-11-17): CEDIS tiene una captura de 374 ubicaciones y la lista decía
 * «Todavía no hay capturas masivas en este almacén» mientras la respuesta venía en camino. Si la
 * lectura fallaba, decía lo mismo. Una lista que dice «no hay» cuando no sabe empuja a capturar de nuevo.
 */

const LOTE = { id: 'l1', kind: 'rango', descripcion: 'Tienda · pasillos A–C · racks 01–25 · niveles 1–5', created_count: 374, skipped_count: 1, created_at: '2026-10-08T19:45:13.607Z', created_by_name: 'Alguien', undone_at: null, undone_count: null, en_uso: 0 } as unknown as LocationCaptureBatch;
const PH = { id: 'w-ph', code: '01', name: 'Padre Hidalgo' };
const CEDIS = { id: 'w-cedis', code: '00', name: 'CEDIS' };

function montar(batches: (id: string) => unknown) {
  TestBed.configureTestingModule({
    imports: [UbicacionesCapturaComponent],
    providers: [{ provide: AlmacenUbicacionesCatalogoService, useValue: { batches: vi.fn(batches) } }],
  });
  const fix = TestBed.createComponent(UbicacionesCapturaComponent);
  fix.componentRef.setInput('warehouse', CEDIS);
  fix.detectChanges();
  const texto = (): string => (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';
  return { fix, texto };
}

describe('[UB.RF.4] Últimas capturas', () => {
  it('⭐ mientras lee, dice que está leyendo, NO que no hay', () => {
    const { texto } = montar(() => new Subject());
    expect(texto()).toContain('Leyendo las capturas de CEDIS');
    expect(texto()).not.toContain('Todavía no hay capturas');
  });

  it('si la lectura falla, lo dice y ofrece reintentar (no «no hay»)', () => {
    const { fix, texto } = montar(() => throwError(() => new HttpErrorResponse({ status: 500 })));
    fix.detectChanges();
    expect(texto()).toContain('No se pudieron leer las capturas');
    expect(texto()).toContain('Reintentar');
    expect(texto()).not.toContain('Todavía no hay capturas');
  });

  it('con su captura, la lista la muestra', () => {
    const { fix, texto } = montar(() => of([LOTE]));
    fix.detectChanges();
    expect(texto()).toContain('374 creadas');
  });

  it('NEGATIVA: vacía de verdad, entonces sí dice que no hay', () => {
    const { fix, texto } = montar(() => of([]));
    fix.detectChanges();
    expect(texto()).toContain('Todavía no hay capturas masivas en este almacén');
  });

  it('la respuesta del almacén ANTERIOR no tapa la del nuevo', () => {
    const viejo = new Subject<LocationCaptureBatch[]>();
    const { fix, texto } = montar((id) => (id === CEDIS.id ? viejo : of([])));
    fix.componentRef.setInput('warehouse', PH);
    fix.detectChanges();
    viejo.next([LOTE]); // llega tarde la de CEDIS
    fix.detectChanges();
    expect(texto()).toContain('Últimas capturas en Padre Hidalgo');
    expect(texto()).not.toContain('374 creadas');
  });
});

describe('[UB.RF.9] El resumen concuerda con su cuenta', () => {
  it('«Se crean 180», no «Se crea 180»; en singular con 1', () => {
    const { fix } = montar(() => of([]));
    const c = fix.componentInstance;
    expect(c.accionLabel('nueva', 180)).toBe('Se crean');
    expect(c.accionLabel('existe', 3)).toBe('Ya existen');
    expect(c.accionLabel('baja', 2)).toBe('Dadas de baja');
    expect(c.accionLabel('nueva', 1)).toBe('Se crea');
    // NEGATIVA: el renglón (sin cuenta) sigue en singular.
    expect(c.accionLabel('nueva')).toBe('Se crea');
  });
});

describe('[UB.RF.15] La captura se reinicia por el ALMACÉN, no por el objeto', () => {
  it('⭐ el mapa recarga tras «Crear» (objeto nuevo, mismo almacén): el resultado y los carteles se quedan', () => {
    const { fix } = montar(() => of([]));
    const c = fix.componentInstance;
    c.resultado.set({ batch_id: 'b1', creadas: 3, omitidas: 0, codigos: ['TA011', 'TA012', 'TA013'] } as never);
    c.carteles.set([{ code: 'TA011', label: null, almacen: '00' }]);
    fix.componentRef.setInput('warehouse', { ...CEDIS });
    fix.detectChanges();
    expect(c.resultado()).not.toBeNull();
    expect(c.carteles().length).toBe(1);
  });

  it('NEGATIVA: con OTRO almacén sí se limpia (lo visto era del anterior)', () => {
    const { fix } = montar(() => of([]));
    const c = fix.componentInstance;
    c.resultado.set({ batch_id: 'b1', creadas: 3, omitidas: 0, codigos: [] } as never);
    fix.componentRef.setInput('warehouse', PH);
    fix.detectChanges();
    expect(c.resultado()).toBeNull();
  });

  it('sin ubicaciones abre en «Crear por rango»; con ubicaciones, en «Productos por rack»', () => {
    const a = montar(() => of([]));
    expect(a.fix.componentInstance.modo()).toBe('rango');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [UbicacionesCapturaComponent], providers: [{ provide: AlmacenUbicacionesCatalogoService, useValue: { batches: vi.fn(() => of([])), products: vi.fn(() => of({ filas: [], total: 0 })) } }] });
    const fix = TestBed.createComponent(UbicacionesCapturaComponent);
    fix.componentRef.setInput('warehouse', PH);
    fix.componentRef.setInput('ubicaciones', [{ code: 'TA011', familia: 'ubicacion', zona: 'T', pasillo: 'A', rack: 1, nivel: 1, estado: 'activa' }]);
    fix.detectChanges();
    expect(fix.componentInstance.modo()).toBe('rack');
    expect((fix.nativeElement as HTMLElement).textContent).not.toContain('Últimas capturas');
  });
});
