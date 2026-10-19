import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[HF.1]` **Un solo control dice «hay versión nueva», y es el que de verdad
 * actualiza.**
 *
 * ── Lo que se quitó, y por qué ───────────────────────────────────────────────
 * La barra superior tenía un botón `pi pi-refresh` que GIRABA, con un punto
 * rojo pulsando al lado. Todo en él decía «hay una actualización, apretá».
 *
 *  · Lo prendían eventos `capture:created/synced/deleted` — un compañero
 *    registró una visita. Nada que ver con versiones de la app.
 *  · Al apretarlo llamaba `dismissUpdate()`, que **sólo apaga su propio
 *    indicador**: no recarga, no trae datos, no navega.
 *
 * O sea: un control que prometía una acción que no ejecutaba. Es la misma falta
 * que dibujar un cero donde no hubo medición (ADR-056), movida al eje de la
 * acción — y como el ícono era el mismo `pi-refresh` del aviso REAL, además
 * competía con él.
 *
 * Reportado por Edgar el 2026-10-16: «parece para refrescar a la nueva
 * actualización».
 *
 * ── Qué fija este gate ───────────────────────────────────────────────────────
 * Que el falso no vuelva, y que el verdadero siga existiendo. Lo segundo importa
 * tanto como lo primero: quitar el ruido sirve de poco si de paso se pierde el
 * aviso que sí recarga, y el día del deploy nadie se entera.
 */
describe('[HF.1] el aviso de versión nueva', () => {
  const RAIZ = join(__dirname, '..', '..', '..');
  const leer = (rel: string): string => readFileSync(join(RAIZ, rel), 'utf8');

  const layoutHtml = leer('modules/dashboard/layout/layout.component.html');
  const layoutTs = leer('modules/dashboard/layout/layout.component.ts');
  const appHtml = leer('app.component.html');

  it('el botón que no hacía nada no volvió a la barra', () => {
    // ⚠️ Se mira la DECLARACIÓN, no la mención: el comentario que explica por
    // qué se fue nombra al método, y un gate que se tropieza con su propia
    // documentación enseña a borrar la documentación.
    expect(layoutTs).not.toMatch(/^\s*dismissPendingUpdate\s*\(/m);
    expect(layoutTs).not.toMatch(/^\s*hasPendingUpdate\s*=/m);
    // En la plantilla sí alcanza con la mención: ahí no hay nada que declarar.
    expect(layoutHtml).not.toMatch(/\(click\)="dismissPendingUpdate\(\)"/);
    expect(layoutHtml).not.toMatch(/\[class[.\w]*\]="hasPendingUpdate\(\)"/);
    expect(layoutHtml).not.toMatch(/@if \(hasPendingUpdate\(\)\)/);
  });

  /**
   * El aviso real: service worker de verdad, y **ofrece** en vez de imponer —
   * recargar bajo las manos de alguien que está capturando es peor que esperar.
   */
  it('el aviso REAL sigue en pie, y es el único que promete actualizar', () => {
    expect(appHtml).toMatch(/updateReady\(\)/);
    expect(appHtml).toMatch(/applyUpdate\(\)/);
    expect(appHtml).toMatch(/versión nueva/i);
  });

  /**
   * NEGATIVA sobre el vocabulario: `pi-refresh` es el ícono de «actualizar».
   * Que aparezca en la barra sin llevar a `applyUpdate()` es exactamente lo que
   * confundió. Si alguien necesita un refresh de DATOS, que no use este ícono en
   * el chrome — o que lo discuta, pero no en silencio.
   */
  it('NEGATIVA: la barra no usa el ícono de actualizar para otra cosa', () => {
    const chrome = layoutHtml.slice(0, layoutHtml.indexOf('<main'));
    expect(chrome).not.toMatch(/pi-refresh/);
  });
});
