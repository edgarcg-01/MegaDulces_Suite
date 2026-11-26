import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal, viewChild } from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type {
  LevantamientoBusquedaFila, LevantamientoCara, LevantamientoContexto, LevantamientoDetalle, LevantamientoDetalleTipo, LevantamientoEscaneoDto,
  LevantamientoEscaneoRespuesta, LevantamientoEstadoFoto, LevantamientoMotivoSalto, LevantamientoPeldano, LevantamientoSugerido,
} from '@megadulces/contracts';
import { LEVANTAMIENTO_ACERCAMIENTOS, LEVANTAMIENTO_CARA_OBLIGATORIA, LEVANTAMIENTO_DETALLE_NOTA_MAX, LEVANTAMIENTO_DETALLES } from '@megadulces/contracts';
import { CALIDAD_VERSION, dimensionesDeMedicion, juzgarFoto, medirFoto } from '@megadulces/ui-web';
import { base64ToBlob } from '../../../core/http/visit-form-data';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ProductScanFieldComponent } from '../../comercial/components/product-scan-field.component';
import { CameraShotComponent } from '../../finanzas/components/camera-shot.component';
import { LevantamientoService } from '../levantamiento.service';

type Paso = 'inicio' | 'buscar' | 'confirmar' | 'captura' | 'repetir' | 'salir' | 'listo' | 'detalle';

interface Pendiente {
  face: LevantamientoCara;
  blob: Blob;
  calidad: { sharpness: number; contrast: number; version: string };
  ancho: number;
  alto: number;
}

const CARA: Record<LevantamientoCara, { nombre: string; indicacion: string }> = {
  // `[NP.7.L.21]` Cada paso recuerda qué encuadrar y la trampa típica de esa toma (la guía completa sale una vez).
  frente: { nombre: 'Frente', indicacion: 'El frente derecho, llenando el marco y sin reflejos.' },
  reverso: { nombre: 'Reverso', indicacion: 'Gira el producto: la cara de atrás, completa y derecha.' },
  lateral_izq: { nombre: 'Lado izq.', indicacion: 'El lado izquierdo del producto.' },
  lateral_der: { nombre: 'Lado der.', indicacion: 'El lado derecho del producto.' },
  base: { nombre: 'Base', indicacion: 'La cara de abajo del producto.' },
  // Acercamientos (primer feedback de quien captura, 2026-11-07): en el reverso entero no se alcanzan a leer.
  tabla_nutricional: { nombre: 'Tabla nutr.', indicacion: 'Acércate a la tabla nutrimental hasta que se lean los números. Espera a que enfoque.' },
  informacion: { nombre: 'Información', indicacion: 'Acércate a los ingredientes y los datos del fabricante hasta que se lean.' },
  codigo_barras: { nombre: 'Código', indicacion: 'Acércate al código de barras: que se lean las barras y los números.' },
};

/** `[NP.7.L.25]` Lo que muestra la tarjeta de un escaneo que no abre la captura. */
export interface TarjetaEscaneo {
  tono: 'ok' | 'curso' | 'warn' | 'bad';
  icono: string;
  titulo: string;
  mensaje: string;
  nombre: string | null;
  codigo: string | null;
  candidatos: Array<{ sku: string; name: string | null }>;
  /** Ofrecer «Buscarlo por nombre» (el código no está en sus sucursales). */
  buscar: boolean;
}

/** Cada acción del servidor, con palabras e icono (nunca sólo color). El texto largo es el del servidor. */
export function tarjetaDe(r: Pick<LevantamientoEscaneoRespuesta, 'action' | 'message' | 'name' | 'code' | 'candidates'>): TarjetaEscaneo {
  const base = { mensaje: r.message, nombre: r.name, codigo: r.code, candidatos: [] as TarjetaEscaneo['candidatos'], buscar: false };
  switch (r.action) {
    case 'ya_esta': return { ...base, tono: 'ok', icono: 'pi-check-circle', titulo: 'Ya tiene fotos' };
    case 'en_revision': return { ...base, tono: 'ok', icono: 'pi-check-circle', titulo: 'Ya se le tomaron fotos' };
    case 'apartado_por_otro': return { ...base, tono: 'curso', icono: 'pi-clock', titulo: 'Alguien más lo está tomando' };
    case 'no_registrado': return { ...base, tono: 'warn', icono: 'pi-exclamation-circle', titulo: 'No está en tus sucursales', buscar: true };
    case 'codigo_compartido': return { ...base, tono: 'warn', icono: 'pi-clone', titulo: '¿Cuál de estos es?', candidatos: r.candidates ?? [] };
    case 'demasiados_apartados': return { ...base, tono: 'warn', icono: 'pi-exclamation-circle', titulo: 'Tienes capturas sin terminar' };
    default: return { ...base, tono: 'warn', icono: 'pi-exclamation-circle', titulo: 'No se puede levantar todavía' };
  }
}

/** `[NP.7.L.24]` Nombre completo de cada foto para el título del paso (el corto va en espacios chicos). */
const CARA_LARGO: Partial<Record<LevantamientoCara, string>> = {
  lateral_izq: 'Lado izquierdo', lateral_der: 'Lado derecho', tabla_nutricional: 'Tabla nutrimental', informacion: 'Ingredientes y fabricante', codigo_barras: 'Código de barras',
};

const MOTIVOS: Array<{ id: LevantamientoMotivoSalto; texto: string }> = [
  { id: 'no_tiene_esa_cara', texto: 'No tiene esa cara' },
  { id: 'no_se_puede_girar', texto: 'No se puede girar' },
  { id: 'otro', texto: 'Otro motivo' },
];

/** `[NP.7.L.21]` La guía se muestra UNA vez por teléfono: quien ya la vio no la vuelve a leer en cada producto. */
const CLAVE_GUIA = 'np7-guia-fotos-vista';
const leerGuiaVista = (): boolean => { try { return localStorage.getItem(CLAVE_GUIA) === '1'; } catch { return false; } };
const guardarGuiaVista = (): void => { try { localStorage.setItem(CLAVE_GUIA, '1'); } catch { /* sin almacenamiento: se vuelve a mostrar */ } };

/** Un acercamiento no es una cara que se gire: o el empaque no lo trae, o hay otro motivo. */
const MOTIVOS_ACERCAMIENTO: Array<{ id: LevantamientoMotivoSalto; texto: string }> = [
  { id: 'no_tiene_esa_cara', texto: 'No la trae' },
  { id: 'otro', texto: 'Otro motivo' },
];

const TIPOS_DETALLE: Array<{ id: LevantamientoDetalleTipo; texto: string }> = [
  // `[NP.7.L.21]` Los lados y la base ya no se piden: si traen algo impreso, van aquí.
  { id: 'lados', texto: 'Lados o base con algo impreso' },
  { id: 'caducidad', texto: 'Caducidad o lote' },
  { id: 'sellos', texto: 'Sellos o advertencias' },
  { id: 'promocion', texto: 'Promoción impresa' },
  { id: 'otro', texto: 'Otra cosa' },
];


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
        @case ('inicio') {
          <!-- [NP.7.L.24] Pulido (maqueta docs/maquetas/NP7-levantamiento-pulido.html): buscador arriba, avance en el
               centro, la lista, y «Escanear» fijo abajo donde cae el pulgar. Entradas: 5 → 2. -->
          <header class="lv-appbar">
            <!-- [NP.7.L.26] La pantalla va sin el marco de la app: ésta es su salida a la suite. -->
            <button type="button" class="lv-back" (click)="volverASuite()" aria-label="Volver a Mi trabajo" title="Volver a Mi trabajo"><i class="pi pi-home" aria-hidden="true"></i></button>
            <div class="lv-grow"><p class="lv-eyebrow">Levantamiento de fotos</p>
              <h1 class="lv-title">{{ ctx()?.branch_name ?? ctx()?.branch_code ?? '' }}</h1></div>
            <div class="lv-quien">{{ ctx()?.user?.name || ctx()?.user?.username || auth.user()?.username }}
              <button type="button" class="lv-link lv-link-sm" (click)="noSoyYo()">No soy yo</button></div>
          </header>
          <section class="lv-body lv-body-inicio">
            <button type="button" class="lv-sbar" (click)="abrirBuscador()"><i class="pi pi-search" aria-hidden="true"></i> Buscar por nombre, SKU o código</button>
            <ng-container [ngTemplateOutlet]="tarjetaTpl" />
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }

            <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
              @if (ctx(); as c) {
                <div class="lv-cov">
                  <div class="lv-cov-k"><span class="lv-eyebrow">Por fotografiar</span><app-freshness-pill measures="fetch" [since]="cargadoEn()" /></div>
                  <p class="lv-cov-big"><b>{{ c.missing | number }}</b> <span>productos sin foto</span></p>
                  <div class="lv-cov-bar" role="progressbar" [attr.aria-valuenow]="cobertura()" aria-valuemin="0" aria-valuemax="100" aria-label="Productos con foto">
                    <i [style.width.%]="cobertura()"></i></div>
                  <p class="lv-cov-lg"><span>{{ c.universe - c.missing | number }} de {{ c.universe | number }} con foto · {{ cobertura() | number: '1.0-1' }} %</span>
                    @if (!c.ai_enabled) { <span>Catálogo revisa cada uno</span> }</p>
                </div>
                <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Tu semana en el levantamiento" />
                @if (c.week.rank) { <p class="lv-ter">Vas <b>{{ c.week.rank }}.º</b> en tu sucursal esta semana</p> }
                @if (sugeridos().length) {
                  <div class="lv-sect"><h2>Búscalos en el anaquel: los más vendidos sin foto</h2></div>
                  <ul class="lv-items" aria-label="Los más vendidos sin foto">
                    @for (s of sugeridos(); track s.sku) {
                      <li class="lv-item"><span class="lv-item-ic" aria-hidden="true"><i class="pi pi-camera"></i></span>
                        <span class="lv-item-tx"><span class="lv-item-nm">{{ s.name }}</span><small>{{ mayuscula(unidad(s.unit_label, s.unit_factor)) }}</small></span></li>
                    }
                  </ul>
                  @if (totalSugeridos() > sugeridos().length) {
                    <button type="button" class="lv-btn" [disabled]="masCargando()" (click)="masSugeridos()">Ver más · {{ totalSugeridos() - sugeridos().length | number }} restantes</button>
                  }
                }
              }
            </app-load-state>
          </section>
          <footer class="lv-dock">
            <button type="button" class="lv-btn lv-pri lv-xl" [disabled]="ocupado()" (click)="lector()?.abrirCamara()">
              <i class="pi pi-qrcode" aria-hidden="true"></i> Escanear código de barras</button>
          </footer>
        }

        @case ('buscar') {
          <header class="lv-appbar"><button type="button" class="lv-back" (click)="paso.set('inicio')" aria-label="Regresar"><i class="pi pi-chevron-left"></i></button>
            <h1 class="lv-title lv-grow">Buscar producto</h1></header>
          <section class="lv-body">
            <div class="lv-search"><i class="pi pi-search" aria-hidden="true"></i>
              <input type="search" [value]="termino()" (input)="alTeclear($any($event.target).value)" placeholder="Nombre, SKU o código"
                aria-label="Buscar por nombre, SKU o código" autocomplete="off" enterkeyhint="search" />
              <button type="button" class="lv-search-scan" aria-label="Escanear el código con la cámara" (click)="lector()?.abrirCamara()"><i class="pi pi-qrcode" aria-hidden="true"></i></button></div>
            <p class="lv-ter">Palabras en cualquier orden. Sin escribir nada: lo más vendido.</p>
            <ng-container [ngTemplateOutlet]="tarjetaTpl" />
            <!-- [NP.7.L.22] Una búsqueda que FALLÓ se dice como error, no como «No aparece» (auditoría 2026-11-26). -->
            <app-load-state [loading]="buscando()" [error]="errorBusqueda()" errorTitle="No se pudo buscar" (retry)="buscarAhora(termino())"
              [isEmpty]="!buscando() && !errorBusqueda() && resultados().length === 0"
              emptyTitle="No aparece" emptyHint="Puede ser un producto que el sistema no tiene en tus sucursales. Avísale a tu encargado.">
              <ul class="lv-list" aria-label="Resultados">
                @for (p of resultados(); track p.sku) {
                  <!-- Se puede tocar aunque ya tenga foto: el servidor responde «ya tiene fotos, escanea otro». -->
                  <li><button type="button" class="lv-res" [class.lv-res-hecha]="p.photo_status !== 'falta'" [disabled]="ocupado()" (click)="elegir(p)">
                    <span class="lv-item-tx"><span class="lv-item-nm">{{ p.name }}</span>
                      <small>@if (p.content) { <span>{{ p.content }}</span> }
                        <span class="lv-pill" [class]="'lv-pill lv-pill-' + p.photo_status"><i [class]="'pi ' + estadoFoto[p.photo_status].icono" aria-hidden="true"></i> {{ estadoFoto[p.photo_status].texto }}</span></small></span>
                    <i class="pi pi-chevron-right lv-chev" aria-hidden="true"></i>
                  </button></li>
                }
              </ul>
            </app-load-state>
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }
          </section>
        }
        @case ('confirmar') {
          <header class="lv-appbar"><button type="button" class="lv-back" [disabled]="ocupado()" (click)="noEsEste()" aria-label="Regresar"><i class="pi pi-chevron-left"></i></button>
            <h1 class="lv-title lv-grow">¿Es este producto?</h1></header>
          <section class="lv-body">
            <div class="lv-prod">
              @if (escaneo()?.code) { <p class="lv-prod-code"><i class="pi pi-qrcode" aria-hidden="true"></i> {{ escaneo()?.code }}</p> }
              @else { <p class="lv-prod-code"><i class="pi pi-search" aria-hidden="true"></i> Elegido por nombre: Catálogo lo revisará</p> }
              <p class="lv-prod-nm">{{ escaneo()?.name }}</p>
            </div>
            <!-- [NP.7.L.23] Elige UNA presentación (viene marcada la del código o la más vendida). Sólo al empezar:
                 al retomar una captura con fotos, cambiarla dejaría esas fotos en otra presentación. -->
            @if (puedeElegirPresentacion()) {
              <p id="lv-pres-q" class="lv-q">¿Qué tienes en la mano?</p>
              <div class="lv-opts" role="radiogroup" aria-labelledby="lv-pres-q">
                @for (p of escaneo()?.rungs ?? []; track p.rung) {
                  <button type="button" role="radio" class="lv-op" [class.lv-op-sel]="p.rung === escaneo()?.principal?.rung" [attr.aria-checked]="p.rung === escaneo()?.principal?.rung"
                    [disabled]="ocupado()" (click)="cambiarPresentacion(p.rung)">
                    <span class="lv-op-rd" aria-hidden="true"></span>
                    <span class="lv-item-tx"><span class="lv-op-nm">{{ mayuscula(unidad(p.label, 1)) }}</span><small>{{ piezas(p.factor) }}</small></span>
                  </button>
                }
              </div>
            } @else {
              <p class="lv-q">Vas a fotografiar: {{ unidad(escaneo()?.principal?.label, escaneo()?.principal?.factor) }}</p>
            }
          </section>
          <footer class="lv-foot">
            <button type="button" class="lv-btn lv-pri lv-cta" [disabled]="ocupado()" (click)="empezar()"><i class="pi pi-camera" aria-hidden="true"></i> {{ textoEmpezar() }}</button>
            <button type="button" class="lv-link lv-full" [disabled]="ocupado()" (click)="noEsEste()">No es éste</button>
          </footer>
        }

        @case ('captura') {
          <header class="lv-appbar"><button type="button" class="lv-back" [disabled]="ocupado()" (click)="paso.set('salir')" aria-label="Salir sin terminar"><i class="pi pi-times"></i></button>
            <div class="lv-grow lv-min0"><p class="lv-eyebrow">{{ mayuscula(unidad(escaneo()?.principal?.label, escaneo()?.principal?.factor)) }}</p>
              <h1 class="lv-title lv-title-sm">{{ escaneo()?.name }}</h1></div></header>
          <section class="lv-body">
            @if (mostrarGuia()) {
              <div class="lv-guia" role="note" aria-labelledby="lv-guia-t">
                <p id="lv-guia-t" class="lv-q0">Para que salgan nítidas</p>
                <p class="lv-tip"><i class="pi pi-sun" aria-hidden="true"></i><span>Buena luz, sin flash si el empaque brilla.</span></p>
                <p class="lv-tip"><i class="pi pi-stop" aria-hidden="true"></i><span>El producto solo, sobre fondo liso, llenando el marco.</span></p>
                <p class="lv-tip"><i class="pi pi-mobile" aria-hidden="true"></i><span>Codos apoyados. Toca el producto para enfocar y espera un segundo.</span></p>
                <button type="button" class="lv-btn" (click)="cerrarGuia()">Entendido</button>
              </div>
            }
            <!-- Avance: un tramo por foto (verde hecho, naranja la actual). La lista de nombres queda para el lector de pantalla. -->
            <ol class="lv-progress" aria-label="Fotos">
              @for (c of caras(); track c; let i = $index) {
                <li [class.hecha]="hechas().has(c)" [class.actual]="i === indice()"><span class="lv-sr">{{ nombreCara(c) }}@if (hechas().has(c)) { (hecha) }</span></li>
              }
            </ol>
            <p class="lv-stepline"><b>{{ nombreCaraLargo(caraActual()) }}</b><span>Foto {{ indice() + 1 }} de {{ caras().length }}</span></p>
            <div class="lv-marco" aria-hidden="true"><span class="lv-esq"></span><span class="lv-esq"></span><span class="lv-esq"></span><span class="lv-esq"></span>
              <p class="lv-indic">{{ indicacion() }}</p></div>
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }
          </section>
          <footer class="lv-foot">
            <button type="button" class="lv-btn lv-pri lv-xl" [disabled]="ocupado()" (click)="camara()?.abrir()"><i class="pi pi-camera" aria-hidden="true"></i> {{ hechas().size === 0 ? 'Tomar foto · ' + nombreCaraLargo(caraActual()) : 'Tomar foto' }}</button>
            @if (eligiendoMotivo()) {
              <div class="lv-motivos" role="group" aria-labelledby="lv-motivo-q">
                <p id="lv-motivo-q" class="lv-q0">¿Por qué no se puede tomar esta foto ({{ nombreCara(caraActual()) }})?</p>
                @for (m of motivosActuales(); track m.id) { <button type="button" class="lv-btn" [disabled]="ocupado()" (click)="saltar(m.id)">{{ m.texto }}</button> }
                <button type="button" class="lv-link lv-full" (click)="eligiendoMotivo.set(false)">Mejor sí la tomo</button>
              </div>
            } @else if (caraActual() !== caraObligatoria) {
              <button type="button" class="lv-link lv-full" [disabled]="ocupado()" (click)="eligiendoMotivo.set(true)">{{ saltarTexto() }}</button>
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
              <button type="button" class="lv-link lv-full" (click)="saltarDesdeRepetir()">{{ saltarTexto() }}</button>
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

        @case ('detalle') {
          <header class="lv-head"><div class="lv-bar"><button type="button" class="lv-back" [disabled]="ocupado()" (click)="cancelarDetalle()" aria-label="Regresar"><i class="pi pi-chevron-left"></i></button>
            <span class="lv-t lv-grow">{{ escaneo()?.name }}</span><span class="lv-sec">Detalle {{ detalles().length + 1 }} de {{ maxDetalles }}</span></div></header>
          <section class="lv-body">
            <p id="lv-det-q" class="lv-q0">¿Qué vas a fotografiar?</p>
            <div class="lv-motivos" role="group" aria-labelledby="lv-det-q">
              @for (t of tiposDetalle; track t.id) {
                <button type="button" class="lv-btn" [class.lv-sel]="detalleTipo() === t.id" [attr.aria-pressed]="detalleTipo() === t.id"
                  [disabled]="ocupado()" (click)="detalleTipo.set(t.id)">{{ t.texto }}</button>
              }
            </div>
            @if (detalleTipo() === 'otro') {
              <label class="lv-search"><input type="text" [value]="detalleNota()" (input)="detalleNota.set($any($event.target).value)" [attr.maxlength]="notaMax"
                placeholder="¿Qué es? (opcional)" aria-label="Qué muestra el detalle (opcional)" autocomplete="off" enterkeyhint="done" /></label>
            }
            @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }
          </section>
          <footer class="lv-foot">
            <button type="button" class="lv-btn lv-pri lv-lg" [disabled]="ocupado() || !detalleTipo()" (click)="camara()?.abrir()"><i class="pi pi-camera" aria-hidden="true"></i> Tomar foto</button>
            <button type="button" class="lv-link lv-full" [disabled]="ocupado()" (click)="cancelarDetalle()">Mejor no</button>
            <ng-container [ngTemplateOutlet]="camaraTpl" />
          </footer>
        }

        @case ('listo') {
          <section class="lv-body lv-center">
            @if (fallidas().length === 0) {
              <i class="pi pi-check-circle lv-ok" aria-hidden="true"></i>
              <p class="lv-t">{{ escaneo()?.name }}</p>
              <p class="lv-sec">{{ resumenEnviado() }}</p>
              @if (aviso()) { <p class="lv-aviso" role="status">{{ aviso() }}</p> }
              <!-- «Más detalles»: opcionales y DESPUÉS de terminar (el producto ya está en revisión; no lo frenan). -->
              @if (puedeDetalle()) {
                <div class="lv-det">
                  <p class="lv-ter">¿Los lados o la base traen algo impreso? ¿Caducidad, sellos, una promoción? Agrégalo aquí.</p>
                  <button type="button" class="lv-btn" [disabled]="ocupado()" (click)="abrirDetalle()">
                    <i class="pi pi-plus" aria-hidden="true"></i> Agregar detalle ({{ detalles().length }} de {{ maxDetalles }})</button>
                </div>
              }
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
      <!-- [NP.7.L.24] Un solo escáner para toda la pantalla: sólo su cámara (el inicio y el buscador ponen sus botones). -->
      <app-product-scan-field [soloCamara]="true" [valor]="codigo()" (valorChange)="codigo.set($event)" (buscar)="escanear($event)"
        (sinCamara)="aviso.set($event)" (pidioTeclear)="abrirBuscador()" [ocupado]="ocupado()" [conPie]="false" [autoEnfoque]="false" />
      <!-- [NP.7.L.25] El resultado de un escaneo que NO abre la captura, en una tarjeta visible (antes, un renglón de
           13 px bajo el buscador: en la prueba en celular se leyó como «no hizo nada»). -->
      <ng-template #tarjetaTpl>
        @if (resultado(); as t) {
          <div [class]="'lv-card lv-card-' + t.tono" role="alert">
            <i [class]="'pi ' + t.icono + ' lv-card-ico'" aria-hidden="true"></i>
            <div class="lv-card-tx">
              <p class="lv-card-t">{{ t.titulo }}</p>
              @if (t.nombre) { <p class="lv-card-nm">{{ t.nombre }}</p> }
              <p class="lv-card-msg">{{ t.mensaje }}</p>
              @if (t.codigo) { <p class="lv-card-code"><i class="pi pi-qrcode" aria-hidden="true"></i> {{ t.codigo }}</p> }
              @if (t.candidatos.length) {
                <div class="lv-card-acc" role="group" aria-label="¿Cuál de estos es?">
                  @for (p of t.candidatos; track p.sku) {
                    <button type="button" class="lv-btn" [disabled]="ocupado()" (click)="elegirCandidato(p.sku)">{{ p.name ?? p.sku }}</button>
                  }
                </div>
              }
              @if (t.buscar) { <button type="button" class="lv-btn lv-card-btn" (click)="abrirBuscador()"><i class="pi pi-search" aria-hidden="true"></i> Buscarlo por nombre</button> }
            </div>
            <button type="button" class="lv-card-x" aria-label="Cerrar aviso" (click)="resultado.set(null)"><i class="pi pi-times" aria-hidden="true"></i></button>
          </div>
        }
      </ng-template>
      <ng-template #camaraTpl>
        <app-camera-shot [etiqueta]="etiquetaCamara()" [maxLado]="4096" [resolucion]="'maxima'" [recodificarSiempre]="true" [indicacion]="indicacionCamara()"
          [guia]="etiquetaCamara()" (tomada)="alTomar($event.dataUri)" />
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
    .lv-back { min-width: var(--tap-min, 44px); min-height: var(--tap-min, 44px); border: 0; background: none; color: var(--fg-1); cursor: pointer; }
    .lv-eyebrow { margin: 0; font-size: var(--fs-micro); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--fg-3); }
    .lv-list { list-style: none; margin: var(--sp-2) 0 0; padding: 0; border-top: 1px solid var(--border-color); }
    .lv-aviso { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .lv-q { margin: var(--sp-3) 0 0; font-weight: 700; }
    /* [NP.7.L.24] Captura: marco con esquinas y el recordatorio dentro, donde esta la vista. */
    .lv-marco { position: relative; flex: 1; min-height: 200px; border-radius: var(--r-lg); background: var(--surface-ground); }
    .lv-esq { position: absolute; width: 26px; height: 26px; border: 0 solid var(--fg-1); }
    .lv-esq:nth-child(1) { top: 16%; left: 16%; border-width: 3px 0 0 3px; border-top-left-radius: 10px; }
    .lv-esq:nth-child(2) { top: 16%; right: 16%; border-width: 3px 3px 0 0; border-top-right-radius: 10px; }
    .lv-esq:nth-child(3) { bottom: 22%; left: 16%; border-width: 0 0 3px 3px; border-bottom-left-radius: 10px; }
    .lv-esq:nth-child(4) { bottom: 22%; right: 16%; border-width: 0 3px 3px 0; border-bottom-right-radius: 10px; }
    .lv-indic { position: absolute; left: var(--sp-3); right: var(--sp-3); bottom: var(--sp-3); margin: 0; font-size: var(--fs-sm); font-weight: 600; text-align: center; color: var(--fg-1); }
    .lv-progress { list-style: none; margin: 0; padding: 0; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; }
    .lv-progress li { height: 4px; border-radius: 2px; background: var(--border-color); }
    .lv-progress li.hecha { background: var(--ok-fg); }
    .lv-progress li.actual { background: var(--action); }
    .lv-stepline { margin: calc(-1 * var(--sp-1)) 0 0; display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-2); }
    .lv-stepline b { font-size: var(--fs-h3); }
    .lv-stepline span { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .lv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .lv-tip { margin: 0; display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.35; }
    .lv-tip .pi { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--card-bg); border: 1px solid var(--border-color); color: var(--fg-1); font-size: var(--fs-xs); }
    .lv-q0 { margin: 0 0 var(--sp-1); font-weight: 700; }
    .lv-motivos { display: grid; gap: var(--sp-1); }
    .lv-sel { border: 2px solid var(--fg-1); font-weight: 700; }
    /* [NP.7.L.24] Encabezado de app: sobretitulo chico y titulo grande; la accion de salir a la izquierda. */
    .lv-appbar { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4) var(--sp-2); }
    .lv-appbar .lv-back { margin-left: calc(-1 * var(--sp-2)); }
    .lv-title { margin: 2px 0 0; font-size: var(--fs-h2); font-weight: 700; letter-spacing: -.01em; }
    .lv-title-sm { font-size: var(--fs-h3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lv-min0 { min-width: 0; }
    .lv-quien { text-align: right; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.3; }
    .lv-link-sm { min-height: var(--tap-min, 32px); padding: 0; font-size: var(--fs-xs); display: block; margin-left: auto; }
    .lv-body-inicio { gap: var(--sp-3); padding-top: var(--sp-1); }
    .lv-sbar { display: flex; align-items: center; gap: var(--sp-2); min-height: 48px; padding: 0 var(--sp-4); width: 100%; border: 1px solid var(--border-color); border-radius: var(--r-pill); background: var(--surface-ground); color: var(--fg-3); font-size: var(--fs-body); text-align: left; cursor: pointer; }
    .lv-sbar:focus-visible, .lv-search-scan:focus-visible, .lv-op:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .lv-cov { border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-4); background: var(--surface-ground); }
    .lv-cov-k { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .lv-cov-big { margin: var(--sp-2) 0 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); }
    .lv-cov-big b { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: var(--fs-display); line-height: 1; letter-spacing: -.02em; }
    .lv-cov-big span { font-size: var(--fs-body); color: var(--fg-2); }
    .lv-cov-bar { height: 6px; margin-top: var(--sp-3); border-radius: 3px; background: var(--border-color); overflow: hidden; }
    .lv-cov-bar i { display: block; height: 100%; min-width: 6px; border-radius: 3px; background: var(--ok-fg); }
    .lv-cov-lg { margin: var(--sp-1) 0 0; display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--fg-3); }
    .lv-sect h2 { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); font-weight: 700; }
    .lv-items { list-style: none; margin: 0; padding: 0; }
    .lv-item { display: flex; align-items: center; gap: var(--sp-3); min-height: 60px; padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .lv-item:last-child { border-bottom: 0; }
    .lv-item-ic { flex: none; width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--surface-ground); border: 1px solid var(--border-color); color: var(--fg-2); }
    .lv-item-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; }
    .lv-item-nm { font-size: var(--fs-body); font-weight: 600; overflow-wrap: anywhere; }
    .lv-item-tx small { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--fg-3); }
    .lv-dock { padding: var(--sp-3) var(--sp-4) max(var(--sp-4), env(safe-area-inset-bottom, 0)); border-top: 1px solid var(--border-color); background: var(--card-bg); position: sticky; bottom: 0; }
    .lv-xl { min-height: 60px; font-size: var(--fs-lg); font-weight: 700; border-radius: var(--r-lg); }
    .lv-cta { min-height: 52px; font-size: var(--fs-h3); font-weight: 700; }
    .lv-search { min-height: 52px; padding-right: var(--sp-1); }
    .lv-search input { font-size: 16px; }
    .lv-search-scan { flex: none; width: 40px; height: 40px; display: grid; place-items: center; border-radius: var(--r-sm); border: 1px solid var(--border-color); background: var(--card-bg); color: var(--fg-1); cursor: pointer; }
    .lv-res { flex-direction: row; align-items: center; gap: var(--sp-2); min-height: 60px; }
    .lv-res-hecha .lv-item-nm { color: var(--fg-2); }
    .lv-chev { color: var(--fg-3); }
    .lv-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: var(--r-pill); font-size: var(--fs-micro); font-weight: 700; white-space: nowrap; }
    .lv-pill-falta { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .lv-pill-tiene_foto { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .lv-pill-en_curso { background: var(--surface-ground); color: var(--fg-2); border: 1px solid var(--border-color); }
    .lv-prod { border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-4); background: var(--surface-ground); }
    .lv-prod-code { margin: 0; display: flex; align-items: center; gap: var(--sp-1); font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); color: var(--fg-2); overflow-wrap: anywhere; }
    .lv-prod-nm { margin: var(--sp-2) 0 0; font-size: var(--fs-lg); font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
    .lv-opts { display: grid; gap: var(--sp-2); }
    .lv-op { display: flex; align-items: center; gap: var(--sp-3); min-height: 60px; padding: var(--sp-2) var(--sp-3); width: 100%; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--fg-1); font: inherit; cursor: pointer; }
    .lv-op-sel { border-color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
    .lv-op-rd { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--fg-3); }
    .lv-op-sel .lv-op-rd { border-color: var(--action); background: var(--action); box-shadow: inset 0 0 0 4px var(--card-bg); }
    .lv-op-nm { font-weight: 700; font-size: var(--fs-body); }
    .lv-op:disabled { opacity: .6; cursor: not-allowed; }
    .lv-card { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3) var(--sp-3) var(--sp-3) var(--sp-4); border-radius: var(--r-lg); border: 1px solid var(--border-color); background: var(--surface-ground); }
    .lv-card-ok { background: var(--ok-soft-bg); }
    .lv-card-warn { background: var(--warn-soft-bg); }
    .lv-card-bad { background: var(--bad-soft-bg); }
    .lv-card-ico { flex: none; margin-top: 2px; font-size: var(--fs-lg); }
    .lv-card-ok .lv-card-ico { color: var(--ok-soft-fg); }
    .lv-card-warn .lv-card-ico { color: var(--warn-soft-fg); }
    .lv-card-bad .lv-card-ico { color: var(--bad-soft-fg); }
    .lv-card-curso .lv-card-ico { color: var(--fg-2); }
    .lv-card-tx { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .lv-card-t { margin: 0; font-size: var(--fs-h3); font-weight: 700; color: var(--fg-1); }
    .lv-card-nm { margin: 0; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); overflow-wrap: anywhere; }
    .lv-card-msg { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .lv-card-code { margin: 2px 0 0; display: flex; align-items: center; gap: var(--sp-1); font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--fg-2); }
    .lv-card-acc { display: grid; gap: var(--sp-1); margin-top: var(--sp-2); }
    .lv-card-btn { margin-top: var(--sp-2); width: auto; justify-self: start; padding: 0 var(--sp-3); }
    .lv-card-x { flex: none; width: var(--tap-min, 36px); height: var(--tap-min, 36px); margin: calc(-1 * var(--sp-1)) calc(-1 * var(--sp-1)) 0 0; display: grid; place-items: center; border: 0; background: none; color: var(--fg-2); border-radius: var(--r-md); cursor: pointer; }
    .lv-card-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .lv-guia { display: grid; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .lv-det { display: grid; gap: var(--sp-2); width: 100%; margin-top: var(--sp-3); }
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
  private readonly router = inject(Router);
  /** `[NP.7.L.19]` Cada foto rechazada deja constancia, para calibrar el medidor con datos. */
  private readonly uso = inject(UsoService);
  protected readonly camara = viewChild(CameraShotComponent);
  /** El lector de códigos: el botón grande «Escanear código» abre su cámara. */
  protected readonly lector = viewChild(ProductScanFieldComponent);

  protected readonly tiposDetalle = TIPOS_DETALLE;
  protected readonly maxDetalles = LEVANTAMIENTO_DETALLES.length;
  protected readonly notaMax = LEVANTAMIENTO_DETALLE_NOTA_MAX;
  /** El frente no se salta (el servidor responde 400): la pantalla ni lo ofrece. */
  protected readonly caraObligatoria = LEVANTAMIENTO_CARA_OBLIGATORIA;
  protected readonly paso = signal<Paso>('inicio');
  protected readonly cargando = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly ocupado = signal(false);
  protected readonly aviso = signal<string | null>(null);
  protected readonly ctx = signal<LevantamientoContexto | null>(null);
  /** `[NP.7.L.25]` El último escaneo que no abrió la captura, como tarjeta (null = ninguno). */
  protected readonly resultado = signal<TarjetaEscaneo | null>(null);
  /** Cuándo se leyó el conteo (se deriva en vivo del ODS; la pastilla dice su edad). */
  protected readonly cargadoEn = signal<Date | null>(null);
  /** Answer-first (Q.1): cuánto falta, y lo que lleva la persona esta semana. Lo que está en revisión no suma. */
  protected readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.ctx();
    if (!c) return [];
    return [
      // [NP.7.L.24] «Sin fotos» pasó a la tarjeta de avance; aquí queda sólo la semana de la persona.
      { label: 'Tus publicadas esta semana', value: c.week.published, format: 'number' },
      { label: 'Tuyas en revisión', value: c.week.in_review, format: 'number', sub: 'no suman hasta publicarse' },
    ];
  });
  /** `[NP.7.L.24]` % del universo de la sucursal que ya tiene ficha: sale de lo que manda el servidor, no se calcula aparte. */
  protected readonly cobertura = computed(() => {
    const c = this.ctx();
    if (!c || !(c.universe > 0)) return 0;
    return Math.max(0, Math.min(100, ((c.universe - c.missing) / c.universe) * 100));
  });
  /** El botón de confirmar dice qué va a pasar: «Tomar 4 fotos del paquete». */
  protected readonly textoEmpezar = computed(() => {
    if (this.hechas().size > 0) return 'Seguir tomando fotos';
    const n = this.caras().length;
    const quien = this.unidad(this.escaneo()?.principal?.label, 1);
    return 'Tomar ' + n + (n === 1 ? ' foto' : ' fotos') + (quien && quien !== 'presentación' ? (quien.endsWith('a') ? ' de la ' : ' del ') + quien : '');
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
  private readonly esAcercamiento = computed(() => LEVANTAMIENTO_ACERCAMIENTOS.includes(this.caraActual()));
  /** `[NP.7.L.21]` La guía de fotos: sólo antes de la primera foto, y sólo hasta que la persona la cierra una vez. */
  private readonly guiaVista = signal(leerGuiaVista());
  protected readonly mostrarGuia = computed(() => !this.guiaVista() && this.hechas().size === 0);
  protected cerrarGuia(): void {
    this.guiaVista.set(true);
    guardarGuiaVista();
  }
  protected readonly motivosActuales = computed(() => (this.esAcercamiento() ? MOTIVOS_ACERCAMIENTO : MOTIVOS));
  protected readonly saltarTexto = computed(() => (this.esAcercamiento() ? 'No la trae: saltar' : 'Saltar esta cara'));

  /** Detalles ya subidos de esta ficha (los dice el servidor) y el que se está armando. */
  protected readonly detalles = signal<LevantamientoDetalle[]>([]);
  protected readonly detalleTipo = signal<LevantamientoDetalleTipo | null>(null);
  protected readonly detalleNota = signal('');
  /** El servidor dijo que ya no (403/409: pasó la ventana, Catálogo ya revisó…): no se vuelve a ofrecer. */
  private readonly detallesCerrados = signal(false);
  private readonly siguienteDetalle = computed<LevantamientoDetalle | null>(
    () => LEVANTAMIENTO_DETALLES.find((d) => !this.detalles().includes(d)) ?? null,
  );
  protected readonly puedeDetalle = computed(() => !!this.escaneo()?.sheet_id && !this.fallidas().length && !this.detallesCerrados() && !!this.siguienteDetalle());
  protected readonly etiquetaCamara = computed(() => {
    if (this.paso() !== 'detalle') return this.nombreCara(this.caraActual());
    return 'Detalle · ' + (TIPOS_DETALLE.find((t) => t.id === this.detalleTipo())?.texto ?? '');
  });
  protected readonly indicacionCamara = computed(() => (this.paso() === 'detalle' ? 'Acércate a lo que quieres mostrar: que se lea.' : this.indicacion()));
  /** Las que fallaron se marcan como hechas para avanzar a la siguiente cara; no cuentan como subidas. */
  protected readonly subidas = computed(() => this.hechas().size - this.fallidas().length - this.saltadas().size);
  /** «Enviado · 5 fotos», o «Enviado · 4 fotos · 1 cara saltada»: nunca se cuenta un salto como foto. */
  protected readonly resumenEnviado = computed(() => {
    const fotos = this.subidas();
    const saltos = this.saltadas().size;
    const det = this.detalles().length;
    let t = 'Enviado · ' + fotos + (fotos === 1 ? ' foto' : ' fotos');
    if (saltos) t += ' · ' + saltos + (saltos === 1 ? ' saltada' : ' saltadas');
    return det ? t + ' · ' + det + (det === 1 ? ' detalle' : ' detalles') : t;
  });
  protected readonly faltanTexto = computed(() => this.fallidas().map((f) => this.nombreCara(f.face)).join(', '));

  ngOnInit(): void { void this.cargar(); }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const [c, s] = await Promise.all([firstValueFrom(this.api.contexto()), firstValueFrom(this.api.sugeridos(3, 0))]);
      this.ctx.set(c);
      this.cargadoEn.set(new Date());
      this.sugeridos.set(s.rows);
      this.totalSugeridos.set(s.total);
    } catch (e) {
      // `[NP.7.L.20]` Sin sucursal en el perfil ni en el alcance, el servidor responde 403 `SIN_SUCURSAL` con el
      // aviso «pídele a tu encargado»: se muestra tal cual. Ya no hay paso para elegirla.
      this.error.set(this.mensajeDe(e, 'No se pudo cargar el levantamiento.'));
    } finally {
      this.cargando.set(false);
    }
  }

  protected readonly masCargando = signal(false);

  /** Un toque a la vez: dos con el mismo offset anexaban las mismas filas dos veces. */
  async masSugeridos(): Promise<void> {
    if (this.masCargando()) return;
    this.masCargando.set(true);
    try {
      const s = await firstValueFrom(this.api.sugeridos(30, this.sugeridos().length));
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
  /** El nombre completo (sin abreviar) para el título del paso y el botón. */
  protected nombreCaraLargo(c: LevantamientoCara): string { return CARA_LARGO[c] ?? this.nombreCara(c); }
  protected mayuscula(t: string): string { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  protected piezas(f: number | null | undefined): string { return f != null && f > 1 ? f + ' piezas' : '1 pieza'; }

  protected noSoyYo(): void { this.auth.logout(); }
  /** `[NP.7.L.26]` Volver a la suite (Mi trabajo): esta pantalla no lleva el marco ni el menú lateral. */
  protected volverASuite(): void { void this.router.navigate(['/projects']); }

  protected readonly termino = signal('');
  protected readonly resultados = signal<LevantamientoBusquedaFila[]>([]);
  protected readonly buscando = signal(false);
  /** `[NP.7.L.22]` La búsqueda falló (red, servidor): distinto de «no aparece». */
  protected readonly errorBusqueda = signal<string | null>(null);
  /** `[NP.7.L.22]` Cómo se dice el estado de las fotos en cada resultado: palabra + icono, nunca sólo color. */
  protected readonly estadoFoto: Record<LevantamientoEstadoFoto, { texto: string; icono: string }> = {
    tiene_foto: { texto: 'Tiene foto', icono: 'pi-check' },
    en_curso: { texto: 'Alguien la está tomando', icono: 'pi-clock' },
    falta: { texto: 'Falta foto', icono: 'pi-camera' },
  };
  private espera: ReturnType<typeof setTimeout> | null = null;
  private consulta = 0;

  protected abrirBuscador(): void {
    this.aviso.set(null);
    this.resultado.set(null);
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

  protected async buscarAhora(q: string): Promise<void> {
    const yo = ++this.consulta;
    this.buscando.set(true);
    try {
      const filas = await firstValueFrom(this.api.buscar(q.trim()));
      if (yo === this.consulta) {
        this.resultados.set(filas);
        this.errorBusqueda.set(null); // y el «Sin conexión» de un intento anterior ya no aplica
      }
    } catch (e) {
      if (yo === this.consulta) { this.resultados.set([]); this.errorBusqueda.set(this.mensajeDe(e, 'No se pudo buscar. Intenta de nuevo.')); }
    } finally {
      if (yo === this.consulta) this.buscando.set(false);
    }
  }

  /** `[NP.7.L.25]` Código compartido: la persona elige cuál de los productos tiene en la mano. */
  protected elegirCandidato(sku: string): void { void this.resolver({ sku }); }

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
    this.resultado.set(null);
    try {
      const r = await firstValueFrom(this.api.escanear(dto));
      this.codigo.set('');
      if (r.action === 'capturar') {
        this.escaneo.set(r);
        this.caras.set(r.faces);
        this.hechas.set(new Set(r.faces_done));
        this.fallidas.set([]);
        // Las saltadas las dice el servidor: al retomar, un salto de la vez anterior no se cuenta como foto.
        this.saltadas.set(new Set(r.faces_skipped));
        this.detalles.set([]);
        this.detallesCerrados.set(false);
        this.paso.set('confirmar');
      } else {
        this.resultado.set(tarjetaDe(r));
        if (navigator.vibrate) navigator.vibrate([60, 60, 60]); // distinto del zumbido corto de «leído»
      }
    } catch (e) {
      this.resultado.set({
        tono: 'bad', icono: 'pi-exclamation-triangle', titulo: 'No se pudo revisar el código',
        mensaje: this.mensajeDe(e, 'Intenta de nuevo.'), nombre: null, codigo: dto.code ?? null, candidatos: [], buscar: false,
      });
    } finally {
      this.ocupado.set(false);
    }
  }

  protected empezar(): void {
    this.aviso.set(null);
    this.eligiendoMotivo.set(false);
    this.paso.set(this.hechas().size >= this.caras().length ? 'listo' : 'captura');
  }

  /** `[NP.7.L.23]` Hay de dónde elegir y la captura no ha empezado (sin fotos ni saltos todavía). */
  protected readonly puedeElegirPresentacion = computed(() => (this.escaneo()?.rungs?.length ?? 0) > 1 && this.hechas().size === 0);

  /**
   * `[NP.7.L.23]` Cambiar la presentación marcada: se suelta el apartado de la propuesta y se vuelve a pedir con la
   * elegida (el servidor valida que el producto la tenga y que nadie más esté tomando ese producto). Si no se puede
   * apartar, se regresa al inicio con el aviso del servidor: nada queda apartado a medias.
   */
  protected async cambiarPresentacion(rung: LevantamientoPeldano): Promise<void> {
    const r = this.escaneo();
    if (!r || this.ocupado() || r.principal?.rung === rung) return;
    const dto: LevantamientoEscaneoDto = r.code ? { code: r.code, rung } : { sku: r.sku ?? '', rung };
    if (r.sheet_id) await firstValueFrom(this.api.soltar(r.sheet_id)).catch(() => undefined);
    await this.resolver(dto);
    if (this.escaneo() === r) {
      this.escaneo.set(null);
      this.paso.set('inicio');
    }
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
    if (this.paso() === 'detalle') return this.tomarDetalle(dataUri);
    const face = this.caraActual();
    const r = this.escaneo();
    if (!r?.sheet_id) return;
    this.ocupado.set(true);
    try {
      const { blob, ancho, alto, medicion } = await this.medir(dataUri);
      const veredicto = juzgarFoto(medicion);
      if (!veredicto.ok) {
        this.uso.registrarFotoRechazada({ motivo: veredicto.motivo, cara: face, version: CALIDAD_VERSION, nitidez: medicion.nitidez, contraste: medicion.contraste, ancho, alto });
        this.aviso.set(veredicto.mensaje);
        this.paso.set('repetir');
        return;
      }
      this.aviso.set(null);
      if (!this.guiaVista()) this.cerrarGuia(); // ya tomó una buena: la guía cumplió
      this.paso.set('captura');
      await this.subir(r.sheet_id, { face, blob, ancho, alto, calidad: { sharpness: medicion.nitidez, contrast: medicion.contraste, version: CALIDAD_VERSION } });
    } catch {
      // medir() no pudo leer la imagen (un archivo que el navegador no decodifica): se dice, no se pierde.
      // (`subir()` atrapa sus propias fallas: lo que llega aquí es de la medición.)
      this.uso.registrarFotoRechazada({ motivo: 'ilegible', cara: face, version: CALIDAD_VERSION, nitidez: null, contraste: null, ancho: null, alto: null });
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
    if (res.complete || this.hechas().size >= this.caras().length) {
      // «Enviado» pinta el aviso (para los detalles): uno viejo de una subida o un salto que ya se resolvieron
      // no puede quedarse junto al éxito. Con fotos fallidas el aviso sigue valiendo y se conserva.
      if (this.fallidas().length === 0) this.aviso.set(null);
      this.paso.set('listo');
    }
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
      this.aviso.set(null); // el «Sin conexión» de un intento anterior ya no aplica
      this.resueltas(res);
    } catch (e) {
      if (this.sinRemedio(e)) return;
      this.aviso.set(this.mensajeDe(e, 'No se pudo guardar. Intenta de nuevo.'));
    } finally {
      this.ocupado.set(false);
    }
  }

  protected abrirDetalle(): void {
    if (!this.puedeDetalle()) return;
    this.aviso.set(null);
    this.detalleTipo.set(null);
    this.detalleNota.set('');
    this.paso.set('detalle');
  }

  protected cancelarDetalle(): void {
    this.aviso.set(null);
    this.paso.set('listo');
  }

  /**
   * Un detalle: misma medición que una cara (borrosa → se repite aquí mismo, sin pantalla «repetir»). Si la red
   * falla, la persona se queda en este paso y la vuelve a tomar; si el servidor dice que ya no (pasó la ventana,
   * Catálogo ya revisó), se avisa en «Enviado» y no se vuelve a ofrecer.
   */
  private async tomarDetalle(dataUri: string): Promise<void> {
    const r = this.escaneo();
    const face = this.siguienteDetalle();
    const tipo = this.detalleTipo();
    if (!r?.sheet_id || !face || !tipo || this.ocupado()) return;
    this.ocupado.set(true);
    try {
      const { blob, ancho, alto, medicion } = await this.medir(dataUri);
      const veredicto = juzgarFoto(medicion);
      if (!veredicto.ok) {
        this.uso.registrarFotoRechazada({ motivo: veredicto.motivo, cara: face, version: CALIDAD_VERSION, nitidez: medicion.nitidez, contraste: medicion.contraste, ancho, alto });
        this.aviso.set(veredicto.mensaje);
        return;
      }
      const nota = tipo === 'otro' ? this.detalleNota().trim() || null : null;
      const res = await firstValueFrom(this.api.subirFoto(r.sheet_id, face, blob,
        { sharpness: medicion.nitidez, contrast: medicion.contraste, version: CALIDAD_VERSION }, ancho, alto, { tipo, nota }));
      if (this.escaneo()?.sheet_id !== r.sheet_id) return;
      this.detalles.set(res.details_done);
      this.aviso.set('Detalle agregado.');
      this.paso.set('listo');
    } catch (e) {
      if (e instanceof HttpErrorResponse && (e.status === 403 || e.status === 409)) {
        this.detallesCerrados.set(true);
        this.aviso.set(this.mensajeDe(e, 'Ya no se le pueden agregar detalles a este producto.'));
        this.paso.set('listo');
        return;
      }
      this.aviso.set(e instanceof HttpErrorResponse ? this.mensajeDe(e, 'No se pudo subir el detalle. Tómalo otra vez.') : 'No se pudo leer esa foto. Tómala otra vez con la cámara.');
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
    this.detalles.set([]);
    this.detalleTipo.set(null);
    this.detalleNota.set('');
    this.detallesCerrados.set(false);
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
