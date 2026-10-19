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
}
export declare const memorySourceChangeAtom: import("jotai").PrimitiveAtom<MemorySourceChange | null> & {
    init: MemorySourceChange | null;
};
export declare function sameMemoryWorkspace(a: string | undefined, b: string | undefined): boolean;
/** Renderer-only notifications, never a backend capability or a rule write route. */
export declare const memorySourceChanges: {
    publish(change: MemorySourceChange): void;
    subscribe(listener: (change: MemorySourceChange) => void): () => void;
};
