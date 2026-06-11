import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, switchMap, catchError } from 'rxjs';
import { VendorService, VendorCustomer, VendorOrder, ThotSuggestion } from '../vendor.service';
import { PriceRow, OrderLine } from '../../portal/portal.service';
import { HapticService } from '../../../core/services/haptic.service';

type OrderMode = 'instante' | 'futuro';

/** Normaliza para búsqueda tipo Google: minúsculas + sin acentos/diacríticos. */
const foldText = (s: string | null | undefined): string =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Tomar pedido (rediseño Mercado mobile-first). Modos:
 *  - instante (autoventa): "Cobrar y entregar" → deliver-now (consume stock).
 *  - futuro: fecha de entrega agendada → confirma (queda pendiente para reparto).
 * Catálogo con "+" 44px, carrito con steppers, y cart pill flotante en la zona
 * del pulgar como CTA único.
 */
@Component({
  selector: 'app-vendor-take-order',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    SkeletonModule,
    InputTextModule,
    ConfirmDialogModule,
  ],
  providers: [ConfirmationService, MessageService],
  template: `
    <p-confirmDialog></p-confirmDialog>

    <!-- Header sticky -->
    <header class="to-head" *ngIf="customer() as c">
      <button class="bk" (click)="back()" aria-label="Volver"><i class="pi pi-arrow-left"></i></button>
      <span class="av">{{ initials(c.name) }}</span>
      <div class="ci">
        <div class="nm">{{ c.name }}</div>
        <div class="cd">{{ c.code }}</div>
      </div>
      <span class="mode fut"><i class="pi pi-calendar"></i> Preventa</span>
      <button class="more" (click)="actionsOpen.set(true)" aria-label="Más acciones"><i class="pi pi-ellipsis-v"></i></button>
    </header>

    <p-skeleton *ngIf="loading()" height="500px" styleClass="mt"></p-skeleton>

    <ng-container *ngIf="!loading() && customer()">
      <div class="scroll">
        <!-- Aviso: el cliente ya tiene un pedido pendiente (preventa/portal o de campo) -->
        <div class="pending-warn" *ngIf="!pendingDismissed() && pendingOrders().length > 0">
          <i class="pi pi-exclamation-triangle"></i>
          <div class="pw-body">
            <b>
              Ya tiene
              {{ pendingOrders().length === 1 ? (hasPreventa() ? 'una preventa' : 'un pedido') : pendingOrders().length + ' pedidos' }}
              pendiente{{ pendingOrders().length === 1 ? '' : 's' }}
            </b>
            <span>{{ fmtMoney(pendingTotal()) }}{{ hasPreventa() ? ' · del portal' : '' }} — revisá antes de duplicar</span>
          </div>
          <div class="pw-actions">
            <button class="pw-see" (click)="goPending()">Ver</button>
            <button class="pw-x" (click)="pendingDismissed.set(true)">Continuar</button>
          </div>
        </div>

        <!-- Fecha de entrega (preventa) -->
        <div class="date-row">
          <label><i class="pi pi-calendar"></i> Fecha de entrega</label>
          <input type="date" [(ngModel)]="requestedDate" [min]="minDate" class="date-input" />
        </div>

        <!-- Search -->
        <div class="search">
          <i class="pi pi-search"></i>
          <input pInputText type="search" placeholder="Buscar producto o código"
            [ngModel]="searchTerm()" (ngModelChange)="searchTerm.set($event)"
            inputmode="search" enterkeyhint="search"
            autocapitalize="none" autocorrect="off" spellcheck="false" />
        </div>

        <!-- Encabezado de lista: por default, lo que Thot recomienda empujar -->
        <div class="list-head" *ngIf="!searchTerm().trim(); else searchHead">
          <ng-container *ngIf="thotRows().length || impulsarLocal().length; else fullHead">
            <span class="lh-t">
              <i class="pi" [ngClass]="cartLines().length > 0 && usingThot() ? 'pi-shopping-cart' : 'pi-bolt'"></i>
              {{ cartLines().length > 0 && usingThot() ? 'Completá la canasta' : 'Para impulsar' }}
            </span>
            <span class="lh-s">{{ usingThot() ? 'Thot' : 'motor' }} · {{ displayed().length }} · buscá para ver los {{ pricedCount() }}</span>
          </ng-container>
          <ng-template #fullHead>
            <span class="lh-t">Catálogo</span>
            <span class="lh-s">{{ pricedCount() }} productos · buscá para filtrar</span>
          </ng-template>
        </div>
        <ng-template #searchHead>
          <div class="list-head">
            <span class="lh-t">{{ displayed().length }}{{ searchCapped() ? '+' : '' }} resultado{{ displayed().length === 1 ? '' : 's' }}</span>
            <span class="lh-s">de {{ pricedCount() }} productos</span>
          </div>
        </ng-template>

        <!-- Catálogo -->
        <div class="catalog">
          <div class="no-res" *ngIf="displayed().length === 0">
            <i class="pi pi-search"></i>
            <p>Sin resultados para "{{ searchTerm() }}".</p>
          </div>
          <div class="prod" *ngFor="let p of displayed(); trackBy: trackProduct" [class.in]="cartQty(p.product_id) > 0">
            <div class="ph"><i class="pi pi-box"></i></div>
            <div class="pb" [class.tappable]="hasPitch(p)" (click)="hasPitch(p) && openPitch(p)">
              <div class="pn">{{ p.product_name }}</div>
              <div class="pm">
                <span class="rsn" *ngIf="!searchTerm().trim() && reasonFor(p.product_id) as rsn"><i class="pi pi-sparkles"></i> {{ rsn }}</span>
                <span class="pr">{{ fmtMoney(p.price) }}</span>
                <span *ngIf="p.min_qty > 1">· min {{ p.min_qty }}</span>
                <span class="stk" [ngClass]="stockClass(p)" *ngIf="p.stock_available != null">{{ stockLabel(p) }}</span>
                <span class="rot" *ngIf="p.rotation_tier === 'alta' && !reasonFor(p.product_id)"><i class="pi pi-bolt"></i> Alta rotación</span>
                <span class="why" *ngIf="hasPitch(p)"><i class="pi pi-comment"></i> por qué</span>
              </div>
            </div>
            <div class="row-stepper" *ngIf="cartQty(p.product_id) > 0; else addBtn">
              <button (click)="decProduct(p)" aria-label="Menos">−</button>
              <span class="q">{{ cartQty(p.product_id) }}</span>
              <button (click)="incProduct(p)" aria-label="Más">+</button>
            </div>
            <ng-template #addBtn>
              <button class="add" [disabled]="!!adding[p.product_id]" (click)="addToCart(p)" aria-label="Agregar"><i class="pi pi-plus"></i></button>
            </ng-template>
          </div>
        </div>

        <div class="empty-cart" *ngIf="cartLines().length === 0">
          <i class="pi pi-shopping-cart"></i>
          <p>Tocá <b>+</b> en un producto para empezar el pedido.</p>
        </div>
      </div>

      <!-- Barra de carrito (zona del pulgar): abrir pedido | cobrar -->
      <div class="cartbar" *ngIf="cartLines().length > 0">
        <button class="cb-open" (click)="cartOpen.set(true)" aria-label="Ver pedido">
          <span class="cb-count">{{ cartLines().length }}</span>
          <span class="cb-info">
            <b>{{ fmtMoney(cartTotal()) }}</b>
            <span>{{ cartUnitsTotal() }} u · {{ cartLines().length }} SKU · ver pedido</span>
          </span>
          <i class="pi pi-chevron-up"></i>
        </button>
        <button class="cb-go" [disabled]="submitting()" (click)="submit()">
          Agendar
          <i class="pi" [ngClass]="submitting() ? 'pi-spin pi-spinner' : 'pi-arrow-right'"></i>
        </button>
      </div>

      <!-- Sheet de pedido: lo seleccionado, con cantidades editables -->
      <div class="sheet-backdrop" *ngIf="cartOpen()" (click)="cartOpen.set(false)"></div>
      <section class="cart-sheet" *ngIf="cartOpen()">
        <div class="sh-head">
          <div class="sh-title">
            <h2>Tu pedido</h2>
            <span>{{ cartLines().length }} SKU · {{ cartUnitsTotal() }} u</span>
          </div>
          <button class="sh-x" (click)="cartOpen.set(false)" aria-label="Cerrar"><i class="pi pi-times"></i></button>
        </div>
        <div class="sh-lines">
          <div class="cline" *ngFor="let l of cartLines(); trackBy: trackLine">
            <div class="cl-info">
              <div class="cl-n">{{ productNameById(l.product_id) }}</div>
              <div class="cl-t">{{ fmtMoney(l.line_total) }}</div>
            </div>
            <div class="stepper">
              <button (click)="dec(l)" aria-label="Menos">−</button>
              <span class="q">{{ +l.quantity }}</span>
              <button (click)="inc(l)" aria-label="Más">+</button>
            </div>
            <button class="rm" (click)="removeLine(l)" aria-label="Quitar"><i class="pi pi-trash"></i></button>
          </div>
        </div>
        <div class="sh-foot">
          <div class="totals">
            <div class="row"><span>Subtotal</span><b>{{ fmtMoney(cartSubtotal()) }}</b></div>
            <div class="row"><span>IVA</span><b>{{ fmtMoney(cartTaxTotal()) }}</b></div>
            <div class="row mg-row" *ngIf="cartMarginPct() !== null"><span>Margen aprox.</span><b [class.neg]="cartMarginPct()! < 0">{{ cartMarginPct() }}%</b></div>
            <div class="row total"><span>Total</span><b>{{ fmtMoney(cartTotal()) }}</b></div>
          </div>
          <button class="sh-go" [disabled]="submitting()" (click)="submit()">
            Agendar pedido
            <i class="pi" [ngClass]="submitting() ? 'pi-spin pi-spinner' : 'pi-arrow-right'"></i>
          </button>
          <button class="cancel" (click)="cancelDraft()"><i class="pi pi-trash"></i> Cancelar borrador</button>
        </div>
      </section>

      <!-- Sheet "por qué ofrecerlo": speech para el vendedor -->
      <div class="sheet-backdrop" *ngIf="pitch()" (click)="pitch.set(null)"></div>
      <section class="pitch-sheet" *ngIf="pitch() as pp">
        <div class="sh-head">
          <div class="sh-title"><h2>Por qué ofrecerlo</h2><span>{{ pp.product_name }}</span></div>
          <button class="sh-x" (click)="pitch.set(null)" aria-label="Cerrar"><i class="pi pi-times"></i></button>
        </div>
        <ul class="pitch-lines">
          <li *ngFor="let l of pitchLines(pp)"><i class="pi pi-check"></i><span>{{ l }}</span></li>
        </ul>
        <div class="pitch-phrase">
          <span class="pp-lbl"><i class="pi pi-comment"></i> Decile al cliente</span>
          <p>{{ pitchPhrase(pp) }}</p>
        </div>
        <button class="sh-go" (click)="addFromPitch(pp)"><i class="pi pi-plus"></i> Agregar al pedido</button>
      </section>

      <!-- Sheet de acciones de la visita (···) -->
      <div class="sheet-backdrop" *ngIf="actionsOpen()" (click)="actionsOpen.set(false)"></div>
      <section class="act-sheet" *ngIf="actionsOpen()">
        <div class="sh-head">
          <div class="sh-title"><h2>Acciones de la visita</h2></div>
          <button class="sh-x" (click)="actionsOpen.set(false)" aria-label="Cerrar"><i class="pi pi-times"></i></button>
        </div>
        <button class="act-row" (click)="goCaptureExhibit()">
          <i class="pi pi-camera"></i><span class="lbl">Capturar exhibición <small>Foto del punto de venta</small></span><i class="pi pi-chevron-right ch"></i>
        </button>
        <button class="act-row danger" (click)="openFinish()">
          <i class="pi pi-flag"></i><span class="lbl">Finalizar visita <small>Registrar el resultado</small></span><i class="pi pi-chevron-right ch"></i>
        </button>
      </section>

      <!-- Sheet de resultado de visita (terminar) -->
      <div class="sheet-backdrop" *ngIf="finishOpen()" (click)="finishOpen.set(false)"></div>
      <section class="finish-sheet" *ngIf="finishOpen()">
        <div class="sh-head">
          <div class="sh-title"><h2>¿Cómo finalizó la visita?</h2></div>
          <button class="sh-x" (click)="finishOpen.set(false)" aria-label="Cerrar"><i class="pi pi-times"></i></button>
        </div>

        <button class="fin-opt" [class.on]="finishOutcome() === 'venta'" (click)="finishOutcome.set('venta')">
          <i class="pi pi-check-circle"></i>
          <span class="lbl">Venta directa <small>Capturé o voy a capturar el ticket</small></span>
        </button>
        <button class="fin-opt" [class.on]="finishOutcome() === 'no_venta'" (click)="finishOutcome.set('no_venta')">
          <i class="pi pi-times-circle"></i>
          <span class="lbl">No compró <small>Elegí el motivo</small></span>
        </button>

        <div class="reasons" *ngIf="finishOutcome() === 'no_venta'">
          <button *ngFor="let r of noSaleReasons" class="rsn-chip" [class.on]="noSaleReason() === r.key" (click)="noSaleReason.set(r.key)">
            {{ r.label }}
          </button>
        </div>

        <button class="sh-go" [disabled]="finishing() || !canFinish()" (click)="confirmFinish()">
          <i class="pi" [ngClass]="finishing() ? 'pi-spin pi-spinner' : 'pi-flag'"></i>
          Finalizar visita
        </button>
      </section>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }
      .to-head {
        display: flex; align-items: center; gap: 0.7rem;
        margin: -1rem -1rem 0.75rem; padding: 0.7rem 1rem; background: var(--card-bg); border-bottom: 1px solid var(--border-color);
      }
      .to-head .bk { width: 2.25rem; height: 2.25rem; border-radius: 14px; border: none; background: var(--surface-ground); color: var(--text-main); display: grid; place-items: center; font-size: 1.05rem; flex-shrink: 0; }
      .to-head .av { width: 2.35rem; height: 2.35rem; border-radius: 14px; background: var(--brand-400); color: var(--stone-950); display: grid; place-items: center; font-weight: 800; flex-shrink: 0; }
      .to-head .ci { flex: 1; min-width: 0; }
      .to-head .nm { font-weight: 700; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .to-head .cd { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); }
      .to-head .mode { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.7rem; font-weight: 700; color: var(--action); background: var(--ember-soft); border: 1px solid var(--ember-border); padding: 0.25rem 0.55rem; border-radius: var(--r-pill, 999px); flex-shrink: 0; }
      .to-head .mode.fut { color: var(--info-soft-fg); background: var(--info-soft-bg); border-color: var(--info-border); }
      .mt { margin-top: 1rem; }

      .scroll { padding-bottom: 6rem; }
      .date-row { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.875rem; }
      .date-row label { font-size: 0.8rem; font-weight: 600; color: var(--text-muted); display: flex; align-items: center; gap: 0.4rem; }
      .date-input { width: 100%; height: 2.9rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 0 0.875rem; font-family: var(--font-body); font-size: 0.95rem; background: var(--card-bg); color: var(--text-main); }

      .search { display: flex; align-items: center; gap: 0.6rem; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: 0.1rem 0.95rem; margin-bottom: 0.875rem; }
      .search i { color: var(--text-muted); }
      .search input { flex: 1; border: none; background: none; outline: none; height: 2.7rem; font-family: var(--font-body); font-size: 0.95rem; color: var(--text-main); }

      .list-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.6rem; }
      .list-head .lh-t { font-weight: 800; font-size: 0.95rem; color: var(--text-main); display: inline-flex; align-items: center; gap: 0.35rem; }
      .list-head .lh-t i { color: var(--action); font-size: 0.85rem; }
      .list-head .lh-s { font-size: 0.72rem; color: var(--text-muted); text-align: right; }
      .no-res { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .no-res i { font-size: 1.75rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }

      .catalog { display: flex; flex-direction: column; gap: 0.5rem; }
      .prod { display: flex; align-items: center; gap: 0.75rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 0.55rem 0.7rem; }
      .prod .ph { width: 2.5rem; height: 2.5rem; border-radius: 14px; background: var(--stone-100); display: grid; place-items: center; color: var(--stone-400); font-size: 1.05rem; flex-shrink: 0; }
      .prod .pb { flex: 1; min-width: 0; }
      .prod .pn { font-weight: 600; font-size: 0.9rem; color: var(--text-main); line-height: 1.2; }
      .prod .pm { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
      .prod .pm .pr { font-family: var(--font-mono); font-weight: 700; color: var(--action); font-variant-numeric: tabular-nums; }
      .prod .pm .stk { font-weight: 600; }
      .prod .pm .stk.ok { color: var(--ok-fg); } .prod .pm .stk.warn { color: var(--warn-fg); } .prod .pm .stk.bad { color: var(--bad-fg); }
      .prod .pm .rot { display: inline-flex; align-items: center; gap: 0.2rem; color: var(--action); font-weight: 700; }
      .prod .pm .rot i { font-size: 0.62rem; }
      .prod .pm .rsn { display: inline-flex; align-items: center; gap: 0.2rem; color: var(--brand-900); font-weight: 700; background: var(--ember-soft); border: 1px solid var(--ember-border); border-radius: var(--r-pill, 999px); padding: 0.05rem 0.45rem; }
      .prod .pm .rsn i { font-size: 0.6rem; color: var(--action); }
      .add { width: 2.75rem; height: 2.75rem; border-radius: 14px; border: none; background: var(--action); color: #fff; font-size: 1.15rem; display: grid; place-items: center; flex-shrink: 0; transition: transform 0.07s var(--ease, ease); }
      .add:active { transform: scale(0.92); } .add:disabled { opacity: 0.5; }
      /* Stepper en la fila del catálogo (cuando el producto ya está en el carrito) */
      .prod .row-stepper { display: flex; align-items: center; border: 1px solid var(--text-main); border-radius: var(--r-pill, 999px); overflow: hidden; flex-shrink: 0; }
      .prod .row-stepper button { width: 2.35rem; height: 2.55rem; border: none; background: transparent; color: var(--text-main); font-size: 1.2rem; font-weight: 800; line-height: 1; }
      .prod .row-stepper button:active { background: var(--surface-ground); }
      .prod .row-stepper .q { min-width: 1.9rem; text-align: center; font-family: var(--font-mono); font-weight: 800; font-size: 0.95rem; color: var(--text-main); font-variant-numeric: tabular-nums; }

      .cline { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color); }
      .cl-info { flex: 1; min-width: 0; }
      .cl-n { font-weight: 600; font-size: 0.9rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cl-t { font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .stepper { display: flex; align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; flex-shrink: 0; }
      .stepper button { width: 2.5rem; height: 2.5rem; border: none; background: var(--surface-ground); color: var(--action); font-size: 1.15rem; font-weight: 700; }
      .stepper .q { width: 2rem; text-align: center; font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; }
      .rm { width: 2.5rem; height: 2.5rem; border: none; background: none; color: var(--bad-fg); font-size: 1rem; flex-shrink: 0; }
      .totals { margin: 0.875rem 0 0 auto; max-width: 16rem; }
      .totals .row { display: flex; justify-content: space-between; padding: 0.2rem 0; color: var(--text-main); font-size: 0.9rem; }
      .totals .row b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
      .totals .mg-row b { color: var(--ok-fg); } .totals .mg-row b.neg { color: var(--bad-fg); }
      .totals .total { border-top: 2px solid var(--brand-400); padding-top: 0.4rem; margin-top: 0.4rem; font-size: 1.1rem; font-weight: 800; }
      .cancel { margin-top: 0.875rem; background: none; border: none; color: var(--bad-fg); font-weight: 600; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem; }

      .empty-cart { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
      .empty-cart i { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }

      /* Barra de carrito (pulgar): abrir pedido + cobrar */
      .cartbar {
        position: fixed; left: 1rem; right: 1rem; bottom: calc(4.75rem + env(safe-area-inset-bottom));
        height: 3.6rem; border-radius: var(--r-lg, 16px); background: var(--stone-900); color: #fff;
        display: flex; align-items: stretch; gap: 0.5rem; padding: 0.45rem; z-index: 40;
        box-shadow: 0 14px 32px -6px rgba(0,0,0,0.5);
      }
      .cartbar .cb-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.55rem; border: none; background: none; color: #fff; text-align: left; padding: 0 0.2rem 0 0.4rem; }
      .cartbar .cb-count { width: 1.85rem; height: 1.85rem; flex-shrink: 0; border-radius: 999px; background: var(--action); color: #fff; display: grid; place-items: center; font-weight: 800; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
      .cartbar .cb-info { flex: 1; min-width: 0; }
      .cartbar .cb-info b { display: block; font-family: var(--font-mono); font-size: 1.05rem; font-variant-numeric: tabular-nums; line-height: 1.15; }
      .cartbar .cb-info span { font-size: 0.67rem; color: var(--stone-400); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
      .cartbar .cb-open > .pi-chevron-up { color: var(--stone-400); font-size: 0.78rem; flex-shrink: 0; }
      .cartbar .cb-go { flex-shrink: 0; padding: 0 1.15rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 700; font-size: 0.92rem; display: flex; align-items: center; gap: 0.45rem; transition: transform 0.07s var(--ease, ease); }
      .cartbar .cb-go:active { transform: scale(0.96); } .cartbar .cb-go:disabled { opacity: 0.7; }

      /* Sheet de pedido (bottom drawer) */
      .sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 50; animation: shfade 0.15s var(--ease, ease); }
      .cart-sheet {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
        max-height: 82vh; display: flex; flex-direction: column;
        background: var(--card-bg); border-radius: 20px 20px 0 0;
        box-shadow: 0 -12px 32px -8px rgba(0,0,0,0.35);
        padding: 0 1rem calc(1rem + env(safe-area-inset-bottom)); animation: shslide 0.2s var(--ease, ease);
      }
      .cart-sheet::before { content: ''; width: 2.5rem; height: 0.28rem; border-radius: 999px; background: var(--border-color); margin: 0.5rem auto 0.5rem; flex-shrink: 0; }
      .cart-sheet .sh-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 0.4rem; flex-shrink: 0; }
      .cart-sheet .sh-title { display: flex; align-items: baseline; gap: 0.5rem; }
      .cart-sheet .sh-title h2 { font-size: 1.1rem; font-weight: 800; color: var(--text-main); }
      .cart-sheet .sh-title span { font-size: 0.74rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .cart-sheet .sh-x { width: 2.25rem; height: 2.25rem; border: none; border-radius: 12px; background: var(--surface-ground); color: var(--text-muted); display: grid; place-items: center; flex-shrink: 0; }
      .cart-sheet .sh-lines { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; min-height: 0; }
      .cart-sheet .sh-foot { border-top: 1px solid var(--border-color); padding-top: 0.6rem; flex-shrink: 0; }
      .cart-sheet .totals { margin: 0 0 0.7rem 0; max-width: 100%; }
      .cart-sheet .sh-go { width: 100%; height: 3.1rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 800; font-size: 1rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; transition: transform 0.07s var(--ease, ease); }
      .cart-sheet .sh-go:active { transform: scale(0.99); } .cart-sheet .sh-go:disabled { opacity: 0.7; }
      .cart-sheet .cancel { margin: 0.5rem auto 0; display: block; }
      @keyframes shfade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes shslide { from { transform: translateY(100%); } to { transform: translateY(0); } }

      /* Fila tocable + hint "por qué" */
      .prod .pb.tappable { cursor: pointer; }
      .prod .pm .why { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--text-muted); font-weight: 600; }
      .prod .pm .why i { font-size: 0.62rem; }

      /* Sheet "por qué ofrecerlo" */
      .pitch-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 51; display: flex; flex-direction: column; gap: 0.7rem; max-height: 82vh; overflow-y: auto; background: var(--card-bg); border-radius: 20px 20px 0 0; box-shadow: 0 -12px 32px -8px rgba(0,0,0,0.35); padding: 0 1rem calc(1.1rem + env(safe-area-inset-bottom)); animation: shslide 0.2s var(--ease, ease); }
      .pitch-sheet::before { content: ''; width: 2.5rem; height: 0.28rem; border-radius: 999px; background: var(--border-color); margin: 0.5rem auto 0.2rem; flex-shrink: 0; }
      .pitch-sheet .sh-head { display: flex; align-items: flex-start; justify-content: space-between; }
      .pitch-sheet .sh-title h2 { font-size: 1.1rem; font-weight: 800; color: var(--text-main); }
      .pitch-sheet .sh-title span { display: block; font-size: 0.82rem; color: var(--text-muted); margin-top: 0.1rem; }
      .pitch-sheet .sh-x { width: 2.25rem; height: 2.25rem; border: none; border-radius: 12px; background: var(--surface-ground); color: var(--text-muted); display: grid; place-items: center; flex-shrink: 0; }
      .pitch-lines { list-style: none; display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; }
      .pitch-lines li { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.93rem; line-height: 1.35; color: var(--text-main); }
      .pitch-lines li i { color: var(--ok-fg); font-size: 0.85rem; margin-top: 0.2rem; flex-shrink: 0; }
      .pitch-phrase { background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 0.7rem 0.8rem; }
      .pitch-phrase .pp-lbl { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.7rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
      .pitch-phrase p { margin: 0.3rem 0 0; font-size: 0.98rem; font-style: italic; color: var(--text-main); line-height: 1.4; }
      .pitch-sheet .sh-go { width: 100%; height: 3rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 800; font-size: 0.98rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }

      /* Botón ··· del header */
      .to-head .more { width: 2.25rem; height: 2.25rem; border-radius: 12px; border: none; background: var(--surface-ground); color: var(--text-muted); display: grid; place-items: center; font-size: 1.05rem; flex-shrink: 0; }

      /* Sheets de acciones + resultado (reusan el chrome del cart-sheet) */
      .act-sheet, .finish-sheet {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
        display: flex; flex-direction: column; gap: 0.5rem;
        background: var(--card-bg); border-radius: 20px 20px 0 0;
        box-shadow: 0 -12px 32px -8px rgba(0,0,0,0.35);
        padding: 0 1rem calc(1.1rem + env(safe-area-inset-bottom)); animation: shslide 0.2s var(--ease, ease);
      }
      .act-sheet::before, .finish-sheet::before { content: ''; width: 2.5rem; height: 0.28rem; border-radius: 999px; background: var(--border-color); margin: 0.5rem auto 0.4rem; }
      .act-sheet .sh-head, .finish-sheet .sh-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 0.3rem; }
      .act-sheet .sh-title h2, .finish-sheet .sh-title h2 { font-size: 1.1rem; font-weight: 800; color: var(--text-main); }
      .act-sheet .sh-x, .finish-sheet .sh-x { width: 2.25rem; height: 2.25rem; border: none; border-radius: 12px; background: var(--surface-ground); color: var(--text-muted); display: grid; place-items: center; }

      .act-row { display: flex; align-items: center; gap: 0.75rem; width: 100%; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); padding: 0.7rem 0.8rem; color: var(--text-main); text-align: left; }
      .act-row > .pi:first-child { font-size: 1.1rem; color: var(--action); width: 1.4rem; text-align: center; flex-shrink: 0; }
      .act-row .lbl { flex: 1; font-weight: 700; font-size: 0.92rem; display: flex; flex-direction: column; }
      .act-row .lbl small { font-weight: 500; font-size: 0.74rem; color: var(--text-muted); }
      .act-row .ch { color: var(--text-faint); font-size: 0.8rem; }
      .act-row.danger > .pi:first-child { color: var(--bad-fg); }

      .fin-opt { display: flex; align-items: center; gap: 0.7rem; width: 100%; border: 1.5px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); padding: 0.8rem; color: var(--text-main); text-align: left; transition: border-color 0.12s var(--ease, ease), background 0.12s var(--ease, ease); }
      .fin-opt > .pi { font-size: 1.25rem; color: var(--text-faint); flex-shrink: 0; }
      .fin-opt .lbl { flex: 1; font-weight: 700; font-size: 0.95rem; display: flex; flex-direction: column; }
      .fin-opt .lbl small { font-weight: 500; font-size: 0.76rem; color: var(--text-muted); }
      .fin-opt.on { border-color: var(--action); background: var(--ember-soft); }
      .fin-opt.on > .pi { color: var(--action); }

      .reasons { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.1rem 0 0.2rem; }
      .reasons .rsn-chip { border: 1px solid var(--border-color); background: var(--surface-ground); color: var(--text-main); border-radius: var(--r-pill, 999px); padding: 0.4rem 0.8rem; font-size: 0.82rem; font-weight: 600; }
      .reasons .rsn-chip.on { border-color: var(--action); background: var(--ember-soft); color: var(--brand-900); }

      .finish-sheet .sh-go { width: 100%; height: 3.1rem; margin-top: 0.4rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 800; font-size: 1rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
      .finish-sheet .sh-go:disabled { opacity: 0.5; }

      /* Aviso de pedido pendiente (anti-duplicado) */
      .pending-warn { display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 0.875rem; padding: 0.7rem 0.8rem; border-radius: var(--r-md, 12px); background: var(--warn-soft-bg); border: 1px solid var(--warn-fg); }
      .pending-warn > i { color: var(--warn-fg); font-size: 1rem; margin-top: 1px; flex-shrink: 0; }
      .pending-warn .pw-body { flex: 1; min-width: 0; }
      .pending-warn .pw-body b { display: block; font-size: 0.85rem; color: var(--text-main); }
      .pending-warn .pw-body span { font-size: 0.76rem; color: var(--text-muted); }
      .pending-warn .pw-actions { display: flex; flex-direction: column; gap: 0.35rem; flex-shrink: 0; }
      .pending-warn .pw-see { background: var(--warn-fg); color: #fff; border: none; border-radius: var(--r-sm, 8px); font-weight: 700; font-size: 0.76rem; padding: 0.35rem 0.7rem; }
      .pending-warn .pw-x { background: none; border: none; color: var(--text-muted); font-size: 0.72rem; font-weight: 600; }

      @media (prefers-reduced-motion: reduce) { .add, .cartbar .cb-go, .cart-sheet, .sheet-backdrop, .cart-sheet .sh-go { transition: none; animation: none; } }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorTakeOrderComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly toast = inject(MessageService);
  private readonly haptic = inject(HapticService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly customer = signal<VendorCustomer | null>(null);
  readonly prices = signal<PriceRow[]>([]);
  readonly cartLines = signal<OrderLine[]>([]);
  readonly cartOrderId = signal<string | null>(null);
  readonly warehouseId = signal<string>('');
  readonly submitting = signal(false);
  /** Siempre preventa: el pedido se agenda y queda para reparto (la venta directa
   *  se registra capturando el ticket, no por este flujo). */
  readonly mode = signal<OrderMode>('futuro');
  /** Sheet de pedido (drawer) abierto/cerrado. */
  readonly cartOpen = signal(false);
  /** Sheet de acciones de la visita (···). */
  readonly actionsOpen = signal(false);
  /** Sheet "terminar visita" + su estado. */
  readonly finishOpen = signal(false);
  readonly finishing = signal(false);
  readonly finishOutcome = signal<'venta' | 'no_venta' | null>(null);
  readonly noSaleReason = signal<string | null>(null);
  readonly noSaleReasons = [
    { key: 'cerrado', label: 'Cerrado' },
    { key: 'no_atendio', label: 'No atendió' },
    { key: 'con_inventario', label: 'Tiene inventario' },
    { key: 'sin_recursos', label: 'Sin recursos' },
    { key: 'no_interesado', label: 'No le interesó' },
    { key: 'otro', label: 'Otro' },
  ];
  /** Habilita "Terminar visita": venta directa, o no-venta con motivo elegido. */
  canFinish(): boolean {
    const o = this.finishOutcome();
    return o === 'venta' || (o === 'no_venta' && !!this.noSaleReason());
  }

  /** Pedidos ya pendientes del cliente (anti-duplicado: avisar + reusar). */
  readonly pendingOrders = signal<VendorOrder[]>([]);
  readonly pendingDismissed = signal(false);
  readonly pendingTotal = computed(() => this.pendingOrders().reduce((s, o) => s + Number(o.total), 0));
  readonly hasPreventa = computed(() => this.pendingOrders().some((o) => o.is_preventa));

  // Fecha de entrega agendada (preventa). Default: mañana.
  requestedDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  readonly minDate = new Date().toISOString().slice(0, 10);
  private customerId = '';

  adding: Record<string, boolean> = {};
  /** Signal (no campo plano): un `computed` que lo lea reacciona al tipear. */
  readonly searchTerm = signal('');

  stockClass(p: PriceRow): 'ok' | 'warn' | 'bad' {
    const s = Number(p.stock_available ?? 0);
    if (s <= 0) return 'bad';
    if (s < (p.min_qty || 1)) return 'warn';
    return 'ok';
  }
  stockLabel(p: PriceRow): string {
    const s = Number(p.stock_available ?? 0);
    if (s <= 0) return 'Sin stock';
    if (s < (p.min_qty || 1)) return `Stock ${s}`;
    return `Stock ${s}`;
  }

  /** Productos del price list con precio real (lo pedible). */
  readonly pricedCount = computed(
    () => this.prices().filter((p) => p.price != null && Number(p.price) > 0).length,
  );

  /** Sugerencias del motor Thot (server-side: rotación·margen·afinidad·zona). */
  readonly suggestions = signal<ThotSuggestion[]>([]);
  /** product_id → razón ("Va con lo que llevas", "Se vende en tu zona", …). */
  readonly reasonMap = computed(
    () => new Map(this.suggestions().map((s) => [s.product_id, s.reason_label] as const)),
  );
  /** Sugerencias de Thot mapeadas a las filas del catálogo cargado (para reusar la card). */
  readonly thotRows = computed(() => {
    const byId = new Map(this.prices().map((p) => [p.product_id, p]));
    return this.suggestions()
      .map((s) => byId.get(s.product_id))
      .filter((p): p is PriceRow => !!p);
  });

  /**
   * Fallback LOCAL (margen × rotación) si Thot aún no responde (API sin reiniciar
   * / feature store vacío). El motor server-side (Thot) es la fuente primaria.
   */
  readonly impulsarLocal = computed(() => {
    const w = (t?: string | null) =>
      t === 'alta' ? 1 : t === 'media' ? 0.6 : t === 'baja' ? 0.2 : 0.1;
    return this.prices()
      .filter((p) => p.price != null && Number(p.price) > 0)
      .map((p) => ({ p, score: (this.marginPct(p) ?? 0) * w(p.rotation_tier) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((x) => x.p);
  });

  /** ¿la lista por default viene de Thot (server) o del fallback local? */
  readonly usingThot = computed(() => !this.searchTerm().trim() && this.thotRows().length > 0);

  /**
   * Lista mostrada: con término → TODO el catálogo filtrado (nombre/SKU); sin
   * término → Thot (server) y, si no hay, fallback local; y si tampoco, el catálogo.
   */
  /** Tope de resultados renderizados en búsqueda → la lista nunca pinta miles
   *  de filas, así cada tecla responde instantáneo. */
  private readonly SEARCH_CAP = 60;
  /** Índice de búsqueda precomputado (1 vez por cambio de catálogo): texto
   *  normalizado "nombre + sku" por producto → cada tecla solo hace includes. */
  readonly priceIndex = computed(() =>
    this.prices().map((p) => ({ p, hay: foldText(p.product_name + ' ' + (p.sku || '')) })),
  );
  /** ¿la búsqueda llegó al tope (hay más matches sin mostrar)? → mostrar "N+". */
  readonly searchCapped = computed(
    () => !!this.searchTerm().trim() && this.displayed().length >= this.SEARCH_CAP,
  );

  readonly displayed = computed(() => {
    const raw = this.searchTerm().trim();
    if (raw) {
      // Match por tokens (AND), sin acentos. Corta al llegar al tope.
      const tokens = foldText(raw).split(/\s+/).filter(Boolean);
      const out: PriceRow[] = [];
      for (const it of this.priceIndex()) {
        if (tokens.every((t) => it.hay.includes(t))) {
          out.push(it.p);
          if (out.length >= this.SEARCH_CAP) break;
        }
      }
      return out;
    }
    // Sin búsqueda: fijar arriba lo que YA está en el carrito (con su stepper)
    // para poder ajustar cantidades desde el menú, y debajo las sugerencias.
    const byId = new Map(this.prices().map((p) => [p.product_id, p]));
    const seen = new Set<string>();
    const cartRows: PriceRow[] = [];
    for (const l of this.cartLines()) {
      if (seen.has(l.product_id)) continue;
      seen.add(l.product_id);
      const p = byId.get(l.product_id);
      if (p) cartRows.push(p);
    }
    const thot = this.thotRows();
    if (thot.length) return [...cartRows, ...thot.filter((p) => !seen.has(p.product_id))];
    const local = this.impulsarLocal().filter((p) => !seen.has(p.product_id));
    if (local.length) return [...cartRows, ...local];
    return [...cartRows, ...this.prices().filter((p) => !seen.has(p.product_id))];
  });

  reasonFor(productId: string): string | null {
    return this.reasonMap().get(productId) ?? null;
  }

  // ─── Speech "por qué ofrecerlo" (argumentos para el vendedor) ───

  /** Producto cuyo pitch está abierto (sheet). */
  readonly pitch = signal<PriceRow | null>(null);
  /** Hay historia que contar: alta rotación o una razón del motor (Thot). */
  hasPitch(p: PriceRow): boolean {
    return p.rotation_tier === 'alta' || !!this.reasonFor(p.product_id);
  }
  openPitch(p: PriceRow): void {
    this.pitch.set(p);
  }
  /** Argumentos de venta (orientados al CLIENTE, no al margen del vendedor). */
  pitchLines(p: PriceRow): string[] {
    const lines: string[] = [];
    if (p.rotation_tier === 'alta') {
      const u = Number(p.sales_units_30d) || 0;
      lines.push(
        u > 0
          ? `Es de alta rotación: se mueve ~${u} piezas al mes. Se vende solo, no se queda en bodega.`
          : 'Es de alta rotación: de los que más se mueven. Se vende solo, no se queda en bodega.',
      );
    } else if (p.rotation_tier === 'media') {
      lines.push('Rotación media: salida constante, pedido seguro.');
    }
    const reason = this.reasonFor(p.product_id);
    if (reason) {
      const r = foldText(reason);
      if (r.includes('mes')) lines.push('Es la marca que estamos impulsando este mes — buena oportunidad.');
      else if (r.includes('zona')) lines.push('En su zona es de los productos más pedidos.');
      else if (r.includes('llev') || r.includes('canasta') || r.includes('va con') || r.includes('compl'))
        lines.push('Combina con lo que ya se lleva — fácil de sumar al pedido.');
      else if (r.includes('nuevo') || r.includes('lanz')) lines.push('Es novedad y la gente lo está buscando.');
      else lines.push(reason);
    }
    if (!lines.length) lines.push('Buen complemento para su surtido.');
    return lines;
  }
  /** Frase lista para decirle al cliente. */
  pitchPhrase(p: PriceRow): string {
    const qty = p.min_qty && p.min_qty > 1 ? `${p.min_qty}` : 'unas';
    return `«Le dejo ${qty} piezas de ${p.product_name}, que se está vendiendo muy bien. ¿Se las anoto?»`;
  }
  /** Agregar desde el pitch y cerrar el sheet. */
  addFromPitch(p: PriceRow): void {
    this.addToCart(p);
    this.pitch.set(null);
  }

  readonly cartUnitsTotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.quantity), 0));
  readonly cartSubtotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.line_subtotal), 0));
  readonly cartTaxTotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.line_tax), 0));
  readonly cartTotal = computed(() => this.cartSubtotal() + this.cartTaxTotal());

  /** Margen aprox. del pedido: (subtotal − costo) / subtotal. Null si no hay costo. */
  readonly cartMarginPct = computed(() => {
    const lines = this.cartLines();
    let rev = 0;
    let cost = 0;
    let haveCost = false;
    for (const l of lines) {
      rev += Number(l.line_subtotal);
      const c = this.productCostById(l.product_id);
      if (c != null) {
        cost += c * Number(l.quantity);
        haveCost = true;
      }
    }
    if (!haveCost || rev <= 0) return null;
    return Math.round(((rev - cost) / rev) * 100);
  });

  /** Cantidad del producto en el carrito = SUMA de sus líneas (robusto a líneas
   *  duplicadas que el addLine del backend pudo crear con taps repetidos). */
  cartQty(productId: string): number {
    return this.cartLines()
      .filter((x) => x.product_id === productId)
      .reduce((s, l) => s + Number(l.quantity), 0);
  }

  ngOnInit(): void {
    const customerId = this.route.snapshot.paramMap.get('id');
    if (!customerId) return;
    this.customerId = customerId;

    this.api
      .defaultWarehouseId()
      .pipe(
        switchMap((warehouseId) =>
          forkJoin({
            customer: this.api.getCustomer(customerId),
            prices: this.api.catalogForCustomer(customerId, warehouseId || undefined),
            warehouseId: of(warehouseId),
            existingDraft: this.api.draftForCustomer(customerId),
            pending: this.api.pendingForCustomer(customerId).pipe(catchError(() => of([] as VendorOrder[]))),
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ customer, prices, warehouseId, existingDraft, pending }) => {
          this.customer.set(customer);
          this.prices.set(prices);
          this.warehouseId.set(warehouseId || '');
          this.pendingOrders.set(pending);
          if (existingDraft) {
            this.cartOrderId.set(existingDraft.id);
            this.api.orderById(existingDraft.id).subscribe((full) => {
              this.cartLines.set(full.lines || []);
              this.loadSuggestions(); // cart-aware una vez que cargan las líneas
            });
          }
          this.loading.set(false);
          this.loadSuggestions();
        },
        error: (e) => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.error?.message || e.message });
        },
      });
  }

  back(): void {
    this.router.navigate(['/vendor/route-home']);
  }

  /** Ir a "Por entregar" para resolver el pendiente en vez de duplicarlo. */
  goPending(): void {
    this.router.navigate(['/vendor/pending']);
  }

  /** "+" en la fila ya en carrito → sube la línea existente (no crea otra). */
  incProduct(p: PriceRow): void {
    const line = this.cartLines().find((l) => l.product_id === p.product_id);
    if (line) this.setQty(line, Number(line.quantity) + 1);
    else this.addToCart(p);
  }
  /** "−" en la fila → baja la línea (la quita al llegar a 0). */
  decProduct(p: PriceRow): void {
    const line = this.cartLines().find((l) => l.product_id === p.product_id);
    if (line) this.dec(line);
  }

  addToCart(p: PriceRow): void {
    const c = this.customer();
    if (!c || !this.warehouseId()) return;
    // Si ya hay línea de este producto, incrementarla en vez de crear otra
    // (el addLine del backend NO fusiona → duplicaría la línea).
    const existing = this.cartLines().find((l) => l.product_id === p.product_id);
    if (existing) {
      this.setQty(existing, Number(existing.quantity) + 1);
      return;
    }
    const qty = p.min_qty || 1;
    if (p.stock_available != null && qty > Number(p.stock_available)) {
      this.toast.add({ severity: 'warn', summary: 'Sin stock suficiente', detail: `Sólo hay ${p.stock_available}. Queda en backorder.`, life: 4000 });
    }
    this.adding[p.product_id] = true;
    const ensure$ = this.cartOrderId()
      ? of({ id: this.cartOrderId()! } as any)
      : this.api.ensureDraftForCustomer(c.id, this.warehouseId(), 'route');
    ensure$
      .pipe(switchMap((draft) => {
        this.cartOrderId.set(draft.id);
        return this.api.addLine(draft.id, p.product_id, qty);
      }))
      .subscribe({
        next: () => {
          this.adding[p.product_id] = false;
          this.haptic.selection();
          // reload primero, luego re-rankear cart-aware ("completá la canasta")
          // sobre el carrito YA actualizado (evita la sugerencia con carrito viejo).
          this.reloadCart(() => this.loadSuggestions());
        },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.haptic.notification('error');
          this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message });
        },
      });
  }

  inc(line: OrderLine): void {
    this.setQty(line, Number(line.quantity) + 1);
  }
  dec(line: OrderLine): void {
    const next = Number(line.quantity) - 1;
    if (next <= 0) { this.removeLine(line); return; }
    this.setQty(line, next);
  }
  private setQty(line: OrderLine, qty: number): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.haptic.selection();
    this.api.updateLine(orderId, line.id, qty).subscribe({
      next: () => this.reloadCart(),
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
    });
  }

  removeLine(line: OrderLine): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.api.removeLine(orderId, line.id).subscribe({
      next: () => this.reloadCart(() => this.loadSuggestions()),
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
    });
  }

  /** Trae las sugerencias de Thot (cart-aware). Best-effort: si falla, queda el fallback local. */
  private loadSuggestions(): void {
    if (!this.customerId) return;
    const cartIds = this.cartLines().map((l) => l.product_id);
    this.api
      .thotSuggest(this.customerId, cartIds, 40)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => this.suggestions.set(s),
        error: () => {
          /* best-effort: el motor/feature store puede no estar; cae al fallback local */
        },
      });
  }

  submit(): void {
    const orderId = this.cartOrderId();
    if (!orderId || this.submitting()) return;
    if (!this.requestedDate) {
      this.toast.add({ severity: 'warn', summary: 'Elegí la fecha de entrega' });
      return;
    }
    const pretty = new Date(this.requestedDate + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    this.confirmSvc.confirm({
      header: 'Agendar pedido',
      message: `¿Agendar ${this.fmtMoney(this.cartTotal())} para entrega el ${pretty}?`,
      icon: 'pi pi-calendar',
      acceptLabel: 'Agendar', rejectLabel: 'Cancelar',
      accept: () => {
        this.submitting.set(true);
        this.api
          .updateDraftHeader(orderId, { requested_delivery_date: this.requestedDate })
          .pipe(switchMap(() => this.api.confirm(orderId)))
          .subscribe({
            next: (o) => this.onDone(o),
            error: (err) => this.onError(err),
          });
      },
    });
  }

  // ─── Acciones de la visita (···) ───

  /** Capturar exhibición: foto del punto de venta. */
  goCaptureExhibit(): void {
    this.actionsOpen.set(false);
    this.router.navigate(['/vendor/capture']);
  }
  /** Abre el sheet de resultado de visita. */
  openFinish(): void {
    this.actionsOpen.set(false);
    this.finishOutcome.set(null);
    this.noSaleReason.set(null);
    this.finishOpen.set(true);
  }
  /** Cierra la visita con el resultado elegido y vuelve a Mi ruta. */
  confirmFinish(): void {
    if (!this.canFinish() || this.finishing()) return;
    const outcome = this.finishOutcome();
    this.finishing.set(true);
    this.api
      .finishVisit(this.customerId, {
        had_ticket: outcome === 'venta',
        no_sale_reason: outcome === 'no_venta' ? this.noSaleReason() || undefined : undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.finishing.set(false);
          this.finishOpen.set(false);
          this.haptic.notification('success');
          this.toast.add({ severity: 'success', summary: 'Visita finalizada' });
          this.router.navigate(['/vendor/route-home']);
        },
        error: (err) => {
          this.finishing.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo terminar', detail: err?.error?.message || err?.message });
        },
      });
  }

  private onDone(o: { code?: string; total?: number | string } | null): void {
    this.submitting.set(false);
    const c = this.customer();
    this.router.navigate(['/vendor/order-success'], {
      queryParams: {
        mode: this.mode(),
        code: o?.code || '',
        total: o?.total ?? this.cartTotal(),
        units: this.cartUnitsTotal(),
        name: c?.name || '',
        wa: c?.whatsapp || '',
        date: this.requestedDate,
        customer: c?.id || '',
      },
    });
  }
  private onError(err: any): void {
    this.submitting.set(false);
    this.haptic.notification('error');
    this.toast.add({ severity: 'error', summary: 'No se pudo completar', detail: err?.error?.message || err?.message || 'Intentá de nuevo.' });
  }

  cancelDraft(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.confirmSvc.confirm({
      message: '¿Cancelar este borrador?',
      header: 'Cancelar pedido',
      icon: 'pi pi-trash',
      accept: () => {
        this.api.cancel(orderId, 'Cancelado por el vendedor').subscribe({
          next: () => {
            this.cartLines.set([]);
            this.cartOrderId.set(null);
            this.cartOpen.set(false);
            this.toast.add({ severity: 'info', summary: 'Borrador cancelado' });
          },
          error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
        });
      },
    });
  }

  productNameById(id: string): string {
    return this.prices().find((p) => p.product_id === id)?.product_name || id.slice(0, 8);
  }
  /**
   * Costo NETO (sin IVA) del producto. `cost_with_tax` (ERP costo_civa) viene
   * CON IVA; el precio es pre-IVA → para comparar en la misma base le quitamos
   * el IVA (`tax_rate`). Null si el ERP no trajo costo.
   */
  private netCost(p: PriceRow): number | null {
    const gross = p.cost_with_tax == null ? null : Number(p.cost_with_tax);
    if (gross == null || gross <= 0) return null;
    return gross / (1 + (Number(p.tax_rate) || 0));
  }
  /** Costo neto del producto por id (del catálogo ya cargado). */
  productCostById(id: string): number | null {
    const p = this.prices().find((x) => x.product_id === id);
    return p ? this.netCost(p) : null;
  }
  /** Margen real por producto: (precio − costo neto) / precio. Null si falta costo/precio. */
  marginPct(p: PriceRow): number | null {
    const price = Number(p.price);
    const cost = this.netCost(p);
    if (!price || cost == null) return null;
    return Math.round(((price - cost) / price) * 100);
  }
  initials(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  trackProduct(_: number, p: PriceRow): string { return p.product_id; }
  trackLine(_: number, l: OrderLine): string { return l.id; }

  private reloadCart(after?: () => void): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.api.orderById(orderId).subscribe({
      next: (full) => {
        const lines = full.lines || [];
        this.cartLines.set(lines);
        if (!lines.length) this.cartOpen.set(false); // se vació → cerrar el sheet
        after?.();
      },
    });
  }

  fmtMoney(n: unknown): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
