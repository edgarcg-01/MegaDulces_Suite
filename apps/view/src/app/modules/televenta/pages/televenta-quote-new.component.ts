import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { Subject, debounceTime, distinctUntilChanged, switchMap, catchError, of } from 'rxjs';
import {
  QuotesService,
  WholesaleCustomer,
  WholesaleBranchTerms,
  QuoteOrigin,
} from '../quotes.service';

/**
 * `[E.12.1]` — Bandeja de alta de cotización.
 *
 * ── Por qué el cliente NO sale de `commercial.customers` ────────────────────────────────────
 * Medido el 2026-09-21: de nuestros 3,239 clientes, **sólo 117 empatan** con un código del ERP.
 * El padrón de mayoreo real vive en `kepler_ods.kdud` y son los **207 códigos `C####`** (la
 * auditoría E.9 había contado 206 clientes facturados por telemarketing). El cliente del caso
 * real —C1086— no existe en nuestro padrón. Por eso esta pantalla busca contra la vista
 * `analytics.v_erp_wholesale_customers`, derivada del ERP: cero importers, cero copias.
 *
 * ── Por qué hay que elegir SUCURSAL, y no es un detalle ─────────────────────────────────────
 * Las condiciones del cliente (descuento, límite de crédito, plazo) **difieren entre sucursales**.
 * C1086 tiene $60,000 y 3% en La Piedad, y $30,000 **sin descuento** en el CEDIS. Sobre 1,574
 * clientes: 204 cambian de límite, 118 de plazo, 57 de descuento. Cotizar sin decir desde qué
 * sucursal es irreproducible, así que el paso 2 es obligatorio y la pantalla **muestra las
 * condiciones de cada una antes de elegir**, en vez de tomar una por default en silencio.
 *
 * Las condiciones NO se mandan desde acá: el backend las relee del ERP y las congela. Lo que se
 * ve en pantalla es informativo; lo que queda guardado es lo que el ERP dijo.
 */

const ORIGENES: Array<{ value: QuoteOrigin; label: string; hint: string }> = [
  { value: 'telemarketing', label: 'El cliente mandó su lista', hint: 'Llegó por correo o WhatsApp pidiendo precio' },
  { value: 'route_visit', label: 'Visita de ruta', hint: 'Se levantó en el punto de venta' },
  { value: 'counter', label: 'Mostrador', hint: 'Preguntó en la sucursal' },
];

@Component({
  selector: 'app-televenta-quote-new',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, ButtonModule, ProgressSpinnerModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="section">
      <a routerLink="/telemarketing/cotizaciones" class="back">
        <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a cotizaciones
      </a>

      <header class="section-header">
        <h1>Nueva cotización</h1>
        <p>
          Elegí a quién se le cotiza y desde qué sucursal. Los renglones se cargan después, ya
          dentro de la cotización.
        </p>
      </header>

      <!-- PASO 1 — A quién -->
      <div class="step" [class.step-done]="cliente()">
        <div class="step-head">
          <span class="step-num">1</span>
          <h2>¿A quién se le cotiza?</h2>
        </div>

        @if (!cliente()) {
          <div class="step-body">
            <div class="tabs" role="group" aria-label="Tipo de destinatario">
              <button type="button" class="tab" [class.tab-active]="modo() === 'mayoreo'" (click)="setModo('mayoreo')">
                Cliente de mayoreo
              </button>
              <button type="button" class="tab" [class.tab-active]="modo() === 'contacto'" (click)="setModo('contacto')">
                Todavía no es cliente
              </button>
            </div>

            @if (modo() === 'mayoreo') {
              <input
                type="search"
                class="input search"
                [(ngModel)]="termino"
                (ngModelChange)="onBuscar($event)"
                placeholder="Código (C1086) o nombre del cliente..."
                aria-label="Buscar cliente de mayoreo"
                autocapitalize="characters"
                autocorrect="off"
                spellcheck="false"
              />
              <p class="hint">
                Busca en el padrón del ERP: {{ TOTAL_MAYOREO }} clientes de mayoreo (códigos
                <code>C</code> + 4 dígitos).
              </p>

              @if (buscando()) {
                <div class="loading-sm"><p-progressspinner styleClass="w-8 h-8"></p-progressspinner></div>
              } @else if (resultados().length > 0) {
                <ul class="results">
                  @for (c of resultados(); track c.customer_code) {
                    <li>
                      <button type="button" class="result" (click)="elegirCliente(c)">
                        <span class="r-code">{{ c.customer_code }}</span>
                        <span class="r-name">{{ c.name }}</span>
                        <span class="r-meta">
                          @if (c.state) { <span>{{ c.state }}</span> }
                          @if (c.phone) { <span>{{ c.phone }}</span> }
                        </span>
                        @if (c.terms_vary_by_branch) {
                          <span class="r-warn" title="Sus condiciones cambian según la sucursal">
                            condiciones distintas por sucursal
                          </span>
                        }
                      </button>
                    </li>
                  }
                </ul>
              } @else if (termino.length > 0) {
                <p class="empty-sm">Ningún cliente de mayoreo coincide con "{{ termino }}".</p>
              }
            } @else {
              <!-- Contacto suelto: el momento ANTES de ser cliente. La cotización no lo da de
                   alta en el padrón; sólo guarda con quién se habló. -->
              <div class="fields">
                <label>
                  <span>Nombre o razón social <b>*</b></span>
                  <input type="text" class="input" [(ngModel)]="contactoNombre" placeholder="Quién pidió el precio" />
                </label>
                <label>
                  <span>Teléfono</span>
                  <input type="tel" class="input" [(ngModel)]="contactoTel" inputmode="tel" />
                </label>
                <label>
                  <span>Correo</span>
                  <input type="email" class="input" [(ngModel)]="contactoMail" inputmode="email" />
                </label>
              </div>
              <p class="hint">
                Esto <strong>no</strong> lo da de alta como cliente: sólo deja registrado a quién se
                le ofreció el precio.
              </p>
            }
          </div>
        } @else {
          <div class="chosen">
            <div>
              <p class="chosen-code">{{ cliente()!.customer_code }}</p>
              <p class="chosen-name">{{ cliente()!.name }}</p>
              @if (cliente()!.address_1) { <p class="chosen-meta">{{ cliente()!.address_1 }}</p> }
            </div>
            <button pButton severity="secondary" [outlined]="true" size="small" (click)="limpiarCliente()">
              <span class="p-button-label">Cambiar</span>
            </button>
          </div>
        }
      </div>

      <!-- PASO 2 — Desde qué sucursal -->
      @if (cliente()) {
        <div class="step" [class.step-done]="sucursal()">
          <div class="step-head">
            <span class="step-num">2</span>
            <h2>¿Con las condiciones de qué sucursal?</h2>
          </div>
          <div class="step-body">
            @if (cliente()!.terms_vary_by_branch) {
              <p class="warn-box">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                Este cliente <strong>no tiene las mismas condiciones en todas las sucursales</strong>.
                Lo que elijas acá queda congelado en la cotización.
              </p>
            }
            <div class="branches">
              @for (b of cliente()!.branches; track b.sucursal) {
                <button
                  type="button"
                  class="branch"
                  [class.branch-active]="sucursal() === b.sucursal"
                  (click)="sucursal.set(b.sucursal)"
                >
                  <span class="b-suc">Sucursal {{ b.sucursal }}</span>
                  <span class="b-row">
                    <span class="b-label">Descuento</span>
                    @if (b.discount_1_pct !== null) {
                      <span class="b-val b-strong">{{ +b.discount_1_pct }}%</span>
                    } @else {
                      <!-- NULL no es 0%: el ERP no tiene descuento configurado, que no es lo
                           mismo que haber decidido no darlo. Se declara. -->
                      <span class="b-val b-none">sin configurar</span>
                    }
                  </span>
                  <span class="b-row">
                    <span class="b-label">Límite</span>
                    <span class="b-val">
                      {{ b.credit_limit !== null ? (+b.credit_limit | currency:'MXN':'symbol-narrow':'1.0-0') : '—' }}
                    </span>
                  </span>
                  <span class="b-row">
                    <span class="b-label">Plazo</span>
                    <span class="b-val">{{ b.payment_days !== null ? b.payment_days + ' días' : '—' }}</span>
                  </span>
                </button>
              }
            </div>
          </div>
        </div>
      }

      <!-- PASO 3 — Detalle -->
      @if (puedeDetalle()) {
        <div class="step">
          <div class="step-head">
            <span class="step-num">3</span>
            <h2>Detalle</h2>
          </div>
          <div class="step-body">
            <div class="fields">
              <label>
                <span>¿De dónde salió?</span>
                <select class="input" [(ngModel)]="origen">
                  @for (o of origenes; track o.value) {
                    <option [value]="o.value">{{ o.label }}</option>
                  }
                </select>
              </label>
              <label>
                <span>Vigencia hasta</span>
                <input type="date" class="input" [(ngModel)]="vigencia" [min]="hoy" />
              </label>
            </div>
            <label class="full">
              <span>La lista del cliente, tal cual llegó <em>(opcional)</em></span>
              <textarea
                class="input textarea"
                rows="5"
                [(ngModel)]="listaCruda"
                placeholder="Pegá acá el correo o el WhatsApp. Se guarda como evidencia de qué pidió."
              ></textarea>
            </label>
            <p class="hint">
              Se conserva sin interpretar. Casar cada renglón contra el catálogo es el paso
              siguiente, y todavía no está construido.
            </p>
          </div>
        </div>

        <div class="actions">
          <button pButton severity="secondary" [outlined]="true" routerLink="/telemarketing/cotizaciones">
            <span class="p-button-label">Cancelar</span>
          </button>
          <button pButton [disabled]="guardando()" (click)="crear()">
            <span class="p-button-icon p-button-icon-left pi" [class.pi-check]="!guardando()" [class.pi-spin]="guardando()" [class.pi-spinner]="guardando()" aria-hidden="true"></span>
            <span class="p-button-label">{{ guardando() ? 'Creando...' : 'Crear cotización' }}</span>
          </button>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .section { padding: 1.25rem; max-width: 900px; margin: 0 auto; }
      .back { display: inline-flex; gap: 0.35rem; align-items: center; font-size: 0.8125rem; color: var(--text-color-secondary); text-decoration: none; margin-bottom: 0.75rem; }
      .back:hover { color: var(--text-color); }
      .section-header h1 { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.25rem; }
      .section-header p { color: var(--text-color-secondary); font-size: 0.875rem; margin: 0 0 1rem; }

      .step { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 0.85rem; }
      .step-head { display: flex; align-items: center; gap: 0.6rem; padding: 0.85rem 1rem; border-bottom: 1px solid var(--border-color); }
      .step-head h2 { font-size: 0.95rem; font-weight: 600; margin: 0; }
      .step-num {
        width: 24px; height: 24px; flex: none; border-radius: 50%;
        background: var(--neutral-100); color: var(--text-color-secondary);
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 0.75rem; font-weight: 700;
      }
      .step-done .step-num { background: var(--primary-color, var(--action)); color: #fff; }
      .step-body { padding: 1rem; }

      .tabs { display: flex; gap: 0.35rem; margin-bottom: 0.75rem; }
      .tab {
        border: 1px solid var(--border-color); background: var(--card-bg);
        border-radius: 9999px; padding: 0.35rem 0.85rem; font-size: 0.8125rem;
        cursor: pointer; color: var(--text-color-secondary); min-height: 32px;
      }
      .tab-active { background: var(--primary-color, var(--action)); border-color: var(--primary-color, var(--action)); color: #fff; font-weight: 600; }

      .input {
        width: 100%; padding: 0.45rem 0.7rem; box-sizing: border-box;
        border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.875rem;
        background: var(--card-bg); color: var(--text-color); min-height: 36px;
      }
      .input:focus-visible { outline: 2px solid var(--primary-color, var(--action)); outline-offset: 1px; }
      .textarea { min-height: 96px; font-family: inherit; resize: vertical; }
      .hint { font-size: 0.75rem; color: var(--text-color-secondary); margin: 0.4rem 0 0; }
      .hint code { font-family: var(--font-mono, monospace); }

      .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; }
      .fields label, .full { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; }
      .full { margin-top: 0.75rem; }
      .fields label span, .full span { color: var(--text-color-secondary); }
      .fields label b { color: var(--red-600, #b91c1c); }

      .loading-sm { display: flex; justify-content: center; padding: 1rem 0; }
      .results { list-style: none; margin: 0.6rem 0 0; padding: 0; max-height: 320px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px; }
      .results li + li { border-top: 1px solid var(--border-color); }
      .result {
        width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
        padding: 0.6rem 0.8rem; display: grid; gap: 0.1rem;
        grid-template-columns: 90px 1fr auto;
      }
      .result:hover { background: var(--neutral-100); }
      .r-code { font-family: var(--font-mono, monospace); font-size: 0.8125rem; font-weight: 600; }
      .r-name { font-size: 0.875rem; }
      .r-meta { grid-column: 2; display: flex; gap: 0.6rem; font-size: 0.75rem; color: var(--text-color-secondary); }
      .r-warn { grid-column: 3; grid-row: 1 / span 2; align-self: center; font-size: 0.7rem; color: var(--yellow-700, #a16207); max-width: 150px; text-align: right; }
      .empty-sm { font-size: 0.8125rem; color: var(--text-color-secondary); margin: 0.6rem 0 0; }

      .chosen { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1rem; }
      .chosen-code { font-family: var(--font-mono, monospace); font-size: 0.8125rem; font-weight: 600; margin: 0; }
      .chosen-name { font-size: 1rem; font-weight: 600; margin: 0.1rem 0; }
      .chosen-meta { font-size: 0.75rem; color: var(--text-color-secondary); margin: 0; }

      .warn-box {
        display: flex; gap: 0.5rem; align-items: flex-start;
        background: var(--yellow-50, #fefce8); border: 1px solid var(--yellow-200, #fef08a);
        border-radius: 6px; padding: 0.6rem 0.8rem; font-size: 0.8125rem; margin: 0 0 0.85rem;
        color: var(--yellow-800, #854d0e);
      }
      .branches { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 0.6rem; }
      .branch {
        text-align: left; cursor: pointer; background: var(--card-bg);
        border: 1px solid var(--border-color); border-radius: 8px; padding: 0.7rem 0.8rem;
        display: flex; flex-direction: column; gap: 0.25rem;
      }
      .branch:hover { background: var(--neutral-100); }
      .branch-active { border-color: var(--primary-color, var(--action)); border-width: 2px; padding: calc(0.7rem - 1px) calc(0.8rem - 1px); }
      .b-suc { font-weight: 700; font-size: 0.875rem; margin-bottom: 0.2rem; }
      .b-row { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.75rem; }
      .b-label { color: var(--text-color-secondary); }
      .b-val { font-variant-numeric: tabular-nums; }
      .b-strong { font-weight: 700; color: var(--primary-color, var(--action)); }
      .b-none { font-style: italic; color: var(--text-color-secondary); }

      .actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 1rem; }
    `,
  ],
})
export class TeleventaQuoteNewComponent implements OnInit {
  private readonly svc = inject(QuotesService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);

  /** Medido 2026-09-21 sobre `kepler_ods.kdud`. Se muestra para que el operador sepa el universo. */
  readonly TOTAL_MAYOREO = 207;
  readonly origenes = ORIGENES;
  readonly hoy = new Date().toISOString().slice(0, 10);

  modo = signal<'mayoreo' | 'contacto'>('mayoreo');
  termino = '';
  buscando = signal(false);
  resultados = signal<WholesaleCustomer[]>([]);
  cliente = signal<WholesaleCustomer | null>(null);
  sucursal = signal<string | null>(null);
  guardando = signal(false);

  contactoNombre = '';
  contactoTel = '';
  contactoMail = '';
  origen: QuoteOrigin = 'telemarketing';
  /** Default 15 días, la misma vigencia que usa el backend si no se manda nada. */
  vigencia = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
  listaCruda = '';

  private readonly busqueda$ = new Subject<string>();

  /** El paso 3 se habilita con cliente+sucursal, o con un contacto suelto que al menos tenga nombre. */
  readonly puedeDetalle = computed(() => {
    if (this.modo() === 'contacto') return this.contactoNombre.trim().length > 0;
    return !!this.cliente() && !!this.sucursal();
  });

  ngOnInit(): void {
    this.busqueda$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((t) => {
          this.buscando.set(true);
          return this.svc.searchWholesaleCustomers(t, 20).pipe(
            catchError((err) => {
              // Un 403 tragado en silencio se lee como "no hay clientes" cuando es "no hay
              // permiso" (GOTCHAS §4). Se avisa.
              this.toast.add({
                severity: err?.status === 403 ? 'warn' : 'error',
                summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo buscar',
                detail: err?.error?.message || 'El padrón de mayoreo no respondió.',
              });
              return of([] as WholesaleCustomer[]);
            }),
          );
        }),
      )
      .subscribe((rows) => {
        this.resultados.set(rows);
        this.buscando.set(false);
      });
    // Arranca mostrando los primeros, para que la pantalla no nazca vacía.
    this.busqueda$.next('');
  }

  setModo(m: 'mayoreo' | 'contacto'): void {
    this.modo.set(m);
    if (m === 'contacto') this.limpiarCliente();
  }

  onBuscar(t: string): void {
    this.busqueda$.next((t || '').trim());
  }

  elegirCliente(c: WholesaleCustomer): void {
    this.cliente.set(c);
    // Si todas sus sucursales dicen lo mismo, no hay nada que elegir: se toma la primera.
    // Si difieren, NO se elige por él — ese es justo el dato que la pantalla existe para mostrar.
    this.sucursal.set(!c.terms_vary_by_branch && c.branches.length ? c.branches[0].sucursal : null);
  }

  limpiarCliente(): void {
    this.cliente.set(null);
    this.sucursal.set(null);
  }

  crear(): void {
    if (this.guardando()) return;
    this.guardando.set(true);

    const esMayoreo = this.modo() === 'mayoreo';
    const payload: Parameters<QuotesService['create']>[0] = {
      origin: this.origen,
      valid_until: this.vigencia || undefined,
      customer_request: this.listaCruda.trim() || undefined,
    };
    if (esMayoreo) {
      payload.erp_customer_code = this.cliente()!.customer_code;
      payload.source_branch = this.sucursal()!;
    } else {
      payload.contact_name = this.contactoNombre.trim();
      payload.contact_phone = this.contactoTel.trim() || undefined;
      payload.contact_email = this.contactoMail.trim() || undefined;
    }

    this.svc.create(payload).subscribe({
      next: (q) => {
        this.guardando.set(false);
        this.toast.add({
          severity: 'success',
          summary: `Cotización ${q.code}`,
          detail: `Creada en borrador, vigente hasta ${q.valid_until}.`,
        });
        this.router.navigate(['/telemarketing/cotizaciones']);
      },
      error: (err) => {
        this.guardando.set(false);
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo crear',
          detail: err?.error?.message || err?.message || 'Error de red.',
        });
      },
    });
  }
}
