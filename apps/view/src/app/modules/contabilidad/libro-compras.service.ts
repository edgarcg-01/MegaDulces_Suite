import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase LC (ADR-052) — Libro de Compras. El trámite mensual se lleva aquí; a ContPAQi
 * solo va el TXT, que sigue subiendo contabilidad.
 */

export type EstadoRun = 'sin_iniciar' | 'borrador' | 'generado' | 'entregado' | 'aplicado' | 'cancelado';
export type ImpuestosModo = 'global' | 'por-cuenta';

export interface MesResumen {
  anio_mes: string;
  cfdis: number;
  total_cfdis: number;
  estado: EstadoRun;
  run_id: string | null;
  facturas: number | null;
  renglones: number | null;
  total_cargos: number | null;
  generado_at: string | null;
  entregado_at: string | null;
  aplicado_at: string | null;
  /** Lo que ContPAQi tiene HOY. En cero con CFDIs presentes = la póliza no existe. */
  patas_en_contpaqi: number;
  total_en_contpaqi: number;
}

export interface FacturaMes {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  serie: string | null;
  folio: string | null;
  fecha: string;
  total: number;
  iva: number;
  ieps: number;
  subtotal16: number;
  base_exenta: number;
  ieps_por_cuota: boolean;
  account_suffix: string | null;
  supplier_name: string | null;
  cuenta_proveedor: string | null;
  cuenta_compra_exenta: string | null;
  cuenta_compra_iva: string | null;
  cuenta_existe: boolean;
  incluida: boolean;
  motivo_exclusion: string | null;
  /** `false` = ContPAQi no la tiene atada a ninguna póliza. `null` = no se sabe. */
  aso_contabilidad: boolean | null;
  /** Su importe ya está abonado al proveedor en la póliza del mes: re-meterla la duplica. */
  ya_en_poliza: boolean;
}

/** Un renglón del tablero de movimientos no asociados. */
export interface MesNoAsociado {
  anio_mes: string;
  cfdis: number;
  no_asociados: number;
  monto_no_asociado: number;
  /** Sin marca pero ya posteadas: NO van al TXT. */
  ya_posteados: number;
  monto_ya_posteados: number;
  faltan: number;
  monto_faltan: number;
  /** Lo accionable: sin asociar, sin postear y con cuenta de compras. Es lo que entra al TXT. */
  entran: number;
  monto_entran: number;
  /** Sin asociar y sin postear, pero de proveedor de gasto/servicio: no entran. */
  fuera_catalogo: number;
  monto_fuera: number;
  /** Si no hay póliza del mes, el mes entero está sin contabilizar. */
  existe_libro: boolean;
  estado: EstadoRun;
  run_id: string | null;
  folio_poliza: number;
  run_facturas: number | null;
  total_cargos: number | null;
  generado_at: string | null;
  entregado_at: string | null;
  aplicado_at: string | null;
}

export interface MesDetalle {
  mes: string;
  /** `libro` = el mes completo · `complemento` = solo lo que quedó sin asociar. */
  tipo: 'libro' | 'complemento';
  run: Record<string, unknown> | null;
  facturas: FacturaMes[];
  resumen: {
    cfdis_del_mes: number; incluidas: number; excluidas: number;
    total: number; subtotal_exento: number; subtotal_gravado: number;
    iva: number; ieps: number; total_todas: number;
    no_asociadas: number; ya_posteadas: number; monto_ya_posteadas: number;
  };
  /** Renglones que ContPAQi rechazaría: apagan el botón de generar. */
  bloqueantes: string[];
  /** Cosas que merecen una mirada pero se postean sin problema. */
  avisos: string[];
}

export interface CuadreContpaqi {
  anio_mes: string;
  patas_nuestras: number;
  patas_en_contpaqi: number;
  casan: number;
  solo_nuestro: number;
  solo_contpaqi: number;
  existe_en_contpaqi: boolean;
}

export interface GenerarResultado {
  anio_mes: string; tipo: 'libro' | 'complemento'; nombre: string; hash: string;
  folio: number; facturas: number; renglones: number; cargos: number; abonos: number;
}

@Injectable({ providedIn: 'root' })
export class LibroComprasService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/finance/purchase-book`;

  listMeses(limit = 24): Observable<MesResumen[]> {
    return this.http.get<MesResumen[]>(this.base, { params: { limit } });
  }

  getMes(mes: string): Observable<MesDetalle> {
    return this.http.get<MesDetalle>(`${this.base}/${mes}`);
  }

  cuadre(mes: string): Observable<CuadreContpaqi> {
    return this.http.get<CuadreContpaqi>(`${this.base}/${mes}/cuadre`);
  }

  setInclusion(mes: string, uuids: string[], incluida: boolean, motivo?: string) {
    return this.http.post<{ ok: boolean; afectadas: number }>(
      `${this.base}/${mes}/inclusion`, { uuids, incluida, motivo });
  }

  generar(mes: string, impuestos: ImpuestosModo, uuid: boolean): Observable<GenerarResultado> {
    return this.http.post<GenerarResultado>(`${this.base}/${mes}/generar`, { impuestos, uuid });
  }

  marcar(mes: string, estado: 'entregado' | 'aplicado' | 'cancelado', datos: { entregado_a?: string; notas?: string } = {}) {
    return this.http.post<{ ok: boolean }>(`${this.base}/${mes}/estado`, { estado, ...datos });
  }

  /**
   * Baja el TXT **ya generado**. No lleva `impuestos` ni `uuid`: esas opciones deciden cómo
   * se arma el archivo y eso se decidió al generarlo. Mandarlas en la descarga hacía que el
   * server regenerara y sirviera uno distinto del que quedó firmado por su hash.
   *
   * Va por HttpClient y no por un `<a href>` pelado porque el endpoint está detrás del
   * guard y sin el token devolvería 401.
   */
  descargar(mes: string): Observable<Blob> {
    return this.http.get(`${this.base}/${mes}/archivo`, { responseType: 'blob' });
  }

  // ── Sub-módulo: movimientos no asociados ──────────────────────────────────────────────
  // Mismo motor, otro alcance: en vez del mes completo, solo lo que ContPAQi no tiene
  // atado a ninguna póliza. Es el propósito del módulo — sacar lo que falta en TXT.

  private noAso = `${this.base}/no-asociados`;

  listNoAsociados(limit = 24): Observable<MesNoAsociado[]> {
    return this.http.get<MesNoAsociado[]>(this.noAso, { params: { limit } });
  }

  getNoAsociados(mes: string): Observable<MesDetalle> {
    return this.http.get<MesDetalle>(`${this.noAso}/${mes}`);
  }

  setInclusionNoAsociados(mes: string, uuids: string[], incluida: boolean, motivo?: string) {
    return this.http.post<{ ok: boolean; afectadas: number }>(
      `${this.noAso}/${mes}/inclusion`, { uuids, incluida, motivo });
  }

  generarNoAsociados(mes: string, impuestos: ImpuestosModo, uuid: boolean): Observable<GenerarResultado> {
    return this.http.post<GenerarResultado>(`${this.noAso}/${mes}/generar`, { impuestos, uuid });
  }

  marcarNoAsociados(mes: string, estado: 'entregado' | 'aplicado' | 'cancelado', datos: { entregado_a?: string; notas?: string } = {}) {
    return this.http.post<{ ok: boolean }>(`${this.noAso}/${mes}/estado`, { estado, ...datos });
  }

  descargarNoAsociados(mes: string): Observable<Blob> {
    return this.http.get(`${this.noAso}/${mes}/archivo`, { responseType: 'blob' });
  }
}
