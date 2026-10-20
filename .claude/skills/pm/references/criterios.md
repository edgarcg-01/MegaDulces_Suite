# Criterios del PM — qué importa más, y de dónde sale cada regla

Cada criterio cita su origen en el repo. No son opinión: son lo que ya costó o lo que ya se valoró.
Si un criterio y un hecho medido hoy se contradicen, gana el hecho y se corrige acá.

---

## 1. Cómo se prioriza (el orden, y por qué)

Se ordena por **lo que cuesta no hacerlo, medido en dinero o en operación detenida**, nunca por
lo interesante o lo fácil.

| # | Clase | Ejemplo real | Por qué va ahí |
|---|---|---|---|
| **1** | **Dinero que se para o se pierde HOY**, u operación que no puede cerrar | CGA frente A: 4 camionetas vendieron **$213,940.09** (13–15 oct) que no llegaron al libro. `denom_key`: el arqueo **no se pudo cerrar en 8 días** | Cada día que pasa crece y nadie lo ve |
| **2** | **Una cifra publicada que es falsa** y alguien decide con ella | ADR-051: 3.3 pp de margen falso por mezclar pieza y caja. CANON.0.1: costos 32× | Una decisión mala tomada con un número malo cuesta más que el bug |
| **3** | **Cerrar lo que ya está a un paso** (🧪 o ⚠️ con causa conocida) | Fase 0: 330 🧪 + 271 ⚠️ contra 395 ✅ | Libera cupo, y lo construido y no aterrizado es inversión parada |
| **4** | **Deuda grande pero invisible**, sin sangrado diario | CGA frente C: **$38.5 M** de deuda a proveedores sin dónde verse | Importa, pero no empeora mañana |
| **5** | **Algo nuevo** | — | Sólo con cupo (≤4 🔨) y métrica medida HOY |

Reglas que mueven un item dentro del orden:
- **Sin árbitro, no hay código.** Si lo único contra qué verificar el dato es el propio dato
  (árbitro circular), el frente **arranca con una decisión, no con una migración** — aunque el
  monto sea grande. *Origen: CGA frente B, vecinal (34 % de su dinero ya ofrecido por otra rama).*
- **Lo barato primero dentro de la misma clase.** Si C1–C3 ya existen y probaron, el frente que sólo
  necesita C0 va antes. *Origen: CGA orden 1º.*
- **Llegar tarde cuesta coordinación.** Si otra sesión ya escribe en la misma tabla, sube un puesto.
  *Origen: CGA frente C, `supplier_payment_obligations`.*

---

## 2. Cómo se acota un pedido

1. **Registrar el pedido literal y cómo cambió**, en orden, con la cita. El alcance se mueve en la
   conversación y la primera medición puede quedar verdadera pero fuera de objetivo.
   *Origen: `FASE_CG_ALCANCE` §0 — cuatro versiones del pedido en un día.*
2. **Separar el universo del trabajo.** El universo es lo que existe; el trabajo es lo que entra.
   «13,316 pendientes» era el universo; **el trabajo eran 110, y 103 de verdad** (7 eran errores de
   fecha de Kepler). Decirlo evita que alguien cite el número grande.
3. **Escribir qué NO incluye.** Es la sección que más malentendidos ahorra
   (`_PLANTILLA_FASE.md` §2; ONBOARDING §8.0b punto 4: *«casi nunca se dice»*).
4. **Un plan hermano no es un plan rival.** Si ya hay doc de fase, se agrega un anexo y se dice qué
   cubre cada uno (`CGP` arregla el arqueo, `CGA` tapa de dónde entra el dinero).

---

## 3. Cómo se sabe que un hecho es un hecho

- **Medido en prod, de sólo lectura, con `system_identifier`.** `pg-prod` `192.168.0.222:5434`,
  `SET default_transaction_read_only = on`, y la consulta junto a la cifra. Nunca Railway (prod
  vieja: medir ahí «triunfa en el lugar equivocado»). Nunca levantando el backend local.
- **Cada cifra con su unidad y su universo**: pieza/caja/pesos, con/sin IVA, qué sucursales, desde
  qué fecha, por fecha de captura o de valor.
- **Contrastado con un testigo independiente** del mismo ERP y grano (ADR-059, `VERDAD_ABSOLUTA`).
- **Un escéptico intenta refutarlo.** *«La aritmética se reproduce al centavo… pero la implicación
  no se sigue»*: en CGA cayeron 43 de 46 conclusiones; los hechos aguantaron. **Los hechos se
  publican; las conclusiones se leen con pinzas.**
- **Lo que creíamos y cayó, se escribe.** Tabla «lo que decía → lo que midió prod». Evita que otra
  sesión lo reconstruya (`VERDAD_ABSOLUTA` guarda las hipótesis refutadas por eso).
- **Feed verde ≠ dato vivo.** `rows_affected = 0` puede ser «la tubería murió» o «el origen dejó de
  escribirse». Lo distingue un **control hermano** que sí avanza. *Origen: Caja General, el Access
  dejó de escribirse el 10-oct a propósito.*
- **Cero filas por un defecto es indistinguible de cero filas por desuso.** Descartar el defecto
  antes de decir «nadie lo usa». *Origen: arqueo, 8 días en cero leídos como falta de adopción.*
- **Una maqueta o una auditoría no es una medición.** Reproducir la cifra con el dato real antes de
  llevársela a un dueño, o decir «sale de un mockup, NO MEDIDO» (§8.0b punto 22).

---

## 4. Cómo se decide

- **Lo que no puede decidir el código se convierte en una decisión numerada** (`D1…Dn`) con
  opciones, **una recomendación con su porqué**, y quién firma. *Origen: `FASE_VAC` §1.*
- **El conflicto con una regla se expone, no se resuelve en silencio.** Si negocio decide algo que
  choca con el sistema (el mayoreo manda en el verificador, `--action` fuera de CTA), decide el
  dueño y **la excepción queda acotada y escrita** con su razón (§8.0b punto 21).
- **Cuando el dueño contradice la recomendación**, se hace como lo pidió y queda escrito por qué
  (§8.0b punto 28). El PM recomienda; no gana por cansancio.
- **Una decisión pendiente bloquea sólo lo que depende de ella.** Marcar qué capas NO dependen
  (la piel del verificador, D1, «es una puerta: ninguna otra capa depende de ella»).

Quiénes firman, según lo que muestra el repo: **Edgar** (lead, alcance técnico y de fase),
**0Sistemas** (decisiones de producto/diseño, p. ej. VAC D1/D4), **Dirección General** (Luis
Francisco López: presupuesto y prioridades de negocio). Si no se sabe quién firma, se pregunta.

---

## 5. Criterios de producto (la mirada del PM sobre una pantalla)

Salen de la auditoría del PM al verificador de precios (ONBOARDING §8.0b, puntos 18–22).

1. **Coherencia de negocio antes que brillo.** Si la escalera de precios sube por unidad al comprar
   más, mejorar su presentación **amplifica el defecto**. Se declara con dueño (Precios/Comercial)
   y con el conteo de SKUs afectados o «NO MEDIDO»; no se tapa con UI.
2. **Una cifra se compara en la MISMA unidad.** No pegar un total a un % unitario, ni poner juntos
   dos mínimos en unidades distintas (3 piezas vs 12 paquetes = 144 piezas). La cifra principal va
   por unidad y el total de apoyo; la equivalencia la calcula el servidor una vez.
3. **Un dato que se calcula, viaja y no se pinta es un hallazgo.** Se pinta o se retira.
4. **Diseñar para la distancia de uso y la carga de decisión.** Un kiosco se lee a 1–2 m; cinco
   precios con dos cifras héroe compiten entre sí.
5. **Error ≠ vacío ≠ sin dato.** Tres estados distintos en pantalla. «$0 vendido» con las cajas
   cobrando es un cero que parece dato (SM.13).
6. **El puesto real, no "el usuario".** Quién lo usa sale de `MATRIZ_ACCESOS.md`; qué ve y qué no
   (la cajera ve lo suyo, la encargada la tienda: SM.12).

---

## 6. Cómo se cierra

- **Las 7 del DoD** (`METODO_DE_TRABAJO.md` §5), todas. No hay ✅ parcial.
- **El antes/después con la misma consulta.** Un commit que cambia un número no cierra sin eso.
- **Lo que no se pudo ver se declara**: «sin validación visual», con lo más probable de ajustar.
- **Lo que no corrió no es "ajeno": es NO MEDIDO** para este cambio (§8.0b punto 31).
- **Registrado.** Trabajo con commits y sin items en el tracker es trabajo que nadie puede auditar
  (lo detecta `tablero.js`).
