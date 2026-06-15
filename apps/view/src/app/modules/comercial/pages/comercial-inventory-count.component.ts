import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, ViewChild, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';
import { App as CapApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { ComercialService, InventoryCount, InventoryCounterProgress, InventoryCountResult, ResolvedProduct } from '../comercial.service';
import { CountFocusService } from '../../../core/services/count-focus.service';

interface FeedEntry {
  sku: string | null;
  name: string | null;
  qty: number;
  slot: string;
  ts: Date;
}

/**
 * Página del CONTADOR (Fase I.2) — pensada para handheld (lector HID que teclea
 * el código + Enter). Conteo CIEGO: nunca muestra el teórico ni la varianza.
 *
 * Flujo de un gesto: escaneás el código (→ salta a cantidad) → tecleás cantidad
 * (→ Enter envía) → confirmación en el feed → foco vuelve al código.
 */
@Component({
  selector: 'app-comercial-inventory-count',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    SelectModule,
    InputNumberModule,
    InputTextModule,
    TagModule,
    ToastModule,
    TooltipModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ic-page">
      <p-toast position="top-center"></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Conteo de inventario</h1>
          <p class="surf-page-sub">Escaneá el código y registrá la cantidad física. No verás el teórico.</p>
        </div>
      </header>

      @if (!folios().length) {
        <div class="ic-empty">
          <i class="pi pi-inbox"></i>
          <p>No hay ningún folio de inventario abierto para contar.</p>
          <small>Pedile a tu supervisor que abra uno.</small>
        </div>
      } @else {
        <!-- Selector de folio (oculto mientras hay un conteo en curso) -->
        @if (!sessionActive()) {
          <div class="ic-folio-row">
            <p-select
              [options]="folios()"
              [(ngModel)]="selectedFolioId"
              optionLabel="label"
              optionValue="id"
              placeholder="Elegí el folio"
              styleClass="ic-folio-select"
              appendTo="body"
              (onChange)="onFolioChange()"
            ></p-select>
          </div>
        }

        @if (selectedFolioId() && !sessionActive() && justFinishedPass() === null) {
          <!-- Pantalla de inicio: arrancar la jornada de conteo -->
          <div class="ic-start">
            <i class="pi pi-stopwatch"></i>
            <h2>Fase {{ currentPass() }} · {{ currentPass() === 1 ? 'Primer conteo' : 'Segundo conteo (ciego)' }}</h2>
            <p>Al iniciar entrás en modo conteo: la app queda fija en esta pantalla hasta que toques <b>Terminar</b>.</p>
            <button pButton label="Iniciar conteo" icon="pi pi-play" class="ic-start-btn" [loading]="starting()" (click)="startCount()"></button>
          </div>
        }

        @if (justFinishedPass() !== null) {
          <!-- Jornada terminada -->
          <div class="ic-done">
            <i class="pi pi-check-circle"></i>
            <h2>Fase {{ justFinishedPass() }} terminada</h2>
            <p>Registramos tu conteo. Esperá a que el supervisor habilite la siguiente fase o cierre el folio.</p>
            <button pButton label="Volver a contar esta fase" icon="pi pi-replay" [text]="true" severity="secondary" (click)="startCount()"></button>
          </div>
        }

        @if (sessionActive()) {
          <div class="ic-phase-banner">
            <span><i class="pi pi-stopwatch"></i> Conteo en curso · Fase {{ currentPass() }}</span>
            <button pButton label="Terminar" icon="pi pi-flag-fill" severity="success" size="small" [loading]="finishing()" (click)="finishCount()"></button>
          </div>
          <!-- Progreso ciego -->
          <div class="ic-progress">
            <div class="ic-progress-bar">
              <div class="ic-progress-fill" [style.width.%]="pct()"></div>
            </div>
            <div class="ic-progress-meta">
              <span><b>{{ progress()?.counted ?? 0 }}</b> de {{ progress()?.total ?? 0 }} contados</span>
              <span class="ic-remaining">{{ progress()?.remaining ?? 0 }} restantes</span>
              <span class="ic-mine">vos: {{ progress()?.mine ?? 0 }}</span>
            </div>
          </div>

          <!-- Captura -->
          <div class="ic-capture">
            <label class="ic-label">Código de barras</label>
            <div class="ic-code-row">
              <input
                #codeInput
                pInputText
                type="text"
                inputmode="numeric"
                autocomplete="off"
                [(ngModel)]="code"
                (keydown.enter)="onCodeEnter()"
                placeholder="Escaneá, tecleá o usá la cámara"
                class="ic-input ic-input-code"
              />
              @if (scanSupported()) {
                <button pButton type="button" icon="pi pi-camera" class="ic-scan-btn"
                        pTooltip="Escanear con la cámara" (click)="startScan()"></button>
              }
            </div>

            <!-- Overlay de cámara -->
            @if (scanning()) {
              <div class="ic-scan-overlay">
                <video #scanVideo class="ic-scan-video" playsinline muted></video>
                <div class="ic-scan-frame"></div>
                <button pButton label="Cancelar" icon="pi pi-times" severity="secondary" class="ic-scan-cancel" (click)="stopScan()"></button>
              </div>
            }

            <!-- Producto reconocido -->
            @if (resolving()) {
              <div class="ic-prod ic-prod-loading"><i class="pi pi-spin pi-spinner"></i> Buscando producto…</div>
            } @else if (resolved()) {
              <div class="ic-prod ic-prod-ok">
                <i class="pi pi-check-circle"></i>
                <div class="ic-prod-info">
                  <span class="ic-prod-name">{{ resolved()?.product_name }}</span>
                  <span class="ic-prod-meta">{{ resolved()?.sku }}@if (resolved()?.brand_name) { · {{ resolved()?.brand_name }} }@if (resolved()?.location) { · ubic. {{ resolved()?.location }} }</span>
                </div>
              </div>
            } @else if (notFound()) {
              <div class="ic-prod ic-prod-bad"><i class="pi pi-exclamation-triangle"></i> Código no reconocido en el catálogo</div>
            }

            <label class="ic-label">Cantidad física</label>
            <p-inputNumber
              #qtyInput
              [(ngModel)]="qty"
              [min]="0"
              [showButtons]="true"
              buttonLayout="horizontal"
              incrementButtonIcon="pi pi-plus"
              decrementButtonIcon="pi pi-minus"
              inputStyleClass="ic-input ic-input-qty"
              (onKeyDown)="onQtyKey($event)"
              placeholder="0"
            ></p-inputNumber>

            <button
              pButton
              label="Registrar conteo"
              icon="pi pi-check"
              class="ic-submit"
              [loading]="submitting()"
              [disabled]="!code() || qty() === null || qty() === undefined"
              (click)="submit()"
            ></button>
          </div>

          <!-- Feed de últimos conteos -->
          @if (feed().length) {
            <div class="ic-feed">
              <h3>Últimos conteos</h3>
              @for (e of feed(); track e.ts) {
                <div class="ic-feed-row">
                  <div class="ic-feed-main">
                    <span class="ic-feed-name">{{ e.name || e.sku || '—' }}</span>
                    @if (e.sku) { <span class="ic-feed-sku">{{ e.sku }}</span> }
                  </div>
                  <span class="ic-feed-qty">{{ e.qty }}</span>
                  <p-tag
                    [value]="slotLabel(e.slot)"
                    [severity]="e.slot === 'count_2' ? 'success' : (e.slot === 'count_3' ? 'warn' : 'info')"
                  ></p-tag>
                </div>
              }
            </div>
          }
        }
      }
    </div>
  `,
  styles: [`
    .ic-start, .ic-done { text-align: center; padding: 2.5rem 1.25rem; background: var(--surface-card,#fff); border: 1px solid var(--surface-200,#e7e5e4); border-radius: 16px; }
    .ic-start i, .ic-done i { font-size: 2.75rem; display: block; margin-bottom: .75rem; }
    .ic-start i { color: var(--action,#ea580c); }
    .ic-done i { color: var(--green-600,#16a34a); }
    .ic-start h2, .ic-done h2 { font-size: 1.2rem; margin: 0 0 .4rem; }
    .ic-start p, .ic-done p { color: var(--text-muted,#78716c); margin: 0 auto 1.25rem; max-width: 34ch; }
    :host ::ng-deep .ic-start-btn { padding: .85rem 2rem; font-size: 1.05rem; }
    .ic-phase-banner { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .55rem .4rem .55rem .85rem; margin-bottom: 1rem; border-radius: 12px; background: color-mix(in srgb, var(--action,#ea580c) 12%, transparent); font-weight: 600; }
    .ic-phase-banner i { margin-right: .35rem; }
    .ic-code-row { display: flex; gap: .5rem; align-items: stretch; }
    .ic-code-row .ic-input-code { flex: 1; }
    :host ::ng-deep .ic-scan-btn { min-width: 56px; }
    :host ::ng-deep .ic-scan-btn .p-button-icon { font-size: 1.4rem; }
    .ic-scan-overlay { position: relative; margin-top: .6rem; border-radius: 12px; overflow: hidden; background: #000; }
    .ic-scan-video { width: 100%; max-height: 50vh; object-fit: cover; display: block; }
    .ic-scan-frame { position: absolute; inset: 18% 12%; border: 3px solid rgba(255,255,255,.85); border-radius: 12px; box-shadow: 0 0 0 9999px rgba(0,0,0,.25); pointer-events: none; }
    .ic-scan-cancel { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); }
    .ic-prod { display: flex; align-items: center; gap: .6rem; padding: .7rem .85rem; border-radius: 12px; margin-top: .25rem; }
    .ic-prod i { font-size: 1.4rem; }
    .ic-prod-loading { background: var(--surface-100,#f5f5f4); color: var(--text-muted,#78716c); }
    .ic-prod-ok { background: color-mix(in srgb, var(--green-500,#22c55e) 12%, transparent); }
    .ic-prod-ok i { color: var(--green-600,#16a34a); }
    .ic-prod-bad { background: color-mix(in srgb, var(--red-500,#ef4444) 12%, transparent); color: var(--red-700,#b91c1c); }
    .ic-prod-info { display: flex; flex-direction: column; min-width: 0; }
    .ic-prod-name { font-weight: 700; font-size: 1.05rem; line-height: 1.2; }
    .ic-prod-meta { font-size: .8rem; color: var(--text-muted,#78716c); }
    .ic-page { max-width: 560px; margin: 0 auto; }
    .ic-empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted, #78716c); }
    .ic-empty i { font-size: 2.5rem; opacity: .5; display: block; margin-bottom: .75rem; }
    .ic-empty p { margin: 0 0 .25rem; font-weight: 600; }
    .ic-folio-row { margin-bottom: 1rem; }
    :host ::ng-deep .ic-folio-select { width: 100%; }
    .ic-progress { margin-bottom: 1.25rem; }
    .ic-progress-bar { height: 10px; border-radius: 99px; background: var(--surface-200, #e7e5e4); overflow: hidden; }
    .ic-progress-fill { height: 100%; background: var(--action, #ea580c); transition: width .3s ease; }
    .ic-progress-meta { display: flex; justify-content: space-between; gap: .5rem; font-size: .8rem; margin-top: .4rem; color: var(--text-muted, #78716c); }
    .ic-progress-meta b { color: var(--text-color, #1c1917); }
    .ic-mine { margin-left: auto; }
    .ic-capture { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1.5rem; }
    .ic-label { font-size: .8rem; font-weight: 600; color: var(--text-muted, #78716c); margin-top: .5rem; }
    :host ::ng-deep .ic-input { font-size: 1.25rem; padding: .85rem; width: 100%; }
    :host ::ng-deep .ic-input-qty { text-align: center; }
    :host ::ng-deep .p-inputnumber { width: 100%; }
    .ic-submit { margin-top: 1rem; width: 100%; }
    :host ::ng-deep .ic-submit { padding: .9rem; font-size: 1.05rem; }
    .ic-feed h3 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #78716c); margin: 0 0 .5rem; }
    .ic-feed-row { display: flex; align-items: center; gap: .75rem; padding: .6rem .25rem; border-bottom: 1px solid var(--surface-100, #f5f5f4); }
    .ic-feed-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .ic-feed-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ic-feed-sku { font-size: .75rem; color: var(--text-muted, #78716c); font-family: var(--font-mono, monospace); }
    .ic-feed-qty { font-size: 1.15rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialInventoryCountComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly focus = inject(CountFocusService);

  @ViewChild('codeInput') codeInput?: ElementRef<HTMLInputElement>;
  @ViewChild('qtyInput', { read: ElementRef }) qtyInput?: ElementRef<HTMLElement>;
  @ViewChild('scanVideo') scanVideo?: ElementRef<HTMLVideoElement>;

  // Escaneo por cámara (ZXing — universal: iOS Safari + Android).
  scanSupported = signal(typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);
  scanning = signal(false);
  private reader?: BrowserMultiFormatReader;
  private controls?: IScannerControls;

  folios = signal<{ id: string; label: string }[]>([]);
  selectedFolioId = signal<string | null>(null);
  progress = signal<InventoryCounterProgress | null>(null);
  feed = signal<FeedEntry[]>([]);
  submitting = signal(false);

  // Jornada de conteo: el contador la abre con "Iniciar" y la cierra con
  // "Terminar". Mientras está activa → modo foco (nav oculto, guard al salir).
  sessionActive = signal(false);
  starting = signal(false);
  finishing = signal(false);
  justFinishedPass = signal<number | null>(null);
  currentPass = computed(() => this.progress()?.current_pass ?? 1);

  code = signal<string>('');
  qty = signal<number | null>(null);
  resolved = signal<ResolvedProduct | null>(null);
  resolving = signal(false);
  notFound = signal(false);

  pct = computed(() => {
    const p = this.progress();
    if (!p || !p.total) return 0;
    return Math.round((p.counted / p.total) * 100);
  });

  // Integridad: detecta si el contador sale de la app / bloquea el celular
  // durante un folio activo y lo registra en la bitácora (auditoría).
  private leftAt: number | null = null;
  private appStateHandle?: PluginListenerHandle;

  constructor() {
    this.loadFolios();
    this.destroyRef.onDestroy(() => { this.stopScan(); this.focus.stop(); });
    this.setupIntegrityMonitor();
  }

  private setupIntegrityMonitor() {
    const onHidden = () => { if (this.sessionActive()) this.leftAt ??= Date.now(); };
    const onVisibility = () => { document.hidden ? onHidden() : this.flushInterruption('visibility'); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHidden); // backstop iOS (freeze sin visibilitychange)

    // Capacitor nativo: más confiable que la web para background/lock en iOS/Android.
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!this.sessionActive()) return;
      if (!isActive) this.leftAt ??= Date.now();
      else this.flushInterruption('appstate');
    }).then((h) => (this.appStateHandle = h)).catch(() => { /* web sin plugin nativo */ });

    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHidden);
      this.appStateHandle?.remove();
    });
  }

  private flushInterruption(source: 'visibility' | 'appstate') {
    const id = this.selectedFolioId();
    if (!id || this.leftAt == null) return;
    const left = this.leftAt;
    this.leftAt = null;
    const seconds = Math.round((Date.now() - left) / 1000);
    if (seconds < 2) return; // ignorar parpadeos (cambio de foco, teclado)
    this.svc.recordInventoryInterruption(id, {
      left_at: new Date(left).toISOString(),
      returned_at: new Date().toISOString(),
      duration_seconds: seconds,
      source,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => { /* best-effort */ } });
    this.toast.add({
      severity: 'info',
      summary: 'Interrupción registrada',
      detail: `Saliste de la app ${seconds}s — queda en la bitácora del folio.`,
    });
  }

  // ───── Escaneo por cámara (ZXing) ─────
  async startScan() {
    if (!this.scanSupported()) {
      this.toast.add({ severity: 'info', summary: 'Sin acceso a cámara', detail: 'Usá un lector o tecleá el código.' });
      return;
    }
    this.scanning.set(true);
    setTimeout(async () => {
      const v = this.scanVideo?.nativeElement;
      if (!v) return;
      const hints = new Map();
      // Solo los formatos reales de retail → menos trabajo por intento.
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
      ]);
      // delayBetweenScanAttempts 100ms (default 500) → ~10× más intentos/seg.
      this.reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
      try {
        this.controls = await this.reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          v,
          (result) => { if (result) this.onScanned(result.getText()); },
        );
      } catch {
        this.scanning.set(false);
        this.toast.add({ severity: 'warn', summary: 'No se pudo abrir la cámara', detail: 'Revisá los permisos (requiere HTTPS).' });
      }
    }, 80);
  }

  private onScanned(raw: string) {
    this.code.set(raw.trim());
    if (navigator.vibrate) navigator.vibrate(80);
    this.stopScan();
    this.resolveCode();
    setTimeout(() => {
      const el = this.qtyInput?.nativeElement?.querySelector('input') as HTMLInputElement | null;
      el?.focus(); el?.select();
    }, 60);
  }

  stopScan() {
    this.scanning.set(false);
    try { this.controls?.stop(); } catch { /* noop */ }
    this.controls = undefined;
    this.reader = undefined;
  }

  private loadFolios() {
    // Solo los folios que me tocan: asignado como contador, o folios sin
    // contadores asignados (modo abierto). El backend ya aplica esa regla.
    this.svc.myCountingFolios()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (open: InventoryCount[]) => {
          this.folios.set(open.map((c) => ({
            id: c.id,
            label: `${c.folio} · ${c.warehouse_code ?? ''} ${c.warehouse_name ?? ''}`.trim(),
          })));
          if (open.length === 1) {
            this.selectedFolioId.set(open[0].id);
            this.refreshProgress();
          }
        },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudieron cargar los folios' }),
      });
  }

  onFolioChange() {
    this.feed.set([]);
    this.code.set(''); this.qty.set(null);
    this.resolved.set(null); this.notFound.set(false);
    this.sessionActive.set(false);
    this.justFinishedPass.set(null);
    this.focus.stop();
    this.refreshProgress();
  }

  startCount() {
    const id = this.selectedFolioId();
    if (!id) return;
    this.starting.set(true);
    this.svc.inventoryStartSession(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.starting.set(false);
          this.sessionActive.set(true);
          this.justFinishedPass.set(null);
          this.focus.start();
          this.refreshProgress();
          this.focusCode();
        },
        error: (e) => {
          this.starting.set(false);
          this.toast.add({ severity: 'warn', summary: 'No se pudo iniciar', detail: e?.error?.message });
        },
      });
  }

  finishCount() {
    const id = this.selectedFolioId();
    if (!id) return;
    this.finishing.set(true);
    this.svc.inventoryFinishSession(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.finishing.set(false);
          this.sessionActive.set(false);
          this.focus.stop();
          this.stopScan();
          this.justFinishedPass.set(r.pass ?? this.currentPass());
        },
        error: (e) => {
          this.finishing.set(false);
          this.toast.add({ severity: 'warn', summary: 'No se pudo terminar', detail: e?.error?.message });
        },
      });
  }

  private refreshProgress() {
    const id = this.selectedFolioId();
    if (!id) return;
    this.svc.inventoryCountProgress(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (p) => this.progress.set(p) });
  }

  onCodeEnter() {
    if (!this.code()) return;
    this.resolveCode();
    // El lector mandó Enter tras el código → saltar a cantidad.
    const el = this.qtyInput?.nativeElement?.querySelector('input') as HTMLInputElement | null;
    el?.focus();
    el?.select();
  }

  /** Resuelve el código a un producto y lo muestra (confirmación tipo checador). */
  private resolveCode() {
    const barcode = this.code().trim();
    if (!barcode) { this.resolved.set(null); this.notFound.set(false); return; }
    this.resolving.set(true);
    this.notFound.set(false);
    this.resolved.set(null);
    this.svc.resolveInventoryProduct(barcode)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (p) => { this.resolved.set(p); this.resolving.set(false); },
        error: () => { this.resolving.set(false); this.notFound.set(true); },
      });
  }

  onQtyKey(event: KeyboardEvent) {
    if (event.key === 'Enter') this.submit();
  }

  submit() {
    const id = this.selectedFolioId();
    const barcode = this.code().trim();
    const quantity = this.qty();
    if (!id || !barcode || quantity === null || quantity === undefined) return;

    this.submitting.set(true);
    // Si ya resolvimos el producto, mandamos su id (más confiable que el código).
    const productId = this.resolved()?.product_id;
    const payload = productId ? { product_id: productId, quantity } : { barcode, quantity };
    this.svc.submitInventoryCount(id, payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r: InventoryCountResult) => {
          this.feed.update((f) => [
            { sku: r.sku, name: r.product_name, qty: r.quantity, slot: r.slot, ts: new Date() },
            ...f,
          ].slice(0, 15));
          this.code.set('');
          this.qty.set(null);
          this.resolved.set(null);
          this.notFound.set(false);
          this.submitting.set(false);
          this.refreshProgress();
          this.focusCode();
        },
        error: (e) => {
          this.submitting.set(false);
          this.toast.add({
            severity: 'warn',
            summary: 'No se registró',
            detail: e?.error?.message || 'Código no encontrado o folio cerrado',
          });
          this.focusCode();
        },
      });
  }

  private focusCode() {
    setTimeout(() => {
      this.codeInput?.nativeElement?.focus();
      this.codeInput?.nativeElement?.select();
    }, 50);
  }

  slotLabel(slot: string): string {
    if (slot === 'count_1') return '1er conteo';
    if (slot === 'count_2') return '2do conteo';
    return 'reconteo';
  }
}
