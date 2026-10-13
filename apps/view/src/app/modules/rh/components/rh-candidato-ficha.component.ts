import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import {
  HR_ESTILOS_LIDERAZGO, hrResultadoLiderazgo, type HrAptitudesEvalGuardada,
  type HrCandidatoEdicion, type HrCandidatoFichaDto, type HrCasilleroDto, type HrDocumentoDto, type HrLigaCreadaDto, type HrTalentCanal,
  type HrTalentEtapa, type HrTalentTipoEvento,
} from '@megadulces/contracts';
import { ReclutamientoService } from '../reclutamiento.service';
import { rhError } from '../rh.service';
import {
  CANALES, ETAPAS, ETAPAS_DEL_FLUJO, MAX_DOCUMENTO_BYTES, TIPOS_EVENTO, etapaLabel, fechaHoraMx, fechaMx, leerComoDataUri,
  siguienteEtapa, telefono,
} from '../reclutamiento-formato';

/** Un renglón de la historia: los eventos y los cambios de etapa, juntos y en orden. */
export interface RenglonHistoria { cuando: string; texto: string; quien: string | null; tipo: 'etapa' | 'evento'; detalle: string | null; deOtroRegistro: boolean }

/** Junta eventos y pasos de etapa en una sola línea de tiempo, del más reciente al más viejo. */
export function historiaDe(f: HrCandidatoFichaDto): RenglonHistoria[] {
  const pasos: RenglonHistoria[] = f.transiciones.map((t) => ({
    cuando: t.changed_at, tipo: 'etapa', quien: t.changed_by_name,
    texto: `${etapaLabel(t.stage_from)} → ${etapaLabel(t.stage_to)}`,
    detalle: t.hours_in_from != null ? `${Math.round(t.hours_in_from * 10) / 10} h en la etapa anterior` : null,
    deOtroRegistro: t.candidate_id !== f.id,
  }));
  const eventos: RenglonHistoria[] = f.eventos.map((e) => ({
    cuando: e.occurred_at, tipo: 'evento', quien: e.actor_name,
    texto: TIPOS_EVENTO.find((x) => x.value === e.event_type)?.label ?? e.event_type,
    detalle: [CANALES.find((c) => c.value === e.channel)?.label ?? e.channel, e.note].filter(Boolean).join(' · ') || null,
    deOtroRegistro: e.candidate_id !== f.id,
  }));
  return [...pasos, ...eventos].sort((a, b) => (a.cuando < b.cuando ? 1 : a.cuando > b.cuando ? -1 : 0));
}

/** El expediente por casillero: lo vigente de cada uno, si falta, y lo que no cae en ningún casillero. */
export function expedienteDe(docs: HrDocumentoDto[], casilleros: HrCasilleroDto[], faltantes: string[]):
  { filas: Array<{ casillero: HrCasilleroDto; docs: HrDocumentoDto[]; falta: boolean }>; otros: HrDocumentoDto[]; retirados: HrDocumentoDto[] } {
  const vigentes = docs.filter((d) => d.vigente);
  const conocidos = new Set(casilleros.map((c) => c.key));
  return {
    filas: casilleros.map((c) => ({ casillero: c, docs: vigentes.filter((d) => d.slot === c.key), falta: faltantes.includes(c.key) })),
    otros: vigentes.filter((d) => !d.slot || !conocidos.has(d.slot)),
    retirados: docs.filter((d) => !d.vigente),
  };
}

type Accion = null | 'no_rehire' | 'spam' | 'papelera' | 'retirar' | 'fusionar' | 'editar';

/**
 * Fase RH · `[RH.2.3]` — la FICHA de un candidato, dentro del panel lateral de Candidatos. Todo lo que RH hace con
 * una persona sale de aquí: mover de etapa, registrar un contacto, marcarla, mandarla a la papelera, completar
 * su expediente y fusionar registros duplicados.
 *
 * Reglas que se ven en pantalla porque el servidor las exige: la lista negra pide motivo; retirar un documento
 * pide motivo y no lo borra; fusionar sólo rellena lo que falta (nunca pisa un dato).
 */
@Component({
  selector: 'app-rh-candidato-ficha',
  standalone: true,
  imports: [FormsModule, SelectModule, InputTextModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let f = ficha();
    <div class="cf">
      <div class="cf-marcas">
        <span class="pill" data-t="etapa">{{ etapaLabel(f.stage) }}</span>
        @if (f.no_rehire) { <span class="pill" data-t="mal" title="{{ f.no_rehire_reason }}">No recontratable</span> }
        @if (f.is_spam) { <span class="pill" data-t="aviso">Spam</span> }
        @if (f.deleted_at) { <span class="pill" data-t="gris">En la papelera</span> }
        @if (!f.has_cv) { <span class="pill" data-t="aviso">Sin CV</span> }
      </div>

      @if (aviso(); as a) { <p class="cf-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }

      @if (f.no_rehire) {
        <p class="cf-alerta" role="note"><b>No vuelve a entrar.</b> {{ f.no_rehire_reason }}
          <small>— {{ f.no_rehire_by_name || 'RH' }}, {{ fechaMx(f.no_rehire_at) }}</small></p>
      }
      @if (f.mismo_telefono.length) {
        <section class="cf-sec" aria-label="Otros registros con el mismo teléfono">
          <h3>Mismo teléfono</h3>
          <p class="cf-nota">Puede ser la misma persona registrada dos veces (el bot y el portal la abren por separado).</p>
          <ul class="cf-lista">
            @for (m of f.mismo_telefono; track m.id) {
              <li>
                <span>{{ m.full_name || 'Sin nombre' }} <small>· alta {{ fechaMx(m.created_at) }}</small>
                  @if (m.no_rehire) { <span class="pill" data-t="mal">No recontratable</span> }</span>
                @if (gestiona() && !f.deleted_at) {
                  @if (accion() === 'fusionar' && objetivo() === m.id) {
                    <span class="cf-confirma">¿Fusionar en esta ficha? Sólo se rellenan los datos que aquí faltan.
                      <p-button label="Sí, fusionar" size="small" [loading]="ocupado()" (onClick)="fusionar(m.id)" />
                      <p-button label="No" size="small" [text]="true" severity="secondary" (onClick)="cerrarAccion()" /></span>
                  } @else {
                    <p-button label="Fusionar aquí" size="small" [text]="true" (onClick)="abrirAccion('fusionar', m.id)" />
                  }
                }
              </li>
            }
          </ul>
        </section>
      }

      <section class="cf-sec" aria-label="Etapa">
        <h3>Etapa</h3>
        <ol class="cf-pasos">
          @for (e of flujo; track e.id; let i = $index) {
            <li [attr.data-estado]="estadoPaso(e.id)">{{ i + 1 }}. {{ e.corto }}</li>
          }
        </ol>
        @if (gestiona() && !f.deleted_at) {
          <div class="cf-fila">
            @if (siguiente(); as s) {
              <p-button [label]="'Pasar a ' + etapaLabel(s)" size="small" [loading]="ocupado()" (onClick)="mover(s)" />
            }
            <p-select [options]="opcionesEtapa()" optionLabel="label" optionValue="id" [ngModel]="etapaElegida()" (ngModelChange)="etapaElegida.set($event)"
                      placeholder="Otra etapa…" appendTo="body" ariaLabel="Mover a otra etapa" />
            <p-button label="Mover" size="small" severity="secondary" [outlined]="true" [disabled]="!etapaElegida()" [loading]="ocupado()"
                      (onClick)="mover(etapaElegida()!)" />
          </div>
        }
      </section>

      <section class="cf-sec" aria-label="Datos">
        <div class="cf-sec-head">
          <h3>Datos</h3>
          @if (gestiona() && !f.deleted_at && accion() !== 'editar') { <p-button label="Corregir" size="small" [text]="true" (onClick)="abrirEdicion()" /> }
        </div>
        @if (accion() === 'editar') {
          <form class="cf-form" (ngSubmit)="guardarEdicion()" aria-label="Corregir datos">
            <label>Nombre <input pInputText name="n" [(ngModel)]="edicion.full_name" /></label>
            <label>Teléfono <input pInputText name="t" [(ngModel)]="edicion.phone" /></label>
            <label>Correo <input pInputText name="c" [(ngModel)]="edicion.email" /></label>
            <label>Plaza <input pInputText name="p" [(ngModel)]="edicion.city_branch" /></label>
            <label>Puesto que busca <input pInputText name="pu" [(ngModel)]="edicion.position_interest" /></label>
            <div class="cf-fila">
              <p-button type="submit" label="Guardar" size="small" [loading]="ocupado()" />
              <p-button label="Cancelar" size="small" [text]="true" severity="secondary" (onClick)="cerrarAccion()" />
            </div>
          </form>
        } @else {
          <dl class="cf-datos">
            <dt>Teléfono</dt><dd class="mono">{{ telefono(f.phone) }}</dd>
            <dt>Correo</dt><dd>{{ f.email || '—' }}</dd>
            <dt>Plaza</dt><dd>{{ f.city_branch || '—' }}</dd>
            <dt>Puesto que busca</dt><dd>{{ f.position_interest || '—' }}</dd>
            <dt>Se enteró por</dt><dd>{{ f.source || '—' }}</dd>
            <dt>Entró por</dt><dd>{{ f.origin === 'web' ? 'La página web' : f.origin === 'whatsapp' ? 'WhatsApp' : (f.origin || '—') }}</dd>
            <dt>Alta</dt><dd>{{ fechaHoraMx(f.created_at) }}</dd>
            <dt>Tiempo de traslado</dt><dd>{{ f.commute_time || '—' }}</dd>
            <dt>Disponibilidad</dt><dd>{{ f.availability || '—' }}</dd>
            <dt>Empresa anterior</dt><dd>{{ f.previous_employer || '—' }}</dd>
            <dt>Sueldo que pide</dt><dd>{{ f.desired_salary || '—' }}</dd>
            <dt>RFC</dt><dd class="mono">{{ f.rfc || '—' }}</dd>
            <dt>NSS</dt><dd class="mono">{{ f.nss || '—' }}</dd>
            <dt>Familiar en la empresa</dt><dd>{{ f.relative_in_company || '—' }}</dd>
            <dt>¿Ya trabajó aquí?</dt><dd>{{ f.rehire_note || '—' }}</dd>
          </dl>
        }
      </section>

      <section class="cf-sec" aria-label="Expediente">
        <h3>Expediente</h3>
        @if (f.documentos_faltantes.length) {
          <p class="cf-nota">Faltan {{ f.documentos_faltantes.length }} documento(s) obligatorio(s).</p>
        }
        <ul class="cf-lista cf-exp">
          @for (r of expediente().filas; track r.casillero.key) {
            <li [class.falta]="r.falta">
              <span>{{ r.casillero.label }}@if (r.falta) { <small> · falta</small> }@if (!r.casillero.obligatorio && !r.docs.length) { <small> · opcional</small> }</span>
              <span class="cf-docs">
                @for (d of r.docs; track d.llave) {
                  @if (d.url) { <a [href]="d.url" target="_blank" rel="noopener">{{ d.file_name || 'Ver' }}</a> } @else { <span>{{ d.file_name || 'sin archivo' }}</span> }
                  @if (gestiona() && !f.deleted_at) { <button type="button" class="cf-x" (click)="abrirAccion('retirar', d.llave)" [attr.aria-label]="'Retirar ' + (d.file_name || 'documento')">Retirar</button> }
                }
              </span>
            </li>
          }
          @for (d of expediente().otros; track d.llave) {
            <li><span>Otro documento</span><span class="cf-docs">
              @if (d.url) { <a [href]="d.url" target="_blank" rel="noopener">{{ d.file_name || 'Ver' }}</a> } @else { <span>{{ d.file_name || 'sin archivo' }}</span> }
              @if (gestiona() && !f.deleted_at) { <button type="button" class="cf-x" (click)="abrirAccion('retirar', d.llave)">Retirar</button> }
            </span></li>
          }
        </ul>
        @if (accion() === 'retirar') {
          <div class="cf-form" role="group" aria-label="Retirar documento">
            <label>¿Por qué se retira? <input pInputText [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Ilegible, de otra persona, equivocado…" /></label>
            <div class="cf-fila">
              <p-button label="Retirar documento" size="small" severity="danger" [disabled]="motivo().trim().length < 3" [loading]="ocupado()" (onClick)="retirar()" />
              <p-button label="Cancelar" size="small" [text]="true" severity="secondary" (onClick)="cerrarAccion()" />
            </div>
          </div>
        }
        @if (gestiona() && !f.deleted_at) {
          <div class="cf-fila cf-subir">
            <p-select [options]="opcionesCasillero()" optionLabel="label" optionValue="key" [ngModel]="casillero()" (ngModelChange)="casillero.set($event)"
                      placeholder="¿Qué documento es?" appendTo="body" ariaLabel="Casillero del documento" />
            <label class="cf-archivo">
              <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic" (change)="subir($event)" [disabled]="!casillero() || ocupado()" />
              <span>{{ ocupado() ? 'Subiendo…' : 'Subir archivo' }}</span>
            </label>
            <small class="cf-nota">PDF o imagen, hasta 10 MB.</small>
          </div>
        }
        @if (gestiona() && !f.deleted_at) {
          <div class="cf-liga" role="group" aria-label="Liga para que suba su CV">
            @if (liga(); as l) {
              <p class="cf-nota">Liga lista (vence {{ fechaMx(l.expires_at) }}). Es personal: sólo sirve para subir el CV de esta persona.</p>
              <input class="cf-liga-url" readonly [value]="l.url" aria-label="Liga para subir el CV" />
              <div class="cf-fila">
                @if (l.whatsapp_url) { <a class="cf-wa" [href]="l.whatsapp_url" target="_blank" rel="noopener">Mandar por WhatsApp</a> }
                <p-button label="Copiar" size="small" severity="secondary" [outlined]="true" (onClick)="copiarLiga(l)" />
              </div>
            } @else {
              <p-button label="Mandar liga para subir su CV" size="small" severity="secondary" [outlined]="true" [loading]="ocupado()" (onClick)="pedirLiga('cv')" />
            }
          </div>
        }
        @if (expediente().retirados.length) {
          <details class="cf-ret"><summary>{{ expediente().retirados.length }} retirado(s)</summary>
            <ul class="cf-lista">
              @for (d of expediente().retirados; track d.llave) {
                <li><span>{{ d.file_name || d.slot }}</span><small>{{ d.retire_reason }} — {{ d.retired_by_name || 'RH' }}, {{ fechaMx(d.retired_at) }}</small></li>
              }
            </ul>
          </details>
        }
      </section>

      <section class="cf-sec" aria-label="Cuestionario de liderazgo">
        <h3>Cuestionario de liderazgo</h3>
        @let l = liderazgo();
        @if (!l.contestadas) {
          <p class="cf-nota">No lo ha contestado.</p>
        } @else if (l.contestadas < l.total) {
          <p class="cf-nota">Lleva {{ l.contestadas }} de {{ l.total }} preguntas.@if (contestandoAhora()) { <b> Contestando ahora.</b>}</p>
        } @else {
          <p><b class="mono">{{ l.porcentaje }}%</b> · {{ l.interpretacion }}</p>
          <p class="cf-nota">{{ estiloNombre(l.estilo) }} · tarea {{ l.puntajeTarea }}/30 · relaciones {{ l.puntajeRelaciones }}/30
            @if (l.porcentaje >= 66) { · <span class="pill" data-t="etapa">califica</span> } @else { · no llega al 66% }</p>
        }
        @if (gestiona() && !f.deleted_at && l.contestadas < l.total) {
          @if (ligaLiderazgo(); as ll) {
            <input class="cf-liga-url" readonly [value]="ll.url" aria-label="Liga del cuestionario" />
            <div class="cf-fila">
              @if (ll.whatsapp_url) { <a class="cf-wa" [href]="ll.whatsapp_url" target="_blank" rel="noopener">Mandar por WhatsApp</a> }
              <p-button label="Copiar" size="small" severity="secondary" [outlined]="true" (onClick)="copiarLiga(ll)" />
            </div>
          } @else {
            <p-button label="Mandar liga del cuestionario" size="small" severity="secondary" [outlined]="true" [loading]="ocupado()" (onClick)="pedirLiga('liderazgo')" />
          }
        }
      </section>

      <section class="cf-sec" aria-label="Evaluación de aptitudes">
        <h3>Evaluación de aptitudes</h3>
        @if (aptitudes(); as a) {
          <p><b class="mono">{{ a.puntaje }}/{{ a.max }}</b> · {{ a.pct }}% · {{ a.banda }}
            @if (a.aprobado) { · <span class="pill" data-t="etapa">aprobado</span> }</p>
          <p class="cf-nota">Evaluó {{ a.evaluador }}@if (a.cargoEvaluador) { ({{ a.cargoEvaluador }})}@if (a.tiempo) { · {{ a.tiempo }}} · {{ fechaHoraMx(a.completadaEn) }}</p>
          @if (a.observaciones) { <p class="cf-nota">{{ a.observaciones }}</p> }
        } @else {
          <p class="cf-nota">El jefe que lo entrevista todavía no la llena.</p>
        }
        @if (gestiona() && !f.deleted_at) {
          @if (ligaAptitudes(); as la) {
            <p class="cf-nota">Mándasela al jefe que hará la entrevista (no al candidato).</p>
            <input class="cf-liga-url" readonly [value]="la.url" aria-label="Liga de la evaluación de aptitudes" />
            <div class="cf-fila">
              @if (la.whatsapp_url) { <a class="cf-wa" [href]="la.whatsapp_url" target="_blank" rel="noopener">Mandar por WhatsApp</a> }
              <p-button label="Copiar" size="small" severity="secondary" [outlined]="true" (onClick)="copiarLiga(la)" />
            </div>
          } @else {
            <p-button label="Liga para el jefe que entrevista" size="small" severity="secondary" [outlined]="true" [loading]="ocupado()" (onClick)="pedirLiga('aptitudes')" />
          }
        }
      </section>

      @if (gestiona() && !f.deleted_at) {
        <section class="cf-sec" aria-label="Registrar">
          <h3>Registrar</h3>
          <form class="cf-form cf-evento" (ngSubmit)="registrar()" aria-label="Registrar contacto, entrevista o nota">
            <p-select [options]="tipos" optionLabel="label" optionValue="value" name="tipo" [(ngModel)]="nuevoEvento.event_type" appendTo="body" ariaLabel="Qué pasó" />
            <p-select [options]="canales" optionLabel="label" optionValue="value" name="canal" [(ngModel)]="nuevoEvento.channel" [showClear]="true"
                      placeholder="Por dónde" appendTo="body" ariaLabel="Canal" />
            <input pInputText name="nota" [(ngModel)]="nuevoEvento.note" placeholder="Nota (obligatoria si es una nota)" aria-label="Nota" />
            <p-button type="submit" label="Registrar" size="small" [loading]="ocupado()" />
          </form>
        </section>
      }

      <section class="cf-sec" aria-label="Historia">
        <h3>Historia</h3>
        @if (!historia().length) { <p class="cf-nota">Sin movimientos todavía.</p> }
        <ol class="cf-historia">
          @for (h of historia(); track $index) {
            <li [attr.data-t]="h.tipo">
              <span class="cf-cuando mono">{{ fechaHoraMx(h.cuando) }}</span>
              <span><b>{{ h.texto }}</b>@if (h.detalle) { <span> · {{ h.detalle }}</span> }
                <small> — {{ h.quien || 'sin dato' }}@if (h.deOtroRegistro) { · del registro fusionado }</small></span>
            </li>
          }
        </ol>
      </section>

      @if (gestiona()) {
        <section class="cf-sec cf-acciones" aria-label="Acciones">
          @if (f.deleted_at) {
            <p class="cf-nota">En la papelera desde {{ fechaMx(f.deleted_at) }}@if (f.deletion_reason === 'fusionado') { (fusionado con otro registro)}.
              @if (f.deletion_reason === 'fusionado') { Restaurarlo lo vuelve su propio registro; lo que ya se copió al otro se queda allá. }</p>
            <p-button label="Restaurar" size="small" [loading]="ocupado()" (onClick)="restaurar()" />
          } @else if (accion() === 'no_rehire' || accion() === 'spam') {
            <div class="cf-form" role="group" [attr.aria-label]="accion() === 'spam' ? 'Spam' : 'No recontratable'">
              <label>{{ textoMotivo() }} <input pInputText [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" /></label>
              <div class="cf-fila">
                <p-button [label]="textoConfirmar()" size="small" [severity]="marcando() ? 'danger' : 'secondary'"
                          [disabled]="marcando() && accion() === 'no_rehire' && motivo().trim().length < 3" [loading]="ocupado()" (onClick)="marcar()" />
                <p-button label="Cancelar" size="small" [text]="true" severity="secondary" (onClick)="cerrarAccion()" />
              </div>
            </div>
          } @else if (accion() === 'papelera') {
            <div class="cf-fila" role="group" aria-label="Mandar a la papelera">
              <p-button label="Cerrar seguimiento" size="small" severity="secondary" [loading]="ocupado()" (onClick)="papelera('cierre_seguimiento')" />
              <p-button label="Mandar a la papelera" size="small" severity="secondary" [outlined]="true" [loading]="ocupado()" (onClick)="papelera('manual')" />
              <p-button label="Cancelar" size="small" [text]="true" severity="secondary" (onClick)="cerrarAccion()" />
            </div>
          } @else {
            <div class="cf-fila">
              <p-button [label]="f.no_rehire ? 'Quitar no recontratable' : 'No recontratable'" size="small" severity="secondary" [outlined]="true" (onClick)="abrirAccion('no_rehire')" />
              <p-button [label]="f.is_spam ? 'Sacar de spam' : 'Spam'" size="small" severity="secondary" [outlined]="true" (onClick)="abrirAccion('spam')" />
              <p-button label="Papelera" size="small" severity="secondary" [text]="true" (onClick)="abrirAccion('papelera')" />
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cf { display: flex; flex-direction: column; gap: var(--sp-3); font-size: var(--fs-sm); color: var(--text-main); }
    .cf-marcas { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='etapa'] { background: var(--info-soft-bg); color: var(--info-soft-fg); font-weight: 600; }
    .pill[data-t='mal'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill[data-t='aviso'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .cf-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .cf-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .cf-alerta { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .cf-alerta small { display: block; opacity: .85; }
    .cf-sec { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .cf-sec h3 { margin: 0; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cf-sec-head { display: flex; justify-content: space-between; align-items: center; }
    .cf-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .cf-fila { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .cf-pasos { margin: 0; padding: 0; list-style: none; display: flex; gap: var(--sp-1); flex-wrap: wrap; }
    .cf-pasos li { padding: 2px var(--sp-2); border-radius: var(--r-sm); font-size: var(--fs-xs); background: var(--surface-2); color: var(--text-muted); }
    .cf-pasos li[data-estado='hecho'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .cf-pasos li[data-estado='actual'] { background: var(--info-soft-bg); color: var(--info-soft-fg); font-weight: 700; }
    .cf-datos { margin: 0; display: grid; grid-template-columns: minmax(9rem, max-content) 1fr; gap: var(--sp-1) var(--sp-3); }
    .cf-datos dt { color: var(--text-muted); font-size: var(--fs-xs); }
    .cf-datos dd { margin: 0; overflow-wrap: anywhere; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cf-lista { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); }
    .cf-lista li { display: flex; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .cf-lista small { color: var(--text-muted); font-size: var(--fs-xs); }
    .cf-exp li.falta > span:first-child { color: var(--bad-soft-fg); }
    .cf-docs { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .cf-docs a { color: var(--action); }
    .cf-x { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-xs); color: var(--text-muted); cursor: pointer; text-decoration: underline; }
    .cf-x:focus-visible { outline: 2px solid var(--focus-ring); }
    .cf-archivo { position: relative; display: inline-flex; align-items: center; padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); cursor: pointer; font-size: var(--fs-xs); }
    .cf-archivo input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .cf-archivo:focus-within { outline: 2px solid var(--focus-ring); }
    .cf-ret summary { cursor: pointer; font-size: var(--fs-xs); color: var(--text-muted); }
    .cf-liga { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-sm); }
    .cf-liga-url { font-family: var(--font-mono); font-size: var(--fs-xs); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--surface-2); color: var(--text-main); width: 100%; }
    .cf-wa { color: var(--action); font-weight: 600; }
    .cf-form { display: flex; flex-direction: column; gap: var(--sp-2); }
    .cf-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .cf-evento { flex-direction: row; flex-wrap: wrap; align-items: center; }
    .cf-evento input { flex: 1 1 14rem; }
    .cf-confirma { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; font-size: var(--fs-xs); }
    .cf-historia { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); }
    .cf-historia li { display: grid; grid-template-columns: 7.5rem 1fr; gap: var(--sp-2); }
    .cf-historia small { color: var(--text-muted); }
    .cf-cuando { color: var(--text-muted); font-size: var(--fs-xs); }
    .cf-acciones { padding-bottom: var(--sp-2); }
    @media (max-width: 30rem) {
      .cf-datos { grid-template-columns: 1fr; }
      .cf-historia li { grid-template-columns: 1fr; }
    }
  `],
})
export class RhCandidatoFichaComponent {
  private readonly api = inject(ReclutamientoService);

  readonly ficha = input.required<HrCandidatoFichaDto>();
  readonly casilleros = input<HrCasilleroDto[]>([]);
  readonly gestiona = input(false);
  /** La ficha cambió (devuelve la nueva). */
  readonly actualizada = output<HrCandidatoFichaDto>();
  /** Se fusionó otro registro en éste: la lista de afuera tiene que recargarse. */
  readonly fusionado = output<string>();

  readonly flujo = ETAPAS_DEL_FLUJO;
  readonly tipos = [...TIPOS_EVENTO];
  readonly canales = [...CANALES];
  readonly etapaLabel = etapaLabel;
  readonly fechaMx = fechaMx;
  readonly fechaHoraMx = fechaHoraMx;
  readonly telefono = telefono;

  readonly ocupado = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly accion = signal<Accion>(null);
  readonly objetivo = signal<string | null>(null);
  readonly motivo = signal('');
  readonly etapaElegida = signal<HrTalentEtapa | null>(null);
  readonly casillero = signal<string | null>(null);
  readonly liga = signal<HrLigaCreadaDto | null>(null);
  readonly ligaLiderazgo = signal<HrLigaCreadaDto | null>(null);
  readonly ligaAptitudes = signal<HrLigaCreadaDto | null>(null);
  /** La evaluación del jefe, como quedó guardada (`aptitude_eval`). */
  readonly aptitudes = computed(() => {
    const a = this.ficha().aptitude_eval as Partial<HrAptitudesEvalGuardada> | null;
    return a && typeof a.pct === 'number' ? (a as HrAptitudesEvalGuardada) : null;
  });
  /** El resultado del cuestionario, calculado con el mismo código que usa el servidor para decidir. */
  readonly liderazgo = computed(() => hrResultadoLiderazgo(
    (this.ficha().portal_data?.['cuestionarioLiderazgo'] ?? null) as Record<number, number> | null));
  /** ¿Lo está contestando ahora? (respondió hace menos de 30 s, como en Mega Talento). */
  readonly contestandoAhora = computed(() => {
    const t = this.ficha().portal_data?.['ultimaActividadCuestionario'];
    return typeof t === 'string' && Date.now() - new Date(t).getTime() < 30_000;
  });
  edicion: HrCandidatoEdicion = {};
  nuevoEvento: { event_type: HrTalentTipoEvento; channel: HrTalentCanal | null; note: string } = { event_type: 'contacto', channel: null, note: '' };

  readonly historia = computed(() => historiaDe(this.ficha()));
  readonly expediente = computed(() => expedienteDe(this.ficha().documents, this.casilleros(), this.ficha().documentos_faltantes));
  readonly siguiente = computed(() => siguienteEtapa(this.ficha().stage));
  readonly opcionesEtapa = computed(() => ETAPAS.filter((e) => e.id !== this.ficha().stage));
  readonly opcionesCasillero = computed(() => [...this.casilleros(), { key: 'otro', label: 'Otro', obligatorio: false }]);
  /** ¿La acción abierta MARCA (o quita la marca)? */
  readonly marcando = computed(() => (this.accion() === 'spam' ? !this.ficha().is_spam : !this.ficha().no_rehire));
  readonly textoMotivo = computed(() => {
    if (!this.marcando()) return 'Nota (opcional)';
    return this.accion() === 'spam' ? 'Motivo (opcional)' : '¿Por qué no debe volver a entrar? (obligatorio)';
  });
  readonly textoConfirmar = computed(() => {
    if (this.accion() === 'spam') return this.marcando() ? 'Enviar a spam' : 'Sacar de spam';
    return this.marcando() ? 'Marcar como no recontratable' : 'Quitar la marca';
  });

  estadoPaso(id: HrTalentEtapa): 'hecho' | 'actual' | 'pendiente' {
    const actual = this.ficha().stage;
    const i = ETAPAS_DEL_FLUJO.findIndex((e) => e.id === id);
    const j = ETAPAS_DEL_FLUJO.findIndex((e) => e.id === actual);
    if (id === actual) return 'actual';
    if (actual === 'contratado' || (j >= 0 && i < j)) return 'hecho';
    return 'pendiente';
  }

  abrirAccion(a: Accion, objetivo: string | null = null): void {
    this.accion.set(a);
    this.objetivo.set(objetivo);
    this.motivo.set('');
    this.aviso.set(null);
  }

  cerrarAccion(): void { this.abrirAccion(null); }

  abrirEdicion(): void {
    const f = this.ficha();
    this.edicion = { full_name: f.full_name, phone: f.phone, email: f.email, city_branch: f.city_branch, position_interest: f.position_interest };
    this.abrirAccion('editar');
  }

  private correr(obs: ReturnType<ReclutamientoService['ficha']>, ok: string, fallback: string): void {
    this.ocupado.set(true);
    obs.subscribe({
      next: (f) => { this.ocupado.set(false); this.accion.set(null); this.aviso.set({ texto: ok, mal: false }); this.actualizada.emit(f); },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, fallback), mal: true }); },
    });
  }

  mover(stage: HrTalentEtapa): void {
    this.etapaElegida.set(null);
    this.correr(this.api.moverEtapa(this.ficha().id, stage), `Pasó a ${etapaLabel(stage)}.`, 'No se pudo mover de etapa.');
  }

  guardarEdicion(): void {
    this.correr(this.api.editar(this.ficha().id, this.edicion), 'Datos corregidos.', 'No se pudieron guardar los datos.');
  }

  marcar(): void {
    const id = this.ficha().id;
    const obs = this.accion() === 'spam'
      ? this.api.spam(id, this.marcando(), this.motivo())
      : this.api.noRecontratable(id, this.marcando(), this.motivo());
    this.correr(obs, 'Listo.', 'No se pudo guardar la marca.');
  }

  papelera(reason: 'manual' | 'cierre_seguimiento'): void {
    this.correr(this.api.aPapelera(this.ficha().id, reason), 'Enviado a la papelera.', 'No se pudo mandar a la papelera.');
  }

  restaurar(): void {
    this.correr(this.api.restaurar(this.ficha().id), 'Restaurado.', 'No se pudo restaurar.');
  }

  retirar(): void {
    const llave = this.objetivo();
    if (!llave) return;
    this.correr(this.api.retirarDocumento(this.ficha().id, llave, this.motivo()), 'Documento retirado.', 'No se pudo retirar el documento.');
  }

  registrar(): void {
    const e = this.nuevoEvento;
    if (e.event_type === 'nota' && !e.note.trim()) { this.aviso.set({ texto: 'Una nota sin texto no dice nada.', mal: true }); return; }
    this.ocupado.set(true);
    this.api.evento(this.ficha().id, { event_type: e.event_type, channel: e.channel, note: e.note.trim() || null }).subscribe({
      next: () => {
        this.nuevoEvento = { event_type: 'contacto', channel: null, note: '' };
        this.api.ficha(this.ficha().id).subscribe({
          next: (f) => { this.ocupado.set(false); this.aviso.set({ texto: 'Registrado.', mal: false }); this.actualizada.emit(f); },
          error: () => { this.ocupado.set(false); this.aviso.set({ texto: 'Registrado. Recarga para verlo.', mal: false }); },
        });
      },
      error: (err) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(err, 'No se pudo registrar.'), mal: true }); },
    });
  }

  async subir(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const archivo = input.files?.[0];
    input.value = '';
    const slot = this.casillero();
    if (!archivo || !slot) return;
    if (archivo.size > MAX_DOCUMENTO_BYTES) { this.aviso.set({ texto: 'El archivo pasa de 10 MB.', mal: true }); return; }
    this.ocupado.set(true);
    try {
      const file_base64 = await leerComoDataUri(archivo);
      this.ocupado.set(false);
      this.casillero.set(null);
      this.correr(this.api.subirDocumento(this.ficha().id, { slot, file_name: archivo.name, file_base64 }), 'Documento subido.', 'No se pudo subir el documento.');
    } catch {
      this.ocupado.set(false);
      this.aviso.set({ texto: 'No se pudo leer el archivo.', mal: true });
    }
  }

  estiloNombre(e: keyof typeof HR_ESTILOS_LIDERAZGO): string {
    return HR_ESTILOS_LIDERAZGO[e].nombre;
  }

  /** `[RH.2.4]` Genera una liga personal (subir el CV o el cuestionario de liderazgo; vence en 7 días). */
  pedirLiga(form: 'cv' | 'liderazgo' | 'aptitudes'): void {
    this.ocupado.set(true);
    this.api.crearLiga(this.ficha().id, form).subscribe({
      next: (l) => {
        this.ocupado.set(false);
        (form === 'cv' ? this.liga : form === 'liderazgo' ? this.ligaLiderazgo : this.ligaAptitudes).set(l);
        this.aviso.set(null);
      },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo generar la liga.'), mal: true }); },
    });
  }

  copiarLiga(l: HrLigaCreadaDto): void {
    const ok = () => this.aviso.set({ texto: 'Mensaje con la liga copiado: pégalo en WhatsApp.', mal: false });
    const mal = () => this.aviso.set({ texto: 'No se pudo copiar: selecciona la liga y cópiala a mano.', mal: true });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(l.mensaje).then(ok, mal); else mal();
  }

  fusionar(absorbId: string): void {
    this.ocupado.set(true);
    this.api.fusionar(this.ficha().id, absorbId).subscribe({
      next: (r) => {
        this.accion.set(null);
        const texto = r.rellenados.length ? `Fusionado. Se recuperaron: ${r.rellenados.join(', ')}.` : 'Fusionado. El otro registro no tenía datos que éste no tuviera.';
        this.api.ficha(this.ficha().id).subscribe({
          next: (f) => { this.ocupado.set(false); this.aviso.set({ texto, mal: false }); this.actualizada.emit(f); this.fusionado.emit(r.conservado); },
          error: () => { this.ocupado.set(false); this.aviso.set({ texto, mal: false }); this.fusionado.emit(r.conservado); },
        });
      },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo fusionar.'), mal: true }); },
    });
  }
}
