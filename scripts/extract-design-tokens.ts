import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(__dirname, '..', 'skills');
const OUTPUT_PATH = join(__dirname, '..', 'dashboard', 'src', 'design-tokens.ts');

function extractTokens(): void {
  const designSystem = readFileSync(join(SKILLS_DIR, 'design', 'principles.md'), 'utf-8');

  const cssVarRegex = /--([a-z-]+):\s+(.+?)(?:\s*\/\*.+?\*\/)?$/gm;
  const tokens: Record<string, string> = {};

  let match;
  while ((match = cssVarRegex.exec(designSystem)) !== null) {
    tokens[match[1]] = match[2].trim();
  }

  const output = `// Auto-generated from skills/design/principles.md
// Do not edit manually — run: npx ts-node scripts/extract-design-tokens.ts

export const designTokens = ${JSON.stringify(tokens, null, 2)} as const;

export type DesignTokenKey = keyof typeof designTokens;
`;

  writeFileSync(OUTPUT_PATH, output, 'utf-8');
  console.log(`Design tokens extracted to ${OUTPUT_PATH}`);
  console.log(`Found ${Object.keys(tokens).length} tokens`);
}

extractTokens();
