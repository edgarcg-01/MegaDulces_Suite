import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import {
  ASSIGNMENT_ROLES,
  LOCATION_BULK_MAX,
  type BulkAssignmentAction,
  type BulkAssignmentInputRow,
  type BulkAssignmentsPreview,
  type BulkAssignmentsResult,
} from '@megadulces/contracts';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';
import { csvATabla, decodificarCsv, leerTablaAsignaciones, leerXlsx } from '../shared/ubicaciones-archivo';

type Sev = 'success' | 'secondary' | 'warn' | 'danger' | 'info';
const ACCION: Record<BulkAssignmentAction, { label: string; sev: Sev }> = {
  nueva: { label: 'Se asigna', sev: 'success' },
  cambia: { label: 'Cambia', sev: 'info' },
  igual: { label: 'Ya está así', sev: 'secondary' },
  repetida: { label: 'Repetida', sev: 'warn' },
  error: { label: 'Con error', sev: 'danger' },
};
const PAPEL = new Map(ASSIGNMENT_ROLES.map((r) => [r.key, r.label]));

/**
 * `[UB.3]` Asignar desde Excel: clave → presentación → ubicación → papel (+ mínimo/máximo).
 *
 * La presentación se escribe como la dice la gente (caja, paquete, pieza) o con el número del
 * peldaño; el servidor la resuelve contra la escalera REAL de Kepler de esa sucursal y, si es
 * ambigua o no existe, lo dice con la fila exacta. La vista previa y el aplicar corren el mismo plan.
 */
@Component({
  selector: 'app-ubicaciones-asignacion-excel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ButtonModule, TableModule, TagModule],
  template: `
    <section class="ax-block" aria-labelledby="ax-h">
      <div class="ax-bh"><h2 id="ax-h">Asignar desde Excel · {{ warehouse().name }}</h2></div>
      <div class="ax-step">
        <div class="ax-file">
          <label class="ax-filebtn">
            <input type="file" accept=".xlsx,.csv" class="sr-only" (change)="onArchivo($event)" />
            <span class="pi pi-upload" aria-hidden="true"></span><span>{{ archivo() ? 'Cambiar archivo' : 'Elegir archivo (.xlsx o .csv)' }}</span>
          </label>
          <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="plantilla()"><span class="p-button-label">Descargar plantilla</span></button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="!filas().length || cargando()" [loading]="cargando() && !aplicando()" (click)="revisar()"><span class="p-button-label">Revisar</span></button>
        </div>
        @if (archivo(); as a) { <p class="ax-sub">{{ a }} · {{ filas().length }} renglones@if (vacias()) { · {{ vacias() }} vacíos ignorados }</p> }
        @if (errArchivo(); as e) { <p class="ax-sub ax-bad" role="alert">{{ e }}</p> }
        <p class="ax-sub">Columnas: <b>Clave</b>, <b>Presentación</b> (caja, paquete, pieza… o 1, 2, 3), <b>Ubicación</b> (BA053), <b>Papel</b> (surtido, exhibición o reserva), Mínimo y Máximo en esa presentación (vacíos: en una asignación que ya existe se conservan). Tope {{ max }} renglones.</p>
      </div>

      @if (err(); as e) { <p class="ax-step ax-bad" role="alert">{{ e }}</p> }

      @if (previa(); as p) {
        <div class="ax-step">
          <div class="ax-resumen" aria-label="Qué va a pasar">
            @for (a of acciones; track a) {
              @if (p.conteo[a]) { <span class="ax-cnt"><p-tag [value]="accionLabel(a)" [severity]="accionSev(a)" styleClass="ax-tag" /> <b class="num">{{ p.conteo[a] }}</b></span> }
            }
            <span class="ax-sub">de {{ p.total }}</span>
          </div>
          <div class="dt-scope">
            <p-table [value]="p.filas" size="small" class="surf-table dt-stack" [scrollable]="true" scrollHeight="24rem">
              <ng-template #header>
                <tr><th class="num">Fila</th><th>Producto</th><th>Presentación</th><th>Ubicación</th><th>Papel</th><th class="num">Mín – Máx</th><th>Qué pasará</th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="num" role="cell" data-label="Fila">{{ r.fila ?? '—' }}</td>
                  <td role="cell" data-label="Producto"><span class="mono">{{ r.sku || '—' }}</span>@if (r.nombre) { <span class="ax-sub ax-blk">{{ r.nombre }}</span> }</td>
                  <td role="cell" data-label="Presentación">{{ r.presentacion || '—' }}@if (r.peldano) { <span class="ax-sub"> · peldaño {{ r.peldano }}</span> }</td>
                  <td class="mono" role="cell" data-label="Ubicación">{{ r.ubicacion || '—' }}</td>
                  <td role="cell" data-label="Papel">{{ papelLabel(r.papel) }}</td>
                  <td class="num" role="cell" data-label="Mín – Máx">{{ r.min_qty ?? '—' }} – {{ r.max_qty ?? '—' }}</td>
                  <td role="cell" data-label="Qué pasará"><p-tag [value]="accionLabel(r.accion)" [severity]="accionSev(r.accion)" styleClass="ax-tag" />@if (r.motivo) { <span class="ax-sub ax-blk">{{ r.motivo }}</span> }</td>
                </tr>
              </ng-template>
            </p-table>
          </div>
          @if (p.truncado) { <p class="ax-sub">Se muestran {{ p.filas.length }} de {{ p.total }}, primero los que tienen algo que revisar.</p> }
          <div class="ax-acts">
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="previa.set(null)"><span class="p-button-label">Cancelar</span></button>
            <button pButton type="button" class="p-button-sm" [disabled]="!(p.conteo.nueva + p.conteo.cambia) || aplicando()" [loading]="aplicando()" (click)="aplicar()"><span class="p-button-label">Aplicar {{ p.conteo.nueva + p.conteo.cambia }}</span></button>
          </div>
        </div>
      }

      @if (resultado(); as r) {
        <p class="ax-step ax-ok" role="status">Listo en {{ resultadoEn() }}: <b class="num">{{ r.creadas }}</b> asignaciones nuevas y <b class="num">{{ r.actualizadas }}</b> cambiadas@if (r.omitidas) { · {{ r.omitidas }} sin cambio o con error }.</p>
      }
    </section>
  `,
  styles: [`
    :host { display:block; }
    .ax-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .ax-bh { padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .ax-bh h2 { margin:0; font-size:var(--fs-h3); font-weight:700; }
    .ax-step { padding:.75rem .85rem; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:.55rem; }
    .ax-bh + .ax-step { border-top:0; }
    .ax-file { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .ax-filebtn { display:inline-flex; align-items:center; gap:.45rem; height:2.5rem; padding:0 .9rem; border:1px dashed var(--border-color); border-radius:var(--r-sm); cursor:pointer; font-size:var(--fs-sm); }
    .ax-filebtn:focus-within { outline:2px solid var(--action-ring); outline-offset:1px; }
    @media (pointer: coarse) { .ax-filebtn { height:2.75rem; } }
    .ax-resumen { display:flex; flex-wrap:wrap; gap:.4rem .9rem; align-items:center; }
    .ax-cnt { display:inline-flex; align-items:center; gap:.35rem; }
    /* ::ng-deep sólo para el tamaño del p-tag de PrimeNG (vendor). */
    :host ::ng-deep .ax-tag { font-size:var(--fs-nano); }
    .ax-acts { display:flex; justify-content:flex-end; gap:.5rem; }
    .ax-sub { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .ax-blk { display:block; }
    .ax-sub.ax-bad, .ax-step.ax-bad { color:var(--bad-fg); }
    .ax-ok { margin:0; font-size:var(--fs-sm); color:var(--ok-fg); }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
  `],
})
export class UbicacionesAsignacionExcelComponent {
  private readonly api = inject(AlmacenUbicacionesCatalogoService);
  private readonly destroyRef = inject(DestroyRef);

  readonly warehouse = input.required<{ id: string; code: string; name: string }>();
  readonly cambio = output<void>();

  readonly max = LOCATION_BULK_MAX;
  readonly acciones: BulkAssignmentAction[] = ['nueva', 'cambia', 'igual', 'repetida', 'error'];
  readonly archivo = signal<string | null>(null);
  readonly filas = signal<BulkAssignmentInputRow[]>([]);
  readonly vacias = signal(0);
  readonly errArchivo = signal<string | null>(null);
  readonly cargando = signal(false);
  readonly aplicando = signal(false);
  readonly err = signal<string | null>(null);
  readonly previa = signal<BulkAssignmentsPreview | null>(null);
  readonly resultado = signal<BulkAssignmentsResult | null>(null);
  /** El almacén donde se aplicó: si la persona cambió de almacén mientras tanto, el aviso lo dice. */
  readonly resultadoEn = signal('');
  /** Sube al cambiar de almacén: una revisión en vuelo del almacén anterior se descarta. */
  private folio = 0;

  constructor() {
    // Lo revisado era de otro almacén: se limpia al cambiar.
    effect(() => {
      const id = this.warehouse().id;
      if (!id) return;
      untracked(() => { this.folio++; this.previa.set(null); this.resultado.set(null); this.err.set(null); this.cargando.set(false); });
    });
  }

  async onArchivo(ev: Event): Promise<void> {
    const f = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!f) return;
    this.previa.set(null);
    this.resultado.set(null);
    this.errArchivo.set(null);
    this.archivo.set(f.name);
    this.filas.set([]);
    try {
      const tabla = /\.csv$/i.test(f.name) ? csvATabla(decodificarCsv(await f.arrayBuffer())) : await leerXlsx(await f.arrayBuffer());
      const r = leerTablaAsignaciones(tabla);
      if (!r.ok) { this.errArchivo.set(r.motivo); return; }
      if (r.filas.length > LOCATION_BULK_MAX) { this.errArchivo.set(`El archivo trae ${r.filas.length} renglones; el tope es ${LOCATION_BULK_MAX}. Pártelo en varios.`); return; }
      this.filas.set(r.filas);
      this.vacias.set(r.vacias);
      this.revisar();
    } catch {
      this.errArchivo.set('No se pudo leer el archivo. Guárdalo como .xlsx o .csv y vuelve a intentar.');
    }
  }

  revisar(): void {
    if (this.cargando() || !this.filas().length) return;
    this.cargando.set(true);
    this.err.set(null);
    this.resultado.set(null);
    const folio = this.folio;
    this.api.assignmentsPreview({ warehouse_id: this.warehouse().id, filas: this.filas(), archivo: this.archivo() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { if (folio !== this.folio) return; this.previa.set(p); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { if (folio !== this.folio) return; this.cargando.set(false); this.err.set(mensaje(e, 'No se pudo revisar el archivo.')); },
    });
  }

  aplicar(): void {
    if (this.aplicando()) return;
    this.aplicando.set(true);
    this.err.set(null);
    const destino = this.warehouse().name;
    this.api.assignmentsApply({ warehouse_id: this.warehouse().id, filas: this.filas(), archivo: this.archivo() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.aplicando.set(false); this.previa.set(null); this.resultadoEn.set(destino); this.resultado.set(r); this.cambio.emit(); },
      error: (e: HttpErrorResponse) => { this.aplicando.set(false); this.err.set(`${destino}: ${mensaje(e, 'No se pudo aplicar el archivo.')}`); },
    });
  }

  async plantilla(): Promise<void> {
    try {
      const mod = (await import('exceljs')) as unknown as Record<string, any>;
      const ExcelJS = mod['default'] ?? mod;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Asignaciones');
      ws.columns = [
        { header: 'Clave', width: 10 }, { header: 'Presentación', width: 14 }, { header: 'Ubicación', width: 11 },
        { header: 'Papel', width: 13 }, { header: 'Mínimo', width: 9 }, { header: 'Máximo', width: 9 },
      ];
      ws.getRow(1).font = { bold: true };
      ws.getColumn(1).numFmt = '@';
      ws.getColumn(3).numFmt = '@';
      ws.addRow(['70243', 'caja', 'BA053', 'surtido', 4, 12]);
      ws.addRow(['70243', 'paquete', 'BA052', 'surtido', 10, 30]);
      ws.addRow(['70243', 'paquete', 'TA021', 'exhibición', '', '']);
      ws.addRow(['70243', 'caja', 'BC022', 'reserva', '', '']);
      const ayuda = wb.addWorksheet('Cómo llenarla');
      ayuda.columns = [{ header: 'Columna', width: 14 }, { header: 'Qué va', width: 70 }];
      ayuda.getRow(1).font = { bold: true };
      ayuda.addRow(['Clave', 'La clave del producto en Kepler. La columna va como texto para no perder ceros a la izquierda.']);
      ayuda.addRow(['Presentación', 'caja, paquete, pieza… (como en Kepler) o el número del peldaño: 1, 2 o 3.']);
      ayuda.addRow(['Ubicación', 'El código de la ubicación, ya dada de alta: BA053 (bodega) o TA021 (tienda).']);
      ayuda.addRow(['Papel', 'surtido (lugar fijo, en bodega) · exhibición (en tienda) · reserva (excedente, en bodega).']);
      ayuda.addRow(['Mínimo / Máximo', 'En esa presentación (4 = 4 cajas). Opcionales: vacíos en una asignación que ya existe, se conservan los que tenía; en una nueva, quedan sin dato.']);
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'plantilla-asignaciones.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      this.err.set('No se pudo generar la plantilla. Vuelve a intentar.');
    }
  }

  accionLabel(a: BulkAssignmentAction): string { return ACCION[a].label; }
  accionSev(a: BulkAssignmentAction): Sev { return ACCION[a].sev; }
  papelLabel(p: string | null): string { return p ? PAPEL.get(p as never) ?? p : '—'; }
}

function mensaje(e: HttpErrorResponse, fallback: string): string {
  const m = e.error?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' · ') : fallback;
}
