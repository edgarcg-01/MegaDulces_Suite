// ⛔ [CG.38] Acá decía `import { describe, it, expect } from 'vitest'` y el archivo **no
// cargaba**: `TypeError: Cannot read properties of undefined (reading 'config')`. La config de
// este proyecto corre con `globals: true`, así que los helpers ya están en el ámbito.
//
// ⚠️ Y lo que esto enseña vale más que el arreglo: un spec que **falla al cargar** reporta
// **0 tests**, no 9 fallando. El resumen decía "420 passed · 1 failed file" y el número grande
// seguía creciendo — las 9 pruebas de [PP.7] llevaban desde que se escribieron **sin correr una
// sola vez**. Es ADR-056 en su forma más incómoda: lo que no se midió no se puede leer como ✔.
import { coberturaLibro } from './payment-program.engine';

/**
 * [PP.7] El candado de la cobertura del libro de Tesorería.
 *
 * El `hoy` se inyecta en todos los casos: una prueba de calendario que lee el reloj de la máquina
 * pasa hoy y falla sola el mes que viene, y entonces nadie sabe si se rompió el código o el día.
 */
describe('coberturaLibro', () => {
  // Lo que había en prod el 2026-10-05, para que el caso real quede fijado.
  const ENE_AGO = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

  it('el caso REAL de prod: con ene–ago cargados, al 5-oct falta septiembre', () => {
    const r = coberturaLibro(ENE_AGO, new Date('2026-10-05T18:00:00Z'));
    expect(r.faltantes).toEqual(['2026-09']);
    expect(r.desde).toBe('2026-01');
    expect(r.hasta_esperado).toBe('2026-09');
  });

  it('encuentra el hueco en MEDIO, no sólo la cola', () => {
    // Marzo falta aunque abril esté: un faltante intermedio es el que más engaña, porque la serie
    // "sigue" y el total del año se ve completo.
    const r = coberturaLibro(['2026-01', '2026-02', '2026-04'], new Date('2026-06-10T18:00:00Z'));
    expect(r.faltantes).toEqual(['2026-03', '2026-05']);
  });

  // ── PRUEBAS NEGATIVAS: que NO marque lo que no debe marcar ────────────────────────────────
  // Un gate que sólo se prueba con el caso que debe encender es una intención: hay que romperlo
  // a propósito y verificar que se queda apagado.

  it('NEGATIVA — el mes EN CURSO no se exige', () => {
    // Al 5-oct, tener septiembre es estar al día. Si octubre contara, el aviso viviría encendido.
    const r = coberturaLibro(['2026-09'], new Date('2026-10-05T18:00:00Z'));
    expect(r.faltantes).toEqual([]);
    expect(r.hasta_esperado).toBe('2026-09');
  });

  it('NEGATIVA — sin nada cargado NO dice que falta todo', () => {
    const r = coberturaLibro([], new Date('2026-10-05T18:00:00Z'));
    expect(r).toEqual({ cargados: [], faltantes: [], desde: null, hasta_esperado: null });
  });

  it('NEGATIVA — no inventa meses ANTERIORES al primero cargado', () => {
    // El universo arranca en el primer mes que existe; la historia previa no es un hueco.
    const r = coberturaLibro(['2026-07', '2026-08', '2026-09'], new Date('2026-10-05T18:00:00Z'));
    expect(r.faltantes).toEqual([]);
    expect(r.desde).toBe('2026-07');
  });

  it('BORDE de año — enero mira a diciembre del año anterior, no al mes -1', () => {
    const r = coberturaLibro(['2025-11'], new Date('2026-01-15T18:00:00Z'));
    expect(r.faltantes).toEqual(['2025-12']);
    expect(r.hasta_esperado).toBe('2025-12');
  });

  it('BORDE — el día 1 del mes se comporta igual que el día 28', () => {
    const uno = coberturaLibro(ENE_AGO, new Date('2026-10-01T06:00:00Z'));
    const veintiocho = coberturaLibro(ENE_AGO, new Date('2026-10-28T23:00:00Z'));
    expect(uno.faltantes).toEqual(['2026-09']);
    expect(veintiocho.faltantes).toEqual(['2026-09']);
  });

  it('ignora basura y duplicados sin romperse, y devuelve ordenado', () => {
    const r = coberturaLibro(['2026-02', '2026-01', '2026-02', '', 'OCTUBRE', '26-1' as string], new Date('2026-04-10T18:00:00Z'));
    expect(r.cargados).toEqual(['2026-01', '2026-02']);
    expect(r.faltantes).toEqual(['2026-03']);
  });

  it('un hueco largo se enumera entero, en orden', () => {
    const r = coberturaLibro(['2026-01', '2026-06'], new Date('2026-07-10T18:00:00Z'));
    expect(r.faltantes).toEqual(['2026-02', '2026-03', '2026-04', '2026-05']);
  });
});
