import { TestBed } from '@angular/core/testing';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

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

// `[CGA-A.65]` El título pasado como atributo NO se queda en el elemento: el navegador pintaba su globo
// nativo («Reposición») encima de las cifras de la ventana. Captura de Edgar, 2026-10-29.
describe('[CGA-A.65] el título no deja un globo nativo sobre la ventana', () => {
  it('con title="…" estático, el host no conserva el atributo title y el h2 sí dice el título', async () => {
    const { TestBed } = await import('@angular/core/testing');
    const { Component } = await import('@angular/core');
    const { SidePeekComponent } = await import('./side-peek.component');
    @Component({ standalone: true, imports: [SidePeekComponent], template: '<app-side-peek title="Reposición" [open]="true"></app-side-peek>' })
    class Anfitrion {}
    TestBed.configureTestingModule({ imports: [Anfitrion] });
    const fx = TestBed.createComponent(Anfitrion);
    fx.detectChanges();
    const host = fx.nativeElement.querySelector('app-side-peek') as HTMLElement;
    expect(host.hasAttribute('title')).toBe(false);
    expect(host.querySelector('.sp-title')?.textContent).toContain('Reposición');
  });
});

/**
 * `[LE.6.34]` Auditoría 2026-11-18 (modern-web-guidance «dialog» y «accessibility» §5): Esc cierra SÓLO la capa
 * de arriba, cerrar con algo capturado PREGUNTA, y el foco regresa a quien abrió.
 */
describe('[LE.6.34] SidePeek — Esc de la capa de arriba, descarte confirmado, foco de regreso', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<SidePeekComponent>>;
  const esc = (target: EventTarget = document.body, prevenido = false) => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    if (prevenido) ev.preventDefault();
    target.dispatchEvent(ev);
    fixture.detectChanges();
  };
  function montar(sucio = false) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [SidePeekComponent], providers: [provideZonelessChangeDetection()] });
    fixture = TestBed.createComponent(SidePeekComponent);
    fixture.componentRef.setInput('sucio', sucio);
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    return fixture.componentInstance;
  }
  afterEach(() => document.querySelectorAll('.p-dialog-mask, .prueba-capa').forEach((n) => n.remove()));

  it('CONTROL: limpio, Esc lo cierra como siempre', () => {
    const c = montar();
    esc();
    expect(c.open()).toBe(false);
  });

  it('⛔ con un diálogo modal ENCIMA, el Esc es del diálogo: el cajón sigue abierto', () => {
    const c = montar();
    const mask = document.createElement('div'); mask.className = 'p-dialog-mask'; document.body.appendChild(mask);
    esc();
    expect(c.open()).toBe(true);
  });

  it('⛔ un Esc que ya atendió un desplegable o calendario (defaultPrevented) no cierra el cajón', () => {
    const c = montar();
    esc(document.body, true);
    expect(c.open()).toBe(true);
  });

  it('⛔ un Esc desde una capa de PrimeNG fuera del cajón no lo cierra', () => {
    const c = montar();
    const capa = document.createElement('div'); capa.className = 'p-overlay prueba-capa';
    const input = document.createElement('input'); capa.appendChild(input); document.body.appendChild(capa);
    esc(input);
    expect(c.open()).toBe(true);
  });

  it('⭐ con algo capturado, Esc PREGUNTA; el foco cae en «seguir» y un segundo Esc no descarta', async () => {
    const c = montar(true);
    esc();
    expect(c.open()).toBe(true);
    const caja = fixture.nativeElement.querySelector('[data-testid="sp-confirma"]') as HTMLElement;
    expect(caja).not.toBeNull();
    await Promise.resolve();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('sp-seguir');
    esc();
    expect(c.open(), 'el segundo Esc es «seguir», no «descartar»').toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="sp-confirma"]')).toBeNull();
  });

  it('⭐ con algo capturado, la X y el fondo preguntan; «Descartar y cerrar» cierra', () => {
    const c = montar(true);
    (fixture.nativeElement.querySelector('.sp-close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(c.open()).toBe(true);
    (fixture.nativeElement.querySelector('[data-testid="sp-descartar"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(c.open()).toBe(false);
    montar(true);
    (fixture.nativeElement.querySelector('.sp-backdrop') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="sp-confirma"]')).not.toBeNull();
  });

  it('⭐ al cerrar, el foco regresa al botón que lo abrió', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [SidePeekComponent], providers: [provideZonelessChangeDetection()] });
    const disparador = document.createElement('button'); document.body.appendChild(disparador); disparador.focus();
    fixture = TestBed.createComponent(SidePeekComponent);
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.componentInstance.close();
    fixture.detectChanges();
    await Promise.resolve(); await Promise.resolve();
    expect(document.activeElement).toBe(disparador);
    disparador.remove();
  });
});

/** [LE.6.34] El panel es aria-modal: Tab da la vuelta adentro (guía «accessibility» §12). */
@Component({ standalone: true, imports: [SidePeekComponent], template: '<app-side-peek [open]="true" title="T"><button id="a">a</button><button id="b">b</button></app-side-peek>' })
class ConBotones {}
describe('[LE.6.34] SidePeek — Tab no se sale del panel', () => {
  it('⭐ Tab en el último enfocable vuelve al primero; Shift+Tab en el primero va al último', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [ConBotones], providers: [provideZonelessChangeDetection()] });
    const fx = TestBed.createComponent(ConBotones);
    fx.detectChanges();
    await Promise.resolve(); await Promise.resolve();
    const orig = HTMLElement.prototype.getClientRects;
    HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
    try {
      const panel = fx.nativeElement.querySelector('.sp-panel') as HTMLElement;
      const ultimo = fx.nativeElement.querySelector('#b') as HTMLElement;
      ultimo.focus();
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      expect(document.activeElement?.className, 'Tab desde el último no volvió al primero (la X del panel)').toContain('sp-close');
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(ultimo);
      // CONTROL: en medio del recorrido, Tab no se intercepta.
      (fx.nativeElement.querySelector('#a') as HTMLElement).focus();
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      panel.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    } finally { HTMLElement.prototype.getClientRects = orig; }
  });
});
