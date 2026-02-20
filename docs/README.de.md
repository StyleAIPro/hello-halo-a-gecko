<div align="center">

<img src="../resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo

### Open Source Cowork for Everyone


Erlebe die volle Kraft eines AI Agents, ohne das Terminal zu berühren. Halo bietet allen eine visuelle, plattformübergreifende Desktop-Erfahrung—open source und kostenlos.

> **Unsere Philosophie:** Komplexe Technologie in intuitive menschliche Interaktion verpacken.

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#installation)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[Download](#installation) · [Dokumentation](#dokumentation) · [Mitwirken](#mitwirken)

**[English](../README.md)** | **[简体中文](./README.zh-CN.md)** | **[繁體中文](./README.zh-TW.md)** | **[Español](./README.es.md)** | **[Français](./README.fr.md)** | **[日本語](./README.ja.md)**

</div>

---

<div align="center">

![Space Home](./assets/space_home.jpg)

</div>

---

## Warum Halo?

**Claude Code ist der leistungsfähigste verfügbare KI-Programmieragent.** Aber es gibt ein Problem:

> **Er ist in einem Terminal gefangen.**

Für Entwickler, die sich mit CLI wohlfühlen, ist das in Ordnung. Aber für Designer, PMs, Studenten und alle, die einfach wollen, dass KI *Dinge erledigt* — das Terminal ist eine Hürde.

**Halo ist der erste, der diese Hürde überwindet.**

Wir haben 100% der Agent-Fähigkeiten von Claude Code genommen und sie in eine visuelle Oberfläche verpackt, die jeder nutzen kann. Gleiche Leistung, null Reibung.

| | Claude Code CLI | Halo |
|---|:---:|:---:|
| Volle Agent-Fähigkeiten | ✅ | ✅ |
| Visuelle Oberfläche | ❌ | ✅ |
| Ein-Klick-Installation | ❌ | ✅ |
| Fernzugriff von jedem Gerät | ❌ | ✅ |
| Dateivorschau & Verwaltung | ❌ | ✅ |
| Integrierter KI-Browser | ❌ | ✅ |

> Stell es dir so vor:
> **Windows** verwandelte DOS in visuelle Desktops.
> **Halo** verwandelt Claude Code CLI in einen visuellen KI-Begleiter.

---

## Funktionen

<table>
<tr>
<td width="50%">

### Echter Agent-Loop
Nicht nur Chat. Halo kann **wirklich Dinge tun** — Code schreiben, Dateien erstellen, Befehle ausführen und iterieren, bis die Aufgabe erledigt ist.

### Space-System
Isolierte Arbeitsbereiche halten deine Projekte organisiert. Jeder Space hat seine eigenen Dateien, Konversationen und Kontext.

### Elegante Artefakt-Leiste
Sieh jede Datei, die die KI erstellt, in Echtzeit. Vorschau von Code, HTML, Bildern — alles ohne die App zu verlassen.

</td>
<td width="50%">

### Fernzugriff
Steuere dein Desktop-Halo von deinem Handy oder jedem Browser. Arbeite von überall — sogar von einem Krankenhausbett (wahre Geschichte).

### KI-Browser
Lass die KI einen echten eingebetteten Browser steuern. Web-Scraping, Formularausfüllung, Tests — alles automatisiert.

### MCP-Unterstützung
Erweitere Fähigkeiten mit Model Context Protocol. Kompatibel mit Claude Desktop MCP-Servern.

</td>
</tr>
</table>

### Und Mehr...

- **Multi-Anbieter-Unterstützung** — Anthropic, OpenAI, DeepSeek und jede OpenAI-kompatible API
- **Echtzeit-Denken** — Beobachte den Denkprozess der KI während sie arbeitet
- **Tool-Berechtigungen** — Genehmige oder erlaube automatisch Datei-/Befehlsoperationen
- **Dunkel/Hell Themes** — Systemabhängige Thematisierung
- **i18n Bereit** — Englisch, Chinesisch, Spanisch (mehr kommen)
- **Auto-Updates** — Bleib aktuell mit Ein-Klick-Updates

---

## Screenshots

![Chat Intro](./assets/chat_intro.jpg)

![Chat Todo](./assets/chat_todo.jpg)


*Fernzugriff: Steuere Halo von überall*

![Remote Settings](./assets/remote_setting.jpg)
<p align="center">
  <img src="./assets/mobile_remote_access.jpg" width="45%" alt="Mobiler Fernzugriff">
  &nbsp;&nbsp;
  <img src="./assets/mobile_chat.jpg" width="45%" alt="Mobiler Chat">
</p>

KI-Browser Video-Demo

https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003

---

## Erweiterte Funktionen-Demo

[![📹 Video Ansehen](https://img.shields.io/badge/📹_Video_Ansehen-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)

---

## Installation

### Download (Empfohlen)

| Plattform | Download | Anforderungen |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [Download .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **macOS** (Intel) | [Download .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **Windows** | [Download .exe](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+ |
| **Linux** | [Download .AppImage](https://github.com/openkursar/hello-halo/releases/latest) | Ubuntu 20.04+ |
| **Web** (PC/Mobil) | Aktiviere Fernzugriff in der Desktop-App | Jeder moderne Browser |

**Das ist alles.** Herunterladen, installieren, ausführen. Kein Node.js. Kein npm. Keine Terminal-Befehle.

### Aus Quellcode Kompilieren

Für Entwickler, die beitragen oder anpassen möchten:

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run dev
```

---

## Schnellstart

1. **Starte Halo** und gib deinen API-Schlüssel ein (Anthropic empfohlen)
2. **Beginne zu chatten** — probiere "Erstelle eine einfache Todo-App mit React"
3. **Beobachte die Magie** — sieh Dateien in der Artefakt-Leiste erscheinen
4. **Vorschau & Iteration** — klicke auf jede Datei zur Vorschau, bitte um Änderungen

> **Profi-Tipp:** Für beste Ergebnisse nutze Claude Sonnet 4.5 oder Opus 4.5 Modelle.

---

## Wie es Funktioniert

```
┌─────────────────────────────────────────────────────────────────┐
│                         Halo Desktop                             │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│    Haupt-   │◄──►│  Claude Code SDK  │   │
│  │  (Renderer) │IPC │   prozess   │    │   (Agent-Loop)    │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │ Lokale Dateien│                           │
│                    │   ~/.halo/    │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

- **100% Lokal** — Deine Daten verlassen niemals deinen Rechner (außer API-Aufrufe)
- **Kein Backend Erforderlich** — Reiner Desktop-Client, nutze deine eigenen API-Schlüssel
- **Echter Agent-Loop** — Tool-Ausführung, nicht nur Textgenerierung

> **Powered by [Claude Code](https://github.com/anthropics/claude-code)** — Danke an Anthropic für den leistungsfähigsten KI-Agenten.

---

## Was Leute Bauen

Halo ist nicht nur für Entwickler. Wir haben gesehen:

- **Finanzteams** bauen Full-Stack-Apps von Grund auf — ohne Programmiererfahrung
- **Designer** prototypen interaktive Mockups
- **Studenten** lernen Programmieren mit KI als Pair-Programming-Partner
- **Entwickler** liefern Features schneller als je zuvor

Die Hürde ist nicht mehr die KI-Fähigkeit. **Es ist die Zugänglichkeit.** Halo beseitigt diese Hürde.

---

## Roadmap

- [x] Kern-Agent-Loop mit Claude Code SDK
- [x] Space & Konversationsverwaltung
- [x] Artefakt-Vorschau (Code, HTML, Bilder, Markdown)
- [x] Fernzugriff (Browser-Steuerung)
- [x] KI-Browser (CDP-basiert)
- [x] MCP-Server-Unterstützung
- [ ] Plugin-System
- [ ] Visuelles Git mit KI-gestützter Code-Review
- [ ] KI-gestützte Dateisuche

---

## Mitwirken

Halo ist Open Source, weil KI für alle zugänglich sein sollte.

Wir begrüßen Beiträge aller Art:

- **Übersetzungen** — Hilf uns, mehr Nutzer zu erreichen (siehe `src/renderer/i18n/`)
- **Bug-Reports** — Etwas Kaputtes gefunden? Lass es uns wissen
- **Feature-Ideen** — Was würde Halo für dich besser machen?
- **Code-Beiträge** — PRs willkommen!

```bash
# Entwicklungsumgebung einrichten
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run dev
```

Siehe [CONTRIBUTING.md](../CONTRIBUTING.md) für Richtlinien.

---

## Community

- [GitHub Discussions](https://github.com/openkursar/hello-halo/discussions) — Fragen & Ideen
- [Issues](https://github.com/openkursar/hello-halo/issues) — Bug-Reports & Feature-Anfragen

---

## Lizenz

MIT-Lizenz — siehe [LICENSE](../LICENSE) für Details.

---

## Von Halo Inspiriert?

Wenn dieses Projekt eine Idee geweckt oder dir beim Bauen von etwas Coolem geholfen hat:

- **Gib uns einen Stern** — es hilft anderen, Halo zu finden
- **Teile deine Geschichte** — wir hören gerne, was du gebaut hast
- **Verlinke uns** — z.B. `Inspired by [Halo](https://github.com/openkursar/hello-halo)`

---

## Die Geschichte Hinter Halo

Vor ein paar Monaten begann es mit einer einfachen Frustration: **Ich wollte Claude Code nutzen, aber ich steckte den ganzen Tag in Meetings.**

Während langweiliger Meetings (wir kennen das alle) dachte ich: *Was wenn ich Claude Code auf meinem Heimcomputer von meinem Handy aus steuern könnte?*

Dann kam ein anderes Problem — meine nicht-technischen Kollegen wollten Claude Code ausprobieren, nachdem sie gesehen hatten, was es kann. Aber sie blieben bei der Installation hängen. *"Was ist npm? Wie installiere ich Node.js?"* Manche verbrachten Tage damit, es herauszufinden.

Also baute ich Halo für mich und meine Freunde:
- **Visuelle Oberfläche** — kein Starren auf Terminal-Ausgaben mehr
- **Ein-Klick-Installation** — kein Node.js, kein npm, einfach herunterladen und ausführen
- **Fernzugriff** — steuern vom Handy, Tablet oder jedem Browser

Die erste Version dauerte ein paar Stunden. Alles danach? **100% von Halo selbst gebaut.** Wir nutzen es seit Monaten täglich.

KI baut KI. Jetzt in jedermanns Händen.

---

## Mitwirkende

<a href="https://github.com/openkursar/hello-halo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-halo" />
</a>

Made with ❤️ by our contributors.

<div align="center">

### Von KI gebaut, für Menschen.

Wenn Halo dir hilft, etwas Großartiges zu bauen, würden wir gerne davon hören.

**Gib diesem Repo einen Star** um anderen zu helfen, Halo zu entdecken.

[![Star History Chart](https://api.star-history.com/svg?repos=openkursar/hello-halo&type=Date)](https://star-history.com/#openkursar/hello-halo&Date)

[⬆ Zurück nach Oben](#halo)

</div>
