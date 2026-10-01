/**
 * The `<script>` blocks of a Vue SFC.
 *
 * Lives on its own rather than in `vue-extractor.ts` because resolution needs
 * it too: a `.vue` file's references carry `language: 'vue'`, which no
 * Tree-sitter parser handles, so anything that needs the script's syntax tree
 * has to peel the block out and parse that. Importing the extractor for this
 * one regex would drag the whole Tree-sitter walker into the resolver.
 */

export interface VueScriptBlock {
  content: string;
  /** 0-indexed line the content starts on; block line 1 is file line startLine + 1. */
  startLine: number;
  isSetup: boolean;
  isTypeScript: boolean;
}

/** The `<script>` and `<script setup>` blocks of a Vue SFC, in source order. */
export function extractVueScriptBlocks(source: string): VueScriptBlock[] {
  const blocks: VueScriptBlock[] = [];
  const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
  let match;

  while ((match = scriptRegex.exec(source)) !== null) {
    const attrs = match[1] || '';
    const content = match.groups?.content || match[2] || '';

    // Detect TypeScript from lang attribute
    const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

    // Detect <script setup>
    const isSetup = /\bsetup\b/.test(attrs);

    // Calculate the 0-indexed line where the content begins. The content
    // starts right after the opening tag's `>` — its leading `\n` is part
    // of the content, so relative line 1 sits ON the tag's closing line
    // (adding 1 here double-counted the embedded newline and shifted every
    // script-block symbol down a line).
    const beforeScript = source.substring(0, match.index);
    const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
    const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
    const openingTagLines = (openingTag.match(/\n/g) || []).length;
    const contentStartLine = scriptTagLine + openingTagLines; // 0-indexed line

    blocks.push({
      content,
      startLine: contentStartLine,
      isSetup,
      isTypeScript,
    });
  }

  return blocks;
}
