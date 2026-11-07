/**
 * `[NP.7.L.11d]` El worker del lector con DOBLES: el acceso a datos en memoria (`RepoMem`), un knex falso que
 * cuenta transacciones y consultas, un bucket falso y un lector falso que mide cuántas llamadas van en vuelo.
 * La fusión y la auditoría son las REALES (`fusion-lecturas.ts`, `auditoria-kepler.ts`); la preparación de la
 * foto también (sharp, sobre un JPEG sintético).
 *
 * ⛔ Ninguna llamada a Anthropic: el lector es un doble. El SQL real lo ejerce `lector-worker.it.spec.ts`.
 *
 * Criterios del item (plan NP.7.L.11d): apagada → cero llamadas; una ráfaga de 500 fotos respeta concurrencia y
 * tope diario; la misma foto dos veces → una llamada; 429 → reintenta y detiene el lote; nunca escribe
 * `sheet`, `status` ni `photos`.
 *
 * Revisión independiente del 2026-11-04 (los casos marcados «revisión»): un error de configuración con el
 * LectorFotoService REAL (transporte falso, sin red) no envenena el atraso; un `retry-after` largo no se adelanta;
 * el reloj frena también los reintentos; las caras ilegibles producen `foto_no_legible`.
 */
import sharp from 'sharp';
import { Logger } from '@nestjs/common';
import {
  DURACION_MAX_MS, ESPERA_MAX_MS, HOLGURA_CANDADO_MS, LectorFotosWorker, RepoLectorFotos, SQL_LECTOR, UMBRAL_IDLE_TX_MS,
  agruparPorFoto, enParalelo, esperaDeReintento, fichaLista,
  type FichaParaPropuesta, type FotoDeFicha, type FotoPendiente,
} from './lector-worker.service';
import type { ConfigLector } from './lector.config';
import {
  NOMBRES_CAMPOS, type AiRawV1, type AuditoriaKepler, type CamposLeidos, type LecturaFotoV1, type LecturaGuardada,
  type PropuestaAmpliada, type ResultadoLectura,
} from './lectura-foto.contract';
import type { KdiiFila } from '../../shared/kdii-codigo';
import { AnthropicService } from '@megadulces/platform-core';
import { ProductSheetsModule } from '../product-sheets.module';
import { LectorFotoService, TIMEOUT_MS } from './lector-foto.service';

// ── Datos de prueba ─────────────────────────────────────────────────────────────────────────────

const CARAS = ['frente', 'reverso', 'lateral_izq', 'lateral_der', 'base'];
const CFG: ConfigLector = {
  habilitada: true, concurrencia: 2, topeDiario: 200, modelo: 'modelo-de-prueba', effort: 'low', maxTokens: 8000, recorte: 'silueta', advertencias: [],
};
const KDII: KdiiFila = { sku: 'X', nombre: 'BON O BON FRESA 8/15G', u1: 'PZA', u2: 'CJA', f2: 8, u3: null, f3: null, base: [], dos: [], tres: [] };

const CAMPOS_NULOS = Object.fromEntries(NOMBRES_CAMPOS.map((k) => [k, null])) as unknown as CamposLeidos;
function lecturaOk(o: { persona?: boolean; rostro?: boolean } = {}): LecturaFotoV1 {
  return {
    version: 'lectura-foto-v1',
    nivel_fisico: { valor: 'pieza', confianza: 'alta', evidencia: 'una pieza suelta' },
    persona_visible: (o.persona ?? false) || (o.rostro ?? false), rostro_visible: o.rostro ?? false,
    legible: 'si', motivo_no_legible: null, texto_literal: ['BON O BON', 'Fresa'],
    campos: { ...CAMPOS_NULOS, marca: { valor: 'Bon o Bon', confianza: 'alta', evidencia: 'BON O BON' } },
  };
}
const USO = { modelo: 'modelo-de-prueba', input_tokens: 1500, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, costo_usd: 0.01, precio_fuente: 'prueba' };

const fechaMx = (d: Date | string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

// ── Dobles ──────────────────────────────────────────────────────────────────────────────────────

interface FichaMem {
  id: string; sku: string; branch_code: string; status: string; deleted: boolean; principal: string;
  photos: FotoDeFicha[]; ai_raw: AiRawV1 | null;
}

function ficha(id: string, shas: string[], o: Partial<FichaMem> = {}): FichaMem {
  return {
    id, sku: `SKU-${id}`, branch_code: '01', status: 'fotos_tomadas', deleted: false, principal: 'base', ai_raw: null,
    photos: shas.map((sha, i) => ({ peldano: 'base', cara: CARAS[i % CARAS.length], storage_key: `levantamiento/01/${id}/${i}.jpg`, sha256: sha })),
    ...o,
  };
}

/** El acceso a datos en memoria, con la MISMA semántica que el SQL (que prueba el .it.spec). */
class RepoMem extends RepoLectorFotos {
  fichas: FichaMem[] = [];
  consultas = 0;
  private f(id: string) { return this.fichas.find((x) => x.id === id); }

  override async llamadasDeHoy(_t: unknown, _tenant: string, ahora: Date): Promise<number> {
    this.consultas++;
    let n = 0;
    for (const f of this.fichas) {
      for (const l of Object.values(f.ai_raw?.lecturas ?? {})) if (l.uso && fechaMx(l.leida_en) === fechaMx(ahora)) n++;
    }
    return n;
  }

  override async pendientes(_t: unknown, _tenant: string, limite: number): Promise<{ fotos: FotoPendiente[]; total: number }> {
    this.consultas++;
    const todas: FotoPendiente[] = [];
    for (const f of this.fichas) {
      if (f.deleted || !['fotos_tomadas', 'publicada'].includes(f.status)) continue;
      for (const p of f.photos) {
        if (p.peldano !== f.principal || !p.storage_key || !p.sha256 || f.ai_raw?.lecturas?.[p.sha256]) continue;
        todas.push({ sheet_id: f.id, sku: f.sku, branch_code: f.branch_code, principal: f.principal, cara: p.cara, peldano: p.peldano, storage_key: p.storage_key, sha256: p.sha256 });
      }
    }
    return { fotos: todas.slice(0, limite), total: todas.length };
  }

  override async lecturasExistentes(_t: unknown, _tenant: string, shas: string[]): Promise<Map<string, LecturaGuardada>> {
    this.consultas++;
    const m = new Map<string, LecturaGuardada>();
    for (const f of this.fichas) for (const [sha, l] of Object.entries(f.ai_raw?.lecturas ?? {})) if (shas.includes(sha) && !m.has(sha)) m.set(sha, structuredClone(l));
    return m;
  }

  override async guardarLectura(_t: unknown, _tenant: string, id: string, sha: string, lectura: LecturaGuardada, ahora: string): Promise<boolean> {
    this.consultas++;
    const f = this.f(id);
    if (!f || f.ai_raw?.lecturas?.[sha]) return false;
    f.ai_raw = { version: 'ai-raw-v1', lecturas: { ...(f.ai_raw?.lecturas ?? {}), [sha]: structuredClone(lectura) }, propuesta: null, auditoria: null, actualizado_en: ahora };
    return true;
  }

  override async fichasListas(_t: unknown, _tenant: string, limite: number): Promise<FichaParaPropuesta[]> {
    this.consultas++;
    return this.fichas
      .filter((f) => !f.deleted && f.ai_raw && !f.ai_raw.propuesta && fichaLista(f.photos, f.principal, f.ai_raw.lecturas))
      .slice(0, limite)
      .map((f) => ({ id: f.id, sku: f.sku, branch_code: f.branch_code, principal: f.principal, photos: structuredClone(f.photos), lecturas: structuredClone(f.ai_raw!.lecturas), actualizado_en: f.ai_raw!.actualizado_en }));
  }

  override async kepler(): Promise<KdiiFila | null> {
    this.consultas++;
    return KDII;
  }

  override async guardarPropuesta(_t: unknown, _tenant: string, ficha: FichaParaPropuesta, propuesta: PropuestaAmpliada, auditoria: AuditoriaKepler, ahora: string): Promise<boolean> {
    this.consultas++;
    const f = this.f(ficha.id);
    if (!f?.ai_raw || f.ai_raw.actualizado_en !== ficha.actualizado_en) return false;
    f.ai_raw = { ...f.ai_raw, propuesta, auditoria, actualizado_en: ahora };
    return true;
  }
}

function knexFalso(candadoLibre = true) {
  const k = { transacciones: 0, consultas: [] as string[], candadosSoltados: 0 };
  const trx = {
    raw: async (sql: string) => {
      k.consultas.push(sql);
      return sql.includes('pg_try_advisory_xact_lock') ? { rows: [{ tomado: candadoLibre }] } : { rows: [] };
    },
    isCompleted: () => false,
    commit: async () => { k.candadosSoltados++; },
  };
  const knex = { transaction: (fn?: (t: typeof trx) => Promise<unknown>) => { k.transacciones++; return fn ? fn(trx) : Promise.resolve(trx); } };
  return { knex, k };
}

let JPEG_URI = '';
class StorageFalso {
  pedidas: string[] = [];
  respuestas = new Map<string, string | null>();
  /** Se corre en cada descarga (la prueba del reloj lo usa para «gastar» tiempo al bajar la foto). */
  alPedir: (() => void) | null = null;
  async getDataUri(key: string): Promise<string | null> {
    this.pedidas.push(key);
    this.alPedir?.();
    return this.respuestas.has(key) ? this.respuestas.get(key)! : JPEG_URI;
  }
}

class LectorFalso {
  llamadas = 0;
  enVuelo = 0;
  maxEnVuelo = 0;
  caras: string[] = [];
  readonly tieneLlave = true;
  /** Se corre en cada llamada, antes de responder (la prueba del reloj la usa para que la llamada «tarde»). */
  antes: ((n: number) => void) | null = null;
  /** Si devuelve algo, se LANZA (simula 429/5xx/red); si no, se responde `respuesta(n)`. */
  falla: ((n: number) => unknown) | null = null;
  respuesta: (n: number) => ResultadoLectura = () => ({ estado: 'ok', lectura: lecturaOk(), uso: { ...USO }, error: null });
  async leerFoto(entrada: { base64: string; mediaType: string; cara: string }): Promise<ResultadoLectura> {
    const n = ++this.llamadas;
    this.caras.push(entrada.cara);
    this.enVuelo++;
    this.maxEnVuelo = Math.max(this.maxEnVuelo, this.enVuelo);
    try {
      await new Promise((r) => setTimeout(r, 5));
      this.antes?.(n);
      const e = this.falla?.(n);
      if (e) throw e;
      return this.respuesta(n);
    } finally {
      this.enVuelo--;
    }
  }
}

/**
 * Un `AnthropicService` falso para correr el LectorFotoService REAL dentro del worker (⛔ sin red). Lanza como el
 * transporte: `Error` con `status` y `retryAfterMs`. Responde como la API: un bloque de texto con el JSON.
 */
class TransporteFalso {
  hasApiKey = true;
  peticiones = 0;
  falla: ((n: number) => unknown) | null = null;
  cable: (n: number) => Record<string, unknown> = () => cableValido();
  async messages(): Promise<unknown> {
    const n = ++this.peticiones;
    const e = this.falla?.(n);
    if (e) throw e;
    return {
      model: 'claude-opus-5-5', stop_reason: 'end_turn',
      usage: { input_tokens: 1500, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: JSON.stringify(this.cable(n)) }],
    };
  }
}

/** Lo que manda la API por el cable (todo ausente salvo la marca), la misma forma que `lector-foto.service.spec.ts`. */
function cableValido(o: { legible?: 'si' | 'parcial' | 'no' } = {}): Record<string, unknown> {
  const ausente = { evidencia: '', valor: '', confianza: 'baja' };
  const campos: Record<string, unknown> = {};
  for (const k of ['denominacion', 'nombre_comercial', 'variante', 'edicion', 'fabricante', 'ingredientes', 'codigo_barras_visible', 'pais_origen', 'conservacion']) campos[k] = ausente;
  Object.assign(campos, {
    marca: { evidencia: 'BON O BON', valor: 'Bon o Bon', confianza: 'alta' },
    contenido_neto: { evidencia: '', valor: { cantidad: 0, unidad: 'g' }, confianza: 'baja' },
    piezas: { evidencia: '', valor: 0, confianza: 'baja' },
    contenido_por_pieza: { evidencia: '', valor: { cantidad: 0, unidad: 'g' }, confianza: 'baja' },
    sellos_nom051: { evidencia: '', valor: [], confianza: 'baja' },
    leyendas_nom051: { evidencia: '', valor: [], confianza: 'baja' },
    alergenos: { evidencia: '', valor: [], confianza: 'baja' },
    puede_contener: { evidencia: '', valor: [], confianza: 'baja' },
    alergenos_otros: { evidencia: '', valor: [], confianza: 'baja' },
    nutricion: { evidencia: '', valor: { base: { cantidad: 0, unidad: 'g' } }, confianza: 'baja' },
    empaque: { evidencia: '', valor: { tipo: null, material: null, colores: [] }, confianza: 'baja' },
  });
  const legible = o.legible ?? 'si';
  return {
    version: 'lectura-foto-v1', persona_visible: false, rostro_visible: false, legible, motivo_no_legible: legible === 'si' ? null : 'reflejo del flash',
    texto_literal: ['BON O BON'], nivel_fisico: { evidencia: 'una pieza suelta', valor: 'pieza', confianza: 'alta' }, campos,
  };
}

class WorkerPrueba extends LectorFotosWorker {
  cfg: ConfigLector = { ...CFG };
  esperas: number[] = [];
  conSharp = true;
  /** `null` = la pregunta real al lector (`tieneLlave`); `true`/`false` la fuerza. */
  llave: boolean | null = null;
  /** `null` = reloj real; un número = reloj simulado en ms, que `esperar` adelanta. */
  relojMs: number | null = null;
  constructor(knex: unknown, storage: StorageFalso, lector: LectorFalso | LectorFotoService, repo: RepoMem) {
    super(knex as never, storage as never, lector as never);
    this.repo = repo;
  }
  protected override config(): ConfigLector { return this.cfg; }
  protected override esperar(ms: number): Promise<void> {
    this.esperas.push(ms);
    if (this.relojMs != null) this.relojMs += ms;
    return Promise.resolve();
  }
  protected override sharpListo(): boolean { return this.conSharp; }
  protected override llaveLista(): boolean { return this.llave ?? super.llaveLista(); }
  protected override reloj(): number { return this.relojMs ?? super.reloj(); }
  fijarDuracionMax(ms: number): void { this.duracionMaxMs = ms; }
}

function armar(o: { cfg?: Partial<ConfigLector>; candadoLibre?: boolean; fichas?: FichaMem[]; lectorReal?: LectorFotoService } = {}) {
  const { knex, k } = knexFalso(o.candadoLibre ?? true);
  const repo = new RepoMem();
  repo.fichas = o.fichas ?? [];
  const storage = new StorageFalso();
  const lector = new LectorFalso();
  const w = new WorkerPrueba(knex, storage, o.lectorReal ?? lector, repo);
  w.cfg = { ...CFG, ...o.cfg };
  return { w, k, repo, storage, lector };
}

/** El LectorFotoService REAL sobre un transporte falso. */
function lectorReal(): { t: TransporteFalso; real: LectorFotoService } {
  const t = new TransporteFalso();
  return { t, real: new LectorFotoService(t as unknown as AnthropicService) };
}
/** Lo que lanza `AnthropicService` ante un HTTP que no es 2xx. */
const errorApi = (status: number, retryAfterMs: number | null = null) =>
  Object.assign(new Error(`Anthropic HTTP ${status}: {"type":"error"}`), { status, retryAfterMs });

const error = (status: number | null, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(status == null ? 'fetch failed' : `Anthropic HTTP ${status}`), status == null ? {} : { status }, extra);

beforeAll(async () => {
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer();
  JPEG_URI = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

// ── Arranque ──────────────────────────────────────────────────────────────────────────────────

describe('[NP.7.L.11d] arranque (lección de #414)', () => {
  // vitest transpila SIN emitDecoratorMetadata: se mide la aridad del constructor, el registro en el módulo y
  // el cron, no design:paramtypes (eso queda «arranque no verificado» hasta el CI/prod).
  const meta = (k: string, o: object) => (Reflect as unknown as { getMetadata(k: string, o: object): unknown }).getMetadata(k, o);
  it('el constructor toma sus tres dependencias (knex, bucket, lector)', () => {
    expect(LectorFotosWorker.length).toBe(3);
  });
  it('el módulo provee el worker, el lector y su transporte', () => {
    const providers = (meta('providers', ProductSheetsModule) ?? []) as unknown[];
    for (const p of [LectorFotosWorker, LectorFotoService, AnthropicService]) expect(providers).toContain(p);
  });
  it('el cron queda registrado cada 5 minutos en hora de México', () => {
    expect(meta('SCHEDULE_CRON_OPTIONS', LectorFotosWorker.prototype.programado)).toMatchObject({ cronTime: '0 */5 * * * *', timeZone: 'America/Mexico_City' });
  });
});

// ── Apagada ─────────────────────────────────────────────────────────────────────────────────────

describe('[NP.7.L.11d] apagada (D6 sin firmar)', () => {
  it('cero consultas a la base, cero llamadas al lector, cero descargas del bucket', async () => {
    const { w, k, repo, storage, lector } = armar({ cfg: { habilitada: false }, fichas: [ficha('A', ['a1', 'a2'])] });
    const r = await w.procesar('cron');
    expect(r.estado).toBe('apagada');
    expect(r.pendientes_restantes).toBeNull();
    expect(k.transacciones).toBe(0);
    expect(k.consultas).toHaveLength(0);
    expect(repo.consultas).toBe(0);
    expect(storage.pedidas).toHaveLength(0);
    expect(lector.llamadas).toBe(0);
  });

  it('el cron nunca relanza (registra y sigue)', async () => {
    const { w } = armar();
    w.cfg = undefined as never; // config() rota: `cfg.habilitada` lanza
    await expect(w.programado()).resolves.toBeUndefined();
  });
});

describe('[NP.7.L.11d] una sola corrida', () => {
  it('si otra instancia tiene el candado, no hace nada', async () => {
    const { w, k, repo, lector } = armar({ candadoLibre: false, fichas: [ficha('A', ['a1'])] });
    const r = await w.procesar();
    expect(r.estado).toBe('ocupado');
    expect(k.consultas.some((s) => s.includes('pg_try_advisory_xact_lock'))).toBe(true);
    expect(repo.consultas).toBe(0);
    expect(lector.llamadas).toBe(0);
    expect(k.candadosSoltados).toBe(1);
  });

  it('sin sharp no hay recorte y no sale ninguna foto', async () => {
    const { w, lector, k } = armar({ fichas: [ficha('A', ['a1'])] });
    w.conSharp = false;
    const r = await w.procesar();
    expect(r.estado).toBe('sin_preparacion');
    expect(lector.llamadas).toBe(0);
    expect(k.transacciones).toBe(0);
  });

  it('dos corridas a la vez en el mismo proceso: la segunda sale «ocupado»', async () => {
    const { w, lector } = armar({ fichas: [ficha('A', ['a1', 'a2'])] });
    const [a, b] = await Promise.all([w.procesar(), w.procesar()]);
    expect([a.estado, b.estado].sort()).toEqual(['completa', 'ocupado']);
    expect(lector.llamadas).toBe(2);
  });
});

// ── Tope diario y concurrencia ──────────────────────────────────────────────────────────────────

describe('[NP.7.L.11d] tope diario', () => {
  it('cuenta sólo las llamadas REALES de hoy (hora de México): ni las copiadas ni las de ayer', async () => {
    const hoy = new Date().toISOString();
    const ayer = new Date(Date.now() - 36 * 3600_000).toISOString();
    const lecturas: Record<string, LecturaGuardada> = {};
    const g = (uso: boolean, leida_en: string): LecturaGuardada => ({
      estado: 'ok', lectura: lecturaOk(), uso: uso ? { ...USO } : null, error: null, cara: 'frente', peldano: 'base', leida_en, preparacion: null,
    });
    for (let i = 0; i < 198; i++) lecturas[`hoy${i}`] = g(true, hoy);
    for (let i = 0; i < 5; i++) lecturas[`ayer${i}`] = g(true, ayer);
    for (let i = 0; i < 3; i++) lecturas[`copia${i}`] = g(false, hoy);
    const historia = ficha('H', [], { status: 'publicada', ai_raw: { version: 'ai-raw-v1', lecturas, propuesta: null, auditoria: null, actualizado_en: hoy } });
    const { w, lector } = armar({ cfg: { topeDiario: 200 }, fichas: [historia, ficha('A', ['a1', 'a2', 'a3', 'a4', 'a5']), ficha('B', ['b1', 'b2', 'b3', 'b4', 'b5'])] });

    const r1 = await w.procesar();
    expect(lector.llamadas).toBe(2);
    expect(r1).toMatchObject({ estado: 'completa', llamadas: 2, leidas: 2, pendientes_restantes: 8 });

    const r2 = await w.procesar();
    expect(r2.estado).toBe('tope_diario');
    expect(lector.llamadas).toBe(2);
  });

  it('tope 0 = ninguna lectura (ni se buscan pendientes)', async () => {
    const { w, lector, repo } = armar({ cfg: { topeDiario: 0 }, fichas: [ficha('A', ['a1'])] });
    const r = await w.procesar();
    expect(r.estado).toBe('tope_diario');
    expect(lector.llamadas).toBe(0);
    expect(repo.consultas).toBe(1); // sólo el conteo de hoy
  });

  it('ráfaga de 500 fotos: nunca más de `concurrencia` en vuelo y nunca más del tope diario', async () => {
    const fichas = Array.from({ length: 100 }, (_, i) => ficha(`F${i}`, CARAS.map((c) => `sha-${i}-${c}`)));
    const { w, lector } = armar({ cfg: { topeDiario: 200, concurrencia: 3 }, fichas });
    const estados: string[] = [];
    let costo = 0;
    for (let corrida = 0; corrida < 12; corrida++) {
      const r = await w.procesar('cron');
      estados.push(r.estado);
      costo += r.costo_usd ?? Number.NaN;
      expect(r.llamadas).toBeLessThanOrEqual(50);
    }
    expect(lector.llamadas).toBe(200);
    expect(lector.maxEnVuelo).toBeLessThanOrEqual(3);
    expect(lector.maxEnVuelo).toBeGreaterThan(1); // de verdad corre en paralelo
    expect(estados.slice(0, 4)).toEqual(['completa', 'completa', 'completa', 'completa']);
    expect(new Set(estados.slice(4))).toEqual(new Set(['tope_diario']));
    // El costo sale de lo que devolvió cada llamada (`uso.costo_usd`), no de una estimación.
    expect(costo).toBeCloseTo(200 * USO.costo_usd, 6);
  });
});

// ── Idempotencia por sha256 ─────────────────────────────────────────────────────────────────────

describe('[NP.7.L.11d] la misma foto no se paga dos veces', () => {
  it('la misma foto en dos fichas del mismo lote → UNA llamada; la segunda ficha recibe la copia con uso null', async () => {
    const { w, lector, repo } = armar({ fichas: [ficha('A', ['igual']), ficha('B', ['igual'])] });
    const r = await w.procesar();
    expect(lector.llamadas).toBe(1);
    expect(r).toMatchObject({ llamadas: 1, leidas: 1, reusadas: 1, pendientes_restantes: 0 });
    const [a, b] = repo.fichas;
    expect(a.ai_raw!.lecturas['igual'].uso).not.toBeNull();
    expect(b.ai_raw!.lecturas['igual'].uso).toBeNull();
    expect(b.ai_raw!.lecturas['igual'].lectura).toEqual(a.ai_raw!.lecturas['igual'].lectura);
  });

  it('una ficha nueva con una foto ya leída en otra ficha → cero llamadas', async () => {
    const { w, lector, repo } = armar({ fichas: [ficha('A', ['igual'])] });
    await w.procesar();
    repo.fichas.push(ficha('C', ['igual']));
    const r = await w.procesar();
    expect(lector.llamadas).toBe(1);
    expect(r).toMatchObject({ llamadas: 0, reusadas: 1, estado: 'completa' });
    expect(repo.fichas[1].ai_raw!.lecturas['igual'].uso).toBeNull();
    // Y la copia no cuenta para el tope.
    expect(await repo.llamadasDeHoy(null, '', new Date())).toBe(1);
  });

  it('la misma foto en dos caras de UNA ficha → una llamada y una sola llave', async () => {
    const { w, lector, repo } = armar({ fichas: [ficha('A', ['x', 'x', 'y'])] });
    await w.procesar();
    expect(lector.llamadas).toBe(2);
    expect(Object.keys(repo.fichas[0].ai_raw!.lecturas).sort()).toEqual(['x', 'y']);
  });
});

// ── 429 / 5xx / red ─────────────────────────────────────────────────────────────────────────────

describe('[NP.7.L.11d] reintentos y lote detenido', () => {
  it('429 que no cede: 3 intentos con la espera que pide la API, y el lote se DETIENE', async () => {
    const { w, lector, repo } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2', 'a3'])] });
    lector.falla = () => error(429, { retryAfterMs: 1500 });
    const r = await w.procesar();
    expect(lector.llamadas).toBe(3);
    expect(w.esperas).toEqual([1500, 1500]);
    expect(r).toMatchObject({ estado: 'detenida', llamadas: 0, fallidas: 1, pendientes_restantes: 3 });
    expect(r.detalle).toMatch(/3 intentos/);
    expect(repo.fichas[0].ai_raw).toBeNull();
    // La siguiente corrida retoma lo pendiente.
    lector.falla = null;
    const r2 = await w.procesar();
    expect(r2).toMatchObject({ estado: 'completa', leidas: 3, pendientes_restantes: 0 });
  });

  it('sin retry-after: espera exponencial desde 2 s; un 429 pasajero no detiene nada', async () => {
    const { w, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1'])] });
    lector.falla = (n) => (n === 1 ? error(429) : null);
    const r = await w.procesar();
    expect(w.esperas).toEqual([2000]);
    expect(r).toMatchObject({ estado: 'completa', leidas: 1, llamadas: 1 });
  });

  it('5xx y red (sin status) se reintentan: 2 s, 4 s y se detiene', async () => {
    for (const e of [error(503), error(529), error(null)]) {
      const { w, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2'])] });
      lector.falla = () => e;
      const r = await w.procesar();
      expect(lector.llamadas).toBe(3);
      expect(w.esperas).toEqual([2000, 4000]);
      expect(r.estado).toBe('detenida');
    }
  });

  it('pasado el tiempo de corrida no se empieza otra foto (el candado no queda abierto de más)', async () => {
    const { w, lector } = armar({ fichas: [ficha('A', ['a1', 'a2'])] });
    w.fijarDuracionMax(-1);
    const r = await w.procesar();
    expect(lector.llamadas).toBe(0);
    expect(r.estado).toBe('detenida');
    expect(r.detalle).toMatch(/tiempo de corrida/);
    expect(r.pendientes_restantes).toBe(2);
  });

  it('un 4xx LANZADO (aun sin la clase de configuración) no se reintenta: detiene el lote sin esperar', async () => {
    const { w, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2'])] });
    lector.falla = () => error(401);
    const r = await w.procesar();
    expect(lector.llamadas).toBe(1);
    expect(w.esperas).toEqual([]);
    expect(r.estado).toBe('detenida');
  });

  it('⭐ revisión: un retry-after más largo que ESPERA_MAX_MS no se adelanta — una llamada y el lote se detiene', async () => {
    const { w, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1'])] });
    lector.falla = () => error(429, { retryAfterMs: 600_000 });
    const r = await w.procesar();
    expect(lector.llamadas).toBe(1);
    expect(w.esperas).toEqual([]);
    expect(r).toMatchObject({ estado: 'detenida', pendientes_restantes: 1 });
    expect(r.detalle).toMatch(/pidió esperar 600 s/);
  });

  it('control: un retry-after de exactamente ESPERA_MAX_MS sí se espera y se reintenta', async () => {
    const { w, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1'])] });
    lector.falla = () => error(429, { retryAfterMs: ESPERA_MAX_MS });
    await w.procesar();
    expect(lector.llamadas).toBe(3);
    expect(w.esperas).toEqual([ESPERA_MAX_MS, ESPERA_MAX_MS]);
  });
});

// ── Revisión 2026-11-04: error de configuración con el LECTOR REAL ──────────────────────────────

describe('[NP.7.L.11d] revisión: error de configuración con el LectorFotoService REAL (transporte falso, sin red)', () => {
  it('⭐ 400/401/403/404: se detiene en la primera foto, NO se guarda ninguna lectura y, arreglado, se leen todas', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { t, real } = lectorReal();
      t.falla = () => errorApi(status);
      const { w, repo } = armar({ cfg: { concurrencia: 1 }, lectorReal: real, fichas: [ficha('A', ['a1', 'a2', 'a3']), ficha('B', ['b1', 'b2', 'b3'])] });
      const r = await w.procesar();
      expect(r, `HTTP ${status}`).toMatchObject({ estado: 'detenida', llamadas: 0, pendientes_restantes: 6 });
      expect(r.detalle).toMatch(new RegExp(`configuración.*HTTP ${status}`));
      expect(t.peticiones).toBe(1);
      expect(w.esperas).toEqual([]);
      expect(repo.fichas.map((f) => f.ai_raw)).toEqual([null, null]);
      // ❌ Antes: 6 lecturas «error» guardadas y la corrida siguiente `sin_pendientes`. Ahora, arreglada la llave:
      t.falla = null;
      const r2 = await w.procesar();
      expect(r2, `HTTP ${status} arreglado`).toMatchObject({ estado: 'completa', leidas: 6, fallidas: 0, pendientes_restantes: 0, propuestas: 2 });
    }
  });

  it('con la configuración rota salen a lo más `concurrencia` peticiones por corrida (deuda (g))', async () => {
    const { t, real } = lectorReal();
    t.falla = () => errorApi(401);
    const fichas = Array.from({ length: 10 }, (_, i) => ficha(`F${i}`, CARAS.map((c) => `sha-${i}-${c}`)));
    const { w, repo } = armar({ cfg: { concurrencia: 3 }, lectorReal: real, fichas });
    const r = await w.procesar();
    expect(r.estado).toBe('detenida');
    expect(t.peticiones).toBeLessThanOrEqual(3);
    expect(repo.fichas.every((f) => f.ai_raw === null)).toBe(true);
  });

  it('sin llave: «sin_llave» sin tocar la base; y si esa compuerta se saltara, el lector lanza y no se guarda nada', async () => {
    const { t, real } = lectorReal();
    t.hasApiKey = false;
    const { w, repo, k } = armar({ lectorReal: real, fichas: [ficha('A', ['a1', 'a2'])] });
    const r = await w.procesar();
    expect(r.estado).toBe('sin_llave');
    expect(k.transacciones).toBe(0);
    expect(repo.consultas).toBe(0);
    // Defensa en profundidad: la compuerta de arriba forzada a «sí hay llave».
    w.llave = true;
    const r2 = await w.procesar();
    expect(r2.estado).toBe('detenida');
    expect(r2.detalle).toMatch(/ANTHROPIC_API_KEY/);
    expect(t.peticiones).toBe(0);
    expect(repo.fichas[0].ai_raw).toBeNull();
  });

  it('413 sí es de la foto: esa foto queda con lectura «error» (no se vuelve a pagar) y las demás se leen', async () => {
    const { t, real } = lectorReal();
    t.falla = (n) => (n === 1 ? errorApi(413) : null);
    const { w, repo } = armar({ cfg: { concurrencia: 1 }, lectorReal: real, fichas: [ficha('A', ['a1', 'a2', 'a3'])] });
    const r = await w.procesar();
    expect(r).toMatchObject({ estado: 'completa', leidas: 2, fallidas: 1, pendientes_restantes: 0, propuestas: 0 });
    expect(repo.fichas[0].ai_raw!.lecturas['a1']).toMatchObject({ estado: 'error', uso: null });
    await w.procesar();
    expect(t.peticiones).toBe(3);
  });
});

// ── Revisión 2026-11-04: el reloj frena también los reintentos ───────────────────────────────────

describe('[NP.7.L.11d] revisión: el candado no queda abierto más de lo que aguanta db-health', () => {
  it('el peor caso cabe bajo el amarillo: DURACION_MAX_MS + TIMEOUT_MS + holgura ≤ 300 s', () => {
    expect(UMBRAL_IDLE_TX_MS).toBe(300_000);
    expect(DURACION_MAX_MS).toBeGreaterThan(0);
    expect(DURACION_MAX_MS + TIMEOUT_MS + HOLGURA_CANDADO_MS).toBeLessThanOrEqual(UMBRAL_IDLE_TX_MS);
  });

  it('⭐ una foto que empieza al final y no responde en TIMEOUT_MS: UN intento, sin esperas, y nada pasa de DURACION_MAX_MS + TIMEOUT_MS', async () => {
    const { w, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2'])] });
    w.relojMs = 0;
    // La primera llamada empieza 1 s antes del límite y tarda TIMEOUT_MS; las siguientes (si las hubiera), otro tanto.
    lector.antes = (n) => { w.relojMs = (n === 1 ? DURACION_MAX_MS - 1_000 : w.relojMs!) + TIMEOUT_MS; };
    lector.falla = () => error(null);
    const r = await w.procesar();
    expect(lector.llamadas).toBe(1);
    expect(w.esperas).toEqual([]);
    expect(r).toMatchObject({ estado: 'detenida', pendientes_restantes: 2 });
    expect(r.detalle).toMatch(/tiempo de corrida agotado/);
    expect(w.relojMs).toBeLessThanOrEqual(DURACION_MAX_MS + TIMEOUT_MS);
  });

  it('control: un reintento que sí cabe se hace (529 y respuesta al segundo intento)', async () => {
    const { w, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1'])] });
    w.relojMs = 0;
    lector.antes = () => { w.relojMs! += 10_000; };
    lector.falla = (n) => (n === 1 ? error(529) : null);
    const r = await w.procesar();
    expect(lector.llamadas).toBe(2);
    expect(w.esperas).toEqual([2000]);
    expect(r).toMatchObject({ estado: 'completa', leidas: 1 });
  });

  it('si bajar y preparar se comen el tiempo, la foto se POSPONE: ninguna llamada y no cuenta como fallida', async () => {
    const { w, lector, storage } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1'])] });
    w.relojMs = 0;
    storage.alPedir = () => { w.relojMs = DURACION_MAX_MS + 1; };
    const r = await w.procesar();
    expect(lector.llamadas).toBe(0);
    expect(r).toMatchObject({ estado: 'detenida', fallidas: 0, pendientes_restantes: 1 });
    expect(r.detalle).toMatch(/tiempo de corrida/);
  });
});

// ── Lo que se guarda ────────────────────────────────────────────────────────────────────────────

/** ¿El UPDATE asigna SÓLO `ai_raw`? (lo que va entre SET y WHERE). */
function asignaSoloAiRaw(sql: string): boolean {
  const set = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(sql)?.[1] ?? '';
  return /^\s*ai_raw\s*=/.test(set) && !/\b(sheet|status|photos|updated_at|updated_by|deleted_at|superseded_at)\s*=/i.test(set);
}

describe('[NP.7.L.11d] nunca escribe sheet, status ni photos', () => {
  it('las únicas escrituras del worker son dos UPDATE que asignan sólo ai_raw; ningún INSERT ni DELETE', () => {
    const sqls = Object.values(SQL_LECTOR);
    expect(sqls.filter((s) => /\b(INSERT\s+INTO|DELETE\s+FROM)\b/i.test(s))).toHaveLength(0);
    const updates = sqls.filter((s) => /^\s*UPDATE\b/i.test(s));
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(asignaSoloAiRaw(u)).toBe(true);
  });

  it('prueba negativa del revisor: un UPDATE que toca status se detecta', () => {
    expect(asignaSoloAiRaw(`UPDATE catalog.product_sheets SET ai_raw = '{}'::jsonb, status = 'publicada' WHERE id = ?`)).toBe(false);
    expect(asignaSoloAiRaw(`UPDATE catalog.product_sheets SET photos = '[]'::jsonb WHERE id = ?`)).toBe(false);
  });

  it('después de leer y proponer, photos, sheet y status quedan idénticos', async () => {
    const fichas = [ficha('A', ['a1', 'a2', 'a3', 'a4', 'a5']), ficha('B', ['b1', 'b2'], { status: 'publicada' })];
    const antes = structuredClone(fichas.map(({ photos, status, principal }) => ({ photos, status, principal })));
    const { w, repo } = armar({ fichas });
    await w.procesar();
    expect(repo.fichas.map(({ photos, status, principal }) => ({ photos, status, principal }))).toEqual(antes);
    expect(repo.fichas.every((f) => f.ai_raw?.version === 'ai-raw-v1')).toBe(true);
  });
});

describe('[NP.7.L.11d] propuesta y auditoría', () => {
  it('con las 5 caras leídas ok: propuesta (fusión real) y auditoría contra Kepler en ai_raw', async () => {
    const { w, repo, lector } = armar({ fichas: [ficha('A', ['a1', 'a2', 'a3', 'a4', 'a5'])] });
    const r = await w.procesar();
    expect(r.propuestas).toBe(1);
    const ai = repo.fichas[0].ai_raw!;
    expect(ai.propuesta?.caras_leidas.sort()).toEqual([...CARAS].sort());
    expect(ai.auditoria).not.toBeNull();
    expect(lector.caras.sort()).toEqual([...CARAS].sort());
    // Cada lectura guarda cómo se preparó la foto (recorte y tamaño) para poder repetirla.
    expect(ai.lecturas['a1'].preparacion?.recorte).not.toBeNull();
    expect(ai.lecturas['a1'].leida_en).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('una cara con respuesta inválida: se guarda (no se vuelve a pagar) y NO hay propuesta', async () => {
    const { w, repo, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2', 'a3'])] });
    lector.respuesta = (n) => (n === 2
      ? { estado: 'invalida', lectura: null, uso: { ...USO }, error: 'la respuesta no es JSON' }
      : { estado: 'ok', lectura: lecturaOk(), uso: { ...USO }, error: null });
    const r = await w.procesar();
    expect(r).toMatchObject({ llamadas: 3, leidas: 2, fallidas: 1, propuestas: 0, pendientes_restantes: 0 });
    expect(repo.fichas[0].ai_raw!.propuesta).toBeNull();
    await w.procesar();
    expect(lector.llamadas).toBe(3);
  });

  it('⭐ rostro visible: queda en la lectura, en el resumen, en el log y como hallazgo rostro_visible de la auditoría', async () => {
    const { w, repo, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2'])] });
    const avisos = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      lector.respuesta = (n) => ({ estado: 'ok', lectura: lecturaOk({ rostro: n === 1 }), uso: { ...USO }, error: null });
      const r = await w.procesar();
      expect(r.rostros_visibles).toBe(1);
      const ai = repo.fichas[0].ai_raw!;
      expect(Object.values(ai.lecturas).filter((l) => l.lectura?.rostro_visible).length).toBe(1);
      expect(ai.auditoria!.hallazgos.map((h) => h.tipo)).toContain('rostro_visible');
      expect(avisos.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ROSTRO visible'))).toHaveLength(1);
    } finally {
      avisos.mockRestore();
    }
  });

  it('⭐ revisión 2026-11-05: una lectura que no quedó ok deja el rostro NO MEDIDO — cuenta y avisa, no pasa como limpia', async () => {
    const { w, repo, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2'])] });
    const avisos = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      lector.respuesta = (n) => (n === 2
        ? { estado: 'invalida', lectura: null, uso: { ...USO }, error: 'rostro_visible no es booleano (no se supone false)' }
        : { estado: 'ok', lectura: lecturaOk(), uso: { ...USO }, error: null });
      const r = await w.procesar();
      expect(r).toMatchObject({ leidas: 1, fallidas: 1, rostros_visibles: 0, rostros_no_medidos: 1, propuestas: 0 });
      const avisosRostro = avisos.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ROSTRO NO MEDIDO'));
      expect(avisosRostro).toHaveLength(1);
      expect(avisosRostro[0]).toContain('rostro_visible no es booleano');
      expect(avisosRostro[0]).toContain('«tiene rostro»');
      // Queda guardada SIN el booleano: quien borre (deuda (a)) no puede leer un `false` de ella.
      expect(Object.values(repo.fichas[0].ai_raw!.lecturas).filter((l) => l.lectura == null)).toHaveLength(1);
    } finally {
      avisos.mockRestore();
    }
  });

  it('⭐ una mano o un zapato (persona sin rostro): queda en la lectura, pero ni cuenta, ni avisa, ni es hallazgo', async () => {
    const { w, repo, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2'])] });
    const avisos = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      lector.respuesta = () => ({ estado: 'ok', lectura: lecturaOk({ persona: true }), uso: { ...USO }, error: null });
      const r = await w.procesar();
      expect(r.rostros_visibles).toBe(0);
      expect(r.rostros_no_medidos).toBe(0); // prueba negativa: todas ok → ninguna sin medir
      const ai = repo.fichas[0].ai_raw!;
      expect(Object.values(ai.lecturas).every((l) => l.lectura?.persona_visible === true)).toBe(true);
      expect(ai.propuesta?.persona_visible).toBe(true);
      expect(ai.propuesta?.rostro_visible).toBe(false);
      expect(ai.auditoria!.hallazgos.map((h) => h.tipo)).not.toContain('rostro_visible');
      expect(avisos.mock.calls.map((c) => String(c[0])).filter((m) => /ROSTRO|persona/i.test(m))).toEqual([]);
    } finally {
      avisos.mockRestore();
    }
  });

  it('⭐ revisión: caras ilegibles → un foto_no_legible por cara con legible «no» (antes la auditoría quedaba vacía)', async () => {
    const { w, repo, lector } = armar({ cfg: { concurrencia: 1 }, fichas: [ficha('A', ['a1', 'a2', 'a3'])] });
    lector.respuesta = (n) => ({
      estado: 'ok', lectura: { ...lecturaOk(), legible: n === 3 ? 'si' : 'no', motivo_no_legible: n === 3 ? null : 'reflejo del flash' }, uso: { ...USO }, error: null,
    });
    const r = await w.procesar();
    expect(r.propuestas).toBe(1);
    const hs = repo.fichas[0].ai_raw!.auditoria!.hallazgos.filter((h) => h.tipo === 'foto_no_legible');
    expect(hs.map((h) => h.foto).sort()).toEqual(['frente: reflejo del flash', 'reverso: reflejo del flash']);
  });

  it('revisión (repro del revisor, LECTOR REAL): las 3 caras ilegibles y Kepler «BON O BON FRESA 8/15G» → 3 hallazgos, no []', async () => {
    const { t, real } = lectorReal();
    t.cable = () => cableValido({ legible: 'no' });
    const { w, repo } = armar({ cfg: { concurrencia: 1 }, lectorReal: real, fichas: [ficha('A', ['a1', 'a2', 'a3'])] });
    await w.procesar();
    const ai = repo.fichas[0].ai_raw!;
    expect(Object.values(ai.lecturas).map((l) => `${l.estado}/${l.lectura?.legible}`)).toEqual(['ok/no', 'ok/no', 'ok/no']);
    expect(ai.auditoria!.hallazgos.map((h) => h.tipo)).toEqual(['foto_no_legible', 'foto_no_legible', 'foto_no_legible']);
  });

  it('control: con todas las caras legibles no sale ningún foto_no_legible', async () => {
    const { w, repo } = armar({ fichas: [ficha('A', ['a1', 'a2', 'a3', 'a4', 'a5'])] });
    await w.procesar();
    expect(repo.fichas[0].ai_raw!.auditoria!.hallazgos.filter((h) => h.tipo === 'foto_no_legible')).toEqual([]);
  });

  it('el costo es null (NO MEDIDO) si una llamada no trae precio', async () => {
    const { w, lector } = armar({ fichas: [ficha('A', ['a1', 'a2'])] });
    lector.respuesta = (n) => ({ estado: 'ok', lectura: lecturaOk(), uso: { ...USO, costo_usd: n === 1 ? null : 0.01 }, error: null });
    const r = await w.procesar();
    expect(r.costo_usd).toBeNull();
    expect(r.llamadas_sin_precio).toBe(1);
    expect(r.detalle).toMatch(/NO MEDIDO/);
  });
});

describe('[NP.7.L.11d] fallos de este lado', () => {
  it('el bucket no entrega la foto: no se guarda nada, queda pendiente y las demás siguen', async () => {
    const { w, repo, storage, lector } = armar({ fichas: [ficha('A', ['a1', 'a2'])] });
    storage.respuestas.set('levantamiento/01/A/0.jpg', null);
    const r = await w.procesar();
    // No se guardó nada de a1: queda pendiente y se vuelve a leer; no es un rostro NO MEDIDO definitivo.
    expect(r).toMatchObject({ leidas: 1, fallidas: 1, pendientes_restantes: 1, rostros_no_medidos: 0 });
    expect(Object.keys(repo.fichas[0].ai_raw!.lecturas)).toEqual(['a2']);
    storage.respuestas.clear();
    await w.procesar();
    expect(lector.llamadas).toBe(2);
  });

  it('una foto que no se puede decodificar se guarda como error SIN llamada (no se reintenta cada 5 min)', async () => {
    const { w, repo, storage, lector } = armar({ fichas: [ficha('A', ['a1'])] });
    storage.respuestas.set('levantamiento/01/A/0.jpg', `data:image/jpeg;base64,${Buffer.from('no soy un jpeg').toString('base64')}`);
    const r = await w.procesar();
    expect(lector.llamadas).toBe(0);
    // Guardada sin lectura: su rostro es NO MEDIDO (revisión 2026-11-05), no «sin rostro».
    expect(r).toMatchObject({ llamadas: 0, fallidas: 1, pendientes_restantes: 0, rostros_no_medidos: 1 });
    expect(repo.fichas[0].ai_raw!.lecturas['a1']).toMatchObject({ estado: 'error', uso: null });
    expect(repo.fichas[0].ai_raw!.lecturas['a1'].error).toMatch(/no se pudo preparar/);
  });
});

// ── Reglas puras ────────────────────────────────────────────────────────────────────────────────

describe('[NP.7.L.11d] reglas puras', () => {
  it('agruparPorFoto: una llave por sha256, sin repetir la ficha', () => {
    const p = (sheet_id: string, sha256: string, cara: string): FotoPendiente =>
      ({ sheet_id, sku: 's', branch_code: '01', principal: 'base', cara, peldano: 'base', storage_key: `k-${sha256}`, sha256 });
    const g = agruparPorFoto([p('A', 'x', 'frente'), p('A', 'x', 'reverso'), p('B', 'x', 'frente'), p('A', 'y', 'base')]);
    expect(g.map((x) => [x.sha256, x.pares.map((q) => q.sheet_id)])).toEqual([['x', ['A', 'B']], ['y', ['A']]]);
  });

  it('fichaLista: todas las fotos reales del peldaño principal con lectura ok (y al menos una)', () => {
    const fotos: FotoDeFicha[] = [
      { peldano: 'base', cara: 'frente', storage_key: 'k1', sha256: 'a' },
      { peldano: 'base', cara: 'reverso', storage_key: null, sha256: null },
      { peldano: 'dos', cara: 'frente', storage_key: 'k3', sha256: 'z' },
    ];
    const ok = { estado: 'ok', lectura: lecturaOk() } as LecturaGuardada;
    expect(fichaLista(fotos, 'base', { a: ok })).toBe(true);
    expect(fichaLista(fotos, 'base', {})).toBe(false);
    expect(fichaLista(fotos, 'base', { a: { ...ok, estado: 'incompleta', lectura: null } })).toBe(false);
    expect(fichaLista([fotos[1]], 'base', {})).toBe(false);
  });

  it('esperaDeReintento: retry-after hasta 60 s se respeta; más largo → null (no se insiste antes); si no, 2 s, 4 s', () => {
    expect(esperaDeReintento({ retryAfterMs: 1500 }, 1)).toBe(1500);
    expect(esperaDeReintento({ retryAfterMs: ESPERA_MAX_MS }, 1)).toBe(ESPERA_MAX_MS);
    // ❌ Antes 60_000: se reintentaba a los 60 s aunque la API pidiera 10 min.
    expect(esperaDeReintento({ retryAfterMs: 600_000 }, 1)).toBeNull();
    expect(esperaDeReintento({}, 1)).toBe(2000);
    expect(esperaDeReintento(new Error('x'), 2)).toBe(4000);
  });

  it('enParalelo: nunca más del límite en vuelo, y deja de tomar al parar', async () => {
    let vuelo = 0;
    let max = 0;
    const hechos: number[] = [];
    await enParalelo([...Array(12).keys()], 4, () => false, async (x) => {
      vuelo++; max = Math.max(max, vuelo);
      await new Promise((r) => setTimeout(r, 3));
      vuelo--; hechos.push(x);
    });
    expect(max).toBe(4);
    expect(hechos.sort((a, b) => a - b)).toEqual([...Array(12).keys()]);

    const tomados: number[] = [];
    await enParalelo([...Array(10).keys()], 2, () => tomados.length >= 3, async (x) => { tomados.push(x); });
    expect(tomados.length).toBeLessThanOrEqual(4);
  });
});
