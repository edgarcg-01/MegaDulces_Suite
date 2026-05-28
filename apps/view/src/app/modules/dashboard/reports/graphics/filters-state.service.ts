import { Injectable, computed, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs';

export interface FiltersState {
  period: string;
  startDate: string;
  endDate: string;
  zone: string | null;
  supervisorId: string | null;
  sellerIds: string[];
  furniture: string | null;
  brand: string | null;
}

// Helper fuera de la clase para evitar problemas de inicialización
function getDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

@Injectable({ providedIn: 'root' })
export class FiltersStateService {
  // Estado inicial extraído como constante estática para evitar duplicación
  private static readonly INITIAL_STATE: FiltersState = {
    period: 'semanal',
    startDate: getDateOffset(-7),
    endDate: getDateOffset(0),
    zone: null,
    supervisorId: null,
    sellerIds: [],
    furniture: null,
    brand: null,
  };

  // Estado reactivo global de filtros — compartido entre Dashboard y Reportes
  private _filters = signal<FiltersState>({ ...FiltersStateService.INITIAL_STATE });

  /**
   * Signal con el estado de filtros en tiempo real (sin debounce).
   * Úsalo para reflejar la UI (chips, dropdowns, etc.).
   */
  readonly filters = this._filters.asReadonly();

  private static readonly DEBOUNCE_MS = 300;

  /**
   * Signal con los filtros debounceados (300 ms) — diseñado para disparar
   * refetches HTTP. Si el usuario cambia rápido entre zona/supervisor/seller,
   * este signal solo emite una vez al final.
   *
   * Implementado con RxJS porque la versión con `effect + setTimeout` perdía
   * emisiones cuando el primer componente que inyectaba el service se
   * destruía (root DestroyRef + scoping). `toSignal` maneja todo el
   * cleanup automáticamente vía DestroyRef del root injector.
   */
  readonly filtersDebounced = toSignal(
    toObservable(this._filters).pipe(debounceTime(FiltersStateService.DEBOUNCE_MS)),
    { initialValue: this._filters() },
  );

  // Texto legible del rango activo para mostrar en UI
  readonly rangeLabel = computed(() => {
    const f = this._filters();
    const labels: Record<string, string> = {
      hoy: 'Hoy',
      semanal: 'Última semana',
      quincenal: 'Últimos 15 días',
      mensual: 'Último mes',
      custom: `${f.startDate} → ${f.endDate}`,
    };
    return labels[f.period] ?? f.period;
  });

  setPeriod(period: string) {
    const end = getDateOffset(0);
    const offsets: Record<string, number> = {
      hoy: 0,
      semanal: -7,
      quincenal: -15,
      mensual: -30,
    };
    if (period === 'custom') {
      this._filters.update(f => ({ ...f, period }));
      return;
    }
    this._filters.update(f => ({
      ...f,
      period,
      startDate: getDateOffset(offsets[period] ?? -7),
      endDate: end,
    }));
  }

  setDateRange(start: Date, end: Date) {
    this._filters.update(f => ({
      ...f,
      period: 'custom',
      startDate: start.toLocaleDateString('en-CA'),
      endDate: end.toLocaleDateString('en-CA'),
    }));
  }

  setZone(zone: string | null) {
    // Reset en cascada: al cambiar zona, limpiar supervisor, vendedores Y mueble
    this._filters.update(f => ({ ...f, zone, supervisorId: null, sellerIds: [], furniture: null }));
  }

  setSupervisor(supervisorId: string | null) {
    this._filters.update(f => ({ ...f, supervisorId, sellerIds: [] }));
  }

  setSellers(sellerIds: string[]) {
    this._filters.update(f => ({ ...f, sellerIds }));
  }

  setFurniture(furniture: string | null) {
    this._filters.update(f => ({ ...f, furniture }));
  }

  setBrand(brand: string | null) {
    this._filters.update(f => ({ ...f, brand }));
  }

  reset() {
    // Usar INITIAL_STATE para evitar duplicación y mantener consistencia
    this._filters.set({ ...FiltersStateService.INITIAL_STATE });
  }
}
