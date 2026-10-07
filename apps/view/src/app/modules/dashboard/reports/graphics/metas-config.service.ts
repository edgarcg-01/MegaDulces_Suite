import { Injectable, signal, computed } from '@angular/core';

export interface KpiRange {
  id: string;
  label: string;
  unit: string;
  min: number;   // umbral rojo → amarillo
  opt: number;   // umbral amarillo → verde
  /**
   * Si true, la semántica del KPI es "menos es mejor" (ej. stockout, errores).
   * `ok` = val <= opt; `warn` = opt < val <= min; `bad` = val > min.
   * Default false (más es mejor).
   */
  inverse?: boolean;
}

export interface FurnitureMeta {
  id: string;
  label: string;
  icon: string;
  target: number;
}

export type KpiStatus = 'ok' | 'warn' | 'bad';

const STORAGE_KEY_KPI      = 'metas_kpi_v2';
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
   *
   * Modo NORMAL (más es mejor):
   *   ok   → val >= opt
   *   warn → min <= val < opt
   *   bad  → val < min
   *
   * Modo INVERSO (`range.inverse=true`, menos es mejor — ej. stockout):
   *   ok   → val <= opt
   *   warn → opt < val <= min
   *   bad  → val > min
   *
   * Si el id no tiene range definido, antes retornaba 'ok' (verde) —
   * causando que TODOS los KPIs sin range aparecieran en meta aunque
   * estuvieran mal. Ahora retorna 'warn' (neutral amarillo) como señal
   * de "sin meta configurada, no se puede evaluar".
   */
  statusFor(id: string, value: number): KpiStatus {
    const range = this.getRange(id);
    if (!range) return 'warn';
    const v = Number(value) || 0;
    if (range.inverse) {
      if (v <= range.opt) return 'ok';
      if (v <= range.min) return 'warn';
      return 'bad';
    }
    if (v >= range.opt) return 'ok';
    if (v >= range.min) return 'warn';
    return 'bad';
  }

  /** Porcentaje de avance respecto a la meta óptima (0-100).
   *  Para KPIs inversos, 100% = 0 errores; baja a medida que sube el valor. */
  progressPct(id: string, value: number): number {
    const range = this.getRange(id);
    if (!range || range.opt === 0) return 0;
    const v = Number(value) || 0;
    if (range.inverse) {
      // 0 → 100%, opt → 100%, min → 50% (degrada), >min → 0%.
      if (v <= range.opt) return 100;
      if (v >= range.min) return 0;
      const span = range.min - range.opt;
      if (span <= 0) return 0;
      return Math.max(0, Math.round((1 - (v - range.opt) / span) * 100));
    }
    return Math.min(100, Math.round((v / range.opt) * 100));
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
    // Defaults para los 8 KPIs del dashboard de reports + 3 históricos del
    // dashboard legacy. Antes solo había `score` definido y los otros 7 caían
    // en el path `if (!range) return 'ok'` → todo aparecía VERDE aunque la
    // realidad fuera mala. Los rangos son baseline editables desde el dialog
    // de "Metas" en /dashboard/reports.
    const defaults: KpiRange[] = [
      // Score promedio por visita (0-100 pts).
      { id: 'score',           label: 'Score Global',       unit: 'pts',   min: 65,  opt: 80  },
      // Total de visitas en el período. Asume meta de 50 visitas semanales del equipo.
      { id: 'visitas',         label: 'Visitas',            unit: '',      min: 20,  opt: 50  },
      // Total de ventas acumuladas $. Ajustar al volumen real del tenant.
      { id: 'venta',           label: 'Impacto venta',      unit: '$',     min: 5000, opt: 20000 },
      // Total de exhibiciones registradas (suma sobre visitas).
      { id: 'exhibiciones',    label: 'Exhibiciones',       unit: '',      min: 50,  opt: 150 },
      // Venta promedio por visita.
      { id: 'avgVenta',        label: 'Venta promedio',     unit: '$',     min: 100, opt: 300 },
      // "Stockout rate" en este dashboard = avgProductsPerVisit. MÁS es mejor (más variedad presente).
      // Si en el futuro se invierte semántica al % real de stockout, marcar `inverse: true` + ajustar rangos.
      { id: 'stockoutRate',    label: 'Productos/visita',   unit: '',      min: 1,   opt: 3   },
      // % de exhibidores en estado "óptimo".
      { id: 'healthRate',      label: 'Health Rate',        unit: '%',     min: 50,  opt: 80  },
      // # productos únicos con presencia en el rango.
      { id: 'uniqueProducts',  label: 'Productos únicos',   unit: '',      min: 10,  opt: 30  },
      // Históricos legacy — se siguen usando en otros dashboards.
      { id: 'avgDuration',     label: 'Tiempo Prom/Visita', unit: 'min',   min: 5,   opt: 15  },
      { id: 'evidenciaVisual', label: 'Evidencia Visual',   unit: 'fotos', min: 10,  opt: 30  },
      { id: 'metaDiaria',      label: 'Meta diaria',        unit: '',      min: 3,   opt: 5   },
    ];

    try {
      const raw = localStorage.getItem(STORAGE_KEY_KPI);
      if (raw) {
        const stored: KpiRange[] = JSON.parse(raw);
        // Merge: respeta lo guardado por el admin pero rellena los ids
        // nuevos que se agregaron en código (post primer load del usuario).
        // Sin esto, un user que ya tenía `metas_kpi_v2` en localStorage
        // queda stuck con solo `score` y ve todo verde para siempre.
        const merged = [...stored];
        const storedIds = new Set(stored.map((r) => r.id));
        for (const d of defaults) {
          if (!storedIds.has(d.id)) merged.push(d);
        }
        return merged;
      }
    } catch {
      /* localStorage corrupto → defaults */
    }
    return defaults;
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
