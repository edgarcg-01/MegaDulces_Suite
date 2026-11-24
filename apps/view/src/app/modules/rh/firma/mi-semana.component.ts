import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { prepararFirma, type FirmaCanvas } from '@megadulces/ui-web';
import type { HrFirmaPublicaDto, HrFirmaPublicaResultadoDto } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { environment } from '../../../../environments/environment';

/**
 * Fase RH · `[RH.15.11]` — «Mi semana»: la persona firma su semana desde SU celular, con el QR que le dio su jefe.
 * Pública (sin cuenta): la autoriza SÓLO el token del QR (decisión de RH: la firma es la autorización, sin número de
 * reloj ni confirmación del jefe). Está en `RUTAS_PUBLICAS`.
 *
 * Las cinco preguntas (`diseno` §0b):
 *  1. Qué ve, en orden: QUIÉN debe firmar («si no eres Fulano, no firmes») y QUÉ semana → su semana día por día (cómo
 *     quedó cada día, entrada, salida, horas) con el total y las faltas → el recuadro de firma y UN botón, pegado abajo.
 *  2. Qué no: nada de otras personas; ni bolsa de tolerancia, ni minutos de atraso, ni códigos internos (jerga de RH
 *     que no decide nada para quien firma).
 *  3. Acceso: sin cuenta, sin contraseña, sin campos: abrir, leer, firmar. El botón al alcance del pulgar.
 *  4. Ligada a: el cierre de la semana. Lo que firma es esa foto; si RH la reabre y cambia, la liga deja de servir.
 *  5. Le toca: es la ÚNICA pantalla de la persona trabajadora en este proceso. Si no está de acuerdo, no firma y lo
 *     habla con su jefe: la pantalla se lo dice, en vez de esconderlo.
 */
@Component({
  selector: 'app-mi-semana',
  standalone: true,
  imports: [LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="ms">
      <app-load-state [loading]="cargando()" [error]="errorLiga()" [isEmpty]="false" [skeletonRows]="3" (retry)="abrirLiga()">
        @if (liga(); as l) {
          <header class="ms-head">
            <p class="ms-hola">{{ l.nombre }}</p>
            <h1>Tu semana del {{ fecha(l.period_start) }} al {{ fecha(l.period_end) }}</h1>
            <p class="ms-sitio">{{ l.site_name }}</p>
          </header>

          @if (firmadaEn(); as en) {
            <section class="ms-card ms-ok" role="status">
              <h2>Firmaste tu semana</h2>
              <p>Quedó guardada el {{ vence(en) }}. Ya puedes cerrar esta página.</p>
            </section>
          } @else {
            <p class="ms-quien" role="note">Esta liga es sólo para <b>{{ l.nombre }}</b>. Si no eres tú, no firmes y avisa a tu jefe de área.</p>

            <section class="ms-card" aria-labelledby="ms-res">
              <p id="ms-res" class="ms-total"><b>{{ l.horas_semana }} h</b> trabajadas@if (l.faltas) { · <b class="ms-falta">{{ l.faltas }} falta{{ l.faltas === 1 ? '' : 's' }}</b> }</p>
              <ul class="ms-dias">
                @for (d of l.dias; track d.fecha) {
                  <li class="ms-dia">
                    <span class="ms-fecha">{{ diaSemana(d.fecha) }}</span>
                    <span class="ms-estado" [class.ms-falta]="d.estado === 'falta'">{{ d.etiqueta }}</span>
                    <span class="ms-horas">
                      @if (d.entrada || d.salida) { {{ d.entrada || '—' }} a {{ d.salida || '—' }} }
                      @if (d.horas) { <b>· {{ d.horas }} h</b> }
                    </span>
                    @if (d.incidencias.length) { <span class="ms-inc">{{ d.incidencias.join(', ') }}</span> }
                  </li>
                }
              </ul>
              <p class="ms-pista">¿Algo no está bien? No firmes y habla con tu jefe de área o con Recursos Humanos.</p>
            </section>

            <section class="ms-card" aria-labelledby="ms-firma-tit">
              <h2 id="ms-firma-tit">Firma con tu dedo</h2>
              <canvas #lienzo class="ms-lienzo" role="img" aria-label="Recuadro para firmar con el dedo"
                      (pointerdown)="abajo($event)" (pointermove)="mueve($event)" (pointerup)="arriba()" (pointerleave)="arriba()"></canvas>
              <div class="ms-fila">
                <span class="ms-pista">{{ hecha() ? 'Listo' : 'Firma dentro del recuadro' }}</span>
                <button type="button" class="ms-sec" (click)="limpiar()" [disabled]="!hecha() || enviando()">Borrar</button>
              </div>
              @if (aviso(); as a) { <p class="ms-mal" role="alert">{{ a }}</p> }
            </section>
            <div class="ms-barra">
              <button type="button" class="ms-btn" (click)="firmar()" [disabled]="!hecha() || enviando()">
                {{ enviando() ? 'Guardando…' : 'Estoy de acuerdo: firmar mi semana' }}
              </button>
              <p class="ms-pie">Vence el {{ vence(l.expires_at) }}. Se usa una sola vez.</p>
            </div>
          }
        }
      </app-load-state>
      <p class="ms-legal">Firmar dice que estás de acuerdo con el registro de tu jornada de esa semana (Ley Federal del Trabajo,
        art. 132, fr. XXXIV). Es evidencia de tu conformidad, no una firma electrónica avanzada.</p>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100dvh; background: var(--surface-ground); }
    .ms { max-width: 32rem; margin: 0 auto; padding: var(--sp-4) var(--sp-4) calc(var(--sp-12) + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: var(--sp-3); }
    .ms-head h1 { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .ms-hola { margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ms-sitio { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .ms-quien { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--warn-soft-bg); color: var(--warn-soft-fg); font-size: var(--fs-sm); }
    .ms-card { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); }
    .ms-card h2 { margin: 0; font-size: var(--fs-h3); font-weight: 700; color: var(--text-main); }
    .ms-pista { font-size: var(--fs-sm); font-weight: 400; color: var(--text-muted); margin: 0; }
    .ms-btn { min-height: 52px; width: 100%; border: 0; border-radius: var(--r-md); background: var(--action); color: var(--action-ink); font: inherit; font-weight: 700; cursor: pointer; }
    .ms-btn:disabled { opacity: .5; cursor: not-allowed; }
    .ms-btn:focus-visible, .ms-sec:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ms-sec { min-height: 44px; padding: 0 var(--sp-3); background: none; border: 1px solid var(--border-color); border-radius: var(--r-sm); color: var(--text-main); font: inherit; cursor: pointer; }
    .ms-pie { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); text-align: center; }
    .ms-mal { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
    .ms-total { margin: 0; font-size: var(--fs-h3); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .ms-falta { color: var(--bad-soft-fg); }
    .ms-dias { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .ms-dia { display: grid; grid-template-columns: 5.5rem 1fr; gap: 2px var(--sp-2); padding: var(--sp-2) 0; border-top: 1px solid var(--border-color); font-size: var(--fs-sm); color: var(--text-main); }
    .ms-fecha { font-weight: 600; }
    .ms-horas { grid-column: 2; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ms-inc { grid-column: 2; font-size: var(--fs-xs); color: var(--text-muted); }
    .ms-lienzo { width: 100%; height: 200px; touch-action: none; background: var(--neutral-50); border: 1px dashed var(--border-color); border-radius: var(--r-md); }
    .ms-fila { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .ms-barra { position: sticky; bottom: 0; padding: var(--sp-2) 0 calc(var(--sp-2) + env(safe-area-inset-bottom)); background: var(--surface-ground); }
    .ms-ok h2 { color: var(--ok-soft-fg); }
    .ms-ok p { margin: 0; color: var(--text-main); }
    .ms-legal { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  `],
})
export class MiSemanaComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly lienzo = viewChild<ElementRef<HTMLCanvasElement>>('lienzo');
  private firma: FirmaCanvas | null = null;
  private firmaEl: HTMLCanvasElement | null = null;
  private token = '';

  readonly cargando = signal(true);
  readonly errorLiga = signal<string | null>(null);
  readonly liga = signal<HrFirmaPublicaDto | null>(null);
  readonly hecha = signal(false);
  readonly enviando = signal(false);
  readonly aviso = signal<string | null>(null);
  readonly firmadaEn = signal<string | null>(null);

  private url(): string {
    return `${environment.apiUrl}/hr/attendance/firma/${encodeURIComponent(this.token)}`;
  }

  ngOnInit(): void {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    this.abrirLiga();
  }

  abrirLiga(): void {
    this.cargando.set(true);
    this.errorLiga.set(null);
    this.http.get<HrFirmaPublicaDto>(this.url()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => { this.liga.set(l); this.cargando.set(false); },
      error: (e) => { this.errorLiga.set(mensajeDe(e, 'No se pudo abrir la liga. Revisa tu señal e intenta de nuevo.')); this.cargando.set(false); },
    });
  }

  firmar(): void {
    const png = this.pad()?.aPng();
    if (this.enviando() || !png) return;
    this.enviando.set(true);   // se apaga en el primer clic
    this.aviso.set(null);
    this.http.post<HrFirmaPublicaResultadoDto>(this.url(), { firma_png: png })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.firmadaEn.set(r.signed_at); this.enviando.set(false); },
        error: (e) => { this.enviando.set(false); this.tropiezo(e); },
      });
  }

  /** Si la liga murió (ya se usó, venció, cambió la semana), se dice y ya; si fue la señal, se puede reintentar. */
  private tropiezo(e: unknown): void {
    const m = mensajeDe(e, 'No se pudo guardar. Revisa tu señal e intenta de nuevo.');
    if ((e as { status?: number })?.status === 403) { this.liga.set(null); this.errorLiga.set(m); return; }
    this.aviso.set(m);
  }

  /** Se re-prepara si el `@if` volvió a crear el canvas (un pad sobre un canvas desprendido dibuja en la nada). */
  private pad(): FirmaCanvas | null {
    const c = this.lienzo()?.nativeElement;
    if (!c) return null;
    if (!this.firma || this.firmaEl !== c) { this.firma = prepararFirma(c); this.firmaEl = c; }
    return this.firma;
  }

  abajo(ev: PointerEvent): void {
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    this.pad()?.abajo(ev.offsetX, ev.offsetY);
  }
  mueve(ev: PointerEvent): void {
    const p = this.pad();
    if (!p) return;
    p.mueve(ev.offsetX, ev.offsetY);
    if (p.firmada() !== this.hecha()) this.hecha.set(p.firmada());
  }
  arriba(): void {
    const p = this.pad();
    if (!p) return;
    p.arriba();
    this.hecha.set(p.firmada());
  }
  limpiar(): void { this.pad()?.limpiar(); this.hecha.set(false); }

  fecha(ymd: string): string {
    const [y, m, d] = (ymd || '').split('-');
    return d && y ? `${Number(d)} de ${MESES[Number(m) - 1]}` : ymd;
  }
  diaSemana(ymd: string): string {
    const d = new Date(`${ymd}T12:00:00Z`);
    return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`;
  }
  vence(iso: string): string {
    if (!iso) return '';
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
  }
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function mensajeDe(e: unknown, porDefecto: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : (m || porDefecto);
}
