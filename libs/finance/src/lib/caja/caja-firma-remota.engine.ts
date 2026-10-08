import { type ContextoFirma, FIRMA_VIDA_MS, firmaSigueValiendo } from '@megadulces/contracts';

// El contrato de la firma vive en libs/contracts: lo necesitan el servidor Y la pantalla, y
// apps/view no puede importar libs/finance (es backend). Se reexporta para que quien ya usa el
// motor no tenga que saber de esa frontera.
export { firmaSigueValiendo };
export type { ContextoFirma };

/** Cuánto vale un código desde que la PC lo pidió. */
export const VIDA_MS = FIRMA_VIDA_MS;

/**
 * `[CG.68]` **El teléfono del mostrador firma lo que la PC está capturando.** Puro, sin sockets.
 *
 * Edgar: *"si esto lo estoy usando en pc, ¿cómo hago que esto se envíe a mi teléfono para que se
 * firme?"*. Un EMPAREJAMIENTO: la caja muestra un código, el teléfono lo escribe, y a partir de
 * ahí los dos hablan por un canal que es **suyo**.
 *
 * ── ⛔ Por qué no alcanza el canal que ya existe ─────────────────────────────────────────────
 *
 * `CajaGateway` ya tiene lo difícil: autentica por JWT en el handshake, exige permiso de Caja
 * General y agrupa por tenant. Le faltan dos cosas, y la segunda es la que importa:
 *
 *   1. **Sólo emite.** Cero `@SubscribeMessage`: no había forma de que un cliente le mandara nada.
 *   2. ⛔ **Sus rooms son POR TENANT.** Una firma emitida ahí llegaría a **todas las cajas
 *      abiertas de la empresa**. Con dos cajeros capturando a la vez, la firma de uno aparece en
 *      la pantalla del otro — y es evidencia de quién recibió efectivo.
 *
 * ── ⛔⛔ LA REESCRITURA, Y POR QUÉ: PRODUCCIÓN TIENE **DOS** RÉPLICAS ────────────────────────
 *
 * La primera versión de este archivo guardaba los emparejamientos en un `Map` del proceso, y lo
 * justificaba con *"producción corre UN solo `prod-api`"* — **citando el runbook de despliegue**.
 *
 * **Medido contra producción el 2026-10-08: era falso.** Prod ya no corre en Docker Compose sino
 * en **k3s**, namespace `prod`, y `kubectl get deploy` decía **`api 2/2`** desde hacía casi siete
 * días. Con dos pods, el `Map` rompe así:
 *
 *     La PC pide el código → cae en el pod A, que lo guarda en SU memoria.
 *     El teléfono lo teclea → cae en el pod B, que no sabe nada → responde `no_existe`.
 *
 * O sea **roto ~la mitad de las veces, al azar**. ⭐ El runbook estaba rancio y yo lo cité como
 * si fuera una medición: *leer dónde dice un documento que corre algo no es medir dónde corre.*
 *
 * ── ⭐ El arreglo no fue mover el `Map` a Redis: fue NO TENER ESTADO PROPIO ──────────────────
 *
 * El emparejamiento vive donde ya estaba compartido: en las **rooms de Socket.IO**. El adaptador
 * de Redis —verificado ACTIVO en el log del pod de prod— comparte la membresía de las rooms y el
 * `data` de cada socket entre pods, así que `fetchSockets()` ve a la PC esté en el pod que esté.
 *
 * Lo que queda del lado del servidor es una DECISIÓN pura, y es lo que vive acá: dada la foto de
 * los sockets de esa room, ¿se puede reclamar? ¿se puede entregar? Sin mapa, sin TTL que
 * administrar, sin nada que purgar — y correcto con N pods, no con uno.
 *
 * ⚠️ Lo que se pierde, dicho: si el adaptador de Redis se cayera, el emparejamiento volvería a
 * ser por pod. **No falla en silencio** — `fetchSockets()` devolvería sólo los locales y el
 * teléfono vería `no_existe`, el mismo mensaje honesto de un código mal tecleado.
 *
 * ── Las decisiones que sobrevivieron a la reescritura ────────────────────────────────────────
 *
 * · **Código de un solo uso.** Si siguiera vivo, un segundo teléfono entraría a la misma room y
 *   vería el contexto del efectivo.
 * · **Vida corta** (`VIDA_MS`). Un código que quedó en la pantalla no puede servir una hora
 *   después, cuando la persona que lo vio ya se fue.
 * · **Alfabeto sin ambigüedad**: sin `0/O`, sin `1/I/L`. Se teclea leyendo de otra pantalla, a
 *   veces de lejos; un `0` leído como `O` es un código que "no funciona" sin motivo.
 * · **El contexto que viaja al teléfono es el MÍNIMO.** El teléfono se le pasa a otras personas
 *   para que firmen: es una superficie para firmar, no una segunda pantalla de caja.
 * · ⭐ **La firma queda atada al MONTO que se mostró** (`firmaSigueValiendo`). Si el cajero cambia
 *   el importe después de que el teléfono firmó, la firma dejó de corresponder — y sin esto la
 *   pantalla seguiría diciendo "firmado" sobre otra cifra.
 */

/** Sin `0/O` ni `1/I/L`: se teclea leyendo de otra pantalla. */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LARGO = 6;

/** Lo que la PC deja en SU socket. Es el único lugar donde vive el emparejamiento. */
export interface MarcaPc {
  readonly codigo: string;
  readonly ctx: ContextoFirma;
  readonly creado: number;
}

/** La foto de un socket de la room, sin socket.io: sólo lo que la decisión necesita. */
export interface SocketEnRoom {
  readonly id: string;
  readonly tenantId: string | null;
  /** Puesta si este socket es la PC que abrió el emparejamiento. */
  readonly pc?: MarcaPc | null;
  /** Puesto si este socket es el teléfono que ya reclamó ese código. */
  readonly telefono?: string | null;
}

export type FalloVinculo =
  | 'no_existe' | 'vencido' | 'otro_tenant' | 'ya_tomado' | 'no_es_suyo' | 'sin_pc';

export interface Resultado<T> {
  readonly ok: boolean;
  readonly v?: T;
  readonly fallo?: FalloVinculo;
}

const ok = <T>(v: T): Resultado<T> => ({ ok: true, v });
const no = <T>(fallo: FalloVinculo): Resultado<T> => ({ ok: false, fallo });

/**
 * Genera un código. `azar` se inyecta para que la prueba no dependa del azar — una prueba que
 * sortea no prueba lo mismo dos veces.
 */
export function nuevoCodigo(azar: () => number = Math.random): string {
  let c = '';
  for (let i = 0; i < LARGO; i++) {
    const k = Math.floor(azar() * ALFABETO.length) % ALFABETO.length;
    c += ALFABETO[k];
  }
  return c;
}

/** Lo tecleado llega como venga: mayúsculas y sin separadores. */
export function normalizarCodigo(c: string | null | undefined): string {
  return String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * La room por la que viaja el PNG. Es de **dos**, nunca la del tenant.
 *
 * ⚠️ El tenant va EN EL NOMBRE y además se compara en cada decisión: el código es un
 * identificador global, y sin la comparación bastaría acertar seis caracteres para mirar el
 * efectivo de otra empresa.
 */
export function roomDeFirma(tenantId: string, codigo: string): string {
  return `firma:${tenantId}:${normalizarCodigo(codigo)}`;
}

/**
 * ¿El teléfono puede reclamar este código? Decide con la foto de la room.
 *
 * `socks` es lo que `fetchSockets()` devolvió para esa room — con el adaptador de Redis, de
 * **todos** los pods.
 */
export function decidirTomar(
  socks: readonly SocketEnRoom[],
  codigo: string,
  tenantId: string,
  ahora: number,
): Resultado<MarcaPc> {
  const cod = normalizarCodigo(codigo);
  const pc = socks.find((s) => s.pc?.codigo === cod);
  // Sin PC esperando, el código no existe: o se tecleó mal, o la caja ya lo cerró.
  if (!pc?.pc) return no('no_existe');
  // ⛔ El vencimiento se reporta APARTE: «vencido» y «mal tecleado» son dos hechos y la persona
  // necesita oír cosas distintas — «pedí uno nuevo» contra «revisá lo que escribiste». La
  // primera versión los colapsaba en uno porque purgaba antes de buscar, y lo encontró su
  // propia prueba.
  if (ahora - pc.pc.creado > VIDA_MS) return no('vencido');
  if (pc.tenantId !== tenantId) return no('otro_tenant');
  // Un solo uso: si ya hay un teléfono en la room, el segundo no entra.
  if (socks.some((s) => s.telefono === cod)) return no('ya_tomado');
  return ok(pc.pc);
}

/** ¿Este teléfono puede entregar la firma? Sólo el que reclamó, y sólo si la PC sigue ahí. */
export function decidirEntregar(
  socks: readonly SocketEnRoom[],
  codigo: string,
  tenantId: string,
  quien: string,
  ahora: number,
): Resultado<MarcaPc> {
  const cod = normalizarCodigo(codigo);
  const yo = socks.find((s) => s.id === quien);
  if (yo?.telefono !== cod) return no('no_es_suyo');
  const pc = socks.find((s) => s.pc?.codigo === cod);
  // ⚠️ Se distingue de `no_existe`: acá el teléfono hizo todo bien y la caja se fue. Decirle
  // «ese código no existe» lo mandaría a revisar lo que tecleó, que está perfecto.
  if (!pc?.pc) return no('sin_pc');
  if (ahora - pc.pc.creado > VIDA_MS) return no('vencido');
  if (pc.tenantId !== tenantId) return no('otro_tenant');
  return ok(pc.pc);
}
