import { TestBed } from '@angular/core/testing';
import { costoEstimado, KeplerCostoComponent } from './kepler-costo.component';
import { DeliveryGuide, Driver } from '../logistica.service';

/**
 * EMB.12 — El costo estimado del viaje en la hoja final, con los números de la maqueta:
 * comisiones $103.20 + $63.84, gasto de Kepler atribuido $2,661.22, valor $159,596.20.
 */

const guia = (over: Partial<DeliveryGuide> = {}): DeliveryGuide => ({
  id: 'g1', number: 'GUIA-2026-00001', shipment_id: 's1', type: 'entrega', status: 'pendiente',
  driver_id: 'd1', driver_commission: 103.2, helper1_id: 'd2', helper1_commission: 63.84,
  helper2_id: null, helper2_commission: 0, overnight: false, per_diem_total: 0,
  ...over,
} as DeliveryGuide);

describe('costoEstimado', () => {
  it('suma comisiones, viáticos y el gasto de Kepler, y da las dos lecturas del costo', () => {
    const c = costoEstimado(guia(), 2661.22, 159596.2);
    expect(c.comisiones).toBe(167.04);
    expect(c.total).toBe(2828.26);
    expect(c.pct_sobre_valor).toBe(1.77);
    expect(c.movido_por_peso).toBe(56.43);
    expect(c.incompleto).toBe(false);
  });

  it('sin gasto de Kepler medible: el total no lo incluye y lo DICE (no lo pone en cero)', () => {
    const c = costoEstimado(guia(), null, 159596.2);
    expect(c.gastos_kepler).toBeNull();
    expect(c.incompleto).toBe(true);
    expect(c.total).toBe(167.04);
  });

  it('sin valor o sin costo, los cocientes son null en vez de dividir entre cero', () => {
    expect(costoEstimado(guia(), 0, 0).pct_sobre_valor).toBeNull();
    expect(costoEstimado(null, 0, 1000).movido_por_peso).toBeNull();
  });
});

describe('KeplerCostoComponent', () => {
  it('pone nombre a la tripulación y declara el gasto sin medir', () => {
    TestBed.configureTestingModule({ imports: [KeplerCostoComponent] });
    const f = TestBed.createComponent(KeplerCostoComponent);
    f.componentRef.setInput('guia', guia());
    f.componentRef.setInput('personas', [
      { id: 'd1', full_name: 'César C.' }, { id: 'd2', full_name: 'Manuel M.' },
    ] as Driver[]);
    f.componentRef.setInput('valor', 159596.2);
    f.componentRef.setInput('gastosKepler', null);
    f.componentRef.setInput('motivoGastos', 'Sin permiso para ver gastos: el total no incluye el gasto de Kepler.');
    f.detectChanges();
    const t = (f.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('Chofer · César C.');
    expect(t).toContain('Ayudante 1 · Manuel M.');
    expect(t).toContain('Sin medir');
    expect(t).toContain('Sin permiso para ver gastos');
    expect(t).toContain('$167.04');
  });
});
