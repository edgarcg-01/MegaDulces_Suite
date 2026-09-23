import { DestroyRef, NgZone, inject } from '@angular/core';

/**
 * Poléa SOLO mientras la pestaña se está viendo, y se pone al día al volver.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * Medido en 'apps/view' el 2026-09-22: 14 componentes usan 'setInterval' y sólo
 * 2 miran si la pestaña se ve. El resto sigue pidiendo al API en una pestaña que
 * nadie tiene delante, así que el costo se multiplica por cada ventana abierta.
 * El caso que manda es 'notifications-bell': vive en el header del layout, o sea
 * corre en TODA pantalla de la Suite, y cada vuelta son 2 peticiones cada 60 s.
 *
 * El mecanismo no se inventa acá: 'tienda-arqueo' ya lo tenía completo (chequea
 * 'visibilityState' antes de la consulta y vuelve a consultar al reaparecer) y
 * 'tienda-arqueo-historial' tenía la mitad (chequea, pero no se pone al día).
 * Esto es esa lógica subida a un lugar, que es lo que pide ADR-056.
 *
 * ── Por qué "ponerse al día" no es opcional ───────────────────────────────────
 * Pausar sin volver a consultar al reaparecer deja al usuario mirando datos más
 * viejos que antes del cambio: volvés a la pestaña y esperás hasta 60 s a que el
 * timer caiga. Con la puesta al día, pausar AHORRA peticiones y además devuelve
 * dato MÁS fresco que el timer ciego, que pudo haber corrido hace 59 s.
 *
 * ── Lo que NO hace ────────────────────────────────────────────────────────────
 * No es para relojes de UI ('_now.set(Date.now())' para pintar "hace N min") ni
 * para contadores de una operación en curso: ésos no cuestan red y pausarlos
 * congelaría la pantalla. Esto es para el trabajo que sale a la red.
 */
export interface OpcionesEncuesta {
  /**
   * Correr una vez de inmediato, al arrancar. Default 'false': casi todas las
   * pantallas ya cargan por su cuenta en el 'ngOnInit' y no queremos duplicar
   * esa primera consulta.
   */
  inmediato?: boolean;
  /**
   * Volver a consultar al reaparecer la pestaña. Default 'true' — ver arriba.
   * Sólo tiene sentido apagarlo si la consulta es cara y el dato no envejece.
   */
  alVolver?: boolean;
  /**
   * Para llamar desde 'ngOnInit', que NO es contexto de inyección. Varias
   * pantallas deciden ahí si polean (según permiso o si el socket conectó), así
   * que exigir el constructor las obligaría a arrancar y parar el timer.
   */
  destroyRef?: DestroyRef;
  zone?: NgZone;
}

/** Corta la encuesta. Se llama sola al destruirse el componente que la creó. */
export type PararEncuesta = () => void;

/**
 * Arranca una encuesta atada al ciclo de vida de quien la llama.
 *
 * Se llama desde un contexto de inyección (constructor o field initializer):
 * toma 'DestroyRef' para cortarse sola, y 'NgZone' porque los listeners de
 * 'document' entran fuera de Angular.
 */
export function encuestarVisible(
  cadaMs: number,
  trabajo: () => void,
  opciones: OpcionesEncuesta = {},
): PararEncuesta {
  const destroyRef = opciones.destroyRef ?? inject(DestroyRef);
  const zone = opciones.zone ?? inject(NgZone);
  const alVolver = opciones.alVolver ?? true;

  let timer: ReturnType<typeof setInterval> | null = null;
  let ultimaCorrida = 0;
  let parado = false;

  const correr = () => {
    ultimaCorrida = Date.now();
    zone.run(trabajo);
  };

  const visible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden';

  const arrancar = () => {
    if (parado || timer !== null) return;
    timer = setInterval(correr, cadaMs);
  };

  const pausar = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const alCambiarVisibilidad = () => {
    if (parado) return;
    if (!visible()) {
      pausar();
      return;
    }
    // Al volver: si la pestaña estuvo oculta más de un ciclo, el dato en
    // pantalla ya está vencido — se consulta ya, no se espera al timer.
    if (alVolver && Date.now() - ultimaCorrida >= cadaMs) correr();
    arrancar();
  };

  if (typeof document !== 'undefined') {
    zone.runOutsideAngular(() => document.addEventListener('visibilitychange', alCambiarVisibilidad));
  }

  if (opciones.inmediato) correr();
  else ultimaCorrida = Date.now(); // sin esto, la 1ª vuelta visible dispararía la puesta al día
  if (visible()) arrancar();

  const parar: PararEncuesta = () => {
    parado = true;
    pausar();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
    }
  };

  destroyRef.onDestroy(parar);
  return parar;
}
