import { $, browser } from "@wdio/globals";

export async function terminalAction(name: string) {
  await browser.execute(() => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Terminal actions"]',
    )!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const action = $(`div=${name}`);
  await action.waitForDisplayed();
  await action.click();
}

export async function gitAction(name: string) {
  await browser.execute(() => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Git actions"]',
    )!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const action = $(`div=${name}`);
  await action.waitForDisplayed();
  await action.click();
}

export async function explorerAction(name: string, create = false) {
  await browser.execute(
    (label) => {
      const trigger = document.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      )!;
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    create ? "New file or folder" : "Selected file actions",
  );
  await $(`div=${name}`).waitForDisplayed();
  await $(`div=${name}`).click();
}
