import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

import { render } from "../../test/render";
import { DocsDriftSection } from "./DocsDriftSection";

it("starts collapsed and only checks drift once expanded", async () => {
  await using screen = await render(
    <DocsDriftSection
      environmentId={EnvironmentId.make("env-1")}
      threadId={ThreadId.make("thread-1")}
      turnId={RunId.make("run-1")}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Docs drift" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  expect(document.body.textContent).not.toContain("Checking docs");
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
});
