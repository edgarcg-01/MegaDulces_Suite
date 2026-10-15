/**
 * `[VTK.10]` Una FOTO de un dato caro, servida al momento y recargada detrás
 * (stale-while-revalidate), con UNA sola recarga a la vez por clave.
 *
 * Nació privada en `existencia.service.ts` (`[EX-PERF.3]`) y se sube acá al volver a
 * necesitarse en el catálogo del vendedor: un primitivo copiado a mano se separa de su
 * original en silencio (ADR-056). Política:
 *   - foto con menos de `recargarMs`  → se sirve tal cual;
 *   - entre `recargarMs` y `venceMs`  → se sirve y se recarga en segundo plano;
 *   - más vieja, o no hay             → se espera la recarga.
 *
 * Un error en segundo plano NO tumba a quien pidió: se sirve la foto que había y se avisa
 * por `alFallar`. Vencida, el error sí sube (no se publica un dato de edad indefinida).
 *
 * ⛔ La edad viaja con el valor (`at`): quien publique el dato la declara. Una foto de hace un
 * minuto no se rotula como si fuera de este segundo.
 */
export interface Foto<T> {
  /** Epoch ms en que se armó. */
  at: number;
  valor: T;
}

export interface FotoSwrOpciones {
  recargarMs: number;
  venceMs: number;
  /** Reloj inyectable (pruebas). */
  ahora?: () => number;
  /** Aviso de una recarga en segundo plano que falló. */
  alFallar?: (clave: string, error: unknown) => void;
}

export class FotoSwr<T> {
  private readonly fotos = new Map<string, Foto<T>>();
  private readonly recargas = new Map<string, Promise<Foto<T>>>();
  private readonly ahora: () => number;

  constructor(private readonly opts: FotoSwrOpciones) {
    if (!(opts.recargarMs > 0) || !(opts.venceMs >= opts.recargarMs)) {
      throw new Error('FotoSwr: se necesita 0 < recargarMs <= venceMs');
    }
    this.ahora = opts.ahora ?? (() => Date.now());
  }

  /** La foto de `clave`; `armar` sólo corre cuando hace falta recargar. */
  async obtener(clave: string, armar: () => Promise<T>): Promise<Foto<T>> {
    const f = this.fotos.get(clave);
    const edad = f ? this.ahora() - f.at : Infinity;
    if (f && edad < this.opts.recargarMs) return f;
    if (f && edad < this.opts.venceMs) {
      this.recargar(clave, armar).catch((e) => this.opts.alFallar?.(clave, e));
      return f;
    }
    return this.recargar(clave, armar);
  }

  /** Tira la foto (una clave, o todas). */
  olvidar(clave?: string): void {
    if (clave === undefined) this.fotos.clear();
    else this.fotos.delete(clave);
  }

  private recargar(clave: string, armar: () => Promise<T>): Promise<Foto<T>> {
    const enCurso = this.recargas.get(clave);
    if (enCurso) return enCurso;
    const p = armar()
      .then((valor) => {
        const foto = { at: this.ahora(), valor };
        this.fotos.set(clave, foto);
        return foto;
      })
      .finally(() => this.recargas.delete(clave));
    this.recargas.set(clave, p);
    return p;
  }
}
