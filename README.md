# browseros-mcp

Standalone browser automation MCP server — supports **both BrowserOS and standard Chrome**.

## Features

- **16 MCP tools**: tabs, tab_groups, navigate, snapshot, diff, act, download, upload, read, grep, screenshot, pdf, wait, windows, evaluate, run
- **Dual backend**: Works with both BrowserOS (custom CDP domains) and standard Chrome (Target.* CDP domain)
- **Auto-detection**: Probes the connected browser to determine if it's BrowserOS or standard Chrome
- **Accessibility Tree first**: Uses AX tree snapshots with `[ref=eN]` stable handles instead of CSS selectors
- **HTTP+SSE transport**: MCP server exposed via HTTP StreamableHTTPTransport (Hono)
- **Auto-reconnect**: WebSocket connection with keepalive and automatic reconnection
- **Auto-launch**: Optionally start Chrome/BrowserOS automatically

## Quick Start

```bash
# Install dependencies
npm install

# Start Chrome with remote debugging (if not already running)
chrome --remote-debugging-port=9222

# Start the MCP server (auto-detects backend)
npm start -- --cdp-port 9222 --mcp-port 3000
```

Or with auto-launch:

```bash
npm start -- --auto-launch --backend auto
```

## Configuration

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--cdp-port` | 9222 | Chrome CDP port |
| `--cdp-host` | 127.0.0.1 | Chrome CDP host |
| `--mcp-port` | 3000 | MCP HTTP server port |
| `--backend` | auto | Backend mode: `browseros`, `chrome`, or `auto` |
| `--chrome-path` | (auto) | Chrome executable path (for auto-launch) |
| `--auto-launch` | false | Automatically start Chrome |
| `--name` | browseros-mcp | MCP server name |
| `--version` | 0.1.0 | MCP server version |

### Environment Variables

All CLI arguments can also be set via environment variables with `BROWSEROS_MCP_` prefix:

```bash
BROWSEROS_MCP_CDP_PORT=9222
BROWSEROS_MCP_BACKEND=chrome
BROWSEROS_MCP_AUTO_LAUNCH=1
```

## Backend Modes

### `browseros` mode
Uses BrowserOS custom CDP domains:
- `Browser.getTabs`, `Browser.createTab`, `Browser.closeTab` — tab management
- `Browser.getWindows`, `Browser.createWindow` — window management
- `Browser.getTabGroups`, `Browser.createTabGroup` — tab group management

All 16 tools are fully functional.

### `chrome` mode
Uses standard Chrome CDP domains:
- `Target.getTargets`, `Target.createTarget`, `Target.closeTarget` — tab management
- `tab_groups` and `windows` tools return "unsupported" errors
- 14 out of 16 tools are fully functional

### `auto` mode (default)
Probes the connected browser's `/json/version` response:
- If `Browser` field contains "BrowserOS" → `browseros` mode
- Otherwise → `chrome` mode

## MCP Tools

| Tool | Description | BrowserOS | Chrome |
|------|-------------|-----------|--------|
| `tabs` | List, create, close, activate tabs | ✅ Full | ✅ Adapted |
| `tab_groups` | Manage tab groups | ✅ Full | ❌ Unsupported |
| `navigate` | Navigate to URL, back, forward, reload | ✅ | ✅ |
| `snapshot` | Capture accessibility tree snapshot | ✅ | ✅ |
| `diff` | Show changes since last snapshot | ✅ | ✅ |
| `act` | Click, type, fill, press, hover, scroll, drag | ✅ | ✅ |
| `download` | Download files from clicked links | ✅ | ✅ |
| `upload` | Upload files to `<input type=file>` | ✅ | ✅ |
| `read` | Read page content as markdown/text/links | ✅ | ✅ |
| `grep` | Search accessibility tree or page content | ✅ | ✅ |
| `screenshot` | Capture page screenshot | ✅ | ✅ |
| `pdf` | Save page as PDF | ✅ | ✅ |
| `wait` | Wait for text, selector, or time | ✅ | ✅ |
| `windows` | Manage browser windows | ✅ Full | ❌ Unsupported |
| `evaluate` | Evaluate JavaScript on a page | ✅ | ✅ |
| `run` | Run JavaScript with browser SDK access | ✅ | ✅ |

### Snapshot refs and page actions

The `snapshot` tool is the main page-interaction contract. It captures the
page Accessibility Tree, renders actionable elements with stable handles like
`[ref=e12]`, and stores the ref map for that page. Tools that operate on
specific elements use those refs instead of CSS selectors:

- `act` uses refs for `click`, `fill`, `hover`, `focus`, `check`, `uncheck`,
  `select`, `scroll`, and `drag`.
- `download` clicks a snapshot ref to trigger the download.
- `upload` resolves a snapshot ref for an `<input type=file>`.
- `grep` with `over="ax"` searches snapshot lines and returns matching refs.
- `screenshot` with `annotate=true` takes a fresh snapshot and paints the ref
  numbers onto the image.

The usual loop is:

```text
tabs list -> snapshot -> act(ref=eN) -> diff -> act(...) -> diff
```

`snapshot` and `diff` update the page observer state. `navigate` automatically
returns a fresh snapshot because navigation invalidates old refs, and `act`
automatically returns a diff so the caller can see the effect of the action.
If the DOM changes substantially, call `snapshot` again before reusing refs.

## MCP Prompts

The server registers one discoverable MCP prompt:

| Prompt | Description | Arguments |
|--------|-------------|-----------|
| `browser-automation` | BrowserOS observe-act-verify guidance for browser tasks. | `task` (optional string) |

Clients that support MCP prompts, such as Claude Desktop, can list prompts and
select `browser-automation` to insert the browser workflow guidance into a
conversation. The optional `task` argument appends a concrete browser task to
the prompt.

## Usage with MCP Clients

### Cursor / Claude Desktop

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "browseros-mcp": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Direct HTTP

```bash
# Health check
curl http://localhost:3000/health

# MCP endpoint
POST http://localhost:3000/mcp
Content-Type: application/json

{"jsonrpc": "2.0", "method": "tools/list", "id": 1}
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    HTTP+SSE Server                        │
│                  (Hono + @hono/mcp)                      │
│                      /mcp endpoint                        │
├─────────────────────────────────────────────────────────┤
│                  MCP Tool Layer                           │
│            16 tools (framework + registry)               │
│          ToolContext { session, signal }                 │
├─────────────────────────────────────────────────────────┤
│                BrowserSession                             │
│    ┌────────────┬───────────┬──────────┐                │
│    │ PageManager │ Observer  │  Input   │                │
│    │ (dual-mode) │ (AX tree) │ (actions) │                │
│    └──────┬─────┴─────┬─────┴────┬─────┘                │
│           │     Navigation    Screenshot                  │
│           │    FrameRegistry  WindowManager               │
├───────────┴─────────────────────────────────────────────┤
│              CdpConnectionImpl                            │
│    WebSocket → /json/version → ws://devtools/browser     │
│    Proxy-based ProtocolApi (55+ CDP domains)             │
├─────────────────────────────────────────────────────────┤
│         Chrome / BrowserOS (CDP port 9222/9100)          │
└─────────────────────────────────────────────────────────┘
```

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (auto-reload)
npm run dev

# Type check
npm run typecheck

# Build
npm run build
```

## License

MIT
