import { data, isRouteErrorResponse } from "react-router";
import type { z } from "zod";

type ParseSuccess<T> = { success: true; data: T };
type ParseFailure = {
  success: false;
  errors: Record<string, string>;
};
type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Converts FormData to a plain object, validates with a Zod schema,
 * and returns either the parsed data or a field-error map (first error per field).
 */
export function parseFormData<T extends z.ZodType>(
  formData: FormData,
  schema: T
): ParseResult<z.infer<T>> {
  const raw = Object.fromEntries(formData);
  const result = schema.safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const fieldErrors = result.error.flatten().fieldErrors;
  const errors: Record<string, string> = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    if (messages && messages.length > 0) {
      errors[key] = messages[0];
    }
  }

  return { success: false, errors };
}

/**
 * Validates route params with a Zod schema.
 * Throws a 400 response on failure (params are never user-correctable form errors).
 */
export function parseParams<T extends z.ZodType>(
  params: Record<string, string | undefined>,
  schema: T
): z.infer<T> {
  const result = schema.safeParse(params);

  if (result.success) {
    return result.data;
  }

  throw data("Invalid parameters", { status: 400 });
}

/**
 * Parses a JSON request body with a Zod schema.
 * Returns either the parsed data or a field-error map (first error per field).
 */
export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<ParseResult<z.infer<T>>> {
  const raw = await request.json();
  const result = schema.safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const fieldErrors = result.error.flatten().fieldErrors;
  const errors: Record<string, string> = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    if (messages && messages.length > 0) {
      errors[key] = messages[0];
    }
  }

  return { success: false, errors };
}

// Statuses a server action throws when a business rule refuses what the user
// asked (forbidden, gone, conflict...), as opposed to a broken request.
const REFUSAL_STATUSES = new Set([403, 404, 409, 410]);

/**
 * For a route's `clientAction`. The server action follows the coding
 * standard and throws `data(message, { status })` when a rule refuses the
 * submission; in the browser that refusal is shown next to the form, in the
 * same `{ errors }` shape as a field error, instead of replacing the page
 * with the error boundary. Anything else (redirects, 401, 5xx) still throws.
 */
export async function refusalAsFormError<T>(
  serverAction: () => Promise<T>
): Promise<T | { errors: { form: string } }> {
  try {
    return await serverAction();
  } catch (error) {
    if (
      isRouteErrorResponse(error) &&
      REFUSAL_STATUSES.has(error.status) &&
      typeof error.data === "string"
    ) {
      return { errors: { form: error.data } };
    }
    throw error;
  }
}
