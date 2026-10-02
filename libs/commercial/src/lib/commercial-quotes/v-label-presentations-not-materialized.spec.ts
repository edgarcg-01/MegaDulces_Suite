/**
 * `[COT.17]` Candado de la migración que acelera `analytics.v_label_presentations`.
 *
 * La migración 20261002120000 dice: "el cuerpo es el de la original byte por byte, sólo con
 * `NOT MATERIALIZED` agregado". Esta prueba lo comprueba, en lugar de confiar en el comentario:
 * si alguien cambia una regla de negocio en la vista nueva, o se pierde un `NOT MATERIALIZED`
 * (y la vista previa vuelve a tardar 3 s), se pone roja.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../../../../database/migrations-newdb');

// Git puede dejar los archivos en CRLF; un template literal de JS normaliza a LF al evaluarse.
// Se compara siempre en LF para que el candado no dependa de la máquina.
const lf = (s: string) => s.replace(/\r\n/g, '\n');

function sqlOriginal(): string {
  const src = readFileSync(join(DIR, '20260924120000_v_label_presentations.js'), 'utf8');
  const raw = src.split('const VIEW = `')[1].split('`;')[0];
  // La original interpola los umbrales (`${0.5}`): se evalúa igual que lo hace Node al cargarla.
  return lf(new Function('return `' + raw + '`')() as string);
}

function sqlNueva(): string {
  const src = readFileSync(join(DIR, '20261002120000_v_label_presentations_not_materialized.js'), 'utf8');
  return lf(src.split('const VIEW = `')[1].split('`;')[0]);
}

describe('v_label_presentations NOT MATERIALIZED (COT.17)', () => {
  it('es la vista original, sin ningún otro cambio', () => {
    expect(sqlNueva().replace(/ AS NOT MATERIALIZED \(/g, ' AS (')).toBe(sqlOriginal());
  });

  it('marca los 6 CTE, para que el filtro por sucursal + sku entre a cada uno', () => {
    const marcados = [...sqlNueva().matchAll(/\b(\w+) AS NOT MATERIALIZED \(/g)].map((m) => m[1]);
    expect(marcados).toEqual(['cat', 'gramos_base', 'pres', 'esc', 'uni', 'todo']);
  });

  it('prueba negativa: un cambio de regla SÍ se detecta', () => {
    const alterada = sqlNueva().replace('BETWEEN 0.5 AND 1', 'BETWEEN 0.4 AND 1');
    expect(alterada).not.toBe(sqlNueva());
    expect(alterada.replace(/ AS NOT MATERIALIZED \(/g, ' AS (')).not.toBe(sqlOriginal());
  });

  // GOTCHAS §38. `CREATE OR REPLACE VIEW` toma ACCESS EXCLUSIVE, y esta vista la leen en vivo la
  // vista previa de la cotización y la etiquetera. Medido: con el candado la migración muere a
  // los 3.0 s con 55P03; sin él seguía bloqueada a los 8 s, con la pantalla detrás. El criterio
  // es CALIENTE, no grande. Y tiene que ir ANTES del DDL, o llega tarde.
  it('frena antes del DDL, y no después', () => {
    const src = lf(readFileSync(join(DIR, '20261002120000_v_label_presentations_not_materialized.js'), 'utf8'));
    const cuerpo = src.split('exports.up')[1].split('exports.down')[0];
    const freno = cuerpo.indexOf('SET LOCAL lock_timeout');
    const ddl = cuerpo.indexOf('knex.raw(VIEW)');
    expect(freno).toBeGreaterThan(-1);
    expect(freno).toBeLessThan(ddl);
  });
});
