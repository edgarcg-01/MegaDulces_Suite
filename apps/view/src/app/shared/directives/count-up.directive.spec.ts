import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountUpDirective } from './count-up.directive';

/**
 * `[GP.RF.UB]` La cifra que se anima tiene que TERMINAR en el último valor que llegó.
 *
 * El caso (medido en prod el 2026-11-17, Asignación de ubicaciones): al buscar «mazapan», la API dijo
 * 46 y la tira pintó 9,045, el valor anterior; al borrar la búsqueda, la API dijo 9,045 y pintó 46.
 * La cifra quedaba un paso atrás hasta el siguiente cambio. Causa: un valor nuevo que llega mientras
 * la primera animación (0 → viejo) sigue corriendo se pintaba, y la animación lo volvía a tapar con
 * el valor viejo, que llevaba guardado.
 *
 * `requestAnimationFrame` se controla a mano: cada cuadro corre cuando la prueba lo dice.
 */

@Component({
  standalone: true,
  imports: [CountUpDirective],
  template: `<b [appCountUp]="v()"></b>`,
})
class Host {
  readonly v = signal(0);
}

describe('CountUpDirective', () => {
  let cola: Map<number, FrameRequestCallback>;
  let id = 0;
  let reloj = 0;

  /** Corre los cuadros pendientes, avanzando el reloj, hasta que no quede animación viva. */
  const correrCuadros = (ms = 2_000): void => {
    const fin = reloj + ms;
    while (cola.size && reloj < fin) {
      reloj += 16;
      const pendientes = [...cola.entries()];
      cola.clear();
      for (const [, cb] of pendientes) cb(reloj);
    }
  };

  beforeEach(() => {
    cola = new Map();
    reloj = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cola.set(++id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (n: number) => { cola.delete(n); });
    // La cifra está en pantalla (el caso del navegador): el observador avisa en cuanto observa.
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(): void { this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      disconnect(): void { /* nada */ }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** La cifra NACE con su valor (como en la app: la tira se pinta cuando llega el dato) y arranca su animación 0 → valor. */
  function montar(inicial: number) {
    const fix = TestBed.createComponent(Host);
    fix.componentInstance.v.set(inicial);
    fix.detectChanges();
    const el = fix.nativeElement.querySelector('b') as HTMLElement;
    return { fix, el };
  }

  it('control: sin cambios a medio camino, termina en su valor', () => {
    const { el } = montar(9045);
    expect(cola.size, 'la primera vez sí anima').toBeGreaterThan(0);
    correrCuadros();
    expect(el.textContent).toBe('9,045');
  });

  it('⭐ un valor que llega A MEDIA animación es el que queda (antes ganaba el viejo)', () => {
    const { fix, el } = montar(9045);
    correrCuadros(100); // la primera animación va a medias
    fix.componentInstance.v.set(46);
    fix.detectChanges();
    correrCuadros();
    expect(el.textContent).toBe('46');
  });

  it('y al revés: de 46 a 9,045 a media animación, queda 9,045', () => {
    const { fix, el } = montar(46);
    correrCuadros(100);
    fix.componentInstance.v.set(9045);
    fix.detectChanges();
    correrCuadros();
    expect(el.textContent).toBe('9,045');
  });
});
