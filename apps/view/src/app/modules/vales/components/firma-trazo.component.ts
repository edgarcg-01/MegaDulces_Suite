import { ChangeDetectionStrategy, Component, ElementRef, output, signal, viewChild } from '@angular/core';

/**
 * `[MDT.3.4]` Firmar con el dedo (o el mouse). Entrega el trazo como PNG (`data:image/png;base64,…`) o
 * `null` mientras esté en blanco. Es el mismo gesto que el vale de MDTask; el servidor valida los bytes.
 * Escala por `devicePixelRatio` para que el trazo no salga borroso en el celular.
 */
@Component({
  selector: 'app-firma-trazo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ft">
      <canvas #lienzo class="ft-lienzo" role="img" aria-label="Recuadro para firmar con el dedo"
              (pointerdown)="empezar($event)" (pointermove)="mover($event)" (pointerup)="terminar()" (pointerleave)="terminar()"></canvas>
      <div class="ft-pie">
        <span class="ft-pista">{{ vacio() ? 'Firma dentro del recuadro' : 'Listo' }}</span>
        <button type="button" class="ft-borrar" (click)="borrar()" [disabled]="vacio()">Borrar</button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ft { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ft-lienzo { width: 100%; height: 180px; touch-action: none; background: var(--neutral-50); border: 1px dashed var(--border-color);
      border-radius: var(--r-md); cursor: crosshair; }
    .ft-pie { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .ft-pista { font-size: var(--fs-xs); color: var(--text-muted); }
    .ft-borrar { min-height: 36px; padding: 0 var(--sp-3); cursor: pointer; background: none; color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); font: inherit; }
    .ft-borrar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    @media (pointer: coarse) { .ft-borrar { min-height: 44px; } }
  `],
})
export class FirmaTrazoComponent {
  readonly cambio = output<string | null>();
  readonly vacio = signal(true);
  private readonly lienzo = viewChild.required<ElementRef<HTMLCanvasElement>>('lienzo');
  private ctx: CanvasRenderingContext2D | null = null;
  private trazando = false;

  /** Se mide en el PRIMER toque, no al nacer: dentro de un diálogo que anima, el tamaño inicial sale escalado. */
  private preparar(): void {
    const c = this.lienzo().nativeElement;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx = c.getContext('2d');
    if (!this.ctx) return;
    this.ctx.scale(dpr, dpr);
    this.ctx.lineWidth = 2.2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    // Tinta oscura sobre papel claro, en claro y en oscuro: es la firma que se imprime. Sale del token.
    this.ctx.strokeStyle = getComputedStyle(c).getPropertyValue('--neutral-950').trim() || 'black';
  }

  empezar(ev: PointerEvent): void {
    if (!this.ctx) this.preparar();
    if (!this.ctx) return;
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    this.trazando = true;
    const p = this.punto(ev);
    this.ctx.beginPath();
    this.ctx.moveTo(p.x, p.y);
  }

  mover(ev: PointerEvent): void {
    if (!this.trazando || !this.ctx) return;
    const p = this.punto(ev);
    this.ctx.lineTo(p.x, p.y);
    this.ctx.stroke();
    if (this.vacio()) this.vacio.set(false);
  }

  terminar(): void {
    if (!this.trazando) return;
    this.trazando = false;
    this.cambio.emit(this.vacio() ? null : this.lienzo().nativeElement.toDataURL('image/png'));
  }

  borrar(): void {
    const c = this.lienzo().nativeElement;
    this.ctx?.clearRect(0, 0, c.width, c.height);
    this.vacio.set(true);
    this.cambio.emit(null);
  }

  private punto(ev: PointerEvent): { x: number; y: number } {
    const r = this.lienzo().nativeElement.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
}
