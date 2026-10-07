import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ANALISIS_TABS } from './analisis-tabs';
import { AnalisisStateService, PRESET_OPTIONS, PresetKey } from './analisis-state.service';

/**
 * `[TDA.A1]` Shell de **Análisis de ventas** (`/tienda/analisis-semanal/*`).
 *
 * Monta UNA vez el encabezado, el filtro y la barra de pestañas para las 4 secciones.
 * El orden es el que pidió el negocio: título → pestañas → filtro → contenido.
 *
 * El filtro va acá y no en cada página por una razón de fondo: las 4 secciones miran el
 * MISMO recorte. Si cada una tuviera el suyo, «Tráfico dice 30 días y Productos dice el
 * mes» sería un estado alcanzable, y a partir de ahí nadie vuelve a confiar en la
 * pantalla. El estado (`AnalisisStateService`) se provee en la ruta padre.
 *
 * OJO: acá adentro NO van acentos graves. El template es un template literal de JS y un
 * backtick lo corta en seco; el compilador entonces reporta un "Cannot find name" que no
 * suena para nada a comilla. (Ya pasó cuatro veces en este repo.)
 */
@Component({
  selector: 'app-tienda-analisis-shell',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterOutlet, SelectModule, DatePickerModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in an-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Análisis de ventas</h1>
          <p class="surf-page-sub">Cómo se comporta la tienda y cómo va cambiando. Elige el período y la sucursal una vez: las cuatro secciones miran el mismo recorte.</p>
        </div>
        @if (st.scopedWarehouse) {
          <span class="an-scope"><i class="pi pi-map-marker"></i> {{ st.branchLabel() }}</span>
        }
      </header>

      <app-page-tabs [tabs]="tabs" />

      <div class="an-filters">
        <label class="an-ctl">
          <span class="an-ctl-lbl">Período</span>
          <p-select [options]="presetOptions" optionLabel="label" optionValue="value"
                    [ngModel]="st.preset()" (ngModelChange)="onPreset($event)"
                    styleClass="sel-liquid an-select" appendTo="body" />
        </label>

        @if (st.preset() === 'custom') {
          <label class="an-ctl">
            <span class="an-ctl-lbl">Fechas</span>
            <p-datepicker [(ngModel)]="st.customRange" selectionMode="range" [readonlyInput]="true"
                          dateFormat="dd/mm/yy" [showIcon]="true" [maxDate]="hoy" appendTo="body"
                          (onSelect)="st.applyCustom()" styleClass="an-dp" placeholder="Elige el rango" />
          </label>
        }

        @if (!st.scopedWarehouse && st.branchOpts().length) {
          <label class="an-ctl an-ctl-right">
            <span class="an-ctl-lbl">Sucursal</span>
            <p-select [options]="st.branchOpts()" optionLabel="label" optionValue="value"
                      [ngModel]="st.storeFilter()" (ngModelChange)="st.changeStore($event)"
                      styleClass="sel-liquid an-select" appendTo="body" />
          </label>
        }

        @if (st.from() && st.to()) {
          <p class="an-rangelbl">
            {{ st.from() | date: 'dd/MM/yy' }} – {{ st.to() | date: 'dd/MM/yy' }}
            <span class="an-muted">({{ st.days() }} {{ st.days() === 1 ? 'día' : 'días' }})</span>
          </p>
        }
      </div>

      <router-outlet />
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .an-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action); margin-left: auto; }
      .an-filters { display: flex; align-items: flex-end; gap: 1rem; flex-wrap: wrap; margin: 0 0 1.1rem; }
      .an-ctl { display: inline-flex; flex-direction: column; gap: .25rem; }
      .an-ctl-right { margin-left: auto; }
      .an-ctl-lbl { font-size: .7rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted); }
      .an-select { min-width: 12rem; }
      .an-rangelbl { margin: 0 0 .15rem; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--text-main); }
      .an-muted { color: var(--text-muted); }
      @media (max-width: 48rem) {
        .an-ctl-right { margin-left: 0; }
        .an-select { min-width: 100%; }
        .an-ctl { width: 100%; }
      }
    `,
  ],
})
export class TiendaAnalisisShellComponent {
  protected readonly st = inject(AnalisisStateService);
  protected readonly tabs = ANALISIS_TABS;
  protected readonly presetOptions = PRESET_OPTIONS;
  protected readonly hoy = new Date();

  onPreset(p: PresetKey): void {
    this.st.applyPreset(p);
  }
}
