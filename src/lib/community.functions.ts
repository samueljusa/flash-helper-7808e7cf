import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type CommunityItem = {
  id: string;
  prompt: string;
  media_type: string;
  media_url: string | null;
  aspect_ratio: string | null;
  created_at: string;
};

export type ModerationItem = CommunityItem & {
  moderation_status: string;
  approved: boolean;
  rejection_reason: string | null;
};

function publicClient() {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
          h.delete("Authorization");
        }
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/** Galerie communautaire publique : uniquement les créations approuvées (avec consentement). */
export const listCommunityGallery = createServerFn({ method: "GET" }).handler(async () => {
  const { data } = await publicClient()
    .from("generations")
    .select("id, prompt, media_type, media_url, aspect_ratio, created_at")
    .eq("submitted_public", true)
    .eq("approved", true)
    .eq("moderation_status", "approved")
    .order("created_at", { ascending: false })
    .limit(60);
  return (data ?? []) as CommunityItem[];
});

/** Indique si l'utilisateur connecté est administrateur / modérateur. */
export const getModerationAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const roles = (data ?? []).map((r) => r.role as string);
    return { isAdmin: roles.includes("admin"), isModerator: roles.includes("moderator") };
  });

/** L'utilisateur soumet sa création à la galerie (consentement explicite). */
export const submitToGallery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; consent: boolean }) => {
    if (!input?.id) throw new Error("Création introuvable");
    if (!input.consent) throw new Error("Consentement requis");
    return { id: String(input.id) };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("generations")
      .update({ submitted_public: true, moderation_status: "pending", approved: false })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** File de modération : toutes les créations soumises à la galerie. */
export const listModerationQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const allowed = (roles ?? []).some((r) => r.role === "admin" || r.role === "moderator");
    if (!allowed) throw new Error("Accès refusé");

    const { data } = await context.supabase
      .from("generations")
      .select(
        "id, prompt, media_type, media_url, aspect_ratio, created_at, moderation_status, approved, rejection_reason",
      )
      .eq("submitted_public", true)
      .order("created_at", { ascending: false })
      .limit(100);
    return (data ?? []) as ModerationItem[];
  });

/** Valide ou rejette une création soumise à la galerie. */
export const moderateGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; action: "approve" | "reject"; reason?: string }) => {
    if (!input?.id) throw new Error("Création introuvable");
    return {
      id: String(input.id),
      action: input.action === "approve" ? ("approve" as const) : ("reject" as const),
      reason: input.reason ? String(input.reason).slice(0, 500) : null,
    };
  })
  .handler(async ({ data, context }) => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const allowed = (roles ?? []).some((r) => r.role === "admin" || r.role === "moderator");
    if (!allowed) throw new Error("Accès refusé");

    const approve = data.action === "approve";
    const { error } = await context.supabase
      .from("generations")
      .update({
        approved: approve,
        moderation_status: approve ? "approved" : "rejected",
        rejection_reason: approve ? null : (data.reason ?? "Contenu inapproprié"),
        moderated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
