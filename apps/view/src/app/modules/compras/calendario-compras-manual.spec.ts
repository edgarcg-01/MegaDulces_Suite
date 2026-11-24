import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ETIQUETA_MOTIVO_NO_SE_PIDE } from '@megadulces/contracts';

import { NOMBRE_ESCALON } from './calendario-compras-reglas';
import { direccionDelManual } from '../../shared/components/manual-link/manual-link.component';

/**
 * `[PQ.3.20]` **El manual no puede enseñar una pantalla que ya no existe.**
 *
 * El manual de capacitación (`assets/manuales/calendario-compras.html`) enseña la pantalla con sus rótulos exactos.
 * Si la pantalla cambia un rótulo y el manual no, la persona busca un botón que no encuentra. Este candado saca los
 * rótulos DE LA PANTALLA (no de una lista escrita a mano) y exige que cada uno esté en el manual:
 * - las opciones de los controles segmentados y las cifras del encabezado (`label: '…', value:`);
 * - los botones con texto fijo (`p-button-label`), los rótulos de los formularios (`cc-label`) y las columnas (`<th>`);
 * - los estados (`estadoEnPalabras`), los motivos de «Hoy no se pide» y los escalones del embudo.
 *
 * Un rótulo NUEVO en la pantalla lo pone en rojo hasta que el manual lo enseñe (o se exime aquí, con su porqué).
 * ⚠️ No prueba que el manual explique bien cada rótulo: sólo que no enseña uno que la pantalla ya no tiene ni se
 * salta uno que tiene.
 */
const SRC = join(__dirname, '..', '..', '..');
const MANUAL = join(SRC, direccionDelManual('calendario-compras'));
const PANTALLA = join(__dirname, 'pages', 'compras-calendario.component.ts');
const REGLAS = join(__dirname, 'calendario-compras-reglas.ts');

/** Espacios normales: el manual y la pantalla usan espacios que no se parten (U+00A0, `&nbsp;`). */
const plano = (t: string) => t.replace(/&nbsp;/g, ' ').replace(/[ \t\r\n ]+/g, ' ').trim();

/** El texto del manual como lo lee una persona: sin script, sin estilos, sin etiquetas. */
function textoDelManual(): string {
  const html = readFileSync(MANUAL, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return plano(html);
}

const todos = (re: RegExp, texto: string) => [...texto.matchAll(re)].map((m) => plano(m[1])).filter(Boolean);

/** Los rótulos fijos que la pantalla muestra, leídos de su código. */
function rotulosDeLaPantalla(): string[] {
  const p = readFileSync(PANTALLA, 'utf8');
  const r = readFileSync(REGLAS, 'utf8');
  return [...new Set([
    ...todos(/label: '([^']+)', value:/g, p),
    ...todos(/class="p-button-label">([^<{]+)</g, p),
    ...todos(/class="cc-label"[^>]*>([^<{]+)</g, p),
    ...todos(/<th>([^<]+)<\/th>/g, p),
    ...todos(/header="([^"{]+)"/g, p),
    ...todos(/etiqueta: '([^']+)'/g, r),
    ...todos(/etiqueta: `([^$`]+)/g, r),
    ...Object.values(ETIQUETA_MOTIVO_NO_SE_PIDE),
    ...Object.values(NOMBRE_ESCALON).map(plano),
  ])];
}

/** Rótulos de la pantalla que el manual no tiene por qué enseñar, cada uno con su porqué. */
const EXENTOS: Readonly<Record<string, string>> = {};

describe('[PQ.3.20] el manual del Calendario de compras', () => {
  it('existe donde lo busca el botón «Manual»', () => {
    expect(existsSync(MANUAL), MANUAL).toBe(true);
  });

  it('la pantalla monta el botón que lleva a ESE manual', () => {
    expect(readFileSync(PANTALLA, 'utf8')).toContain('<app-manual-link manual="calendario-compras"');
  });

  it('el instrumento sabe decir que no (control): un rótulo inventado no está en el manual', () => {
    expect(textoDelManual()).not.toContain('Borrar todas las reglas');
    expect(textoDelManual()).toContain('Calendario de compras');
  });

  it('lee de la pantalla los rótulos de cada familia (si una lectura se rompe, no pasa en silencio)', () => {
    const rs = rotulosDeLaPantalla();
    for (const esperado of ['Por revisar', 'Sin regla', 'Todas las sucursales', 'Cada N días', 'Se adelanta al viernes', 'Hoy no se pide',
      'Rezagadas', 'Marcar', 'Abrir en Pedido', 'Definir regla', '¿Dónde se revisa?', 'Fuera de ciclo hasta', 'Peso en la compra',
      'Dar de baja la regla', 'Toca hoy', 'Rezagada ·', 'Ya hay pedido']) {
      expect(rs, `no leyó «${esperado}» de la pantalla`).toContain(esperado);
    }
  });

  it('⭐ cada rótulo de la pantalla está en el manual', () => {
    const manual = textoDelManual();
    const faltan = rotulosDeLaPantalla().filter((r) => !(r in EXENTOS) && !manual.includes(r));
    expect(faltan, `La pantalla tiene rótulos que el manual no enseña: ${faltan.join(' · ')}`).toEqual([]);
  });
});
