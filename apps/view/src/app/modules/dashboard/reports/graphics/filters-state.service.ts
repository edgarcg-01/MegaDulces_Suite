import { Injectable, signal, computed } from '@angular/core';

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

@Injectable({ providedIn: 'root' })
export class FiltersStateService {
  // Estado reactivo global de filtros — compartido entre Dashboard y Reportes
  private _filters = signal<FiltersState>({
    period: 'semanal',
    startDate: this._getDateOffset(-7),
    endDate: this._getDateOffset(0),
    zone: null,
    supervisorId: null,
    sellerIds: [],
    furniture: null,
    brand: null,
  });

  readonly filters = this._filters.asReadonly();

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
    const end = this._getDateOffset(0);
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
      startDate: this._getDateOffset(offsets[period] ?? -7),
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
    this._filters.update(f => ({ ...f, zone, supervisorId: null, sellerIds: [] }));
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
    this._filters.set({
      period: 'semanal',
      startDate: this._getDateOffset(-7),
      endDate: this._getDateOffset(0),
      zone: null,
      supervisorId: null,
      sellerIds: [],
      furniture: null,
      brand: null,
    });
  }

  private _getDateOffset(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-CA');
  }
}
