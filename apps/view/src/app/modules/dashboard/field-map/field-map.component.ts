import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { RoutesAnalysisComponent } from '../routes-analysis/routes-analysis.component';
import { VendorHistoryComponent } from '../vendor-history/vendor-history.component';
import { CommercialMapComponent } from '../commercial-map/commercial-map.component';
import { TeamDayComponent } from './team-day.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

type FieldView = 'equipo' | 'ruta' | 'vendedor' | 'exhibicion';

/**
 * Mapa de campo — superficie unificada (MF.1). Reúne en una sola entrada las
 * tres vistas que antes eran rutas separadas (Rutas / Historial / Mapa
 * Comercial), todas sobre "tiendas + visitas + recorrido". Por ahora cada vista
 * monta su componente existente bajo un selector (consolidación de interfaces
 * sin regresión); fases siguientes (MF.2+) unifican el mapa y el drill-down.
 * La vista activa se refleja en ?view= para deep-links.
 */
@Component({
  selector: 'app-field-map',
  standalone: true,
  imports: [CommonModule, RoutesAnalysisComponent, VendorHistoryComponent, CommercialMapComponent, TeamDayComponent],
  template: `
    <div class="fm-wrap">
      <nav class="fm-tabs" role="tablist">
        <button role="tab" [class.act]="view() === 'equipo'" [attr.aria-selected]="view() === 'equipo'" (click)="setView('equipo')">
          <i class="pi pi-users" aria-hidden="true"></i>&nbsp;Equipo
        </button>
        <button role="tab" [class.act]="view() === 'ruta'" [attr.aria-selected]="view() === 'ruta'" (click)="setView('ruta')">
          <i class="pi pi-map" aria-hidden="true"></i>&nbsp;Por ruta
        </button>
        <button role="tab" [class.act]="view() === 'vendedor'" [attr.aria-selected]="view() === 'vendedor'" (click)="setView('vendedor')">
          <i class="pi pi-history" aria-hidden="true"></i>&nbsp;Por vendedor
        </button>
        @if (canExhibition()) {
          <button role="tab" [class.act]="view() === 'exhibicion'" [attr.aria-selected]="view() === 'exhibicion'" (click)="setView('exhibicion')">
            <i class="pi pi-map-marker" aria-hidden="true"></i>&nbsp;Exhibición
          </button>
        }
      </nav>
      <div class="fm-view">
        @switch (view()) {
          @case ('equipo') { <app-team-day (selectVendor)="onTeamSelect($event)" /> }
          @case ('ruta') { <app-routes-analysis /> }
          @case ('vendedor') { <app-vendor-history /> }
          @case ('exhibicion') { <app-commercial-map /> }
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .fm-wrap { display:flex; flex-direction:column; min-height:calc(100vh - var(--app-header-h, 56px)); }
    .fm-tabs { display:flex; gap:.25rem; padding:.5rem .75rem 0; border-bottom:1px solid var(--divider,#e7e5e4); background:var(--card-bg,#fff); flex-wrap:wrap; }
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
  protected view = signal<FieldView>('equipo');

  /** La vista Exhibición (Mapa Comercial) requiere COMMERCIAL_MAP_VER. */
  protected canExhibition = computed(
    () =>
      this.perms.can('read', 'commercial_map' as any) ||
      this.auth.user()?.permissions?.[Permission.COMMERCIAL_MAP_VER] === true,
  );

  ngOnInit(): void {
    const v = this.route.snapshot.queryParamMap.get('view') as FieldView | null;
    if (v === 'equipo' || v === 'ruta' || v === 'vendedor' || (v === 'exhibicion' && this.canExhibition())) this.view.set(v);
  }

  protected setView(v: FieldView): void {
    if (v === this.view()) return;
    this.view.set(v);
    // Refleja la vista en la URL (deep-link) sin recargar.
    this.router.navigate([], { relativeTo: this.route, queryParams: { view: v }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Clic en una fila del resumen → salta a "Por vendedor" de ese vendedor/día. */
  protected onTeamSelect(sel: { user_id: string; date: string }): void {
    this.router
      .navigate([], { relativeTo: this.route, queryParams: { view: 'vendedor', user_id: sel.user_id, date: sel.date }, queryParamsHandling: 'merge' })
      .then(() => this.view.set('vendedor'));
  }
}
