import { describe, it, expect } from "vitest";
import { redirect, UNSAFE_ErrorResponseImpl } from "react-router";
import { refusalAsFormError } from "./validation";

// What a fetcher's serverAction() rejects with when the server action threw
// `data(message, { status })`.
function thrownByServer(status: number, message: string) {
  return new UNSAFE_ErrorResponseImpl(status, "", message);
}

describe("refusalAsFormError", () => {
  it("passes the server action's result through", async () => {
    const result = await refusalAsFormError(async () => ({ errors: null }));
    expect(result).toEqual({ errors: null });
  });

  it("turns a rule's refusal into a form error with its message", async () => {
    const result = await refusalAsFormError(async () => {
      throw thrownByServer(409, "There is already an open refund request on this purchase.");
    });
    expect(result).toEqual({
      errors: { form: "There is already an open refund request on this purchase." },
    });
  });

  it("still throws redirects and other failures", async () => {
    const goToWelcome = redirect("/courses/x/welcome");
    await expect(
      refusalAsFormError(async () => {
        throw goToWelcome;
      })
    ).rejects.toBe(goToWelcome);
    await expect(
      refusalAsFormError(async () => {
        throw thrownByServer(401, "Select a user from the DevUI panel.");
      })
    ).rejects.toMatchObject({ status: 401 });
  });
});
