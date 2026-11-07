import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal, viewChild } from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  LevantamientoBusquedaFila, LevantamientoCara, LevantamientoContexto, LevantamientoEscaneoDto, LevantamientoEscaneoRespuesta, LevantamientoMotivoSalto, LevantamientoSugerido,
} from '@megadulces/contracts';
import { LEVANTAMIENTO_CARA_OBLIGATORIA } from '@megadulces/contracts';
import { CALIDAD_VERSION, dimensionesDeMedicion, juzgarFoto, medirFoto } from '@megadulces/ui-web';
import { base64ToBlob } from '../../../core/http/visit-form-data';
import { AuthService } from '../../../core/services/auth.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ProductScanFieldComponent } from '../../comercial/components/product-scan-field.component';
import { CameraShotComponent } from '../../finanzas/components/camera-shot.component';
import { LevantamientoService } from '../levantamiento.service';

type Paso = 'sucursal' | 'inicio' | 'buscar' | 'confirmar' | 'captura' | 'repetir' | 'salir' | 'listo';

interface Pendiente {
  face: LevantamientoCara;
  blob: Blob;
  calidad: { sharpness: number; contrast: number; version: string };
  ancho: number;
  alto: number;
}

const CARA: Record<LevantamientoCara, { nombre: string; indicacion: string }> = {
  frente: { nombre: 'Frente', indicacion: 'Pon el frente del producto dentro del marco.' },
  reverso: { nombre: 'Reverso', indicacion: 'Gira el producto: la cara de atrás.' },
  lateral_izq: { nombre: 'Lado izq.', indicacion: 'El lado izquierdo del producto.' },
  lateral_der: { nombre: 'Lado der.', indicacion: 'El lado derecho del producto.' },
  base: { nombre: 'Base', indicacion: 'La cara de abajo (casi siempre trae el código).' },
};

const MOTIVOS: Array<{ id: LevantamientoMotivoSalto; texto: string }> = [
  { id: 'no_tiene_esa_cara', texto: 'No tiene esa cara' },
  { id: 'no_se_puede_girar', texto: 'No se puede girar' },
  { id: 'otro', texto: 'Otro motivo' },
];

/** Comodidad por teléfono: la sucursal que eligió quien no tiene una en su perfil. Si falla, se vuelve a preguntar. */
const CLAVE_SUCURSAL = 'np7-sucursal-elegida';
const leerSucursal = (): string | null => { try { return localStorage.getItem(CLAVE_SUCURSAL); } catch { return null; } };
const guardarSucursal = (v: string | null): void => { try { if (v) localStorage.setItem(CLAVE_SUCURSAL, v); else localStorage.removeItem(CLAVE_SUCURSAL); } catch { /* sin almacenamiento: se pregunta otra vez */ } };

const PALABRA: Record<string, string> = { PZA: 'pieza', PAQ: 'paquete', CJA: 'caja', BTO: 'bulto', CUB: 'cubeta', KG: 'kilo', BOL: 'bolsa', DSP: 'exhibidor' };

/**
 * `[NP.7.L.4a]` Levantamiento del Catálogo digital — pantalla de celular, sin el marco de la app.
 * Maquetas A → B0 → B → C de `FASE_NP7_ALTA_DESDE_FOTOS.md` §10b.4 (HTML en `C:\DEV\_reportes`).
 *
 * Las cinco preguntas (skill `diseno` §0b), contestadas en el plan §10b.2:
 *  1. Ve primero «Escanear código»; debajo el buscador; luego cuántos faltan y su semana; luego qué buscar.
 *  2. No ve costo, precio, margen, proveedor ni lo que leyó la IA (el servidor no los manda).
 *  3. Una mano, objetivos ≥ 44 px, sin teclear en el camino normal; sucursal por nombre.
 *  4. Ligada a Productos nuevos (sugeridos), Recepción (después) y Altas (código que no existe).
 *  5. Sólo captura: no aprueba ni corrige datos.
 *
 * ⚠️ Sin validación en dispositivo: no se probó en un celular real (cámara, barra de gestos).
 * Buscador de respaldo (NP.7.L.10): la misma búsqueda de Cotización nueva, sin precio. Lo que no aparece se avisa
 * al encargado; la presolicitud de alta (NP.7.L.13) todavía no existe y la pantalla no la promete.
 */
@Component({
  selector: 'app-levantamiento-page',
  standalone: true,
  imports: [DecimalPipe, NgTemplateOutlet, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ProductScanFieldComponent, CameraShotComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="lv" [attr.aria-busy]="ocupado()">
      @switch (paso()) {
        @case ('sucursal') {
          <header class="lv-head"><h1 class="lv-t">¿En qué sucursal estás?</h1>
            <p class="lv-s">Tu usuario no tiene sucursal asignada. Elige dónde estás levantando productos.</p></header>
          <section class="lv-body">
            <ul class="lv-list" aria-label="Sucursales">
              @for (b of sucursalesDisponibles(); track b.code) {
                <li><button type="button" class="lv-btn lv-opcion" (click)="elegirSucursal(b.code)">{{ b.name }}</button></li>
              }
            </ul>
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }
          </section>
        }
        @case ('inicio') {
          <header class="lv-head">
            <h1 class="lv-t">Levantamiento · {{ ctx()?.branch_name ?? ctx()?.branch_code ?? '' }}</h1>
            <p class="lv-s">{{ ctx()?.user?.name || ctx()?.user?.username || auth.user()?.username }}
              <button type="button" class="lv-link" (click)="noSoyYo()">No soy yo</button>
              @if (ctx()?.branch_source === 'elegida') { <button type="button" class="lv-link" (click)="cambiarSucursal()">Cambiar sucursal</button> }</p>
          </header>
          <section class="lv-body">
            <button type="button" class="lv-btn lv-pri lv-lg" [disabled]="ocupado()" (click)="lector()?.abrirCamara()">
              <i class="pi pi-qrcode" aria-hidden="true"></i> Escanear código</button>
            <app-product-scan-field [valor]="codigo()" (valorChange)="codigo.set($event)" (buscar)="escanear($event)"
              (sinCamara)="aviso.set($event)" [ocupado]="ocupado()" [conPie]="false" [autoEnfoque]="false"
              etiqueta="O escribe el código" placeholder="O escribe el código" />
            <button type="button" class="lv-link lv-full" (click)="abrirBuscador()">¿No pasa el código? Búscalo</button>
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }

            <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
              @if (ctx(); as c) {
                <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Tu avance en el levantamiento" />
                <p class="lv-ter">@if (c.week.rank) { Vas <b>{{ c.week.rank }}.º</b> en tu sucursal esta semana · }
                  <app-freshness-pill measures="fetch" [since]="cargadoEn()" /></p>
                @if (!c.ai_enabled) { <p class="lv-ter">Todo lo que levantes lo revisa Catálogo antes de publicarse.</p> }
                <div class="lv-sug">
                  <p class="lv-eyebrow">Búscalos en el anaquel y escanéalos</p>
                  <p class="lv-ter">Los que más se venden primero</p>
                  <ul class="lv-list">
                    @for (s of sugeridos(); track s.sku) {
                      <li class="lv-row"><span>{{ s.name }}</span><small>{{ unidad(s.unit_label, s.unit_factor) }}</small></li>
                    }
                  </ul>
                  @if (totalSugeridos() > sugeridos().length) {
                    <button type="button" class="lv-link lv-full" [disabled]="masCargando()" (click)="masSugeridos()">ver más ({{ totalSugeridos() - sugeridos().length | number }} restantes)</button>
                  }
                </div>
              }
            </app-load-state>
          </section>
        }

        @case ('buscar') {
          <header class="lv-head"><div class="lv-bar"><button type="button" class="lv-back" (click)="paso.set('inicio')" aria-label="Regresar"><i class="pi pi-chevron-left"></i></button>
            <h1 class="lv-t lv-grow">Buscar el producto</h1></div></header>
          <section class="lv-body">
            <label class="lv-search"><i class="pi pi-search" aria-hidden="true"></i>
              <input type="search" [value]="termino()" (input)="alTeclear($any($event.target).value)" placeholder="Código, SKU o nombre"
                aria-label="Buscar por código, SKU o nombre" autocomplete="off" enterkeyhint="search" /></label>
            <p class="lv-ter">Palabras en cualquier orden. Sin escribir nada: lo más vendido aquí.</p>
            <app-load-state [loading]="buscando()" [error]="null" [isEmpty]="!buscando() && resultados().length === 0"
              emptyTitle="No aparece" emptyHint="Puede ser un producto que el sistema no tiene en esta sucursal. Avísale a tu encargado.">
              <ul class="lv-list" aria-label="Resultados">
                @for (p of resultados(); track p.sku) {
                  <li><button type="button" class="lv-res" [disabled]="p.has_sheet || ocupado()" (click)="elegir(p)">
                    <span>{{ p.name }}</span>
                    <small>{{ p.has_sheet ? 'Ya tiene ficha' : 'Falta' }}@if (p.content) { · {{ p.content }} }</small>
                  </button></li>
                }
              </ul>
            </app-load-state>
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }
          </section>
        }
        @case ('confirmar') {
          <header class="lv-head"><div class="lv-bar"><button type="button" class="lv-back" [disabled]="ocupado()" (click)="noEsEste()" aria-label="Regresar"><i class="pi pi-chevron-left"></i></button>
            <h1 class="lv-t lv-grow">Confirma el código</h1></div></header>
          <section class="lv-body">
            @if (escaneo()?.code) { <p class="lv-code">{{ escaneo()?.code }}</p> } @else { <p class="lv-ter">Elegido por nombre: Catálogo lo revisará antes de publicarse.</p> }
            <p class="lv-name">{{ escaneo()?.name }}</p>
            <p class="lv-sec">Vas a fotografiar: <b>{{ unidad(escaneo()?.principal?.label, escaneo()?.principal?.factor) }}</b></p>
            <p class="lv-q">¿Es lo que tienes en la mano?</p>
            @if (escaneo()?.scanned; as s) { <p class="lv-ter lv-push">En Kepler: {{ s.label ?? 'sin rótulo' }} · factor {{ s.factor ?? 'sin capturar' }} (tal cual)</p> }
          </section>
          <footer class="lv-foot">
            <button type="button" class="lv-btn lv-pri" [disabled]="ocupado()" (click)="empezar()">Sí, tomar fotos</button>
            <button type="button" class="lv-link lv-full" [disabled]="ocupado()" (click)="noEsEste()">No es éste</button>
          </footer>
        }

        @case ('captura') {
          <header class="lv-head">
            <div class="lv-bar"><button type="button" class="lv-back" [disabled]="ocupado()" (click)="paso.set('salir')" aria-label="Salir"><i class="pi pi-chevron-left"></i></button>
              <span class="lv-t lv-grow">{{ escaneo()?.name }}</span><span class="lv-sec">{{ indice() + 1 }} de {{ caras().length }}</span></div>
            <p class="lv-sec">Fotografías: <b>{{ unidad(escaneo()?.principal?.label, escaneo()?.principal?.factor) }}</b></p>
          </header>
          <section class="lv-body">
            <ol class="lv-steps" aria-label="Caras">
              @for (c of caras(); track c; let i = $index) {
                <li [class.hecha]="hechas().has(c)" [class.actual]="i === indice()">
                  <span class="lv-step-ico" aria-hidden="true">@if (hechas().has(c)) { <i class="pi pi-check"></i> } @else { {{ i + 1 }} }</span>{{ nombreCara(c) }}
                </li>
              }
            </ol>
            <div class="lv-marco" aria-hidden="true"><div class="lv-silueta">{{ nombreCara(caraActual()) }}</div></div>
            <p class="lv-indic">{{ indicacion() }}</p>
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }
          </section>
          <footer class="lv-foot">
            <button type="button" class="lv-btn lv-pri lv-lg" [disabled]="ocupado()" (click)="camara()?.abrir()"><i class="pi pi-camera" aria-hidden="true"></i> Tomar foto</button>
            @if (eligiendoMotivo()) {
              <div class="lv-motivos" role="group" aria-labelledby="lv-motivo-q">
                <p id="lv-motivo-q" class="lv-q0">¿Por qué no se puede tomar esta cara ({{ nombreCara(caraActual()) }})?</p>
                @for (m of motivos; track m.id) { <button type="button" class="lv-btn" [disabled]="ocupado()" (click)="saltar(m.id)">{{ m.texto }}</button> }
                <button type="button" class="lv-link lv-full" (click)="eligiendoMotivo.set(false)">Mejor sí la tomo</button>
              </div>
            } @else if (caraActual() !== caraObligatoria) {
              <button type="button" class="lv-link lv-full" [disabled]="ocupado()" (click)="eligiendoMotivo.set(true)">Saltar esta cara</button>
            } @else {
              <p class="lv-ter lv-center">El frente siempre se fotografía: es la foto principal del catálogo.</p>
            }
            <ng-container [ngTemplateOutlet]="camaraTpl" />
          </footer>
        }

        @case ('repetir') {
          <header class="lv-head"><p class="lv-t">{{ escaneo()?.name }}</p></header>
          <section class="lv-body">
            <p class="lv-mal" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ aviso() }}</p>
          </section>
          <footer class="lv-foot">
            <button type="button" class="lv-btn lv-pri lv-lg" (click)="camara()?.abrir()"><i class="pi pi-camera" aria-hidden="true"></i> Repetir foto</button>
            <!-- Una cara lisa (sin texto ni dibujo) puede no pasar nunca la medición: siempre hay salida. El frente no
                 se salta (toda ficha trae al menos una foto real): su salida es «Salir sin terminar». -->
            @if (caraActual() !== caraObligatoria) {
              <button type="button" class="lv-link lv-full" (click)="saltarDesdeRepetir()">Saltar esta cara</button>
            }
            <button type="button" class="lv-link lv-full" (click)="paso.set('salir')">Salir sin terminar</button>
            <ng-container [ngTemplateOutlet]="camaraTpl" />
          </footer>
        }

        @case ('salir') {
          <section class="lv-body">
            <p class="lv-t">¿Salir sin terminar?</p>
            <p class="lv-sec">Llevas {{ hechas().size }} de {{ caras().length }}. Lo que ya subió se queda; el producto vuelve a quedar libre.</p>
          </section>
          <footer class="lv-foot">
            <button type="button" class="lv-btn lv-pri" (click)="paso.set('captura')">Seguir tomando fotos</button>
            <button type="button" class="lv-btn lv-bad" (click)="salir()">Salir</button>
          </footer>
        }

        @case ('listo') {
          <section class="lv-body lv-center">
            @if (fallidas().length === 0) {
              <i class="pi pi-check-circle lv-ok" aria-hidden="true"></i>
              <p class="lv-t">{{ escaneo()?.name }}</p>
              <p class="lv-sec">{{ resumenEnviado() }}</p>
            } @else {
              <i class="pi pi-exclamation-triangle lv-bad-ico" aria-hidden="true"></i>
              <p class="lv-t">Subieron {{ subidas() }} de {{ caras().length }}</p>
              <p class="lv-sec">Faltan: {{ faltanTexto() }}</p>
            }
          </section>
          <footer class="lv-foot">
            @if (fallidas().length) {
              <button type="button" class="lv-btn lv-pri" [disabled]="ocupado()" (click)="reintentar()">Reintentar</button>
              <button type="button" class="lv-link lv-full" [disabled]="ocupado()" (click)="siguiente()">Escanear el siguiente</button>
            } @else {
              <button type="button" class="lv-btn lv-pri" [disabled]="ocupado()" (click)="siguiente()">Escanear el siguiente</button>
            }
          </footer>
        }
      }
      <!-- La cámara sólo existe en los dos pasos que toman foto, dentro de su pie. Suelta al final de la pantalla, su
           respaldo sin cámara (permiso negado) se arrastraba a «Enviado» con un «Tomar foto» que ya no tenía qué
           fotografiar, y pegado al borde (prueba visual con la CSP de prod, 2026-11-03). Una sola declaración. -->
      <ng-template #camaraTpl>
        <app-camera-shot [etiqueta]="nombreCara(caraActual())" [maxLado]="4096" [resolucion]="'maxima'" [recodificarSiempre]="true" [indicacion]="indicacion()"
          [guia]="nombreCara(caraActual())" (tomada)="alTomar($event.dataUri)" />
      </ng-template>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100dvh; background: var(--card-bg); color: var(--fg-1); }
    .lv { display: flex; flex-direction: column; min-height: 100dvh; padding-top: env(safe-area-inset-top, 0); }
    .lv-head { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border-color); }
    .lv-bar { display: flex; align-items: center; gap: var(--sp-2); }
    .lv-grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .lv-t { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold, 700); }
    .lv-s, .lv-sec { margin: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .lv-ter { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); }
    .lv-body { flex: 1; display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .lv-foot { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3) var(--sp-4) max(var(--sp-4), env(safe-area-inset-bottom, 0)); border-top: 1px solid var(--border-color); }
    .lv-btn { min-height: var(--tap-min, 44px); width: 100%; border-radius: var(--r-md); border: 1px solid var(--border-color); background: var(--card-bg); color: var(--fg-1); font-size: var(--fs-body); font-weight: var(--fw-medium, 600); display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2); cursor: pointer; }
    .lv-btn:focus-visible, .lv-link:focus-visible, .lv-back:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .lv-btn:disabled, .lv-link:disabled, .lv-back:disabled { opacity: .5; cursor: not-allowed; }
    .lv-pri { background: var(--action); border-color: var(--action); color: var(--action-ink); }
    .lv-lg { min-height: 64px; font-size: var(--fs-lg); }
    .lv-bad { border-color: transparent; color: var(--bad-fg); }
    .lv-link { min-height: var(--tap-min, 44px); background: none; border: 0; color: var(--fg-2); text-decoration: underline; text-underline-offset: 3px; font-size: var(--fs-sm); cursor: pointer; padding: 0 var(--sp-2); }
    .lv-full { width: 100%; }
    .lv-search { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--tap-min, 44px); padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); color: var(--fg-3); }
    .lv-search input { flex: 1; min-width: 0; border: 0; background: none; color: var(--fg-1); font-size: var(--fs-body); outline: none; }
    .lv-search input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .lv-res { display: flex; flex-direction: column; align-items: flex-start; width: 100%; min-height: var(--tap-min, 44px); padding: var(--sp-2) 0; border: 0; border-bottom: 1px solid var(--border-color); background: none; color: var(--fg-1); font-size: var(--fs-body); text-align: left; cursor: pointer; }
    .lv-res small { color: var(--fg-3); font-size: var(--fs-xs); }
    .lv-res:disabled { cursor: default; color: var(--fg-3); }
    .lv-res:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .lv-opcion { justify-content: flex-start; padding: 0 var(--sp-3); margin-top: var(--sp-1); }
    .lv-back { min-width: var(--tap-min, 44px); min-height: var(--tap-min, 44px); border: 0; background: none; color: var(--fg-1); cursor: pointer; }
    .lv-eyebrow { margin: 0; font-size: var(--fs-micro); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--fg-3); }
    .lv-list { list-style: none; margin: var(--sp-2) 0 0; padding: 0; border-top: 1px solid var(--border-color); }
    .lv-row { display: flex; flex-direction: column; justify-content: center; min-height: var(--tap-min, 44px); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); font-size: var(--fs-body); }
    .lv-row small { color: var(--fg-3); font-size: var(--fs-xs); }
    .lv-aviso { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .lv-code { margin: var(--sp-2) 0 0; font-family: var(--font-mono, monospace); font-size: var(--fs-h2); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .lv-name { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
    .lv-q { margin: var(--sp-3) 0 0; font-weight: 700; }
    .lv-push { margin-top: auto; }
    .lv-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--sp-1); }
    .lv-steps li { display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); font-size: var(--fs-nano); color: var(--fg-3); text-align: center; }
    .lv-step-ico { display: grid; place-items: center; width: 100%; aspect-ratio: 1; border: 1px dashed var(--border-color); border-radius: var(--r-sm); }
    .lv-steps li.hecha .lv-step-ico { border-style: solid; color: var(--ok-fg); }
    .lv-steps li.actual { color: var(--fg-1); font-weight: 700; }
    .lv-steps li.actual .lv-step-ico { border: 2px solid var(--fg-1); }
    .lv-indic { margin: 0; font-weight: 600; text-align: center; }
    .lv-marco { flex: 1; min-height: 180px; display: grid; place-items: center; border-radius: var(--r-md); background: var(--surface-ground); }
    .lv-silueta { width: 46%; aspect-ratio: 3 / 4; border: 2px dashed var(--fg-3); border-radius: var(--r-md); display: grid; place-items: center;
      color: var(--fg-3); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: var(--fs-sm); }
    .lv-q0 { margin: 0 0 var(--sp-1); font-weight: 700; }
    .lv-motivos { display: grid; gap: var(--sp-1); }
    .lv-mal { margin: 0; font-weight: 600; display: flex; gap: var(--sp-2); }
    .lv-mal .pi { color: var(--bad-fg); }
    .lv-center { align-items: center; justify-content: center; text-align: center; }
    .lv-ok { font-size: 2.5rem; color: var(--ok-fg); }
    .lv-bad-ico { font-size: 2.5rem; color: var(--bad-fg); }
  `],
})
export class LevantamientoComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(LevantamientoService);
  protected readonly camara = viewChild(CameraShotComponent);
  /** El lector de códigos: el botón grande «Escanear código» abre su cámara. */
  protected readonly lector = viewChild(ProductScanFieldComponent);

  protected readonly motivos = MOTIVOS;
  /** El frente no se salta (el servidor responde 400): la pantalla ni lo ofrece. */
  protected readonly caraObligatoria = LEVANTAMIENTO_CARA_OBLIGATORIA;
  protected readonly paso = signal<Paso>('inicio');
  protected readonly cargando = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly ocupado = signal(false);
  protected readonly aviso = signal<string | null>(null);
  protected readonly ctx = signal<LevantamientoContexto | null>(null);
  /** La sucursal ELEGIDA (sólo si el perfil no trae una, D25); null = la del perfil. */
  private readonly sucursal = signal<string | null>(leerSucursal());
  protected readonly sucursalesDisponibles = signal<Array<{ code: string; name: string }>>([]);
  /** Cuándo se leyó el conteo (se deriva en vivo del ODS; la pastilla dice su edad). */
  protected readonly cargadoEn = signal<Date | null>(null);
  /** Answer-first (Q.1): cuánto falta, y lo que lleva la persona esta semana. Lo que está en revisión no suma. */
  protected readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.ctx();
    if (!c) return [];
    return [
      { label: 'Sin fotos', value: c.missing, format: 'number', sub: 'productos de esta sucursal' },
      { label: 'Publicadas esta semana', value: c.week.published, format: 'number' },
      { label: 'En revisión', value: c.week.in_review, format: 'number', sub: 'no suman hasta publicarse' },
    ];
  });
  protected readonly sugeridos = signal<LevantamientoSugerido[]>([]);
  protected readonly totalSugeridos = signal(0);
  protected readonly codigo = signal('');
  protected readonly escaneo = signal<LevantamientoEscaneoRespuesta | null>(null);
  protected readonly caras = signal<LevantamientoCara[]>([]);
  protected readonly hechas = signal<Set<LevantamientoCara>>(new Set());
  protected readonly fallidas = signal<Pendiente[]>([]);
  /** Caras que se saltaron con motivo: cuentan como resueltas, NO como fotos enviadas. */
  protected readonly saltadas = signal<Set<LevantamientoCara>>(new Set());
  protected readonly eligiendoMotivo = signal(false);
  /** «No es éste» dos veces con el mismo código: el código no corresponde al producto (§10b.7). */
  private rechazos = new Map<string, number>();

  protected readonly indice = computed(() => {
    const i = this.caras().findIndex((c) => !this.hechas().has(c));
    return i < 0 ? this.caras().length - 1 : i;
  });
  protected readonly caraActual = computed<LevantamientoCara>(() => this.caras()[this.indice()] ?? 'frente');
  protected readonly indicacion = computed(() => CARA[this.caraActual()]?.indicacion ?? '');
  /** Las que fallaron se marcan como hechas para avanzar a la siguiente cara; no cuentan como subidas. */
  protected readonly subidas = computed(() => this.hechas().size - this.fallidas().length - this.saltadas().size);
  /** «Enviado · 5 fotos», o «Enviado · 4 fotos · 1 cara saltada»: nunca se cuenta un salto como foto. */
  protected readonly resumenEnviado = computed(() => {
    const fotos = this.subidas();
    const saltos = this.saltadas().size;
    const t = 'Enviado · ' + fotos + (fotos === 1 ? ' foto' : ' fotos');
    return saltos ? t + ' · ' + saltos + (saltos === 1 ? ' cara saltada' : ' caras saltadas') : t;
  });
  protected readonly faltanTexto = computed(() => this.fallidas().map((f) => this.nombreCara(f.face)).join(', '));

  ngOnInit(): void { void this.cargar(); }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const [c, s] = await Promise.all([firstValueFrom(this.api.contexto(this.sucursal())), firstValueFrom(this.api.sugeridos(this.sucursal(), 3, 0))]);
      this.ctx.set(c);
      this.cargadoEn.set(new Date());
      this.sugeridos.set(s.rows);
      this.totalSugeridos.set(s.total);
    } catch (e) {
      if (e instanceof HttpErrorResponse && (e.error as { code?: string } | null)?.code === 'SUCURSAL_REQUERIDA') {
        await this.pedirSucursal();
        return;
      }
      this.error.set(this.mensajeDe(e, 'No se pudo cargar el levantamiento.'));
    } finally {
      this.cargando.set(false);
    }
  }

  private async pedirSucursal(): Promise<void> {
    guardarSucursal(null);
    this.sucursal.set(null);
    try {
      this.sucursalesDisponibles.set(await firstValueFrom(this.api.sucursales()));
    } catch (e) {
      this.aviso.set(this.mensajeDe(e, 'No se pudo cargar la lista de sucursales.'));
    }
    this.paso.set('sucursal');
  }

  protected elegirSucursal(code: string): void {
    this.sucursal.set(code);
    guardarSucursal(code);
    this.aviso.set(null);
    this.paso.set('inicio');
    void this.cargar();
  }

  protected cambiarSucursal(): void { void this.pedirSucursal(); }

  protected readonly masCargando = signal(false);

  /** Un toque a la vez: dos con el mismo offset anexaban las mismas filas dos veces. */
  async masSugeridos(): Promise<void> {
    if (this.masCargando()) return;
    this.masCargando.set(true);
    try {
      const s = await firstValueFrom(this.api.sugeridos(this.sucursal(), 30, this.sugeridos().length));
      this.sugeridos.update((xs) => [...xs, ...s.rows]);
      this.totalSugeridos.set(s.total);
    } catch (e) {
      this.aviso.set(this.mensajeDe(e, 'No se pudieron cargar más. Intenta de nuevo.'));
    } finally {
      this.masCargando.set(false);
    }
  }

  protected unidad(label: string | null | undefined, factor: number | null | undefined): string {
    const r = String(label ?? '').trim().toUpperCase();
    const base = PALABRA[r] ?? (/^\d+$/.test(r) ? r + ' g' : r ? r.toLowerCase() : 'presentación');
    return factor != null && factor > 1 ? base + ' de ' + factor : base;
  }

  protected nombreCara(c: LevantamientoCara): string { return CARA[c]?.nombre ?? c; }

  protected noSoyYo(): void { this.auth.logout(); }

  protected readonly termino = signal('');
  protected readonly resultados = signal<LevantamientoBusquedaFila[]>([]);
  protected readonly buscando = signal(false);
  private espera: ReturnType<typeof setTimeout> | null = null;
  private consulta = 0;

  protected abrirBuscador(): void {
    this.aviso.set(null);
    this.termino.set('');
    this.paso.set('buscar');
    void this.buscarAhora('');
  }

  /** 250 ms después de dejar de teclear (el mismo ritmo que Cotización nueva). */
  protected alTeclear(v: string): void {
    this.termino.set(v);
    if (this.espera) clearTimeout(this.espera);
    this.espera = setTimeout(() => void this.buscarAhora(v), 250);
  }

  private async buscarAhora(q: string): Promise<void> {
    const yo = ++this.consulta;
    this.buscando.set(true);
    try {
      const filas = await firstValueFrom(this.api.buscar(this.sucursal(), q.trim()));
      if (yo === this.consulta) this.resultados.set(filas);
    } catch (e) {
      if (yo === this.consulta) { this.resultados.set([]); this.aviso.set(this.mensajeDe(e, 'No se pudo buscar. Intenta de nuevo.')); }
    } finally {
      if (yo === this.consulta) this.buscando.set(false);
    }
  }

  protected elegir(p: LevantamientoBusquedaFila): void { void this.resolver({ sku: p.sku }); }

  async escanear(code: string): Promise<void> {
    const c = String(code ?? '').trim();
    if (!c) return;
    await this.resolver({ code: c });
  }

  /** Escaneo o elección en el buscador: el servidor resuelve, aparta y dice qué sigue. */
  private async resolver(dto: LevantamientoEscaneoDto): Promise<void> {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    this.aviso.set(null);
    try {
      const r = await firstValueFrom(this.api.escanear(this.sucursal(), dto));
      this.codigo.set('');
      if (r.action === 'capturar') {
        this.escaneo.set(r);
        this.caras.set(r.faces);
        this.hechas.set(new Set(r.faces_done));
        this.fallidas.set([]);
        // Las saltadas las dice el servidor: al retomar, un salto de la vez anterior no se cuenta como foto.
        this.saltadas.set(new Set(r.faces_skipped));
        this.paso.set('confirmar');
      } else {
        this.aviso.set(r.message);
      }
    } catch (e) {
      this.aviso.set(this.mensajeDe(e, 'No se pudo revisar el código. Intenta de nuevo.'));
    } finally {
      this.ocupado.set(false);
    }
  }

  protected empezar(): void {
    this.aviso.set(null);
    this.eligiendoMotivo.set(false);
    this.paso.set(this.hechas().size >= this.caras().length ? 'listo' : 'captura');
  }

  async noEsEste(): Promise<void> {
    if (this.ocupado()) return;
    const r = this.escaneo();
    this.ocupado.set(true);
    try {
      if (r?.sheet_id) await firstValueFrom(this.api.soltar(r.sheet_id)).catch(() => undefined);
    } finally {
      this.ocupado.set(false);
    }
    // Elegido por nombre no hay código que rechazar: sólo se cuenta el rechazo de un código leído.
    const code = r?.code ?? '';
    const n = code ? (this.rechazos.get(code) ?? 0) + 1 : 1;
    if (code) this.rechazos.set(code, n);
    this.volverAlInicio(n >= 2
      ? 'Ese código no corresponde al producto que tienes. Avísale a tu encargado para que Catálogo lo revise.'
      : code ? 'Escanea otra vez el código del producto que tienes en la mano.' : 'Busca otra vez el producto que tienes en la mano.');
  }

  /** Mide la foto en el teléfono; si sale borrosa u opaca, se repite antes de subir. */
  async alTomar(dataUri: string): Promise<void> {
    const face = this.caraActual();
    const r = this.escaneo();
    if (!r?.sheet_id) return;
    this.ocupado.set(true);
    try {
      const { blob, ancho, alto, medicion } = await this.medir(dataUri);
      const veredicto = juzgarFoto(medicion);
      if (!veredicto.ok) {
        this.aviso.set(veredicto.mensaje);
        this.paso.set('repetir');
        return;
      }
      this.aviso.set(null);
      this.paso.set('captura');
      await this.subir(r.sheet_id, { face, blob, ancho, alto, calidad: { sharpness: medicion.nitidez, contrast: medicion.contraste, version: CALIDAD_VERSION } });
    } catch {
      // medir() no pudo leer la imagen (un archivo que el navegador no decodifica): se dice, no se pierde.
      this.aviso.set('No se pudo leer esa foto. Tómala otra vez con la cámara.');
      this.paso.set('repetir');
    } finally {
      this.ocupado.set(false);
    }
  }

  /**
   * Lo resuelto = lo que el servidor ya tiene ∪ lo que falló al subir y espera en memoria para reintentar.
   * Sólo con faces_done una subida buena borraba de la lista las caras que fallaron antes: la pantalla
   * volvía a pedirlas y «Subieron X de 5» contaba de menos.
   */
  private resueltas(res: { faces_done: LevantamientoCara[]; faces_skipped: LevantamientoCara[]; complete: boolean }): void {
    this.hechas.set(new Set([...res.faces_done, ...this.fallidas().map((x) => x.face)]));
    this.saltadas.set(new Set(res.faces_skipped));
    // Con una cara fallida en memoria el servidor dice complete=false aunque ya no quede nada por tomar:
    // sin esto la pantalla se quedaba en la captura, sin el botón Reintentar.
    if (res.complete || this.hechas().size >= this.caras().length) this.paso.set('listo');
  }

  /**
   * 403/409 no son de red: otra persona tiene el producto, o ya no está apartado a tu nombre. Reintentar no
   * lo arregla; se dice y se vuelve al inicio (el escaneo es quien aparta de nuevo).
   */
  private sinRemedio(e: unknown): boolean {
    if (!(e instanceof HttpErrorResponse) || (e.status !== 403 && e.status !== 409)) return false;
    this.volverAlInicio(this.mensajeDe(e, 'Este producto ya no está apartado a tu nombre. Escanéalo otra vez.'));
    return true;
  }

  private async subir(sheetId: string, p: Pendiente): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.subirFoto(sheetId, p.face, p.blob, p.calidad, p.ancho, p.alto));
      if (this.escaneo()?.sheet_id !== sheetId) return; // la persona ya pasó a otro producto
      this.fallidas.update((xs) => xs.filter((x) => x.face !== p.face));
      this.resueltas(res);
    } catch (e) {
      if (this.escaneo()?.sheet_id !== sheetId || this.sinRemedio(e)) return;
      // Falla a media subida: la foto se queda en la memoria de la pantalla para reintentar (sin cola, tramo 1).
      this.fallidas.update((xs) => [...xs.filter((x) => x.face !== p.face), p]);
      this.hechas.update((s) => new Set(s).add(p.face));
      this.aviso.set(this.mensajeDe(e, 'No se pudo subir la foto. Sigue con la siguiente; al final la reintentas.'));
      if ([...this.hechas()].length >= this.caras().length) this.paso.set('listo');
    }
  }

  async reintentar(): Promise<void> {
    const r = this.escaneo();
    if (!r?.sheet_id) return;
    this.ocupado.set(true);
    try {
      for (const p of [...this.fallidas()]) {
        if (this.escaneo()?.sheet_id !== r.sheet_id) break; // volvió al inicio (403/409)
        this.hechas.update((s) => { const n = new Set(s); n.delete(p.face); return n; });
        await this.subir(r.sheet_id, p);
      }
    } finally {
      this.ocupado.set(false);
    }
  }

  /** Desde «repetir»: la misma cara se salta con su motivo (vuelve a la captura con la pregunta abierta). */
  protected saltarDesdeRepetir(): void {
    this.aviso.set(null);
    this.eligiendoMotivo.set(true);
    this.paso.set('captura');
  }

  async saltar(motivo: LevantamientoMotivoSalto): Promise<void> {
    const r = this.escaneo();
    // Mientras sube una foto no se salta nada: la foto y el salto de la misma cara competían.
    if (!r?.sheet_id || this.ocupado()) return;
    this.ocupado.set(true);
    this.eligiendoMotivo.set(false);
    try {
      const res = await firstValueFrom(this.api.saltar(r.sheet_id, this.caraActual(), motivo));
      this.resueltas(res);
    } catch (e) {
      if (this.sinRemedio(e)) return;
      this.aviso.set(this.mensajeDe(e, 'No se pudo guardar. Intenta de nuevo.'));
    } finally {
      this.ocupado.set(false);
    }
  }

  async salir(): Promise<void> {
    const r = this.escaneo();
    if (r?.sheet_id) await firstValueFrom(this.api.soltar(r.sheet_id)).catch(() => undefined);
    this.volverAlInicio(null);
  }

  /**
   * Con fotos que no subieron, el producto se SUELTA antes de seguir: si no, se quedaba apartado 30 min y
   * con tres así (justo cuando no hay señal) ya no se podía escanear nada más.
   */
  protected async siguiente(): Promise<void> {
    if (this.ocupado()) return;
    const r = this.escaneo();
    if (r?.sheet_id && this.fallidas().length) await firstValueFrom(this.api.soltar(r.sheet_id)).catch(() => undefined);
    this.volverAlInicio(null);
  }

  private volverAlInicio(aviso: string | null): void {
    this.saltadas.set(new Set());
    this.escaneo.set(null);
    this.caras.set([]);
    this.hechas.set(new Set());
    this.fallidas.set([]);
    this.paso.set('inicio');
    this.aviso.set(aviso);
    void this.cargar();
  }

  /** Reduce a 640 px de lado mayor SÓLO para medir; lo que se sube es la foto entera. */
  private async medir(dataUri: string): Promise<{ blob: Blob; ancho: number; alto: number; medicion: { nitidez: number; contraste: number } }> {
    const img = new Image();
    img.src = dataUri;
    await img.decode();
    const d = dimensionesDeMedicion(img.naturalWidth, img.naturalHeight);
    const lienzo = document.createElement('canvas');
    lienzo.width = d.ancho;
    lienzo.height = d.alto;
    const g = lienzo.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('Sin canvas');
    g.drawImage(img, 0, 0, d.ancho, d.alto);
    const medicion = medirFoto(g.getImageData(0, 0, d.ancho, d.alto).data, d.ancho, d.alto);
    // Sin `fetch(dataUri)`: la CSP de prod (`connect-src 'self'`) lo bloquea, y en local no hay CSP que lo
    // delate. Así ninguna foto llegó al servidor en la primera captura en prod (2026-11-03).
    const blob = base64ToBlob(dataUri);
    return { blob, ancho: img.naturalWidth, alto: img.naturalHeight, medicion };
  }

  private mensajeDe(e: unknown, porDefecto: string): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string | string[] } | null)?.message;
      if (typeof m === 'string' && m) return m;
      if (Array.isArray(m) && m.length) return m.join(' ');
      if (e.status === 0) return 'Sin conexión. Revisa la señal e intenta de nuevo.';
    }
    return porDefecto;
  }
}
