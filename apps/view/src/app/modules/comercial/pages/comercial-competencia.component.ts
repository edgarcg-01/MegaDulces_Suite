import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PRECIOS_TABS } from '../precios-tabs';
import { MotorMargenService, type CompetenciaMotor } from '../motor-margen.service';

/**
 * `[PR.M3]`+`[PR.M6]` — **La competencia.** Quién nos gana, cuánto, y a qué precio.
 *
 * ── Answer-first (§Q.1) ────────────────────────────────────────────────────────────────────
 * La pregunta que trae quien entra no es «cuántas marcas hay»: es **«¿estoy caro o barato, y
 * dónde me están ganando?»**. Por eso abre con el dinero —lo que cobramos por encima y por
 * debajo del mercado— y recién después vienen las tablas.
 *
 * ── ⛔ Lo que esta pantalla NO muestra, y lo dice ──────────────────────────────────────────
 * **No hay precio de lista de nadie.** ISCAM no publica precios: el que se ve acá se **deriva**
 * de valor/volumen, y por eso viaja con su banda de confianza y con la advertencia de que la
 * unidad no está verificada. Tampoco se puede decir QUÉ competidor vende a ese precio: el panel
 * de ISCAM **anonimiza** a sus 116 participantes. Los competidores con nombre son otra fuente
 * (INEGI DENUE) y **las dos no se pueden empatar**.
 *
 * ── ⚠️ El selector de subcanal NO es cosmético ─────────────────────────────────────────────
 * Cambia la cifra, y **las dos son ciertas**: 5.36 % en Mayoreo Puro —nuestro canal— y 3.80 %
 * en el mayoreo total, porque hay $426.8M de mercado en subcanales donde no vendemos nada. Es
 * una decisión de negocio sin resolver, así que la pantalla **la expone en vez de elegir por
 * su cuenta**.
 *
 * ── El contrato de diseño ──────────────────────────────────────────────────────────────────
 * Sin `font-size` literal · sin hex crudo · `tabular-nums` en toda cifra · números a la derecha
 * **y su `<th>` también** con `comm-num` · elevación por hairline, nunca sombra dentro de la
 * página · cero zebra · iconos, **nunca emojis**.
 */
@Component({
  selector: 'app-comercial-competencia',
  standalone: true,
  imports: [
    CommonModule, TableModule, ButtonModule, SegmentedComponent,
    PageTabsComponent, LoadStateComponent, MetricStripComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div class="surf-page cmp">
  <div class="pr-tabs"><app-page-tabs [tabs]="tabs" /></div>

  <header class="surf-page-head">
    <div class="surf-page-head-text">
      <h1>Competencia</h1>
      <p class="surf-page-sub">
        Cuánto vendió <strong>el resto del canal</strong> bajo cada marca, y a qué precio contra
        el nuestro. Sale de la medición mensual de ISCAM.
        <app-context-help topic="control-de-margen" />
        <app-context-help topic="competencia" />
      </p>
    </div>
    <div class="cmp-head-acc">
      <app-segmented [options]="subcanales" [value]="subcanal()"
                     (valueChange)="cambiarSubcanal($event)"
                     ariaLabel="Universo de mercado" />
      <p-button type="button" icon="pi pi-refresh" label="Actualizar" [loading]="cargando()"
                (click)="cargar()" styleClass="p-button-text p-button-sm" />
    </div>
  </header>

  <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="vacio()"
                  emptyTitle="Sin entrega de ISCAM"
                  [emptyHint]="motivoVacio()" (retry)="cargar()">

    <!-- ══ ANSWER-FIRST: el dinero, antes que las tablas ══ -->
    <app-metric-strip [items]="kpis()" ariaLabel="La competencia en dinero" />

    <p class="cmp-proc">
      Entrega <code>{{ d()?.periodo ?? '—' }}</code> &middot;
      {{ d()?.universo?.region }} &middot; <strong>{{ d()?.universo?.subcanal }}</strong> &middot;
      {{ d()?.universo?.mercado }}.
      <span class="cmp-warn">
        <i class="pi pi-info-circle mx-ico" aria-hidden="true"></i>
        El share depende del universo: en el mayoreo total la cifra es más baja porque hay
        mercado medido en subcanales donde no vendemos nada. Las dos son ciertas.
      </span>
    </p>

    <!-- ══ 1 · EL PRECIO ══ -->
    <section class="cmp-sec">
      <h2 class="cmp-h2">Precio contra la competencia</h2>
      <p class="cmp-h2-sub">
        Precio <strong>implícito</strong> (valor &divide; volumen), no de lista ni de anaquel.
        La <em>confianza</em> sale de nuestro propio volumen: con poca venta nuestra la cifra se
        vuelve inestable, y eso se dice en la fila.
      </p>

      @if (precio(); as p) {
        <div class="cmp-duo">
          <div class="cmp-col">
            <h3 class="cmp-h3">
              <i class="pi pi-arrow-up mx-ico cmp-ic-bad" aria-hidden="true"></i>
              Cobramos más caro
            </h3>
            <p-table [value]="p.mas_caras_que_el_mercado" styleClass="p-datatable-sm surf-table"
                     [scrollable]="true" scrollHeight="22rem">
              <ng-template #header>
                <tr>
                  <th scope="col">Marca</th>
                  <th scope="col" class="comm-num">Nuestro</th>
                  <th scope="col" class="comm-num">Competencia</th>
                  <th scope="col" class="comm-num">Dif.</th>
                  <th scope="col">Certeza</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td>
                    <div class="cmp-nom">{{ r.submarca }}</div>
                    <div class="cmp-sub">{{ r.categoria }} &middot; venta {{ mx(r.venta_nuestra) }}</div>
                  </td>
                  <td class="comm-num">{{ mx2(r.precio_nuestro) }}</td>
                  <td class="comm-num">{{ mx2(r.precio_competencia) }}</td>
                  <td class="comm-num cmp-bad">+{{ r.dif_pct }}%</td>
                  <td><span class="comm-pill" [class.cmp-pill-baja]="r.confianza === 'baja'">{{ certeza(r) }}</span></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="5" class="cmp-none">Ninguna marca por encima del mercado en este universo.</td></tr>
              </ng-template>
            </p-table>
          </div>

          <div class="cmp-col">
            <h3 class="cmp-h3">
              <i class="pi pi-arrow-down mx-ico cmp-ic-ok" aria-hidden="true"></i>
              Cobramos más barato
            </h3>
            <p-table [value]="p.mas_baratas_que_el_mercado" styleClass="p-datatable-sm surf-table"
                     [scrollable]="true" scrollHeight="22rem">
              <ng-template #header>
                <tr>
                  <th scope="col">Marca</th>
                  <th scope="col" class="comm-num">Nuestro</th>
                  <th scope="col" class="comm-num">Competencia</th>
                  <th scope="col" class="comm-num">Dif.</th>
                  <th scope="col">Certeza</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td>
                    <div class="cmp-nom">{{ r.submarca }}</div>
                    <div class="cmp-sub">{{ r.categoria }} &middot; venta {{ mx(r.venta_nuestra) }}</div>
                  </td>
                  <td class="comm-num">{{ mx2(r.precio_nuestro) }}</td>
                  <td class="comm-num">{{ mx2(r.precio_competencia) }}</td>
                  <td class="comm-num cmp-ok">{{ r.dif_pct }}%</td>
                  <td><span class="comm-pill" [class.cmp-pill-baja]="r.confianza === 'baja'">{{ certeza(r) }}</span></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="5" class="cmp-none">Ninguna marca por debajo del mercado en este universo.</td></tr>
              </ng-template>
            </p-table>
          </div>
        </div>
      }
    </section>

    <!-- ══ 2 · QUIÉN NOS GANA ══ -->
    <section class="cmp-sec">
      <h2 class="cmp-h2">Dónde más creció la competencia</h2>
      <p class="cmp-h2-sub">
        Ordenado por <strong>cuántos pesos más</strong> vendió el resto del canal contra el
        periodo anterior &mdash; no por tamaño de mercado, que pondría arriba a los gigantes
        donde no pasó nada este mes.
      </p>
      <p-table [value]="d()?.fabricantes ?? []" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="24rem">
        <ng-template #header>
          <tr>
            <th scope="col">Fabricante</th>
            <th scope="col" class="comm-num">Creció la competencia</th>
            <th scope="col" class="comm-num">Mercado</th>
            <th scope="col" class="comm-num">Nuestro</th>
            <th scope="col" class="comm-num">Share</th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr>
            <td class="cmp-nom">{{ r.fabricante }}</td>
            <td class="comm-num" [class.cmp-bad]="num(r.competencia_delta) > 0">{{ mx(r.competencia_delta) }}</td>
            <td class="comm-num">{{ mx(r.mercado) }}</td>
            <td class="comm-num">{{ mx(r.nuestro) }}</td>
            <td class="comm-num">{{ r.share_pct ?? '—' }}%</td>
          </tr>
        </ng-template>
      </p-table>
    </section>

    <!-- ══ 3 · DÓNDE NO ESTAMOS ══ -->
    <section class="cmp-sec">
      <h2 class="cmp-h2">Marcas que el canal compra y nosotros no vendemos</h2>
      <p class="cmp-h2-sub">
        Acá no hay nada que corregir de precio: <strong>es surtido</strong>. Son marcas con
        mercado medido y venta nuestra en cero.
      </p>
      <p-table [value]="d()?.ausentes ?? []" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="20rem">
        <ng-template #header>
          <tr>
            <th scope="col">Marca</th>
            <th scope="col">Fabricante</th>
            <th scope="col">Categoría</th>
            <th scope="col" class="comm-num">Se lo lleva la competencia</th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr>
            <td class="cmp-nom">{{ r.submarca }}</td>
            <td class="cmp-sub-td">{{ r.fabricante }}</td>
            <td class="cmp-sub-td">{{ r.categoria }}</td>
            <td class="comm-num">{{ mx(r.competencia) }}</td>
          </tr>
        </ng-template>
      </p-table>
    </section>

    <!-- ══ LO QUE ESTA PANTALLA NO SABE ══ -->
    <section class="cmp-decl">
      <h2 class="cmp-h2">
        <i class="pi pi-exclamation-triangle mx-ico" aria-hidden="true"></i>
        Lo que estas cifras NO son
      </h2>
      <ul class="cmp-decl-list">
        @for (t of declaraciones(); track t) { <li>{{ t }}</li> }
      </ul>
    </section>
  </app-load-state>
</div>
`,
  styles: [`
.cmp { display: flex; flex-direction: column; gap: var(--sp-4); }
.cmp-head-acc { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

.cmp-proc {
  margin: 0; color: var(--fg-2); font-size: var(--fs-sm); line-height: 1.5;
}
.cmp-proc code { font-family: var(--font-mono); font-size: var(--fs-xs); }
.cmp-warn { display: block; margin-top: var(--sp-1); color: var(--fg-3); }

.cmp-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
.cmp-h2 {
  margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--fg-1);
  display: flex; align-items: center; gap: var(--sp-2);
}
.cmp-h2-sub { margin: 0; color: var(--fg-3); font-size: var(--fs-sm); line-height: 1.5; }
.cmp-h3 {
  margin: 0 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-2);
  display: flex; align-items: center; gap: var(--sp-1);
}

/* Dos columnas en escritorio, una debajo de otra en teléfono: la tabla nunca scrollea de lado. */
.cmp-duo { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); }
.cmp-col { min-width: 0; }

.cmp-nom { font-weight: var(--fw-medium); color: var(--fg-1); }
.cmp-sub, .cmp-sub-td { color: var(--fg-3); font-size: var(--fs-xs); }
.cmp-none { color: var(--fg-3); font-size: var(--fs-sm); padding: var(--sp-3); text-align: center; }

/* El signo va en la flecha y en el texto, no sólo en el color. */
.cmp-bad { color: var(--bad-fg); }
.cmp-ok { color: var(--ok-fg); }
.cmp-ic-bad { color: var(--bad-fg); }
.cmp-ic-ok { color: var(--ok-fg); }
.cmp-pill-baja { opacity: 0.72; }

.cmp-decl {
  display: flex; flex-direction: column; gap: var(--sp-2);
  border-top: 1px solid var(--border-color); padding-top: var(--sp-3);
}
.cmp-decl-list {
  margin: 0; padding-left: var(--sp-4); color: var(--fg-3);
  font-size: var(--fs-sm); line-height: 1.6;
}
.cmp-decl-list li + li { margin-top: var(--sp-1); }

@media (max-width: 60rem) {
  .cmp-duo { grid-template-columns: 1fr; }
}
`],
})
export class ComercialCompetenciaComponent {
  private readonly svc = inject(MotorMargenService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = PRECIOS_TABS;
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly d = signal<CompetenciaMotor | null>(null);

  /**
   * ⚠️ Los dos universos se ofrecen, no se elige uno por dentro. El share cambia y las dos
   *    cifras son ciertas; cuál se publica es decisión de negocio y sigue abierta.
   */
  readonly subcanales: SegOption[] = [
    { label: 'Mayoreo Puro', value: 'Mayoreo Puro' },
    { label: 'Mayoreo total', value: 'Puntos de Venta Mayoristas' },
  ];
  readonly subcanal = signal('Mayoreo Puro');

  cambiarSubcanal(v: string): void { this.subcanal.set(v); this.cargar(); }

  readonly precio = computed(() => this.d()?.precio ?? null);
  readonly vacio = computed(() => { const x = this.d(); return !!x && !x.medido; });
  readonly motivoVacio = computed(() => this.d()?.motivo
    ?? 'La carga de ISCAM es mensual y explícita: la sube una persona cuando llega el archivo.');

  /** Las declaraciones del dato y las del precio, juntas: son del mismo peso. */
  readonly declaraciones = computed(() => {
    const x = this.d();
    return [...(x?.precio?.declara ?? []), ...(x?.declara ?? [])];
  });

  /**
   * ⭐ Answer-first: el dinero primero. `venta_nuestra` de las marcas donde estamos caros es lo
   *   que de verdad se puede mover; el share es contexto.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const x = this.d();
    if (!x?.medido) return [];
    const r = x.precio?.resumen ?? [];
    const suma = (v: string) => r.filter((i) => i.veredicto === v)
      .reduce((a, i) => a + Number(i.venta_nuestra || 0), 0);
    const cuenta = (v: string) => r.filter((i) => i.veredicto === v)
      .reduce((a, i) => a + i.submarcas, 0);
    const ausentes = (x.por_veredicto ?? []).find((v) => v.veredicto === 'ausentes');
    const nuestro = Number(x.total?.nuestro || 0);
    const mercado = Number(x.total?.mercado || 0);
    return [
      {
        label: 'Vendemos caro', value: suma('arriba_del_mercado'), format: 'currency-short',
        tone: 'bad', sub: `${cuenta('arriba_del_mercado')} marcas por encima del mercado`,
      },
      {
        label: 'Vendemos barato', value: suma('abajo_del_mercado'), format: 'currency-short',
        tone: 'warn', sub: `${cuenta('abajo_del_mercado')} marcas por debajo`,
      },
      {
        label: 'Donde no estamos', value: Number(ausentes?.competencia || 0),
        format: 'currency-short', tone: 'default',
        sub: `${ausentes?.marcas ?? 0} marcas que el canal compra y no vendemos`,
      },
      {
        label: 'Share del canal', value: mercado > 0 ? (100 * nuestro) / mercado : 0,
        format: 'percent', tone: 'brand',
        sub: `${x.universo?.subcanal ?? ''} · ${x.total?.marcas ?? 0} marcas medidas`,
      },
    ];
  });

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.svc.competencia({ subcanal: this.subcanal(), limit: 60 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.d.set(r); this.cargando.set(false); },
        error: (e) => {
          this.error.set(e?.error?.message || 'No se pudo leer la medición de competencia.');
          this.cargando.set(false);
        },
      });
  }

  num(v: string | null): number { return Number(v || 0); }

  /** ⛔ NULL no es cero: se escribe como guion, porque un $0 se lee como "no vendió nada". */
  mx(v: string | null): string {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }

  mx2(v: string | null): string {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  /** La certeza se dice con PALABRAS, no con un color que hay que saber interpretar. */
  certeza(r: { confianza: string | null; share_volumen_pct: string | null }): string {
    if (r.confianza === 'alta') return 'medida';
    if (r.confianza === 'baja') return `poca venta nuestra (${r.share_volumen_pct ?? '—'}%)`;
    return 'no calculable';
  }
}
