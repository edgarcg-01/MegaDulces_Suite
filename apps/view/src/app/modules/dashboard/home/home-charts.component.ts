import { Component, Input, ViewEncapsulation } from '@angular/core';
import { ChartModule } from 'primeng/chart';

@Component({
  selector: 'app-home-charts',
  standalone: true,
  imports: [ChartModule],
  template: `
    <div class="card-premium">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-base font-bold text-content-main">Ejecución Semanal</h3>
          <p class="text-xs text-content-muted mt-1">Visitas por día de la semana (acumulado)</p>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-4 text-[11px] text-content-muted">
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-ok"></span>Alto Score</span>
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-warn"></span>Medio</span>
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-bad"></span>Bajo</span>
          </div>
        </div>
      </div>
      <div class="h-[320px]">
        <p-chart type="bar" [data]="stackedChartData" [options]="stackedChartOptions" height="100%"></p-chart>
      </div>
    </div>
  `,
  encapsulation: ViewEncapsulation.None,
})
export class HomeChartsComponent {
  @Input() stackedChartData: any;
  @Input() stackedChartOptions: any;
}
