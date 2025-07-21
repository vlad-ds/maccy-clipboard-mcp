# Maccy Clipboard MCP Server

An MCP (Model Context Protocol) server that exposes your Maccy clipboard history to Claude and other AI assistants.

## ⚠️ Important Security Warning

**This tool provides Claude access to your entire clipboard history, which may contain sensitive information such as passwords, API keys, personal data, or confidential content. When connected to external AI systems, this data could potentially be transmitted outside your local machine.**

**By using this MCP server, you acknowledge and accept full responsibility for any data exposure or security risks. The author disclaims all responsibility for any unauthorized access, data leaks, or security breaches that may result from using this tool.**

**Use at your own risk. Consider your security requirements carefully before installation.**

## About Maccy

[Maccy](https://maccy.app) is a lightweight clipboard manager for macOS that keeps a history of everything you copy. It runs in your menu bar and stores clipboard items locally in a SQLite database. This MCP server connects directly to that database to give Claude access to your clipboard history, allowing you to search, retrieve, and manage your copied content through natural conversation.

## Features

- 🔍 Search clipboard history with text patterns
- 📋 Get recent clipboard items with full content
- 🖼️ Image support - view images from clipboard history
- 📌 Pin/unpin important items
- 📊 View clipboard usage statistics
- 🗂️ Filter by application
- 📁 Export history to JSON/CSV/TXT formats

## Prerequisites

- macOS with [Maccy](https://maccy.app) installed
- Node.js 16+
- Claude Desktop or other MCP-compatible client

## Installation

### Easy Installation (Recommended)

1. Download the `maccy-clipboard-mcp.dxt` file from this repository
2. Double-click the `.dxt` file to open it in Claude Desktop
3. Claude Desktop will automatically install and configure the MCP server
4. Restart Claude Desktop

### Manual Installation

If you encounter issues with the .dxt installation:

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

### Troubleshooting

If you encounter issues loading the extension or Node.js related problems:

#### Required Node.js Configuration (if issues occur)

⚠️ **If the extension fails to load**, try disabling Claude Desktop's built-in Node.js:

1. **Install Node.js LTS**: Visit [nodejs.org](https://nodejs.org) and download the LTS version
2. **Configure Claude Desktop**:
   - Go to Claude > Settings > Extensions > Advanced Settings
   - **Disable** "Use Built-in Node.js for MCP"  
   - Restart Claude Desktop

Some users may need to use their system's Node.js installation instead of Claude's built-in version.

#### Additional Troubleshooting Steps

If you still experience issues:
1. Verify Node.js is installed: Run `node --version` in your terminal
2. Ensure "Use Built-in Node.js for MCP" is disabled in Claude Desktop settings
3. Restart Claude Desktop completely
4. Check the logs at `~/Library/Logs/Claude/` (macOS) or `%LOCALAPPDATA%\Claude\Logs\` (Windows) for MCP server error details

## Available Tools

1. **search_clipboard** - Search by text pattern with filters
2. **get_recent_items** - Get recent items with image support (images shown by default)
3. **copy_to_clipboard** - Copy item back to clipboard (supports both text and images)
4. **pin_item** / **unpin_item** - Manage pinned items
5. **export_history** - Export to local file
6. **get_clipboard_stats** - View usage statistics
7. **get_items_by_app** - Filter by application with image support

## Image Support

The server automatically detects and returns images from your clipboard history:
- Images are shown by default in recent items and searches
- Images are returned as base64-encoded data with thumbnail sizing (100px width)
- Supports PNG, JPEG, TIFF, and other common formats
- Images are marked with 🖼️ indicator
- Both text and image content can be copied back to the clipboard

## Notes

- All data stays local on your machine
- The server has read-only access by default (except for pin/unpin operations)
- Large exports are written to local files to avoid MCP size limits