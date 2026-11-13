import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PlanChecklist } from "./ThreadPlan";

const milestones = [
  { id: "M1", text: "Contracts", done: true },
  { id: "M2", text: "Projection", done: false },
];

it("renders milestones with done state and the progress log tail", async () => {
  await using screen = await render(
    <PlanChecklist
      milestones={milestones}
      progressLog={["old", "newest"]}
      onToggle={() => {}}
    />,
  );
  await expect.element(screen.getByText("1 of 2 done")).toBeInTheDocument();
  await expect.element(screen.getByRole("checkbox", { name: "Contracts" })).toBeChecked();
  await expect.element(screen.getByRole("checkbox", { name: "Projection" })).not.toBeChecked();
  await expect.element(screen.getByText("newest")).toBeInTheDocument();
});

it("calls onToggle with the milestone id and the next done state", async () => {
  const onToggle = vi.fn();
  await using screen = await render(
    <PlanChecklist milestones={milestones} progressLog={[]} onToggle={onToggle} />,
  );
  // The checkbox is unsized in the test layout (no Tailwind), so Playwright sees it as hidden.
  (screen.getByRole("checkbox", { name: "Projection" }).element() as HTMLElement).click();
  expect(onToggle).toHaveBeenCalledWith("M2", true);
});
