import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { VendorService, DayPickOption, DayPickState } from '../vendor.service';
import { AuthService } from '../../../core/services/auth.service';
import { markRoutePickAsked } from '../route-pick.guard';

const DAY_SHORT = ['', 'L', 'M', 'Mi', 'J', 'V', 'S', 'D'];

/**
 * `[VR.SUP.1]` "¿Qué ruta vas a trabajar hoy?" — el supervisor de ventas escoge una
 * ruta de su equipo para trabajar HOY. Vale solo por hoy: mañana vuelve a su agenda.
 * No le quita la ruta al vendedor dueño (los dos la ven).
 *
 * Se llega (a) solo, la primera vez del día, por `routePickGuard`; o (b) desde el
 * botón "Cambiar ruta" del hero de "Mi ruta".
 */
@Component({
  selector: 'app-vendor-route-pick',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, SkeletonModule, ButtonModule],
  template: `
    <div class="page-head">
      <h1 class="page-title">¿Qué ruta vas a trabajar hoy?</h1>
      <p class="subtitle">Hoy · {{ todayLabel }}. Solo vale por hoy; mañana vuelves a tu agenda.</p>
    </div>

    @if (loading()) {
      <p-skeleton height="4.5rem" styleClass="mb-2"></p-skeleton>
      <p-skeleton height="4.5rem" styleClass="mb-2"></p-skeleton>
      <p-skeleton height="4.5rem"></p-skeleton>
    }

    @if (!loading() && loadError()) {
      <div class="empty">
        <i class="pi pi-cloud"></i>
        <p>No se pudieron cargar las rutas de tu equipo.</p>
        <div class="empty-actions">
          <button pButton severity="secondary" [text]="true" (click)="load()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Reintentar</span>
          </button>
          <button pButton [text]="true" (click)="useAgenda()">
            <span class="p-button-label">Seguir con mi agenda</span>
          </button>
        </div>
      </div>
    }

    @if (!loading() && !loadError() && state(); as s) {
      <!-- Mi agenda normal -->
      <button
        type="button"
        class="opt agenda"
        [class.sel]="!s.current"
        [disabled]="saving() !== null"
        (click)="useAgenda()"
      >
        <span class="ic"><i class="pi pi-calendar"></i></span>
        <span class="body">
          <span class="t">Mi agenda normal</span>
          <span class="d">
            @if (s.agenda_today.length) {
              Hoy te toca {{ s.agenda_today.join(', ') }}
            } @else {
              No tienes ruta agendada hoy
            }
          </span>
        </span>
        @if (saving() === 'agenda') {
          <i class="pi pi-spin pi-spinner go"></i>
        } @else if (!s.current) {
          <i class="pi pi-check go ok"></i>
        }
      </button>

      @if (s.options.length > 8) {
        <input
          type="search"
          class="search"
          placeholder="Buscar ruta, zona o vendedor"
          aria-label="Buscar ruta"
          [ngModel]="search()"
          (ngModelChange)="search.set($event)"
        />
      }

      @if (!s.options.length) {
        <div class="empty small">
          <p>Tu equipo no tiene rutas agendadas. Pide que se las asignen en el panel de rutas.</p>
        </div>
      }

      @if (todayOpts().length) {
        <div class="group">Tocan hoy</div>
        @for (o of todayOpts(); track o.route_id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: o }"></ng-container>
        }
      }
      @if (otherOpts().length) {
        <div class="group">Otras rutas de tu equipo</div>
        @for (o of otherOpts(); track o.route_id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: o }"></ng-container>
        }
      }
      @if (search() && !todayOpts().length && !otherOpts().length) {
        <p class="none">Ninguna ruta coincide con “{{ search() }}”.</p>
      }
    }

    <ng-template #row let-o>
      <button
        type="button"
        class="opt"
        [class.sel]="state()?.current?.route_id === o.route_id"
        [disabled]="saving() !== null"
        (click)="pick(o)"
      >
        <span class="ic route"><i class="pi pi-map-marker"></i></span>
        <span class="body">
          <span class="t">
            {{ o.route }}
            @if (o.zone) { <span class="zone">· {{ o.zone }}</span> }
          </span>
          <span class="d">{{ vendorsLabel(o) }}</span>
          <span class="meta">
            <span>{{ o.customers }} {{ o.customers === 1 ? 'cliente' : 'clientes' }}</span>
            <span class="days">{{ daysLabel(o.days) }}</span>
          </span>
        </span>
        @if (saving() === o.route_id) {
          <i class="pi pi-spin pi-spinner go"></i>
        } @else if (state()?.current?.route_id === o.route_id) {
          <i class="pi pi-check go ok"></i>
        } @else {
          <i class="pi pi-chevron-right go"></i>
        }
      </button>
    </ng-template>
  `,
  styles: [
    `
      .page-title { margin: 0 0 0.2rem; font-size: 1.4rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.85rem; }
      .group { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); margin: 1.1rem 0 0.5rem; }
      .opt {
        display: flex; align-items: center; gap: 0.75rem; width: 100%; min-height: 3.5rem; text-align: left;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px);
        padding: 0.75rem; margin-bottom: 0.5rem; cursor: pointer; color: inherit; font: inherit;
        transition: transform 0.08s var(--ease, ease);
      }
      .opt:active:not(:disabled) { transform: scale(0.99); }
      .opt:disabled { opacity: 0.7; cursor: default; }
      .opt:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
      .opt.sel { border-color: var(--action); box-shadow: 0 0 0 1px var(--action) inset; }
      @media (prefers-reduced-motion: reduce) { .opt { transition: none; } }
      .ic { width: 2.35rem; height: 2.35rem; border-radius: 14px; display: grid; place-items: center; flex-shrink: 0; font-size: 1rem; background: var(--surface-2, var(--border-color)); color: var(--text-muted); }
      .ic.route { background: var(--action); color: #fff; }
      .body { flex: 1; min-width: 0; }
      .t { display: block; font-weight: 700; font-size: 0.925rem; color: var(--text-main); }
      .zone { font-weight: 500; color: var(--text-muted); font-size: 0.8rem; }
      .d { display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .meta { display: flex; gap: 0.6rem; font-size: 0.72rem; color: var(--text-faint); margin-top: 2px; }
      .days { font-family: var(--font-mono, ui-monospace, monospace); }
      .go { color: var(--text-faint); font-size: 0.9rem; flex-shrink: 0; }
      .go.ok { color: var(--action); }
      .search {
        width: 100%; margin: 0.75rem 0 0; padding: 0.65rem 0.8rem; font: inherit; font-size: 0.9rem;
        border: 1px solid var(--border-color); border-radius: var(--r-md, 12px);
        background: var(--card-bg); color: var(--text-main);
      }
      .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .empty.small { padding: 1rem; }
      .empty i { font-size: 2.2rem; display: block; margin-bottom: 0.5rem; }
      .empty-actions { display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap; }
      .none { color: var(--text-muted); font-size: 0.85rem; text-align: center; margin-top: 1rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorRoutePickComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly state = signal<DayPickState | null>(null);
  /** route_id que se está guardando, 'agenda' al volver a la agenda, null si nada. */
  readonly saving = signal<string | null>(null);
  readonly search = signal('');
  readonly todayLabel = new Date().toLocaleDateString('es-MX', { weekday: 'long' });

  private readonly filteredOpts = computed(() => {
    const opts = this.state()?.options ?? [];
    const term = this.search().trim().toLowerCase();
    if (!term) return opts;
    return opts.filter(
      (o) =>
        o.route.toLowerCase().includes(term) ||
        (o.zone ?? '').toLowerCase().includes(term) ||
        o.vendors.some((v) => v.username.toLowerCase().includes(term)),
    );
  });
  readonly todayOpts = computed(() => this.filteredOpts().filter((o) => o.scheduled_today));
  readonly otherOpts = computed(() => this.filteredOpts().filter((o) => !o.scheduled_today));

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.api
      .dayPickState()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          // Un vendedor sin equipo que cae aquí por URL no tiene nada que escoger.
          if (!s.can_pick) {
            this.goHome();
            return;
          }
          this.state.set(s);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  pick(o: DayPickOption): void {
    if (this.saving()) return;
    this.saving.set(o.route_id);
    this.api
      .setDayPick(o.route_id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          markRoutePickAsked(this.auth.user()?.sub);
          this.toast.add({ severity: 'success', summary: `Hoy trabajas ${o.route}` });
          this.goHome();
        },
        error: (err) => {
          this.saving.set(null);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo escoger la ruta',
            detail: err?.error?.message || 'Revisa tu conexión e intenta de nuevo.',
          });
        },
      });
  }

  /** Trabaja su agenda normal: borra la elección de hoy (si había) y no le vuelve a preguntar hoy. */
  useAgenda(): void {
    if (this.saving()) return;
    markRoutePickAsked(this.auth.user()?.sub);
    if (!this.state()?.current) {
      this.goHome();
      return;
    }
    this.saving.set('agenda');
    this.api
      .clearDayPick()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.goHome(),
        error: () => {
          this.saving.set(null);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo volver a tu agenda',
            detail: 'Revisa tu conexión e intenta de nuevo.',
          });
        },
      });
  }

  vendorsLabel(o: DayPickOption): string {
    const names = o.vendors.map((v) => (v.is_me ? 'Tú' : v.username) + (v.today ? ' (hoy)' : ''));
    return names.join(', ');
  }

  daysLabel(days: number[]): string {
    return days.map((d) => DAY_SHORT[d] ?? '').join(' ');
  }

  private goHome(): void {
    this.router.navigate(['/vendor/route-home'], { replaceUrl: true });
  }
}
