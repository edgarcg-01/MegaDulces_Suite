import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

interface StoredReading { fields: unknown; status: string; at: number }

/**
 * Lo que el modelo de visión **realmente leyó**, indexado por el hash del archivo.
 *
 * Existe porque los flujos de evidencia (ficha de depósito, comprobante de pago, factura
 * del proveedor) guardaban la lectura tal como venía en el request, y de ella salen
 * `monto_match`, el descuadre persistido y controles como "la cuenta destino es nuestra".
 * Con eso, quien capturaba podía teclear el importe esperado y el sistema certificaba un
 * cuadre que el documento no dice. La lectura es **evidencia**: la produce el servidor
 * corriendo el modelo, y el request no puede dictarla.
 *
 * El flujo es: el endpoint de OCR lee y `remember`; el de guardado hace `recall` por el
 * hash de la hoja y usa eso en vez de lo que llegó. Si no hay lectura (el API se reinició
 * entre una cosa y la otra), cada dominio decide su caída — hoy todos usan la del request
 * y dejan warning, para no perderle la captura a nadie.
 *
 * En memoria a propósito: la ventana entre leer y guardar son segundos dentro del mismo
 * diálogo. Para que además aguante reinicios y varias instancias hay que persistirla
 * (tabla por `sha256`), que es la versión hermética de esto mismo.
 */
@Injectable()
export class OcrReadingsService {
  private readonly logger = new Logger(OcrReadingsService.name);
  private readonly store = new Map<string, StoredReading>();

  private static readonly TTL_MS = 8 * 60 * 60 * 1000;
  private static readonly MAX = 3000;

  /** Hash del contenido — la misma cuenta con la que se deduplican hojas repetidas. */
  hash(base64: string): string {
    return createHash('sha256').update(base64).digest('hex');
  }

  remember(scope: string, sha256: string, fields: unknown, status: string): void {
    if (!scope || !sha256) return;
    if (this.store.size >= OcrReadingsService.MAX) this.evict();
    this.store.set(`${scope}:${sha256}`, { fields, status, at: Date.now() });
  }

  recall<T>(scope: string, sha256?: string | null): { fields: T; status: string } | null {
    const sha = (sha256 || '').trim();
    if (!scope || !sha) return null;
    const key = `${scope}:${sha}`;
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > OcrReadingsService.TTL_MS) {
      this.store.delete(key);
      return null;
    }
    return { fields: hit.fields as T, status: hit.status };
  }

  /** Primero lo vencido; si con eso no alcanza, la más vieja (el Map guarda orden). */
  private evict(): void {
    const corte = Date.now() - OcrReadingsService.TTL_MS;
    for (const [k, v] of this.store) if (v.at < corte) this.store.delete(k);
    while (this.store.size >= OcrReadingsService.MAX) {
      const vieja = this.store.keys().next().value;
      if (!vieja) break;
      this.store.delete(vieja);
    }
    this.logger.debug(`lecturas en memoria: ${this.store.size}`);
  }
}
