import { Injectable, signal, computed } from '@angular/core';

export interface KpiRange {
  id: string;
  label: string;
  unit: string;
  min: number;   // umbral rojo → amarillo
  opt: number;   // umbral amarillo → verde
}

export interface FurnitureMeta {
  id: string;
  label: string;
  icon: string;
  target: number;
}

export type KpiStatus = 'ok' | 'warn' | 'bad';

const STORAGE_KEY_KPI      = 'metas_kpi_v1';
const STORAGE_KEY_FURNITURE = 'metas_furniture_v1';

@Injectable({ providedIn: 'root' })
export class MetasConfigService {
  // ── KPI ranges ──────────────────────────────────────────────────
  private _kpiRanges = signal<KpiRange[]>(this._loadKpi());

  readonly kpiRanges = this._kpiRanges.asReadonly();

  getRange(id: string): KpiRange | undefined {
    return this._kpiRanges().find(k => k.id === id);
  }

  /**
   * Evalúa en qué semáforo cae un valor dado el KPI.
   * ok   → val >= opt
   * warn → min <= val < opt
   * bad  → val < min
   */
  statusFor(id: string, value: number): KpiStatus {
    const range = this.getRange(id);
    if (!range) return 'ok';
    if (value >= range.opt) return 'ok';
    if (value >= range.min) return 'warn';
    return 'bad';
  }

  /** Porcentaje de avance respecto a la meta óptima (0-100) */
  progressPct(id: string, value: number): number {
    const range = this.getRange(id);
    if (!range || range.opt === 0) return 0;
    return Math.min(100, Math.round((value / range.opt) * 100));
  }

  updateKpiRange(id: string, min: number, opt: number) {
    this._kpiRanges.update(ranges =>
      ranges.map(r => r.id === id ? { ...r, min, opt: Math.max(opt, min + 1) } : r)
    );
    this._saveKpi();
  }

  // ── Furniture targets ──────────────────────────────────────────
  private _furniture = signal<FurnitureMeta[]>(this._loadFurniture());

  readonly furniture = this._furniture.asReadonly();

  updateFurnitureTarget(id: string, target: number) {
    this._furniture.update(list =>
      list.map(f => f.id === id ? { ...f, target } : f)
    );
    this._saveFurniture();
  }

  furnitureStatus(actual: number, target: number): KpiStatus {
    const min = Math.round(target * 0.8);
    if (actual >= target) return 'ok';
    if (actual >= min)    return 'warn';
    return 'bad';
  }

  // ── Persist ────────────────────────────────────────────────────
  private _saveKpi() {
    try { localStorage.setItem(STORAGE_KEY_KPI, JSON.stringify(this._kpiRanges())); } catch {}
  }
  private _saveFurniture() {
    try { localStorage.setItem(STORAGE_KEY_FURNITURE, JSON.stringify(this._furniture())); } catch {}
  }
  private _loadKpi(): KpiRange[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_KPI);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [
      { id: 'visitas',       label: 'Visitas',        unit: '',  min: 200, opt: 250 },
      { id: 'score',         label: 'Avg score',       unit: '%', min: 65,  opt: 80  },
      { id: 'venta',         label: 'Impacto venta',   unit: '',  min: 150000, opt: 200000 },
      { id: 'exhibiciones',  label: 'Exhibiciones',    unit: '',  min: 800, opt: 1000 },
      { id: 'avgVenta',      label: 'Venta promedio',  unit: '',  min: 1000, opt: 1500 },
      { id: 'metaDiaria',    label: 'Meta diaria',     unit: '',  min: 3,   opt: 5    },
      { id: 'stockoutRate',  label: 'Stockout Rate',   unit: '%', min: 10,  opt: 5    },
      { id: 'healthRate',    label: 'Health Rate',     unit: '%', min: 60,  opt: 80   },
      { id: 'uniqueProducts',label: 'Productos Únicos',unit: '',  min: 15,  opt: 20   },
    ];
  }
  private _loadFurniture(): FurnitureMeta[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FURNITURE);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [
      { id: 'vitrina',     label: 'Vitrinas',     icon: 'pi pi-objects-column', target: 50  },
      { id: 'exhibidor',   label: 'Exhibidores',  icon: 'pi pi-box',            target: 40  },
      { id: 'vitrolero',   label: 'Vitroleros',   icon: 'pi pi-database',       target: 30  },
      { id: 'paletero',    label: 'Paleteros',    icon: 'pi pi-stop-circle',    target: 25  },
      { id: 'tira',        label: 'Tiras',        icon: 'pi pi-list',           target: 60  },
    ];
  }
}
