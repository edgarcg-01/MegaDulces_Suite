import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SdAdjuntosComponent } from './sd-adjuntos.component';

/** Un padre mínimo: `archivos`/`enlaces`/`optimizando` van enlazados en los dos sentidos, como en las pantallas reales. */
@Component({
  standalone: true,
  imports: [SdAdjuntosComponent],
  template: `<app-sd-adjuntos [(archivos)]="archivos" [(enlaces)]="enlaces" [(optimizando)]="optimizando" />`,
})
class PadreComponent {
  readonly archivos = signal<File[]>([]);
  readonly enlaces = signal<string[]>([]);
  readonly optimizando = signal(false);
}

const png = (n: string) => new File(['x'], n, { type: 'image/png' });

/** Un evento de arrastre con los `types` y `files` que trae un arrastre real desde el escritorio. */
function arrastre(tipo: string, over: { types?: string[]; files?: File[] } = {}): Event {
  const ev = new Event(tipo, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types: over.types ?? ['Files'], files: over.files ?? [], dropEffect: 'none' } });
  return ev;
}

describe('[MS.ADJ.3.1/3.3] SdAdjuntosComponent: soltar archivos y enlaces de Google', () => {
  let fix: ComponentFixture<PadreComponent>;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const zona = (): HTMLElement => el().querySelector('.adj') as HTMLElement;
  const alerta = (): string => el().querySelector('[role=alert]')?.textContent?.trim() ?? '';
  const esperar = async () => { await vi.waitFor(() => expect(fix.componentInstance.optimizando()).toBe(false)); fix.detectChanges(); };

  beforeEach(() => {
    fix = TestBed.configureTestingModule({ imports: [PadreComponent] }).createComponent(PadreComponent);
    fix.detectChanges();
  });

  it('⭐ soltar imágenes y PDF desde el escritorio los agrega a la lista', async () => {
    const pdf = new File(['%PDF'], 'oficio.pdf', { type: 'application/pdf' });
    zona().dispatchEvent(arrastre('drop', { files: [png('a.png'), pdf] }));
    await esperar();
    expect(fix.componentInstance.archivos().map((f) => f.name)).toEqual(['a.png', 'oficio.pdf']);
    expect(alerta()).toBe('');
    expect(el().textContent).toContain('a.png');
  });

  it('⛔ NEGATIVA — soltar Word/Excel/PowerPoint NO agrega nada y dice a dónde ir (enlace de Google)', async () => {
    const docx = new File(['x'], 'informe.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const xls = new File(['x'], 'cifras.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    zona().dispatchEvent(arrastre('drop', { files: [docx, xls] }));
    fix.detectChanges();
    expect(fix.componentInstance.archivos()).toEqual([]);
    expect(alerta()).toContain('informe.docx');
    expect(alerta()).toContain('enlace de Google');
  });

  it('lo bueno entra aunque venga mezclado con lo rechazado', async () => {
    zona().dispatchEvent(arrastre('drop', { files: [new File(['x'], 'a.zip', { type: 'application/zip' }), png('b.png')] }));
    await esperar();
    expect(fix.componentInstance.archivos().map((f) => f.name)).toEqual(['b.png']);
    expect(alerta()).toContain('a.zip');
  });

  it('⛔ NEGATIVA — el tope de 5 archivos se respeta al soltar', async () => {
    zona().dispatchEvent(arrastre('drop', { files: Array.from({ length: 7 }, (_, i) => png(`f${i}.png`)) }));
    await esperar();
    expect(fix.componentInstance.archivos()).toHaveLength(5);
    expect(alerta()).toContain('Máximo 5');
  });

  it('la zona se enciende SOLO con un arrastre de archivos (no con texto) y dice «Suelta aquí»', () => {
    zona().dispatchEvent(arrastre('dragenter', { types: ['text/plain'] }));
    fix.detectChanges();
    expect(zona().classList.contains('arrastrando')).toBe(false);
    zona().dispatchEvent(arrastre('dragenter'));
    fix.detectChanges();
    expect(zona().classList.contains('arrastrando')).toBe(true);
    expect(el().textContent).toContain('Suelta aquí');
    zona().dispatchEvent(arrastre('dragleave'));
    fix.detectChanges();
    expect(zona().classList.contains('arrastrando')).toBe(false);
  });

  it('⛔ NEGATIVA — soltar un archivo FUERA de la zona no navega la pestaña (se cancela el drop)', () => {
    const fuera = arrastre('drop', { files: [png('x.png')] });
    document.body.dispatchEvent(fuera);
    expect(fuera.defaultPrevented).toBe(true);
    const texto = arrastre('drop', { types: ['text/plain'] });
    document.body.dispatchEvent(texto);
    expect(texto.defaultPrevented).toBe(false); // arrastrar texto no se toca
  });

  it('un enlace de Google válido se agrega; se puede quitar', () => {
    const c = fix.debugElement.children[0].componentInstance as SdAdjuntosComponent;
    c.abrirEnlace();
    c.textoEnlace.set('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing');
    c.agregarEnlace();
    fix.detectChanges();
    expect(fix.componentInstance.enlaces()).toEqual(['https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing']);
    expect(c.pidiendoEnlace()).toBe(false);
    c.quitarEnlace(fix.componentInstance.enlaces()[0]);
    expect(fix.componentInstance.enlaces()).toEqual([]);
  });

  it.each([
    ['otro dominio', 'https://evil.com/doc'],
    ['host por sufijo', 'https://docs.google.com.evil.com/document/d/1AbCdEfGhIjKlMnOp'],
    ['http', 'http://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit'],
  ])('⛔ NEGATIVA — enlace no aceptado (%s): no se agrega y se avisa', (_n, url) => {
    const c = fix.debugElement.children[0].componentInstance as SdAdjuntosComponent;
    c.abrirEnlace();
    c.textoEnlace.set(url);
    c.agregarEnlace();
    fix.detectChanges();
    expect(fix.componentInstance.enlaces()).toEqual([]);
    expect(alerta()).toContain('Google');
  });

  it('⛔ NEGATIVA — el cuarto enlace se rechaza', () => {
    const c = fix.debugElement.children[0].componentInstance as SdAdjuntosComponent;
    for (const n of [1, 2, 3, 4]) {
      c.abrirEnlace();
      c.textoEnlace.set(`https://docs.google.com/document/d/1AbCdEfGhIjKlMnO${n}/edit`);
      c.agregarEnlace();
    }
    fix.detectChanges();
    expect(fix.componentInstance.enlaces()).toHaveLength(3);
    expect(alerta()).toContain('Máximo 3');
  });
});
