import { PRIMARY_OUTLET, Router, UrlTree } from '@angular/router';

/**
 * `[MT.5.4]` **Navegar a una URL en texto sin tirar la pantalla partida.**
 *
 * ── El defecto, reportado por Edgar el 2026-10-16 ────────────────────────────
 * «si abro otra pantalla, o hasta en el mismo módulo, se cierra. Debe permanecer
 * ahí hasta que le dé a la X.» El panel se cerraba en algunas navegaciones y en
 * otras no, sin patrón visible desde la pantalla — que es la peor forma del
 * defecto, porque enseña a no confiar en la función.
 *
 * ── Lo que lo causaba, medido sobre el router real ───────────────────────────
 * No era la pantalla ni el módulo: era CÓMO navega cada botón.
 *
 *   router.createUrlTree(['/x'])        → CONSERVA
 *   router.navigate(['/x'])             → CONSERVA
 *   router.navigate(['/x'], {query})    → CONSERVA
 *   router.navigate([...], {relativeTo})→ CONSERVA
 *   router.navigateByUrl('/x')          → ⛔ PIERDE
 *
 * `navigate()` arma el árbol a partir del actual y deja intactos los outlets que
 * los comandos no nombran. `navigateByUrl` con un **texto** no: parsea esa URL
 * como el árbol COMPLETO, y lo que no esté escrito ahí no existe. El panel no
 * está escrito ahí, así que desaparece.
 *
 * ── Por qué una función y no "acordarse de no usar navigateByUrl" ────────────
 * Porque son 12 sitios y van a ser más. Esto reinyecta el grupo del panel en el
 * árbol del destino: el llamador sigue pensando en una URL de texto, que es lo
 * que tiene a mano (viene de un feed, de un hallazgo, de un link del chat).
 *
 * ⚠️ Si el destino YA trae panel propio, gana el destino: alguien que navega a
 * una URL con split pidió ese split, no el que estaba.
 *
 * ⛔ **Dónde NO se usa**: cerrar sesión, sesión vencida y login. Ahí tirar el
 * panel es lo correcto — la pantalla partida pertenece a la sesión que termina.
 */
export function irConservandoPanel(router: Router, url: string | UrlTree): Promise<boolean> {
  const destino = typeof url === 'string' ? router.parseUrl(url) : url;
  const actual = router.parseUrl(router.url);
  const panel = actual.root.children['panel'];
  if (panel && !destino.root.children['panel'] && destino.root.children[PRIMARY_OUTLET]) {
    destino.root.children['panel'] = panel;
  }
  return router.navigateByUrl(destino);
}
