import {
  type AgentApp,
  type AgentConnection,
  type AgentContext,
  type AgentRequestHandlersByMethod,
  type AgentRequestMethod,
  type Stream,
  agent as agentApp,
  methods,
} from "@agentclientprotocol/sdk";
import { type SangxiaAgent, setModelParams } from "../agent.js";
import type { ClientChannel } from "./client-channel.js";
import { withHandlerErrorLogging } from "./handler-logging.js";

/**
 * Stable ACP requests we deliberately leave unregistered, so the SDK answers
 * them with -32601. They are app-level features scheduled separately (SA-65
 * "范围外"), not part of the SDK upgrade.
 */
type UnsupportedRequest = "logout" | "session/list" | "session/delete" | "session/resume" | "session/close";

/**
 * Every other stable request must have a handler. Typing the map against the
 * SDK's own method list means a method added by a future SDK release fails to
 * compile here until it is classified, instead of silently becoming -32601.
 */
type SupportedRequest = Exclude<AgentRequestMethod, UnsupportedRequest>;
type RequestHandlers = { [M in SupportedRequest]: AgentRequestHandlersByMethod[M] };

/** Legacy model-switch request; SDK 2.x dropped it from the stable schema but AIR still sends it. */
const SET_MODEL_METHOD = "session/set_model";

function requestHandlers(agent: SangxiaAgent): RequestHandlers {
  return {
    [methods.agent.initialize]: ({ params }) => agent.initialize(params),
    [methods.agent.authenticate]: ({ params }) => agent.authenticate(params),
    [methods.agent.session.new]: ({ params }) => agent.newSession(params),
    [methods.agent.session.load]: ({ params }) => agent.loadSession(params),
    [methods.agent.session.setMode]: ({ params }) => agent.setSessionMode(params),
    [methods.agent.session.setConfigOption]: ({ params }) => agent.setSessionConfigOption(params),
    // `ctx.signal` aborts on `$/cancel_request` and when the connection drops;
    // the agent folds it into the turn's own abort controller.
    [methods.agent.session.prompt]: ({ params, signal }) => agent.prompt(params, signal),
  };
}

type AnyHandler = (ctx: { method: string; params: unknown }) => unknown;

function register<M extends SupportedRequest>(app: AgentApp, method: M, handler: AgentRequestHandlersByMethod[M]): void {
  // Wrapping erases the per-method context type; the wrapper passes ctx through unchanged.
  app.onRequest<M>(method, withHandlerErrorLogging(handler as AnyHandler) as AgentRequestHandlersByMethod[M]);
}

/**
 * Route ACP wire methods onto a {@link SangxiaAgent} (SA-65 Step B).
 *
 * `SangxiaAgent` stays a transport-free business class; this thin layer is the
 * only place that knows SDK 2.x's `agent().onRequest(...)` API. Params of the
 * stable methods are zod-validated by the SDK before they get here; the legacy
 * and extension methods receive raw params and narrow them themselves.
 */
export function createAgentApp(agent: SangxiaAgent): AgentApp {
  const app = agentApp({ name: "sangxia" });
  const handlers = requestHandlers(agent);
  for (const method of Object.keys(handlers) as SupportedRequest[]) register(app, method, handlers[method]);

  // A notification: forgetting it would produce no -32601 to notice, so it is
  // registered explicitly next to the request map.
  app.onNotification(methods.agent.session.cancel, withHandlerErrorLogging(({ params }) => agent.cancel(params)));

  // Registered explicitly (not left to the fallback) so it keeps -32602 for
  // bad params / unknown models instead of degrading to -32601 or -32603.
  app.onRequest(
    SET_MODEL_METHOD,
    (params: unknown) => params,
    withHandlerErrorLogging(async ({ params }) => {
      await agent.setSessionModel(setModelParams(params));
      return {};
    }),
  );

  // Extension methods (`_sangxia.set_model`, …) and anything unknown: the
  // agent answers -32601 with the wire name itself.
  app.onRequest("*", withHandlerErrorLogging(({ method, params }) => agent.extMethod(method, params)));
  return app;
}

/** Adapt the SDK's per-connection client context to the harness's narrow channel. */
function clientChannel(client: () => AgentContext): ClientChannel {
  return {
    sessionUpdate: (params) => client().notify(methods.client.session.update, params),
    requestPermission: (params) => client().request(methods.client.session.requestPermission, params),
    readTextFile: (params) => client().request(methods.client.fs.readTextFile, params),
    writeTextFile: (params) => client().request(methods.client.fs.writeTextFile, params),
    createTerminal: (params) => client().createTerminal(params),
  };
}

/**
 * Serve a new {@link SangxiaAgent} over an ACP stream (stdio in index.ts, an
 * in-memory NDJSON pair in the TUI bridge and unit tests).
 *
 * The agent is built first against a channel that resolves the connection's
 * client context lazily; `onConnect` fills it in before the first inbound
 * message is handled, so no handler can observe it unset.
 */
export function serveAgent(
  stream: Stream,
  create: (client: ClientChannel) => SangxiaAgent,
): { agent: SangxiaAgent; connection: AgentConnection } {
  let client: AgentContext | null = null;
  const agent = create(clientChannel(() => {
    if (!client) throw new Error("ACP 连接尚未建立");
    return client;
  }));
  const app = createAgentApp(agent).onConnect((connection) => {
    client = connection.client;
  });
  return { agent, connection: app.connect(stream) };
}
