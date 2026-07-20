import { Injectable, Logger } from '@nestjs/common';

/**
 * MAAT-IQ · MIQ.5 — Entity resolution (ADR-028). Descubre cuando una MISMA
 * entidad aparece con RFCs distintos: nombres casi iguales (p.ej. "PACTIV
 * FOODSERVICE" vs "PACTIV FOODSERVICE MEXICO SA DE CV") ligados a ≥2 RFCs. Señal
 * de: proveedor fragmentado (error de captura) o duplicación/shell (riesgo).
 *
 * Complementa el grafo de proveedores (MAAT.10, fan-in/fan-out por coincidencia
 * exacta) con matching DIFUSO (normaliza sufijos legales + tokens) y lo surte a
 * la bandeja como hallazgo `entidad_duplicada`. Determinista, solo analytics.*.
 */

interface EntityFinding {
  rule_key: string; severity: 'info' | 'warn' | 'critical'; score: number;
  titulo: string; resumen: string; entity: Record<string, any>;
  periodo: string | null; importe: number; evidencia: Record<string, any>; dedup_key: string;
}

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const STOP = new Set(['SA', 'S', 'DE', 'CV', 'RL', 'SAPI', 'SC', 'SOFOM', 'ENR', 'SAS', 'SADECV', 'SRL', 'SPR', 'CVDE', 'LA', 'EL', 'Y']);

/** Clave canónica del nombre: sin acentos, sin sufijos legales, primeros 4 tokens ≥2. */
function nameKey(raw: string): string {
  // NFD + catch-all a-z0-9: separa el acento del carácter base y el catch-all lo elimina.
  const clean = String(raw || '').toUpperCase()
    .normalize('NFD')
    .replace(/[^A-Z0-9 ]+/g, ' ');
  const toks = clean.split(/\s+/).filter((t) => t.length >= 2 && !STOP.has(t));
  return toks.slice(0, 4).join(' ');
}

@Injectable()
export class MaatEntityService {
  private readonly logger = new Logger(MaatEntityService.name);

  async detEntidadDuplicada(trx: any, tenantId: string, p: any): Promise<EntityFinding[]> {
    const minMonto = Number(p.min_monto) || 10000;
    const rows = await trx.raw(
      `SELECT upper(btrim(beneficiario)) AS nombre, upper(btrim(rfc)) AS rfc,
              COUNT(*)::int AS n, ROUND(SUM(importe)::numeric, 2) AS monto
         FROM analytics.expense_documents
        WHERE tenant_id = ? AND beneficiario IS NOT NULL AND btrim(beneficiario) <> ''
          AND rfc IS NOT NULL AND btrim(rfc) <> ''
        GROUP BY 1, 2`, [tenantId]);

    // agrupa (nombre,rfc) por clave canónica de nombre → colecta RFCs distintos
    const groups = new Map<string, { rfcs: Map<string, { nombre: string; monto: number; n: number }>; monto: number }>();
    for (const r of rows.rows) {
      const key = nameKey(r.nombre);
      if (!key || key.length < 3) continue;
      if (!groups.has(key)) groups.set(key, { rfcs: new Map(), monto: 0 });
      const g = groups.get(key)!;
      const prev = g.rfcs.get(r.rfc) || { nombre: r.nombre, monto: 0, n: 0 };
      prev.monto += Number(r.monto); prev.n += Number(r.n);
      g.rfcs.set(r.rfc, prev);
      g.monto += Number(r.monto);
    }

    const out: EntityFinding[] = [];
    // fan-out: mismo nombre canónico ligado a ≥2 RFCs (duplicación/shell)
    for (const [key, g] of groups) {
      if (g.rfcs.size < 2 || g.monto < minMonto) continue;
      const detalle = [...g.rfcs.entries()].map(([rfc, v]) => ({ rfc, nombre: v.nombre, monto: Math.round(v.monto), docs: v.n }))
        .sort((a, b) => b.monto - a.monto);
      out.push({
        rule_key: 'entidad_duplicada',
        severity: g.rfcs.size >= 3 ? 'critical' : 'warn',
        score: Math.min(1, g.rfcs.size / 4),
        titulo: `Posible misma entidad con ${g.rfcs.size} RFCs — ${detalle[0].nombre}`,
        resumen: `"${detalle[0].nombre}" aparece con ${g.rfcs.size} RFCs distintos (${detalle.map((d) => d.rfc).join(', ')}) por un total de ${money(g.monto)}. O es el mismo proveedor mal capturado (fragmentado, rompe DIOT/materialidad) o duplicación/shell — consolidar o investigar.`,
        entity: { nombre_clave: key, rfcs: detalle.map((d) => d.rfc) },
        periodo: null, importe: Math.round(g.monto),
        evidencia: { tipo: 'fan_out', clave: key, num_rfcs: g.rfcs.size, detalle: detalle.slice(0, 6) },
        dedup_key: `entidad_duplicada|${key}`,
      });
    }

    // fan-in: mismo RFC con ≥2 nombres canónicos distintos (error de captura / razón social — el caso PACTIV)
    const byRfc = new Map<string, { keys: Map<string, { nombre: string; monto: number }>; monto: number }>();
    for (const r of rows.rows) {
      const key = nameKey(r.nombre);
      if (!key || key.length < 3) continue;
      if (!byRfc.has(r.rfc)) byRfc.set(r.rfc, { keys: new Map(), monto: 0 });
      const g = byRfc.get(r.rfc)!;
      const prev = g.keys.get(key) || { nombre: r.nombre, monto: 0 };
      prev.monto += Number(r.monto); g.keys.set(key, prev); g.monto += Number(r.monto);
    }
    for (const [rfc, g] of byRfc) {
      if (g.keys.size < 2 || g.monto < minMonto) continue;
      const detalle = [...g.keys.values()].map((v) => ({ nombre: v.nombre, monto: Math.round(v.monto) })).sort((a, b) => b.monto - a.monto);
      out.push({
        rule_key: 'entidad_duplicada',
        severity: 'warn',
        score: Math.min(1, g.keys.size / 4),
        titulo: `RFC ${rfc} con ${g.keys.size} nombres distintos`,
        resumen: `El RFC ${rfc} aparece con ${g.keys.size} nombres distintos (${detalle.map((d) => `"${d.nombre}"`).join(', ')}) por ${money(g.monto)}. Inconsistencia de captura o razón social cambiada — unificar el nombre para no romper DIOT/materialidad.`,
        entity: { rfc, nombres: detalle.map((d) => d.nombre) },
        periodo: null, importe: Math.round(g.monto),
        evidencia: { tipo: 'fan_in', rfc, num_nombres: g.keys.size, detalle: detalle.slice(0, 6) },
        dedup_key: `entidad_duplicada|rfc|${rfc}`,
      });
    }

    return out.sort((a, b) => b.importe - a.importe).slice(0, 100);
  }
}
