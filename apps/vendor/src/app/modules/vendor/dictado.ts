// [MCP.3.15] Dictado de las indicaciones del pedido y el aviso de sabores (David, 2026-10-26).
// El micrófono es el del navegador (Web Speech API), el mismo que ya usa el asistente.
// ⚠️ Deuda con nombre (ADR-056): `apps/view/.../desarrolladores/dictation.ts` es otro dictado; los dos
// deberían vivir en `libs/` — hoy vendor no puede importar de view.

/** Lo mínimo que usamos del reconocimiento de voz del navegador (sin `any`). */
interface ResultadoVoz { readonly 0: { readonly transcript: string }; readonly isFinal: boolean }
interface EventoVoz { readonly resultIndex: number; readonly results: ArrayLike<ResultadoVoz> }
interface ReconocedorVoz {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: EventoVoz) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
}
type CtorVoz = new () => ReconocedorVoz;

function ctorVoz(): CtorVoz | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: CtorVoz; webkitSpeechRecognition?: CtorVoz };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** ¿Este navegador puede dictar? (Chrome en Android sí; algunos navegadores no). */
export const puedeDictar = (): boolean => !!ctorVoz();

/** Suma lo dictado a lo que ya estaba escrito, con un espacio o punto de por medio. */
export function unirDictado(previo: string, dictado: string): string {
  const a = previo.trim();
  const b = dictado.trim();
  if (!b) return a;
  if (!a) return b.charAt(0).toUpperCase() + b.slice(1);
  const sep = /[.!?]$/.test(a) ? ' ' : '. ';
  return a + sep + b.charAt(0).toUpperCase() + b.slice(1);
}

const SABORES = ['fresa', 'coco', 'uva', 'mora', 'limon', 'limón', 'mandarina', 'naranja', 'manzana', 'piña', 'guayaba',
  'jamaica', 'horchata', 'kiwi', 'sandia', 'sandía', 'mango', 'cereza', 'tamarindo', 'chocolate', 'vainilla'];

/**
 * ¿La indicación habla de sabores? Cada sabor es otro producto en Kepler (30 de Electrolit y suero,
 * medido el 2026-10-26): si va como texto, el ticket dice otro producto que el que se entrega.
 */
export function mencionaSabores(texto: string): boolean {
  const t = ` ${texto.toLowerCase()} `;
  if (/\bsabor(es)?\b/.test(t)) return true;
  return SABORES.some((s) => new RegExp(`[^a-záéíóúñ]${s}[^a-záéíóúñ]`).test(t));
}

/** Un dictado en curso. `alTexto` recibe lo reconocido; `alTerminar` siempre se llama una vez. */
export function dictar(alTexto: (texto: string) => void, alTerminar: (error: string | null) => void): (() => void) | null {
  const Ctor = ctorVoz();
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = 'es-MX';
  r.interimResults = true;
  r.continuous = false;
  let texto = '';
  let error: string | null = null;
  r.onresult = (e) => {
    texto = '';
    for (let i = 0; i < e.results.length; i++) texto += e.results[i][0].transcript;
    alTexto(texto);
  };
  r.onerror = (e) => {
    error = e?.error === 'not-allowed' ? 'El navegador no dio permiso para usar el micrófono.' : 'No se pudo escuchar. Intenta otra vez.';
  };
  r.onend = () => alTerminar(error);
  try {
    r.start();
  } catch {
    alTerminar('No se pudo abrir el micrófono.');
    return null;
  }
  return () => { try { r.stop(); } catch { /* ya terminó */ } };
}
