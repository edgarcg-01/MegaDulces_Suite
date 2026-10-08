import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { coincideBusqueda } from '@megadulces/ui-web';
import type { PresaleFieldResponse, PresaleOrderRow, PresaleStage } from '@megadulces/contracts';
import { PresaleLoadService } from './presale-load.service';

const ETAPA: Partial<Record<PresaleStage, string>> = {
  por_surtir: 'Por surtir',
  en_surtido: 'En surtido',
  en_caja: 'En caja',
  cobrado: 'Cobrado',
};

const money = (n: number | null | undefined): string =>
  '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dm = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [, m, d] = v.slice(0, 10).split('-');
  return d + '/' + m;
};

/**
 * `[MCP.5]` Llevar pedidos (Fase MCP, ADR-089): el repartidor o el vendedor elige en su celular los
 * pedidos de preventa que se lleva. Quedan en su guía de carga de hoy (una por ruta), y la cajera la
 * imprime para que la firme (D8).
 *
 * Pescar NO entrega ni cobra: sólo dice quién se lleva qué. La entrega se registra en MCP.6.
 */
@Component({
  selector: 'app-presale-load',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="pl">
      <div class="pl-head">
        <div>
          <h1>Llevar pedidos</h1>
          <p class="sub">Elige los pedidos que te llevas. Quedan en tu guía de hoy y la caja la imprime para que la firmes.</p>
        </div>
        <button type="button" class="pl-refresh" [class.spinning]="loading()" [disabled]="loading()" (click)="reload()" aria-label="Actualizar"><i class="pi pi-refresh" aria-hidden="true"></i></button>
      </div>

      @if (err(); as e) { <div class="pl-msg bad" role="alert">{{ e }}</div> }
      @if (msg(); as m) { <div class="pl-msg" [class.bad]="m.mal" role="status">{{ m.texto }}</div> }

      @if (loading() && !data()) {
        <div class="pl-skel" aria-busy="true"><div></div><div></div><div></div></div>
      } @else if (data(); as d) {
        @if (d.mine.length) {
          <h2 class="pl-h2">Mis guías de hoy</h2>
          @for (g of d.mine; track g.id) {
            <section class="pl-guia" [class.impresa]="g.status === 'impresa'">
              <div class="pl-guia-h">
                <div><b class="mono">{{ g.folio }}</b><span class="muted"> · {{ g.sales_route }} · {{ g.branch }}</span></div>
                <span class="pl-tag" [class.ok]="g.status === 'impresa'">{{ g.status === 'impresa' ? 'Impresa' : 'Por imprimir' }}</span>
              </div>
              @for (o of g.orders; track o.order_id) {
                <div class="pl-guia-o">
                  <div class="pl-o-main"><span class="mono">{{ o.code }}</span> <span class="pl-o-cli">{{ o.customer_name || '—' }}</span></div>
                  <span class="num">{{ money(o.document_total ?? o.total) }}</span>
                  @if (g.status === 'abierta') {
                    <button type="button" class="pl-quitar" [disabled]="!!ocupado()" (click)="quitar(o.order_id)" [attr.aria-label]="'Quitar ' + o.code">Quitar</button>
                  }
                </div>
              }
              <div class="pl-guia-f">
                <span>{{ g.orders.length }} {{ g.orders.length === 1 ? 'pedido' : 'pedidos' }} · <b class="num">{{ money(g.total) }}</b></span>
                <span class="muted">{{ g.status === 'impresa' ? 'Ya la firmaste en caja.' : 'Pide en caja que la impriman para firmarla.' }}</span>
              </div>
            </section>
          }
        }

        <h2 class="pl-h2">Para llevar</h2>
        <p class="pl-src muted">{{ d.source === 'propios' ? 'Pedidos que tú levantaste.' : 'Pedidos de las sucursales que te tocan.' }}</p>
        @if (d.available.length > 6) {
          <input class="pl-q" type="search" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Buscar cliente, folio o ruta" aria-label="Buscar cliente, folio o ruta" />
        }
        @if (!visibles().length) {
          <div class="pl-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>{{ d.available.length ? 'Ningún pedido con esa búsqueda.' : 'No hay pedidos de preventa para llevar.' }}</span></div>
        }
        @for (grupo of grupos(); track grupo.ruta) {
          <div class="pl-ruta">{{ grupo.ruta }} <span class="muted">· {{ grupo.pedidos.length }}</span></div>
          @for (p of grupo.pedidos; track p.id) {
            <label class="pl-card" [class.on]="sel().has(p.id)">
              <input type="checkbox" [checked]="sel().has(p.id)" (change)="toggle(p.id)" [attr.aria-label]="'Llevar ' + p.code" />
              <div class="pl-card-b">
                <div class="pl-card-t"><span class="pl-o-cli">{{ p.customer_name || '—' }}</span><b class="num">{{ money(p.link?.total ?? p.total) }}</b></div>
                <div class="pl-card-s">
                  <span class="mono">{{ p.code }}</span>
                  <span [class.bad]="p.due === 'vencido'">entrega {{ dm(p.requested_delivery_date) }}{{ p.due === 'vencido' ? ' · vencido' : p.due === 'hoy' ? ' · hoy' : '' }}</span>
                  @if (etapa(p.stage); as e) { <span class="pl-chip">{{ e }}</span> }
                  @if (p.link) { <span class="pl-chip ok">Doc. {{ p.link.folio_digital }}</span> }
                </div>
              </div>
            </label>
          }
        }
      }

      @if (sel().size) {
        <div class="pl-bar">
          <button type="button" class="pl-go" [disabled]="!!ocupado()" (click)="llevar()">
            {{ ocupado() === 'cargar' ? 'Cargando…' : 'Llevar ' + sel().size + (sel().size === 1 ? ' pedido' : ' pedidos') + ' · ' + money(totalSel()) }}
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .pl { padding:.9rem 1rem 7rem; max-width:720px; margin:0 auto; }
    .pl-head { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; }
    .pl-head h1 { margin:0; font-size:var(--fs-h2); font-weight:700; }
    .sub { margin:.2rem 0 0; font-size:var(--fs-sm); color:var(--text-muted); }
    .pl-refresh { width:2.5rem; height:2.5rem; border-radius:999px; border:1px solid var(--border-color); background:var(--card-bg); color:var(--text-main); flex:none; }
    .pl-refresh.spinning i { animation:pl-spin .9s linear infinite; }
    @keyframes pl-spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .pl-refresh.spinning i { animation:none; } }
    .pl-h2 { font-size:var(--fs-h3); font-weight:700; margin:1.1rem 0 .45rem; }
    .pl-src { font-size:var(--fs-xs); margin:-.25rem 0 .5rem; }
    .pl-msg { margin:.6rem 0; padding:.6rem .75rem; border-radius:10px; background:var(--card-bg); border:1px solid var(--border-color); font-size:var(--fs-sm); }
    .pl-msg.bad, .bad { color:var(--bad-fg); }
    .pl-msg.bad { border-left:3px solid var(--bad-fg); }
    .pl-guia { border:1px solid var(--border-color); border-left:3px solid var(--warn-fg); border-radius:12px; background:var(--card-bg); padding:.6rem .75rem; margin-bottom:.6rem; }
    .pl-guia.impresa { border-left-color:var(--ok-fg); }
    .pl-guia-h { display:flex; justify-content:space-between; align-items:center; gap:.5rem; font-size:var(--fs-body); }
    .pl-tag { font-size:var(--fs-micro); font-weight:700; padding:.15rem .5rem; border-radius:999px; background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .pl-tag.ok { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .pl-guia-o { display:flex; align-items:center; gap:.5rem; padding:.4rem 0; border-bottom:1px dashed var(--border-color); font-size:var(--fs-sm); }
    .pl-o-main { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pl-o-cli { font-weight:600; }
    .pl-quitar { border:1px solid var(--border-color); background:transparent; color:var(--text-main); border-radius:8px; padding:.35rem .6rem; font-size:var(--fs-xs); min-height:2.25rem; }
    .pl-guia-f { display:flex; justify-content:space-between; gap:.5rem; flex-wrap:wrap; font-size:var(--fs-xs); padding-top:.45rem; }
    .pl-q { width:100%; height:2.75rem; border:1px solid var(--border-color); border-radius:10px; padding:0 .75rem; background:var(--card-bg); color:var(--text-main); font-size:var(--fs-body); margin-bottom:.5rem; }
    .pl-ruta { font-size:var(--fs-xs); font-weight:700; text-transform:uppercase; letter-spacing:.04em; margin:.8rem 0 .35rem; }
    .pl-card { display:flex; gap:.65rem; align-items:flex-start; border:1px solid var(--border-color); border-radius:12px; background:var(--card-bg); padding:.7rem .75rem; margin-bottom:.45rem; cursor:pointer; }
    .pl-card.on { border-color:var(--action); box-shadow:0 0 0 1px var(--action); }
    .pl-card input { width:1.3rem; height:1.3rem; margin-top:.1rem; accent-color:var(--action); flex:none; }
    .pl-card-b { flex:1; min-width:0; display:flex; flex-direction:column; gap:.25rem; }
    .pl-card-t { display:flex; justify-content:space-between; gap:.5rem; font-size:var(--fs-body); }
    .pl-card-t .pl-o-cli { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pl-card-s { display:flex; flex-wrap:wrap; gap:.25rem .6rem; font-size:var(--fs-xs); color:var(--text-muted); align-items:center; }
    .pl-chip { padding:.05rem .45rem; border-radius:999px; background:var(--hover-bg); color:var(--text-main); }
    .pl-chip.ok { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .pl-empty { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:1.5rem; color:var(--text-muted); text-align:center; font-size:var(--fs-body); }
    .pl-skel { display:flex; flex-direction:column; gap:.5rem; margin-top:1rem; }
    .pl-skel div { height:4.5rem; border-radius:12px; background:var(--hover-bg); }
    .pl-bar { position:fixed; left:0; right:0; bottom:calc(3.6rem + env(safe-area-inset-bottom)); padding:.6rem 1rem; background:linear-gradient(transparent, var(--layout-bg) 30%); }
    .pl-go { width:100%; max-width:720px; display:block; margin:0 auto; min-height:3rem; border:0; border-radius:12px; background:var(--action); color:var(--action-ink); font-weight:700; font-size:var(--fs-h3); }
    .pl-go:disabled { opacity:.6; }
    .pl-card:focus-within, .pl-go:focus-visible, .pl-quitar:focus-visible, .pl-refresh:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
  `],
})
export class PresaleLoadComponent implements OnInit {
  private readonly api = inject(PresaleLoadService);
  private readonly destroyRef = inject(DestroyRef);
  private sub: Subscription | null = null;

  readonly money = money;
  readonly dm = dm;

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly msg = signal<{ texto: string; mal: boolean } | null>(null);
  readonly data = signal<PresaleFieldResponse | null>(null);
  readonly sel = signal<Set<string>>(new Set());
  readonly q = signal('');
  readonly ocupado = signal<'cargar' | 'quitar' | null>(null);

  readonly visibles = computed<PresaleOrderRow[]>(() =>
    (this.data()?.available ?? []).filter((p) =>
      coincideBusqueda(this.q(), p.customer_name, p.code, p.sales_route, p.customer_erp_code)),
  );
  readonly grupos = computed(() => {
    const m = new Map<string, PresaleOrderRow[]>();
    for (const p of this.visibles()) {
      const k = p.sales_route || 'Sin ruta';
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ruta, pedidos]) => ({ ruta, pedidos }));
  });
  readonly totalSel = computed(() =>
    (this.data()?.available ?? []).filter((p) => this.sel().has(p.id)).reduce((t, p) => t + (p.link?.total ?? p.total), 0),
  );

  ngOnInit(): void {
    this.reload();
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.sub?.unsubscribe();
    this.sub = this.api.campo().subscribe({
      next: (d) => this.aplicar(d),
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        this.err.set(e?.status === 0 ? 'Sin conexión: revisa tu señal y actualiza.' : e?.status === 403 ? 'Tu usuario no tiene permiso para llevar pedidos.' : 'No se pudieron cargar los pedidos. Actualiza en un momento.');
      },
    });
  }

  toggle(id: string): void {
    const s = new Set(this.sel());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.sel.set(s);
  }

  llevar(): void {
    const ids = [...this.sel()];
    if (!ids.length) return;
    this.ocupado.set('cargar');
    this.msg.set(null);
    this.api.cargar(ids).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.ocupado.set(null);
        this.aplicar(d);
        this.msg.set({ texto: ids.length + (ids.length === 1 ? ' pedido quedó' : ' pedidos quedaron') + ' en tu guía. Pide en caja que la impriman.', mal: false });
      },
      error: (e: HttpErrorResponse) => { this.ocupado.set(null); this.msg.set({ texto: this.errorTexto(e, 'No se pudieron cargar los pedidos.'), mal: true }); this.reload(); },
    });
  }

  quitar(orderId: string): void {
    this.ocupado.set('quitar');
    this.msg.set(null);
    this.api.quitar(orderId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.ocupado.set(null); this.aplicar(d); },
      error: (e: HttpErrorResponse) => { this.ocupado.set(null); this.msg.set({ texto: this.errorTexto(e, 'No se pudo quitar el pedido.'), mal: true }); this.reload(); },
    });
  }

  etapa(s: PresaleStage): string | null { return ETAPA[s] ?? null; }

  private aplicar(d: PresaleFieldResponse): void {
    this.data.set(d);
    this.loading.set(false);
    // La selección sólo conserva lo que sigue disponible.
    const libres = new Set(d.available.map((p) => p.id));
    this.sel.set(new Set([...this.sel()].filter((id) => libres.has(id))));
  }

  private errorTexto(e: HttpErrorResponse, defecto: string): string {
    const m = (e?.error as { message?: string | string[] } | null)?.message;
    return Array.isArray(m) ? m.join(' ') : m || defecto;
  }

}
