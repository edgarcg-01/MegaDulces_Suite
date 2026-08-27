import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { EntradasService, EntradaRow, ProofFile, ReceiptSettings, AttachReceipt, RemisionOcr } from '../entradas.service';
import { branchName } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

type EstadoHoja = 'leyendo' | 'enlazada' | 'ambigua' | 'sin_match' | 'duplicada' | 'guardada' | 'error';

/** Un archivo del bonche, con su lectura, su enlace propuesto y su destino. */
interface Hoja {
  id: number;
  name: string;
  dataUri: string;
  kind: 'image' | 'pdf';
  estado: EstadoHoja;
  // lectura
  sha256?: string;
  folioOcr?: string | null;
  total?: number | null;
  subtotal?: number | null;
  fecha?: string | null;
  rfc?: string | null;
  ocr?: Partial<RemisionOcr>;
  // enlace
  entrada?: EntradaRow | null;
  candidatas?: EntradaRow[];
  porMonto?: boolean;       // enlazada por monto, no por folio → menos confianza
  dupDe?: string | null;
  motivo?: string | null;   // por qué quedó afuera al guardar
  buscando?: boolean;
  busqueda?: string;
}

/**
 * `[RE.13.3]` — **Captura por lote (CEDIS)**.
 *
 * CEDIS es el 74% del volumen de la red (~815 entradas/mes, ~30 por día hábil) en manos de una
 * o dos personas, y sus facturas llegan ya digitales. Con el flujo de a una —dos pasos, diálogo
 * modal, buscar el folio a mano— son unas 8 interacciones por entrada: **240 al día**. Inviable.
 *
 * Acá el humano **no busca la entrada**: suelta el bonche y confirma el enlace. El motor ya
 * existía completo (`ocr` lee cada hoja, `matchByOcr` enlaza por folio con monto como respaldo,
 * el dedup por hash detecta la repetida); lo que faltaba era esta superficie.
 */
@Component({
  selector: 'app-compras-entradas-lote',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TagModule, ToastModule],
  providers: [MessageService],
  template: `
    <div class="surf-page in lt">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Captura por lote</h1>
          <p class="surf-page-sub">
            Soltá todas las facturas del día juntas. Las leo, las enlazo por folio con su orden de
            entrada y vos sólo confirmás. Para CEDIS, que recibe ~30 al día.
          </p>
        </div>
        <div class="lt-head-actions">
          @if (hojas().length) {
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="procesando() || guardando()" (click)="limpiar()">
              <span class="p-button-icon p-button-icon-left pi pi-trash" aria-hidden="true"></span>
              <span class="p-button-label">Vaciar</span>
            </button>
          }
          <label class="lt-pick" [class.disabled]="procesando()">
            <i class="pi pi-upload" aria-hidden="true"></i> Agregar archivos
            <input type="file" accept="image/*,application/pdf" multiple hidden (change)="onFiles($event)" [disabled]="procesando()" />
          </label>
        </div>
      </header>

      @if (!canManage()) {
        <div class="lt-block"><i class="pi pi-lock" aria-hidden="true"></i>
          <span>No tenés permiso para capturar evidencia de entradas.</span></div>
      } @else if (!hojas().length) {
        <div class="lt-drop" [class.drag]="dragging()"
             (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
          <i class="pi pi-cloud-upload lt-drop-ico" aria-hidden="true"></i>
          <p class="lt-drop-main">Arrastrá acá el bonche de facturas</p>
          <p class="lt-drop-sub">PDF o fotos, hasta {{ tope() }} archivos por lote. Se leen de 3 en 3 para no saturar.</p>
          <label class="lt-pick primary">
            <i class="pi pi-upload" aria-hidden="true"></i> Elegir archivos
            <input type="file" accept="image/*,application/pdf" multiple hidden (change)="onFiles($event)" />
          </label>
        </div>
      } @else {
        <!-- Contadores honestos: lo enlazado, lo que necesita mano y lo que no entra. -->
        <div class="lt-counts" role="status">
          <span class="lt-c ok"><b>{{ n('enlazada') + n('guardada') }}</b> enlazadas</span>
          @if (n('ambigua')) { <span class="lt-c warn"><b>{{ n('ambigua') }}</b> ambiguas</span> }
          @if (n('sin_match')) { <span class="lt-c warn"><b>{{ n('sin_match') }}</b> sin enlazar</span> }
          @if (n('duplicada')) { <span class="lt-c bad"><b>{{ n('duplicada') }}</b> ya subidas</span> }
          @if (n('error')) { <span class="lt-c bad"><b>{{ n('error') }}</b> con error</span> }
          @if (procesando()) {
            <span class="lt-c proc"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> leyendo {{ n('leyendo') }}…</span>
          }
          <span class="lt-c-sep"></span>
          <span class="lt-c muted">{{ hojas().length }} archivos</span>
          <button pButton type="button" [loading]="guardando()" [disabled]="!listas().length || procesando()" (click)="guardar()">
            <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
            <span class="p-button-label">Guardar {{ nExpedientes() }} {{ nExpedientes() === 1 ? 'entrada' : 'entradas' }}</span>
          </button>
        </div>

        <!-- Tabla propia (no p-table): cada renglón tiene su propio sub-formulario de
             desambiguación, y meter eso en un template de celda vuelve el grid ilegible. -->
        <div class="lt-table" role="table" aria-label="Conciliación del lote">
          <div class="lt-h" role="row">
            <span role="columnheader">Archivo</span>
            <span role="columnheader">Orden de entrada</span>
            <span role="columnheader" class="ta-r">Kepler</span>
            <span role="columnheader" class="ta-r">Factura</span>
            <span role="columnheader" class="ta-r">Δ</span>
            <span role="columnheader">Estado</span>
            <span role="columnheader"></span>
          </div>

          @for (h of hojas(); track h.id) {
            <div class="lt-r" role="row" [class]="'is-' + h.estado">
              <span role="cell" class="lt-file">
                <i class="pi" [ngClass]="h.kind === 'pdf' ? 'pi-file-pdf' : 'pi-image'" aria-hidden="true"></i>
                <span class="lt-file-n" [title]="h.name">{{ h.name }}</span>
                @if (h.folioOcr) { <em class="lt-file-folio">folio leído {{ h.folioOcr }}</em> }
              </span>

              <span role="cell" class="lt-link">
                @if (h.estado === 'leyendo') {
                  <span class="muted"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> leyendo…</span>
                } @else if (h.entrada; as e) {
                  <span class="lt-ent">
                    <b class="mono">{{ suc(e.sucursal) }} · {{ e.folio }}</b>
                    <em>{{ e.proveedor_nombre || e.proveedor_code }}</em>
                    @if (h.porMonto) { <span class="lt-bymonto" title="Enlazada por monto: el OCR no leyó el folio. Verificá que sea la correcta.">por monto</span> }
                    @if (e.deposits > 0) { <span class="lt-yatiene" title="Esta entrada ya tiene evidencia; se agrega otra">ya tiene</span> }
                  </span>
                  @if (h.estado !== 'guardada') {
                    <button type="button" class="lt-chg" (click)="desenlazar(h)">cambiar</button>
                  }
                } @else if (h.dupDe) {
                  <span class="bad">Ya subida en {{ h.dupDe }}</span>
                } @else {
                  <span class="lt-find">
                    @if (h.candidatas?.length) {
                      <span class="muted">{{ h.candidatas!.length }} posibles:</span>
                      @for (c of h.candidatas!; track c.sucursal + '/' + c.folio) {
                        <button type="button" class="lt-cand" (click)="elegir(h, c)">
                          <b class="mono">{{ c.folio }}</b> {{ c.proveedor_nombre || c.proveedor_code }} · {{ money(c.monto) }}
                        </button>
                      }
                    }
                    <span class="lt-find-in">
                      <input pInputText [(ngModel)]="h.busqueda" (keyup.enter)="buscar(h)"
                             placeholder="Últimos 4 o proveedor…" [attr.aria-label]="'Buscar entrada para ' + h.name" />
                      <button pButton type="button" size="small" [loading]="!!h.buscando" (click)="buscar(h)" ariaLabel="Buscar">
                        <span class="p-button-icon pi pi-search" aria-hidden="true"></span>
                      </button>
                    </span>
                  </span>
                }
              </span>

              <span role="cell" class="ta-r num">{{ h.entrada ? money(h.entrada.monto) : '—' }}</span>
              <span role="cell" class="ta-r num">{{ h.total != null ? money(h.total) : (h.subtotal != null ? money(h.subtotal) : '—') }}</span>
              <span role="cell" class="ta-r num" [class.bad]="delta(h) !== null && !cuadra(h)">
                @if (delta(h) !== null) { {{ cuadra(h) ? '—' : money(delta(h)!) }} } @else { — }
              </span>

              <span role="cell">
                @switch (h.estado) {
                  @case ('guardada') { <p-tag value="Guardada" severity="success" /> }
                  @case ('enlazada') {
                    @if (cuadra(h)) { <p-tag value="Cuadra" severity="success" /> }
                    @else if (h.total == null && h.subtotal == null) { <p-tag value="Sin total leído" severity="warn" /> }
                    @else { <p-tag value="No cuadra" severity="warn" /> }
                  }
                  @case ('ambigua') { <p-tag value="Elegí cuál" severity="warn" /> }
                  @case ('sin_match') { <p-tag value="Sin enlazar" severity="warn" /> }
                  @case ('duplicada') { <p-tag value="Duplicada" severity="danger" /> }
                  @case ('error') { <p-tag [value]="h.motivo || 'Error'" severity="danger" /> }
                  @default { <span class="muted">…</span> }
                }
              </span>

              <span role="cell">
                @if (h.estado !== 'guardada') {
                  <button type="button" class="lt-x" (click)="quitar(h)" [attr.aria-label]="'Quitar ' + h.name">
                    <i class="pi pi-times" aria-hidden="true"></i>
                  </button>
                }
              </span>
            </div>
          }
        </div>

        <p class="lt-hint">
          Varias hojas enlazadas a la <strong>misma entrada</strong> se guardan como un solo
          expediente. Las que no cuadran <strong>se pueden guardar igual</strong>: el revisor
          decide. Las duplicadas y las que no tienen entrada enlazada quedan afuera hasta que
          las resuelvas.
        </p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .lt-head-actions { display: flex; align-items: center; gap: .5rem; }
    .lt-pick { display: inline-flex; align-items: center; gap: .4rem; cursor: pointer; padding: .45rem .85rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); font-weight: 600; min-height: 2.5rem; }
    .lt-pick:hover { border-color: var(--action); color: var(--action); }
    .lt-pick.primary { background: var(--action); border-color: var(--action); color: #fff; }
    .lt-pick.primary:hover { filter: brightness(1.06); color: #fff; }
    .lt-pick.disabled { opacity: .5; pointer-events: none; }
    .lt-pick:focus-within { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }

    .lt-block { display: flex; gap: .6rem; align-items: center; padding: 1rem 1.2rem; color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); }
    .lt-drop { display: grid; place-items: center; gap: .5rem; padding: 3.5rem 1.5rem; text-align: center;
      border: 2px dashed var(--border-color); border-radius: var(--r-md, .5rem); }
    .lt-drop.drag { border-color: var(--action); background: color-mix(in oklab, var(--action) 5%, transparent); }
    .lt-drop-ico { font-size: 2rem; color: var(--text-muted); }
    .lt-drop-main { margin: 0; font-weight: 600; font-size: 1.05rem; }
    .lt-drop-sub { margin: 0; color: var(--text-muted); font-size: var(--fs-sm, .85rem); }

    .lt-counts { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; padding: .6rem .8rem; margin-bottom: .7rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-sunken, var(--card-bg)); }
    .lt-c { font-size: var(--fs-sm, .85rem); color: var(--text-muted); }
    .lt-c b { font-variant-numeric: tabular-nums; font-size: 1.05rem; color: var(--text-main); }
    .lt-c.ok b { color: var(--ok-fg); }
    .lt-c.warn b { color: var(--warn-fg, var(--bad-fg)); }
    .lt-c.bad b { color: var(--bad-fg); }
    .lt-c-sep { flex: 1; }

    .lt-table { display: grid; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); overflow: hidden; }
    .lt-h, .lt-r { display: grid; gap: .6rem; align-items: center; padding: .5rem .7rem;
      grid-template-columns: minmax(9rem, 1.2fr) minmax(12rem, 1.6fr) 7rem 7rem 6rem 8rem 2rem; }
    .lt-h { background: var(--surface-sunken, var(--card-bg)); font-size: var(--fs-micro, .72rem);
      text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .lt-r { border-top: 1px solid var(--border-color); font-size: var(--fs-sm, .85rem); }
    .lt-r.is-duplicada, .lt-r.is-error { background: color-mix(in oklab, var(--bad-fg) 5%, transparent); }
    .lt-r.is-guardada { opacity: .65; }
    @media (max-width: 78rem) {
      .lt-h { display: none; }
      .lt-r { grid-template-columns: 1fr 1fr; grid-auto-rows: min-content; }
      .lt-r > [role='cell']:nth-child(2) { grid-column: 1 / -1; }
    }
    .lt-file { display: flex; align-items: center; gap: .4rem; min-width: 0; flex-wrap: wrap; }
    .lt-file-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 12rem; }
    .lt-file-folio { font-style: normal; font-size: var(--fs-micro, .72rem); color: var(--text-muted); flex: 1 1 100%; }
    .lt-link { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; min-width: 0; }
    .lt-ent { display: flex; align-items: baseline; gap: .35rem; flex-wrap: wrap; min-width: 0; }
    .lt-ent em { font-style: normal; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 11rem; }
    .lt-bymonto, .lt-yatiene { font-size: var(--fs-micro, .72rem); border: 1px solid currentColor; border-radius: 99px; padding: 0 .35rem; }
    .lt-bymonto { color: var(--warn-fg, var(--bad-fg)); }
    .lt-yatiene { color: var(--text-muted); }
    .lt-chg { background: transparent; border: 0; color: var(--action); cursor: pointer; font: inherit; font-size: var(--fs-micro, .72rem); text-decoration: underline; }
    .lt-find { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
    .lt-cand { display: inline-flex; align-items: baseline; gap: .3rem; cursor: pointer; font: inherit; font-size: var(--fs-micro, .72rem);
      background: transparent; border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); padding: .1rem .35rem; }
    .lt-cand:hover { border-color: var(--action); color: var(--action); }
    .lt-find-in { display: inline-flex; gap: .25rem; }
    .lt-find-in input { width: 10rem; font-size: var(--fs-sm, .85rem); padding: .2rem .4rem; }
    .mono { font-family: var(--font-mono); font-size: .92em; }
    .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); }
    .lt-x { background: transparent; border: 0; color: var(--text-muted); cursor: pointer; padding: .2rem; }
    .lt-x:hover { color: var(--bad-fg); }
    .lt-hint { margin: .6rem 0 0; font-size: var(--fs-xs, .75rem); color: var(--text-muted); }
  `],
})
export class ComprasEntradasLoteComponent {
  private readonly svc = inject(EntradasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly hojas = signal<Hoja[]>([]);
  readonly procesando = signal(false);
  readonly guardando = signal(false);
  readonly dragging = signal(false);
  private readonly cfg = signal<ReceiptSettings | null>(null);
  private seq = 0;
  /** De 3 en 3: cada hoja es una llamada de visión, y el lote son 30. */
  private static readonly EN_VUELO = 3;

  money = money;
  suc(code: string): string { return branchName(code) || code; }
  tope(): number { return this.cfg()?.bulk_max_files ?? 50; }

  readonly canManage = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_GESTIONAR] === true);

  n(e: EstadoHoja): number { return this.hojas().filter((h) => h.estado === e).length; }
  /** Lo que se puede mandar: enlazada, sin duplicar, y todavía no guardada. */
  readonly listas = computed(() => this.hojas().filter((h) => h.estado === 'enlazada' && h.entrada && !h.dupDe));
  /**
   * Cuántos EXPEDIENTES se van a crear — no cuántos archivos. Una factura de 2 hojas son 2
   * archivos y una sola entrada, y el botón que prometía "2" mentía sobre lo que iba a pasar.
   */
  readonly nExpedientes = computed(() => {
    const k = new Set(this.listas().map((h) => `${h.entrada!.sucursal}|${h.entrada!.folio}`));
    return k.size;
  });

  constructor() {
    this.svc.settings().subscribe({ next: (s) => this.cfg.set(s), error: () => void 0 });
  }

  delta(h: Hoja): number | null {
    if (!h.entrada) return null;
    const cands = [h.total, h.subtotal].filter((v): v is number => v != null);
    if (!cands.length) return null;
    return Math.min(...cands.map((v) => Math.abs(v - h.entrada!.monto)));
  }
  cuadra(h: Hoja): boolean {
    const d = this.delta(h);
    return d !== null && d <= (this.cfg()?.match_tolerance ?? 1);
  }

  // ── entrada de archivos ──
  onDragOver(e: DragEvent): void { e.preventDefault(); this.dragging.set(true); }
  onDragLeave(e: DragEvent): void { e.preventDefault(); this.dragging.set(false); }
  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) void this.agregar(files);
  }
  onFiles(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) void this.agregar(files);
  }

  private async agregar(files: File[]): Promise<void> {
    const espacio = this.tope() - this.hojas().length;
    if (espacio <= 0) {
      this.toast.add({ severity: 'warn', summary: `El lote llegó al tope de ${this.tope()}`, detail: 'Guardá lo que hay y seguí con otro lote.' });
      return;
    }
    const lote = files.slice(0, espacio);
    if (lote.length < files.length) {
      this.toast.add({ severity: 'warn', summary: `Se tomaron ${lote.length} de ${files.length}`, detail: `El tope del lote es ${this.tope()} archivos.` });
    }
    const nuevas: Hoja[] = [];
    for (const f of lote) {
      const esPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      let dataUri: string;
      try { dataUri = esPdf ? await this.leer(f) : await this.comprimir(f); }
      catch { continue; }
      nuevas.push({
        id: ++this.seq, name: f.name || (esPdf ? 'factura.pdf' : 'factura.jpg'),
        dataUri, kind: esPdf ? 'pdf' : 'image', estado: 'leyendo', busqueda: '',
      });
    }
    if (!nuevas.length) return;
    this.hojas.update((l) => [...l, ...nuevas]);
    await this.procesar(nuevas);
  }

  /**
   * Lee y enlaza con concurrencia acotada. El pool es a mano y no con `forkJoin` porque 30
   * llamadas de visión en paralelo es exactamente cómo se choca con el rate-limit del proveedor.
   */
  private async procesar(lote: Hoja[]): Promise<void> {
    this.procesando.set(true);
    const cola = [...lote];
    const obreros = Array.from({ length: Math.min(ComprasEntradasLoteComponent.EN_VUELO, cola.length) }, async () => {
      for (;;) {
        const h = cola.shift();
        if (!h) return;
        await this.leerYEnlazar(h);
      }
    });
    await Promise.all(obreros);
    this.procesando.set(false);
  }

  private async leerYEnlazar(h: Hoja): Promise<void> {
    try {
      const o = await firstValueFrom(this.svc.ocr(h.dataUri, 'factura'));
      this.parchar(h.id, {
        sha256: o.sha256, folioOcr: o.folio, total: o.total, subtotal: o.subtotal,
        fecha: o.fecha, rfc: o.rfc, ocr: o,
      });
      if (o.duplicate) {
        this.parchar(h.id, { estado: 'duplicada', dupDe: `${o.duplicate.sucursal}/${o.duplicate.folio}` });
        return;
      }
      // FOLIO primero (preciso), MONTO como respaldo — la misma prioridad del server.
      const r = await firstValueFrom(this.svc.matchByOcr({
        folio: o.folio || undefined,
        total: o.total ?? o.subtotal ?? undefined,
        fecha: o.fecha || undefined,
      }));
      const cands = r?.entradas || [];
      if (cands.length === 1) {
        this.parchar(h.id, { estado: 'enlazada', entrada: cands[0], porMonto: !o.folio, candidatas: [] });
      } else if (cands.length > 1) {
        this.parchar(h.id, { estado: 'ambigua', candidatas: cands.slice(0, 5) });
      } else {
        this.parchar(h.id, { estado: 'sin_match', candidatas: [] });
      }
    } catch (e: any) {
      this.parchar(h.id, { estado: 'error', motivo: e?.error?.message || 'no se pudo leer' });
    }
  }

  private parchar(id: number, p: Partial<Hoja>): void {
    this.hojas.update((l) => l.map((h) => (h.id === id ? { ...h, ...p } : h)));
  }

  elegir(h: Hoja, e: EntradaRow): void {
    this.parchar(h.id, { entrada: e, estado: 'enlazada', candidatas: [], porMonto: !h.folioOcr });
  }
  desenlazar(h: Hoja): void {
    this.parchar(h.id, { entrada: null, estado: 'sin_match', candidatas: [], porMonto: false });
  }
  quitar(h: Hoja): void { this.hojas.update((l) => l.filter((x) => x.id !== h.id)); }
  limpiar(): void { this.hojas.set([]); }

  buscar(h: Hoja): void {
    const q = (h.busqueda || '').trim();
    if (!q) return;
    this.parchar(h.id, { buscando: true });
    this.svc.matchByOcr({ search: q }).subscribe({
      next: (r) => {
        const cands = r?.entradas || [];
        this.parchar(h.id, {
          buscando: false,
          candidatas: cands.slice(0, 8),
          estado: cands.length ? 'ambigua' : 'sin_match',
        });
      },
      error: () => this.parchar(h.id, { buscando: false }),
    });
  }

  guardar(): void {
    const listas = this.listas();
    if (!listas.length || this.guardando()) return;
    this.guardando.set(true);
    // Subir primero (Cloudinary/bucket), después adjuntar el lote entero: si una subida
    // falla, esa hoja queda fuera pero las demás siguen.
    const subidas: { h: Hoja; file: ProofFile }[] = [];
    const fallas: Hoja[] = [];
    (async () => {
      for (const h of listas) {
        try {
          const up = await firstValueFrom(this.svc.uploadFile(h.dataUri, 'factura'));
          subidas.push({
            h,
            file: {
              ...up, role: 'factura', name: h.name, sha256: h.sha256,
              ocr_folio: h.folioOcr ?? null, ocr_total: h.total ?? null,
              ocr_fecha: h.fecha ?? null, ocr_rfc: h.rfc ?? null,
            },
          });
        } catch {
          fallas.push(h);
          this.parchar(h.id, { estado: 'error', motivo: 'no se pudo subir el archivo' });
        }
      }
      if (!subidas.length) { this.guardando.set(false); return; }
      // AGRUPAR por entrada antes de mandar. Una factura de 2 hojas son 2 archivos pero UN
      // expediente: mandando un item por archivo, el server creaba dos evidencias para la
      // misma entrada (el dedup por hash no las cruza porque son hojas distintas) y el
      // revisor veía la misma factura dos veces.
      const porEntrada = new Map<string, { h: Hoja; file: ProofFile }[]>();
      for (const s of subidas) {
        const k = `${s.h.entrada!.sucursal}|${s.h.entrada!.folio}`;
        porEntrada.set(k, [...(porEntrada.get(k) || []), s]);
      }
      const items: AttachReceipt[] = [...porEntrada.values()].map((grupo) => ({
        sucursal: grupo[0].h.entrada!.sucursal,
        folio: grupo[0].h.entrada!.folio,
        files: grupo.map((g) => g.file),
        // La lectura que manda para el cuadre es la de la hoja que trae importe.
        ocr: (grupo.find((g) => g.h.total != null || g.h.subtotal != null) || grupo[0]).h.ocr,
      }));
      try {
        const r = await firstValueFrom(this.svc.attachBulk(items));
        // Cada renglón sabe qué le pasó: el server contesta por expediente, y todas las hojas
        // de un expediente comparten su resultado.
        for (const { h } of subidas) {
          const d = r.detalle.find((x) => x.sucursal === h.entrada!.sucursal && x.folio === h.entrada!.folio);
          if (d?.ok) this.parchar(h.id, { estado: 'guardada' });
          else this.parchar(h.id, { estado: 'error', motivo: d?.motivo || 'no se pudo adjuntar' });
        }
        this.guardando.set(false);
        this.toast.add({
          severity: r.omitidas ? 'warn' : 'success',
          summary: `${r.guardadas} guardadas`,
          detail: r.omitidas
            ? `${r.omitidas} quedaron afuera — mirá el motivo en su renglón.`
            : `${r.cuadran} cuadran al peso; el resto lo revisa el revisor.`,
        });
      } catch (e: any) {
        this.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo guardar el lote', detail: e?.error?.message || '' });
      }
    })();
  }

  // ── utilidades de archivo (mismas que la captura de sucursal) ──
  private leer(file: File): Promise<string> {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
  }
  private async comprimir(file: File): Promise<string> {
    const raw = await this.leer(file);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('ilegible')); i.src = raw;
      });
      const max = 1600;
      const esc = Math.min(1, max / Math.max(img.width, img.height));
      if (esc === 1 && raw.length < 1_500_000) return raw;
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * esc); cv.height = Math.round(img.height * esc);
      cv.getContext('2d')?.drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.8);
    } catch { return raw; }
  }
}
