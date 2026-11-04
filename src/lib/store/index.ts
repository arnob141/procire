import { memoryStore } from "./memory";
import { supabaseStore } from "./supabase";
import type { Store } from "./types";

let cached: Store | null = null;

/** Supabase when both keys are set, otherwise an in-memory store for trying the app. */
export function getStore(): Store {
  if (cached) return cached;
  cached = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? supabaseStore() : memoryStore;
  return cached;
}
