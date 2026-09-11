import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SalesDocumentsService, SalesDocRow, SalesDocsReport, SalesDocsFiltros } from '../sales-documents.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { TELEMARKETING_TABS } from '../telemarketing-tabs';
import {
  TelemarketingFiltrosComponent, TmFiltros, tmFiltrosIniciales,
} from '../components/telemarketing-filtros.component';

/**
 * GT.2 — Reportes de Telemarketing: se eligen facturas a mano y sale la **Guía de Cobranza**.
 *
 * La selección es el acto de negocio: el cobrador sale con ESAS facturas, no con "las que
 * caigan en un rango". Por eso el filtro sólo acota lo que se ve y lo que entra al papel son
 * los renglones palomeados — el contador de la barra dice siempre cuántos son, cuánto suman y
 * a cuántos clientes representan, que es lo que se compara contra el papel al regresar.
 *
 * El PDF lo arma el backend (`guia-cobranza.pdf`) y llega como blob porque el endpoint pide
 * JWT: abrir la URL en una pestaña mandaría la petición sin token.
 */
@Component({
  selector: 'app-comercial-reportes-cobranza',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, TagModule, ButtonModule, InputTextModule,
    TooltipModule, ToastModule, LoadStateComponent, PageTabsComponent, TelemarketingFiltrosComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
  <div class="surf-page">
    <p-toast position="bottom-right" />

    <div class="surf-page-head">
      <div>
        <h1>Reportes de Telemarketing</h1>
        <p class="surf-page-sub">
          Selecciona las facturas y genera la Guía de Cobranza que sale con el cobrador
        </p>
      </div>
    </div>

    <app-page-tabs [tabs]="tabs" />

    <app-telemarketing-filtros [value]="filtros()" [vendedores]="vendedorOpts()"
                               (cambio)="aplicar($event)" />

    <!-- Lo seleccionado, siempre a la vista: es lo que va a salir impreso -->
    <div class="barra card-premium card-flat" [class.vacia]="!sel().length">
      <div class="cuenta">
        <span class="n">{{ sel().length }}</span>
        <span class="l">factura{{ sel().length === 1 ? '' : 's' }} seleccionada{{ sel().length === 1 ? '' : 's' }}</span>
        @if (sel().length) {
          <span class="det">· {{ clientesSel() }} cliente{{ clientesSel() === 1 ? '' : 's' }}
            · <b class="mono">{{ importeSel() | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</b> a cobrar</span>
        }
      </div>

      <input pInputText type="text" class="resp" [(ngModel)]="responsable"
             placeholder="Responsable (opcional)" aria-label="Nombre del responsable"
             pTooltip="Se imprime sobre la línea de firma del responsable." />

      <p-button label="Limpiar" [text]="true" size="small" [disabled]="!sel().length"
                (onClick)="limpiar()" />
      <p-button icon="pi pi-print" label="Imprimir" size="small" severity="secondary" [outlined]="true"
                [disabled]="!listo()" [loading]="busy() === 'print'" (onClick)="generar(true)" />
      <p-button icon="pi pi-file-pdf" label="Generar reporte" size="small"
                [disabled]="!listo()" [loading]="busy() === 'pdf'" (onClick)="generar(false)" />
    </div>

    <!-- La guía es de UN vendedor: se dice acá, no después de apretar el botón -->
    @if (mezcla(); as m) {
      <p class="alerta"><i class="pi pi-exclamation-triangle"></i>
        La guía es de un solo vendedor y la selección tiene {{ m }}. Filtrá por vendedor
        arriba y armá una guía por cada uno.</p>
    }

    @if (parcial(); as p) {
      <p class="nota"><i class="pi pi-info-circle"></i> {{ p }}</p>
    }

    <div class="card-premium card-flat tabla-wrap">
      <app-load-state
        [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && rows().length === 0"
        emptyIcon="pi-file" emptyTitle="Sin facturas en el periodo"
        [emptyHint]="pista()"
        (retry)="load()">

        <p-table [value]="rows()" dataKey="folio_digital" [scrollable]="true" scrollHeight="calc(100vh - 27rem)"
                 [rowHover]="true" size="small"
                 class="surf-table surf-table--sticky surf-table--frozen-first tabla-docs"
                 [tableStyle]="{ 'min-width': '58rem' }"
                 [selection]="sel()" (selectionChange)="sel.set($event)" selectionMode="multiple">
          <ng-template #header>
            <tr>
              <th scope="col" style="width:12.5rem"><p-tableheadercheckbox /> <span>Folio</span></th>
              <!-- Piso propio: es la unica columna flexible, y con el min-width de la tabla
                   repartido entre las fijas se quedaba con 80 px en tablet — el nombre del
                   cliente salia partido en una palabra por renglon. -->
              <th scope="col" style="min-width:17rem">Cliente</th>
              <th scope="col" style="width:6.5rem">Fecha</th>
              <th scope="col" style="width:8.5rem">Vence</th>
              <th scope="col" style="width:9rem" class="r">Total</th>
              <th scope="col" style="width:8.5rem" class="r">Saldo</th>
              <th scope="col" style="width:8rem">Cobro</th>
            </tr>
          </ng-template>

          <ng-template #body let-d>
            <tr>
              <td class="c-folio">
                <p-tablecheckbox [value]="d" />
                <span>
                  <span class="mono folio">{{ d.sucursal }} {{ d.doc_prefix }}-{{ d.folio }}</span>
                  <span class="sub">{{ d.doc_label }}</span>
                </span>
              </td>
              <td>
                <span class="nom">{{ d.cliente_nombre }}</span>
                <span class="sub mono">{{ d.cliente_code }}@if (d.vendedor_nombre) { · {{ d.vendedor_nombre }} }</span>
              </td>
              <td class="mono">{{ d.fecha | date: 'dd/MM/yy' }}</td>
              <td>
                <span class="mono" [class.derivada]="d.vencimiento_source !== 'erp'">
                  {{ d.vencimiento | date: 'dd/MM/yy' }}{{ d.vencimiento_source === 'erp' ? '' : ' ~' }}
                </span>
                @if (d.vencida) {
                  <p-tag severity="danger" [value]="d.dias_vencida + 'd vencida'" styleClass="tg" />
                }
              </td>
              <td class="r mono strong">{{ d.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
              <td class="r mono">
                @if (d.saldo === null) { <span class="sub" pTooltip="No aparece en la cartera: se imprime el total.">—</span> }
                @else if (+d.saldo > 0.005) {
                  <span class="debe">{{ d.saldo | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
                } @else { <span class="sub">$0.00</span> }
              </td>
              <td>
                <p-tag [severity]="COBRO_TONE[d.estatus_cobro]" [value]="COBRO_LABEL[d.estatus_cobro]" styleClass="tg" />
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>
  </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }

    .barra {
      display: flex; align-items: center; gap: .5rem;
      padding: .5rem .75rem; margin-bottom: .5rem;
      border-left: 3px solid var(--action);
      transition: opacity .15s ease;
      flex-wrap: wrap;
    }
    .barra.vacia { border-left-color: var(--border-color); opacity: .75; }
    .barra .cuenta { display: flex; align-items: baseline; gap: .4rem; flex: 1 1 14rem; min-width: 0; }
    .barra .n { font-family: var(--font-mono, ui-monospace, monospace); font-size: 1.05rem; font-weight: 700; }
    .barra .l { font-size: var(--fs-sm); color: var(--text-main); }
    .barra .det { font-size: var(--fs-sm); color: var(--text-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .barra .resp { width: 13rem; min-width: 8rem; font-size: var(--fs-sm); }

    /* Angosto: la cuenta manda su propio renglón y los botones se van juntos a la derecha.
       Sin esto los tres botones salían del ancho de la página y "Generar reporte" quedaba
       cortado contra el borde (reporte de Edgar 2026-09-11). Breakpoints en rem: en px se
       rompen con zoom al 200% (DESIGN.md §R). */
    @media (max-width: 62.5rem) {
      .barra .cuenta { flex: 1 1 100%; }
      .barra .resp { flex: 1 1 10rem; width: auto; }
    }

    /* Teléfono: el Responsable en su renglón y los botones repartidos a lo ancho, con altura
       de toque. Tres botones apretados en 22rem se convierten en tres blancos de 5 mm. */
    @media (max-width: 30rem) {
      .barra { gap: .45rem; }
      .barra .resp { flex: 1 1 100%; }
      .barra > p-button { flex: 1 1 auto; }
      .barra ::ng-deep .p-button { width: 100%; min-height: var(--tap-min, 44px); }
      .alerta { align-items: flex-start; }
      .alerta i { margin-top: .15rem; }
    }

    .nota {
      display: flex; align-items: center; gap: .4rem; margin: 0 0 .5rem;
      font-size: var(--fs-xs, .75rem); color: var(--text-soft);
    }
    .alerta {
      display: flex; align-items: center; gap: .45rem; margin: 0 0 .5rem;
      font-size: var(--fs-sm); font-weight: 600; color: var(--danger, var(--text-main));
    }

    .tabla-wrap { padding: 0; overflow: hidden; min-width: 0; }

    /* Estas dos tablas se salen de la regla global vieja de styles.css (<=60rem esconde de la
       4a columna en adelante y pega la ultima a la derecha). Ese patron de "columnas
       prioritarias" pelea con el canon de DESIGN_TABLES -- scroll horizontal + 1a columna
       congelada -- que es el que aplica aca: en la guia de cobranza el Saldo y el Total son
       justo lo que no se puede esconder, y la ultima columna pegada a la derecha se encimaba
       encima de Cliente en 390 px. */
    @media (max-width: 60rem) {
      :host ::ng-deep .tabla-docs .p-datatable-thead > tr > th,
      :host ::ng-deep .tabla-docs .p-datatable-tbody > tr > td { display: table-cell !important; }
      :host ::ng-deep .tabla-docs .p-datatable-thead > tr > th:last-child,
      :host ::ng-deep .tabla-docs .p-datatable-tbody > tr > td:last-child {
        position: static !important; right: auto !important;
        box-shadow: none !important; min-width: 0 !important;
      }
    }


    /* Telefono: la tabla deja de tener scroll vertical PROPIO y crece; el que scrollea es la
       pagina. Con un scrollHeight fijo quedaban ~4 renglones dentro de una ventanita de 6 cm
       con la bottom-nav encima. El scroll horizontal (y la 1a columna congelada) siguen. */
    @media (max-width: 48rem) {
      .tabla-docs .p-datatable-table-container,
      :host ::ng-deep .tabla-docs .p-datatable-table-container { max-height: none !important; }
    }

    /* La 1ª columna es la congelada (DESIGN_TABLES §2.3): lleva el identificador, y acá
       también el checkbox — al scrollear en horizontal tenés que seguir viendo QUÉ estás
       palomeando, no una casilla suelta sin folio al lado. */
    .c-folio { display: flex; align-items: flex-start; gap: .5rem; }
    .tabla-docs th:first-child { white-space: nowrap; }
    .tabla-docs th.r, .tabla-docs td.r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    .folio { font-weight: 650; display: block; }
    .nom { display: block; font-weight: 600; line-height: 1.25; }
    .sub { display: block; font-size: var(--fs-xs, .75rem); color: var(--text-soft); margin-top: 1px; }
    td .sub { display: inline-block; margin-left: .25rem; }
    .strong { font-weight: 700; }
    .debe { font-weight: 650; color: var(--danger, var(--text-main)); }
    .derivada { color: var(--text-soft); font-style: italic; }
    .tg { margin-left: .35rem; }
  `],
})
export class ComercialReportesCobranzaComponent {
  private readonly svc = inject(SalesDocumentsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = TELEMARKETING_TABS;
  readonly report = signal<SalesDocsReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal<'pdf' | 'print' | null>(null);
  readonly sel = signal<SalesDocRow[]>([]);
  readonly filtros = signal<TmFiltros>(tmFiltrosIniciales());
  private readonly catalogos = signal<SalesDocsFiltros | null>(null);

  responsable = '';
  /**
   * Lo último que se autocompletó desde el filtro de vendedor. Sirve para saber si el texto
   * que hay en el campo lo puso la pantalla o lo escribió una persona: lo escrito a mano NO
   * se pisa al cambiar de vendedor.
   */
  private respAuto = '';

  /** Se pide la página GRANDE: acá se selecciona, y paginar de 50 en 50 parte la selección. */
  private static readonly PAGE = 200;

  /**
   * Sello de la consulta en curso. La lista tarda segundos contra el ERP y las respuestas
   * **vuelven fuera de orden**: sin esto, una consulta vieja aterrizaba después de la nueva,
   * pintaba filas de otro rango y —peor— se llevaba la selección por delante (las filas
   * "ya no existen" y el filtro de vivos las tira). Se ignora todo lo que no sea la última.
   */
  private peticion = 0;

  readonly vendedorOpts = computed(() =>
    (this.catalogos()?.vendedores || []).map((v) => ({ label: v.vendedor_nombre, value: v.vendedor_code })));

  readonly clientesSel = computed(() => new Set(this.sel().map((d) => d.cliente_code)).size);
  /**
   * Cuántos vendedores distintos hay en la selección — `0` cuando no hay mezcla (nada que
   * avisar). La identidad es el CÓDIGO: dos vendedores pueden llamarse igual.
   */
  readonly mezcla = computed(() => {
    const n = new Set(this.sel().map((d) => d.vendedor_code || '(sin vendedor)')).size;
    return n > 1 ? n : 0;
  });
  readonly listo = computed(() => this.sel().length > 0 && !this.mezcla());
  /** Lo que se va a cobrar: el saldo; sin cartera no hay saldo medido y se cobra el total. */
  readonly importeSel = computed(() =>
    this.sel().reduce((a, d) => a + (d.saldo === null ? Number(d.total) || 0 : Number(d.saldo) || 0), 0));

  /**
   * La tabla trae hasta 200 renglones. Si el filtro encontró más, se dice: una selección
   * "completa" sobre una lista recortada es justo el error que nadie nota hasta la ruta.
   */
  readonly parcial = computed(() => {
    const r = this.report();
    if (!r) return null;
    const total = r.kpis?.documentos ?? 0;
    return total > r.rows.length
      ? `Se muestran ${r.rows.length} de ${total} facturas del filtro. Acota el rango o el vendedor para poder seleccionarlas todas.`
      : null;
  });


  /**
   * Qué decir cuando la ventana no trajo nada. Un "ajusta el rango" a secas deja al usuario
   * adivinando: si sabemos cuándo fue la última factura del canal, se dice. Sin eso, la
   * pantalla de 8 dias arranca en blanco cada vez que el feed viene atrasado y se lee como
   * que la app esta rota.
   */
  readonly pista = computed(() => {
    const u = this.report()?.ultima_factura;
    if (!u) return 'Ajusta el rango de fechas o quita filtros para ver facturas.';
    const [a, m, d] = [u.slice(2, 4), u.slice(5, 7), u.slice(8, 10)];
    return `La última factura de esta selección es del ${d}/${m}/${a}. Ajusta el rango de fechas.`;
  });

  readonly COBRO_LABEL: Record<string, string> = {
    pagada: 'Pagada', parcial: 'Abono parcial', pendiente: 'Pendiente',
    sin_cartera: 'Sin cartera', cancelada: 'Cancelada',
  };
  readonly COBRO_TONE: Record<string, 'success' | 'warn' | 'danger' | 'secondary' | 'info'> = {
    pagada: 'success', parcial: 'warn', pendiente: 'info',
    sin_cartera: 'secondary', cancelada: 'secondary',
  };

  constructor() {
    this.load();
  }

  aplicar(f: TmFiltros): void {
    const antes = this.filtros().vendedor;
    this.filtros.set(f);
    if (f.vendedor !== antes) this.autoResponsable(f.vendedor);
    this.load();
  }

  /**
   * Al elegir vendedor, su nombre entra como Responsable de la guía (decisión Edgar
   * 2026-09-11): en el 99% de los casos el que sale a cobrar es el mismo que vendió, y
   * escribirlo a mano en cada guía es teclear lo que la pantalla ya sabe. Sigue siendo
   * editable, y si alguien ya escribió otro nombre NO se lo borramos.
   */
  private autoResponsable(vendedor: string | null): void {
    const manual = this.responsable.trim() && this.responsable !== this.respAuto;
    if (manual) return;
    const nombre = vendedor
      ? (this.catalogos()?.vendedores || []).find((v) => v.vendedor_code === vendedor)?.vendedor_nombre || ''
      : '';
    this.responsable = nombre;
    this.respAuto = nombre;
  }

  limpiar(): void {
    this.sel.set([]);
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const mia = ++this.peticion;
    const f = this.filtros();
    const q = {
      from: f.desde, to: f.hasta, search: f.search || undefined,
      vendedor_code: f.vendedor || undefined,
      cobro: f.cobro || undefined,
      vencidas: f.soloVencidas ? 'true' : undefined,
      pageSize: ComercialReportesCobranzaComponent.PAGE,
    };
    this.svc.list(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (mia !== this.peticion) return; // llegó tarde: manda la consulta nueva
        this.report.set(r);
        // La selección sobrevive al cambio de filtro sólo en lo que sigue existiendo: dejar
        // marcada una factura que ya no está en la lista imprimiría algo que nadie vio.
        const vivos = new Set(r.rows.map((d) => d.folio_digital));
        this.sel.update((s) => s.filter((d) => vivos.has(d.folio_digital)));
        this.loading.set(false);
      },
      error: (e) => {
        if (mia !== this.peticion) return;
        this.error.set(e?.error?.message || 'No se pudieron cargar las facturas.');
        this.loading.set(false);
      },
    });
    this.svc.filtros(q).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (c) => this.catalogos.set(c), error: () => undefined });
  }

  // ── guía de cobranza ───────────────────────────────────────────────────
  generar(imprimir: boolean): void {
    if (!this.listo()) return;
    const folios = this.sel().map((d) => d.folio_digital);
    this.busy.set(imprimir ? 'print' : 'pdf');
    this.svc.guiaCobranzaBlob(folios, { responsable: this.responsable || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (b) => {
          this.busy.set(null);
          const url = URL.createObjectURL(b);
          if (imprimir) this.imprimir(url); else window.open(url, '_blank');
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        },
        error: (e) => {
          this.busy.set(null);
          // El endpoint responde blob, así que el mensaje del backend viene DENTRO del blob:
          // sin leerlo, un "hay facturas canceladas en la selección" se vería como error genérico.
          this.mensaje(e).then((detail) => this.toast.add({
            severity: 'error', summary: 'No se pudo generar la guía', detail, life: 8000,
          }));
        },
      });
  }

  private async mensaje(e: any): Promise<string> {
    try {
      const cuerpo = e?.error instanceof Blob ? await e.error.text() : null;
      const json = cuerpo ? JSON.parse(cuerpo) : e?.error;
      const m = json?.message;
      return Array.isArray(m) ? m.join(' · ') : String(m || 'Intenta de nuevo.');
    } catch {
      return 'Intenta de nuevo.';
    }
  }

  /** Mismo camino que el anexo: iframe aislado y, si el visor no expone print(), pestaña nueva. */
  private imprimir(url: string): void {
    const ifr = document.createElement('iframe');
    ifr.style.position = 'fixed';
    ifr.style.right = '0';
    ifr.style.bottom = '0';
    ifr.style.width = '0';
    ifr.style.height = '0';
    ifr.style.border = '0';
    ifr.src = url;
    ifr.onload = () => {
      try {
        const w = ifr.contentWindow;
        if (!w) throw new Error('sin contentWindow');
        w.focus();
        w.print();
        setTimeout(() => ifr.remove(), 60_000);
      } catch {
        ifr.remove();
        window.open(url, '_blank');
        this.toast.add({
          severity: 'info', summary: 'Abrí el PDF en otra pestaña',
          detail: 'Este navegador no permite imprimir directo; usa el botón de imprimir del visor.',
          life: 6000,
        });
      }
    };
    document.body.appendChild(ifr);
  }
}
