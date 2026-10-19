import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { SegmentedComponent, type SegOption } from './segmented.component';

/**
 * Candado del control segmentado. Lo montan **48 pantallas**, así que lo que se prueba acá no es
 * la variante nueva: es que agregarla no se lleve puestas las otras cuarenta y siete.
 *
 * El componente nació sin spec. Su hermano `app-side-peek` —misma situación— ya tuvo un defecto
 * de este tipo que dejó 8 de 10 pantallas pintadas y sin responder, y nadie lo vio hasta prod.
 */
describe('SegmentedComponent — el conteo es aditivo', () => {
  let fx: ReturnType<typeof TestBed.createComponent<SegmentedComponent>>;

  function montar(options: SegOption[], value = options[0]?.value ?? '') {
    TestBed.configureTestingModule({
      imports: [SegmentedComponent],
      providers: [provideZonelessChangeDetection()],
    });
    fx = TestBed.createComponent(SegmentedComponent);
    fx.componentRef.setInput('options', options);
    fx.componentRef.setInput('value', value);
    fx.detectChanges();
    return fx;
  }

  const botones = (): HTMLElement[] =>
    Array.from(fx.nativeElement.querySelectorAll('.seg-btn'));

  beforeEach(() => TestBed.resetTestingModule());

  it('⭐ SIN count, el control queda exactamente como estaba', () => {
    // Esto es lo que protege a las 48 pantallas que ya lo montan.
    montar([{ label: 'Todo', value: '' }, { label: 'Entradas', value: 'ingreso' }]);
    expect(fx.nativeElement.querySelectorAll('.seg-n').length,
      'apareció un conteo donde nadie lo pidió').toBe(0);
    expect(botones()[0].textContent?.trim()).toBe('Todo');
  });

  it('con count, el número va DENTRO del botón — o sea, en el nombre accesible', () => {
    /**
     * ⚠️ Dentro y no en un `title`: un número en el title no se anuncia y no existe para quien
     * navega con teclado. El lector tiene que decir «Egresos 117», no «Egresos».
     */
    montar([{ label: 'Egresos', value: 'eg', count: 117 }]);
    const b = botones()[0];
    expect(b.querySelector('.seg-n')?.textContent?.trim()).toBe('117');
    expect(b.textContent?.replace(/\s+/g, ' ').trim()).toBe('Egresos 117');
  });

  it('⛔ count = 0 SÍ se dibuja: cero es una medición', () => {
    // «No hay ninguno» es información; esconderlo obligaría a tocar el filtro para enterarse.
    montar([{ label: 'Bóveda', value: 'caos', count: 0 }]);
    expect(botones()[0].querySelector('.seg-n')?.textContent?.trim()).toBe('0');
  });

  it('⛔ [negativa] count undefined NO se dibuja como cero', () => {
    // ADR-056: lo que no se midió se declara, nunca se dibuja en cero. Si el servidor todavía
    // no manda el conteo, el acceso sale sin número — no con un 0 que afirma que no hay trabajo.
    montar([{ label: 'Ruta', value: 'ruta' }]);
    expect(botones()[0].textContent?.trim()).toBe('Ruta');
    expect(botones()[0].querySelector('.seg-n')).toBeNull();
  });

  it('⛔ en Alto Contraste la opción elegida se distingue SIN depender del color', () => {
    /**
     * La flota es Windows y `forced-colors` es el tercer modo. Ahí el fondo y el texto los
     * sustituye el sistema y el `box-shadow` **no se dibuja**: las tres señales con que este
     * control marcaba la opción activa eran la misma señal, y desaparecían juntas.
     *
     * ⚠️ Se afirma sobre la HOJA DE ESTILO y no sobre el estilo computado, a propósito: ningún
     * entorno de prueba renderiza `forced-colors`, así que un `getComputedStyle` daría verde
     * sobre un modo que nadie ejerció — que es peor que no probarlo.
     */
    const css = (SegmentedComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('\n');
    expect(css, 'no hay bloque forced-colors').toContain('forced-colors: active');
    const bloque = css.slice(css.indexOf('forced-colors: active'));
    expect(bloque, 'la opción activa no se marca en Alto Contraste').toContain('.seg-btn.on');
    expect(/outline\s*:\s*2px solid Highlight/.test(bloque),
      'se marcó con algo que forced-colors no dibuja (background/box-shadow)').toBe(true);
  });

  it('el teclado no cambió: UNA parada de Tab y las flechas mueven la selección', () => {
    const ops: SegOption[] = [
      { label: 'A', value: 'a', count: 1 },
      { label: 'B', value: 'b', count: 2 },
      { label: 'C', value: 'c' },
    ];
    montar(ops, 'a');

    // Roving: sólo la activa es tabulable.
    expect(botones().map((b) => b.tabIndex)).toEqual([0, -1, -1]);

    let elegido = '';
    fx.componentInstance.valueChange.subscribe((v: string) => { elegido = v; });
    botones()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(elegido, 'la flecha no movió la selección').toBe('b');
  });
});
