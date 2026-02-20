<div align="center">

<img src="../resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo

### Open Source Cowork for Everyone


Expérimentez toute la puissance d'un AI Agent sans toucher au terminal. Halo apporte une expérience de bureau visuelle et multiplateforme à tous—open source et gratuit.

> **Notre philosophie :** Envelopper une technologie complexe dans une interaction humaine intuitive.

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#installation)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[Télécharger](#installation) · [Documentation](#documentation) · [Contribuer](#contribuer)

**[English](../README.md)** | **[简体中文](./README.zh-CN.md)** | **[繁體中文](./README.zh-TW.md)** | **[Español](./README.es.md)** | **[Deutsch](./README.de.md)** | **[日本語](./README.ja.md)**

</div>

---

<div align="center">

![Space Home](./assets/space_home.jpg)

</div>

---

## Pourquoi Halo ?

**Claude Code est l'agent IA de programmation le plus performant disponible.** Mais il y a un problème :

> **Il est piégé dans un terminal.**

Pour les développeurs à l'aise avec le CLI, c'est bien. Mais pour les designers, les chefs de produit, les étudiants, et tous ceux qui veulent simplement que l'IA *fasse des choses* — le terminal est un obstacle.

**Halo est le premier à briser cet obstacle.**

Nous avons pris 100% des capacités d'Agent de Claude Code et les avons enveloppées dans une interface visuelle que tout le monde peut utiliser. Même puissance, zéro friction.

| | Claude Code CLI | Halo |
|---|:---:|:---:|
| Capacités Agent complètes | ✅ | ✅ |
| Interface visuelle | ❌ | ✅ |
| Installation en un clic | ❌ | ✅ |
| Accès distant depuis n'importe quel appareil | ❌ | ✅ |
| Aperçu et gestion des fichiers | ❌ | ✅ |
| Navigateur IA intégré | ❌ | ✅ |

> Pensez-y ainsi :
> **Windows** a transformé DOS en bureaux visuels.
> **Halo** transforme Claude Code CLI en compagnon IA visuel.

---

## Fonctionnalités

<table>
<tr>
<td width="50%">

### Vraie Boucle d'Agent
Pas seulement du chat. Halo peut **vraiment faire des choses** — écrire du code, créer des fichiers, exécuter des commandes, et itérer jusqu'à ce que la tâche soit terminée.

### Système d'Espaces
Des espaces de travail isolés gardent vos projets organisés. Chaque Espace a ses propres fichiers, conversations et contexte.

### Barre d'Artefacts Élégante
Voyez chaque fichier créé par l'IA en temps réel. Prévisualisez le code, HTML, images — le tout sans quitter l'application.

</td>
<td width="50%">

### Accès Distant
Contrôlez votre Halo de bureau depuis votre téléphone ou n'importe quel navigateur. Travaillez de n'importe où — même depuis un lit d'hôpital (histoire vraie).

### Navigateur IA
Laissez l'IA contrôler un vrai navigateur intégré. Web scraping, remplissage de formulaires, tests — tout automatisé.

### Support MCP
Étendez les capacités avec Model Context Protocol. Compatible avec les serveurs MCP de Claude Desktop.

</td>
</tr>
</table>

### Et Plus Encore...

- **Support Multi-fournisseurs** — Anthropic, OpenAI, DeepSeek, et toute API compatible OpenAI
- **Réflexion en Temps Réel** — Observez le processus de réflexion de l'IA pendant qu'elle travaille
- **Permissions d'Outils** — Approuvez ou autorisez automatiquement les opérations fichiers/commandes
- **Thèmes Sombre/Clair** — Thématisation adaptée au système
- **i18n Prêt** — Anglais, Chinois, Espagnol (plus à venir)
- **Mises à Jour Auto** — Restez à jour en un clic

---

## Captures d'Écran

![Chat Intro](./assets/chat_intro.jpg)

![Chat Todo](./assets/chat_todo.jpg)


*Accès Distant : Contrôlez Halo de n'importe où*

![Remote Settings](./assets/remote_setting.jpg)
<p align="center">
  <img src="./assets/mobile_remote_access.jpg" width="45%" alt="Accès Distant Mobile">
  &nbsp;&nbsp;
  <img src="./assets/mobile_chat.jpg" width="45%" alt="Chat Mobile">
</p>

Démo Vidéo du Navigateur IA

https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003

---

## Démo des Fonctionnalités Avancées

[![📹 Voir la Vidéo](https://img.shields.io/badge/📹_Voir_la_Vidéo-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)

---

## Installation

### Télécharger (Recommandé)

| Plateforme | Télécharger | Prérequis |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [Télécharger .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **macOS** (Intel) | [Télécharger .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **Windows** | [Télécharger .exe](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+ |
| **Linux** | [Télécharger .AppImage](https://github.com/openkursar/hello-halo/releases/latest) | Ubuntu 20.04+ |
| **Web** (PC/Mobile) | Activez l'Accès Distant dans l'app de bureau | N'importe quel navigateur moderne |

**C'est tout.** Téléchargez, installez, lancez. Pas de Node.js. Pas de npm. Pas de commandes terminal.

### Compiler depuis les Sources

Pour les développeurs qui veulent contribuer ou personnaliser :

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run dev
```

---

## Démarrage Rapide

1. **Lancez Halo** et entrez votre clé API (Anthropic recommandé)
2. **Commencez à discuter** — essayez "Crée une simple app de tâches avec React"
3. **Observez la magie** — voyez les fichiers apparaître dans la Barre d'Artefacts
4. **Prévisualisez et itérez** — cliquez sur n'importe quel fichier pour prévisualiser, demandez des modifications

> **Conseil pro :** Pour de meilleurs résultats, utilisez les modèles Claude Sonnet 4.5 ou Opus 4.5.

---

## Comment Ça Marche

```
┌─────────────────────────────────────────────────────────────────┐
│                         Halo Bureau                              │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│  Processus  │◄──►│  Claude Code SDK  │   │
│  │  (Renderer) │IPC │  Principal  │    │  (Boucle Agent)   │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │Fichiers Locaux│                           │
│                    │   ~/.halo/    │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

- **100% Local** — Vos données ne quittent jamais votre machine (sauf appels API)
- **Pas de Backend Requis** — Client de bureau pur, utilisez vos propres clés API
- **Vraie Boucle d'Agent** — Exécution d'outils, pas seulement génération de texte

> **Powered by [Claude Code](https://github.com/anthropics/claude-code)** — Merci à Anthropic d'avoir construit l'agent IA le plus performant.

---

## Ce Que les Gens Construisent

Halo n'est pas que pour les développeurs. Nous avons vu :

- **Des équipes finance** construire des apps full-stack de zéro — sans expérience en programmation
- **Des designers** prototyper des maquettes interactives
- **Des étudiants** apprendre à coder avec l'IA comme partenaire de pair programming
- **Des développeurs** livrer des fonctionnalités plus vite que jamais

L'obstacle n'est plus la capacité de l'IA. **C'est l'accessibilité.** Halo supprime cet obstacle.

---

## Feuille de Route

- [x] Boucle d'Agent centrale avec Claude Code SDK
- [x] Gestion des Espaces et Conversations
- [x] Aperçu des artefacts (Code, HTML, Images, Markdown)
- [x] Accès Distant (contrôle navigateur)
- [x] Navigateur IA (basé sur CDP)
- [x] Support serveur MCP
- [ ] Système de plugins
- [ ] Git visuel avec revue assistée par IA
- [ ] Recherche de fichiers propulsée par IA

---

## Contribuer

Halo est open source parce que l'IA devrait être accessible à tous.

Nous accueillons les contributions de toute nature :

- **Traductions** — Aidez-nous à atteindre plus d'utilisateurs (voir `src/renderer/i18n/`)
- **Rapports de bugs** — Trouvé quelque chose de cassé ? Faites-le nous savoir
- **Idées de fonctionnalités** — Qu'est-ce qui rendrait Halo meilleur pour vous ?
- **Contributions de code** — PRs bienvenues !

```bash
# Configuration de développement
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run dev
```

Voir [CONTRIBUTING.md](../CONTRIBUTING.md) pour les directives.

---

## Communauté

- [GitHub Discussions](https://github.com/openkursar/hello-halo/discussions) — Questions et idées
- [Issues](https://github.com/openkursar/hello-halo/issues) — Rapports de bugs et demandes de fonctionnalités

---

## Licence

Licence MIT — voir [LICENSE](../LICENSE) pour les détails.

---

## Inspiré par Halo ?

Si ce projet a éveillé une idée ou vous a aidé à construire quelque chose de cool :

- **Donnez-nous une étoile** — cela aide les autres à trouver Halo
- **Partagez votre histoire** — nous adorons savoir ce que vous avez construit
- **Faites un lien vers nous** — par exemple `Inspired by [Halo](https://github.com/openkursar/hello-halo)`

---

## L'Histoire Derrière Halo

Il y a quelques mois, tout a commencé avec une simple frustration : **Je voulais utiliser Claude Code, mais j'étais coincé en réunions toute la journée.**

Pendant des réunions ennuyeuses (on y est tous passés), j'ai pensé : *Et si je pouvais contrôler Claude Code sur mon ordinateur à la maison depuis mon téléphone ?*

Puis est venu un autre problème — mes collègues non-techniques voulaient essayer Claude Code après avoir vu ce qu'il pouvait faire. Mais ils étaient bloqués à l'installation. *"C'est quoi npm ? Comment j'installe Node.js ?"* Certains ont passé des jours à essayer de comprendre.

Alors j'ai construit Halo pour moi et mes amis :
- **Interface visuelle** — plus besoin de fixer la sortie terminal
- **Installation en un clic** — pas de Node.js, pas de npm, juste télécharger et lancer
- **Accès distant** — contrôle depuis téléphone, tablette, ou n'importe quel navigateur

La première version a pris quelques heures. Tout après ça ? **100% construit par Halo lui-même.** On l'utilise quotidiennement depuis des mois.

L'IA qui construit l'IA. Maintenant entre les mains de tous.

---

## Contributeurs

<a href="https://github.com/openkursar/hello-halo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-halo" />
</a>

Made with ❤️ by our contributors.

<div align="center">

### Construit par l'IA, pour les humains.

Si Halo vous aide à construire quelque chose d'incroyable, on aimerait en entendre parler.

**Donnez une Star à ce repo** pour aider les autres à découvrir Halo.

[![Star History Chart](https://api.star-history.com/svg?repos=openkursar/hello-halo&type=Date)](https://star-history.com/#openkursar/hello-halo&Date)

[⬆ Retour en Haut](#halo)

</div>
