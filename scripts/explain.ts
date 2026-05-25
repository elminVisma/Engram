#!/usr/bin/env tsx
/**
 * Dry-run recall for a given prompt — shows which concepts were extracted,
 * how many queries ran, and which memories would (or would not) be injected.
 *
 * Usage:
 *   npm run explain -- "how does jwt auth work"
 *   npm run explain -- "your prompt here" --scope https://github.com/org/repo.git
 */

import { multiSearch, getProjectScope, INJECTION_THRESHOLD } from '../lib/memory.ts';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GREY   = '\x1b[90m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';

async function main() {
  const args = process.argv.slice(2);
  const scopeIdx = args.indexOf('--scope');
  let scope: string | null = null;
  let promptParts: string[] = args;

  if (scopeIdx !== -1) {
    scope = args[scopeIdx + 1] ?? null;
    promptParts = args.filter((_, i) => i !== scopeIdx && i !== scopeIdx + 1);
  }

  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    process.stderr.write('Usage: npm run explain -- "<prompt>" [--scope <git-url>]\n');
    process.exit(1);
  }

  const resolvedScope = scope ?? getProjectScope();

  console.log(`\n${BOLD}${CYAN}Engram Explain Recall${RESET}`);
  console.log(`${DIM}Prompt: ${prompt}${RESET}`);
  console.log(`${DIM}Scope:  ${resolvedScope ?? '(none)'}${RESET}\n`);

  const { concepts, queries, candidates } = await multiSearch(prompt, resolvedScope);

  console.log(`${BOLD}Concepts extracted${RESET} (${concepts.length})`);
  if (concepts.length === 0) {
    console.log(`  ${GREY}none${RESET}`);
  } else {
    for (const c of concepts) console.log(`  • ${c}`);
  }

  console.log(`\n${BOLD}Queries run${RESET}: ${queries.length}`);
  for (const q of queries) console.log(`  ${DIM}${q}${RESET}`);

  console.log(`\n${BOLD}Candidates${RESET} (${candidates.length})`);
  if (candidates.length === 0) {
    console.log(`  ${GREY}no matches${RESET}`);
  } else {
    for (const c of candidates) {
      const inject = c.distance < INJECTION_THRESHOLD;
      const tag = inject
        ? `${GREEN}[inject]${RESET}`
        : `${YELLOW}[skip]${RESET}`;
      const prov = c.memory_tier === 'provisional' ? ` ${DIM}(provisional)${RESET}` : '';
      console.log(`  ${tag} ${BOLD}${c.title}${RESET}${prov}`);
      console.log(`        dist=${c.distance.toFixed(4)}  tier=${c.memory_tier}  topic=${c.topic}`);
    }
  }

  console.log();
}

main().catch(e => {
  process.stderr.write(`Error: ${e}\n`);
  process.exit(1);
});
