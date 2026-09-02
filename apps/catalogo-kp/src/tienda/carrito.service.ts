import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import * as crypto from 'crypto';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { pgRaw } from '../kp-concentrada/pg-raw.util';
import { TiendaService, SUC_TIENDA } from './tienda.service';

/**
 * Carrito de la tienda.
 *
 * NO tiene tabla propia: el esquema 002 ya define el estado 'CARRITO' en
 * tienda.pedidos, así que un carrito es un pedido que todavía no se autoriza.
 * Convertirlo en pedido será un cambio de estado, no una copia de datos, y la
 * bitácora de pedido_eventos sirve desde el primer minuto.
 *
 * IDENTIFICACIÓN SIN CUENTA
 * El comprador no necesita registrarse, así que el carrito se identifica con
 * un token firmado: "<id>.<hmac>", donde el hmac usa CATALOGO_KP_JWT_SECRET
 * (no JWT_SECRET — ver jwt.strategy.ts, CV.1). No se guarda ningún token en la
 * base — no hay nada que robarse de ahí — y un id ajeno no sirve sin la
 * firma. El cliente lo guarda y lo presenta en cada llamada.
 *
 * PRECIOS
 * kp se re-sincroniza cada hora, así que el precio de ayer puede no ser el de
 * hoy. El precio se congela al agregar (para que el cliente vea lo mismo que
 * aceptó) pero se REVALIDA al consultar el carrito, y los cambios se reportan
 * explícitamente. Un carrito viejo que se cobra a precios viejos es una
 * pérdida silenciosa; uno que cambia sin avisar es un reclamo.
 */

/** Un carrito parado más de esto se considera abandonado. */
const HORAS_VIDA_CARRITO = 24 * 14;

const centavos = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface ItemCarrito {
  id:               number;
  codigo:           string;
  nombre:           string;
  unidad:           string;
  etiqueta:         string;
  piezas_por_unidad: number;
  cantidad:         number;
  precio_unitario:  number;
  importe:          number;
  /** Se llena sólo si algo cambió desde que se agregó. */
  aviso?:           string;
  disponible:       boolean;
}

/** Lo que se responde si la migración 003 todavía no se aplicó. */
const FALTA_MIGRACION = {
  ok: false as const,
  error: 'El carrito no está disponible: falta aplicar la migración 003_carrito.sql ' +
         '(ADMINISTRAR.bat, opción 8).',
};

@Injectable()
export class CarritoService {
  private readonly logger = new Logger(CarritoService.name);

  /**
   * El carrito necesita la columna `activo` de la migración 003. Se comprueba
   * en vez de dejar que cada llamada reviente con un "Internal server error"
   * que no le dice nada a nadie: un sistema que falla debe explicar qué le
   * falta.
   *
   * POR QUE SE REINTENTA Y NO SE COMPRUEBA UNA SOLA VEZ AL ARRANCAR
   * Así estaba, y el 31/08/2026 dejó el carrito apagado con la migración
   * puesta. La API había arrancado un segundo antes de que la base volviera,
   * la comprobación no pudo consultar nada, y el `false` quedó grabado hasta
   * el siguiente reinicio. Los tres servicios de la tienda cayeron igual, y
   * uno llegó a decir que faltaba la 002, que existe desde el principio.
   *
   * No es un caso raro: el vigilante relanza la API automáticamente durante
   * una caída, así que arrancar ANTES de que la base esté lista es lo normal,
   * no la excepción.
   *
   * Un `true` sí se guarda para siempre: una migración aplicada no se
   * desaplica, así que no hace falta volver a preguntar.
   */
  private listo = false;
  private ultimaRevision = 0;
  private static readonly REVISAR_CADA_MS = 30_000;

  private async estaListo(): Promise<boolean> {
    if (this.listo) return true;
    if (Date.now() - this.ultimaRevision < CarritoService.REVISAR_CADA_MS) return false;
    this.ultimaRevision = Date.now();
    await this.comprobarMigracion();
    return this.listo;
  }

  constructor(
    @Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex,
    private readonly tienda: TiendaService,
  ) {
    void this.comprobarMigracion();
  }

  private async comprobarMigracion() {
    try {
      const r = await this.q<any>(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'tienda' AND table_name = 'pedido_items'
           AND column_name = 'activo'`);
      this.listo = r.length > 0;
    } catch {
      this.listo = false;
    }
    // Aqui se mira this.listo directamente, NO estaListo(): esta funcion es a
    // la que estaListo() llama, y usarla aqui la haria llamarse a si misma.
    if (!this.listo) {
      this.logger.warn(
        'Carrito DESACTIVADO: falta la migracion 003_carrito.sql. ' +
        'Se reintenta solo en la siguiente peticion; no hace falta reiniciar.');
    }
  }

  // ── Token ─────────────────────────────────────────────────────────────────

  private firma(id: number): string {
    const secreto = process.env.CATALOGO_KP_JWT_SECRET;
    if (!secreto) throw new Error('CATALOGO_KP_JWT_SECRET no configurado');
    return crypto.createHmac('sha256', secreto)
      .update(`carrito:${id}`)
      .digest('base64url')
      .slice(0, 32);
  }

  private token(id: number): string {
    return `${id}.${this.firma(id)}`;
  }

  /**
   * Devuelve el id del carrito si el token es válido, o null.
   *
   * Es público para que el checkout no tenga que reimplementar la verificación
   * de firma: dos copias de la misma comprobación de seguridad terminan
   * divergiendo, y la que se olvida es la que falla.
   */
  idDe(token: string): number | null { return this.idDeToken(token); }

  /**
   * Devuelve el id si el token es válido, o null.
   * La comparación es de tiempo constante: comparar firmas con === filtra
   * información por el tiempo que tarda en fallar.
   */
  private idDeToken(token: string): number | null {
    const t = String(token || '');
    const punto = t.indexOf('.');
    if (punto < 1) return null;

    const id = Number(t.slice(0, punto));
    if (!Number.isInteger(id) || id <= 0) return null;

    const dada = Buffer.from(t.slice(punto + 1));
    let esperada: Buffer;
    try { esperada = Buffer.from(this.firma(id)); } catch { return null; }

    if (dada.length !== esperada.length) return null;
    return crypto.timingSafeEqual(dada, esperada) ? id : null;
  }

  // ── Utilidades ────────────────────────────────────────────────────────────

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }

  /**
   * Registra en la bitácora. Nunca tumba la operación si falla.
   *
   * `ejecutor` es `this.db` fuera de una transacción, o el `trx` en curso
   * cuando sí la hay (equivalente al `PoolClient` del original).
   */
  private async anotar(ejecutor: Knex, pedidoId: number, estadoA: string,
                       actor: string, detalle: string, datos?: any) {
    try {
      await pgRaw(ejecutor,
        `INSERT INTO tienda.pedido_eventos (pedido_id, estado_a, actor, detalle, datos)
         VALUES ($1, $2, $3, $4, $5)`,
        [pedidoId, estadoA, actor, detalle, datos ? JSON.stringify(datos) : null]);
    } catch (e: any) {
      this.logger.warn(`No se pudo anotar el evento del pedido ${pedidoId}: ${e.message}`);
    }
  }

  /** Busca una unidad vendible del producto, con su precio y factor actuales. */
  private async unidadVigente(codigo: string, unidad: string) {
    const r: any = await this.tienda.getProducto(codigo, false);
    if (!r.ok) return { error: r.error as string };
    const u = r.producto.unidades.find(
      (x: any) => x.unidad === String(unidad || '').trim().toUpperCase());
    if (!u) return { error: `La presentación ${unidad} no está disponible` };
    return { producto: r.producto, unidad: u };
  }

  // ── Operaciones ───────────────────────────────────────────────────────────

  /** Crea un carrito vacío. */
  async crear() {
    if (!(await this.estaListo())) return FALTA_MIGRACION;
    const r = await this.q<any>(
      `INSERT INTO tienda.pedidos (sucursal, estado, entrega)
       VALUES ($1, 'CARRITO', 'ENVIO') RETURNING id`, [SUC_TIENDA]);
    const id = Number(r[0].id);
    return { ok: true, token: this.token(id), carrito: await this.armar(id) };
  }

  /**
   * Arma la vista del carrito revalidando cada renglón contra kp.
   *
   * Es lo que hace que un carrito de hace tres días sea confiable: si subió el
   * precio, si se agotó o si el producto dejó de venderse por mayoreo, el
   * renglón lo dice. No se modifica nada en silencio.
   */
  private async armar(id: number) {
    const filas = await this.q<any>(
      `SELECT id, codigo, nombre, unidad, piezas_por_unidad, cantidad,
              precio_unitario, importe
       FROM tienda.pedido_items
       WHERE pedido_id = $1 AND activo
       ORDER BY id`, [id]);

    const items: ItemCarrito[] = [];
    let subtotal = 0;

    for (const f of filas) {
      const v = await this.unidadVigente(f.codigo, f.unidad);
      const cantidad = Number(f.cantidad);
      const item: ItemCarrito = {
        id:                Number(f.id),
        codigo:            f.codigo,
        nombre:            f.nombre,
        unidad:            f.unidad,
        etiqueta:          f.unidad,
        piezas_por_unidad: Number(f.piezas_por_unidad),
        cantidad,
        precio_unitario:   centavos(Number(f.precio_unitario)),
        importe:           centavos(Number(f.importe)),
        disponible:        true,
      };

      if ('error' in v) {
        item.disponible = false;
        item.aviso = v.error;
      } else {
        item.etiqueta = v.unidad.etiqueta;

        const ahora = centavos(v.unidad.precio);
        if (ahora !== item.precio_unitario) {
          const sube = ahora > item.precio_unitario;
          item.aviso = `El precio ${sube ? 'subió' : 'bajó'} de $${item.precio_unitario} a $${ahora}`;
          item.precio_unitario = ahora;
          item.importe = centavos(ahora * cantidad);
        }

        const piezas = cantidad * Number(v.unidad.piezas);
        if (piezas > Number(v.producto.disponible)) {
          item.disponible = false;
          item.aviso = `Sólo quedan ${Math.floor(Number(v.producto.disponible) / Number(v.unidad.piezas))} de esta presentación`;
        }
      }

      if (item.disponible) subtotal += item.importe;
      items.push(item);
    }

    subtotal = centavos(subtotal);
    const envio = this.tienda.calcularEnvio(subtotal);

    // Los totales se guardan para que la vista de carritos abandonados y la
    // pantalla de confirmación no tengan que recalcularlos.
    await this.q(
      `UPDATE tienda.pedidos SET subtotal = $2, envio = $3, total = $4 WHERE id = $1`,
      [id, subtotal, envio, centavos(subtotal + envio)]);

    const cfg = this.tienda.getConfig().envio;
    return {
      items,
      partidas:  items.length,
      subtotal,
      envio,
      total:     centavos(subtotal + envio),
      // envio_gratis se define por el subtotal, no por "el envío salió cero":
      // un carrito vacío también da cero y no es que se haya ganado el envío
      // gratis. La diferencia importa porque el frontend pinta una insignia.
      envio_gratis:      subtotal >= cfg.gratis_desde,
      falta_para_gratis: Math.max(0, centavos(cfg.gratis_desde - subtotal)),
      hay_avisos:        items.some(i => i.aviso),
    };
  }

  /** Consulta un carrito. */
  async ver(token: string) {
    if (!(await this.estaListo())) return FALTA_MIGRACION;
    const id = this.idDeToken(token);
    if (!id) return { ok: false, error: 'Carrito no válido' };

    const p = await this.q<any>(
      `SELECT id, estado,
              EXTRACT(EPOCH FROM (NOW() - actualizado_en)) / 3600 AS horas
       FROM tienda.pedidos WHERE id = $1`, [id]);
    if (!p.length) return { ok: false, error: 'Carrito no encontrado' };

    // Un carrito que dejó de serlo no se puede seguir editando. El mensaje
    // distingue el motivo: decirle "ya se convirtió en pedido" a alguien que
    // lo canceló es mentirle, y manda a soporte a buscar un pedido que no existe.
    if (p[0].estado !== 'CARRITO') {
      return {
        ok: false,
        error: p[0].estado === 'CANCELADO'
          ? 'Este carrito fue cancelado'
          : 'Este carrito ya se convirtió en pedido',
        estado: p[0].estado,
      };
    }
    if (Number(p[0].horas) > HORAS_VIDA_CARRITO) {
      return { ok: false, error: 'El carrito expiró' };
    }

    return { ok: true, token, carrito: await this.armar(id) };
  }

  /** Agrega un renglón, o suma a uno existente si ya estaba. */
  async agregar(token: string, codigo: string, unidad: string, cantidad: number) {
    if (!(await this.estaListo())) return FALTA_MIGRACION;
    const id = this.idDeToken(token);
    if (!id) return { ok: false, error: 'Carrito no válido' };

    const vigente = await this.ver(token);
    if (!vigente.ok) return vigente;

    const cant = Number(cantidad);
    if (!Number.isFinite(cant) || cant <= 0) {
      return { ok: false, error: 'La cantidad debe ser mayor que cero' };
    }

    const v = await this.unidadVigente(codigo, unidad);
    if ('error' in v) return { ok: false, error: v.error };

    const u = v.unidad;
    const cod = v.producto.codigo;

    try {
      await this.db.transaction(async (trx) => {
        // Si el producto y la presentación ya están, se suma la cantidad en vez
        // de duplicar el renglón: al cliente le resulta natural y evita un
        // carrito con la misma caja repetida cinco veces.
        const ya = await pgRaw<any>(trx,
          `SELECT id, cantidad FROM tienda.pedido_items
           WHERE pedido_id = $1 AND codigo = $2 AND unidad = $3 AND activo
           FOR UPDATE`, [id, cod, u.unidad]);

        const total = cant + (ya.length ? Number(ya[0].cantidad) : 0);

        // La existencia se valida contra el TOTAL, no contra lo que se agrega.
        const piezas = total * Number(u.piezas);
        if (piezas > Number(v.producto.disponible)) {
          const cabe = Math.floor(Number(v.producto.disponible) / Number(u.piezas));
          // Lanzar aquí hace que Knex haga ROLLBACK solo; se traduce afuera.
          throw { controlado: `Sólo hay existencia para ${cabe} de esta presentación` };
        }

        const importe = centavos(Number(u.precio) * total);

        if (ya.length) {
          await pgRaw(trx,
            `UPDATE tienda.pedido_items
             SET cantidad = $2, precio_unitario = $3, importe = $4
             WHERE id = $1`, [ya[0].id, total, u.precio, importe]);
        } else {
          await pgRaw(trx,
            `INSERT INTO tienda.pedido_items
               (pedido_id, codigo, nombre, unidad, piezas_por_unidad,
                cantidad, precio_unitario, importe, existencia_al_comprar)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [id, cod, v.producto.nombre, u.unidad, u.piezas,
             total, u.precio, importe, v.producto.disponible]);
        }

        await this.anotar(trx, id, 'CARRITO', 'cliente',
          `Agregó ${cant} ${u.unidad} de ${cod}`, { codigo: cod, unidad: u.unidad, cantidad: cant });
      });
    } catch (e: any) {
      if (e?.controlado) return { ok: false, error: e.controlado as string };
      this.logger.error(`Error al agregar al carrito ${id}: ${e.message}`);
      return { ok: false, error: 'No se pudo agregar el producto' };
    }

    return { ok: true, token, carrito: await this.armar(id) };
  }

  /** Cambia la cantidad de un renglón. Cantidad 0 lo quita. */
  async cambiar(token: string, itemId: number, cantidad: number) {
    if (!(await this.estaListo())) return FALTA_MIGRACION;
    const id = this.idDeToken(token);
    if (!id) return { ok: false, error: 'Carrito no válido' };

    const vigente = await this.ver(token);
    if (!vigente.ok) return vigente;

    const cant = Number(cantidad);
    if (!Number.isFinite(cant) || cant < 0) {
      return { ok: false, error: 'Cantidad no válida' };
    }
    if (cant === 0) return this.quitar(token, itemId);

    const fila = await this.q<any>(
      `SELECT codigo, unidad FROM tienda.pedido_items
       WHERE id = $1 AND pedido_id = $2 AND activo`, [Number(itemId), id]);
    if (!fila.length) return { ok: false, error: 'Ese renglón no está en el carrito' };

    const v = await this.unidadVigente(fila[0].codigo, fila[0].unidad);
    if ('error' in v) return { ok: false, error: v.error };

    const piezas = cant * Number(v.unidad.piezas);
    if (piezas > Number(v.producto.disponible)) {
      const cabe = Math.floor(Number(v.producto.disponible) / Number(v.unidad.piezas));
      return { ok: false, error: `Sólo hay existencia para ${cabe} de esta presentación` };
    }

    await this.q(
      `UPDATE tienda.pedido_items
       SET cantidad = $2, precio_unitario = $3, importe = $4
       WHERE id = $1`,
      [Number(itemId), cant, v.unidad.precio, centavos(Number(v.unidad.precio) * cant)]);

    return { ok: true, token, carrito: await this.armar(id) };
  }

  /**
   * Quita un renglón.
   *
   * Es borrado lógico, no DELETE: catalogo_kp_runtime no tiene ese permiso y
   * no debe tenerlo. Además deja rastro de lo que el cliente sacó, que es
   * información útil para entender por qué un carrito no se cerró.
   */
  async quitar(token: string, itemId: number) {
    if (!(await this.estaListo())) return FALTA_MIGRACION;
    const id = this.idDeToken(token);
    if (!id) return { ok: false, error: 'Carrito no válido' };

    const vigente = await this.ver(token);
    if (!vigente.ok) return vigente;

    const r = await this.q<any>(
      `UPDATE tienda.pedido_items SET activo = FALSE
       WHERE id = $1 AND pedido_id = $2 AND activo
       RETURNING codigo, unidad, cantidad`, [Number(itemId), id]);
    if (!r.length) return { ok: false, error: 'Ese renglón no está en el carrito' };

    await this.anotar(this.db, id, 'CARRITO', 'cliente',
      `Quitó ${r[0].cantidad} ${r[0].unidad} de ${r[0].codigo}`, r[0]);

    return { ok: true, token, carrito: await this.armar(id) };
  }

  /**
   * Cancela un carrito completo.
   *
   * Cambia el estado a CANCELADO en vez de borrar: es la misma regla que rige
   * a los pedidos, y así el carrito deja de aparecer en la vista de
   * abandonados sin perder el rastro de que existió.
   *
   * Sirve para dos cosas: que el cliente vacíe su carrito, y que las pruebas
   * automáticas no dejen basura en la vista que usa el departamento.
   */
  async cancelar(token: string, motivo = 'Cancelado por el cliente') {
    if (!(await this.estaListo())) return FALTA_MIGRACION;
    const id = this.idDeToken(token);
    if (!id) return { ok: false, error: 'Carrito no válido' };

    const r = await this.q<any>(
      `UPDATE tienda.pedidos
       SET estado = 'CANCELADO', cancelado_motivo = $2
       WHERE id = $1 AND estado = 'CARRITO'
       RETURNING id`, [id, motivo]);
    if (!r.length) {
      return { ok: false, error: 'Ese carrito ya no se puede cancelar' };
    }

    await this.anotar(this.db, id, 'CANCELADO', 'cliente', motivo);

    return { ok: true, cancelado: true };
  }

  /** Datos de contacto del comprador. Se piden antes de pagar. */
  async datosCliente(token: string, d: { nombre?: string; email?: string; tel?: string }) {
    if (!(await this.estaListo())) return FALTA_MIGRACION;
    const id = this.idDeToken(token);
    if (!id) return { ok: false, error: 'Carrito no válido' };

    const vigente = await this.ver(token);
    if (!vigente.ok) return vigente;

    const email = String(d.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: 'Ese correo no parece válido' };
    }

    await this.q(
      `UPDATE tienda.pedidos
       SET cliente_nombre = COALESCE(NULLIF($2,''), cliente_nombre),
           cliente_email  = COALESCE(NULLIF($3,''), cliente_email),
           cliente_tel    = COALESCE(NULLIF($4,''), cliente_tel)
       WHERE id = $1`,
      [id, String(d.nombre || '').trim(), email, String(d.tel || '').trim()]);

    return { ok: true, token, carrito: await this.armar(id) };
  }
}
