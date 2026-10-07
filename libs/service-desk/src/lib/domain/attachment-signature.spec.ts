/**
 * Adjuntos por FIRMA, no por el tipo que declara el cliente.
 *
 * El incidente que esto previene: `ObjectStorageService.putFile` guarda el Content-Type DECLARADO. Un HTML
 * o un ejecutable con `data:image/png;base64,…` se almacenaría y serviría como imagen.
 */
import { detectarTipo, sanitizarNombre, validarAdjunto } from './attachment-signature';

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs);
const ascii = (s: string): number[] => Array.from(Buffer.from(s, 'latin1'));
const relleno = (n: number): number[] => new Array<number>(n).fill(0x20);

const PDF = Buffer.from([...ascii('%PDF-1.7\n'), ...relleno(50)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...relleno(40)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...relleno(40)]);
const GIF = Buffer.from([...ascii('GIF89a'), ...relleno(40)]);
const WEBP = Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...relleno(30)]);
const HEIC = Buffer.from([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heic'), ...relleno(30)]);
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');
const EXE = Buffer.from([...ascii('MZ'), ...relleno(60)]);
const uri = (tipo: string, b: Buffer): string => `data:${tipo};base64,${b.toString('base64')}`;
const MAX = 8 * 1048576;

describe('detectarTipo (firma)', () => {
  it.each([
    ['PDF', PDF, 'application/pdf'], ['PNG', PNG, 'image/png'], ['JPEG', JPG, 'image/jpeg'],
    ['GIF', GIF, 'image/gif'], ['WEBP', WEBP, 'image/webp'], ['HEIC', HEIC, 'image/heic'],
  ])('reconoce %s', (_n, buf, esperado) => {
    expect(detectarTipo(buf)).toBe(esperado);
  });
  it('⭐ NEGATIVA: un HTML con <script> y un ejecutable (MZ) NO son un tipo permitido', () => {
    expect(detectarTipo(HTML)).toBeNull();
    expect(detectarTipo(EXE)).toBeNull();
  });
  it('NEGATIVA: archivos truncados o vacíos no explotan', () => {
    expect(detectarTipo(bytes())).toBeNull();
    expect(detectarTipo(bytes(0x25, 0x50))).toBeNull();
    expect(detectarTipo(bytes(0xff, 0xd8))).toBeNull();
    expect(detectarTipo(Buffer.from(ascii('RIFF')))).toBeNull();
  });
  it('NEGATIVA: RIFF que no es WEBP (un .wav) no pasa por imagen', () => {
    expect(detectarTipo(Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE'), ...relleno(20)]))).toBeNull();
  });
});

describe('validarAdjunto', () => {
  it('CONTROL: un PNG honesto pasa y se guarda con el tipo DETECTADO', () => {
    const r = validarAdjunto(uri('image/png', PNG), MAX);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.adjunto.contentType).toBe('image/png'); expect(r.adjunto.sizeBytes).toBe(PNG.length); }
  });
  it('⭐ NEGATIVA: un HTML declarado como image/png se RECHAZA (el tipo declarado no basta)', () => {
    const r = validarAdjunto(uri('image/png', HTML), MAX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('tipo_no_permitido');
  });
  it('⭐ NEGATIVA: un JPEG declarado como PDF se rechaza por NO COINCIDIR', () => {
    const r = validarAdjunto(uri('application/pdf', JPG), MAX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('tipo_no_coincide');
  });
  it('un navegador que manda application/octet-stream o nada: se acepta y manda la firma', () => {
    for (const declarado of ['application/octet-stream', '']) {
      const r = validarAdjunto(uri(declarado, PDF), MAX);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.adjunto.contentType).toBe('application/pdf');
    }
  });
  it('HEIC declarado como image/heif se acepta (es la misma familia)', () => {
    expect(validarAdjunto(uri('image/heif', HEIC), MAX).ok).toBe(true);
  });
  it('NEGATIVA: demasiado grande, vacío, sin base64 y no-data-URI', () => {
    const grande = Buffer.concat([PDF, Buffer.alloc(2 * 1048576)]);
    const g = validarAdjunto(uri('application/pdf', grande), 1048576);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe('demasiado_grande');
    const v = validarAdjunto('data:image/png;base64,', MAX);
    expect(!v.ok && v.error).toBe('vacio');
    const nb = validarAdjunto(`data:image/png,${PNG.toString('latin1')}`, MAX);
    expect(!nb.ok && nb.error).toBe('no_es_base64');
    const nd = validarAdjunto('https://ejemplo.com/a.png', MAX);
    expect(!nd.ok && nd.error).toBe('no_es_data_uri');
    expect(validarAdjunto(undefined as unknown as string, MAX).ok).toBe(false);
  });
  it('tolera saltos de línea dentro del base64 (algunos clientes lo parten)', () => {
    const b64 = PNG.toString('base64');
    const partido = `${b64.slice(0, 20)}\n${b64.slice(20)}`;
    expect(validarAdjunto(`data:image/png;base64,${partido}`, MAX).ok).toBe(true);
  });
});

describe('sanitizarNombre', () => {
  it('quita la ruta y los caracteres de control', () => {
    expect(sanitizarNombre('C:\\Users\\yo\\captura.png', 'image/png')).toBe('captura.png');
    expect(sanitizarNombre('../../etc/passwd', 'image/png')).toBe('passwd');
    expect(sanitizarNombre('a\u0000b<c>.png', 'image/png')).toBe('abc.png');
  });
  it('sin nombre usa uno genérico con la extensión del tipo REAL', () => {
    expect(sanitizarNombre('', 'application/pdf')).toBe('adjunto.pdf');
    expect(sanitizarNombre(null, 'image/jpeg')).toBe('adjunto.jpg');
    expect(sanitizarNombre('..', 'image/png')).toBe('adjunto.png');
  });
  it('recorta a 120 conservando la extensión', () => {
    const largo = `${'x'.repeat(300)}.pdf`;
    const r = sanitizarNombre(largo, 'application/pdf');
    expect(r.length).toBe(120);
    expect(r.endsWith('.pdf')).toBe(true);
  });
});
