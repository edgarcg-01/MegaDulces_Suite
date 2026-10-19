import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * `[RA-FIX.4]` — **El candado del redondeo a caja: que no aparezca un tercero.**
 *
 * ## Qué protege, y qué NO
 *
 * Hoy la cantidad final del pedido se redondea en **dos** sitios, y cada uno contesta la pregunta
 * con una regla distinta:
 *
 * | superficie | quién redondea | regla |
 * |---|---|---|
 * | `/compras/pedido` | `roundSeedConTope` — **este módulo** | caja cerrada + tope de 45 días |
 * | `/almacen/autoabasto` | `redondearPedido` + `aplicarMinimoMenor` — **`libs/contracts`** | escalera de unidades + mínimo $200 + resta `ya_pedido` |
 *
 * ⛔ **Este candado NO une las dos reglas** — unirlas cambia el número que se le pide a un
 * proveedor y eso es una decisión de negocio, que va medida antes/después y en su propio commit.
 * Lo que este candado impide es **que aparezca un tercero**: que la próxima pantalla que necesite
 * convertir piezas a cajas lo vuelva a escribir a mano, como ya pasó seis veces con la resta del
 * tránsito antes de `transito.ts`.
 *
 * ⚠️ Un escaneo por regex **no es un test**: no prueba que el redondeo sea correcto. Prueba una
 * sola cosa, y es la que importa acá: que siga habiendo **un** lugar en este módulo. Por eso
 * lleva su propia prueba negativa.
 */

const DIR = __dirname;

/** Los dueños legítimos del redondeo en este módulo. Todo lo demás se escanea. */
const DUENOS = ['pedido-redondeo.ts', 'pedido-tope.ts'];

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { fuentes(p, acc); continue; }
    if (!e.endsWith('.ts') || e.endsWith('.spec.ts')) continue;
    if (DUENOS.includes(e)) continue;
    acc.push(p);
  }
  return acc;
}

/**
 * La firma de una conversión pieza↔caja escrita a mano: aritmética contra `uxc` (unidades por
 * caja). Es la forma exacta que tiene el redondeo en `pedido-redondeo.ts`.
 *
 * ⚠️ NO marca declararlo ni pasarlo (`uxc: number`, `r.uxc`, `uxc,`): arrastrar el factor hasta
 * el lugar que decide es lo correcto; un detector que marcara eso obligaría a repartir la
 * decisión, que es peor que el problema.
 */
const CONVERSION_A_MANO = /[*/]\s*\(?\s*(?:[\w.]+\.)?uxc\b|\buxc\b\s*[*/]/;

function escanear(texto: string): boolean {
  return CONVERSION_A_MANO.test(texto);
}

describe('[RA-FIX.4] un solo redondeo a caja en el módulo de compras', () => {
  it('encuentra los fuentes que dice escanear', () => {
    const fs_ = fuentes(DIR).map((p) => p.split(/[\\/]/).pop());
    expect(fs_).toContain('compras.service.ts');
    expect(fs_).toContain('compras-pedido-real.component.ts');
    expect(fs_.length).toBeGreaterThanOrEqual(10);
  });

  it('⭐ PRUEBA NEGATIVA: el detector SÍ se pone rojo con la conversión a mano', () => {
    expect(escanear('const cajas = Math.ceil(pz / uxc);')).toBe(true);
    expect(escanear('const pz = cajas * r.uxc;')).toBe(true);
    expect(escanear('return Math.round(total / (uxc || 1));')).toBe(true);
    expect(escanear('const n = uxc * 2;')).toBe(true);
  });

  it('⭐ y NO se pone rojo con arrastrar o declarar el factor', () => {
    expect(escanear('uxc?: number | null;')).toBe(false);
    expect(escanear('roundSeedConTope(c.ped, r.uxc, c.exis, c.vta, !!c.rung)')).toBe(false);
    expect(escanear('box_size: number | null;         // Pz/Caja (etiqueta) — normalmente = uxc')).toBe(false);
    expect(escanear('const { uxc, cells } = row;')).toBe(false);
  });

  it('⛔ ningún fuente del módulo convierte piezas↔cajas fuera de sus dos dueños', () => {
    const culpables = fuentes(DIR)
      .filter((p) => escanear(readFileSync(p, 'utf8')))
      .map((p) => p.split(/[\\/]/).pop());
    expect(culpables, `redondeo a mano fuera de ${DUENOS.join(' / ')}`).toEqual([]);
  });
});
