import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  VendorService,
  RouteTicket,
  RouteTicketType,
  ProcesarRouteTicketResult,
} from '../vendor.service';

type Step = 'pick' | 'review' | 'success';

interface EditableCargaLine {
  product_id: string;
  product_name: string;
  quantity: number;
  include: boolean;
}

const TYPE_META: Record<RouteTicketType, { label: string; icon: string; desc: string }> = {
  venta: { label: 'Corte de venta', icon: 'pi-receipt', desc: 'Cierre del día' },
  carga: { label: 'Carga', icon: 'pi-box', desc: 'Mercancía al camión' },
  combustible: { label: 'Combustible', icon: 'pi-bolt', desc: 'Gasolina / diésel' },
};

@Component({
  selector: 'app-vendor-close-route',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="crt">
      <header class="crt-head">
        <div class="crt-head-text">
          <h1>Cierre de ruta</h1>
          <p>Sube tus tickets del día: corte, carga y combustible</p>
        </div>
        @if (step() === 'pick' && !loadingList()) {
          <div class="crt-daycount" aria-label="Tickets de hoy">
            <span class="crt-daycount-n">{{ tickets().length }}</span>
            <span class="crt-daycount-l">hoy</span>
          </div>
        }
      </header>

      <input
        #fileInput
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        (change)="onFile($event)"
      />

      <!-- Requisitos del día: venta + carga obligatorios -->
      <div *ngIf="step() === 'pick' && !loadingList() && !ocrError()" class="crt-reqs" [class.done]="requiredDone()">
        <div class="crt-reqs-head">
          <span class="crt-reqs-title">
            <i class="pi" [ngClass]="requiredDone() ? 'pi-check-circle' : 'pi-flag'" aria-hidden="true"></i>
            {{ requiredDone() ? 'Cierre completo' : 'Para cerrar tu día' }}
          </span>
          <span class="crt-reqs-status">{{ requiredDone() ? '✓ listo' : 'faltan obligatorios' }}</span>
        </div>
        <div class="crt-reqs-items">
          <span class="crt-req" [class.done]="hasVenta()">
            <i class="pi" [ngClass]="hasVenta() ? 'pi-check' : 'pi-circle'" aria-hidden="true"></i>
            Venta <em>obligatorio</em>
          </span>
          <span class="crt-req" [class.done]="hasCarga()">
            <i class="pi" [ngClass]="hasCarga() ? 'pi-check' : 'pi-circle'" aria-hidden="true"></i>
            Carga <em>obligatorio</em>
          </span>
          <span class="crt-req opt" [class.done]="hasCombustible()">
            <i class="pi" [ngClass]="hasCombustible() ? 'pi-check' : 'pi-circle'" aria-hidden="true"></i>
            Combustible <em>opcional</em>
          </span>
        </div>
      </div>

      <!-- Paso 1: elegir tipo -->
      <div *ngIf="step() === 'pick' && !ocrError()" class="crt-pick">
        <button *ngFor="let t of types; let i = index" type="button" class="crt-tile"
          [attr.data-type]="t" (click)="choose(t)" [style.animation-delay.ms]="i * 80">
          <span class="crt-tile-glow" aria-hidden="true"></span>
          <span class="crt-tile-icon"><i class="pi {{ meta[t].icon }}" aria-hidden="true"></i></span>
          <span class="crt-tile-body">
            <span class="crt-tile-label">{{ meta[t].label }}</span>
            <span class="crt-tile-desc">{{ meta[t].desc }}</span>
          </span>
          <span class="crt-tile-cta">
            <i class="pi pi-camera" aria-hidden="true"></i>
            <span class="crt-tile-cta-text">Tomar foto</span>
            <i class="pi pi-arrow-right crt-tile-arrow" aria-hidden="true"></i>
          </span>
        </button>
      </div>

      <!-- Procesando OCR -->
      <div *ngIf="processing()" class="crt-processing" role="status" aria-live="polite">
        <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
        <span>Extrayendo datos del ticket…</span>
      </div>

      <!-- Falló el OCR: conservamos la foto y dejamos reintentar sin re-capturar -->
      <div *ngIf="ocrError() && !processing()" class="crt-ocr-error">
        <img *ngIf="photoPreview()" [src]="photoPreview()!" class="crt-preview" alt="Ticket capturado" />
        <p class="crt-warn">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          No se pudo leer el ticket. Revisá tu conexión — tu foto sigue acá.
        </p>
        <button type="button" class="crt-save" (click)="retryOcr()">
          <i class="pi pi-refresh" aria-hidden="true"></i> Reintentar lectura
        </button>
        <button type="button" class="crt-change crt-ocr-retake" (click)="reset()">
          <i class="pi pi-camera" aria-hidden="true"></i> Tomar otra foto
        </button>
      </div>

      <!-- Paso 2: revisar + guardar -->
      <div *ngIf="step() === 'review'" class="crt-review">
        <div class="crt-review-head">
          <span class="crt-type-chip" [attr.data-type]="selectedType()">
            <i class="pi {{ meta[selectedType()!].icon }}" aria-hidden="true"></i>{{ meta[selectedType()!].label }}
          </span>
          <button type="button" class="crt-change" (click)="reset()">
            <i class="pi pi-times" aria-hidden="true"></i> Cambiar
          </button>
        </div>

        <img *ngIf="photoPreview()" [src]="photoPreview()!" class="crt-preview" alt="Ticket capturado" />

        <div class="crt-fields">
          <!-- Ruta: NO editable. La detecta el OCR y la valida el backend contra
               las rutas reales de la zona del vendedor. -->
          <div class="crt-field">
            <span class="crt-field-label">Ruta</span>
            <div class="crt-route" [class.ok]="routeMatched()" [class.bad]="!routeMatched()">
              <i class="pi" [ngClass]="routeMatched() ? 'pi-check-circle' : 'pi-exclamation-triangle'" aria-hidden="true"></i>
              <span class="crt-route-name">{{ routeMatched() ? routeValue() : 'Ruta no reconocida' }}</span>
              <span class="crt-route-tag">{{ routeMatched() ? 'detectada' : 'reintenta' }}</span>
            </div>
            <p class="crt-route-hint" *ngIf="!routeMatched()">
              La ruta del ticket no coincide con ninguna ruta de tu zona. Vuelve a tomar la foto con la ruta visible.
            </p>
          </div>

          <div class="crt-field">
            <span class="crt-field-label">Fecha</span>
            <div class="crt-ro" [class.empty]="!form.ticket_date">{{ fmtDate(form.ticket_date) }}</div>
          </div>

          <div class="crt-field">
            <span class="crt-field-label">Total</span>
            <div class="crt-ro" [class.empty]="form.total == null">{{ form.total != null ? fmtMoney(form.total) : 'sin detectar' }}</div>
          </div>

          <div class="crt-field" *ngIf="selectedType() === 'venta'">
            <span class="crt-field-label">Número de corte</span>
            <div class="crt-ro" [class.empty]="!form.corte_number">{{ form.corte_number || 'sin detectar' }}</div>
          </div>

          <div class="crt-field" *ngIf="selectedType() === 'carga'">
            <span class="crt-field-label">Folio</span>
            <div class="crt-ro" [class.empty]="!form.folio">{{ form.folio || 'sin detectar' }}</div>
          </div>

          <div class="crt-field" *ngIf="selectedType() === 'combustible'">
            <span class="crt-field-label">Litros</span>
            <div class="crt-ro" [class.empty]="form.liters == null">{{ form.liters != null ? form.liters + ' L' : 'sin detectar' }}</div>
          </div>

          <div class="crt-field" *ngIf="selectedType() === 'combustible'">
            <span class="crt-field-label">Referencia / folio</span>
            <div class="crt-ro" [class.empty]="!form.reference">{{ form.reference || 'sin detectar' }}</div>
          </div>
        </div>

        <!-- Carga: productos detectados → descargan al camión (solo lectura) -->
        <div *ngIf="selectedType() === 'carga'" class="crt-lines">
          <div class="crt-lines-head">
            <span>Productos cargados al camión</span>
            <span class="crt-lines-count">{{ cargaLines().length }}</span>
          </div>
          <p class="crt-lines-empty" *ngIf="cargaLines().length === 0">
            No se detectaron productos. Se guarda solo el total.
          </p>
          <div class="crt-line-ro" *ngFor="let l of cargaLines()">
            <span class="crt-line-name">{{ l.product_name }}</span>
            <span class="crt-line-qty-ro">×{{ l.quantity }}</span>
          </div>
        </div>

        <p class="crt-note">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          Los datos se leen del ticket y no son editables. Si algo está mal, vuelve a tomar la foto.
        </p>

        <p class="crt-warn" *ngIf="!canSave()">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          No se pudo leer la ruta o la fecha del ticket. Vuelve a tomar la foto.
        </p>

        <button type="button" class="crt-save" [disabled]="!canSave() || saving()" (click)="save()">
          <i class="pi" [ngClass]="saving() ? 'pi-spin pi-spinner' : 'pi-check'" aria-hidden="true"></i>
          Guardar ticket
        </button>
      </div>

      <!-- Paso 3: éxito (card animada) -->
      <div *ngIf="step() === 'success' && savedSummary() as s" class="crt-success">
        <div class="crt-check" aria-hidden="true">
          <svg viewBox="0 0 52 52">
            <circle class="crt-check-ring" cx="26" cy="26" r="24" fill="none"/>
            <path class="crt-check-mark" fill="none" d="M14 27l8 8 16-17"/>
          </svg>
        </div>
        <h2 class="crt-success-title">Ticket guardado</h2>
        <span class="crt-type-chip" [attr.data-type]="s.type">
          <i class="pi {{ meta[s.type].icon }}" aria-hidden="true"></i>{{ meta[s.type].label }}
        </span>
        <p class="crt-success-meta">{{ s.route }}<span *ngIf="s.total != null"> · {{ fmtMoney(s.total) }}</span></p>
        @if (!requiredDone()) {
          <p class="crt-success-next">
            Te falta {{ !hasVenta() ? 'el corte de venta' : '' }}{{ !hasVenta() && !hasCarga() ? ' y ' : '' }}{{ !hasCarga() ? 'la carga' : '' }} para cerrar el día.
          </p>
        } @else {
          <p class="crt-success-next ok"><i class="pi pi-check-circle" aria-hidden="true"></i> Cierre del día completo.</p>
        }
        <button type="button" class="crt-save" (click)="reset()">
          <i class="pi pi-plus" aria-hidden="true"></i> Subir otro ticket
        </button>
      </div>

      <!-- Tickets de hoy -->
      <section *ngIf="step() === 'pick' && !ocrError()" class="crt-recent">
        <h2 class="crt-section">Tickets de hoy</h2>
        <div class="crt-list">
          <div *ngFor="let t of tickets()" class="crt-ticket" [attr.data-type]="t.ticket_type">
            <span class="crt-ticket-icon"><i class="pi {{ meta[t.ticket_type].icon }}" aria-hidden="true"></i></span>
            <div class="crt-ticket-info">
              <span class="crt-ticket-type">{{ meta[t.ticket_type].label }}</span>
              <span class="crt-ticket-meta">RD{{ t.route_code }} · {{ t.ticket_date }}</span>
            </div>
            <span class="crt-ticket-total">{{ t.total != null ? fmtMoney(t.total) : '—' }}</span>
          </div>
          <!-- Fallo de red al cargar la lista (distinto del vacío real) -->
          <div class="crt-empty" *ngIf="!loadingList() && listError()">
            <i class="pi pi-cloud" aria-hidden="true"></i>
            <p>No se pudo cargar la lista.</p>
            <button type="button" class="crt-change" (click)="retryList()">
              <i class="pi pi-refresh" aria-hidden="true"></i> Reintentar
            </button>
          </div>
          <div class="crt-empty" *ngIf="!loadingList() && !listError() && tickets().length === 0">
            <i class="pi pi-receipt" aria-hidden="true"></i>
            <p>Aún no subiste tickets hoy.</p>
          </div>
        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .crt { max-width: 720px; margin: 0 auto; padding: 1.5rem 1rem calc(2rem + env(safe-area-inset-bottom, 0px)); }
      @media (min-width: 768px) { .crt { padding: 2rem 1.5rem 2.5rem; } }

      /* ── header ── */
      .crt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
      .crt-head-text h1 { margin: 0 0 0.2rem; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .crt-head-text p { margin: 0; color: var(--text-muted); font-size: 0.875rem; }
      .crt-daycount { display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; width: 3.25rem; height: 3.25rem; border-radius: 1rem; background: var(--card-bg); border: 1px solid var(--border-color); }
      .crt-daycount-n { font-size: 1.25rem; font-weight: 800; line-height: 1; color: var(--text-main); font-variant-numeric: tabular-nums; }
      .crt-daycount-l { font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); font-weight: 700; }

      /* ── paso 1: tiles interactivos ── */
      .crt-pick { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.875rem; margin-bottom: 2rem; }
      @keyframes crt-tile-in { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
      .crt-tile {
        position: relative; overflow: hidden;
        display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
        padding: 1.5rem 0.875rem 1.125rem; cursor: pointer; text-align: center;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 1.125rem;
        animation: crt-tile-in 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) both;
        transition: transform 0.2s var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1)), box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease;
      }
      /* Halo de color del tipo que aparece en hover */
      .crt-tile-glow { position: absolute; inset: 0; opacity: 0; transition: opacity 0.25s ease; pointer-events: none; }
      .crt-tile[data-type='venta'] .crt-tile-glow { background: radial-gradient(120% 80% at 50% -10%, var(--ok-soft-bg), transparent 70%); }
      .crt-tile[data-type='carga'] .crt-tile-glow { background: radial-gradient(120% 80% at 50% -10%, var(--info-soft-bg), transparent 70%); }
      .crt-tile[data-type='combustible'] .crt-tile-glow { background: radial-gradient(120% 80% at 50% -10%, var(--warn-soft-bg), transparent 70%); }
      .crt-tile:hover { transform: translateY(-4px); box-shadow: var(--shadow-hover, 0 14px 30px -16px rgba(0,0,0,.28)); }
      .crt-tile:hover .crt-tile-glow { opacity: 1; }
      .crt-tile:active { transform: translateY(-1px) scale(0.99); }
      .crt-tile:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
      .crt-tile[data-type='venta']:hover { border-color: var(--ok-fg); }
      .crt-tile[data-type='carga']:hover { border-color: var(--info-fg); }
      .crt-tile[data-type='combustible']:hover { border-color: var(--warn-fg); }

      .crt-tile-icon {
        position: relative; z-index: 1; display: grid; place-items: center;
        width: 3.25rem; height: 3.25rem; border-radius: 1rem; font-size: 1.5rem;
        transition: transform 0.2s var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1));
      }
      .crt-tile:hover .crt-tile-icon { transform: scale(1.12) rotate(-6deg); }
      .crt-tile[data-type='venta'] .crt-tile-icon { background: var(--ok-soft-bg); color: var(--ok-fg); }
      .crt-tile[data-type='carga'] .crt-tile-icon { background: var(--info-soft-bg); color: var(--info-fg); }
      .crt-tile[data-type='combustible'] .crt-tile-icon { background: var(--warn-soft-bg); color: var(--warn-fg); }

      .crt-tile-body { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 0.15rem; }
      .crt-tile-label { font-size: 0.9375rem; font-weight: 800; color: var(--text-main); letter-spacing: -0.01em; }
      .crt-tile-desc { font-size: 0.6875rem; color: var(--text-muted); }

      .crt-tile-cta {
        position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 0.35rem;
        font-size: 0.6875rem; font-weight: 700; color: var(--text-faint);
        text-transform: uppercase; letter-spacing: 0.04em; transition: color 0.2s ease;
      }
      .crt-tile:hover .crt-tile-cta { color: var(--text-main); }
      .crt-tile[data-type='venta']:hover .crt-tile-cta { color: var(--ok-fg); }
      .crt-tile[data-type='carga']:hover .crt-tile-cta { color: var(--info-fg); }
      .crt-tile[data-type='combustible']:hover .crt-tile-cta { color: var(--warn-fg); }
      .crt-tile-arrow { font-size: 0.625rem; opacity: 0; transform: translateX(-4px); transition: opacity 0.2s ease, transform 0.2s ease; }
      .crt-tile:hover .crt-tile-arrow { opacity: 1; transform: translateX(0); }
      .crt-tile:hover .crt-tile-cta .pi-camera { animation: crt-cam 0.6s ease; }
      @keyframes crt-cam { 0%,100% { transform: translateY(0); } 30% { transform: translateY(-2px) rotate(-8deg); } 60% { transform: translateY(0) rotate(4deg); } }

      @media (prefers-reduced-motion: reduce) {
        .crt-tile { animation: none; transition: border-color 0.2s ease; }
        .crt-tile:hover { transform: none; }
        .crt-tile:hover .crt-tile-icon, .crt-tile:hover .crt-tile-cta .pi-camera { transform: none; animation: none; }
        .crt-tile-arrow { display: none; }
        .crt-save { transition: filter 0.2s ease; }
        .crt-save:active:not(:disabled) { transform: none; }
        .crt-save::after, .crt-save:hover:not(:disabled)::after { animation: none; display: none; }
        .crt-change:active { transform: none; }
      }

      /* touch: el hover se queda pegado tras el tap → neutralizarlo (emil) */
      @media (hover: none) {
        .crt-tile:hover { transform: none; box-shadow: none; }
        .crt-tile:hover .crt-tile-glow { opacity: 0; }
        .crt-tile:hover .crt-tile-icon { transform: none; }
        .crt-tile:hover .crt-tile-arrow { opacity: 0; transform: translateX(-4px); }
        .crt-tile:hover .crt-tile-cta .pi-camera { animation: none; }
        .crt-save:hover:not(:disabled) { filter: none; box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 10px 22px -10px rgba(240,90,40,0.75), 0 2px 5px rgba(0,0,0,0.08); }
        .crt-save:hover:not(:disabled)::after { animation: none; }
        .crt-change:hover { background: var(--surface-ground); color: var(--text-muted); border-color: var(--border-color); }
      }

      /* ── OCR fallido (reintento sin re-capturar) ── */
      .crt-ocr-error { display: flex; flex-direction: column; gap: 0.875rem; margin-bottom: 1.5rem; }
      .crt-ocr-error .crt-warn { margin: 0; }
      .crt-ocr-error .crt-save { margin-top: 0; }
      .crt-ocr-retake { align-self: center; }

      /* ── procesando ── */
      .crt-processing {
        display: flex; align-items: center; gap: 0.625rem; justify-content: center;
        padding: 1.5rem; margin-bottom: 1.5rem; color: var(--text-muted);
        background: var(--card-bg); border: 1px dashed var(--border-color); border-radius: 1rem;
      }
      .crt-processing i { color: var(--action); }

      /* ── paso 2: review ── */
      .crt-review-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 1rem; }
      .crt-type-chip { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.7rem; border-radius: 999px; font-size: 0.8125rem; font-weight: 700; }
      .crt-type-chip[data-type='venta'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .crt-type-chip[data-type='carga'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
      .crt-type-chip[data-type='combustible'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .crt-change { display: inline-flex; align-items: center; gap: 0.35rem; background: var(--card-bg); border: 1px solid var(--border-color); cursor: pointer; font-size: 0.75rem; font-weight: 700; color: var(--text-muted); padding: 0.4rem 0.75rem; border-radius: 999px; transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.12s; }
      .crt-change:hover { background: var(--hover-bg); color: var(--text-main); border-color: var(--text-faint); }
      .crt-change:active { transform: scale(0.95); }
      .crt-change:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }

      .crt-preview { width: 100%; max-height: 260px; object-fit: contain; border: 1px solid var(--border-color); border-radius: 1rem; margin-bottom: 1.25rem; background: var(--surface-ground); }

      .crt-fields { display: flex; flex-direction: column; gap: 0.875rem; }
      .crt-field { display: flex; flex-direction: column; gap: 0.35rem; }
      .crt-field-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-faint); }
      .crt-input-wrap { position: relative; }
      .crt-field input {
        width: 100%; padding: 0.6875rem 0.875rem; font-size: 0.9375rem;
        border: 1px solid var(--border-color); border-radius: 0.75rem;
        background: var(--card-bg); color: var(--text-main);
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .crt-field input:focus { outline: none; border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring, rgba(240,90,40,.25)); }
      .crt-input-wrap input { padding-right: 5.5rem; }
      .crt-detect { position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%); font-size: 0.625rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.1rem 0.4rem; border-radius: 999px; background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
      .crt-detect.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }

      /* Valor read-only (todo el ticket es no editable: lo lee el OCR) */
      .crt-ro { padding: 0.6875rem 0.875rem; border-radius: 0.75rem; border: 1px solid var(--border-color); background: var(--surface-ground); color: var(--text-main); font-size: 0.9375rem; font-weight: 700; font-variant-numeric: tabular-nums; }
      .crt-ro.empty { color: var(--text-faint); font-weight: 500; font-style: italic; }
      .crt-line-ro { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 0; border-top: 1px solid var(--border-color); }
      .crt-line-ro:first-of-type { border-top: none; }
      .crt-line-ro .crt-line-name { flex: 1; font-size: 0.875rem; color: var(--text-main); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .crt-line-qty-ro { font-variant-numeric: tabular-nums; font-weight: 800; color: var(--text-muted); flex-shrink: 0; }
      .crt-note { display: flex; align-items: flex-start; gap: 0.4rem; color: var(--text-muted); font-size: 0.75rem; margin: 1.25rem 0 0; }
      .crt-note i { margin-top: 0.1rem; }

      /* Ruta read-only (resuelta por backend, no editable) */
      .crt-route { display: flex; align-items: center; gap: 0.5rem; padding: 0.6875rem 0.875rem; border-radius: 0.75rem; border: 1px solid var(--border-color); font-weight: 700; }
      .crt-route.ok { background: var(--ok-soft-bg); border-color: var(--ok-border, var(--ok-soft-bg)); color: var(--ok-soft-fg); }
      .crt-route.bad { background: var(--bad-soft-bg); border-color: var(--bad-border, var(--bad-soft-bg)); color: var(--bad-soft-fg); }
      .crt-route-name { flex: 1; font-size: 0.9375rem; }
      .crt-route-tag { font-size: 0.5625rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.1rem 0.45rem; border-radius: 999px; background: color-mix(in srgb, currentColor 16%, transparent); }
      .crt-route-hint { margin: 0.4rem 0 0; font-size: 0.75rem; color: var(--bad-soft-fg); }

      /* ── requisitos del día (venta + carga obligatorios) ── */
      .crt-reqs { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 1rem; padding: 0.875rem 1rem; }
      .crt-reqs.done { border-color: var(--ok-border, var(--ok-soft-bg)); background: var(--ok-soft-bg); }
      .crt-reqs-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.625rem; }
      .crt-reqs-title { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.875rem; font-weight: 800; color: var(--text-main); }
      .crt-reqs.done .crt-reqs-title { color: var(--ok-soft-fg); }
      .crt-reqs-status { font-size: 0.625rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.15rem 0.5rem; border-radius: 999px; background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .crt-reqs.done .crt-reqs-status { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .crt-reqs-items { display: flex; flex-wrap: wrap; gap: 0.5rem; }
      .crt-req { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; font-weight: 700; color: var(--text-muted); background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: 999px; padding: 0.3rem 0.6rem; transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease; }
      .crt-req i { font-size: 0.7rem; }
      .crt-req em { font-style: normal; font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; font-weight: 800; }
      .crt-req.done { background: var(--ok-soft-bg); border-color: transparent; color: var(--ok-soft-fg); }
      .crt-req.opt { color: var(--text-faint); }
      .crt-req.opt.done { color: var(--ok-soft-fg); }

      /* ── card de éxito (animada) ── */
      .crt-success { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0.75rem; padding: 1.5rem 1rem 0.5rem; animation: crt-success-in 0.35s ease both; }
      @keyframes crt-success-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .crt-check { width: 84px; height: 84px; border-radius: 50%; background: var(--ok-soft-bg); display: grid; place-items: center; animation: crt-pop 0.4s var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1)) both; }
      @keyframes crt-pop { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      .crt-check svg { width: 54px; height: 54px; }
      .crt-check-ring { stroke: var(--ok-fg); stroke-width: 3; opacity: 0.35; }
      .crt-check-mark { stroke: var(--ok-fg); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 48; stroke-dashoffset: 48; animation: crt-draw 0.4s 0.2s cubic-bezier(0.65, 0, 0.45, 1) forwards; }
      @keyframes crt-draw { to { stroke-dashoffset: 0; } }
      .crt-success-title { font-size: 1.25rem; font-weight: 800; color: var(--text-main); letter-spacing: -0.02em; }
      .crt-success-meta { font-size: 0.875rem; color: var(--text-muted); margin: 0; font-variant-numeric: tabular-nums; }
      .crt-success-next { font-size: 0.8125rem; color: var(--warn-soft-fg); background: var(--warn-soft-bg); padding: 0.5rem 0.875rem; border-radius: 0.75rem; margin: 0.25rem 0 0; }
      .crt-success-next.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); display: inline-flex; align-items: center; gap: 0.35rem; }
      .crt-success .crt-save { max-width: 280px; }

      @media (prefers-reduced-motion: reduce) {
        .crt-success, .crt-check { animation: none; }
        .crt-check-mark { animation: none; stroke-dashoffset: 0; }
      }

      /* ── carga lines ── */
      .crt-lines { margin-top: 1.25rem; border: 1px solid var(--border-color); border-radius: 1rem; padding: 0.875rem 1rem; }
      .crt-lines-head { display: flex; justify-content: space-between; align-items: center; font-size: 0.8125rem; font-weight: 700; color: var(--text-main); margin-bottom: 0.5rem; }
      .crt-lines-count { font-weight: 600; font-size: 0.6875rem; color: var(--text-muted); background: var(--surface-ground); padding: 0.1rem 0.5rem; border-radius: 999px; }
      .crt-lines-empty { font-size: 0.8125rem; color: var(--text-muted); margin: 0.25rem 0; }
      .crt-line { display: flex; align-items: center; gap: 0.625rem; padding: 0.5rem 0; border-top: 1px solid var(--border-color); cursor: pointer; }
      .crt-line:first-of-type { border-top: none; }
      .crt-line input[type='checkbox'] { width: 1.05rem; height: 1.05rem; accent-color: var(--action); flex-shrink: 0; }
      .crt-line-name { flex: 1; font-size: 0.875rem; color: var(--text-main); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .crt-line.off .crt-line-name { color: var(--text-faint); text-decoration: line-through; }
      .crt-line-qty { width: 4.25rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 0.5rem; background: var(--card-bg); color: var(--text-main); font-variant-numeric: tabular-nums; }
      .crt-line-qty:disabled { opacity: 0.5; }

      /* ── warn + save ── */
      .crt-warn { display: flex; align-items: center; gap: 0.4rem; color: var(--bad-soft-fg); background: var(--bad-soft-bg); font-size: 0.8125rem; margin: 1.25rem 0 0; padding: 0.625rem 0.875rem; border-radius: 0.75rem; }
      .crt-save {
        position: relative; overflow: hidden;
        display: flex; align-items: center; justify-content: center; gap: 0.5rem; width: 100%;
        margin-top: 1.25rem; padding: 0.95rem 1rem; cursor: pointer;
        color: var(--action-ink, #fff); border: none; border-radius: 1rem;
        font-size: 0.95rem; font-weight: 800; letter-spacing: 0.01em;
        background: linear-gradient(180deg, var(--action-hover, #ff6b3d), var(--action) 55%, var(--action-press, #d8431a));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 10px 22px -10px rgba(240,90,40,0.75), 0 2px 5px rgba(0,0,0,0.08);
        transition: transform 0.13s var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1)), box-shadow 0.2s ease, filter 0.2s ease;
      }
      /* barrido de brillo en hover (desktop) */
      .crt-save::after {
        content: ''; position: absolute; inset: 0;
        background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.38) 50%, transparent 65%);
        transform: translateX(-130%);
      }
      .crt-save:hover:not(:disabled) { filter: brightness(1.05); box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 14px 28px -10px rgba(240,90,40,0.85), 0 2px 6px rgba(0,0,0,0.1); }
      .crt-save:hover:not(:disabled)::after { animation: crt-shine 0.85s ease; }
      .crt-save:active:not(:disabled) { transform: scale(0.975) translateY(1px); box-shadow: inset 0 2px 6px rgba(0,0,0,0.18), 0 4px 10px -6px rgba(240,90,40,0.6); }
      .crt-save:disabled { background: var(--surface-ground); color: var(--text-faint); box-shadow: none; cursor: not-allowed; }
      .crt-save:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
      .crt-save i { position: relative; z-index: 1; }
      @keyframes crt-shine { to { transform: translateX(130%); } }

      /* ── tickets de hoy ── */
      .crt-recent { margin-top: 2rem; }
      .crt-section { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); margin: 0 0 0.75rem; }
      .crt-list { display: flex; flex-direction: column; gap: 0.5rem; }
      .crt-ticket { display: flex; align-items: center; gap: 0.875rem; padding: 0.75rem 0.875rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 0.875rem; }
      .crt-ticket-icon { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: 0.625rem; font-size: 1rem; flex-shrink: 0; }
      .crt-ticket[data-type='venta'] .crt-ticket-icon { background: var(--ok-soft-bg); color: var(--ok-fg); }
      .crt-ticket[data-type='carga'] .crt-ticket-icon { background: var(--info-soft-bg); color: var(--info-fg); }
      .crt-ticket[data-type='combustible'] .crt-ticket-icon { background: var(--warn-soft-bg); color: var(--warn-fg); }
      .crt-ticket-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; flex: 1; }
      .crt-ticket-type { font-size: 0.875rem; font-weight: 700; color: var(--text-main); }
      .crt-ticket-meta { font-size: 0.75rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .crt-ticket-total { font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); flex-shrink: 0; }
      .crt-empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; text-align: center; color: var(--text-muted); padding: 2rem 1rem; background: var(--card-bg); border: 1px dashed var(--border-color); border-radius: 1rem; }
      .crt-empty i { font-size: 1.75rem; color: var(--text-faint); }
      .crt-empty p { margin: 0; font-size: 0.875rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorCloseRouteComponent implements OnInit, OnDestroy {
  private readonly api = inject(VendorService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>;

  /** Formatter reutilizado — no instanciar Intl por cada cifra (estándar PWA perf). */
  private readonly money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

  readonly types: RouteTicketType[] = ['venta', 'carga', 'combustible'];
  readonly meta = TYPE_META;

  readonly step = signal<Step>('pick');
  readonly selectedType = signal<RouteTicketType | null>(null);
  readonly processing = signal(false);
  readonly saving = signal(false);
  readonly photoPreview = signal<string | null>(null);
  readonly tickets = signal<RouteTicket[]>([]);
  readonly loadingList = signal(true);
  /** Falló la lista (red) — distinto de "sin tickets hoy" (estándar PWA §5). */
  readonly listError = signal(false);
  /** Falló el OCR — conservamos la foto para reintentar sin volver a capturar. */
  readonly ocrError = signal(false);
  private retryFile: File | null = null;
  readonly cargaLines = signal<EditableCargaLine[]>([]); // productos detectados en carga
  // Ruta resuelta por el backend (el usuario NO la edita). Sin match → no se guarda.
  readonly routeMatched = signal(false);
  readonly routeValue = signal<string | null>(null);

  // Resumen del último ticket guardado (card de éxito animada).
  readonly savedSummary = signal<{ type: RouteTicketType; route: string; total: number | null } | null>(null);
  private successTimer: any = null;

  // ── Requisitos del día: venta + carga OBLIGATORIOS (combustible opcional) ──
  private todayTickets = computed(() => {
    const t = this.today();
    return this.tickets().filter((x) => x.ticket_date === t);
  });
  readonly hasVenta = computed(() => this.todayTickets().some((x) => x.ticket_type === 'venta'));
  readonly hasCarga = computed(() => this.todayTickets().some((x) => x.ticket_type === 'carga'));
  readonly hasCombustible = computed(() => this.todayTickets().some((x) => x.ticket_type === 'combustible'));
  readonly requiredDone = computed(() => this.hasVenta() && this.hasCarga());

  private lastResult: ProcesarRouteTicketResult | null = null;
  form: {
    route_code: string;
    ticket_date: string;
    total: number | null;
    corte_number: string | null;
    reference: string | null;
    liters: number | null;
    folio: string | null;
  } = this.emptyForm();

  ngOnInit(): void {
    this.loadList();
  }

  ngOnDestroy(): void {
    clearTimeout(this.successTimer);
    this.setPreview(null); // revoca el object URL pendiente
  }

  /** Setea el preview revocando el object URL anterior (evita fuga de blobs). */
  private setPreview(url: string | null): void {
    const prev = this.photoPreview();
    if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    this.photoPreview.set(url);
  }

  choose(t: RouteTicketType): void {
    this.selectedType.set(t);
    this.ocrError.set(false);
    // dispara el file picker (#fileInput en el template)
    queueMicrotask(() => this.fileInput?.nativeElement.click());
  }

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // permite re-seleccionar la misma foto
    const type = this.selectedType();
    if (!file || !type) return;

    this.processing.set(true);
    this.ocrError.set(false);
    try {
      const compressed = await this.compress(file);
      this.retryFile = compressed; // permite reintentar el OCR sin re-fotografiar
      this.setPreview(URL.createObjectURL(compressed));
      this.runOcr(type, compressed);
    } catch {
      this.processing.set(false);
      this.toast.add({ severity: 'error', summary: 'Imagen inválida' });
    }
  }

  /** Reintenta el OCR con la última foto capturada (sin abrir la cámara de nuevo). */
  retryOcr(): void {
    const type = this.selectedType();
    if (!type || !this.retryFile) return;
    this.ocrError.set(false);
    this.processing.set(true);
    this.runOcr(type, this.retryFile);
  }

  private runOcr(type: RouteTicketType, file: File): void {
    this.api
      .procesarTicket(type, file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.lastResult = res;
          this.form = {
            route_code: res.fields.route_code ?? '',
            ticket_date: res.fields.ticket_date ?? this.today(),
            total: res.fields.total,
            corte_number: res.fields.corte_number,
            reference: res.fields.reference,
            liters: res.fields.liters,
            folio: res.fields.folio,
          };
          // Ruta resuelta por el backend contra el catálogo de su zona.
          this.routeMatched.set(!!res.route_matched);
          this.routeValue.set(res.route_value ?? null);
          // carga: precargar productos detectados (solo los matcheados).
          this.cargaLines.set(
            (res.lines ?? [])
              .filter((l) => !!l.product_id)
              .map((l) => ({
                product_id: l.product_id as string,
                product_name: l.product_name ?? l.normalized,
                quantity: l.quantity || 1,
                include: true,
              })),
          );
          this.processing.set(false);
          this.step.set('review');
        },
        error: (e) => {
          this.processing.set(false);
          // Conservamos la foto: el vendedor reintenta sin volver a capturar.
          this.ocrError.set(true);
          this.toast.add({ severity: 'error', summary: 'No se pudo leer el ticket', detail: e?.error?.message || 'Revisá tu conexión y reintentá' });
        },
      });
  }

  canSave(): boolean {
    // La ruta debe haber matcheado una ruta real de su zona (no editable).
    return this.routeMatched() && !!this.form.ticket_date;
  }

  save(): void {
    const type = this.selectedType();
    if (!type || !this.canSave()) return;
    this.saving.set(true);
    const lines =
      type === 'carga'
        ? this.cargaLines()
            .filter((l) => l.include && l.product_id && Number(l.quantity) > 0)
            .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) }))
        : undefined;
    this.api
      .guardarTicket({
        ticket_type: type,
        route_code: this.form.route_code.trim(),
        ticket_date: this.form.ticket_date,
        total: this.form.total,
        corte_number: type === 'venta' ? this.form.corte_number : null,
        reference: type === 'combustible' ? this.form.reference : null,
        liters: type === 'combustible' ? this.form.liters : null,
        folio: type === 'carga' ? this.form.folio : null,
        cloudinary_public_id: this.lastResult?.cloudinary_public_id ?? null,
        photo_url: this.lastResult?.photo_url ?? null,
        photo_preview_url: this.lastResult?.photo_preview_url ?? null,
        ocr_json: this.lastResult?.fields ?? null,
        lines,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          // Card de éxito animada (en vez de solo el toast).
          this.savedSummary.set({
            type,
            route: this.routeValue() || `RD ${this.form.route_code}`,
            total: this.form.total,
          });
          this.setPreview(null);
          this.selectedType.set(null);
          this.cargaLines.set([]);
          this.lastResult = null;
          this.retryFile = null;
          this.step.set('success');
          this.loadList();
          // Auto-retorno al inicio tras unos segundos (o el usuario toca "Subir otro").
          clearTimeout(this.successTimer);
          this.successTimer = setTimeout(() => {
            if (this.step() === 'success') this.reset();
          }, 3200);
        },
        error: (e) => {
          this.saving.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || '' });
        },
      });
  }

  reset(): void {
    clearTimeout(this.successTimer);
    this.step.set('pick');
    this.selectedType.set(null);
    this.setPreview(null);
    this.lastResult = null;
    this.retryFile = null;
    this.ocrError.set(false);
    this.cargaLines.set([]);
    this.routeMatched.set(false);
    this.routeValue.set(null);
    this.savedSummary.set(null);
    this.form = this.emptyForm();
  }

  private loadList(): void {
    this.loadingList.set(true);
    this.listError.set(false);
    this.api
      .listTickets({ pageSize: 30 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.tickets.set(r.data || []);
          this.loadingList.set(false);
        },
        error: () => {
          this.loadingList.set(false);
          this.listError.set(true);
        },
      });
  }

  /** Reintenta cargar la lista del día tras un fallo de red. */
  retryList(): void {
    this.loadList();
  }

  /** Downscale a 1920px máx + JPEG calidad 0.8 vía canvas (sin dependencias). */
  private compress(file: File): Promise<File> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1920;
        let { width, height } = img;
        if (width > max || height > max) {
          const r = Math.min(max / width, max / height);
          width = Math.round(width * r);
          height = Math.round(height * r);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('no canvas ctx'));
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('toBlob falló'));
            resolve(new File([blob], 'ticket.jpg', { type: 'image/jpeg' }));
          },
          'image/jpeg',
          0.8,
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('no se pudo leer la imagen'));
      };
      img.src = url;
    });
  }

  fmtMoney(n: any): string {
    return this.money.format(Number(n) || 0);
  }
  /** ISO YYYY-MM-DD → dd/mm/yyyy (read-only display). 'sin detectar' si vacío. */
  fmtDate(iso: string | null): string {
    if (!iso) return 'sin detectar';
    const [y, m, d] = iso.split('-');
    return y && m && d ? `${d}/${m}/${y}` : iso;
  }
  /** Fecha local del dispositivo (YYYY-MM-DD). NO usar toISOString (es UTC →
   *  al cerrar ruta de noche en MX rodaría al día siguiente). TZ del backend = MX. */
  private today(): string {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  private emptyForm() {
    return { route_code: '', ticket_date: this.today(), total: null, corte_number: null, reference: null, liters: null, folio: null };
  }
}
