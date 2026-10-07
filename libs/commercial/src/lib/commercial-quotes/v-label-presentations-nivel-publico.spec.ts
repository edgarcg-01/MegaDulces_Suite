/**
 * `[ETQ.NIV.1]` Candado de la migración que deja de publicar el precio de un NIVEL DE CLIENTE
 * en la etiqueta de anaquel y en la vista previa de la cotización.
 *
 * El defecto: `kepler_ods.kdpv_prod_util` tiene DOS ejes —`c2` = presentación y `c3` = nivel de
 * precio del cliente (0 = mostrador, 1-3 = negociados)— y el CTE `esc` agrupaba sin `c3`,
 * aplastando los cuatro niveles; el desempate `ORDER BY c4, c7` se quedaba con el más barato.
 *
 * Esta prueba mira la FORMA del SQL. Lo que mira el DATO —que nada se publique por debajo del
 * nivel 0 de su plaza, y el caso canónico contra lo que de verdad se cobró— es
 * `database/tests/test-newdb-label-mayoreo-nivel-publico.js`. Las dos hacen falta: ésta se pone
 * roja cuando alguien cambia la regla sin querer; aquélla, cuando el dato de Kepler se mueve.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.

const DIR = join(__dirname, '../../../../../database/migrations-newdb');
const PREVIA = '20261002120000_v_label_presentations_not_materialized.js';
const NUEVA = '20261007155746_label_presentations_nivel_publico.js';

// Git puede dejar los archivos en CRLF; se compara siempre en LF.
const lf = (s: string) => s.replace(/\r\n/g, '\n');

function cuerpo(archivo: string): string {
  const src = readFileSync(join(DIR, archivo), 'utf8');
  return lf(src.split('const VIEW = `')[1].split('`;')[0]);
}

/** Parte el cuerpo en sus CTE: { nombre -> texto del CTE, sin el encabezado }. */
function ctes(sql: string): Record<string, string> {
  const re = /(?:^\nWITH |\n\), )(\w+) AS NOT MATERIALIZED \(\n/g;
  const cortes: { nombre: string; desde: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) cortes.push({ nombre: m[1], desde: m.index + m[0].length });
  const out: Record<string, string> = {};
  cortes.forEach((c, i) => {
    const hasta = i + 1 < cortes.length
      ? sql.lastIndexOf('\n), ', cortes[i + 1].desde)
      : sql.indexOf('\n)\nSELECT\n');
    out[c.nombre] = sql.slice(c.desde, hasta);
  });
  return out;
}

describe('v_label_presentations: el mayoreo sale de UN nivel (ETQ.NIV.1)', () => {
  const previa = ctes(cuerpo(PREVIA));
  const nueva = ctes(cuerpo(NUEVA));

  it('sólo toca la escalera: los demás CTE quedan byte por byte', () => {
    for (const n of ['cat', 'gramos_base', 'pres', 'uni']) {
      expect(nueva[n], `el CTE ${n} cambió y no debía`).toBe(previa[n]);
    }
  });

  it('el peldaño se elige DENTRO de un nivel (c3 entra al GROUP BY)', () => {
    expect(nueva['esc_niv']).toContain('u.c3::int');
    expect(nueva['esc_niv']).toContain('GROUP BY 1, 2, 3, 4');
    // La vieja agrupaba por 1,2,3 y por eso mezclaba niveles.
    expect(previa['esc']).toContain('GROUP BY 1, 2, 3');
    expect(previa['esc']).not.toContain('c3');
  });

  it('gana el nivel MÁS SUPERFICIAL, nunca el más barato', () => {
    expect(nueva['esc']).toContain('DISTINCT ON (sucursal, sku, unidad)');
    expect(nueva['esc']).toContain('ORDER BY sucursal, sku, unidad, nivel');
    expect(nueva['esc']).toContain('FROM esc_niv');
  });

  it('el nivel 0 es PISO aunque no tenga umbral (los 133 grupos de umbral <= 1)', () => {
    expect(nueva['piso_publico']).toContain('u.c3::int = 0');
    // El piso NO le exige umbral: si lo hiciera, no cerraría el hueco que existe para cerrar.
    expect(nueva['piso_publico']).not.toContain('floor(u.c4');
  });

  it('el piso frena ANTES del árbitro de lista, en los tres CASE', () => {
    const sql = cuerpo(NUEVA);
    const piso = [...sql.matchAll(/t\.piso_publico IS NOT NULL AND t\.mayoreo_precio < t\.piso_publico/g)];
    expect(piso).toHaveLength(3); // precio, desde y veredicto
    // En cada CASE el piso va antes de la banda 0.5..1, o la banda decidiría primero.
    for (const p of piso) {
      const banda = sql.indexOf('BETWEEN 0.5 AND 1', p.index as number);
      expect(banda).toBeGreaterThan(p.index as number);
    }
    expect(sql).toContain("THEN 'bajo_nivel_publico'");
  });

  it('la columna nueva va AL FINAL (CREATE OR REPLACE VIEW no admite otra cosa)', () => {
    const sql = cuerpo(NUEVA);
    const cola = sql.slice(sql.lastIndexOf('AS mayoreo_veredicto'));
    expect(cola).toContain('AS mayoreo_nivel');
    expect(cola.indexOf('AS mayoreo_nivel')).toBeLessThan(cola.indexOf('FROM todo t'));
    // Y el orden de las que ya existían no se mueve. Se mira SÓLO el SELECT final: dentro de los
    // CTE hay alias homónimos (`AS sucursal`, `AS mayoreo_precio`) que no son columnas de salida.
    const salida = sql.slice(sql.indexOf('\n)\nSELECT\n'));
    const orden = [...salida.matchAll(/ AS (\w+)[,\n]/g)].map((m) => m[1]);
    expect(orden).toEqual([
      'contenido', 'precio_lista', 'mayoreo_precio', 'mayoreo_desde', 'mayoreo_veredicto', 'mayoreo_nivel',
    ]);
  });

  it('los CTE nuevos también son NOT MATERIALIZED (si no, el filtro no baja y vuelven los 3 s)', () => {
    const marcados = [...cuerpo(NUEVA).matchAll(/\b(\w+) AS NOT MATERIALIZED \(/g)].map((m) => m[1]);
    expect(marcados).toEqual(['cat', 'gramos_base', 'pres', 'esc_niv', 'piso_publico', 'esc', 'uni', 'todo']);
  });

  it('prueba negativa: quitar c3 del GROUP BY SÍ se detecta', () => {
    const roto = ctes(cuerpo(NUEVA).replace('GROUP BY 1, 2, 3, 4', 'GROUP BY 1, 2, 3'));
    expect(roto['esc_niv']).not.toContain('GROUP BY 1, 2, 3, 4');
    expect(roto['esc_niv']).toContain('GROUP BY 1, 2, 3');
  });

  // GOTCHAS §38. `CREATE OR REPLACE VIEW` toma ACCESS EXCLUSIVE y esta vista la leen en vivo la
  // etiquetera y la vista previa de la cotización. El freno va ANTES del DDL, o llega tarde.
  it('frena antes del DDL, y no después', () => {
    const src = lf(readFileSync(join(DIR, NUEVA), 'utf8'));
    const up = src.split('exports.up')[1].split('exports.down')[0];
    const freno = up.indexOf('SET LOCAL lock_timeout');
    const ddl = up.indexOf('knex.raw(VIEW)');
    expect(freno).toBeGreaterThan(-1);
    expect(freno).toBeLessThan(ddl);
  });
});
