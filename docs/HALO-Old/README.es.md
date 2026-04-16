<div align="center">

<img src="../resources/icon.png" alt="AICO-Bot Logo" width="120" height="120">

# AICO-Bot

### Open Source Cowork for Everyone


Experimenta todo el poder de un AI Agent sin tocar la terminal. AICO-Bot ofrece una experiencia de escritorio visual y multiplataforma para todos—open source y gratis.

> **Nuestra filosofía:** Envolver tecnología compleja en interacción humana intuitiva.

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-aico-bot?style=social)](https://github.com/openkursar/hello-aico-bot/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#instalación)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-aico-bot/total.svg)](https://github.com/openkursar/hello-aico-bot/releases)

[Descargar](#instalación) · [Documentación](#documentación) · [Contribuir](#contribuir)

**[English](../README.md)** | **[简体中文](./README.zh-CN.md)** | **[繁體中文](./README.zh-TW.md)** | **[Deutsch](./README.de.md)** | **[Français](./README.fr.md)** | **[日本語](./README.ja.md)**

</div>

---

<div align="center">

![Space Home](./assets/space_home.jpg)

</div>

---

## ¿Por qué AICO-Bot?

**Claude Code es el agente de IA para programación más capaz disponible.** Pero hay un problema:

> **Está atrapado en una terminal.**

Para desarrolladores cómodos con CLI, está bien. Pero para diseñadores, PMs, estudiantes, y cualquiera que solo quiera que la IA *haga cosas* — la terminal es una barrera.

**AICO-Bot es el primero en romper esa barrera.**

Tomamos el 100% de las capacidades de Agent de Claude Code y las envolvimos en una interfaz visual que cualquiera puede usar. Mismo poder, cero fricción.

| | Claude Code CLI | AICO-Bot |
|---|:---:|:---:|
| Capacidades completas de Agent | ✅ | ✅ |
| Interfaz visual | ❌ | ✅ |
| Instalación con un clic | ❌ | ✅ |
| Acceso remoto desde cualquier dispositivo | ❌ | ✅ |
| Vista previa y gestión de archivos | ❌ | ✅ |
| Navegador IA integrado | ❌ | ✅ |

> Piénsalo así:
> **Windows** convirtió DOS en escritorios visuales.
> **AICO-Bot** convierte Claude Code CLI en un compañero de IA visual.

---

## Características

<table>
<tr>
<td width="50%">

### Bucle de Agent Real
No solo chat. AICO-Bot puede **realmente hacer cosas** — escribir código, crear archivos, ejecutar comandos, e iterar hasta que la tarea esté hecha.

### Sistema de Espacios
Espacios de trabajo aislados mantienen tus proyectos organizados. Cada Espacio tiene sus propios archivos, conversaciones y contexto.

### Barra de Artefactos Elegante
Ve cada archivo que la IA crea en tiempo real. Previsualiza código, HTML, imágenes — todo sin salir de la aplicación.

</td>
<td width="50%">

### Acceso Remoto
Controla tu AICO-Bot de escritorio desde tu teléfono o cualquier navegador. Trabaja desde cualquier lugar — incluso desde una cama de hospital (historia real).

### Navegador IA
Deja que la IA controle un navegador real integrado. Web scraping, llenado de formularios, pruebas — todo automatizado.

### Soporte MCP
Extiende capacidades con Model Context Protocol. Compatible con servidores MCP de Claude Desktop.

</td>
</tr>
</table>

### Y Más...

- **Soporte Multi-proveedor** — Anthropic, OpenAI, DeepSeek, y cualquier API compatible con OpenAI
- **Pensamiento en Tiempo Real** — Observa el proceso de pensamiento de la IA mientras trabaja
- **Permisos de Herramientas** — Aprueba o permite automáticamente operaciones de archivos/comandos
- **Temas Oscuro/Claro** — Tematización consciente del sistema
- **i18n Listo** — Inglés, Chino, Español (más por venir)
- **Actualizaciones Automáticas** — Mantente al día con actualizaciones de un clic

---

## Capturas de Pantalla

![Chat Intro](./assets/chat_intro.jpg)

![Chat Todo](./assets/chat_todo.jpg)


*Acceso Remoto: Controla AICO-Bot desde cualquier lugar*

![Remote Settings](./assets/remote_setting.jpg)
<p align="center">
  <img src="./assets/mobile_remote_access.jpg" width="45%" alt="Acceso Remoto Móvil">
  &nbsp;&nbsp;
  <img src="./assets/mobile_chat.jpg" width="45%" alt="Chat Móvil">
</p>

Demo de Video del Navegador IA

https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003

---

## Demostración de Funciones Avanzadas

[![📹 Ver Video](https://img.shields.io/badge/📹_Ver_Video-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)

---

## Instalación

### Descargar (Recomendado)

| Plataforma | Descargar | Requisitos |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [Descargar .dmg](https://github.com/openkursar/hello-aico-bot/releases/latest) | macOS 11+ |
| **macOS** (Intel) | [Descargar .dmg](https://github.com/openkursar/hello-aico-bot/releases/latest) | macOS 11+ |
| **Windows** | [Descargar .exe](https://github.com/openkursar/hello-aico-bot/releases/latest) | Windows 10+ |
| **Linux** | [Descargar .AppImage](https://github.com/openkursar/hello-aico-bot/releases/latest) | Ubuntu 20.04+ |
| **Web** (PC/Móvil) | Habilita Acceso Remoto en la app de escritorio | Cualquier navegador moderno |

**Eso es todo.** Descarga, instala, ejecuta. Sin Node.js. Sin npm. Sin comandos de terminal.

### Compilar desde Código Fuente

Para desarrolladores que quieran contribuir o personalizar:

```bash
git clone https://github.com/openkursar/hello-aico-bot.git
cd hello-aico-bot
npm install
npm run dev
```

---

## Inicio Rápido

1. **Inicia AICO-Bot** e ingresa tu clave API (Anthropic recomendado)
2. **Comienza a chatear** — prueba "Crea una app de tareas simple con React"
3. **Observa la magia** — ve los archivos aparecer en la Barra de Artefactos
4. **Previsualiza e itera** — haz clic en cualquier archivo para previsualizar, pide cambios

> **Consejo pro:** Para mejores resultados, usa los modelos Claude Sonnet 4.5 u Opus 4.5.

---

## Cómo Funciona

```
┌─────────────────────────────────────────────────────────────────┐
│                       AICO-Bot Escritorio                            │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│   Proceso   │◄──►│  Claude Code SDK  │   │
│  │  (Renderer) │IPC │   Principal │    │  (Bucle Agent)    │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │Archivos Locales│                           │
│                    │   ~/.aico-bot/    │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

- **100% Local** — Tus datos nunca salen de tu máquina (excepto llamadas API)
- **Sin Backend Requerido** — Cliente de escritorio puro, usa tus propias claves API
- **Bucle de Agent Real** — Ejecución de herramientas, no solo generación de texto

> **Powered by [Claude Code](https://github.com/anthropics/claude-code)** — Gracias a Anthropic por construir el agente de IA más capaz.

---

## Qué Está Construyendo la Gente

AICO-Bot no es solo para desarrolladores. Hemos visto:

- **Equipos de finanzas** construyendo apps full-stack desde cero — sin experiencia en programación
- **Diseñadores** prototipando mockups interactivos
- **Estudiantes** aprendiendo a programar con IA como su compañero de pair programming
- **Desarrolladores** entregando funciones más rápido que nunca

La barrera ya no es la capacidad de la IA. **Es la accesibilidad.** AICO-Bot elimina esa barrera.

---

## Hoja de Ruta

- [x] Bucle de Agent central con Claude Code SDK
- [x] Gestión de Espacios y Conversaciones
- [x] Vista previa de artefactos (Código, HTML, Imágenes, Markdown)
- [x] Acceso Remoto (control por navegador)
- [x] Navegador IA (basado en CDP)
- [x] Soporte de servidor MCP
- [ ] Sistema de plugins
- [ ] Git visual con revisión asistida por IA
- [ ] Búsqueda de archivos potenciada por IA

---

## Contribuir

AICO-Bot es código abierto porque la IA debería ser accesible para todos.

Damos la bienvenida a contribuciones de todo tipo:

- **Traducciones** — Ayúdanos a llegar a más usuarios (ver `src/renderer/i18n/`)
- **Reportes de bugs** — ¿Encontraste algo roto? Háznoslo saber
- **Ideas de funciones** — ¿Qué haría a AICO-Bot mejor para ti?
- **Contribuciones de código** — ¡PRs bienvenidos!

```bash
# Configuración de desarrollo
git clone https://github.com/openkursar/hello-aico-bot.git
cd hello-aico-bot
npm install
npm run dev
```

Ver [CONTRIBUTING.md](../CONTRIBUTING.md) para guías.

---

## Comunidad

- [GitHub Discussions](https://github.com/openkursar/hello-aico-bot/discussions) — Preguntas e ideas
- [Issues](https://github.com/openkursar/hello-aico-bot/issues) — Reportes de bugs y solicitudes de funciones

---

## Licencia

Licencia MIT — ver [LICENSE](../LICENSE) para detalles.

---

## ¿Inspirado por AICO-Bot?

Si este proyecto despertó una idea o te ayudó a construir algo genial:

- **Danos una estrella** — ayuda a otros a encontrar AICO-Bot
- **Comparte tu historia** — nos encanta saber qué construiste
- **Enlázanos** — por ejemplo `Inspired by [AICO-Bot](https://github.com/openkursar/hello-aico-bot)`

---

## La Historia Detrás de AICO-Bot

Hace unos meses, comenzó con una simple frustración: **Quería usar Claude Code, pero estaba atrapado en reuniones todo el día.**

Durante reuniones aburridas (todos hemos estado ahí), pensé: *¿Y si pudiera controlar Claude Code en mi computadora de casa desde mi teléfono?*

Luego vino otro problema — mis colegas no técnicos querían probar Claude Code después de ver lo que podía hacer. Pero se quedaron atascados en la instalación. *"¿Qué es npm? ¿Cómo instalo Node.js?"* Algunos pasaron días intentando descifrarlo.

Así que construí AICO-Bot para mí y mis amigos:
- **Interfaz visual** — no más mirar salida de terminal
- **Instalación con un clic** — sin Node.js, sin npm, solo descarga y ejecuta
- **Acceso remoto** — controla desde teléfono, tablet, o cualquier navegador

La primera versión tomó unas horas. ¿Todo después de eso? **100% construido por AICO-Bot mismo.** Lo hemos estado usando a diario durante meses.

IA construyendo IA. Ahora en las manos de todos.

---

## Contribuidores

<a href="https://github.com/openkursar/hello-aico-bot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-aico-bot" />
</a>

Made with ❤️ by our contributors.

<div align="center">

### Construido por IA, para humanos.

Si AICO-Bot te ayuda a construir algo increíble, nos encantaría saberlo.

**Dale Star a este repo** para ayudar a otros a descubrir AICO-Bot.

[![Star History Chart](https://api.star-history.com/svg?repos=openkursar/hello-aico-bot&type=Date)](https://star-history.com/#openkursar/hello-aico-bot&Date)

[⬆ Volver Arriba](#aico-bot)

</div>
