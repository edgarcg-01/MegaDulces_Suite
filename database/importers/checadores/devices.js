/**
 * Inventario de checadores ZKTeco. Editable a mano.
 *
 * `serial` es la identidad estable — la IP cambia y el campo `IPAddress` que
 * reporta el propio equipo NO sirve (varios traen el default de fábrica
 * 192.168.1.201 mientras viven en otra IP). El importer casa por serie: si a un
 * equipo le cambian el IP, se actualiza aquí y el histórico sigue pegado.
 *
 * Descubrimiento 2026-08-17: 10 equipos vivos. Los de sucursal se encontraron
 * barriendo UDP 4370 además de TCP (los MB160 viejos contestan por los dos,
 * pero el barrido UDP + broadcast es el que no deja huecos). Subredes reales
 * detectadas por gateway: 0, 11, 13, 30, 32, 40, 42, 44, 50, 54.
 *
 * ── `site_code` YA NO lo llena el operador: se DERIVA de la subred ───────────
 * Decía "el equipo no sabe dónde está" y eso es cierto — pero la RED sí. Cada
 * sucursal tiene su propia subred, y esa correspondencia no es una suposición:
 * es la misma que usa la replicación lógica de Kepler todos los días, escrita en
 * `route-push/INVENTARIO_Y_PLAN_RUTAS.md` §1.2 (tabla `md.pv_suc_ip` del ERP):
 *
 *     subred 10 → md_01 Sucursal Hidalgo (PH)     subred 44 → md_04 Yurécuaro
 *     subred 42 → md_02 La Piedad Abastos         subred 54 → md_05 Zamora Centro
 *     subred 40 → md_03 8 Esquinas                subred 50 → md_06 Canindo
 *     subred  0 → matriz / oficinas (00)          subredes 30 y 32 → Morelia
 *
 * O sea: el `site_code` que CH.0 declaró como pendiente BLOQUEANTE del reporte
 * por sucursal estaba resuelto en otra carpeta del repo. Un checador en la
 * subred 40 está físicamente en el edificio cuyo Kepler es `192.168.40.40/md_03`.
 * Confirmación independiente: el `.10.2` lo etiquetó a mano como "Padre Hidalgo"
 * quien lo recuperó, y la regla predice exactamente eso.
 *
 * ⚠️ Es derivación, no lectura del equipo. Si alguien muda un reloj de edificio
 * sin cambiarle el IP, esto miente — pero hoy es la única fuente que existe, y
 * mentiría igual el operador llenándolo a mano.
 *
 * Medido en vivo el 2026-09-12 desde `.163`: los 12 contestan en TCP 4370, entre
 * 2 y 32 ms. Dos correcciones al inventario de agosto, abajo.
 */
module.exports = [
  // ── Matriz / oficinas (subred 192.168.0) ──────────────────────────────
  { ip: '192.168.0.80',   serial: 'UEED255000166', model: 'MB360',    label: 'Matriz / Oficinas',   site_code: '00' }, //  42 usr /  3,910 logs
  { ip: '192.168.0.81',   serial: 'CLXK233460626', model: 'MB360/ID', label: 'Matriz / Oficinas',   site_code: '00' }, //  48 usr /  4,010 — misma plantilla que .80 renumerada (+100)
  { ip: '192.168.0.153',  serial: 'CLXK225060395', model: 'MB360/ID', label: 'Matriz / Oficinas',   site_code: '00' }, //  21 usr / 23,657
  { ip: '192.168.0.196',  serial: 'UEED253600029', model: 'MB360',    label: 'Matriz / Oficinas',   site_code: '00' }, //  12 usr /  1,314

  // ── Sucursales (vía túnel; latencia 90-130 ms → timeouts holgados) ─────
  { ip: '192.168.32.215', serial: 'UEED255000061', model: 'MB360',    label: 'Morelia Madero',      site_code: '32' }, //  30 usr /  2,115
  { ip: '192.168.40.12',  serial: 'CEZU201060011', model: 'MB360/ID', label: '8 Esquinas',          site_code: '03' }, // 103 usr / 51,818 — el más cargado
  { ip: '192.168.42.37',  serial: 'UEED241600095', model: 'MB360',    label: 'La Piedad Abastos',   site_code: '02' }, //  58 usr / 16,892
  { ip: '192.168.44.12',  serial: 'UEED242200104', model: 'MB360',    label: 'Yurécuaro',           site_code: '04' }, //  16 usr /  7,133
  { ip: '192.168.50.12',  serial: 'CC5B194660472', model: 'MB160',    label: 'Canindo',             site_code: '06' }, //  95 usr / 10,561 — firmware 2018
  { ip: '192.168.54.10',  serial: 'CC5B194760731', model: 'MB160',    label: 'Zamora Centro',       site_code: '05' }, //  27 usr /  8,040 — firmware 2018

  // ── Padre Hidalgo (recuperado 2026-08-20) ─────────────────────────────
  // Estaba invisible desde la central porque su GATEWAY estaba mal
  // (0.0.0.0 / 192.168.10.254 = un DNS, no el router). Respondía local pero
  // no podía enrutar la respuesta a través del túnel. Fix: gateway → .10.1
  // (el mismo que usan las PCs de PH). Modelo MB300 (familia distinta).
  { ip: '192.168.10.2',   serial: '3266161700219', model: 'MB300',    label: 'Padre Hidalgo',       site_code: '01' }, // 175 usr / 29,563

  // ── Morelia Abastos — RECUPERADO (corregido 2026-09-12) ───────────────
  // El inventario de agosto lo daba por no recuperado: "tenía el gateway en
  // 8.8.8.8 (un DNS, no el router), no puede contestar a la central". Ya no es
  // cierto. Medido desde `.163`: contesta en TCP 4370 a 28 ms, entrega su serie
  // y **376 usuarios** — es el más poblado de los doce. Alguien le corrigió el
  // gateway y nadie lo escribió acá; queda escrito.
  //
  // Modelo MB300 por familia de serie (`32661617002xx`, la misma que el .10.2
  // de PH). Entre sus enrolamientos hay nombres de MARCA —Delicias, Chipileta,
  // Hersheys, Ricolino—: son promotoras de proveedor que checan en la tienda,
  // no empleados de Mega Dulces. Al cruzar contra el padrón NO van a casar, y
  // eso es correcto: hay que declararlas, no forzarlas.
  { ip: '192.168.30.253', serial: '3266161700253', model: 'MB300',    label: 'Morelia Abastos',     site_code: '30' }, // 376 usr
];
