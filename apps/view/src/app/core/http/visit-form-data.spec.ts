import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { base64ToBlob } from './visit-form-data';

/**
 * `[NP.7]` La primera captura en prod (2026-11-03) no subió ninguna foto: el levantamiento armaba el archivo
 * con `fetch(dataUri)` y la CSP de prod (`connect-src 'self' …`, sin `data:` ni `blob:`) lo bloquea. En local
 * no hay CSP, así que nadie lo vio. El arreglo es `base64ToBlob` (sin red); esto lo prueba y cierra la puerta
 * a que el patrón vuelva en cualquier parte de las apps web.
 */
describe('[NP.7] base64ToBlob — armar la foto sin pasar por la red', () => {
  // Un JPEG mínimo: SOI (ff d8) + EOI (ff d9).
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const b64 = btoa(String.fromCharCode(...JPEG));
  // El Blob de jsdom no trae arrayBuffer(): los bytes se leen con FileReader, como en un navegador viejo.
  const bytesDe = (b: Blob) => new Promise<number[]>((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok([...new Uint8Array(r.result as ArrayBuffer)]);
    r.onerror = () => mal(r.error);
    r.readAsArrayBuffer(b);
  });

  it('un data URI de la cámara se vuelve un Blob con los MISMOS bytes y tipo JPEG', async () => {
    const blob = base64ToBlob(`data:image/jpeg;base64,${b64}`);
    expect(blob.type).toBe('image/jpeg');
    expect(await bytesDe(blob)).toEqual([...JPEG]);
  });

  it('también acepta el base64 pelón (sin el prefijo data:)', async () => {
    expect(await bytesDe(base64ToBlob(b64))).toEqual([...JPEG]);
  });
});

/** Busca `fetch(` sobre un data:/blob: literal o una variable que por su nombre es un data URI. Sin comentarios. */
export function fetchDeDataUri(codigo: string): string[] {
  const sin = codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const re = /fetch\(\s*(?:['"`]\s*(?:data|blob):|[\w.]*(?:dataUri|dataUrl|dataURL|DataUri|DataUrl|blobUrl|objectUrl)\b)/g;
  return sin.match(re) ?? [];
}

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : archivosTs(p);
    return n.endsWith('.ts') && !n.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('[NP.7] ninguna app web hace fetch() de un data:/blob: (la CSP de prod lo bloquea)', () => {
  const RAIZ = join(__dirname, '../../../../../..');
  const DIRS = ['apps/view/src', 'apps/portal/src', 'apps/vendor/src', 'libs/ui-web/src'].map((d) => join(RAIZ, d));

  it('el barrido de las apps no encuentra ninguno', () => {
    const hallados = DIRS.flatMap((d) => archivosTs(d).flatMap((f) => fetchDeDataUri(readFileSync(f, 'utf8')).map((m) => `${f.slice(RAIZ.length + 1)}: ${m}`)));
    expect(hallados).toEqual([]);
  });

  it('⛔ NEGATIVA — el instrumento sí los ve, y no confunde comentarios ni URLs normales', () => {
    expect(fetchDeDataUri('const b = await (await fetch(dataUri)).blob();')).toHaveLength(1);
    expect(fetchDeDataUri("fetch('data:image/png;base64,AAAA')")).toHaveLength(1);
    expect(fetchDeDataUri('await fetch(this.blobUrl)')).toHaveLength(1);
    expect(fetchDeDataUri('// Sin `fetch(dataUri)`: la CSP lo bloquea')).toHaveLength(0);
    expect(fetchDeDataUri('fetch(`${environment.apiUrl}/x`); fetch("https://a.b/c")')).toHaveLength(0);
  });
});
