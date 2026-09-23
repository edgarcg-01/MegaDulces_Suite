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

    <section class="rc-card rc-filtros">
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
        <button pButton size="small" [loading]="cargando()" (click)="cargar()">Aplicar</button>
        <button pButton size="small" [text]="true" severity="secondary" (click)="limpiar()">Limpiar</button>
      </div>
    </section>

    @if (rep(); as r) {
      @if (r.aviso) { <div class="rc-aviso">{{ r.aviso }}</div> }

      <div class="rc-kpis">
        <div class="rc-kpi"><span>Documentos</span><b class="rc-mono">{{ r.resumen.documentos }}</b></div>
        <div class="rc-kpi"><span>Importe</span><b class="rc-mono">{{ r.resumen.importe | currency:'MXN':'symbol-narrow' }}</b></div>
        <div class="rc-kpi"><span>Descuento</span><b class="rc-mono">{{ r.resumen.descuento | currency:'MXN':'symbol-narrow' }}</b></div>
        <div class="rc-kpi"><span>Promedio</span><b class="rc-mono">{{ r.resumen.promedio | currency:'MXN':'symbol-narrow' }}</b></div>
        <div class="rc-kpi"><span>Sucursales</span><b class="rc-mono">{{ r.resumen.plazas_con_compra }}</b></div>
      </div>

      <section class="rc-card rc-tabla">
        <table>
          <thead>
            <tr>
              <th style="width:38px">
                <input type="checkbox" [checked]="todosDentro()" (change)="alternarTodos()"
                       aria-label="Incluir todos los documentos del periodo">
              </th>
              <th>Folio</th><th>Fecha</th><th>Sucursal</th><th>Tipo</th><th>Atendió</th>
              <th class="ta-r">Descuento</th><th class="ta-r">Total</th>
            </tr>
          </thead>
          <tbody>
            @for (d of r.documentos; track d.id) {
              <tr [class.dentro]="dentro().has(d.id)">
                <td><input type="checkbox" [checked]="dentro().has(d.id)" (change)="alternar(d)"
                           [attr.aria-label]="'Incluir ' + d.id"></td>
                <td class="rc-mono">{{ d.id }}</td>
                <td class="rc-mono">{{ d.fecha ? (d.fecha + 'T12:00:00' | date:'dd/MM/yy') : '—' }}</td>
                <td>{{ d.sucursal_nombre || d.sucursal }}@if (d.caja != null) { · caja {{ d.caja }} }</td>
                <td><p-tag [value]="d.origen_label" [severity]="sev(d.origen)"></p-tag></td>
                <td>{{ d.atendio || '—' }}</td>
                <td class="ta-r rc-mono">{{ d.descuento > 0 ? (d.descuento | currency:'MXN':'symbol-narrow') : '—' }}</td>
                <td class="ta-r rc-mono" [class.neg]="d.total < 0">{{ d.total | currency:'MXN':'symbol-narrow' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="8" class="rc-empty">Sin documentos con esos filtros.</td></tr>
            }
          </tbody>
        </table>
      </section>

      @if (r.documentos.length) {
        <section class="rc-card rc-accion">
          <div class="rc-accion-txt">
            <b>{{ dentro().size }} de {{ r.documentos.length }} documentos en el reporte</b>
            <span class="rc-nota">
              Suman <span class="rc-mono">{{ totalDentro() | currency:'MXN':'symbol-narrow' }}</span>
              @if (fuera() > 0) { · {{ fuera() }} fuera por decisión de quien lo emite }
            </span>
          </div>
          <button pButton size="small" [disabled]="!dentro().size" (click)="imprimir()">Imprimir reporte</button>
        </section>
      }
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
    .rc-filtros { display: flex; flex-direction: column; gap: 9px; }
    .rc-fila { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); }
    .rc-fila input[type=date], .rc-fila input[type=text], .rc-fila input[type=number] { font: inherit; font-size: 13px; padding: 7px 9px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--text-1); }
    .rc-num { width: 98px; }
    .rc-check { display: flex; align-items: center; gap: 6px; }
    .rc-sep { width: 1px; height: 22px; background: var(--border-color); }
    .rc-aviso { font-size: 12.5px; line-height: 1.5; padding: 10px 13px; border: 1px solid var(--warn-border); background: var(--warn-soft-bg); color: var(--warn-soft-fg); border-radius: var(--radius-sm); }
    .rc-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
    .rc-kpi { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 11px 13px; display: flex; flex-direction: column; gap: 3px; }
    .rc-kpi span { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); }
    .rc-kpi b { font-size: 20px; font-weight: 600; }
    .rc-tabla { padding: 0; overflow: hidden; }
    .rc-tabla table { width: 100%; border-collapse: collapse; }
    .rc-tabla th { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); text-align: left; font-weight: 600; padding: 10px 12px; background: var(--page-bg, transparent); }
    .rc-tabla td { font-size: 13px; padding: 8px 12px; border-top: 1px solid var(--border-color); }
    .rc-tabla tr.dentro td { background: var(--overlay-selected); }
    .ta-r { text-align: right; }
    .neg { color: var(--bad-fg); }
    .rc-empty { text-align: center; color: var(--text-3); padding: 20px; }
    .rc-accion { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    .rc-accion-txt { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
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
    this.cargar();
  }

  cambiar(): void {
    this.cliente.set(null);
    this.rep.set(null);
    this.buscado.set(false);
    this.dentro.set(new Set());
  }

  limpiar(): void {
    this.f = {};
    this.cargar();
  }

  cargar(): void {
    const c = this.cliente();
    if (!c) return;
    this.cargando.set(true);
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
