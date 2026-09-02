/*
 * Reporta a la API los errores que ocurren en el navegador del cliente.
 *
 * POR QUE EXISTE
 * Si a alguien le truena el checkout, el error pasa en SU navegador: no deja
 * rastro en el servidor y el cliente casi nunca llama a contarlo. Simplemente
 * no compra. Esto convierte esa venta perdida en un aviso.
 *
 * COMO SE USA
 * Se agrega como PRIMER script de la pagina, antes que cualquier otro, para
 * que alcance a capturar los errores de los demas:
 *
 *   <script src="/reportar-errores.js"></script>
 *
 * Si la pagina conoce el folio del pedido en curso, se lo dice:
 *
 *   window.MD_FOLIO = 'MD-2026-00123';
 *
 * Eso es lo que permite llamarle despues al cliente que no pudo pagar.
 *
 * REGLAS QUE SE RESPETAN
 * - Nunca estorba: si el reporte falla, se ignora en silencio. El cliente ya
 *   tuvo un problema; no hay que sumarle otro.
 * - No manda datos del formulario. Solo el mensaje, donde ocurrio y en que
 *   pagina. Nada de correos, direcciones ni RFC.
 * - No repite el mismo error en la misma visita: un fallo dentro de un bucle
 *   generaria miles de peticiones.
 */
(function () {
  'use strict';

  var RUTA = '/api/errores';
  var TOPE_POR_VISITA = 10;     // no mas reportes que esto por carga de pagina
  var enviados = 0;
  var yaVistos = {};

  function reportar(datos) {
    try {
      if (enviados >= TOPE_POR_VISITA) return;

      // Misma huella dos veces en la misma visita: casi siempre es un bucle.
      var llave = (datos.mensaje || '') + '|' + (datos.origen || '');
      if (yaVistos[llave]) return;
      yaVistos[llave] = true;
      enviados++;

      var cuerpo = JSON.stringify({
        mensaje:   datos.mensaje,
        origen:    datos.origen,
        rastro:    datos.rastro,
        pagina:    location.pathname + location.search,
        navegador: navigator.userAgent,
        folio:     window.MD_FOLIO || null
      });

      // sendBeacon sobrevive a que la pagina se cierre, que es justo cuando
      // mas se pierden los errores: el cliente ve que algo falla y se va.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(RUTA, new Blob([cuerpo], { type: 'application/json' }));
        return;
      }
      var x = new XMLHttpRequest();
      x.open('POST', RUTA, true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(cuerpo);
    } catch (e) {
      // Un fallo aqui no puede romper la pagina.
    }
  }

  // Errores de JavaScript sin atrapar.
  window.addEventListener('error', function (e) {
    // Los errores de carga de recursos (imagenes, scripts) llegan por aqui
    // tambien, pero sin mensaje util. Se distinguen porque traen `target`.
    if (e && e.target && e.target !== window && e.target.tagName) {
      reportar({
        mensaje: 'No se pudo cargar ' + String(e.target.tagName).toLowerCase(),
        origen:  e.target.src || e.target.href || ''
      });
      return;
    }
    reportar({
      mensaje: (e && e.message) || 'Error sin mensaje',
      origen:  ((e && e.filename) || '') + (e && e.lineno ? ':' + e.lineno : ''),
      rastro:  e && e.error && e.error.stack ? String(e.error.stack) : ''
    });
  }, true);

  // Promesas rechazadas sin catch. Es por donde se escapan casi todos los
  // errores de las llamadas a la API, que es lo que importa en el checkout.
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    reportar({
      mensaje: 'Promesa sin atender: ' + (r && r.message ? r.message : String(r)),
      origen:  '',
      rastro:  r && r.stack ? String(r.stack) : ''
    });
  });

  // Para reportar a mano algo que la pagina si atrapo pero que igual conviene
  // saber. Por ejemplo, que la pasarela devolvio un error controlado.
  window.MDReportarError = function (mensaje, detalle) {
    reportar({
      mensaje: String(mensaje || 'Error reportado por la pagina'),
      origen:  '',
      rastro:  detalle ? String(detalle) : ''
    });
  };
})();
