import {
  AREAS_DE_ALCANCE,
  AREA_TODAS,
  ReglaConArea,
  elegirRegla,
  esAreaDeAlcance,
  etiquetaDeArea,
} from './scope-areas';

/**
 * `[ZN.8]` — **La precedencia de área decide qué filas ve una persona, y falla en silencio.**
 *
 * Si `elegirRegla` elige mal no hay excepción, ni log, ni 500: alguien ve de más o de menos y se
 * descubre semanas después mirando una pantalla rara. Por eso es una función pura y por eso
 * tiene candado antes que pantalla.
 *
 * El caso que la motivó es real: una encargada que **hace el pedido de todas las sucursales** y
 * en el resto de la app sólo mira su plaza. Su bitácora tenía cuatro cambios de alcance en
 * quince días —`all` → `listed` → `all` → `own`— cada uno arreglando una pantalla y rompiendo
 * otra, porque había **una sola palanca** para dos necesidades.
 */
const r = (dimension: string, area?: string, tag = ''): ReglaConArea & { tag: string } =>
  ({ dimension, area, tag: tag || `${dimension}@${area ?? AREA_TODAS}` });

describe('[ZN.8] elegirRegla — qué regla gana', () => {
  it('sin reglas no inventa ninguna', () => {
    expect(elegirRegla([], 'warehouse', 'compras')).toBeUndefined();
  });

  it('con sólo la general, gana la general — pregunten por el área que pregunten', () => {
    const reglas = [r('warehouse', AREA_TODAS)];
    expect(elegirRegla(reglas, 'warehouse', 'compras')?.tag).toBe('warehouse@*');
    expect(elegirRegla(reglas, 'warehouse')?.tag).toBe('warehouse@*');
  });

  it('⭐ el caso que motivó la fase: en Compras gana la de Compras, en el resto la general', () => {
    const reglas = [r('warehouse', AREA_TODAS), r('warehouse', 'compras')];
    expect(elegirRegla(reglas, 'warehouse', 'compras')?.tag).toBe('warehouse@compras');
    expect(elegirRegla(reglas, 'warehouse', 'pdv')?.tag).toBe('warehouse@*');
    expect(elegirRegla(reglas, 'warehouse')?.tag).toBe('warehouse@*');
  });

  it('⛔ NO depende del orden en que vengan: Postgres no garantiza orden sin ORDER BY', () => {
    const alReves = [r('warehouse', 'compras'), r('warehouse', AREA_TODAS)];
    expect(elegirRegla(alReves, 'warehouse', 'compras')?.tag).toBe('warehouse@compras');
    const derecho = [r('warehouse', AREA_TODAS), r('warehouse', 'compras')];
    expect(elegirRegla(derecho, 'warehouse', 'compras')?.tag).toBe('warehouse@compras');
  });

  it('⛔ una regla de OTRA área no se cuela — ignorarla importa tanto como preferir la propia', () => {
    const reglas = [r('warehouse', 'pdv')];
    expect(elegirRegla(reglas, 'warehouse', 'compras')).toBeUndefined();
    expect(elegirRegla(reglas, 'warehouse')).toBeUndefined();
  });

  it('no cruza dimensiones', () => {
    const reglas = [r('zone', 'compras'), r('warehouse', AREA_TODAS)];
    expect(elegirRegla(reglas, 'warehouse', 'compras')?.tag).toBe('warehouse@*');
    expect(elegirRegla(reglas, 'zone', 'compras')?.tag).toBe('zone@compras');
  });

  it('`area` ausente o null en la fila cuenta como la general', () => {
    expect(elegirRegla([r('warehouse', undefined)], 'warehouse', 'compras')?.tag).toBe('warehouse@*');
    expect(elegirRegla([{ dimension: 'warehouse', area: null }], 'warehouse', 'compras')).toBeDefined();
  });

  it('preguntar por `*` explícito es lo mismo que no preguntar por área', () => {
    const reglas = [r('warehouse', AREA_TODAS), r('warehouse', 'compras')];
    expect(elegirRegla(reglas, 'warehouse', AREA_TODAS)?.tag).toBe('warehouse@*');
  });
});

describe('[ZN.8] las áreas se DERIVAN del árbol, no se copian', () => {
  it('hay áreas, y son los proyectos de AUTHZ_TREE', () => {
    expect(AREAS_DE_ALCANCE.length).toBeGreaterThan(5);
    expect(AREAS_DE_ALCANCE.map((a) => a.id)).toContain('compras');
    // ⚠️ El proyecto del mostrador se llama `pdv` («Punto de Venta»), NO `tienda` — que es su
    // RUTA. Este test lo descubrió: el id y el prefijo de ruta no tienen por qué coincidir, y
    // asumir que sí es justo el typo que `esAreaDeAlcance` rechaza en silencio para el usuario.
    expect(AREAS_DE_ALCANCE.map((a) => a.id)).toContain('pdv');
  });

  it('todas traen etiqueta: un id pelado en pantalla obliga al front a su propia tabla', () => {
    expect(AREAS_DE_ALCANCE.every((a) => !!a.label && a.label.trim().length > 0)).toBe(true);
  });

  it('⛔ no hay ids repetidos — dos proyectos con el mismo id harían ambigua la precedencia', () => {
    const ids = AREAS_DE_ALCANCE.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('`*` es válida y se NOMBRA; un typo no lo es', () => {
    expect(esAreaDeAlcance(AREA_TODAS)).toBe(true);
    expect(etiquetaDeArea(AREA_TODAS)).toBe('Todas las áreas');
    expect(esAreaDeAlcance('compra')).toBe(false);
    expect(esAreaDeAlcance('')).toBe(false);
    expect(esAreaDeAlcance(null)).toBe(false);
  });
});
