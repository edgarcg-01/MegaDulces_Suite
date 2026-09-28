import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { faltaParaMandar } from '@megadulces/contracts';

/**
 * `[GX.31]` — Candado del **respaldo de la salida de dinero** en el módulo de gastos.
 *
 * ## Qué pasó, medido
 * Hasta GX.17 el respaldo era el archivo `solicitud_kepler`, subido en un paso propio.
 * GX.18 retiró ese paso (pedido del usuario) y lo reemplazó por la **foto en vivo del vale
 * autorizado**. Pero el candado viejo quedó en pie en tres lugares del servicio y en el
 * botón de la captura, y el nuevo **no cubría** el caso que la captura genera:
 *
 *  · `create()` exigía `solicitud_kepler` → **todo POST de la captura moría en 400**, y el
 *    botón ni siquiera se encendía. El módulo quedó inutilizable y nadie lo vio porque la
 *    única prueba que lo tocaba comprobaba el estado ANTERIOR a GX.18.
 *  · `faltaParaMandar` sólo pide la foto cuando `exige_evidencia` es true, y GX.19 fija la
 *    captura en `no_comprobable` → quitar el candado a secas dejaba crear un gasto **sin un
 *    solo documento**. El agujero era peor que la traba.
 *
 * ## Por qué esta prueba lee el TEXTO del servicio
 * Lo que hay que impedir no es un cálculo mal hecho: es que alguien **borre una decisión**.
 * Las tres guardas se rompen quitando una línea, y eso no lo ve ninguna prueba de
 * comportamiento que no levante la base. Mismo patrón que `etiquetas-precio-vivo.spec.ts`.
 *
 * ⚠️ Las dos primeras pruebas SÍ son de comportamiento: corren la regla compartida de
 * verdad. Sólo las guardas del servicio se vigilan por texto.
 */

const SERVICIO = readFileSync(
  join(__dirname, 'expense-proofs.service.ts'), 'utf8');

const foto = (live: boolean) => ({ role: 'comprobante_1', url: 'https://x/y.jpg', live });

describe('[GX.31] la regla compartida exige la foto SIEMPRE', () => {
  /**
   * ⭐ El agujero que abría quitar el candado viejo sin más. Con `exige_evidencia:false`
   * —que es lo que devolvía `requiereEvidencia('no_comprobable')`— la regla no pide nada.
   */
  it('con exige_evidencia en false NO pide foto: por eso el servicio ya no se lo pasa', () => {
    const faltan = faltaParaMandar({
      forma_pago: 'efectivo', forma_pago_detalle: 'caja chica',
      archivos: [], exige_evidencia: false,
    });
    expect(faltan.map((f) => f.id)).not.toContain('evidencia');
  });

  it('con exige_evidencia en true, un gasto sin foto no pasa', () => {
    const faltan = faltaParaMandar({
      forma_pago: 'efectivo', forma_pago_detalle: 'caja chica',
      archivos: [], exige_evidencia: true,
    });
    expect(faltan.map((f) => f.id)).toContain('evidencia');
  });

  /**
   * `[GX.36]` **El sello de cámara dejó de ser obligatorio.** Acá esta prueba exigía que
   * la foto viniera de la cámara; se retiró con la regla, porque en esta operación los
   * vales se ESCANEAN y el escaneo del vale firmado vale lo mismo que su foto.
   *
   * ⚠️ El sello sigue viajando y Aprobación lo muestra: pasó de COMPUERTA a DATO.
   */
  it('un comprobante subido como archivo YA alcanza', () => {
    const faltan = faltaParaMandar({
      forma_pago: 'efectivo', forma_pago_detalle: 'caja chica',
      archivos: [foto(false)], exige_evidencia: true,
    });
    expect(faltan).toEqual([]);
  });

  it('con la foto en vivo y la forma de pago, pasa', () => {
    const faltan = faltaParaMandar({
      forma_pago: 'efectivo', forma_pago_detalle: 'caja chica',
      archivos: [foto(true)], exige_evidencia: true,
    });
    expect(faltan).toEqual([]);
  });
});

describe('[GX.31] las tres guardas del servicio siguen en pie', () => {
  /**
   * ⭐ La que rompía la captura. Si alguien vuelve a pasarle `llevaEvidencia`, el gasto
   * `no_comprobable` —que es TODO lo que levanta la pantalla desde GX.19— vuelve a poder
   * crearse sin una sola imagen.
   */
  it('create() exige la foto SIEMPRE, no según la clasificación', () => {
    expect(SERVICIO).toContain('exige_evidencia: true,');
    expect(SERVICIO).not.toContain('exige_evidencia: llevaEvidencia,');
  });

  /** El respaldo se juzga en UN solo lugar: dos copias se separan. */
  it('hay un único predicado de respaldo, y las dos puertas lo usan', () => {
    expect(SERVICIO).toContain('function tieneRespaldo(');
    const usos = SERVICIO.match(/tieneRespaldo\(f\)/g) || [];
    expect(usos.length).toBe(3); // approve(), validate() y el reporte de sin-folio
  });

  /**
   * ⛔ Aceptar sólo la foto rompería los expedientes viejos (traen `solicitud_kepler` y no
   * comprobante); aceptar sólo la solicitud rompe todo lo de GX.18 en adelante. Van los dos.
   */
  it('el respaldo admite los DOS: la solicitud firmada vieja y la foto del vale', () => {
    const cuerpo = SERVICIO.slice(SERVICIO.indexOf('function tieneRespaldo('));
    expect(cuerpo).toContain('role === REQUEST_ROLE');
    expect(cuerpo).toContain("role.startsWith('comprobante')");
  });

  /**
   * ⚠️ Ninguna pantalla sube ya `solicitud_kepler`. Si el candado vuelve a exigirlo solo,
   * la captura se muere otra vez — y en silencio, porque el botón no lo sabe explicar.
   */
  it('NINGUNA guarda vuelve a exigir sólo la solicitud firmada', () => {
    // Se miran los sitios que FRENAN (los `throw`), no las menciones: `REQUEST_ROLE`
    // sigue existiendo a propósito, es la mitad vieja del respaldo.
    expect(SERVICIO).not.toContain('!roles.has(REQUEST_ROLE)');
    expect(SERVICIO).not.toContain('sin la solicitud de gasto firmada adjunta');
    expect(SERVICIO).not.toContain('falta la solicitud de gasto firmada');
  });

  /**
   * ⚠️ El chip «sin firmada» de `capturas-sin-folio` colgaba de un campo que miraba SÓLO
   * la solicitud vieja: marcaba en rojo expedientes perfectamente aprobables.
   */
  it('el reporte informa el RESPALDO, no la solicitud vieja', () => {
    expect(SERVICIO).toContain('tiene_respaldo: files.some((f) => tieneRespaldo(f))');
    expect(SERVICIO).not.toContain('tiene_solicitud:');
  });
});
