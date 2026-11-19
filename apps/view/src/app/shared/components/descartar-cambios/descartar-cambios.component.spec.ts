import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { DescartarCambiosComponent } from './descartar-cambios.component';

/** La ventana de PrimeNG se simula con su clase: el componente busca SU ventana con `closest('.p-dialog')`. */
@Component({
  standalone: true,
  imports: [DescartarCambiosComponent],
  template: `<div class="p-dialog"><input id="campo" /><app-descartar-cambios [sucio]="sucio()" [bloqueado]="bloqueado()" (cerrar)="cerradas = cerradas + 1" /></div>
             <input id="afuera" />`,
})
class HostComponent {
  readonly sucio = signal(false);
  readonly bloqueado = signal(false);
  cerradas = 0;
}

/** `[LE.6.34]` El «Cancelar» de una ventana con algo contado adentro (modern-web-guidance «dialog»). */
describe('[LE.6.34] DescartarCambios — cerrar una ventana con algo contado pregunta primero', () => {
  let fx: ReturnType<typeof TestBed.createComponent<HostComponent>>;
  const q = (sel: string) => fx.nativeElement.querySelector(sel) as HTMLElement | null;
  const cancelar = () => { (q('[data-testid="dc-cancelar"] button') as HTMLButtonElement).click(); fx.detectChanges(); };
  const esc = (id: string) => {
    document.getElementById(id)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fx.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent], providers: [provideZonelessChangeDetection()] });
    fx = TestBed.createComponent(HostComponent);
    fx.detectChanges();
  });

  it('CONTROL: sin nada contado, «Cancelar» cierra de una', () => {
    cancelar();
    expect(fx.componentInstance.cerradas).toBe(1);
    expect(q('[data-testid="dc-pregunta"]')).toBeNull();
  });

  it('⭐ con algo contado, «Cancelar» pregunta; el foco cae en «Seguir contando»; «Descartar» cierra', () => {
    fx.componentInstance.sucio.set(true); fx.detectChanges();
    cancelar();
    expect(fx.componentInstance.cerradas).toBe(0);
    expect(q('[data-testid="dc-pregunta"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('dc-seguir');
    (q('[data-testid="dc-descartar"]') as HTMLButtonElement).click(); fx.detectChanges();
    expect(fx.componentInstance.cerradas).toBe(1);
  });

  it('⭐ Esc dentro de SU ventana con algo contado pregunta; un segundo Esc es «seguir», no «descartar»', () => {
    fx.componentInstance.sucio.set(true); fx.detectChanges();
    esc('campo');
    expect(q('[data-testid="dc-pregunta"]')).not.toBeNull();
    esc('campo');
    expect(q('[data-testid="dc-pregunta"]')).toBeNull();
    expect(fx.componentInstance.cerradas).toBe(0);
  });

  it('⛔ un Esc de fuera de su ventana no es suyo', () => {
    fx.componentInstance.sucio.set(true); fx.detectChanges();
    esc('afuera');
    expect(q('[data-testid="dc-pregunta"]')).toBeNull();
  });

  it('⛔ mientras se guarda, cancelar no hace nada (cerrar a medio envío pierde el resultado)', () => {
    fx.componentInstance.bloqueado.set(true); fx.detectChanges();
    cancelar();
    expect(fx.componentInstance.cerradas).toBe(0);
  });
});
