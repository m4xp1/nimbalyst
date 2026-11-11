// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveLaunchTarget, type PathKind } from '../launchTarget';

const project = path.resolve('/Users/me/project');
const tree: Record<string, PathKind> = {
    [project]: 'directory',
    [path.join(project, 'src')]: 'directory',
    [path.join(project, 'README.md')]: 'file',
};
const kindOf = (p: string): PathKind => tree[p] ?? null;

describe('resolveLaunchTarget', () => {
    it('resolves `.` against the shell directory to the folder to open', () => {
        expect(resolveLaunchTarget(['.'], project, kindOf)).toEqual({
            kind: 'directory',
            path: project,
        });
    });

    it('resolves relative files and folders and keeps absolute paths', () => {
        expect(resolveLaunchTarget(['README.md'], project, kindOf)).toEqual({
            kind: 'file',
            path: path.join(project, 'README.md'),
        });
        expect(resolveLaunchTarget([path.join(project, 'src')], '/tmp', kindOf)).toEqual({
            kind: 'directory',
            path: path.join(project, 'src'),
        });
    });

    it('skips switches macOS and Chromium add, deep links, and flag values', () => {
        const args = [
            '-psn_0_12345',
            '--allow-file-access-from-files',
            'nimbalyst://open?x=1',
            '--workspace',
            '/Users/me/other',
            'src',
        ];
        expect(resolveLaunchTarget(args, project, kindOf)).toEqual({
            kind: 'directory',
            path: path.join(project, 'src'),
        });
    });

    it('reports a path that does not exist instead of dropping it', () => {
        expect(resolveLaunchTarget(['nope'], project, kindOf)).toEqual({
            kind: 'missing',
            path: path.join(project, 'nope'),
        });
    });

    it('returns null when no path was given', () => {
        expect(resolveLaunchTarget([], '/Users/me', kindOf)).toBeNull();
        expect(resolveLaunchTarget(['--safe-mode'], '/Users/me', kindOf)).toBeNull();
    });
});
