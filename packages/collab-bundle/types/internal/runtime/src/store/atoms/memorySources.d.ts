/** Durable Memory-rule receipts shared by file-tree actions and the extension settings panel. */
export interface MemorySourceChange {
    workspacePath: string;
    rootId: string | null;
    revision: string;
    rules: {
        version: 1;
        include: string[];
        exclude: string[];
    };
    /** Serialized, browser-safe rule program supplied with the durable receipt. */
    treePolicy?: unknown;
}
export declare const memorySourceChangeAtom: import("jotai").PrimitiveAtom<MemorySourceChange | null> & {
    init: MemorySourceChange | null;
};
export interface MemorySourceFolder {
    id: string | null;
    label: string;
    path: string;
    available: boolean;
}
/** Host-owned metadata, updated by the central Memory listener, never one RPC per picker. */
export declare const memorySourceFoldersAtomFamily: import("jotai-family").AtomFamily<string, import("jotai").PrimitiveAtom<MemorySourceFolder[]> & {
    init: MemorySourceFolder[];
}>;
/** Session-local selection; undefined means All, never persisted into indexing rules. */
export declare const memorySearchRootIdsAtomFamily: import("jotai-family").AtomFamily<string, import("jotai").PrimitiveAtom<(string | null)[] | undefined> & {
    init: (string | null)[] | undefined;
}>;
export declare function sameMemoryWorkspace(a: string | undefined, b: string | undefined): boolean;
/** Renderer-only notifications, never a backend capability or a rule write route. */
export declare const memorySourceChanges: {
    publish(change: MemorySourceChange): void;
    subscribe(listener: (change: MemorySourceChange) => void): () => void;
};
