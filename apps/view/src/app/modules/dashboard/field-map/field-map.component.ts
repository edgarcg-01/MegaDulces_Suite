import { Component, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';

import { ActivatedRoute, Router } from '@angular/router';
import { LiveMapComponent } from '../live-map/live-map.component';
import { RoutesAnalysisComponent } from '../routes-analysis/routes-analysis.component';
import { VendorHistoryComponent } from '../vendor-history/vendor-history.component';
import { TeamDayComponent } from './team-day.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

type FieldView = 'live' | 'equipo' | 'ruta' | 'vendedor';

/**
 * Mapas (Trade) — superficie unificada de tracking de PERSONAS. Reúne en una
 * sola entrada las vistas que antes eran rutas separadas (Mapa en Vivo / Equipo /
 * Rutas / Historial por vendedor), todas sobre "tiendas + visitas + recorrido".
 * Cada vista monta su componente existente bajo un @switch (consolidación sin
 * regresión). Requiere RUTAS_VER. "Mapa Comercial" (propio vs competencia) vive
 * aparte como su propia entrada. La vista activa se refleja en ?view= (deep-link).
 */
@Component({
  selector: 'app-field-map',
  standalone: true,
  imports: [LiveMapComponent, RoutesAnalysisComponent, VendorHistoryComponent, TeamDayComponent],
  template: `
    <div class="fm-wrap">
      <nav class="fm-tabs" role="tablist">
        <button role="tab" [class.act]="view() === 'live'" [attr.aria-selected]="view() === 'live'" (click)="setView('live')">
          <i class="pi pi-compass" aria-hidden="true"></i>&nbsp;En vivo
        </button>
        <button role="tab" [class.act]="view() === 'equipo'" [attr.aria-selected]="view() === 'equipo'" (click)="setView('equipo')">
          <i class="pi pi-users" aria-hidden="true"></i>&nbsp;Equipo
        </button>
        <button role="tab" [class.act]="view() === 'ruta'" [attr.aria-selected]="view() === 'ruta'" (click)="setView('ruta')">
          <i class="pi pi-map" aria-hidden="true"></i>&nbsp;Por ruta
        </button>
        <button role="tab" [class.act]="view() === 'vendedor'" [attr.aria-selected]="view() === 'vendedor'" (click)="setView('vendedor')">
          <i class="pi pi-history" aria-hidden="true"></i>&nbsp;Por vendedor
        </button>
      </nav>
      <div class="fm-view">
        @switch (view()) {
          @case ('live') { <app-live-map /> }
          @case ('equipo') { <app-team-day (selectVendor)="onTeamSelect($event)" /> }
          @case ('ruta') { <app-routes-analysis /> }
          @case ('vendedor') { <app-vendor-history /> }
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    :host { display:block; }
    .fm-wrap { display:flex; flex-direction:column; min-height:calc(100vh - var(--app-header-h, 56px)); }
    .fm-tabs { display:flex; gap:.25rem; padding:.5rem .75rem 0; border-bottom:1px solid var(--border-color); background:var(--card-bg,#fff); flex-wrap:wrap; }
    .fm-tabs button { padding:.55rem .9rem; border:0; border-bottom:2px solid transparent; background:transparent; font:600 .85rem 'Hanken Grotesk',sans-serif; color:var(--text-dim,#78716c); cursor:pointer; }
    .fm-tabs button:hover { color:var(--text,#1c1917); }
    .fm-tabs button.act { color:var(--action,#F05A28); border-bottom-color:var(--action,#F05A28); }
    .fm-view { flex:1; min-height:0; }
  `],
})
export class FieldMapComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);
  private perms = inject(PermissionsService);
  protected view = signal<FieldView>('live');

  /** Todas las pestañas requieren RUTAS_VER (tracking de personas). */
  protected canTracking = computed(() => this.perms.has(Permission.RUTAS_VER));

  ngOnInit(): void {
    const v = this.route.snapshot.queryParamMap.get('view') as FieldView | null;
    if (v && this.isAllowed(v)) this.view.set(v);
  }

  private isAllowed(v: FieldView): boolean {
    return v === 'live' || v === 'equipo' || v === 'ruta' || v === 'vendedor';
  }

  protected setView(v: FieldView): void {
    if (v === this.view()) return;
    this.view.set(v);
    this.router.navigate([], { relativeTo: this.route, queryParams: { view: v }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Clic en una fila del resumen → salta a "Por vendedor" de ese vendedor/día. */
  protected onTeamSelect(sel: { user_id: string; date: string }): void {
    this.router
      .navigate([], { relativeTo: this.route, queryParams: { view: 'vendedor', user_id: sel.user_id, date: sel.date }, queryParamsHandling: 'merge' })
      .then(() => this.view.set('vendedor'));
  }
}
