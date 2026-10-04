// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SourceSettings } from "../components/SourceSettings";
afterEach(cleanup);
describe("source settings", () => {
  it("requires preview, displays provider notice and applies normalized rules", async () => {
    const rules = {
      version: 1,
      include: ["MAP.md", "research/**/*.md"],
      exclude: [],
    };
    const call = vi.fn(async (name: string) =>
      name === "memory.get_sources"
        ? { version: 1, include: [], exclude: [] }
        : name === "memory.preview_sources"
        ? {
            rules,
            files: ["MAP.md"],
            excluded: [{ path: "secrets.md", reason: "Excluded" }],
          }
        : {}
    );
    const applied = vi.fn();
    render(
      <SourceSettings callBackendTool={call} openai onApplied={applied} />
    );
    const field = await screen.findByLabelText("Additional source includes");
    await waitFor(() =>
      expect((field as HTMLTextAreaElement).disabled).toBe(false)
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Apply sources",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    fireEvent.change(field, { target: { value: "MAP.md\nresearch/" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview files" }));
    await screen.findByText(/1 matching Markdown/);
    expect(call).toHaveBeenCalledWith("memory.preview_sources", {
      version: 1,
      include: ["MAP.md", "research/"],
      exclude: [],
    });
    screen.getByRole("note");
    fireEvent.click(screen.getByRole("button", { name: "Apply sources" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("memory.set_sources", rules)
    );
    expect(applied).toHaveBeenCalled();
  });
  it("invalidates the preview after edits and reports errors without raw provider data", async () => {
    const call = vi.fn(async (name: string) =>
      name === "memory.get_sources"
        ? { version: 1, include: [], exclude: [] }
        : name === "memory.preview_sources"
        ? {
            rules: { version: 1, include: [], exclude: [] },
            files: [],
            excluded: [],
          }
        : Promise.reject(new Error("SECRET RESPONSE"))
    );
    render(
      <SourceSettings
        callBackendTool={call}
        openai={false}
        onApplied={() => {}}
      />
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Preview files",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview files" }));
    await screen.findByText(/0 matching Markdown/);
    fireEvent.change(screen.getByLabelText("Additional source includes"), {
      target: { value: "MAP.md" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Apply sources",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview files" }));
    await screen.findByText(/0 matching Markdown/);
    fireEvent.click(screen.getByRole("button", { name: "Apply sources" }));
    expect((await screen.findByRole("alert")).textContent).not.toContain(
      "SECRET RESPONSE"
    );
  });
});
