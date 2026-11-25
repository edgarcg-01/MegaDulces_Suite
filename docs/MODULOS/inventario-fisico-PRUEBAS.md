# Inventario físico — plan de pruebas con Playwright

> **Para quien ejecuta.** Cada renglón es una prueba: se provoca a propósito, se anota lo que se
> vio y se firma. ⛔ **Un renglón sin anotar no es «pasó»: es NO MEDIDO** (ADR-056).
>
> Cómo funciona el módulo: [`inventario-fisico.md`](inventario-fisico.md). Este plan sólo dice
> **qué se rompe a propósito y qué tiene que pasar**.

**Estado al escribirlo (2026-11-25):** nunca se cerró un folio en producción —6 folios, los 6
cancelados; 7 renglones contados de 18,845; 0 exportaciones a Kepler—. Todo lo de abajo se prueba
**por primera vez**: no hay un «antes» con qué comparar, y por eso cada prueba anota lo que vio,
no sólo si pasó.

---

## Las seis personas, cada una con su plan

⛔ **Las pruebas no son las mismas para cada quien, y por eso cada persona tiene su archivo.** Lo
que el supervisor hace mal (abrir a ciegas sobre una sucursal que no ve) no se parece a lo que el
contador hace mal (teclear 100 donde iban 10), ni a lo que el ajeno tiene que no poder hacer.

| # | Persona | Permiso | En prod | Su plan |
|---|---|---|---:|---|
| 1 | **Supervisor de oficina** | `SUPERVISAR` | 21 | [`1-supervisor-de-oficina.md`](pruebas-inventario-fisico/1-supervisor-de-oficina.md) |
| 2 | **Encargado de tienda** | `ASIGNAR` | 38 | [`2-encargado-de-tienda.md`](pruebas-inventario-fisico/2-encargado-de-tienda.md) |
| 3 | **Almacenista contador** | `CONTAR` o asignado | 31 | [`3-almacenista-contador.md`](pruebas-inventario-fisico/3-almacenista-contador.md) |
| 4 | **Reconciliador** | `RECONCILIAR` | 17 | [`4-reconciliador.md`](pruebas-inventario-fisico/4-reconciliador.md) ⛔ suspendido |
| 5 | **Prevención y observadores** | `VER` | 54 | [`5-prevencion-observador.md`](pruebas-inventario-fisico/5-prevencion-observador.md) |
| 6 | **El ajeno** | ninguno | el resto | [`6-ajeno-sin-permiso.md`](pruebas-inventario-fisico/6-ajeno-sin-permiso.md) |

⛔⛔ **Probar con un admin no sirve.** Los roles de plataforma pasan por god-mode y un permiso que
nadie repartió **sale verde igual**. Cada bloque se corre con un usuario que tenga **exactamente**
ese permiso y ninguno más.

### Dos cosas medidas que cambian el plan

1. ⭐⭐ **El contador no está en un teléfono: está en Windows.** De los 11 `almacenista`, **6
   entran desde Windows, 1 desde Android y 4 nunca han entrado**. Todo el diseño offline-first
   está pensado para un pasillo sin señal, y la gente que lo usaría está en una computadora. No
   invalida el offline —una laptop también pierde la red— pero **las pruebas van con teclado, no
   con gestos**, y «perder el teléfono» se vuelve «contar desde otra máquina».
2. ⭐ **Quien abre el folio no está en la sucursal.** Ni un `almacenista` ni un `encargado_tienda`
   tiene `SUPERVISAR`: los 21 son de oficina. Y **5 de ellos son `marketing`**, que puede abrir y
   congelar un almacén pero **no cerrarlo**.

---

## 0. ⛔⛔ Antes de escribir una línea: contra qué se prueba

**No está decidido, y hay que decidirlo primero**, porque cambia qué pruebas son posibles.

Hoy el repo tiene Playwright instalado y suites en [`e2e/`](../../e2e/), pero **ninguna apunta a
la aplicación corriendo**: todas abren un prototipo estático por `file://`. No hay `baseURL`, ni
`webServer`, ni ayudante de sesión. La razón está escrita en el config de `e2e/caja-general`:
levantar el front o el back en local está prohibido (regla 3), así que las suites existentes
prueban **el contrato**, no la pantalla real.

### D-PW1 · Dónde corren estas pruebas — decide el PM

| Opción | Qué permite | Qué cuesta | Veredicto |
|---|---|---|---|
| **A · Contra producción** | todo, con datos reales | ⛔ exige credenciales reales (prohibido) y **cada folio abierto congela un almacén de verdad** | **No.** La primera prueba de escritura deja basura en prod |
| **B · Carril de CI que levanta la pila** | **todo**, incluido el cierre y los tiempos | [`boot-api.yml`](../../.github/workflows/boot-api.yml) ya arma Postgres desde cero, migra, siembra el tenant, compila y arranca la API — pero **arranca y se apaga**. Falta dejarla viva en el puerto, sembrar un acceso y servir el front | ⭐ **Recomendada.** La única que cumple la regla 13: un endpoint que escribe no está probado hasta ejercerlo contra base real |
| **C · Front servido + API simulada (`page.route`)** | los errores **humanos y de diseño**, y los estados que hoy no existen (folio a medias, 500 del servidor, red caída) | no prueba nada del servidor | Buena **como complemento**, no como sustituto |

⭐ **Recomendación:** armar **B** para lo marcado `[B]`, usar **C** para lo marcado `[C]`.
Lo `[C]` se puede empezar **hoy**.

### Nivel de evidencia de cada renglón

- **`[C]`** se ve en el navegador con la API simulada → se puede hacer ya.
- **`[B]`** necesita servidor y base reales → espera a D-PW1.
- **`[M]`** se **mide**: el renglón anota el número, no «pasó».

---

## 7. Transversales — no son de nadie y le pegan a todos

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `TRV-01` | ⛔ Abrir un folio con **el ODS atrasado** para esa sucursal | Hoy `openCount` **no consulta la frescura del ODS** ni la declara: el folio nace con un teórico viejo y nada avisa. Tiene que declarar **de cuándo es la foto** | 🔴 | B |
| `TRV-02` | **Dos pestañas** con el mismo folio, capturando en las dos | Anotar si se pisan | 🟠 | C |
| `TRV-03` | La **misma persona** en dos máquinas | Anotar qué pasa con las dos colas | 🟠 | B |
| `TRV-04` | Congelar un almacén y **pedir un pedido** desde la Suite | Rechazo nombrando el folio | 🟠 | B |
| `TRV-05` | ⛔⛔ Congelar un almacén y **vender por el POS** | **No se frena, y no se puede frenar**: la Suite no escribe en Kepler. Verificar que cuando menos **quede registrado** que el teórico se movió | 🔴 | B |
| `TRV-06` | Toda la suite **sin internet** (cae la ingesta) | Anotar qué sigue funcionando del módulo | 🟠 | B |
| `TRV-07` | El contraste de cada texto, claro y oscuro | Ya medido en código: pasa AA en los diez colores. Verificarlo **sobre lo pintado** | 🟡 | C |
| `TRV-08` | La lista con **200 folios** (el tope) | Avisa que hay tope; medir el tiempo (gate: 500 ms) | 🟠 | B·M |
| `TRV-09` | **Alto Contraste de Windows** en las tres pantallas | La flota **es** Windows y esto nunca se midió | 🟠 | C |

---

## 8. Cómo se anota

| ID | Fecha | Quién | Resultado | Lo que se vio | Evidencia |
|---|---|---|---|---|---|
| `CNT-C9` | | | ✅ / ❌ / **NO MEDIDO** | en una frase, lo que de verdad pasó | traza de Playwright, captura, o el número |

1. ⛔ **Un renglón sin correr se anota NO MEDIDO**, nunca en blanco ni asumido verde.
2. Los renglones **`·M`** anotan **el número**. «Reconcilió» no vale; «reconcilió 4,819 renglones
   en 41 s» sí.
3. Un ❌ se anota **aunque ya se sepa** que está mal: la prueba convierte el diagnóstico en
   evidencia reproducible.
4. ⭐ **Toda prueba que afirme que un candado funciona tiene que romperlo primero.** Un guard que
   nunca se vio en rojo es una intención, no un guard.

---

## 9. Por dónde empezar

Si hay medio día y no el plan entero:

1. **[`6-ajeno`](pruebas-inventario-fisico/6-ajeno-sin-permiso.md) · `AJE-2a`** — los 29 endpoints
   con un usuario sin permiso. Son 29 llamadas y es lo que más cobra si falta un candado.
2. **[`4-reconciliador`](pruebas-inventario-fisico/4-reconciliador.md) · `REC-C1`** — medir el
   cierre con 4,819 renglones contra el tope de 60 s. Si no cabe, nada más importa.
3. **[`3-contador`](pruebas-inventario-fisico/3-almacenista-contador.md) · `CNT-C1` a `CNT-C10`** —
   el camino offline completo. Es donde vive el trabajo de la gente.
4. **[`1-supervisor`](pruebas-inventario-fisico/1-supervisor-de-oficina.md) · `SUP-D1`** — el
   fallo que se lee como «no hay folios». Barato, y hoy engaña.
5. **[`4-reconciliador`](pruebas-inventario-fisico/4-reconciliador.md) · `REC-V1`** — el cierre con
   ventas del POS en medio. Es el que puede destruir existencia.

El resto, por severidad: primero las 🔴, después las 🟠.
