import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * `[RD.59]` — **El bono por objetivo mensual: configurable, y lo que se puede medir se mide.**
 *
 * ── Lo que reemplaza ─────────────────────────────────────────────────────────────────────
 * La hoja `OBJETIVO MENSUAL RD` del libro: tres criterios por ruta, cada uno **marcado a mano**
 * con `IF(celda="CUMPLIDO", 50%, 0%)`, sin fecha, sin responsable y sin forma de saber con qué
 * se decidió. Quedó parada en 2021 y todas sus celdas dicen `NO CUMPLIDO`.
 *
 * ── Lo que cambia, y es el punto ─────────────────────────────────────────────────────────
 * **Dos de los tres criterios dejan de marcarse y pasan a medirse**, contra prod:
 *
 *   `visitas`  ✅ `tickets` por ruta. Septiembre 2026: de 165 (la 505) a 1,118 (la 503).
 *              ⚠️ Son visitas **con venta** — la que no vendió no deja ticket. Se declara.
 *   `volumen`  ✅ la venta del mes. Septiembre: de $94,608 a $529,895.
 *   `manual`   ⛔ *desarrollo de marcas* **no es derivable**: `analytics.v_sellout_daily` con el
 *              `vendor_code` de las rutas de RD devuelve **0 filas**. Se marca a mano, pero
 *              ahora con fecha, responsable y **motivo obligatorio**.
 *
 * ── ⛔⛔ Sin marcar NO es «no cumplió», y ésa es la diferencia con el Excel ────────────────
 * En la hoja, una celda vacía vale `0%`: el silencio **castiga**. Acá `cumplido` es ternario —
 * `true` / `false` / `null`— y el `null` suma a `sin_resolver_pct`, que se publica **al lado**
 * del alcanzado. Un mes sin marcar sale «50% alcanzado, 25% sin resolver», no «75%». Es la
 * misma regla que ADR-056 aplica al resto del sistema: lo que no se midió se declara.
 *
 * ── Y no paga solo ───────────────────────────────────────────────────────────────────────
 * Este servicio **calcula y muestra**; no escribe en la corrida de nómina. Los tres criterios
 * nacen `activo = false` con `monto = 0`, y `computeRun` filtra `periodo='quincena' AND activo`,
 * así que aunque alguien los encienda **no entran a la quincena**. Meterlos al pago es un cambio
 * aparte, y primero hay que fijar el importe y los umbrales, que nadie ha dado. *Medir antes de
 * pagar* — al revés es como se publican cifras que nadie pidió.
 */
@Injectable()
export class CommissionObjectiveService {
  private readonly logger = new Logger(CommissionObjectiveService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Los criterios configurados, con su peso y su estado. Sin filtrar por activo: se editan. */
  async configuracion(): Promise<ObjetivoConfig> {
    return this.tk.run(async (trx) => {
      const { rows: criterios } = await trx.raw(`
        SELECT b.id, b.nombre, b.metrica, b.comparador, b.umbral, b.monto, b.peso_pct,
               b.route_code, b.activo, b.beneficiario, b.updated_at,
               s.code AS escala, s.nombre AS escala_nombre
          FROM commercial.commission_bonuses b
          JOIN commercial.commission_scales s ON s.id = b.scale_id AND s.deleted_at IS NULL
         WHERE b.grupo = ? AND b.deleted_at IS NULL
         ORDER BY b.peso_pct DESC, b.nombre`, [GRUPO]);

      const pesos = criterios.reduce((a: number, c: Criterio) => a + Number(c.peso_pct ?? 0), 0);
      const activos = criterios.filter((c: Criterio) => c.activo).length;
      const montoTotal = criterios.reduce((a: number, c: Criterio) => a + Number(c.monto ?? 0), 0);

      const pendientes: string[] = [];
      if (!criterios.length) pendientes.push('No hay ningún criterio configurado.');
      if (criterios.length && Math.abs(pesos - 100) > 0.0001) {
        pendientes.push(`Los pesos suman ${pesos}% y tienen que sumar 100%.`);
      }
      if (montoTotal === 0) {
        pendientes.push('Nadie ha fijado el importe del bono: hoy vale $0 y por eso sigue apagado.');
      }
      const sinUmbral = criterios.filter(
        (c: Criterio) => c.metrica !== 'manual' && Number(c.umbral) === 0,
      );
      if (sinUmbral.length) {
        pendientes.push(
          `${sinUmbral.length} criterio(s) sin umbral: ${sinUmbral.map((c: Criterio) => c.nombre).join(', ')}. Con umbral 0 se cumplen siempre.`,
        );
      }

      return {
        grupo: GRUPO,
        criterios,
        peso_total: Number(pesos.toFixed(4)),
        monto_total: Number(montoTotal.toFixed(2)),
        activos,
        // ⛔ Encendido NO es «funciona»: es que los criterios activos cubran el 100% del peso
        // y que alguien haya puesto el importe. Decirlo de otra forma sería prometer un pago.
        estado: !criterios.length ? 'sin_configurar'
          : activos === 0 ? 'apagado'
            : pendientes.length ? 'encendido_incompleto' : 'encendido',
        pendientes,
        // ⛔ Aunque se encienda, el objetivo NO entra a la nómina: `computeRun` sólo paga
        // `periodo='quincena'`. Que la pantalla lo diga evita la promesa implícita.
        entra_a_nomina: false,
      };
    });
  }

  /**
   * El resultado del mes por ruta. `anio` y `mes` (1..12) sobre el calendario, que es como el
   * negocio habla; la hoja usaba un calendario de 28 días que no coincide con ninguna quincena.
   */
  async resultado(anio: number, mes: number): Promise<ObjetivoResultado> {
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
      throw new BadRequestException('mes tiene que ir de 1 a 12');
    }
    const config = await this.configuracion();

    return this.tk.run(async (trx) => {
      // ── La ventana del mes, y si ya terminó ──────────────────────────────────────────
      const { rows: [v] } = await trx.raw(`
        SELECT make_date(?, ?, 1) AS desde,
               (make_date(?, ?, 1) + interval '1 month')::date AS hasta,
               ((make_date(?, ?, 1) + interval '1 month')::date <= current_date) AS cerrado,
               (SELECT min(business_date) FROM analytics.mv_rd_route_daily_200d) AS fuente_desde`,
        [anio, mes, anio, mes, anio, mes]);

      // ── Las rutas que comisionan: del universo derivado, no de una lista ─────────────
      const { rows: rutas } = await trx.raw(`
        SELECT route_code, chofer_nombre, plaza_o_zona
          FROM analytics.v_rd_commission_universe
         WHERE comisiona ORDER BY route_code`);

      // ── Lo medible ──────────────────────────────────────────────────────────────────
      const { rows: medido } = await trx.raw(`
        SELECT route_code,
               sum(tickets)::int AS visitas,
               round(sum(subtotal), 2) AS volumen,
               count(DISTINCT business_date)::int AS dias
          FROM analytics.mv_rd_route_daily_200d
         WHERE business_date >= ?::date AND business_date < ?::date
         GROUP BY 1`, [v.desde, v.hasta]);
      const porRuta = new Map<string, Medido>(medido.map((m: Medido) => [m.route_code, m]));

      // ── Lo marcado a mano ───────────────────────────────────────────────────────────
      const { rows: marcas } = await trx.raw(`
        SELECT bonus_id, route_code, cumplido, motivo, marked_at, marked_by_nombre
          FROM commercial.objective_marks
         WHERE anio = ? AND periodo_no = ? AND deleted_at IS NULL`, [anio, mes]);
      const porMarca = new Map<string, ObjetivoMarca>(
        marcas.map((m: ObjetivoMarca) => [`${m.bonus_id}|${m.route_code}`, m]),
      );

      // ⛔ Un mes anterior a la fuente no tiene con qué medirse, y eso NO es «no cumplió».
      const sinFuente = v.fuente_desde && new Date(v.desde) < new Date(v.fuente_desde);

      const criteriosActivos = config.criterios.filter((c) => c.activo);
      const filas: ObjetivoFila[] = rutas.map((r: RutaUniverso) => {
        const m = porRuta.get(r.route_code);
        const detalle: ObjetivoCriterioFila[] = criteriosActivos.map((c) => {
          const marca = porMarca.get(`${c.id}|${r.route_code}`);
          const { valor, cumplido, motivo } = this.evaluar(c, m, marca, sinFuente);
          return {
            bonus_id: c.id, nombre: c.nombre, metrica: c.metrica,
            peso_pct: Number(c.peso_pct), umbral: Number(c.umbral), comparador: c.comparador,
            valor, cumplido, motivo,
            marcado_por: marca?.marked_by_nombre ?? null,
            marcado_at: marca?.marked_at ?? null,
            marca_motivo: marca?.motivo ?? null,
          };
        });

        const suma = (p: (d: ObjetivoCriterioFila) => boolean): number =>
          Number(detalle.filter(p).reduce((a, d) => a + d.peso_pct, 0).toFixed(4));

        return {
          route_code: r.route_code,
          chofer: r.chofer_nombre,
          zona: r.plaza_o_zona,
          dias_con_venta: m?.dias ?? 0,
          criterios: detalle,
          alcanzado_pct: suma((d) => d.cumplido === true),
          // ⭐ El silencio no castiga: lo que nadie resolvió se publica APARTE, no como fallo.
          sin_resolver_pct: suma((d) => d.cumplido === null),
          fallado_pct: suma((d) => d.cumplido === false),
        };
      });

      const huecos: string[] = [];
      if (!criteriosActivos.length) {
        huecos.push('Ningún criterio está encendido: el bono no se está evaluando. Se enciende en la configuración.');
      }
      if (sinFuente) {
        huecos.push(`La fuente de venta arranca el ${iso(v.fuente_desde)}; este mes es anterior, así que no hay con qué medir — no es que no se haya cumplido.`);
      }
      if (!v.cerrado) {
        huecos.push('El mes todavía no termina: lo medido va a seguir subiendo.');
      }
      const manuales = criteriosActivos.filter((c) => c.metrica === 'manual');
      if (manuales.length) {
        const faltan = filas.reduce(
          (a, f) => a + f.criterios.filter((d) => d.metrica === 'manual' && d.cumplido === null).length, 0);
        if (faltan) {
          huecos.push(`${faltan} marca(s) manual(es) sin resolver. «Desarrollo de marcas» no se puede derivar: v_sellout_daily con el código de vendedor de las rutas de RD devuelve cero filas.`);
        }
      }

      return {
        anio, mes,
        desde: iso(v.desde), hasta: iso(v.hasta), cerrado: v.cerrado,
        config, filas, huecos,
      };
    });
  }

  /** Aplica el comparador configurado. El veredicto vive acá y en ningún otro lado. */
  private evaluar(c: Criterio, m: Medido | undefined, marca: ObjetivoMarca | undefined, sinFuente: boolean):
  { valor: number | null; cumplido: boolean | null; motivo: string | null } {
    if (c.metrica === 'manual') {
      if (!marca) return { valor: null, cumplido: null, motivo: 'sin marcar' };
      return { valor: null, cumplido: marca.cumplido, motivo: null };
    }
    if (sinFuente) return { valor: null, cumplido: null, motivo: 'sin fuente para ese mes' };
    if (!m) return { valor: null, cumplido: null, motivo: 'la ruta no registró venta en el mes' };

    const valor = c.metrica === 'visitas' ? Number(m.visitas)
      : c.metrica === 'volumen' ? Number(m.volumen)
        : null;
    if (valor === null) return { valor: null, cumplido: null, motivo: `métrica ${c.metrica} sin fuente mensual` };

    const umbral = Number(c.umbral);
    // ⛔ Con umbral 0 cualquier cosa lo cumple: eso no es un logro, es una configuración a
    // medias. Se declara en vez de regalar el criterio.
    if (umbral === 0) return { valor, cumplido: null, motivo: 'sin umbral configurado' };
    return {
      valor,
      cumplido: c.comparador === 'gt' ? valor > umbral : valor >= umbral,
      motivo: null,
    };
  }

  /** Edita un criterio. Sólo los campos que el negocio decide; ni la métrica ni el grupo. */
  async editarCriterio(id: string, cambios: EditarCriterio): Promise<Criterio> {
    const campos: Record<string, unknown> = {};
    if (cambios.umbral !== undefined) campos.umbral = cambios.umbral;
    if (cambios.monto !== undefined) campos.monto = cambios.monto;
    if (cambios.peso_pct !== undefined) campos.peso_pct = cambios.peso_pct;
    if (cambios.comparador !== undefined) campos.comparador = cambios.comparador;
    if (cambios.activo !== undefined) campos.activo = cambios.activo;
    if (!Object.keys(campos).length) throw new BadRequestException('nada que cambiar');

    return this.tk.run(async (trx) => {
      const { rows: [antes] } = await trx.raw(
        `SELECT id, grupo, peso_pct FROM commercial.commission_bonuses
          WHERE id = ? AND deleted_at IS NULL`, [id]);
      if (!antes) throw new NotFoundException('ese criterio no existe');
      if (antes.grupo !== GRUPO) {
        throw new BadRequestException('ese bono no es un criterio del objetivo mensual');
      }

      // ⛔ Los pesos del grupo tienen que seguir sumando 100 DESPUÉS del cambio. La base no
      // puede exigirlo (un CHECK no ve otras filas), así que se exige acá, antes de escribir.
      if (cambios.peso_pct !== undefined) {
        const { rows: [{ resto }] } = await trx.raw(
          `SELECT coalesce(sum(peso_pct), 0)::numeric resto
             FROM commercial.commission_bonuses
            WHERE grupo = ? AND id <> ? AND deleted_at IS NULL`, [GRUPO, id]);
        const total = Number(resto) + Number(cambios.peso_pct);
        if (Math.abs(total - 100) > 0.0001) {
          throw new BadRequestException(
            `los pesos del objetivo tienen que sumar 100%: con este cambio suman ${total}%`);
        }
      }

      campos.updated_at = trx.fn.now();
      campos.updated_by = this.tenantCtx.get()?.userId ?? null;
      await trx('commercial.commission_bonuses').where({ id }).update(campos);
      const { rows: [despues] } = await trx.raw(
        `SELECT id, nombre, metrica, comparador, umbral, monto, peso_pct, route_code, activo,
                beneficiario, updated_at
           FROM commercial.commission_bonuses WHERE id = ?`, [id]);
      this.logger.log(`[RD.59] criterio ${despues.nombre} actualizado: ${JSON.stringify(cambios)}`);
      return despues;
    });
  }

  /** La marca humana del criterio que nadie puede derivar. Exige motivo. */
  async marcar(dto: MarcarDto): Promise<ObjetivoMarca> {
    if (!dto.motivo || !dto.motivo.trim()) {
      throw new BadRequestException('el motivo es obligatorio: una marca que decide dinero tiene que decir por qué');
    }
    if (!Number.isInteger(dto.mes) || dto.mes < 1 || dto.mes > 12) {
      throw new BadRequestException('mes tiene que ir de 1 a 12');
    }
    return this.tk.run(async (trx) => {
      const { rows: [bono] } = await trx.raw(
        `SELECT id, metrica, grupo FROM commercial.commission_bonuses
          WHERE id = ? AND deleted_at IS NULL`, [dto.bonus_id]);
      if (!bono) throw new NotFoundException('ese criterio no existe');
      if (bono.grupo !== GRUPO) throw new BadRequestException('ese bono no es del objetivo mensual');
      // ⛔ No se deja marcar a mano lo que SÍ se puede medir: ahí la marca sería una forma de
      // pisar la medición sin que se note.
      if (bono.metrica !== 'manual') {
        throw new BadRequestException(
          `«${bono.metrica}» se mide, no se marca. Sólo los criterios declarados manuales admiten marca.`);
      }

      const userId = this.tenantCtx.get()?.userId ?? null;
      const nombre = this.tenantCtx.get()?.username ?? null;
      const { rows: [fila] } = await trx.raw(`
        INSERT INTO commercial.objective_marks
          (tenant_id, bonus_id, route_code, anio, periodo_no, cumplido, motivo,
           marked_by, marked_by_nombre, marked_at, created_by, updated_by)
        VALUES (current_tenant_id(), ?, ?, ?, ?, ?, ?, ?, ?, now(), ?, ?)
        ON CONFLICT ON CONSTRAINT objective_marks_natural_unique DO UPDATE
          SET cumplido = excluded.cumplido, motivo = excluded.motivo,
              marked_by = excluded.marked_by, marked_by_nombre = excluded.marked_by_nombre,
              marked_at = now(), updated_at = now(), updated_by = excluded.updated_by,
              deleted_at = NULL, deleted_by = NULL
        RETURNING bonus_id, route_code, anio, periodo_no, cumplido, motivo,
                  marked_at, marked_by_nombre`,
        [dto.bonus_id, dto.route_code, dto.anio, dto.mes, dto.cumplido, dto.motivo.trim(),
          userId, nombre, userId, userId]);
      return fila;
    });
  }
}

const GRUPO = 'objetivo_mensual';

/** ⚠️ `pg` devuelve `date` como Date: `String(d).slice(0,10)` da el día anterior en MX. */
function iso(d: Date | string | null): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface Criterio {
  id: string; nombre: string; metrica: string; comparador: string;
  umbral: string; monto: string; peso_pct: string | null;
  route_code: string | null; activo: boolean; beneficiario: string;
  updated_at: Date;
  escala?: string; escala_nombre?: string;
}

export interface ObjetivoConfig {
  grupo: string;
  criterios: Criterio[];
  peso_total: number;
  monto_total: number;
  activos: number;
  estado: 'sin_configurar' | 'apagado' | 'encendido_incompleto' | 'encendido';
  pendientes: string[];
  entra_a_nomina: boolean;
}

export interface ObjetivoCriterioFila {
  bonus_id: string; nombre: string; metrica: string;
  peso_pct: number; umbral: number; comparador: string;
  valor: number | null;
  /** ⛔ TERNARIO. `null` = nadie lo resolvió, que NO es lo mismo que no haberlo cumplido. */
  cumplido: boolean | null;
  motivo: string | null;
  marcado_por: string | null;
  marcado_at: Date | null;
  marca_motivo: string | null;
}

export interface ObjetivoFila {
  route_code: string; chofer: string | null; zona: string | null;
  dias_con_venta: number;
  criterios: ObjetivoCriterioFila[];
  alcanzado_pct: number;
  sin_resolver_pct: number;
  fallado_pct: number;
}

export interface ObjetivoResultado {
  anio: number; mes: number;
  desde: string | null; hasta: string | null; cerrado: boolean;
  config: ObjetivoConfig;
  filas: ObjetivoFila[];
  huecos: string[];
}

export interface EditarCriterio {
  umbral?: number; monto?: number; peso_pct?: number;
  comparador?: 'gt' | 'gte'; activo?: boolean;
}

export interface MarcarDto {
  bonus_id: string; route_code: string;
  anio: number; mes: number;
  cumplido: boolean; motivo: string;
}

interface Medido { route_code: string; visitas: number; volumen: string; dias: number }
export interface ObjetivoMarca {
  bonus_id: string; route_code: string; cumplido: boolean; motivo: string;
  marked_at: Date; marked_by_nombre: string | null;
  anio?: number; periodo_no?: number;
}
interface RutaUniverso { route_code: string; chofer_nombre: string | null; plaza_o_zona: string | null }
