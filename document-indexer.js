import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const DEFAULT_INDEX_FILES = [
  "README.md",
  "agent.js",
  "index.js",
  "rag-agent.js",
  "rag-demo.js",
  "mcp-server.js",
  "mcp-client.js",
  "mcp-agent.js",
  "mcp-pipeline-agent.js",
  "mcp-orchestrator-agent.js",
  "mcp-scheduler-agent.js",
  "mcp-files-server.js",
  "mcp-git-server.js",
  "swarm-agent.js",
  "swarm-cli.js",
  "context-strategy-agent.js",
  "layered-memory-agent.js",
  "task-state-machine-agent.js",
  "memory-cli.js",
  "strategy-cli.js",
  "task-state-cli.js",
  "compression-demo.js",
  "strategy-demo.js",
  "memory-demo.js",
  "task-state-demo.js",
  "token-demo.js",
  "personalization-demo.js"
];

const STOP_WORDS = new Set([
  "что",
  "как",
  "для",
  "или",
  "это",
  "если",
  "при",
  "над",
  "под",
  "the",
  "and",
  "with",
  "from",
  "this",
  "that",
  "const",
  "return",
  "await",
  "async"
]);

export class DocumentIndexer {
  constructor({
    cwd = ".",
    files = DEFAULT_INDEX_FILES,
    embeddingDimensions = 128,
    fixedChunkSize = 1400,
    fixedOverlap = 220,
    outputDir = "./document-index"
  } = {}) {
    this.cwd = cwd;
    this.files = files;
    this.embeddingDimensions = embeddingDimensions;
    this.fixedChunkSize = fixedChunkSize;
    this.fixedOverlap = fixedOverlap;
    this.outputDir = outputDir;
  }

  async loadDocuments() {
    const files = await this.resolveFiles();
    const documents = [];

    for (const file of files) {
      const content = await readFile(join(this.cwd, file), "utf8");
      documents.push({
        source: file,
        title: file,
        content,
        characters: content.length,
        lines: content.split(/\r?\n/).length
      });
    }

    return documents;
  }

  async resolveFiles() {
    const existing = [];

    for (const file of this.files) {
      try {
        await readFile(join(this.cwd, file), "utf8");
        existing.push(file);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    if (existing.length > 0) {
      return existing;
    }

    const entries = await readdir(this.cwd, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(md|js|txt)$/i.test(entry.name))
      .map((entry) => relative(this.cwd, join(this.cwd, entry.name)));
  }

  chunkFixed(documents) {
    const chunks = [];

    for (const document of documents) {
      const normalized = document.content.replace(/\r\n/g, "\n");
      let start = 0;

      while (start < normalized.length) {
        const end = Math.min(start + this.fixedChunkSize, normalized.length);
        const text = normalized.slice(start, end).trim();

        if (text) {
          chunks.push({
            text,
            metadata: {
              source: document.source,
              title: document.title,
              section: this.detectSection(normalized, start),
              chunking_strategy: "fixed",
              start_char: start,
              end_char: end,
              line_start: this.lineNumberAt(normalized, start),
              line_end: this.lineNumberAt(normalized, end)
            }
          });
        }

        if (end === normalized.length) {
          break;
        }
        start = Math.max(0, end - this.fixedOverlap);
      }
    }

    return chunks;
  }

  chunkStructured(documents) {
    const chunks = [];

    for (const document of documents) {
      if (document.source.endsWith(".md")) {
        chunks.push(...this.chunkMarkdownByHeadings(document));
      } else {
        chunks.push(...this.chunkCodeByBlocks(document));
      }
    }

    return chunks;
  }

  chunkMarkdownByHeadings(document) {
    const lines = document.content.replace(/\r\n/g, "\n").split("\n");
    const chunks = [];
    let currentTitle = document.title;
    let currentStartLine = 1;
    let buffer = [];

    const flush = (endLine) => {
      const text = buffer.join("\n").trim();
      if (!text) {
        return;
      }
      chunks.push({
        text,
        metadata: {
          source: document.source,
          title: document.title,
          section: currentTitle,
          chunking_strategy: "structured",
          line_start: currentStartLine,
          line_end: endLine,
          start_char: this.charOffsetAtLine(document.content, currentStartLine),
          end_char: this.charOffsetAtLine(document.content, endLine + 1)
        }
      });
    };

    for (const [index, line] of lines.entries()) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading && buffer.length > 0) {
        flush(index);
        buffer = [];
        currentStartLine = index + 1;
      }
      if (heading) {
        currentTitle = heading[2].trim();
      }
      buffer.push(line);
    }

    flush(lines.length);
    return chunks;
  }

  chunkCodeByBlocks(document) {
    const lines = document.content.replace(/\r\n/g, "\n").split("\n");
    const chunks = [];
    let buffer = [];
    let currentStartLine = 1;
    let currentSection = document.title;

    const boundaryPattern = /^(export\s+)?(class|function|async function|const|let|var)\s+([A-Za-z0-9_]+)/;
    const flush = (endLine) => {
      const text = buffer.join("\n").trim();
      if (!text) {
        return;
      }
      chunks.push({
        text,
        metadata: {
          source: document.source,
          title: document.title,
          section: currentSection,
          chunking_strategy: "structured",
          line_start: currentStartLine,
          line_end: endLine,
          start_char: this.charOffsetAtLine(document.content, currentStartLine),
          end_char: this.charOffsetAtLine(document.content, endLine + 1)
        }
      });
    };

    for (const [index, line] of lines.entries()) {
      const boundary = line.match(boundaryPattern);
      if (boundary && buffer.length > 0) {
        flush(index);
        buffer = [];
        currentStartLine = index + 1;
      }
      if (boundary) {
        currentSection = boundary[3];
      }
      buffer.push(line);

      if (buffer.join("\n").length > this.fixedChunkSize * 1.4) {
        flush(index + 1);
        buffer = [];
        currentStartLine = index + 2;
        currentSection = document.title;
      }
    }

    flush(lines.length);
    return chunks;
  }

  buildIndex(strategy, chunks, documents) {
    const indexedChunks = chunks.map((chunk, index) => ({
      chunk_id: `${strategy}-${String(index + 1).padStart(5, "0")}`,
      text: chunk.text,
      embedding: this.embed(chunk.text),
      metadata: {
        ...chunk.metadata,
        chunk_id: `${strategy}-${String(index + 1).padStart(5, "0")}`,
        token_estimate: this.estimateTokens(chunk.text),
        char_count: chunk.text.length
      }
    }));

    return {
      created_at: new Date().toISOString(),
      strategy,
      embedding: {
        type: "local_hashing_embedding",
        dimensions: this.embeddingDimensions,
        normalized: true
      },
      corpus: {
        document_count: documents.length,
        total_characters: documents.reduce((sum, document) => sum + document.characters, 0),
        total_lines: documents.reduce((sum, document) => sum + document.lines, 0),
        estimated_pages: this.estimatePages(documents),
        sources: documents.map((document) => ({
          source: document.source,
          title: document.title,
          characters: document.characters,
          lines: document.lines
        }))
      },
      chunks: indexedChunks
    };
  }

  compareIndexes(fixedIndex, structuredIndex) {
    return {
      corpus: fixedIndex.corpus,
      strategies: [
        this.strategyStats(fixedIndex),
        this.strategyStats(structuredIndex)
      ],
      notes: [
        "fixed: стабильный размер чанков, проще контролировать контекстное окно.",
        "structured: сохраняет границы разделов, функций и файлов, обычно лучше читается человеком."
      ]
    };
  }

  strategyStats(index) {
    const tokenCounts = index.chunks.map((chunk) => chunk.metadata.token_estimate);
    const charCounts = index.chunks.map((chunk) => chunk.metadata.char_count);
    return {
      strategy: index.strategy,
      chunks: index.chunks.length,
      avg_tokens: this.average(tokenCounts),
      min_tokens: Math.min(...tokenCounts),
      max_tokens: Math.max(...tokenCounts),
      avg_chars: this.average(charCounts),
      sources: new Set(index.chunks.map((chunk) => chunk.metadata.source)).size
    };
  }

  async buildAndSaveAll() {
    const documents = await this.loadDocuments();
    const fixedIndex = this.buildIndex("fixed", this.chunkFixed(documents), documents);
    const structuredIndex = this.buildIndex("structured", this.chunkStructured(documents), documents);
    const comparison = this.compareIndexes(fixedIndex, structuredIndex);

    await mkdir(this.outputDir, { recursive: true });
    await this.writeJson(join(this.outputDir, "index-fixed.json"), fixedIndex);
    await this.writeJson(join(this.outputDir, "index-structured.json"), structuredIndex);
    await this.writeJson(join(this.outputDir, "comparison.json"), comparison);

    return { fixedIndex, structuredIndex, comparison };
  }

  embed(text) {
    const vector = new Array(this.embeddingDimensions).fill(0);
    const tokens = this.tokenize(text);

    for (const token of tokens) {
      const index = this.hash(token) % this.embeddingDimensions;
      vector[index] += 1;

      for (const gram of this.charNgrams(token, 3)) {
        const gramIndex = this.hash(gram) % this.embeddingDimensions;
        vector[gramIndex] += 0.25;
      }
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => Number((value / norm).toFixed(6)));
  }

  tokenize(text) {
    return String(text)
      .toLowerCase()
      .match(/[a-zа-яё0-9_/-]{3,}/gi)
      ?.map((token) => token.toLowerCase())
      .filter((token) => !STOP_WORDS.has(token)) || [];
  }

  charNgrams(token, size) {
    if (token.length <= size) {
      return [token];
    }
    const grams = [];
    for (let index = 0; index <= token.length - size; index += 1) {
      grams.push(token.slice(index, index + size));
    }
    return grams;
  }

  hash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  estimateTokens(text) {
    return Math.max(1, Math.ceil(text.length / 3.5));
  }

  estimatePages(documents) {
    const totalCharacters = documents.reduce((sum, document) => sum + document.characters, 0);
    return Number((totalCharacters / 2500).toFixed(1));
  }

  detectSection(content, start) {
    const before = content.slice(0, start);
    const headings = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)];
    return headings.at(-1)?.[1]?.trim() || "file";
  }

  lineNumberAt(content, charOffset) {
    return content.slice(0, charOffset).split("\n").length;
  }

  charOffsetAtLine(content, lineNumber) {
    if (lineNumber <= 1) {
      return 0;
    }
    const lines = content.split(/\r?\n/);
    return lines.slice(0, lineNumber - 1).join("\n").length + 1;
  }

  average(values) {
    if (values.length === 0) {
      return 0;
    }
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
  }

  async writeJson(path, data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}
