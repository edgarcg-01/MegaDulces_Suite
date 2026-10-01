import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[MKT.1]` — Acuerdos con proveedor (formato MKTN001).
 *
 * Servicio **propio** y no un bloque más en `comercial.service.ts` (que ya pasa de 1,600 líneas):
 * es un dominio con su propio permiso, su propio expediente y su propia regla de dinero.
 *
 * ⚠️ **`monto` es opcional a propósito.** El servidor **omite la clave** cuando el usuario no
 * tiene `MKT_AGREEMENTS_GESTIONAR`; la deja en `null` cuando sí puede verla y no se pactó monto.
 * No son lo mismo y la pantalla los dibuja distinto — «—» contra «sin monto pactado». Si el tipo
 * fuera `monto: number | null` a secas, el primer caso se leería como el segundo y la pantalla
 * afirmaría que no se negoció dinero cuando en realidad no le toca verlo (ADR-056).
 */

export type AgreementStatus = 'borrador' | 'autorizado' | 'vigente' | 'cerrado' | 'cancelado';
export type ApoyoTipo = 'sell_out' | 'sell_in' | 'exhibicion' | 'promocional' | 'otro';
export type FileKind = 'negociacion' | 'evidencia' | 'formato_pdf' | 'nota_credito';

/** Fila del tablero. */
export interface AcuerdoResumen {
  id: string;
  folio: string | null;
  proveedor: string;
  apoyo: ApoyoTipo;
  mecanica: string;
  status: AgreementStatus;
  vigencia_desde: string | null;
  vigencia_hasta: string | null;
  vigencia_hasta_texto: string | null;
  /** Ausente = no te toca verlo · `null` = te toca y no se pactó monto. */
  monto?: number | null;
  canales_total: number;
  canales_con_evidencia: number;
  evidencia_total: number;
}

/** Un expediente de plaza dentro del acuerdo. */
export interface CanalExpediente {
  id: string;
  warehouse_code: string;
  warehouse_name: string | null;
  cajas_texto: string | null;
  cajas_lp: number | null;
  cajas_can: number | null;
  cajas_mor: number | null;
  con_cargo: boolean | null;
  evidence_required: number;
  evidence_count: number;
  evidence_last_at: string | null;
  completo: boolean;
}

export interface ArchivoExpediente {
  id: string;
  channel_id: string | null;
  kind: FileKind;
  file_name: string;
  file_url: string;
  mime_type: string | null;
  size_bytes: number | null;
  nota: string | null;
  uploaded_by_username: string | null;
  uploaded_at: string;
}

export interface AcuerdoDetalle {
  /** Carátula del formato. Las cinco claves de dinero pueden no venir. */
  cabecera: Record<string, unknown>;
  codigos: { position: number; code: string; descripcion: string | null }[];
  canales: CanalExpediente[];
  archivos: ArchivoExpediente[];
}

export interface ResumenAcuerdos {
  activos: number;
  expedientes_completos: number;
  expedientes_total: number;
  canales_sin_evidencia: number;
  /** Ausente si no puede ver dinero · `null` si ninguno de los activos tiene monto pactado. */
  monto_comprometido?: number | null;
}

@Injectable({ providedIn: 'root' })
export class PromoAgreementsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/promo-agreements`;

  // ── Tablero ───────────────────────────────────────────────────────────────
  listar(status?: AgreementStatus): Observable<AcuerdoResumen[]> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.http.get<AcuerdoResumen[]>(`${this.base}${q}`);
  }

  resumen(): Observable<ResumenAcuerdos> {
    return this.http.get<ResumenAcuerdos>(`${this.base}/resumen`);
  }

  /** Expediente completo. La plaza recibe sólo su canal (lo recorta el servidor). */
  obtener(id: string): Observable<AcuerdoDetalle> {
    return this.http.get<AcuerdoDetalle>(`${this.base}/${id}`);
  }

  // ── Plaza ─────────────────────────────────────────────────────────────────
  /**
   * Lo que corre en UNA sucursal. La sucursal viaja explícita porque el alcance la valida:
   * pedir otra da 403 desde el servidor, no desde un filtro de la pantalla.
   */
  porSucursal(code: string): Observable<{ acuerdo: AcuerdoResumen; canal: CanalExpediente }[]> {
    return this.http.get<{ acuerdo: AcuerdoResumen; canal: CanalExpediente }[]>(
      `${this.base}/sucursal/${encodeURIComponent(code)}`,
    );
  }

  subirEvidencia(
    channelId: string,
    dto: { file_name: string; file_url: string; mime_type?: string; size_bytes?: number; nota?: string },
  ) {
    return this.http.post<ArchivoExpediente>(`${this.base}/canales/${channelId}/evidencia`, dto);
  }

  quitarEvidencia(fileId: string) {
    return this.http.delete<{ ok: boolean }>(`${this.base}/evidencia/${fileId}`);
  }

  // ── Alta y ciclo de vida (Mercadotecnia) ──────────────────────────────────
  crear(dto: Record<string, unknown>) {
    return this.http.post<{ id: string }>(this.base, dto);
  }

  fijarCanales(id: string, canales: Record<string, unknown>[]) {
    return this.http.patch<{ ok: boolean }>(`${this.base}/${id}/canales`, { canales });
  }

  autorizar(id: string) {
    return this.http.post<{ folio: string }>(`${this.base}/${id}/autorizar`, {});
  }

  cambiarEstado(id: string, status: AgreementStatus) {
    return this.http.patch<{ ok: boolean }>(`${this.base}/${id}/estado`, { status });
  }
}
