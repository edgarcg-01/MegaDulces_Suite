# FASE CDC — ODS por Change Data Capture (WAL logical decoding reemplaza el poll)

> Estado: 🔨 DISEÑO (planeación) — 2026-08-21
> Objetivo: reemplazar el shipper **por polling** (`replicate-ods-live`: ctid-watermark + hash-delta
> md5-scan) por un consumidor de **WAL / logical decoding** en el `:5433`, que empuja **solo los cambios
> reales** (incluidos **DELETE**) a `kepler_ods.*` en prod.
> ADR asociado: **ADR-047 (propuesto)**. Hijo de la [Fase SYNC](FASE_SYNC_TIEMPO_REAL.md) (ADR-035: on-prem
> empuja deltas por **ingress gratis** a `feeds-ingest`; este plan cambia el ORIGEN del delta, no el sink).

---

## 0. El disparo (Edgar, 2026-08-21)

> *"¿no se puede aplicar una replicación lógica también y solo mandar los cambios en el :5433?"*

Sí. Es exactamente **CDC (Change Data Capture)**. Hoy el shipper **escanea** tablas buscando cambios; la
propuesta es **leer el WAL del `:5433`** (que ya trae los cambios de Kepler por la replicación lógica) y
enviar solo eso. El `:5433` es *subscriber* de Kepler → es *cascading logical replication*.

## ⭐ CDC.0 — RESULTADO (2026-08-21) + hallazgo que reencuadra la fase

**El spike PASÓ (definitivo).** `wal_level=logical` + restart aplicados; un slot `test_decoding` en
`kepler_pilot` capturó **119 cambios en 20s** con las **3 operaciones — INSERT 28 / UPDATE 15 / DELETE 16**
— de tablas Kepler reales (kdm2/kdil/kdik/kdij/kdii/kdue) que **la subscription APLICA**. Confirma:
**subscriber-as-publisher funciona + el DELETE viaja en el WAL** (el win #1). Slot dropeado (sin retener WAL).

**HALLAZGO — ya existe un CDC por TRIGGERS, medio construido y ABANDONADO:** `ods-cdc-setup.js` +
`ods-cdc-forward.js` (en `database/importers/kepler/`). El setup instala `ods.change_queue` + triggers
`ods_cdc` **ENABLE ALWAYS** (truco: normalmente no disparan durante el apply) en las tablas MUTABLES →
encolan `(table_name, op, row_json)` con **OLD para DELETE**; el forwarder drena la cola y empuja el delta
por feeds-ingest (I/U upsert; **DELETE lo DIFIERE — no lo aplica**). Estado medido 2026-08-21:
- **md_03 = 312 triggers ALWAYS · md_02 = 315 · resto (00,01,04,05,06) = 0.** change_queue existe en 02/03.
- **El forwarder NO corre** (ni tarea, ni proceso, ni PM2) → **piloto abandonado**: 600+ triggers vivos
  cobrando impuesto de escritura en cada apply, sin drenador. Cola en 0 (bajo churn; benigno HOY, 72kB) pero
  es estado inconsistente **a resolver sí o sí** (terminar el forwarder O dropear los triggers).

**Dos caminos PROBADOS ahora — decisión (§6):**
| | Trigger-outbox (60% built, abandonado) | WAL-decode (spike ✅) |
|---|---|---|
| Estado | setup+forward codeados; triggers en 2/6 ramas; forwarder sin agendar | mecanismo probado; consumidor por construir |
| Superficie | **300+ triggers × 6 ramas + cola + forwarder** (estado disperso) | **1 slot + 1 consumidor por rama** (centralizado) |
| Costo runtime | **impuesto de escritura** en cada apply (trigger + INSERT extra) | pasivo (lee WAL) |
| Riesgo | cola crece si el forwarder se atrasa; **fácil de dejar a medias** (ya pasó) | slot retiene WAL si el consumidor muere (**monitorable** en pg_replication_slots) |
| DELETE | capturado (OLD) pero **el forwarder lo difiere** (no lo aplica) | capturado y aplicable |

**Recomendación:** **WAL-decode** — el piloto abandonado acaba de demostrar la fragilidad operativa del
approach por triggers (600+ triggers huérfanos, sin consumidor, impuesto de escritura), y el WAL tiene una
superficie más chica y monitorable; `wal_level=logical` ya quedó hecho. **Y retirar los triggers huérfanos**
de md_02/md_03 (cleanup, quitar el impuesto + el estado inconsistente). Alternativa legítima: **terminar el
piloto por triggers** (wire forwarder + 4 ramas + aplicar DELETEs) si se prefiere la cola-tabla visible sobre
el slot. **Decisión de Edgar pendiente.**

## 1. Tesis

`kepler_ods.*` (prod) se alimenta hoy con **2 loops de polling** (`OdsLiveLoop` @15s + `OdsFullMirror` @5min):
por cada tabla del carril hash se **re-lee la tabla ENTERA + md5 de cada fila** vs un shadow local para
descubrir el delta. Es correcto pero: (a) **no propaga DELETE** (UPSERT-only → filas borradas viven para
siempre en prod), (b) quema **CPU/IO local** re-escaneando tablas que no cambiaron, (c) latencia = la cadencia
del poll (5min el frío). El **WAL del `:5433` ya tiene el flujo exacto de cambios** (INSERT/UPDATE/DELETE en
orden de commit) — leerlo elimina las 3 cosas de un golpe.

## 2. Qué gana (3 cosas — la 1ª es la que importa)

1. **Arregla los DELETE** — *correctness*, no eficiencia. Hoy el ODS es UPSERT-only ([`replicate-ods-live.js`
   límite conocido](../../database/importers/kepler/replicate-ods-live.js)); el `:5433` SÍ borra (mirror real),
   pero prod se queda con SKUs descontinuados / folios cancelados para siempre. El WAL trae el evento DELETE
   con su PK → se propaga. El ODS pasa a ser **espejo fiel**.
2. **Real-time en TODO** — sin poll: el cambio viaja al confirmarse el commit en el `:5433`. Muere el corte
   15s/5min (hot/frío) → un solo pipe para todas las tablas.
3. **Cero md5-scan** — solo viajan los cambios reales. Se libera el CPU/IO del `:5433` (contenedor pgvector-md).

## 3. Estado actual VERIFICADO (2026-08-21)

- `:5433` tiene **7 subscriptions activas** (`sub_pilot`=md_03 + `sub_md_00..06`) → recibe los 6+CEDIS en tiempo real ✅.
- `:5433` **`wal_level = replica`** → **NO puede ser publisher / crear slots lógicos todavía**. Prerequisito duro: subir a `logical` + restart del container.
- `max_replication_slots = 10` en `:5433`; `pg_replication_slots` vacío (los slots de las subs viven del lado Kepler, no acá).
- Shipper actual = poll (ctid + hash-delta), sink `FEEDS_SINK=http` → `feeds-ingest` (ingress gratis, ADR-035).
- Prod `kepler_ods` ya poblado (2 loops corriendo) → la migración es **relevo go-forward**, no from-scratch.

## 4. Arquitectura objetivo

```
Kepler POS (6+CEDIS)                :5433 (LAN, pgvector-md)                 Railway (prod)
  publication ods_pub  ──logical──►  kepler_md_XX (subscriber)   ──WAL──►  consumer CDC (LAN, Node)
                                       + publication cdc_pub (NUEVA)          decodifica pgoutput/wal2json
                                       + slot lógico cdc_md_XX                agrega `sucursal`, batchea
                                                                              push HTTP (ingress GRATIS) ─►  feeds-ingest ─►(red privada)─► kepler_ods.kdXX
                                                                              op = upsert | DELETE
```

- **Consumidor** = proceso Node en la LAN (reemplaza `replicate-ods-live`). Recomendado: cliente
  `pg-logical-replication` (npm; decodifica pgoutput/wal2json **in-process**) → mantiene el transform
  (`sucursal`, PK `(sucursal,c1)`) y el push HTTP en un solo lugar, consistente con el stack Node actual.
  Alternativa: `pg_recvlogical` + `wal2json` (requiere el plugin en el container).
- **7 streams** (uno por branch DB) → cada uno etiqueta `sucursal` y empuja. Igual que hoy, pero **event-driven**
  en vez de poll. La fusión 7→1 en `kepler_ods.kdXX` sigue en el consumidor.
- **Sink sin cambios**: `feeds-ingest` (ADR-035). Solo se agrega el **handler `delete`** (hoy solo `raw-upsert`):
  `DELETE FROM kepler_ods.<t> WHERE sucursal=$1 AND <pk>=$2`.
- **Snapshot inicial**: prod ya está poblado → el CDC arranca desde la creación del slot (go-forward). Para una
  tabla NUEVA o un re-sync, se reusa el **shipper de poll como cargador de snapshot** (una corrida `--full`) y
  luego el CDC toma el go-forward. Migración sin ventana ciega.

## 5. Límites / riesgos duros (por qué es una FASE, no un tweak)

1. **`wal_level=logical` + restart** del container pgvector-md. Afecta a `postgres_platform` (dev) + los 7
   `kepler_md_XX` a la vez (breve; las subs de Kepler resumen solas al volver). Agendar.
2. **Retención de WAL / disco** — un slot lógico retiene WAL en `:5433` hasta que el consumidor confirma
   (`confirmed_flush_lsn`). Si el consumidor se cae/atrasa, el WAL **se acumula → llena disco** (mismo riesgo
   que del lado Kepler). Mitigar: `max_slot_wal_keep_size` (dropea el slot si excede → se pierde el delta, se
   re-snapshotea; salva el disco) + **sensor db-health sobre el lag del slot** (`pg_replication_slots`).
3. **Subscriber-as-publisher** — los cambios que el apply-worker de la subscription escribe en el WAL del
   `:5433` SÍ se re-publican en cascada (pgoutput), pero hay que **verificarlo en spike** (CDC.0) y confirmar
   que no hay loop (cadena one-way, sin `origin` circular → OK).
4. **Snapshot vs slot race** — al crear el slot, definir el punto de consistencia (LSN) para que el snapshot y
   el stream no dupliquen ni pierdan. El caso fácil (prod ya poblado) evita esto; sólo aplica a tablas nuevas.
5. **Evolución de esquema (DDL)** — `publication FOR ALL TABLES` auto-incluye tablas nuevas ✅, pero un
   `ALTER TABLE` (columna nueva) necesita que el consumidor tolere el cambio de forma. El schema Kepler es
   estable (ofuscado, no evoluciona) → riesgo bajo, pero el consumidor debe degradar sin romper.
6. **Orden/consistencia** — logical decoding entrega en orden de commit **por slot**; entre los 7 slots no hay
   orden cruzado — irrelevante porque el ODS es por-`sucursal` (cada branch es su propio stream ordenado).
7. **TOAST / filas grandes** — kdmx (CFDI XML), bitácora: UPDATE de columnas TOAST-eadas puede no traer el valor
   completo en el WAL salvo `REPLICA IDENTITY FULL`. Definir REPLICA IDENTITY por tabla (default = PK, suficiente
   para el WHERE del delete; FULL solo si se necesita el old-value completo).

## 6. Decisiones abiertas (→ ADR-047)

- **ADR-047 propuesto**: *el ODS se alimenta por CDC (logical decoding del `:5433`), no por poll; el consumidor
  vive en la LAN y empuja deltas+deletes a `feeds-ingest` (ingress gratis, hereda ADR-035); el poll queda como
  cargador de snapshot y fallback.* Hereda ADR-016 (motor decide / LLM fuera) N/A y ADR-035 (writer en Railway).
- Consumidor: **`pg-logical-replication` (Node)** vs `pg_recvlogical`+wal2json. Recomendado el primero.
- REPLICA IDENTITY: default (PK) global, o FULL selectivo para kdmx/bitácora.
- ¿CDC reemplaza AMBOS loops (hot+full-mirror) o solo el full-mirror? Recomendado: **reemplaza ambos** (un solo
  pipe) una vez validado; hasta entonces corren en paralelo (CDC sombra vs poll autoridad).

## 7. Plan por sprints (orden = riesgo / valor)

- [ ] **CDC.0 — Spike de viabilidad** (⛔ ruta crítica, sin tocar prod). En una copia/branch de prueba:
      `wal_level=logical` + `CREATE PUBLICATION cdc_pub FOR ALL TABLES` + slot en `kepler_md_03` → confirmar
      que los cambios **aplicados por la subscription de Kepler SÍ salen** por el slot (subscriber-as-publisher),
      que el DELETE trae PK, y medir el flujo. **Gate: si no re-publica, replantear.**
- [ ] **CDC.1 — Infra WAL**: `wal_level=logical` + restart agendado; `max_slot_wal_keep_size`; publication +
      slot por los 7 branch DBs; `max_replication_slots` holgado.
- [ ] **CDC.2 — Consumidor (INSERT/UPDATE)**: proceso Node con `pg-logical-replication`, decodifica, agrega
      `sucursal`, batchea, push a `feeds-ingest` (reusa el sink actual). Corre **en SOMBRA** (escribe a un
      `kepler_ods_cdc.*` de prueba o compara) vs el poll que sigue de autoridad.
- [ ] **CDC.3 — DELETE**: handler `delete` en `feeds-ingest` + el consumidor emite el op de borrado. Prueba:
      borrar un SKU en Kepler → verificar que desaparece de `kepler_ods` (hoy no pasa).
- [ ] **CDC.4 — Snapshot + cutover**: reusar el poll `--full` como cargador inicial de lo que falte; punto de
      consistencia; flip de autoridad poll→CDC por tabla o global. Poll queda como fallback.
- [ ] **CDC.5 — Salud del slot**: sensor db-health sobre `pg_replication_slots` (lag/retención) + guard de disco
      en `:5433`. Dead-man's switch: si el consumidor muere, ROJO antes de llenar disco.
- [ ] **CDC.6 — Retiro del poll**: apagar `OdsLiveLoop` + `OdsFullMirror` una vez CDC estable N días. El
      `replicate-ods-live` queda como snapshot/fallback (no se borra).

MVP = CDC.0–CDC.4 (con la 3 = el valor real). CDC.5 es requisito operacional antes de retirar el poll (CDC.6).

## 8. Método de verificación

1. **Spike primero** (CDC.0): la viabilidad del subscriber-as-publisher es el gate — todo lo demás depende.
2. **Sombra**: CDC corre en paralelo al poll; comparar `kepler_ods` (poll) vs el stream CDC (conteos + Σ + un
   DELETE de prueba que el poll NO refleja y el CDC SÍ) antes de flip de autoridad.
3. **Cutover por tabla** donde se pueda (kdm1/kdm2 primero, las calientes), no big-bang.
4. Commit verde por sprint. Actualizar este doc + `03_LOG_REVISIONES.md` + memoria.

## 9. Qué NO cambia (por diseño)

- **`feeds-ingest`** (ADR-035) — el sink y la economía (ingress gratis) son iguales; solo se agrega el op `delete`.
- **`kepler_ods.*`** — el schema destino (columna `sucursal`, PK `(sucursal,c1)`) no cambia; los consumidores
  aguas abajo (feeds normalizados, vistas erp_*, sensores) no se enteran.
- **La replicación Kepler→:5433** (Salto 1) — intacta; el CDC se cuelga de su WAL, no la reemplaza.
- **Los feeds normalizados** (`analytics/commercial/catalog`) — siguen a su cadencia (son cómputo, no copia).
