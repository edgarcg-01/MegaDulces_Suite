/**
 * `[CG.68]` **El contrato de la firma del movimiento de caja**, compartido por las dos puntas.
 *
 * ⚠️ Vive acá y no en `libs/finance` por una razón de frontera, no de gusto: `libs/finance` es
 * backend (NestJS, Knex) y `apps/view` **no puede importarlo** — la restricción de Nx lo frena, y
 * con razón. Sin este archivo, la comparación de abajo se habría escrito dos veces: una en el
 * servidor y otra en la pantalla. Dos copias de una regla de integridad es la forma más barata de
 * que una de las dos quede vieja (ADR-056).
 */

/**
 * Lo MÍNIMO que el teléfono necesita para saber qué está firmando.
 *
 * ⚠️ Es deliberadamente corto. El teléfono del mostrador se le pasa a otras personas: es una
 * superficie para firmar, no una segunda pantalla de caja. Mandarle el movimiento entero sería
 * publicar el detalle del efectivo en un aparato que cambia de manos.
 */
export interface ContextoFirma {
  readonly tipo: string;
  readonly monto: number;
  readonly beneficiario: string | null;
  readonly documento: string | null;
}

/**
 * ⭐⭐ `[CG.199]`–`[CG.202]` **El pedido de firma es una fila del servidor** (`finance.cash_signature_requests`).
 *
 * Reemplaza al emparejamiento por socket (`[CG.68]`–`[CG.196]`), cuyo estado vivía en la memoria
 * del socket de la PC y se perdía con cada despliegue, wifi caído o pestaña en segundo plano.
 *
 * `vencida` NO se guarda: se calcula contra `expira_at` al leer. Así una fila nunca dice
 * «abierta» de algo que ya no se puede firmar.
 */
export type EstadoFirmaSolicitud = 'abierta' | 'tomada' | 'firmada' | 'usada' | 'cancelada' | 'vencida';

/**
 * Por qué no se pudo. **Un código, una causa, una acción**: el teléfono le dice a la persona
 * exactamente qué hacer, y la PC también — `[CG.204]`.
 */
export type FalloFirmaSolicitud =
  | 'no_existe'       // el QR no es de un pedido nuestro (o está mal copiado)
  | 'vencida'         // pasó `FIRMA_VIDA_MS`: hace falta otro QR
  | 'cancelada'       // la caja lo canceló
  | 'ya_usada'        // ya se guardó con un movimiento
  | 'otro_telefono'   // lo tomó otro teléfono
  | 'no_es_firma'     // el trazo no es un PNG válido o está vacío
  | 'no_firmada'      // (PC) se quiso guardar con un pedido que todavía no se firma
  | 'monto_distinto'; // (PC) el importe cambió después de firmar

/**
 * La frase de cada fallo: **qué pasó y qué hacer**, en una línea. La usan el servidor (mensaje
 * del error), la PC y el teléfono — una sola redacción para que las tres puntas no se contradigan.
 */
export function textoFalloFirma(f: FalloFirmaSolicitud | string | null | undefined): string {
  switch (f) {
    case 'no_existe': return 'Este QR no corresponde a ningún pedido de firma. Pide uno nuevo en la caja.';
    case 'vencida': return 'Este QR ya venció. Pide uno nuevo en la pantalla de la caja.';
    case 'cancelada': return 'La caja canceló este pedido de firma. Si hace falta, que lo pida de nuevo.';
    case 'ya_usada': return 'Esta firma ya quedó guardada con su movimiento.';
    case 'otro_telefono': return 'Este QR ya lo abrió otro teléfono. Pide uno nuevo en la caja.';
    case 'no_es_firma': return 'La firma no se pudo leer. Borra y firma de nuevo.';
    case 'no_firmada': return 'Todavía no llega la firma del teléfono.';
    case 'monto_distinto': return 'La firma del teléfono fue por otro importe. Vuelve a pedirla o firma en esta pantalla.';
    default: return 'No se pudo completar la firma. Prueba de nuevo.';
  }
}

/** Lo que la PC recibe al pedir la firma: el QR se arma con `token`. */
export interface FirmaSolicitudAbierta {
  readonly id: string;
  readonly token: string;
  readonly expira_at: string;
}

/** Lo que la PC consulta mientras espera (`GET`). La imagen sólo viaja cuando ya está firmada. */
export interface FirmaSolicitudEstado {
  readonly id: string;
  readonly estado: EstadoFirmaSolicitud;
  readonly monto: number;
  readonly firma_png: string | null;
  readonly firma_nombre: string | null;
  readonly firmada_at: string | null;
}

/** Lo que el teléfono ve. ⛔ Nada más que el contexto y su estado: el teléfono cambia de manos. */
export interface FirmaSolicitudTelefono {
  readonly estado: EstadoFirmaSolicitud;
  readonly contexto: ContextoFirma;
}

/** Ruta pública del teléfono y ruta de la PC. Viven acá para que las dos puntas no diverjan. */
export const FIRMA_RUTA_PUBLICA_API = 'finance/firma';
export const FIRMA_RUTA_PC_API = 'finance/caja-firmas';

/**
 * ⭐⭐ `[CG.196]` **Cuánto vive un pedido de firma — un RESPALDO, no la puerta.**
 *
 * ⚠️ `[CG.201]` El texto de abajo describe el diseño por socket, que se retiró: hoy la vida del
 * pedido es `expira_at` de su fila y la del token del QR es este mismo número. Se conservan las
 * razones de las 8 horas, que siguen valiendo.
 *
 * Pedido de Edgar (2026-10-20): *«el token de la firma caduca muy rápido, o si se bloquea el
 * teléfono se pierde; que dure más y no se venza hasta que se firme o se cancele»*.
 *
 * ── Quién manda de verdad sobre la vida del código ──────────────────────────────────────────
 *
 * **El emparejamiento vive en el socket de la PC** (`client.data.firma`), y `decidirTomar` exige
 * encontrar esa marca en la room. O sea que el código **ya** moría cuando la caja cerraba el
 * panel (`firma:cerrar`) o cuando la PC se desconectaba: *«hasta que se firme o se cancele»* es
 * lo que el diseño hace, sin reloj. Este número es sólo el tope de un panel **abandonado**.
 *
 * ⛔ **Eran 3 minutos y ésa era la mitad del problema.** La otra mitad era un defecto, no un
 * parámetro: al bloquearse el teléfono su socket caía, el servidor emitía `firma:cortada` a toda
 * la room y **la PC destruía el emparejamiento** — ver `[CG.196]` en `caja.gateway.ts`. Subir
 * este número sin arreglar aquello no habría cambiado nada.
 *
 * ── ⭐ Por qué subirlo NO afloja la puerta, medido contra el código ──────────────────────────
 *
 * El comentario de `TOPE_INTENTOS` justificaba los 3 minutos con la aritmética de la fuerza
 * bruta —31^6 = 887 millones en 180 segundos—. **Esa cuenta sobra, porque el reloj nunca fue la
 * defensa:** un invitado (el que entra con el pase del QR, sin sesión) **sólo puede reclamar el
 * código de SU propio pase** (`tomarFirma` compara contra `paseCodigo`). Adivinar un código ajeno
 * exige una **sesión iniciada con permiso de Caja General**, o sea un empleado del área — y ahí
 * el tope de 5 intentos por socket sigue siendo el detector, igual que antes.
 *
 * Dicho de otro modo: el reloj acotaba a quien ya estaba adentro, no a quien está afuera.
 *
 * ── Por qué 8 horas y no «infinito» ─────────────────────────────────────────────────────────
 *
 * Un turno. Cubre de sobra el caso real —un teléfono bloqueado que vuelve en minutos— y conserva
 * el único riesgo que el número protegía: un panel que alguien dejó abierto y se fue. Sin tope,
 * un QR impreso en una pantalla olvidada seguiría sirviendo mañana.
 *
 * ⚠️ Y acota también al **pase** del QR, que se firma con este mismo valor (`expiresIn`). Un pase
 * más corto que el código reintroduce el bug por otra puerta: el teléfono vuelve del bloqueo, el
 * emparejamiento sigue vivo y el pase ya no sirve. **Los dos tienen que medir lo mismo.**
 */
export const FIRMA_VIDA_MS = 8 * 60 * 60 * 1000;

/**
 * ⭐ ¿La firma que volvió sigue correspondiendo a lo que hay en pantalla?
 *
 * Compara el monto que se le mostró a quien firmó contra el que está ahora. **Falla cerrado**:
 * ante un número que no es número, la firma no cuenta — nunca al revés.
 */
export function firmaSigueValiendo(montoFirmado: number, montoAhora: number): boolean {
  const a = Number(montoFirmado);
  const b = Number(montoAhora);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  // Al centavo: el monto sale de un conteo de piezas, no de una medición.
  return Math.abs(a - b) < 0.005;
}
