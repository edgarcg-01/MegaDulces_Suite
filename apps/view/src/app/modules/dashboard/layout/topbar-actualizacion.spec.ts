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
   * ⭐⭐ `[SW.2]` **LA REGLA NO CAMBIÓ; CAMBIÓ EL MECANISMO.**
   *
   * Acá se exigía que el botón «Hay una versión nueva · Actualizar» siguiera en
   * `app.component.html`. Edgar lo hizo quitar el 2026-10-20: salía después de
   * cada despliegue y había que atenderlo.
   *
   * ⛔ Pero lo que este gate protege sigue valiendo, y es lo de arriba, textual:
   * *«quitar el ruido sirve de poco si de paso se pierde el aviso que sí recarga,
   * y el día del deploy nadie se entera»*. Un botón menos **no puede** significar
   * gente corriendo código viejo sin saberlo — y menos después de un hotfix.
   *
   * Así que el gate deja de exigir el BOTÓN y pasa a exigir el MECANISMO: que la
   * versión nueva se aplique sola cuando la pestaña deja de estar a la vista.
   * Si alguien borra eso creyendo que limpia, esto se pone rojo.
   */
  const appTs = leer('app.component.ts');

  it('la versión nueva se sigue aplicando sola, aunque ya no haya botón', () => {
    // El disparador: pestaña oculta. ⛔ `visibilitychange`, no `blur` — `blur` se
    // dispara con la pestaña todavía a la vista al lado de otra ventana.
    expect(appTs).toMatch(/visibilitychange/);
    expect(appTs).toMatch(/visibilityState === 'hidden'/);
    // Y que de verdad active y recargue: escuchar el evento sin aplicar no sirve.
    expect(appTs).toMatch(/activateUpdate\(\)/);
    expect(appTs).toMatch(/location\.reload\(\)/);
  });

  /**
   * ⛔ NEGATIVA del cambio: el botón no vuelve por la puerta de atrás. Si hace
   * falta otra vez, se discute — pero no reaparece en un refactor.
   */
  it('NEGATIVA: el botón de actualizar NO volvió a la raíz', () => {
    expect(appHtml).not.toMatch(/\(click\)="applyUpdate\(\)"/);
    expect(appHtml).not.toMatch(/class="app-update"/);
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
