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
/**
 * `[ETQ-PRES.4]` El fixture dejó de ser tres cajones y pasó a ser la LISTA.
 *
 * ⚠️ Los campos `piece_*`/`pack_*`/`box_*` siguen acá **sólo** porque `LabelModel` todavía los
 * declara y el camino sin plaza los usa. La etiqueta YA NO LOS LEE: si se borran de abajo, nada
 * de lo que estos casos afirman cambia. Eso es, justamente, lo que se está probando.
 */
const BASE: LabelModel = {
  product_id: 'p-1', sku: '20186', name: 'DULCE DE PRUEBA 50G/8', content: '50 g',
  barcode: '7501234567893', barcode_format: 'EAN13',
  piece_price: 12.5, wholesale_piece_min_qty: 3, wholesale_piece_price: 11,
  pack_size: 8, pack_price: 90, wholesale_pack_price: 85, wholesale_pack_min_qty: 3,
  box_size: 24, box_price: 250, unit_base: 'PZA', sold_by_kg: false,
  presentaciones: [
    { unidad: 'PZA', factor: 1, origen: 'base', contenido: '50 g', precio_lista: 12.5, mayoreo_precio: 11, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
    { unidad: 'PAQ', factor: 8, origen: 'ranura', contenido: '400 g', precio_lista: 90, mayoreo_precio: 85, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
    { unidad: 'CJA', factor: 24, origen: 'ranura', contenido: '1.2 kg', precio_lista: 250, mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_mayoreo' },
  ],
};

/** Igual que `BASE` pero SIN el peldaño de la base: aísla el camino de la promo sola. */
const SIN_PELDANO_BASE = (m: LabelModel): LabelModel => ({
  ...m,
  presentaciones: (m.presentaciones ?? []).map((p) =>
    p.origen === 'base' ? { ...p, mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_mayoreo' as const } : p),
});

/** Cambia el precio de lista de la presentación base (y deja el resto igual). */
const CON_LISTA_BASE = (m: LabelModel, precio: number): LabelModel => ({
  ...m, piece_price: precio,
  presentaciones: (m.presentaciones ?? []).map((p) => (p.origen === 'base' ? { ...p, precio_lista: precio } : p)),
});

/** Cambia el peldaño de la presentación base. */
const CON_PELDANO_BASE = (m: LabelModel, precio: number, desde = 3): LabelModel => ({
  ...m,
  presentaciones: (m.presentaciones ?? []).map((p) =>
    p.origen === 'base'
      ? { ...p, mayoreo_precio: precio, mayoreo_desde: desde, mayoreo_veredicto: 'ok' as const }
      : p),
});

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

  /**
   * `[ETQ-PRES.4]` EL GRANEL DEJÓ DE SER UN CASO ESPECIAL.
   *
   * Esto probaba `granelAltTier`, el renglón "kg ↔ porción" que la etiqueta fabricaba con
   * aritmética (`precio_base × 1000 / gramos`) y que tenía su propio interruptor en el
   * multiselect. Ya no existe: la porción y el kilo son **dos presentaciones del ERP**, y se
   * imprimen por el mismo camino que la caja o la cubeta.
   *
   * Verificado antes de retirarlo, contra prod: los **2,108** pares granel tienen su presentación
   * `KG` publicada, y el kilo derivado coincide con el del ERP en **2,108 de 2,108** (peor
   * diferencia $0.00). O sea que la aritmética no estaba mal — estaba de más.
   *
   * ⭐ Y lo que sí corrige: el `18022` es base `500`, y la etiqueta rotulaba su mayoreo como
   * "3+ **pzas**". No son piezas, son bolsas de medio kilo — 88 SKUs con ese rótulo.
   */
  it('⭐ el granel imprime su porción y su kilo como dos presentaciones, con la unidad del ERP', async () => {
    const granel: LabelModel = {
      ...BASE, sku: '18022', name: 'CAJETA ENVINADA 25KGS', unit_base: '500', sold_by_kg: true,
      piece_price: 57.88, content: '500 g',
      pack_price: null, pack_size: null, box_price: null, box_size: null,
      wholesale_pack_price: null, wholesale_piece_price: null,
      presentaciones: [
        { unidad: '500', factor: 1, origen: 'base', contenido: '500 g', precio_lista: 57.88, mayoreo_precio: 53.75, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
        { unidad: 'KG', factor: 2, origen: 'ranura', contenido: '1 kg', precio_lista: 115.74, mayoreo_precio: 107.48, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
        { unidad: 'CUB', factor: 50, origen: 'ranura', contenido: '25 kg', precio_lista: 2339.76, mayoreo_precio: 2232.28, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
      ],
    };
    await render(granel);
    const t = texto();
    // El hero es el kilo (convención de anaquel) y sale del ERP, no de una multiplicación.
    expect(el().querySelector('.etq-price')?.textContent).toContain('115.74');
    // ⭐⭐ El "25 kg" queda pegado a los $2,339.76 de la CUBETA — que es de quien era ese peso.
    // Antes el contenido salía de un regex sobre el nombre ("...25KGS") y se imprimía junto al
    // precio de la porción: "25 kg · $57.88", 50× abajo, en 111 SKUs × 9 plazas.
    expect(t).toMatch(/Cubeta\s*25 kg/);
    expect(t).toContain('2,339.76');
    expect(t).toContain('500 g');
    // ⛔ NEGATIVA: el peso del bulto NUNCA viaja junto al precio de la porción.
    expect(t).not.toMatch(/25 kg[^$]*\$?57\.88/);
    // Los peldaños se apagan sin apagar las presentaciones, y viceversa.
    await render(granel, { ...ALL_SECTIONS, mayoreo: false });
    expect(texto()).not.toContain('Mayoreo');
    expect(texto()).toContain('2,339.76');
    await render(granel, { ...ALL_SECTIONS, presentaciones: false });
    expect(texto()).not.toContain('2,339.76');
  });

  /**
   * ⭐⭐ `[ETQ-PRES.4]` EL PRECIO DE MAYOREO — lo que Edgar reportó tres veces seguidas.
   *
   * El veredicto lo emite `analytics.v_label_presentations` comparando el peldaño contra el
   * precio de lista **de su misma unidad**. Es ternario a propósito (ADR-056): un booleano no
   * puede decir "no sé". Medido en prod al construirlo: **3,864 peldaños incoherentes** y
   * **10,599 `sin_arbitro`**.
   *
   * ⛔ Estos cuatro casos son la PRUEBA NEGATIVA: si alguien afloja el criterio y publica lo que
   * no es `ok`, la etiqueta vuelve a imprimir "MAYOREO $1.35" bajo una pieza de $26.01.
   */
  describe('⭐⭐ el mayoreo sólo se publica si su veredicto lo respalda', () => {
    const tiers = (): string[] =>
      [...el().querySelectorAll('.etq-tier')].map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const conVeredictoCJA = (v: 'ok' | 'incoherente' | 'sin_arbitro' | 'sin_mayoreo'): LabelModel => ({
      ...BASE,
      presentaciones: (BASE.presentaciones ?? []).map((p) =>
        p.unidad === 'CJA'
          ? { ...p, mayoreo_precio: 225, mayoreo_desde: 3, mayoreo_veredicto: v }
          : p),
    });

    it('con veredicto ok, se imprime con su "desde N" y su unidad', async () => {
      await render(conVeredictoCJA('ok'));
      expect(tiers().some((t) => /Mayoreo 3\+ cajas.*225\.00/.test(t))).toBe(true);
    });

    for (const v of ['incoherente', 'sin_arbitro'] as const) {
      it(`⛔ NEGATIVA: con veredicto "${v}" el peldaño NO se imprime`, async () => {
        await render(conVeredictoCJA(v));
        expect(tiers().some((t) => t.includes('225.00'))).toBe(false);
        // …y la presentación sigue apareciendo con su precio de lista: lo que se suprime es el
        // peldaño que no se puede sostener, no la caja.
        expect(tiers().some((t) => t.includes('250.00'))).toBe(true);
      });
    }

    it('⛔ NEGATIVA: sin umbral real (desde ≤ 1) no se imprime — un precio de volumen sin su cantidad', async () => {
      await render({
        ...BASE,
        presentaciones: (BASE.presentaciones ?? []).map((p) =>
          p.unidad === 'CJA' ? { ...p, mayoreo_precio: 225, mayoreo_desde: 1, mayoreo_veredicto: 'ok' as const } : p),
      });
      expect(tiers().some((t) => t.includes('225.00'))).toBe(false);
    });

    it('⭐ el REALCE exige un descuento real contra el precio de lista de SU MISMA unidad', async () => {
      // 249 contra 250 es 0.4%: el precio SÍ es más bajo, así que el renglón se imprime —
      // esconderlo sorprendería a quien compare contra la pantalla— pero sin el chip amarillo.
      // ⚠️ El realce se mira EN SU RENGLÓN, no en la etiqueta: `BASE` también trae el peldaño de
      // la pieza (11 contra 12.50 = 12%), que sí se realza. Un `querySelector` suelto lo
      // encontraría a él y el caso se pondría verde sin probar nada.
      const realceDe = (monto: string): boolean =>
        [...el().querySelectorAll('.etq-tier')]
          .filter((n) => (n.textContent ?? '').includes(monto))
          .every((n) => n.classList.contains('is-mayoreo'));

      // ⚠️ El fixture deja UN solo peldaño (el de la caja). Con los tres de `BASE` la etiqueta
      // llega a cinco renglones y el recorte se lleva justo el de menor descuento — que es el
      // que este caso quiere mirar. Un fixture que dispara otra regla no prueba la que dice.
      const soloCaja = (precio: number): LabelModel => ({
        ...BASE,
        presentaciones: (BASE.presentaciones ?? []).map((p) =>
          p.unidad === 'CJA'
            ? { ...p, mayoreo_precio: precio, mayoreo_desde: 3, mayoreo_veredicto: 'ok' as const }
            : { ...p, mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_mayoreo' as const }),
      });
      await render(soloCaja(225));
      expect(realceDe('225.00')).toBe(true);                               // 225/250 = 10%
      await render(soloCaja(249));
      expect(texto()).toContain('249.00');
      expect(realceDe('249.00')).toBe(false);                              // 249/250 = 0.4%
    });
  });

  /**
   * `[ETQ-PRES.4]` Lo que el diccionario NO entiende se imprime CRUDO — no se traduce.
   *
   * Misma regla que `QtyUnitLabel`. Medido: `SER` son 13 SKUs y casi todos son asientos
   * contables (`VENTAS AL 0 %`, `COMISION BANCARIA`, `CANCELADA`), pero uno —`03056 GLOBO #9
   * ROSA /50 AP`— sí es mercancía con la ranura mal rotulada en el ERP. Decir "servicio" sobre un
   * globo sería inventar; imprimir `SER` deja ver el error de captura a quien puede corregirlo.
   */
  it('⭐ una unidad que el diccionario no conoce se imprime tal cual, sin traducir', async () => {
    await render({
      ...BASE, sku: '03056', name: 'GLOBO #9 ROSA /50 AP',
      presentaciones: [
        { unidad: 'PZA', factor: 1, origen: 'base', contenido: null, precio_lista: 2.5, mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_mayoreo' },
        { unidad: 'SER', factor: 50, origen: 'ranura', contenido: null, precio_lista: 110, mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_mayoreo' },
      ],
    });
    expect(texto()).toContain('SER');
    expect(texto()).toContain('110.00');
  });

  /**
   * ⭐⭐ `[ETQ-PRES.4]` LO QUE NO ENTRA EN EL PAPEL.
   *
   * Con la lista, la cantidad de renglones dejó de ser fija. El arnés de geometría lo midió sobre
   * el papel: con 4 renglones no se recorta ninguno; con **5 se recortan 9 de 16**, y les faltan
   * 1.29–1.69 mm con el monto ya en su piso de legibilidad (2.6 mm) y el código de barras en su
   * mínimo. No hay de dónde sacar ese milímetro y medio.
   *
   * Imprimir un renglón cortado es peor que no imprimirlo: se ve que falta algo y no se lee qué.
   * Así que la etiqueta elige — y elige con una medición: en las 1,733 etiquetas de cinco
   * renglones de prod hay 5,199 peldaños y **3,047 (58.6%) descuentan menos del 3%**.
   */
  describe('⭐⭐ cuando no entran todos, cede el peldaño que menos descuenta', () => {
    const tiers = (): string[] =>
      [...el().querySelectorAll('.etq-tier')].map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    /** 3 presentaciones con precio + 3 peldaños ok = 5 renglones. El caso real del 18022. */
    const CINCO: LabelModel = {
      ...BASE, sku: '18022', unit_base: '500', sold_by_kg: true,
      presentaciones: [
        { unidad: '500', factor: 1, origen: 'base', contenido: '500 g', precio_lista: 57.88, mayoreo_precio: 57.30, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
        { unidad: 'KG', factor: 2, origen: 'ranura', contenido: '1 kg', precio_lista: 115.74, mayoreo_precio: 107.48, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
        { unidad: 'CUB', factor: 50, origen: 'ranura', contenido: '25 kg', precio_lista: 2339.76, mayoreo_precio: 2232.28, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
      ],
    };

    it('se imprimen 4 renglones y el que sale es el peldaño de menor descuento', async () => {
      await render(CINCO);
      expect(tiers().length).toBe(4);
      // El de 500 g descuenta 1.0% ($57.88 → $57.30); los otros dos, 7.1% y 4.6%.
      expect(tiers().some((t) => t.includes('57.30'))).toBe(false);
      // ⛔ Y NINGUNA presentación desaparece: las tres siguen con su precio de lista.
      expect(tiers().some((t) => t.includes('57.88'))).toBe(true);
      expect(tiers().some((t) => t.includes('2,339.76'))).toBe(true);
      expect(tiers().some((t) => t.includes('2,232.28'))).toBe(true);
    });

    it('⭐ lo que no entra se DECLARA, no desaparece en silencio', async () => {
      await render(CINCO);
      expect(fix.componentInstance.renglonesOcultos).toBe(1);
      // …y con cuatro o menos no hay nada que declarar: el 97.9% de las etiquetas.
      await render(BASE);
      expect(fix.componentInstance.renglonesOcultos).toBe(0);
    });

    it('⛔ NEGATIVA: el precio de lista de una presentación NO cede antes que un peldaño', async () => {
      // Aunque el peldaño de la cubeta descuente mucho más que el de la porción, lo que se saca
      // sigue siendo un peldaño: borrar un precio de lista haría desaparecer una UNIDAD del
      // papel, que es el defecto que esta fase cierra.
      await render(CINCO);
      const conLista = tiers().filter((t) => !t.includes('Mayoreo'));
      expect(conLista.length).toBe(2);                    // las dos que no son el hero
    });
  });

  /**
   * `[ETQ-PRES.4]` Sin lista NO se rellena con los tres cajones — se imprime lo que hay.
   *
   * Medido: de los 84,219 pares (sku, plaza) con precio, **253 (0.30 %)** no tienen
   * presentaciones, y en los 253 la causa es una sola — `kdii.c11` viene vacío, o sea que el ERP
   * no le declara unidad base. Inventar un "Paquete" ahí sería exactamente el defecto que esta
   * fase cierra, en miniatura.
   */
  it('⛔ NEGATIVA: sin presentaciones no se fabrica ningún renglón', async () => {
    await render({ ...BASE, presentaciones: [] });
    expect(el().querySelectorAll('.etq-tier').length).toBe(0);
    // Los tres cajones siguen cargados en el modelo y NO se leen: ni el paquete de $90 ni la
    // caja de $250 aparecen.
    expect(texto()).not.toContain('90.00');
    expect(texto()).not.toContain('250.00');
    expect(el().querySelector('.etq-price')?.textContent).toContain('12.50');
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
    // `[ETQ-PRES.4]` La promo se declara con el RÓTULO del ERP, no con un cajón traducido.
    const CON_PROMO: LabelModel = { ...BASE, promo_pct: 10, promo_min_qty: 1, promo_unidad: 'PZA', promo_aplica: 'pieza' };
    /**
     * `[ETQ-AIDA.1]` SIN escalera de mayoreo, para aislar el camino de la promo sola.
     *
     * `BASE` trae el peldaño de la base a $11 contra una lista de $12.50, así que `CON_PROMO`
     * entra por el hero de mayoreo (11 × 0.9 = 9.90) y ya no prueba lo que estos casos dicen
     * probar. Peor: `PROMO_GRANDE` subía la lista a 236.51 y dejaba el mayoreo en 11, una
     * combinación que no existe en el ERP — daba un "Ahorra $226.61". Un fixture incoherente no
     * es un caso límite, es ruido: se parte en dos y cada uno prueba una cosa.
     */
    const SOLO_PROMO: LabelModel = SIN_PELDANO_BASE(CON_PROMO);
    // Ahorro por ENCIMA del piso ($23.65, como el FERRERO real de la plaza 05).
    const PROMO_GRANDE: LabelModel = CON_LISTA_BASE(SOLO_PROMO, 236.51);
    const precio = (): string => el().querySelector('.etq-price')?.textContent?.replace(/\s/g, '') ?? '';
    const antes = (): string | null => el().querySelector('.etq-antes .amt')?.textContent?.trim() ?? null;

    it('el precio grande lleva el descuento y el normal baja a un renglón tachado', async () => {
      await render(SOLO_PROMO);
      expect(precio()).toContain('11.25');           // 12.50 − 10%
      expect(antes()).toBe('$12.50');
      expect(el().querySelector('.etq-tachado')).not.toBeNull();
    });

    it('⭐ NEGATIVA: si la promo es de OTRA presentación, el precio grande NO se toca', async () => {
      // Hero = la base PZA (default de este modelo) pero la promo está declarada en CJA.
      await render({ ...CON_PROMO, promo_unidad: 'CJA', promo_aplica: 'caja' });
      expect(precio()).toContain('12.50');
      expect(antes()).toBeNull();
    });

    it('sin plaza no hay promo, y eso NO se pinta como "sin descuento"', async () => {
      await render({ ...BASE, promo_pct: null, promo_unidad: null, promo_aplica: null });
      expect(precio()).toContain('12.50');
      expect(antes()).toBeNull();
    });

    it('"desde N" sólo aparece con umbral real — 496 de 498 promos arrancan en 1', async () => {
      await render(CON_PROMO);
      expect(el().querySelector('.etq-antes .txt')?.textContent).not.toContain('desde');
      await render({ ...CON_PROMO, promo_min_qty: 3 });
      expect(el().querySelector('.etq-antes .txt')?.textContent).toContain('desde');
    });

    it('⭐ el ahorro va DENTRO del panel amarillo y el Código baja a la derecha', async () => {
      // [ETQ-PROMO.3] Es el reacomodo que hace que el precio NO se achique: la barra de ahorro
      // entra al panel porque la meta libera sus 5.9 mm. Si la meta se queda arriba, la barra
      // le come al numero — y eso contradice la regla de que el precio domina la composicion.
      await render(PROMO_GRANDE);
      const barra = el().querySelector('.etq-ahorro-bar');
      expect(barra).not.toBeNull();
      expect(barra?.textContent).toContain('23.65'); // 10% de 236.51
      // la meta existe UNA sola vez, y del lado derecho
      expect(el().querySelectorAll('.etq-meta').length).toBe(1);
      expect(el().querySelector('.etq-right .etq-meta')).not.toBeNull();
      expect(el().querySelector('.etq-left .etq-meta')).toBeNull();
      // la reserva de abajo y el punteado viajan juntos, o el borde pisa la barra
      const css = (LabelComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('');
      expect(css).toContain('con-ahorro .etq-pricebox{ padding-bottom:11.4mm');
      expect(css).toContain('con-ahorro .etq-pricebox::before{ inset:.8mm .8mm 11.4mm .8mm');
    });

    it('SIN oferta la etiqueta no cambia: meta a la izquierda y sin barra', async () => {
      await render(BASE);
      expect(el().querySelector('.etq-ahorro-bar')).toBeNull();
      expect(el().querySelector('.etq-left .etq-meta')).not.toBeNull();
      expect(el().querySelector('.etq-right .etq-meta')).toBeNull();
    });

    it('⭐ REGLA DE 100: se muestra el número MÁS GRANDE, no un umbral inventado', async () => {
      // [ETQ-PROMO.5] El comprador no hace la resta: compara números y gana el que se ve más
      // grande (Berger). Como ahorro = precio × pct/100, "ahorro > pct" es exactamente
      // "precio > $100" — la regla sin constante mágica.
      //
      // Acá había un AHORRO_MIN_MXN = 5 que inventé. Medido sobre las 388 etiquetas en promo de
      // prod, ese umbral discrepaba de la regla en 44 casos: 42 ponían pesos donde va porcentaje.

      // BARATO ($12.50, ahorro $1.25 vs 10%): gana el porcentaje.
      await render(SOLO_PROMO);
      const barra1 = el().querySelector('.etq-ahorro-bar');
      expect(barra1?.textContent).toContain('10%');
      expect(barra1?.textContent).not.toContain('1.25');

      // CARO ($236.51, ahorro $23.65 vs 10%): gana el monto.
      await render(PROMO_GRANDE);
      const barra2 = el().querySelector('.etq-ahorro-bar');
      expect(barra2?.textContent).toContain('23.65');
      expect(barra2?.textContent).not.toContain('10%');

      // el cruce está en $100, y no hay ninguna constante que lo diga
      expect((LabelComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp).toBeTruthy();
    });

    it('un pct absurdo (0 o >=100) se ignora: no se imprime un precio de regalo', async () => {
      for (const pct of [0, 100, 140]) {
        await render({ ...CON_PROMO, promo_pct: pct });
        expect(precio()).toContain('12.50');
        expect(antes()).toBeNull();
      }
    });

    /**
     * ⭐⭐ `[ETQ-AIDA.1]` Los dos descuentos se APILAN, y el grande es el de mayoreo.
     *
     * Medido contra prod (plaza 05, ticket `U-D-10`, 2026-08-20→09-18, renglones con `c66 > 0`):
     * de los 1,064 que alcanzan umbral, **686 reproducen exactamente `peldaño × (1 − pct)`**, y
     * aflojar la tolerancia 20× sólo lo mueve a 711 — el ajuste es real, no tolerancia generosa.
     * Y **82.9% de los renglones con umbral pagan MENOS que el precio promocional** ($4.11 en
     * promedio): la versión anterior de esta etiqueta escondía justo ese precio, porque comparaba
     * un mayoreo SIN descontar contra un promocional YA descontado.
     */
    describe('⭐⭐ el mayoreo apilado manda', () => {
      const tierTxts = (): string[] =>
        [...el().querySelectorAll('.etq-tier')].map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? '');

      it('el precio grande es el peldaño CON la promo encima, no el promocional', async () => {
        // lista 12.50 · mayoreo 11.00 desde 3 · promo 10% → 11.00 × 0.9 = 9.90 (no 11.25)
        await render(CON_PROMO);
        expect(precio()).toContain('9.90');
        expect(antes()).toBe('$12.50');
      });

      it('⭐ NEGATIVA: con la escalera INVERTIDA el grande vuelve al promocional', async () => {
        // 2 de 487 promos de la plaza 05 traen el mayoreo MÁS CARO que la lista. Ahí apilar daría
        // un precio peor que la oferta, así que el hero no se mueve.
        // El veredicto lo emite la vista contra el precio de lista de SU MISMA unidad: 13/12.50
        // queda por encima del techo, así que llega 'incoherente' y el peldaño no se publica.
        await render({
          ...CON_PROMO,
          presentaciones: (CON_PROMO.presentaciones ?? []).map((p) =>
            p.origen === 'base' ? { ...p, mayoreo_precio: 13, mayoreo_veredicto: 'incoherente' as const } : p),
        });
        expect(precio()).toContain('11.25');
        expect(el().textContent).not.toContain('Llevando');
      });

      it('⭐⭐ LA MINA DE UNIDADES YA NO EXISTE: el peldaño es un campo de SU presentación', async () => {
        // Esto probaba que el componente eligiera bien entre `wholesale_piece_price` y
        // `wholesale_pack_price` a partir de un `slot` — un mapeo que fallaba EN SILENCIO en el
        // 73.5% del catálogo cuando se equivocaba. Ya no hay nada que elegir: el peldaño viene
        // en la presentación que lleva el precio grande.
        //
        // El candado que reemplaza al viejo: **los tres campos del modelo viejo van en `null` y
        // la etiqueta sale igual**. Si alguien vuelve a leerlos, este caso se pone rojo.
        // Fixture = FERRERO 24P real de la plaza 05.
        const FERRERO: LabelModel = {
          ...BASE, sku: '42001', name: 'FERRERO 24P', unit_base: 'PAQ',
          piece_price: null, wholesale_piece_price: null, wholesale_piece_min_qty: null,
          wholesale_pack_price: null, wholesale_pack_min_qty: null,
          pack_size: null, pack_price: null, box_size: null, box_price: null,
          promo_pct: 10, promo_min_qty: 1, promo_unidad: 'PAQ', promo_aplica: 'pieza',
          presentaciones: [
            { unidad: 'PAQ', factor: 1, origen: 'base', contenido: '300 g', precio_lista: 236.51, mayoreo_precio: 221.86, mayoreo_desde: 3, mayoreo_veredicto: 'ok' },
            { unidad: 'CJA', factor: 6, origen: 'ranura', contenido: '1.8 kg', precio_lista: 1331.14, mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_mayoreo' },
          ],
        };
        await render(FERRERO);
        expect(precio()).toContain('199.67');                 // 221.86 × 0.9
        expect(antes()).toBe('$236.51');
        // `[ETQ-ODS.1]` La CAJA se imprime igual. NO lleva la promo (está declarada en PAQ, y
        // medido: la promo no sale de su presentación), así que por unidad queda por encima del
        // hero — pero el renglón no promete ser el mejor precio, dice cuánto cuesta la caja.
        expect(tierTxts().some((t) => t.includes('1,331.14'))).toBe(true);
        // ⭐ Y la caja se rotula CAJA, con SU contenido — no "Caja 6 paquetes" armado en el HTML.
        expect(tierTxts().some((t) => /Caja\s*1\.8 kg/.test(t))).toBe(true);
      });

      it('`[ETQ-AIDA.2]` la CONDICIÓN viaja pegada al número, con su unidad', async () => {
        // El precio grande es condicional: medido, 70.8% de los renglones con promo NO alcanzan
        // el umbral. Un precio de volumen sin su cantidad al lado es publicidad engañosa.
        await render(CON_PROMO);
        const franja = el().querySelector('.etq-pieza')?.textContent ?? '';
        expect(franja).toContain('Llevando');
        expect(franja).toContain('3+');
        // ADR-055: la unidad NO se pierde. Y ahora sale del diccionario del contrato aplicado a
        // la presentación del hero, no de una cascada aparte — por eso dice "piezas" y no "pzas".
        expect(franja).toContain('piezas');
      });

      it('`[ETQ-AIDA.3]` aparece el escalón intermedio "Oferta 1 a N−1"', async () => {
        await render(CON_PROMO);
        const escalon = tierTxts().find((t) => t.includes('Oferta 1 a'));
        expect(escalon).toBeDefined();
        expect(escalon).toContain('2');                       // umbral 3 → "1 a 2"
        expect(escalon).toContain('11.25');                   // el promocional puro
      });

      it('con umbral PROPIO de promo no se arma la escalera de tres', async () => {
        // Dos umbrales distintos (el de la promo y el del mayoreo) no se pueden rotular sin
        // ambigüedad → se cae al diseño de dos precios. Son 2 de 498 promos vigentes.
        await render({ ...CON_PROMO, promo_min_qty: 3 });
        expect(precio()).toContain('11.25');
        expect(tierTxts().some((t) => t.includes('Oferta 1 a'))).toBe(false);
      });
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
