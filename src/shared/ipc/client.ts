import { invoke, Channel } from "@tauri-apps/api/core";
import type { Request, Response, StreamEvent } from "../../generated/protocol";
export async function rpc(request: Request): Promise<Response> {
  return invoke<Response>("dispatch", { request });
}
export async function call<T extends Response["type"]>(
  request: Request,
  type: T,
): Promise<Extract<Response, { type: T }>> {
  const response = await rpc(request);
  if (response.type !== type)
    throw new Error(`Unexpected native response: ${response.type}`);
  return response as Extract<Response, { type: T }>;
}
export async function subscribe(
  scope: string,
  handler: (event: StreamEvent) => void,
) {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = handler;
  await invoke("subscribe", { scope, channel });
  return () => {
    channel.onmessage = () => {};
  };
}
export { errorText, errorDetails } from "../errors";
