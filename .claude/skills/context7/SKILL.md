---
name: context7
description: Documentación VIGENTE de una librería o framework, traída de Context7 en vez de la memoria del modelo. OBLIGATORIA antes de escribir o corregir código que llama a una API ajena de este stack — NestJS 11, Angular standalone, PrimeNG, Tailwind, Knex, Nx, Socket.IO, Capacitor, Dexie, vitest, el SDK de Postgres — y ante cualquier «no me acuerdo de la firma», decorador, opción de configuración, migración de versión o mensaje de error que venga de una dependencia. ⛔ NO para nada de ESTE negocio (Kepler, el ODS, nuestras tablas, nuestras cifras): eso se mide, no se consulta afuera. Se invoca con context7, documentación, docs de la librería, API de, firma de, cómo se usa, versión, breaking change, migrar a, "esto cambió en", deprecado.
---

# Context7 — la documentación de lo ajeno, al día

> ⭐ Existe por una razón concreta: **la memoria del modelo tiene fecha de corte y las librerías no.**
> Este repo ya pagó eso. Casos medidos de este mismo mes: `npm run migrate:new` **no crea nada**
> —corre `migrate:latest`—, `b.name` tiró `/filters` entero porque la columna de `catalog.brands`
> se llama `nombre`, y un `import` sin `type` en una firma decorada rompe el build con `TS1272`.
> Los tres son «yo creía que la API era así».
>
> ⛔ **Lo que Context7 NO arregla:** que la cifra esté bien. Las docs dicen cómo se llama el método,
> no qué dicen nuestros datos. Eso sigue saliendo de medir prod, de [`VERDAD_ABSOLUTA.md`](../../../docs/VERDAD_ABSOLUTA.md)
> y de [`ERP_KEPLER.md`](../../../docs/ERP_KEPLER.md).

## Cómo se usa

Dos herramientas, en este orden:

1. **`resolve-library-id`** — el nombre del paquete («@nestjs/common», «primeng», «knex») → el id que
   Context7 entiende. Sin este paso el segundo adivina.
2. **`query-docs`** — el id más la pregunta técnica concreta, en inglés, lo más angosta posible
   («how to type a decorated parameter with isolatedModules», no «nestjs decorators»).

Si la respuesta vuelve pobre o de otra versión, **decilo y seguí**: una doc que no corresponde a la
versión que tenemos es peor que no tenerla. La versión que corre está en `package.json`, no en la doc.

## ⛔⛔ Qué NO se manda a Context7

Es un **servicio externo**: todo lo que se le escribe sale de la empresa.

- ⛔ Nada del negocio: nombres de nuestras tablas, de sucursales, de personas, de clientes o
  proveedores, folios, claves de Kepler, montos, ninguna cifra.
- ⛔ Nada de nuestra infraestructura: IPs, hosts, nombres de deployments, cadenas de conexión.
- ⛔ Nada de código nuestro pegado entero «para que lo vea». Si hace falta mostrar código, se
  reescribe el pedazo con nombres neutros.
- ✅ Sí: el nombre del paquete, su versión, la firma de la API ajena y el mensaje de error **tal como
  lo imprime la librería**, sin nuestras rutas.

*El repo es público y los datos del negocio no lo son.* Un nombre de proveedor dentro de una consulta
a un tercero es una fuga, aunque la consulta sea técnica.

## Cuándo manda OTRA skill

| Lo que vas a hacer | Skill |
|---|---|
| HTML, CSS o JS de navegador (diálogos, tablas, dark mode, accesibilidad, CWV) | **`modern-web-guidance`** primero — es obligatoria y cubre la plataforma web, no las librerías |
| Escribir o cambiar frontend de esta suite | **`diseno`** (obligatoria) |
| Juzgar una pantalla ya construida | **`auditoria-diseno`** |
| Tocar el carril de entrega | **`entrega`** |
| Entender un número, una tabla o un `cN` de Kepler | **ninguna skill**: se mide contra prod y se contrasta |

Context7 entra **adentro** de cualquiera de ésas, cuando la duda es «cómo se llama esto en la
librería», nunca en lugar de ellas.

## Cómo quedó instalado (2026-11-23)

Servidor MCP por HTTP en el [`.mcp.json`](../../../.mcp.json) del proyecto, al lado de `playwright`,
`chrome-devtools` y `stitch`:

```json
"context7": { "type": "http", "url": "https://mcp.context7.com/mcp" }
```

Comprobado el mismo día contra el servidor vivo: contesta `initialize` con **Context7 v4.7.3** y
expone `resolve-library-id` y `query-docs`.

- **Sin API key, a propósito.** La clave es opcional (sólo sube el límite de peticiones y abre repos
  privados) y **el repo es público**: una clave en `.mcp.json` se publica. Si el límite llega a
  estorbar, cada quien pone la suya **en su propia máquina**, fuera del repo:

  ```bash
  claude mcp add --scope user --transport http \
    --header "CONTEXT7_API_KEY: <tu clave de context7.com/dashboard>" \
    context7 https://mcp.context7.com/mcp
  ```

  ⚠️ Esa entrada de alcance `user` **gana** sobre la del proyecto; es lo que se quiere, pero si un día
  Context7 «deja de contestar» en una sola máquina, mirá ahí antes que acá.
- **Hay que reiniciar la sesión** para que las herramientas aparezcan, y la primera vez Claude Code
  **pide aprobación** para un servidor declarado en el `.mcp.json` del proyecto (es de los 4 devs, no
  de una máquina). Mientras no se apruebe, `mcp__context7__*` no existe y hay que decirlo, no suponerlo.
- **Depende de internet.** Si la oficina se queda sin salida, esta skill no sirve: lo que había que
  consultar se declara **NO CONSULTADO** y no se rellena de memoria, que es justo lo que vino a evitar.
