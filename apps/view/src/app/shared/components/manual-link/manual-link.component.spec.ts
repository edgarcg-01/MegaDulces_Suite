import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { ManualLinkComponent, direccionDelManual } from './manual-link.component';

/**
 * `[PQ.3.20]` El botón «Manual»: lleva al archivo del manual, en otra pestaña, y dice cuál es.
 */
describe('ManualLinkComponent', () => {
  function montar(manual: string, titulo: string): HTMLAnchorElement {
    TestBed.configureTestingModule({ imports: [ManualLinkComponent], providers: [provideZonelessChangeDetection()] });
    const fx = TestBed.createComponent(ManualLinkComponent);
    fx.componentRef.setInput('manual', manual);
    fx.componentRef.setInput('titulo', titulo);
    fx.detectChanges();
    return fx.nativeElement.querySelector('a') as HTMLAnchorElement;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('la dirección es la carpeta de manuales, relativa a la base de la app', () => {
    expect(direccionDelManual('calendario-compras')).toBe('assets/manuales/calendario-compras.html');
  });

  it('abre el archivo del manual en otra pestaña, sin darle acceso a la pantalla que lo abrió', () => {
    const a = montar('calendario-compras', 'Calendario de compras');
    expect(a.getAttribute('href')).toBe('assets/manuales/calendario-compras.html');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('el texto visible es «Manual» y el nombre accesible dice cuál y que se abre aparte', () => {
    const a = montar('calendario-compras', 'Calendario de compras');
    expect(a.textContent?.trim()).toBe('Manual');
    expect(a.getAttribute('aria-label')).toBe('Abrir el manual «Calendario de compras» en otra pestaña');
    expect(a.querySelector('i.pi-book')?.getAttribute('aria-hidden')).toBe('true');
  });
});
