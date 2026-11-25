import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import type { HrFirmaDepartamentoDto, HrFirmasSemanaDto, HrLigasFirmaDto } from '@megadulces/contracts';

import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { RhFirmasService } from '../rh-firmas.service';
import { leerComoDataUri, MAX_DOCUMENTO_BYTES } from '../reclutamiento-formato';
import { descargarPdfQr, qrDe, type QrTrazo } from '../firma/firma-qr';
import { descargarPdfFirmas, momento } from '../firma/firma-pdf';

/**
 * Fase RH · `[RH.15.5]` — La firma de la semana, debajo del cierre.
 *
 * LFT 132-XXXIV: el registro hace prueba plena si se acredita que lo acordaron la persona y la empresa. RH lo
 * acredita con UNA HOJA POR DEPARTAMENTO, firmada por las personas y su jefe de área; aquí esa hoja se sube y queda
 * ligada a la semana cerrada que se firmó.
 *
 * Las cinco preguntas (`diseno` §0b):
 *  1. Qué ve primero: cuántos firmaron de cuántos, y por departamento quién falta. Lo pendiente arriba.
 *  2. Qué no: la lista de personas de un departamento que ya firmó completo; las hojas anuladas, sólo contadas.
 *  3. Acceso: un clic abre la hoja escaneada; «Registrar hoja» trae marcadas a todas las personas del departamento.
 *  4. Ligada al cierre: si la semana se reabre y cambia, la hoja dice «de otra versión» y la gente cuenta sin firmar.
 *  5. Le toca a este panel: es el paso que sigue a cerrar la semana, con el mismo permiso.
 *
 * `[RH.15.11]` Y la firma desde el CELULAR (la hoja en papel se queda como respaldo). La firma ES la autorización:
 * cuenta en cuanto la persona firma (decisión de RH, 2026-11-17). Las mismas cinco preguntas:
 *  1. Por departamento: quién firmó en su celular (cuándo, con su firma a un clic) y quién falta («tiene su QR»).
 *  2. Qué no: el token no se guarda en ningún lado; si se pierde la hoja de QR, se generan otros.
 *  3. Acceso: un clic genera los QR del departamento; se escanean de la pantalla o se imprimen (PDF, 6 por hoja). Un
 *     clic descarga el PDF de la semana con TODAS las firmas: lo que va al expediente.
 *  4. Ligada al cierre: los QR mueren si la semana se reabre; cada firma guarda la versión que firmó.
 *  5. Le toca: es la misma tarea que la hoja (firmar la semana cerrada), con el mismo permiso. Si alguien firmó por
 *     otra persona, aquí se anula con motivo y se le genera otro QR.
 */
@Component({
  selector: 'app-rh-firmas-semana',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rf" aria-labelledby="rf-tit">
      <header class="rf-head">
        <h3 id="rf-tit">Firmas de la semana</h3>
        <app-freshness-pill measures="fetch" [since]="leidoEn()" label="leído" />
      </header>
      @if (datos()?.total) {
        <app-metric-strip [items]="cifras()" density="compact" ariaLabel="Cómo va la firma de la semana" />
        <p class="rf-cifra"><b>{{ datos()!.firmaron }} de {{ datos()!.total }}</b> firmaron@if (datos()!.total - datos()!.firmaron) { · faltan {{ datos()!.total - datos()!.firmaron }} }@if (enCelular()) { · {{ enCelular() }} en su celular }</p>
      }
      <p class="rf-ayuda">Cada persona firma su semana en su celular con un QR personal, o en la hoja del departamento. Con eso,
        el registro de la semana es la prueba de su acuerdo (LFT art. 132, fr. XXXIV). El PDF de cada departamento va a su expediente.</p>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!cargando() && !error() && !!datos() && !datos()!.departamentos.length"
                      [skeletonRows]="3" emptyIcon="pi-users" emptyTitle="Nadie que firme en esta semana"
                      emptyHint="La semana cerrada no tiene personas del padrón." (retry)="cargar()">
        @if (datos(); as d) {
          <ul class="rf-deps">
            @for (dep of ordenados(); track dep.department) {
              <li class="rf-dep" [class.listo]="dep.firmaron === dep.total">
                <div class="rf-dep-fila">
                  <span class="rf-dep-nom">{{ dep.department }}</span>
                  @if (dep.firmaron === dep.total) {
                    <span class="rf-ok"><i class="pi pi-check" aria-hidden="true"></i> {{ dep.total }} de {{ dep.total }}</span>
                  } @else {
                    <span class="rf-falta">{{ dep.firmaron }} de {{ dep.total }} · faltan {{ dep.total - dep.firmaron }}</span>
                    @if (puedeRegistrar() && registrando() !== dep.department) {
                      <p-button label="QR para el celular" icon="pi pi-qrcode" size="small" [outlined]="true" [loading]="generando() === dep.department"
                                [disabled]="!!generando()" (onClick)="generarQr(dep)" />
                      <p-button label="Registrar hoja" icon="pi pi-upload" size="small" [text]="true" (onClick)="abrir(dep)" />
                    }
                  }
                  @if (dep.firmaron) {
                    <p-button label="PDF de firmas" icon="pi pi-file-pdf" size="small" [text]="true" [loading]="descargando() === dep.department"
                              [disabled]="!!descargando()" (onClick)="pdfDepartamento(dep)"
                              [ariaLabel]="'Descargar el PDF de la semana de ' + dep.department + ' con todas sus firmas'" />
                  }
                </div>
                @if (celularDe(dep); as cel) {
                  @if (cel.length) {
                    <ul class="rf-cel" [attr.aria-label]="'Firmaron en su celular en ' + dep.department">
                      @for (p of cel; track p.codigo) {
                        <li>
                          <span><i class="pi pi-mobile" aria-hidden="true"></i> {{ p.nombre }}</span>
                          <span class="rf-meta">firmó el {{ momento(p.firmado_at ?? '') }}</span>
                          <p-button label="Ver firma" [text]="true" size="small" (onClick)="verFirma(p.firma_id!)" />
                          @if (puedeRegistrar()) {
                            @if (anulandoFirma() === p.firma_id) {
                              <input pInputText type="text" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Por qué se anula (p. ej. firmó otra persona)"
                                     [attr.aria-label]="'Por qué se anula la firma de ' + p.nombre" />
                              <p-button label="Anular" severity="danger" size="small" [disabled]="motivo().trim().length < 5 || enviando()" (onClick)="anularFirma(p.firma_id!, p.nombre)" />
                              <p-button label="Cancelar" [text]="true" size="small" (onClick)="anulandoFirma.set(null)" />
                            } @else {
                              <p-button label="Anular" [text]="true" severity="secondary" size="small" (onClick)="anulandoFirma.set(p.firma_id ?? null); motivo.set('')" />
                            }
                          }
                        </li>
                      }
                    </ul>
                  }
                }
                @if (dep.firmaron !== dep.total && registrando() !== dep.department) {
                  <p class="rf-faltan">Sin firmar: {{ faltanDe(dep) }}</p>
                }
                @if (qr()?.datos?.department === dep.department) {
                  <div class="rf-form" role="region" [attr.aria-label]="'QR para firmar de ' + dep.department">
                    <p class="rf-qr-ayuda">Entrega cada QR <b>en mano</b> a su persona: es la única llave. Lo escanea con la cámara de su
                      celular, ve su semana y firma; su firma cuenta en ese momento. Es de un solo uso y vence el
                      {{ vence(qr()!.datos.ligas[0]?.expires_at) }}. Si se pierde, genera otros: los anteriores dejan de servir.</p>
                    @if (qr()!.datos.ligas.length) {
                      <ul class="rf-qrs">
                        @for (l of qr()!.datos.ligas; track l.person_code) {
                          <li class="rf-qr">
                            @if (qr()!.trazos.get(l.person_code); as t) {
                              <svg class="rf-qr-img" [attr.viewBox]="'-4 -4 ' + (t.n + 8) + ' ' + (t.n + 8)" role="img"
                                   [attr.aria-label]="'QR para que ' + l.nombre + ' firme su semana'" shape-rendering="crispEdges">
                                <rect x="-4" y="-4" [attr.width]="t.n + 8" [attr.height]="t.n + 8" fill="#FFFFFF" />
                                <path [attr.d]="t.d" fill="#000000" />
                              </svg>
                            }
                            <span class="rf-qr-nom">{{ l.nombre }}</span>
                            <p-button label="Copiar liga" icon="pi pi-copy" [text]="true" size="small" (onClick)="copiar(l.url, l.nombre)"
                                      [ariaLabel]="'Copiar la liga de ' + l.nombre + ' (si su cámara no lee el QR)'" />
                          </li>
                        }
                      </ul>
                    }
                    @if (qr()!.datos.omitidas.length) {
                      <p class="rf-faltan">Sin QR: {{ omitidasTexto() }}</p>
                    }
                    <div class="rf-acc">
                      @if (qr()!.datos.ligas.length) {
                        <p-button label="Descargar para imprimir" icon="pi pi-print" size="small" [loading]="imprimiendo()" (onClick)="imprimirQr()" />
                      }
                      <p-button label="Cerrar" [text]="true" size="small" (onClick)="qr.set(null)" />
                    </div>
                  </div>
                }
                @if (registrando() === dep.department) {
                  <form class="rf-form" (ngSubmit)="guardar(dep)" [attr.aria-label]="'Registrar la hoja de ' + dep.department">
                    <fieldset class="rf-quienes">
                      <legend>Quiénes firmaron la hoja</legend>
                      @for (p of dep.personas; track p.codigo) {
                        <label class="rf-check">
                          <input type="checkbox" [checked]="marcados().has(p.codigo)" (change)="alternar(p.codigo)" [name]="'p-' + p.codigo" />
                          {{ p.nombre }}<span class="rf-cod">#{{ p.codigo }}</span>
                        </label>
                      }
                    </fieldset>
                    <label class="rf-campo">Jefe de área que firmó
                      <input pInputText type="text" name="jefe" [ngModel]="jefe()" (ngModelChange)="jefe.set($event)" autocomplete="off" required />
                    </label>
                    <label class="rf-campo">Hoja firmada (PDF o foto, hasta 10 MB)
                      <input type="file" name="hoja" accept="application/pdf,image/*" (change)="elegir($event)" />
                    </label>
                    <label class="rf-campo">Nota (opcional)
                      <input pInputText type="text" name="nota" [ngModel]="nota()" (ngModelChange)="nota.set($event)" maxlength="500" />
                    </label>
                    @if (falta(); as f) { <p class="rf-aviso" role="status">{{ f }}</p> }
                    <div class="rf-acc">
                      <p-button type="submit" label="Guardar hoja" icon="pi pi-check" size="small" [disabled]="!!falta() || enviando()" [loading]="enviando()" />
                      <p-button label="Cancelar" [text]="true" size="small" [disabled]="enviando()" (onClick)="registrando.set(null)" />
                    </div>
                  </form>
                }
              </li>
            }
          </ul>

          @if (d.hojas.length) {
            <h4 class="rf-sub">Hojas registradas</h4>
            <ul class="rf-hojas">
              @for (h of d.hojas; track h.id) {
                <li [class.rf-anulada]="!!h.voided_at">
                  <span>{{ h.department }} · {{ h.person_codes.length }} persona{{ h.person_codes.length === 1 ? '' : 's' }} · jefe: {{ h.jefe_nombre }}</span>
                  <span class="rf-meta">{{ fecha(h.created_at) }}@if (h.created_by_name) { · {{ h.created_by_name }} }</span>
                  @if (h.voided_at) {
                    <span class="rf-tag">Anulada: {{ h.void_reason }}</span>
                  } @else if (!h.vigente) {
                    <span class="rf-tag rf-tag-bad">De otra versión: la semana se reabrió después de firmar. Hay que volver a firmar.</span>
                  }
                  <p-button label="Ver hoja" icon="pi pi-external-link" [text]="true" size="small" (onClick)="verHoja(h.id)" />
                  @if (puedeRegistrar() && !h.voided_at) {
                    @if (anulando() === h.id) {
                      <input pInputText type="text" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Por qué se anula" aria-label="Por qué se anula la hoja" />
                      <p-button label="Anular" severity="danger" size="small" [disabled]="motivo().trim().length < 5 || enviando()" (onClick)="anular(h.id)" />
                      <p-button label="Cancelar" [text]="true" size="small" (onClick)="anulando.set(null)" />
                    } @else {
                      <p-button label="Anular" [text]="true" severity="secondary" size="small" (onClick)="anulando.set(h.id); motivo.set('')" />
                    }
                  }
                </li>
              }
            </ul>
          }
          @if (aviso(); as a) { <p class="rf-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
        }
      </app-load-state>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rf { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .rf-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2) var(--sp-3); }
    .rf-head h3 { margin: 0; font-size: var(--fs-h3); font-weight: 700; color: var(--text-main); }
    .rf-cifra { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .rf-ayuda { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 70ch; }
    .rf-deps, .rf-hojas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .rf-dep { padding: var(--sp-2) 0; border-top: 1px solid var(--border-color); }
    .rf-dep-fila { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
    .rf-dep-nom { font-weight: 600; color: var(--text-main); min-width: 10rem; }
    .rf-ok { color: var(--ok-soft-fg); font-size: var(--fs-sm); font-weight: 600; }
    .rf-falta { color: var(--text-main); font-size: var(--fs-sm); }
    .rf-faltan { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .rf-form { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-2); padding: var(--sp-3); border-radius: var(--r-md); background: var(--surface-2); }
    .rf-quienes { margin: 0; padding: 0; border: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); }
    .rf-quienes legend { font-size: var(--fs-sm); font-weight: 600; margin-bottom: var(--sp-1); color: var(--text-main); }
    .rf-check { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); min-height: var(--tap-min); color: var(--text-main); }
    .rf-cod { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-xs); margin-left: 2px; }
    .rf-campo { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-main); max-width: 28rem; }
    .rf-aviso { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .rf-acc { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .rf-sub { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .rf-hojas li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); font-size: var(--fs-sm); color: var(--text-main); }
    .rf-meta { color: var(--text-muted); font-size: var(--fs-xs); }
    .rf-tag { font-size: var(--fs-xs); color: var(--text-muted); }
    .rf-tag-bad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-radius: var(--r-sm); padding: 1px var(--sp-1); font-weight: 600; }
    .rf-anulada > span:first-child { text-decoration: line-through; color: var(--text-muted); }
    .rf-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .rf-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .rf-qr-ayuda { margin: 0; font-size: var(--fs-sm); color: var(--text-main); max-width: 70ch; }
    .rf-qrs { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: var(--sp-3); }
    .rf-qr { display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); }
    /* El QR va negro sobre blanco en los dos temas: un QR invertido no lo leen todas las cámaras. */
    .rf-qr-img { width: 9rem; height: 9rem; border-radius: var(--r-sm); }
    .rf-qr-nom { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); text-align: center; }
    .rf-cel { list-style: none; margin: var(--sp-1) 0 0; padding: 0; display: flex; flex-direction: column; }
    .rf-cel li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); color: var(--text-main); }
    .rf-cel .pi-mobile { color: var(--text-muted); }
  `],
})
export class RhFirmasSemanaComponent {
  private readonly api = inject(RhFirmasService);
  private readonly destroyRef = inject(DestroyRef);

  readonly site = input.required<string>();
  /** Jueves de la semana (la semana de nómina va de jueves a miércoles). */
  readonly semana = input.required<string>();
  /** El cierre vigente: si cambia (se reabrió y se volvió a cerrar), se vuelve a pedir el estado. */
  readonly cierre = input<string | null>(null);
  readonly puedeRegistrar = input(false);
  /** `[RH.15.11]` El nombre de la plaza, para la hoja de QR impresa (se nombra, no se numera). */
  readonly plaza = input('');

  readonly datos = signal<HrFirmasSemanaDto | null>(null);
  readonly leidoEn = signal<Date | null>(null);
  /** Q.1: la respuesta primero. Faltan en rojo: es lo que hay que hacer. */
  readonly cifras = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const faltan = d.total - d.firmaron;
    return [
      { label: 'Firmaron', value: d.firmaron, format: 'number', tone: faltan ? 'default' : 'ok' },
      { label: 'Faltan', value: faltan, format: 'number', tone: faltan ? 'bad' : 'muted' },
      { label: 'Hojas', value: d.hojas.filter((h) => !h.voided_at).length, format: 'number' },
    ];
  });
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly registrando = signal<string | null>(null);
  readonly marcados = signal<Set<string>>(new Set());
  readonly jefe = signal('');
  readonly nota = signal('');
  readonly archivo = signal<File | null>(null);
  readonly enviando = signal(false);
  readonly anulando = signal<string | null>(null);
  readonly motivo = signal('');

  // ── `[RH.15.11]` La firma desde el celular ──
  /** Los QR recién generados. Sólo en memoria: el token no se guarda en ningún lado, ni en el navegador. */
  readonly qr = signal<{ datos: HrLigasFirmaDto; trazos: Map<string, QrTrazo> } | null>(null);
  readonly generando = signal<string | null>(null);
  readonly imprimiendo = signal(false);
  readonly descargando = signal<string | null>(null);
  readonly anulandoFirma = signal<string | null>(null);
  readonly momento = momento;
  readonly enCelular = computed(() => (this.datos()?.departamentos ?? [])
    .reduce((s, d) => s + d.personas.filter((p) => p.via === 'celular').length, 0));
  readonly omitidasTexto = computed(() => (this.qr()?.datos.omitidas ?? []).map((o) => `${o.nombre} (${o.motivo.toLowerCase()})`).join(', '));

  /** Los departamentos con firmas pendientes primero: es lo que hay que hacer. */
  readonly ordenados = computed(() => [...(this.datos()?.departamentos ?? [])]
    .sort((a, b) => Number(a.firmaron === a.total) - Number(b.firmaron === b.total)));

  /** Qué falta para poder guardar, dicho con palabras (las mismas reglas que el servidor). */
  readonly falta = computed<string | null>(() => {
    const f = this.archivo();
    if (!this.marcados().size) return 'Marca a quienes firmaron la hoja.';
    if (this.jefe().trim().length < 3) return 'Escribe el nombre del jefe de área que firmó.';
    if (!f) return 'Sube la hoja firmada (PDF o foto).';
    if (f.size > MAX_DOCUMENTO_BYTES) return 'La hoja pesa más de 10 MB: tómale una foto más ligera o escanéala en PDF.';
    return null;
  });

  constructor() {
    effect(() => {
      // Cambia la plaza, la semana o el cierre vigente: se vuelve a pedir.
      this.site(); this.semana(); this.cierre();
      untracked(() => this.cargar());
    });
  }

  cargar(): void {
    const site = this.site(), semana = this.semana();
    if (!site || !semana) return;
    this.cargando.set(true);
    this.error.set(null);
    this.api.estado(site, semana).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.datos.set(d); this.leidoEn.set(new Date()); this.cargando.set(false); },
      error: (e) => { this.error.set(mensajeDe(e, 'No se pudo leer cómo va la firma de la semana.')); this.cargando.set(false); },
    });
  }

  faltanDe(dep: HrFirmaDepartamentoDto): string {
    return dep.personas.filter((p) => !p.firmo).map((p) => p.nombre + (p.liga ? ' (tiene su QR)' : '')).join(', ');
  }

  /** Quienes firmaron en su celular (cuenta en cuanto firman). */
  celularDe(dep: HrFirmaDepartamentoDto): HrFirmaDepartamentoDto['personas'] {
    return dep.personas.filter((p) => p.via === 'celular' && p.firma_id);
  }

  /** `[RH.15.11]` El PDF del departamento con todas las firmas de la versión vigente: lo que va al expediente. */
  pdfDepartamento(dep: HrFirmaDepartamentoDto): void {
    if (this.descargando()) return;
    this.descargando.set(dep.department);
    this.api.hoja(this.site(), this.semana(), dep.department).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: async (h) => {
        try { await descargarPdfFirmas(h, 'hoja'); } catch { this.aviso.set({ texto: 'No se pudo armar el PDF de firmas.', mal: true }); }
        this.descargando.set(null);
      },
      error: (e) => { this.descargando.set(null); this.aviso.set({ texto: mensajeDe(e, 'No se pudo leer la hoja de firmas.'), mal: true }); },
    });
  }

  verFirma(id: string): void {
    this.api.archivoFirma(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ url }) => window.open(url, '_blank', 'noopener'),
      error: (e) => this.aviso.set({ texto: mensajeDe(e, 'No se pudo abrir la firma.'), mal: true }),
    });
  }

  /** Anula una firma del celular (firmó otra persona, se equivocó). No se borra; queda con su motivo. */
  anularFirma(id: string, nombre: string): void {
    if (this.enviando()) return;
    this.enviando.set(true);
    this.api.anularFirma(id, this.motivo().trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.enviando.set(false);
        this.anulandoFirma.set(null);
        this.aviso.set({ texto: `Firma de ${nombre} anulada. Genera otro QR para que vuelva a firmar.`, mal: false });
        this.cargar();
      },
      error: (e) => { this.enviando.set(false); this.aviso.set({ texto: mensajeDe(e, 'No se anuló la firma.'), mal: true }); },
    });
  }

  /** `[RH.15.11]` Genera los QR del departamento (revoca los anteriores sin usar) y los dibuja. */
  generarQr(dep: HrFirmaDepartamentoDto): void {
    if (this.generando()) return;
    this.generando.set(dep.department);
    this.aviso.set(null);
    this.qr.set(null);
    this.api.generarLigas({ site_code: this.site(), period_start: this.semana(), department: dep.department })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: async (datos) => {
          try {
            const trazos = new Map<string, QrTrazo>();
            await Promise.all(datos.ligas.map(async (l) => trazos.set(l.person_code, await qrDe(l.url))));
            this.qr.set({ datos, trazos });
            if (!datos.ligas.length) this.aviso.set({ texto: `Nadie de ${dep.department} necesita QR: ya firmaron.`, mal: false });
          } catch {
            this.aviso.set({ texto: 'Se generaron las ligas pero no se pudieron dibujar los QR. Intenta de nuevo.', mal: true });
          }
          this.generando.set(null);
          this.cargar();
        },
        error: (e) => { this.generando.set(null); this.aviso.set({ texto: mensajeDe(e, 'No se generaron los QR. Nada cambió.'), mal: true }); },
      });
  }

  async imprimirQr(): Promise<void> {
    const q = this.qr();
    if (!q || this.imprimiendo()) return;
    this.imprimiendo.set(true);
    try { await descargarPdfQr(q.datos, this.plaza() || this.site()); } catch {
      this.aviso.set({ texto: 'No se pudo armar el PDF de los QR.', mal: true });
    }
    this.imprimiendo.set(false);
  }

  /** Para el celular cuya cámara no lee el QR. ⚠️ La liga es la única llave: sólo a esa persona. */
  async copiar(url: string, nombre: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.aviso.set({ texto: `Liga de ${nombre} copiada. Es personal: mándasela sólo a esa persona.`, mal: false });
    } catch {
      this.aviso.set({ texto: 'El navegador no dejó copiar la liga.', mal: true });
    }
  }

  vence(iso: string | undefined): string {
    if (!iso) return '';
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  abrir(dep: HrFirmaDepartamentoDto): void {
    this.marcados.set(new Set(dep.personas.map((p) => p.codigo)));
    this.jefe.set('');
    this.nota.set('');
    this.archivo.set(null);
    this.aviso.set(null);
    this.registrando.set(dep.department);
  }

  alternar(codigo: string): void {
    const s = new Set(this.marcados());
    if (s.has(codigo)) s.delete(codigo); else s.add(codigo);
    this.marcados.set(s);
  }

  elegir(ev: Event): void {
    this.archivo.set((ev.target as HTMLInputElement).files?.[0] ?? null);
  }

  async guardar(dep: HrFirmaDepartamentoDto): Promise<void> {
    const f = this.archivo();
    if (this.enviando() || this.falta() || !f) return;
    this.enviando.set(true);   // se apaga en el primer clic, antes de leer el archivo
    let dataUri: string;
    try { dataUri = await leerComoDataUri(f); } catch {
      this.enviando.set(false);
      this.aviso.set({ texto: 'No se pudo leer el archivo. Intenta de nuevo.', mal: true });
      return;
    }
    this.api.registrar({
      site_code: this.site(), period_start: this.semana(), department: dep.department, person_codes: [...this.marcados()],
      jefe_nombre: this.jefe().trim(), file_data_uri: dataUri, file_name: f.name, notes: this.nota().trim() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.enviando.set(false);
        this.registrando.set(null);
        this.aviso.set({ texto: `Hoja de ${dep.department} guardada.`, mal: false });
        this.cargar();
      },
      error: (e) => { this.enviando.set(false); this.aviso.set({ texto: mensajeDe(e, 'No se guardó la hoja. Nada cambió.'), mal: true }); },
    });
  }

  verHoja(id: string): void {
    this.api.archivo(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ url }) => window.open(url, '_blank', 'noopener'),
      error: (e) => this.aviso.set({ texto: mensajeDe(e, 'No se pudo abrir la hoja.'), mal: true }),
    });
  }

  anular(id: string): void {
    if (this.enviando()) return;
    this.enviando.set(true);
    this.api.anular(id, this.motivo().trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.enviando.set(false); this.anulando.set(null); this.aviso.set({ texto: 'Hoja anulada.', mal: false }); this.cargar(); },
      error: (e) => { this.enviando.set(false); this.aviso.set({ texto: mensajeDe(e, 'No se anuló la hoja.'), mal: true }); },
    });
  }

  fecha(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)} ${m[4]}:${m[5]}` : iso;
  }
}

function mensajeDe(e: unknown, porDefecto: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : (m || porDefecto);
}
