import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.54/55/56]` — Candado de **el vale que se aprueba DEBIENDO su comprobante**.
 *
 * ## La regla, textual del usuario
 * *«cuando activemos "Esto es una prefactura o cotización, todavía falta el comprobante" y
 * demos click en "Aprobar como provisional" se le regrese al usuario y se le permita volver a
 * adjuntar la evidencia para que lo vuelva a enviar»*.
 *
 * ## ⛔ El defecto que cierra, y por qué estaba en TRES lugares
 * `no_comprobable` significa «este gasto no lleva evidencia», y `[GX.19]` fija la captura en
 * ese valor — o sea que `requiereEvidencia()` es **false para todo lo que se levanta hoy**.
 * Tres guards distintos usaban esa función para decidir si un vale admite un archivo:
 *
 *  1. `approve()` cerraba en `validada` aunque la marca dijera que faltaba el comprobante.
 *  2. `addEvidence()` rebotaba con «este gasto no lleva evidencia (no comprobable)».
 *  3. `tieneRespaldo()` no aceptaba una cotización, así que el vale no se podía ni aprobar.
 *
 * **La marca correcta es `provisional`, no la clasificación**: significa literalmente
 * «aprobado pero debiendo el comprobante». La clasificación dice qué clase de gasto es, no si
 * se le debe un papel.
 *
 * ## Por qué un candado de TEXTO y no una prueba con base
 * Lo mismo que `dueno-del-vale.spec.ts` y `respaldo-autorizacion.spec.ts`: son tres `if` en
 * medio de una transacción con knex. Montarla acá probaría a knex. Lo que hay que impedir es
 * que alguien «limpie» uno de los tres y el ciclo se corte **sin que nada se ponga rojo** —
 * porque la pantalla se sigue viendo bien, sólo que el vale ya no vuelve.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const BRK = String.fromCharCode(10);
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));

const metodo = (src: string, decl: string): string => {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const fin = src.indexOf(BRK + '  }', i);
  return fin < 0 ? src.slice(i) : src.slice(i, fin);
};

describe('[GX.56] la casilla del aprobador devuelve el vale', () => {
  /**
   * ⭐ La prueba que sostiene el pedido. Sin esto, marcar «falta el comprobante» sobre un vale
   * que trae la foto lo cerraba igual en `validada`: la marca puesta, el trámite terminado, y
   * el camino para subir la factura inexistente (`addEvidence` sólo opera sobre `aprobada`).
   */
  it('marcado provisional, el vale queda en «aprobada» y NO cierra', () => {
    const cuerpo = metodo(SERVICIO, 'async approve(');
    expect(cuerpo).toContain('if (prov || soloCotizacion) {');
    // Y lo que sigue a esa rama es el estado que devuelve el vale, no el que lo cierra.
    const i = cuerpo.indexOf('if (prov || soloCotizacion) {');
    expect(cuerpo.slice(i, i + 120)).toContain("nextStatus = 'aprobada'");
  });

  /**
   * ⚠️ La segunda señal se conserva: cubre al aprobador que NO marca la casilla sobre un vale
   * que sólo trae cotización. Son dos formas de lo mismo y basta con una.
   */
  it('un vale que sólo trae cotización vuelve aunque nadie marque la casilla', () => {
    const cuerpo = metodo(SERVICIO, 'async approve(');
    expect(cuerpo).toContain("const soloCotizacion = files.some((f) => String(f?.role || '').startsWith('cotizacion'))");
    expect(cuerpo).toContain("&& !files.some((f) => String(f?.role || '').startsWith('comprobante'))");
  });
});

describe('[GX.54] la cotización respalda la autorización', () => {
  /**
   * ⛔ Antes `tieneRespaldo` aceptaba `solicitud_kepler` y `comprobante*` nada más, así que un
   * vale con la foto del vale firmado subida como cotización **no se podía aprobar**: el
   * aprobador recibía «no se puede aprobar sin el respaldo de la autorización». Se reportó en
   * pantalla, sobre un vale que sí traía el papel.
   */
  it('acepta también los roles de cotización', () => {
    const fn = metodo(SERVICIO, 'function tieneRespaldo(');
    expect(fn).toContain("role.startsWith('cotizacion')");
    // Sin perder los dos que ya valían.
    expect(fn).toContain('role === REQUEST_ROLE');
    expect(fn).toContain("role.startsWith('comprobante')");
  });
});

describe('[GX.55] el vale provisional puede recibir su comprobante después', () => {
  /**
   * ⭐ El guard era `requiereEvidencia(clasificacion)` a secas — y con `no_comprobable` eso es
   * **false**, así que el único camino que importa estaba cerrado: el vale mostraba «te toca
   * subir la factura del pago» y rebotaba con «este gasto no lleva evidencia».
   */
  it('`addEvidence` no rebota si el vale debe el comprobante', () => {
    const cuerpo = metodo(SERVICIO, 'async addEvidence(');
    expect(cuerpo).toContain('if (!requiereEvidencia(base.clasificacion) && base.cur.provisional !== true) {');
  });

  /** ⛔ Y para poder mirarlo, tiene que venir en el SELECT. */
  it('`addEvidence` lee `provisional` de la fila', () => {
    const cuerpo = metodo(SERVICIO, 'async addEvidence(');
    expect(cuerpo).toContain("'provisional'");
  });

  /**
   * La pantalla decide el modo con lo que le devuelve `proofByFolio`. Sin `provisional` ahí,
   * la captura no puede distinguir «cerrado» de «esperando la factura».
   */
  it('`proofByFolio` devuelve `provisional`', () => {
    const cuerpo = metodo(SERVICIO, 'async proofByFolio(');
    expect(cuerpo).toContain("'provisional'");
    expect(cuerpo).toContain('provisional: r.provisional === true');
  });

  /** Y el listado también, para que la tarea diga «la factura» y no «la evidencia». */
  it('el listado publica `provisional`', () => {
    const cuerpo = metodo(SERVICIO, 'async list(');
    expect(cuerpo).toContain("'provisional'");
  });
});

describe('[GX.51] la deuda no lleva fecha límite', () => {
  /**
   * Se retiró el default de 15 días (GX.30) por pedido del usuario: la factura del pago llega
   * cuando llega y no depende de nadie de la casa. Lo que la fecha cuidaba —que la deuda no se
   * olvide— se conserva: `validated_at` dice desde cuándo espera.
   */
  it('aprobar ya no inventa un vencimiento', () => {
    const cuerpo = metodo(SERVICIO, 'async approve(');
    expect(cuerpo).toContain('comprobante_esperado_at: prov ? (esperado || null) : null');
    expect(cuerpo).not.toContain("interval '15 days'");
  });

  /** Ni el alta con cotización. */
  it('el alta con cotización tampoco', () => {
    const cuerpo = metodo(SERVICIO, 'async create(');
    expect(cuerpo).toContain('{ provisional: true }');
    expect(cuerpo).not.toContain("interval '15 days'");
  });
});
