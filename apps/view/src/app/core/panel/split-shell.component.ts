import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, RouterOutlet } from '@angular/router';
import { MultitareaService } from '../services/multitarea.service';
import { PanelLateralComponent } from './panel-lateral.component';

/**
 * `[MT.5]` **Contenedor de pantalla partida para una pantalla SIN layout.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * El outlet `panel` vivía sólo dentro de `LayoutComponent`, o sea dentro de las
 * 12 áreas. «Mi trabajo» (`/projects`) es de primer nivel y NO usa el layout
 * —trae su propio encabezado y usa el ancho completo a propósito—, así que al
 * entrar ahí la pantalla partida se perdía entera: no había segundo panel donde
 * dibujar nada. Reportado por Edgar el 2026-10-16.
 *
 * Este shell da esa columna sin meter a Mi trabajo en el layout, que es lo que
 * le habría puesto encima una SEGUNDA barra superior con los mismos controles
 * que ya tiene, y al costado el sidebar de un área — en la pantalla que existe
 * justamente para ELEGIR área.
 *
 * ── Lo que NO hace ───────────────────────────────────────────────────────────
 * No dibuja chrome: ni barra, ni sidebar, ni padding. Lo único que agrega es la
 * fila y el panel, que cerrado mide 0. La pantalla que hospeda se ve igual que
 * sin él.
 */
@Component({
  selector: 'app-split-shell',
  standalone: true,
  imports: [RouterOutlet, PanelLateralComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      \`con-panel\` enciende los contenedores de consulta, y sólo con el panel
      abierto. El motivo largo está en styles.css: contener la columna siempre
      rompía los overlays de cámara, incluso en el teléfono donde no hay split.
    -->
    <div class="split-shell" [class.con-panel]="panel.visible()">
      <div class="split-shell-main"><router-outlet /></div>
      <app-panel-lateral #panel />
    </div>
  `,
  styles: [
    `
      .split-shell {
        display: flex;
        min-height: 100dvh;
        max-height: 100dvh;
      }
      /* min-width: 0 no es decoracion: sin el, un hijo ancho (una tabla) se
         niega a encogerse y empuja al panel fuera de la pantalla.
         (Sin acentos graves: dentro de un styles[] rompen el parseo.)

         Para las pantallas SIN layout (Mi trabajo), que no tienen la columna
         .pane. Igual que .pane: el contenedor se enciende SOLO con el panel
         abierto, o los overlays fijos de la pantalla quedarian contenidos
         siempre. El motivo completo esta en styles.css. */
      .split-shell-main {
        flex: 1 1 auto;
        min-width: 0;
        overflow: auto;
      }
      .split-shell.con-panel .split-shell-main {
        container-type: inline-size;
      }
    `,
  ],
})
export class SplitShellComponent implements OnInit {
  private readonly multitarea = inject(MultitareaService);
  private readonly ruta = inject(ActivatedRoute);

  /**
   * El servicio necesita saber en qué nivel vive el outlet `panel` para poder
   * armar un enlace que abra algo al lado. Acá ese nivel es ESTA ruta — lo
   * mismo que hace el layout en su propio `ngOnInit` para su área.
   */
  ngOnInit(): void {
    this.multitarea.registrarRutaDelArea(this.ruta);
  }
}
