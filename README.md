# Maccy Clipboard MCP Server

An MCP (Model Context Protocol) server that exposes your Maccy clipboard history to Claude and other AI assistants.

## Features

- 🔍 Search clipboard history with text patterns
- 📋 Get recent clipboard items with full content
- 🖼️ Image support - view images from clipboard history
- 📌 Pin/unpin important items
- 📊 View clipboard usage statistics
- 🗂️ Filter by application
- 📁 Export history to JSON/CSV/TXT formats
- 🗑️ Clear history with safety confirmations

## Prerequisites

- macOS with [Maccy](https://maccy.app) installed
- Node.js 16+
- Claude Desktop or other MCP-compatible client

## Installation

1. Clone this repository:
```bash
git clone <repository-url>
cd maccy-clipboard-mcp
```

2. Install dependencies:
```bash
npm install
```

3. Add to Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "maccy-clipboard": {
      "command": "node",
      "args": ["/path/to/maccy-clipboard-mcp/server/index.js"]
    }
  }
}
```

4. Restart Claude Desktop

## Available Tools

1. **search_clipboard** - Search by text pattern with filters
2. **get_recent_items** - Get recent items with image support
3. **copy_to_clipboard** - Copy item back to clipboard
4. **pin_item** / **unpin_item** - Manage pinned items
5. **clear_history** - Clear history (requires confirmation)
6. **export_history** - Export to local file
7. **get_clipboard_stats** - View usage statistics
8. **get_items_by_app** - Filter by application

## Image Support

The server automatically detects and returns images from your clipboard history:
- Images are returned as base64-encoded data
- Supports PNG, JPEG, TIFF, and other common formats
- Images are marked with 🖼️ indicator

## Notes

- All data stays local on your machine
- The server has read-only access by default (except for pin/unpin operations)
- Large exports are written to local files to avoid MCP size limits