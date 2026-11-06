import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFontEmbedder, StandardFonts, decodePDFRawStream,
} from 'pdf-lib';

/**
 * `[ALC.1.1]` Texto de un PDF con su posición, para leer documentos **generados** (no escaneados).
 *
 * Plan: [`FASE_ALC_ALTA_DE_CLIENTES.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md) §9 C1.
 *
 * ── Por qué no una librería de PDF ───────────────────────────────────────────────────────────
 * La constancia del SAT la genera *Oracle XML Publisher* con las dos fuentes estándar
 * (`Helvetica`, `Helvetica-Bold`) en `WinAnsiEncoding` y cada texto con su `Tm` absoluto
 * (medido el 2026-11-04 en dos constancias reales). Para eso basta `pdf-lib` —ya en el repo— para
 * abrir el archivo y descomprimir los flujos; lo demás es interpretar media docena de operadores.
 * Una dependencia nueva de extracción de texto sería mucho más código del que se usa.
 *
 * ── Qué cubre y qué declara ──────────────────────────────────────────────────────────────────
 * - Operadores de texto `BT ET Tf Tm Td TD T* TL Tj TJ ' "`, y `q Q cm` para la posición.
 * - Fuentes simples (`Type1`, `TrueType`) en `WinAnsiEncoding` o sin codificación declarada.
 * - ⛔ Una fuente compuesta (`Type0`), `Type3` o con `/Differences` **no se adivina**: la lectura
 *   devuelve `fuente_no_soportada`. Un PDF escaneado (sólo imágenes) devuelve `sin_texto`.
 * - No entra a los `Form XObject` (la constancia no los usa para texto).
 * - El ancho de cada trozo sale de las métricas de las 14 fuentes estándar (las que trae `pdf-lib`);
 *   con otra fuente queda en `null`. No aplica `Tc`/`Tw`/`Tz` ni el kerning de `TJ`.
 */

export interface TrozoTexto {
  pagina: number;
  x: number;
  y: number;
  texto: string;
  fuente: string;
  tamano: number;
  /** Avance horizontal en puntos, o `null` si la fuente no es una de las 14 estándar. */
  ancho: number | null;
}

const ESTANDAR = new Set<string>(Object.values(StandardFonts));
const embebedores = new Map<string, StandardFontEmbedder>();
function anchoEstandar(fuente: string, texto: string, tamano: number): number | null {
  const base = fuente.replace(/^[A-Z]{6}\+/, '');
  if (!ESTANDAR.has(base)) return null;
  try {
    let e = embebedores.get(base);
    // `for()` pide el `FontNames` de @pdf-lib/standard-fonts; sus valores son los mismos de `StandardFonts`.
    if (!e) { e = StandardFontEmbedder.for(base as unknown as Parameters<typeof StandardFontEmbedder.for>[0]); embebedores.set(base, e); }
    return e.widthOfTextAtSize(texto, tamano);
  } catch {
    return null; // un carácter fuera de WinAnsi: mejor sin ancho que con uno inventado
  }
}

export interface Renglon {
  pagina: number;
  y: number;
  trozos: TrozoTexto[];
  texto: string;
}

export type MotivoPdfIlegible = 'no_es_pdf' | 'cifrado' | 'sin_texto' | 'fuente_no_soportada' | 'ilegible';

export type LecturaPdf =
  | { ok: true; paginas: number; productor: string | null; trozos: TrozoTexto[] }
  | { ok: false; motivo: MotivoPdfIlegible; detalle: string };

/** WinAnsi (cp1252) en 0x80–0x9F; el resto coincide con Latin-1. */
const CP1252_80_9F: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
  0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodificarWinAnsi(bytes: number[]): string {
  let s = '';
  for (const b of bytes) s += CP1252_80_9F[b] ?? String.fromCharCode(b);
  return s;
}

type Matriz = [number, number, number, number, number, number];
const IDENTIDAD: Matriz = [1, 0, 0, 1, 0, 0];
/** m1 × m2 (convención de PDF: vector renglón). */
function mult(m1: Matriz, m2: Matriz): Matriz {
  return [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

// ── Lexer mínimo de flujo de contenido ──────────────────────────────────────────────────────
type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: number[] }
  | { t: 'name'; v: string }
  | { t: 'arr'; v: Token[] }
  | { t: 'op'; v: string };

const ES_BLANCO = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const ES_DELIM = (c: number) => '()<>[]{}/%'.includes(String.fromCharCode(c));

class Lexer {
  i = 0;
  constructor(private readonly b: Uint8Array) {}

  private saltarBlancos(): void {
    const b = this.b;
    while (this.i < b.length) {
      if (ES_BLANCO(b[this.i])) this.i++;
      else if (b[this.i] === 0x25 /* % */) { while (this.i < b.length && b[this.i] !== 0x0a && b[this.i] !== 0x0d) this.i++; }
      else break;
    }
  }

  private cadenaLiteral(): number[] {
    const b = this.b, out: number[] = [];
    let prof = 1;
    this.i++; // (
    while (this.i < b.length) {
      const c = b[this.i++];
      if (c === 0x5c /* \ */) {
        const d = b[this.i++];
        const esc: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (d in esc) out.push(esc[d]);
        else if (d >= 0x30 && d <= 0x37) {
          let oct = d - 0x30;
          for (let k = 0; k < 2 && b[this.i] >= 0x30 && b[this.i] <= 0x37; k++) oct = oct * 8 + (b[this.i++] - 0x30);
          out.push(oct & 0xff);
        } else if (d === 0x0d) { if (b[this.i] === 0x0a) this.i++; } // continuación de línea
        else if (d !== 0x0a) out.push(d);
      } else if (c === 0x28) { prof++; out.push(c); }
      else if (c === 0x29) { if (--prof === 0) break; out.push(c); }
      else out.push(c);
    }
    return out;
  }

  private cadenaHex(): number[] {
    const b = this.b;
    let hex = '';
    this.i++; // <
    while (this.i < b.length && b[this.i] !== 0x3e) { const ch = String.fromCharCode(b[this.i++]); if (/[0-9a-fA-F]/.test(ch)) hex += ch; }
    this.i++; // >
    if (hex.length % 2) hex += '0';
    const out: number[] = [];
    for (let k = 0; k < hex.length; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16));
    return out;
  }

  /** Salta una imagen en línea `BI … ID <binario> EI`. */
  private saltarImagenEnLinea(): void {
    const b = this.b;
    while (this.i < b.length - 1 && !(b[this.i] === 0x49 && b[this.i + 1] === 0x44)) this.i++; // ID
    this.i += 2;
    while (this.i < b.length - 2) {
      if (ES_BLANCO(b[this.i]) && b[this.i + 1] === 0x45 && b[this.i + 2] === 0x49 && (this.i + 3 >= b.length || ES_BLANCO(b[this.i + 3]))) { this.i += 3; return; }
      this.i++;
    }
    this.i = b.length;
  }

  siguiente(): Token | null {
    this.saltarBlancos();
    const b = this.b;
    if (this.i >= b.length) return null;
    const c = b[this.i];
    if (c === 0x28) return { t: 'str', v: this.cadenaLiteral() };
    if (c === 0x3c) {
      if (b[this.i + 1] === 0x3c) { this.i += 2; return { t: 'op', v: '<<' }; }
      return { t: 'str', v: this.cadenaHex() };
    }
    if (c === 0x3e && b[this.i + 1] === 0x3e) { this.i += 2; return { t: 'op', v: '>>' }; }
    if (c === 0x5b) {
      this.i++;
      const arr: Token[] = [];
      for (;;) {
        this.saltarBlancos();
        if (this.i >= b.length) break;
        if (b[this.i] === 0x5d) { this.i++; break; }
        const t = this.siguiente();
        if (!t) break;
        arr.push(t);
      }
      return { t: 'arr', v: arr };
    }
    if (c === 0x5d || c === 0x7b || c === 0x7d) { this.i++; return this.siguiente(); }
    if (c === 0x2f) {
      let j = this.i + 1;
      while (j < b.length && !ES_BLANCO(b[j]) && !ES_DELIM(b[j])) j++;
      const v = Buffer.from(b.slice(this.i + 1, j)).toString('latin1');
      this.i = j;
      return { t: 'name', v };
    }
    let j = this.i;
    while (j < b.length && !ES_BLANCO(b[j]) && !ES_DELIM(b[j])) j++;
    if (j === this.i) { this.i++; return this.siguiente(); }
    const palabra = Buffer.from(b.slice(this.i, j)).toString('latin1');
    this.i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(palabra)) return { t: 'num', v: Number(palabra) };
    if (palabra === 'BI') { this.saltarImagenEnLinea(); return this.siguiente(); }
    return { t: 'op', v: palabra };
  }
}

interface FuenteSimple { soportada: boolean; nombre: string; motivo?: string }

function leerFuentes(doc: PDFDocument, recursos: PDFDict | undefined): Map<string, FuenteSimple> {
  const out = new Map<string, FuenteSimple>();
  const fuentes = recursos?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fuentes) return out;
  for (const [clave, valor] of fuentes.entries()) {
    const f = doc.context.lookup(valor);
    if (!(f instanceof PDFDict)) continue;
    const subtipo = String(f.get(PDFName.of('Subtype')) ?? '');
    const base = String(f.get(PDFName.of('BaseFont')) ?? '').replace(/^\//, '');
    const enc = f.get(PDFName.of('Encoding'));
    const encResuelta = enc instanceof PDFRef ? doc.context.lookup(enc) : enc;
    let soportada = subtipo === '/Type1' || subtipo === '/TrueType' || subtipo === '/MMType1';
    let motivo: string | undefined = soportada ? undefined : `fuente ${subtipo || 'sin subtipo'}`;
    if (encResuelta instanceof PDFDict && encResuelta.get(PDFName.of('Differences'))) { soportada = false; motivo = 'codificación con /Differences'; }
    else if (encResuelta && !(encResuelta instanceof PDFDict) && String(encResuelta) !== '/WinAnsiEncoding' && String(encResuelta) !== '/StandardEncoding') {
      soportada = false; motivo = `codificación ${String(encResuelta)}`;
    }
    out.set(clave.toString().replace(/^\//, ''), { soportada, nombre: base, motivo });
  }
  return out;
}

function flujosDeContenido(doc: PDFDocument, contenidos: unknown): Uint8Array[] {
  const lista = contenidos instanceof PDFArray ? contenidos.asArray().map((r) => doc.context.lookup(r)) : [contenidos];
  const out: Uint8Array[] = [];
  for (const s of lista) if (s instanceof PDFRawStream) out.push(decodePDFRawStream(s).decode());
  return out;
}

/** Lee el texto de un PDF. Nunca lanza: lo que no puede leer lo dice en `motivo`. */
export async function leerTextoPdf(bytes: Uint8Array): Promise<LecturaPdf> {
  if (!bytes || bytes.length < 5 || Buffer.from(bytes.slice(0, 5)).toString('latin1') !== '%PDF-') {
    return { ok: false, motivo: 'no_es_pdf', detalle: 'El archivo no es un PDF.' };
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    return { ok: false, motivo: 'ilegible', detalle: `El PDF no se pudo abrir: ${(e as Error).message}` };
  }
  if (doc.isEncrypted) return { ok: false, motivo: 'cifrado', detalle: 'El PDF está protegido con contraseña.' };

  const trozos: TrozoTexto[] = [];
  const noSoportadas = new Set<string>();
  try {
    doc.getPages().forEach((pagina, idx) => {
      const fuentes = leerFuentes(doc, pagina.node.Resources());
      let ctm: Matriz = IDENTIDAD;
      const pila: Matriz[] = [];
      let tm: Matriz = IDENTIDAD, tlm: Matriz = IDENTIDAD;
      let fuente = '', tamano = 0, interlineado = 0;
      const ops: Token[] = [];

      const mostrar = (bytesTexto: number[] | null, partes?: Token[]) => {
        const f = fuentes.get(fuente);
        if (f && !f.soportada) { noSoportadas.add(`${f.nombre}: ${f.motivo}`); return; }
        let texto = '';
        if (partes) {
          for (const p of partes) {
            if (p.t === 'str') texto += decodificarWinAnsi(p.v);
            else if (p.t === 'num' && p.v < -200) texto += ' '; // separación de palabra por kerning
          }
        } else if (bytesTexto) texto = decodificarWinAnsi(bytesTexto);
        if (!texto.trim()) return;
        const m = mult(tm, ctm);
        const nombre = f?.nombre ?? fuente;
        const escala = Math.hypot(m[0], m[1]) || 1;
        const a = anchoEstandar(nombre, texto, tamano);
        trozos.push({
          pagina: idx + 1, x: Math.round(m[4] * 100) / 100, y: Math.round(m[5] * 100) / 100, texto, fuente: nombre,
          tamano: Math.round(tamano * escala * 100) / 100, ancho: a === null ? null : Math.round(a * escala * 100) / 100,
        });
      };
      const saltoDeLinea = () => { tlm = mult([1, 0, 0, 1, 0, -interlineado], tlm); tm = tlm; };
      const num = (k: number) => { const t = ops[ops.length - k]; return t && t.t === 'num' ? t.v : 0; };

      for (const flujo of flujosDeContenido(doc, pagina.node.Contents())) {
        const lx = new Lexer(flujo);
        for (let t = lx.siguiente(); t; t = lx.siguiente()) {
          if (t.t !== 'op') { ops.push(t); continue; }
          switch (t.v) {
            case 'q': pila.push(ctm); break;
            case 'Q': ctm = pila.pop() ?? IDENTIDAD; break;
            case 'cm': ctm = mult([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
            case 'BT': tm = IDENTIDAD; tlm = IDENTIDAD; break;
            case 'Tf': { const n = ops[ops.length - 2]; fuente = n && n.t === 'name' ? n.v : fuente; tamano = num(1); break; }
            case 'TL': interlineado = num(1); break;
            case 'Tm': tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tm = tlm; break;
            case 'Td': tlm = mult([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break;
            case 'TD': interlineado = -num(1); tlm = mult([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break;
            case 'T*': saltoDeLinea(); break;
            case 'Tj': { const s = ops[ops.length - 1]; if (s && s.t === 'str') mostrar(s.v); break; }
            case "'": { saltoDeLinea(); const s = ops[ops.length - 1]; if (s && s.t === 'str') mostrar(s.v); break; }
            case '"': { saltoDeLinea(); const s = ops[ops.length - 1]; if (s && s.t === 'str') mostrar(s.v); break; }
            case 'TJ': { const a = ops[ops.length - 1]; if (a && a.t === 'arr') mostrar(null, a.v); break; }
            default: break;
          }
          ops.length = 0;
        }
      }
    });
  } catch (e) {
    return { ok: false, motivo: 'ilegible', detalle: `El contenido del PDF no se pudo interpretar: ${(e as Error).message}` };
  }

  if (!trozos.length && noSoportadas.size) {
    return { ok: false, motivo: 'fuente_no_soportada', detalle: `El PDF usa fuentes que no se leen sin adivinar (${[...noSoportadas].join('; ')}).` };
  }
  if (!trozos.length) return { ok: false, motivo: 'sin_texto', detalle: 'El PDF no trae texto: parece escaneado o una foto.' };
  return { ok: true, paginas: doc.getPageCount(), productor: doc.getProducer() ?? null, trozos };
}

/**
 * Une los trozos de un renglón (ya ordenados por x) con espacio **sólo si entre ellos hay hueco**:
 * el SAT dibuja palabra por palabra y pega el valor al rótulo («Código Postal:58000»). Con el ancho
 * real de la fuente estándar; sin él, una estimación de 0.55 em por carácter. `xs[i]` = x del
 * trozo que dibujó el carácter `i`.
 */
export function unirTrozos(trozos: TrozoTexto[]): { texto: string; xs: number[] } {
  let texto = '';
  const xs: number[] = [];
  let previo: TrozoTexto | null = null;
  for (const t of trozos) {
    if (previo) {
      const tam = previo.tamano || 8;
      const ancho = previo.ancho ?? previo.texto.length * tam * 0.55;
      const pegado = /\s$/.test(previo.texto) || /^\s/.test(t.texto);
      // Hay espacio si el hueco pasa de ~la mitad de un espacio de Helvetica (0.278 em).
      if (!pegado && t.x - (previo.x + ancho) > tam * 0.12) { texto += ' '; xs.push(t.x); }
    }
    for (let k = 0; k < t.texto.length; k++) { texto += t.texto[k]; xs.push(t.x); }
    previo = t;
  }
  return { texto, xs };
}

/**
 * Agrupa los trozos en renglones: misma página y misma altura (±`tolerancia` puntos), de arriba
 * abajo y de izquierda a derecha. `texto` los une con `unirTrozos` y colapsa los espacios.
 */
export function agruparRenglones(trozos: TrozoTexto[], tolerancia = 2): Renglon[] {
  const orden = [...trozos].sort((a, b) => a.pagina - b.pagina || b.y - a.y || a.x - b.x);
  const out: Renglon[] = [];
  for (const t of orden) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.pagina === t.pagina && Math.abs(ultimo.y - t.y) <= tolerancia) ultimo.trozos.push(t);
    else out.push({ pagina: t.pagina, y: t.y, trozos: [t], texto: '' });
  }
  for (const r of out) {
    r.trozos.sort((a, b) => a.x - b.x);
    r.texto = unirTrozos(r.trozos).texto.replace(/\s+/g, ' ').trim();
  }
  return out;
}
