import { bootstrapApplication } from '@angular/platform-browser';
import { installNumberWheelGuard, installRadioGroupNav, installRowNavGuard } from '@megadulces/ui-web';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// DESIGN.md D.5: la rueda del mouse NO cambia el valor de un input numérico. Un solo listener
// cubre toda la app, incluida la pantalla que se escriba mañana.
installNumberWheelGuard(document);
// `[KBD.1]` Las teclas de una fila navegable NO se le roban a un campo que vive adentro.
// `pSelectableRow` de PrimeNG escucha en el `<tr>` y conmuta sobre `event.code` SIN mirar
// `event.target`, asi que un `Space` tecleado en un input de esa fila selecciona el renglon y
// ademas hace `preventDefault()`: no se puede escribir un espacio. Igual con `Enter` (abre el
// detalle), `Home`/`End` (saltan de fila) y las flechas (chocan con DESIGN D.5). Un solo
// listener en fase de CAPTURA, por la misma razon que el de la rueda: una directiva hay que
// acordarse de importarla, y son 153 tablas.
installRowNavGuard(document);

// `[TAB.3]` Teclado de los selectores de una opcion. 35 de 37 no tenian roving tabindex:
// el tabulador paraba en CADA opcion (D.4a) y las flechas no hacian nada. Global por la
// misma razon que los dos de arriba: una directiva se olvida y el que la olvida no rompe
// nada -- simplemente vuelve a quedar sin teclado. Deja en paz a los que ya se administran.
installRadioGroupNav(document);

// `[CD.23]` EL SELLO DE BUILD SE PIDE, YA NO VIENE HORNEADO EN `index.html`.
// Hasta hoy `index.html` traía un `<script>` con el commit, escrito por un `sed` del Dockerfile
// ANTES de compilar. Eso metía el commit dentro del hash de Nx, así que el bundle del vendedor
// se recompilaba entero en cada despliegue — 34-49 s, en 6 de 6 despliegues medidos, aunque no
// se hubiera tocado una línea de esta app. Ahora `start.sh` publica el sello en runtime y acá
// se lee de ahí.
//
// Se pueblan las MISMAS dos variables globales que ya leía la sonda de diagnóstico de
// `vendor-shell.component.ts`, a propósito: así ese archivo no cambia ni una línea.
// ⚠️ Es asíncrono, o sea que hay una ventana de unos ms en la que la sonda diría `n/a` — ya
//    tenía ese fallback. En la práctica la sonda la abre una persona desde Ajustes, mucho
//    después. No se bloquea el arranque por un dato de diagnóstico.
// ⛔ `.catch()` que no hace nada a propósito: sin red (el vendedor trabaja offline) esto falla,
//    y un 404 en la consola no debe parecer un error de la app.
fetch('/assets/version.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((v: { commit?: string; timestamp?: string } | null) => {
    if (!v) return;
    const w = window as unknown as { __BUILD_VERSION__?: string; __BUILD_TIMESTAMP__?: string };
    w.__BUILD_VERSION__ = v.commit;
    w.__BUILD_TIMESTAMP__ = v.timestamp;
  })
  .catch(() => undefined);

bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err),
);
