import type {
  WikiPage,
  IngestResult,
  CompileResult,
  QueryResult,
  LintResult,
  LintIssue,
  LintIssueType,
  AuditCorrection,
  KbSource,
} from './types';
import { KbLlmCaller } from './llm-caller';
import fs from 'node:fs';
import path from 'node:path';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'about', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'they', 'them', 'their', 'what', 'which', 'who',
]);

const WIKI_SUBDIRS = ['concepts', 'entities', 'summaries', 'conversations'] as const;

const SUBDIR_TO_KIND: Record<string, PageKind> = {
  concepts: 'concept',
  entities: 'entity',
  summaries: 'summary',
  conversations: 'conversation',
};

type PageKind = 'concept' | 'entity' | 'summary' | 'conversation';

// --- Analysis Phase Types (compact, no full content) ---

interface AnalysisReport {
  docTitle: string;
  docType: string;
  briefSummary: string;
  keyPoints: string[];
  entities: Array<{ name: string; type: string; isNew: boolean; relatedExisting: string[]; brief: string }>;
  concepts: Array<{ name: string; isNew: boolean; relatedExisting: string[]; brief: string }>;
  contradictions: Array<{ existingPage: string; issue: string; suggestedAction: string }>;
  newPages: string[];
  pagesToModify: Array<{ page: string; reason: string }>;
}

interface IngestLlmOutput {
  docTitle: string;
  docType: string;
  summary: string;
  keyPoints: string[];
  concepts: Array<{ title?: string; content?: string; tags?: string[]; difficulty?: string; brief?: string }>;
  entities: Array<{ title?: string; content?: string; tags?: string[]; entityType?: string; brief?: string }>;
}

interface CompileSuggestion {
  action: 'split' | 'merge';
  target: string;
  reason: string;
}

interface FrontmatterData {
  title: string;
  type: PageKind;
  created: string;
  updated: string;
  sources: string[];
  tags: string[];
  difficulty?: string;
  entityType?: string;
}

interface TitleCacheEntry {
  path: string;
  title: string;
}

export class WikiEngine {
  private kbPath: string;
  private llm: KbLlmCaller;
  private titleCache: Map<string, TitleCacheEntry> | null;

  constructor(kbPath: string, llm: KbLlmCaller) {
    this.kbPath = kbPath;
    this.llm = llm;
    this.titleCache = null;
  }

  // ---------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------

  private static MAX_INPUT_CHARS = 12000;

  // ===========================================================================
  // Phase 1: Analysis — compact, memory-safe
  // ===========================================================================

  private readExistingWikiIndex(): string {
    const indexPath = path.join(this.kbPath, 'wiki', 'index.md');
    if (fs.existsSync(indexPath)) {
      const full = fs.readFileSync(indexPath, 'utf-8');
      return full.length > 3000 ? full.slice(0, 3000) + '\n...(truncated)' : full;
    }
    return '';
  }

  /**
   * Build a title→{path, title} cache from all wiki .md files.
   * Used by findPagePath, readExistingPageContent, and readExistingPageTitles.
   * Only rebuilt when null (called once per ingest).
   */
  private buildTitleCache(): Map<string, TitleCacheEntry> {
    const wikiDir = path.join(this.kbPath, 'wiki');
    const cache = new Map<string, TitleCacheEntry>();
    if (!fs.existsSync(wikiDir)) return cache;

    for (const filePath of this.readdirRecursive(wikiDir, '.md')) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      cache.set(title.toLowerCase(), { path: filePath, title });
    }
    return cache;
  }

  private readExistingPageTitles(): string[] {
    if (!this.titleCache) {
      this.titleCache = this.buildTitleCache();
    }
    return Array.from(this.titleCache.values()).map((e) => e.title);
  }

  /**
   * Phase 1: Analyze document and existing wiki. Compact output — no full page content.
   * This call should stay under ~15KB total (input + response) to avoid memory pressure.
   */
  private async analyzeDocument(content: string, existingIndex: string, existingTitles: string[], signal?: AbortSignal): Promise<AnalysisReport> {
    const existingHint = existingTitles.length > 0
      ? `Existing wiki pages: ${existingTitles.slice(0, 40).join(', ')}`
      : 'No existing wiki pages.';

    const prompt = [
      'You are a senior knowledge engineer. Analyze this document against the existing wiki.',
      '',
      existingHint,
      '',
      '## Output ONLY valid JSON (keep it compact — NO full page content, just analysis):',
      '{',
      '  "docTitle": "document title",',
      '  "docType": "paper|report|article|tutorial|spec|docs|thesis|manual|other",',
      '  "briefSummary": "300-600 char overview of the document\'s core content and key conclusions",',
      '  "keyPoints": ["5-8 factual bullet points"],',
      '  "entities": [',
      '    {"name": "...", "type": "technology|organization|dataset|system|person|...", "isNew": true, "relatedExisting": ["existing page title if related"], "brief": "1-2 sentence description"}',
      '  ],',
      '  "concepts": [',
      '    {"name": "...", "isNew": true, "relatedExisting": ["..."], "brief": "1-2 sentence description"}',
      '  ],',
      '  "contradictions": [{"existingPage": "...", "issue": "...", "suggestedAction": "..."}],',
      '  "newPages": ["list of new wiki page titles to create"],',
      '  "pagesToModify": [{"page": "...", "reason": "..."}]',
      '}',
    ].join('\n');

    const result = await this.llm.chatWithJson<AnalysisReport>([
      { role: 'system', content: prompt },
      { role: 'user', content },
    ], 4096, signal);

    const r = {
      docTitle: result.docTitle || '',
      docType: result.docType || 'document',
      briefSummary: result.briefSummary || '',
      keyPoints: result.keyPoints || [],
      entities: result.entities || [],
      concepts: result.concepts || [],
      contradictions: result.contradictions || [],
      newPages: result.newPages || [],
      pagesToModify: result.pagesToModify || [],
    };
    console.log(`[WikiEngine] Phase 1: concepts=${r.concepts.length}, entities=${r.entities.length}, title="${r.docTitle}"`);
    if (r.concepts.length > 0) {
      console.log(`[WikiEngine]   concepts: ${r.concepts.map((c) => c.name).join(', ')}`);
    }
    if (r.entities.length > 0) {
      console.log(`[WikiEngine]   entities: ${r.entities.map((e) => e.name).join(', ')}`);
    }
    return r;
  }

  // ===========================================================================
  // Phase 2: Generation — based on analysis report
  // ===========================================================================

  private async generateWikiPages(
    analysis: AnalysisReport,
    sourceMaterial: string,
    existingTitles: string[],
    signal?: AbortSignal,
  ): Promise<IngestLlmOutput> {
    const titlesHint = existingTitles.length > 0
      ? `Existing pages for [[Wikilink]]: ${existingTitles.slice(0, 30).join(', ')}`
      : 'No existing pages.';

    // --- Call 1: Summary ---
    const summaryResult = await this.llm.chatWithJson<{
      summary: string;
      keyPoints: string[];
    }>([
      {
        role: 'system',
        content: [
          'Generate a wiki summary page for a document.',
          'Output ONLY JSON: {"summary": "...", "keyPoints": ["...", "..."]}',
          `Existing pages for [[Wikilink]]: ${existingTitles.slice(0, 30).join(', ')}`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Document: ${analysis.docTitle}`,
          `Brief analysis: ${analysis.briefSummary}`,
          '',
          'Source material:',
          sourceMaterial.slice(0, 8000),
          '',
          'Summary (1000-2000 chars) sections: ## Overview, ## Core Content, ## Key Findings, ## Significance',
          'Include specific data and facts. Rich markdown with headers, lists, tables.',
        ].join('\n'),
      },
    ], 4096, signal);

    // --- Per-concept generation (one LLM call each) ---
    const concepts: IngestLlmOutput['concepts'] = [];
    for (const concept of analysis.concepts ?? []) {
      if (signal?.aborted) throw new Error('提取已取消');
      try {
        const existingContent = !concept.isNew && concept.relatedExisting.length > 0
          ? this.readExistingPageContent(concept.relatedExisting[0])
          : '';

        const result = await this.llm.chatWithJson<{
          title: string;
          content: string;
          tags: string[];
          difficulty: string;
        }>([
          {
            role: 'system',
            content: [
              concept.isNew
                ? 'Generate a NEW wiki concept page. Output ONLY JSON: {"title": "...", "content": "... (1000-2000 chars, markdown with ## Definition, ## How It Works, ## Why It Matters, ## Connections)", "tags": [...], "difficulty": "beginner|intermediate|advanced"}'
                : 'UPDATE an existing wiki concept page. Output ONLY JSON: {"title": "...", "content": "... (200-500 chars, NEW information from this source only, to APPEND)", "tags": [...], "difficulty": "beginner|intermediate|advanced"}',
              '',
              `Existing pages for [[Wikilink]]: ${titlesHint}`,
              '',
              'CRITICAL: "content" MUST be detailed markdown with headers and paragraphs — NOT a brief description.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Document: ${analysis.docTitle}`,
              `Brief analysis: ${analysis.briefSummary}`,
              '',
              'Source material:',
              sourceMaterial.slice(0, 12000),
              '',
              `## Concept: ${concept.name}`,
              concept.isNew ? '(NEW — create full wiki page)' : `(UPDATE existing: ${concept.relatedExisting.join(', ')})`,
              `Brief: ${concept.brief}`,
              existingContent ? `\nExisting page content:\n${existingContent.slice(0, 3000)}\n\nGenerate ONLY new/different information not already covered above.` : '',
            ].join('\n'),
          },
        ], 4096, signal);
        concepts.push(result);
        console.log(`[WikiEngine] Phase 2: generated concept "${result.title || concept.name}" (${(result.content || '').length} chars)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WikiEngine] Failed to generate concept "${concept.name}": ${msg}`);
        concepts.push({ title: concept.name, content: '', tags: [], difficulty: undefined });
      }
    }

    // --- Per-entity generation (one LLM call each) ---
    const entities: IngestLlmOutput['entities'] = [];
    for (const entity of analysis.entities ?? []) {
      if (signal?.aborted) throw new Error('提取已取消');
      try {
        const existingContent = !entity.isNew && entity.relatedExisting.length > 0
          ? this.readExistingPageContent(entity.relatedExisting[0])
          : '';

        const result = await this.llm.chatWithJson<{
          title: string;
          content: string;
          tags: string[];
          entityType: string;
        }>([
          {
            role: 'system',
            content: [
              entity.isNew
                ? 'Generate a NEW wiki entity page. Output ONLY JSON: {"title": "...", "content": "... (800-1500 chars, markdown with ## Overview, ## Specifications, ## References)", "tags": [...], "entityType": "technology|organization|dataset|system|person"}'
                : 'UPDATE an existing wiki entity page. Output ONLY JSON: {"title": "...", "content": "... (200-500 chars, NEW information from this source only, to APPEND)", "tags": [...], "entityType": "technology|organization|dataset|system|person"}',
              '',
              `Existing pages for [[Wikilink]]: ${titlesHint}`,
              '',
              'CRITICAL: "content" MUST be detailed markdown with headers and paragraphs — NOT a brief description.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Document: ${analysis.docTitle}`,
              `Brief analysis: ${analysis.briefSummary}`,
              '',
              'Source material:',
              sourceMaterial.slice(0, 12000),
              '',
              `## Entity: ${entity.name}`,
              entity.isNew ? '(NEW — create full wiki page)' : `(UPDATE existing: ${entity.relatedExisting.join(', ')})`,
              `Brief: ${entity.brief}`,
              existingContent ? `\nExisting page content:\n${existingContent.slice(0, 3000)}\n\nGenerate ONLY new/different information not already covered above.` : '',
            ].join('\n'),
          },
        ], 4096, signal);
        entities.push(result);
        console.log(`[WikiEngine] Phase 2: generated entity "${result.title || entity.name}" (${(result.content || '').length} chars)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WikiEngine] Failed to generate entity "${entity.name}": ${msg}`);
        entities.push({ title: entity.name, content: '', tags: [], entityType: undefined });
      }
    }

    return {
      docTitle: analysis.docTitle,
      docType: analysis.docType,
      summary: summaryResult.summary || '',
      keyPoints: summaryResult.keyPoints || [],
      concepts,
      entities,
    };
  }

  private readExistingPageContent(title: string): string {
    const filePath = this.findPagePath(title);
    if (!filePath) return '';
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { body } = this.parseFrontmatter(raw);
    return body;
  }

  private async generateReviewItems(
    contradictions: AnalysisReport['contradictions'],
  ): Promise<Array<{ type: string; page: string; description: string; suggestedFix: string }>> {
    if (!contradictions?.length) return [];

    try {
      return await this.llm.chatWithJson<Array<{ type: string; page: string; description: string; suggestedFix: string }>>([{
        role: 'system',
        content: [
          'For each contradiction found during analysis, generate a review item.',
          `Contradictions: ${JSON.stringify(contradictions)}`,
          '',
          'Output ONLY JSON array: [{"type": "contradiction", "page": "...", "description": "...", "suggestedFix": "..."}]',
        ].join('\n'),
      }], 1024);
    } catch {
      return contradictions.map((c) => ({
        type: 'contradiction',
        page: c.existingPage,
        description: c.issue,
        suggestedFix: c.suggestedAction,
      }));
    }
  }

  // ===========================================================================
  // Ingest Orchestrator
  // ===========================================================================

  async ingest(
    source: KbSource,
    content: string,
    onProgress?: (chunkIndex: number, totalChunks: number) => void,
    signal?: AbortSignal,
  ): Promise<IngestResult> {
    const result: IngestResult = {
      pagesCreated: 0, pagesUpdated: 0,
      conceptsCount: 0, entitiesCount: 0, summaryCreated: false, errors: [],
    };

    try {
      // Skip files with too little content — LLM can't produce meaningful analysis
      if (content.trim().length < 50) {
        throw new Error(`File content too short (${content.trim().length} chars), minimum 50 required`);
      }

      const today = new Date().toISOString().slice(0, 10);

      // Truncate large documents
      let inputContent = content;
      if (content.length > WikiEngine.MAX_INPUT_CHARS) {
        inputContent = content.slice(0, WikiEngine.MAX_INPUT_CHARS) + '\n\n[... truncated ...]';
      }

      // --- Phase 1: Analysis (compact, one small LLM call) ---
      const existingIndex = this.readExistingWikiIndex();
      const existingTitles = this.readExistingPageTitles();
      const analysis = await this.analyzeDocument(inputContent, existingIndex, existingTitles, signal);

      // Release input content — no longer needed after analysis
      void inputContent;

      // --- Phase 2: Generation (1 summary call + per-concept/entity calls) ---
      const generation = await this.generateWikiPages(analysis, content, existingTitles, signal);

      // --- Write wiki pages ---
      const docTitle = analysis.docTitle || source.storedName;
      const docType = analysis.docType || 'document';

      // Summary
      const summaryDir = path.join(this.kbPath, 'wiki', 'summaries');
      fs.mkdirSync(summaryDir, { recursive: true });
      const summaryPath = path.join(summaryDir, `${source.storedName}-summary.md`);
      const summaryTags = [docType, ...(generation.keyPoints?.slice(0, 3).map((p) => p.slice(0, 20).toLowerCase()) ?? [])];
      const summaryFrontmatter = this.buildFrontmatter({
        title: `${docTitle} - Summary`,
        type: 'summary',
        created: today, updated: today,
        sources: [source.id],
        tags: summaryTags,
      });
      const keyPointsSection = generation.keyPoints?.length
        ? `\n\n## Key Points\n${generation.keyPoints.map((p) => `- ${p}`).join('\n')}`
        : '';
      fs.writeFileSync(summaryPath, `${summaryFrontmatter}\n${this.truncateContent(generation.summary)}${keyPointsSection}`, 'utf-8');
      result.summaryCreated = true;
      result.pagesCreated++;

      // Concepts + Entities
      const allTitles = [
        ...(generation.concepts ?? []).map((c) => c.title || '').filter(Boolean),
        ...(generation.entities ?? []).map((e) => e.title || '').filter(Boolean),
        ...existingTitles,
      ];

      // Build lookup from Phase 1 analysis: concept/entity name → {isNew, relatedExisting}
      const conceptMeta = new Map<string, { isNew: boolean; relatedExisting: string[] }>();
      for (const c of analysis.concepts) conceptMeta.set(c.name.toLowerCase(), { isNew: c.isNew, relatedExisting: c.relatedExisting });
      const entityMeta = new Map<string, { isNew: boolean; relatedExisting: string[] }>();
      for (const e of analysis.entities) entityMeta.set(e.name.toLowerCase(), { isNew: e.isNew, relatedExisting: e.relatedExisting });

      const conceptsDir = path.join(this.kbPath, 'wiki', 'concepts');
      fs.mkdirSync(conceptsDir, { recursive: true });
      for (const concept of generation.concepts ?? []) {
        try {
          const conceptContent = concept.content || `# ${concept.title}\n\n${concept.brief || ''}`;
          const conceptTags = Array.isArray(concept.tags) ? concept.tags : [];
          const conceptTitle = concept.title || 'Untitled Concept';
          if (conceptContent.trim().length < 50) {
            console.warn(`[WikiEngine] Skipping concept "${conceptTitle}": content too short (${conceptContent.trim().length} chars)`);
            continue;
          }

          // Check if this is an update to an existing page
          const meta = conceptMeta.get(conceptTitle.toLowerCase());
          if (meta && !meta.isNew && meta.relatedExisting.length > 0) {
            const existingPath = this.findPagePath(meta.relatedExisting[0]);
            if (existingPath) {
              this.updateExistingPage(existingPath, conceptContent, source.id, today, conceptTags);
              result.conceptsCount++;
              result.pagesUpdated++;
              console.log(`[WikiEngine] Updated concept "${conceptTitle}" → ${meta.relatedExisting[0]}`);
              continue;
            }
          }

          // Create new page
          const slug = this.slugify(conceptTitle);
          const conceptPath = path.join(conceptsDir, `${slug}.md`);
          const fm = this.buildFrontmatter({
            title: conceptTitle, type: 'concept',
            created: today, updated: today,
            sources: [source.id],
            tags: conceptTags, difficulty: concept.difficulty,
          });
          const bodyWithLinks = this.injectWikilinks(this.truncateContent(conceptContent), allTitles);
          fs.writeFileSync(conceptPath, `${fm}\n${bodyWithLinks}`, 'utf-8');
          result.conceptsCount++;
          result.pagesCreated++;
        } catch (writeErr: unknown) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          console.error(`[WikiEngine] Failed to write concept "${concept.title}": ${msg}`);
          result.errors.push(`concept "${concept.title}": ${msg}`);
        }
      }

      const entitiesDir = path.join(this.kbPath, 'wiki', 'entities');
      fs.mkdirSync(entitiesDir, { recursive: true });
      for (const entity of generation.entities ?? []) {
        try {
          const entityContent = entity.content || `# ${entity.title}\n\n${entity.brief || ''}`;
          const entityTags = Array.isArray(entity.tags) ? entity.tags : [];
          const entityTitle = entity.title || 'Untitled Entity';
          if (entityContent.trim().length < 50) {
            console.warn(`[WikiEngine] Skipping entity "${entityTitle}": content too short (${entityContent.trim().length} chars)`);
            continue;
          }

          // Check if this is an update to an existing page
          const meta = entityMeta.get(entityTitle.toLowerCase());
          if (meta && !meta.isNew && meta.relatedExisting.length > 0) {
            const existingPath = this.findPagePath(meta.relatedExisting[0]);
            if (existingPath) {
              this.updateExistingPage(existingPath, entityContent, source.id, today, entityTags);
              result.entitiesCount++;
              result.pagesUpdated++;
              console.log(`[WikiEngine] Updated entity "${entityTitle}" → ${meta.relatedExisting[0]}`);
              continue;
            }
          }

          // Create new page
          const slug = this.slugify(entityTitle);
          const entityPath = path.join(entitiesDir, `${slug}.md`);
          const fm = this.buildFrontmatter({
            title: entityTitle, type: 'entity',
            created: today, updated: today,
            sources: [source.id],
            tags: entityTags, entityType: entity.entityType,
          });
          const bodyWithLinks = this.injectWikilinks(this.truncateContent(entityContent), allTitles);
          fs.writeFileSync(entityPath, `${fm}\n${bodyWithLinks}`, 'utf-8');
          result.entitiesCount++;
          result.pagesCreated++;
        } catch (writeErr: unknown) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          console.error(`[WikiEngine] Failed to write entity "${entity.title}": ${msg}`);
          result.errors.push(`entity "${entity.title}": ${msg}`);
        }
      }

      // Review items
      if (analysis.contradictions?.length > 0) {
        const reviewItems = await this.generateReviewItems(analysis.contradictions);
        this.appendReviewItems(source, reviewItems);
      }

      this.updateIndex();
      console.log(`[WikiEngine] Ingest done: summary=${result.summaryCreated}, concepts=${result.conceptsCount}, entities=${result.entitiesCount}, pages=${result.pagesCreated}, updated=${result.pagesUpdated}`);
      this.appendLog('ingest', `${source.storedName} → ${docTitle}`, `created=${result.pagesCreated}, updated=${result.pagesUpdated}, concepts=${result.conceptsCount}, entities=${result.entitiesCount}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === '提取已取消') throw err;
      if (result.pagesCreated === 0) {
        throw new Error(`Ingest failed: ${message}`);
      }
      // Partial success — record error but don't throw
      result.errors.push(`Partial failure: ${message}`);
    }

    return result;
  }

  private appendReviewItems(
    source: KbSource,
    reviewItems: Array<{ type: string; page: string; description: string; suggestedFix: string }>,
  ): void {
    if (!reviewItems?.length) return;
    const reviewDir = path.join(this.kbPath, 'wiki', '_review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reviewPath = path.join(reviewDir, `${today}-${source.storedName}.md`);
    const lines: string[] = [
      '---',
      `title: "Review: ${source.storedName}"`,
      `created: ${today}`,
      `source: ${source.id}`,
      '---',
      '',
      `# Review Items for ${source.storedName}`,
      '',
      ...reviewItems.map((item, i) => [
        `## ${i + 1}. [${item.type}] ${item.page}`,
        '', `**Issue**: ${item.description}`, '', `**Suggested Fix**: ${item.suggestedFix}`, '',
      ].join('\n')),
    ];
    fs.writeFileSync(reviewPath, lines.join('\n'), 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Compile
  // ---------------------------------------------------------------------------

  async compile(): Promise<CompileResult> {
    const result: CompileResult = {
      splitsPerformed: 0,
      mergesPerformed: 0,
      indexRebuilt: false,
      issuesFound: 0,
    };

    const allPages = this.readAllWikiPages();

    if (allPages.length === 0) {
      return result;
    }

    const pageSummaries = allPages.map((p) => {
      const wordCount = p.content.split(/\s+/).filter(Boolean).length;
      return `### ${p.title} (${p.type})\nPath: ${p.path}\nWords: ${wordCount}\n${p.content.slice(0, 300)}\n---`;
    });

    const suggestions: CompileSuggestion[] = await this.llm.chatWithJson<CompileSuggestion[]>([
      {
        role: 'system',
        content: [
          'You are a wiki compiler. Analyze the provided wiki pages and suggest improvements.',
          'Look for:',
          '- Pages that should be split (>2000 characters)',
          '- Near-duplicate pages that should be merged',
          '- Missing wikilinks between related pages',
          'Output ONLY valid JSON: [{"action": "split"|"merge", "target": "page title", "reason": "..."}]',
        ].join('\n'),
      },
      {
        role: 'user',
        content: pageSummaries.join('\n\n'),
      },
    ]);

    result.issuesFound = suggestions.length;

    for (const suggestion of suggestions) {
      try {
        if (suggestion.action === 'split') {
          this.splitPage(suggestion.target);
          result.splitsPerformed++;
        } else if (suggestion.action === 'merge') {
          this.mergeDuplicates(suggestion.target);
          result.mergesPerformed++;
        }
      } catch {
        // Best-effort: continue with remaining suggestions
      }
    }

    this.updateIndex();
    result.indexRebuilt = true;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  async query(question: string): Promise<QueryResult> {
    const relevantPages = this.findRelevantPages(question, 5);

    if (relevantPages.length === 0) {
      return { answer: 'No relevant information found.', citedPages: [] };
    }

    const context = relevantPages
      .map((p) => `## ${p.title}\n${p.content}`)
      .join('\n\n');

    const answer = await this.llm.chat([
      {
        role: 'system',
        content:
          'Answer the question based ONLY on the provided wiki content. Cite pages using [[Page Title]] format.',
      },
      { role: 'user', content: `Question: ${question}\n\nWiki content:\n${context}` },
    ]);

    const citations = this.extractCitations(answer);
    this.appendLog('query', question.slice(0, 80), `cited: [${citations.join(', ')}]`);
    return { answer, citedPages: citations };
  }

  /**
   * File a query answer back into the wiki as a new page.
   * This follows the LLM Wiki pattern: good answers compound in the knowledge base.
   */
  saveQueryResult(question: string, answer: string, citedPages: string[]): void {
    const today = new Date().toISOString().slice(0, 10);
    const queryDir = path.join(this.kbPath, 'wiki', 'summaries');
    fs.mkdirSync(queryDir, { recursive: true });

    const slug = this.slugify(question.slice(0, 60));
    const filePath = path.join(queryDir, `query-${slug}.md`);

    const fm = this.buildFrontmatter({
      title: `Q: ${question.slice(0, 80)}`,
      type: 'summary',
      created: today, updated: today,
      sources: citedPages,
      tags: ['query', 'generated'],
    });

    fs.writeFileSync(filePath, `${fm}\n\n## Question\n${question}\n\n## Answer\n${answer}`, 'utf-8');
    this.updateIndex();
    this.appendLog('query-save', question.slice(0, 80));
  }

  // ---------------------------------------------------------------------------
  // Lint
  // ---------------------------------------------------------------------------

  async lint(): Promise<LintResult> {
    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) {
      return { issues: [], totalPages: 0, deadLinks: 0, orphanPages: 0, healthScore: 100 };
    }

    const mdFiles = this.readdirRecursive(wikiDir, '.md');
    const issues: LintIssue[] = [];

    // Build title → filepath map and linked-set map
    const titleToPath = new Map<string, string>();
    const pageTitles = new Set<string>();
    const linkedBy = new Map<string, Set<string>>();
    const linkedTo = new Map<string, Set<string>>();

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title =
        (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      titleToPath.set(title, filePath);
      pageTitles.add(title);

      // Parse wikilinks in body
      const linkMatches = Array.from(body.matchAll(/\[\[([^\]]+)\]\]/g));
      const outgoing = new Set<string>();
      for (const match of linkMatches) {
        outgoing.add(match[1]);
      }
      linkedTo.set(filePath, outgoing);

      for (const target of Array.from(outgoing)) {
        if (!linkedBy.has(target)) {
          linkedBy.set(target, new Set());
        }
        linkedBy.get(target)!.add(filePath);
      }
    }

    // Dead links
    for (const [file, targets] of Array.from(linkedTo)) {
      for (const target of Array.from(targets)) {
        if (!pageTitles.has(target)) {
          issues.push({
            type: 'dead_link' as LintIssueType,
            severity: 'error',
            file: path.relative(this.kbPath, file),
            detail: `Dead link: [[${target}]] — target page does not exist`,
          });
        }
      }
    }

    // Orphan pages (not linked by any other page)
    for (const [file] of Array.from(linkedTo)) {
      const title = (titleToPath as unknown as Map<string, string>).get(
        path.basename(file, '.md'),
      );
      const isLinked = title ? linkedBy.has(title) : false;
      const relPath = path.relative(this.kbPath, file);
      const isIndex = relPath === path.join('wiki', 'index.md');
      if (!isLinked && !isIndex) {
        issues.push({
          type: 'orphan_page' as LintIssueType,
          severity: 'warning',
          file: relPath,
          detail: 'This page is not linked by any other page',
        });
      }
    }

    // Missing from index
    const indexPath = path.join(wikiDir, 'index.md');
    let indexContent = '';
    if (fs.existsSync(indexPath)) {
      indexContent = fs.readFileSync(indexPath, 'utf-8');
    }
    for (const [title, filePath] of Array.from(titleToPath)) {
      if (!indexContent.includes(`[[${title}]]`) && !filePath.endsWith('index.md')) {
        issues.push({
          type: 'missing_index' as LintIssueType,
          severity: 'warning',
          file: path.relative(this.kbPath, filePath),
          detail: `Page "${title}" is not listed in wiki/index.md`,
        });
      }
    }

    // Oversized pages (>5000 lines)
    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lineCount = raw.split('\n').length;
      if (lineCount > 5000) {
        issues.push({
          type: 'oversized_page' as LintIssueType,
          severity: 'warning',
          file: path.relative(this.kbPath, filePath),
          detail: `Page has ${lineCount} lines (threshold: 5000)`,
        });
      }
    }

    const deadLinks = issues.filter((i) => i.type === 'dead_link').length;
    const orphanPages = issues.filter((i) => i.type === 'orphan_page').length;
    const totalPages = mdFiles.length;

    // Health score: 100 minus penalty for each issue type
    const penalty = deadLinks * 10 + orphanPages * 2 + (issues.length - deadLinks - orphanPages);
    const healthScore = Math.max(0, Math.min(100, 100 - penalty));
    this.appendLog('lint', `health=${healthScore}, issues=${issues.length}`, `dead_links=${deadLinks}, orphans=${orphanPages}, total=${totalPages}`);
    return { issues, totalPages, deadLinks, orphanPages, healthScore };
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  async audit(correction: AuditCorrection): Promise<void> {
    const auditDir = path.join(this.kbPath, 'audit', 'corrections');
    fs.mkdirSync(auditDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const fileName = `${date}-${correction.type}.md`;
    const filePath = path.join(auditDir, fileName);

    const frontmatter = this.buildFrontmatter({
      title: `Audit: ${correction.targetPage}`,
      type: 'conversation',
      created: date,
      updated: date,
      sources: [],
      tags: ['audit', correction.type],
    });

    const body = [
      `## Target Page`,
      `[[${correction.targetPage}]]`,
      ``,
      `## Type`,
      `${correction.type}`,
      ``,
      `## Description`,
      `${correction.description}`,
      ``,
      `## Suggested Fix`,
      correction.suggestedFix ?? 'No fix suggested',
    ].join('\n');

    fs.writeFileSync(filePath, `${frontmatter}\n${body}`, 'utf-8');

    // Try to apply correction via LLM if a target page exists and a fix is suggested
    if (correction.suggestedFix) {
      const targetPath = this.findPagePath(correction.targetPage);
      if (targetPath && fs.existsSync(targetPath)) {
        try {
          const currentContent = fs.readFileSync(targetPath, 'utf-8');
          const updated = await this.llm.chat([
            {
              role: 'system',
              content: [
                'You are a wiki editor. Apply the described correction to the wiki page.',
                'Return the COMPLETE updated page content (including frontmatter). Do NOT add any explanation outside the page content.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `Current page:\n${currentContent}\n\nCorrection:\n${correction.description}\n\nSuggested fix:\n${correction.suggestedFix}`,
            },
          ]);

          fs.writeFileSync(targetPath, updated, 'utf-8');
        } catch {
          // Best-effort LLM application
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Relevance search (V1: keyword matching)
  // ---------------------------------------------------------------------------

  findRelevantPages(query: string, topK: number): WikiPage[] {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

    if (keywords.length === 0) {
      return [];
    }

    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) {
      return [];
    }

    const mdFiles = this.readdirRecursive(wikiDir, '.md');
    const scored: Array<{ page: WikiPage; score: number }> = [];

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      const type = (frontmatter['type'] as PageKind) ?? 'concept';
      const sources = (frontmatter['sources'] as string[]) ?? [];
      const tags = (frontmatter['tags'] as string[]) ?? [];

      const searchable = `${title} ${tags.join(' ')} ${body}`.toLowerCase();
      const snippet = body.slice(0, 200);

      let score = 0;
      for (const kw of keywords) {
        if (searchable.includes(kw)) {
          score++;
        }
      }

      if (score > 0) {
        scored.push({
          page: { title, type, path: filePath, content: snippet, sources, tags },
          score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.page);
  }

  // ---------------------------------------------------------------------------
  // Index rebuild
  // ---------------------------------------------------------------------------

  /**
   * Cross-link all wiki pages: scan every page for references to other page titles
   * and inject [[wikilinks]] where found. Runs after all ingestion is complete.
   */
  crossLinkAllPages(): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) return;

    const mdFiles = this.readdirRecursive(wikiDir, '.md');
    // Build title → { filePath, title } map
    const titleToPage = new Map<string, { filePath: string; title: string }>();
    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      titleToPage.set(title.toLowerCase(), { filePath, title });
    }

    // For each page, find references to other titles and inject wikilinks
    for (const filePath of mdFiles) {
      let content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);
      const currentPageTitle = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');

      let newBody = body;
      let changed = false;

      for (const [lowerTitle, pageInfo] of Array.from(titleToPage)) {
        if (pageInfo.title === currentPageTitle) continue;
        // Skip very short titles (1-2 chars) to avoid false positives
        if (pageInfo.title.length < 3) continue;

        const escaped = pageInfo.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'i');
        if (regex.test(newBody)) {
          newBody = newBody.replace(regex, `[[${pageInfo.title}]]`);
          changed = true;
        }
      }

      if (changed) {
        // Reconstruct file with original frontmatter + updated body
        const fmEnd = content.indexOf('---', 3);
        const fmBlock = fmEnd !== -1 ? content.slice(0, fmEnd + 3) : '';
        fs.writeFileSync(filePath, `${fmBlock}\n${newBody}`, 'utf-8');
      }
    }
  }

  updateIndex(): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });

    const categories: Record<PageKind, Array<{ title: string; desc: string }>> = {
      concept: [],
      entity: [],
      summary: [],
      conversation: [],
    };

    for (const subdir of WIKI_SUBDIRS) {
      const dirPath = path.join(wikiDir, subdir);
      if (!fs.existsSync(dirPath)) continue;

      const kind = SUBDIR_TO_KIND[subdir];
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = this.parseFrontmatter(raw);
        const title = (frontmatter['title'] as string) ?? path.basename(file, '.md');
        const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
        const desc = firstLine.replace(/^#+\s*/, '').slice(0, 100);

        if (categories[kind]) {
          categories[kind].push({ title, desc });
        }
      }
    }

    const sections: string[] = ['# Wiki Index', ''];
    const typeLabels: Record<PageKind, string> = {
      concept: 'Concepts',
      entity: 'Entities',
      summary: 'Summaries',
      conversation: 'Conversations',
    };

    const allKinds: PageKind[] = ['concept', 'entity', 'summary', 'conversation'];
    for (const kind of allKinds) {
      const entries = categories[kind];
      if (entries.length === 0) continue;
      sections.push(`## ${typeLabels[kind]}`, '');
      for (const entry of entries) {
        sections.push(`- [[${entry.title}]] — ${entry.desc}`);
      }
      sections.push('');
    }

    fs.writeFileSync(path.join(wikiDir, 'index.md'), sections.join('\n'), 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Operation log (chronological record of all wiki operations)
  // ---------------------------------------------------------------------------

  appendLog(operation: string, description: string, details?: string): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const logPath = path.join(wikiDir, 'log.md');
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const lines: string[] = [`## [${timestamp}] ${operation} | ${description}`];
    if (details) lines.push('', details);
    lines.push('');
    const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    fs.writeFileSync(logPath, existing + lines.join('\n'), 'utf-8');
  }

  /**
   * Append new content to an existing wiki page, merging tags/sources.
   * Adds a timestamped update section instead of overwriting.
   */
  private updateExistingPage(
    existingPath: string,
    newContent: string,
    sourceId: string,
    today: string,
    newTags: string[],
  ): void {
    const raw = fs.readFileSync(existingPath, 'utf-8');
    const { frontmatter, body } = this.parseFrontmatter(raw);
    const title = (frontmatter['title'] as string) ?? path.basename(existingPath, '.md');

    const existingTags = Array.isArray(frontmatter['tags']) ? (frontmatter['tags'] as string[]) : [];
    const mergedTags = [...new Set([...existingTags, ...newTags.filter(Boolean)])];

    const existingSources = Array.isArray(frontmatter['sources']) ? (frontmatter['sources'] as string[]) : [];
    const mergedSources = [...new Set([...existingSources, sourceId])];

    const updateSection = `\n\n---\n## Update [${today}]\n${newContent}`;
    const newBody = body + updateSection;

    const fm = this.buildFrontmatter({
      title,
      type: (frontmatter['type'] as PageKind) ?? 'concept',
      created: (frontmatter['created'] as string) ?? today,
      updated: today,
      sources: mergedSources,
      tags: mergedTags,
      difficulty: (frontmatter['difficulty'] as string) ?? undefined,
      entityType: (frontmatter['entity_type'] as string) ?? undefined,
    });

    fs.writeFileSync(existingPath, `${fm}\n${newBody}`, 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const frontmatter: Record<string, unknown> = {};

    if (!content.startsWith('---')) {
      return { frontmatter, body: content };
    }

    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) {
      return { frontmatter, body: content };
    }

    const yamlBlock = content.slice(3, endIndex).trim();
    const body = content.slice(endIndex + 3).trimStart();

    for (const line of yamlBlock.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();

      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        // Parse array: [item1, item2]
        const items = rawValue
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        frontmatter[key] = items;
      } else if (rawValue === 'true' || rawValue === 'false') {
        frontmatter[key] = rawValue === 'true';
      } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        frontmatter[key] = Number(rawValue);
      } else {
        frontmatter[key] = rawValue.replace(/^['"]|['"]$/g, '');
      }
    }

    return { frontmatter, body };
  }

  slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  private static MAX_CONTENT_LENGTH = 5000;

  private truncateContent(text: string): string {
    if (text.length <= WikiEngine.MAX_CONTENT_LENGTH) return text;
    return text.slice(0, WikiEngine.MAX_CONTENT_LENGTH - 3) + '...';
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildFrontmatter(data: FrontmatterData): string {
    const tagsStr = data.tags.length > 0
      ? `[${data.tags.map((t) => `"${t}"`).join(', ')}]`
      : '[]';
    const sourcesStr = data.sources.length > 0
      ? `[${data.sources.map((s) => `"${s}"`).join(', ')}]`
      : '[]';
    const lines: string[] = [
      '---',
      `title: "${data.title.replace(/"/g, '\\"')}"`,
      `type: ${data.type}`,
      `created: ${data.created}`,
      `updated: ${data.updated}`,
      `sources: ${sourcesStr}`,
      `tags: ${tagsStr}`,
    ];
    if (data.difficulty) lines.push(`difficulty: ${data.difficulty}`);
    if (data.entityType) lines.push(`entity_type: ${data.entityType}`);
    lines.push('---');
    return lines.join('\n');
  }

  private injectWikilinks(content: string, allTitles: string[]): string {
    let result = content;
    for (const title of allTitles) {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'i');
      result = result.replace(regex, `[[${title}]]`);
    }
    return result;
  }

  private readAllWikiPages(): WikiPage[] {
    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) return [];

    const pages: WikiPage[] = [];
    const mdFiles = this.readdirRecursive(wikiDir, '.md');

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      const type = (frontmatter['type'] as PageKind) ?? 'concept';
      const sources = (frontmatter['sources'] as string[]) ?? [];
      const tags = (frontmatter['tags'] as string[]) ?? [];
      pages.push({ title, type, path: filePath, content: body, sources, tags });
    }

    return pages;
  }

  private splitPage(targetTitle: string): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    const mdFiles = this.readdirRecursive(wikiDir, '.md');

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');

      if (title !== targetTitle) continue;

      // Split body on ## headings
      const sections = body.split(/^## .+$/m).filter((s) => s.trim().length > 0);
      if (sections.length <= 1) return;

      const dirName = this.slugify(targetTitle);
      const parentDir = path.dirname(filePath);
      const subDir = path.join(parentDir, dirName);
      fs.mkdirSync(subDir, { recursive: true });

      const today = new Date().toISOString().slice(0, 10);

      // Move original to index.md and replace body with a hub linking to sub-pages
      const subPageTitles: string[] = [];
      for (let i = 0; i < sections.length; i++) {
        const firstLine = sections[i].split('\n').find((l) => l.trim().length > 0) ?? `Section ${i + 1}`;
        const sectionTitle = `${targetTitle} — ${firstLine.slice(0, 60)}`;
        subPageTitles.push(sectionTitle);
        const slug = this.slugify(`${targetTitle}-${i}`);
        const subPath = path.join(subDir, `${slug}.md`);
        const fm = this.buildFrontmatter({
          title: sectionTitle,
          type: (frontmatter['type'] as PageKind) ?? 'concept',
          created: today,
          updated: today,
          sources: (frontmatter['sources'] as string[]) ?? [],
          tags: (frontmatter['tags'] as string[]) ?? [],
        });
        fs.writeFileSync(subPath, `${fm}\n${sections[i].trim()}`, 'utf-8');
      }

      const hubBody = [
        `This topic has been split into sub-pages:`,
        '',
        ...subPageTitles.map((t) => `- [[${t}]]`),
      ].join('\n');

      const hubFm = this.buildFrontmatter({
        title: targetTitle,
        type: (frontmatter['type'] as PageKind) ?? 'concept',
        created: (frontmatter['created'] as string) ?? today,
        updated: today,
        sources: (frontmatter['sources'] as string[]) ?? [],
        tags: (frontmatter['tags'] as string[]) ?? [],
      });

      fs.writeFileSync(filePath, `${hubFm}\n${hubBody}`, 'utf-8');
      return;
    }
  }

  private mergeDuplicates(targetTitle: string): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    const mdFiles = this.readdirRecursive(wikiDir, '.md');

    const matches: Array<{ filePath: string; title: string; body: string; frontmatter: Record<string, unknown> }> = [];

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');

      if (title === targetTitle) {
        matches.push({ filePath, title, body, frontmatter });
      }
    }

    if (matches.length <= 1) return;

    // Keep the most complete version (longest body)
    matches.sort((a, b) => b.body.length - a.body.length);
    const primary = matches[0];
    const today = new Date().toISOString().slice(0, 10);

    // Merge unique content from others
    const mergedSections = new Set(primary.body.split('\n'));
    for (let i = 1; i < matches.length; i++) {
      for (const line of matches[i].body.split('\n')) {
        mergedSections.add(line);
      }
      // Remove duplicate file
      fs.unlinkSync(matches[i].filePath);
    }

    const mergedBody = Array.from(mergedSections).join('\n');
    const fm = this.buildFrontmatter({
      title: targetTitle,
      type: (primary.frontmatter['type'] as PageKind) ?? 'concept',
      created: (primary.frontmatter['created'] as string) ?? today,
      updated: today,
      sources: (primary.frontmatter['sources'] as string[]) ?? [],
      tags: (primary.frontmatter['tags'] as string[]) ?? [],
    });

    fs.writeFileSync(primary.filePath, `${fm}\n${mergedBody}`, 'utf-8');
  }

  private extractCitations(text: string): string[] {
    const matches = text.matchAll(/\[\[([^\]]+)\]\]/g);
    return Array.from(matches, (m) => m[1]);
  }

  /**
   * Find a wiki page by title. Uses case-insensitive exact match first,
   * then falls back to substring/contains fuzzy matching.
   */
  private findPagePath(title: string): string | undefined {
    if (!title) return undefined;
    if (!this.titleCache) {
      this.titleCache = this.buildTitleCache();
    }
    if (this.titleCache.size === 0) return undefined;

    // 1. Exact case-insensitive match
    const exact = this.titleCache.get(title.toLowerCase());
    if (exact) return exact.path;

    // 2. Fuzzy: check if existing title contains search term or vice versa
    const lowerSearch = title.toLowerCase();
    let bestMatch: TitleCacheEntry | undefined;
    let bestScore = 0;
    for (const entry of this.titleCache.values()) {
      const lowerTitle = entry.title.toLowerCase();
      if (lowerTitle === lowerSearch) { bestMatch = entry; break; }
      if (lowerTitle.includes(lowerSearch) || lowerSearch.includes(lowerTitle)) {
        const score = Math.min(lowerTitle.length, lowerSearch.length);
        if (score > bestScore) { bestScore = score; bestMatch = entry; }
      }
    }
    return bestMatch?.path;
  }

  private readdirRecursive(dir: string, extension: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.readdirRecursive(fullPath, extension));
      } else if (entry.name.endsWith(extension)) {
        results.push(fullPath);
      }
    }

    return results;
  }
}
