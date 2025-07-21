# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

This is an MCP (Model Context Protocol) server that provides access to Maccy clipboard history on macOS. The server is built using Node.js with ES modules and the MCP SDK.

### Core Components

**Server Entry Point**: `server/index.js` - Single-file MCP server that handles all tool requests via stdio transport

**Database Access**: The server connects directly to Maccy's SQLite database at:
```
~/Library/Containers/org.p0deje.Maccy/Data/Library/Application Support/Maccy/Storage.sqlite
```

**Key Classes**:
- `ClipboardDB` - Main database wrapper class with promisified SQLite operations
- Database operates in read-only mode by default, except for pin/unpin operations

### Data Model

Maccy uses a Core Data SQLite schema with these key tables:
- `ZHISTORYITEM` - Main clipboard items (id, title, application, timestamps, pin status)
- `ZHISTORYITEMCONTENT` - Content by type (text, images as BLOBs)

**Timestamp Conversion**: Maccy uses Mac epoch (2001-01-01), requires +978307200 conversion to Unix epoch.

**Content Types**:
- Text: `public.utf8-plain-text`, `public.text`
- Images: `public.png`, `public.jpeg`, `public.tiff`, `com.apple.NSImage`

## Available MCP Tools

1. **search_clipboard** - Text/regex search with date/app filtering
2. **get_recent_items** - Recent items (images shown by default)
3. **copy_to_clipboard** - Copy text/images back to clipboard via pbcopy/osascript
4. **pin_item/unpin_item** - Manage pinned items
5. **export_history** - Export to JSON/CSV/TXT
6. **get_clipboard_stats** - Usage statistics
7. **get_items_by_app** - Filter by application

## Development Commands

**Installation**:
```bash
npm install
```

**Run Server** (for testing):
```bash
node server/index.js
```

**Package for Distribution**:
The project includes a `.dxt` file for easy Claude Desktop installation. The `dxt/` folder contains DXT tooling but isn't part of the main MCP server.

## Key Implementation Details

**Image Handling**: 
- Images stored as SQLite BLOBs, converted to base64 for MCP transport
- Thumbnails use `width: 100` property for display optimization
- Image copying uses temporary files + osascript for proper clipboard integration

**Text Sanitization**: 
- `sanitizeText()` removes only problematic control characters (`[\x00-\x08\x0B\x0C\x0E-\x1F]`)
- Avoids aggressive Unicode filtering to prevent text corruption

**Logging**: 
- All operations logged to `mcp-debug.log` in current working directory
- Handles Buffer objects and circular references in log data

**Error Handling**: 
- Database connection failures are handled gracefully
- Individual item formatting errors don't break entire responses
- JSON serialization validation before returning MCP responses

## Platform Requirements

- macOS only (accesses Maccy's SQLite database)
- Node.js 16+ with ES module support
- Maccy application must be installed and have clipboard history
- SQLite3 native dependency (automatically built during npm install)