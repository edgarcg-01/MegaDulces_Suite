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
