import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { GeolocationService } from '../../core/services/geolocation.service';
import { SetLocationResult, VendorService } from './vendor.service';

/**
 * `[MCP.3.7]` Protocolo de visitas, del lado del celular.
 *
 *  - Abrir a un cliente REGISTRA la llegada (hora + desde dónde). El servidor calcula la distancia
 *    al cliente y, si el cliente no tenía ubicación, se la fija con esta toma (el flujo de siempre,
 *    con su guarda contra encimar dos clientes). Abrirlo otra vez no duplica la visita.
 *  - «El cliente no pidió nada» cierra la visita sin pedido, con su motivo.
 *  - Las faltas (se fue sin abrir / no pasó) NO se calculan aquí: las calcula el servidor al
 *    consultarlas el supervisor, con el GPS de la jornada que la app ya manda.
 */

/** Motivos de no venta: las claves son las del servidor (`NO_SALE_REASONS`); los textos, para la calle. */
export const NO_SALE_OPTIONS: readonly { key: NoSaleKey; label: string; icon: string }[] = [
  { key: 'con_inventario', label: 'Todavía tiene producto', icon: 'pi-box' },
  { key: 'sin_recursos', label: 'No tiene dinero', icon: 'pi-wallet' },
  { key: 'cerrado', label: 'Estaba cerrado', icon: 'pi-lock' },
  { key: 'no_atendio', label: 'No estaba el encargado', icon: 'pi-user-minus' },
  { key: 'no_interesado', label: 'No le interesa', icon: 'pi-times-circle' },
  { key: 'otro', label: 'Otro motivo', icon: 'pi-pencil' },
];
export type NoSaleKey = 'con_inventario' | 'sin_recursos' | 'cerrado' | 'no_atendio' | 'no_interesado' | 'otro';

/** «Otro» sin explicación no le sirve al supervisor: se pide el texto. */
export function noSaleIsValid(key: NoSaleKey | null, notes: string): boolean {
  if (!key) return false;
  return key !== 'otro' || notes.trim().length >= 3;
}

/** Una toma de GPS reciente se reusa (la de la tarjeta de llegada) para no volver a esperar al GPS. */
export interface RecentFix {
  lat: number;
  lng: number;
  at: number;
}
const FIX_MAX_AGE_MS = 2 * 60 * 1000;

export interface ArrivalResult {
  id: string;
  distance_m?: number | null;
  reused?: boolean;
  location?: SetLocationResult | null;
}

@Injectable({ providedIn: 'root' })
export class VisitProtocolService {
  private readonly api = inject(VendorService);
  private readonly geo = inject(GeolocationService);

  /**
   * Registra la llegada al cliente. GPS best-effort: sin permiso o sin señal, la visita se
   * registra igual, sin distancia (el supervisor la ve como «sin GPS al abrir»).
   */
  async registerArrival(customerId: string, recent?: RecentFix | null): Promise<ArrivalResult> {
    let coords: { latitude?: number; longitude?: number } = {};
    if (recent && Date.now() - recent.at <= FIX_MAX_AGE_MS) {
      coords = { latitude: recent.lat, longitude: recent.lng };
    } else if (this.geo.supported) {
      try {
        const fix = await this.geo.getCurrentPosition();
        coords = { latitude: fix.lat, longitude: fix.lng };
      } catch {
        /* sin GPS: la llegada se registra sin coordenadas */
      }
    }
    return firstValueFrom((this.api.checkIn(customerId, coords) as Observable<ArrivalResult>).pipe(timeout(15000)));
  }

  /** Cierra la visita sin pedido, con su motivo (y el texto si es «otro»). */
  closeWithoutOrder(customerId: string, reason: NoSaleKey, notes: string): Observable<{ id: string }> {
    return this.api.finishVisit(customerId, {
      had_order: false,
      had_ticket: false,
      no_sale_reason: reason,
      notes: notes.trim() || undefined,
    });
  }
}
