import {
  WAREHOUSE_DISPLAY_ORDER,
  warehouseName,
  warehouseCodeAndName,
  compareWarehouseCodes,
} from './warehouse-order.contract';

/**
 * `[SUC.1]` CANDADO del rotulador de sucursales.
 *
 * Existe porque el defecto que arregla —121 renderizados de un código crudo en 64 componentes—
 * se arregla con UNA función, y una función que rotula mal es peor que un número: un `07` se lee
 * como «no sé qué plaza es» y se investiga; «Padre Hidalgo» donde va «Morelia Madero» se cree.
 *
 * Lo que vigila, y por qué cada cosa:
 *  1. Todos los alias de una plaza dan el MISMO nombre — es la razón de ser del agrupador, y lo
 *     que distingue este rotulador de un `Map` plano código→nombre.
 *  2. Un código desconocido vuelve TAL CUAL. Nunca vacío, nunca el nombre del vecino (ADR-056).
 *  3. Las rutas se derivan de la forma del código, y SÓLO con el prefijo explícito: un `09`
 *     suelto no es «Ruta 09», es una plaza que esta lista no conoce.
 *  4. El orden de pantalla sigue vivo — agregar `name` no podía moverlo.
 */
describe('[SUC.1] warehouseName', () => {
  it('da el mismo nombre para TODOS los alias de la misma plaza', () => {
    for (const g of WAREHOUSE_DISPLAY_ORDER) {
      for (const c of g.codes) {
        expect(warehouseName(c)).toBe(g.name);
      }
    }
  });

  it('resuelve los dos vocabularios: el código Kepler de 2 dígitos y el de commercial.warehouses', () => {
    expect(warehouseName('07')).toBe('Morelia Madero');      // sucursal (feeds)
    expect(warehouseName('MD-32')).toBe('Morelia Madero');   // warehouse_code (Wincaja)
    expect(warehouseName('32')).toBe('Morelia Madero');      // source_branch (crudo)
    expect(warehouseName('08')).toBe('Morelia Abastos');
    expect(warehouseName('30')).toBe('Morelia Abastos');
  });

  it('el 03 se llama «8 Esquinas», no «8ESQ» — eso es la abreviatura de columna', () => {
    expect(warehouseName('03')).toBe('8 Esquinas');
    const g = WAREHOUSE_DISPLAY_ORDER.find((x) => x.codes.includes('03'));
    expect(g?.label).toBe('8ESQ');
    expect(g?.name).not.toBe(g?.label);
  });

  it('ninguna plaza se queda sin nombre, y ningún nombre se repite entre plazas', () => {
    const nombres = WAREHOUSE_DISPLAY_ORDER.map((g) => g.name);
    expect(nombres.every((n) => n.trim().length > 2)).toBe(true);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it('un código DESCONOCIDO vuelve tal cual: ni vacío, ni el nombre de otra plaza', () => {
    expect(warehouseName('MD-99')).toBe('MD-99');
    expect(warehouseName('ZZZ')).toBe('ZZZ');
    // ⚠️ `09` NO existe hoy. Si algún día existe hay que agregarlo acá, no dejar que el
    // rotulador lo adivine — por eso vuelve como vino en vez de caer en la regla de rutas.
    expect(warehouseName('09')).toBe('09');
    expect(warehouseName('21')).toBe('21');
  });

  it('nulo, vacío y espacios no revientan ni inventan', () => {
    expect(warehouseName(null)).toBe('');
    expect(warehouseName(undefined)).toBe('');
    expect(warehouseName('   ')).toBe('');
    expect(warehouseName(' 07 ')).toBe('Morelia Madero');
    expect(warehouseName('md-30')).toBe('Morelia Abastos'); // insensible a mayúsculas
  });

  it('las rutas se derivan de la forma, y sólo con el prefijo explícito', () => {
    expect(warehouseName('RUTA-21')).toBe('Ruta 21');
    expect(warehouseName('RUTA-505')).toBe('Ruta 505');
    expect(warehouseName('ruta-321')).toBe('Ruta 321');
  });

  it('warehouseCodeAndName muestra los dos, y NO repite cuando no conoce el código', () => {
    expect(warehouseCodeAndName('07')).toBe('07 · Morelia Madero');
    expect(warehouseCodeAndName('MD-99')).toBe('MD-99');     // no «MD-99 · MD-99»
    expect(warehouseCodeAndName(null)).toBe('');
  });

  it('agregar `name` no movió el orden de pantalla', () => {
    const orden = ['01', '08', '07', '03', '02', '04', '06', '05', '00'];
    const revuelto = [...orden].reverse();
    expect([...revuelto].sort(compareWarehouseCodes)).toEqual(orden);
  });
});
