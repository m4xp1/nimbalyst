import {atom} from 'jotai';
import {atomFamily} from '../debug/atomFamilyRegistry';
import {normalizeFileTreePath} from '../../utils/fileTreePath';
export function memoryTreePathKey(path:string):string{const key=normalizeFileTreePath(path);return key.startsWith('//')?key.toLowerCase():key;}
export const memoryTreeErrorsAtom=atom<ReadonlyMap<string,string>>(new Map<string,string>());
export const memoryTreeIndexingAtom=atom(false);
export const memoryTreeErrorAtom=atomFamily((path:string)=>atom(get=>get(memoryTreeErrorsAtom).get(memoryTreePathKey(path))));
export const memoryTreeAvailableAtom=atom(false);
export const memoryTreeIncludedPathsAtom=atom<ReadonlySet<string>>(new Set<string>());
/** Each row receives a stable boolean rather than the whole workspace snapshot. */
export const memoryTreeIncludedAtom=atomFamily((path:string)=>atom(get=>get(memoryTreeAvailableAtom)&&get(memoryTreeIncludedPathsAtom).has(memoryTreePathKey(path))));
