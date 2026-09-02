import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { PageTabsComponent } from '../../../../shared/components/page-tabs/page-tabs.component';
import { CONTABILIDAD_TABS } from '../../contabilidad-tabs';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';
import { LibroComprasService, MesNoAsociado, MesDetalle, FacturaMes, ImpuestosModo } from '../../libro-compras.service';
import { NO_ASOCIADOS_STYLES } from './libro-compras.styles';

/**
 * Fase LC (ADR-052) — Movimientos no asociados.
 *
 * Es el propósito del módulo: sacar en TXT **lo que ContPAQi no tiene atado a ninguna
 * póliza**, para que contabilidad lo suba y cierre el trámite. No es el libro del mes
 * completo (eso es la otra pantalla, y solo aplica a un mes que nunca se subió).
 *
 * Dos cosas que la pantalla tiene que dejar claras porque cuestan dinero:
 *   1. **Cuánto falta**, por mes. Ago-2026 son 724 facturas por $48.2M sin contabilizar.
 *   2. **Qué NO hay que volver a mandar**: 271 facturas de 2026 por $32.6M no tienen marca
 *      de asociación pero su importe YA está en la póliza del mes. Pasa porque nuestro
 *      propio TXT no lleva UUID. Van marcadas y excluidas; incluirlas duplica el asiento.
 *
 * Layout de sector Fiscal/Contable (DESIGN §14): master-detail permanente + answer-first.
 */
@Component({
  selector: 'app-movimientos-no-asociados',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, DialogModule,
    SelectButtonModule, CheckboxModule, InputTextModule, ToastModule,
    MetricStripComponent, PageTabsComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [NO_ASOCIADOS_STYLES],
  template: `
    <p-toast />
    <app-page-tabs [tabs]="tabs" />

    <header class="lc-head">
      <div>
        <h1>Movimientos no asociados</h1>
        <p class="muted">
          Las facturas que ContPAQi no tiene ligadas a ninguna póliza. Aquí se revisan y se
          bajan en TXT; el archivo lo sube contabilidad, como siempre.
        </p>
      </div>
      <button pButton type="button" icon="pi pi-refresh" [text]="true"
              (click)="cargarMeses()" [loading]="cargandoMeses()"
              aria-label="Recargar los meses"></button>
    </header>

    <div class="lc-layout">
      <!-- ── Master: los meses, ordenados por lo que falta ─────────────────── -->
      <aside class="lc-meses" aria-label="Meses con movimientos sin asociar">
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
              <!-- La tarjeta muestra lo ACCIONABLE (lo que entra al TXT), el mismo número
                   que el encabezado del detalle. Mostrar aquí el total sin asociar y allá
                   el que entra hacía que el mismo mes se leyera con dos cifras distintas,
                   las dos rotuladas "por asociar". -->
              <div class="lc-mes-cifras">
                <span class="na-falta" [class.cero]="!m.entran">
                  {{ m.entran ? m.entran + ' entran al TXT' : 'nada que entregar' }}
                </span>
                @if (m.entran) {
                  <span class="mono">{{ m.monto_entran | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                }
              </div>
              @if (!m.existe_libro && m.cfdis) {
                <span class="na-mes-sinlibro">El mes no tiene póliza de compras</span>
              }
              @if (m.ya_posteados || m.fuera_catalogo) {
                <span class="na-mes-nota">
                  @if (m.ya_posteados) { {{ m.ya_posteados }} ya posteadas }
                  @if (m.ya_posteados && m.fuera_catalogo) { · }
                  @if (m.fuera_catalogo) { {{ m.fuera_catalogo }} de gasto }
                </span>
              }
            </button>
          }
        }
      </aside>

      <!-- ── Detail ────────────────────────────────────────────────────────── -->
      <section class="lc-detalle">
        @if (!mesSel()) {
          <div class="lc-empty lc-empty-lg">
            <i class="pi pi-link"></i>
            <p>Elige un mes para ver qué facturas quedaron sin asociar.</p>
          </div>
        } @else if (cargandoMes()) {
          <div class="lc-skel-bloque"></div>
        } @else if (detalle(); as d) {
          <div class="lc-veredicto" [class]="'v-' + veredicto().tono">
            <i [class]="veredicto().icono"></i>
            <div>
              <strong>{{ veredicto().titulo }}</strong>
              <span class="muted">{{ veredicto().detalle }}</span>
            </div>
            <div class="lc-acciones">
              @if (puedeGestionar()) {
                <button pButton type="button" label="Generar TXT" icon="pi pi-file-export"
                        [disabled]="!!d.bloqueantes.length || !d.resumen.incluidas || generando()"
                        [loading]="generando()" (click)="generar()"></button>
                @if (estadoRun() === 'generado' || estadoRun() === 'entregado') {
                  <button pButton type="button" label="Descargar" icon="pi pi-download"
                          severity="secondary" [outlined]="true" (click)="descargar()"></button>
                }
                @if (estadoRun() === 'generado') {
                  <button pButton type="button" label="Marcar entregado" icon="pi pi-send"
                          severity="secondary" [text]="true" (click)="dlgEntrega.set(true)"></button>
                }
                @if (estadoRun() === 'entregado') {
                  <button pButton type="button" label="Marcar aplicado" icon="pi pi-check-circle"
                          severity="secondary" [text]="true" (click)="marcar('aplicado')"></button>
                }
              }
            </div>
          </div>

          <app-metric-strip [items]="kpis()" ariaLabel="Desglose de lo que falta por asociar" />

          @if (contexto().length) {
            <p class="na-contexto">
              <span class="muted">Queda fuera del TXT:</span>
              @for (c of contexto(); track c.texto; let last = $last) {
                <span [class.warn]="c.tono === 'warn'">
                  {{ c.texto }}@if (c.monto) { <span class="mono"> ({{ c.monto | currency:'MXN':'symbol-narrow':'1.0-0' }})</span> }
                </span>@if (!last) { <span class="muted"> · </span> }
              }
            </p>
          }

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
            <label>
              <span class="muted">Impuestos</span>
              <p-selectbutton [options]="opcImpuestos" [(ngModel)]="impuestosModo" optionLabel="label"
                              optionValue="value" [allowEmpty]="false" aria-label="Cómo postear IVA e IEPS" />
            </label>
            <label class="lc-chk">
              <p-checkbox [(ngModel)]="incluirUuid" [binary]="true" inputId="na-uuid" />
              <span for="na-uuid">Poner el UUID en cada renglón</span>
            </label>
            <span class="lc-cuadre">
              Póliza {{ folioPoliza() }} del Diario · {{ d.resumen.incluidas }} facturas
            </span>
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
                  <th class="c-cta">Estado</th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr [class.excluida]="!f.incluida" [class.dup]="f.ya_en_poliza">
                  <td class="c-chk">
                    <p-checkbox [ngModel]="f.incluida" [binary]="true" [disabled]="!puedeGestionar()"
                                (ngModelChange)="alternar(f, $event)"
                                [ariaLabel]="'Incluir ' + f.emisor_nombre" />
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
                    @if (f.ya_en_poliza) {
                      <p-tag value="Ya en la póliza" severity="warn" />
                    } @else if (!f.account_suffix) {
                      <p-tag value="RFC sin cuenta" severity="danger" />
                    } @else if (!f.cuenta_existe) {
                      <p-tag value="Cuenta inexistente" severity="danger" />
                    } @else {
                      <span class="mono muted">{{ f.cuenta_proveedor }}</span>
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="10">
                  <div class="lc-empty">
                    <i class="pi pi-check-circle"></i>
                    <p>{{ nombreMes(mesSel()!) }} no tiene movimientos sin asociar.</p>
                    <small class="muted">Todas sus facturas ya están ligadas a una póliza.</small>
                  </div>
                </td></tr>
              </ng-template>
            </p-table>
          </div>
        }
      </section>
    </div>

    <p-dialog header="Marcar como entregado" [(visible)]="dlgEntregaVisible" [modal]="true" [style]="{ width: '26rem' }">
      <label class="lc-campo">
        <span>¿A quién se le entregó?</span>
        <input pInputText [(ngModel)]="entregadoA" placeholder="Nombre de quien lo sube a ContPAQi" />
      </label>
      <ng-template #footer>
        <button pButton type="button" label="Cancelar" [text]="true" (click)="dlgEntrega.set(false)"></button>
        <button pButton type="button" label="Confirmar" (click)="marcar('entregado')"></button>
      </ng-template>
    </p-dialog>
  `,
})
export class MovimientosNoAsociadosComponent implements OnInit {
  private svc = inject(LibroComprasService);
  private toast = inject(MessageService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly tabs = CONTABILIDAD_TABS;
  readonly opcImpuestos = [
    { label: 'Un renglón al mes', value: 'global' as ImpuestosModo },
    { label: 'Por proveedor', value: 'por-cuenta' as ImpuestosModo },
  ];

  meses = signal<MesNoAsociado[]>([]);
  detalle = signal<MesDetalle | null>(null);
  mesSel = signal<string | null>(null);
  cargandoMeses = signal(false);
  cargandoMes = signal(false);
  generando = signal(false);
  dlgEntrega = signal(false);
  impuestosModo: ImpuestosModo = 'global';
  incluirUuid = true;
  entregadoA = '';

  get dlgEntregaVisible() { return this.dlgEntrega(); }
  set dlgEntregaVisible(v: boolean) { this.dlgEntrega.set(v); }

  puedeGestionar = computed(() => {
    const u = this.auth.user();
    return u?.permissions?.[Permission.FISCAL_PURCHASE_BOOK_GESTIONAR] === true
      || u?.role_name === 'admin' || u?.role_name === 'superadmin';
  });

  estadoRun = computed(() => (this.detalle()?.run?.['estado'] as string) ?? 'sin_iniciar');
  folioPoliza = computed(() => Number(this.detalle()?.run?.['folio_poliza'] ?? 2));

  /**
   * La tira desglosa el total del asiento y **cuadra a la vista**:
   * `0% + c/IVA + IEPS + IVA = Falta por asociar`. El IEPS estaba faltando y por eso los
   * mosaicos no sumaban (en jul-2026 quedaban $54,912 sin explicar) — justo el concepto
   * que el Excel venía capturando en cero.
   *
   * Lo que NO se acciona (ya posteadas, fuera del catálogo) va aparte en `contexto()`, para
   * que no compita visualmente: en julio "ya posteadas" son $17.7M contra $1.27M del total
   * que sí importa, y siendo 14× más grande se robaba la lectura.
   */
  kpis = computed<MetricStripItem[]>(() => {
    const d = this.detalle();
    if (!d) return [];
    const r = d.resumen;
    return [
      { label: 'Falta por asociar', value: r.total, format: 'currency', tone: 'brand',
        sub: `${r.incluidas} facturas entran al TXT` },
      { label: 'Compras al 0%', value: r.subtotal_exento, format: 'currency' },
      { label: 'Compras c/IVA', value: r.subtotal_gravado, format: 'currency' },
      { label: 'IEPS acreditable', value: r.ieps, format: 'currency',
        tone: r.ieps > 0 ? 'ok' : 'default' },
      { label: 'IVA acreditable', value: r.iva, format: 'currency' },
    ];
  });

  /** Lo que queda FUERA del TXT, con su razón. Es control, no acción. */
  contexto = computed(() => {
    const d = this.detalle();
    if (!d) return [];
    const r = d.resumen;
    const fuera = r.cfdis_del_mes - r.incluidas - r.ya_posteadas;
    const out: { texto: string; monto: number; tono: string }[] = [];
    if (r.ya_posteadas) {
      out.push({ texto: `${r.ya_posteadas} ya están en la póliza del mes`, monto: r.monto_ya_posteadas, tono: 'warn' });
    }
    if (fuera > 0) {
      out.push({ texto: `${fuera} de proveedor de gasto o servicio`, monto: 0, tono: 'muted' });
    }
    return out;
  });

  /** El veredicto del mes en una línea, antes de la tabla (DESIGN §15 answer-first). */
  veredicto = computed(() => {
    const d = this.detalle();
    if (!d) return { tono: 'neutral', icono: 'pi pi-circle', titulo: '', detalle: '' };
    const estado = this.estadoRun();
    const r = d.resumen;
    if (estado === 'aplicado') {
      return { tono: 'ok', icono: 'pi pi-check-circle', titulo: 'Complemento aplicado',
        detalle: 'Lo que faltaba de este mes ya está en ContPAQi.' };
    }
    if (!r.cfdis_del_mes) {
      return { tono: 'ok', icono: 'pi pi-check-circle', titulo: 'Nada pendiente',
        detalle: 'Todas las facturas del mes están ligadas a una póliza.' };
    }
    if (d.bloqueantes.length) {
      return { tono: 'bad', icono: 'pi pi-exclamation-circle', titulo: 'No se puede generar todavía',
        detalle: 'Hay facturas que ContPAQi rechazaría. Resuélvelas o exclúyelas.' };
    }
    if (estado === 'entregado') {
      return { tono: 'warn', icono: 'pi pi-send', titulo: 'Entregado, falta confirmar',
        detalle: 'Cuando aparezca la póliza en ContPAQi, márcalo aplicado.' };
    }
    if (estado === 'generado') {
      return { tono: 'warn', icono: 'pi pi-file-check', titulo: 'Archivo generado',
        detalle: 'Descárgalo y pásalo a quien lo sube a ContPAQi.' };
    }
    if (!r.incluidas) {
      return { tono: 'warn', icono: 'pi pi-info-circle', titulo: 'Nada que entregar',
        detalle: `Las ${r.cfdis_del_mes} sin asociar son de proveedores fuera del catálogo de compras o ya están posteadas.` };
    }
    return { tono: 'bad', icono: 'pi pi-exclamation-triangle',
      titulo: `Faltan ${r.incluidas} movimientos por asociar`,
      detalle: `${this.money(r.total)} sin contabilizar en este mes.` };
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

  etiquetaEstado(m: MesNoAsociado) {
    if (m.estado === 'sin_iniciar') return m.faltan ? 'Pendiente' : 'Al día';
    return { borrador: 'Borrador', generado: 'Generado', entregado: 'Entregado', aplicado: 'Aplicado', cancelado: 'Cancelado' }[m.estado] ?? m.estado;
  }

  severidadEstado(m: MesNoAsociado): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
    if (m.estado === 'aplicado') return 'success';
    if (m.estado === 'entregado' || m.estado === 'generado') return 'warn';
    if (m.estado === 'cancelado') return 'danger';
    if (!m.faltan) return 'success';
    // Un mes sin póliza de compras no es un pendiente más: es el mes entero sin contabilizar.
    return m.existe_libro ? 'warn' : 'danger';
  }

  cargarMeses() {
    this.cargandoMeses.set(true);
    this.svc.listNoAsociados().subscribe({
      next: (r) => { this.meses.set(r); this.cargandoMeses.set(false); },
      error: (e) => { this.cargandoMeses.set(false); this.error('No se pudieron cargar los meses', e); },
    });
  }

  abrirMes(mes: string) {
    this.mesSel.set(mes);
    this.cargandoMes.set(true);
    // El mes queda en la URL para poder compartir la vista (DESIGN §10).
    this.router.navigate([], { relativeTo: this.route, queryParams: { mes }, replaceUrl: true });
    this.svc.getNoAsociados(mes).subscribe({
      next: (d) => {
        this.detalle.set(d);
        this.impuestosModo = (d.run?.['impuestos_modo'] as ImpuestosModo) ?? 'global';
        this.incluirUuid = d.run?.['incluye_uuid'] !== false;
        this.cargandoMes.set(false);
      },
      error: (e) => { this.cargandoMes.set(false); this.error('No se pudo abrir el mes', e); },
    });
  }

  /** Optimista: la fila cambia de inmediato y se revierte si el server dice que no. */
  alternar(f: FacturaMes, incluida: boolean) {
    const mes = this.mesSel(); if (!mes) return;
    // Incluir una que ya está posteada duplica el asiento. Se avisa y se deja pasar: puede
    // ser un falso positivo del cruce por importe (dos facturas del mismo monto), y quien
    // lleva el libro es quien sabe. El generador vuelve a frenar si sigue marcada.
    if (incluida && f.ya_en_poliza) {
      this.toast.add({ severity: 'warn', summary: 'Cuidado: se duplicaría',
        detail: `${this.money(f.total)} de ${f.emisor_nombre} ya aparece en la póliza del mes. Solo inclúyela si comprobaste que es otra factura.`,
        life: 9000 });
    }
    const antes = f.incluida;
    this.aplicarInclusionLocal(f.uuid, incluida);
    this.svc.setInclusionNoAsociados(mes, [f.uuid], incluida).subscribe({
      error: (e) => { this.aplicarInclusionLocal(f.uuid, antes); this.error('No se pudo cambiar la factura', e); },
    });
  }

  private aplicarInclusionLocal(uuid: string, incluida: boolean) {
    const d = this.detalle(); if (!d) return;
    const facturas = d.facturas.map((x) => (x.uuid === uuid ? { ...x, incluida } : x));
    const dentro = facturas.filter((x) => x.incluida);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    this.detalle.set({
      ...d, facturas,
      resumen: {
        ...d.resumen,
        incluidas: dentro.length,
        excluidas: facturas.length - dentro.length,
        total: r2(dentro.reduce((a, x) => a + x.total, 0)),
        subtotal_exento: r2(dentro.reduce((a, x) => a + x.base_exenta, 0)),
        subtotal_gravado: r2(dentro.reduce((a, x) => a + x.subtotal16, 0)),
        iva: r2(dentro.reduce((a, x) => a + x.iva, 0)),
        ieps: r2(dentro.reduce((a, x) => a + x.ieps, 0)),
      },
    });
  }

  generar() {
    const mes = this.mesSel(); if (!mes) return;
    this.generando.set(true);
    this.svc.generarNoAsociados(mes, this.impuestosModo, this.incluirUuid).subscribe({
      next: (r) => {
        this.generando.set(false);
        this.toast.add({ severity: 'success', summary: 'Complemento generado',
          detail: `${r.facturas} facturas · ${r.renglones} renglones · ${this.money(r.cargos)} · póliza ${r.folio}` });
        this.abrirMes(mes); this.cargarMeses();
      },
      error: (e) => { this.generando.set(false); this.error('No se pudo generar', e); },
    });
  }

  descargar() {
    const mes = this.mesSel(); if (!mes) return;
    this.svc.descargarNoAsociados(mes, this.impuestosModo, this.incluirUuid).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `complemento-compras-${mes}.txt`;
        a.click(); URL.revokeObjectURL(url);
      },
      error: (e) => this.error('No se pudo descargar', e),
    });
  }

  marcar(estado: 'entregado' | 'aplicado' | 'cancelado') {
    const mes = this.mesSel(); if (!mes) return;
    this.svc.marcarNoAsociados(mes, estado, { entregado_a: this.entregadoA || undefined }).subscribe({
      next: () => {
        this.dlgEntrega.set(false); this.entregadoA = '';
        this.toast.add({ severity: 'success', summary: 'Trámite actualizado', detail: `Complemento marcado como ${estado}.` });
        this.abrirMes(mes); this.cargarMeses();
      },
      error: (e) => this.error('No se pudo actualizar el trámite', e),
    });
  }

  private error(resumen: string, e: unknown) {
    const detalle = (e as { error?: { message?: string } })?.error?.message ?? 'Intenta de nuevo.';
    this.toast.add({ severity: 'error', summary: resumen, detail: detalle, life: 8000 });
  }
}
