import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import {
  aisleOrder,
  describeLocationCode,
  LOCATION_KINDS,
  parseLocationCode,
  type LocationKind,
  type LocationZone,
  type WarehouseLocationRow,
  type WarehouseLocationsResponse,
} from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';

/** Estado de un rack en el mapa: el más urgente de sus niveles. */
type EstadoRack = 'bloqueada' | 'contenido' | 'activa' | 'baja' | 'vacio';

interface Celda {
  rack: number;
  estado: EstadoRack;
  niveles: WarehouseLocationRow[];
  aria: string;
}
interface Fila {
  pasillo: string;
  celdas: Celda[];
}

const ESTADO_LABEL: Record<EstadoRack, string> = {
  bloqueada: 'con un nivel bloqueado',
  contenido: 'con mercancía acomodada',
  activa: 'dada de alta',
  baja: 'dada de baja',
  vacio: 'sin dar de alta',
};

/**
 * `[UB.1]` Mapa de ubicaciones (Fase UB, ADR-090).
 *
 * Los pasillos en renglones y los racks en columnas, por zona (bodega / tienda). Cada cuadro es
 * un rack y se pinta con el estado más urgente de sus niveles. Al tocarlo se ven sus niveles. Quien
 * tiene GESTIONAR puede dar de alta una ubicación desde aquí; la captura masiva llega en `[UB.2]`.
 *
 * Lo que no tiene formato nuevo (códigos libres del Andén, como `R-12`) no se esconde: se lista
 * aparte como "código libre", porque sigue existiendo y puede tener mercancía.
 */
@Component({
  selector: 'app-almacen-ubicaciones-mapa',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head ub-head">
        <div class="ub-head-text">
          <h1>Ubicaciones</h1>
          @if (data()?.warehouse; as w) { <span class="ub-meta">{{ w.code }} · {{ w.name }} · bodega y tienda en el mismo almacén</span> }
        </div>
        <div class="ub-actions">
          @if (almacenOpts().length > 1) {
            <p-select [options]="almacenOpts()" optionLabel="label" optionValue="value" [ngModel]="warehouseId()" (onChange)="pickAlmacen($event.value)" ariaLabel="Almacén" appendTo="body" class="ub-sel" />
          }
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (err(); as e) { <div class="ub-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="ub-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="ub-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="ub-skel-row"></div> }</div> }
      @else if (data(); as d) {
        @if (!d.warehouse) {
          <div class="ub-note ub-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene un almacén asignado, así que no hay ubicaciones que mostrarte. Pide que te lo asignen en <b>Administración › Personas</b>.</span></div>
        } @else {
          <section class="ub-kpis" aria-label="Resumen">
            <div class="ub-kpi"><span class="ub-kpi-l">Ubicaciones activas</span><span class="ub-kpi-v num">{{ d.resumen.activas }}</span><span class="ub-kpi-s">de {{ d.resumen.total }} dadas de alta</span></div>
            <div class="ub-kpi"><span class="ub-kpi-l">Bloqueadas</span><span class="ub-kpi-v num" [class.ub-bad]="d.resumen.bloqueadas > 0">{{ d.resumen.bloqueadas }}</span><span class="ub-kpi-s">no se sugieren</span></div>
            <div class="ub-kpi"><span class="ub-kpi-l">Con mercancía</span><span class="ub-kpi-v num">{{ d.resumen.con_contenido }}</span><span class="ub-kpi-s">acomodada con escaneo</span></div>
            <div class="ub-kpi"><span class="ub-kpi-l">Código libre</span><span class="ub-kpi-v num" [class.ub-warn]="d.resumen.legado > 0">{{ d.resumen.legado }}</span><span class="ub-kpi-s">sin el formato BA053</span></div>
          </section>

          <div class="ub-split">
            <section class="ub-block" aria-labelledby="ub-h-mapa">
              <div class="ub-bh">
                <h2 id="ub-h-mapa" class="sr-only">Mapa</h2>
                <div class="ub-seg" role="group" aria-label="Zona">
                  <button type="button" class="ub-seg-b" [class.on]="zona() === 'B'" [attr.aria-pressed]="zona() === 'B'" (click)="pickZona('B')">B · Bodega <span class="num">{{ cuentaZona('B') }}</span></button>
                  <button type="button" class="ub-seg-b" [class.on]="zona() === 'T'" [attr.aria-pressed]="zona() === 'T'" (click)="pickZona('T')">T · Tienda <span class="num">{{ cuentaZona('T') }}</span></button>
                </div>
                <div class="ub-legend" aria-hidden="true">
                  <span><i class="ub-sw ub-c-activa"></i>Dada de alta</span>
                  <span><i class="ub-sw ub-c-contenido"></i>Con mercancía</span>
                  <span><i class="ub-sw ub-c-bloqueada"></i>Bloqueada</span>
                  <span><i class="ub-sw ub-c-vacio"></i>Sin dar de alta</span>
                </div>
              </div>

              @if (filas().length) {
                <div class="ub-grid-wrap">
                  <div class="ub-grid" [style.--ub-cols]="racks().length">
                    <span></span>
                    @for (r of racks(); track r) { <span class="ub-rh num">{{ dos(r) }}</span> }
                    @for (f of filas(); track f.pasillo) {
                      <span class="ub-ah">Pasillo <b class="num">{{ f.pasillo }}</b></span>
                      @for (c of f.celdas; track c.rack) {
                        <button type="button" class="ub-cell ub-c-{{ c.estado }}" [class.sel]="selKey() === f.pasillo + c.rack" [attr.aria-label]="c.aria" [attr.aria-pressed]="selKey() === f.pasillo + c.rack" (click)="pickRack(f.pasillo, c)"></button>
                      }
                    }
                  </div>
                </div>
                <p class="ub-hint">Cada cuadro es un rack; el color es el estado más urgente de sus niveles. Tócalo para ver sus niveles.</p>
              } @else {
                <div class="ub-empty"><i class="pi pi-map" aria-hidden="true"></i><span>Todavía no hay ubicaciones de {{ zona() === 'B' ? 'bodega' : 'tienda' }} con el formato nuevo en {{ d.warehouse.code }}.</span>@if (puedeGestionar()) { <span>Da de alta la primera aquí a la derecha; la captura masiva por rango llega en la siguiente entrega.</span> }</div>
              }
            </section>

            <aside class="ub-block ub-side" aria-label="Detalle">
              @if (sel(); as s) {
                <div class="ub-step">
                  <h3>Rack {{ s.pasillo }}{{ dos(s.celda.rack) }} · {{ zona() === 'B' ? 'bodega' : 'tienda' }}</h3>
                  @if (s.celda.niveles.length) {
                    <ul class="ub-levels">
                      @for (n of s.celda.niveles; track n.id) {
                        <li class="ub-level">
                          <span class="ub-code mono">{{ n.code }}</span>
                          <span class="ub-level-txt">Nivel {{ n.nivel }} · {{ tipoLabel(n.tipo) }}@if (n.renglones_con_cantidad) { · <b>{{ n.renglones_con_cantidad }} con mercancía</b> }</span>
                          <span class="ub-chip ub-chip-{{ n.estado }}">{{ estadoTxt(n.estado) }}</span>
                          @if (n.motivo_estado) { <span class="ub-sub">{{ n.motivo_estado }}</span> }
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="ub-hint">Este rack no tiene niveles dados de alta.</p>
                  }
                </div>
              }

              @if (puedeGestionar()) {
                <form class="ub-step" (ngSubmit)="crear()" aria-labelledby="ub-h-alta">
                  <h3 id="ub-h-alta">Dar de alta una ubicación</h3>
                  <label class="ub-field" for="ub-code">Código
                    <input pInputText id="ub-code" name="code" class="mono" autocomplete="off" [ngModel]="codigo()" (ngModelChange)="onCodigo($event)" placeholder="BA053" maxlength="12" [attr.aria-invalid]="codigo() && !parsed().ok" aria-describedby="ub-code-help" />
                  </label>
                  <span id="ub-code-help" class="ub-sub" [class.ub-bad]="codigo() && !parsed().ok" aria-live="polite">{{ ayudaCodigo() }}</span>
                  <label class="ub-field" for="ub-tipo">Tipo
                    <p-select inputId="ub-tipo" [options]="tipos" optionLabel="label" optionValue="key" [ngModel]="tipo()" (onChange)="tipo.set($event.value)" appendTo="body" placeholder="Sin tipo" [showClear]="true" />
                  </label>
                  @if (crearErr(); as e) { <span class="ub-sub ub-bad" role="alert">{{ e }}</span> }
                  @if (creada(); as c) { <span class="ub-sub ub-ok" role="status">{{ c }} quedó dada de alta.</span> }
                  <button pButton type="submit" class="p-button-sm" [disabled]="!parsed().ok || creando()" [loading]="creando()"><span class="p-button-label">Dar de alta</span></button>
                </form>
              }

              @if (legado().length) {
                <div class="ub-step">
                  <h3>Con código libre ({{ legado().length }})</h3>
                  <p class="ub-hint">Las dio de alta el Andén antes del formato nuevo. Siguen valiendo; se recodifican desde Mantenimiento.</p>
                  <ul class="ub-levels">
                    @for (n of legado(); track n.id) {
                      <li class="ub-level"><span class="ub-code mono">{{ n.code }}</span><span class="ub-level-txt">{{ n.label || 'Sin nombre' }}@if (n.renglones_con_cantidad) { · <b>{{ n.renglones_con_cantidad }} con mercancía</b> }</span><span class="ub-chip ub-chip-{{ n.estado }}">{{ estadoTxt(n.estado) }}</span></li>
                    }
                  </ul>
                </div>
              }
            </aside>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .ub-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .ub-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .ub-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    :host ::ng-deep .ub-sel { min-width:12rem; }
    .ub-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(10rem, 1fr)); gap:.6rem; margin-bottom:.75rem; }
    .ub-kpi { display:flex; flex-direction:column; gap:.15rem; padding:.6rem .8rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .ub-kpi-l, .ub-kpi-s { font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-kpi-v { font-size:var(--fs-h2); font-weight:600; }
    .ub-split { display:flex; flex-wrap:wrap; gap:.75rem; align-items:flex-start; }
    .ub-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; flex:999 1 36rem; }
    .ub-side { flex:1 1 20rem; }
    .ub-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .ub-seg { display:inline-flex; border:1px solid var(--border-color); border-radius:var(--r-sm); overflow:hidden; }
    .ub-seg-b { height:2.25rem; padding:0 .8rem; border:0; border-left:1px solid var(--border-color); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-sm); cursor:pointer; display:inline-flex; align-items:center; gap:.4rem; }
    .ub-seg-b:first-child { border-left:0; }
    .ub-seg-b.on { background:var(--text-main); color:var(--card-bg); }
    .ub-seg-b:focus-visible, .ub-cell:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .ub-legend { display:flex; flex-wrap:wrap; gap:.4rem .9rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-legend span { display:inline-flex; align-items:center; gap:.35rem; }
    .ub-sw { display:inline-block; width:.85rem; height:.85rem; border-radius:3px; }
    .ub-grid-wrap { overflow-x:auto; padding:.75rem .85rem .25rem; }
    .ub-grid { display:grid; grid-template-columns:4.75rem repeat(var(--ub-cols), minmax(1.75rem, 1fr)); gap:.25rem; align-items:center; min-width:min-content; }
    .ub-rh { text-align:center; font-size:var(--fs-nano); color:var(--text-muted); }
    .ub-ah { font-size:var(--fs-xs); color:var(--text-muted); white-space:nowrap; }
    .ub-cell { height:2.25rem; border-radius:var(--r-sm); border:1px solid transparent; cursor:pointer; padding:0; }
    .ub-cell.sel { outline:3px solid var(--action); outline-offset:2px; }
    .ub-c-activa { background:var(--text-muted); border-color:var(--text-muted); }
    .ub-c-contenido { background:var(--warn-soft-bg); border-color:var(--warn-border); }
    .ub-c-bloqueada { background:var(--bad-soft-bg); border:2px solid var(--bad-fg); }
    .ub-c-baja { background:var(--hover-bg); border:1px solid var(--border-color); }
    .ub-c-vacio { background:transparent; border:1px dashed var(--border-color); }
    .ub-step { padding:.75rem .85rem; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:.5rem; }
    .ub-side > .ub-step:first-child { border-top:0; }
    .ub-step h3 { font-size:var(--fs-sm); font-weight:700; margin:0; }
    .ub-levels { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.4rem; }
    .ub-level { display:grid; grid-template-columns:auto 1fr auto; gap:.15rem .6rem; align-items:center; padding:.45rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .ub-level .ub-sub { grid-column:1 / -1; }
    .ub-code { font-size:var(--fs-md); font-weight:600; }
    .ub-level-txt { font-size:var(--fs-xs); color:var(--text-muted); min-width:0; }
    .ub-level-txt b { color:var(--text-main); font-weight:600; }
    .ub-chip { font-size:var(--fs-nano); padding:.1rem .45rem; border-radius:999px; border:1px solid var(--border-color); white-space:nowrap; }
    .ub-chip-activa { background:var(--ok-soft-bg); color:var(--ok-soft-fg); border-color:var(--ok-border); }
    .ub-chip-bloqueada { background:var(--bad-soft-bg); color:var(--bad-soft-fg); border-color:var(--bad-border); }
    .ub-chip-baja { background:var(--hover-bg); color:var(--text-muted); }
    .ub-field { display:flex; flex-direction:column; gap:.25rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-field input { font-size:var(--fs-md); height:2.5rem; }
    .ub-sub { font-size:var(--fs-xs); color:var(--text-muted); }
    .ub-bad { color:var(--bad-fg) !important; }
    .ub-warn { color:var(--warn-soft-fg) !important; }
    .ub-ok { color:var(--ok-fg) !important; }
    .ub-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:0; padding:0 .85rem .7rem; }
    .ub-step .ub-hint { padding:0; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .ub-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .ub-note-bad { border-left:3px solid var(--bad-fg); }
    .ub-note-bad .pi { color:var(--bad-fg); }
    .ub-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .ub-errbox .pi { color:var(--bad-fg); } .ub-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .ub-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); font-size:var(--fs-sm); }
    .ub-empty .pi { font-size:var(--fs-lg); }
    .ub-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .ub-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:ub-pulse 1.4s ease-in-out infinite; }
    @keyframes ub-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .ub-skel-row { animation:none; } }
  `],
})
export class AlmacenUbicacionesMapaComponent implements OnInit {
  private readonly api = inject(AlmacenUbicacionesCatalogoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly skel = Array.from({ length: 6 });
  readonly tipos = [...LOCATION_KINDS];

  readonly data = signal<WarehouseLocationsResponse | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly warehouseId = signal<string | null>(null);
  readonly zona = signal<LocationZone>('B');
  readonly sel = signal<{ pasillo: string; celda: Celda } | null>(null);
  readonly selKey = computed(() => {
    const s = this.sel();
    return s ? s.pasillo + s.celda.rack : null;
  });

  readonly codigo = signal('');
  readonly tipo = signal<LocationKind | null>(null);
  readonly creando = signal(false);
  readonly crearErr = signal<string | null>(null);
  readonly creada = signal<string | null>(null);
  readonly parsed = computed(() => parseLocationCode(this.codigo()));

  readonly puedeGestionar = computed(
    () => this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.ALMACEN_UBICACIONES_GESTIONAR],
  );

  readonly almacenOpts = computed(() =>
    (this.data()?.alcance.almacenes ?? []).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })),
  );

  private readonly conFormato = computed(() => (this.data()?.ubicaciones ?? []).filter((u) => u.familia === 'ubicacion'));
  readonly legado = computed(() => (this.data()?.ubicaciones ?? []).filter((u) => u.familia === 'legado'));

  /** Columnas: del rack 1 al mayor que exista en la zona (los huecos se ven como "sin dar de alta"). */
  readonly racks = computed(() => {
    const max = Math.max(0, ...this.conFormato().filter((u) => u.zona === this.zona()).map((u) => u.rack ?? 0));
    return Array.from({ length: max }, (_, i) => i + 1);
  });

  readonly filas = computed<Fila[]>(() => {
    const deZona = this.conFormato().filter((u) => u.zona === this.zona());
    const pasillos = [...new Set(deZona.map((u) => u.pasillo as string))].sort((a, b) => aisleOrder(a) - aisleOrder(b));
    return pasillos.map((pasillo) => ({
      pasillo,
      celdas: this.racks().map((rack) => {
        const niveles = deZona.filter((u) => u.pasillo === pasillo && u.rack === rack).sort((a, b) => (a.nivel ?? 0) - (b.nivel ?? 0));
        const estado = estadoDeRack(niveles);
        return { rack, estado, niveles, aria: `Rack ${pasillo}${String(rack).padStart(2, '0')}, ${ESTADO_LABEL[estado]}` };
      }),
    }));
  });

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.api.list(this.warehouseId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        if (!this.warehouseId() && d.warehouse) this.warehouseId.set(d.warehouse.id);
        this.refrescarSel();
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.err.set('No se pudieron cargar las ubicaciones.');
      },
    });
  }

  pickAlmacen(id: string): void {
    this.warehouseId.set(id);
    this.sel.set(null);
    this.reload();
  }

  pickZona(z: LocationZone): void {
    this.zona.set(z);
    this.sel.set(null);
  }

  pickRack(pasillo: string, celda: Celda): void {
    this.sel.set(this.selKey() === pasillo + celda.rack ? null : { pasillo, celda });
  }

  /** Tras recargar, el rack elegido se vuelve a leer de los datos nuevos (si no, mostraría niveles viejos). */
  private refrescarSel(): void {
    const s = this.sel();
    if (!s) return;
    const fila = this.filas().find((f) => f.pasillo === s.pasillo);
    const celda = fila?.celdas.find((c) => c.rack === s.celda.rack);
    this.sel.set(celda ? { pasillo: s.pasillo, celda } : null);
  }

  cuentaZona(z: LocationZone): number {
    return this.conFormato().filter((u) => u.zona === z && u.estado !== 'baja').length;
  }

  onCodigo(v: string): void {
    this.codigo.set(v);
    this.crearErr.set(null);
    this.creada.set(null);
  }

  ayudaCodigo(): string {
    const p = this.parsed();
    if (!this.codigo()) return 'Zona (T/B) · pasillo · rack 01–99 · nivel 1–6. Ejemplo: BA053.';
    return p.ok ? describeLocationCode(p.parts) : p.motivo;
  }

  crear(): void {
    const p = this.parsed();
    const w = this.warehouseId();
    if (!p.ok || !w || this.creando()) return;
    this.creando.set(true);
    this.crearErr.set(null);
    this.api.create({ warehouse_id: w, code: p.code, tipo: this.tipo() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (row) => {
        this.creando.set(false);
        this.creada.set(row.code);
        this.codigo.set('');
        if (row.zona) this.zona.set(row.zona);
        this.reload();
      },
      error: (e: HttpErrorResponse) => {
        this.creando.set(false);
        const m = e.error?.message;
        this.crearErr.set(typeof m === 'string' ? m : 'No se pudo dar de alta la ubicación.');
      },
    });
  }

  dos(n: number): string {
    return String(n).padStart(2, '0');
  }
  tipoLabel(t: LocationKind | null): string {
    return t ? LOCATION_KINDS.find((k) => k.key === t)?.label ?? t : 'sin tipo';
  }
  estadoTxt(e: string): string {
    return e === 'activa' ? 'Activa' : e === 'bloqueada' ? 'Bloqueada' : 'Baja';
  }
}

/** El estado más urgente de los niveles de un rack (bloqueada > con mercancía > activa > baja > vacío). */
export function estadoDeRack(niveles: WarehouseLocationRow[]): EstadoRack {
  if (!niveles.length) return 'vacio';
  if (niveles.some((n) => n.estado === 'bloqueada')) return 'bloqueada';
  if (niveles.some((n) => n.estado !== 'baja' && n.renglones_con_cantidad > 0)) return 'contenido';
  if (niveles.some((n) => n.estado === 'activa')) return 'activa';
  return 'baja';
}
