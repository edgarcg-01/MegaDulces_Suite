import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subject, debounceTime, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { environment } from '../../../../environments/environment';

interface Directive {
  id: string;
  directive_type: string;
  target_kind: string;
  target_name: string;
  boost: number;
  reason: string;
  sponsor: string | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
}
interface BrandOpt { id: string; nombre: string; products: number; }

/**
 * Thot T.2 — Empuje dirigido. El negocio define QUÉ empujar (marca foco) y Thot
 * lo amplifica en el take-order. Gateado por COMMERCIAL_PROMOTIONS_GESTIONAR.
 */
@Component({
  selector: 'app-comercial-thot-directives',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="wrap">
      <header class="head">
        <div>
          <h1>Empuje dirigido <span class="thot">· Thot</span></h1>
          <p>Definí qué empujar (marca del mes, lanzamiento, liquidación). El motor lo sube en "Para impulsar" del vendedor.</p>
        </div>
      </header>

      <!-- Alta -->
      <section class="card form">
        <h2>Nueva directriz</h2>
        <div class="grid">
          <label>Tipo
            <select [(ngModel)]="dType">
              <option value="focus_brand">Marca foco</option>
            </select>
          </label>
          <label>Marca
            <input type="search" placeholder="Buscar marca…" [(ngModel)]="brandTerm" (ngModelChange)="brandTerm$.next($event)" />
            <div class="opts" *ngIf="brands().length && !selectedBrand()">
              <button class="opt" *ngFor="let b of brands()" (click)="pickBrand(b)">{{ b.nombre }} <small>{{ b.products }} prod.</small></button>
            </div>
            <div class="picked" *ngIf="selectedBrand() as b">{{ b.nombre }} <button (click)="selectedBrand.set(null)">✕</button></div>
          </label>
          <label>Razón (la ve el vendedor)
            <input type="text" maxlength="80" [(ngModel)]="reason" placeholder="Marca del mes" />
          </label>
          <label>Empuje (boost)
            <input type="number" min="0" max="5" step="0.25" [(ngModel)]="boost" />
            <small>0.5 moderado · 1 fuerte · 2 dominante</small>
          </label>
          <label>Patrocinador (opcional)
            <input type="text" maxlength="80" [(ngModel)]="sponsor" placeholder="Quién financia el empuje" />
          </label>
          <label>Vigencia
            <span class="dates"><input type="date" [(ngModel)]="validFrom" /> → <input type="date" [(ngModel)]="validTo" /></span>
          </label>
        </div>
        <button class="primary" [disabled]="!canCreate() || creating()" (click)="create()">
          {{ creating() ? 'Creando…' : 'Crear directriz' }}
        </button>
        <span class="err" *ngIf="error()">{{ error() }}</span>
      </section>

      <!-- Listado -->
      <section class="card">
        <h2>Directrices activas</h2>
        <div class="empty" *ngIf="!loading() && directives().length === 0">Sin directrices. Creá una arriba para empezar a empujar.</div>
        <table *ngIf="directives().length">
          <thead><tr><th scope="col">Target</th><th scope="col">Razón</th><th scope="col" class="num">Boost</th><th scope="col">Patrocinador</th><th scope="col">Vigencia</th><th scope="col"><span class="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            <tr *ngFor="let d of directives()" [class.off]="!d.active">
              <td><span class="kind">{{ kindLabel(d.target_kind) }}</span> {{ d.target_name || '—' }}</td>
              <td>{{ d.reason }}</td>
              <td class="num">{{ d.boost }}</td>
              <td>{{ d.sponsor || '—' }}</td>
              <td class="dt">{{ d.valid_from || '∞' }} → {{ d.valid_to || '∞' }}</td>
              <td class="actions">
                <button (click)="toggle(d)">{{ d.active ? 'Pausar' : 'Activar' }}</button>
                <button class="del" (click)="remove(d)">Eliminar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  `,
  styles: [`
    .wrap { max-width: 980px; margin: 0 auto; padding: var(--sp-5); }
    .head h1 { font-size: 1.4rem; font-weight: 800; margin: 0; }
    .head .thot { color: var(--action); font-weight: 700; }
    .head p { color: var(--text-muted); font-size: 0.85rem; margin: var(--sp-1) 0 var(--sp-4); }
    .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-4); margin-bottom: var(--sp-4); }
    .card h2 { font-size: 1rem; font-weight: 700; margin: 0 0 var(--sp-3); }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-3) var(--sp-4); }
    label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: 0.78rem; font-weight: 600; color: var(--text-muted); position: relative; }
    input, select { height: var(--row-h-md); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 0 var(--sp-2); font-family: var(--font-body); font-size: 0.9rem; background: var(--surface-ground); color: var(--text-main); }
    input:focus-visible, select:focus-visible { outline: none; border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    label small { font-weight: 400; color: var(--text-faint); }
    .dates { display: flex; align-items: center; gap: var(--sp-2); }
    .opts { position: absolute; top: 100%; left: 0; right: 0; z-index: 5; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); max-height: 220px; overflow-y: auto; box-shadow: var(--shadow-hover); }
    .opt { display: flex; justify-content: space-between; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--border-color); padding: var(--sp-2); font-size: 0.85rem; color: var(--text-main); cursor: pointer; }
    .opt:hover { background: var(--surface-hover-bg); }
    .opt small { color: var(--text-faint); }
    .picked { display: inline-flex; align-items: center; gap: var(--sp-2); background: var(--ember-soft); border: 1px solid var(--ember-border); border-radius: var(--r-pill); padding: var(--sp-1) var(--sp-3); font-weight: 700; color: var(--brand-900); font-size: 0.85rem; }
    .picked button { background: none; border: none; color: var(--text-muted); cursor: pointer; height: auto; padding: 0; }
    .primary { margin-top: var(--sp-4); height: 2.7rem; padding: 0 var(--sp-5); border: none; border-radius: var(--r-md); background: var(--action); color: var(--action-ink); font-weight: 700; cursor: pointer; }
    .primary:hover:not(:disabled) { background: var(--action-hover); }
    .primary:disabled { opacity: 0.5; }
    .err { margin-left: var(--sp-3); color: var(--bad-fg); font-size: 0.8rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border-color); }
    td { padding: var(--sp-2); border-bottom: 1px solid var(--border-color); color: var(--text-main); }
    td.num, td.dt { font-family: var(--font-mono); }
    td.dt { text-align: left; }
    tr.off { opacity: 0.5; }
    .kind { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill); padding: 0.05rem var(--sp-1); color: var(--text-muted); }
    .actions { display: flex; gap: var(--sp-2); }
    .actions button { background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: var(--sp-1) var(--sp-2); font-size: 0.76rem; font-weight: 600; cursor: pointer; color: var(--text-main); }
    .actions button:hover { background: var(--surface-hover-bg); }
    .actions .del { color: var(--bad-fg); }
    .empty { color: var(--text-muted); padding: var(--sp-4) 0; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialThotDirectivesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = environment.apiUrl + '/commercial/intelligence/directives';

  readonly directives = signal<Directive[]>([]);
  readonly brands = signal<BrandOpt[]>([]);
  readonly selectedBrand = signal<BrandOpt | null>(null);
  readonly loading = signal(true);
  readonly creating = signal(false);
  readonly error = signal('');

  dType = 'focus_brand';
  brandTerm = '';
  reason = 'Marca del mes';
  boost = 1;
  sponsor = '';
  validFrom = '';
  validTo = '';

  readonly brandTerm$ = new Subject<string>();

  ngOnInit(): void {
    this.reload();
    this.brandTerm$
      .pipe(
        debounceTime(250),
        switchMap((t) => this.http.get<BrandOpt[]>(`${this.base}/brands`, { params: new HttpParams().set('search', t || '') })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({ next: (b) => this.brands.set(b), error: () => this.brands.set([]) });
  }

  private reload(): void {
    this.loading.set(true);
    this.http.get<Directive[]>(this.base).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.directives.set(d); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  pickBrand(b: BrandOpt): void { this.selectedBrand.set(b); this.brands.set([]); this.brandTerm = b.nombre; }
  canCreate(): boolean { return !!this.selectedBrand() && !!this.reason.trim(); }
  kindLabel(k: string): string { return k === 'brand' ? 'Marca' : k === 'product' ? 'Producto' : 'Categoría'; }

  create(): void {
    const b = this.selectedBrand();
    if (!b) return;
    this.creating.set(true); this.error.set('');
    this.http.post(this.base, {
      directive_type: this.dType,
      target_id: b.id,
      reason: this.reason.trim(),
      boost: Number(this.boost),
      sponsor: this.sponsor.trim() || undefined,
      valid_from: this.validFrom || undefined,
      valid_to: this.validTo || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.creating.set(false);
        this.selectedBrand.set(null); this.brandTerm = ''; this.sponsor = ''; this.validFrom = ''; this.validTo = '';
        this.reload();
      },
      error: (e) => { this.creating.set(false); this.error.set(e?.error?.message || 'No se pudo crear'); },
    });
  }

  toggle(d: Directive): void {
    this.http.patch(`${this.base}/${d.id}`, { active: !d.active }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.reload() });
  }
  remove(d: Directive): void {
    if (!confirm(`¿Eliminar la directriz "${d.reason}" (${d.target_name})?`)) return;
    this.http.delete(`${this.base}/${d.id}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.reload() });
  }
}
