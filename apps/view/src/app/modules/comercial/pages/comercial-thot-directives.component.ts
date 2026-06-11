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
          <thead><tr><th>Target</th><th>Razón</th><th>Boost</th><th>Patrocinador</th><th>Vigencia</th><th></th></tr></thead>
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
    .wrap { max-width: 980px; margin: 0 auto; padding: 1.25rem; }
    .head h1 { font-size: 1.4rem; font-weight: 800; margin: 0; }
    .head .thot { color: var(--action); font-weight: 700; }
    .head p { color: var(--text-muted); font-size: 0.85rem; margin: 0.25rem 0 1rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px); padding: 1rem 1.1rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; font-weight: 700; margin: 0 0 0.75rem; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem 1rem; }
    label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; font-weight: 600; color: var(--text-muted); position: relative; }
    input, select { height: 2.5rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: 0 0.6rem; font-family: var(--font-body); font-size: 0.9rem; background: var(--surface-ground); color: var(--text-main); }
    label small { font-weight: 400; color: var(--text-faint); }
    .dates { display: flex; align-items: center; gap: 0.4rem; }
    .opts { position: absolute; top: 100%; left: 0; right: 0; z-index: 5; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md,10px); max-height: 220px; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    .opt { display: flex; justify-content: space-between; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--border-color); padding: 0.5rem 0.6rem; font-size: 0.85rem; color: var(--text-main); cursor: pointer; }
    .opt small { color: var(--text-faint); }
    .picked { display: inline-flex; align-items: center; gap: 0.4rem; background: var(--ember-soft); border: 1px solid var(--ember-border); border-radius: var(--r-pill,999px); padding: 0.3rem 0.7rem; font-weight: 700; color: var(--brand-900); font-size: 0.85rem; }
    .picked button { background: none; border: none; color: var(--text-muted); cursor: pointer; height: auto; padding: 0; }
    .primary { margin-top: 0.9rem; height: 2.7rem; padding: 0 1.2rem; border: none; border-radius: var(--r-md,10px); background: var(--action); color: #fff; font-weight: 700; cursor: pointer; }
    .primary:disabled { opacity: 0.5; }
    .err { margin-left: 0.75rem; color: var(--bad-fg); font-size: 0.8rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border-color); }
    td { padding: 0.55rem 0.5rem; border-bottom: 1px solid var(--border-color); color: var(--text-main); }
    td.num, td.dt { font-family: var(--font-mono); }
    tr.off { opacity: 0.5; }
    .kind { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill,999px); padding: 0.05rem 0.4rem; color: var(--text-muted); }
    .actions { display: flex; gap: 0.4rem; }
    .actions button { background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-sm,8px); padding: 0.3rem 0.6rem; font-size: 0.76rem; font-weight: 600; cursor: pointer; color: var(--text-main); }
    .actions .del { color: var(--bad-fg); }
    .empty { color: var(--text-muted); padding: 1rem 0; }
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
