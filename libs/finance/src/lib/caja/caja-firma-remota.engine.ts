/**
 * `[CG.68]` **El teléfono del mostrador firma lo que la PC está capturando.** Puro, sin sockets.
 *
 * Edgar: *"si esto lo estoy usando en pc, ¿cómo hago que esto se envíe a mi teléfono para que se
 * firme?"*. La respuesta es un EMPAREJAMIENTO: la PC muestra un código, el teléfono lo escribe,
 * y a partir de ahí los dos hablan en un canal que es **suyo**.
 *
 * ── ⛔ Por qué no alcanza el canal que ya existe ─────────────────────────────────────────────
 *
 * `CajaGateway` ya tiene lo difícil: autentica por JWT en el handshake, exige permiso de Caja
 * General y agrupa por tenant. Le faltan dos cosas, y la segunda es la que importa:
 *
 *   1. **Sólo emite.** Cero `@SubscribeMessage`: no hay forma de que un cliente le mande nada.
 *   2. ⛔ **Sus rooms son POR TENANT.** Una firma emitida ahí llegaría a **todas las cajas
 *      abiertas de la empresa**. Con dos cajeros capturando a la vez, la firma de uno aparece en
 *      la pantalla del otro — y es evidencia de quién recibió efectivo. El emparejamiento existe
 *      para que el PNG viaje por una room de DOS, no por la del tenant.
 *
 * ── Las decisiones, y lo que cada una evita ──────────────────────────────────────────────────
 *
 * · **Código de un solo uso.** En cuanto un teléfono lo reclama, muere. Si siguiera vivo, un
 *   segundo teléfono entraría a la misma room y vería el contexto del efectivo.
 * · **Vida corta** (`VIDA_MS`). Un código que quedó en la pantalla no puede servir una hora
 *   después, cuando la persona que lo vio ya se fue.
 * · **Alfabeto sin ambigüedad**: sin `0/O`, sin `1/I/L`. Quien lo teclea lo está leyendo de otra
 *   pantalla, a veces de lejos; un `0` leído como `O` es un código que "no funciona" sin motivo.
 * · **El contexto que viaja al teléfono es el MÍNIMO** (tipo, monto, beneficiario). El teléfono
 *   es una superficie para firmar, no una segunda pantalla de caja.
 * · ⭐ **La firma queda atada al MONTO que se mostró.** Si el cajero cambia el importe después de
 *   que el teléfono firmó, la firma dejó de corresponder — y sin esto nadie se enteraría: la
 *   pantalla seguiría diciendo "firmado" sobre otra cifra.
 *
 * ── ⚠️ Límite declarado: el estado vive EN MEMORIA ───────────────────────────────────────────
 *
 * Es deliberado y alcanza hoy: producción corre **un solo** `prod-api` (RUNBOOK de despliegue), y
 * un código de 3 minutos no merece una tabla. ⛔ Pero si alguna vez la API escala a dos réplicas,
 * el emparejamiento **se rompe en silencio**: la PC y el teléfono caen en procesos distintos y el
 * código "no existe". El arreglo tiene nombre y ya está en el stack: mover este mapa a Redis.
 */

import { type ContextoFirma, FIRMA_VIDA_MS, firmaSigueValiendo } from '@megadulces/contracts';

// El contrato de la firma vive en libs/contracts: lo necesitan el servidor Y la pantalla, y
// apps/view no puede importar libs/finance (es backend). Se reexporta para que quien ya usa el
// motor no tenga que saber de esa frontera.
export { firmaSigueValiendo };
export type { ContextoFirma };

/** Cuanto vive un codigo sin reclamar, y cuanto vive el vinculo ya reclamado. */
export const VIDA_MS = FIRMA_VIDA_MS;

/** Sin `0/O` ni `1/I/L`: se teclea leyendo de otra pantalla. */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LARGO = 6;



export interface Vinculo {
  readonly codigo: string;
  readonly tenantId: string;
  /** El socket de la PC que pidió la firma. */
  readonly pc: string;
  /** El socket del teléfono, una vez que reclamó. `null` mientras nadie reclamó. */
  telefono: string | null;
  readonly ctx: ContextoFirma;
  readonly creado: number;
  /** Quién abrió el vínculo, para el registro. */
  readonly porUsuario: string | null;
}

export type FalloVinculo = 'no_existe' | 'vencido' | 'otro_tenant' | 'ya_tomado' | 'no_es_suyo';

export interface Resultado<T> {
  readonly ok: boolean;
  readonly v?: T;
  readonly fallo?: FalloVinculo;
}

const ok = <T>(v: T): Resultado<T> => ({ ok: true, v });
const no = <T>(fallo: FalloVinculo): Resultado<T> => ({ ok: false, fallo });

/**
 * Genera un código. `azar` se inyecta para que la prueba no dependa del azar — una prueba que
 * sortea no prueba nada dos veces igual.
 */
export function nuevoCodigo(azar: () => number = Math.random): string {
  let c = '';
  for (let i = 0; i < LARGO; i++) {
    const k = Math.floor(azar() * ALFABETO.length) % ALFABETO.length;
    c += ALFABETO[k];
  }
  return c;
}

/**
 * El registro de vínculos vivos. Sin sockets y sin reloj propio: los dos se inyectan, así que
 * la prueba puede adelantar el tiempo sin esperarlo.
 */
export class VinculosFirma {
  private readonly porCodigo = new Map<string, Vinculo>();

  constructor(
    private readonly ahora: () => number = () => Date.now(),
    private readonly azar: () => number = Math.random,
  ) {}

  /** Abre un vínculo para la PC y devuelve su código. */
  abrir(tenantId: string, pc: string, ctx: ContextoFirma, porUsuario: string | null = null): Vinculo {
    this.purgar();
    // ⚠️ Se reintenta si el código ya está tomado. Con 31^6 (~887 millones) y vida de 3 min la
    // colisión es anecdótica, pero "anecdótico" no es "imposible", y una colisión silenciosa
    // mandaría la firma de una caja a la otra — que es exactamente lo que esto vino a evitar.
    let codigo = nuevoCodigo(this.azar);
    for (let i = 0; i < 8 && this.porCodigo.has(codigo); i++) codigo = nuevoCodigo(this.azar);
    if (this.porCodigo.has(codigo)) throw new Error('no se pudo generar un código libre');

    const v: Vinculo = {
      codigo, tenantId, pc, telefono: null, ctx, creado: this.ahora(), porUsuario,
    };
    this.porCodigo.set(codigo, v);
    return v;
  }

  /**
   * El teléfono reclama el código. Un solo uso: el segundo intento falla con `ya_tomado`.
   *
   * ⚠️ Se compara el tenant: un código de otra empresa no se puede reclamar ni por casualidad.
   * El JWT ya separa los tenants, pero el código es un identificador global y sin esta
   * comparación bastaría acertar seis caracteres para mirar el efectivo de otro.
   */
  reclamar(codigo: string, tenantId: string, telefono: string): Resultado<Vinculo> {
    // ⛔ ACÁ HABÍA UN `purgar()` Y LO ENCONTRÓ SU PROPIA PRUEBA: purgando antes de buscar, el
    // vínculo vencido ya no estaba y el fallo salía `no_existe`. Son DOS hechos distintos y la
    // persona necesita oír cosas distintas — «revisá el código» contra «pedí uno nuevo». Es la
    // misma falla de forma que ADR-056 persigue: dos ausencias colapsadas en una.
    // La memoria se acota al ABRIR, que es cuando crece.
    const v = this.porCodigo.get(this.normalizar(codigo));
    if (!v) return no('no_existe');
    if (this.vencido(v)) { this.porCodigo.delete(v.codigo); return no('vencido'); }
    if (v.tenantId !== tenantId) return no('otro_tenant');
    if (v.telefono) return no('ya_tomado');
    v.telefono = telefono;
    return ok(v);
  }

  /** El teléfono entrega la firma. Sólo el teléfono que reclamó puede entregar. */
  entregar(codigo: string, tenantId: string, telefono: string): Resultado<Vinculo> {
    // Mismo motivo que en reclamar: buscar ANTES de purgar, o "vencido" se disfraza de
    // "no existe".
    const v = this.porCodigo.get(this.normalizar(codigo));
    if (!v) return no('no_existe');
    if (this.vencido(v)) { this.porCodigo.delete(v.codigo); return no('vencido'); }
    if (v.tenantId !== tenantId) return no('otro_tenant');
    if (v.telefono !== telefono) return no('no_es_suyo');
    // Se cierra al entregar: una firma por vínculo. Si quedara abierto, el mismo teléfono podría
    // mandar una segunda firma y pisar la primera sin que nadie lo pidiera.
    this.porCodigo.delete(v.codigo);
    return ok(v);
  }

  /** El vínculo de un socket que se cayó. Cierra los dos lados: no sirve uno solo. */
  soltarSocket(socketId: string): Vinculo[] {
    const caidos: Vinculo[] = [];
    for (const v of [...this.porCodigo.values()]) {
      if (v.pc === socketId || v.telefono === socketId) {
        this.porCodigo.delete(v.codigo);
        caidos.push(v);
      }
    }
    return caidos;
  }

  /** La room por la que viaja el PNG. Es de DOS, nunca la del tenant. */
  room(v: Pick<Vinculo, 'tenantId' | 'codigo'>): string {
    return `firma:${v.tenantId}:${v.codigo}`;
  }

  vivos(): number { this.purgar(); return this.porCodigo.size; }

  /** Lo tecleado llega como venga: mayúsculas y sin espacios. */
  private normalizar(c: string): string {
    return String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  private vencido(v: Vinculo): boolean { return this.ahora() - v.creado > VIDA_MS; }

  private purgar(): void {
    for (const v of [...this.porCodigo.values()]) {
      if (this.vencido(v)) this.porCodigo.delete(v.codigo);
    }
  }
}

