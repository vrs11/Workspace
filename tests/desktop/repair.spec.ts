import { browser, $, expect } from "@wdio/globals";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("native startup preference recovery", () => {
  it("restores a validated backup after confirmation and keeps private checkpoints", async () => {
    const reload = async () => {
      await browser.execute(() => {
        document
          .getElementById("root")!
          .setAttribute("data-reload-probe", "old-document");
      });
      await browser.refresh();
      await browser.waitUntil(
        async () =>
          await browser.execute(
            () =>
              !document
                .getElementById("root")
                ?.hasAttribute("data-reload-probe"),
          ),
      );
    };
    await $(".startup-repair h1").waitForDisplayed();
    await $("button=Restore previous preferences").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await $(".recent-projects button").waitForDisplayed();
    const data = process.env.AW_DESKTOP_DATA!;
    expect(
      JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).version,
    ).toBe(2);
    expect(readFileSync(join(data, "recovery-preserved.bak"), "utf8")).toBe(
      "private checkpoint fixture",
    );
    const retained = readdirSync(data).find((name) =>
      name.startsWith("settings.retained-"),
    );
    expect(retained).toBeDefined();
    expect(readFileSync(join(data, retained!), "utf8")).toBe(
      "damaged preferences",
    );
    expect(await $(".trust-banner").isExisting()).toBe(false);
    await reload();
    await $(".recent-projects button").waitForDisplayed();
    expect(await $(".startup-repair").isExisting()).toBe(false);
    console.info("Preferences restored; opening fixture");
    await $(".recent-projects button").click();
    await $(".trust-banner").waitForDisplayed();
    await $(".explorer").$("span=hello.ts").click();
    await $('[aria-label="Close hello.ts"]').waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    const workspaceFile = join(
      process.env.AW_DESKTOP_PROJECT!,
      ".agent-workspace",
      "workspace.json",
    );
    await browser.waitUntil(() => existsSync(workspaceFile));
    writeFileSync(workspaceFile, "damaged editor layout");
    console.info("Editor layout damaged; reloading");
    await reload();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    expect(await $('[role="dialog"]').getText()).toContain(
      "Repair saved editor layout",
    );
    await $('[role="dialog"] button.primary').click();
    await $(".explorer").waitForDisplayed();
    await browser.waitUntil(() => {
      try {
        return (
          JSON.parse(readFileSync(workspaceFile, "utf8")).ui.tabs.length === 0
        );
      } catch {
        return false;
      }
    });
    expect(JSON.parse(readFileSync(workspaceFile, "utf8")).ui.tabs).toEqual([]);
    console.info("Editor layout repaired");
    const damaged = JSON.parse(readFileSync(workspaceFile, "utf8"));
    damaged.terminal.version = 99;
    writeFileSync(workspaceFile, JSON.stringify(damaged));
    await reload();
    await $(".explorer").waitForDisplayed();
    await $('button[aria-label="Terminal"]').click();
    await $("button=Reset terminal layout").waitForDisplayed();
    console.info("Terminal layout repair displayed");
    await $("button=Reset terminal layout").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(
      async () => !(await $("button=Reset terminal layout").isExisting()),
    );
    expect(
      JSON.parse(readFileSync(workspaceFile, "utf8")).terminal.tabs,
    ).toEqual([]);
    expect(readFileSync(join(data, "recovery-preserved.bak"), "utf8")).toBe(
      "private checkpoint fixture",
    );
  });
});
