import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, switchMap, of, catchError, map } from 'rxjs';
import { VendorService, VendorCustomer } from '../vendor.service';

@Component({
  selector: 'app-vendor-customers',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    SkeletonModule,
    InputTextModule,
    ButtonModule,
  ],
  template: `
    <div class="head">
      <div>
        <h1 class="page-title">Buscar cliente</h1>
        <p class="subtitle">Cualquier cliente del catálogo, esté o no en tu cartera</p>
      </div>
      <button type="button" class="new-btn" [class.active]="showForm()" (click)="toggleForm()">
        <i class="pi" [ngClass]="showForm() ? 'pi-times' : 'pi-plus'"></i>
        {{ showForm() ? 'Cancelar' : 'Nuevo' }}
      </button>
    </div>

    <!-- Alta de cliente nuevo -->
    <form *ngIf="showForm()" class="new-form" (ngSubmit)="submit()">
      <div *ngIf="formError()" class="form-err">
        <i class="pi pi-exclamation-circle"></i> {{ formError() }}
      </div>

      <label class="fld">
        <span>Nombre del negocio *</span>
        <input pInputText type="text" name="name" [(ngModel)]="form.name"
               placeholder="Ej. Abarrotes La Esquina" autocapitalize="words"
               enterkeyhint="next" required />
      </label>

      <div class="row">
        <label class="fld">
          <span>Teléfono</span>
          <input pInputText type="tel" name="phone" [(ngModel)]="form.phone"
                 placeholder="10 dígitos" inputmode="tel" autocomplete="off" />
        </label>
        <label class="fld">
          <span>WhatsApp</span>
          <input pInputText type="tel" name="whatsapp" [(ngModel)]="form.whatsapp"
                 placeholder="10 dígitos" inputmode="tel" autocomplete="off" />
        </label>
      </div>

      <label class="fld">
        <span>RFC <em>(opcional)</em></span>
        <input pInputText type="text" name="rfc" [(ngModel)]="form.rfc"
               placeholder="XAXX010101000" autocapitalize="characters"
               autocorrect="off" spellcheck="false" />
      </label>

      <label class="fld">
        <span>Dirección / referencia</span>
        <input pInputText type="text" name="notes" [(ngModel)]="form.notes"
               placeholder="Calle, colonia, entre calles…" autocapitalize="sentences" />
      </label>

      <button type="button" class="geo-btn" [class.ok]="hasGeo()" (click)="captureLocation()">
        <i class="pi" [ngClass]="locating() ? 'pi-spin pi-spinner' : (hasGeo() ? 'pi-check-circle' : 'pi-map-marker')"></i>
        {{ hasGeo() ? 'Ubicación capturada' : 'Capturar ubicación' }}
      </button>

      <button pButton type="submit" class="submit-btn"
              [disabled]="saving() || !form.name.trim()"
              [label]="saving() ? 'Guardando…' : 'Crear y tomar pedido'"></button>
    </form>

    <ng-container *ngIf="!showForm()">
      <div class="search">
        <i class="pi" [ngClass]="searching() ? 'pi-spin pi-spinner' : 'pi-search'"></i>
        <input
          pInputText
          type="search"
          placeholder="Nombre, código o RFC"
          [(ngModel)]="search"
          (ngModelChange)="onSearch($event)"
          inputmode="search"
          enterkeyhint="search"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
        />
      </div>

      <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

      <!-- Fallo de red sin resultados previos -->
      <div *ngIf="!loading() && loadError() && customers().length === 0" class="empty">
        <i class="pi pi-cloud"></i>
        <p>No se pudo buscar. Revisá tu conexión.</p>
        <a pButton label="Reintentar" icon="pi pi-refresh" severity="secondary" [text]="true" (click)="retry()"></a>
      </div>

      <div *ngIf="!loading() && !loadError() && customers().length === 0" class="empty">
        <i class="pi pi-search"></i>
        <p *ngIf="search">Sin resultados para "{{ search }}".</p>
        <p *ngIf="!search">Escribí para buscar un cliente.</p>
        <a *ngIf="search" pButton label="Crear cliente nuevo" icon="pi pi-plus" severity="secondary" [text]="true" (click)="toggleForm()"></a>
      </div>

      <!-- Resultados previos en pantalla pero la última búsqueda falló -->
      <button *ngIf="!loading() && loadError() && customers().length > 0" type="button" class="err-banner" (click)="retry()">
        <i class="pi pi-exclamation-triangle"></i> No se pudo actualizar — tocá para reintentar
      </button>

      <div *ngIf="!loading() && customers().length > 0" class="list">
        <button class="client" *ngFor="let c of customers()" (click)="navigateToTakeOrder(c)">
          <span class="av">{{ initials(c.name) }}</span>
          <span class="cbody">
            <span class="nm">{{ c.name }}</span>
            <span class="meta">
              <span class="code">{{ c.code }}</span>
              <span *ngIf="c.phone">· {{ c.phone }}</span>
            </span>
          </span>
          <i class="pi pi-arrow-right action"></i>
        </button>
      </div>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }
      .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; margin-bottom: 1rem; }
      .page-title { margin: 0 0 0.2rem; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .subtitle { margin: 0; color: var(--text-muted); font-size: 0.875rem; }
      .new-btn {
        flex-shrink: 0; display: inline-flex; align-items: center; gap: 0.4rem;
        background: var(--action); color: #fff; border: none; border-radius: var(--r-pill, 999px);
        padding: 0.6rem 1rem; font-weight: 700; font-size: 0.85rem; cursor: pointer;
        box-shadow: 0 1px 2px rgba(16,13,9,0.08); transition: transform 0.06s var(--ease, ease), filter 0.15s ease;
      }
      .new-btn:active { transform: scale(0.97); }
      .new-btn.active { background: var(--card-bg); color: var(--text-muted); border: 1px solid var(--border-color); }
      @media (prefers-reduced-motion: reduce) { .new-btn { transition: none; } }

      .new-form { display: flex; flex-direction: column; gap: 0.85rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px); padding: 1rem; box-shadow: 0 1px 2px rgba(16,13,9,0.05); animation: list-in 0.18s var(--ease-out, cubic-bezier(0.23,1,0.32,1)); }
      .form-err { display: flex; align-items: center; gap: 0.45rem; padding: 0.55rem 0.7rem; border-radius: var(--r-md, 12px); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: 0.8rem; font-weight: 600; }
      .fld { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; }
      .fld > span { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 700; }
      .fld > span em { font-style: normal; color: var(--text-faint); font-weight: 500; text-transform: none; letter-spacing: 0; }
      .fld input { width: 100%; height: 2.7rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); padding: 0 0.85rem; font-family: var(--font-body); font-size: 0.95rem; color: var(--text-main); }
      .fld input:focus { outline: none; border-color: var(--text-muted); }
      .row { display: flex; gap: 0.7rem; }
      .geo-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; height: 2.7rem; border: 1px dashed var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); color: var(--text-muted); font-weight: 600; font-size: 0.85rem; cursor: pointer; }
      .geo-btn.ok { border-style: solid; border-color: var(--ok-fg, #2e7d32); color: var(--ok-fg, #2e7d32); }
      .submit-btn { width: 100%; }
      .submit-btn ::ng-deep .p-button { width: 100%; justify-content: center; background: var(--action); border-color: var(--action); font-weight: 700; }

      .search { display: flex; align-items: center; gap: 0.6rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: 0.1rem 0.95rem; margin-bottom: 1rem; box-shadow: 0 1px 2px rgba(16,13,9,0.05); }
      .search i { color: var(--text-muted); }
      .search input { flex: 1; border: none; background: none; outline: none; height: 2.8rem; font-family: var(--font-body); font-size: 0.95rem; color: var(--text-main); }
      .empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }
      .err-banner { display: flex; align-items: center; gap: 0.45rem; width: 100%; margin-bottom: 0.6rem; padding: 0.55rem 0.8rem; border-radius: var(--r-md, 12px); background: var(--bad-soft-bg); border: 1px solid var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: 0.78rem; font-weight: 600; text-align: left; cursor: pointer; }
      .list { display: flex; flex-direction: column; gap: 0.5rem; animation: list-in 0.18s var(--ease-out, cubic-bezier(0.23,1,0.32,1)); }
      @keyframes list-in { from { opacity: 0; } to { opacity: 1; } }
      .client {
        display: flex; align-items: center; gap: 0.8rem; width: 100%; text-align: left;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px);
        padding: 0.7rem 0.875rem; cursor: pointer; box-shadow: 0 1px 2px rgba(16,13,9,0.05);
        transition: transform 0.06s var(--ease, ease);
      }
      .client:active { transform: scale(0.985); }
      @media (prefers-reduced-motion: reduce) { .list { animation: none; } .client { transition: none; } .new-form { animation: none; } }
      .av { width: 2.4rem; height: 2.4rem; border-radius: 16px; flex-shrink: 0; display: grid; place-items: center; background: var(--stone-100); color: var(--stone-700); font-weight: 800; font-size: 0.9rem; }
      .cbody { flex: 1; min-width: 0; }
      .nm { display: block; font-weight: 700; font-size: 0.95rem; color: var(--text-main); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .meta { display: flex; gap: 0.4rem; font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
      .code { font-family: var(--font-mono); font-weight: 600; }
      .action { color: var(--action); font-size: 1.1rem; flex-shrink: 0; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorCustomersComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(true); // skeleton solo en la carga inicial
  readonly searching = signal(false); // re-búsqueda: spinner sutil sin blanquear la lista
  /** Falló la búsqueda (red) — distinto de "sin resultados" (estándar PWA §5). */
  readonly loadError = signal(false);
  readonly customers = signal<VendorCustomer[]>([]);

  // ─── Alta de cliente nuevo ───
  readonly showForm = signal(false);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  readonly locating = signal(false);
  readonly geo = signal<{ lat: number; lng: number } | null>(null);
  form = { name: '', phone: '', whatsapp: '', rfc: '', notes: '' };

  search = '';
  private first = true;
  private readonly search$ = new Subject<string>();

  ngOnInit(): void {
    this.search$
      .pipe(
        debounceTime(250),
        // catchError DENTRO del switchMap: un error de red NO mata el stream
        // (sin esto, tras un fallo la búsqueda quedaba muerta hasta recargar).
        switchMap((s) =>
          this.api.listCustomers({ search: s.trim() || undefined, pageSize: 100 }).pipe(
            map((r) => r.data),
            catchError(() => {
              this.loadError.set(true);
              return of<VendorCustomer[] | null>(null);
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((data) => {
        if (data !== null) {
          this.customers.set(data);
          this.loadError.set(false);
        }
        this.loading.set(false);
        this.searching.set(false);
        this.first = false;
      });

    this.runSearch(''); // carga inicial

    // Llegada desde "Agregar cliente" del home (ronda vacía): abre el form directo.
    if (this.route.snapshot.queryParamMap.get('new') === '1') {
      this.toggleForm();
    }
  }

  onSearch(v: string): void {
    this.runSearch(v);
  }

  private runSearch(v: string): void {
    this.loadError.set(false);
    if (this.first) this.loading.set(true);
    else this.searching.set(true);
    this.search$.next(v);
  }

  /** Reintenta la última búsqueda tras un fallo de red. */
  retry(): void {
    this.runSearch(this.search);
  }

  navigateToTakeOrder(c: VendorCustomer): void {
    this.router.navigate(['/vendor/take-order', c.id]);
  }

  // ─── Alta de cliente ───

  hasGeo(): boolean {
    return this.geo() !== null;
  }

  toggleForm(): void {
    const next = !this.showForm();
    this.showForm.set(next);
    if (next) {
      // Pre-llena el nombre con lo que venía buscando (atajo de campo).
      this.form = { name: this.search.trim(), phone: '', whatsapp: '', rfc: '', notes: '' };
      this.geo.set(null);
      this.formError.set(null);
    }
  }

  captureLocation(): void {
    if (!navigator.geolocation) {
      this.formError.set('Tu dispositivo no permite capturar ubicación.');
      return;
    }
    this.locating.set(true);
    this.formError.set(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.geo.set({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        this.locating.set(false);
      },
      () => {
        this.locating.set(false);
        this.formError.set('No se pudo obtener tu ubicación. Podés crear el cliente sin ella.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }

  submit(): void {
    const name = this.form.name.trim();
    if (!name) {
      this.formError.set('El nombre del negocio es obligatorio.');
      return;
    }
    this.saving.set(true);
    this.formError.set(null);
    const g = this.geo();
    this.api
      .createCustomer({
        name,
        phone: this.form.phone.trim() || undefined,
        whatsapp: this.form.whatsapp.trim() || undefined,
        rfc: this.form.rfc.trim() || undefined,
        notes: this.form.notes.trim() || undefined,
        latitude: g?.lat,
        longitude: g?.lng,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (c) => {
          this.saving.set(false);
          this.showForm.set(false);
          // Flujo natural de campo: alta → tomar pedido de inmediato.
          this.router.navigate(['/vendor/take-order', c.id]);
        },
        error: (e) => {
          this.saving.set(false);
          this.formError.set(
            e?.error?.message ||
              'No se pudo crear el cliente. Revisá los datos e intentá de nuevo.',
          );
        },
      });
  }

  initials(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
}
