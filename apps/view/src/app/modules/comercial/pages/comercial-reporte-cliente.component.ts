import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { TicketsService, ClienteCandidato, ReporteCliente, ReporteDocumento, ReporteFiltrosUI } from '../tickets.service';
import { imprimirReporteCliente } from '../reporte-cliente-papel';

/**
 * TK.8 — **Reporte por cliente**. Sección propia, no una pestaña: la pantalla de buscar folio
 * se queda tal cual y desde ahí se llega con un botón.
 *
 * ⚠️ **Para quién sirve, medido:** el mostrador es anónimo — 187,530 de 193,297 tickets de 90
 * días se cobraron a `CONTADO`. El buscador ofrece los **1,065 clientes con nombre**, y no los
 * inventa: sale del maestro de Kepler.
 *
 * ⚠️ **La clave es por sucursal.** 29 de 1,005 nombran a otro cliente en otra plaza, así que se
 * elige (sucursal, clave) y las ambiguas se marcan. Un reporte que junte dos plazas puede estar
 * sumando a dos personas distintas.
 *
 * ⚠️ Lo que los filtros no dicen por sí solos viaja en `aviso` desde el backend y se imprime
 * arriba de la tabla: el 15.8% del catálogo sin proveedor, que la caja deja fuera las facturas,
 * y que un filtro de marca trae el documento **completo** (si trajera sólo sus partidas, el
 * total dejaría de ser un cobro que existió).
 */
@Component({
  selector: 'app-comercial-reporte-cliente',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TagModule, ToastModule],
  providers: [MessageService],
  template: `
<p-toast></p-toast>
<div class="rc">
  <header class="rc-head">
    <div>
      <div class="rc-crumb">Comercial › Tickets › Reporte por cliente</div>
      <h1>Reporte por cliente</h1>
    </div>
    <a class="rc-volver" routerLink="/comercial/tickets">Buscar un folio</a>
  </header>

  @if (!cliente(); as _) {
    <!-- Paso 1: elegir de quién. Sin cliente no hay reporte que mostrar. -->
    <section class="rc-card rc-buscar">
      <label for="q">Nombre, clave o RFC del cliente</label>
      <input id="q" type="text" [(ngModel)]="termino" (keyup.enter)="buscarCliente()"
             placeholder="abarrotes…" autocomplete="off">
      <button pButton size="small" [loading]="buscando()" (click)="buscarCliente()">Buscar</button>
    </section>

    @if (candidatos().length) {
      <section class="rc-card">
        <ul class="rc-cands">
          @for (c of candidatos(); track c.cliente_code) {
            <li>
              <button type="button" class="rc-cand" (click)="elegir(c)">
                <span class="rc-cand-nom">{{ c.nombre || c.cliente_code }}</span>
                <span class="rc-cand-sub">
                  <span class="rc-mono">{{ c.cliente_code }}</span>
                  @if (c.zona) { · zona {{ c.zona }} }
                  @if (c.ciudad) { · {{ c.ciudad }} }
                  · en {{ c.plazas }} sucursal{{ c.plazas === 1 ? '' : 'es' }}
                </span>
                @if (c.clave_ambigua) {
                  <span class="rc-amb">⚠ Esta clave trae nombres distintos según la sucursal: puede ser más de un cliente</span>
                }
              </button>
            </li>
          }
        </ul>
        @if (topado()) { <p class="rc-nota">Hay más coincidencias: afiná el nombre.</p> }
      </section>
    } @else if (buscado()) {
      <section class="rc-card rc-vacio">
        <p><b>Ningún cliente con ese nombre.</b></p>
        <p class="rc-nota">
          El mostrador es anónimo: de 193,297 tickets de los últimos 90 días, 187,530 se cobraron
          a <span class="rc-mono">CONTADO</span> y no son de nadie. Sólo aparecen los clientes
          con nombre en el maestro de Kepler.
        </p>
      </section>
    }
  } @else {
    <!-- Paso 2: el cliente elegido manda la pantalla. -->
    <section class="rc-card rc-cli">
      <div class="rc-cli-txt">
        <b>{{ cliente()!.nombre || cliente()!.cliente_code }}</b>
        <span class="rc-cand-sub">
          <span class="rc-mono">{{ cliente()!.cliente_code }}</span>
          @if (cliente()!.zona) { · zona {{ cliente()!.zona }} }
          @if (cliente()!.ciudad) { · {{ cliente()!.ciudad }} }
        </span>
        @if (cliente()!.clave_ambigua) {
          <span class="rc-amb">⚠ Esta clave trae nombres distintos según la sucursal: el reporte puede estar sumando a más de un cliente</span>
        }
      </div>
      <button pButton size="small" [text]="true" severity="secondary" (click)="cambiar()">Cambiar cliente</button>
    </section>

    <!-- UNA fila. Lo que se usa siempre a la vista; el resto detrás de «Más filtros», y lo
         que está puesto se ve como etiqueta que se quita de un clic: no hay que abrir el panel
         para saber qué hay activo. -->
    <div class="rc-barra">
      <select class="rc-periodo" aria-label="Periodo" [ngModel]="periodo()" (ngModelChange)="elegirPeriodo($event)">
        @for (p of PERIODOS; track p.id) { <option [value]="p.id">{{ p.label }}</option> }
      </select>

      <button type="button" class="rc-masf" [class.abierto]="panel()" (click)="panel.set(!panel())"
              [attr.aria-expanded]="panel()">
        <i class="pi pi-sliders-h" aria-hidden="true"></i>
        Más filtros
        @if (activos().length) { <span class="rc-badge">{{ activos().length }}</span> }
      </button>

      @for (a of activos(); track a.clave) {
        <span class="rc-chip">
          {{ a.texto }}
          <button type="button" [attr.aria-label]="'Quitar el filtro ' + a.texto" (click)="quitar(a.clave)">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        </span>
      }

      <span class="rc-flex"></span>

      @if (rep()?.documentos?.length) {
        <button pButton size="small" [disabled]="!dentro().size" (click)="imprimir()">
          <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span>Imprimir reporte
        </button>
      }
    </div>

    @if (panel()) {
      <section class="rc-card rc-panel">
        <div class="rc-fila">
          <label for="f1">Del</label>
          <input id="f1" type="date" [(ngModel)]="f.date_from">
          <label for="f2">al</label>
          <input id="f2" type="date" [(ngModel)]="f.date_to">
          <span class="rc-sep"></span>
          <label for="f3">Importe</label>
          <input id="f3" type="number" [(ngModel)]="f.min" placeholder="mín" class="rc-num">
          <span>–</span>
          <input id="f4" type="number" [(ngModel)]="f.max" placeholder="máx" class="rc-num" aria-label="Importe máximo">
          <label class="rc-check">
            <input type="checkbox" [(ngModel)]="f.solo_con_descuento"> Sólo con descuento
          </label>
        </div>
        <div class="rc-fila">
          <label for="f7">Folio</label>
          <input id="f7" type="text" [(ngModel)]="f.folio" placeholder="contiene" class="rc-num">
          <label for="f8">Sucursal</label>
          <input id="f8" type="text" [(ngModel)]="f.warehouse_codes" placeholder="todas" class="rc-num">
          <label for="f5">Caja</label>
          <input id="f5" type="number" [(ngModel)]="f.caja" placeholder="todas" class="rc-num">
          <label for="f6">Atendió</label>
          <input id="f6" type="text" [(ngModel)]="f.atendio" placeholder="clave" class="rc-num">
          <span class="rc-sep"></span>
          <button pButton size="small" [loading]="cargando()" (click)="aplicar()">Aplicar</button>
          <button pButton size="small" [text]="true" severity="secondary" (click)="limpiar()">Limpiar</button>
        </div>
      </section>
    }

    @if (rep(); as r) {
      <!-- El aviso sale SOLO cuando hay algo que declarar: lo decide el backend. -->
      @if (r.aviso) { <div class="rc-aviso">{{ r.aviso }}</div> }

      <!-- DOS cifras, no cinco. La pregunta es cuánto compró y en cuántas compras. -->
      <div class="rc-cifras">
        <div>
          <b class="rc-mono rc-total">{{ r.resumen.importe | currency:'MXN':'symbol-narrow' }}</b>
          <span>en {{ r.resumen.documentos }} compra{{ r.resumen.documentos === 1 ? '' : 's' }}</span>
        </div>
        @if (r.resumen.descuento > 0) {
          <div>
            <b class="rc-mono rc-desc">{{ r.resumen.descuento | currency:'MXN':'symbol-narrow' }}</b>
            <span>de descuento</span>
          </div>
        }
      </div>

      <section class="rc-card rc-tabla">
        <table>
          <thead>
            <tr>
              <th style="width:38px">
                <input type="checkbox" [checked]="todosDentro()" (change)="alternarTodos()"
                       aria-label="Incluir todas las compras">
              </th>
              <th>Compra</th><th>Dónde</th>
              <th class="ta-r">Descuento</th><th class="ta-r">Total</th>
            </tr>
          </thead>
          <tbody>
            @for (d of r.documentos; track d.id) {
              <tr [class.dentro]="dentro().has(d.id)">
                <td><input type="checkbox" [checked]="dentro().has(d.id)" (change)="alternar(d)"
                           [attr.aria-label]="'Incluir ' + d.id"></td>
                <td>
                  <!-- La fecha manda: ya elegiste al cliente, nadie busca por folio acá. Y el
                       tipo se dice con palabras, no sólo con un color. -->
                  <div class="rc-dia" [class.neg]="d.total < 0">
                    {{ dia(d.fecha) }}
                    @if (d.origen !== 'mostrador') { · {{ d.origen_label | lowercase }} }
                  </div>
                  <div class="rc-sub rc-mono">{{ d.id }}</div>
                </td>
                <td>{{ d.sucursal_nombre || d.sucursal }}@if (d.caja != null) { <i class="rc-caja">· caja {{ d.caja }}</i> }</td>
                <td class="ta-r rc-mono">{{ d.descuento > 0 ? (d.descuento | currency:'MXN':'symbol-narrow') : '—' }}</td>
                <td class="ta-r rc-mono" [class.neg]="d.total < 0">{{ d.total | currency:'MXN':'symbol-narrow' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="rc-empty">Sin compras con esos filtros.</td></tr>
            }
          </tbody>
        </table>

        @if (r.documentos.length) {
          <div class="rc-pie">
            <b>{{ dentro().size }} de {{ r.documentos.length }} compra{{ r.documentos.length === 1 ? '' : 's' }} van al reporte</b>
            <span class="rc-nota">
              @if (fuera() > 0) { Suman {{ totalDentro() | currency:'MXN':'symbol-narrow' }} · {{ fuera() }} fuera }
              @else { Destildá las que no quieras incluir }
            </span>
          </div>
        }
      </section>
    }
  }
</div>
  `,
  styles: [`
    .rc { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
    .rc-head { display: flex; align-items: flex-end; justify-content: space-between; }
    .rc-crumb { font-size: 12px; color: var(--text-3); }
    .rc h1 { margin: 2px 0 0; font-size: 20px; font-weight: 700; letter-spacing: -.01em; }
    .rc-volver { font-size: 13px; }
    .rc-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 14px; }
    .rc-buscar { display: flex; align-items: center; gap: 10px; }
    .rc-buscar label { font-size: 13px; color: var(--text-2); }
    .rc-buscar input { flex-grow: 1; font: inherit; font-size: 14px; padding: 9px 11px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--text-1); }
    .rc-cands { list-style: none; margin: 0; padding: 0; }
    .rc-cand { width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--border-color); padding: 9px 4px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; font: inherit; color: inherit; }
    .rc-cand:hover { background: var(--overlay-hover); }
    .rc-cand-nom { font-size: 14px; font-weight: 600; }
    .rc-cand-sub { font-size: 12px; color: var(--text-3); }
    .rc-amb { font-size: 12px; color: var(--warn-soft-fg); }
    .rc-cli { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .rc-cli-txt { display: flex; flex-direction: column; gap: 3px; }
    .rc-barra { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
    .rc-flex { flex-grow: 1; }
    .rc-periodo { font: inherit; font-size: 14px; font-weight: 500; padding: 9px 11px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--text-1); }
    .rc-masf { display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: 14px; padding: 9px 13px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--text-2); cursor: pointer; }
    .rc-masf:hover, .rc-masf.abierto { background: var(--overlay-hover); color: var(--text-1); }
    .rc-badge { font-family: var(--font-mono); font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--action); color: #fff; }
    .rc-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 6px 7px 6px 11px; border: 1px solid var(--action); border-radius: 999px; color: var(--action); background: transparent; }
    .rc-chip button { display: inline-flex; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0; line-height: 0; font-size: 11px; }
    .rc-panel { display: flex; flex-direction: column; gap: 9px; }
    .rc-cifras { display: flex; align-items: baseline; gap: 36px; padding: 2px; }
    .rc-cifras > div { display: flex; flex-direction: column; gap: 1px; }
    .rc-cifras span { font-size: 12.5px; color: var(--text-3); }
    .rc-total { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; }
    .rc-desc { font-size: 19px; font-weight: 600; color: var(--ok-fg); }
    .rc-dia { font-size: 14px; font-weight: 500; }
    .rc-sub { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
    .rc-caja { font-style: normal; color: var(--text-3); }
    .rc-pie { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--border-color); }
    .rc-fila { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); }
    .rc-fila input[type=date], .rc-fila input[type=text], .rc-fila input[type=number] { font: inherit; font-size: 13px; padding: 7px 9px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--text-1); }
    .rc-num { width: 98px; }
    .rc-check { display: flex; align-items: center; gap: 6px; }
    .rc-sep { width: 1px; height: 22px; background: var(--border-color); }
    .rc-aviso { font-size: 12.5px; line-height: 1.5; padding: 10px 13px; border: 1px solid var(--warn-border); background: var(--warn-soft-bg); color: var(--warn-soft-fg); border-radius: var(--radius-sm); }
    .rc-tabla { padding: 0; overflow: hidden; }
    .rc-tabla table { width: 100%; border-collapse: collapse; }
    .rc-tabla th { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); text-align: left; font-weight: 600; padding: 10px 12px; background: var(--page-bg, transparent); }
    .rc-tabla td { font-size: 14px; padding: 12px; border-top: 1px solid var(--border-color); }
    .rc-tabla tr.dentro td { background: var(--overlay-selected); }
    .ta-r { text-align: right; }
    .neg { color: var(--bad-fg); }
    .rc-empty { text-align: center; color: var(--text-3); padding: 20px; }
    .rc-nota { font-size: 12px; color: var(--text-3); margin: 0; }
    .rc-vacio p { margin: 0 0 6px; font-size: 13px; }
    .rc-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialReporteClienteComponent {
  private readonly svc = inject(TicketsService);
  private readonly toast = inject(MessageService);

  termino = '';
  f: ReporteFiltrosUI = {};

  /**
   * Los periodos que se piden de verdad. El cuarto abre el panel: un rango a mano es la
   * excepción, y ponerlo primero obligaba a todos a pensar en fechas para ver un mes.
   */
  readonly PERIODOS = [
    { id: 'mes', label: 'Este mes' },
    { id: 'mes-1', label: 'Mes pasado' },
    { id: '90', label: 'Últimos 90 días' },
    { id: 'todo', label: 'Todo' },
    { id: 'otro', label: 'Otro periodo…' },
  ];
  readonly periodo = signal('mes');
  /** El panel de filtros arranca CERRADO: la pantalla tiene que poder leerse sin abrirlo. */
  readonly panel = signal(false);

  readonly buscando = signal(false);
  readonly buscado = signal(false);
  readonly cargando = signal(false);
  readonly candidatos = signal<ClienteCandidato[]>([]);
  readonly topado = signal(false);
  readonly cliente = signal<ClienteCandidato | null>(null);
  readonly rep = signal<ReporteCliente | null>(null);

  /**
   * Qué documentos van al papel. Arrancan TODOS dentro: el caso normal es el periodo completo,
   * y quitar dos es menos trabajo que marcar cuarenta.
   */
  readonly dentro = signal<Set<string>>(new Set());

  readonly totalDentro = computed(() =>
    (this.rep()?.documentos ?? []).filter((d) => this.dentro().has(d.id)).reduce((s, d) => s + d.total, 0));
  readonly fuera = computed(() => (this.rep()?.documentos.length ?? 0) - this.dentro().size);
  readonly todosDentro = computed(() => {
    const n = this.rep()?.documentos.length ?? 0;
    return n > 0 && this.dentro().size === n;
  });

  /**
   * Los filtros puestos, como etiquetas que se quitan de un clic.
   *
   * ⚠️ El periodo NO entra acá: ya se ve en su propio selector, y repetirlo haría leer dos
   * filtros donde hay uno. Sólo lo que está escondido detrás del panel necesita decirse.
   */
  readonly activos = computed<{ clave: keyof ReporteFiltrosUI; texto: string }[]>(() => {
    const f = this.fAplicados();
    const out: { clave: keyof ReporteFiltrosUI; texto: string }[] = [];
    if (f.folio) out.push({ clave: 'folio', texto: `Folio: ${f.folio}` });
    if (f.warehouse_codes) out.push({ clave: 'warehouse_codes', texto: `Sucursal: ${f.warehouse_codes}` });
    if (f.caja) out.push({ clave: 'caja', texto: `Caja ${f.caja}` });
    if (f.atendio) out.push({ clave: 'atendio', texto: `Atendió: ${f.atendio}` });
    if (f.min) out.push({ clave: 'min', texto: `Desde $${f.min}` });
    if (f.max) out.push({ clave: 'max', texto: `Hasta $${f.max}` });
    if (f.solo_con_descuento) out.push({ clave: 'solo_con_descuento', texto: 'Sólo con descuento' });
    return out;
  });

  /** Copia de lo APLICADO, no de lo tecleado: una etiqueta tiene que reflejar lo que se ve. */
  private readonly fAplicados = signal<ReporteFiltrosUI>({});

  /** Quita un filtro y vuelve a pedir: la etiqueta promete eso, y tiene que cumplirlo. */
  quitar(clave: keyof ReporteFiltrosUI): void {
    delete this.f[clave];
    this.aplicar();
  }

  /**
   * El periodo, en fechas. ⚠️ Se arma con `getFullYear/getMonth` y se formatea a mano, NO con
   * `toISOString()`: eso convierte a UTC y en México adelanta el día, así que «este mes»
   * arrancaría el último día del mes anterior.
   */
  elegirPeriodo(id: string): void {
    this.periodo.set(id);
    if (id === 'otro') { this.panel.set(true); return; }
    const hoy = new Date();
    const d = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    if (id === 'mes') {
      this.f.date_from = d(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
      this.f.date_to = d(hoy);
    } else if (id === 'mes-1') {
      this.f.date_from = d(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1));
      this.f.date_to = d(new Date(hoy.getFullYear(), hoy.getMonth(), 0));
    } else if (id === '90') {
      this.f.date_from = d(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 90));
      this.f.date_to = d(hoy);
    } else {
      delete this.f.date_from;
      delete this.f.date_to;
    }
    this.aplicar();
  }

  /** Aplicar cierra el panel: si quedara abierto taparía la respuesta que se acaba de pedir. */
  aplicar(): void {
    this.panel.set(false);
    this.cargar();
  }

  private readonly MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  /**
   * «18 de septiembre» a partir de 'YYYY-MM-DD'.
   *
   * ⚠️ Se PARTE el string, no se construye un `Date`: un `date` de Postgres leído como UTC y
   * renderizado en hora de México sale con el día ANTERIOR — el primero de mes cae en el mes
   * pasado. Ya costó una entrega en la Fase LC, y es el mismo criterio que usa el papel.
   * Además evita depender de que la app registre el locale `es-MX` para el pipe `date`.
   */
  dia(iso: string | null): string {
    if (!iso) return 'sin fecha';
    const [y, m, d] = iso.split('-');
    const mes = this.MESES[Number(m) - 1];
    return y && mes && d ? `${Number(d)} de ${mes}` : iso;
  }

  sev(origen: string): 'info' | 'success' | 'warn' | 'danger' | 'secondary' {
    return origen === 'mostrador' ? 'info'
      : origen === 'telemarketing' ? 'success'
      : origen === 'credito' ? 'warn'
      : origen === 'abono' ? 'danger' : 'secondary';
  }

  buscarCliente(): void {
    const q = this.termino.trim();
    if (q.length < 2) return;
    this.buscando.set(true);
    this.svc.clientes(q).subscribe({
      next: (r) => {
        this.candidatos.set(r.candidatos);
        this.topado.set(r.topado);
        this.buscado.set(true);
        this.buscando.set(false);
        if (r.candidatos.length === 1) this.elegir(r.candidatos[0]);
      },
      error: () => {
        this.buscando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo buscar' });
      },
    });
  }

  elegir(c: ClienteCandidato): void {
    this.cliente.set(c);
    this.candidatos.set([]);
    // Arranca en el mes en curso, no en «todo»: es lo que se pide el 90% de las veces, y
    // abrir con el histórico completo es la diferencia entre 40 renglones y varios cientos.
    this.elegirPeriodo('mes');
  }

  cambiar(): void {
    this.cliente.set(null);
    this.rep.set(null);
    this.buscado.set(false);
    this.dentro.set(new Set());
  }

  limpiar(): void {
    this.f = {};
    this.periodo.set('todo');
    this.aplicar();
  }

  cargar(): void {
    const c = this.cliente();
    if (!c) return;
    this.cargando.set(true);
    this.fAplicados.set({ ...this.f });
    this.svc.reporte(c.cliente_code, this.f).subscribe({
      next: (r) => {
        this.rep.set(r);
        this.dentro.set(new Set(r.documentos.map((d) => d.id)));
        this.cargando.set(false);
      },
      error: () => {
        this.cargando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo cargar el reporte' });
      },
    });
  }

  alternar(d: ReporteDocumento): void {
    const s = new Set(this.dentro());
    if (s.has(d.id)) s.delete(d.id); else s.add(d.id);
    this.dentro.set(s);
  }

  alternarTodos(): void {
    const docs = this.rep()?.documentos ?? [];
    this.dentro.set(this.todosDentro() ? new Set() : new Set(docs.map((d) => d.id)));
  }

  imprimir(): void {
    const r = this.rep();
    const c = this.cliente();
    if (!r || !c) return;
    const elegidos = r.documentos.filter((d) => this.dentro().has(d.id));
    if (!imprimirReporteCliente(c, elegidos, this.f, this.fuera())) {
      this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la impresión' });
    }
  }
}
