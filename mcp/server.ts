#!/usr/bin/env tsx
/**
 * Engram MCP server — exposes one tool, `save_memory`, so Claude can
 * persist a curated memory on demand (e.g. when the user says "save this").
 *
 * Transport: stdio. Configure in ~/.mcp.json:
 *
 *   {
 *     "mcpServers": {
 *       "engram": {
 *         "command": "npx",
 *         "args": ["tsx", "C:/Users/<you>/source/repos/Engram/mcp/server.ts"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { daemonSaveMemory } from '../daemon/client.ts';
import { getTopicFromGit, getProjectScope, multiSearch, INJECTION_THRESHOLD } from '../lib/memory.ts';
import { pin, unpin, listPinned, DB_PATH } from '../lib/pin.ts';
import {
  handleSaveMemory, handlePinMemory, handleUnpinMemory, handleListPinned, handleExplainRecall,
} from './handlers.ts';

function nextPinOrder(): number {
  const db = new DatabaseSync(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT COALESCE(MAX(pin_order), 0) AS max FROM memories WHERE memory_tier = 'pinned'`
    ).get() as { max: number };
    return row.max + 1;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'engram', version: '1.0.0' });

  server.tool(
    'save_memory',
    'Save a curated memory to Engram on demand. Use when the user explicitly asks ' +
      'to remember or save something. Bypasses the signal-phrase filter that gates ' +
      'auto-extracted memories. Topic and scope are derived from the current git repo ' +
      'unless overridden.',
    {
      title: z.string().min(1).max(120).describe('Short title — under 8 words is best'),
      content: z.string().min(1).describe('The memory body — 1-3 sentences works well'),
      topic: z.string().optional().describe('Override the derived git topic'),
      excerpt: z.string().optional().describe('Verbatim sentence that triggered this save'),
      tier: z.enum(['short', 'long', 'pinned', 'user', 'shared', 'provisional']).optional()
        .describe('Memory tier. Default: short. Use "pinned" to inject at SessionStart, "user" for user-level facts that surface in every project.'),
      scope: z.enum(['user', 'project']).optional()
        .describe('Scope override. "user" saves with tier=user and no project binding — surfaces in every project. Overrides tier when set.'),
    },
    async (args) => {
      const result = await handleSaveMemory(args, {
        save: daemonSaveMemory,
        defaultTopic: () => getTopicFromGit(),
        defaultScope: () => getProjectScope(),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    'pin_memory',
    'Pin an existing memory so it is injected at every SessionStart in the matching scope. ' +
      'The closest thing Engram has to "always-on" memory — use for stable facts the model ' +
      'should never forget. Pass order to control injection sequence (lower = first).',
    {
      id: z.number().int().positive().describe('Memory id to pin'),
      order: z.number().int().positive().optional().describe('pin_order — lower numbers inject first. Defaults to last position.'),
    },
    async (args) => {
      const result = await handlePinMemory(args, {
        pin: (id, order) => pin(id, order),
        nextOrder: () => nextPinOrder(),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    'unpin_memory',
    'Unpin a memory and restore its previous tier. Memory is still searchable but no longer ' +
      'auto-injected at SessionStart.',
    {
      id: z.number().int().positive().describe('Memory id to unpin'),
    },
    async (args) => {
      const result = await handleUnpinMemory(args, { unpin: (id) => unpin(id) });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    'list_pinned',
    'List pinned memories. By default scopes to the current git repo. Pass all=true to ' +
      'list every pinned memory across scopes.',
    {
      scope: z.string().optional().describe('Project scope (git remote URL) to filter by'),
      all: z.boolean().optional().describe('If true, list pins across all scopes'),
    },
    async (args) => {
      const result = await handleListPinned(args, {
        listPinned: (scope) => listPinned(scope),
        defaultScope: () => getProjectScope(),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    'explain_recall',
    'Dry-run Engram recall for a given prompt: shows which concepts were extracted, ' +
      'how many queries ran, and which memories would be injected (distance < threshold). ' +
      'Use to debug why a memory did or did not surface in a conversation.',
    {
      prompt: z.string().min(1).describe('The prompt text to simulate recall for'),
      scope: z.string().optional().describe('Project scope override (git remote URL)'),
    },
    async (args) => {
      const result = await handleExplainRecall(args, {
        multiSearch: (prompt, scope) => multiSearch(prompt, scope),
        defaultScope: () => getProjectScope(),
        injectionThreshold: INJECTION_THRESHOLD,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(e => {
  process.stderr.write(`[engram-mcp] Fatal: ${e}\n`);
  process.exit(1);
});
