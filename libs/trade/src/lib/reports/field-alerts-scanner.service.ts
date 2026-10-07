import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { EventsService } from '../websocket/events.service';

/**
 * Alertas de campo EN VIVO para el cockpit del Mapa en Vivo. Cada pocos minutos
 * revisa public.route_location_pings (sin RLS, todos los tenants) y detecta:
 *  - 'offline': estaba activo hoy y dejó de reportar hace > OFFLINE_MIN (perdió señal).
 *  - 'idle': sigue reportando pero lleva > IDLE_MIN detenido (pings dentro de RADIUS).
 * Emite por el WS /reports (room global del tenant + equipo del supervisor) — el
 * mismo canal que el cockpit ya consume. Cooldown 1h por (tenant,user,tipo).
 */
@Injectable()
export class FieldAlertsScannerService {
  private readonly logger = new Logger(FieldAlertsScannerService.name);
  private readonly cooldown = new Map<string, number>();

  private static readonly OFFLINE_MIN = 20; // sin pings > esto → perdió señal
  private static readonly MAX_OFFLINE_MIN = 180; // más → asumimos jornada terminada
  private static readonly IDLE_MIN = 15; // detenido > esto → alerta
  private static readonly IDLE_WINDOW_MIN = 45; // ventana de pings a analizar
  private static readonly IDLE_RADIUS_M = 70; // dentro de esto = "quieto"
  private static readonly COOLDOWN_MS = 60 * 60 * 1000;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly events: EventsService,
  ) {}

  @Cron('0 */4 * * * *') // cada 4 min
  async scan(): Promise<{ emitted: number }> {
    if (!this.events.isServerReady) return { emitted: 0 };
    try {
      const now = Date.now();

      // Última posición por usuario activo en las últimas 3h (+ supervisor).
      const active = await this.knex('public.route_location_pings as p')
        .leftJoin('users as u', 'u.id', 'p.user_id')
        .whereRaw("p.captured_at >= now() - interval '3 hours'")
        .groupBy('p.tenant_id', 'p.user_id', 'u.username', 'u.supervisor_id')
        .select('p.tenant_id', 'p.user_id', 'u.username', 'u.supervisor_id')
        .max('p.captured_at as last');

      // Pings recientes (ventana idle) para evaluar estacionariedad.
      const recent = await this.knex('public.route_location_pings')
        .whereRaw(`captured_at >= now() - interval '${FieldAlertsScannerService.IDLE_WINDOW_MIN} minutes'`)
        .orderBy('user_id', 'asc')
        .orderBy('captured_at', 'asc')
        .select('user_id', 'lat', 'lng', 'captured_at');
      const byUser = new Map<string, any[]>();
      for (const r of recent) {
        let arr = byUser.get(r.user_id);
        if (!arr) { arr = []; byUser.set(r.user_id, arr); }
        arr.push(r);
      }

      let emitted = 0;
      for (const a of active) {
        const lastMs = new Date(a.last).getTime();
        const offMin = (now - lastMs) / 60000;

        let alert: { type: 'idle' | 'offline'; minutes: number; lat?: number; lng?: number } | null = null;
        if (offMin >= FieldAlertsScannerService.OFFLINE_MIN && offMin <= FieldAlertsScannerService.MAX_OFFLINE_MIN) {
          alert = { type: 'offline', minutes: Math.round(offMin) };
        } else if (offMin < FieldAlertsScannerService.OFFLINE_MIN) {
          const idle = FieldAlertsScannerService.stationaryMinutes(byUser.get(a.user_id) || []);
          if (idle.minutes >= FieldAlertsScannerService.IDLE_MIN)
            alert = { type: 'idle', minutes: idle.minutes, lat: idle.lat, lng: idle.lng };
        }
        if (!alert) continue;

        const key = `${a.tenant_id}:${a.user_id}:${alert.type}`;
        if (this.onCooldown(key, now)) continue;
        this.cooldown.set(key, now + FieldAlertsScannerService.COOLDOWN_MS);

        this.events.emitFieldAlert({
          type: alert.type,
          tenantId: a.tenant_id,
          userId: a.user_id,
          supervisorId: a.supervisor_id || undefined,
          username: a.username || '—',
          minutes: alert.minutes,
          lat: alert.lat,
          lng: alert.lng,
          at: new Date().toISOString(),
        });
        emitted++;
      }
      if (emitted) this.logger.debug(`Field alerts emitidas: ${emitted}`);
      return { emitted };
    } catch (e: any) {
      this.logger.warn(`scan error: ${e?.message || e}`);
      return { emitted: 0 };
    }
  }

  /** Minutos detenido si TODOS los pings de la ventana caen dentro del radio. */
  private static stationaryMinutes(pts: any[]): { minutes: number; lat?: number; lng?: number } {
    if (pts.length < 2) return { minutes: 0 };
    let latSum = 0, lngSum = 0;
    for (const p of pts) { latSum += Number(p.lat); lngSum += Number(p.lng); }
    const cLat = latSum / pts.length, cLng = lngSum / pts.length;
    for (const p of pts) {
      if (FieldAlertsScannerService.haversineM(cLat, cLng, Number(p.lat), Number(p.lng)) > FieldAlertsScannerService.IDLE_RADIUS_M)
        return { minutes: 0 };
    }
    const span = (new Date(pts[pts.length - 1].captured_at).getTime() - new Date(pts[0].captured_at).getTime()) / 60000;
    return { minutes: Math.round(span), lat: cLat, lng: cLng };
  }

  private onCooldown(key: string, now: number): boolean {
    const exp = this.cooldown.get(key);
    if (exp && exp > now) return true;
    if (exp) this.cooldown.delete(key);
    return false;
  }

  /** Para tests: reset del cooldown. */
  resetCooldown(): void {
    this.cooldown.clear();
  }

  private static haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
}
