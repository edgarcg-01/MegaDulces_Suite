import { QUIEN_RESUELVE_TEXTO, lecturaKepler, solicitudCanceladaEnKepler, type ComprobacionEnLaCola, type QuienResuelve } from '@megadulces/contracts';
import type { ValeEsperaKepler } from '../comprobaciones.service';

/**
 * `[PGP.123]` G.9 — Las reglas puras de «Esperan a Kepler» como cola de comprobación (anexo G §14.2–§14.3), para
 * probarlas sin montar Aprobación.
 *
 * La prueba de la frase: «¿qué le falta a cada gasto autorizado para quedar comprobado en Kepler?». Antes era una
 * sola lista por días (G.UI.3: quien comprueba buscaba sus 126 entre 18 por autorizar y 29 canceladas, que iban
 * primero). Ahora: primero lo que se comprueba, partido en lo que tiene un motivo (por quién lo mueve) y lo que
 * escribe la Suite; lo demás, plegado con su conteo.
 *
 * ⛔ «La Suite las escribe» sólo cuenta lo que la Suite VA a escribir sin que nadie haga nada: lo que ya escribió, o lo
 * listo en una base donde la escritura está abierta. Lo listo en una base cerrada (el interruptor de la sucursal o la
 * bandera apagados) lo sigue capturando una persona en Kepler, y decir lo contrario
 * haría que nadie lo comprobara.
 */

/** La sección de «con motivo» a la que va un vale. `QuienResuelve` = el motivo de G.5, por quién lo mueve. */
export type ClaveDelGrupo = 'fallo' | 'apagada' | 'sin_calcular' | 'ya_tiene' | QuienResuelve;

/** Un grupo de «con motivo»: su título en llano y sus vales. */
export interface GrupoConMotivo {
  clave: ClaveDelGrupo;
  titulo: string;
  vales: ValeEsperaKepler[];
}

export interface ColaDeKepler {
  /**
   * `[PGP.122]` Firmados que nacieron en la Suite y cuya solicitud Kepler TODAVÍA NO TIENE (sin folio): Kepler la
   * rechazó, se atoró, o se está escribiendo. Antes caían en «No se pudo leer su estado en Kepler» —plegado y sin poder
   * abrirse— aunque Kepler sí había contestado. Van primero y a la vista: el rechazo necesita a una persona.
   */
  sinEscribir: ValeEsperaKepler[];
  /** Autorizados sin gasto: la cola de comprobación. Es exactamente `laSuite` + los vales de `conMotivo`. */
  porComprobar: ValeEsperaKepler[];
  /** Los que la Suite escribe sola (o ya escribió). */
  laSuite: ValeEsperaKepler[];
  /** Los que necesitan a una persona, por qué y quién los mueve (en el orden de `ORDEN_GRUPOS`). */
  conMotivo: GrupoConMotivo[];
  porAutorizar: ValeEsperaKepler[];
  aplicadaSinLigar: ValeEsperaKepler[];
  /**
   * `[PGP.123]` G.UI.1c — Las que Kepler canceló, con su gasto ya generado («¿salió dinero?») o sin él. No esperan nada
   * de Kepler: van a su propia lista, «Canceladas en Kepler» (pedido de Francisco, 2026-11-16).
   */
  canceladas: ValeEsperaKepler[];
  /** Lo que no se pudo medir: la espera de Kepler. */
  sinMedir: ValeEsperaKepler[];
}

/** Primero lo que necesita una decisión (el fallo y las excepciones con su dueño); después lo rutinario. */
export const ORDEN_GRUPOS: readonly ClaveDelGrupo[] = ['fallo', 'sucursal', 'finanzas', 'contabilidad', 'suite', 'apagada', 'sin_calcular', 'ya_tiene', 'nadie'];
export const TITULO_GRUPO: Readonly<Record<ClaveDelGrupo, string>> = {
  fallo: 'La Suite las intentó y necesitan a una persona',
  // La comprobación (el «Alta gasto CFDI») es de la sucursal; Finanzas autoriza (Francisco, 2026-11-17).
  sucursal: 'Las comprueba la sucursal, en Kepler',
  finanzas: 'Le toca a Finanzas, en Kepler',
  contabilidad: 'Las decide Contabilidad',
  suite: 'Falta algo en la Suite',
  apagada: 'Listas, pero en su base la Suite todavía no genera gastos: mientras, las comprueba la sucursal en Kepler',
  sin_calcular: 'No se pudo calcular si se comprueban solas',
  ya_tiene: 'Kepler ya tiene su gasto: salen de la lista al actualizarse',
  nadie: 'No hay nada que hacer',
};

/** El título de un motivo que esta versión de la pantalla no conoce: se dice, no se esconde. */
export const TITULO_OTRO_MOTIVO = 'Con otro motivo (actualiza la página)';

/** Lo que la Suite intentó y necesita a una persona: se atoró, Kepler lo rechazó o Kepler canceló el gasto escrito. */
const FALLO = new Set(['stuck', 'rejected_by_kepler', 'cancelled']);

/**
 * ¿Lo resuelve la Suite? Lo que ya escribió o está escribiendo, o lo listo en una base donde escribe y que no falló.
 * `[PGP.123]` G.14 (D2, 2026-11-21): «listo» ya NO se escribe solo: espera el clic de «Generar gasto» de quien pidió el
 * vale o de quien aprueba. La sección se llama «Listas para generar el gasto».
 */
export function loEscribeLaSuite(g: ComprobacionEnLaCola): boolean {
  const e = g.gasto;
  if (e?.folio && e.status !== 'cancelled') return true;
  if (e?.status === 'writing') return true;
  if (e?.status && FALLO.has(e.status)) return false;
  return g.comprobacion.listo && g.escritura.abierta;
}

/** La sección de un autorizado sin gasto. `undefined` (un servidor sin G.9) o `null` (no se pudo calcular): sin calcular. */
export function grupoDelVale(g: ComprobacionEnLaCola | null | undefined): ClaveDelGrupo | 'la_suite' {
  if (!g) return 'sin_calcular';
  if (loEscribeLaSuite(g)) return 'la_suite';
  // ⛔ «En duda» fuera de una base abierta: puede que el gasto YA esté en Kepler. Capturarlo a mano lo duplicaría.
  const st = String(g.gasto?.status ?? '');
  if (FALLO.has(st) || st === 'in_doubt') return 'fallo';
  const c = g.comprobacion;
  if (c.listo) return 'apagada';
  if (c.motivo === 'sin_medir') return 'sin_calcular';
  if (c.motivo === 'ya_comprobado') return 'ya_tiene';
  return c.quien;
}

/** `[PGP.122]` ¿Nació en la Suite y Kepler todavía no tiene su solicitud? (sin folio: no se ha escrito). */
export function solicitudSinEscribir(v: Pick<ValeEsperaKepler, 'folio_solicitud' | 'nace_en_la_suite'>): boolean {
  return !!v.nace_en_la_suite && !String(v.folio_solicitud ?? '').trim();
}

/**
 * `[PGP.122]` Lo que dice el renglón de una solicitud sin escribir: la MISMA lectura que el panel del vale
 * (`lecturaKepler`), y la nota de Kepler (el motivo del rechazo) cuando la hay.
 */
export function lecturaSinEscribir(v: Pick<ValeEsperaKepler, 'nace_en_la_suite'>): { texto: string; tono: TonoDelGasto } {
  const l = lecturaKepler({ solicitud: null, estado: null, suite: null, nace_en_la_suite: v.nace_en_la_suite }, 'validada');
  const nota = String(v.nace_en_la_suite?.nota ?? '').trim();
  return { texto: nota ? l.texto + ' · ' + nota : l.texto, tono: l.tono };
}

/** `[PGP.123]` G.UI.1c — ¿Kepler canceló su solicitud? Con su gasto generado (el hallazgo de GX.96) o sin él. */
export function esCanceladaEnKepler(v: Pick<ValeEsperaKepler, 'hallazgo' | 'kepler_estado'>): boolean {
  return v.hallazgo || solicitudCanceladaEnKepler(v.kepler_estado);
}

/**
 * Las canceladas, partidas por lo que hay que averiguar: si salió dinero (con gasto) o dónde quedó el gasto (sin él).
 * `[PGP.123]` G.UI.1e: las que ya se revisaron van aparte (con quién y qué), fuera de lo pendiente.
 */
export function partirCanceladas(vs: readonly ValeEsperaKepler[]): { conGasto: ValeEsperaKepler[]; sinGasto: ValeEsperaKepler[]; revisadas: ValeEsperaKepler[] } {
  const pendientes = vs.filter((v) => !v.cancelada_revisada);
  return { conGasto: pendientes.filter((v) => v.hallazgo), sinGasto: pendientes.filter((v) => !v.hallazgo), revisadas: vs.filter((v) => !!v.cancelada_revisada) };
}

/** Reparte la cola en sus secciones. Ningún vale se pierde: cada uno cae en exactamente una. */
export function colaDeKepler(vales: readonly ValeEsperaKepler[]): ColaDeKepler {
  const c: ColaDeKepler = { sinEscribir: [], porComprobar: [], laSuite: [], conMotivo: [], porAutorizar: [], aplicadaSinLigar: [], canceladas: [], sinMedir: [] };
  const grupos = new Map<ClaveDelGrupo, ValeEsperaKepler[]>();
  for (const v of vales) {
    if (solicitudSinEscribir(v)) { c.sinEscribir.push(v); continue; }
    if (esCanceladaEnKepler(v)) { c.canceladas.push(v); continue; }
    switch (v.espera) {
      case 'falta_generar_gasto': {
        c.porComprobar.push(v);
        const k = grupoDelVale(v.gasto_kepler);
        if (k === 'la_suite') c.laSuite.push(v);
        else grupos.set(k, [...(grupos.get(k) ?? []), v]);
        break;
      }
      case 'falta_autorizar': c.porAutorizar.push(v); break;
      case 'aplicada_sin_ligar': c.aplicadaSinLigar.push(v); break;
      default: c.sinMedir.push(v);
    }
  }
  // ⛔ Un `quien` que esta pantalla no conoce (un servidor de otra versión mientras se despliega) NO hace desaparecer sus
  // vales: va al final, con un título que lo dice. «Ningún vale se pierde» vale también para lo inesperado.
  const conocidos = ORDEN_GRUPOS.filter((k) => grupos.has(k));
  const otros = [...grupos.keys()].filter((k) => !ORDEN_GRUPOS.includes(k));
  c.conMotivo = [...conocidos, ...otros].map((k) => ({ clave: k, titulo: TITULO_GRUPO[k] ?? TITULO_OTRO_MOTIVO, vales: grupos.get(k)! }));
  return c;
}

export type TonoDelGasto = 'ok' | 'neutro' | 'warn' | 'bad';

/**
 * La línea del gasto (X-A-10) de un vale, en llano (G.UI.6): lo escrito con su folio y su póliza, lo que la Suite hará,
 * o el motivo. `quien` va aparte: en la cola ya lo dice el título de la sección; el panel lo escribe al lado. El estado
 * de lo ya intentado manda sobre la regla: un gasto atorado se dice aunque hoy la regla diga «se comprueba sola».
 */
export function lineaDelGasto(g: ComprobacionEnLaCola | null | undefined): { texto: string; tono: TonoDelGasto; quien: string | null } {
  if (!g) return { texto: 'No se pudo calcular si se comprueba sola: revísalo en Kepler', tono: 'warn', quien: null };
  const e = g.gasto;
  const abierta = g.escritura.abierta;
  if (e?.folio && e.status !== 'cancelled') {
    return e.poliza
      ? { texto: `Escrito por la Suite: X-A-10 ${e.folio} · póliza ${polizaCorta(e.poliza)}`, tono: 'ok', quien: null }
      : { texto: `Ya tiene su gasto en Kepler: X-A-10 ${e.folio}`, tono: 'ok', quien: null };
  }
  // Lo que la Suite intentó y no quedó lo atiende Finanzas: decide si se reintenta (el botón está en su panel) o se
  // captura a mano. Lo que la Suite todavía no escribe lo sigue comprobando la sucursal, como hoy.
  const persona = QUIEN_RESUELVE_TEXTO.finanzas;
  // `[PGP.123]` G-AUD.14 (2026-11-23): la nota del servidor mandaba a «Reintentar el gasto», un botón que no existe; y un
  // gasto que alguien canceló a propósito no se vuelve a escribir de primera. Se dice qué pasó y cuál es el botón.
  if (e?.status === 'cancelled') return { texto: textoCancelado(e.nota), tono: 'bad', quien: persona };
  if (e?.status === 'stuck' || e?.status === 'rejected_by_kepler') return { texto: `No se pudo escribir: ${e.nota || 'sin motivo'}`, tono: 'bad', quien: persona };
  if (e?.status === 'writing') return { texto: 'Escribiéndose en Kepler', tono: 'neutro', quien: null };
  if (e?.status === 'in_doubt') {
    return abierta && g.comprobacion.listo
      ? { texto: 'En duda: la Suite lo busca en Kepler antes de volver a intentar', tono: 'warn', quien: null }
      : { texto: 'En duda: puede que ya esté en Kepler; búscalo antes de capturarlo', tono: 'warn', quien: persona };
  }
  if (g.comprobacion.listo) {
    if (!abierta) return { texto: `Lista para generar, pero ${minuscula(g.escritura.motivo ?? 'la escritura de gastos está apagada en esta base')}`, tono: 'neutro', quien: QUIEN_RESUELVE_TEXTO.sucursal };
    // G.14 (D2): nada lo escribe solo; lo genera una persona con un clic.
    if (e?.status === 'retry') return { texto: `No quedó: ${e.nota || 'el intento anterior no quedó'}. Genéralo otra vez`, tono: 'warn', quien: null };
    return { texto: 'Listo para generar su gasto en Kepler con un clic', tono: 'neutro', quien: null };
  }
  const quien = g.comprobacion.quien === 'nadie' ? null : (QUIEN_RESUELVE_TEXTO[g.comprobacion.quien] ?? null);
  return { texto: g.comprobacion.texto, tono: 'neutro', quien };
}

/** `kdc22611/D/4` → `D 4 (nov 2026)`, como se busca en Kepler. Si no tiene la forma esperada, tal cual (no se inventa). */
export function polizaCorta(p: string): string {
  const m = /^kdc2(\d{2})(\d{2})\/D\/(\d+)$/.exec(p);
  if (!m) return p;
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `D ${m[3]} (${MESES[Number(m[2]) - 1] ?? m[2]} 20${m[1]})`;
}

function minuscula(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * ¿Tiene sentido ofrecer «Escribir el gasto» en el panel? Sólo si la Suite lo escribiría (listo, base abierta) y no hay
 * un gasto escrito o escribiéndose: en otro caso el botón sólo devolvería el mismo motivo que ya se lee.
 */
export function puedeEscribirseYa(g: ComprobacionEnLaCola | null | undefined): boolean {
  if (!g || !g.comprobacion.listo || !g.escritura.abierta) return false;
  const e = g.gasto;
  if (e?.folio && e.status !== 'cancelled') return false;
  // G-AUD.14: lo que Kepler canceló no se ofrece de primera (ver `pideGenerarOtraVez`).
  return !['writing', 'written', 'seen_in_ods', 'cancelled'].includes(String(e?.status ?? ''));
}

/**
 * `[PGP.123]` G-AUD.14 (2026-11-23) — ¿Se ofrece «Generar otra vez»? Cuando Kepler canceló el gasto que la Suite había
 * escrito y hoy se escribiría de nuevo. No es el acto principal: alguien lo canceló, quizá a propósito. El botón pide
 * confirmar antes de escribir (medido: los tres gastos de prueba que Edgar canceló salían arriba de la cola con «Generar
 * gasto» en rojo, a un clic de reescribirse).
 */
export function pideGenerarOtraVez(g: ComprobacionEnLaCola | null | undefined): boolean {
  if (!g || !g.escritura.abierta || g.gasto?.status !== 'cancelled') return false;
  return g.comprobacion.listo || g.comprobacion.motivo === 'lectura_distinta';
}

/** La nota de un gasto cancelado, sin el botón viejo que nombraba («Reintentar el gasto»), y con el que existe. */
export function textoCancelado(nota: string | null | undefined): string {
  // G-RED.1: la nota del servidor trae la póliza como se guarda (`kdc22611/D/371`); se dice como se busca en Kepler.
  // G-RED.1b: dentro de un paréntesis, el mes va tras una coma («(póliza D 371, nov 2026)»), no en otro paréntesis.
  const base = String(nota ?? '').replace(/:\s*el vale vuelve a esperar su gasto.*$/s, '').trim()
    .replace(/\(póliza (kdc2\d{4}\/D\/\d+)\)/g, (_m, p: string) => `(póliza ${polizaCorta(p).replace(/ \((.+)\)$/, ', $1')})`)
    .replace(/kdc2\d{4}\/D\/\d+/g, (p) => polizaCorta(p)) || 'Kepler canceló su gasto';
  return `${base}. No se vuelve a escribir solo: si fue un error, «Generar otra vez»`;
}

/**
 * `[PGP.123]` G.16 — ¿Se ofrece «Ya lo comparé · Generar»? Sólo cuando lo ÚNICO que frena es la lectura del comprobante
 * (DG12: dice otro monto que la solicitud), en una base que escribe y sin gasto escrito o escribiéndose. Si además fallara
 * otra condición, el servidor la diría al generar.
 */
export function pideComparar(g: ComprobacionEnLaCola | null | undefined): boolean {
  if (!g || g.comprobacion.listo || g.comprobacion.motivo !== 'lectura_distinta' || !g.escritura.abierta) return false;
  const e = g.gasto;
  if (e?.folio && e.status !== 'cancelled') return false;
  return !['writing', 'written', 'seen_in_ods', 'cancelled'].includes(String(e?.status ?? ''));
}

/**
 * G.UI.8 — Quién, por su nombre. El padrón manda; sin nombre, la clave. Un actor del sistema («cierre GX.82 (aprobado
 * con cotización)») se dice sin el código del tracker: «el cierre automático (aprobado con cotización)».
 */
export function quienTexto(nombre: string | null | undefined, usuario: string | null | undefined): string {
  const n = String(nombre ?? '').trim();
  if (n) return n;
  const u = String(usuario ?? '').trim();
  if (!u) return '—';
  if (/\b[A-Z]{1,4}\.\d+(\.\d+)?\b/.test(u)) {
    const limpio = u.replace(/\s*\b[A-Z]{1,4}\.\d+(\.\d+)?\b\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return limpio.startsWith('cierre') ? `el ${limpio.replace(/^cierre/, 'cierre automático')}` : limpio;
  }
  return u;
}
