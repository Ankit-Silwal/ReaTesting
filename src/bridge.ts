import { invoke } from "@tauri-apps/api/core";
import type { RequestSpec, ResponseData, Workspace } from "./types";
export const isDesktop = () => "__TAURI_INTERNALS__" in window;
export const startDemo = () =>
  isDesktop()
    ? invoke<string>("start_demo")
    : Promise.resolve("http://127.0.0.1:8787");
export const loadWorkspace = async () => {
  if (isDesktop()) return invoke<Workspace | null>("load_workspace");
  const saved = localStorage.getItem("relay-preview-workspace");
  return saved ? (JSON.parse(saved) as Workspace) : null;
};
export const saveWorkspace = async (data: Workspace) => {
  if (isDesktop()) return invoke<void>("save_workspace", { data });
  localStorage.setItem("relay-preview-workspace", JSON.stringify(data));
};
export const sendRequest = (request: RequestSpec) => {
  if (!isDesktop())
    return Promise.reject(
      new Error(
        "Open the Relay desktop app to send HTTP requests. Run npm.cmd run desktop.",
      ),
    );
  return invoke<ResponseData>("send_request", { request });
};
export const cancelRequest = (id: string) =>
  invoke<boolean>("cancel_request", { id });
