import { BadRequestException } from '@nestjs/common';
import {
  FUENTE_CONSOLIDADA,
  FUENTE_POR_SUCURSAL,
  PRICE_REPORT_LIMIT_DEFAULT,
  PRICE_REPORT_LIMIT_MAX,
  buildPriceReportMeta,
  resolvePriceReportParams,
} from './price-report';

/**
 * `[CAT.7]` — Las dos decisiones del reporte de precios que NO son SQL.
 *
 * Por qué se prueban acá y no por HTTP: lo que decide esto no es una consulta, es **de qué fuente
 * sale el precio** y **qué huecos se declaran**. La consulta la mide el smoke con base real
 * (ADR-044); esto mide lo que después va impreso en la carátula de la hoja.
 *
 * Las tres cosas que este bloque impide que vuelvan a pasar en silencio:
 *  1. Que una plaza mal escrita caiga al camino consolidado **sin avisar** — la hoja diría un
 *     precio que no es el de ese mostrador, con el nombre de ese mostrador arriba.
 *  2. Que un recorte por tope se lea como «el proveedor no tiene más productos».
 *  3. Que la ausencia de fecha se lea como «recién actualizado». `null` es «no se pudo medir».
 */

const UUID_A = '605a0f41-b40e-4e65-abab-907f8c21e7ec';
const UUID_B = '1f682df0-83ef-48cc-a352-fb839c6c787e';

describe('[CAT.7] resolvePriceReportParams — de qué fuente sale el precio', () => {
  it('sin sucursal lee la vista CONSOLIDADA y lo declara', () => {
    const p = resolvePriceReportParams({ supplier_ids: [UUID_A] });
    expect(p.sucursal).toBeNull();
    expect(p.fuente).toBe(FUENTE_CONSOLIDADA);
  });

  it('con una plaza de dos dígitos lee la tabla POR SUCURSAL', () => {
    const p = resolvePriceReportParams({ sucursal: '03' });
    expect(p.sucursal).toBe('03');
    expect(p.fuente).toBe(FUENTE_POR_SUCURSAL);
  });

  it('el CEDIS "00" es una plaza válida — no se cae por ser cero', () => {
    // Un `if (sucursal)` sobre el string vacío está bien; sobre un `Number` no: `00` vale 0.
    const p = resolvePriceReportParams({ sucursal: '00' });
    expect(p.sucursal).toBe('00');
    expect(p.fuente).toBe(FUENTE_POR_SUCURSAL);
  });

  it.each(['3', '003', 'MD-03', '0x', '', '  '])(
    'una plaza que no es de dos dígitos (%s) cae a consolidado, y la respuesta lo dirá',
    (suc) => {
      const p = resolvePriceReportParams({ sucursal: suc });
      expect(p.sucursal).toBeNull();
      expect(p.fuente).toBe(FUENTE_CONSOLIDADA);
    },
  );

  it('los proveedores inválidos se descartan y los válidos sobreviven', () => {
    const p = resolvePriceReportParams({ supplier_ids: [UUID_A, 'no-es-uuid', UUID_B] });
    expect(p.supplierIds).toEqual([UUID_A, UUID_B]);
  });

  it('⛔ si NINGÚN proveedor pedido es válido, es un 400 — no "todo el catálogo"', () => {
    // El pedido era acotado. Devolver 8,700 productos sería contestar otra pregunta.
    expect(() => resolvePriceReportParams({ supplier_ids: ['basura'] })).toThrow(BadRequestException);
  });

  it('sin `supplier_ids` no hay error: es el reporte de todo el catálogo, con su tope', () => {
    const p = resolvePriceReportParams({});
    expect(p.supplierIds).toEqual([]);
    expect(p.limit).toBe(PRICE_REPORT_LIMIT_DEFAULT);
  });

  it('el tope se respeta: nadie pide 100 mil renglones', () => {
    expect(resolvePriceReportParams({ limit: 100000 }).limit).toBe(PRICE_REPORT_LIMIT_MAX);
    expect(resolvePriceReportParams({ limit: 10 }).limit).toBe(10);
    // 0, negativo o basura NO son "sin límite": caen al default.
    expect(resolvePriceReportParams({ limit: 0 }).limit).toBe(PRICE_REPORT_LIMIT_DEFAULT);
    expect(resolvePriceReportParams({ limit: -5 }).limit).toBe(PRICE_REPORT_LIMIT_DEFAULT);
    expect(resolvePriceReportParams({ limit: NaN }).limit).toBe(PRICE_REPORT_LIMIT_DEFAULT);
  });

  it('sólo un `only_active: false` EXPLÍCITO incluye las bajas', () => {
    expect(resolvePriceReportParams({}).onlyActive).toBe(true);
    expect(resolvePriceReportParams({ only_active: true }).onlyActive).toBe(true);
    expect(resolvePriceReportParams({ only_active: false }).onlyActive).toBe(false);
  });
});

describe('[CAT.7] buildPriceReportMeta — los huecos, declarados', () => {
  const params = { limit: 3000, sucursal: null as string | null };

  it('cuenta los renglones SIN precio, que salen con guion y no con cero', () => {
    const meta = buildPriceReportMeta(
      [{ piece_price: '12.50' }, { piece_price: null }, { piece_price: undefined }],
      3,
      params,
      null,
    );
    expect(meta.sin_precio).toBe(2);
    expect(meta.mostrados).toBe(3);
  });

  it('un precio de 0 NO cuenta como "sin precio" — es un dato, y uno que hay que ir a mirar', () => {
    const meta = buildPriceReportMeta([{ piece_price: '0' }], 1, params, null);
    expect(meta.sin_precio).toBe(0);
  });

  it('`truncado` se enciende cuando el total supera lo que se devolvió', () => {
    expect(buildPriceReportMeta([{ piece_price: '1' }], 900, params, null).truncado).toBe(true);
    expect(buildPriceReportMeta([{ piece_price: '1' }], 1, params, null).truncado).toBe(false);
  });

  it('`precios_al` es el más RECIENTE de las filas, no el primero que aparece', () => {
    const meta = buildPriceReportMeta(
      [
        { piece_price: '1', computed_at: '2026-09-01T00:00:00.000Z' },
        { piece_price: '1', computed_at: '2026-09-12T01:32:16.492Z' },
        { piece_price: '1', computed_at: '2026-08-20T00:00:00.000Z' },
      ],
      3,
      params,
      null,
    );
    expect(meta.precios_al).toBe('2026-09-12T01:32:16.492Z');
  });

  it('acepta el `Date` que devuelve node-pg para un timestamptz', () => {
    const meta = buildPriceReportMeta(
      [{ piece_price: '1', computed_at: new Date('2026-09-12T01:32:16.492Z') }],
      1,
      params,
      null,
    );
    expect(meta.precios_al).toBe('2026-09-12T01:32:16.492Z');
  });

  it('⛔ sin ninguna fecha, `precios_al` es null — que NO es "hoy"', () => {
    const meta = buildPriceReportMeta([{ piece_price: '1' }], 1, params, null);
    expect(meta.precios_al).toBeNull();
  });

  it('`consolidado` es lo contrario de tener plaza, y el nombre viaja para la carátula', () => {
    expect(buildPriceReportMeta([], 0, params, null).consolidado).toBe(true);
    const conPlaza = buildPriceReportMeta([], 0, { limit: 3000, sucursal: '03' }, '8ESQ');
    expect(conPlaza.consolidado).toBe(false);
    expect(conPlaza.sucursal_nombre).toBe('8ESQ');
  });

  it('una lista vacía no rompe nada y no inventa un total', () => {
    const meta = buildPriceReportMeta([], 0, params, null);
    expect(meta).toMatchObject({ total: 0, mostrados: 0, truncado: false, sin_precio: 0, precios_al: null });
  });
});
