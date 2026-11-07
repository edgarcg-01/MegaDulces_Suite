import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { TagModule } from 'primeng/tag';
import {
  CASILLAS_KEPLER,
  type CasillaKepler,
  type CatalogosAlta,
  type CodigoPostalAlta,
  type FichaKeplerCliente,
  type UbicacionAlta,
  type HallazgoAlta,
  type PosibleDuplicado,
  type RevisionAlta,
  type SolicitudAlta,
  type SolicitudAltaBody,
  type SubirConstanciaRespuesta,
  type TipoPersona,
  warehouseName,
} from '@megadulces/contracts';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { AltaClientesService } from '../alta-clientes.service';
import { MapComponent } from '../../../shared/components/map/map.component';

type Paso = 'elegir' | 'leyendo' | 'forma';

const FICHA_VACIA: FichaKeplerCliente = {
  nombre: '', direccion_1: '', direccion_2: '', estado: '', codigo_postal: '',
  telefono_1: '', telefono_2: '', telefono_3: '', rfc: '', curp: '', email: '',
};

function formaVacia(branch: string): SolicitudAltaBody {
  return {
    branch, origen: 'manual', tipo_persona: 'fisica', rfc: '', curp: '', nombre_fiscal: '', regimen_capital: null,
    nombre_comercial: null, regimen_fiscal: '', codigo_postal_fiscal: '', ficha: { ...FICHA_VACIA },
    vendedor_code: null, grupo_code: null, zona_code: null, credito_solicitado: 0, plazo_dias: 0, descuento_pct: 0,
    comentarios: null, constancia_key: null, customer_id: null,
  };
}

/** Casillas de la forma de Kepler que se capturan aquí, en SU orden y en dos grupos (Miller: ≤ 6). */
/** RFC genérico nacional del SAT («público en general») y el único régimen que admite. */
const RFC_GENERICO = 'XAXX010101000';
const REGIMEN_SIN_RFC = '616';
const DOMICILIO: CasillaKepler[] =['nombre', 'direccion_1', 'direccion_2', 'estado', 'codigo_postal'];
const CONTACTO: CasillaKepler[] = ['telefono_1', 'telefono_2', 'telefono_3', 'email'];

/**
 * `[ALC.3.1]` Alta de un cliente: desde la constancia del SAT o a mano.
 *
 * ⛔ La constancia NO se exige (CFF 83 fr. IX): «Capturar a mano» vale lo mismo y está al lado.
 * Lo que la constancia trae se prellena y se puede corregir; lo que no trae se dice.
 * Las reglas (RFC con verificador, régimen, CP del SAT, duplicados en Kepler) las corre el
 * servidor: la pantalla pinta cada hallazgo junto a su casilla.
 */
@Component({
  selector: 'app-alta-cliente-form',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, InputNumberModule, SelectModule, TextareaModule, TagModule, SegmentedComponent, MapComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (paso() === 'elegir') {
      <div class="af-elegir">
        <label class="af-opcion" for="af-pdf">
          <i class="pi pi-file-pdf" aria-hidden="true"></i>
          <span class="af-op-t">Subir su constancia</span>
          <span class="af-op-s">El PDF que da el SAT. Se llenan RFC, nombre, domicilio y régimen; tú los revisas.</span>
          <input id="af-pdf" type="file" accept="application/pdf" class="af-oculto" (change)="elegirPdf($event)" />
        </label>
        <button type="button" class="af-opcion" (click)="aMano()">
          <i class="pi pi-pencil" aria-hidden="true"></i>
          <span class="af-op-t">Capturar a mano</span>
          <span class="af-op-s">Si no trae la constancia. No se le puede exigir para facturar.</span>
        </button>
      </div>
      @if (errorLectura()) { <p class="af-banda af-banda-bad" role="alert"><i class="pi pi-exclamation-circle" aria-hidden="true"></i>{{ errorLectura() }}</p> }
    }

    @if (paso() === 'leyendo') {
      <p class="af-leyendo" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo la constancia…</p>
    }

    @if (paso() === 'forma') {
      <form class="af-forma" (ngSubmit)="guardar()" autocomplete="off">
        @if (lectura(); as l) {
          @if (l.lectura.ok) {
            <p class="af-banda af-banda-info" role="status">
              <i class="pi pi-file-check" aria-hidden="true"></i>
              Constancia leída{{ l.lectura.constancia.emitida_el ? ', emitida el ' + fechaLarga(l.lectura.constancia.emitida_el) : '' }}.
              Revisa lo que se llenó.
              @if (l.aviso_guardado) { <strong>{{ l.aviso_guardado }}</strong> }
            </p>
          }
        }
        @if (avisosGenerales().length) {
          <ul class="af-avisos" aria-label="Avisos de la captura">
            @for (h of avisosGenerales(); track h.mensaje) { <li [class.af-bloquea]="h.gravedad === 'bloquea'">{{ h.mensaje }}</li> }
          </ul>
        }
        @if (duplicados().length) {
          <div class="af-banda af-banda-warn" role="alert">
            <i class="pi pi-clone" aria-hidden="true"></i>
            <div>
              <strong>{{ duplicados()[0].por === 'rfc' ? 'Este RFC ya está en Kepler' : 'En Kepler hay clientes con un nombre muy parecido' }}:</strong>
              <ul class="af-dups">
                @for (d of duplicados(); track d.clave) {
                  <li><span class="af-mono">{{ d.clave }}</span> {{ d.nombre }} · {{ sucursalesDe(d) }}</li>
                }
              </ul>
              @if (pideConfirmar()) {
                <p class="af-tenue">Si de verdad es otra ficha (otra razón social u otra entrega), guárdala confirmándolo.</p>
              }
            </div>
          </div>
        }

        <fieldset class="af-grupo">
          <legend>Datos fiscales <span class="af-tenue">— lo que lleva la factura</span></legend>
          @if (!sinRfc()) {
            <div class="af-fila">
              <app-segmented [options]="tipos" [value]="f().tipo_persona" (valueChange)="tipo($event)" ariaLabel="Tipo de persona" />
            </div>
          }
          <div class="af-rejilla">
            <div class="af-campo">
              <div class="af-campo-cab">
                <label for="af-rfc">RFC</label>
                <app-segmented [options]="modosRfc" [value]="sinRfc() ? 'sin' : 'con'" (valueChange)="modoRfc($event)" ariaLabel="¿El cliente tiene RFC?" />
              </div>
              <input pInputText id="af-rfc" name="rfc" [ngModel]="f().rfc" (ngModelChange)="setRfc($event)" (blur)="revisar()" maxlength="13"
                     class="af-mono" [readonly]="sinRfc()" [attr.aria-invalid]="esBloqueo('rfc')" required />
              @if (sinRfc()) {
                <small class="af-tenue">RFC genérico del SAT (público en general): persona física, régimen 616. Se le vende sin factura a su nombre.</small>
              } @else if (error('rfc'); as e) {
                <small [class.af-err]="esBloqueo('rfc')" [class.af-aviso]="!esBloqueo('rfc')">{{ e }}</small>
              }
            </div>
            @if (f().tipo_persona === 'fisica') {
              <label class="af-campo">
                <span>CURP <span class="af-tenue">(opcional)</span></span>
                <input pInputText name="curp" [ngModel]="f().curp" (ngModelChange)="setCurp($event)" (blur)="revisar()" maxlength="18" class="af-mono" />
                @if (error('curp'); as e) { <small [class.af-err]="esBloqueo('curp')" [class.af-aviso]="!esBloqueo('curp')">{{ e }}</small> }
              </label>
            }
            <label class="af-campo af-ancho">
              <span>{{ f().tipo_persona === 'moral' ? 'Razón social (sin «SA de CV»)' : 'Nombre completo' }}</span>
              <input pInputText name="nombre_fiscal" [ngModel]="f().nombre_fiscal" (ngModelChange)="setNombre($event)" (blur)="revisar()" required />
              @if (error('nombre_fiscal'); as e) { <small [class.af-err]="esBloqueo('nombre_fiscal')" [class.af-aviso]="!esBloqueo('nombre_fiscal')">{{ e }}</small> }
            </label>
            @if (f().tipo_persona === 'moral') {
              <label class="af-campo">
                <span>Régimen de capital</span>
                <input pInputText name="regimen_capital" [ngModel]="f().regimen_capital" (ngModelChange)="set('regimen_capital', $event)" placeholder="SOCIEDAD ANONIMA DE CAPITAL VARIABLE" />
              </label>
            }
            <label class="af-campo af-ancho">
              <span>Régimen fiscal</span>
              <p-select name="regimen_fiscal" [options]="regimenes()" optionLabel="etiqueta" optionValue="clave" [ngModel]="f().regimen_fiscal"
                        (ngModelChange)="set('regimen_fiscal', $event); revisar()" placeholder="Elige el régimen con el que se le factura"
                        [filter]="true" filterBy="etiqueta" appendTo="body" ariaLabel="Régimen fiscal" [disabled]="sinRfc() && f().regimen_fiscal === REGIMEN_SIN_RFC" />
              @if (error('regimen_fiscal'); as e) { <small class="af-err">{{ e }}</small> }
            </label>
            <label class="af-campo">
              <span>Código postal fiscal</span>
              <input pInputText name="cp" [ngModel]="f().codigo_postal_fiscal" (ngModelChange)="setCp($event)" (blur)="revisar()" maxlength="5" inputmode="numeric" class="af-mono" required />
              @if (error('codigo_postal_fiscal'); as e) { <small [class.af-err]="esBloqueo('codigo_postal_fiscal')" [class.af-aviso]="!esBloqueo('codigo_postal_fiscal')">{{ e }}</small> }
            </label>
          </div>
        </fieldset>

        <fieldset class="af-grupo">
          <legend>Ficha de Kepler <span class="af-tenue">— en el orden de la forma «Datos del cliente»</span></legend>
          <div class="af-rejilla">
            @for (c of domicilio; track c) {
              <label class="af-campo" [class.af-ancho]="c === 'nombre' || c === 'direccion_1' || c === 'direccion_2'">
                <span>{{ rotulo(c) }} <span class="af-cuenta" [class.af-pasa]="largo(c) > limite(c)">{{ largo(c) }}/{{ limite(c) }}</span></span>
                <input pInputText [name]="'k_' + c" [ngModel]="f().ficha[c]" (ngModelChange)="setFicha(c, $event)" (blur)="revisar()" />
                @if (error('ficha.' + c); as e) { <small [class.af-err]="esBloqueo('ficha.' + c)" [class.af-aviso]="!esBloqueo('ficha.' + c)">{{ e }}</small> }
                @if (c === 'estado' && estadoAuto() && f().ficha.estado === estadoAuto()) { <small class="af-tenue">Del catálogo del SAT por el código postal.</small> }
              </label>
              @if (c === 'direccion_2' && sugerenciasDir2().length) {
                <div class="af-sugerencias af-ancho" role="group" [attr.aria-label]="'Colonia y municipio como los escribe Kepler para el CP ' + datosCp()!.codigo_postal">
                  <span class="af-tenue">Así lo escribe Kepler para el CP {{ datosCp()!.codigo_postal }}:</span>
                  @for (s of sugerenciasDir2(); track s.texto) {
                    <button pButton type="button" size="small" [outlined]="true" severity="secondary" (click)="usarSugerencia(s.texto)"
                            [attr.aria-pressed]="f().ficha.direccion_2 === s.texto">{{ s.texto }}</button>
                  }
                </div>
              }
            }
          </div>
          <div class="af-rejilla af-sep">
            @for (c of contacto; track c) {
              <label class="af-campo">
                <span>{{ rotulo(c) }}</span>
                <input pInputText [name]="'k_' + c" [ngModel]="f().ficha[c]" (ngModelChange)="setFicha(c, $event)" [type]="c === 'email' ? 'email' : 'tel'" />
                @if (error('ficha.' + c); as e) { <small class="af-err">{{ e }}</small> }
              </label>
            }
          </div>
        </fieldset>

        <fieldset class="af-grupo">
          <legend>Ubicación <span class="af-tenue">— opcional: dónde está la tienda, para la ruta y el mapa de clientes</span></legend>
          <div class="af-geo-acciones">
            <button pButton type="button" size="small" [outlined]="true" [disabled]="buscandoUbicacion() || !direccionParaBuscar()"
                    [loading]="buscandoUbicacion() === 'direccion'" (click)="ubicarPorDireccion()">
              <span class="p-button-icon p-button-icon-left pi pi-map-marker" aria-hidden="true"></span>Ubicar en el mapa
            </button>
            @if (hayGps) {
              <button pButton type="button" size="small" [outlined]="true" [disabled]="!!buscandoUbicacion()"
                      [loading]="buscandoUbicacion() === 'gps'" (click)="usarMiUbicacion()">
                <span class="p-button-icon p-button-icon-left pi pi-compass" aria-hidden="true"></span>Usar mi ubicación
              </button>
            }
            @if (f().ubicacion) {
              <button pButton type="button" size="small" [text]="true" severity="secondary" (click)="quitarUbicacion()">Quitar</button>
            }
          </div>
          @if (avisoUbicacion(); as a) { <small class="af-aviso" role="status">{{ a }}</small> }
          @if (f().ubicacion; as u) {
            <p class="af-geo-nota" role="status">
              {{ u.origen === 'gps' ? 'Del GPS de este dispositivo' + (u.precision_m != null ? ' (±' + u.precision_m + ' m)' : '') : u.origen === 'mapa' ? 'Punto elegido en el mapa' : 'Buscado por la dirección: revisa que caiga en la tienda' }}
              · <span class="af-mono">{{ u.lat.toFixed(6) }}, {{ u.lng.toFixed(6) }}</span> · un clic en el mapa lo mueve.
            </p>
            <app-map [pickable]="true" [pickedPoint]="{ lat: u.lat, lng: u.lng }" (mapClick)="moverPunto($event)"
                     height="220px" [autoFit]="'off'" [showBasemapToggle]="false" />
          }
          @if (error('ubicacion'); as e) { <small [class.af-err]="esBloqueo('ubicacion')" [class.af-aviso]="!esBloqueo('ubicacion')">{{ e }}</small> }
        </fieldset>

        <fieldset class="af-grupo">
          <legend>Sucursal y cartera en Kepler</legend>
          <div class="af-rejilla">
            <label class="af-campo">
              <span>Sucursal</span>
              <p-select name="branch" [options]="sucursales()" optionLabel="nombre" optionValue="clave" [ngModel]="f().branch"
                        (ngModelChange)="cambiarSucursal($event)" appendTo="body" ariaLabel="Sucursal donde se da de alta" />
            </label>
            <label class="af-campo">
              <span>Vendedor</span>
              <p-select name="vendedor" [options]="catalogos()?.vendedores ?? []" optionLabel="nombre" optionValue="clave" [ngModel]="f().vendedor_code"
                        (ngModelChange)="set('vendedor_code', $event)" [filter]="true" [showClear]="true" appendTo="body" placeholder="Se elige en Kepler" ariaLabel="Vendedor" />
            </label>
            <label class="af-campo">
              <span>Grupo</span>
              <p-select name="grupo" [options]="catalogos()?.grupos ?? []" optionLabel="nombre" optionValue="clave" [ngModel]="f().grupo_code"
                        (ngModelChange)="set('grupo_code', $event)" [filter]="true" [showClear]="true" appendTo="body" placeholder="Se elige en Kepler" ariaLabel="Grupo" />
            </label>
            <label class="af-campo">
              <span>Zona</span>
              <p-select name="zona" [options]="catalogos()?.zonas ?? []" optionLabel="nombre" optionValue="clave" [ngModel]="f().zona_code"
                        (ngModelChange)="set('zona_code', $event)" [filter]="true" [showClear]="true" appendTo="body" placeholder="Se elige en Kepler" ariaLabel="Zona" />
            </label>
          </div>
        </fieldset>

        <fieldset class="af-grupo">
          <legend>Crédito <span class="af-tenue">— si pide crédito, plazo o descuento, lo aprueba Crédito y Cobranza</span></legend>
          <div class="af-rejilla">
            <label class="af-campo">
              <span>Límite de crédito</span>
              <p-inputnumber name="credito" [ngModel]="f().credito_solicitado" (ngModelChange)="set('credito_solicitado', $event ?? 0)" mode="currency" currency="MXN" locale="es-MX" [min]="0" inputId="af-credito" />
            </label>
            <label class="af-campo">
              <span>Plazo (días)</span>
              <p-inputnumber name="plazo" [ngModel]="f().plazo_dias" (ngModelChange)="set('plazo_dias', $event ?? 0)" [min]="0" [max]="365" [useGrouping]="false" inputId="af-plazo" />
            </label>
            <label class="af-campo">
              <span>Descuento</span>
              <p-inputnumber name="descuento" [ngModel]="f().descuento_pct" (ngModelChange)="set('descuento_pct', $event ?? 0)" suffix=" %" [min]="0" [max]="100" [maxFractionDigits]="2" inputId="af-descuento" />
            </label>
            <label class="af-campo af-ancho">
              <span>Comentarios</span>
              <textarea pTextarea name="comentarios" rows="2" [ngModel]="f().comentarios" (ngModelChange)="set('comentarios', $event)"></textarea>
            </label>
          </div>
          <p class="af-destino">
            @if (pideCredito()) { <i class="pi pi-hourglass" aria-hidden="true"></i> Al guardar va a <strong>Crédito y Cobranza</strong>; mientras, no se captura en Kepler. }
            @else { <i class="pi pi-check" aria-hidden="true"></i> De contado: al guardar queda <strong>lista para capturar en Kepler</strong>. }
          </p>
        </fieldset>

        <footer class="af-pie">
          @if (confirmarDescarte()) {
            <span class="af-tenue" role="status">¿Descartar lo capturado?</span>
            <button pButton type="button" severity="secondary" [text]="true" (click)="confirmarDescarte.set(false)">Seguir capturando</button>
            <button pButton type="button" severity="danger" [outlined]="true" (click)="cerrar.emit()">Sí, descartar</button>
          } @else {
            <button pButton type="button" severity="secondary" [text]="true" (click)="salir()">Cancelar</button>
            @if (pideConfirmar()) {
              <button pButton type="button" severity="secondary" [outlined]="true" [disabled]="guardando()" (click)="guardar(true)">Es otra ficha: guardar</button>
            }
            <button pButton type="submit" [disabled]="guardando()" [loading]="guardando()">
              <span class="p-button-icon p-button-icon-left pi pi-save" aria-hidden="true"></span>Guardar solicitud
            </button>
          }
        </footer>
      </form>
    }
  `,
  styles: [`
    :host { display: block; }
    .af-oculto { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .af-elegir { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--sp-3); }
    .af-opcion { position: relative; display: flex; flex-direction: column; gap: var(--sp-1); align-items: flex-start; text-align: left;
      padding: var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg);
      color: var(--fg-1); cursor: pointer; font: inherit; }
    .af-opcion:hover { background: var(--hover-bg); }
    .af-opcion:focus-within, .af-opcion:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .af-opcion .pi { font-size: var(--fs-lg); color: var(--action); }
    .af-op-t { font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .af-op-s { font-size: var(--fs-sm); color: var(--fg-2); }
    .af-leyendo { display: flex; gap: var(--sp-2); align-items: center; color: var(--fg-2); }
    .af-forma { display: flex; flex-direction: column; gap: var(--sp-4); }
    .af-grupo { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .af-grupo legend { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); padding: 0; margin-bottom: var(--sp-2); }
    .af-rejilla { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: var(--sp-3) var(--sp-3); }
    .af-sep { margin-top: var(--sp-2); }
    .af-ancho { grid-column: span 2; }
    @media (max-width: 40rem) { .af-ancho { grid-column: auto; } }
    .af-campo { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; font-size: var(--fs-xs); color: var(--fg-2); }
    .af-campo input, .af-campo textarea { width: 100%; }
    .af-geo-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .af-geo-nota { margin: 0; font-size: var(--fs-xs); color: var(--fg-2); }
    .af-sugerencias { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); font-size: var(--fs-xs); margin-top: calc(-1 * var(--sp-1)); }
    .af-campo-cab { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    .af-campo input[readonly] { color: var(--fg-2); }
    .af-mono { font-family: var(--font-mono); letter-spacing: 0.02em; }
    .af-tenue { color: var(--fg-3); font-weight: var(--fw-medium); }
    .af-err { color: var(--bad-fg); font-size: var(--fs-xs); }
    .af-aviso { color: var(--warn-soft-fg); font-size: var(--fs-xs); }
    .af-cuenta { float: right; color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .af-pasa { color: var(--bad-fg); font-weight: var(--fw-bold); }
    .af-banda { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0; padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .af-banda-info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .af-banda-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .af-banda-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .af-avisos { margin: 0; padding-left: var(--sp-4); font-size: var(--fs-sm); color: var(--warn-soft-fg); }
    .af-avisos .af-bloquea { color: var(--bad-fg); }
    .af-dups { margin: var(--sp-1) 0; padding-left: var(--sp-4); }
    .af-destino { margin: 0; font-size: var(--fs-sm); color: var(--fg-2); display: flex; gap: var(--sp-2); align-items: center; }
    .af-pie { display: flex; justify-content: flex-end; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
      border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
    @media (pointer: coarse) { .af-pie button { min-height: 44px; } }
  `],
})
export class AltaClienteFormComponent implements OnInit {
  private readonly svc = inject(AltaClientesService);

  readonly catalogos = input<CatalogosAlta | null>(null);
  /** Sucursal con la que arranca (la primera del alcance de quien captura). */
  readonly branchInicial = input('');
  readonly guardada = output<SolicitudAlta>();
  readonly cerrar = output<void>();
  /** Pide al padre otros catálogos al cambiar de sucursal. */
  readonly sucursal = output<string>();

  readonly tipos: SegOption[] = [{ label: 'Persona física', value: 'fisica' }, { label: 'Persona moral', value: 'moral' }];
  /**
   * `[ALC.3.3]` Sin RFC = el genérico del SAT. Es el caso MAYORITARIO: 15,160 de 22,558 fichas de
   * Kepler (67 %) lo traen (prod, 2026-11-06). El SAT lo valida como persona física y sólo admite
   * el régimen 616 «Sin obligaciones fiscales»; el código postal sigue siendo captura: no tenemos el
   * de cada sucursal y no se inventa.
   */
  readonly modosRfc: SegOption[] = [{ label: 'Con RFC', value: 'con' }, { label: 'Sin RFC', value: 'sin' }];
  readonly REGIMEN_SIN_RFC = REGIMEN_SIN_RFC;
  readonly sinRfc = computed(() => this.f().rfc === RFC_GENERICO);
  readonly domicilio = DOMICILIO;
  readonly contacto = CONTACTO;

  readonly paso = signal<Paso>('elegir');
  readonly f = signal<SolicitudAltaBody>(formaVacia(''));
  readonly lectura = signal<SubirConstanciaRespuesta | null>(null);
  readonly hallazgos = signal<HallazgoAlta[]>([]);
  readonly duplicados = signal<PosibleDuplicado[]>([]);
  readonly pideConfirmar = signal(false);
  readonly guardando = signal(false);
  readonly errorLectura = signal<string | null>(null);
  readonly confirmarDescarte = signal(false);
  /**
   * `[ALC.3.4]` Lo que se sabe del CP: el estado se LLENA (el SAT da uno por CP) mientras la persona no
   * lo haya cambiado; el renglón 2 (colonia, municipio) sólo se SUGIERE, porque un CP tiene varias
   * colonias y no hay catálogo de ellas en el ODS.
   */
  readonly datosCp = signal<CodigoPostalAlta | null>(null);
  readonly estadoAuto = signal('');
  readonly sugerenciasDir2 = computed(() => (this.datosCp()?.sugerencias_direccion_2 ?? []).slice(0, 6));
  private cpConsultado = '';
  private sucio = false;

  readonly sucursales = computed(() => this.catalogos()?.sucursales ?? []);
  readonly pideCredito = computed(() => {
    const x = this.f();
    return Number(x.credito_solicitado) > 0 || Number(x.plazo_dias) > 0 || Number(x.descuento_pct) > 0;
  });
  /** Los regímenes del tipo de persona; los vigentes de la constancia, primero. */
  readonly regimenes = computed(() => {
    const tipo = this.f().tipo_persona;
    const vigentes = new Set(this.lectura()?.regimenes_vigentes ?? []);
    return (this.catalogos()?.regimenes ?? [])
      .filter((r) => (tipo === 'fisica' ? r.persona_fisica : r.persona_moral))
      .map((r) => ({ clave: r.clave, etiqueta: `${r.clave} · ${r.descripcion}${vigentes.has(r.clave) ? ' (de su constancia)' : ''}`, primero: vigentes.has(r.clave) }))
      .sort((a, b) => Number(b.primero) - Number(a.primero) || a.clave.localeCompare(b.clave));
  });
  /** Hallazgos sin casilla propia (constancia, Kepler, sucursal): arriba del formulario. */
  readonly avisosGenerales = computed(() =>
    this.hallazgos().filter((h) => !['rfc', 'curp', 'nombre_fiscal', 'regimen_fiscal', 'codigo_postal_fiscal', 'ubicacion'].includes(h.campo) && !h.campo.startsWith('ficha.')));

  /**
   * `[ALC.3.5]` Ubicación, opcional. Dos maneras: buscar el domicilio capturado (el geocodificador de
   * la Suite, Mapbox: se paga por llamada, por eso es UN clic y no cada tecla) o el GPS del teléfono,
   * para el vendedor parado en la tienda. Un clic en el mapa corrige el punto.
   */
  readonly hayGps = typeof navigator !== 'undefined' && !!navigator.geolocation;
  readonly buscandoUbicacion = signal<'direccion' | 'gps' | null>(null);
  readonly avisoUbicacion = signal<string | null>(null);
  readonly direccionParaBuscar = computed(() => {
    const k = this.f().ficha;
    const calle = (k.direccion_1 ?? '').trim();
    return calle ? [calle, k.direccion_2, k.codigo_postal, k.estado, 'MEXICO'].map((p) => String(p ?? '').trim()).filter(Boolean).join(', ') : '';
  });

  constructor() {
    // Si el diálogo abrió antes de que llegaran los catálogos, la sucursal por defecto se pone al llegar.
    effect(() => {
      const b = this.branchInicial();
      if (b && !untracked(this.f).branch) this.f.update((x) => ({ ...x, branch: b }));
    });
  }

  ngOnInit(): void { this.iniciar(this.branchInicial()); }

  /** Todo limpio, con la sucursal por defecto. */
  iniciar(branch: string): void {
    this.paso.set('elegir');
    this.f.set(formaVacia(branch));
    this.lectura.set(null);
    this.hallazgos.set([]);
    this.duplicados.set([]);
    this.pideConfirmar.set(false);
    this.errorLectura.set(null);
    this.confirmarDescarte.set(false);
    this.guardando.set(false);
    this.datosCp.set(null);
    this.estadoAuto.set('');
    this.buscandoUbicacion.set(null);
    this.avisoUbicacion.set(null);
    this.cpConsultado = '';
    this.sucio = false;
  }

  /** El CP del domicilio (o, si falta, el fiscal) completo → estado y sugerencias. Una consulta por CP. */
  private alCambiarCp(): void {
    const x = this.f();
    const cp = [x.ficha.codigo_postal, x.codigo_postal_fiscal].map((v) => String(v ?? '').trim()).find((v) => /^\d{5}$/.test(v)) ?? '';
    if (!cp || cp === this.cpConsultado) return;
    this.cpConsultado = cp;
    this.svc.codigoPostal(cp).subscribe({
      next: (r) => {
        if (r.codigo_postal !== this.cpConsultado) return; // llegó tarde: ya cambiaron el CP
        this.datosCp.set(r);
        const est = r.estado;
        if (!est) return;
        const actual = this.f().ficha.estado ?? '';
        // Sólo si está vacío o lo puso este mismo llenado: lo que la persona escribió no se pisa.
        if (!actual.trim() || actual === this.estadoAuto()) {
          this.f.update((y) => ({ ...y, ficha: { ...y.ficha, estado: est } }));
          this.estadoAuto.set(est);
        }
      },
      error: () => { this.cpConsultado = ''; /* es ayuda: si falla, se captura a mano */ },
    });
  }
  ubicarPorDireccion(): void {
    const q = this.direccionParaBuscar();
    if (!q) return;
    this.buscandoUbicacion.set('direccion');
    this.avisoUbicacion.set(null);
    this.svc.geocode(q).subscribe({
      next: (r) => {
        this.buscandoUbicacion.set(null);
        const g = r?.results?.[0];
        if (!g) { this.avisoUbicacion.set('No se encontró esa dirección en el mapa: usa tu ubicación o haz clic donde está la tienda.'); return; }
        this.fijarUbicacion({ lat: g.lat, lng: g.lng, origen: 'direccion', precision_m: null });
      },
      error: () => { this.buscandoUbicacion.set(null); this.avisoUbicacion.set('No se pudo buscar la dirección. Intenta otra vez o usa tu ubicación.'); },
    });
  }
  usarMiUbicacion(): void {
    if (!this.hayGps) return;
    this.buscandoUbicacion.set('gps');
    this.avisoUbicacion.set(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.buscandoUbicacion.set(null);
        this.fijarUbicacion({ lat: p.coords.latitude, lng: p.coords.longitude, origen: 'gps', precision_m: Math.round(p.coords.accuracy * 10) / 10 });
        if (p.coords.accuracy > 100) this.avisoUbicacion.set(`El GPS sólo dio ±${Math.round(p.coords.accuracy)} m: revisa el punto en el mapa.`);
      },
      (e) => {
        this.buscandoUbicacion.set(null);
        this.avisoUbicacion.set(e.code === 1 ? 'El navegador no dio permiso de ubicación: actívalo o busca por la dirección.' : 'El dispositivo no dio la ubicación. Intenta otra vez o busca por la dirección.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }
  /** Un clic en el mapa: la persona corrige el punto. */
  moverPunto(p: { lat: number; lng: number }): void {
    this.fijarUbicacion({ lat: p.lat, lng: p.lng, origen: 'mapa', precision_m: null });
  }
  quitarUbicacion(): void {
    this.sucio = true;
    this.avisoUbicacion.set(null);
    this.f.update((x) => ({ ...x, ubicacion: null }));
  }
  private fijarUbicacion(u: UbicacionAlta): void {
    this.sucio = true;
    const r6 = (n: number) => Math.round(n * 1e6) / 1e6; // la columna guarda 6 decimales (~10 cm)
    this.f.update((x) => ({ ...x, ubicacion: { ...u, lat: r6(u.lat), lng: r6(u.lng) } }));
  }
  usarSugerencia(texto: string): void {
    this.setFicha('direccion_2', texto.slice(0, this.limite('direccion_2')));
  }

  rotulo(c: CasillaKepler): string { return CASILLAS_KEPLER[c].rotulo; }
  limite(c: CasillaKepler): number { return CASILLAS_KEPLER[c].largo; }
  largo(c: CasillaKepler): number { return (this.f().ficha[c] ?? '').length; }
  error(campo: string): string | null { return this.hallazgos().find((h) => h.campo === campo)?.mensaje ?? null; }
  esBloqueo(campo: string): boolean { return this.hallazgos().some((h) => h.campo === campo && h.gravedad === 'bloquea'); }
  sucursalesDe(d: PosibleDuplicado): string {
    return d.sucursales.length >= 9 ? 'en las 9 sucursales' : d.sucursales.map((s) => warehouseName(s)).join(', ');
  }
  fechaLarga(iso: string): string {
    return new Date(`${iso}T12:00:00`).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // ── edición ──────────────────────────────────────────────────────────────────────────────
  set<K extends keyof SolicitudAltaBody>(k: K, v: SolicitudAltaBody[K]): void {
    this.sucio = true;
    this.f.update((x) => ({ ...x, [k]: v }));
  }
  setFicha(c: CasillaKepler, v: string): void {
    this.sucio = true;
    this.f.update((x) => ({ ...x, ficha: { ...x.ficha, [c]: String(v ?? '').toUpperCase() } }));
    if (c === 'codigo_postal') this.alCambiarCp();
  }
  /** RFC, CURP y CP de la ficha de Kepler siguen a los fiscales: son el mismo dato. */
  setRfc(v: string): void {
    const rfc = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
    this.sucio = true;
    this.f.update((x) => ({ ...x, rfc, tipo_persona: rfc.length === 12 ? 'moral' : rfc.length === 13 ? 'fisica' : x.tipo_persona, ficha: { ...x.ficha, rfc } }));
    // Teclear el genérico es lo mismo que elegir «Sin RFC».
    if (rfc === RFC_GENERICO) this.f.update((x) => this.fijarSinRfc(x));
  }
  /** Lo que «Sin RFC» deja fijo además del RFC. */
  private fijarSinRfc(x: SolicitudAltaBody): SolicitudAltaBody {
    const hay616 = (this.catalogos()?.regimenes ?? []).some((r) => r.clave === REGIMEN_SIN_RFC && r.persona_fisica);
    return { ...x, rfc: RFC_GENERICO, tipo_persona: 'fisica', regimen_capital: null, regimen_fiscal: hay616 ? REGIMEN_SIN_RFC : x.regimen_fiscal,
      ficha: { ...x.ficha, rfc: RFC_GENERICO } };
  }
  setCurp(v: string): void {
    const curp = String(v ?? '').toUpperCase().replace(/\s/g, '');
    this.sucio = true;
    this.f.update((x) => ({ ...x, curp, ficha: { ...x.ficha, curp } }));
  }
  setNombre(v: string): void {
    const nombre = String(v ?? '').toUpperCase();
    this.sucio = true;
    // La ficha sigue al nombre fiscal mientras nadie la haya cambiado a mano.
    this.f.update((x) => ({ ...x, nombre_fiscal: nombre, ficha: { ...x.ficha, nombre: x.ficha.nombre === x.nombre_fiscal ? nombre : x.ficha.nombre } }));
  }
  setCp(v: string): void {
    const cp = String(v ?? '').replace(/\D/g, '').slice(0, 5);
    this.sucio = true;
    this.f.update((x) => ({ ...x, codigo_postal_fiscal: cp, ficha: { ...x.ficha, codigo_postal: x.ficha.codigo_postal === x.codigo_postal_fiscal ? cp : x.ficha.codigo_postal } }));
    this.alCambiarCp();
  }
  /** Con RFC ↔ sin RFC: el genérico llena RFC, tipo y régimen; al volver, se vacían para capturarlos. */
  modoRfc(v: string): void {
    this.sucio = true;
    const sin = v === 'sin';
    if (sin === this.sinRfc()) return;
    this.f.update((x) => sin
      ? this.fijarSinRfc(x)
      : { ...x, rfc: '', regimen_fiscal: x.regimen_fiscal === REGIMEN_SIN_RFC ? '' : x.regimen_fiscal, ficha: { ...x.ficha, rfc: '' } });
    this.revisar();
  }
  tipo(v: string): void {
    const t: TipoPersona = v === 'moral' ? 'moral' : 'fisica';
    this.f.update((x) => ({ ...x, tipo_persona: t, curp: t === 'moral' ? '' : x.curp, ficha: { ...x.ficha, curp: t === 'moral' ? '' : x.ficha.curp } }));
  }
  cambiarSucursal(branch: string): void {
    this.f.update((x) => ({ ...x, branch, vendedor_code: null, grupo_code: null, zona_code: null }));
    this.sucursal.emit(branch);
  }

  // ── constancia ───────────────────────────────────────────────────────────────────────────
  aMano(): void {
    this.paso.set('forma');
  }

  elegirPdf(ev: Event): void {
    const archivo = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!archivo) return;
    if (archivo.size > 5 * 1024 * 1024) { this.errorLectura.set('El archivo pesa más de 5 MB: la constancia del SAT pesa alrededor de 140 KB.'); return; }
    this.errorLectura.set(null);
    this.paso.set('leyendo');
    const lector = new FileReader();
    lector.onload = () => this.leer(String(lector.result ?? ''));
    lector.onerror = () => { this.paso.set('elegir'); this.errorLectura.set('No se pudo abrir el archivo.'); };
    lector.readAsDataURL(archivo);
  }

  private leer(dataUri: string): void {
    this.svc.subirConstancia(dataUri, this.f().branch).subscribe({
      next: (r) => {
        if (!r.lectura.ok) {
          this.paso.set('elegir');
          this.errorLectura.set(`${r.lectura.detalle} Puedes capturarlo a mano.`);
          return;
        }
        const c = r.lectura.constancia;
        this.lectura.set(r);
        this.f.update((x) => ({
          ...x, origen: 'constancia', constancia_key: r.constancia_key, tipo_persona: c.tipo, rfc: c.rfc, curp: c.curp ?? '',
          nombre_fiscal: c.nombre_fiscal, regimen_capital: c.regimen_capital, nombre_comercial: c.nombre_comercial,
          regimen_fiscal: r.regimen_sugerido ?? '', codigo_postal_fiscal: c.domicilio.codigo_postal ?? '',
          ficha: r.armado ? { ...r.armado.ficha } : x.ficha,
        }));
        this.hallazgos.set(r.hallazgos);
        this.duplicados.set(r.duplicados);
        this.sucio = true;
        this.paso.set('forma');
        this.alCambiarCp(); // el estado ya viene de la constancia y no se pisa; quedan las sugerencias
      },
      error: (e: HttpErrorResponse) => { this.paso.set('elegir'); this.errorLectura.set(this.mensaje(e, 'No se pudo leer la constancia.')); },
    });
  }

  // ── revisar y guardar ────────────────────────────────────────────────────────────────────
  revisar(): void {
    const x = this.f();
    if (!x.rfc && !x.nombre_fiscal) return;
    this.svc.revisar(x).subscribe({
      next: (r: RevisionAlta) => { this.hallazgos.set(r.hallazgos); this.duplicados.set(r.duplicados); },
      error: () => { /* la revisión al salir de la casilla es ayuda; el guardar vuelve a revisar */ },
    });
  }

  guardar(confirmarDuplicado = false): void {
    if (this.guardando()) return;
    this.guardando.set(true); // idempotencia visual: síncrono, antes de esperar al servidor
    this.svc.crear({ ...this.f(), confirmar_duplicado: confirmarDuplicado }).subscribe({
      next: (r) => { this.guardando.set(false); this.sucio = false; this.guardada.emit(r.solicitud); },
      error: (e: HttpErrorResponse) => {
        this.guardando.set(false);
        const rev = (e.error?.revision ?? null) as RevisionAlta | null;
        if (rev) { this.hallazgos.set(rev.hallazgos); this.duplicados.set(rev.duplicados); }
        this.pideConfirmar.set(e.status === 409 && !!rev?.duplicados?.some((d) => d.por === 'rfc'));
        if (!rev) this.hallazgos.set([{ campo: 'guardar', gravedad: 'bloquea', mensaje: this.mensaje(e, 'No se pudo guardar la solicitud.') }]);
        else if (e.status !== 409 || !this.pideConfirmar()) this.hallazgos.update((h) => [{ campo: 'guardar', gravedad: 'bloquea', mensaje: this.mensaje(e, 'Revisa lo marcado.') }, ...h]);
      },
    });
  }

  /** Estado sucio: con algo capturado, cancelar pregunta antes de descartar. */
  salir(): void {
    if (this.sucio) this.confirmarDescarte.set(true);
    else this.cerrar.emit();
  }

  private mensaje(e: HttpErrorResponse, defecto: string): string {
    const m = e?.error?.message;
    return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' ') : defecto;
  }
}
