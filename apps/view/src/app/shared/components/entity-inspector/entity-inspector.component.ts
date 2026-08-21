import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, model, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SidePeekComponent } from '../side-peek/side-peek.component';
import { EntityRefService, RefRelation, RefResult } from './entity-ref.service';
import { money } from '../../util';

/**
 * Inspector de registros — el panel que hace que TODO sea clickeable.
 *
 * Recibe un `ref` (`ent:…`, `adj:…`, `prov:…`) y muestra lo que el backend resuelva:
 * campos con su columna de origen y relaciones que a su vez son refs. Cada relación es
 * un botón: al abrirla se apila y aparece el "volver", así se puede recorrer la cadena
 * (recepción → proveedor → otra recepción → un renglón → el producto) sin perder el hilo
 * ni salir de la pantalla.
 *
 * Uso:
 *   <app-entity-inspector [(ref)]="inspect" />
 *   ...y en cualquier celda:  (click)="inspect.set(entityRef('prov', r.proveedor_code))"
 *
 * El ref vive en la URL (`?ref=`) para que un hallazgo se pueda pegar en un chat y el
 * otro abra exactamente el mismo registro. Se escribe con `merge` + `replaceUrl`, así que
 * convive con los filtros de la página sin ensuciar el historial.
 */
@Component({
  selector: 'app-entity-inspector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ButtonModule, SidePeekComponent],
  template: `
    <app-side-peek [open]="isOpen()" (openChange)="onOpenChange($event)" [aboveModals]="true"
                   [title]="data()?.title || 'Detalle'" [subtitle]="data()?.subtitle ?? null">
      <div class="ei">
        @if (depth() > 1) {
          <button type="button" class="ei-back" (click)="back()">
            <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver
            <span class="ei-back-trail">{{ trail() }}</span>
          </button>
        }

        @if (loading()) {
          <div class="ei-skel" aria-hidden="true">
            @for (i of [1,2,3,4,5,6]; track i) { <span class="ei-skel-row"></span> }
          </div>
        } @else if (error(); as e) {
          <div class="ei-err" role="alert">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span class="ei-err-txt">{{ e }}</span>
            <button pButton type="button" class="p-button-sm p-button-outlined" (click)="retry()" label="Reintentar"></button>
          </div>
        } @else if (data(); as d) {
          @if (d.badges.length) {
            <div class="ei-badges">
              @for (b of d.badges; track b.text) {
                <span class="ei-badge" [class]="'is-' + b.tone" [title]="b.title || ''">{{ b.text }}</span>
              }
            </div>
          }

          <dl class="ei-fields">
            @for (f of shownFields(); track f.label) {
              <div class="ei-f">
                <dt>{{ f.label }}</dt>
                <dd [class.mono]="f.kind === 'mono' || f.kind === 'money' || f.kind === 'qty' || f.kind === 'date'">{{ fmt(f.value, f.kind) }}</dd>
                @if (f.source) { <p class="ei-src">{{ f.source }}</p> }
              </div>
            }
          </dl>

          @for (g of groups(); track g.name) {
            <section class="ei-grp">
              <h3 class="ei-grp-h">{{ g.name }} <span class="ei-grp-n">{{ g.items.length }}</span></h3>
              <ul class="ei-rel">
                @for (r of g.items; track r.ref) {
                  <li>
                    <button type="button" class="ei-relbtn" [class.est]="r.heuristic" (click)="go(r.ref)"
                            [attr.aria-label]="'Abrir ' + r.label">
                      <span class="ei-rel-main">
                        <span class="ei-rel-label">{{ r.label }}</span>
                        @if (r.sub) { <span class="ei-rel-sub">{{ r.sub }}</span> }
                      </span>
                      @if (r.amount != null) { <span class="ei-rel-amt">{{ money(r.amount) }}</span> }
                      <i class="pi pi-angle-right" aria-hidden="true"></i>
                    </button>
                  </li>
                }
              </ul>
            </section>
          }

          @if (d.notes.length) {
            <div class="ei-notes">
              @for (nt of d.notes; track nt) { <p>{{ nt }}</p> }
            </div>
          }
        }
      </div>
    </app-side-peek>
  `,
  styles: [`
    :host { display:contents; }

    /* El apilado sobre los diálogos lo resuelve el propio side-peek con [aboveModals]:
       un override desde acá empataba en especificidad con su regla y ganaba uno u otro
       segun el orden del bundle. Es seguro pedirlo: adentro de este panel no hay ningun
       overlay de PrimeNG que necesite taparlo, solo botones. */

    .ei { display:flex; flex-direction:column; gap:1rem; padding:1rem 1.25rem 2rem; }

    .ei-back { align-self:flex-start; display:inline-flex; align-items:center; gap:.4rem; background:none; border:0;
      color:var(--action); cursor:pointer; font:inherit; font-size:.82rem; padding:0; }
    .ei-back:hover { text-decoration:underline; }
    .ei-back:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .ei-back-trail { color:var(--text-faint); text-decoration:none; }

    .ei-badges { display:flex; flex-wrap:wrap; gap:.35rem; }
    .ei-badge { font-size:.68rem; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
      padding:.14rem .45rem; border:1px solid var(--border-color); border-radius:var(--r-sm); color:var(--text-muted); }
    .ei-badge.is-ok { color:var(--ok-fg); border-color:var(--ok-fg); }
    .ei-badge.is-warn { color:var(--warn-fg); border-color:var(--warn-fg); }
    .ei-badge.is-danger { color:var(--bad-fg); border-color:var(--bad-fg); }
    .ei-badge.is-info { color:var(--action); border-color:var(--action); }

    .ei-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.7rem .9rem; margin:0; }
    .ei-f { min-width:0; display:flex; flex-direction:column; gap:.1rem; }
    .ei-f dt { font-size:.66rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); }
    .ei-f dd { margin:0; font-size:.86rem; color:var(--text-main); overflow-wrap:anywhere; }
    .ei-f dd.mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .ei-src { margin:0; font-size:.64rem; color:var(--text-faint); font-family:var(--font-mono); overflow-wrap:anywhere; }

    .ei-grp { display:flex; flex-direction:column; gap:.35rem; }
    .ei-grp-h { margin:0; font-size:.72rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .ei-grp-n { font-weight:400; color:var(--text-faint); margin-left:.25rem; }
    .ei-rel { list-style:none; margin:0; padding:0; display:flex; flex-direction:column;
      border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; }
    .ei-rel li + li .ei-relbtn { border-top:1px solid var(--border-color); }
    .ei-relbtn { width:100%; display:flex; align-items:center; gap:.6rem; text-align:left; background:none; border:0;
      padding:.5rem .65rem; cursor:pointer; color:var(--text-main); font:inherit; }
    .ei-relbtn:hover { background:var(--surface-ground); }
    .ei-relbtn:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    .ei-relbtn .pi-angle-right { color:var(--text-faint); flex-shrink:0; }
    .ei-rel-main { min-width:0; flex:1; display:flex; flex-direction:column; }
    .ei-rel-label { font-size:.84rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ei-rel-sub { font-size:.7rem; color:var(--text-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ei-rel-amt { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:.8rem; white-space:nowrap; }
    /* Vínculo estimado: se marca en el borde, no con color de alarma — es una pista, no un error. */
    .ei-relbtn.est { box-shadow:inset 3px 0 0 var(--warn-fg); }

    .ei-notes { border-top:1px solid var(--border-color); padding-top:.7rem; display:flex; flex-direction:column; gap:.4rem; }
    .ei-notes p { margin:0; font-size:.72rem; line-height:1.5; color:var(--text-faint); }

    .ei-err { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; border:1px solid var(--border-color);
      border-left:3px solid var(--bad-fg); border-radius:var(--r-md); }
    .ei-err .pi { color:var(--bad-fg); }
    .ei-err-txt { flex:1; font-size:.84rem; }

    .ei-skel { display:flex; flex-direction:column; gap:.5rem; }
    .ei-skel-row { height:1.4rem; border-radius:var(--r-sm); background:var(--surface-ground); }
    @media (prefers-reduced-motion:no-preference) {
      .ei-skel-row { animation:ei-pulse 1.3s ease-in-out infinite; }
      @keyframes ei-pulse { 0%,100% { opacity:.55; } 50% { opacity:1; } }
    }
  `],
})
export class EntityInspectorComponent {
  /** Ref abierto. `null` = cerrado. Two-way: el panel lo cambia al navegar o cerrar. */
  readonly ref = model<string | null>(null);
  /** Nombre del query param donde se refleja. `null` desactiva el sync con la URL. */
  readonly urlParam = input<string | null>('ref');

  private readonly svc = inject(EntityRefService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly data = signal<RefResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Pila de navegación: el último es el que se está viendo. */
  private readonly stack = signal<string[]>([]);
  readonly depth = computed(() => this.stack().length);
  readonly isOpen = computed(() => this.depth() > 0);
  readonly trail = computed(() => {
    const s = this.stack();
    return s.length > 1 ? this.kindLabel(s[s.length - 2]) : '';
  });

  /** Un campo vacío no aporta: se muestran solo los que tienen valor. */
  readonly shownFields = computed(() => (this.data()?.fields ?? []).filter((f) => f.value !== null && f.value !== '' && f.value !== undefined));

  readonly groups = computed(() => {
    const out: { name: string; items: RefRelation[] }[] = [];
    for (const r of this.data()?.relations ?? []) {
      const g = out.find((x) => x.name === r.group);
      if (g) g.items.push(r); else out.push({ name: r.group, items: [r] });
    }
    return out;
  });

  readonly money = money;

  constructor() {
    // Arranque desde la URL: permite pegar un enlace y caer en el mismo registro.
    const p = this.urlParam();
    const initial = p ? this.route.snapshot.queryParamMap.get(p) : null;
    if (initial) queueMicrotask(() => this.ref.set(initial));

    effect(() => {
      const r = this.ref();
      const st = untracked(this.stack);
      const top = st[st.length - 1] ?? null;
      if (r === top) return;
      if (!r) {
        this.stack.set([]); this.data.set(null); this.error.set(null); this.loading.set(false);
      } else {
        // Si ya estaba en la pila es un "volver": se corta ahí en vez de duplicar.
        const i = st.indexOf(r);
        this.stack.set(i >= 0 ? st.slice(0, i + 1) : [...st, r]);
        this.load(r);
      }
      this.syncUrl(r);
    });
  }

  private load(ref: string): void {
    this.loading.set(true); this.error.set(null);
    this.svc.resolve(ref).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        // Puede haber llegado tarde: si ya se navegó a otra cosa, se descarta.
        if (this.stack()[this.stack().length - 1] !== ref) return;
        this.data.set(d); this.loading.set(false);
      },
      error: (e) => {
        if (this.stack()[this.stack().length - 1] !== ref) return;
        this.data.set(null); this.loading.set(false);
        this.error.set(e?.error?.message || 'No se pudo abrir el registro.');
      },
    });
  }

  private syncUrl(ref: string | null): void {
    const p = this.urlParam();
    if (!p) return;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [p]: ref },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  go(ref: string): void { this.ref.set(ref); }

  back(): void {
    const s = this.stack();
    this.ref.set(s.length > 1 ? s[s.length - 2] : null);
  }

  retry(): void { const r = this.ref(); if (r) this.load(r); }

  onOpenChange(open: boolean): void { if (!open) this.ref.set(null); }

  fmt(v: string | number | null, kind?: string): string {
    if (v === null || v === undefined || v === '') return '—';
    if (kind === 'money') return money(Number(v));
    if (kind === 'pct') return `${(Number(v) * 100).toFixed(2)}%`;
    if (kind === 'qty') return Number(v).toLocaleString('es-MX');
    return String(v);
  }

  private kindLabel(ref: string): string {
    const k = ref.split(':')[0];
    return ({ ent: 'la entrada', lin: 'el renglón', adj: 'el ajuste', pay: 'el pago', prov: 'el proveedor', sku: 'el producto' } as Record<string, string>)[k] ?? '';
  }
}
