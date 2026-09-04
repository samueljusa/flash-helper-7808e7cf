/**
 * Logique serveur de génération de médias (Grok Imagine / OpenRouter / passerelle Lovable).
 * Règle de crédits : le quota est réservé de façon atomique puis remboursé
 * intégralement si l'API échoue ou si le média n'est pas affichable.
 */

import type { Tier } from "@/lib/quota";

export type GenerationInput = {
  prompt: string;
  mediaType: "image" | "video";
  resolution: string;
  duration: string;
  aspectRatio: string;
};

export type GenerationRow = {
  id: string;
  prompt: string;
  media_type: string;
  resolution: string | null;
  duration: string | null;
  aspect_ratio: string | null;
  media_url: string | null;
  storage_path?: string | null;
  status: string;
  duration_seconds: number;
  error_message: string | null;
  created_at: string;
};

export type GenerationResult =
  | { ok: true; id: string | null; status: "ready"; mediaUrl: string; seconds: number }
  | { ok: false; reason: "quota"; used: number; limit: number; tier: Tier }
  | { ok: false; reason: "error"; message: string; id: string | null };

const SIGNED_URL_TTL = 60 * 60 * 6;

function extensionFor(contentType: string): string {
  if (contentType.includes("video")) return contentType.includes("webm") ? "webm" : "mp4";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

/** Régénère des URL signées fraîches à partir des chemins de stockage. */
export async function withFreshUrls<T extends GenerationRow>(rows: T[]): Promise<T[]> {
  const paths = rows.map((r) => r.storage_path).filter((p): p is string => Boolean(p));
  if (paths.length === 0) return rows;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const signed = new Map<string, string>();

  await Promise.all(
    paths.map(async (path) => {
      const { data } = await supabaseAdmin.storage
        .from("generations")
        .createSignedUrl(path, SIGNED_URL_TTL);
      if (data?.signedUrl) signed.set(path, data.signedUrl);
    }),
  );

  return rows.map((row) =>
    row.storage_path && signed.has(row.storage_path)
      ? { ...row, media_url: signed.get(row.storage_path)! }
      : row,
  );
}

type MediaOutcome =
  | { ok: true; bytes: Uint8Array | null; contentType: string; mediaUrl: string | null }
  | { ok: false; error: string };

/** Taille exacte acceptée par gpt-image-2 pour le format demandé. */
function openaiSizeFor(ratio: string): "1024x1024" | "1024x1536" | "1536x1024" {
  const [w, h] = ratio.split(":").map((n) => Number.parseFloat(n));
  if (!w || !h || w === h) return "1024x1024";
  return w > h ? "1536x1024" : "1024x1536";
}

/** Chaîne de fournisseurs pour les images : Grok Imagine → OpenRouter → passerelle Lovable. */
async function generateImage(input: GenerationInput): Promise<MediaOutcome> {
  const errors: string[] = [];

  const { isXaiConfigured, generateImageWithXai } = await import("@/lib/services/xai.server");
  if (isXaiConfigured()) {
    const result = await generateImageWithXai(input);
    if (result.ok) {
      return { ok: true, bytes: result.bytes, contentType: result.contentType, mediaUrl: result.bytes ? null : result.mediaUrl };
    }
    errors.push(`Grok Imagine : ${result.error}`);
  }

  const { isOpenRouterConfigured, generateImageWithOpenRouter } = await import(
    "@/lib/services/openrouter.server"
  );
  if (isOpenRouterConfigured()) {
    const result = await generateImageWithOpenRouter(input);
    if (result.ok) {
      return { ok: true, bytes: result.bytes, contentType: result.contentType, mediaUrl: result.bytes ? null : result.mediaUrl };
    }
    errors.push(`OpenRouter : ${result.error}`);
  }

  const apiKey = process.env["LOVABLE_API_KEY"];
  if (apiKey) {
    // gpt-image-2 accepte une taille exacte : le format choisi est donc respecté.
    const res = await fetch("https://ai.gateway.lovable.dev/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: `${input.prompt}. Cadrage ${input.aspectRatio}, qualité ${input.resolution}.`,
        size: openaiSizeFor(input.aspectRatio),
        n: 1,
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: { b64_json?: string }[] };
      const base64 = json.data?.[0]?.b64_json;
      if (base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return { ok: true, bytes, contentType: "image/png", mediaUrl: null };
      }
      errors.push("Passerelle Lovable : aucune image renvoyée");
    } else {
      errors.push(`Passerelle Lovable : refus (${res.status})`);
    }
  }

  return {
    ok: false,
    error: errors.length > 0 ? errors.join(" · ") : "Aucune passerelle image configurée",
  };
}

/** Vidéo : Grok Imagine (xAI) puis OpenRouter si un modèle vidéo y est configuré. */
async function generateVideo(input: GenerationInput): Promise<MediaOutcome> {
  const errors: string[] = [];

  const { isXaiConfigured, generateVideoWithXai } = await import("@/lib/services/xai.server");
  if (isXaiConfigured()) {
    const result = await generateVideoWithXai(input);
    if (result.ok) {
      return { ok: true, bytes: result.bytes, contentType: result.contentType, mediaUrl: result.bytes ? null : result.mediaUrl };
    }
    errors.push(`Grok Imagine : ${result.error}`);
  }

  const { isOpenRouterVideoConfigured, generateVideoWithOpenRouter } = await import(
    "@/lib/services/openrouter.server"
  );
  if (isOpenRouterVideoConfigured()) {
    const result = await generateVideoWithOpenRouter(input);
    if (result.ok) {
      return { ok: true, bytes: result.bytes, contentType: result.contentType, mediaUrl: result.bytes ? null : result.mediaUrl };
    }
    errors.push(`OpenRouter : ${result.error}`);
  }

  if (errors.length === 0) {
    return {
      ok: false,
      error:
        "La génération vidéo Grok Imagine n'est pas encore activée (clé xAI manquante) — aucun crédit n'a été débité.",
    };
  }
  return { ok: false, error: errors.join(" · ") };
}

export function secondsFor(input: GenerationInput): number {
  return input.mediaType === "video" ? Number.parseInt(input.duration, 10) || 6 : 2;
}

/** Exécute une génération complète pour un utilisateur donné. */
export async function runGeneration(
  userId: string,
  input: GenerationInput,
): Promise<GenerationResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const seconds = secondsFor(input);

  const { data: reserved, error: reserveError } = await supabaseAdmin.rpc("reserve_quota", {
    _user_id: userId,
    _seconds: seconds,
  });
  if (reserveError) throw new Error(reserveError.message);

  const row = Array.isArray(reserved) ? reserved[0] : reserved;
  if (!row?.allowed) {
    return {
      ok: false,
      reason: "quota",
      used: row?.seconds_used ?? 0,
      limit: row?.seconds_limit ?? 0,
      tier: (row?.tier ?? "free") as Tier,
    };
  }

  let debited = true;
  const refund = async () => {
    if (!debited) return;
    debited = false;
    await supabaseAdmin.rpc("refund_quota", { _user_id: userId, _seconds: seconds });
  };

  const persist = async (fields: {
    mediaUrl: string | null;
    storagePath: string | null;
    status: string;
    errorMessage: string | null;
  }) => {
    const { data: inserted } = await supabaseAdmin
      .from("generations")
      .insert({
        user_id: userId,
        prompt: input.prompt,
        media_type: input.mediaType,
        resolution: input.resolution,
        duration: input.duration,
        aspect_ratio: input.aspectRatio,
        media_url: fields.mediaUrl,
        storage_path: fields.storagePath,
        duration_seconds: fields.status === "ready" ? seconds : 0,
        status: fields.status,
        error_message: fields.errorMessage,
      })
      .select("id")
      .single();
    return inserted?.id ?? null;
  };

  try {
    const outcome =
      input.mediaType === "image" ? await generateImage(input) : await generateVideo(input);
    if (!outcome.ok) throw new Error(outcome.error);

    let mediaUrl = outcome.mediaUrl;
    let storagePath: string | null = null;

    if (outcome.bytes) {
      const path = `${userId}/${crypto.randomUUID()}.${extensionFor(outcome.contentType)}`;
      const { error: upErr } = await supabaseAdmin.storage
        .from("generations")
        .upload(path, outcome.bytes, { contentType: outcome.contentType });
      if (upErr) throw new Error(upErr.message);

      const { data: signed } = await supabaseAdmin.storage
        .from("generations")
        .createSignedUrl(path, SIGNED_URL_TTL);
      storagePath = path;
      mediaUrl = signed?.signedUrl ?? null;
    }

    if (!mediaUrl) throw new Error("Média indisponible : aucun crédit n'a été débité");

    const id = await persist({ mediaUrl, storagePath, status: "ready", errorMessage: null });
    return { ok: true, id, status: "ready", mediaUrl, seconds };
  } catch (error) {
    await refund();
    const message = error instanceof Error ? error.message : "Génération impossible";
    const id = await persist({
      mediaUrl: null,
      storagePath: null,
      status: "error",
      errorMessage: message,
    });
    return { ok: false, reason: "error", message, id };
  }
}
