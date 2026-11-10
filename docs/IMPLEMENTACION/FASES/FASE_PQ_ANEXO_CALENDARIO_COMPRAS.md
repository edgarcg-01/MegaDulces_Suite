# Fase PQ · Anexo C — Calendario de compras: que ningún proveedor se quede rezagado

> Anexo de [`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`](FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md), frente **F2** (agenda de
> proveedores). Reemplaza el alcance de **PQ.3** y lo parte en **PQ.3.1–PQ.3.7**; absorbe la pestaña Ciclo
> de **PQ.4** y la fuente del aviso de **PQ.5**. Método: [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Las decisiones de este anexo se numeran **DC1–DC8** para no confundirlas con las D del plan base.

```
OBJETIVO: sustituir la hoja «2026» del Excel de Compras (la brújula del equipo para no dejar
          proveedores rezagados) por un calendario en la Suite donde todos los proveedores tienen
          ciclo y el estado de cada uno sale de Kepler, no de un color puesto a mano.
MÉTRICA:  proveedores con compra en los últimos 12 meses y ciclo DEFINIDO por la gerencia de compras, HOY
          (2026-11-10): 0 de 356 (sin las 9 claves de sucursal propia; la Suite no tiene captura de
          ciclo usada: 0 manuales).
          → META: 356 de 356 (DC5: todos entran en ciclo) y la hoja 2026 deja de usarse.
CAPA TOPE: C3 (pantalla Compras › Calendario de compras)
ÁREA:      Compras (operan) · Dirección (consulta) · sucursales (compras locales)
DUEÑO:     Francisco (negocio)
ESTADO:    ⬜ — plan escrito; dentro de PQ (🔨), no abre fase.
```

Medido en `pg-prod` (`system_identifier` 7688376744939610156), **sólo lectura**, usuario nominal,
2026-11-10. La hoja de Excel se leyó fuera del repo (no se importa: regla 1; sirve de **testigo**).
⚠️ Repo público: aquí van conteos y puestos, nunca nombres de personas ni montos.

---

## 1. Qué problema resuelve

La hoja 2026 es un bloque por día hábil (219 días, 1,487 renglones, 293 nombres de proveedor): debajo
de cada fecha, los proveedores a los que toca pedirles y, por sucursal, un **color** (se pasó · no se
pasó · requisición · traspaso). Al pedir, el comprador **escribe al proveedor en su siguiente fecha**;
por eso la hoja ya llega al 28-dic. Es «cada N días», no día fijo: de 118 proveedores con 4+
apariciones, sólo 12 caen ≥ 70 % el mismo día de la semana.

La Suite ya tiene la agenda por proveedor (PQ.4, pestaña Ciclo de Pedido) y el aviso «hoy te toca»
(PQ.5), y **no la sustituyó**:

| Medido | Valor |
|---|---|
| Uso de la agenda (`worklist/proveedores`, 30 d) | 39 consultas en 9 días |
| Ciclos capturados a mano en la Suite | 0 (proveedores y canales) |
| Ciclo de la agenda (entregas por almacén) contra el del Excel | razón mediana **0.59**: marca vencido antes de tiempo |
| Ciclo por rondas de órdenes de Kepler (X-A-35, toda la red; la vista PQ.3.1) contra el del Excel | razón mediana 0.82; **42 %** dentro de ±30 %, 74 % dentro de ±50 % |
| «Se pasó el pedido» (verde) con documento X-A-30/35 de Kepler a ±3 días | **67–70 %** (tres sucursales), 57 % (la cuarta); el rojo, 30–39 % |
| Lo mismo contra requisiciones de la Suite | 27 % (el pedido se arma también fuera de la Suite) |

Conclusión: el **estado** del día se puede derivar de Kepler; el **ciclo** no se puede adivinar (Kepler
lo propone, Compras lo confirma: es la D5 ya firmada).

## 2. Qué NO incluye

- El plan comercial con proveedores (TOP semanal, folleto, eventos): es de Mercadotecnia (Francisco,
  2026-11-10). Las temporadas siguen en PQ.94.
- Cambiar la cantidad sugerida con el ciclo confirmado: va en **PQ.6** con antes/después (DC3).
- Importar la hoja de Excel (regla 1). Se usa como control en el paralelo (PQ.3.7).
- Escribir en Kepler.

## 3. Las capas

### C0 · Dato
- **Derivado (vista `commercial.v_purchase_calendar_proposal`, PQ.3.1 🧪):** sobre
  `analytics.erp_purchase_orders` (el decode canónico de la OC X-A-35), por clave de proveedor de
  Kepler y sin las claves de sucursal propia (`TI*`): las **rondas** de OC vivas en 365 días (una ronda
  = las OC dentro de 4 días desde la PRIMERA; elegido contra la hoja entre varias ventanas), el
  **ciclo propuesto** (mediana entre rondas, con 4+ rondas; `compra_continua` si las rondas van
  pegadas), la última ronda por sucursal y la próxima fecha.
  Medido (2026-11-10): 338 claves con OC viva; 241 con ciclo propuesto, 4 en compra continua, 47 con
  2–3 rondas y 46 con una (esos 97 los define a mano la gerencia de compras). ~200–300 ms.
- **Dato propio (tabla nueva, `tenant_id` + auditoría):** el ciclo **definido por la gerencia de
  compras** (DC8) por proveedor (y por proveedor × sucursal cuando es compra local), quién y cuándo; y
  el «hoy no se pide» con motivo y nueva fecha. Nada se copia de Kepler.

### C1 · Dominio
- Próxima fecha = última orden de Kepler + ciclo confirmado (o propuesto, marcado «sin confirmar»).
- **Rezagado** = próxima fecha vencida y sin X-A-30/35 del proveedor desde entonces. Medición inicial
  con el ciclo propuesto de la vista PQ.3.1, **sin validar**: 63 rezagados (> 3 d), 39 (> 14 d); 46
  tocan esta semana (±3 d).
  Incluye proveedores de temporada y los que dejaron de surtir: el calendario los distingue.
- «Hoy no se pide» recorre la fecha y deja el motivo; nunca borra al proveedor del calendario.

### C2 · API
- `GET` calendario (día, semana, mes) en una sola respuesta, con el estado por sucursal ya calculado
  en SQL (sin una llamada por proveedor). < 500 ms.
- `POST` ciclo confirmado y `POST` «hoy no se pide». ⛔ Regla 13: probados contra base real con el
  payload de la pantalla (CI, `pruebas-db`).

### C3 · UI (skill `diseno`; cinco preguntas, §0b)
1. **Qué ve y en qué orden:** los **rezagados** (días de atraso), después **los que tocan hoy**,
   después los próximos 7 días. Por proveedor: sucursales y su estado en palabras («OC 00/0007265 del
   10-nov», «requisición», «sin pedido», «por traspaso»), ciclo y si está confirmado.
2. **Qué no ve:** los colores a mano; la historia completa del proveedor (a un clic); las cantidades
   (están en Pedido).
3. **Accesibilidad:** por nombre de proveedor y de sucursal, nunca por código; buscable; el estado con
   palabra, no sólo color.
4. **Ligado a otro proceso:** **«Armar pedido» abre Pedido con el proveedor y sus sucursales ya
   puestos** (ya existe en PQ.4: se reutiliza); el aviso de Pedido «hoy te toca» lee este calendario.
5. **¿Le toca a este proceso?** Sí: confirmar ciclo, posponer con motivo y armar. El pedido se hace en
   Pedido, no aquí.

**Dónde vive:** menú Compras, grupo **Compra**, renglón propio **«Calendario de compras»** entre Alertas
de abasto y Pedido (se mira antes de pedir; D2 ya pedía la agenda como entrada). Reemplaza la pestaña
Ciclo de Pedido: una sola agenda.

## 4. Decisiones

| # | Decisión | Estado |
|---|---|---|
| DC1 | Las columnas del Excel son las sucursales (antes se revisaba por almacén). Con Pedido la compra se concentra: el calendario es **por proveedor** y el estado por sucursal es información derivada, no captura | ✅ Francisco, 2026-11-10 |
| DC2 | El ciclo se captura **en el calendario** | ✅ Francisco, 2026-11-10 |
| DC3 | El ciclo confirmado **no** cambia la cantidad sugerida hasta PQ.6 (antes/después, commit aparte). Por eso vive en su propia tabla, no en `catalog.suppliers.cadence_days_override` ni en `replenishment_channel`, que ya alimentan al motor | 🟡 Claude, por regla 15; Francisco puede revertirla |
| DC4 | Desde el calendario, «Armar pedido» abre Pedido con el proveedor ya seleccionado | ✅ Francisco, 2026-11-10 |
| DC5 | **Todos** los proveedores entran en ciclo. Universo: los que tienen compra en Kepler en los últimos 12 meses, sin las claves de sucursal propia (356 hoy; 338 con OC viva salen de la vista PQ.3.1, las otras 18 se agregan con ciclo a mano); uno nuevo entra con su primera compra | ✅ Francisco (todos) · universo propuesto por Claude |
| DC6 | Quién entra (ver §4.1) | ✅ Francisco, 2026-11-10 · faltan 3 puestos por confirmar |
| DC7 | Permisos nuevos (ADR-054, una clave por acción): `COMPRAS_CALENDARIO_VER` (consultar), `COMPRAS_CALENDARIO_GESTIONAR` (posponer con motivo) y `COMPRAS_CALENDARIO_CICLO` (definir el ciclo). `COMPRAS_PEDIDO_VER` ya lo tienen 29 roles (cajeros, rutas…), demasiado ancho para esto. «Armar pedido» sigue gateado por los permisos de Pedido | 🟡 Claude |
| DC8 | **Los ciclos los define la gerencia de compras** (rol `gerente_compras`), también los de compra local. Los demás puestos no definen ciclo: consultan, posponen y arman | ✅ Francisco, 2026-11-10 |

### 4.1 Quién entra (DC6), medido contra los roles de prod

| Puesto (Francisco) | Rol en prod | Permiso propuesto |
|---|---|---|
| Gerencia de compras (define los ciclos, DC8) | `gerente_compras` | ver · gestionar · **ciclo** |
| Compras Morelia | `compras_operaciones` (almacén 08) | ver · gestionar |
| Compras Canindo y Zamora Centro | `gerente_compras` (✅ Francisco 2026-11-10) | ver · gestionar · ciclo (por rol); el calendario abre en 05 y 06 con una regla de alcance del área (PQ.3.6) |
| Recepción de mercancía Padre Hidalgo | `auxiliar_compras` (✅ Francisco 2026-11-10) | ver · gestionar |
| Gerentes de zona (3) | rol de plataforma, puesto `jefe_zona` (✅ Francisco 2026-11-10) | ver. Su zona en el calendario con una regla de alcance del área, como `[COT.20]`: 07–08 · 05–06 · 01–04 |
| Dirección General y Dirección Comercial | `direccion` | ver |
| Encargados de sucursal (compras locales) | `encargado_tienda` | ver · gestionar, sólo los proveedores de su sucursal |
| Almacenistas de sucursal (compras locales) | `almacenista` | ver · gestionar, sólo los proveedores de su sucursal |

DC8 se sostiene con la **bitácora**, no sólo con el permiso: la tabla de ciclos guarda quién lo definió
y la pantalla lo muestra («definido por gerencia de compras» o por otro puesto). Los dos puestos con
`gerente_compras` pueden definir ciclo.

Compras locales: en Kepler sólo 5 claves compran en una sola sucursal fuera del CEDIS;
las compras de tienda en Wincaja (`WIN_C`) **NO MEDIDAS** todavía para el calendario.

## 5. Riesgos y bloqueos

- **R1** El ciclo de Kepler no reproduce el del Excel en 60 % de los proveedores: por eso se confirma.
  Mientras no se confirme, el calendario lo dice («sin confirmar»), no lo calla.
- **R2** Rezagado incluye proveedores de temporada o dados de baja: necesitan «fuera de ciclo hasta
  <fecha>» con motivo, no quedarse rojos para siempre.
- **R3** ~~Los 3 puestos sin rol claro~~ — contestado por Francisco el 2026-11-10 (§4.1). Queda: las
  reglas de alcance por área para la gerencia de Canindo/Zamora y los 3 gerentes de zona.
- **R4** 24 claves con OC viva en Kepler sólo tienen una ficha **borrada** en la Suite: la
  consolidación de duplicados del 2026-07-20 dejó viva otra ficha con otra clave. La vista lo declara
  (`supplier_record`), no casa por nombre. El arreglo del catálogo toca más módulos: dueño por decidir.
- **R5** En 62 de las 314 claves con ficha viva, el proveedor de la OC no es el `supplier_id` de esos productos en Pedido:
  «Armar pedido» lo resuelve en PQ.3.5.

## 6. Items (en el tracker como PQ.3.1–PQ.3.7)

| # | Entregable | Capa |
|---|---|---|
| PQ.3.1 | Vista derivada: rondas de OC por proveedor, ciclo propuesto, última ronda por sucursal y próxima fecha. Control contra la hoja 2026: ±30 % en ≥ 40 % | C0 |
| PQ.3.2 | Tabla de ciclo confirmado (+ sucursal en compra local) y de «hoy no se pide»; migración generada | C0→C1 |
| PQ.3.3 | Rezagado, próxima fecha y posponer, en dominio, y el estado del día por sucursal (control: el verde de la hoja con documento de Kepler ≥ 67 %); prueba con negativa (rezagado que no lo es) | C1 |
| PQ.3.4 | API del calendario y las dos escrituras, probadas contra base real con el payload de la pantalla | C2 |
| PQ.3.5 | Pantalla «Calendario de compras» (Hoy · Semana · Mes · Sin ciclo), «Armar pedido» hacia Pedido; reemplaza la pestaña Ciclo; el aviso de Pedido lee el calendario | C3 |
| PQ.3.6 | Permisos repartidos según §4.1 (regla 20) y alcance por sucursal para compras locales | C2/C3 |
| PQ.3.7 | Paralelo de 2 semanas contra la hoja 2026: cada día, lo que lista el Excel sale en el calendario; con eso se retira la hoja | — |

## 7. Definición de Terminado

1. 356 de 356 proveedores del universo con ciclo definido (o «fuera de ciclo» con motivo).
2. El estado de hoy por sucursal sale de Kepler y concuerda con la hoja en el paralelo.
3. Permisos repartidos en prod a los puestos de §4.1.
4. La hoja 2026 se deja de usar (lo confirma la gerencia de compras).
5. Lo no medido se declara.

## 8. Bitácora

| Fecha | Qué | Quién |
|---|---|---|
| 2026-11-10 | Lectura de la hoja 2026 y cruces contra Kepler y la Suite; DC1, DC2, DC4–DC6 y DC8 de Francisco; plan escrito | Francisco + sesión Claude |
| 2026-11-10 | **PQ.3.1 🧪**: vista `commercial.v_purchase_calendar_proposal` (mig `20261110015037`, sin aplicar). Primera versión: rondas ENCADENADAS (cada OC contra la anterior), 48 % en ±30 % contra la hoja. La primera versión tardaba 106 s (CTEs unidos); se reescribió | sesión Claude |
| 2026-11-10 | **Revisión independiente** (otro agente) antes del PR: la ronda encadenada juntaba a quien se le pide a diario en UNA ronda de 313 días («una compra» con 366 OC) y dejaba próximas fechas antes de la última OC; 9 claves eran sucursales propias (`TI*`); 4 huecos en la prueba. Corregido: la ronda se acota desde su INICIO (recursión sobre los días de cada proveedor), `compra_continua` sin ciclo para rondas pegadas, fuera las `TI`, `last_order_date`. Contra la hoja con la regla corregida: 42 % en ±30 %, 74 % en ±50 % (la versión encadenada ganaba en el control porque fallaba justo con proveedores que la hoja no tiene). Universo 338 (de 356); 241 propuesto · 4 compra continua · 47 pocas · 46 una; 24 fichas borradas; ~200–300 ms. Prueba 17/17 contra prod, 8 mutantes + 1 del cruce de fichas en rojo | sesión Claude |
