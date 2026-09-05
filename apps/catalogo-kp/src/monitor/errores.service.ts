import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import * as crypto from 'crypto';
import { KNEX_PLATFORM } from '../platform-db/platform-db.constants';
import { pgRaw } from '../platform-db/pg-raw.util';

/**
 * Captura de errores del navegador.
 *
 * QUE PROBLEMA RESUELVE
 * Si a un cliente le truena el checkout, el error ocurre en SU navegador: no
 * deja rastro en el servidor, y casi nunca llama a contarlo. Simplemente no
 * compra, y nadie se entera de que hubo una venta perdida.
 *
 * SE AGRUPA, NO SE ACUMULA
 * Un mismo error se repite cientos de veces. Si cada ocurrencia fuera un
 * correo, la bandeja se vuelve inútil el primer día y la gente deja de
 * mirarla. La primera vez avisa; las siguientes sólo suman al contador.
 *
 * ES UN ENDPOINT PUBLICO, Y ESO OBLIGA A CUIDARLO
 * Lo llama el navegador de cualquiera, así que sin límites es una forma cómoda
 * de llenar la base desde internet. De ahí el tope por IP y el recorte de
 * todos los campos.
 */

/** Cuántos reportes acepta una misma IP por minuto. */
const TOPE_POR_MINUTO = 20;

/** Recortes. Un rastro de pila puede venir de megabytes. */
const MAX_MENSAJE = 500;
const MAX_RASTRO  = 4000;
const MAX_CAMPO   = 300;

/** Cuántas ocurrencias se guardan por grupo. */
const DETALLES_POR_ERROR = 20;

const recorta = (v: any, max: number) =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Recorta conservando los saltos de línea.
 *
 * El rastro de pila los NECESITA: la huella se calcula con su primera línea, y
 * si se colapsan todo el rastro queda en una sola. Eso hacía que dos
 * ocurrencias del mismo error, llegadas por caminos distintos, se agruparan
 * como errores diferentes — justo lo contrario de lo que este servicio existe
 * para lograr.
 *
 * Lo detectó el banco de pruebas: cambiar el número de línea creaba un grupo
 * nuevo aunque la huella normaliza los números.
 */
const recortaLineas = (v: any, max: number) =>
  String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .trim()
    .slice(0, max);

export interface ReporteError {
  mensaje?:   string;
  origen?:    string;
  rastro?:    string;
  pagina?:    string;
  navegador?: string;
  folio?:     string;
}

@Injectable()
export class ErroresService implements OnModuleInit {
  private readonly logger = new Logger(ErroresService.name);
  private listo = false;
  private ultimaRevision = 0;

  /** Contador por IP para el tope. Se limpia solo. */
  private vistos = new Map<string, { n: number; desde: number }>();

  constructor(@Inject(KNEX_PLATFORM) private readonly db: Knex) {}

  onModuleInit() {
    void this.comprobar();
  }

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }

  private async comprobar() {
    try {
      const r = await this.q<any>(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema='monitor' AND table_name='errores'`);
      this.listo = r.length > 0;
    } catch { this.listo = false; }
    if (!this.listo) {
      this.logger.warn(
        'Captura de errores DESACTIVADA: falta la migracion 006_errores_web.sql. ' +
        'Se reintenta solo; no hace falta reiniciar.');
    }
  }

  /** Misma idea que en el resto de la tienda: reintenta en vez de fallar cerrado. */
  private async estaListo(): Promise<boolean> {
    if (this.listo) return true;
    if (Date.now() - this.ultimaRevision < 30_000) return false;
    this.ultimaRevision = Date.now();
    await this.comprobar();
    return this.listo;
  }

  /** Tope por IP. Devuelve true si se pasó. */
  private demasiados(ip: string): boolean {
    const ahora = Date.now();
    const v = this.vistos.get(ip);
    if (!v || ahora - v.desde > 60_000) {
      this.vistos.set(ip, { n: 1, desde: ahora });
      // Limpieza oportunista: sin esto el mapa crece sin fin.
      if (this.vistos.size > 5000) {
        for (const [k, x] of this.vistos) {
          if (ahora - x.desde > 120_000) this.vistos.delete(k);
        }
      }
      return false;
    }
    v.n++;
    return v.n > TOPE_POR_MINUTO;
  }

  /**
   * Huella del error: lo que decide si dos ocurrencias son "el mismo error".
   *
   * Se usa el mensaje más la primera línea del rastro, NO el rastro completo:
   * un mismo fallo produce rastros distintos según por dónde se llegó, y
   * agruparlos por el rastro entero daría un grupo nuevo cada vez, que es
   * justo lo que se quiere evitar.
   */
  private huella(mensaje: string, origen: string, rastro: string): string {
    const primeraLinea = String(rastro || '').split('\n')[0] || '';
    // Se quitan números: líneas, columnas y timestamps cambian entre versiones
    // y harían que el mismo error se vea como nuevo tras cada compilación.
    const normal = `${mensaje}|${origen}|${primeraLinea}`
      .replace(/\d+/g, '#')
      .toLowerCase();
    return crypto.createHash('sha256').update(normal).digest('hex').slice(0, 32);
  }

  /**
   * Registra un error reportado por el navegador.
   *
   * Nunca lanza ni devuelve error al cliente: si esto falla, el visitante no
   * tiene por qué enterarse. Ya tuvo un problema; no se le suma otro.
   */
  async registrar(r: ReporteError, ip: string): Promise<{ ok: boolean; nuevo?: boolean }> {
    try {
      if (!(await this.estaListo())) return { ok: true };
      if (this.demasiados(ip)) return { ok: true };

      const mensaje = recorta(r.mensaje, MAX_MENSAJE);
      if (!mensaje) return { ok: true };

      const origen    = recorta(r.origen, MAX_CAMPO);
      const rastro    = recortaLineas(r.rastro, MAX_RASTRO);
      const pagina    = recorta(r.pagina, MAX_CAMPO);
      const navegador = recorta(r.navegador, MAX_CAMPO);
      const folio     = recorta(r.folio, 32) || null;

      // Un error con pedido en curso o en la página de pago cuesta una venta.
      const critico = !!folio || /checkout|pago|carrito/i.test(pagina);

      const huella = this.huella(mensaje, origen, rastro);

      // ON CONFLICT: dos navegadores reportando a la vez no deben crear dos
      // grupos ni reventar por la restricción única.
      const g = await this.q<any>(
        `INSERT INTO monitor.errores
           (huella, mensaje, origen, rastro, pagina, navegador, critico)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (huella) DO UPDATE
           SET veces = monitor.errores.veces + 1,
               ultima_vez = NOW(),
               -- Si vuelve a ocurrir uno ya resuelto, se reabre.
               resuelto_en = NULL,
               critico = monitor.errores.critico OR EXCLUDED.critico
         RETURNING id, veces, avisado_en`,
        [huella, mensaje, origen, rastro, pagina, navegador, critico]);

      const id = Number(g[0].id);
      const nuevo = Number(g[0].veces) === 1;

      await this.q(
        `INSERT INTO monitor.errores_detalle (error_id, pagina, navegador, folio, ip)
         VALUES ($1,$2,$3,$4,$5)`, [id, pagina, navegador, folio, recorta(ip, 64)]);

      // Sólo se conservan las últimas ocurrencias de cada grupo.
      await this.q(
        `DELETE FROM monitor.errores_detalle
         WHERE error_id = $1 AND id NOT IN (
           SELECT id FROM monitor.errores_detalle
           WHERE error_id = $1 ORDER BY ocurrio_en DESC LIMIT $2)`,
        [id, DETALLES_POR_ERROR]).catch(() => {
          // El rol de runtime puede no tener DELETE en monitor: si no se puede
          // recortar, no es motivo para perder el reporte. Se anota y sigue.
          this.logger.debug('No se pudo recortar el detalle de errores.');
        });

      if (nuevo) {
        this.logger.warn(
          `Error NUEVO en el navegador${critico ? ' (CRITICO)' : ''}: ${mensaje} — ${pagina}`);
      }
      return { ok: true, nuevo };
    } catch (e: any) {
      this.logger.warn(`No se pudo registrar un error del navegador: ${e.message}`);
      return { ok: true };
    }
  }

  /** Errores sin resolver, para el tablero. */
  async activos() {
    if (!(await this.estaListo())) {
      return { total: 0, criticos: 0, errores: [],
               error: 'Falta aplicar la migración 006_errores_web.sql' };
    }
    const filas = await this.q<any>(`SELECT * FROM monitor.v_errores_activos LIMIT 200`);
    return {
      total:    filas.length,
      criticos: filas.filter(f => f.critico).length,
      errores:  filas.map(f => ({
        id: Number(f.id),
        mensaje: f.mensaje,
        origen: f.origen,
        pagina: f.pagina,
        critico: f.critico,
        veces: Number(f.veces),
        primera_vez: f.primera_vez,
        ultima_vez: f.ultima_vez,
        horas_desde_ultima: Number(f.horas_desde_ultima),
        pedidos_afectados: Number(f.pedidos_afectados),
        avisado: !!f.avisado_en,
      })),
    };
  }

  /** Detalle de un error, con sus últimas ocurrencias. */
  async detalle(id: number) {
    if (!(await this.estaListo())) return { ok: false, error: 'Falta la migración 006' };
    const e = (await this.q<any>(`SELECT * FROM monitor.errores WHERE id = $1`, [id]))[0];
    if (!e) return { ok: false, error: 'Ese error no existe' };
    const d = await this.q<any>(
      `SELECT pagina, navegador, folio, ocurrio_en FROM monitor.errores_detalle
       WHERE error_id = $1 ORDER BY ocurrio_en DESC LIMIT 20`, [id]);
    return {
      ok: true,
      error: {
        id: Number(e.id), mensaje: e.mensaje, origen: e.origen,
        rastro: e.rastro, critico: e.critico, veces: Number(e.veces),
        primera_vez: e.primera_vez, ultima_vez: e.ultima_vez,
        resuelto_en: e.resuelto_en, resuelto_por: e.resuelto_por, nota: e.nota,
        ocurrencias: d,
      },
    };
  }

  /** Marca un error como atendido. */
  async resolver(id: number, quien: string, nota?: string) {
    if (!(await this.estaListo())) return { ok: false, error: 'Falta la migración 006' };
    const r = await this.q<any>(
      `UPDATE monitor.errores
       SET resuelto_en = NOW(), resuelto_por = $2, nota = $3
       WHERE id = $1 AND resuelto_en IS NULL
       RETURNING id, mensaje`, [id, quien, recorta(nota, 500) || null]);
    if (!r.length) return { ok: false, error: 'Ese error no existe o ya estaba resuelto' };
    return { ok: true, mensaje: r[0].mensaje };
  }
}
