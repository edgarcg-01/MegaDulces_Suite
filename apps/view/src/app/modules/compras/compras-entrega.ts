/**
 * `[RE.32]` Lógica pura de la entrega de compras a Finanzas (sin Angular, con pruebas en
 * `compras-entrega.spec.ts`). La pantalla y el PDF sólo dibujan lo que sale de acá.
 */
import type { ReceiptEvidenceStatus, ReceiptKey } from '@megadulces/contracts';
import { branchName } from '../../core/constants/store-branches';

/** Llave estable de una orden de entrada (la misma que el índice único de la base). */
export const receiptKey = (r: ReceiptKey): string => `${r.sucursal}|${r.doc_prefix}|${r.folio}`;

export interface GrupoSucursal<T> {
  sucursal: string;
  nombre: string;
  rows: T[];
  total: number;
}

/**
 * Agrupa respetando el ORDEN que ya trae la lista (el servidor ordena sucursal → fecha → proveedor).
 * No reordena: si lo hiciera, el PDF y la pantalla podrían dejar de coincidir con lo que se firmó.
 */
export function agruparPorSucursal<T extends { sucursal: string; amount: number }>(rows: T[]): GrupoSucursal<T>[] {
  const out: GrupoSucursal<T>[] = [];
  for (const r of rows) {
    let g = out.length ? out[out.length - 1] : undefined;
    if (!g || g.sucursal !== r.sucursal) {
      g = out.find((x) => x.sucursal === r.sucursal);
      if (!g) { g = { sucursal: r.sucursal, nombre: nombreSucursal(r.sucursal), rows: [], total: 0 }; out.push(g); }
    }
    g.rows.push(r);
    g.total = redondear(g.total + (Number(r.amount) || 0));
  }
  return out;
}

export const nombreSucursal = (code: string): string => {
  const n = branchName(code);
  return n && n !== code ? `${n} (${code})` : `Sucursal ${code}`;
};

export const sumar = (rows: { amount: number }[]): number => redondear(rows.reduce((a, r) => a + (Number(r.amount) || 0), 0));

/** Centavos exactos: sumar floats de dinero acumula error y el PDF firmado no debe descuadrar. */
export const redondear = (v: number): number => Math.round(v * 100) / 100;

const pad = (n: number) => String(n).padStart(2, '0');
export const ymdLocal = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Periodo por defecto: los últimos `dias` días, hasta hoy (fecha local del navegador = MX). */
export function periodoPorDefecto(hoy: Date, dias = 7): { from: string; to: string } {
  const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - (dias - 1));
  return { from: ymdLocal(desde), to: ymdLocal(hoy) };
}

/** YYYY-MM-DD → DD/MM/AAAA, sin pasar por Date (evita el corrimiento de día por zona horaria, LC.16). */
export const dia = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

export const EVIDENCIA_LABEL: Record<ReceiptEvidenceStatus, string> = {
  sin_evidencia: 'Sin foto',
  recibido: 'Con foto',
  validado: 'Validada',
  rechazado: 'Foto rechazada',
};
export const evidenciaLabel = (s: string | null | undefined): string =>
  EVIDENCIA_LABEL[(s ?? 'sin_evidencia') as ReceiptEvidenceStatus] ?? s ?? '—';

export const ESTADO_ENTREGA_LABEL: Record<string, string> = {
  entregada: 'Por confirmar',
  recibida: 'Recibida',
  recibida_parcial: 'Recibida con rechazos',
  cancelada: 'Cancelada',
};

export const nombreArchivoEntrega = (code: string): string => `Entrega-${code.replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
