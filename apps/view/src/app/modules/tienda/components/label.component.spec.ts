import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ALL_SECTIONS, LabelComponent, LabelModel, LabelSections } from './label.component';

/**
 * La etiqueta RENDERIZADA (jsdom). Los candados de `../etiqueta-hoja.spec.ts` leen el código;
 * acá se mira lo que sale en el DOM — lo que la cajera y el lector ven.
 *
 * jsdom no hace layout (`clientWidth` = 0), así que los auto-ajustes salen por su guarda de
 * "sin medida no se toca" y no se prueban acá. JsBarcode sí dibuja el SVG, así que la zona muda
 * y los dígitos legibles se pueden comprobar de verdad.
 */
const BASE: LabelModel = {
  product_id: 'p-1', sku: '20186', name: 'DULCE DE PRUEBA 50G/8', content: '50 g',
  barcode: '7501234567893', barcode_format: 'EAN13',
  piece_price: 12.5, wholesale_piece_min_qty: 3, wholesale_piece_price: 11,
  pack_size: 8, pack_price: 90, wholesale_pack_price: 85, wholesale_pack_min_qty: 3,
  box_size: 24, box_price: 250, unit_base: 'PZA', sold_by_kg: false,
};

describe('LabelComponent · lo que sale impreso', () => {
  let fix: ComponentFixture<LabelComponent>;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent ?? '';

  async function render(model: LabelModel, show: LabelSections = ALL_SECTIONS): Promise<void> {
    fix = TestBed.createComponent(LabelComponent);
    fix.componentRef.setInput('model', model);
    fix.componentRef.setInput('show', show);
    fix.detectChanges();
    // `ngOnChanges` difiere el render a un microtask y el asentamiento cuelga de FUENTES_USABLES.
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [LabelComponent] }).compileComponents();
  });

  it('un EAN-13 imprime sus 13 dígitos debajo de las barras, agrupados como en el empaque', async () => {
    await render(BASE);
    expect(el().querySelector('.etq-bc-digits')?.textContent?.trim()).toBe('7 501234 567893');
  });

  it('UPC-A y EAN-8 también llevan su número', async () => {
    await render({ ...BASE, barcode: '012345678905', barcode_format: 'UPC' });
    expect(el().querySelector('.etq-bc-digits')?.textContent?.trim()).toBe('0 12345 67890 5');
    await render({ ...BASE, barcode: '96385074', barcode_format: 'EAN8' });
    expect(el().querySelector('.etq-bc-digits')?.textContent?.trim()).toBe('9638 5074');
  });

  it('el CODE128 de respaldo NO repite el SKU debajo: ya está arriba en "Código:"', async () => {
    await render({ ...BASE, barcode: null, barcode_format: null });
    expect(el().querySelector('.etq-barcode svg rect')).toBeTruthy(); // sí hay símbolo
    expect(el().querySelector('.etq-bc-digits')).toBeNull();
    expect(texto()).toContain('20186');
  });

  it('la zona muda viaja DENTRO del SVG: 11 módulos a la izquierda y 7 a la derecha', async () => {
    await render(BASE);
    const svg = el().querySelector('.etq-barcode svg')!;
    // 95 módulos × 2 px + (11 + 7) × 2 px de zona muda = 226 unidades de viewBox.
    //
    // ⭐ Este `toMatch` destapó un defecto que 28 candados de código fuente no vieron: JsBarcode
    // escribe `width="226px"` y el componente copiaba el TEXTO al viewBox → `"0 0 226px 98px"`.
    // Medido en Chrome 152: un viewBox con unidades se IGNORA (`viewBox.baseVal` = 0,0,0,0), así
    // que el símbolo nunca se escalaba a la columna — se dibujaba a 2 px/módulo (190 px = 50.3 mm)
    // dentro de un SVG de 43.4 mm (164 px) y `overflow:hidden` se llevaba ~13 módulos del lado
    // derecho, la guarda final incluida. En pantalla se veía "un código de barras" igual. Con el
    // viewBox numérico el último módulo cae en x=164 (escala), no en x=225.8 (recorte).
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 226 98$/);
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    expect(svg.hasAttribute('width')).toBe(false); // el ancho lo manda el CSS de la columna
  });

  it('el renglón alterno del granel se apaga con el multiselect, como los demás', async () => {
    const granel: LabelModel = {
      ...BASE, unit_base: '500', sold_by_kg: true, piece_price: 30,
      pack_price: null, pack_size: null, box_price: null, box_size: null,
      wholesale_pack_price: null, wholesale_piece_price: null,
    };
    await render(granel);
    expect(texto()).toContain('Por 500 g');
    await render(granel, { ...ALL_SECTIONS, granel: false });
    expect(texto()).not.toContain('Por 500 g');
  });

  it('marca cuándo terminó de ajustarse, para que la impresión tenga qué esperar', async () => {
    await render(BASE);
    expect(el().querySelector('.etq-label')?.getAttribute('data-etq-settled')).toBeTruthy();
  });

  /**
   * ⭐ El alto medido de los renglones NO puede depender del ZOOM de la vista de hoja.
   *
   * La vista previa dibuja las etiquetas bajo transform:scale; `getBoundingClientRect()` viene
   * escalado y `clientHeight` no. Mezclarlos hacía que el mismo bloque midiera 53% menos a
   * escala 0.47 (los montos crecían hasta desbordar) y 42% más a escala 1.42 (los encogía hasta
   * el piso) — "el precio del paquete salió de otro tamaño". La hoja de impresión nunca va
   * escalada, así que medía distinto que la pantalla.
   */
  it('⭐ el alto de los renglones NO depende del zoom de la vista previa', async () => {
    await render(BASE);
    const cmp = fix.componentInstance as unknown as { altoTiers(b: HTMLElement): number; escalaVisual(b: HTMLElement): number };

    // Caja de 70 px de layout con 3 renglones de 20 px. `k` simula el transform:scale de la hoja.
    const caja = (k: number): HTMLElement => {
      const box = document.createElement('div');
      Object.defineProperty(box, 'offsetHeight', { value: 70, configurable: true });
      box.getBoundingClientRect = () => ({ height: 70 * k, top: 0, bottom: 70 * k }) as DOMRect;
      for (let i = 0; i < 3; i++) {
        const hijo = document.createElement('div');
        hijo.getBoundingClientRect = () => ({ height: 20 * k }) as DOMRect;
        box.appendChild(hijo);
      }
      return box;
    };

    const sinZoom = cmp.altoTiers(caja(1));
    expect(sinZoom).toBeCloseTo(60, 6); // 3 × 20 px de layout (jsdom no reporta rowGap)
    // 0.474 = la escala fija vieja · 0.68 laptop · 1.054 monitor 1080 · 1.418 monitor 1440.
    for (const k of [0.474, 0.68, 1.054, 1.418]) expect(cmp.altoTiers(caja(k))).toBeCloseTo(sinZoom, 6);

    // Prueba NEGATIVA en el mismo caso: con la fórmula vieja (sumar los rects sin dividir por la
    // escala) este mismo escenario SÍ cambia. O sea el caso no es degenerado y el candado mide algo.
    const crudo = (k: number) =>
      Array.from(caja(k).children).reduce((a, e) => a + (e as HTMLElement).getBoundingClientRect().height, 0);
    expect(crudo(1.418)).toBeGreaterThan(crudo(1) * 1.4);
    expect(crudo(0.474)).toBeLessThan(crudo(1) * 0.5);

    // Sin layout (jsdom, etiqueta recién creada) la escala se declara 1: nunca se divide por 0.
    expect(cmp.escalaVisual(document.createElement('div'))).toBe(1);
  });
});
