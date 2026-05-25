#!/usr/bin/env tsx
/**
 * Write a new memory and immediately index it.
 *
 * Usage:
 *   npm run remember -- --topic "auth" --title "JWT refresh flow" --tags "auth,jwt"
 *   cat output.md | npx tsx scripts/remember.ts --topic "auth" --title "JWT refresh flow"
 *   npx tsx scripts/remember.ts --topic "auth" --title "JWT refresh flow" --file output.md
 */

import { readFileSync } from 'fs';
import { saveMemory } from '../lib/memory.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    topic: get('--topic'),
    title: get('--title'),
    tags: get('--tags') ?? '',
    file: get('--file'),
    long: args.includes('--long'),
    scope: get('--scope') as 'user' | 'project' | undefined,
  };
}

async function main() {
  const { topic, title, tags, file, long, scope } = parseArgs();

  if (!topic || !title) {
    console.error('Usage: tsx remember.ts --topic <topic> --title <title> [--tags <tags>] [--file <path>] [--long] [--scope user|project]');
    console.error('       Or pipe content via stdin.');
    process.exit(1);
  }

  let content: string;
  if (file) {
    content = readFileSync(file, 'utf-8');
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    content = Buffer.concat(chunks).toString('utf-8');
  }

  if (!content.trim()) {
    console.error('No content provided.');
    process.exit(1);
  }

  const isUser = scope === 'user';
  await saveMemory(title, topic, content, {
    tags,
    tier: isUser ? 'user' : (long ? 'long' : 'short'),
    projectScope: isUser ? null : undefined,
  });
  console.log('Saved and indexed.');
}

main().catch(console.error);
