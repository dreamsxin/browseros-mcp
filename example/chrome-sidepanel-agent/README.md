# Browser Control Agent Side Panel

Load this folder as an unpacked Chrome extension after the local Python service is running.

1. Start the Browser Control MCP server from the repo root.
2. Start `python example/browser_agent_service.py`.
3. Open `chrome://extensions`, enable Developer Mode, and load `example/chrome-sidepanel-agent`.
4. Click the extension icon to open the side panel.

The panel keeps a chat session in local storage. Use **Edit** on the last user
message to revise it and resubmit; the local service rewinds the previous agent
turn before running the revised prompt.
