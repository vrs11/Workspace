import { expect, it } from "vitest";
import { errorText, errorDetails } from "../../src/shared/errors";
import { useApp, perform, notice } from "../../src/shared/state/store";
const failure = {
  code: "alreadyExists",
  message: "“existing.ts” already exists. Choose a different name.",
  operationId: "2e6506d3-d5b9-4aaa-85fa-be71053ab099",
};
it("keeps the user message separate from troubleshooting references", () => {
  expect(errorText(failure)).toBe(failure.message);
  expect(errorText(failure)).not.toContain(failure.operationId);
  expect(errorDetails(failure)).toEqual({
    code: failure.code,
    operationId: failure.operationId,
  });
  expect(errorText({ unexpected: "private data" })).not.toContain(
    "[object Object]",
  );
  expect(
    errorDetails({ code: "bad code", operationId: "not-a-reference" }),
  ).toBeNull();
});
it("keeps error references for details and clears stale references with the next notice", async () => {
  await perform(async () => {
    throw failure;
  });
  expect(useApp.getState().notice).toBe(failure.message);
  expect(useApp.getState().noticeDetails?.operationId).toBe(
    failure.operationId,
  );
  notice("Done");
  expect(useApp.getState().noticeDetails).toBeNull();
});
