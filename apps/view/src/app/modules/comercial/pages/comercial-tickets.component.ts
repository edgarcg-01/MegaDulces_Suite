import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { TicketsService, TicketCandidato } from '../tickets.service';
import { imprimirTicketVenta, TicketVenta } from '../ticket-venta';

/**
 * Fase TK.2 — Tickets de venta. Buscar un folio y reimprimirlo.
 *
 * Superficie **Operations** (`DESIGN.md`): sin Fraunces, sin ilustraciones, densidad compacta,
 * master-detail. Se busca arriba, los candidatos a la izquierda y el documento a la derecha.
 *
 * ⚠️ **Los candidatos NO se resuelven solos, ni siquiera cuando hay uno.** Bueno: cuando hay
 * exactamente uno sí se abre, porque ahí no hay ambigüedad que resolver. Con dos o más, elige
 * la persona — el folio no identifica un documento (cada sucursal y cada caja tienen su propio
 * contador; medido: `0018665` existe 7 veces) y "el primero de la lista" sería el dinero de
 * otra tienda.
 */
@Component({
  selector: 'app-comercial-tickets',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Tickets de venta</h1>
          <p class="surf-page-sub">Busca cualquier folio y reimprímelo con el descuento desglosado</p>
        </div>
      </header>

      <form class="tk-search" (ngSubmit)="buscar()">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input name="q" type="search" autocomplete="off" [(ngModel)]="termino" #campo
               placeholder="Folio del ticket — 18665, 0018665, 03UD1001-0018665 o PD-2026-00012"
               aria-label="Folio a buscar" />
        <button pButton type="submit" [loading]="buscando()" [disabled]="!termino.trim()">Buscar</button>
      </form>
      <p class="tk-hint">
        Busca en los tres canales a la vez: mostrador, telemarketing y crédito, y pedidos de la plataforma.
      </p>

      @if (buscado() && !candidatos().length && !buscando()) {
        <div class="comm-empty">
          <div class="comm-empty-icon"><i class="pi pi-receipt" aria-hidden="true"></i></div>
          <h3>Ningún documento con ese folio</h3>
          <p>Revisa el número. Si el ticket es de una sucursal que no alcanzas, no aparece acá.</p>
        </div>
      }

      @if (candidatos().length) {
        <div class="tk-split">
          <aside class="tk-lista">
            <div class="tk-lista-head">
              <span>{{ candidatos().length }} coincidencia{{ candidatos().length === 1 ? '' : 's' }}</span>
              @if (truncado()) { <span class="tk-trunc">hay más — afina el folio</span> }
            </div>
            @if (candidatos().length > 1) {
              <p class="tk-aviso">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                El mismo folio existe en varias cajas o sucursales. Elige el correcto por fecha e importe.
              </p>
            }
            <ul class="tk-cands">
              @for (c of candidatos(); track c.id) {
                <li>
                  <button type="button" class="tk-cand" [class.sel]="c.id === seleccionado()"
                          (click)="abrir(c)">
                    <span class="tk-cand-top">
                      <p-tag [value]="c.origen_label" [severity]="sev(c.origen)"></p-tag>
                      <b class="tk-mono">{{ c.total | currency:'MXN':'symbol-narrow' }}</b>
                    </span>
                    <span class="tk-cand-mid">{{ c.sucursal_nombre || c.sucursal || 'sin sucursal' }}
                      @if (c.caja != null) { <i>· caja {{ c.caja }}</i> }
                    </span>
                    <span class="tk-cand-bot">
                      <span class="tk-mono">{{ c.folio }}</span>
                      <span>{{ c.fecha ? (c.fecha + 'T12:00:00' | date:'dd/MM/yy') : 'sin fecha' }}</span>
                    </span>
                    <span class="tk-cand-cli">{{ c.cliente_nombre || 'Público en general' }}</span>
                  </button>
                </li>
              }
            </ul>
          </aside>

          <section class="tk-doc">
            @if (cargando()) { <div class="tk-cargando">Cargando documento…</div> }
            @else if (doc(); as d) {
              <div class="tk-doc-head">
                <div>
                  <div class="tk-doc-sub">{{ d.doc_label || d.origen_label }}</div>
                  <h2 class="tk-mono">{{ d.id }}</h2>
                </div>
                <div class="tk-acciones">
                  <button pButton size="small" (click)="imprimir(d)">
                    <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span>Ticket
                  </button>
                  <button pButton size="small" [text]="true" severity="secondary"
                          [loading]="generandoPdf()" (click)="carta(d)">
                    <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>Carta (PDF)
                  </button>
                </div>
              </div>

              @if (d.aviso) { <div class="tk-warn">{{ d.aviso }}</div> }

              <dl class="tk-meta">
                <div><dt>Sucursal</dt><dd>{{ d.sucursal_nombre || d.sucursal || '—' }}</dd></div>
                @if (d.caja != null) { <div><dt>Caja</dt><dd>{{ d.caja }}</dd></div> }
                <div><dt>Fecha</dt><dd>{{ d.fecha ? (d.fecha + 'T12:00:00' | date:'dd/MM/yyyy') : '—' }}</dd></div>
                <div><dt>Cliente</dt><dd>{{ d.cliente_nombre || 'Público en general' }}</dd></div>
                @if (d.atendio) { <div><dt>{{ d.atendio_rol || 'Atendió' }}</dt><dd>{{ d.atendio }}</dd></div> }
              </dl>
              <!-- Se declara por qué no hay hora, en vez de dejar el hueco mudo o inventarla. -->
              @if (d.hora_motivo) { <p class="tk-nota">{{ d.hora_motivo }}</p> }

              <p-table [value]="d.lineas" styleClass="p-datatable-sm surf-table" [scrollable]="true">
                <ng-template #header>
                  <tr>
                    <th scope="col">Producto</th>
                    <th scope="col" class="tk-num">Cant.</th>
                    @if (hayLista()) { <th scope="col" class="tk-num">Lista</th> }
                    <th scope="col" class="tk-num">{{ hayLista() ? 'Pagado' : 'Precio' }}</th>
                    @if (hayDescuento()) { <th scope="col" class="tk-num">Descuento</th> }
                    <th scope="col" class="tk-num">Importe</th>
                  </tr>
                </ng-template>
                <ng-template #body let-l>
                  <tr>
                    <td>
                      <div class="tk-prod">{{ l.descripcion || l.sku }}</div>
                      <div class="tk-sku">{{ l.sku }}@if (l.equivalencia) { <span> · equivale a {{ l.equivalencia }}</span> }</div>
                    </td>
                    <td class="tk-num">{{ l.cantidad }} <i class="tk-uni">{{ l.unidad }}</i></td>
                    @if (hayLista()) {
                      <td class="tk-num" [class.tk-tachado]="l.descuento_linea > 0">
                        {{ l.lista_conocida ? (l.precio_lista | currency:'MXN':'symbol-narrow') : '—' }}
                      </td>
                    }
                    <td class="tk-num tk-fuerte">{{ l.precio_pagado | currency:'MXN':'symbol-narrow' }}</td>
                    @if (hayDescuento()) {
                      <td class="tk-num tk-ahorro">{{ l.descuento_linea > 0 ? ('-' + (l.descuento_linea | currency:'MXN':'symbol-narrow')) : '' }}</td>
                    }
                    <td class="tk-num tk-fuerte">{{ l.importe | currency:'MXN':'symbol-narrow' }}</td>
                  </tr>
                </ng-template>
              </p-table>

              <div class="tk-cierre">
                <table class="tk-res">
                  <tbody>
                    @if (hayQueRestar()) {
                      <tr><td>Precio de lista</td><td class="tk-num">{{ d.cascada.importe_lista | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    @if (d.cascada.descuento_precio > 0) {
                      <tr class="tk-desc"><td>Descuento en precio</td><td class="tk-num">-{{ d.cascada.descuento_precio | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    @if (d.cascada.descuento_documento > 0) {
                      <tr class="tk-desc"><td>Descuento del documento
                        @if (d.cascada.descuento_documento_pct_erp) { <i>({{ d.cascada.descuento_documento_pct_erp }}% en el ERP)</i> }
                      </td><td class="tk-num">-{{ d.cascada.descuento_documento | currency:'MXN':'symbol-narrow' }}</td></tr>
                    } @else if (d.cascada.descuento_documento < 0) {
                      <tr><td>Ajuste de redondeo</td><td class="tk-num">{{ -d.cascada.descuento_documento | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    @if (!d.impuestos_incluidos && d.cascada.iva) {
                      <tr><td>IVA</td><td class="tk-num">{{ d.cascada.iva | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    <tr class="tk-total"><td>Total pagado</td><td class="tk-num">{{ d.cascada.total | currency:'MXN':'symbol-narrow' }}</td></tr>
                  </tbody>
                </table>
                @if (d.cascada.descuento_total > 0) {
                  <div class="tk-ahorraste">
                    <i>El cliente ahorró</i>
                    {{ d.cascada.descuento_total | currency:'MXN':'symbol-narrow' }} ({{ d.cascada.descuento_total_pct }}%)
                  </div>
                }
              </div>
            } @else {
              <div class="tk-vacio"><i class="pi pi-arrow-left" aria-hidden="true"></i> Elige un documento de la lista</div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [`
    .tk-search { display:flex; align-items:center; gap:.5rem; position:relative; margin-top:.75rem }
    .tk-search i { position:absolute; left:.7rem; color:var(--text-muted,#78716c); pointer-events:none }
    .tk-search input { flex:1 1 auto; padding:.55rem .75rem .55rem 2.1rem; border:1px solid var(--surface-border,#e7e5e4);
      border-radius:var(--radius-md,6px); background:var(--surface-card,#fff); color:inherit; font-size:.95rem }
    .tk-search input:focus-visible { outline:2px solid var(--action,#c2410c); outline-offset:1px }
    .tk-hint { margin:.35rem 0 0; font-size:.78rem; color:var(--text-muted,#78716c) }
    .tk-split { display:grid; grid-template-columns:minmax(230px,300px) 1fr; gap:1rem; margin-top:1rem; align-items:start }
    @media (max-width:900px) { .tk-split { grid-template-columns:1fr } }
    .tk-lista-head { display:flex; justify-content:space-between; gap:.5rem; font-size:.78rem;
      color:var(--text-muted,#78716c); font-weight:600; margin-bottom:.35rem }
    .tk-trunc { color:var(--action,#c2410c) }
    .tk-aviso { display:flex; gap:.4rem; font-size:.75rem; line-height:1.3; margin:0 0 .5rem;
      padding:.4rem .55rem; border:1px solid #d6b45a; background:#fdf6e3; color:#5c4803; border-radius:var(--radius-sm,4px) }
    .tk-cands { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.35rem }
    .tk-cand { width:100%; display:flex; flex-direction:column; gap:.15rem; text-align:left; cursor:pointer;
      padding:.5rem .6rem; border:1px solid var(--surface-border,#e7e5e4); border-radius:var(--radius-md,6px);
      background:var(--surface-card,#fff); color:inherit; font:inherit }
    .tk-cand:hover { border-color:var(--action,#c2410c) }
    .tk-cand.sel { border-color:var(--action,#c2410c); box-shadow:inset 3px 0 0 var(--action,#c2410c) }
    .tk-cand:focus-visible { outline:2px solid var(--action,#c2410c); outline-offset:1px }
    .tk-cand-top { display:flex; justify-content:space-between; align-items:center; gap:.5rem }
    .tk-cand-mid { font-size:.8rem; font-weight:600 }
    .tk-cand-mid i { font-style:normal; color:var(--text-muted,#78716c); font-weight:500 }
    .tk-cand-bot { display:flex; justify-content:space-between; font-size:.74rem; color:var(--text-muted,#78716c) }
    .tk-cand-cli { font-size:.74rem; color:var(--text-muted,#78716c); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
    .tk-doc { border:1px solid var(--surface-border,#e7e5e4); border-radius:var(--radius-md,6px);
      background:var(--surface-card,#fff); padding:.85rem 1rem }
    .tk-doc-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap }
    .tk-doc-sub { font-size:.7rem; letter-spacing:.1em; text-transform:uppercase; color:var(--action,#c2410c); font-weight:700 }
    .tk-doc-head h2 { margin:.1rem 0 0; font-size:1.05rem }
    .tk-acciones { display:flex; gap:.4rem; flex-wrap:wrap }
    .tk-warn { margin-top:.6rem; padding:.45rem .6rem; border:1px solid #d6b45a; background:#fdf6e3;
      color:#5c4803; border-radius:var(--radius-sm,4px); font-size:.8rem; font-weight:600 }
    .tk-meta { display:flex; flex-wrap:wrap; gap:.15rem 1.4rem; margin:.7rem 0 .2rem }
    .tk-meta dt { font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted,#78716c); font-weight:700 }
    .tk-meta dd { margin:0; font-size:.85rem; font-weight:600 }
    .tk-nota { margin:.35rem 0 .7rem; font-size:.73rem; color:var(--text-muted,#78716c) }
    .tk-num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap }
    .tk-uni { font-style:normal; font-size:.7rem; color:var(--text-muted,#78716c) }
    .tk-prod { font-weight:600; font-size:.85rem; line-height:1.2 }
    .tk-sku { font-size:.7rem; color:var(--text-muted,#78716c) }
    .tk-mono { font-family:var(--font-mono,monospace) }
    /* El tachado es lo que hace legible "antes costaba X, pagaste Y" sin leer la columna. */
    .tk-tachado { text-decoration:line-through; color:var(--text-muted,#78716c) }
    .tk-fuerte { font-weight:700 }
    .tk-ahorro { color:#155e35; font-weight:700 }
    .tk-cierre { display:flex; justify-content:flex-end; margin-top:.8rem }
    .tk-res { border-collapse:collapse; min-width:19rem }
    .tk-res td { padding:.25rem .6rem; border-bottom:1px solid var(--surface-border,#e7e5e4); font-size:.88rem }
    .tk-res td i { font-style:normal; font-size:.72rem; color:var(--text-muted,#78716c) }
    .tk-res tr.tk-desc td { color:#155e35 }
    .tk-res tr.tk-total td { border-top:2px solid currentColor; border-bottom:none; font-size:1.05rem; font-weight:800; padding-top:.4rem }
    .tk-ahorraste { margin-left:1rem; align-self:flex-end; padding:.45rem .8rem; border:1.5px solid #155e35;
      background:#eaf5ee; color:#0f4527; border-radius:var(--radius-sm,4px); font-weight:800; text-align:center }
    .tk-ahorraste i { display:block; font-style:normal; font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; font-weight:600 }
    .tk-vacio, .tk-cargando { padding:2rem 1rem; text-align:center; color:var(--text-muted,#78716c); font-size:.9rem }
  `],
})
export class ComercialTicketsComponent {
  private readonly svc = inject(TicketsService);
  private readonly toast = inject(MessageService);

  termino = '';
  readonly buscando = signal(false);
  readonly buscado = signal(false);
  readonly cargando = signal(false);
  readonly generandoPdf = signal(false);
  readonly candidatos = signal<TicketCandidato[]>([]);
  readonly truncado = signal(false);
  readonly seleccionado = signal<string | null>(null);
  readonly doc = signal<TicketVenta | null>(null);

  /** La columna de descuento sólo existe si el documento trae alguno (el 70% no trae). */
  readonly hayDescuento = computed(() => (this.doc()?.cascada.descuento_precio ?? 0) > 0);
  /**
   * La columna de precio de lista desaparece ENTERA cuando ningún renglón lo tiene — es lo que
   * pasa en todo documento anterior al 2026-08-13, que es cuando Kepler empezó a guardarlo.
   * Mostrarla con guiones o en $0.00 sería afirmar un precio que nadie registró; el aviso del
   * documento explica por qué no está (ADR-056: lo que no se puede medir se declara).
   */
  readonly hayLista = computed(() => (this.doc()?.cascada.lineas_con_lista ?? 0) > 0);
  /** Sin nada que restar, "Precio de lista" sería el total repetido con otro nombre. */
  readonly hayQueRestar = computed(() => {
    const c = this.doc()?.cascada;
    return !!c && (c.descuento_precio > 0 || c.descuento_documento !== 0);
  });

  sev(origen: string): 'info' | 'success' | 'warn' | 'secondary' {
    return origen === 'mostrador' ? 'info'
      : origen === 'telemarketing' ? 'success'
      : origen === 'credito' ? 'warn' : 'secondary';
  }

  buscar(): void {
    const q = this.termino.trim();
    if (!q) return;
    this.buscando.set(true);
    this.doc.set(null);
    this.seleccionado.set(null);
    this.svc.buscar(q).subscribe({
      next: (r) => {
        this.candidatos.set(r.candidatos);
        this.truncado.set(r.truncado);
        this.buscado.set(true);
        this.buscando.set(false);
        // Con UN solo candidato no hay ambigüedad que resolver, así que se abre. Con dos o más
        // elige la persona: "el primero" sería el dinero de otra tienda.
        if (r.candidatos.length === 1) this.abrir(r.candidatos[0]);
      },
      error: () => {
        this.buscando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo buscar', detail: 'Reintenta en un momento.' });
      },
    });
  }

  abrir(c: TicketCandidato): void {
    this.seleccionado.set(c.id);
    this.cargando.set(true);
    this.svc.detalle(c.id).subscribe({
      next: (d) => { this.doc.set(d); this.cargando.set(false); },
      error: () => {
        this.cargando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo abrir el documento' });
      },
    });
  }

  imprimir(d: TicketVenta): void {
    if (!imprimirTicketVenta(d)) {
      this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la impresión', detail: 'Permite las ventanas de impresión para este sitio.' });
    }
  }

  carta(d: TicketVenta): void {
    this.generandoPdf.set(true);
    this.svc.cartaPdf(d.id).subscribe({
      next: (blob) => {
        this.generandoPdf.set(false);
        // Se abre desde un blob URL: la ruta va con Bearer y una pestaña nueva no lleva el token.
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank');
        if (!w) this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la pestaña', detail: 'Permite las ventanas emergentes para ver el PDF.' });
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      error: () => {
        this.generandoPdf.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo generar el PDF' });
      },
    });
  }
}
