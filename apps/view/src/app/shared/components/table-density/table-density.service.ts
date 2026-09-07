import { Injectable, signal } from '@angular/core';

const KEY = 'md.table-density';

/**
 * `[RE.17.6]` — DESIGN §datos densos 2: la tabla de Operations mide 40px y **se puede bajar a
 * 32px para quien vive en ella**. La clase `surf-table--plain.is-dense` existe en `styles.css`
 * desde que se escribió la regla y ninguna pantalla la exponía.
 *
 * La preferencia es del USUARIO, no de la pantalla: quien la aprieta en "Pendientes" espera
 * encontrarla apretada al pasar a "Órdenes". Por eso vive en un servicio con `localStorage` y
 * no en un signal por componente.
 *
 * Se lee con `try/catch`: en una ventana privada o con las cookies bloqueadas, `localStorage`
 * lanza al ACCEDER, no al leer un valor vacío — y una preferencia de densidad no puede tumbar
 * la pantalla.
 */
@Injectable({ providedIn: 'root' })
export class TableDensityService {
  readonly dense = signal(this.leer());

  toggle(): void {
    const v = !this.dense();
    this.dense.set(v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* sin almacenamiento: vive la sesión */ }
  }

  private leer(): boolean {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  }
}
