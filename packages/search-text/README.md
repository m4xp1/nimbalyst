# Search text

Pure, host-independent NFC/case/e-yo normalization, Russian Snowball 3.1.1, lexical matching and UTF-16 source positions. Runtime searchText remains a compatible re-export. Snowball attribution and upstream source are in src/snowball/COPYING and SOURCE.md; include both source and license when packaging. No filesystem, Electron, provider or index dependency.

`matchSearchText` preserves the existing Quick Open consecutive-phrase behavior. `matchAllSearchTerms` is the Local Wiki AND matcher across fields, with literal forms before stems. `searchTextSnippet` returns grapheme-safe source text and UTF-16 highlight ranges. Memory retains its own tokenizer, minimum term length and retrieval scoring.
