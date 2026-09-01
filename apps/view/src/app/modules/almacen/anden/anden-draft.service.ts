import { Injectable } from '@angular/core';
import { AndenBorrador } from './anden.state';

/**
 * Borrador local del Andén — **el vale sobrevive a que la app muera**.
 *
 * Un handheld se queda sin batería, entra una llamada, Android mata la app en
 * segundo plano. Hoy eso significa volver a empezar el cotejo con el camión
 * enfrente. Acá cada cambio se persiste al instante, con clave por `session_id`.
 *
 * **Sobre el almacenamiento:** en web es `localStorage`. En Capacitor lo correcto
 * es `Preferences` (nativo, sobrevive a que el sistema limpie el WebView), y por
 * eso el guardado es `async` aunque hoy la implementación sea síncrona: cambiar
 * el backend no obliga a tocar a los llamadores. Ver `ANDEN_DRAFT_NATIVE` abajo.
 *
 * **Qué se guarda y qué no.** Sólo lo que no se puede re-derivar del server: el
 * conteo, lo acomodado, la sección activa y los `scan_uuid` ya enviados. El
 * detalle del vale se vuelve a pedir, porque el server manda.
 *
 * **`scan_uuid`:** cada escaneo lleva el suyo. Al recuperar, reenviar lo que
 * quedó a medias es idempotente y no duplica cantidades. Es el mismo patrón que
 * el conteo físico resolvió con `inventory_count_scan_log`.
 */

const PREFIJO = 'anden.borrador.';
/** Un borrador viejo describe un camión que ya se fue. */
const TTL_MS = 72 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class AndenDraftService {
  private clave(sessionId: string): string {
    return PREFIJO + sessionId;
  }

  /**
   * Guarda el borrador. **Nunca lanza**: si el storage está lleno o el navegador
   * está en modo privado, la pantalla tiene que seguir funcionando — el borrador
   * es una red de seguridad, no una dependencia.
   */
  async guardar(b: AndenBorrador): Promise<boolean> {
    try {
      localStorage.setItem(this.clave(b.sessionId), JSON.stringify(b));
      return true;
    } catch {
      return false;
    }
  }

  async leer(sessionId: string): Promise<AndenBorrador | null> {
    try {
      const raw = localStorage.getItem(this.clave(sessionId));
      if (!raw) return null;
      const b = JSON.parse(raw) as AndenBorrador;
      if (!b || typeof b !== 'object' || b.sessionId !== sessionId) return null;
      if (Date.now() - (b.guardadoEn || 0) > TTL_MS) {
        await this.borrar(sessionId);
        return null;
      }
      // Defensivo: un borrador corrupto no puede tumbar la pantalla de un andén.
      b.contado = b.contado && typeof b.contado === 'object' ? b.contado : {};
      b.ubicado = b.ubicado && typeof b.ubicado === 'object' ? b.ubicado : {};
      b.scans = Array.isArray(b.scans) ? b.scans : [];
      return b;
    } catch {
      return null;
    }
  }

  async borrar(sessionId: string): Promise<void> {
    try {
      localStorage.removeItem(this.clave(sessionId));
    } catch {
      /* nada que hacer: el borrador es best-effort */
    }
  }

  /**
   * El vale que quedó abierto en este equipo, si lo hay. Es lo que permite que el
   * bodeguero vuelva a entrar y siga donde estaba sin teclear el folio de nuevo.
   */
  async ultimoAbierto(): Promise<AndenBorrador | null> {
    try {
      let mejor: AndenBorrador | null = null;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(PREFIJO)) continue;
        const b = await this.leer(k.slice(PREFIJO.length));
        if (b && (!mejor || b.guardadoEn > mejor.guardadoEn)) mejor = b;
      }
      return mejor;
    } catch {
      return null;
    }
  }
}
