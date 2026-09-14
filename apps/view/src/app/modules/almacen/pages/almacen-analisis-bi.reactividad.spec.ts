/**
 * WMS-BI.4.7 — Candado de reactividad: un `computed()` que lee un CAMPO PLANO queda congelado.
 *
 * Esta suite no prueba el componente entero: prueba **la regla que el componente violaba**, con
 * la misma forma exacta del código que estaba en producción. Existe porque bajo
 * `provideZonelessChangeDetection()` (app.config.ts) el síntoma es mudo — no hay error, no hay
 * warning: el valor simplemente no cambia nunca, y en una pantalla con 3 pestañas y 25 columnas
 * eso se lee como "el filtro no hace nada".
 *
 * Los dos casos son los que se encontraron medidos el 2026-09-14 en
 * `almacen-analisis-bi.component.ts`:
 *
 *   1. `warehouseOptsFiltered = computed(() => { const z = this.selectedZoneIds; ... })`
 *      — `selectedZoneIds` era un `string[]` plano. El computed SÍ se invalidaba cuando cambiaba
 *      `filters()` (señal), así que parecía vivo al cargar la página; pero elegir una Zona no
 *      volvía a filtrar el desplegable de Almacén. El bug se escondía detrás de otra dependencia.
 *
 *   2. `selectedFields = computed(() => this.selectedFieldsList)`
 *      — **cero** dependencias de señal ⇒ se evalúa UNA vez y se cachea para siempre. Tildar una
 *      casilla en "Explorar datos" no cambiaba ni el encabezado ni las celdas.
 *
 * ⚠️ El caso 1 es el que enseña la lección: *"le puse un `computed` y se actualiza"* es falso —
 * se actualizaba por la señal de al lado, no por la que el usuario tocaba.
 */
import { computed, signal } from '@angular/core';

describe('WMS-BI.4.7 · un computed sólo reacciona a SEÑALES', () => {
  it('REPRODUCE el bug: computed sobre campo plano nunca se recomputa', () => {
    const host = {
      zonas: [] as string[],                       // campo plano, como estaba
      almacenes: signal([{ id: 'a', zona: 'z1' }, { id: 'b', zona: 'z2' }]),
    };
    const filtrado = computed(() => {
      const z = host.zonas;                        // <-- lectura NO reactiva
      const todos = host.almacenes();
      return z.length ? todos.filter((w) => z.includes(w.zona)) : todos;
    });

    expect(filtrado().length).toBe(2);
    host.zonas = ['z1'];
    // Sin señal de por medio el computed sigue sirviendo su caché: 2, no 1.
    expect(filtrado().length).toBe(2);
  });

  it('REPRODUCE el bug: computed sin NINGUNA dependencia queda congelado para siempre', () => {
    const host = { campos: ['a', 'b'] as string[] };
    const seleccionados = computed(() => host.campos);

    expect(seleccionados()).toEqual(['a', 'b']);
    host.campos = ['a', 'b', 'c'];
    expect(seleccionados()).toEqual(['a', 'b']);   // congelado
  });

  it('EL FIX: con signal(), el computed sigue al usuario', () => {
    const host = {
      zonas: signal<string[]>([]),
      almacenes: signal([{ id: 'a', zona: 'z1' }, { id: 'b', zona: 'z2' }]),
    };
    const filtrado = computed(() => {
      const z = host.zonas();
      const todos = host.almacenes();
      return z.length ? todos.filter((w) => z.includes(w.zona)) : todos;
    });

    expect(filtrado().length).toBe(2);
    host.zonas.set(['z1']);
    expect(filtrado().length).toBe(1);
    expect(filtrado()[0].id).toBe('a');
  });

  it('EL FIX: un signal de lista reevalúa al reasignar', () => {
    const campos = signal<string[]>(['a', 'b']);
    const seleccionados = computed(() => campos());

    expect(seleccionados()).toEqual(['a', 'b']);
    campos.set(['a', 'b', 'c']);
    expect(seleccionados()).toEqual(['a', 'b', 'c']);
  });
});
