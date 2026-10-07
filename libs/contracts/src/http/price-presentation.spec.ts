import {
  MAYOREO_BANDA, mayoreoPublicable, presentacionBase, presentacionMayor, unidadLegible,
  type PresentacionPrecio,
} from './price-presentation.contract';

/**
 * `[ETQ-PRES.4]` El vocabulario de unidades de la etiqueta, con su prueba negativa.
 *
 * La regla del contrato —heredada de `QtyUnitLabel`— es que lo que no se entiende **se declara,
 * no se traduce**. Un diccionario sin este candado se vuelve el lugar donde alguien "mejora" la
 * etiqueta inventando que `SER` quiere decir "servicio", y termina imprimiendo esa palabra sobre
 * el `03056 GLOBO #9 ROSA /50 AP`, que es mercancía con la ranura mal rotulada en el ERP.
 */
describe('unidadLegible · traduce lo verificado y declara lo demás', () => {
  it('las seis que el censo respalda salen en palabras', () => {
    expect(unidadLegible('CJA')).toEqual({ singular: 'caja', plural: 'cajas', conocida: true });
    expect(unidadLegible('PAQ').singular).toBe('paquete');
    expect(unidadLegible('PZA').plural).toBe('piezas');
    expect(unidadLegible('BTO').singular).toBe('bulto');
    expect(unidadLegible('CUB').plural).toBe('cubetas');
    // En una medida el plural NO cambia: "3+ kg", nunca "3+ kgs".
    expect(unidadLegible('KG')).toEqual({ singular: 'kg', plural: 'kg', conocida: true });
  });

  it('el rótulo llega como venga del ERP: minúsculas y espacios no lo cambian', () => {
    expect(unidadLegible(' cja ').singular).toBe('caja');
  });

  /**
   * ⭐ Los GRAMAJES sí se traducen, y no es interpretación: `v_label_presentations` lo verificó
   * contra un testigo independiente — de los 51 SKUs con base numérica que además tienen ranura
   * `KG`, en 51 de 51 se cumple `base × factor_KG = 1000`.
   *
   * Lo que esto corrige: la etiqueta imprimía "Mayoreo 3+ **pzas**" para una base `500`. No son
   * piezas, son bolsas de medio kilo — 88 SKUs.
   */
  it('un rótulo numérico son GRAMOS, porque la aritmética lo dice', () => {
    expect(unidadLegible('500')).toEqual({ singular: '500 g', plural: '500 g', conocida: true });
    expect(unidadLegible('250').singular).toBe('250 g');
  });

  it('⛔ NEGATIVA: lo que no está verificado se imprime CRUDO y se declara desconocido', () => {
    // Los tres que el censo de prod encontró sin poder explicar: 13 SKUs de asientos contables
    // (`SER`), 1 de `IND` y 1 de `2KG` —este último con el factor en NULL—.
    for (const raro of ['SER', 'IND', '2KG']) {
      const u = unidadLegible(raro);
      expect(u.singular).toBe(raro);
      expect(u.plural).toBe(raro);
      expect(u.conocida).toBe(false);
    }
    // Y un rótulo vacío no se convierte en "pieza" ni en nada: no hay unidad que declarar.
    expect(unidadLegible(null)).toEqual({ singular: '', plural: '', conocida: false });
    expect(unidadLegible('  ').conocida).toBe(false);
  });
});

describe('el veredicto del mayoreo es TERNARIO, y sólo uno se publica', () => {
  const p = (v: PresentacionPrecio['mayoreo_veredicto']): PresentacionPrecio => ({
    unidad: 'CJA', factor: 12, origen: 'ranura', contenido: '2.268 kg',
    precio_lista: 285, mayoreo_precio: 260, mayoreo_desde: 3, mayoreo_veredicto: v,
  });

  it('sólo `ok` es publicable', () => {
    expect(mayoreoPublicable(p('ok'))).toBe(true);
  });

  /**
   * ⛔ `sin_arbitro` NO es `ok`. Medido en prod: **10,599 presentaciones** no tienen precio de
   * lista de su propia unidad, así que no hay con qué comparar el peldaño. Llamarlas sanas sería
   * el `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional a tres matvistas.
   */
  it('⛔ NEGATIVA: los otros tres NO se publican, y `sin_arbitro` tampoco', () => {
    for (const v of ['incoherente', 'sin_arbitro', 'sin_mayoreo'] as const) {
      expect(mayoreoPublicable(p(v))).toBe(false);
    }
  });

  it('la banda tiene piso y techo, y el techo es aritmético', () => {
    // Si el "mayoreo" supera a la lista, no es mayoreo. Y por debajo del 50% lo que hay es otra
    // unidad disfrazada: un descuento de volumen mayor al 50% no existe en este catálogo.
    expect(MAYOREO_BANDA.piso).toBeGreaterThan(0);
    expect(MAYOREO_BANDA.techo).toBe(1.0);
    expect(MAYOREO_BANDA.piso).toBeLessThan(MAYOREO_BANDA.techo);
  });
});

describe('presentacionBase · sin unidad base no se sustituye por la primera que haya', () => {
  const base: PresentacionPrecio = {
    unidad: '500', factor: 1, origen: 'base', contenido: '500 g',
    precio_lista: 57.88, mayoreo_precio: 53.75, mayoreo_desde: 3, mayoreo_veredicto: 'ok',
  };
  const cubeta: PresentacionPrecio = {
    unidad: 'CUB', factor: 50, origen: 'ranura', contenido: '25 kg',
    precio_lista: 2339.76, mayoreo_precio: 2232.28, mayoreo_desde: 3, mayoreo_veredicto: 'ok',
  };

  it('devuelve la de origen `base`', () => {
    expect(presentacionBase([cubeta, base])?.unidad).toBe('500');
  });

  /**
   * ⛔ Medido: de los 84,219 pares (sku, plaza) con precio en prod, **253 (0.30 %)** no tienen
   * presentaciones, y en los 253 la causa es exactamente una — `kdii.c11` vacío. Devolver la
   * cubeta ahí haría que la etiqueta anunciara $2,339.76 como el precio de mostrador.
   */
  it('⛔ NEGATIVA: sin `base` devuelve null, no la ranura más grande', () => {
    expect(presentacionBase([cubeta])).toBeNull();
    expect(presentacionBase([])).toBeNull();
  });

  it('presentacionMayor elige por factor y no cae a la base cuando ninguna tiene precio', () => {
    expect(presentacionMayor([base, cubeta])?.unidad).toBe('CUB');
    expect(presentacionMayor([base])).toBeNull();                         // factor 1 no cuenta
    expect(presentacionMayor([{ ...cubeta, precio_lista: null }])).toBeNull();
  });
});
