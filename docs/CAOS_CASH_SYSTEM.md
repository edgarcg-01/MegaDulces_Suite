# CAOS — Sistema de manejo de efectivo (caja fuerte inteligente)

> Decode de reconocimiento, **solo lectura**, hecho el 2026-09-24 sobre `http://192.168.0.110`
> con una sesión real por el navegador (usuario `admin`). **No se escribió nada** del lado de
> CAOS: sólo `GET` y abrir detalles. Este documento es lo que se vio, no una integración; si se
> decide integrar, va a tracker con su propia fase.

---

## Qué es

**CAOS 6.72.3** — aplicación web (español, MX) para operar y auditar un **dispositivo de manejo
de efectivo**: una caja fuerte inteligente / reciclador-dispensador de billetes. No es vending
ni checador (las dos hipótesis que el nombre y el menú sugieren primero y que los datos
descartaron).

- **Host:** `192.168.0.110` (LAN interna), HTTP en el puerto 80 — **sin TLS**.
- **Stack aparente:** Node/Express (302 en texto plano, `ETag` estilo Express), frontend jQuery
  3.6.1 + jQuery-UI, cifrado de clave con JSEncrypt (RSA).
- **NO figuraba en el repo ni en la documentación** antes de esto (`grep` de `CAOS` y de la IP:
  cero). Es un sistema que la plataforma no conocía.

El dispositivo integrado es un **`AST700`** (nombre en CAOS: `AST700-19758`) que habla por un
protocolo llamado **`C-Link`**. En la operación real, CAOS registra dos gestos de efectivo:

- **Depósito** — entra efectivo (lo mete un operador; ej. cierres de venta).
- **Dispensar** — sale efectivo, con **detalle por denominación** y una **referencia** libre
  (ej. la tx 1417 salió con ref *"pagos gdl"*).

---

## Por qué nos importa (conexión con Caja General / arqueo)

El detalle de una transacción de *Dispensar* trae exactamente lo mismo que el arqueo de
`/finanzas/caja-general` construido en CG.23:

| Denominación | Cantidad | Total |
|---|---:|---:|
| 20 MXN | 100 | 2,000 |
| 50 MXN | 100 | 5,000 |
| 100 MXN | 250 | 25,000 |
| 200 MXN | 200 | 40,000 |
| 500 MXN | 160 | 80,000 |
| **Total** | | **152,000** |

Son **las mismas cinco denominaciones** (500/200/100/50/20, sin monedas) que la caja de la Suite
cuenta. CAOS es, de hecho, una **fuente independiente y por denominación del efectivo que se
mueve** — el tipo de árbitro que `docs/VERDAD_ABSOLUTA.md` (ADR-059) pide para una cifra de caja:
un hecho de otra fuente contra el cual cuadrar lo que se captura a mano.

⚠️ **No verificado todavía:** si el efectivo que pasa por CAOS es el mismo universo que el de
Caja General (misma caja física, mismas sucursales) o uno distinto (p. ej. sólo CEDIS / "pagos
gdl"). Antes de cruzar cifras hay que establecer **qué caja física es CAOS y de qué sucursal**,
igual que se hizo con `c45`/Caja General. No cruzar por ahora.

---

## Mapa de la interfaz (lo que se vio)

Menú superior: **Usuarios · Reportes · Ajustes · Autorizaciones · Herramientas · ? · Administrator**

### Reportes (submenú)
- **Transacciones** (`/Reports/report-TransactionsList`) — el reporte principal.
- **Contenidos** — presumiblemente el efectivo cargado por canal/cassette (no abierto).
- **Estatus** · **Info Equipo** · **Visor de Eventos** · **Balance de Usuarios** ·
  **Contabilidad de Canales** (no abiertos en esta pasada).

### Reporte de Transacciones
- **Filtros:** rango Fecha/Hora inicio–fin (default = el día de hoy), `ID de Usuario`,
  `Info de Usuario`, `ID de Canal`, `ID de Turno`, `Tipos de transacción`.
- **Columnas:** `Numero de Op.` · `Fecha` · `Fecha de Contabilidad` · `Usuario` · `Tipo` ·
  `Total`. Cada fila expande a **Detalle de Efectivo** (Denominación / Cantidad / Total) +
  **Referencia de Transacción**.
- **Balance** del rango arriba de la tabla (ej. `-15950.00 MXN` para el 2026-09-24: los depósitos
  menos los dispensados).
- Nota: hay dos fechas por operación — la de captura y la **`Fecha de Contabilidad`**, que es la
  que importa para cuadrar contra un período (mismo patrón que `kdm1.c9` vs `c68` en Kepler).

**Ejemplo real del 2026-09-24** (24 h): depósitos de `Maria del Carmen Rdriguez Vera (003)` y
`Vendedor (006) - VENTAS` en el rango de $10k–$28k c/u, más dos *Dispensar* grandes ($152,000 ref
"pagos gdl" y $59,520). Balance del día `-15,950.00 MXN`.

### Integraciones (`/Settings/Integrations/integrations`) — la página del pedido
Tabla **Activo · Nombre · Nombre del Dispositivo · Tipo** con acciones (info / editar / borrar) y
un `+` para agregar. Una sola integración configurada:

| Activo | Nombre | Dispositivo | Tipo |
|---|---|---|---|
| ✓ | C-Link | AST700-19758 | C-Link |

Es donde se da de alta el/los dispositivos de efectivo. **No se editó nada.**

---

## Hallazgos de seguridad (van tal cual, son parte del "documentarlo")

1. ⛔ **Credenciales por defecto:** entra con `admin` / `caos`. Es una consola con **control de un
   dispositivo de efectivo** (puede *dispensar* billetes). Cambiar esa clave es lo primero.
2. ⛔ **Todo por HTTP plano**, sin TLS, en la LAN.
3. ⚠️ **El "cifrado" del login no protege de replay:** la clave se cifra en el navegador con una
   **llave pública RSA incrustada en la propia página de login** (`pubKey` en
   `/Script/Login/loginUtils.js`) y viaja por HTTP. El blob cifrado que se manda a
   `POST /adminlogin` es **reutilizable tal cual** por quien vea el tráfico — el cifrado asimmétrico
   del lado del cliente sólo evita mandar la clave en claro, no un replay. Sobre TLS esto sería
   defendible; sin TLS, no agrega protección real.
4. La contraseña por defecto viajó por chat en esta sesión → **rotarla igual**, además de por
   ser default.

---

## Integración: SÍ es factible — la API interna ya está mapeada (2026-09-24)

La app tiene una **API JSON interna limpia** detrás de la sesión. No es API oficial documentada:
son los endpoints AJAX que consume su propio frontend. El patrón de integración es idéntico al de
**MagniTracking / flota (ADR-034)**: *no hay API oficial → un adapter replica el login de sesión y
llama los endpoints internos*. Ya funcionó ahí; funcionaría acá.

### Endpoints medidos (todos POST/GET a `192.168.0.110`, auth por cookie de sesión de `/adminlogin`)

| Endpoint | Qué devuelve |
|---|---|
| `GET /Reports/report-TransactionsList/getConfiguration` | Catálogo: **18 tipos** de transacción (id→label), lista de dispositivos, formato de moneda, flags (`channelsEnabled`, `sharedDBEnabled`…). |
| `POST /Reports/report-TransactionsList/getTransactions` | La lista de movimientos. Body: `{startDate,startTime,endDate,endTime,userID,transactionTypes[],devices[]}` (fecha `YY/MM/DD`). Devuelve `transactions.compactTransactions[]`. |
| `POST /Reports/report-TransactionsList/getTransactionDetails` | Body `{transactionID}`. Devuelve `transactionDetails` con **`cashDetails[]`** (denom/quantity/type B=billete), `cheques[]`, `tickets[]`, `ref`, `executedBy`, `shiftID`. |

**Forma de una transacción (`compactTransactions[]`):**
`devName · id · date · accountingDate · user · transactionTotal[] · type · channelName/ID · shiftID`.
El `id` es una **secuencia contigua** (sirve de watermark incremental para un feed sin churn).

**Detalle (`cashDetails[]`):** `{ currency, denom, type:"B", quantity, class, rollSize }` — el arqueo
real por denominación que hace la máquina.

### Historia y volumen (medido en vivo, rango 2026-01-01 → 2026-12-31)

- **977 movimientos**, del **27/05/2026** al 24/09/2026 (~4 meses vivos, ~8/día). IDs 449→1425.
- Por tipo: **Depósito 648 · Dispensar 307** · Dotar 11 · Vaciar Stocks 6 · Cambio 4 · Contenido
  Modificado 1.
- Dinero movido en esos 4 meses: **Depósitos $15.91M · Dispensado $15.57M** · Vaciar Stocks $2.35M
  · Dotar $1.50M. ≈ **$4M/mes de rotación de efectivo.**
- Operadores: `Vendedor (006) - VENTAS` (494), `Maria del Carmen Rdriguez Vera (003)` (392),
  `Juan Jesus Carrillo Contreras (002)` (90), `caos` (1, sistema).

### Cómo se integraría (recomendación, NO ejecutado — es una fase con ADR)

Igual que la flota: un **adapter detrás de un puerto** (`CASH_SAFE_PROVIDER_PORT`) que hace login,
pagina `getTransactions` por rango, enriquece con `getTransactionDetails` y **escribe a una tabla
propia** (dato de un sistema externo, con `tenant_id` + audit; no es vista sobre `kepler_ods`, así
que NO aplica derive-no-copy — aplica la excepción de "sistema externo", como
`logistics.vehicle_positions`). Feed incremental por el `id` como watermark (UPSERT sin churn).
Cambiar de marca de caja = cambiar sólo el adapter.

---

## Cuánto valor da (evaluación)

**Alto, y cae exactamente en el dominio de finanzas que ya venimos trabajando.** Cuatro usos
concretos, en orden de valor:

1. ⭐ **Árbitro del arqueo de Caja General (ADR-059).** Hoy el arqueo de `/finanzas/caja-general`
   (CG.23) es un conteo **a mano** de billetes. CAOS tiene el **conteo de la máquina**, por
   denominación, por usuario, con hora. Cruzar máquina-vs-mano es *la* forma de cazar faltantes y
   errores de captura de efectivo — es literalmente para lo que existe el arqueo ciego. Mismas 5
   denominaciones (500/200/100/50/20), así que cuadra directo.
2. ⭐ **Pierna de conciliación bancaria (Fase CB).** Los tipos **"Bóveda Virtual" (depósito/
   dispensación)** son el mecanismo por el que una smart-safe acredita el efectivo al banco antes
   de la recolección física. Un depósito en CAOS debería aparecer como abono bancario → se concilia
   contra `finance.bank_*`.
3. **Rendición por persona / detección de fraude (Maat).** Cada depósito y cada *Dispensar* lleva
   usuario, hora y referencia. Un *Dispensar* de $152,000 con ref "pagos gdl" es una salida de
   efectivo que debería atarse a una obligación de pago (Calendario TP) o levantarse como hallazgo
   si no cuadra.
4. **Trazabilidad del efectivo del CEDIS/tesorería** que hoy no vive en Kepler ni en Wincaja: es un
   circuito propio de la caja fuerte.

### ✅ Anclaje de negocio (respondido por el usuario 2026-09-25)

**CAOS ES la Caja General de OFICINAS (sucursal `00`).** El efectivo físico que mueve CAOS es el
mismo que ya representan (a) la contabilidad de Kepler (`kdm1`, `c45 = 0011` CAJA GENERAL / EFECTIVO)
y (b) el libro nuevo `finance.cash_ledger`. Son **tres vistas del mismo dinero**; CAOS es la única
con el **conteo físico por denominación de la máquina**.

⛔ **Consecuencia de diseño:** como CAOS *es* la Caja General, sus movimientos **NO se agregan como
asientos nuevos** al libro — eso sería doble conteo. El valor de CAOS es ser el **árbitro**: su
conteo de máquina se **cruza** contra la contabilidad (Kepler `0011` / `cash_ledger`) y las
diferencias se levantan como hallazgo. Esto redefine las capas: CS.3/CS.4/CS.5 son, en el fondo, un
**único matcher CAOS (máquina) ↔ Kepler caja 0011 (contabilidad)**.

### ⚠️ Lo que sigue pendiente

- **Mapear los operadores de CAOS** (`003` María del Carmen, `006` Vendedor VENTAS, `002` Juan Jesús)
  a `identity.users`.
- **El matcher necesita MEDIRSE contra datos reales antes de confiar en sus hallazgos.** CAOS y
  Kepler `0011` no comparten llave: el cruce sería por importe + proximidad de fecha (+ quizá
  `ref "ruta NN"`). Un cruce por importe sin su **placebo/piso de ruido** no significa nada
  (regla del proyecto). No se puede medir desde esta máquina (`.245` rechaza la IP en `pg_hba`);
  se mide en `md`.
- **Mapear los usuarios de CAOS** (`003`, `006`, `002`) a `identity.users`.
- **`accountingDate` vs `date`, TZ y retención** no verificados — cuál manda para cuadrar un período.
- **Riesgo de adapter:** son endpoints internos de CAOS 6.72.3, sin contrato. Una actualización de
  CAOS puede cambiarlos (mismo riesgo asumido y documentado para la flota).
- **Secretos/seguridad:** un poller guardaría credenciales de CAOS; hoy la caja está en HTTP plano
  con clave por defecto. Antes de un feed automático: rotar la clave y, idealmente, TLS.

**Veredicto:** vale la pena. Es una fuente de verdad de efectivo, independiente, por denominación y
por persona, de ~$4M/mes, directamente enchufable al arqueo y a conciliación bancaria. La
integración es de esfuerzo medio (adapter + tabla + feed incremental, patrón ya probado en flota),
y el bloqueante real no es técnico sino de negocio: anclar a qué caja/sucursal corresponde.

---

## Evidencia

Respuestas crudas de la API (no versionadas, en la raíz del working dir): `caos-getTransactions-response.json`,
`caos-getTransactionDetails-1417.json`. Capturas: `caos-integrations.png`, `caos-transacciones.png`,
`caos-transacciones-datos.png`, `caos-tx-detalle.png`.
