import { Directive, HostListener, ElementRef, inject, output, signal } from '@angular/core';

/** ¿Lo que se arrastra trae ARCHIVOS (y no un texto o un enlace seleccionado)? */
export function traeArchivos(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

/**
 * `[MS.ADJ.3.1]` Zona donde se SUELTAN archivos del escritorio.
 *
 *   <div appArchivoDrop (soltados)="agregar($event)"> … </div>
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────────
 *  · Sobre la zona: marca `arrastrando` (clase en el host) y entrega los `File[]` al soltar.
 *  · FUERA de la zona, mientras exista: soltar un archivo NO abre el archivo en la pestaña (el navegador lo haría y la persona
 *    perdería lo que estaba escribiendo). Se cancela el `dragover`/`drop` del documento sólo cuando traen archivos.
 *  · Sólo reacciona a archivos: arrastrar texto o un enlace no enciende la zona ni se traga el gesto.
 *
 * No decide qué tipos sirven ni cuántos caben: eso lo hace quien la usa (`adjuntos.ts`) y, en última instancia, el servidor.
 */
@Directive({
  selector: '[appArchivoDrop]',
  standalone: true,
  exportAs: 'appArchivoDrop',
  host: { '[class.arrastrando]': 'encima()' },
})
export class ArchivoDropDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** Los archivos que se soltaron en la zona. */
  readonly soltados = output<File[]>();
  /** ¿Hay un arrastre de archivos encima? (para pintar la zona). */
  readonly encima = signal(false);

  // `dragenter`/`dragleave` se disparan también al pasar sobre los hijos: se cuenta para no parpadear.
  private nivel = 0;

  @HostListener('dragenter', ['$event'])
  alEntrar(ev: DragEvent): void {
    if (!traeArchivos(ev.dataTransfer)) return;
    ev.preventDefault();
    this.nivel++;
    this.encima.set(true);
  }

  @HostListener('dragover', ['$event'])
  alPasar(ev: DragEvent): void {
    if (!traeArchivos(ev.dataTransfer)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }

  @HostListener('dragleave', ['$event'])
  alSalir(ev: DragEvent): void {
    if (!traeArchivos(ev.dataTransfer)) return;
    this.nivel = Math.max(0, this.nivel - 1);
    if (this.nivel === 0) this.encima.set(false);
  }

  @HostListener('drop', ['$event'])
  alSoltar(ev: DragEvent): void {
    if (!traeArchivos(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.stopPropagation(); // que el guardián del documento no lo trate como «afuera»
    this.nivel = 0;
    this.encima.set(false);
    const archivos = Array.from(ev.dataTransfer?.files ?? []);
    if (archivos.length) this.soltados.emit(archivos);
  }

  /** Guardián: un archivo soltado FUERA de la zona no debe navegar la pestaña hacia él. */
  @HostListener('document:dragover', ['$event'])
  guardianPasar(ev: DragEvent): void {
    if (!traeArchivos(ev.dataTransfer) || this.host.contains(ev.target as Node)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none';
  }

  @HostListener('document:drop', ['$event'])
  guardianSoltar(ev: DragEvent): void {
    if (!traeArchivos(ev.dataTransfer)) return;
    ev.preventDefault();
    this.nivel = 0;
    this.encima.set(false);
  }

  /** Si se suelta fuera de la ventana o se cancela con Esc, el navegador sólo avisa por `dragend`/`dragleave` del documento. */
  @HostListener('document:dragend')
  alTerminar(): void {
    this.nivel = 0;
    this.encima.set(false);
  }
}
