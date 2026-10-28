import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { act } from "react";
import { ErrorDetails } from "../../src/shared/components/ErrorDetails";
import {
  ask,
  DialogHost,
  waitForDialogIdle,
  askWhenIdle,
} from "../../src/shared/components/Dialog";
afterEach(cleanup);
it("focuses the default choice, navigates every action with arrows and activates the selected choice with Enter", async () => {
  render(<DialogHost />);
  let result!: Promise<string | null>;
  act(() => {
    result = ask({
      title: "Save changes",
      description: "Choose what happens to your edits.",
      choices: ["Save", "Discard"],
    });
  });
  expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
  const user = userEvent.setup();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(await result).toBe("Discard");
});
it("moves from the default to Cancel with Left and Enter cancels rather than submitting the first choice", async () => {
  render(<DialogHost />);
  let result!: Promise<string | null>;
  act(() => {
    result = ask({
      title: "Delete",
      description: "Confirm deletion",
      choices: ["Delete"],
    });
  });
  const user = userEvent.setup();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(await result).toBeNull();
});
it("wraps Up/Down between choices while input arrows retain caret movement and Enter submits its value", async () => {
  render(<DialogHost />);
  let result!: Promise<string | null>;
  act(() => {
    result = ask({
      title: "Rename",
      description: "Enter a name",
      input: "abc",
      choices: ["Rename"],
    });
  });
  const input = screen.getByRole("textbox") as HTMLInputElement;
  expect(input).toHaveFocus();
  input.setSelectionRange(1, 1);
  const user = userEvent.setup();
  await user.keyboard("{ArrowRight}");
  expect(input).toHaveFocus();
  expect(input.selectionStart).toBe(2);
  await user.keyboard("{Enter}");
  expect(await result).toBe("abc");
  act(() => {
    result = ask({
      title: "Choose",
      description: "Choose an option",
      choices: ["First", "Second"],
    });
  });
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(await result).toBeNull();
});
it("labels a real dialog, submits its input and resolves the action", async () => {
  render(<DialogHost />);
  let result: Promise<string | null>;
  act(() => {
    result = ask({
      title: "Rename file",
      description: "Existing destinations are refused.",
      input: "old",
    });
  });
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Rename file");
  const input = screen.getByRole("textbox");
  const user = userEvent.setup();
  await user.clear(input);
  await user.type(input, "new");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await result!).toBe("new");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("Escape cancels rather than authorizing an action", async () => {
  render(<DialogHost />);
  let result: Promise<string | null>;
  act(() => {
    result = ask({
      title: "Delete",
      description: "Confirm deletion",
      choices: ["Delete"],
    });
  });
  await userEvent.setup().keyboard("{Escape}");
  expect(await result!).toBeNull();
});

it("retains a rejected name inline and submits a correction without losing the dialog", async () => {
  render(<DialogHost />);
  const submitted: string[] = [];
  let result: Promise<string | null>;
  act(() => {
    result = ask({
      title: "New file",
      description: "Create in project root",
      inputLabel: "Name",
      input: "existing.ts",
      choices: ["Create"],
      submit: async (name) => {
        submitted.push(name);
        if (name === "existing.ts")
          throw {
            code: "alreadyExists",
            message: "“existing.ts” already exists. Choose a different name.",
            operationId: "2e6506d3-d5b9-4aaa-85fa-be71053ab099",
          };
      },
    });
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("existing.ts");
  expect(screen.getByRole("textbox")).toHaveValue("existing.ts");
  expect(screen.getByRole("alert")).not.toHaveTextContent("2e6506d3");
  await user.click(screen.getByRole("button", { name: "Details" }));
  expect(
    await screen.findByRole("dialog", { name: "Error details" }),
  ).toBeInTheDocument();
  expect(submitted).toEqual(["existing.ts"]);
  expect(
    screen.getByRole("button", { name: "Close error details" }),
  ).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("button", { name: "Copy reference" })).toHaveFocus();
  await user.keyboard("{ArrowLeft}{Enter}");
  expect(screen.getByRole("dialog", { name: "New file" })).toBeInTheDocument();
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "new.ts");
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await result!).toBe("new.ts");
  expect(submitted).toEqual(["existing.ts", "new.ts"]);
});
it("a pending submission cannot double-submit or dismiss a newer question", async () => {
  render(<DialogHost />);
  let complete: () => void = () => {};
  let calls = 0;
  act(() => {
    void ask({
      title: "Create",
      description: "Create file",
      input: "a",
      choices: ["Create"],
      submit: () => {
        calls++;
        return new Promise<void>((resolve) => {
          complete = resolve;
        });
      },
    });
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  act(() => {
    void ask({ title: "New question", description: "Keep this decision" });
  });
  await act(async () => {
    complete();
  });
  expect(calls).toBe(1);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("New question");
  await user.keyboard("{Escape}");
});

it("keeps an opened error reference stable when a background notice changes", async () => {
  const details = {
    code: "alreadyExists",
    operationId: "2e6506d3-d5b9-4aaa-85fa-be71053ab099",
  };
  const view = render(<ErrorDetails details={details} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Details" }));
  view.rerender(<ErrorDetails details={null} />);
  expect(
    screen.getByRole("dialog", { name: "Error details" }),
  ).toHaveTextContent(details.operationId);
  await user.click(screen.getByRole("button", { name: "Close error details" }));
  view.rerender(<ErrorDetails details={{ code: "permissionDenied" }} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("a queued close waits for an existing decision even when it needs no new question", async () => {
  render(<DialogHost />);
  let question: Promise<string | null>;
  act(() => {
    question = ask({
      title: "Trust this folder",
      description: "Choose explicitly",
      choices: ["Trust"],
    });
  });
  let completed = false;
  const idle = waitForDialogIdle().then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Trust this folder");
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(await question!).toBeNull();
  await idle;
  expect(completed).toBe(true);
});

it("concurrent idle questions are serialized rather than replacing a pending decision", async () => {
  render(<DialogHost />);
  let first: Promise<string | null>;
  let second: Promise<string | null>;
  act(() => {
    first = askWhenIdle({
      title: "First decision",
      description: "Keep this decision",
      choices: ["First"],
    });
    second = askWhenIdle({
      title: "Second decision",
      description: "Wait for the first",
      choices: ["Second"],
    });
  });
  expect(screen.getByRole("dialog")).toHaveAccessibleName("First decision");
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(await first!).toBeNull();
  expect(await screen.findByRole("dialog")).toHaveAccessibleName(
    "Second decision",
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(await second!).toBeNull();
});
