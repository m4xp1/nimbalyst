import React, { createRef, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
import {
  WorkstreamEditorTabs,
  type WorkstreamEditorTabsRef,
} from "../WorkstreamEditorTabs";
import {
  initWorkstreamState,
  workstreamStateAtom,
  workstreamStatesLoadedAtom,
} from "../../../store/atoms/workstreamState";
import { setAgentFilePlacementAtom } from "../../../store/atoms/agentFilePlacement";
import { setWorkstreamRightPanelModeAtom, workstreamRightPanelModeAtom } from "../../../store/atoms/workstreamState";
import { revealEditorPosition } from "../../TabEditor/editorRevealCommand";

const { actions, tabs, openDialog } = vi.hoisted(() => ({
  openDialog: vi.fn(),
  actions: {
    addTab: vi.fn(),
    switchTab: vi.fn(),
    findTabByPath: vi.fn(),
    removeTab: vi.fn(),
  },
  tabs: [] as Array<{ id: string; filePath: string }>,
}));
vi.mock("../../../contexts/DialogContext", () => ({
  useDialog: () => ({ open: openDialog, close: vi.fn(), activeDialogs: [] }),
}));
vi.mock("../../../contexts/TabsContext", () => ({
  TabsProvider: ({ children }: { children: ReactNode }) => children,
  useTabs: () => ({ tabs, activeTabId: null }),
  useTabsActions: () => actions,
  useTabNavigationShortcuts: () => {},
}));
vi.mock("../../TabManager/TabManager", () => ({ TabManager: () => null }));
vi.mock("../../TabContent/TabContent", () => ({ TabContent: () => null }));
vi.mock("../FilePlacementControl", () => ({
  FilePlacementControl: () => null,
  FilePlacementNotice: () => null,
}));
vi.mock("../../TabEditor/editorRevealCommand", () => ({
  revealEditorPosition: vi.fn(),
}));
afterEach(() => {
  cleanup();
  tabs.length = 0;
  vi.clearAllMocks();
});

it("opens file quick open in the worktree and routes the selection into this viewer", () => {
  initWorkstreamState("/project");
  const store = createStore();
  const id = "quick-open-editor";
  render(
    <Provider store={store}>
      <WorkstreamEditorTabs
        workstreamId={id}
        workspacePath="/project"
        basePath="/project-worktree"
      />
    </Provider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Open file…" }));
  expect(openDialog).toHaveBeenCalledWith("unified-quick-open", expect.objectContaining({
    initialTab: "files",
    workspacePath: "/project-worktree",
    onFileSelect: expect.any(Function),
  }));
  expect(actions.addTab).not.toHaveBeenCalled();
  act(() => openDialog.mock.calls[0][1].onFileSelect("/project-worktree/source.ts"));
  expect(actions.addTab).toHaveBeenCalledWith("/project-worktree/source.ts");
  expect(store.get(workstreamStateAtom(id)).layoutMode).toBe("split");
});

it("does not mirror an empty hidden editor before hydration, forwards file locations, and acknowledges hidden tracker opens", () => {
  initWorkstreamState("/placement-test");
  const store = createStore();
  const id = "hidden-editor";
  const saved = [
    {
      resource: {
        kind: "file" as const,
        resourceId: "/saved.md",
        filePath: "/saved.md",
      },
    },
  ];
  store.set(workstreamStateAtom(id), { openResources: saved });
  const ref = createRef<WorkstreamEditorTabsRef>();
  render(
    <Provider store={store}>
      <WorkstreamEditorTabs
        ref={ref}
        workstreamId={id}
        workspacePath="/placement-test"
        isActive={false}
      />
    </Provider>
  );
  expect(store.get(workstreamStateAtom(id)).openResources).toEqual(saved);
  act(() => store.set(workstreamStatesLoadedAtom, true));
  expect(actions.addTab).toHaveBeenCalledWith("/saved.md");
  act(() => ref.current?.openFile("/source.ts", { line: 37, column: 4 }));
  expect(revealEditorPosition).toHaveBeenCalledWith("/source.ts", {
    line: 37,
    column: 4,
  });
  const event = new CustomEvent("nimbalyst:workstream-open-tracker", {
    detail: { workstreamId: id, trackerItemId: "tracker-1" },
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(actions.addTab).toHaveBeenCalledWith("tracker://tracker-1");
  expect(store.get(workstreamStateAtom(id)).layoutMode).toBe("split");
});

it("lets the user return from the empty right-side file viewer to edited files", () => {
  initWorkstreamState("/project");
  const store = createStore();
  const id = "empty-viewer";
  store.set(setAgentFilePlacementAtom, "right");
  store.set(setWorkstreamRightPanelModeAtom, { workstreamId: id, mode: "file-viewer" });
  render(
    <Provider store={store}>
      <WorkstreamEditorTabs workstreamId={id} workspacePath="/project" basePath="/project" />
    </Provider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Show edited files" }));
  expect(store.get(workstreamRightPanelModeAtom(id))).toBe("edited-files");
});

it("reveals the original file tab for a relative Windows path in the worktree", () => {
  initWorkstreamState("C:/project");
  const store = createStore();
  const ref = createRef<WorkstreamEditorTabsRef>();
  const filePath = 'D:/Worktree/Docs/Plan.md';
  tabs.push({ id: 'plan', filePath });
  render(
    <Provider store={store}>
      <WorkstreamEditorTabs ref={ref} workstreamId="file-alias" workspacePath="C:/project" basePath="D:/worktree" />
    </Provider>
  );
  act(() => ref.current?.openFile('docs\\plan.md', { line: 3 }));
  expect(actions.addTab).not.toHaveBeenCalled();
  expect(actions.switchTab).toHaveBeenCalledWith('plan');
  expect(revealEditorPosition).toHaveBeenCalledWith(filePath, { line: 3 });
  act(() => ref.current?.openFile('docs/new.md', { line: 1 }));
  expect(actions.addTab).toHaveBeenCalledWith('D:/worktree/docs/new.md');
  expect(revealEditorPosition).toHaveBeenCalledWith('D:/worktree/docs/new.md', { line: 1 });
});
