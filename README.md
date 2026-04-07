<div align="center">

<img src="./resources/icon.png" alt="AICO-Bot Logo" width="120" height="120">

# AICO-Bot

### Open Source Cowork for Everyone


Experience the full power of an AI Agent without touching the terminal. AICO-Bot brings a visual, cross-platform desktop experience to everyone—open source and free.

> **Our Philosophy:** Wrap complex technology into intuitive human interaction.


[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-aico-bot?style=social)](https://github.com/openkursar/hello-aico-bot/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#installation)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-aico-bot/total.svg)](https://github.com/openkursar/hello-aico-bot/releases)

[Download](#installation) · [Documentation](#documentation) · [Contributing](#contributing)

 **[Español](./docs/README.es.md)** | **[Deutsch](./docs/README.de.md)** |**[中文](./docs/README.zh-CN.md)** |  **[Français](./docs/README.fr.md)** | **[日本語](./docs/README.ja.md)**

</div>

---

<div align="center">

![Space Home](./docs/assets/space_home.jpg)

</div>

---

## Why AICO-Bot?

**Claude Code is the most capable AI coding agent available.** But there's a problem:

> **It's trapped in a terminal.**

For developers comfortable with CLI, that's fine. But for designers, PMs, students, and anyone who just wants AI to *do things* — the terminal is a wall.

**AICO-Bot is the first to break down that wall.**

We took 100% of Claude Code's Agent capabilities and wrapped them in a visual interface that anyone can use. Same power, zero friction.

| | Claude Code CLI | AICO-Bot |
|---|:---:|:---:|
| Full Agent capabilities | ✅ | ✅ |
| Visual interface | ❌ | ✅ |
| One-click install | ❌ | ✅ |
| Remote access from any device | ❌ | ✅ |
| File preview & management | ❌ | ✅ |
| Built-in AI Browser | ❌ | ✅ |

> Think of it like this:
> **Windows** turned DOS into visual desktops.
> **AICO-Bot** turns Claude Code CLI into a visual AI companion.

---

## Features

<table>
<tr>
<td width="50%">

### Real Agent Loop
Not just chat. AICO-Bot can **actually do things** — write code, create files, run commands, and iterate until the task is done.

### Space System
Isolated workspaces keep your projects organized. Each Space has its own files, conversations, and context.

### Beautiful Artifact Rail
See every file AI creates in real-time. Preview code, HTML, images — all without leaving the app.

</td>
<td width="50%">

### Remote Access
Control your desktop AICO-Bot from your phone or any browser. Work from anywhere — even from a hospital bed (true story).

### AI Browser
Let AI control a real embedded browser. Web scraping, form filling, testing — all automated.

### MCP Support
Extend capabilities with Model Context Protocol. Compatible with Claude Desktop MCP servers.

</td>
</tr>
</table>

### And More...

- **Multi-provider Support** — Anthropic, OpenAI, DeepSeek, and any OpenAI-compatible API
- **Real-time Thinking** — Watch AI's thought process as it works
- **Tool Permissions** — Approve or auto-allow file/command operations
- **Dark/Light Themes** — System-aware theming
- **i18n Ready** — English, Chinese, Spanish (more coming)
- **Auto Updates** — Stay current with one-click updates

---

## Digital Humans

Digital Humans are autonomous AI agents that work for you in the background — monitoring, summarizing, notifying, and acting — so you don't have to.

Browse and install them directly from the **AICO-Bot Digital Human Store**, no setup required.

> Think of them like apps on your phone, except they work *for* you automatically.

### For Users — Install in seconds

Open the Store in AICO-Bot, pick a Digital Human, configure a few fields, and it starts running. No code, no prompts, no manual effort.

Examples of what Digital Humans can do for you:

- Monitor prices and alert you when a deal drops
- Deliver a daily news or market digest every morning
- Watch your inbox and summarize what matters
- Track social mentions of your brand or product
- Run reports on a schedule and send them to your team

### For Developers — Build and publish

Want to contribute a Digital Human to the ecosystem? Write a `spec.yaml` and submit a PR to the [Digital Human Protocol (DHP)](https://github.com/openkursar/digital-human-protocol) registry — the open-source store and protocol behind AICO-Bot's Digital Humans.

Your agent becomes available to all AICO-Bot users instantly after merge.

---

## Screenshots

![Chat Intro](./docs/assets/chat_intro.jpg)

![Chat Todo](./docs/assets/chat_todo.jpg)


*Remote Access: Control AICO-Bot from anywhere*

![Remote Settings](./docs/assets/remote_setting.jpg)
<p align="center">
  <img src="./docs/assets/mobile_remote_access.jpg" width="45%" alt="Mobile Remote Access">
  &nbsp;&nbsp;
  <img src="./docs/assets/mobile_chat.jpg" width="45%" alt="Mobile Chat">
</p>

AI browser Video Demo 

https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003

---

## Advanced Features Demo

[![中文](https://img.shields.io/badge/点击播放-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)
[![English](https://img.shields.io/badge/Watch_Video-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)


## Installation

### Download (Recommended)





| Platform | Download | Requirements |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [Download .dmg](https://github.com/openkursar/hello-aico-bot/releases/latest) | macOS 11+ |
| **macOS** (Intel) | [Download .dmg](https://github.com/openkursar/hello-aico-bot/releases/latest) | macOS 11+ |
| **Windows** | [Download .exe](https://github.com/openkursar/hello-aico-bot/releases/latest) | Windows 10+ |
| **Linux** | [Download .AppImage](https://github.com/openkursar/hello-aico-bot/releases/latest) | Ubuntu 20.04+ |
| **Web** (PC/Mobile) | Enable Remote Access in desktop app | Any modern browser |

**That's it.** Download, install, run. No Node.js. No npm. No terminal commands.

### Build from Source

For developers who want to contribute or customize:

```bash
git clone https://github.com/openkursar/hello-aico-bot.git
cd hello-aico-bot
npm install
npm run prepare        # Download binary dependencies for your platform
npm run dev
```

> To build for all platforms, run `npm run prepare:all` first to download binaries for every target platform.

详细的 Windows 本地开发、构建、部署指南请参阅 [WINDOWS_DEV.md](./WINDOWS_DEV.md)。

---

## Quick Start

1. **Launch AICO-Bot** and enter your API key (Anthropic recommended)
2. **Start chatting** — try "Create a simple todo app with React"
3. **Watch the magic** — see files appear in the Artifact Rail
4. **Preview & iterate** — click any file to preview, ask for changes

> **Pro tip:** For best results, use Claude Sonnet 4.5 or Opus 4.5 models.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                          AICO-Bot Desktop                           │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│    Main     │◄──►│  Claude Code SDK  │   │
│  │  (Renderer) │IPC │   Process   │    │   (Agent Loop)    │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │  Local Files  │                           │
│                    │  ~/.aico-bot/     │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

- **100% Local** — Your data never leaves your machine (except API calls)
- **No Backend Required** — Pure desktop client, use your own API keys
- **Real Agent Loop** — Tool execution, not just text generation

> **Powered by [Claude Code](https://github.com/anthropics/claude-code)** — Thanks to Anthropic for building the most capable AI agent.

---

## What People Are Building

AICO-Bot isn't just for developers. We've seen:

- **Finance teams** building full-stack apps from scratch — with zero coding experience
- **Designers** prototyping interactive mockups
- **Students** learning to code with AI as their pair programmer
- **Developers** shipping features faster than ever

The barrier isn't AI capability anymore. **It's accessibility.** AICO-Bot removes that barrier.

---

## Roadmap

- [x] Core Agent Loop with Claude Code SDK
- [x] Space & Conversation management
- [x] Artifact preview (Code, HTML, Images, Markdown)
- [x] Remote Access (browser control)
- [x] AI Browser (CDP-based)
- [x] MCP Server support
- [ ] Plugin system
- [ ] Visual Git with AI-assisted review
- [ ] AI-powered file search

---

## Contributing

AICO-Bot is open source because AI should be accessible to everyone.

We welcome contributions of all kinds:

- **Translations** — Help us reach more users (see `src/renderer/i18n/`)
- **Bug reports** — Found something broken? Let us know
- **Feature ideas** — What would make AICO-Bot better for you?
- **Code contributions** — PRs welcome!

```bash
# Development setup
git clone https://github.com/openkursar/hello-aico-bot.git
cd hello-aico-bot
npm install
npm run prepare        # Download binary dependencies for your platform
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Community

- [GitHub Discussions](https://github.com/openkursar/hello-aico-bot/discussions) — Questions & ideas
- [Issues](https://github.com/openkursar/hello-aico-bot/issues) — Bug reports & feature requests

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Inspired by AICO-Bot?

If this project sparked an idea or helped you build something cool:

- **Give us a star** — it helps others find AICO-Bot
- **Share your story** — we love hearing what you built
- **Link back to us** — e.g. `Inspired by [AICO-Bot](https://github.com/openkursar/hello-aico-bot)`

---

## The Story Behind AICO-Bot

A few months ago, it started with a simple frustration: **I wanted to use Claude Code, but I was stuck in meetings all day.**

During boring meetings (we've all been there), I thought: *What if I could control Claude Code on my home computer from my phone?*

Then came another problem — my non-technical colleagues wanted to try Claude Code after seeing what it could do. But they got stuck at installation. *"What's npm? How do I install Node.js?"* Some spent days trying to figure it out.

So I built AICO-Bot for myself and my friends:
- **Visual interface** — no more staring at terminal output
- **One-click install** — no Node.js, no npm, just download and run
- **Remote access** — control from phone, tablet, or any browser

The first version took a few hours. Everything after that? **100% built by AICO-Bot itself.** We've been using it daily for months.

AI building AI. Now in everyone's hands.

---

## Contributors

<a href="https://github.com/openkursar/hello-aico-bot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-aico-bot" />
</a>

Made with ❤️ by our contributors.

<div align="center">

### Built by AI, for humans.

If AICO-Bot helps you build something amazing, we'd love to hear about it.

**Star this repo** to help others discover AICO-Bot.

[![Star History Chart](https://api.star-history.com/svg?repos=openkursar/hello-aico-bot&type=Date)](https://star-history.com/#openkursar/hello-aico-bot&Date)

[⬆ Back to Top](#aico-bot)

</div>
