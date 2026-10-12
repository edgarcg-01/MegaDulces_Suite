// api/agente/cola.js
//
// LA COLA LOCAL — lo que hace que un corte de internet no cueste checadas.
//
// Regla: TODO evento se escribe PRIMERO aquí y DESPUÉS se intenta enviar. Al
// revés (enviar y guardar solo si falla) parece equivalente y no lo es: si el
// proceso muere entre el evento y el envío, esa marca no existió nunca y no hay
// forma de saber que faltó. Con la cola, el peor caso es mandarla dos veces —
// y eso la API ya lo ignora por dedup.
//
// SQLite y no un archivo JSON porque hacen falta tres cosas que un archivo no
// da barato: escritura atómica (si se corta la luz a media línea, el archivo
// queda corrupto), UNIQUE para no encolar dos veces el mismo evento, y borrado
// por rango de fecha para la retención.

const path = require('path');
const fs = require('fs');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('\n[cola] Falta better-sqlite3. Corre `npm install` dentro de api/agente.\n');
  throw e;
}

const RETENCION_DIAS = 30;
// A partir de aquí la cola dejó de ser un buffer y es un síntoma: o la API
// lleva días caída, o algo no está confirmando los envíos.
const AVISO_FILAS = 200000;

class Cola {
  constructor(rutaDb) {
    const ruta = rutaDb || path.join(__dirname, 'cola.db');
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    this.db = new Database(ruta);
    // WAL: permite leer mientras se escribe y sobrevive mejor a un corte de luz.
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pendientes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        serie       TEXT NOT NULL,
        codigo      TEXT NOT NULL,
        fecha_hora  TEXT NOT NULL,
        tipo        INTEGER,
        origen      TEXT NOT NULL DEFAULT 'stream',
        creado_en   TEXT NOT NULL,
        enviado_en  TEXT,
        UNIQUE (serie, codigo, fecha_hora)
      );
      CREATE INDEX IF NOT EXISTS ix_pendientes_sin_enviar
        ON pendientes (serie, id) WHERE enviado_en IS NULL;

      -- Marca de agua por reloj: hasta dónde ya se mandó. Es lo que evita que
      -- cada backfill horario reenvíe las 50 mil checadas de 8-Esquinas.
      CREATE TABLE IF NOT EXISTS marcas (
        serie            TEXT PRIMARY KEY,
        ultima_fecha_hora TEXT,
        ultimo_backfill  TEXT
      );
    `);

    this.qEncolar = this.db.prepare(
      `INSERT INTO pendientes (serie, codigo, fecha_hora, tipo, origen, creado_en)
       VALUES (@serie, @codigo, @fechaHora, @tipo, @origen, @creadoEn)
       ON CONFLICT (serie, codigo, fecha_hora) DO NOTHING`
    );
    this.qPendientes = this.db.prepare(
      `SELECT id, serie, codigo, fecha_hora AS fechaHora, tipo FROM pendientes
        WHERE serie = ? AND enviado_en IS NULL ORDER BY id LIMIT ?`
    );
    this.qSeries = this.db.prepare(
      `SELECT DISTINCT serie FROM pendientes WHERE enviado_en IS NULL`
    );
    this.qMarcarEnviadas = this.db.prepare(
      `UPDATE pendientes SET enviado_en = ? WHERE id = ?`
    );
    this.qContar = this.db.prepare(`SELECT count(*) AS n FROM pendientes`);
    this.qContarSinEnviar = this.db.prepare(
      `SELECT count(*) AS n FROM pendientes WHERE enviado_en IS NULL`
    );
  }

  /** Encola un lote. Devuelve cuántas eran nuevas (las repetidas se ignoran). */
  encolar(serie, filas, origen = 'stream') {
    const ahora = new Date().toISOString();
    const tx = this.db.transaction((lista) => {
      let n = 0;
      for (const f of lista) {
        const r = this.qEncolar.run({
          serie, codigo: String(f.codigo), fechaHora: f.fechaHora,
          tipo: f.tipo ?? null, origen, creadoEn: ahora,
        });
        n += r.changes;
      }
      return n;
    });
    return tx(filas);
  }

  /** Lo que falta por mandar de un reloj, en orden de llegada. */
  pendientes(serie, limite = 500) {
    return this.qPendientes.all(serie, limite);
  }

  /** Series con algo pendiente (para reintentar al recuperar la conexión). */
  seriesPendientes() {
    return this.qSeries.all().map((r) => r.serie);
  }

  /** Confirma un envío. Solo se llama cuando la API lo aceptó de verdad. */
  confirmar(ids) {
    const ahora = new Date().toISOString();
    const tx = this.db.transaction((lista) => {
      for (const id of lista) this.qMarcarEnviadas.run(ahora, id);
    });
    tx(ids);
  }

  // ── Marca de agua ────────────────────────────────────────────────
  marca(serie) {
    return this.db.prepare('SELECT * FROM marcas WHERE serie = ?').get(serie) || null;
  }

  /**
   * Sube la marca de agua. Solo avanza (never goes back): si un reloj devuelve
   * una fecha vieja porque le movieron la hora, no queremos que el siguiente
   * backfill reenvíe medio año.
   */
  subirMarca(serie, ultimaFechaHora, esBackfill = false) {
    const previa = this.marca(serie);
    const nueva = !previa?.ultima_fecha_hora || (ultimaFechaHora || '') > previa.ultima_fecha_hora
      ? (ultimaFechaHora || previa?.ultima_fecha_hora || null)
      : previa.ultima_fecha_hora;
    this.db.prepare(
      `INSERT INTO marcas (serie, ultima_fecha_hora, ultimo_backfill) VALUES (?,?,?)
       ON CONFLICT (serie) DO UPDATE SET
         ultima_fecha_hora = excluded.ultima_fecha_hora,
         ultimo_backfill = COALESCE(excluded.ultimo_backfill, marcas.ultimo_backfill)`
    ).run(serie, nueva, esBackfill ? new Date().toISOString() : null);
  }

  // ── Mantenimiento ────────────────────────────────────────────────
  /** Borra lo YA ENVIADO con más de 30 días. Lo no enviado no se toca nunca. */
  limpiar() {
    const corte = new Date(Date.now() - RETENCION_DIAS * 86400000).toISOString();
    const r = this.db.prepare(
      'DELETE FROM pendientes WHERE enviado_en IS NOT NULL AND enviado_en < ?'
    ).run(corte);
    return r.changes;
  }

  /** Números para el log: sirve para notar que la cola dejó de vaciarse. */
  estado() {
    const total = this.qContar.get().n;
    const sinEnviar = this.qContarSinEnviar.get().n;
    return { total, sinEnviar, alerta: total > AVISO_FILAS ? AVISO_FILAS : null };
  }

  cerrar() { try { this.db.close(); } catch { /* ya estaba cerrada */ } }
}

module.exports = { Cola, RETENCION_DIAS, AVISO_FILAS };
