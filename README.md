<div align="center">
  <img src="static/logo.png" alt="LeedPDF Logo" width="160" height="160">
  
  # LeedPDF - Free PDF Annotation Tool
  
  **Add drawings and notes to any PDF.**
  
  *Works with mouse, touch, or stylus - completely free and private.*
</div>
<br>

<div align="center">

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-87A96B.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Commercial License](https://img.shields.io/badge/Commercial%20License-Available-87A96B.svg)](https://buy.polar.sh/polar_cl_tPmQ3d72uYwrYvzzIUM4R7cku7hg2kmEQqruI1its5c)
[![Free for Personal Use on Web](https://img.shields.io/badge/Free-Web%20App-87A96B.svg)](#web-app-agpl)
[![GitHub Stars](https://img.shields.io/github/stars/rudi-q/leed_pdf_viewer?color=87A96B&style=flat&logo=github)](https://github.com/rudi-q/leed_pdf_viewer/stargazers)
[![Downloads](https://img.shields.io/github/downloads/rudi-q/leed_pdf_viewer/total?label=Downloads&logo=github&color=87A96B)](https://github.com/rudi-q/leed_pdf_viewer/releases)
[![WCAG AAA Compliant](https://img.shields.io/badge/WCAG%20AAA-Compliant-87A96B?style=flat&logo=accessibilityalt&logoColor=white)](https://www.w3.org/WAI/WCAG2AAA-Conformance)

[![SvelteKit](https://img.shields.io/badge/SvelteKit-FF3E00?style=flat&logo=svelte&logoColor=white)](https://kit.svelte.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-24C8D8?style=flat&logo=tauri&logoColor=white)](https://tauri.app/)
[![PDF.js](https://img.shields.io/badge/PDF.js-000000?style=flat&logo=mozilla&logoColor=white)](https://mozilla.github.io/pdf.js/)
[![Brave Search API](https://img.shields.io/badge/Brave%20Search-FB542B?style=flat&logo=brave&logoColor=white)](https://api.search.brave.com/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![CodeRabbit](https://img.shields.io/badge/CodeRabbit-FF570A?style=flat&logo=coderabbit&logoColor=white)](https://coderabbit.ai/)
[![Appwrite](https://img.shields.io/badge/Appwrite-F02E65?style=flat&logo=appwrite&logoColor=white)](https://appwrite.io/)
[![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat&logo=vercel&logoColor=white)](https://vercel.com/)

</div>

**A modern, open-source PDF annotation tool that runs entirely in your browser**

Transform any PDF into an interactive canvas. Draw, annotate, and collaborate without uploading your documents to external servers.

<div align="center">
  <img src="static/screenshot.png" alt="LeedPDF in action - annotating a Y Combinator fundraising guide with highlights, comments, and drawings" width="800" style="border-radius: 12px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);">
</div>

[**Try it now →**](https://leed.my) | [**Report Issues**](https://github.com/rudi-q/leed_pdf_viewer/issues) | [**Contribute**](https://github.com/rudi-q/leed_pdf_viewer/blob/main/CONTRIBUTING.md)

## ✨ Features

### 🔍 **PDF Search & Discovery**
- **Web-wide PDF search** powered by Brave Search API
- **Direct PDF opening** from search results
- **Smart filtering** for PDF documents only
- **Pagination** through search results
- **Real-time search** with instant results
- **Setup guide**: See [docs/SEARCH_FEATURE.md](docs/SEARCH_FEATURE.md) for configuration

### 🎨 **Drawing & Annotation**
- **Freehand drawing** with customizable pencil and highlighter tools
- **Shape tools** including rectangles, circles, arrows, and stars
- **Text annotations** with inline editing
- **Sticky notes** for quick comments
- **Smart eraser** that removes intersecting elements

### 📱 **Universal Access**
- Works on **any device** - desktop, tablet, or phone
- **Touch-optimized** with Apple Pencil support
- **Mobile-friendly** interface that works seamlessly on smartphones and tablets
- **No installation required** - runs in your browser
- **Fast loading** with optimized caching

### ♿ **Accessibility First**
- **WCAG AAA compliant** - exceeds accessibility standards with 7.06:1 contrast ratios
- **Keyboard navigation** - full functionality without a mouse
- **Screen reader friendly** - semantic HTML and proper ARIA labels
- **High contrast mode** support for visually impaired users
- **Scalable interface** - works with browser zoom up to 200%
- **Color blind friendly** - doesn't rely solely on color for information
- **Focus indicators** - clear visual focus states for all interactive elements

### 🔒 **Privacy First**
- **100% client-side** - your PDFs never leave your device
- **No account required** - start annotating immediately
- **Local auto-save** - your work is preserved automatically

### ⚡ **Performance**
- **Instant loading** from URLs (including Dropbox links)
- **High-DPI rendering** for crisp display on all screens
- **Infinite canvas** - pan and zoom without limits
- **Full undo/redo** with keyboard shortcuts

## 🚀 Quick Start

### Option 1: Use Online
Visit [leed.my](https://leed.my) and start annotating immediately.

### Option 2: Load from URL
Share annotated PDFs by adding `/pdf/` to any URL:
```
https://leed.my/pdf/https://example.com/document.pdf
```

### Option 3: Run Locally
```bash
git clone https://github.com/rudi-q/leed_pdf_viewer.git
cd leed_pdf_viewer
pnpm install
pnpm build && pnpm preview

# Or just use the shorthand:
pnpm prev
```

Open `http://localhost:4173` in your browser.

## 🛠️ Tech Stack

- **Framework**: SvelteKit + TypeScript
- **PDF Rendering**: PDF.js
- **Drawing Engine**: HTML5 Canvas
- **Styling**: Tailwind CSS
- **Build**: Vite

## 📖 Usage

### Basic Controls
- **Upload**: Drag & drop a PDF or click the folder icon
- **Draw**: Select the pencil tool and start drawing
- **Navigate**: Use arrow keys or toolbar buttons
- **Zoom**: Ctrl + scroll wheel or toolbar buttons
- **Pan**: Ctrl + drag (or just drag outside PDF area)

### Keyboard Shortcuts
| Action | Shortcut |
|--------|----------|
| Tools | `1-9` (pencil, eraser, text, etc.) |
| Navigation | `←/→` for pages, `W/H` for fit |
| Zoom | `Ctrl +/-`, `Ctrl 0` to reset |
| Actions | `Ctrl Z/Y` for undo/redo |
| Upload | `U` to choose file |
| Paper chat | `8` ask tool, `C` show/hide chat |
| Help | `?` or `F1` |

### Paper chat
Ask an AI about any passage of a research paper, and keep the conversation anchored to it.

1. Open the chat with `C` (or the chat button) and add your [OpenRouter](https://openrouter.ai) API key in its settings.
2. Choose the ask tool (`8`), select a term or sentence, and click **Ask about…**.
3. The passage stays highlighted. **Double-click** it to reopen the conversation; **hover** it for a short summary in the left margin — written once the conversation has been idle for a minute (adjustable), or as soon as you select another passage.

Answers draw on the whole paper's structure — title, abstract, outline, figures, the text around the passage and the references it cites — which comes from parsing the PDF with [MinerU](https://github.com/opendatalab/MinerU). Papers are parsed in the background when opened; see Docker below for running the parser. Conversations are saved in your browser (IndexedDB). Your API key stays in this browser and is sent only to OpenRouter.

## 🎯 Perfect For

- **Students** reviewing lecture slides and textbooks
- **Professionals** annotating contracts and reports
- **Researchers** marking up papers and documentation
- **Teams** collaborating on design mockups
- **Anyone** who needs to mark up PDFs quickly

## 🔧 Development

### Prerequisites
- Node.js 18+
- npm/pnpm/yarn

### Setup
```bash
# Install dependencies
pnpm install

# Build for production
pnpm build

# Preview production build
pnpm preview

# Or use the shorthand:
pnpm prev
```

### Docker
No local Node needed — everything runs through Docker Compose profiles:

```bash
docker compose --profile dev up                    # app with HMR on :5173, plus the MinerU parser
docker compose --profile test run --rm unit        # unit tests (vitest)
docker compose --profile test run --rm typecheck   # svelte-check
docker compose --profile test run --rm e2e --project=firefox --project=webkit   # Playwright
docker compose --profile prod up -d --build        # production build on :3000, plus MinerU

# Parser on an NVIDIA GPU (needs the NVIDIA Container Toolkit; untested in CI):
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile prod up -d --build
```

Configuration lives in `.env` — copy `.env.docker.example`. Notes:
- The browser never talks to MinerU directly (it sends no CORS headers); the app relays through its own `/api/mineru` route to `MINERU_URL`. Set `MINERU_URL=https://mineru.net/api` and `MINERU_API_KEY` to use the hosted parser instead of the bundled one — it then receives a copy of every paper opened.
- The bundled CPU parser serves MinerU's fast `flash` tier; the GPU override serves `standard` (better equations and layout).
- `PUBLIC_*` values are compiled into the client, so they are build arguments: rebuild after changing them.
- Containers run as uid 1000 so files they write into the checkout stay yours.
- The Tauri desktop app is not built in Docker; parsing needs the server relay, so it is web-only for now.

### Building the Tauri Desktop App
```bash
# 1. Install dependencies
pnpm install

# 2. Install Rust (if you don't have it)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 3. Build your native app
pnpm tauri build
```

### Project Structure
```
src/
├── lib/
│   ├── components/     # Svelte components
│   ├── stores/         # State management
│   └── utils/          # PDF and drawing utilities
├── routes/             # SvelteKit routes
└── app.html           # App template
```

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/awesome-feature`
3. **Commit** your changes: `git commit -m 'Add awesome feature'`
4. **Push** to the branch: `git push origin feature/awesome-feature`
5. **Open** a Pull Request

### Development Guidelines
- Follow the existing code style (ESLint + Prettier configured)
- Test your changes across different devices/browsers
- Update documentation for new features
- Keep commits atomic and well-described

## 💬 Community & Feedback

We'd love to hear from you! Join our community discussions:

- **💚 [Wall of Love](https://github.com/rudi-q/leed_pdf_viewer/discussions/categories/wall-of-love)** - Share your feedback about what you loved about LeedPDF and why
- **🙏 [Q&A](https://github.com/rudi-q/leed_pdf_viewer/discussions/categories/q-a)** - Ask any questions you may have
- **🗳️ [Polls](https://github.com/rudi-q/leed_pdf_viewer/discussions/categories/polls)** - Poll on ideas
- **💡 [Ideas](https://github.com/rudi-q/leed_pdf_viewer/discussions/categories/ideas)** - Share new ideas
- **🙌 [Show and Tell](https://github.com/rudi-q/leed_pdf_viewer/discussions/categories/show-and-tell)** - Show us how you're using LeedPDF

You can also use [GitHub Issues](https://github.com/rudi-q/leed_pdf_viewer/issues) for bug reports.

## 🌱 Support the Project

Love LeedPDF? Help us keep it free and open source!

### ☕ GitHub Sponsors
**[💝 Sponsor on GitHub](https://github.com/sponsors/rudi-q)**

Your sponsorship helps us:
- ✨ Add new features and improvements
- 🔧 Fix bugs and maintain code quality
- 📖 Create better documentation and tutorials
- 🌍 Keep the project free for everyone
- 🚀 Improve performance and accessibility

*Every contribution, big or small, makes a difference!*

## 📄 License

LeedPDF is **flexibly licensed** to give you options:
<a id="web-app-agpl"></a>
### 🆓 **Web App - AGPL-3.0 (Free & Open Source)**
**[✨ Try LeedPDF Web App](https://leed.my)** - Always free, no account required

Perfect for:
- ✅ Personal projects and learning
- ✅ Educational and research use
- ✅ Full PDF annotation features
- ✅ Privacy-focused (local processing)
- ✅ Contributing back to the community

### 🖥️ **Desktop App - PAID**
**[💻 Download Desktop App for Windows](https://leed.my/download-for-windows)** - One-time purchase
- 🎯 **Windows:** Pay-what-you-want
- ✅ Native desktop experience
- ✅ Better performance
- ✅ Offline sync capabilities
- ✅ Lifetime updates
- 📋 Governed by [End User License Agreement](LICENSE-DESKTOP-EULA)

*Mac desktop app coming soon!*

### 💼 **Commercial License for developers (Paid)**
Required for:
- 🏢 Commercial products and services
- 🏢 Proprietary software integration
- 🏢 SaaS applications and hosted services
- 🏢 Client work and consulting projects
- 🏢 Removing AGPL-3.0 obligations

---

## 💳 **Developer Commercial Licensing Options**

**[🛒 Get Commercial License](https://buy.polar.sh/polar_cl_tPmQ3d72uYwrYvzzIUM4R7cku7hg2kmEQqruI1its5c)**

Available options:
- **Individual License** - Solo developers and small companies
- **Enterprise License** - Large organizations with custom terms

*For Enterprise licensing and custom requirements, contact [reach@rudi.engineer](mailto:reach@rudi.engineer)*

### 🤝 **What You Get With Commercial License:**
- ✅ Remove AGPL-3.0 copyleft requirements
- ✅ Use in proprietary/commercial applications
- ✅ No source code disclosure obligations
- ✅ Distribute without open-sourcing your app
- ✅ Remove attribution requirements
- ✅ Email support for integration questions
- ✅ Perpetual license (no expiration)

### ❓ **Need Help Choosing?**
- **Personal project for web?** → Use AGPL-3.0 (free)
- **Building a commercial product?** → [Individual License](https://buy.polar.sh/polar_cl_tPmQ3d72uYwrYvzzIUM4R7cku7hg2kmEQqruI1its5c)
- **Large company/custom terms?** → [Enterprise License](https://buy.polar.sh/polar_cl_tPmQ3d72uYwrYvzzIUM4R7cku7hg2kmEQqruI1its5c)

**Questions about licensing?** Contact us: [reach@rudi.engineer](mailto:reach@rudi.engineer)

---

*By using LeedPDF, you agree to comply with the terms of your chosen license. The AGPL-3.0 license requires that any network-accessible modifications be open-sourced.*

## 🙏 Acknowledgments

- **PDF.js** - Mozilla's excellent PDF rendering engine
- **SvelteKit** - The framework that makes this possible
- **Brave Search API** - Powering our web-wide PDF search functionality
- **Vite** - Lightning-fast build tool
- **Tauri** - For building lightweight desktop apps
- **Tailwind CSS** - Utility-first CSS framework

---

**Built with ❤️ for the open web**

*Privacy-focused • Lightweight • No tracking • No accounts • No servers*
