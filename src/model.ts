import type {
  Auth,
  Collection,
  Environment,
  Method,
  Pair,
  Request,
  Settings,
  Workspace,
} from "./types";

export const methods: Method[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
export const uid = () => crypto.randomUUID();
export const pair = (key = "", value = "", enabled = true): Pair => ({
  id: uid(),
  key,
  value,
  enabled,
});
export const blankAuth = (): Auth => ({
  kind: "none",
  token: "",
  username: "",
  password: "",
});
export const newRequest = (overrides: Partial<Request> = {}): Request => ({
  id: uid(),
  name: "Untitled request",
  method: "GET",
  url: "",
  headers: [],
  params: [],
  bodyMode: "none",
  body: "",
  auth: blankAuth(),
  ...overrides,
});
export const cloneRequest = (request: Request): Request => ({
  ...structuredClone(request),
  id: uid(),
});
export const defaults: Settings = {
  timeoutMs: 30000,
  followRedirects: true,
  verifyTls: true,
  theme: "dark",
};

export function initialWorkspace(baseUrl: string): Workspace {
  const collectionId = "playground";
  const users = newRequest({
    name: "List users",
    url: "{{base_url}}/users",
    params: [pair("page", "1"), pair("limit", "10")],
    collectionId,
  });
  const create = newRequest({
    name: "Create a user",
    method: "POST",
    url: "{{base_url}}/echo",
    bodyMode: "json",
    body: '{\n  "name": "Alex Morgan",\n  "email": "alex@example.com",\n  "role": "developer"\n}',
    collectionId,
  });
  const health = newRequest({
    name: "Health check",
    url: "{{base_url}}/health",
    collectionId,
  });
  return {
    schemaVersion: 1,
    tabs: [structuredClone(users)],
    activeId: users.id,
    collections: [
      {
        id: collectionId,
        name: "Getting started",
        requests: [users, create, health],
      },
    ],
    history: [],
    environments: [
      {
        id: "local",
        name: "Local playground",
        variables: [pair("base_url", baseUrl)],
      },
    ],
    activeEnvironmentId: "local",
    settings: { ...defaults },
  };
}

export function interpolate(value: string, environment?: Environment): string {
  const vars = new Map(
    environment?.variables
      .filter((p) => p.enabled && p.key.trim())
      .map((p) => [p.key.trim(), p.value]) ?? [],
  );
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name: string) => {
    const result = vars.get(name.trim());
    if (result === undefined)
      throw new Error(
        `Variable “${name}” is not defined in the selected environment.`,
      );
    return result;
  });
}

export function resolveRequest(
  request: Request,
  environment?: Environment,
): Request {
  const sub = (value: string) => interpolate(value, environment);
  const pairs = (items: Pair[]) =>
    items.map((p) =>
      p.enabled ? { ...p, key: sub(p.key), value: sub(p.value) } : p,
    );
  const auth = { ...request.auth };
  if (auth.kind === "bearer") auth.token = sub(auth.token);
  if (auth.kind === "basic") {
    auth.username = sub(auth.username);
    auth.password = sub(auth.password);
  }
  const url = sub(request.url).trim();
  if (!/^https?:\/\//i.test(url))
    throw new Error("Enter an absolute URL starting with http:// or https://.");
  new URL(url);
  const body = request.bodyMode === "none" ? request.body : sub(request.body);
  if (request.bodyMode === "json") {
    try {
      JSON.parse(body);
    } catch {
      throw new Error("The request body is not valid JSON.");
    }
  }
  return {
    ...request,
    url,
    headers: pairs(request.headers),
    params: pairs(request.params),
    body,
    auth,
  };
}

export function formatSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(2)} KB`
      : `${(bytes / 1048576).toFixed(2)} MB`;
}
export function displayUrl(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\{\{base_url\}\}/, "playground");
}
export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function toCurl(request: Request, environment?: Environment): string {
  const r = resolveRequest(request, environment);
  const url = new URL(r.url);
  r.params
    .filter((p) => p.enabled && p.key)
    .forEach((p) => url.searchParams.append(p.key, p.value));
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const parts = ["curl", "-X", r.method, quote(url.toString())];
  r.headers
    .filter((p) => p.enabled && p.key)
    .forEach((p) => parts.push("-H", quote(`${p.key}: ${p.value}`)));
  if (r.bodyMode === "json")
    parts.push("-H", quote("Content-Type: application/json"));
  if (r.auth.kind === "bearer")
    parts.push("-H", quote(`Authorization: Bearer ${r.auth.token}`));
  if (r.auth.kind === "basic")
    parts.push("-u", quote(`${r.auth.username}:${r.auth.password}`));
  if (r.bodyMode !== "none") parts.push("--data-raw", quote(r.body));
  return parts.join(" ");
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function postmanPairs(value: unknown): Pair[] {
  return Array.isArray(value)
    ? value.map((p) => {
        const v = record(p);
        return pair(string(v.key), string(v.value), !v.disabled);
      })
    : [];
}

export function importCollections(input: unknown): Collection[] {
  const root = record(input);
  if (!Array.isArray(root.item))
    throw new Error("Choose a Postman Collection v2 or v2.1 JSON file.");
  const info = record(root.info);
  const inheritedAuth = root.auth;
  const collections: Collection[] = [];
  let total = 0;
  function visit(items: unknown[], name: string, parentAuth: unknown) {
    const collection: Collection = { id: uid(), name, requests: [] };
    const nested: { items: unknown[]; name: string; auth: unknown }[] = [];
    for (const raw of items) {
      const item = record(raw);
      if (Array.isArray(item.item)) {
        nested.push({
          items: item.item,
          name: `${name} / ${string(item.name, "Folder")}`,
          auth: item.auth ?? parentAuth,
        });
        continue;
      }
      if (!item.request) continue;
      if (++total > 1000)
        throw new Error("Import is limited to 1000 requests per file.");
      const data =
        typeof item.request === "string"
          ? { url: item.request }
          : record(item.request);
      const urlObject = record(data.url);
      let url = typeof data.url === "string" ? data.url : string(urlObject.raw);
      const params = postmanPairs(urlObject.query);
      // Postman stores the same query both in raw URL and query rows. Keep one copy.
      if (params.length && url.includes("?"))
        url =
          url.slice(0, url.indexOf("?")) +
          (url.includes("#") ? url.slice(url.indexOf("#")) : "");
      const body = record(data.body);
      if (body.mode && body.mode !== "raw")
        throw new Error(
          `“${string(item.name, "Request")}” uses ${string(body.mode)}. This release imports raw JSON/text bodies only.`,
        );
      const auth = blankAuth();
      const authData = record(data.auth ?? parentAuth);
      if (authData.type === "bearer" || authData.type === "basic") {
        auth.kind = authData.type;
        for (const entry of postmanPairs(authData[auth.kind])) {
          if (entry.key === "token") auth.token = entry.value;
          if (entry.key === "username") auth.username = entry.value;
          if (entry.key === "password") auth.password = entry.value;
        }
      } else if (authData.type && authData.type !== "noauth") {
        throw new Error(
          `Unsupported imported authentication: ${String(authData.type)}. Use bearer, basic, or no auth.`,
        );
      }
      const method = string(data.method, "GET").toUpperCase();
      if (!methods.includes(method as Method))
        throw new Error(`Unsupported imported method: ${method}`);
      const headers = postmanPairs(data.header);
      const isJson =
        record(record(body.options).raw).language === "json" ||
        headers.some(
          (p) =>
            p.key.toLowerCase() === "content-type" && p.value.includes("json"),
        );
      collection.requests.push(
        newRequest({
          name: string(item.name, "Imported request"),
          method: method as Method,
          url,
          params,
          headers,
          auth,
          body: string(body.raw),
          bodyMode: body.mode === "raw" ? (isJson ? "json" : "text") : "none",
          collectionId: collection.id,
        }),
      );
    }
    collections.push(collection);
    nested.forEach((n) => visit(n.items, n.name, n.auth));
  }
  visit(root.item, string(info.name, "Imported collection"), inheritedAuth);
  if (!total) throw new Error("This collection contains no HTTP requests.");
  return collections;
}

function exportedUrl(request: Request) {
  const hashIndex = request.url.indexOf("#");
  const fragment = hashIndex < 0 ? "" : request.url.slice(hashIndex);
  const raw = hashIndex < 0 ? request.url : request.url.slice(0, hashIndex);
  const queryIndex = raw.indexOf("?");
  const base = queryIndex < 0 ? raw : raw.slice(0, queryIndex);
  const existing =
    queryIndex < 0
      ? []
      : [...new URLSearchParams(raw.slice(queryIndex + 1))].map(
          ([key, value]) => ({ key, value, enabled: true }),
        );
  const all = [...existing, ...request.params];
  const params = new URLSearchParams();
  all
    .filter((p) => p.enabled && p.key)
    .forEach((p) => params.append(p.key, p.value));
  return {
    raw: `${base}${params.size ? `?${params}` : ""}${fragment}`,
    query: all.map((p) => ({
      key: p.key,
      value: p.value,
      disabled: !p.enabled,
    })),
  };
}

export function exportCollection(collection: Collection) {
  return {
    info: {
      name: collection.name,
      _postman_id: uid(),
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: collection.requests.map((r) => ({
      name: r.name,
      request: {
        method: r.method,
        header: r.headers.map((p) => ({
          key: p.key,
          value: p.value,
          disabled: !p.enabled,
        })),
        url: exportedUrl(r),
        auth:
          r.auth.kind === "bearer"
            ? {
                type: "bearer",
                bearer: [{ key: "token", value: r.auth.token, type: "string" }],
              }
            : r.auth.kind === "basic"
              ? {
                  type: "basic",
                  basic: [
                    { key: "username", value: r.auth.username },
                    { key: "password", value: r.auth.password },
                  ],
                }
              : { type: "noauth" },
        ...(r.bodyMode !== "none"
          ? {
              body: {
                mode: "raw",
                raw: r.body,
                options: {
                  raw: { language: r.bodyMode === "json" ? "json" : "text" },
                },
              },
            }
          : {}),
      },
    })),
  };
}

export function validateWorkspace(input: unknown): Workspace {
  const root = record(input);
  if (
    root.schemaVersion !== 1 ||
    !Array.isArray(root.tabs) ||
    !root.tabs.length ||
    !Array.isArray(root.collections) ||
    !Array.isArray(root.history) ||
    !Array.isArray(root.environments)
  )
    throw new Error(
      "Workspace format is invalid. The saved file has been preserved.",
    );
  const ws = input as Workspace;
  const validPairs = (value: unknown): value is Pair[] =>
    Array.isArray(value) &&
    value.every((p) => {
      const row = record(p);
      return (
        typeof row.id === "string" &&
        typeof row.key === "string" &&
        typeof row.value === "string" &&
        typeof row.enabled === "boolean"
      );
    });
  if (
    ws.collections.some(
      (c) =>
        !c ||
        typeof c.id !== "string" ||
        typeof c.name !== "string" ||
        !Array.isArray(c.requests),
    ) ||
    ws.environments.some(
      (e) =>
        !e ||
        typeof e.id !== "string" ||
        typeof e.name !== "string" ||
        !validPairs(e.variables),
    ) ||
    ws.history.some(
      (h) =>
        !h ||
        typeof h.id !== "string" ||
        typeof h.timestamp !== "number" ||
        !h.request,
    )
  ) {
    throw new Error(
      "Saved workspace entries are invalid. The saved file has been preserved.",
    );
  }
  const requests = [
    ...ws.tabs,
    ...ws.collections.flatMap((c) =>
      Array.isArray(c.requests) ? c.requests : [],
    ),
    ...ws.history.map((h) => h.request),
  ];
  for (const r of requests) {
    if (
      !r ||
      typeof r.id !== "string" ||
      typeof r.url !== "string" ||
      typeof r.name !== "string" ||
      typeof r.body !== "string" ||
      !["none", "json", "text"].includes(r.bodyMode) ||
      !methods.includes(r.method) ||
      !validPairs(r.headers) ||
      !validPairs(r.params) ||
      !r.auth ||
      typeof r.auth.token !== "string" ||
      typeof r.auth.username !== "string" ||
      typeof r.auth.password !== "string" ||
      !["none", "bearer", "basic"].includes(r.auth.kind)
    )
      throw new Error(
        "A saved request is invalid. The saved file has been preserved.",
      );
  }
  if (!ws.tabs.some((t) => t.id === ws.activeId)) ws.activeId = ws.tabs[0].id;
  ws.settings = { ...defaults, ...record(ws.settings) } as Settings;
  return ws;
}
