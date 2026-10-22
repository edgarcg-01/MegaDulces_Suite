import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { environment } from '../../../../environments/environment';
import { CfdiLeido, leerCfdiXml, urlVerificadorSat } from './cfdi-xml';

type Estado = 'vacio' | 'cargando' | 'sin_xml' | 'error' | 'ilegible' | 'listo';

/**
 * `[LC.20]` — La factura (CFDI) leída de su XML guardado: emisor, receptor, conceptos, impuestos y
 * timbre, más bajar el XML y abrirla en el verificador del SAT.
 *
 * Va dentro de un `app-side-peek`. Pide el XML a `GET /fiscal/cfdi/:uuid/xml` (permiso
 * FISCAL_CFDI_VER). Distingue «todavía no hay XML» (404: el feed del ADD los completa del más
 * nuevo al más viejo) de «falló la red»: no son lo mismo y piden cosas distintas.
 */
@Component({
  selector: 'app-cfdi-visor',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (estado()) {
      @case ('cargando') { <p class="cv-nota">Cargando la factura…</p> }
      @case ('sin_xml') {
        <p class="cv-nota">
          El XML de esta factura todavía no se copia del ADD de ContPAQi. Se van guardando del más
          nuevo al más viejo; vuelve a intentarlo más tarde.
        </p>
      }
      @case ('error') { <p class="cv-nota cv-mal">No se pudo cargar la factura. Revisa tu conexión y vuelve a abrirla.</p> }
      @case ('ilegible') { <p class="cv-nota cv-mal">El documento guardado no es un CFDI legible.</p> }
      @case ('listo') {
        @if (cfdi(); as c) {
          <div class="cv-acciones">
            <p-button type="button" label="Descargar XML" icon="pi pi-download" size="small"
                      styleClass="p-button-outlined p-button-secondary" (click)="descargar()" />
            @if (urlSat(); as u) {
              <a class="cv-link" [href]="u" target="_blank" rel="noopener">
                <i class="pi pi-external-link" aria-hidden="true"></i> Verificar en el SAT
              </a>
            }
          </div>

          <dl class="cv-datos">
            <dt>Emisor</dt><dd>{{ c.emisor.nombre || '—' }} <span class="mono muted">{{ c.emisor.rfc }}</span></dd>
            <dt>Receptor</dt><dd>{{ c.receptor.nombre || '—' }} <span class="mono muted">{{ c.receptor.rfc }}</span></dd>
            <dt>Serie y folio</dt><dd class="mono">{{ c.serie || '' }} {{ c.folio || '—' }}</dd>
            <dt>Fecha</dt><dd class="mono">{{ c.fecha || '—' }}</dd>
            <dt>Tipo · uso</dt><dd>{{ c.tipo || '—' }} · {{ c.receptor.uso || '—' }}</dd>
            <dt>Método · forma</dt><dd>{{ c.metodo_pago || '—' }} · {{ c.forma_pago || '—' }}</dd>
            <dt>UUID</dt><dd class="mono">{{ c.uuid || '—' }}</dd>
            <dt>Timbrado</dt><dd class="mono">{{ c.fecha_timbrado || '—' }}</dd>
          </dl>

          <h4 class="cv-h">Conceptos <span class="muted">· {{ c.conceptos.length }}</span></h4>
          <p-table [value]="c.conceptos" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="40vh">
            <ng-template #header>
              <tr><th>Descripción</th><th class="num">Cant.</th><th>Unidad</th><th class="num">P. unit.</th><th class="num">Importe</th></tr>
            </ng-template>
            <ng-template #body let-k>
              <tr>
                <td>
                  {{ k.descripcion }}
                  <small class="muted mono">{{ k.clave_prod_serv }}</small>
                  @for (t of k.traslados; track $index) {
                    <small class="muted"> · {{ t.impuesto }} {{ t.tasa != null ? (t.tasa * 100 | number:'1.0-4') + ' %' : t.tipo_factor }}</small>
                  }
                </td>
                <td class="num mono">{{ k.cantidad ?? '—' }}</td>
                <td>{{ k.clave_unidad || '—' }}{{ k.unidad ? ' · ' + k.unidad : '' }}</td>
                <td class="num mono">{{ k.valor_unitario != null ? (k.valor_unitario | currency:'MXN':'symbol-narrow':'1.2-6') : '—' }}</td>
                <td class="num mono">{{ k.importe != null ? (k.importe | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
              </tr>
            </ng-template>
          </p-table>

          <dl class="cv-tot">
            <dt>Subtotal</dt><dd class="mono">{{ c.subtotal != null ? (c.subtotal | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</dd>
            @if (c.descuento) { <dt>Descuento</dt><dd class="mono">−{{ c.descuento | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd> }
            @for (t of c.traslados; track $index) {
              <dt>{{ t.impuesto }} {{ t.tasa != null ? (t.tasa * 100 | number:'1.0-4') + ' %' : t.tipo_factor }}</dt>
              <dd class="mono">{{ t.importe != null ? (t.importe | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</dd>
            }
            <dt class="cv-total">Total</dt>
            <dd class="mono cv-total">{{ c.total != null ? (c.total | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }} {{ c.moneda && c.moneda !== 'MXN' ? c.moneda : '' }}</dd>
          </dl>
        }
      }
    }
  `,
  styles: [`
    :host { display: block; font-size: var(--fs-sm); }
    .cv-nota { color: var(--text-muted); margin: .5rem 0; }
    .cv-mal { color: var(--bad-fg); }
    .cv-acciones { display: flex; align-items: center; gap: .9rem; margin-bottom: .9rem; }
    .cv-link { color: var(--text-main); text-decoration: underline; }
    .cv-datos, .cv-tot { display: grid; grid-template-columns: max-content 1fr; gap: .3rem .9rem; margin: 0 0 1rem; }
    .cv-datos dt, .cv-tot dt { color: var(--text-muted); }
    .cv-datos dd, .cv-tot dd { margin: 0; }
    .cv-tot { margin-top: 1rem; justify-content: end; }
    .cv-tot dd { text-align: right; }
    .cv-total { font-weight: 600; color: var(--text-main); }
    .cv-h { margin: .5rem 0; font-size: var(--fs-sm); }
    .num { text-align: right; }
    .mono { font-family: var(--font-mono); }
    .muted { color: var(--text-muted); }
  `],
})
export class CfdiVisorComponent {
  /** UUID del CFDI a mostrar. null = nada. */
  readonly uuid = input<string | null>(null);

  readonly estado = signal<Estado>('vacio');
  readonly cfdi = signal<CfdiLeido | null>(null);
  readonly urlSat = signal<string | null>(null);
  private xml: string | null = null;
  private carga?: Subscription;
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    effect(() => this.cargar(this.uuid()));
  }

  private cargar(uuid: string | null) {
    this.carga?.unsubscribe();
    this.cfdi.set(null); this.urlSat.set(null); this.xml = null;
    if (!uuid) { this.estado.set('vacio'); return; }
    this.estado.set('cargando');
    this.carga = this.http.get(`${environment.apiUrl}/fiscal/cfdi/${encodeURIComponent(uuid)}/xml`, { responseType: 'text' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (xml) => {
          const c = leerCfdiXml(xml);
          if (!c) { this.estado.set('ilegible'); return; }
          this.xml = xml; this.cfdi.set(c); this.urlSat.set(urlVerificadorSat(c)); this.estado.set('listo');
        },
        error: (e: HttpErrorResponse) => this.estado.set(e.status === 404 ? 'sin_xml' : 'error'),
      });
  }

  descargar() {
    const c = this.cfdi(); if (!this.xml || !c) return;
    const url = URL.createObjectURL(new Blob([this.xml], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${c.uuid ?? this.uuid() ?? 'cfdi'}.xml`; a.click();
    URL.revokeObjectURL(url);
  }
}
