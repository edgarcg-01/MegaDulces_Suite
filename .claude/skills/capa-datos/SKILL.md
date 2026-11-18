---
name: capa-datos
description: Capa C0 (Dato) de la suite — de dónde sale un número y con qué se comprueba. OBLIGATORIO antes de crear o cambiar una vista, matview, tabla, columna, migración, consulta SQL o cualquier cifra que se vaya a publicar, y antes de afirmar que un dato "está bien". Cubre derive-no-copy sobre kepler_ods/wincaja, arbitraje contra testigo (ADR-059), unidades, dinero, lo NO MEDIDO (ADR-056) y migraciones Knex. Se invoca con dato, cifra, número, vista, matview, tabla, columna, migración, SQL, query, knex, ODS, Kepler, Wincaja, existencia, ventas, costo, unidades, cajas, piezas, "de dónde sale", "no cuadra", "da otro número", "está en cero".
---

# C0 · Dato — el número antes que la pantalla

> La capa que más ha costado en este repo. `VERDAD_ABSOLUTA.md` tiene **37 secciones** y casi
> todas empiezan con un número que se publicó mal durante semanas. La ley vive ahí y en
> [`docs/GOTCHAS.md`](../../../docs/GOTCHAS.md); esta skill es **el orden en que se aplica**.
> Si se contradicen, gana el documento y se corrige aquí.

## Antes de escribir SQL: cinco preguntas

1. **¿De dónde sale?** Búscalo en [`REGISTRO_CANONICO_COMPLETO.md`](../../../docs/REGISTRO_CANONICO_COMPLETO.md).
   Si ya hay un **resolvedor canónico** para esa pregunta (`VERDAD_ABSOLUTA.md` §5), se lee ese;
   no se arma otro camino al mismo número.
2. **¿Se deriva del ODS?** Todo dato sale de `kepler_ods.*` (o `wincaja.*` solo para históricos,
   §8), de **una tabla principal**, por **vista**. Si no se puede derivar: **parar y decirlo**
   (regla 1). ⛔ Nada de importers, nada de `*_bak` ni copias en otro schema (regla 2).
3. **¿En qué unidad está?** Pieza, caja o presentación: hay **tres** unidades, no una
   (`VERDAD_ABSOLUTA.md` §31, [`UNIDADES_DE_MEDIDA.md`](../../../docs/UNIDADES_DE_MEDIDA.md)). La unidad
   **no se hereda de la fuente**: se prueba en la tabla que el consumidor lee (ADR-055).
4. **¿Con qué se arbitra?** Un testigo **independiente, del mismo ERP y del mismo grano**
   (ADR-059, reglas R1–R3). Kepler contra Kepler. El dinero arbitra la cantidad; el costo arbitra
   mejor que el precio.
5. **¿Qué pasa cuando falta?** NULL con una etiqueta que diga **por qué** falta, nunca `0`
   (R4, ADR-056). Ausencias distintas llevan etiquetas distintas.

## Medir: dónde, y cómo no engañarse

- ⛔ **Prod es `md`, no Railway.** El `FLEET_DB_URL` del `.env` local todavía apunta al clúster
  viejo y congelado. Antes de cualquier medición, confirma el destino por **`system_identifier`**,
  nunca por el nombre de la base (las dos se llaman `railway`). Ver «Datos del entorno» en
  `CLAUDE.md`.
- Las mediciones contra prod son **de solo lectura**. Nunca la laptop escribiendo en prod.
- **Valida las consultas de Knex ejecutándolas por Knex**, no por `psql`: el `?` dentro de un
  literal se convierte en `$1` en silencio (`GOTCHAS.md` §5). Un SQL ajeno (`pg_get_viewdef`)
  va por un cliente `pg` directo.
- ¿Una columna existe? Pregúntale a **`pg_attribute`**, no a `information_schema` (que no lista
  matviews). Y después mide una **invariante del dato**: que exista no dice que esté bien poblada.
- Busca el patrón **en lo incorrecto** (R6): agrupa el error por sucursal, por SKU y **por pesos**,
  no por filas. 100 filas pueden cargar la mitad de la brecha.
- Desconfía de tu consulta cuando el número sorprende: folios reciclados (§31), filas duplicadas
  por el +6 h del ODS (§21), filas borradas aguas arriba que el ODS conserva (§22).

## Construir

| Qué | Cómo | Dónde está la regla |
|---|---|---|
| Vista nueva | `derive-no-copy` sobre la tabla principal. Revisa el **gate de costo**: no todo lo derivable puede ser vista normal | `GOTCHAS.md` §19, §28 |
| Matview | Solo si la vista no aguanta el costo medido. Su refresco es **escritura pesada**: fuera de horario hábil | Regla 9 |
| Tabla nueva | `tenant_id` UUID NOT NULL + campos de auditoría, snake_case, inglés salvo término de dominio, RLS | Regla 18, ADR-010 |
| Columna `NOT NULL` o PK nueva | Recorrer **todos** los caminos que insertan en la tabla: servicios, feeds, crons, seeds, migraciones | Regla 14 |
| Dinero | `numeric` en la base. Llega como **string** por JSON: el consumidor lo coerciona | `GOTCHAS.md` §6 |
| Resolvedor nuevo en §5 | Lleva **paridad registrada** (lo publicado contra el árbitro) o el motivo escrito de por qué no | R7, `test-newdb-truth-parity.js` |

### Migraciones

- **Se generan:** `node scripts/nueva-migracion.js <nombre>`. ⚠️ `npm run migrate:new` **no crea
  nada**: corre `migrate:latest`.
- **Guard idempotente** al inicio (`hasTable` / `hasColumn`), siempre.
- ⛔ **Nunca** agregar columnas a una migración ya aplicada: Knex no la vuelve a correr y prod
  nunca recibe lo agregado. Lo nuevo va en **archivo nuevo**.
- ⛔ Nunca borrar ni renombrar una migración aplicada, ni insertar filas a mano en `knex_migrations`.
- Hay **cuatro** carpetas de migraciones y **dos** `knex_migrations`; el `search_path` puede darte
  la equivocada (`GOTCHAS.md` §29).
- En prod: **una por una** con `database/scripts/apply-one-migration-prod.js`, nunca
  `migrate:latest`. El carril completo está en la skill `entrega` §5.
- `CREATE INDEX CONCURRENTLY` y `ALTER TABLE` que esperan candado: leer `entrega` §5 y
  `GOTCHAS.md` §38 **antes**.

## Verificado cuando

- [ ] El origen está escrito (tabla principal del ODS) y la vista lo deriva sin copiar.
- [ ] La unidad está probada **de los dos lados** (fuente y consumidor).
- [ ] La cifra se cruzó contra un testigo independiente, con la consulta, el resultado y la
      **fecha** de la medición.
- [ ] Lo que no cuadra o no se pudo medir quedó **declarado**, con monto si lo hay.
- [ ] Si un número publicado cambió: medición antes/después con la misma consulta (regla 15).
- [ ] La migración es idempotente y se probó en la réplica de desarrollo, no solo en local.

## Lo que se reporta

```text
C0  origen: kepler_ods.<tabla> → <vista>
    unidad: <pieza|caja|presentación>, probada en <dónde>
    árbitro: <testigo> — <n> de <N> cuadran (<fecha>) · no cuadra: <n> por $<monto>, causa <…>
    NO MEDIDO: <qué, y por qué>
```
