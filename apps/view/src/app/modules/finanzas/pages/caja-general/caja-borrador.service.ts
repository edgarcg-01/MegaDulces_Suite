import { Injectable } from '@angular/core';

/**
 * Borrador local de la bandeja de caja — **lo marcado sobrevive a un F5**.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido el 2026-09-22 en `/finanzas/caja-general`: la pantalla NO persistía nada. `contado` y
 * `seleccion` eran señales en memoria, así que un refresh accidental —o que el navegador mate la
 * pestaña— borraba todo lo tecleado. Con 12,207 movimientos pendientes y hasta 100 filas por
 * pantalla, eso es mucho trabajo tirado por una tecla.
 *
 * ⚠️ `[CG.48]` Nació guardando DOS cosas, lo contado y lo marcado. La columna "Contado" de la
 * bandeja se retiró (era la única vía de meter una cifra contada al libro sin desglose), así que
 * hoy guarda sólo la selección. El campo `contado` queda como legado de sólo lectura.
 *
 * ── Qué se guarda y qué NO ──────────────────────────────────────────────────────────────────
 * Sólo **lo marcado**: es intención de la persona y no existe en ningún otro lado
 * todavía. El movimiento en sí NO se copia — vive en Kepler y en el matview, y
 * duplicarlo acá crearía una segunda verdad que se desfasa en cuanto otra persona confirma desde
 * otro equipo. Es la misma regla que ya aplica el borrador del Andén.
 *
 * ── La clave lleva el USUARIO, y no es un detalle ───────────────────────────────────────────
 * `localStorage` es por origen, no por persona. En una sucursal el mismo navegador lo usan varios
 * cajeros: sin el usuario en la clave, el conteo de uno reaparecería en la pantalla del otro —
 * y en una bandeja de efectivo eso no es un bug de comodidad, es un conteo ajeno firmado con tu
 * nombre.
 *
 * ── TTL corto, a propósito ──────────────────────────────────────────────────────────────────
 * 12 horas: un arqueo es trabajo de un turno. Un borrador de anteayer describe un conteo que ya
 * no se puede defender, y re-aplicarlo en silencio sería peor que perderlo.
 */

const PREFIJO = 'caja.borrador.';
/** Un arqueo es trabajo de un turno; más viejo que eso ya no se sostiene. */
const TTL_MS = 12 * 60 * 60 * 1000;

export interface BorradorCaja {
  usuario: string;
  guardadoEn: number;
  /**
   * ⛔ `[CG.48]` LEGADO, sólo lectura. Eran los conteos por renglón de la columna "Contado" de
   * la bandeja, que se retiró: el lote espeja al ERP y contar lleva desglose. Ya no se escribe.
   * Se sigue leyendo para poder DECIRLE a quien tenga un borrador de antes que esos conteos no
   * se revivieron — con TTL de 12 h el campo desaparece solo.
   */
  contado?: Array<[string, number]>;
  marcadas: string[];
}

@Injectable({ providedIn: 'root' })
export class CajaBorradorService {
  private clave(usuario: string): string {
    return PREFIJO + usuario;
  }

  /**
   * **Nunca lanza.** Si el storage está lleno, bloqueado o el navegador va en modo privado, la
   * bandeja tiene que seguir funcionando: el borrador es una red, no una dependencia.
   */
  guardar(usuario: string, marcadas: Set<string>): boolean {
    if (!usuario) return false;
    try {
      // Un borrador vacío no se guarda: dejaría una entrada muerta que después hay que barrer.
      if (!marcadas.size) { this.borrar(usuario); return true; }
      // `contado` NO se escribe: la columna que lo alimentaba se retiró en `[CG.48]`.
      const b: BorradorCaja = {
        usuario, guardadoEn: Date.now(), marcadas: [...marcadas],
      };
      localStorage.setItem(this.clave(usuario), JSON.stringify(b));
      return true;
    } catch {
      return false;
    }
  }

  /** Devuelve `null` si no hay, si venció, si es de otra persona o si quedó corrupto. */
  leer(usuario: string): BorradorCaja | null {
    if (!usuario) return null;
    try {
      const raw = localStorage.getItem(this.clave(usuario));
      if (!raw) return null;
      const b = JSON.parse(raw) as BorradorCaja;
      // Defensivo: un borrador corrupto no puede tumbar una pantalla de caja.
      if (!b || typeof b !== 'object' || b.usuario !== usuario) return null;
      // ⛔ `[CG.48]` Acá se exigía que `contado` FUERA un array, y al dejar de escribirlo eso
      // habría rechazado **todos** los borradores nuevos — la red se caía justo al quitarle una
      // pata, y en silencio: `leer()` devuelve `null` igual que cuando no hay nada guardado.
      // Lo obligatorio es `marcadas`; `contado` se tolera ausente (nuevo) o presente (legado).
      if (!Array.isArray(b.marcadas)) return null;
      if (b.contado !== undefined && !Array.isArray(b.contado)) return null;
      if (Date.now() - (b.guardadoEn || 0) > TTL_MS) { this.borrar(usuario); return null; }
      return b;
    } catch {
      return null;
    }
  }

  borrar(usuario: string): void {
    try { localStorage.removeItem(this.clave(usuario)); } catch { /* sin storage no hay nada que borrar */ }
  }
}
