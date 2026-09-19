import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ALL_SECTIONS, LabelComponent, LabelModel, LabelSections, MEDIDOR_DE_TEXTO } from './label.component';

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
    // `ngOnChanges` difiere el render a un microtask; la medición corre en el siguiente cuadro
    // (`requestAnimationFrame`, fuera de la zona de Angular) — se espera un cuadro de verdad.
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    await frame();
    fix.detectChanges();
  }
  /** Un cuadro de animación: cuando corre `ajustar()`. */
  const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

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
   * ⭐ El ajuste reacciona a LO QUE SE MIDE. Tres insumos (texto, tipografía, geometría —esta
   * última no se puede ejercer en jsdom, que no tiene ResizeObserver) y una NEGATIVA: lo que los
   * ajustes ESCRIBEN (`style`) no puede volver a disparar el ajuste, o es un lazo. Y la firma:
   * dos pedidos sin cambio = cero pases.
   */
  describe('⭐ vuelve a medir cuando cambia el insumo, y sólo entonces', () => {
    const cmp = () => fix.componentInstance as unknown as { layout(): void; programar(): void };
    const espiar = () => vi.spyOn(cmp(), 'layout');
    const dosCuadros = async () => { await frame(); await frame(); };

    it('un cambio de TEXTO que no pasa por Angular (el modelo mutado en sitio) re-mide', async () => {
      await render(BASE);
      await frame();
      const spy = espiar();
      // Como si el precio del ERP hubiera llegado después de la primera medida.
      el().querySelector('.etq-price')!.textContent = '$1,234.56';
      await dosCuadros();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('NEGATIVA: escribir `style` (lo que hacen los ajustes) NO re-mide — sin esto sería un lazo', async () => {
      await render(BASE);
      await frame();
      const spy = espiar();
      (el().querySelector('.etq-price') as HTMLElement).style.fontSize = '9mm';
      (el().querySelector('.etq-label') as HTMLElement).style.setProperty('--x', '1');
      await dosCuadros();
      expect(spy).not.toHaveBeenCalled();
    });

    it('cuando el navegador avisa que llegó una fuente (`loadingdone`) re-mide con la verdad nueva', async () => {
      const original = Object.getOwnPropertyDescriptor(document, 'fonts');
      const fake = new EventTarget() as EventTarget & { check: (s: string) => boolean; load: () => Promise<void> };
      fake.check = () => false;
      fake.load = () => Promise.resolve();
      Object.defineProperty(document, 'fonts', { value: fake, configurable: true });
      try {
        await render(BASE);
        await frame();
        // Sin fuentes la etiqueta lo declara…
        const raiz = el().querySelector('.etq-label')!;
        expect(raiz.getAttribute('data-etq-settled')).toBe('fallback');
        const spy = espiar();
        // …llega la familia: la firma cambia (fuentesOk false → true) y se re-mide UNA vez.
        fake.check = () => true;
        fake.dispatchEvent(new Event('loadingdone'));
        await dosCuadros();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(raiz.getAttribute('data-etq-settled')).toBe('fonts');
        // NEGATIVA: el mismo aviso sin cambio real no re-mide.
        fake.dispatchEvent(new Event('loadingdone'));
        await dosCuadros();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        if (original) Object.defineProperty(document, 'fonts', original);
        else delete (document as unknown as Record<string, unknown>)['fonts'];
      }
    });

    it('misma firma → NO re-mide: dos pedidos seguidos sin cambio son cero pases', async () => {
      await render(BASE);
      await frame();
      const spy = espiar();
      cmp().programar();
      cmp().programar();
      await dosCuadros();
      expect(spy).not.toHaveBeenCalled();
      // …pero la marca para la impresión se REPONE aunque no haya habido pase.
      expect(el().querySelector('.etq-label')?.getAttribute('data-etq-settled')).toBeTruthy();
    });

    /**
     * ⭐⭐ EL BUG DE YURÉCUARO (2026-09-15), ejercido.
     *
     * `document.fonts` dice "cargada" ANTES de que el navegador vuelva a maquetar el texto que la
     * usa. El ajuste crece contra el ancho VIEJO (más chico) hasta el techo, y cuando entra Anton
     * el número se ensancha y desborda. Rastro real: `15mm | 91 | 120 | fuentes` — 91 px es el
     * ancho que ese `$86.00` tiene a 10.75 mm, no a 15.
     *
     * Acá el re-maquetado tardío llega SIN ningún evento (ni resize, ni loadingdone, ni cambio de
     * texto): sólo cambia el ancho medido. Se corrige porque la firma vigila la MEDIDA, y porque
     * cada pase que maqueta pide un pase de verificación.
     */
    it('⭐ una re-maquetación TARDÍA se corrige sola, sin que ningún evento la avise', async () => {
      await render(BASE);
      await frame();
      const price = el().querySelector('.etq-price') as HTMLElement;
      let ancho = 91; // lo que mide con la maquetación de la tipografía anterior
      Object.defineProperty(price, 'offsetWidth', { get: () => ancho, configurable: true });
      const spy = espiar();
      cmp().programar();
      await frame(); // pase 1: la firma cambió (91) → maqueta y pide verificación
      ancho = 127; // el navegador re-maquetó con Anton; nadie avisó
      await frame(); // pase 2 (la verificación): lo detecta y vuelve a ajustar
      expect(spy).toHaveBeenCalledTimes(2);
      // …y CONVERGE: sin más cambios deja de maquetar (si no, sería un lazo por cuadro).
      await dosCuadros();
      await dosCuadros();
      expect(spy).toHaveBeenCalledTimes(2);
    });

    /**
     * ⭐⭐ LA PROPIEDAD QUE CIERRA EL DEFECTO: el DOM ya no decide el tamaño.
     *
     * Cuatro entregas (ET.5, ET.6, ET.6b, ET.6c) fueron la misma forma de arreglo —"medir el DOM
     * en el momento correcto"— y las cuatro fallaron, porque lo frágil no era el momento sino
     * medir el DOM. Acá `offsetWidth` MIENTE de las dos maneras posibles: primero devuelve 0 (lo
     * que hacía crecer el número hasta el techo de 15 mm, el desborde reportado) y después un
     * número enorme (lo que lo hundiría hasta el piso de 4.5 mm).
     *
     * Con el tamaño calculado desde las métricas de la tipografía, **las dos mentiras dan el mismo
     * resultado**. Si algún día alguien vuelve a hacer que el ancho salga del elemento, estas dos
     * lecturas se separan y esta prueba se pone roja.
     */
    it('⭐⭐ el DOM ya no decide: con `offsetWidth` mintiendo en las dos direcciones, el tamaño es el mismo', async () => {
      const original = Object.getOwnPropertyDescriptor(document, 'fonts');
      Object.defineProperty(document, 'fonts', {
        value: { check: () => true, load: () => Promise.resolve() }, configurable: true,
      });
      // Métricas de mentira pero COHERENTES: cada carácter ocupa 0.45 del cuerpo con que se dibuja.
      const medidor = vi.spyOn(MEDIDOR_DE_TEXTO, 'ancho').mockImplementation((txt: string, fuente: string) => {
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(fuente)?.[1] ?? 0);
        return txt.length * px * 0.45;
      });
      try {
        await render(BASE);
        await frame();
        const price = el().querySelector('.etq-price') as HTMLElement;
        const box = price.parentElement as HTMLElement;
        // jsdom no maqueta: se le da a la caja una geometría, que es lo ÚNICO del DOM que se sigue
        // leyendo (y es estable: viene de un ancho fijo en milímetros).
        price.style.fontFamily = 'Anton, sans-serif';
        Object.defineProperty(box, 'clientWidth', { value: 120, configurable: true });
        Object.defineProperty(box, 'clientHeight', { value: 60, configurable: true });
        // ⚠️ Las dos mentiras tienen que ser distintas ENTRE SÍ y del valor inicial: la firma
        // incluye `offsetWidth`, así que repetir un valor no dispara un pase nuevo y se leería el
        // tamaño viejo. (Pasó al escribir esta prueba: el primer pase usaba 0, que es lo que jsdom
        // ya devolvía, y nunca volvió a maquetar.)
        let mentira = 1;
        Object.defineProperty(price, 'offsetWidth', { get: () => mentira, configurable: true });

        cmp().programar();
        await dosCuadros();
        const conChico = price.style.fontSize; // con el viejo camino: 15mm (el techo)

        mentira = 9999;
        cmp().programar();
        await dosCuadros();
        const conEnorme = price.style.fontSize; // con el viejo camino: 4.5mm (el piso)

        expect(conChico).toBe(conEnorme);
        // …y el cálculo SÍ acotó: ni se quedó en el techo ni se fue al piso.
        expect(parseFloat(conChico)).toBeLessThan(15);
        expect(parseFloat(conChico)).toBeGreaterThan(4.5);
        // El tamaño sale de las métricas, no del elemento.
        expect(medidor).toHaveBeenCalled();
      } finally {
        medidor.mockRestore();
        if (original) Object.defineProperty(document, 'fonts', original);
        else delete (document as unknown as Record<string, unknown>)['fonts'];
      }
    });

    it('declara su veredicto, y en jsdom (sin layout) es "sin_medida" — nunca "ok"', async () => {
      await render(BASE);
      expect(el().querySelector('.etq-label')?.getAttribute('data-etq-fit')).toBe('sin_medida');
    });

    /**
     * ⭐ NEGATIVA de la compuerta de renglones. Sin esta prueba, la compuerta es una intención.
     *
     * `fitTiers` encoge hasta su piso de 2.6 mm y, si ahí sigue sin caber, SALE — y el
     * `overflow:hidden` de `.etq-label` se come el sobrante. El veredicto no miraba ese bloque,
     * así que decía `ok` y `print()` —que cuenta `[data-etq-fit="overflow"]`— no avisaba.
     * Medido en vivo: SKU 70500 sucursal 06, la fila de CAJA salía cortada por la mitad.
     *
     * Se mockea la geometría porque jsdom no hace layout, igual que el candado del zoom de abajo.
     */
    it('⭐ NEGATIVA: un renglón que NO cabe sale "overflow", no "ok"', async () => {
      await render(BASE);
      const cmp = fix.componentInstance as unknown as { veredicto(): string };
      const precio = el().querySelector('.etq-price') as HTMLElement;
      const cajaPrecio = precio.parentElement as HTMLElement;
      const tiers = el().querySelector('.etq-tiers') as HTMLElement;

      // El hero tiene que ser medible o el veredicto sale 'sin_medida' ANTES de mirar los renglones.
      Object.defineProperty(cajaPrecio, 'clientWidth', { value: 200, configurable: true });

      // Caja de renglones de 60 px, sin zoom (rect == offsetHeight → escalaVisual = 1).
      Object.defineProperty(tiers, 'offsetHeight', { value: 60, configurable: true });
      Object.defineProperty(tiers, 'clientHeight', { value: 60, configurable: true });
      tiers.getBoundingClientRect = () => ({ height: 60 }) as DOMRect;
      const hijos = Array.from(tiers.children) as HTMLElement[];
      expect(hijos.length).toBeGreaterThan(0); // si no hay renglones el caso sería degenerado
      const altoDeCadaRenglon = (px: number) =>
        hijos.forEach((h) => { h.getBoundingClientRect = () => ({ height: px }) as DOMRect; });

      // CABE: los renglones entran holgados en la caja.
      altoDeCadaRenglon(10);
      expect(cmp.veredicto()).toBe('ok');

      // NO CABE: los MISMOS renglones, más altos que la caja. Esto es lo que antes salía 'ok'.
      altoDeCadaRenglon(40);
      expect(cmp.veredicto()).toBe('overflow');
    });
  });

  /**
   * ⭐ [ETQ-PROMO.1] El "Descuento por Cantidad" de Kepler en la etiqueta.
   *
   * El precio grande pasa a ser el DESCONTADO y el de lista baja a un renglón chico tachado.
   * Lo que más importa acá es la negativa: la promo apunta a UNA presentación y en el 43% de las
   * vigentes no es la base, así que aplicarla al precio grande sin mirar la unidad estaría mal
   * en casi la mitad de los casos.
   */
  describe('⭐ descuento por cantidad', () => {
    const CON_PROMO: LabelModel = { ...BASE, promo_pct: 10, promo_min_qty: 1, promo_aplica: 'pieza' };
    const precio = (): string => el().querySelector('.etq-price')?.textContent?.replace(/\s/g, '') ?? '';
    const antes = (): string | null => el().querySelector('.etq-antes .amt')?.textContent?.trim() ?? null;

    it('el precio grande lleva el descuento y el normal baja a un renglón tachado', async () => {
      await render(CON_PROMO);
      expect(precio()).toContain('11.25');           // 12.50 − 10%
      expect(antes()).toBe('$12.50');
      expect(el().querySelector('.etq-tachado')).not.toBeNull();
    });

    it('⭐ NEGATIVA: si la promo es de OTRA presentación, el precio grande NO se toca', async () => {
      // Hero = pieza (default de este modelo) pero la promo es de caja: no aplica.
      await render({ ...CON_PROMO, promo_aplica: 'caja' });
      expect(precio()).toContain('12.50');
      expect(antes()).toBeNull();
    });

    it('sin plaza no hay promo, y eso NO se pinta como "sin descuento"', async () => {
      await render({ ...BASE, promo_pct: null, promo_aplica: null });
      expect(precio()).toContain('12.50');
      expect(antes()).toBeNull();
    });

    it('"desde N" sólo aparece con umbral real — 496 de 498 promos arrancan en 1', async () => {
      await render(CON_PROMO);
      expect(el().querySelector('.etq-antes .txt')?.textContent).not.toContain('desde');
      await render({ ...CON_PROMO, promo_min_qty: 3 });
      expect(el().querySelector('.etq-antes .txt')?.textContent).toContain('desde');
    });

    it('un pct absurdo (0 o >=100) se ignora: no se imprime un precio de regalo', async () => {
      for (const pct of [0, 100, 140]) {
        await render({ ...CON_PROMO, promo_pct: pct });
        expect(precio()).toContain('12.50');
        expect(antes()).toBeNull();
      }
    });
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
