import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ComprasService, RequisitionDetail, RequisitionEstado, saveXlsxResponse } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Fase RA (ADR-030) — detalle de requisición + aprobar/rechazar (HITL). */
@Component({
  selector: 'app-compras-requisicion-detalle',
  standalone: true,
  imports: [RouterLink, CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule, DialogModule, TextareaModule, MetricStripComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in rd-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <a pButton class="p-button-text p-button-sm rd-back" [routerLink]="['/compras/requisiciones']" [queryParams]="{ tab: req()?.source_type === 'branch' ? 'branch' : 'supplier' }"><span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">Requisiciones</span></a>
          @if (req(); as r) {
            <h1>
              {{ r.folio }}
              @if (r.source_type === 'branch') {
                <p-tag value="Traspaso" severity="info"></p-tag>
              }
              <!-- [AB.29] La pidió una sucursal desde Autoabasto: rechazarla pide motivo. -->
              @if (r.requested_by_branch) {
                <p-tag value="Pedida por la sucursal" severity="info"></p-tag>
              }
              <p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag>
            </h1>
            <p class="surf-page-sub">
              @if (r.source_type === 'branch') {
                Traspaso: <strong>{{ r.source_warehouse_code || 'CEDIS' }}</strong> ({{ r.source_warehouse_name || 'Origen' }}) → <strong>{{ r.warehouse_code }}</strong> ({{ r.warehouse_name }}) · {{ r.total_lines }} líneas · objetivo {{ basisLabel(r.target_basis) }}
              } @else {
                <!-- [RQ.8] La COMPRA dice DÓNDE ENTREGA, que no es lo mismo que para quién es.
                     Antes esta línea mostraba un solo almacén y las sucursales destino vivían en
                     notes como texto libre: 48 compras consolidadas por $7.42M se veían
                     idénticas a una entrega directa. -->
                Proveedor: <strong>{{ r.supplier_name || 'Varios' }}</strong> · entrega en
                <strong>{{ r.warehouse_code }}</strong> ({{ r.warehouse_name }}) · {{ r.total_lines }} líneas · objetivo {{ basisLabel(r.target_basis) }}
              }
            </p>
          }
        </div>
        @if (req(); as r) {
          <div class="rd-actions">
            <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [loading]="exporting()" (click)="exportXlsx()"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">Exportar Excel</span></button>
            @if (canManage) {
              @if (r.estado === 'pending_approval' || r.estado === 'approved') {
                <!-- [RQ.1] La salida del freno, y de UN clic. Trae los costos de hoy sin tocar las
                     cantidades: cuánto pedir es decisión del comprador. -->
                <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="recalc()" (click)="recalcular()"
                        [attr.title]="'Trae el costo de hoy a cada renglón. No cambia las cantidades.'"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Recalcular costos</span></button>
              }
              @if (r.estado === 'pending_approval') {
                <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [loading]="busy()" (click)="abrirRechazo()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
                <button pButton type="button" class="p-button-sm" [loading]="busy()" (click)="approve()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Aprobar</span></button>
              } @else if (r.estado === 'approved') {
                <button pButton type="button" class="p-button-sm" [loading]="busy()" (click)="generatePO()"><span class="p-button-icon p-button-icon-left pi" [ngClass]="r.source_type === 'branch' ? 'pi-send' : 'pi-shopping-cart'" aria-hidden="true"></span><span class="p-button-label">{{ r.source_type === 'branch' ? 'Generar orden de traspaso' : 'Generar orden de compra' }}</span></button>
              } @else if (r.estado === 'ordered' || r.estado === 'received') {
                <button pButton type="button" class="p-button-sm p-button-outlined" (click)="goToPO()"><span class="p-button-icon p-button-icon-left pi pi-arrow-right" aria-hidden="true"></span><span class="p-button-label">{{ r.source_type === 'branch' ? 'Ver orden de traspaso' : 'Ver orden de compra' }}</span></button>
              }
            }
          </div>
        }
      </header>

      @if (req(); as r) {
        <!-- [RQ.1] LA VIGENCIA, ANTES DE LA TABLA. Medido en prod el 2026-10-06 sobre las 610
             pendientes: el costo capturado ya se había movido en el 83.5 % de los renglones de
             31-60 días y en el 98.7 % de los de 60+. Aprobar eso es ordenar a un precio que no
             existe, y la ficha no lo decía en ningún lado. Las TRES salidas llevan rótulos
             distintos a propósito: "sin medir" no es "al día" (ADR-056). -->
        <!-- [RQ.8] DE DÓNDE VIENE Y A DÓNDE VA. Se DERIVA de la FK bajada→compra, no se copia:
             las sucursales destino de una compra consolidada SON los destinos de sus bajadas. -->
        @if (r.bajadas?.length) {
          <div class="rd-ruta" role="status">
            <i class="pi pi-sitemap" aria-hidden="true"></i>
            <span>Esta compra <strong>se consolida</strong>: entrega en <strong>{{ r.warehouse_code | sucursal }}</strong> y baja por traspaso a
              @for (b of r.bajadas; track b.id) {<a class="rd-ruta-l" [routerLink]="['/compras/requisiciones', b.id]">{{ b.code }}</a>@if (!$last) {<span>, </span>}}
              — {{ r.bajadas.length }} traspaso(s) generado(s) con ella.</span>
          </div>
        }
        @if (r.origen; as o) {
          <div class="rd-ruta" role="status">
            <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
            <span>Este traspaso <strong>baja una compra</strong>: <a class="rd-ruta-l" [routerLink]="['/compras/requisiciones', o.id]">{{ o.folio }}</a>
              @if (o.supplier_name) { a {{ o.supplier_name }} }({{ estadoLabel($any(o.estado)) }}).</span>
          </div>
        }
        <!-- [KR.8] DÓNDE ESTÁ ESTA REQUISICIÓN EN KEPLER. Cuatro salidas, no dos: medido el
             2026-10-13, el 73 % de las requisiciones son traspasos y Kepler NO tiene documento
             que los reciba (N-A-6 / N-D-6 están muertos en las nueve sucursales). Sin
             declararlo, alguien buscaría en el ERP pedidos que nunca estuvieron.
             SIN ACENTOS GRAVES ACÁ: esto vive dentro de un template literal y un backtick
             cierra la cadena. Van siete veces que rompe el build de este repo. -->
        @if (keplerBanner(r); as kb) {
          <div class="rd-ruta" [class.rd-ruta-tenue]="kb.tenue" role="status">
            <i class="pi" [ngClass]="kb.icono" aria-hidden="true"></i>
            <span>{{ kb.texto }}</span>
            @if (kb.reintentable && canManage) {
              <button pButton type="button" class="p-button-sm p-button-text" [loading]="pushing()" (click)="pushKepler()"><span class="p-button-icon p-button-icon-left pi pi-replay" aria-hidden="true"></span><span class="p-button-label">Reintentar</span></button>
            }
          </div>
        }
        @if (r.lote; as l) {
          <div class="rd-ruta rd-ruta-tenue" role="status">
            <i class="pi pi-objects-column" aria-hidden="true"></i>
            <span>Salió del lote <strong>{{ l.folio || 'sin folio' }}</strong>, junto con otros <strong>{{ l.documentos - 1 }}</strong> documento(s).
              <a class="rd-ruta-l" routerLink="/compras/requisiciones">Ver el lote</a></span>
          </div>
        }
        @if (vigBanner(r); as b) {
          <div class="rd-vig" [ngClass]="b.cls" role="status">
            <i class="pi" [ngClass]="b.icono" aria-hidden="true"></i>
            <span>{{ b.texto }}</span>
          </div>
        }
        <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen de la requisición" />

        <p-table [value]="r.lines" styleClass="p-datatable-sm rd-table">
          <ng-template #header>
            <tr>
              <th>SKU</th><th>Producto</th><th>Origen</th>
              <th class="rd-r">Existencia</th><th class="rd-r">Reorden</th><th class="rd-r">Sugerido</th>
              <th class="rd-r">Pedir</th>
              @if (showRecibido()) { <th class="rd-r">Recibido</th> }
              <th class="rd-r">Costo unit.</th><th class="rd-r">Importe</th>
            </tr>
          </ng-template>
          <ng-template #body let-l>
            <tr>
              <td class="rd-mono">{{ l.sku }}</td>
              <td>{{ l.nombre }}</td>
              <td class="rd-muted">
                @if (l.source_type === 'branch') { <span class="rd-src-branch">Traspaso</span> }
                @else { {{ l.supplier_name || 'Proveedor' }} }
              </td>
              <td class="rd-r rd-muted">{{ l.on_hand | number:'1.0-0' }}</td>
              <td class="rd-r rd-muted">{{ l.reorder_point | number:'1.0-0' }}</td>
              <td class="rd-r rd-muted">{{ l.suggested_qty | number:'1.0-0' }}</td>
              <td class="rd-r rd-strong">{{ l.final_qty | number:'1.0-0' }}</td>
              @if (showRecibido()) {
                <td class="rd-r">{{ l.received_qty != null ? (l.received_qty | number:'1.0-0') : '—' }}
                  @if (l.received_qty != null && l.final_qty > 0) { <span class="rd-fill">{{ (l.received_qty / l.final_qty) | percent:'1.0-0' }}</span> }
                </td>
              }
              <td class="rd-r" [class.rd-movido]="l.costo_movido === true">{{ money(l.unit_cost) }}
                <!-- [RQ.1] El costo de HOY al lado del capturado, y sólo cuando NO coinciden:
                     repetirlo en los 130 renglones sanos sería ruido. NULL se declara con
                     "sin medir", nunca con un cero (un cero acá diría "hoy no cuesta nada"). -->
                @if (l.costo_movido === true) { <span class="rd-hoy" title="Costo de hoy según el plan vigente">hoy {{ money(l.costo_hoy) }}</span> }
                @else if (l.costo_movido === null) { <span class="rd-sinmedir" title="Este producto no tiene costo comparable hoy en este almacén">sin medir</span> }
              </td>
              <td class="rd-r">{{ money(l.line_cost) }}</td>
            </tr>
          </ng-template>
        </p-table>
      } @else if (!loading()) {
        <p class="rd-empty">Requisición no encontrada.</p>
      }
      <!-- [AB.32] Rechazar: si la pidió una sucursal, el motivo es obligatorio y la sucursal lo ve. -->
      <p-dialog [visible]="rechazoAbierto()" (visibleChange)="rechazoAbierto.set($event)" [modal]="true" [style]="{ width: '32rem' }"
                [breakpoints]="{ '40rem': '95vw' }" header="Rechazar requisición" [dismissableMask]="!busy()">
        <p class="rd-rech-p">
          @if (req()?.requested_by_branch) {
            La pidió una sucursal desde Autoabasto: <strong>escribe el motivo</strong>. La sucursal lo va a ver para saber si volver a pedirlo.
          } @else {
            Puedes dejar el motivo; queda guardado con quién la rechazó y cuándo.
          }
        </p>
        <label class="rd-rech-lab" for="rd-rech-motivo">Motivo @if (!req()?.requested_by_branch) { <span class="rd-muted">(opcional)</span> }</label>
        <textarea pTextarea id="rd-rech-motivo" class="rd-rech-motivo" rows="3" maxlength="500"
                  [ngModel]="motivoRechazo()" (ngModelChange)="motivoRechazo.set($event)"
                  placeholder="Por ejemplo: la matriz no tiene existencia; se compra directo la otra semana"></textarea>
        <ng-template #footer>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="rechazoAbierto.set(false)" [disabled]="busy()">
            <span class="p-button-label">Cancelar</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-danger" (click)="reject()"
                  [disabled]="busy() || (!!req()?.requested_by_branch && !motivoRechazo().trim())">
            <span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span>
            <span class="p-button-label">Rechazar</span>
          </button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    /* [AB.32] Rechazar con motivo */
    .rd-rech-p { margin: 0 0 .6rem; font-size: var(--fs-sm); line-height: 1.45; }
    .rd-rech-lab { display: block; margin-bottom: .25rem; font-size: var(--fs-sm); font-weight: 600; }
    .rd-rech-motivo { width: 100%; }
    .rd-muted { color: var(--text-muted); font-weight: 400; }
    :host { display: block; }
    .rd-back { margin-bottom: .25rem; margin-left: -.5rem; }
    .surf-page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .rd-actions { display: flex; gap: .5rem; }
    app-metric-strip { display:block; margin: 1rem 0; }
    .rd-table { font-size: .84rem; }
    .rd-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rd-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .8rem; }
    .rd-muted { color: var(--text-muted); } .rd-strong { font-weight: 700; }
    .rd-src-branch { color: var(--action); font-weight: 600; }
    .rd-fill { margin-left: .35rem; font-size: .72rem; color: var(--text-muted); }
    /* [RQ.1] Vigencia: tres estados, tres lecturas. El gris NO es el verde — "no se midió" es su
       propio resultado y se ve distinto a propósito. */
    /* [RQ.8] De dónde viene y a dónde va. */
    .rd-ruta { display: flex; align-items: center; gap: .6rem; margin: .75rem 0 0;
               padding: .5rem .7rem; border-radius: var(--radius-md);
               border: 1px solid var(--surface-border); background: var(--surface-card); font-size: var(--fs-sm); }
    .rd-ruta i { color: var(--action); }
    .rd-ruta-tenue { opacity: .85; }
    .rd-ruta-tenue i { color: var(--text-muted); }
    .rd-ruta-l { font-weight: 600; }
    .rd-vig { display: flex; align-items: center; gap: .6rem; margin: 1rem 0 0;
              padding: .6rem .8rem; border-radius: var(--radius-md); border: 1px solid; font-size: var(--fs-body); }
    .rd-vig-ok { border-color: var(--ok-border); background: var(--ok-soft-bg); }
    .rd-vig-ok i { color: var(--ok-soft-fg); }
    .rd-vig-mal { border-color: var(--warn-border); background: var(--warn-soft-bg); }
    .rd-vig-mal i { color: var(--warn-soft-fg); }
    .rd-vig-gris { border-color: var(--surface-border); background: var(--surface-card); }
    .rd-vig-gris i { color: var(--text-muted); }
    .rd-movido { color: var(--warn-soft-fg); font-weight: 700; }
    .rd-hoy, .rd-sinmedir { display: block; font-size: var(--fs-xs); font-weight: 500; color: var(--text-muted); }
    .rd-empty { color: var(--text-muted); padding: 2rem; text-align: center; }
  `],
})
export class ComprasRequisicionDetalleComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  req = signal<RequisitionDetail | null>(null);

  kpiItems(r: RequisitionDetail): MetricStripItem[] {
    const fmtDate = (d: any) => d ? new Date(d).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const items: MetricStripItem[] = [
      { label: 'Unidades', value: r.total_units },
      { label: 'Costo estimado', value: r.total_cost, format: 'currency', tone: 'brand' },
      { label: 'Creada', value: fmtDate(r.created_at), format: 'text' },
    ];
    if (r.notes) items.push({ label: 'Nota', value: r.notes, format: 'text' });
    // `[AB.32]` Por qué se rechazó, con la misma voz que la ve la sucursal.
    if (r.rejection_reason) items.push({ label: 'Motivo del rechazo', value: r.rejection_reason, format: 'text', tone: 'bad' });
    return items;
  }
  loading = signal(true);
  busy = signal(false);
  exporting = signal(false);
  canManage = this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMPRAS_REQUISICIONES_GESTIONAR];
  private id = '';

  /** Export XLSX con diseño (header + líneas + totales). Disponible en cualquier estado. */
  exportXlsx(): void {
    const r = this.req(); if (!r) return;
    this.exporting.set(true);
    this.api.exportRequisitionXlsx(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (resp) => { this.exporting.set(false); saveXlsxResponse(resp, `${r.folio}.xlsx`); },
      error: () => { this.exporting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo exportar.' }); },
    });
  }

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') || '';
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.getRequisition(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.req.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.req.set(null); },
    });
  }

  approve(): void {
    this.busy.set(true);
    this.api.approve(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // `[KR.5]` Aprobar y "salió a Kepler" son DOS hechos: el primero siempre ocurre, el
      // segundo puede rebotar sin voltearlo. Un solo «Aprobada» los juntaría y dejaría creyendo
      // que el ERP ya la tiene.
      next: (r) => {
        this.busy.set(false);
        const k = r?.kepler;
        if (k?.estado === 'entregada') this.toast.add({ severity: 'success', summary: 'Aprobada', detail: `Escrita en Kepler con folio ${k.folio}.` });
        else if (k?.estado === 'no_salio') this.toast.add({ severity: 'warn', life: 14000, summary: 'Aprobada, pero NO salió a Kepler', detail: `${k.motivo} — se puede reintentar desde esta ficha.` });
        else this.toast.add({ severity: 'success', summary: 'Aprobada' });
        this.load();
      },
      // `[RQ.3]` El freno del servidor DICE por qué y cuál es la salida. Taparlo con un
      // "No se pudo aprobar" genérico dejaría al comprador sin saber que un clic lo resuelve.
      error: (e) => {
        this.busy.set(false);
        this.toast.add({ severity: 'warn', summary: 'No se aprobó', life: 12000, detail: e?.error?.message || 'No se pudo aprobar.' });
      },
    });
  }

  pushing = signal(false);
  /**
   * `[KR.8]` Dónde está esta requisición respecto de Kepler. **Cuatro salidas, y ninguna se
   * puede leer como otra** (ADR-056):
   *
   *  - **Traspaso** → no existe `X-A-30` que lo reciba. No es un error ni algo pendiente: es que
   *    el documento no existe en el ERP. Es el **73 % del volumen**, así que callarlo haría que
   *    alguien buscara en Kepler pedidos que nunca estuvieron.
   *  - **Salió** → folio del ERP, que es lo que se busca en Kepler.
   *  - **Salió y falló** → el motivo, para que una persona lo arregle. Reintentable.
   *  - **Todavía no salió** → aprobada en lote, o la integración apagada. Reintentable.
   *
   * ⛔ Devuelve `null` mientras la requisición no esté aprobada: antes de eso no hay nada que
   * decir, y un cartel de "no salió" en una pendiente se leería como una falla.
   */
  keplerBanner(r: RequisitionDetail): { texto: string; icono: string; tenue: boolean; reintentable: boolean } | null {
    if (r.estado === 'pending_approval' || r.estado === 'draft' || r.estado === 'cancelled') return null;
    // `[KR.10]` Compra y traspaso salen como DOCUMENTOS DISTINTOS, y decirlo importa: quien
    // lo busque en Kepler tiene que saber si abre Requisición de compra o Pedido de traspaso.
    const doc = r.source_type === 'branch' ? 'pedido de traspaso' : 'requisición';
    if (r.kepler_folio) {
      return { icono: 'pi-check-circle', tenue: true, reintentable: false,
        texto: `En Kepler como ${doc} ${r.kepler_sucursal}/${r.kepler_folio}.` };
    }
    if (r.kepler_error) {
      return { icono: 'pi-exclamation-triangle', tenue: false, reintentable: true,
        texto: `No se pudo escribir en Kepler: ${r.kepler_error}` };
    }
    return { icono: 'pi-clock', tenue: false, reintentable: true,
      texto: 'Todavía no se escribió en Kepler. Se aprobó en lote, o la integración está apagada en este despliegue.' };
  }

  /** `[KR.4]` Reintento manual. Idempotente del lado del servidor. */
  pushKepler(): void {
    this.pushing.set(true);
    this.api.pushKepler(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.pushing.set(false);
        this.toast.add({ severity: 'success', summary: r.ya_estaba ? 'Ya estaba en Kepler' : 'Escrita en Kepler', detail: `Folio ${r.kepler?.folio}.` });
        this.load();
      },
      // ⭐ El servidor dice CUÁLES SKUs no resolvieron y por qué. Taparlo con un genérico deja a
      // quien aprueba sin nada que arreglar — que es la diferencia entre un aviso y un estorbo.
      error: (e) => {
        this.pushing.set(false);
        const malas: Array<{ sku: string; motivo?: string }> = e?.error?.lineas ?? [];
        const det = malas.length
          ? malas.slice(0, 4).map((l) => `${l.sku}: ${l.motivo}`).join(' · ') + (malas.length > 4 ? ` · y ${malas.length - 4} más` : '')
          : (e?.error?.message || 'No se pudo escribir en Kepler.');
        this.toast.add({ severity: 'warn', summary: 'No salió a Kepler', life: 16000, detail: det });
        this.load();
      },
    });
  }

  recalc = signal(false);
  /** `[RQ.1]` Trae los costos de hoy. Sólo el costo: las cantidades son del comprador. */
  recalcular(): void {
    this.recalc.set(true);
    this.api.recalcularRequisicion(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.recalc.set(false);
        this.toast.add({
          severity: r.renglones_actualizados ? 'success' : 'info',
          summary: r.renglones_actualizados ? `${r.renglones_actualizados} renglón(es) al costo de hoy` : 'Ya estaban al día',
          detail: `Nuevo total: ${this.money(r.total_cost)}`, life: 8000,
        });
        this.load();
      },
      error: (e) => {
        this.recalc.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo recalcular', detail: e?.error?.message || 'Intenta de nuevo.' });
      },
    });
  }

  /**
   * `[RQ.1]` El banner de vigencia. TRES salidas, con rótulos distintos porque piden trabajos
   * distintos: al día (seguí), movido (recalculá), sin medir (nadie lo comprobó — no es lo mismo
   * que estar bien).
   */
  vigBanner(r: RequisitionDetail): { cls: string; icono: string; texto: string } | null {
    if (r.estado !== 'pending_approval' && r.estado !== 'approved') return null;
    const v = r.vigencia;
    const edad = r.dias != null ? ` · ${r.dias} día(s) parada` : '';
    if (!v || v.vigente == null) {
      return { cls: 'rd-vig-gris', icono: 'pi-question-circle',
        texto: `No se pudo medir si los costos siguen vigentes${v ? `: ninguno de sus ${v.renglones} renglones tiene costo comparable hoy` : ''}${edad}. Se declara, no se supone.` };
    }
    if (v.vigente) {
      const cola = v.sin_medir > 0 ? ` (${v.sin_medir} renglón(es) sin medir)` : '';
      return { cls: 'rd-vig-ok', icono: 'pi-check-circle',
        texto: `Los ${v.medibles} renglones medibles conservan el costo con el que se capturaron${cola}${edad}.` };
    }
    const cola = v.sin_medir > 0 ? ` · ${v.sin_medir} sin medir` : '';
    return { cls: 'rd-vig-mal', icono: 'pi-exclamation-triangle',
      texto: `${v.movidos} de ${v.medibles} renglones ya no tienen el costo de hoy: ${this.money(v.monto_capturado)} capturados contra ${this.money(v.monto_hoy)} actuales (${v.delta >= 0 ? '+' : ''}${this.money(v.delta)})${cola}${edad}. Recalcula antes de aprobar — aprobar está frenado hasta entonces.` };
  }
  /** `[AB.32]` Rechazar pasa por el diálogo: una de sucursal exige motivo (el servidor también). */
  readonly rechazoAbierto = signal(false);
  readonly motivoRechazo = signal('');
  abrirRechazo(): void {
    this.motivoRechazo.set('');
    this.rechazoAbierto.set(true);
  }
  reject(): void {
    const motivo = this.motivoRechazo().trim();
    if (this.req()?.requested_by_branch && !motivo) return;
    this.busy.set(true);
    this.api.reject(this.id, motivo || null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(false); this.rechazoAbierto.set(false); this.toast.add({ severity: 'info', summary: 'Rechazada' }); this.load(); },
      error: (e) => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo rechazar', detail: e?.error?.message || 'Intenta de nuevo.' }); },
    });
  }
  /** RA.15 — genera la OC desde la requisición aprobada y navega a ella. */
  generatePO(): void {
    this.busy.set(true);
    this.api.createPOFromRequisition(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.busy.set(false);
        const summary = this.req()?.source_type === 'branch' ? 'Orden de traspaso generada' : 'Orden de compra generada';
        this.toast.add({ severity: 'success', summary, detail: r.folio });
        this.router.navigate(['/compras/ordenes', r.id]);
      },
      error: (e) => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo generar la OC.' }); },
    });
  }
  /** Navega a la OC ya generada desde esta requisición. */
  goToPO(): void {
    const poId = this.req()?.purchase_order_id;
    if (poId) this.router.navigate(['/compras/ordenes', poId]);
    else this.router.navigate(['/compras/ordenes']);
  }

  /** Muestra la columna Recibido cuando la requisición ya está en recepción o recibida. */
  showRecibido(): boolean { const e = this.req()?.estado; return e === 'ordered' || e === 'received'; }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  basisLabel(b: string) { return ({ min: 'mínimo', reorder: 'reorden', max: 'máximo' } as Record<string, string>)[b] || b; }
  estadoLabel(e: RequisitionEstado) { return ({ draft: 'Borrador', pending_approval: 'Pendiente', approved: 'Aprobada', ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada' } as Record<RequisitionEstado, string>)[e]; }
  estadoSev(e: RequisitionEstado): Sev { return ({ draft: 'secondary', pending_approval: 'warn', approved: 'success', ordered: 'info', received: 'success', cancelled: 'danger' } as Record<RequisitionEstado, Sev>)[e]; }
}
