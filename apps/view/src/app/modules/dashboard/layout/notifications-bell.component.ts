import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AlertsSocketService, CommercialAlert } from '../command-center/alerts-socket.service';
import { FindingsService } from '../../finanzas/findings.service';
import { ActionsService } from '../../finanzas/actions.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

interface FeedItem { type: string; severity: 'info' | 'warn' | 'critical'; title: string; message: string; at: number; route?: string }

/**
 * Notificaciones de finanzas TEMPORALMENTE desactivadas (2026-08): la bandeja de hallazgos
 * está en recalibración; el badge de "críticos" traía cientos de hallazgos sin triar (ruido).
 * Con esto la campana no muestra ni cuenta nada de finanzas (sección, badge y alertas
 * finance_finding del feed en vivo). Volver a `true` cuando el flujo esté bien estructurado.
 */
const FINANCE_NOTIF_ENABLED = false;

/**
 * CxP (Fase CXP.1) — Centro de Notificaciones del header. Campana única que reúne
 * lo que necesita atención SIN entrar a cada pantalla:
 *   · Cuenta autoritativa (poll 60s): hallazgos críticos + acciones HITL por aprobar
 *     (de Maat/CxP) → badge. Solo si el usuario ve finanzas (evita 403).
 *   · Feed en vivo (WS /alerts): cualquier alerta que llega (finance_finding,
 *     pedidos, stock, db_health…) con un pulso "hay algo nuevo".
 *
 * Read-state en localStorage: al abrir marca leído y apaga el pulso; el badge es un
 * conteo VIVO de pendientes (no se apaga hasta que se resuelvan). Autónomo como el
 * HealthAlertToast: se monta una vez en el header. No desconecta el socket en destroy
 * (lo administra el toast hermano; misma vida del layout).
 */
@Component({
  selector: 'app-notifications-bell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="relative">
      <button
        type="button"
        (click)="toggle()"
        class="p-2 rounded-lg hover:bg-surface-hover transition-colors text-content-muted relative
               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
        [class.text-content-active]="attentionCount() > 0"
        aria-label="Notificaciones"
        aria-haspopup="dialog"
        [attr.aria-expanded]="open()"
      >
        <i class="pi pi-bell text-lg" [class.animate-pulse]="hasNew()" aria-hidden="true"></i>
        @if (attentionCount() > 0) {
          <span
            class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold leading-none
                   flex items-center justify-center"
            [style.background]="criticos() > 0 ? 'var(--bad-fg)' : 'var(--action)'"
            style="color:#fff"
            aria-hidden="true"
          >{{ attentionCount() > 99 ? '99+' : attentionCount() }}</span>
        } @else if (hasNew()) {
          <span class="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full animate-pulse" style="background:var(--action)" aria-hidden="true"></span>
        }
      </button>

      @if (open()) {
        <div class="fixed inset-0 z-[40]" (click)="close()" aria-hidden="true"></div>
        <div
          class="absolute right-0 top-full mt-2 w-[360px] max-w-[92vw] bg-surface-sidebar border border-divider rounded-xl shadow-lg z-[50] overflow-hidden"
          role="dialog"
          aria-label="Centro de notificaciones"
        >
          <header class="flex items-center justify-between px-4 py-3 border-b border-divider">
            <span class="text-sm font-semibold text-content-main">Notificaciones</span>
            @if (canSeeFinance()) {
              <button type="button" (click)="goHallazgos()" class="text-xs text-[color:var(--action)] hover:underline">Ver hallazgos</button>
            }
          </header>

          @if (canSeeFinance()) {
            <div class="px-2 py-2 border-b border-divider grid grid-cols-1 gap-1">
              <button type="button" (click)="goHallazgos()" class="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-left transition-colors">
                <i class="pi pi-flag text-base" [style.color]="criticos() > 0 ? 'var(--bad-fg)' : 'var(--content-muted, currentColor)'" aria-hidden="true"></i>
                <span class="flex-1 min-w-0">
                  <span class="block text-sm text-content-main">{{ criticos() }} crítico(s) · {{ pendientes() }} pendiente(s)</span>
                  <span class="block text-xs text-content-muted">Hallazgos de Maat</span>
                </span>
                @if (montoRiesgo() > 0) { <span class="text-xs font-semibold text-content-main tabular-nums">{{ money(montoRiesgo()) }}</span> }
              </button>
              <button type="button" (click)="goAcciones()" class="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-left transition-colors">
                <i class="pi pi-check-square text-base" [style.color]="accionesPend() > 0 ? 'var(--action)' : 'var(--content-muted, currentColor)'" aria-hidden="true"></i>
                <span class="flex-1 min-w-0">
                  <span class="block text-sm text-content-main">{{ accionesPend() }} acción(es) por aprobar</span>
                  <span class="block text-xs text-content-muted">Cuentas por Pagar / Tesorería (HITL)</span>
                </span>
                <i class="pi pi-angle-right text-content-muted" aria-hidden="true"></i>
              </button>
            </div>
          }

          <div class="max-h-[46vh] overflow-y-auto">
            @if (feed().length === 0) {
              <p class="px-4 py-6 text-center text-xs text-content-muted">Sin novedades en tiempo real.</p>
            } @else {
              <ul class="divide-y divide-[color:var(--c-divider,var(--border-color))]">
                @for (it of feed(); track it.at) {
                  <li>
                    <button type="button" (click)="goFeed(it)" class="w-full flex items-start gap-3 px-4 py-2.5 hover:bg-surface-hover text-left transition-colors">
                      <i class="pi {{ icon(it) }} text-sm mt-0.5" [style.color]="sevColor(it.severity)" aria-hidden="true"></i>
                      <span class="flex-1 min-w-0">
                        <span class="block text-sm text-content-main truncate">{{ it.title }}</span>
                        <span class="block text-xs text-content-muted line-clamp-2">{{ it.message }}</span>
                      </span>
                      <span class="text-[10px] text-content-muted whitespace-nowrap mt-0.5">{{ ago(it.at) }}</span>
                    </button>
                  </li>
                }
              </ul>
            }
          </div>

          @if (!connected()) {
            <div class="px-4 py-1.5 text-[10px] text-content-muted border-t border-divider status-bad">
              <span class="status-dot" aria-hidden="true"></span> Sin conexión en tiempo real
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class NotificationsBellComponent implements OnInit, OnDestroy {
  private readonly socket = inject(AlertsSocketService);
  private readonly findingsSvc = inject(FindingsService);
  private readonly actionsSvc = inject(ActionsService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);

  readonly open = signal(false);
  readonly criticos = signal(0);
  readonly pendientes = signal(0);
  readonly montoRiesgo = signal(0);
  readonly accionesPend = signal(0);
  readonly feed = signal<FeedItem[]>([]);
  readonly connected = this.socket.connected;
  private readonly lastReadAt = signal<number>(Number(localStorage.getItem('cxp_notif_read_at') || 0));
  private readonly newSince = signal(false);

  readonly canSeeFinance = computed(() =>
    FINANCE_NOTIF_ENABLED &&
    (this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.FINANCE_AI_CHAT] === true));
  /**
   * Quién ve los avisos de FEED (Kepler/ContPAQi trajo movimientos): quien tiene el
   * módulo de Bancos. Independiente de FINANCE_NOTIF_ENABLED (ese flag apaga los
   * hallazgos ruidosos de Maat, no estos avisos de feed).
   */
  readonly canSeeFinanceFeed = computed(() =>
    this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.FINANCE_BANK_VER] === true);
  readonly attentionCount = computed(() => this.criticos() + this.accionesPend());
  readonly hasNew = computed(() => this.newSince());

  private sub?: Subscription;
  private timer?: any;

  ngOnInit(): void {
    this.socket.connect();
    this.sub = this.socket.alert$.subscribe((a) => this.onAlert(a));
    if (this.canSeeFinance()) {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), 60_000);
    }
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    // el socket lo administra HealthAlertToast (hermano de layout) — no desconectar aquí.
  }

  private onAlert(a: CommercialAlert): void {
    // Finanzas (hallazgos Maat) desactivado: no dejamos pasar sus alertas al feed en vivo.
    if (!FINANCE_NOTIF_ENABLED && a.type === ('finance_finding' as any)) return;
    // Aviso de FEED nuevo (Kepler/ContPAQi): solo a quien tiene el módulo de Finanzas.
    if (a.type === ('finance_feed' as any) && !this.canSeeFinanceFeed()) return;
    const at = Date.parse(a.emitted_at) || Date.now();
    this.feed.update((f) => [{ type: a.type, severity: a.severity, title: a.title, message: a.message, at, route: a.data?.route }, ...f].slice(0, 20));
    this.newSince.set(true);
    // Una alerta financiera implica hallazgos nuevos → refresca el conteo.
    if (a.type === ('finance_finding' as any) && this.canSeeFinance()) this.refresh();
  }

  private refresh(): void {
    this.findingsSvc.stats().subscribe({
      next: (s) => { this.criticos.set(s.criticos || 0); this.pendientes.set(s.pendientes || 0); this.montoRiesgo.set(s.monto_en_riesgo || 0); },
      error: () => {},
    });
    this.actionsSvc.list('pending_approval').subscribe({
      next: (rows) => this.accionesPend.set(rows?.length || 0),
      error: () => {},
    });
  }

  toggle(): void {
    const willOpen = !this.open();
    this.open.set(willOpen);
    if (willOpen) { this.markRead(); if (this.canSeeFinance()) this.refresh(); }
  }
  close(): void { this.open.set(false); }

  private markRead(): void {
    const now = Date.now();
    this.lastReadAt.set(now);
    localStorage.setItem('cxp_notif_read_at', String(now));
    this.newSince.set(false);
  }

  goHallazgos(): void { this.close(); this.router.navigate(['/finanzas/hallazgos']); }
  goAcciones(): void { this.close(); this.router.navigate(['/finanzas/hallazgos'], { fragment: 'acciones' }); }
  goFeed(it: FeedItem): void { this.close(); if (it.route) this.router.navigateByUrl(it.route); }

  icon(it: FeedItem): string {
    switch (it.type) {
      case 'finance_finding': return 'pi-flag';
      case 'large_order': return 'pi-shopping-cart';
      case 'order_confirmed': case 'order_fulfilled': return 'pi-check-circle';
      case 'low_stock_critical': return 'pi-box';
      case 'vip_inactive': return 'pi-user';
      case 'db_health': return 'pi-database';
      case 'finance_feed': return 'pi-sync';
      default: return 'pi-bell';
    }
  }
  sevColor(s: 'info' | 'warn' | 'critical'): string {
    return s === 'critical' ? 'var(--bad-fg)' : s === 'warn' ? 'var(--warn-fg)' : 'var(--info-fg, currentColor)';
  }
  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  ago(at: number): string {
    const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (s < 60) return 'ahora'; if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
  }
}
