/**
 * `[CG.74]` Candados del QR.
 *
 * ⚠️ No se prueba que el QR "diga" el texto —eso lo prueba el decodificador de @zxing, que no es
 * nuestro—. Se prueba lo que SÍ es nuestro y lo que puede romper la pantalla: que no tire, que
 * no acumule, que tenga nombre accesible y que un lado ridículo no produzca algo inescaneable.
 */
import { qrSvg, pintarQr, QR_LADO_MINIMO } from './qr-svg';

describe('qrSvg · [CG.74]', () => {
  it('devuelve un SVG con el lado pedido', () => {
    const s = qrSvg('https://ejemplo/x?c=ABC234', 200);
    expect(s).not.toBeNull();
    expect(s!.tagName.toLowerCase()).toBe('svg');
    expect(s!.getAttribute('width')).toBe('200');
    expect(s!.getAttribute('height')).toBe('200');
  });

  it('⭐ un lado por debajo del mínimo se SUBE, no se respeta', () => {
    // Un QR de 20px no lo engancha la cámara de un teléfono viejo. Obedecer ahí sería entregar
    // un adorno que no se puede escanear — peor que no ponerlo.
    const s = qrSvg('https://ejemplo/x', 20);
    expect(Number(s!.getAttribute('width'))).toBe(QR_LADO_MINIMO);
  });

  it('tiene nombre accesible: no es un "gráfico" mudo', () => {
    const s = qrSvg('https://ejemplo/x');
    expect(s!.getAttribute('role')).toBe('img');
    expect(s!.getAttribute('aria-label')).toMatch(/qr/i);
  });

  it('⛔ [negativa] sin texto NO inventa un QR', () => {
    // Un QR de la cadena vacía es un QR válido que lleva a ninguna parte: alguien lo escanea,
    // no pasa nada, y nadie sabe por qué.
    for (const vacio of ['', '   ', null, undefined]) {
      expect(qrSvg(vacio as string | null)).toBeNull();
    }
  });

  it('⛔ [negativa] NO tira: ante un fallo devuelve null', () => {
    // El QR es una comodidad — el código de 6 caracteres sigue escrito al lado. Si esto tirara,
    // se llevaría puesta la captura entera del movimiento.
    // 4 KB de texto exceden la capacidad de un QR: el codificador falla por dentro.
    expect(() => qrSvg('x'.repeat(4096))).not.toThrow();
    expect(qrSvg('x'.repeat(4096))).toBeNull();
  });
});

describe('pintarQr · [CG.74]', () => {
  it('pinta dentro del contenedor', () => {
    const d = document.createElement('div');
    expect(pintarQr(d, 'https://ejemplo/x?c=ABC234')).toBe(true);
    expect(d.querySelector('svg')).not.toBeNull();
  });

  it('⛔ [negativa] REEMPLAZA, no acumula', () => {
    // Sin esto, al cambiar el código queda el QR nuevo DEBAJO del viejo — y el de arriba, que es
    // el que la gente escanea, es el vencido. Falla silenciosa y de las caras.
    const d = document.createElement('div');
    pintarQr(d, 'https://ejemplo/x?c=AAAAAA');
    pintarQr(d, 'https://ejemplo/x?c=BBBBBB');
    expect(d.querySelectorAll('svg').length).toBe(1);
  });

  it('⛔ [negativa] sin texto deja el contenedor VACÍO y avisa que no pintó', () => {
    const d = document.createElement('div');
    d.innerHTML = '<svg><!-- el QR anterior --></svg>';
    expect(pintarQr(d, '')).toBe(false);
    expect(d.querySelector('svg'), 'quedó el QR viejo, que ya no corresponde').toBeNull();
  });

  it('⛔ [negativa] sin contenedor no revienta', () => {
    expect(pintarQr(null, 'https://ejemplo/x')).toBe(false);
  });
});
