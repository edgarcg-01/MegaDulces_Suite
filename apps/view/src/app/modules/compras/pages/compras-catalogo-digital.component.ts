import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { RevisionBandeja, RevisionDecision, RevisionFicha, RevisionMotivo } from '@megadulces/contracts';
import { REVISION_MOTIVO_TEXTO } from '@megadulces/contracts';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { CatalogoDigitalService } from '../catalogo-digital.service';

const CARA: Record<string, string> = { frente: 'Frente', reverso: 'Reverso', lateral_izq: 'Lado izq.', lateral_der: 'Lado der.', base: 'Base' };
const PALABRA: Record<string, string> = { PZA: 'pieza', PAQ: 'paquete', CJA: 'caja', BTO: 'bulto', CUB: 'cubeta', KG: 'kilo' };
const MOTIVOS: RevisionMotivo[] = ['sin_analizar', 'caras_saltadas', 'entro_por_busqueda', 'foto_repetida'];

/**
 * `[NP.7.L.3b]` Catálogo digital › Por revisar. Maqueta F de `FASE_NP7_ALTA_DESDE_FOTOS.md` §10b.4.
 *
 * Las cinco preguntas (skill `diseno` §0b; plan §10b.2):
 *  1. Primero, cuántas fichas esperan y por qué; luego la lista y, al lado, la ficha: fotos contra Kepler.
 *  2. No ve costo, precio, margen ni el ranking.
 *  3. Teclado completo (P publica, R pide otra foto, D descarta, flechas entre fichas; escritos en los
 *     botones), fotos ampliables sin salir, motivo en texto y no sólo en color.
 *  4. Ligada al levantamiento (de ahí llegan) y, después, a Incidencias (NP.7.L.3c, todavía no).
 *  5. Le toca a quien tenga `CATALOGO_FICHAS_REVISAR`.
 */
@Component({
  selector: 'app-compras-catalogo-digital',
  standalone: true,
  imports: [DecimalPipe, DatePipe, PageTabsComponent, LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cd">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Catálogo digital · Por revisar</h1>
          <p class="cd-sub">Lo que levantó el personal de sucursal. Nada se publica sin que alguien lo vea.
            <app-freshness-pill measures="fetch" [since]="cargadoEn()" /></p>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" />

      <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Fichas por revisar" />
      <div class="cd-filtros" role="group" aria-label="Filtrar por motivo">
        <button type="button" class="cd-chip" [attr.aria-pressed]="motivo() === null" (click)="filtrar(null)">Todas {{ totalBandeja() | number }}</button>
        @for (m of motivos; track m) {
          @if ((datos()?.counts?.[m] ?? 0) > 0) {
            <button type="button" class="cd-chip" [attr.aria-pressed]="motivo() === m" (click)="filtrar(m)">{{ texto(m) }} {{ datos()?.counts?.[m] | number }}</button>
          }
        }
      </div>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!!datos() && (datos()?.rows?.length ?? 0) === 0"
                      emptyIcon="pi-check-circle" emptyTitle="No hay fichas por revisar"
                      emptyHint="Todo lo levantado ya tiene decisión." (retry)="cargar()">
        <div class="cd-md">
          <ul class="cd-lista" aria-label="Fichas por revisar">
            @for (f of datos()?.rows ?? []; track f.id; let i = $index) {
              <li><button type="button" class="cd-fila" [class.on]="i === sel()" [attr.aria-current]="i === sel()" (click)="elegir(i)">
                <span class="cd-fila-n">{{ f.name ?? f.sku }}</span>
                <small>{{ unidad(f.unit_label, f.unit_factor) }} · {{ f.captured_by ?? 'sin nombre' }} · {{ f.branch_name ?? f.branch_code }}</small>
                <small>{{ motivosTexto(f) }}</small>
              </button></li>
            }
            @if ((datos()?.total ?? 0) > (datos()?.rows?.length ?? 0)) {
              <li class="cd-mas">Se muestran {{ datos()?.rows?.length }} de {{ datos()?.total | number }}.
                <button type="button" class="cd-link" (click)="masFichas()">Ver más</button></li>
            }
          </ul>

          @if (actual(); as f) {
            <section class="cd-ficha" aria-live="polite">
              <div class="cd-ficha-head">
                <h2>{{ f.name ?? f.sku }}</h2>
                <span class="cd-meta">{{ f.sku }} · {{ unidad(f.unit_label, f.unit_factor) }} · {{ f.captured_by ?? 'sin nombre' }} · {{ f.captured_at | date: 'd MMM, HH:mm' }} · {{ f.branch_name ?? f.branch_code }}</span>
              </div>
              <p class="cd-frase">{{ frase(f) }}</p>

              <div class="cd-fotos">
                @for (p of f.photos; track p.face) {
                  @if (p.url) {
                    <a class="cd-foto" [href]="p.url" target="_blank" rel="noopener" [attr.aria-label]="'Ampliar ' + caraTexto(p.face)">
                      <img [src]="p.url" [alt]="caraTexto(p.face) + ' de ' + (f.name ?? f.sku)" loading="lazy" />
                      <span>{{ caraTexto(p.face) }}</span>
                    </a>
                  } @else {
                    <div class="cd-foto cd-foto-sin"><span>{{ caraTexto(p.face) }}</span><small>Saltada: {{ saltoTexto(p.skipped_reason) }}</small></div>
                  }
                }
              </div>

              <dl class="cd-kv">
                <dt>Código escaneado</dt><dd class="cd-mono">{{ f.scanned_code ?? 'ninguno (entró por el buscador)' }}</dd>
                <dt>En Kepler ({{ f.branch_name ?? f.branch_code }})</dt>
                <dd>{{ f.unit_label ?? 'sin rótulo' }} · factor {{ f.unit_factor ?? 'sin capturar' }} · código de barras <span class="cd-mono">{{ escaneables(f).length ? escaneables(f).join(', ') : 'ninguno' }}</span>
                  @if (internas(f) > 0) { <span class="cd-meta"> · {{ internas(f) }} clave{{ internas(f) === 1 ? '' : 's' }} interna{{ internas(f) === 1 ? '' : 's' }} de Kepler (no se escanean)</span> }</dd>
              </dl>

              @if (pidiendoNota(); as d) {
                <label class="cd-nota">{{ d === 'recapturar' ? 'Qué hay que volver a fotografiar' : 'Por qué se descarta' }}
                  <input type="text" id="cd-nota-input" [value]="nota()" (input)="nota.set($any($event.target).value)" (keydown.enter)="confirmar()"
                         maxlength="500" autocomplete="off" /></label>
                <div class="cd-acciones">
                  <button type="button" class="cd-btn cd-pri" [disabled]="ocupado() || !nota().trim()" (click)="confirmar()">{{ d === 'recapturar' ? 'Pedir otra foto' : 'Descartar' }}</button>
                  <button type="button" class="cd-btn" (click)="pidiendoNota.set(null)">Cancelar</button>
                </div>
              } @else {
                <div class="cd-acciones">
                  <button type="button" class="cd-btn cd-pri" [disabled]="ocupado()" (click)="decidir('publicar')">Publicar <kbd>P</kbd></button>
                  <button type="button" class="cd-btn" [disabled]="ocupado()" (click)="pedirNota('recapturar')">Pedir otra foto <kbd>R</kbd></button>
                  <span class="cd-sp"></span>
                  <button type="button" class="cd-btn cd-ghost" [disabled]="ocupado()" (click)="pedirNota('descartar')">Descartar <kbd>D</kbd></button>
                </div>
              }
              @if (aviso()) { <p class="cd-aviso" role="status">{{ aviso() }}</p> }
              <p class="cd-ayuda">Publicar = la ficha queda en el catálogo digital y suma a quien la levantó · Pedir otra foto = vuelve al celular con tu nota · Descartar = la captura no sirve; ni suma ni resta. «Confirmar hallazgo» llega con Incidencias.</p>
            </section>
          }
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cd-sub { margin: var(--sp-1) 0 0; color: var(--fg-2); font-size: var(--fs-sm); display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .cd-filtros { display: flex; gap: var(--sp-1); flex-wrap: wrap; margin: var(--sp-3) 0; }
    .cd-chip { min-height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-pill); background: var(--card-bg); color: var(--fg-2); font-size: var(--fs-xs); font-weight: 600; cursor: pointer; font-variant-numeric: tabular-nums; }
    .cd-chip[aria-pressed='true'] { background: var(--fg-1); color: var(--card-bg); border-color: var(--fg-1); }
    .cd-chip:focus-visible, .cd-fila:focus-visible, .cd-btn:focus-visible, .cd-link:focus-visible, .cd-foto:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cd-md { display: grid; grid-template-columns: minmax(240px, 300px) 1fr; gap: var(--sp-4); align-items: start; }
    @container (max-width: 47.5rem) { .cd-md { grid-template-columns: 1fr; } }
    .cd { container-type: inline-size; }
    .cd-lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .cd-fila { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: var(--sp-2) var(--sp-3); border: 0; border-bottom: 1px solid var(--border-color); background: var(--card-bg); color: var(--fg-1); text-align: left; cursor: pointer; }
    .cd-fila.on { background: var(--hover-bg); box-shadow: inset 3px 0 0 var(--fg-1); }
    .cd-fila-n { font-size: var(--fs-sm); font-weight: 600; }
    .cd-fila small { color: var(--fg-3); font-size: var(--fs-xs); }
    .cd-mas { padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--fg-3); }
    .cd-link { border: 0; background: none; color: var(--fg-2); text-decoration: underline; cursor: pointer; font-size: var(--fs-xs); }
    .cd-ficha { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-4); background: var(--card-bg); display: flex; flex-direction: column; gap: var(--sp-3); }
    .cd-ficha-head h2 { margin: 0; font-size: var(--fs-h3); }
    .cd-meta { font-size: var(--fs-xs); color: var(--fg-3); }
    .cd-frase { margin: 0; font-size: var(--fs-body); font-weight: 600; }
    .cd-fotos { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--sp-2); }
    .cd-foto { display: flex; flex-direction: column; gap: var(--sp-1); align-items: center; text-decoration: none; color: var(--fg-2); font-size: var(--fs-xs); }
    .cd-foto img { width: 100%; aspect-ratio: 3 / 4; object-fit: cover; border-radius: var(--r-sm); border: 1px solid var(--border-color); background: var(--surface-ground); }
    .cd-foto-sin { justify-content: center; aspect-ratio: 3 / 4; border: 1px dashed var(--border-color); border-radius: var(--r-sm); text-align: center; padding: var(--sp-1); }
    .cd-foto-sin small { color: var(--fg-3); }
    .cd-kv { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-1) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
    .cd-kv dt { color: var(--fg-3); }
    .cd-kv dd { margin: 0; }
    .cd-mono { font-family: var(--font-mono, monospace); font-size: var(--fs-xs); overflow-wrap: anywhere; }
    .cd-acciones { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .cd-sp { flex: 1; }
    .cd-btn { min-height: 36px; padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); color: var(--fg-1); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; display: inline-flex; gap: var(--sp-2); align-items: center; }
    .cd-btn:disabled { opacity: .5; cursor: not-allowed; }
    .cd-pri { background: var(--action); border-color: var(--action); color: var(--action-ink); }
    .cd-ghost { border-color: transparent; color: var(--fg-2); }
    .cd-btn kbd { font-family: var(--font-mono, monospace); font-size: var(--fs-micro); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; opacity: .7; }
    .cd-nota { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--fg-2); }
    .cd-nota input { min-height: 36px; padding: 0 var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--surface-ground); color: var(--fg-1); font-size: var(--fs-sm); }
    .cd-aviso { margin: 0; font-size: var(--fs-sm); }
    .cd-ayuda { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); }
  `],
})
export class ComprasCatalogoDigitalComponent implements OnInit {
  private readonly api = inject(CatalogoDigitalService);
  protected readonly tabs = CATALOGO_TABS;
  protected readonly motivos = MOTIVOS;

  protected readonly datos = signal<RevisionBandeja | null>(null);
  protected readonly cargando = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly cargadoEn = signal<Date | null>(null);
  protected readonly motivo = signal<RevisionMotivo | null>(null);
  protected readonly sel = signal(0);
  protected readonly ocupado = signal(false);
  protected readonly aviso = signal<string | null>(null);
  protected readonly pidiendoNota = signal<'recapturar' | 'descartar' | null>(null);
  protected readonly nota = signal('');

  protected readonly actual = computed<RevisionFicha | null>(() => this.datos()?.rows?.[this.sel()] ?? null);
  /** «Todas» = la suma sin filtro: con un motivo puesto, `total` es el del filtro. */
  private readonly totalSinFiltro = signal(0);
  protected readonly totalBandeja = computed(() => this.totalSinFiltro());
  protected readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    return [
      { label: 'Por revisar', value: this.totalSinFiltro(), format: 'number', sub: 'fichas levantadas que esperan decisión' },
      { label: 'Sin lectura de la IA', value: d.counts.sin_analizar, format: 'number', sub: 'la IA está apagada en el piloto' },
    ];
  });

  ngOnInit(): void { void this.cargar(); }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const d = await firstValueFrom(this.api.bandeja({ reason: this.motivo(), limit: 30, offset: 0 }));
      this.datos.set(d);
      // El total SIN filtro lo manda el servidor: con un motivo puesto, «Todas» y el KPI también bajan al decidir.
      this.totalSinFiltro.set(d.total_all);
      this.cargadoEn.set(new Date());
      if (this.sel() >= d.rows.length) this.sel.set(Math.max(0, d.rows.length - 1));
    } catch (e) {
      this.error.set(this.mensajeDe(e, 'No se pudo cargar la bandeja.'));
    } finally {
      this.cargando.set(false);
    }
  }

  private masCargando = false;

  /** Un clic a la vez: dos con el mismo offset anexaban las mismas fichas dos veces. */
  async masFichas(): Promise<void> {
    const d = this.datos();
    if (!d || this.masCargando) return;
    this.masCargando = true;
    const motivo = this.motivo();
    try {
      const mas = await firstValueFrom(this.api.bandeja({ reason: motivo, limit: 30, offset: d.rows.length }));
      // Si mientras tanto cambió el filtro (o se recargó), estas filas son de OTRA lista: se tiran.
      if (this.motivo() !== motivo || this.datos() !== d) return;
      this.datos.set({ ...mas, rows: [...d.rows, ...mas.rows] });
      this.totalSinFiltro.set(mas.total_all);
    } catch (e) {
      this.aviso.set(this.mensajeDe(e, 'No se pudieron cargar más fichas. Intenta de nuevo.'));
    } finally {
      this.masCargando = false;
    }
  }

  protected filtrar(m: RevisionMotivo | null): void {
    this.motivo.set(m);
    this.sel.set(0);
    void this.cargar();
  }

  protected elegir(i: number): void {
    this.sel.set(i);
    this.pidiendoNota.set(null);
    this.aviso.set(null);
  }

  protected pedirNota(d: 'recapturar' | 'descartar'): void {
    this.nota.set('');
    this.pidiendoNota.set(d);
    // El cursor entra solo: el atajo R o D es para escribir la nota de inmediato, sin otro clic.
    setTimeout(() => (document.getElementById('cd-nota-input') as HTMLInputElement | null)?.focus(), 0);
  }

  /** Códigos que se pueden escanear (forma GS1). Las claves internas de Kepler (C…, CB…) sólo se cuentan. */
  protected escaneables(f: RevisionFicha): string[] { return f.kepler_codes.filter((c) => /^([0-9]{8}|[0-9]{12,14})$/.test(c)); }
  protected internas(f: RevisionFicha): number { return f.kepler_codes.length - this.escaneables(f).length; }

  protected confirmar(): void {
    const d = this.pidiendoNota();
    if (d && this.nota().trim()) void this.decidir(d);
  }

  /** Una decisión: el botón se apaga al primer clic (sin dobles envíos) y la ficha sale de la lista. */
  async decidir(d: RevisionDecision): Promise<void> {
    const f = this.actual();
    if (!f || this.ocupado()) return;
    this.ocupado.set(true);
    this.aviso.set(null);
    try {
      await firstValueFrom(this.api.decidir(f.id, { decision: d, note: d === 'publicar' ? undefined : this.nota().trim() }));
      this.pidiendoNota.set(null);
      this.nota.set('');
      await this.cargar();
    } catch (e) {
      this.aviso.set(this.mensajeDe(e, 'No se pudo guardar la decisión.'));
    } finally {
      this.ocupado.set(false);
    }
  }

  /** Atajos: P / R / D y flechas. No se disparan mientras se escribe la nota. */
  @HostListener('document:keydown', ['$event'])
  protected alTeclear(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = this.datos()?.rows?.length ?? 0;
    if (e.key === 'ArrowDown' && n) { this.elegir(Math.min(n - 1, this.sel() + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && n) { this.elegir(Math.max(0, this.sel() - 1)); e.preventDefault(); }
    else if ((e.key === 'p' || e.key === 'P') && this.actual() && !this.pidiendoNota()) { void this.decidir('publicar'); }
    else if ((e.key === 'r' || e.key === 'R') && this.actual()) { this.pedirNota('recapturar'); e.preventDefault(); }
    else if ((e.key === 'd' || e.key === 'D') && this.actual()) { this.pedirNota('descartar'); e.preventDefault(); }
  }

  protected texto(m: RevisionMotivo): string { return REVISION_MOTIVO_TEXTO[m]; }
  protected caraTexto(c: string): string { return CARA[c] ?? c; }
  protected motivosTexto(f: RevisionFicha): string { return f.reasons.map((m) => REVISION_MOTIVO_TEXTO[m]).join(' · ') || 'Revisión normal'; }
  protected saltoTexto(m: string | null): string {
    return m === 'no_tiene_esa_cara' ? 'no tiene esa cara' : m === 'no_se_puede_girar' ? 'no se puede girar' : 'otro motivo';
  }
  protected unidad(label: string | null | undefined, factor: number | null | undefined): string {
    const r = String(label ?? '').trim().toUpperCase();
    const base = PALABRA[r] ?? (r ? r.toLowerCase() : 'presentación');
    return factor != null && factor > 1 ? base + ' de ' + factor : base;
  }

  /** La ficha en una frase (Q.2): qué se fotografió y qué falta decidir. */
  protected frase(f: RevisionFicha): string {
    const fotos = f.photos.filter((p) => p.url).length;
    const saltos = f.photos.length - fotos;
    const partes = [fotos + ' foto' + (fotos === 1 ? '' : 's') + ' de ' + this.unidad(f.unit_label, f.unit_factor)];
    if (saltos) partes.push(saltos + ' cara' + (saltos === 1 ? '' : 's') + ' saltada' + (saltos === 1 ? '' : 's'));
    if (!f.scanned_code) partes.push('entró por el buscador: revisa que sea el producto');
    else if (f.kepler_codes.length && !f.kepler_codes.includes(f.scanned_code)) partes.push('el código escaneado no está en esta unidad en Kepler');
    return partes.join(' · ') + '.';
  }

  private mensajeDe(e: unknown, porDefecto: string): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string | string[] } | null)?.message;
      if (typeof m === 'string' && m) return m;
      if (Array.isArray(m) && m.length) return m.join(' ');
    }
    return porDefecto;
  }
}
