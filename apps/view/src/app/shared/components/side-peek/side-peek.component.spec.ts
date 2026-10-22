import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { SidePeekComponent } from './side-peek.component';

/**
 * Candado del cajón lateral. Lo monta **31 pantallas**, así que lo que se prueba acá no es
 * una variante: es que agregar una no se lleve puestas las otras treinta.
 *
 * ⚠️ El componente nació sin spec y ya tuvo un defecto de este tipo: el commit 6b4146c9
 * (2026-08-20) movió dos declaraciones al insertar un bloque nuevo y dejó **8 de 10**
 * pantallas pintadas y sin responder a nada. Nadie lo vio hasta producción.
 */
describe('SidePeekComponent — la variante nueva no toca el default', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<SidePeekComponent>>;

  function montar(lado?: 'derecha' | 'izquierda') {
    TestBed.configureTestingModule({
      imports: [SidePeekComponent],
      providers: [provideZonelessChangeDetection()],
    });
    fixture = TestBed.createComponent(SidePeekComponent);
    if (lado) { fixture.componentRef.setInput('lado', lado); }
    fixture.detectChanges();
    return fixture;
  }

  const raiz = (): HTMLElement => fixture.nativeElement.querySelector('.sp-root');

  beforeEach(() => TestBed.resetTestingModule());

  it('⭐ por DEFAULT entra por la derecha: sin la clase de la variante', () => {
    // Esto es lo que protege a las 31 pantallas que ya lo montan.
    montar();
    expect(fixture.componentInstance.lado()).toBe('derecha');
    expect(raiz().classList.contains('is-izq'),
      'el default cambió: las 31 pantallas que montan el cajón se moverían de lado').toBe(false);
  });

  it('con lado="izquierda" marca la clase de la variante', () => {
    montar('izquierda');
    expect(raiz().classList.contains('is-izq')).toBe(true);
  });

  it('⛔ abierto y a la izquierda lleva LAS DOS clases, que es de lo que depende el CSS', () => {
    /**
     * La regla de abierto es `.sp-root.is-izq.is-open .sp-panel`. Se escribió con las dos
     * clases a propósito: contra `.sp-root.is-open .sp-panel` tendría la misma
     * especificidad y ganaría la que el bundle ponga última — el mismo defecto que la nota
     * de `is-above-modals` documenta ("el cajón salía arriba o abajo según el día").
     * Si alguna de las dos clases deja de ponerse, el cajón izquierdo no entra.
     */
    montar('izquierda');
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    expect(raiz().classList.contains('is-izq')).toBe(true);
    expect(raiz().classList.contains('is-open')).toBe(true);
  });

  it('la variante NO toca lo que el organismo garantiza: rol, modal y Esc', () => {
    // El lado es presentación. Lo que hace que esto sea un diálogo no cambia con el borde.
    montar('izquierda');
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const panel: HTMLElement = fixture.nativeElement.querySelector('.sp-panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');

    fixture.componentInstance.onEscape();
    expect(fixture.componentInstance.open(), 'Esc dejó de cerrar el cajón izquierdo').toBe(false);
  });

  it('el ancho por default sigue siendo el del cajón, no el de la ventana', () => {
    // `widthPx` es protected; se comprueba por el estilo que el panel publica.
    montar('izquierda');
    const panel: HTMLElement = fixture.nativeElement.querySelector('.sp-panel');
    expect(panel.style.getPropertyValue('--sp-w')).toBe('520px');
  });
});
