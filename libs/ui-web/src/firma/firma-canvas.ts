/**
 * `[CG.66]` LA FIRMA SOBRE UN CANVAS — la lógica, una sola vez y sin framework.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ACÁ Y NO EN UN COMPONENTE COMPARTIDO
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Medido antes de escribir esto: el repo tiene **cero** `@Component` en `libs/` — ninguna
 * librería hospeda componentes de Angular, y `ui-web` está tagueada `type:util`, que por la
 * restricción de Nx sólo puede depender de `type:util`. Hacerla depender de `@angular/core` es
 * un cambio de configuración, y la configuración de Angular/Nx **no se toca sin autorización**.
 *
 * Así que lo que se comparte es lo que de verdad se duplicaba: el DIBUJO. La cáscara (el
 * `<canvas>` en la plantilla y los tres `(pointer*)`) son cuatro líneas por app y se quedan ahí.
 * ⚠️ **Deuda declarada, no resuelta:** mientras no exista una librería de componentes Angular,
 * la cáscara se repite. Es la mitad chica del problema; la lógica es la que tenía los defectos.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * DE DÓNDE SALE, Y LOS CUATRO DEFECTOS QUE TRAÍA
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Esto vivía dentro de `apps/vendor/.../rider-deliveries.component.ts` (en producción: es la
 * firma del cliente en la entrega a domicilio, Fase LM). No se movió tal cual — se midió:
 *
 * **1 · ⛔ Un TOQUE contaba como firma.** `signed = true` se ponía en `pointerdown`, así que
 *    apoyar el dedo y levantarlo dejaba un punto y el formulario lo aceptaba como firmado. Acá
 *    hace falta TRAZO: se acumula el largo del recorrido y por debajo de `MIN_TRAZO` no está
 *    firmada. Un punto no es una firma.
 *
 * **2 · ⛔ Redimensionar BORRABA la firma, en silencio.** El ajuste de resolución
 *    (`c.width = c.clientWidth`) corría en CADA evento, y escribir `canvas.width` **limpia el
 *    canvas** por especificación. Con el teclado del teléfono abriéndose a mitad de la firma, o
 *    al girar el aparato, el trazo desaparecía sin aviso. Ahora el ajuste pasa UNA vez, al
 *    preparar, y si el tamaño cambió se re-dibuja el trazo guardado.
 *
 * **3 · ⛔ En un teléfono la firma salía BORROSA.** El canvas se fijaba en píxeles CSS, ignorando
 *    `devicePixelRatio`: en un equipo con DPR 3 la imagen guardada tenía un tercio de la
 *    resolución que el dedo dibujó. Para algo que es EVIDENCIA, eso importa.
 *
 * **4 · ⛔ El PNG salía con fondo TRANSPARENTE.** Sobre blanco no se nota; en un visor oscuro la
 *    firma es invisible. Se rellena blanco antes de exportar.
 *
 * ⚠️ Y lo que esto **NO** es: una firma electrónica con valor legal. Es evidencia de conformidad
 * —el equivalente digital del renglón "Recibí conforme" del ticket— y así se declara en pantalla.
 * La e.firma del SAT es otro mecanismo y otro proyecto.
 */

/** Un punto del trazo, en píxeles CSS del canvas. */
export interface PuntoFirma {
  readonly x: number;
  readonly y: number;
  /** `false` abre un trazo nuevo (el dedo se levantó y volvió a bajar). */
  readonly sigue: boolean;
}

/**
 * Largo mínimo del recorrido, en píxeles CSS, para considerar que hay una firma.
 *
 * ⚠️ El número es deliberadamente BAJO: no juzga si la firma es "buena" —eso no le toca a un
 * programa— sino que distingue un trazo de un toque accidental. 24px es menos de lo que mide
 * una inicial.
 */
export const MIN_TRAZO = 24;

export interface FirmaCanvas {
  /** Empieza un trazo en ese punto. */
  abajo(x: number, y: number): void;
  /** Continúa el trazo. Sin `abajo` previo no hace nada. */
  mueve(x: number, y: number): void;
  /** Levanta el dedo. */
  arriba(): void;
  /** Borra todo y vuelve al estado sin firmar. */
  limpiar(): void;
  /** ¿Hay TRAZO suficiente? (no: ¿hay un punto?) */
  firmada(): boolean;
  /** Largo acumulado del recorrido, en píxeles CSS. Para declarar por qué algo no cuenta. */
  largo(): number;
  /** El PNG como data URI, con fondo BLANCO. `null` si no está firmada. */
  aPng(): string | null;
  /** Re-ajusta a su tamaño en pantalla conservando el trazo. Llamar en `resize`. */
  reajustar(): void;
}

/**
 * Prepara un `<canvas>` para firmar.
 *
 * ⚠️ El trazo se guarda en memoria además de dibujarse. No es por capricho: es lo único que
 * permite sobrevivir a un cambio de tamaño (defecto 2) sin perder la firma.
 */
export function prepararFirma(canvas: HTMLCanvasElement): FirmaCanvas {
  const trazo: PuntoFirma[] = [];
  let dibujando = false;
  let recorrido = 0;
  let ultX = 0;
  let ultY = 0;
  // Ancho/alto CSS con el que se dibujó el buffer actual. Si cambia, hay que reajustar.
  let anchoCss = 0;
  let altoCss = 0;

  const dpr = (): number => {
    const r = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    // ⚠️ Techo en 3: por arriba de eso el PNG crece al cuadrado y no se gana nitidez visible.
    // Y piso en 1, porque un DPR de 0 o NaN dejaría el canvas en 0×0 — o sea sin firma y sin error.
    return Math.min(3, Math.max(1, Number(r) || 1));
  };

  const ctx = (): CanvasRenderingContext2D | null => canvas.getContext('2d');

  /** Fija el buffer al tamaño en pantalla × DPR. ⛔ ESTO BORRA EL CANVAS (es la especificación). */
  const fijarBuffer = (): void => {
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    const k = dpr();
    anchoCss = w;
    altoCss = h;
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(h * k);
    const g = ctx();
    // Se escala el CONTEXTO, así que todo el resto del archivo habla en píxeles CSS y nadie
    // tiene que acordarse del DPR. Sin esto, cada coordenada habría que multiplicarla a mano.
    if (g) g.setTransform(k, 0, 0, k, 0, 0);
  };

  const pintarTrazo = (): void => {
    const g = ctx();
    if (!g) return;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#111111';
    g.beginPath();
    for (let i = 0; i < trazo.length; i++) {
      const p = trazo[i];
      if (!p.sigue) { g.moveTo(p.x, p.y); continue; }
      g.lineTo(p.x, p.y);
    }
    g.stroke();
  };

  const asegurarBuffer = (): void => {
    if (canvas.width === 0 || anchoCss !== (canvas.clientWidth || anchoCss)
        || altoCss !== (canvas.clientHeight || altoCss)) {
      fijarBuffer();
      pintarTrazo();
    }
  };

  fijarBuffer();

  return {
    abajo(x, y) {
      asegurarBuffer();
      dibujando = true;
      ultX = x; ultY = y;
      trazo.push({ x, y, sigue: false });
    },

    mueve(x, y) {
      if (!dibujando) return;
      const g = ctx();
      if (!g) return;
      recorrido += Math.hypot(x - ultX, y - ultY);
      trazo.push({ x, y, sigue: true });
      g.lineWidth = 2;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#111111';
      g.beginPath();
      g.moveTo(ultX, ultY);
      g.lineTo(x, y);
      g.stroke();
      ultX = x; ultY = y;
    },

    arriba() { dibujando = false; },

    limpiar() {
      trazo.length = 0;
      recorrido = 0;
      dibujando = false;
      const g = ctx();
      if (g) g.clearRect(0, 0, anchoCss, altoCss);
    },

    firmada() { return recorrido >= MIN_TRAZO; },

    largo() { return recorrido; },

    aPng() {
      if (recorrido < MIN_TRAZO) return null;
      // Fondo BLANCO (defecto 4). Se pinta DEBAJO de lo ya dibujado con `destination-over`, que
      // es lo que evita tener que re-dibujar el trazo encima.
      const g = ctx();
      if (g) {
        const antes = g.globalCompositeOperation;
        g.globalCompositeOperation = 'destination-over';
        g.fillStyle = '#FFFFFF';
        g.fillRect(0, 0, anchoCss, altoCss);
        g.globalCompositeOperation = antes;
      }
      return canvas.toDataURL('image/png');
    },

    reajustar() {
      fijarBuffer();
      pintarTrazo();
    },
  };
}
