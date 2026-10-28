export type ErrorDetails = { code?: string; operationId?: string };
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
  )
    return error.message;
  if (typeof error === "string" && error) return error;
  return "The operation could not be completed. Try again.";
}
export function errorDetails(error: unknown): ErrorDetails | null {
  if (typeof error !== "object" || error === null) return null;
  const code =
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9]{0,63}$/i.test(error.code)
      ? error.code
      : undefined;
  const operationId =
    "operationId" in error &&
    typeof error.operationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      error.operationId,
    )
      ? error.operationId
      : undefined;
  return code || operationId ? { code, operationId } : null;
}
