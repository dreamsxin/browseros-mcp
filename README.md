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

## LangChain Test Agent

The repository includes a Python smoke-test agent that connects to the MCP
server, discovers browser tools, fetches the `browser-automation` MCP prompt,
and calls an OpenAI-compatible chat model through LangChain.

Install Python dependencies:

```bash
pip install langchain-openai langchain-core requests
```

Create `example/browser_agent_config.json` from
`example/browser_agent_config.example.json` and fill in your model settings:

```json
{
  "mcp_url": "http://127.0.0.1:3000/mcp",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "api_key": "your-api-key",
  "temperature": 0,
  "workspace_dir": "."
}
```

The real config file is ignored by git. Command-line flags override environment
variables, which override the config file.

Start Chrome and this MCP server, then run the agent. Without a positional
prompt, the script starts a persistent interactive session and keeps the MCP
browser session plus chat history alive until you type `exit` or `quit`:

```bash
# In one terminal
npm start -- --backend chrome --mcp-port 3000

# In another terminal
python example/browser_agent_langchain.py
```

You can also pass a one-shot task and exit after the model finishes:

```bash
python example/browser_agent_langchain.py "open https://example.com and summarize it"
```

The test agent also injects three local file tools for saving and inspecting
test artifacts inside `workspace_dir`: `local_list_files`, `local_read_file`,
and `local_write_file`. A fuller browser-plus-file test prompt is:

```bash
python example/browser_agent_langchain.py "打开 https://www.baidu.com/，总结页面主要内容，并保存到 outputs/baidu-summary.md，然后读回文件确认"
```

Interactive mode prints extra diagnostics by default so tool selection can be
debugged while the model is running. The diagnostics include status transitions
such as `thinking`, `model-returned`, `executing`, `tool-returned`, and
`finalizing`; the approximate message size sent to the model; the latest input
preview; response finish reason; token usage and prompt cache hit rate when the
provider returns cache fields such as `prompt_cache_hit_tokens`; tool calls;
tool-result previews; and warnings for suspicious patterns such as empty model
responses, invalid tool calls, repeated identical calls, unknown tools, or extra
inspection tools after a successful `read`. Use `--quiet` to reduce this output,
or `--verbose` to enable the same diagnostics for one-shot prompts.

Diagnostic lines are colorized by data type when stderr is an interactive
terminal: status is cyan, model metadata is magenta, tool calls are yellow,
tool results are green, MCP events are blue, configuration is gray, and warnings
or errors are red. Use `--color always` or `--color never` to override automatic
detection.

If `--mcp-url` or `BROWSEROS_MCP_URL` is not provided, the script prompts for
the MCP URL first and defaults to `http://127.0.0.1:3000/mcp`.

For OpenAI-compatible local or proxy endpoints, update the config file or pass
`--base-url` and `--model`, for example:

```bash
python example/browser_agent_langchain.py --base-url http://127.0.0.1:8000/v1 --model qwen2.5 "list tabs"
```

### Local Agent Service

`example/browser_agent_service.py` wraps the same LangChain + MCP logic in a
small local HTTP service so browser UIs can reuse the agent loop instead of
reimplementing tool-calling in JavaScript.

It uses the same `example/browser_agent_config.json` file and Python
dependencies as the CLI script, then exposes:

- `GET /health`
- `POST /api/chat`
- `POST /api/reset`

Start it after the MCP server:

```bash
# In one terminal
npm start -- --backend chrome --mcp-port 3000

# In another terminal
python example/browser_agent_service.py --host 127.0.0.1 --port 8001
```

### Chrome Side Panel Extension

The repo also includes a simple Chrome MV3 side-panel extension in
`example/chrome-sidepanel-agent`. It connects to the local Python service,
persists chat state in `chrome.storage.local`, and renders the agent's returned
tool/diagnostic events in an execution trace panel.

To try it:

1. Start the MCP server and `python example/browser_agent_service.py`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Load `example/chrome-sidepanel-agent` as an unpacked extension.
5. Click the extension icon to open the side panel.

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
