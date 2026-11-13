declare module '*.css';

declare module 'word-extractor' {
  interface ExtractedDocument {
    getBody(): string;
    getHeaders(options?: { includeFooters?: boolean }): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getFooters(): string;
    getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<ExtractedDocument>;
  }
}

declare module 'markdown-it-footnote' {
  const plugin: (md: unknown) => void;
  export default plugin;
}
