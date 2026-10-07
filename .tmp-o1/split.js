/* [CG.46] Mueve la captura del modal al detalle permanente. Con aserciones: si algo no calza,
   aborta sin tocar el archivo. */
const fs = require('fs');
const P = 'apps/view/src/app/modules/finanzas/pages/caja-general/finanzas-caja-general.component.ts';
let s = fs.readFileSync(P, 'utf8');
// El repo tiene core.autocrlf=true, asi que tras un `git checkout` el archivo viene en CRLF y
// los marcadores con \n no casan. Se normaliza para buscar y se restaura al escribir.
const CRLF = s.indexOf(String.fromCharCode(13) + String.fromCharCode(10)) >= 0;
const RE_CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g');
if (CRLF) s = s.replace(RE_CRLF, String.fromCharCode(10));
const must = (c, m) => { if (!c) throw new Error('ABORTA: ' + m); };

// ── 1 · Recortar el dialogo de captura entero ────────────────────────────────────────────────
const ABRE = '    <p-dialog [visible]="capturaAbierta()" (visibleChange)="$event ? null : cerrarConFoco(capturaAbierta)"';
const i0 = s.indexOf(ABRE);
must(i0 > 0, 'no se encontro el dialogo de captura');
const FIN = '    </p-dialog>';
const i1 = s.indexOf(FIN, i0);
must(i1 > i0, 'no se encontro el cierre del dialogo de captura');
const bloque = s.slice(i0, i1 + FIN.length);
must(bloque.split('<p-dialog').length === 2, 'el recorte abarca mas de un dialogo');

// El cuerpo: desde <div class="fin-form"> hasta el comentario del pie.
const jBody = bloque.indexOf('      <div class="fin-form">');
const jFoot = bloque.indexOf('      <!-- ⚠️ El pie va con #footer');
must(jBody > 0, 'no se encontro el cuerpo del formulario');
must(jFoot > jBody, 'no se encontro el comentario del pie');
const cuerpo = bloque.slice(jBody, jFoot).replace(/\s+$/, '');

// ⚠️ El pie del DIALOGO, no el de una tabla: adentro de este bloque hay DOS <ng-template #footer>
// mas, que son pies de p-table del arqueo. Se busca DESDE el comentario del pie, que es unico.
const kF = bloque.indexOf('<ng-template #footer>', jFoot);
const kE = bloque.indexOf('</ng-template>', kF);
must(kF > jFoot && kE > kF, 'no se encontro el pie del dialogo');
const botones = bloque.slice(kF + '<ng-template #footer>'.length, kE).replace(/^\n/, '').replace(/\n\s*$/, '');
must((botones.match(/<p-button/g) || []).length === 2, 'el pie no trae los dos botones: ' + botones.slice(0, 80));
must(/Guardar/.test(botones) && /Cancelar/.test(botones), 'el pie no es el de Guardar/Cancelar');

// Se saca el dialogo de donde estaba (quedan el <p-toast> y los otros dos dialogos).
s = s.slice(0, i0) + s.slice(i1 + FIN.length).replace(/^\n+/, '\n');

// ── 2 · Abrir el split justo antes de la bandeja (el master) ─────────────────────────────────
const MASTER = '      <section class="cg-bandeja">';
const iM = s.indexOf(MASTER);
must(iM > 0, 'no se encontro la seccion maestra');
const CAB = '      <!-- ⭐ [CG.46] O.1 (BINDING): /finanzas/* va en MASTER-DETAIL PERMANENTE.\n'
  + '           La captura vivia en un modal de 62rem que tapaba la bandeja entera. O.1 reserva\n'
  + '           el modal para "confirmar/crear CORTO" y manda split para el documento extenso;\n'
  + '           datos densos 8 agrega que un create multi-seccion complejo va a superficie propia.\n'
  + '           Este formulario tiene documento, contraparte, cuenta, concepto, glosa, monto, la\n'
  + '           reja de 16 denominaciones y el panel del cajero: de corto no tiene nada.\n'
  + '           Ahora la lista queda a la izquierda y lo elegido al lado, sin perder la cola. -->\n'
  + '      <div class="cg-split">\n'
  + '        <div class="cg-main">\n';
s = s.slice(0, iM) + CAB + s.slice(iM);

// ── 3 · Cerrar el split y colgar el aside antes del cierre de la pagina ──────────────────────
const CIERRE = '      </app-load-state>\n    </div>\n\n    <p-toast';
const iC = s.indexOf(CIERRE);
must(iC > 0, 'no se encontro el cierre de la pagina');
const sangra = (txt, n) => txt.split('\n').map((l) => (l.trim() ? ' '.repeat(n) + l : l)).join('\n');

const ASIDE = '      </app-load-state>\n'
  + '        </div><!-- /cg-main -->\n\n'
  + '        <!-- El detalle. PERMANENTE: cuando no hay nada elegido NO desaparece -- dice que\n'
  + '             esta esperando y ofrece la captura desde cero. Un panel que aparece y se va\n'
  + '             mueve la lista debajo del cursor justo cuando se esta marcando. -->\n'
  + '        <aside class="cg-detail" [class.cg-detail-vacio]="!capturaAbierta()"\n'
  + '               aria-label="Detalle del movimiento">\n'
  + '          @if (capturaAbierta()) {\n'
  + '            <div class="cg-detail-head">\n'
  + '              <strong class="cg-detail-h">Registrar movimiento de caja</strong>\n'
  + '              <span class="cg-bandeja-sp"></span>\n'
  + '              <p-button icon="pi pi-times" size="small" severity="secondary" [text]="true" [rounded]="true"\n'
  + '                        ariaLabel="Cerrar la captura y volver a la lista"\n'
  + '                        (onClick)="cerrarConFoco(capturaAbierta)"></p-button>\n'
  + '            </div>\n'
  + '            <div class="cg-detail-cuerpo">\n'
  + sangra(cuerpo, 6) + '\n'
  + '            </div>\n'
  + '            <!-- El pie queda pegado abajo del panel: con la reja de denominaciones abierta,\n'
  + '                 Guardar caia fuera de la vista y habia que ir a buscarlo. -->\n'
  + '            <div class="cg-detail-pie">\n'
  + sangra(botones, 4) + '\n'
  + '            </div>\n'
  + '          } @else {\n'
  + '            <!-- Vacio operacional: icono, titulo neutral, que hacer, y una accion real. -->\n'
  + '            <div class="cg-detail-nada">\n'
  + '              <i class="pi pi-wallet" aria-hidden="true"></i>\n'
  + '              <strong>Nada elegido todavia</strong>\n'
  + '              <p>Elegi un movimiento de la lista para confirmarlo o capturarlo. Se abre aca,\n'
  + '                 al lado, sin taparte la cola de trabajo.</p>\n'
  + '              <p-button label="Registrar uno nuevo" icon="pi pi-plus" size="small"\n'
  + '                        [disabled]="!hayConceptos() && !coberturaSinMedir()"\n'
  + '                        (onClick)="abrirCaptura()"></p-button>\n'
  + '            </div>\n'
  + '          }\n'
  + '        </aside>\n'
  + '      </div><!-- /cg-split -->\n'
  + '    </div>\n\n'
  + '    <p-toast';
s = s.slice(0, iC) + ASIDE + s.slice(iC + CIERRE.length);

const LF = new RegExp(String.fromCharCode(10), 'g');
fs.writeFileSync(P, CRLF ? s.replace(LF, String.fromCharCode(13) + String.fromCharCode(10)) : s);
console.log('OK · la captura pasa de modal a detalle permanente');
console.log('   cuerpo movido  :', cuerpo.split('\n').length, 'lineas');
console.log('   botones del pie:', (botones.match(/<p-button/g) || []).length, '->', botones.replace(/\s+/g, ' ').slice(0, 90));
