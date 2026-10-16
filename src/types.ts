export type Method =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type Pair = { id: string; key: string; value: string; enabled: boolean };
export type Auth = {
  kind: "none" | "bearer" | "basic";
  token: string;
  username: string;
  password: string;
};
export type Request = {
  id: string;
  name: string;
  method: Method;
  url: string;
  headers: Pair[];
  params: Pair[];
  bodyMode: "none" | "json" | "text";
  body: string;
  auth: Auth;
  collectionId?: string;
};
export type Collection = { id: string; name: string; requests: Request[] };
export type Environment = { id: string; name: string; variables: Pair[] };
export type HistoryItem = {
  id: string;
  request: Request;
  timestamp: number;
  status: number | null;
  timeMs: number;
};
export type Settings = {
  timeoutMs: number;
  followRedirects: boolean;
  verifyTls: boolean;
  theme: "dark" | "light";
};
export type Workspace = {
  schemaVersion: 1;
  tabs: Request[];
  activeId: string;
  collections: Collection[];
  history: HistoryItem[];
  environments: Environment[];
  activeEnvironmentId: string;
  settings: Settings;
};
export type ResponseData = {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  body: string;
  size: number;
  timeMs: number;
  truncated: boolean;
  binary: boolean;
};
export type RequestSpec = Request & Settings;
export type RunState = {
  loading: boolean;
  response?: ResponseData;
  error?: string;
};
