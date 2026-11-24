import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { qrDe, trazoDe, tramosDe } from './firma-qr';

/**
 * `[RH.15.11]` El QR que se dibuja tiene que LEERSE y decir la liga exacta. El control no es «hay un trazo»: es pasar
 * lo dibujado por un lector de QR (@zxing, el mismo que ya usa la suite para escanear) y recuperar la URL.
 */
function leer(n: number, d: string): string {
  // Del trazo a pixeles: cada «M{c} {r}h{largo}» pinta un tramo del renglón r. 4 módulos de margen, 4 px por módulo.
  const ESC = 4, MARGEN = 4, lado = (n + MARGEN * 2) * ESC;
  const lum = new Uint8ClampedArray(lado * lado).fill(255);
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [c, r, largo] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let y = (r + MARGEN) * ESC; y < (r + MARGEN + 1) * ESC; y++) {
      for (let x = (c + MARGEN) * ESC; x < (c + MARGEN + largo) * ESC; x++) lum[y * lado + x] = 0;
    }
  }
  const bmp = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, lado, lado)));
  return new QRCodeReader().decode(bmp).getText();
}

describe('[RH.15.11] el QR de la firma', () => {
  it('un tramo por corrida oscura, no un cuadro por módulo', () => {
    const m = [[1, 1, 0], [0, 1, 1], [0, 0, 0]];
    const oscuro = (r: number, c: number) => m[r][c] === 1;
    expect(trazoDe(3, oscuro)).toBe('M0 0h2v1h-2zM1 1h2v1h-2z');
    expect(tramosDe(3, oscuro)).toEqual([{ r: 0, c: 0, largo: 2 }, { r: 1, c: 1, largo: 2 }]);
    expect(trazoDe(3, () => false)).toBe('');
  });

  it('lo dibujado se LEE y devuelve la liga exacta (control con un lector de QR real)', async () => {
    const url = 'https://megadulcessuite.com/mi-semana/AAAAAAAAAAAAAAAAAAAAAOx2v_9k-ZmQ3hT1cW8yLr0aBcDe';
    const q = await qrDe(url);
    expect(q.n).toBeGreaterThanOrEqual(25);
    expect(leer(q.n, q.d)).toBe(url);
  });

  it('el control falla si el dibujo está mal: un QR con la mitad borrada no se lee', async () => {
    const q = await qrDe('https://megadulcessuite.com/mi-semana/control-negativo');
    const mitad = q.d.split('z').filter((x) => x && Number(/M\d+ (\d+)/.exec(x)?.[1]) < q.n / 2).map((x) => `${x}z`).join('');
    expect(() => leer(q.n, mitad)).toThrow();
  });
});
