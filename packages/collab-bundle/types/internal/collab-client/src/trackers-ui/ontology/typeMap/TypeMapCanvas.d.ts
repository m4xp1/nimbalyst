import type { TypeMapRelationship, TypeMapType } from '../ontologyLabelMap';
import { type MapLayout, type MapPair } from './typeMapLayout';
export type MapSelection = {
    kind: 'type' | 'relationship';
    id: string;
} | null;
export declare function initials(name: string): string;
export interface TypeMapCanvasProps {
    layout: MapLayout;
    types: ReadonlyMap<string, TypeMapType>;
    pairs: ReadonlyMap<string, MapPair>;
    relationships: ReadonlyMap<string, TypeMapRelationship>;
    zoneTone: ReadonlyMap<string, number>;
    maxCount: number;
    /** Ids (`type:x`, `rel:x`) in the hovered or selected neighbourhood. */
    lit: ReadonlySet<string>;
    selection: MapSelection;
    onSelect: (selection: MapSelection) => void;
    onHover: (selection: MapSelection) => void;
}
export declare const TypeMapCanvas: import("react").NamedExoticComponent<TypeMapCanvasProps>;
