import { TestBed } from '@angular/core/testing';
import { facturaLabel, KeplerParadasComponent } from './kepler-paradas.component';
import { hojaGuia0001419 } from '../../../../testing/nuevo-embarque.fixture';
import { GuideRecipient } from '../logistica.service';

/**
 * EMB.12 — Las paradas de la guía, de sólo lectura. Se monta con TestBed para que compile el
 * template y se pruebe lo que se lee: las 13 paradas y los totales de la guía 0001419.
 */

describe('facturaLabel — kdm1.c43 en palabras', () => {
  it('F y R traen factura; N no; lo no decodificado no se adivina', () => {
    expect(facturaLabel({ facturado: true, facturacion: 'F' })).toBe('Sí');
    expect(facturaLabel({ facturado: true, facturacion: 'R' })).toBe('Sí');
    expect(facturaLabel({ facturado: false, facturacion: 'N' })).toBe('No');
    expect(facturaLabel({ facturado: false, facturacion: 'A' })).toBe('—');
    expect(facturaLabel({ facturado: null, facturacion: null })).toBe('—');
  });
});

function montar(entregas: GuideRecipient[] | null = null) {
  TestBed.configureTestingModule({ imports: [KeplerParadasComponent] });
  const f = TestBed.createComponent(KeplerParadasComponent);
  f.componentRef.setInput('hoja', hojaGuia0001419());
  f.componentRef.setInput('entregas', entregas);
  f.detectChanges();
  return f.nativeElement as HTMLElement;
}

describe('KeplerParadasComponent', () => {
  it('pinta las 13 paradas y los totales que dio Kepler', () => {
    const el = montar();
    expect(el.querySelectorAll('tbody tr').length).toBe(13);
    const pie = el.querySelector('tfoot')!.textContent!.replace(/\s+/g, ' ');
    expect(pie).toContain('13 paradas');
    expect(pie).toContain('190');
    expect(pie).toContain('85');
    expect(pie).toContain('$159,596.20');
  });

  it('al tomar el viaje muestra la nota de almacén tal cual, sin avisos', () => {
    const el = montar();
    expect(el.querySelector('thead')!.textContent).toContain('Nota de almacén');
    expect(el.textContent).toContain('26  CAJAS  2 PAQ.  B-3');
    expect(el.textContent).not.toContain('La nota dice');
  });

  it('en el embarque creado cambia la nota por lo que registró el chofer', () => {
    const el = montar([
      { id: 'r1', guide_id: 'g', customer_name: 'x', boxes_count: 67, weight_kg: 0, value: 0, status: 'entregado', kepler_folio: '0001052', kepler_serie: '1' },
      { id: 'r2', guide_id: 'g', customer_name: 'x', boxes_count: 5, weight_kg: 0, value: 0, status: 'pendiente', kepler_folio: '0001053', kepler_serie: '1' },
    ] as GuideRecipient[]);
    expect(el.querySelector('thead')!.textContent).toContain('Entrega');
    expect(el.querySelector('thead')!.textContent).not.toContain('Nota de almacén');
    const filas = [...el.querySelectorAll('tbody tr')];
    expect(filas[0].textContent).toContain('Entregado');
    expect(filas[1].textContent).toContain('Pendiente');
  });

  it('cada celda lleva su rótulo para apilarse en el teléfono', () => {
    const el = montar();
    const celdas = [...el.querySelectorAll('tbody td')];
    expect(celdas.length).toBeGreaterThan(0);
    expect(celdas.every((c) => c.getAttribute('data-label') && c.getAttribute('role') === 'cell')).toBe(true);
    expect(el.querySelector('.dt-scope .dt-stack')).not.toBeNull();
  });
});
