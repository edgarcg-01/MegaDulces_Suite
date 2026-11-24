import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { PrecioListaToggleComponent, textoPrecioLista } from './precio-lista-toggle.component';

describe('[COT.55] textoPrecioLista — el estado en palabras', () => {
  it('sin permiso siempre dice quién lo cambia', () => {
    expect(textoPrecioLista(false, null, false)).toBe('Lo cambia un supervisor.');
    expect(textoPrecioLista(true, true, false)).toBe('Así lo tiene el cliente. Lo cambia un supervisor.');
  });
  it('con permiso y como lo tiene el cliente', () => {
    expect(textoPrecioLista(true, true, true)).toBe('Así lo tiene el cliente.');
    expect(textoPrecioLista(false, false, true)).toBeNull();
  });
  it('con permiso y distinto del cliente, dice cómo va el cliente', () => {
    expect(textoPrecioLista(true, false, true)).toBe('El cliente va con mayoreo.');
    expect(textoPrecioLista(false, true, true)).toBe('El cliente va a precio 1.');
  });
  it('sin cliente de Kepler no hay nada que decir', () => {
    expect(textoPrecioLista(true, null, true)).toBeNull();
  });
});

describe('[COT.55] PrecioListaToggleComponent', () => {
  function montar(e: { valor?: boolean; delCliente?: boolean | null; puede?: boolean }) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [PrecioListaToggleComponent], providers: [provideZonelessChangeDetection()] });
    const f = TestBed.createComponent(PrecioListaToggleComponent);
    f.componentRef.setInput('valor', e.valor ?? false);
    f.componentRef.setInput('delCliente', e.delCliente ?? null);
    f.componentRef.setInput('puede', e.puede ?? false);
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }

  it('sin permiso el interruptor está apagado para moverse y no ofrece fijarlo', () => {
    const { el } = montar({ valor: true, delCliente: false, puede: false });
    expect(el.querySelector('input')?.disabled).toBe(true);
    expect(el.querySelector('.pl-fijar')).toBeNull();
    expect(el.textContent).toContain('Lo cambia un supervisor.');
  });

  it('con permiso y distinto del cliente, ofrece «Dejarlo así para este cliente» y avisa al pulsarlo', () => {
    const { f, el } = montar({ valor: true, delCliente: false, puede: true });
    let fijado = false;
    f.componentInstance.fijarCliente.subscribe(() => (fijado = true));
    const b = el.querySelector<HTMLButtonElement>('.pl-fijar');
    expect(b?.textContent).toContain('Dejarlo así para este cliente');
    b!.click();
    expect(fijado).toBe(true);
  });

  it('la etiqueta nombra al interruptor (lector de pantalla y clic en el texto)', () => {
    const { el } = montar({ puede: true });
    expect(el.querySelector('label[for="precioListaSwitch"]')?.textContent).toContain('Solo precio 1 (sin mayoreo)');
  });
});
