/**
 * `[CG.74]` Candados del QR.
 *
 * ⚠️ No se prueba que el QR "diga" el texto —eso lo prueba el decodificador de @zxing, que no es
 * nuestro—. Se prueba lo que SÍ es nuestro y lo que puede romper la pantalla: que no tire, que
 * no acumule, que tenga nombre accesible y que un lado ridículo no produzca algo inescaneable.
 *
 * ⭐ **Las dos funciones son `async` desde que el codificador se carga diferido.** No es un
 * detalle de forma: con el `import` estático, `@zxing/browser` entraba al paquete INICIAL de toda
 * la app —porque `libs/ui-web/src/index.ts` re-exporta esto y ese barril se importa desde código
 * que carga al arrancar— y reventó el presupuesto de Angular por **449 kB**, dejando `main` sin
 * poder desplegar. Si alguien vuelve a ponerlas sincrónicas, vuelve el bloqueo.
 *
 * ⛔ **Lo que estas pruebas NO cubren, declarado:** que el trozo quede de verdad fuera del paquete
 * inicial. Eso no se ve desde una prueba unitaria —se mide al empaquetar— y hoy lo vigila el
 * presupuesto del `build` en el CI, que es quien lo atrapó la primera vez.
 */
import { qrSvg, pintarQr, QR_LADO_MINIMO } from './qr-svg';

describe('qrSvg · [CG.74]', () => {
  it('devuelve un SVG con el lado pedido', async () => {
    const s = await qrSvg('https://ejemplo/x?c=ABC234', 200);
    expect(s).not.toBeNull();
    expect(s!.tagName.toLowerCase()).toBe('svg');
    expect(s!.getAttribute('width')).toBe('200');
    expect(s!.getAttribute('height')).toBe('200');
  });

  it('⭐ un lado por debajo del mínimo se SUBE, no se respeta', async () => {
    // Un QR de 20px no lo engancha la cámara de un teléfono viejo. Obedecer ahí sería entregar
    // un adorno que no se puede escanear — peor que no ponerlo.
    const s = await qrSvg('https://ejemplo/x', 20);
    expect(Number(s!.getAttribute('width'))).toBe(QR_LADO_MINIMO);
  });

  it('tiene nombre accesible: no es un "gráfico" mudo', async () => {
    const s = await qrSvg('https://ejemplo/x');
    expect(s!.getAttribute('role')).toBe('img');
    expect(s!.getAttribute('aria-label')).toMatch(/qr/i);
  });

  it('⛔ [negativa] sin texto NO inventa un QR', async () => {
    // Un QR de la cadena vacía es un QR válido que lleva a ninguna parte: alguien lo escanea,
    // no pasa nada, y nadie sabe por qué.
    for (const vacio of ['', '   ', null, undefined]) {
      expect(await qrSvg(vacio as string | null)).toBeNull();
    }
  });

  it('⛔ [negativa] NO tira: ante un fallo devuelve null', async () => {
    // El QR es una comodidad — el código de 6 caracteres sigue escrito al lado. Si esto tirara,
    // se llevaría puesta la captura entera del movimiento.
    // 4 KB de texto exceden la capacidad de un QR: el codificador falla por dentro.
    // ⚠️ Siendo `async`, el contrato se afirma sobre la PROMESA: lo que se exige es que RESUELVA
    // en `null`, no que rechace. Una promesa rechazada acá sería un fallo igual de malo —el
    // `.then()` de la pantalla nunca correría y el reintento quedaría colgado—, y `resolves` lo
    // descarta: si el `try/catch` de adentro desapareciera, esta línea se pone roja.
    await expect(qrSvg('x'.repeat(4096))).resolves.toBeNull();
  });
});

describe('pintarQr · [CG.74]', () => {
  it('pinta dentro del contenedor', async () => {
    const d = document.createElement('div');
    expect(await pintarQr(d, 'https://ejemplo/x?c=ABC234')).toBe(true);
    expect(d.querySelector('svg')).not.toBeNull();
  });

  it('⛔ [negativa] REEMPLAZA, no acumula', async () => {
    // Sin esto, al cambiar el código queda el QR nuevo DEBAJO del viejo — y el de arriba, que es
    // el que la gente escanea, es el vencido. Falla silenciosa y de las caras.
    const d = document.createElement('div');
    await pintarQr(d, 'https://ejemplo/x?c=AAAAAA');
    await pintarQr(d, 'https://ejemplo/x?c=BBBBBB');
    expect(d.querySelectorAll('svg').length).toBe(1);
  });

  it('⛔ [negativa] sin texto deja el contenedor VACÍO y avisa que no pintó', async () => {
    // ⭐ Este candado atrapó un cambio real: al volver la función diferida se intentó vaciar
    // DESPUÉS de esperar al SVG, para que no parpadeara. Eso dejaba el QR anterior a la vista
    // cuando la llamada nueva no produce ninguno — y un QR vencido que alguien escana es peor que
    // un hueco, porque el hueco se ve. El orden se mantuvo: vaciar primero.
    const d = document.createElement('div');
    d.innerHTML = '<svg><!-- el QR anterior --></svg>';
    expect(await pintarQr(d, '')).toBe(false);
    expect(d.querySelector('svg'), 'quedó el QR viejo, que ya no corresponde').toBeNull();
  });

  it('⛔ [negativa] sin contenedor no revienta', async () => {
    expect(await pintarQr(null, 'https://ejemplo/x')).toBe(false);
  });
});
