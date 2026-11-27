import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import type { FirmaEtiquetaPedido } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';
import { type DatosEtiquetaPedido, imprimirTicketPedido } from './pedido-etiqueta-impresion';

/** Cuánto se espera la firma antes de imprimir sin ella: la persona tiene la bolsa en la mano. */
export const ESPERA_FIRMA_MS = 4000;

/**
 * `[MCP.36]` Imprime la etiqueta del pedido con la LIGA en el QR: así la cámara de cualquier celular abre el pedido
 * (David, 2026-11-25: «para todos sin excepciones»). La liga la firma el servidor, con el dominio público.
 *
 * Si la firma no llega (sin red, error, tarda más de `ESPERA_FIRMA_MS`), la etiqueta sale IGUAL con el folio solo —
 * la pistola y los lectores de la Suite la siguen leyendo— y se devuelve `'sin_liga'` para que la pantalla lo DIGA.
 * Nunca se queda la persona sin etiqueta por la liga.
 */
@Injectable({ providedIn: 'root' })
export class EtiquetaPedidoService {
  private readonly http = inject(HttpClient);

  firma(folio: string): Promise<FirmaEtiquetaPedido> {
    return firstValueFrom(
      this.http
        .get<FirmaEtiquetaPedido>(`${environment.apiUrl}/commercial/etiqueta-pedido/firma/${encodeURIComponent(folio)}`)
        .pipe(timeout(ESPERA_FIRMA_MS)),
    );
  }

  async imprimir(d: DatosEtiquetaPedido, onDone?: () => void): Promise<'con_liga' | 'sin_liga'> {
    let liga: string | null = null;
    try {
      liga = (await this.firma(d.folio)).liga || null;
    } catch {
      liga = null;
    }
    await imprimirTicketPedido(d, onDone, liga);
    return liga ? 'con_liga' : 'sin_liga';
  }
}
