import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { TiendaService, SUC_TIENDA } from './tienda.service';
import { AvisosService, type TipoAviso } from './avisos.service';
import { ColaService } from './cola.service';

/**
 * Pantalla de confirmación: la herramienta diaria del departamento de
 * e-commerce.
 *
 * QUE PROBLEMA RESUELVE
 * Un pedido con tarjeta lleva el cargo reservado en Mercado Pago, y esa
 * reserva vence. Alguien tiene que mirar si hay existencia y decidir, antes de
 * que venza. Con ~600 pedidos al mes y confirmación sólo en días hábiles son
 * unos 27 al día, y **el lunes por la mañana se acumulan unos 50** de viernes
 * tarde, sábado y domingo.
 *
 * De ahí las dos decisiones de diseño que mandan aquí:
 *
 *   1. CONFIRMACION EN LOTE. Si hay que abrir pedido por pedido, el lunes se
 *      vuelve insostenible antes de que el negocio crezca.
 *
 *   2. TODO LO NECESARIO PARA DECIDIR, EN LA LISTA. Cada renglón trae la
 *      existencia de HOY, no la del momento de la compra. Confirmar es
 *      prometer que se puede surtir, así que la lista muestra lo que se puede
 *      surtir ahora.
 *
 * La existencia se vuelve a validar al confirmar, no sólo al mostrar: entre
 * que el operador mira la pantalla y aprieta el botón, el mostrador pudo haber
 * vendido la última caja.
 */

/** Un pedido cuya reserva vence antes de esto es urgente. */
const HORAS_URGENTE = 24;

const centavos = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface Actor {
  email: string;
  nombre?: string;
}

@Injectable()
export class PedidosService {
  private readonly logger = new Logger(PedidosService.name);

  constructor(
    @Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex,
    private readonly tienda: TiendaService,
    private readonly avisos: AvisosService,
    private readonly cola: ColaService,
  ) {}

  /**
   * Programa un aviso y lo encola.
   *
   * El registro va dentro de la transacción que provoca el cambio de estado,
   * para que no exista un pedido confirmado sin su aviso programado. El envío
   * va fuera y sin bloquear: si el correo falla, el pedido ya está confirmado
   * y el aviso se reintenta solo. Nunca al revés.
   */
  private async avisar(trx: Knex, pedidoId: number, tipo: TipoAviso,
                       destino: string): Promise<number | null> {
    try {
      return await this.avisos.programar(pedidoId, tipo, destino, trx);
    } catch (e: any) {
      this.logger.warn(`No se pudo programar el aviso ${tipo} del pedido ${pedidoId}: ${e.message}`);
      return null;
    }
  }

  /** Encola el envío de un aviso ya programado. Nunca lanza. */
  private encolarAviso(avisoId: number | null, folio: string) {
    if (!avisoId) return;
    this.cola.encolar('aviso_cliente', { aviso_id: avisoId })
      .catch(e => this.logger.warn(`No se pudo encolar el aviso del pedido ${folio}: ${e.message}`));
  }

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const r = await this.db.raw(sql, params ?? []);
    return r.rows as T[];
  }

  private async anotar(ejecutor: Knex, pedidoId: number, de: string | null, a: string,
                       actor: string, detalle: string, datos?: any) {
    try {
      await ejecutor.raw(
        `INSERT INTO tienda.pedido_eventos (pedido_id, estado_de, estado_a, actor, detalle, datos)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pedidoId, de, a, actor, detalle, datos ? JSON.stringify(datos) : null]);
    } catch (e: any) {
      this.logger.warn(`No se pudo anotar el evento del pedido ${pedidoId}: ${e.message}`);
    }
  }

  /**
   * Existencia actual de una lista de códigos, separando PH del resto.
   *
   * Se separan porque la diferencia decide el trabajo: lo que está en PH se
   * surte de inmediato, y lo que sólo está en otra sucursal es un producto
   * **bajo pedido** que exige mover mercancía antes de poder enviarlo. Sumarlo
   * todo escondería esa diferencia justo en la pantalla donde hay que verla.
   */
  private async existenciasDe(codigos: string[]): Promise<Map<string, { ph: number; otras: number }>> {
    const m = new Map<string, { ph: number; otras: number }>();
    if (!codigos.length) return m;
    const filas = await this.q<any>(
      `SELECT TRIM(c2) AS cod,
              SUM(CASE WHEN sucursal =  $1 THEN c5::numeric ELSE 0 END) AS ph,
              SUM(CASE WHEN sucursal <> $1 THEN c5::numeric ELSE 0 END) AS otras
       FROM kp.kdik
       WHERE c5::text ~ '^[[:space:]]*-?[0-9]+([.][0-9]*)?[[:space:]]*$'
         AND TRIM(c2) = ANY($2)
       GROUP BY TRIM(c2)`, [SUC_TIENDA, codigos]);
    for (const f of filas) {
      m.set(f.cod, { ph: Number(f.ph) || 0, otras: Math.max(0, Number(f.otras) || 0) });
    }
    return m;
  }

  /** Lo que hay de un código, con cero por omisión si no aparece. */
  private hayDe(m: Map<string, { ph: number; otras: number }>, cod: string) {
    return m.get(cod) ?? { ph: 0, otras: 0 };
  }

  // ── La lista ──────────────────────────────────────────────────────────────

  /**
   * Pedidos esperando confirmación, con todo lo necesario para decidir sin
   * abrir cada uno.
   */
  async porConfirmar() {
    const pedidos = await this.q<any>(
      `SELECT p.id, p.folio, p.estado, p.metodo_pago,
              p.cliente_nombre, p.cliente_email, p.cliente_tel,
              p.subtotal, p.envio, p.total,
              p.requiere_factura, p.cliente_kepler, p.datos_fiscales,
              p.direccion, p.creado_en, p.confirmar_antes_de,
              p.autorizacion_expira,
              ROUND(EXTRACT(EPOCH FROM (p.confirmar_antes_de - NOW()))/3600, 1) AS horas_restantes,
              (p.confirmar_antes_de < NOW()) AS vencido
       FROM tienda.pedidos p
       WHERE p.estado = 'PENDIENTE_CONFIRMACION'
       ORDER BY p.confirmar_antes_de`);

    if (!pedidos.length) {
      return { total: 0, urgentes: 0, vencidos: 0, pedidos: [] };
    }

    const items = await this.q<any>(
      `SELECT pedido_id, id, codigo, nombre, unidad, piezas_por_unidad,
              cantidad, precio_unitario, importe, existencia_al_comprar
       FROM tienda.pedido_items
       WHERE pedido_id = ANY($1) AND activo
       ORDER BY pedido_id, id`, [pedidos.map(p => p.id)]);

    const existencias = await this.existenciasDe([...new Set(items.map(i => i.codigo))]);

    const porPedido = new Map<number, any[]>();
    for (const i of items) {
      const piezas = Number(i.cantidad) * Number(i.piezas_por_unidad);
      const hay = this.hayDe(existencias, i.codigo);
      const total = hay.ph + hay.otras;
      const arr = porPedido.get(Number(i.pedido_id)) ?? [];
      arr.push({
        id: Number(i.id),
        codigo: i.codigo,
        nombre: i.nombre,
        unidad: i.unidad,
        cantidad: Number(i.cantidad),
        piezas_necesarias: piezas,
        precio_unitario: Number(i.precio_unitario),
        importe: Number(i.importe),
        existencia_hoy: hay.ph,
        en_otras_sucursales: hay.otras,
        // Marca el trabajo extra: hay que traer mercancía de otra tienda antes
        // de poder enviar. Es lo que distingue un pedido que se surte hoy de
        // uno que exige un traspaso.
        requiere_traspaso: hay.ph < piezas && total >= piezas,
        // Lo que decide todo: se puede surtir o no, con lo que hay AHORA en
        // cualquier sucursal.
        alcanza: total >= piezas,
        faltan: total >= piezas ? 0 : centavos(piezas - total),
      });
      porPedido.set(Number(i.pedido_id), arr);
    }

    const salida = pedidos.map(p => {
      const its = porPedido.get(Number(p.id)) ?? [];
      const completo = its.length > 0 && its.every(i => i.alcanza);
      const conTraspaso = its.some(i => i.requiere_traspaso);
      const horas = Number(p.horas_restantes);
      return {
        id: Number(p.id),
        folio: p.folio,
        metodo_pago: p.metodo_pago,
        cliente: {
          nombre: p.cliente_nombre,
          email:  p.cliente_email,
          tel:    p.cliente_tel,
          // Distinguir cliente nuevo de recurrente importa: el nuevo lleva un
          // paso extra, darlo de alta en Kepler para poder facturarle.
          nuevo_en_kepler: p.requiere_factura && !p.cliente_kepler,
        },
        requiere_factura: p.requiere_factura,
        datos_fiscales: p.datos_fiscales,
        direccion: p.direccion,
        subtotal: Number(p.subtotal),
        envio: Number(p.envio),
        total: Number(p.total),
        creado_en: p.creado_en,
        confirmar_antes_de: p.confirmar_antes_de,
        horas_restantes: horas,
        vencido: p.vencido,
        urgente: !p.vencido && horas <= HORAS_URGENTE,
        partidas: its.length,
        // Con esto el operador puede confirmar en lote sin abrir nada: lo que
        // sale completo se puede aprobar de un golpe.
        se_puede_surtir: completo,
        // Se puede surtir, pero hay que traer mercancía de otra sucursal. Se
        // separa de `se_puede_surtir` porque conviene poder confirmar primero
        // todo lo que sale de PH y dejar los traspasos aparte: son trabajos
        // distintos y con tiempos distintos.
        requiere_traspaso: conTraspaso,
        items: its,
      };
    });

    return {
      total:     salida.length,
      urgentes:  salida.filter(p => p.urgente).length,
      vencidos:  salida.filter(p => p.vencido).length,
      completos: salida.filter(p => p.se_puede_surtir).length,
      // Cuántos exigen traer mercancía de otra tienda. Es el número que le
      // interesa a Operaciones, no al que confirma.
      con_traspaso: salida.filter(p => p.requiere_traspaso).length,
      pedidos:   salida,
    };
  }

  // ── Confirmar ─────────────────────────────────────────────────────────────

  /**
   * Confirma un pedido: valida existencia AHORA y lo pasa a CONFIRMADO.
   *
   * La existencia se revalida aunque la lista ya la haya mostrado: entre que
   * el operador mira la pantalla y aprieta el botón, el mostrador pudo vender
   * la última caja. Confirmar sin revisar es prometer lo que no se tiene.
   */
  async confirmar(id: number, actor: Actor, opciones?: { forzar?: boolean }) {
    try {
      return await this.db.transaction(async (trx) => {
        const p = await trx.raw(
          `SELECT id, folio, estado, metodo_pago, total, cliente_email
           FROM tienda.pedidos WHERE id = $1 FOR UPDATE`, [id]);
        if (!p.rows.length) {
          throw { controlado: { ok: false, error: 'Pedido no encontrado' } };
        }
        const pedido = p.rows[0];
        if (pedido.estado !== 'PENDIENTE_CONFIRMACION') {
          throw { controlado: { ok: false, error: `El pedido ${pedido.folio} ya no está por confirmar (${pedido.estado})` } };
        }

        const its = await trx.raw(
          `SELECT id, codigo, nombre, unidad, cantidad, piezas_por_unidad
           FROM tienda.pedido_items WHERE pedido_id = $1 AND activo`, [id]);
        if (!its.rows.length) {
          throw { controlado: { ok: false, error: `El pedido ${pedido.folio} no tiene partidas` } };
        }

        const existencias = await this.existenciasDe(its.rows.map((i: any) => i.codigo));
        const revision = its.rows.map((i: any) => {
          const hay = this.hayDe(existencias, i.codigo);
          const necesita = Number(i.cantidad) * Number(i.piezas_por_unidad);
          return {
            codigo: i.codigo, nombre: i.nombre, unidad: i.unidad,
            necesita,
            hay: hay.ph + hay.otras,
            en_ph: hay.ph,
            // Se puede surtir, pero moviendo mercancía de otra tienda primero.
            requiere_traspaso: hay.ph < necesita && (hay.ph + hay.otras) >= necesita,
          };
        });
        // Falta de verdad sólo si NO alcanza ni juntando todas las sucursales.
        // Antes se comparaba contra PH nada más, y con eso ningún pedido de bajo
        // pedido habría podido confirmarse jamás.
        const faltantes = revision.filter((x: any) => x.hay < x.necesita);
        const traspasos = revision.filter((x: any) => x.requiere_traspaso);

        if (faltantes.length && !opciones?.forzar) {
          throw { controlado: {
            ok: false,
            error: `No hay existencia para ${faltantes.length} producto(s) del pedido ${pedido.folio}`,
            faltantes,
          } };
        }

        // cantidad_surtida se llena con lo pedido: si se forzó con faltante, se
        // deja constancia de que se surtió menos.
        for (const i of its.rows) {
          const necesita = Number(i.cantidad);
          const hay = this.hayDe(existencias, i.codigo);
          const cabe = Math.min(necesita,
            Math.floor((hay.ph + hay.otras) / Number(i.piezas_por_unidad)));
          await trx.raw(
            `UPDATE tienda.pedido_items SET cantidad_surtida = $2 WHERE id = $1`,
            [i.id, opciones?.forzar ? cabe : necesita]);
        }

        await trx.raw(
          `UPDATE tienda.pedidos
           SET estado = 'CONFIRMADO', confirmado_por = $2, confirmado_en = NOW()
           WHERE id = $1`, [id, actor.email]);

        // Que un pedido necesite traspaso queda en la bitácora, no sólo en la
        // pantalla: quien surta mañana tiene que saber de dónde traer la
        // mercancía sin volver a calcularlo.
        const detalle = [
          opciones?.forzar && faltantes.length
            ? `Confirmado con faltante en ${faltantes.length} producto(s)`
            : 'Existencia validada',
          traspasos.length ? `requiere traspaso de ${traspasos.length} producto(s)` : '',
        ].filter(Boolean).join('; ');

        await this.anotar(trx, id, 'PENDIENTE_CONFIRMACION', 'CONFIRMADO',
          actor.email, detalle,
          {
            faltantes: faltantes.length ? faltantes : undefined,
            traspasos: traspasos.length ? traspasos : undefined,
          });

        // Al cliente se le avisa que su pedido quedó confirmado, y si paga en
        // efectivo, que en seguida le llegan los datos para pagar.
        const avisoConfirmado = await this.avisar(
          trx, id, 'CONFIRMADO', String(pedido.cliente_email || ''));

        return {
          folio: pedido.folio,
          metodo_pago: pedido.metodo_pago,
          avisoConfirmado,
          con_faltante: faltantes.length > 0,
          requiere_traspaso: traspasos.length > 0,
          traspasos: traspasos.length ? traspasos.map((t: any) => t.codigo) : undefined,
        };
      }).then((r) => {
        // El cobro y el aviso al cliente van por la cola, no aquí: si Mercado
        // Pago no responde, el pedido ya quedó confirmado y el cobro se
        // reintenta solo. Confirmar y cobrar son cosas distintas.
        this.encolarAviso(r.avisoConfirmado, r.folio);
        return {
          ok: true,
          folio: r.folio,
          metodo_pago: r.metodo_pago,
          siguiente_paso: r.metodo_pago === 'TARJETA'
            ? 'CAPTURAR_PAGO' : 'ENVIAR_REFERENCIA',
          con_faltante: r.con_faltante,
          requiere_traspaso: r.requiere_traspaso,
          traspasos: r.traspasos,
        };
      });
    } catch (e: any) {
      if (e?.controlado) return e.controlado;
      this.logger.error(`Error al confirmar el pedido ${id}: ${e.message}`);
      return { ok: false, error: 'No se pudo confirmar el pedido' };
    }
  }

  /**
   * Confirma varios de un golpe. Es lo que hace sostenible la mañana del
   * lunes, cuando se acumulan unos 50.
   *
   * Cada pedido va en su propia transacción: que uno falle por falta de
   * existencia no debe tumbar los demás. Se devuelve el detalle de cada uno
   * para que el operador vea exactamente qué pasó y con cuáles hay que
   * hacer algo.
   */
  async confirmarLote(ids: number[], actor: Actor) {
    const unicos = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!unicos.length) return { ok: false, error: 'No se indicó ningún pedido' };
    if (unicos.length > 200) {
      return { ok: false, error: 'Demasiados pedidos de un golpe. Máximo 200.' };
    }

    const resultados: any[] = [];
    for (const id of unicos) {
      resultados.push({ id, ...(await this.confirmar(id, actor)) });
    }
    const confirmados = resultados.filter(r => r.ok);
    return {
      ok: true,
      pedidos: unicos.length,
      confirmados: confirmados.length,
      fallidos: resultados.length - confirmados.length,
      detalle: resultados,
    };
  }

  /** Cancela un pedido. Siempre con motivo: sin él no se puede explicar después. */
  async cancelar(id: number, actor: Actor, motivo: string) {
    const razon = String(motivo || '').trim();
    if (!razon) return { ok: false, error: 'Hay que decir por qué se cancela' };

    try {
      const r = await this.db.transaction(async (trx) => {
        const upd = await trx.raw(
          `UPDATE tienda.pedidos
           SET estado = 'CANCELADO', cancelado_motivo = $3,
               confirmado_por = $2, confirmado_en = NOW()
           WHERE id = $1 AND estado IN ('PENDIENTE_CONFIRMACION','CONFIRMADO')
           RETURNING folio, estado, cliente_email`, [id, actor.email, razon]);
        if (!upd.rows.length) {
          throw { controlado: { ok: false, error: 'Ese pedido no se puede cancelar en su estado actual' } };
        }
        await this.anotar(trx, id, 'PENDIENTE_CONFIRMACION', 'CANCELADO', actor.email, razon);

        // Cancelar sin avisar es lo que genera la llamada de "¿y mi pedido?".
        // Se le dice el motivo y, si pagó con tarjeta, que no se le cobró.
        const aviso = await this.avisar(
          trx, id, 'CANCELADO', String(upd.rows[0].cliente_email || ''));

        return { folio: upd.rows[0].folio, aviso };
      });

      this.encolarAviso(r.aviso, r.folio);
      return { ok: true, folio: r.folio };
    } catch (e: any) {
      if (e?.controlado) return e.controlado;
      this.logger.error(`Error al cancelar el pedido ${id}: ${e.message}`);
      return { ok: false, error: 'No se pudo cancelar el pedido' };
    }
  }

  /**
   * Marca que el cliente ya quedó dado de alta en Kepler.
   *
   * Sin esto, cada pedido de un cliente recurrente vuelve a aparecer como
   * "nuevo" y alguien pierde tiempo comprobando un alta que ya existe.
   */
  async ligarClienteKepler(id: number, clave: string, actor: Actor) {
    const c = String(clave || '').trim();
    if (!c) return { ok: false, error: 'Falta la clave del cliente en Kepler' };

    const r = await this.q<any>(
      `UPDATE tienda.pedidos SET cliente_kepler = $2
       WHERE id = $1 RETURNING folio, cliente_email`, [id, c]);
    if (!r.length) return { ok: false, error: 'Pedido no encontrado' };

    // Se propaga a los demás pedidos del mismo cliente que sigan sin clave.
    const otros = await this.q<any>(
      `UPDATE tienda.pedidos SET cliente_kepler = $2
       WHERE LOWER(cliente_email) = LOWER($1) AND cliente_kepler IS NULL
       RETURNING id`, [r[0].cliente_email, c]);

    return { ok: true, folio: r[0].folio, tambien_actualizados: otros.length };
  }

  // ── 9. Envío ───────────────────────────────────────────────────────────────

  /** Paqueterías con las que se envía. Decidido el 24/08/2026. */
  static readonly PAQUETERIAS = ['ESTAFETA', 'DHL'] as const;

  /**
   * Registra la guía y marca el pedido como enviado.
   *
   * La guía se captura A MANO por ahora. Integrarse con la API de Estafeta o
   * DHL queda para después, y este método es el punto donde entraría: lo que
   * cambiaría es quién llama aquí, no la forma de los datos.
   *
   * Sólo se puede sobre un pedido CONFIRMADO: enviar algo que nadie validó, o
   * volver a "enviar" lo ya enviado, casi siempre es un error de dedo.
   */
  async registrarGuia(id: number, actor: Actor,
                      datos: { paqueteria?: string; guia?: string }) {
    const paq  = String(datos.paqueteria || '').trim().toUpperCase();
    const guia = String(datos.guia || '').trim();

    if (!(PedidosService.PAQUETERIAS as readonly string[]).includes(paq)) {
      return { ok: false, error: `Paquetería no válida. Opciones: ${PedidosService.PAQUETERIAS.join(', ')}` };
    }
    // Sin número de guía el aviso al cliente no sirve de nada: lo único útil
    // de ese correo es que pueda rastrear su paquete.
    if (guia.length < 5) {
      return { ok: false, error: 'El número de guía parece incompleto' };
    }

    try {
      const r = await this.db.transaction(async (trx) => {
        const upd = await trx.raw(
          `UPDATE tienda.pedidos
           SET estado = 'ENVIADO', paqueteria = $2, guia = $3,
               enviado_en = NOW(), enviado_por = $4
           WHERE id = $1 AND estado = 'CONFIRMADO'
           RETURNING folio, cliente_email`, [id, paq, guia, actor.email]);
        if (!upd.rows.length) {
          throw { controlado: {
            ok: false,
            error: 'Sólo se puede registrar la guía de un pedido confirmado que aún no se ha enviado',
          } };
        }

        await this.anotar(trx, id, 'CONFIRMADO', 'ENVIADO', actor.email,
          `Enviado por ${paq}, guía ${guia}`, { paqueteria: paq, guia });

        const aviso = await this.avisar(
          trx, id, 'ENVIADO', String(upd.rows[0].cliente_email || ''));

        return { folio: upd.rows[0].folio, aviso };
      });

      this.encolarAviso(r.aviso, r.folio);
      return { ok: true, folio: r.folio, paqueteria: paq, guia };
    } catch (e: any) {
      if (e?.controlado) return e.controlado;
      // Una guía repetida casi siempre es que se pegó en el pedido equivocado.
      if (String(e.message).includes('duplicate')) {
        return { ok: false, error: 'Esa guía ya está registrada en otro pedido' };
      }
      this.logger.error(`Error al registrar la guía del pedido ${id}: ${e.message}`);
      return { ok: false, error: 'No se pudo registrar la guía' };
    }
  }

  /** Pedidos confirmados esperando que se les registre la guía. */
  async porEnviar() {
    const filas = await this.q<any>(
      `SELECT p.id, p.folio, p.cliente_nombre, p.cliente_email, p.total,
              p.direccion, p.confirmado_en, p.metodo_pago,
              p.capturado_en IS NOT NULL AS pagado,
              ROUND(EXTRACT(EPOCH FROM (NOW() - p.confirmado_en))/3600, 1) AS horas_confirmado
       FROM tienda.pedidos p
       WHERE p.estado = 'CONFIRMADO'
       ORDER BY p.confirmado_en`);
    return {
      total: filas.length,
      paqueterias: PedidosService.PAQUETERIAS,
      pedidos: filas.map(r => ({
        id: Number(r.id), folio: r.folio,
        cliente: { nombre: r.cliente_nombre, email: r.cliente_email },
        total: Number(r.total),
        metodo_pago: r.metodo_pago,
        // Enviar algo que no se ha pagado es una decisión, no un descuido: se
        // marca para que quien despacha lo vea antes de imprimir la guía.
        pagado: r.pagado,
        direccion: r.direccion,
        confirmado_en: r.confirmado_en,
        horas_confirmado: Number(r.horas_confirmado),
      })),
    };
  }

  // ── 11. Vigilancia de autorizaciones ──────────────────────────────────────

  /** A partir de cuántos días sin capturar se considera urgente. */
  static readonly DIAS_AVISO_VENCIMIENTO = 4;

  /**
   * Autorizaciones de tarjeta que están por vencer sin haberse cobrado.
   *
   * Es el peor caso del flujo con tarjeta: la reserva vence, el cobro se
   * pierde, y el dinero estuvo retenido en la tarjeta del cliente todo ese
   * tiempo sin cobro ni entrega. El cliente reclama, y con razón.
   *
   * Mercado Pago mantiene la reserva 5 días (API de Orders) o 7 (Checkout
   * Bricks), así que se avisa al cuarto día para dejar margen de reacción.
   */
  async autorizacionesPorVencer() {
    const filas = await this.q<any>(
      `SELECT * FROM tienda.v_autorizaciones_por_vencer`);

    const urgentes = filas.filter(r =>
      Number(r.horas_para_vencer) <= PedidosService.DIAS_AVISO_VENCIMIENTO * 24);

    return {
      total: filas.length,
      urgentes: urgentes.length,
      vencidas: filas.filter(r => r.vencida).length,
      importe_en_riesgo: centavos(urgentes.reduce((s, r) => s + Number(r.total || 0), 0)),
      dias_aviso: PedidosService.DIAS_AVISO_VENCIMIENTO,
      pedidos: filas.map(r => ({
        id: Number(r.id), folio: r.folio, estado: r.estado,
        metodo_pago: r.metodo_pago,
        cliente: { nombre: r.cliente_nombre, email: r.cliente_email },
        total: Number(r.total),
        autorizado_en: r.autorizado_en,
        autorizacion_expira: r.autorizacion_expira,
        horas_para_vencer: Number(r.horas_para_vencer),
        vencida: r.vencida,
        urgente: !r.vencida &&
          Number(r.horas_para_vencer) <= PedidosService.DIAS_AVISO_VENCIMIENTO * 24,
        ya_se_aviso: !!r.aviso_vencimiento_en,
      })),
    };
  }

  /**
   * Pedidos en efectivo con referencia enviada que nadie pagó.
   *
   * Es la fuga conocida del flujo en efectivo: no generan ningún error, sólo
   * se quedan ahí. Es dinero que ya estaba decidido a entrar, y con perfil de
   * telemarketing en el equipo se puede recuperar buena parte.
   */
  async sinPagar() {
    const filas = await this.q<any>(`SELECT * FROM tienda.v_efectivo_sin_pagar`);
    return {
      total: filas.length,
      importe: centavos(filas.reduce((s, r) => s + Number(r.total || 0), 0)),
      pedidos: filas.map(r => ({
        id: Number(r.id), folio: r.folio, metodo_pago: r.metodo_pago,
        cliente: { nombre: r.cliente_nombre, email: r.cliente_email, tel: r.cliente_tel },
        total: Number(r.total), estado: r.estado,
        creado_en: r.creado_en,
        horas_sin_pagar: Number(r.horas_sin_pagar),
      })),
    };
  }
}
