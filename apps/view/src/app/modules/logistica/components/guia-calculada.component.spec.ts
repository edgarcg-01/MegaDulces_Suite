import { TestBed } from '@angular/core/testing';
import { viaticosDeLaGuia } from '@megadulces/contracts';
import { GuiaCalculadaComponent, PersonaDeLaGuia } from './guia-calculada.component';

/**
 * EMB.19 — La tabla de comisión y viáticos CALCULADOS: sólo lectura, una fila por persona que va.
 * Lo que importa: que no haya nada que teclear, y que lo que falta salga «—», no un $0.
 * Nombres de prueba, inventados.
 */

const TARIFAS = { cafe: 50, desayuno: 100, comida: 100, cena: 100 };
const DOS: PersonaDeLaGuia[] = [
  { key: 'driver', rol: 'Chofer', nombre: 'PRUEBA UNO' },
  { key: 'helper1', rol: 'Ayudante 1', nombre: 'PRUEBA DOS' },
];

function pintar(inputs: Record<string, unknown>) {
  TestBed.configureTestingModule({ imports: [GuiaCalculadaComponent] });
  const f = TestBed.createComponent(GuiaCalculadaComponent);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  const filas = [...el.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent!.replace(/\s+/g, ' ').trim()));
  return { el, filas, pie: el.querySelector('tfoot')!.textContent!.replace(/\s+/g, ' ').trim() };
}

describe('GuiaCalculadaComponent', () => {
  it('una fila por persona: comisión, comidas que tocan y su viático; el pie suma', () => {
    const viaticos = viaticosDeLaGuia({ salida: '05:30', llegada: '16:00', duerme_fuera: false }, TARIFAS, { driver: true, helper1: true, helper2: false });
    const { el, filas, pie } = pintar({
      personas: DOS, tarifas: TARIFAS, viaticos,
      comisiones: { driver_commission: 120, helper1_commission: 80, helper2_commission: 0 },
    });
    expect(filas).toEqual([
      ['Chofer PRUEBA UNO', '$120.00', 'Sí', 'Sí', 'Sí', '—No', '$250.00'],
      ['Ayudante 1 PRUEBA DOS', '$80.00', 'Sí', 'Sí', 'Sí', '—No', '$250.00'],
    ]);
    expect(pie).toContain('$200.00');
    expect(pie).toContain('$500.00');
    expect(el.querySelector('thead')!.textContent).toContain('$50.00'); // la tarifa de cada comida, a la vista
    expect(el.querySelector('input, select, textarea, p-inputnumber')).toBeNull();
  });

  it('lo que no se puede calcular sale «—», nunca $0', () => {
    const { filas, pie } = pintar({ personas: DOS.slice(0, 1), tarifas: TARIFAS, viaticos: null, comisiones: null });
    expect(filas).toEqual([['Chofer PRUEBA UNO', '—', '—', '—', '—', '—', '—']]);
    expect(pie).not.toContain('$0.00');
  });

  it('una comida sin tarifa no pone leyenda en el encabezado (lo que falta lo dice la lista de faltantes)', () => {
    const { el } = pintar({ personas: DOS.slice(0, 1), tarifas: { ...TARIFAS, cafe: 0 }, viaticos: null, comisiones: null });
    const cafe = [...el.querySelectorAll('thead th')].find((th) => th.textContent!.includes('Café'))!;
    expect(cafe.textContent!.trim()).toBe('Café');
  });
});
