"use server";

import { revalidatePath } from "next/cache";
import { getStore } from "./lib/store";

export async function ackAlertAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (id.length < 3 || id.length > 120) return;
  const store = getStore();
  if (!store.getAlert(id)) return;
  store.ackAlert(id, Date.now() * 1000);
  revalidatePath("/alerts");
}

export async function resolveTriageAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (id.length < 3 || id.length > 120) return;
  getStore().resolveTriage(id, Date.now() * 1000);
  revalidatePath("/evals");
}
