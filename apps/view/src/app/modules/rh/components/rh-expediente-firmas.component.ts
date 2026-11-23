import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import type { HrExpedienteFirmaDto } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhFirmasService } from '../rh-firmas.service';
import { descargarPdfFirmas, momento } from '../firma/firma-pdf';

/**
 * Fase RH · `[RH.15.11]` — El expediente de firmas de UNA persona: cada semana que firmó, en su celular o en la hoja de
 * papel, con su comprobante en PDF. Vive en la ficha de la persona (Asistencia › persona), debajo de su semana.
 *
 * Las cinco preguntas (`diseno` §0b):
 *  1. Qué ve, en orden: las semanas firmadas, la más nueva primero; por cada una, cómo firmó y cuándo.
 *  2. Qué no: IP, navegador y trazo no van en la lista: están en el comprobante (un clic), que es donde se usan.
 *  3. Acceso: un clic descarga el comprobante (la versión EXACTA que firmó, aunque la semana se haya reabierto) o abre
 *     la hoja de papel.
 *  4. Ligada a: los cierres de semana. Una firma de una versión vieja se marca «de otra versión»; una anulada, con motivo.
 *  5. Le toca: es la pregunta de RH «¿esta persona firmó sus semanas?», sobre esa persona. Lo de toda la plaza vive en
 *     el panel de firmas de la semana.
 */
@Component({
  selector: 'app-rh-expediente-firmas',
  standalone: true,
  imports: [ButtonModule, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ef" aria-labelledby="ef-tit">
      <h3 id="ef-tit">{{ titulo() }}</h3>
      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!cargando() && !error() && !firmas().length" [skeletonRows]="2"
                      emptyIcon="pi-pen-to-square" emptyTitle="Todavía no ha firmado ninguna semana"
                      emptyHint="Se firma desde el panel de firmas, con la semana cerrada." (retry)="cargar()">
        <ul class="ef-lista">
          @for (f of firmas(); track f.via + f.id) {
            <li [class.ef-anulada]="!!f.anulada">
              <span class="ef-sem">Semana del {{ corta(f.period_start) }} al {{ corta(f.period_end) }}</span>
              <span class="ef-meta">{{ f.via === 'celular' ? 'En su celular' : 'En papel' }} · {{ momento(f.firmado_at) }} · {{ f.department }}@if (userId()) { · plaza {{ f.site_code }} }</span>
              @if (f.anulada) {
                <span class="ef-tag">Anulada: {{ f.anulada.motivo }}</span>
              } @else if (!f.vigente) {
                <span class="ef-tag ef-tag-bad">De otra versión: la semana se reabrió después de firmar</span>
              }
              @if (f.via === 'celular') {
                <p-button label="Comprobante" icon="pi pi-file-pdf" [text]="true" size="small" [loading]="bajando() === f.id"
                          [disabled]="!!bajando()" (onClick)="comprobante(f)"
                          [ariaLabel]="'Descargar el comprobante de la semana del ' + corta(f.period_start)" />
              } @else {
                <p-button label="Ver hoja" icon="pi pi-external-link" [text]="true" size="small" (onClick)="verHoja(f.id)" />
              }
            </li>
          }
        </ul>
      </app-load-state>
      @if (aviso(); as a) { <p class="ef-mal" role="alert">{{ a }}</p> }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ef { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ef h3 { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .ef-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .ef-lista li { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--sp-3); padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); font-size: var(--fs-sm); color: var(--text-main); }
    .ef-sem { font-weight: 600; }
    .ef-meta { color: var(--text-muted); font-size: var(--fs-xs); }
    .ef-tag { font-size: var(--fs-xs); color: var(--text-muted); }
    .ef-tag-bad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-radius: var(--r-sm); padding: 1px var(--sp-1); font-weight: 600; }
    .ef-anulada .ef-sem { text-decoration: line-through; color: var(--text-muted); }
    .ef-mal { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
  `],
})
export class RhExpedienteFirmasComponent {
  private readonly api = inject(RhFirmasService);
  private readonly destroyRef = inject(DestroyRef);

  /** `[RH.15.11]` Por persona (todas sus plazas). Sin usuario (aún no ligada), por plaza + número. */
  readonly userId = input<string | null>(null);
  readonly site = input('');
  readonly persona = input('');
  /** Dentro del expediente de la persona el título lo pone el contenedor. */
  readonly titulo = input('Firmas de su asistencia');

  readonly firmas = signal<HrExpedienteFirmaDto[]>([]);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);
  readonly bajando = signal<string | null>(null);
  readonly momento = momento;

  constructor() {
    effect(() => {
      this.userId(); this.site(); this.persona();
      untracked(() => this.cargar());
    });
  }

  cargar(): void {
    const userId = this.userId(), site = this.site(), persona = this.persona();
    if (!userId && (!site || !persona)) return;
    this.cargando.set(true);
    this.error.set(null);
    this.api.expediente({ userId, site, personCode: persona }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (e) => { this.firmas.set(e.firmas); this.cargando.set(false); },
      error: (e) => { this.error.set(mensajeDe(e, 'No se pudieron leer sus firmas.')); this.cargando.set(false); },
    });
  }

  comprobante(f: HrExpedienteFirmaDto): void {
    if (this.bajando()) return;
    this.bajando.set(f.id);
    this.aviso.set(null);
    this.api.comprobante(f.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: async (h) => {
        try { await descargarPdfFirmas(h, 'comprobante'); } catch { this.aviso.set('No se pudo armar el PDF del comprobante.'); }
        this.bajando.set(null);
      },
      error: (e) => { this.bajando.set(null); this.aviso.set(mensajeDe(e, 'No se pudo leer el comprobante.')); },
    });
  }

  verHoja(id: string): void {
    this.api.archivo(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ url }) => window.open(url, '_blank', 'noopener'),
      error: (e) => this.aviso.set(mensajeDe(e, 'No se pudo abrir la hoja.')),
    });
  }

  corta(ymd: string): string {
    const [y, m, d] = (ymd || '').split('-');
    return d ? `${d}/${m}/${y.slice(2)}` : ymd;
  }
}

function mensajeDe(e: unknown, porDefecto: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : (m || porDefecto);
}
