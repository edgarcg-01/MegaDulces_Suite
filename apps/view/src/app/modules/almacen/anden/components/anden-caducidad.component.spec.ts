import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AndenCaducidadComponent, FechadoConfirmado } from './anden-caducidad.component';
import { AndenLinea } from '../anden.state';

/**
 * **Varias caducidades en un mismo renglón** (WMS-REC.9).
 *
 * Es el caso normal, no la excepción: llegan 6 cajas de un lote y 4 de otro. Lo
 * que se prueba acá es lo que puede costar mercancía:
 *
 *  - que la suma de las fechas **no pase** de lo que Kepler manda,
 *  - que una fecha se pueda **quitar antes de guardar** (mientras está en la
 *    lista todavía no tocó el inventario),
 *  - que al guardar salgan **todas**, no la última,
 *  - y que la cantidad se diga en la **unidad del vale**, que en el 73.6 % de los
 *    renglones no es la pieza.
 */
function linea(over: Partial<AndenLinea> = {}): AndenLinea {
  return {
    id: 'l1', product_id: 'p1', sku: '10211', product_name: 'GALL ARTESANALES',
    expected_qty: 100, received_qty: 0, discrepancy_kind: 'pending',
    declared_qty: 0, held_qty: 0, expected_unit: 'PAQ',
    uxc: null, declarado: 0, retenido: 0, faltaFechar: 100, binSugerido: null,
    ...over,
  } as AndenLinea;
}

describe('AndenCaducidadComponent · varias caducidades en un renglón', () => {
  let fix: ComponentFixture<AndenCaducidadComponent>;
  let c: AndenCaducidadComponent;

  const texto = (): string => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(l: AndenLinea = linea()): Promise<void> {
    fix = TestBed.createComponent(AndenCaducidadComponent);
    fix.componentRef.setInput('linea', l);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
  }

  /** Llena el formulario como lo llenaría el operario. */
  function capturar(digitos: string, cantidad: number, lote = ''): void {
    c.setFecha(digitos);
    c.lote.set(lote);
    c.setCantidad(String(cantidad));
    fix.detectChanges();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AndenCaducidadComponent] }).compileComponents();
  });

  it('la cantidad arranca con todo lo que falta: una sola fecha no se toca', async () => {
    await render();
    expect(c.cantidad()).toBe(100);
    expect(c.libre()).toBe(100);
  });

  it('agregar una fecha descuenta del resto y deja el formulario limpio para la siguiente', async () => {
    await render();
    capturar('300427', 40, 'A1');
    c.agregarOtra();
    fix.detectChanges();

    expect(c.entradas().length).toBe(1);
    expect(c.entradas()[0]).toMatchObject({ cantidad: 40, lote: 'A1', caducidadIso: '2027-04-30' });
    // El formulario queda vacío y la cantidad repuesta con lo que falta.
    expect(c.fechaRaw()).toBe('');
    expect(c.lote()).toBe('');
    expect(c.libre()).toBe(60);
    expect(c.cantidad()).toBe(60);
  });

  it('guardar emite TODAS las fechas: la lista más la que está en el formulario', async () => {
    await render();
    const emitidas: FechadoConfirmado[] = [];
    c.confirmar.subscribe((f) => emitidas.push(f));

    capturar('300427', 40, 'A1');
    c.agregarOtra();
    capturar('310827', 25, 'A2');
    c.agregarOtra();
    capturar('301227', 35, 'A3');
    c.emitir();

    expect(emitidas.length).toBe(1);
    expect(emitidas[0].entradas.map((e) => [e.caducidadIso, e.cantidad])).toEqual([
      ['2027-04-30', 40],
      ['2027-08-31', 25],
      ['2027-12-30', 35],
    ]);
  });

  it('quitar una fecha de la lista devuelve su cantidad al resto — todavía no tocó el inventario', async () => {
    await render();
    capturar('300427', 40, 'A1');
    c.agregarOtra();
    capturar('310827', 25, 'A2');
    c.agregarOtra();
    expect(c.libre()).toBe(35);

    c.quitar(0);
    fix.detectChanges();
    expect(c.entradas().length).toBe(1);
    expect(c.entradas()[0].caducidadIso).toBe('2027-08-31');
    expect(c.libre()).toBe(75);
  });

  it('no deja agregar otra cuando lo capturado ya cubre todo lo que falta', async () => {
    // Si el renglón ya quedó completo, "otra fecha" sólo puede declarar de más.
    await render();
    capturar('300427', 100);
    expect(c.puedeAgregarOtra()).toBe(false);

    c.setCantidad('60');
    fix.detectChanges();
    expect(c.puedeAgregarOtra()).toBe(true);
  });

  it('avisa cuando la misma caducidad se captura dos veces en el mismo renglón', async () => {
    await render();
    capturar('300427', 40);
    c.agregarOtra();
    capturar('300427', 20);
    expect(c.repetida()).toBe(true);
    expect(texto()).toContain('ya agregaste esta fecha');
  });

  it('con la lista cargada se puede guardar aunque el formulario esté vacío', async () => {
    await render();
    capturar('300427', 40);
    c.agregarOtra();
    fix.detectChanges();
    // El effect repone la cantidad con lo que queda libre, así que el operario
    // que ya agregó todo lo que trajo tiene que poder mandarlo igual.
    c.setCantidad('0');
    fix.detectChanges();
    expect(c.puedeGuardar()).toBe(true);
  });

  it('la cantidad se dice en la unidad del VALE, no en piezas', async () => {
    // Medido: 68,440 de 93,030 renglones no se cuentan en piezas (PAQ domina).
    await render(linea({ expected_unit: 'PAQ' }));
    expect(c.unidad()).toBe('paq');
    expect(texto()).toContain('100 paq');

    await render(linea({ expected_unit: 'CJA' }));
    expect(c.unidad()).toBe('cja');

    // El centinela de ambigüedad del backend NO es una unidad.
    await render(linea({ expected_unit: 'ambigua' }));
    expect(c.unidad()).toBe('unidades');

    await render(linea({ expected_unit: null }));
    expect(c.unidad()).toBe('unidades');
  });

  it('una captura suelta (fuera del vale) no arrastra la lista del renglón anterior', async () => {
    await render();
    capturar('300427', 40);
    c.agregarOtra();
    expect(c.entradas().length).toBe(1);

    // `limpiar()` es lo que el padre llama al abrir otro renglón.
    c.limpiar();
    fix.detectChanges();
    expect(c.entradas()).toEqual([]);
    expect(c.cantidad()).toBe(100);
  });
});
