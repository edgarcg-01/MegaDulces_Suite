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
}

export interface MesDetalle {
  mes: string;
  run: Record<string, unknown> | null;
  facturas: FacturaMes[];
  resumen: {
    cfdis_del_mes: number; incluidas: number; excluidas: number;
    total: number; subtotal_exento: number; subtotal_gravado: number;
    iva: number; ieps: number; total_todas: number;
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
  anio_mes: string; nombre: string; hash: string;
  facturas: number; renglones: number; cargos: number; abonos: number;
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

  /** URL de descarga directa — el navegador la abre y guarda el archivo. */
  urlArchivo(mes: string, impuestos: ImpuestosModo, uuid: boolean): string {
    return `${this.base}/${mes}/archivo?impuestos=${impuestos}&uuid=${uuid ? '1' : '0'}`;
  }

  /** Descarga con el token puesto: el endpoint va detrás del guard, así que un
   *  `<a href>` pelado devolvería 401. */
  descargar(mes: string, impuestos: ImpuestosModo, uuid: boolean): Observable<Blob> {
    return this.http.get(this.urlArchivo(mes, impuestos, uuid), { responseType: 'blob' });
  }
}
