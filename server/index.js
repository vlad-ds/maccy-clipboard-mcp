#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";

// Logging utility
function logToFile(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    data: data ? JSON.stringify(data, (key, value) => {
      // Handle Buffer objects in logging
      if (Buffer.isBuffer(value)) {
        return `[Buffer: ${value.length} bytes]`;
      }
      // Handle circular references and other problematic objects
      if (typeof value === 'object' && value !== null) {
        try {
          JSON.stringify(value);
          return value;
        } catch (e) {
          return `[Object: ${e.message}]`;
        }
      }
      return value;
    }, 2) : null
  };
  
  const logLine = `[${level.toUpperCase()}] ${timestamp}: ${message}${data ? `\nData: ${logEntry.data}` : ''}\n`;
  
  try {
    // Write to both stderr and file
    console.error(logLine.trim());
    const logPath = path.join(process.cwd(), 'mcp-debug.log');
    fsSync.appendFileSync(logPath, logLine);
  } catch (e) {
    console.error(`[ERROR] ${timestamp}: Failed to log message: ${e.message}`);
  }
}

// Maccy database path
const MACCY_DB_PATH = path.join(
  os.homedir(),
  "Library/Containers/org.p0deje.Maccy/Data/Library/Application Support/Maccy/Storage.sqlite"
);

// SQLite database wrapper with promises
class ClipboardDB {
  constructor(readOnly = true) {
    const mode = readOnly ? sqlite3.OPEN_READONLY : (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    this.db = new sqlite3.Database(MACCY_DB_PATH, mode);
    
    // Configure database to handle BLOBs properly
    this.db.configure('busyTimeout', 10000);
    
    this.get = promisify(this.db.get.bind(this.db));
    this.all = promisify(this.db.all.bind(this.db));
    this.run = promisify(this.db.run.bind(this.db));
  }

  // Sanitize text content to ensure valid UTF-8 and remove invalid Unicode sequences
  sanitizeText(text) {
    if (!text) return text;
    
    try {
      // Convert to string if needed
      let str = typeof text === 'string' ? text : text.toString();
      
      // Remove null bytes and other control characters
      str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      
      // Replace invalid UTF-8 sequences and unpaired surrogates
      // This regex matches unpaired high surrogates, unpaired low surrogates, and non-characters
      str = str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
      
      // Additional fix for specific case - remove any remaining problematic Unicode sequences
      str = str.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
      
      // Remove other problematic Unicode characters
      str = str.replace(/[\uFFFE\uFFFF]/g, '');
      
      // Additional cleanup for common problematic patterns
      // Remove zero-width characters that can cause issues
      str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
      
      // Ensure the string is valid UTF-8 by encoding and decoding
      const encoded = Buffer.from(str, 'utf8');
      const decoded = encoded.toString('utf8');
      
      // Final check - try to JSON stringify to ensure it's safe
      JSON.stringify(decoded);
      
      return decoded;
    } catch (e) {
      // If all else fails, return a safe placeholder
      return '[Content could not be sanitized]';
    }
  }

  // Convert Maccy timestamp (seconds since 2001-01-01) to JavaScript Date
  convertTimestamp(maccyTimestamp) {
    // Add 978307200 to convert from Mac epoch to Unix epoch
    const unixTimestamp = maccyTimestamp + 978307200;
    return new Date(unixTimestamp * 1000);
  }

  // Format date for display
  formatDate(date) {
    return date.toLocaleString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short", 
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
  }

  async searchClipboard(query, limit = 10, useRegex = false, dateRange = null, appFilter = null) {
    // First, search for matching items
    let sql = `
      SELECT DISTINCT h.Z_PK as id, h.ZTITLE, h.ZAPPLICATION, h.ZLASTCOPIEDAT, h.ZNUMBEROFCOPIES, h.ZPIN
      FROM ZHISTORYITEM h 
      LEFT JOIN ZHISTORYITEMCONTENT c ON h.Z_PK = c.ZITEM
      WHERE 1=1
    `;
    const params = [];
    
    // Add search condition - search in title and text content only
    if (useRegex) {
      // Note: REGEXP might not be available in all SQLite builds
      sql += ` AND (h.ZTITLE LIKE ? OR (c.ZTYPE = 'public.utf8-plain-text' AND c.ZVALUE LIKE ?))`;
      // For now, fallback to LIKE with % wildcards for regex-like behavior
      params.push(`%${query}%`, `%${query}%`);
    } else {
      sql += ` AND (h.ZTITLE LIKE ? OR (c.ZTYPE = 'public.utf8-plain-text' AND c.ZVALUE LIKE ?))`;
      const searchPattern = `%${query}%`;
      params.push(searchPattern, searchPattern);
    }
    
    // Add date range filter
    if (dateRange) {
      const { since, until } = dateRange;
      if (since) {
        sql += ` AND h.ZLASTCOPIEDAT >= ?`;
        params.push((since.getTime() / 1000) - 978307200);
      }
      if (until) {
        sql += ` AND h.ZLASTCOPIEDAT <= ?`;
        params.push((until.getTime() / 1000) - 978307200);
      }
    }
    
    // Add app filter
    if (appFilter) {
      sql += ` AND h.ZAPPLICATION = ?`;
      params.push(appFilter);
    }
    
    sql += ` ORDER BY h.ZLASTCOPIEDAT DESC LIMIT ?`;
    params.push(limit);
    
    const historyItems = await this.all(sql, params);
    
    // Then get all content for these items
    const results = [];
    for (const item of historyItems) {
      const contentSql = `
        SELECT ZTYPE, ZVALUE 
        FROM ZHISTORYITEMCONTENT 
        WHERE ZITEM = ?
      `;
      const contentRows = await this.all(contentSql, [item.id]);
      
      const itemData = {
        id: item.id,
        title: item.ZTITLE,
        application: item.ZAPPLICATION,
        lastCopied: this.formatDate(this.convertTimestamp(item.ZLASTCOPIEDAT)),
        copyCount: item.ZNUMBEROFCOPIES,
        pinned: item.ZPIN !== null,
        content: {}
      };
      
      // Group all content types for this item
      for (const contentRow of contentRows) {
        if (contentRow.ZVALUE !== null) {
          // Check if it's binary data (Buffer) - SQLite returns BLOB as Buffer
          if (Buffer.isBuffer(contentRow.ZVALUE)) {
            // Keep as Buffer for binary data (typically images)
            itemData.content[contentRow.ZTYPE] = contentRow.ZVALUE;
          } else {
            // Convert to string for text content and sanitize
            itemData.content[contentRow.ZTYPE] = this.sanitizeText(contentRow.ZVALUE.toString());
          }
        }
      }
      
      results.push(itemData);
    }
    
    return results;
  }

  async getRecentItems(limit = 10, application = null, excludeImages = true) {
    // First get the history items
    // Fetch extra items to account for ones that might be filtered out
    const fetchLimit = excludeImages ? limit * 3 : limit;
    
    let sql = `
      SELECT h.Z_PK as id, h.ZTITLE, h.ZAPPLICATION, h.ZLASTCOPIEDAT, h.ZNUMBEROFCOPIES, h.ZPIN
      FROM ZHISTORYITEM h
    `;
    const params = [];
    
    if (application) {
      sql += ` WHERE h.ZAPPLICATION = ?`;
      params.push(application);
    }
    
    sql += ` ORDER BY h.ZLASTCOPIEDAT DESC LIMIT ?`;
    params.push(fetchLimit);
    
    const historyItems = await this.all(sql, params);
    
    // Then get content for these items, optionally excluding images
    const results = [];
    for (const item of historyItems) {
      let contentSql = `
        SELECT ZTYPE, ZVALUE 
        FROM ZHISTORYITEMCONTENT 
        WHERE ZITEM = ?
      `;
      
      if (excludeImages) {
        contentSql += ` AND ZTYPE NOT IN ('public.png', 'public.jpeg', 'public.tiff', 'com.apple.NSImage') 
                        AND ZTYPE NOT LIKE 'image/%'`;
      }
      
      const contentRows = await this.all(contentSql, [item.id]);
      
      const itemData = {
        id: item.id,
        title: item.ZTITLE,
        application: item.ZAPPLICATION,
        lastCopied: this.formatDate(this.convertTimestamp(item.ZLASTCOPIEDAT)),
        copyCount: item.ZNUMBEROFCOPIES,
        pinned: item.ZPIN !== null,
        content: {}
      };
      
      // Group all content types for this item
      for (const contentRow of contentRows) {
        if (contentRow.ZVALUE !== null) {
          // Skip image types if excluding images
          if (excludeImages && (
            contentRow.ZTYPE === 'public.png' || 
            contentRow.ZTYPE === 'public.jpeg' || 
            contentRow.ZTYPE === 'public.tiff' || 
            contentRow.ZTYPE === 'com.apple.NSImage' ||
            contentRow.ZTYPE.startsWith('image/')
          )) {
            continue;
          }
          
          // Check if it's binary data (Buffer) - SQLite returns BLOB as Buffer
          if (Buffer.isBuffer(contentRow.ZVALUE)) {
            // Keep as Buffer for binary data (typically images)
            itemData.content[contentRow.ZTYPE] = contentRow.ZVALUE;
            // console.error(`DEBUG: Found Buffer data for type ${contentRow.ZTYPE}, size: ${contentRow.ZVALUE.length} bytes`);
          } else {
            // Convert to string for text content and sanitize
            itemData.content[contentRow.ZTYPE] = this.sanitizeText(contentRow.ZVALUE.toString());
          }
        }
      }
      
      // Only include items that have content after filtering (or if we have a title)
      if (Object.keys(itemData.content).length > 0 || itemData.title) {
        results.push(itemData);
        
        // Stop if we've collected enough items
        if (results.length >= limit) {
          break;
        }
      }
    }
    
    return results;
  }

  async getStatistics() {
    const totalItems = await this.get(`SELECT COUNT(*) as count FROM ZHISTORYITEM`);
    const topApps = await this.all(`
      SELECT ZAPPLICATION as app, COUNT(*) as count 
      FROM ZHISTORYITEM 
      GROUP BY ZAPPLICATION 
      ORDER BY count DESC 
      LIMIT 5
    `);
    const oldestItem = await this.get(`
      SELECT MIN(ZLASTCOPIEDAT) as oldest FROM ZHISTORYITEM
    `);
    const newestItem = await this.get(`
      SELECT MAX(ZLASTCOPIEDAT) as newest FROM ZHISTORYITEM
    `);

    return {
      totalItems: totalItems.count,
      topApplications: topApps.map(app => ({
        application: app.app,
        itemCount: app.count
      })),
      oldestItem: oldestItem.oldest ? this.formatDate(this.convertTimestamp(oldestItem.oldest)) : null,
      newestItem: newestItem.newest ? this.formatDate(this.convertTimestamp(newestItem.newest)) : null
    };
  }

  async getItemsByApplication(application, limit = 10) {
    return this.getRecentItems(limit, application, true);
  }

  async getItemById(id) {
    const sql = `
      SELECT h.Z_PK as id, h.ZTITLE, h.ZAPPLICATION, h.ZLASTCOPIEDAT, h.ZNUMBEROFCOPIES, h.ZPIN,
             c.ZTYPE, c.ZVALUE
      FROM ZHISTORYITEM h 
      LEFT JOIN ZHISTORYITEMCONTENT c ON h.Z_PK = c.ZITEM
      WHERE h.Z_PK = ?
    `;
    const results = await this.all(sql, [id]);
    
    if (results.length === 0) return null;
    
    // Group content by type for the same item
    const item = {
      id: results[0].id,
      title: this.sanitizeText(results[0].ZTITLE),
      application: results[0].ZAPPLICATION,
      lastCopied: this.formatDate(this.convertTimestamp(results[0].ZLASTCOPIEDAT)),
      copyCount: results[0].ZNUMBEROFCOPIES,
      pinned: results[0].ZPIN !== null,
      content: {}
    };
    
    for (const row of results) {
      if (row.ZTYPE && row.ZVALUE) {
        // For BLOB data (images), ensure it's stored as a Buffer
        if (row.ZTYPE === 'public.png' || row.ZTYPE === 'public.jpeg' || 
            row.ZTYPE === 'public.tiff' || row.ZTYPE.startsWith('image/') ||
            row.ZTYPE === 'com.apple.NSImage') {
          if (Buffer.isBuffer(row.ZVALUE)) {
            item.content[row.ZTYPE] = row.ZVALUE;
          }
        } else {
          // For text content, convert to string and sanitize
          item.content[row.ZTYPE] = this.sanitizeText(row.ZVALUE?.toString() || row.ZVALUE);
        }
      }
    }
    
    return item;
  }

  async copyToClipboard(itemId) {
    const item = await this.getItemById(itemId);
    if (!item) throw new Error(`Item with ID ${itemId} not found`);
    
    // Get the text content to copy
    const textContent = item.content['public.utf8-plain-text'] || 
                       item.content['public.text'] || 
                       item.title;
    
    if (!textContent) throw new Error('No text content found to copy');
    
    // Use pbcopy to set clipboard on macOS
    try {
      execSync('pbcopy', { input: textContent.toString(), encoding: 'utf8' });
      return { success: true, content: textContent.toString() };
    } catch (error) {
      throw new Error(`Failed to copy to clipboard: ${error.message}`);
    }
  }

  async pinItem(itemId) {
    const sql = `UPDATE ZHISTORYITEM SET ZPIN = ? WHERE Z_PK = ?`;
    await this.run(sql, [new Date().toISOString(), itemId]);
    return { success: true, itemId, action: 'pinned' };
  }

  async unpinItem(itemId) {
    const sql = `UPDATE ZHISTORYITEM SET ZPIN = NULL WHERE Z_PK = ?`;
    await this.run(sql, [itemId]);
    return { success: true, itemId, action: 'unpinned' };
  }

  async clearHistory(beforeDate = null, confirm = false) {
    if (!confirm) {
      throw new Error('This action requires confirmation. Set confirm=true to proceed.');
    }
    
    let sql = `DELETE FROM ZHISTORYITEM`;
    const params = [];
    
    if (beforeDate) {
      sql += ` WHERE ZLASTCOPIEDAT < ?`;
      params.push((beforeDate.getTime() / 1000) - 978307200);
    }
    
    const result = await this.run(sql, params);
    return { success: true, deletedCount: result.changes };
  }

  async exportHistory(filePath, format = 'json', dateRange = null) {
    // Validate file path
    const resolvedPath = path.resolve(filePath);
    const dir = path.dirname(resolvedPath);
    
    try {
      await fs.access(dir);
    } catch (error) {
      throw new Error(`Directory does not exist: ${dir}`);
    }
    
    let sql = `
      SELECT h.Z_PK as id, h.ZTITLE, h.ZAPPLICATION, h.ZLASTCOPIEDAT, h.ZNUMBEROFCOPIES, h.ZPIN,
             c.ZTYPE, c.ZVALUE
      FROM ZHISTORYITEM h 
      LEFT JOIN ZHISTORYITEMCONTENT c ON h.Z_PK = c.ZITEM
      WHERE 1=1
    `;
    const params = [];
    
    if (dateRange) {
      const { since, until } = dateRange;
      if (since) {
        sql += ` AND h.ZLASTCOPIEDAT >= ?`;
        params.push((since.getTime() / 1000) - 978307200);
      }
      if (until) {
        sql += ` AND h.ZLASTCOPIEDAT <= ?`;
        params.push((until.getTime() / 1000) - 978307200);
      }
    }
    
    sql += ` ORDER BY h.ZLASTCOPIEDAT DESC`;
    const results = await this.all(sql, params);
    
    // Group results by item ID
    const items = {};
    for (const row of results) {
      if (!items[row.id]) {
        items[row.id] = {
          id: row.id,
          title: this.sanitizeText(row.ZTITLE),
          application: row.ZAPPLICATION,
          lastCopied: this.formatDate(this.convertTimestamp(row.ZLASTCOPIEDAT)),
          copyCount: row.ZNUMBEROFCOPIES,
          pinned: row.ZPIN !== null,
          content: {}
        };
      }
      if (row.ZTYPE && row.ZVALUE) {
        // For binary data (images), include metadata but not raw data in export
        if (row.ZTYPE === 'public.png' || row.ZTYPE === 'public.jpeg' || 
            row.ZTYPE === 'public.tiff' || row.ZTYPE.startsWith('image/')) {
          items[row.id].content[row.ZTYPE] = `[Binary data: ${row.ZVALUE.length} bytes]`;
        } else {
          items[row.id].content[row.ZTYPE] = this.sanitizeText(row.ZVALUE?.toString() || row.ZVALUE);
        }
      }
    }
    
    const itemArray = Object.values(items);
    let exportData;
    
    switch (format.toLowerCase()) {
      case 'json':
        exportData = JSON.stringify(itemArray, null, 2);
        break;
      case 'csv':
        const csvHeader = 'ID,Title,Application,LastCopied,CopyCount,Pinned,Content\n';
        const csvRows = itemArray.map(item => {
          const content = item.content['public.utf8-plain-text'] || item.title || '';
          const escapedContent = `"${content.replace(/"/g, '""')}"`;
          return `${item.id},"${item.title}","${item.application}","${item.lastCopied}",${item.copyCount},${item.pinned},${escapedContent}`;
        }).join('\n');
        exportData = csvHeader + csvRows;
        break;
      case 'txt':
        exportData = itemArray.map(item => {
          const content = item.content['public.utf8-plain-text'] || item.title || '';
          return `[${item.lastCopied}] ${item.application}\n${content}\n${'='.repeat(50)}`;
        }).join('\n\n');
        break;
      default:
        throw new Error(`Unsupported format: ${format}. Supported formats: json, csv, txt`);
    }
    
    // Write to file
    await fs.writeFile(resolvedPath, exportData, 'utf8');
    
    return {
      success: true,
      filePath: resolvedPath,
      itemCount: itemArray.length,
      fileSize: Buffer.byteLength(exportData, 'utf8')
    };
  }

  close() {
    this.db.close();
  }
}

const server = new Server(
  {
    name: "maccy-clipboard-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_clipboard",
        description: "Search clipboard history by text pattern or regex",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text pattern or regex to search for in clipboard history",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 10)",
              default: 10,
            },
            use_regex: {
              type: "boolean",
              description: "Use regex pattern matching (default: false)",
              default: false,
            },
            app_filter: {
              type: "string",
              description: "Filter by application bundle identifier",
            },
            since: {
              type: "string",
              description: "ISO date string - only return items copied since this date",
            },
            until: {
              type: "string",
              description: "ISO date string - only return items copied before this date",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_recent_items",
        description: "Get recent clipboard items with optional filters",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of items to return (default: 10)",
              default: 10,
            },
            application: {
              type: "string",
              description: "Filter by application that copied the item",
            },
            exclude_images: {
              type: "boolean",
              description: "Exclude images from the results (default: true)",
              default: true,
            },
          },
        },
      },
      {
        name: "copy_to_clipboard",
        description: "Copy a specific history item back to current clipboard",
        inputSchema: {
          type: "object",
          properties: {
            item_id: {
              type: "number",
              description: "ID of the clipboard item to copy",
            },
          },
          required: ["item_id"],
        },
      },
      {
        name: "pin_item",
        description: "Pin a clipboard item for persistence",
        inputSchema: {
          type: "object",
          properties: {
            item_id: {
              type: "number",
              description: "ID of the clipboard item to pin",
            },
          },
          required: ["item_id"],
        },
      },
      {
        name: "unpin_item", 
        description: "Unpin a clipboard item",
        inputSchema: {
          type: "object",
          properties: {
            item_id: {
              type: "number",
              description: "ID of the clipboard item to unpin",
            },
          },
          required: ["item_id"],
        },
      },
      {
        name: "clear_history",
        description: "Clear clipboard history (requires confirmation)",
        inputSchema: {
          type: "object",
          properties: {
            before_date: {
              type: "string",
              description: "ISO date string - only clear items before this date (optional)",
            },
            confirm: {
              type: "boolean",
              description: "Confirmation flag - must be true to proceed",
              default: false,
            },
          },
          required: ["confirm"],
        },
      },
      {
        name: "export_history",
        description: "Export clipboard history to a local file",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Local file path where to save the export (e.g., ~/Desktop/clipboard_export.json)",
            },
            format: {
              type: "string",
              enum: ["json", "csv", "txt"],
              description: "Export format (default: json)",
              default: "json",
            },
            since: {
              type: "string",
              description: "ISO date string - only export items since this date",
            },
            until: {
              type: "string",
              description: "ISO date string - only export items before this date",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "get_clipboard_stats",
        description: "Get clipboard usage statistics",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_items_by_app",
        description: "Get clipboard items from specific application",
        inputSchema: {
          type: "object",
          properties: {
            application: {
              type: "string",
              description: "Application bundle identifier (e.g., com.google.Chrome)",
            },
            limit: {
              type: "number",
              description: "Maximum number of items to return (default: 10)",
              default: 10,
            },
          },
          required: ["application"],
        },
      },
    ],
  };
});

// Helper function to format clipboard items with image support
function formatClipboardItem(item, includeImages = false) {
  try {
    logToFile('debug', `Formatting clipboard item ${item.id}`, {
      itemId: item.id,
      includeImages,
      contentKeys: item.content ? Object.keys(item.content) : [],
      hasTitle: !!item.title
    });
    
    const content = [];
    
    // Add text description
    const textContent = item.content && typeof item.content === 'object' ? 
      item.content['public.utf8-plain-text'] || item.content['public.text'] || item.title : 
      item.content || item.title;
  
  // Count different content types
  const contentTypes = item.content && typeof item.content === 'object' ? Object.keys(item.content) : [];
  const hasImages = contentTypes.some(type => 
    type === 'public.png' || type === 'public.jpeg' || type === 'public.tiff' || 
    type.startsWith('image/') || type === 'com.apple.NSImage'
  );
  
  content.push({
    type: "text",
    text: `📋 **${item.application}** (${item.lastCopied}) [ID: ${item.id}]\n` +
          `   Content: ${typeof textContent === 'string' ? textContent.substring(0, 100) : String(textContent || '').substring(0, 100)}${(textContent?.length || 0) > 100 ? '...' : ''}\n` +
          `   Content Types: ${contentTypes.join(', ')}\n` +
          `   Copied ${item.copyCount} times${item.pinned ? ' 📌 Pinned' : ''}${hasImages ? ' 🖼️ Has Images' : ''}\n`
  });
  
  // Add images if present and requested
  if (includeImages && hasImages && item.content && typeof item.content === 'object') {
    // console.error(`DEBUG: Processing item ${item.id} with image content. Content types: ${Object.keys(item.content).join(', ')}`);
    for (const [contentType, value] of Object.entries(item.content)) {
      if (contentType === 'public.png' || contentType === 'public.jpeg' || 
          contentType === 'public.tiff' || contentType.startsWith('image/') ||
          contentType === 'com.apple.NSImage') {
        // console.error(`DEBUG: Processing image type ${contentType}, value type: ${typeof value}, isBuffer: ${Buffer.isBuffer(value)}`);
        try {
          // Handle different possible value types
          let base64Data;
          if (Buffer.isBuffer(value)) {
            base64Data = value.toString('base64');
          } else if (typeof value === 'string') {
            // Value might be a hex string or already base64
            base64Data = Buffer.from(value, 'binary').toString('base64');
          } else if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
            // Handle JSON-serialized Buffer
            base64Data = Buffer.from(value.data).toString('base64');
          } else {
            throw new Error(`Unknown value type: ${typeof value}`);
          }
          
          logToFile('debug', `Processing image data`, {
            itemId: item.id,
            contentType,
            originalSize: value?.length || 0,
            base64Size: base64Data?.length || 0,
            sampleData: base64Data?.substring(0, 50) + '...'
          });
          
          // Validate base64 data before adding to response
          try {
            JSON.stringify({ data: base64Data });
          } catch (jsonError) {
            logToFile('warn', `Base64 data failed JSON validation`, {
              itemId: item.id,
              contentType,
              error: jsonError.message
            });
            throw new Error(`Base64 data validation failed: ${jsonError.message}`);
          }
          
          content.push({
            type: "image",
            data: base64Data,
            mimeType: contentType === 'public.png' ? 'image/png' : 
                     contentType === 'public.jpeg' ? 'image/jpeg' :
                     contentType === 'public.tiff' ? 'image/tiff' : 
                     contentType === 'com.apple.NSImage' ? 'image/png' :
                     contentType
          });
        } catch (error) {
          content.push({
            type: "text",
            text: `   📷 Image content (${contentType}) - Size: ${value?.length || 0} bytes [Error: ${error.message}]\n`
          });
        }
      }
    }
  }
  
  logToFile('debug', `Clipboard item formatted successfully`, {
    itemId: item.id,
    contentParts: content.length,
    hasImages: content.some(c => c.type === 'image')
  });
  
  return content;
  } catch (error) {
    logToFile('error', `Error formatting clipboard item ${item.id}`, {
      itemId: item.id,
      error: error.message,
      stack: error.stack
    });
    
    // Return a safe fallback
    return [{
      type: "text",
      text: `⚠️ Error formatting item ${item.id}: ${error.message}\n`
    }];
  }
}

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const requestId = Math.random().toString(36).substr(2, 9);
  
  logToFile('info', `Tool call started: ${request.params.name}`, {
    requestId,
    toolName: request.params.name,
    arguments: request.params.arguments
  });
  
  const readOnly = !['copy_to_clipboard', 'pin_item', 'unpin_item', 'clear_history'].includes(request.params.name);
  const db = new ClipboardDB(readOnly);
  
  try {
    switch (request.params.name) {
      case "search_clipboard": {
        const { query, limit = 10, use_regex = false, app_filter, since, until } = request.params.arguments;
        
        let dateRange = null;
        if (since || until) {
          dateRange = {};
          if (since) dateRange.since = new Date(since);
          if (until) dateRange.until = new Date(until);
        }
        
        const results = await db.searchClipboard(query, limit, use_regex, dateRange, app_filter);
        
        const content = [
          {
            type: "text",
            text: `Found ${results.length} clipboard items matching "${query}":\n\n`
          }
        ];
        
        for (const item of results) {
          content.push(...formatClipboardItem(item, true));
        }
        
        const response = { content };
        
        // Validate response can be serialized to JSON before returning
        try {
          const serialized = JSON.stringify(response);
          logToFile('debug', `Search response prepared and validated`, {
            requestId,
            resultsCount: results.length,
            responseSize: serialized.length,
            contentItemsCount: content.length
          });
        } catch (jsonError) {
          logToFile('error', `Search response failed JSON validation`, {
            requestId,
            error: jsonError.message,
            resultsCount: results.length,
            contentItemsCount: content.length
          });
          throw new Error(`Response serialization failed: ${jsonError.message}`);
        }
        
        return response;
      }

      case "get_recent_items": {
        const { limit = 10, application, exclude_images = true } = request.params.arguments;
        const results = await db.getRecentItems(limit, application, exclude_images);
        
        const filterText = application ? ` from ${application}` : '';
        const content = [
          {
            type: "text",
            text: `Recent ${results.length} clipboard items${filterText}:\n\n`
          }
        ];
        
        for (const item of results) {
          try {
            content.push(...formatClipboardItem(item, !exclude_images));
          } catch (err) {
            // If formatting fails for an item, add error info instead
            content.push({
              type: "text",
              text: `⚠️ Error formatting item ${item.id}: ${err.message}\n`
            });
          }
        }
        
        const response = { content };
        
        // Validate response can be serialized to JSON before returning
        try {
          const serialized = JSON.stringify(response);
          logToFile('debug', `Recent items response prepared and validated`, {
            requestId,
            resultsCount: results.length,
            responseSize: serialized.length,
            contentItemsCount: content.length,
            excludeImages: exclude_images
          });
        } catch (jsonError) {
          logToFile('error', `Recent items response failed JSON validation`, {
            requestId,
            error: jsonError.message,
            resultsCount: results.length,
            contentItemsCount: content.length
          });
          throw new Error(`Response serialization failed: ${jsonError.message}`);
        }
        
        return response;
      }

      case "copy_to_clipboard": {
        const { item_id } = request.params.arguments;
        const result = await db.copyToClipboard(item_id);
        
        const contentPreview = typeof result.content === 'string' ? result.content : String(result.content || '');
        return {
          content: [
            {
              type: "text",
              text: `✅ Successfully copied item ${item_id} to clipboard:\n${contentPreview.substring(0, 200)}${contentPreview.length > 200 ? '...' : ''}`,
            },
          ],
        };
      }

      case "pin_item": {
        const { item_id } = request.params.arguments;
        const result = await db.pinItem(item_id);
        
        return {
          content: [
            {
              type: "text",
              text: `📌 Successfully pinned clipboard item ${item_id}`,
            },
          ],
        };
      }

      case "unpin_item": {
        const { item_id } = request.params.arguments;
        const result = await db.unpinItem(item_id);
        
        return {
          content: [
            {
              type: "text",
              text: `📌 Successfully unpinned clipboard item ${item_id}`,
            },
          ],
        };
      }

      case "clear_history": {
        const { before_date, confirm } = request.params.arguments;
        
        let beforeDate = null;
        if (before_date) {
          beforeDate = new Date(before_date);
        }
        
        const result = await db.clearHistory(beforeDate, confirm);
        
        const dateText = beforeDate ? ` before ${beforeDate.toLocaleDateString()}` : '';
        return {
          content: [
            {
              type: "text",
              text: `🗑️ Successfully cleared ${result.deletedCount} clipboard items${dateText}`,
            },
          ],
        };
      }

      case "export_history": {
        const { file_path, format = 'json', since, until } = request.params.arguments;
        
        let dateRange = null;
        if (since || until) {
          dateRange = {};
          if (since) dateRange.since = new Date(since);
          if (until) dateRange.until = new Date(until);
        }
        
        const result = await db.exportHistory(file_path, format, dateRange);
        
        return {
          content: [
            {
              type: "text",
              text: `📄 Successfully exported clipboard history!\n\n` +
                    `**File:** ${result.filePath}\n` +
                    `**Format:** ${format.toUpperCase()}\n` +
                    `**Items:** ${result.itemCount}\n` +
                    `**File Size:** ${(result.fileSize / 1024).toFixed(1)} KB`,
            },
          ],
        };
      }

      case "get_clipboard_stats": {
        const stats = await db.getStatistics();
        
        return {
          content: [
            {
              type: "text",
              text: `📊 **Clipboard Statistics**\n\n` +
                `Total Items: ${stats.totalItems}\n` +
                `Date Range: ${stats.oldestItem} → ${stats.newestItem}\n\n` +
                `**Top Applications:**\n` +
                stats.topApplications.map(app => 
                  `• ${app.application}: ${app.itemCount} items`
                ).join('\n'),
            },
          ],
        };
      }

      case "get_items_by_app": {
        const { application, limit = 10 } = request.params.arguments;
        const results = await db.getItemsByApplication(application, limit);
        
        const content = [
          {
            type: "text",
            text: `Found ${results.length} clipboard items from ${application}:\n\n`
          }
        ];
        
        for (const item of results) {
          content.push(...formatClipboardItem(item, false));
        }
        
        return { content };
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    logToFile('error', `Tool call failed: ${request.params.name}`, {
      requestId,
      toolName: request.params.name,
      error: error.message,
      stack: error.stack
    });
    
    const errorResponse = {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
    
    logToFile('debug', `Error response prepared`, {
      requestId,
      responseSize: JSON.stringify(errorResponse).length
    });
    
    return errorResponse;
  } finally {
    db.close();
  }
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport);

logToFile('info', 'Maccy Clipboard MCP server starting up', {
  timestamp: new Date().toISOString(),
  pid: process.pid,
  cwd: process.cwd()
});

console.error("Maccy Clipboard MCP server running...");