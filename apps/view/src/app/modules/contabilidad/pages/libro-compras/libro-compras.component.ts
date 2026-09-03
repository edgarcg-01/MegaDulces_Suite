import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { PageTabsComponent } from '../../../../shared/components/page-tabs/page-tabs.component';
import { CONTABILIDAD_TABS } from '../../contabilidad-tabs';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';
import { LibroComprasService, MesResumen, MesDetalle, CuadreContpaqi } from '../../libro-compras.service';
import { LIBRO_COMPRAS_STYLES } from './libro-compras.styles';

/**
 * Fase LC (ADR-052) — Libro de Compras.
 *
 * El trámite mensual dejó de vivir en un Excel: aquí se ve el mes, se decide qué entra,
 * se genera el TXT y se registra que ya se subió. A ContPAQi solo va el archivo.
 *
 * Layout de sector Fiscal/Contable (DESIGN §14): master-detail permanente — la lista de
 * meses a la izquierda no desaparece al abrir uno. Y answer-first (§15): antes de la
 * tabla, el veredicto del mes en una línea.
 */
@Component({
  selector: 'app-libro-compras',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, DialogModule,
    CheckboxModule, InputTextModule, ToastModule,
    MetricStripComponent, PageTabsComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [LIBRO_COMPRAS_STYLES],
  template: `
    <p-toast />
    <app-page-tabs [tabs]="tabs" />

    <header class="lc-head">
      <div>
        <h1>Libro de Compras</h1>
        <p class="muted">
          El trámite se arma aquí y a ContPAQi solo va el TXT de la póliza. Lo sube contabilidad, como siempre.
        </p>
      </div>
      <!-- Componente p-button, NO la directiva con label/icon: en PrimeNG 22 la directiva
           pButton ya no tiene esos inputs, así que Angular los ignora y el botón sale
           VACÍO. Ver la nota en movimientos-no-asociados. -->
      <p-button type="button" icon="pi pi-refresh" styleClass="p-button-text"
                (click)="cargarMeses()" [loading]="cargandoMeses()"
                ariaLabel="Recargar los meses" />
    </header>

    <div class="lc-layout">
      <!-- ── Master: los meses ─────────────────────────────────────────────── -->
      <aside class="lc-meses" aria-label="Meses">
        @if (cargandoMeses()) {
          @for (i of [1,2,3,4,5,6]; track i) { <div class="lc-mes-skel"></div> }
        } @else if (!meses().length) {
          <div class="lc-empty">
            <i class="pi pi-inbox"></i>
            <p>No hay CFDIs recibidos cargados todavía.</p>
            <small class="muted">El feed del ADD de ContPAQi los trae; revisa que esté corriendo.</small>
          </div>
        } @else {
          @for (m of meses(); track m.anio_mes) {
            <button type="button" class="lc-mes" [class.sel]="mesSel() === m.anio_mes"
                    [attr.aria-current]="mesSel() === m.anio_mes" (click)="abrirMes(m.anio_mes)">
              <div class="lc-mes-top">
                <span class="lc-mes-nombre">{{ nombreMes(m.anio_mes) }}</span>
                <p-tag [value]="etiquetaEstado(m)" [severity]="severidadEstado(m)" />
              </div>
              <div class="lc-mes-cifras">
                <span class="mono">{{ m.cfdis }} CFDIs</span>
                <span class="mono">{{ m.total_cfdis | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              </div>
              @if (!m.patas_en_contpaqi && m.cfdis) {
                <span class="lc-mes-alerta">Sin póliza en ContPAQi</span>
              }
            </button>
          }
        }
      </aside>

      <!-- ── Detail: el mes ────────────────────────────────────────────────── -->
      <section class="lc-detalle">
        @if (!mesSel()) {
          <div class="lc-empty lc-empty-lg">
            <i class="pi pi-book"></i>
            <p>Elige un mes para ver sus facturas y armar la póliza.</p>
          </div>
        } @else if (cargandoMes()) {
          <div class="lc-skel-bloque"></div>
        } @else if (detalle(); as d) {
          <!-- Answer-first: el veredicto antes que el grid -->
          <div class="lc-veredicto" [class]="'v-' + veredicto().tono">
            <i [class]="veredicto().icono"></i>
            <div>
              <strong>{{ veredicto().titulo }}</strong>
              <span class="muted">{{ veredicto().detalle }}</span>
            </div>
            <div class="lc-acciones">
              @if (estadoRun() === 'generado' || estadoRun() === 'entregado') {
                <p-button type="button" label="Descargar" icon="pi pi-download"
                          styleClass="p-button-outlined p-button-secondary" (click)="descargar()" />
              }
              <p-button type="button" label="Ir a movimientos no asociados" icon="pi pi-arrow-right"
                        iconPos="right" styleClass="p-button-text"
                        (click)="irANoAsociados()" />
            </div>
          </div>

          <!-- Esta pantalla es de LECTURA. El libro completo del mes ya no se genera: su
               universo arrastra los CFDIs que ContPAQi YA tiene asociados y los duplicaría,
               que es una vía de doble registro que el filtro por importe no cubre. Lo que se
               entrega sale del sub-módulo; si el mes no tiene póliza, ahí se le cambia el
               folio a 1 y el complemento ES el libro. -->
          <p class="lc-solo-lectura">
            <i class="pi pi-info-circle"></i>
            Vista de lectura: acá se ve el mes completo y su cuadre contra ContPAQi.
            <strong>El archivo se genera desde Movimientos no asociados</strong>, que es lo
            único que se puede entregar sin duplicar asientos.
          </p>

          <app-metric-strip [items]="kpis()" ariaLabel="Totales del mes" />

          @if (d.bloqueantes.length) {
            <ul class="lc-avisos lc-bloq" aria-label="Lo que impide generar">
              @for (a of d.bloqueantes; track a) { <li><i class="pi pi-times-circle"></i>{{ a }}</li> }
            </ul>
          }
          @if (d.avisos.length) {
            <ul class="lc-avisos lc-info" aria-label="Cosas que vale la pena revisar">
              @for (a of d.avisos; track a) { <li><i class="pi pi-info-circle"></i>{{ a }}</li> }
            </ul>
          }

          <div class="lc-opciones">
            @if (cuadre(); as c) {
              <span class="lc-cuadre" [class.ok]="c.existe_en_contpaqi && !c.solo_contpaqi && !c.solo_nuestro">
                ContPAQi: {{ c.patas_en_contpaqi }} renglones · casan {{ c.casan }}
              </span>
            }
          </div>

          <div class="lc-tablewrap">
            <p-table [value]="d.facturas" styleClass="p-datatable-sm" [rowHover]="true"
                     [scrollable]="true" scrollHeight="52vh" [paginator]="d.facturas.length > 100"
                     [rows]="100" dataKey="uuid">
              <ng-template #header>
                <tr>
                  <th class="c-chk"></th>
                  <th>Proveedor</th>
                  <th class="c-num">Folio</th>
                  <th class="c-num">Fecha</th>
                  <th class="c-num">Exento</th>
                  <th class="c-num">Gravado 16%</th>
                  <th class="c-num">IEPS</th>
                  <th class="c-num">IVA</th>
                  <th class="c-num">Total</th>
                  <th class="c-cta">Cuentas</th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr [class.excluida]="!f.incluida">
                  <td class="c-chk">
                    <!-- Sólo indicador: la decisión de qué entra se toma en el sub-módulo,
                         que es el único que genera archivo. -->
                    <p-checkbox [ngModel]="f.incluida" [binary]="true" [disabled]="true"
                                [ariaLabel]="f.incluida ? 'Entra al asiento' : 'Fuera del asiento'" />
                  </td>
                  <td>
                    <span class="lc-prov">{{ f.emisor_nombre }}</span>
                    <small class="muted mono">{{ f.emisor_rfc }}</small>
                    @if (f.ieps_por_cuota) {
                      <p-tag value="IEPS por cuota" severity="warn" [rounded]="true" />
                    }
                    @if (!f.incluida && f.motivo_exclusion) {
                      <small class="muted">Excluida: {{ f.motivo_exclusion }}</small>
                    }
                  </td>
                  <td class="c-num mono">{{ f.folio }}</td>
                  <td class="c-num mono">{{ f.fecha }}</td>
                  <td class="c-num mono">{{ f.base_exenta | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono">{{ f.subtotal16 | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono">{{ f.ieps | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono">{{ f.iva | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-num mono strong">{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="c-cta">
                    @if (f.account_suffix && f.cuenta_existe) {
                      <span class="mono muted">{{ f.cuenta_proveedor }}</span>
                    } @else if (!f.account_suffix) {
                      <p-tag value="RFC sin cuenta" severity="danger" />
                    } @else {
                      <p-tag value="Cuenta inexistente" severity="danger" />
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="10">
                  <div class="lc-empty">
                    <i class="pi pi-file"></i>
                    <p>{{ nombreMes(mesSel()!) }} no tiene CFDIs de proveedor cargados.</p>
                  </div>
                </td></tr>
              </ng-template>
            </p-table>
          </div>
        }
      </section>
    </div>

  `,
})
export class LibroComprasComponent implements OnInit {
  private svc = inject(LibroComprasService);
  private toast = inject(MessageService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly tabs = CONTABILIDAD_TABS;

  meses = signal<MesResumen[]>([]);
  detalle = signal<MesDetalle | null>(null);
  cuadre = signal<CuadreContpaqi | null>(null);
  mesSel = signal<string | null>(null);
  cargandoMeses = signal(false);
  cargandoMes = signal(false);


  puedeGestionar = computed(() => {
    const u = this.auth.user();
    return u?.permissions?.[Permission.FISCAL_PURCHASE_BOOK_GESTIONAR] === true
      || u?.role_name === 'admin' || u?.role_name === 'superadmin';
  });

  estadoRun = computed(() => (this.detalle()?.run?.['estado'] as string) ?? 'sin_iniciar');

  kpis = computed<MetricStripItem[]>(() => {
    const d = this.detalle();
    if (!d) return [];
    const r = d.resumen;
    return [
      { label: 'Total del asiento', value: r.total, format: 'currency', tone: 'brand',
        sub: `${r.incluidas} de ${r.cfdis_del_mes} facturas` },
      { label: 'Compras al 0%', value: r.subtotal_exento, format: 'currency' },
      { label: 'Compras c/IVA', value: r.subtotal_gravado, format: 'currency' },
      { label: 'IEPS acreditable', value: r.ieps, format: 'currency',
        tone: r.ieps > 0 ? 'ok' : 'default' },
      { label: 'IVA acreditable', value: r.iva, format: 'currency' },
    ];
  });

  /** El veredicto del mes en una línea, antes de la tabla (DESIGN §15 answer-first). */
  veredicto = computed(() => {
    const d = this.detalle();
    if (!d) return { tono: 'neutral', icono: 'pi pi-circle', titulo: '', detalle: '' };
    const estado = this.estadoRun();
    const c = this.cuadre();
    if (estado === 'aplicado') {
      return { tono: 'ok', icono: 'pi pi-check-circle', titulo: 'Aplicado en ContPAQi',
        detalle: 'El trámite del mes está cerrado.' };
    }
    if (d.bloqueantes.length) {
      return { tono: 'bad', icono: 'pi pi-exclamation-circle', titulo: 'No se puede generar todavía',
        detalle: 'Hay facturas que ContPAQi rechazaría. Resuélvelas o exclúyelas.' };
    }
    if (estado === 'entregado') {
      return { tono: 'warn', icono: 'pi pi-send', titulo: 'Entregado, falta confirmar',
        detalle: c?.existe_en_contpaqi ? 'Ya aparece una póliza en ContPAQi: revisa el cuadre y márcalo aplicado.'
          : 'Todavía no aparece la póliza en ContPAQi.' };
    }
    if (estado === 'generado') {
      return { tono: 'warn', icono: 'pi pi-file-check', titulo: 'Archivo generado',
        detalle: 'Descárgalo y pásalo a quien lo sube a ContPAQi.' };
    }
    if (c && !c.existe_en_contpaqi) {
      return { tono: 'bad', icono: 'pi pi-exclamation-triangle', titulo: 'Este mes no tiene póliza en ContPAQi',
        detalle: `${d.resumen.incluidas} facturas por ${this.money(d.resumen.total)} sin contabilizar.` };
    }
    return { tono: 'neutral', icono: 'pi pi-clock', titulo: 'Listo para generar',
      detalle: `${d.resumen.incluidas} facturas por ${this.money(d.resumen.total)}.` };
  });

  ngOnInit() {
    this.cargarMeses();
    const mes = this.route.snapshot.queryParamMap.get('mes');
    if (mes) this.abrirMes(mes);
  }

  private money(n: number) {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
  }

  nombreMes(anioMes: string) {
    const [y, m] = anioMes.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, 1)));
  }

  etiquetaEstado(m: MesResumen) {
    if (m.estado === 'sin_iniciar') return m.patas_en_contpaqi ? 'En ContPAQi' : 'Sin armar';
    return { borrador: 'Borrador', generado: 'Generado', entregado: 'Entregado', aplicado: 'Aplicado', cancelado: 'Cancelado' }[m.estado] ?? m.estado;
  }

  severidadEstado(m: MesResumen): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
    if (m.estado === 'aplicado') return 'success';
    if (m.estado === 'entregado' || m.estado === 'generado') return 'warn';
    if (m.estado === 'cancelado') return 'danger';
    if (m.patas_en_contpaqi) return 'info';
    return m.cfdis ? 'danger' : 'secondary';
  }

  cargarMeses() {
    this.cargandoMeses.set(true);
    this.svc.listMeses().subscribe({
      next: (r) => { this.meses.set(r); this.cargandoMeses.set(false); },
      error: (e) => { this.cargandoMeses.set(false); this.error('No se pudieron cargar los meses', e); },
    });
  }

  abrirMes(mes: string) {
    this.mesSel.set(mes);
    this.cargandoMes.set(true);
    this.cuadre.set(null);
    // El mes queda en la URL para poder compartir la vista (DESIGN §10).
    this.router.navigate([], { relativeTo: this.route, queryParams: { mes }, replaceUrl: true });
    this.svc.getMes(mes).subscribe({
      next: (d) => {
        this.detalle.set(d);
        this.cargandoMes.set(false);
      },
      error: (e) => { this.cargandoMes.set(false); this.error('No se pudo abrir el mes', e); },
    });
    this.svc.cuadre(mes).subscribe({ next: (c) => this.cuadre.set(c), error: () => this.cuadre.set(null) });
  }

  /** El archivo se entrega desde el sub-módulo: es el único que no duplica asientos. */
  irANoAsociados() {
    const mes = this.mesSel();
    this.router.navigate(['/contabilidad/movimientos-no-asociados'], mes ? { queryParams: { mes } } : {});
  }

  descargar() {
    const mes = this.mesSel(); if (!mes) return;
    this.svc.descargar(mes).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `poliza-compras-${mes}.txt`;
        a.click(); URL.revokeObjectURL(url);
      },
      error: (e) => this.error('No se pudo descargar', e),
    });
  }

  private error(resumen: string, e: unknown) {
    const detalle = (e as { error?: { message?: string } })?.error?.message ?? 'Intenta de nuevo.';
    this.toast.add({ severity: 'error', summary: resumen, detail: detalle, life: 8000 });
  }
}
