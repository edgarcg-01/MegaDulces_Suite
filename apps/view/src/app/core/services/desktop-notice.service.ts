import { Injectable, signal } from '@angular/core';

/**
 * `[MS.AVISO]` Avisos del SISTEMA OPERATIVO (la burbuja de Windows), para cuando la Suite está abierta pero no a la vista.
 *
 * Una ventana emergente dentro de la página no la ve quien tiene otra pestaña o programa al frente; ésta sí. Sólo funciona con la
 * pestaña abierta (no es un push con la pestaña cerrada: eso exigiría un service worker y llaves VAPID, que no existen).
 *
 * El permiso lo da la PERSONA, una vez, desde un botón (los navegadores no dejan pedirlo sin un clic). Si lo niega o el navegador no
 * tiene la API, `permiso()` lo dice y el resto de la app sigue con su ventana emergente: **nunca se finge un aviso que no salió**.
 */
export type PermisoEscritorio = 'granted' | 'denied' | 'default' | 'unsupported';

@Injectable({ providedIn: 'root' })
export class DesktopNoticeService {
  readonly permiso = signal<PermisoEscritorio>(this.leer());

  private leer(): PermisoEscritorio {
    try {
      return typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as PermisoEscritorio);
    } catch {
      return 'unsupported';
    }
  }

  /** Pide el permiso. Llamar sólo desde un clic. */
  async solicitar(): Promise<PermisoEscritorio> {
    if (this.permiso() === 'unsupported') return 'unsupported';
    try {
      await Notification.requestPermission();
    } catch {
      /* Safari viejo usa callback y puede lanzar: se relee abajo */
    }
    this.permiso.set(this.leer());
    return this.permiso();
  }

  /** `true` si salió. `false` si no hay permiso o el navegador lo rechazó: quien llama decide qué hacer. */
  mostrar(titulo: string, cuerpo: string, alHacerClic: () => void, etiqueta?: string): boolean {
    if (this.permiso() !== 'granted') return false;
    try {
      // `tag` hace que dos avisos del mismo tipo no se apilen indefinidamente en el centro de notificaciones.
      const n = new Notification(titulo, { body: cuerpo, tag: etiqueta, icon: '/favicon.ico' });
      n.onclick = () => {
        try { window.focus(); } catch { /* sin foco no pasa nada */ }
        n.close();
        alHacerClic();
      };
      return true;
    } catch {
      return false;
    }
  }
}
