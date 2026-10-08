import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import {
  expandLocationRange,
  LOCATION_BULK_MAX,
  LOCATION_KINDS,
  type BulkLocationAction,
  type BulkLocationInputRow,
  type BulkLocationsBody,
  type BulkLocationsPreview,
  type BulkLocationsResult,
  type LocationCaptureBatch,
  type LocationKind,
  type LocationRangeSpec,
  type LocationZone,
} from '@megadulces/contracts';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { AndenCartelComponent, type CartelUbicacion } from '../anden/components/anden-cartel.component';
import { csvATabla, leerTablaUbicaciones } from '../shared/ubicaciones-archivo';

type Modo = 'rango' | 'archivo';
type Sev = 'success' | 'secondary' | 'warn' | 'danger' | 'info';

const ACCION: Record<BulkLocationAction, { label: string; sev: Sev }> = {
  nueva: { label: 'Se crea', sev: 'success' },
  existe: { label: 'Ya existe', sev: 'secondary' },
  baja: { label: 'Dada de baja', sev: 'warn' },
  repetida: { label: 'Repetida', sev: 'warn' },
  error: { label: 'Con error', sev: 'danger' },
};

/**
 * `[UB.2]` Captura masiva de ubicaciones (Fase UB, ADR-090), dentro de `/almacen/ubicaciones`.
 *
 * Dos caminos — por rango o desde un Excel — que pasan por la MISMA vista previa del servidor: lo
 * que se ve es lo que se crea. Lo creado sale con sus carteles para imprimir, y cada captura queda
 * como lote que se deshace mientras nada de lo creado tenga mercancía.
 */
@Component({
  selector: 'app-ubicaciones-captura',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule, TableModule, TagModule, SegmentedComponent, AndenCartelComponent],
  template: `
    <section class="uc-block" aria-labelledby="uc-h">
      <div class="uc-bh">
        <h2 id="uc-h">Captura masiva · {{ warehouse().code }}</h2>
        <app-segmented [options]="modos" [value]="modo()" (valueChange)="pickModo($any($event))" ariaLabel="Forma de captura" />
      </div>

      @if (modo() === 'rango') {
        <form class="uc-step uc-rango" (ngSubmit)="revisar()" aria-label="Rango">
          <div class="uc-field">
            <span class="uc-l" id="uc-zona-l">Zona</span>
            <app-segmented [options]="zonas" [value]="rango().zona" (valueChange)="setRango('zona', $any($event))" ariaLabel="Zona" />
          </div>
          <div class="uc-pair">
            <span class="uc-l">Pasillos</span>
            <label class="uc-mini"><span class="sr-only">Pasillo desde</span><input pInputText class="mono" name="pd" maxlength="1" [ngModel]="rango().pasillo_desde" (ngModelChange)="setRango('pasillo_desde', $event)" /></label>
            <span class="uc-a">a</span>
            <label class="uc-mini"><span class="sr-only">Pasillo hasta</span><input pInputText class="mono" name="ph" maxlength="1" [ngModel]="rango().pasillo_hasta" (ngModelChange)="setRango('pasillo_hasta', $event)" /></label>
          </div>
          <div class="uc-pair">
            <span class="uc-l">Racks</span>
            <label class="uc-mini"><span class="sr-only">Rack desde</span><input pInputText type="number" class="mono" name="rd" min="1" max="99" [ngModel]="rango().rack_desde" (ngModelChange)="setRango('rack_desde', $event)" /></label>
            <span class="uc-a">a</span>
            <label class="uc-mini"><span class="sr-only">Rack hasta</span><input pInputText type="number" class="mono" name="rh" min="1" max="99" [ngModel]="rango().rack_hasta" (ngModelChange)="setRango('rack_hasta', $event)" /></label>
          </div>
          <div class="uc-pair">
            <span class="uc-l">Niveles</span>
            <label class="uc-mini"><span class="sr-only">Nivel desde</span><input pInputText type="number" class="mono" name="nd" min="1" max="6" [ngModel]="rango().nivel_desde" (ngModelChange)="setRango('nivel_desde', $event)" /></label>
            <span class="uc-a">a</span>
            <label class="uc-mini"><span class="sr-only">Nivel hasta</span><input pInputText type="number" class="mono" name="nh" min="1" max="6" [ngModel]="rango().nivel_hasta" (ngModelChange)="setRango('nivel_hasta', $event)" /></label>
          </div>
          <label class="uc-field" for="uc-tipo-r"><span class="uc-l">Tipo</span>
            <p-select inputId="uc-tipo-r" [options]="tipos" optionLabel="label" optionValue="key" [ngModel]="tipo()" (onChange)="tipo.set($event.value); limpiarPrevia()" appendTo="body" placeholder="Sin tipo" [showClear]="true" />
          </label>
          <p class="uc-cuenta" [class.uc-bad]="!cuenta().ok" aria-live="polite">{{ cuentaTxt() }}</p>
          <button pButton type="submit" class="p-button-sm p-button-outlined" [disabled]="!cuenta().ok || cargando()" [loading]="cargando() && !aplicando()"><span class="p-button-label">Revisar</span></button>
        </form>
      } @else {
        <div class="uc-step">
          <div class="uc-file">
            <label class="uc-filebtn">
              <input type="file" accept=".xlsx,.csv" class="sr-only" (change)="onArchivo($event)" />
              <span class="pi pi-upload" aria-hidden="true"></span><span>{{ archivo() ? 'Cambiar archivo' : 'Elegir archivo (.xlsx o .csv)' }}</span>
            </label>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="plantilla()"><span class="p-button-label">Descargar plantilla</span></button>
          </div>
          @if (archivo(); as a) { <p class="uc-sub">{{ a }} · {{ filas().length }} renglones@if (vacias()) { · {{ vacias() }} vacíos ignorados }</p> }
          @if (errArchivo(); as e) { <p class="uc-sub uc-bad" role="alert">{{ e }}</p> }
          <label class="uc-field" for="uc-tipo-a"><span class="uc-l">Tipo para los renglones que no lo traen</span>
            <p-select inputId="uc-tipo-a" [options]="tipos" optionLabel="label" optionValue="key" [ngModel]="tipo()" (onChange)="tipo.set($event.value); limpiarPrevia()" appendTo="body" placeholder="Sin tipo" [showClear]="true" />
          </label>
          <p class="uc-sub">Columnas: <b>Código</b> (obligatoria), Tipo y Nombre. Tope {{ max }} renglones.</p>
        </div>
      }

      @if (err(); as e) { <p class="uc-step uc-bad" role="alert">{{ e }}</p> }

      @if (previa(); as p) {
        <div class="uc-step">
          <div class="uc-resumen" aria-label="Qué va a pasar">
            @for (a of acciones; track a) {
              @if (p.conteo[a]) { <span class="uc-cnt"><p-tag [value]="accionLabel(a)" [severity]="accionSev(a)" styleClass="uc-tag" /> <b class="num">{{ p.conteo[a] }}</b></span> }
            }
            <span class="uc-sub">de {{ p.total }}</span>
          </div>
          <div class="dt-scope">
            <p-table [value]="p.filas" size="small" class="surf-table dt-stack" [scrollable]="true" scrollHeight="22rem" dataKey="code">
              <ng-template #header>
                <tr><th class="num">Fila</th><th>Código</th><th>Tipo</th><th>Nombre</th><th>Qué pasará</th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="num" role="cell" data-label="Fila">{{ r.fila ?? '—' }}</td>
                  <td class="mono" role="cell" data-label="Código">{{ r.code || '—' }}</td>
                  <td role="cell" data-label="Tipo">{{ tipoLabel(r.tipo) }}</td>
                  <td role="cell" data-label="Nombre">{{ r.label || '—' }}</td>
                  <td role="cell" data-label="Qué pasará"><p-tag [value]="accionLabel(r.accion)" [severity]="accionSev(r.accion)" styleClass="uc-tag" />@if (r.motivo) { <span class="uc-sub uc-mot">{{ r.motivo }}</span> }</td>
                </tr>
              </ng-template>
            </p-table>
          </div>
          @if (p.truncado) { <p class="uc-sub">Se muestran {{ p.filas.length }} de {{ p.total }}, primero los que tienen algo que revisar. Los conteos sí cubren todos.</p> }
          <div class="uc-acts">
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="limpiarPrevia()"><span class="p-button-label">Cancelar</span></button>
            <button pButton type="button" class="p-button-sm" [disabled]="!p.conteo.nueva || aplicando()" [loading]="aplicando()" (click)="aplicar()"><span class="p-button-label">Crear {{ p.conteo.nueva }}</span></button>
          </div>
        </div>
      }

      @if (resultado(); as res) {
        <div class="uc-step">
          <p class="uc-ok" role="status">Se crearon <b class="num">{{ res.creadas }}</b> ubicaciones@if (res.omitidas) { · {{ res.omitidas }} no se crearon (ya existían o traían error) }. Quedaron como un lote: se puede deshacer abajo mientras ninguna tenga mercancía.</p>
          @if (carteles().length) { <app-anden-cartel [ubicaciones]="carteles()" (cerrar)="carteles.set([])" /> }
        </div>
      }

      <div class="uc-step">
        <h3>Últimas capturas en {{ warehouse().code }}</h3>
        @if (lotes().length) {
          <ul class="uc-lotes">
            @for (l of lotes(); track l.id) {
              <li class="uc-lote">
                <span class="uc-lote-d">{{ l.descripcion }}</span>
                <span class="uc-sub">{{ fecha(l.created_at) }} · {{ l.created_by_name || 'sin usuario' }} · <b class="num">{{ l.created_count }}</b> creadas</span>
                @if (l.undone_at) {
                  <span class="uc-sub">Deshecho {{ fecha(l.undone_at) }} ({{ l.undone_count }} retiradas)</span>
                } @else if (l.en_uso) {
                  <span class="uc-sub">{{ l.en_uso }} con mercancía: ya no se deshace</span>
                } @else if (confirmar() === l.id) {
                  <span class="uc-confirm">
                    <span class="uc-sub">¿Retirar las {{ l.created_count }}?</span>
                    <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="confirmar.set(null)"><span class="p-button-label">No</span></button>
                    <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [loading]="deshaciendo()" (click)="deshacer(l)"><span class="p-button-label">Sí, deshacer</span></button>
                  </span>
                } @else {
                  <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="confirmar.set(l.id)"><span class="p-button-label">Deshacer</span></button>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="uc-sub">Todavía no hay capturas masivas en este almacén.</p>
        }
      </div>
    </section>
  `,
  styles: [`
    :host { display:block; }
    .uc-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .uc-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .uc-bh h2 { margin:0; font-size:var(--fs-h3); font-weight:700; }
    .uc-step { padding:.75rem .85rem; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:.55rem; }
    .uc-bh + .uc-step { border-top:0; }
    .uc-step h3 { margin:0; font-size:var(--fs-sm); font-weight:700; }
    .uc-rango { flex-direction:row; flex-wrap:wrap; align-items:flex-end; gap:.75rem 1.25rem; }
    .uc-field { display:flex; flex-direction:column; gap:.25rem; }
    .uc-pair { display:grid; grid-template-columns:auto auto auto; grid-template-rows:auto auto; column-gap:.4rem; row-gap:.25rem; align-items:center; }
    .uc-pair .uc-l { grid-column:1 / -1; }
    .uc-l { font-size:var(--fs-xs); color:var(--text-muted); }
    .uc-mini input { width:4rem; height:2.5rem; text-align:center; }
    .uc-a { font-size:var(--fs-xs); color:var(--text-muted); }
    .uc-cuenta { margin:0; font-size:var(--fs-sm); flex-basis:100%; }
    .uc-file { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .uc-filebtn { display:inline-flex; align-items:center; gap:.45rem; height:2.5rem; padding:0 .9rem; border:1px dashed var(--border-color); border-radius:var(--r-sm); cursor:pointer; font-size:var(--fs-sm); }
    .uc-filebtn:focus-within { outline:2px solid var(--action-ring); outline-offset:1px; }
    .uc-resumen { display:flex; flex-wrap:wrap; gap:.4rem .9rem; align-items:center; }
    .uc-cnt { display:inline-flex; align-items:center; gap:.35rem; }
    :host ::ng-deep .uc-tag { font-size:var(--fs-nano); }
    .uc-mot { display:block; margin-top:.15rem; }
    .uc-acts { display:flex; justify-content:flex-end; gap:.5rem; }
    .uc-sub { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .uc-sub.uc-bad, .uc-cuenta.uc-bad, .uc-step.uc-bad { color:var(--bad-fg); }
    .uc-ok { margin:0; font-size:var(--fs-sm); color:var(--ok-fg); }
    .uc-lotes { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.4rem; }
    .uc-lote { display:grid; grid-template-columns:1fr auto; gap:.15rem .75rem; align-items:center; padding:.45rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .uc-lote > :nth-child(2) { grid-column:1; }
    .uc-lote > :nth-child(3) { grid-column:2; grid-row:1 / span 2; }
    .uc-lote-d { font-size:var(--fs-sm); }
    .uc-confirm { display:inline-flex; align-items:center; gap:.35rem; flex-wrap:wrap; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
  `],
})
export class UbicacionesCapturaComponent implements OnInit {
  private readonly api = inject(AlmacenUbicacionesCatalogoService);
  private readonly destroyRef = inject(DestroyRef);

  readonly warehouse = input.required<{ id: string; code: string; name: string }>();
  /** Se creó o se deshizo algo: el mapa tiene que recargarse. */
  readonly cambio = output<void>();

  readonly max = LOCATION_BULK_MAX;
  readonly tipos = [...LOCATION_KINDS];
  readonly acciones: BulkLocationAction[] = ['nueva', 'existe', 'baja', 'repetida', 'error'];
  readonly modos: SegOption[] = [
    { label: 'Por rango', value: 'rango' },
    { label: 'Desde Excel', value: 'archivo' },
  ];
  readonly zonas: SegOption[] = [
    { label: 'B · Bodega', value: 'B' },
    { label: 'T · Tienda', value: 'T' },
  ];

  readonly modo = signal<Modo>('rango');
  readonly rango = signal<LocationRangeSpec>({ zona: 'B', pasillo_desde: 'A', pasillo_hasta: 'D', rack_desde: 1, rack_hasta: 15, nivel_desde: 1, nivel_hasta: 3 });
  readonly tipo = signal<LocationKind | null>(null);
  readonly archivo = signal<string | null>(null);
  readonly filas = signal<BulkLocationInputRow[]>([]);
  readonly vacias = signal(0);
  readonly errArchivo = signal<string | null>(null);

  readonly cargando = signal(false);
  readonly aplicando = signal(false);
  readonly err = signal<string | null>(null);
  readonly previa = signal<BulkLocationsPreview | null>(null);
  readonly resultado = signal<BulkLocationsResult | null>(null);
  readonly carteles = signal<CartelUbicacion[]>([]);
  readonly lotes = signal<LocationCaptureBatch[]>([]);
  readonly confirmar = signal<string | null>(null);
  readonly deshaciendo = signal(false);

  /** La misma regla que usa el servidor: lo que dice esta línea es lo que dirá la vista previa. */
  readonly cuenta = computed(() => expandLocationRange(this.rango()));

  ngOnInit(): void {
    this.cargarLotes();
  }

  cuentaTxt(): string {
    const c = this.cuenta();
    if (!c.ok) return c.motivo;
    const r = this.rango();
    const pas = r.pasillo_hasta.toUpperCase().charCodeAt(0) - r.pasillo_desde.toUpperCase().charCodeAt(0) + 1;
    return `${pas} pasillo${pas === 1 ? '' : 's'} × ${r.rack_hasta - r.rack_desde + 1} racks × ${r.nivel_hasta - r.nivel_desde + 1} niveles = ${c.total} ubicaciones`;
  }

  pickModo(m: Modo): void {
    this.modo.set(m);
    this.limpiarPrevia();
  }

  setRango<K extends keyof LocationRangeSpec>(k: K, v: LocationRangeSpec[K]): void {
    const val = (k === 'pasillo_desde' || k === 'pasillo_hasta' ? String(v ?? '').toUpperCase() : k === 'zona' ? v : Number(v)) as LocationRangeSpec[K];
    this.rango.update((r) => ({ ...r, [k]: val }));
    this.limpiarPrevia();
  }

  limpiarPrevia(): void {
    this.previa.set(null);
    this.err.set(null);
  }

  private cuerpo(): BulkLocationsBody {
    const base = { warehouse_id: this.warehouse().id, tipo: this.tipo() };
    return this.modo() === 'rango' ? { ...base, rango: this.rango() } : { ...base, filas: this.filas(), archivo: this.archivo() };
  }

  revisar(): void {
    if (this.cargando()) return;
    if (this.modo() === 'rango' && !this.cuenta().ok) return;
    if (this.modo() === 'archivo' && !this.filas().length) return;
    this.cargando.set(true);
    this.err.set(null);
    this.resultado.set(null);
    this.api.preview(this.cuerpo()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.previa.set(p); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.cargando.set(false); this.err.set(mensaje(e, 'No se pudo revisar la captura.')); },
    });
  }

  aplicar(): void {
    if (this.aplicando()) return;
    // Se deshabilita SÍNCRONO al primer clic (DESIGN.md 13): un doble clic no crea dos lotes.
    this.aplicando.set(true);
    this.err.set(null);
    this.api.apply(this.cuerpo()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.aplicando.set(false);
        this.previa.set(null);
        this.resultado.set(res);
        this.carteles.set(res.codigos.map((code) => ({ code, label: null, almacen: this.warehouse().code })));
        this.cargarLotes();
        this.cambio.emit();
      },
      error: (e: HttpErrorResponse) => { this.aplicando.set(false); this.err.set(mensaje(e, 'No se pudo crear la captura.')); },
    });
  }

  async onArchivo(ev: Event): Promise<void> {
    const f = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!f) return;
    this.limpiarPrevia();
    this.errArchivo.set(null);
    this.archivo.set(f.name);
    this.filas.set([]);
    try {
      const tabla = /\.csv$/i.test(f.name) ? csvATabla(await f.text()) : await leerXlsx(await f.arrayBuffer());
      const r = leerTablaUbicaciones(tabla);
      if (!r.ok) { this.errArchivo.set(r.motivo); return; }
      if (r.filas.length > LOCATION_BULK_MAX) { this.errArchivo.set(`El archivo trae ${r.filas.length} renglones; el tope por captura es ${LOCATION_BULK_MAX}. Pártelo en varios.`); return; }
      this.filas.set(r.filas);
      this.vacias.set(r.vacias);
      this.revisar();
    } catch {
      this.errArchivo.set('No se pudo leer el archivo. Guárdalo como .xlsx o .csv y vuelve a intentar.');
    }
  }

  async plantilla(): Promise<void> {
    const mod = (await import('exceljs')) as unknown as Record<string, any>;
    const ExcelJS = mod['default'] ?? mod;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ubicaciones');
    ws.columns = [{ header: 'Código', width: 12 }, { header: 'Tipo', width: 18 }, { header: 'Nombre', width: 30 }];
    ws.getRow(1).font = { bold: true };
    ws.addRow(['BA011', 'surtido', 'Pasillo A, rack 01, nivel 1']);
    ws.addRow(['BA012', 'reserva', '']);
    ws.addRow(['TA021', 'tienda_piso', '']);
    const tipos = wb.addWorksheet('Tipos válidos');
    tipos.columns = [{ header: 'Tipo', width: 18 }, { header: 'Qué es', width: 30 }];
    tipos.getRow(1).font = { bold: true };
    for (const k of LOCATION_KINDS) tipos.addRow([k.key, k.label]);
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'plantilla-ubicaciones.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  cargarLotes(): void {
    this.api.batches(this.warehouse().id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => this.lotes.set(l),
      error: () => this.lotes.set([]),
    });
  }

  deshacer(l: LocationCaptureBatch): void {
    if (this.deshaciendo()) return;
    this.deshaciendo.set(true);
    this.err.set(null);
    this.api.undo(l.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.deshaciendo.set(false);
        this.confirmar.set(null);
        if (this.resultado()?.batch_id === l.id) { this.resultado.set(null); this.carteles.set([]); }
        this.cargarLotes();
        this.cambio.emit();
      },
      error: (e: HttpErrorResponse) => { this.deshaciendo.set(false); this.confirmar.set(null); this.err.set(mensaje(e, 'No se pudo deshacer el lote.')); this.cargarLotes(); },
    });
  }

  accionLabel(a: BulkLocationAction): string { return ACCION[a].label; }
  accionSev(a: BulkLocationAction): Sev { return ACCION[a].sev; }
  tipoLabel(t: LocationKind | null): string { return t ? LOCATION_KINDS.find((k) => k.key === t)?.label ?? t : '—'; }
  fecha(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
}

function mensaje(e: HttpErrorResponse, fallback: string): string {
  const m = e.error?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' · ') : fallback;
}

/** Primera hoja del Excel como tabla de celdas. `exceljs` se carga bajo demanda (no entra al bundle inicial). */
async function leerXlsx(buf: ArrayBuffer): Promise<unknown[][]> {
  const mod = (await import('exceljs')) as unknown as Record<string, any>;
  const ExcelJS = mod['default'] ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const tabla: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row: { values: unknown[] }, n: number) => {
    // exceljs indexa las celdas desde 1: values[0] siempre viene vacío.
    tabla[n - 1] = (row.values as unknown[]).slice(1);
  });
  return Array.from(tabla, (r) => r ?? []);
}
