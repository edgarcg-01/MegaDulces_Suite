import type { IScannerControls } from '@zxing/browser';

/**
 * **Apagar la cámara de un lector de códigos (`@zxing/browser`) sin dejar un rechazo suelto.**
 *
 * zxing 0.2 tiene dos `stop()`. Sin linterna es síncrono. CON linterna —casi todo celular— es una
 * promesa: corta la cámara y después intenta apagar la linterna sobre la pista ya cortada, y eso se
 * RECHAZA. Un `try { controles.stop() } catch {}` no ve ese rechazo: queda suelto, el manejador global
 * lo atrapa y sale «Algo falló en esta pantalla» con cada código leído. *Medido en prod el 2026-11-03
 * (NP.7): el aviso caía 177 ms antes de que el servidor creara la ficha escaneada.*
 *
 * La usan los cuatro lectores de la app (levantamiento/caducidades, andén, verificador, conteo).
 */
export function detenerLector(controles: Pick<IScannerControls, 'stop'> | null | undefined): void {
  try {
    const cierre: unknown = controles?.stop();
    if (cierre && typeof (cierre as PromiseLike<unknown>).then === 'function') {
      (cierre as PromiseLike<unknown>).then(undefined, () => undefined);
    }
  } catch { /* la cámara ya estaba cerrada */ }
}

/**
 * Lo que devuelve `decodeFromConstraints` llega DESPUÉS de esperar el permiso y la cámara. Si en ese
 * lapso la persona tocó «Cancelar», el cierre no tenía nada que detener y la cámara se quedaba prendida
 * y leyendo detrás de la pantalla. Esto la apaga en cuanto llega si ya no hace falta.
 */
export function controlesSiSigueAbierta<T extends Pick<IScannerControls, 'stop'>>(controles: T, sigueAbierta: boolean): T | undefined {
  if (sigueAbierta) return controles;
  detenerLector(controles);
  return undefined;
}
