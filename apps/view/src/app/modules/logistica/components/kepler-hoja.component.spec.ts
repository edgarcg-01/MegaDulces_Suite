import { TestBed } from '@angular/core/testing';
import { cajasDeNota, KeplerHojaComponent, notaDescuadra } from './kepler-hoja.component';
import { hojaGuia0001419, hojaSinChofer } from '../../../../testing/nuevo-embarque.fixture';
import { GuideRecipient, NuevoEmbarqueHoja } from '../logistica.service';

/**
 * EMB.12 — La hoja del viaje TAL COMO LA CAPTURÓ KEPLER.
 *
 * Se monta con TestBed a propósito: así compila el template (lo que `tsc` no mira) y se prueba
 * lo que el usuario ve — los totales de la guía 0001419, el aviso cuando la nota de almacén no
 * cuadra con los renglones, el chofer que Kepler no trae, y el estado de entrega en la hoja final.
 */

describe('cajasDeNota — las notas reales de almacén', () => {
  it.each([
    ['10  CAJAS    A-1', 10],          // Canindo: número y palabra
    ['43  CAJAS  1 PAQ.   A-4', 43],
    ['1  CAJA   2 PAQ.  C-5', 1],      // ⚠️ no 2: con la abreviatura primero se leía mal
    ['18C B5', 18],                    // pegado
    ['CJ 13 PQ 1 UB 3', 13],           // Padre Hidalgo: abreviatura y número
    ['DULCERIA ANDRADE PIAR880710898 CJ 28 UB 5', 28],
  ])('«%s» → %i cajas', (nota, esperado) => {
    expect(cajasDeNota(nota)).toBe(esperado);
  });

  it('una nota sin cajas es null, no cero', () => {
    expect(cajasDeNota('1 PAQ.  B-3')).toBeNull();
    expect(cajasDeNota('PQ 1 UB 6')).toBeNull();
    expect(cajasDeNota(null)).toBeNull();
  });

  it('avisa sólo cuando la nota contradice a los renglones', () => {
    expect(notaDescuadra({ nota_almacen: '26  CAJAS  2 PAQ.  B-3', cajas: 2 })).toBe(true); // la 0001062
    expect(notaDescuadra({ nota_almacen: '67  CAJAS  B-4', cajas: 67 })).toBe(false);
    expect(notaDescuadra({ nota_almacen: '1 PAQ.  B-3', cajas: 0 })).toBe(false);
  });
});

function montar(hoja: NuevoEmbarqueHoja, modo: 'previa' | 'final' = 'previa', entregas: GuideRecipient[] = []) {
  TestBed.configureTestingModule({ imports: [KeplerHojaComponent] });
  const f = TestBed.createComponent(KeplerHojaComponent);
  f.componentRef.setInput('hoja', hoja);
  f.componentRef.setInput('modo', modo);
  f.componentRef.setInput('entregas', entregas);
  f.detectChanges();
  return f.nativeElement as HTMLElement;
}

describe('KeplerHojaComponent', () => {
  it('pinta las 13 paradas y los totales que dio Kepler para la guía 0001419', () => {
    const el = montar(hojaGuia0001419());
    expect(el.querySelectorAll('tbody tr').length).toBe(13);
    const pie = el.querySelector('tfoot')!.textContent!.replace(/\s+/g, ' ');
    expect(pie).toContain('4 rutas');
    expect(pie).toContain('7 clientes');
    expect(pie).toContain('190');
    expect(pie).toContain('85');
    expect(pie).toContain('$159,596.20');
  });

  it('en previa dice de qué columna de Kepler sale cada dato', () => {
    const el = montar(hojaGuia0001419());
    const texto = el.textContent!;
    expect(texto).toContain('kdm1.c83 → kdm_transporte');
    expect(texto).toContain('kdudent.c13 → kdm_rutas');
  });

  it('declara el peso como «Sin medir», nunca como cero', () => {
    const el = montar(hojaGuia0001419());
    const carga = el.querySelector('.kh-carga')!.textContent!;
    expect(carga).toContain('Sin medir');
    expect(carga).toContain('39 kg vendidos por kilo');
    expect(carga).not.toMatch(/Peso\s*0\b/);
  });

  it('avisa en la parada 0001062 que la nota dice 26 cajas y los renglones 2', () => {
    const el = montar(hojaGuia0001419());
    const avisos = [...el.querySelectorAll('.kh-pill.is-warn')].map((x) => x.textContent!.trim());
    expect(avisos).toContain('La nota dice 26 cajas; los renglones, 2');
  });

  it('cuando Kepler no trae chofer lo dice, y marca el dato como faltante', () => {
    const el = montar(hojaSinChofer());
    const campo = [...el.querySelectorAll('.kh-field')].find((x) => x.textContent!.includes('Chofer'))!;
    expect(campo.classList).toContain('is-missing');
    expect(campo.textContent).toContain('No viene en Kepler');
  });

  it('en la hoja final cambia la nota por el estado de entrega que captura el chofer', () => {
    const entregas = [
      { id: 'r1', guide_id: 'g', customer_name: 'x', boxes_count: 67, weight_kg: 0, value: 0, status: 'entregado', kepler_folio: '0001052', kepler_serie: '1' },
      { id: 'r2', guide_id: 'g', customer_name: 'x', boxes_count: 5, weight_kg: 0, value: 0, status: 'pendiente', kepler_folio: '0001053', kepler_serie: '1' },
    ] as GuideRecipient[];
    const el = montar(hojaGuia0001419(), 'final', entregas);
    expect(el.querySelector('thead')!.textContent).toContain('Entrega');
    expect(el.querySelector('thead')!.textContent).not.toContain('Nota de almacén');
    const filas = [...el.querySelectorAll('tbody tr')];
    expect(filas[0].textContent).toContain('Entregado');
    expect(filas[1].textContent).toContain('Pendiente');
    expect(filas[2].textContent).toContain('Sin registro');
    // Sin el andamio de columnas de Kepler en la hoja final.
    expect(el.textContent).not.toContain('kdm1.c83');
  });

  it('cada celda lleva su rótulo para apilarse en el teléfono', () => {
    const el = montar(hojaGuia0001419());
    const celdas = [...el.querySelectorAll('tbody td')];
    expect(celdas.length).toBeGreaterThan(0);
    expect(celdas.every((c) => c.getAttribute('data-label') && c.getAttribute('role') === 'cell')).toBe(true);
    expect(el.querySelector('.dt-scope .dt-stack')).not.toBeNull();
  });
});
