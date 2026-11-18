import { client } from "@agentclientprotocol/sdk";

/**
 * Smoke-test ACP client on SDK 2.x (SA-65 Step B).
 *
 * SDK 2.x removed `ClientSideConnection`; this keeps its call shape so the
 * smoke scenarios stay readable: `connectClient(() => handlers, stream)` takes
 * the same handler object (`sessionUpdate` / `requestPermission` /
 * `readTextFile` / `writeTextFile`) and returns `initialize` / `newSession` /
 * `loadSession` / `prompt` / `setSessionMode` / `setSessionConfigOption` /
 * `cancel` / `extMethod`, all routed through the SDK's `client()` app.
 * As with any 2.x agent, `initialize` must be the first request.
 */
export function connectClient(toClient, stream) {
  const handlers = toClient();
  const app = client({ name: "sangxia-smoke" });
  if (handlers.sessionUpdate) app.onNotification("session/update", ({ params }) => handlers.sessionUpdate(params));
  if (handlers.requestPermission) app.onRequest("session/request_permission", ({ params }) => handlers.requestPermission(params));
  if (handlers.readTextFile) app.onRequest("fs/read_text_file", ({ params }) => handlers.readTextFile(params));
  if (handlers.writeTextFile) app.onRequest("fs/write_text_file", ({ params }) => handlers.writeTextFile(params));
  const connection = app.connect(stream);
  const agent = connection.agent;
  return {
    connection,
    initialize: (params) => agent.request("initialize", params),
    newSession: (params) => agent.request("session/new", params),
    loadSession: (params) => agent.request("session/load", params),
    prompt: (params) => agent.request("session/prompt", params),
    setSessionMode: (params) => agent.request("session/set_mode", params),
    setSessionConfigOption: (params) => agent.request("session/set_config_option", params),
    cancel: (params) => agent.notify("session/cancel", params),
    extMethod: (method, params) => agent.request(method, params),
  };
}
