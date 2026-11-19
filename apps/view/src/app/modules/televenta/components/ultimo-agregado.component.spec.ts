/**
 * `[COT.46]` La confirmación de lo último que entró a la lista, debajo del buscador: en una lista
 * larga el renglón cae fuera de la pantalla y el aviso de esquina se iba solo.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';

import { UltimoAgregadoComponent, textoAgregado, type UltimoAgregado } from './ultimo-agregado.component';

function pintar(info: UltimoAgregado | null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [UltimoAgregadoComponent], providers: [provideZonelessChangeDetection()] });
  const f = TestBed.createComponent(UltimoAgregadoComponent);
  f.componentRef.setInput('info', info);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  return { f, el, texto: (el.textContent ?? '').replace(/\s+/g, ' ').trim() };
}

describe('[COT.46] textoAgregado', () => {
  it('cantidad, unidad e importe en pesos', () => {
    expect(textoAgregado(10, 'CJA', 2573.02)).toBe('10 CJA · $2,573.02');
  });
  it('sin importe (renglón sin precio) sólo la cantidad', () => {
    expect(textoAgregado(3, 'PAQ', null)).toBe('3 PAQ');
  });
});

describe('[COT.46] UltimoAgregadoComponent', () => {
  const MAMUT: UltimoAgregado = { id: 'r23', numero: 23, nombre: 'GALL MINI MAMUT GAMESA', detalle: '10 CJA · $2,573.02', sumado: false };

  it('dice el número de renglón, el producto y lo agregado', () => {
    expect(pintar(MAMUT).texto).toBe('Renglón 23: GALL MINI MAMUT GAMESA · 10 CJA · $2,573.02 · Ver en la lista');
  });

  it('si se sumó a uno que ya estaba, lo dice', () => {
    expect(pintar({ ...MAMUT, numero: 5, sumado: true, detalle: 'ahora 15 CJA' }).texto).toMatch(/^Sumado al renglón 5: GALL MINI MAMUT GAMESA · ahora 15 CJA/);
  });

  it('la región viva existe aunque no haya nada (un aria-live que nace con su texto no se anuncia)', () => {
    const { el, texto } = pintar(null);
    expect(el.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(texto).toBe('');
  });

  it('«Ver en la lista» emite el id del renglón; sin id, no se ofrece', () => {
    const { f, el } = pintar(MAMUT);
    let visto: string | null = null;
    f.componentInstance.ver.subscribe((id) => (visto = id));
    el.querySelector<HTMLButtonElement>('button.ver')!.click();
    expect(visto).toBe('r23');
    expect(pintar({ ...MAMUT, id: null }).el.querySelector('button.ver')).toBeNull();
  });
});
