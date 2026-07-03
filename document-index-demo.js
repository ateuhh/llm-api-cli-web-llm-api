import { DocumentIndexer } from "./document-indexer.js";

const outputDirArgIndex = process.argv.findIndex((arg) => arg === "--out");
const outputDir = outputDirArgIndex >= 0
  ? process.argv[outputDirArgIndex + 1]
  : "./document-index";

const indexer = new DocumentIndexer({ outputDir });
const { fixedIndex, structuredIndex, comparison } = await indexer.buildAndSaveAll();

function formatStrategy(strategy) {
  return [
    `${strategy.strategy}:`,
    `  chunks: ${strategy.chunks}`,
    `  avg_tokens: ${strategy.avg_tokens}`,
    `  min_tokens: ${strategy.min_tokens}`,
    `  max_tokens: ${strategy.max_tokens}`,
    `  avg_chars: ${strategy.avg_chars}`,
    `  sources: ${strategy.sources}`
  ].join("\n");
}

console.log("Локальный индекс документов построен.");
console.log(`Папка индекса: ${outputDir}`);
console.log("");
console.log("Корпус:");
console.log(`  документов: ${comparison.corpus.document_count}`);
console.log(`  строк: ${comparison.corpus.total_lines}`);
console.log(`  символов: ${comparison.corpus.total_characters}`);
console.log(`  оценка страниц: ${comparison.corpus.estimated_pages}`);
console.log("");
console.log("Стратегии chunking:");
for (const strategy of comparison.strategies) {
  console.log(formatStrategy(strategy));
}
console.log("");
console.log("Файлы:");
console.log(`  ${outputDir}/index-fixed.json`);
console.log(`  ${outputDir}/index-structured.json`);
console.log(`  ${outputDir}/comparison.json`);
console.log("");
console.log("Пример metadata fixed:");
console.log(JSON.stringify(fixedIndex.chunks[0].metadata, null, 2));
console.log("");
console.log("Пример metadata structured:");
console.log(JSON.stringify(structuredIndex.chunks[0].metadata, null, 2));
