import { Injectable } from '@angular/core';

/**
 * Borrador local de la bandeja de caja — **lo contado sobrevive a un F5**.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido el 2026-09-22 en `/finanzas/caja-general`: la pantalla NO persistía nada. `contado` y
 * `seleccion` eran señales en memoria, así que un refresh accidental —o que el navegador mate la
 * pestaña— borraba todo lo tecleado. Con 12,207 movimientos pendientes y hasta 100 filas por
 * pantalla, eso es mucho trabajo de conteo tirado por una tecla.
 *
 * ── Qué se guarda y qué NO ──────────────────────────────────────────────────────────────────
 * Sólo **lo contado** y **lo marcado**: los dos son intención de la persona y no existen en
 * ningún otro lado todavía. El movimiento en sí NO se copia — vive en Kepler y en el matview, y
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
  /** `origen_ref` → lo que se contó. Pares y no objeto: los `origen_ref` llevan `|`. */
  contado: Array<[string, number]>;
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
  guardar(usuario: string, contado: Map<string, number | null>, marcadas: Set<string>): boolean {
    if (!usuario) return false;
    try {
      const pares: Array<[string, number]> = [];
      for (const [ref, v] of contado) if (v != null && Number(v) > 0) pares.push([ref, Number(v)]);
      // Un borrador vacío no se guarda: dejaría una entrada muerta que después hay que barrer.
      if (!pares.length && !marcadas.size) { this.borrar(usuario); return true; }
      const b: BorradorCaja = {
        usuario, guardadoEn: Date.now(), contado: pares, marcadas: [...marcadas],
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
      if (!Array.isArray(b.contado) || !Array.isArray(b.marcadas)) return null;
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
