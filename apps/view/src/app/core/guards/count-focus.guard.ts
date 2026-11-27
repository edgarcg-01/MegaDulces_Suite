import { CanDeactivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { CountFocusService } from '../services/count-focus.service';
import { InventoryOfflineService } from '../services/inventory-offline.service';

/**
 * Confirma antes de abandonar la pantalla de conteo. No bloquea de forma dura — pide
 * confirmación para evitar salidas accidentales.
 *
 * Pregunta por **dos** motivos distintos, y lo dice:
 *
 * 1. **Jornada activa** (modo foco): salir la interrumpe. Tocar «Terminar» apaga el modo foco,
 *    así que ahí ya no pregunta por esto.
 * 2. ⛔ `[ICR.M5]` **Cola sucia**: hay escaneos capturados que todavía no llegaron al folio.
 *    Esto se revisa **aunque la jornada ya haya terminado**, que es justo cuando la persona se
 *    va: lo capturado vive en Dexie y se drena al volver a entrar, pero si nadie vuelve a
 *    entrar con ese dispositivo, el supervisor cierra el folio sin esas filas y la mercancía
 *    sale como faltante. La regla operativa del acta del 2026-11-27 es «nadie se va con la
 *    cola en rojo»; éste es el único punto del código donde eso se puede ejercer.
 *
 * ⚠️ Usa `confirm()` nativo, igual que antes. `DESIGN.md` pide `p-confirmDialog`, pero un
 * `CanDeactivateFn` corre fuera del árbol de la pantalla y cambiarlo a un diálogo de PrimeNG es
 * un rediseño del guard, no parte de `[ICR.M5]`. Queda como deuda con nombre: **no crece** —
 * sigue habiendo una sola llamada.
 */
export const countFocusGuard: CanDeactivateFn<unknown> = () => {
  const focus = inject(CountFocusService);
  const offline = inject(InventoryOfflineService);
  const enCurso = focus.active();
  const sinSubir = offline.pending();
  if (!enCurso && sinSubir <= 0) return true;

  const motivos: string[] = [];
  if (enCurso) motivos.push('Tienes un conteo en curso: si sales ahora se interrumpe.');
  if (sinSubir > 0) {
    motivos.push(
      `Quedan ${sinSubir} escaneo(s) sin subir. Se guardan en este dispositivo, pero no entran al folio hasta que vuelvas a abrir esta pantalla con conexión.`,
    );
  }
  return confirm(`${motivos.join('\n')}\n¿Quieres salir de todas formas?`);
};
