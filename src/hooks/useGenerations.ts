import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getQuotaStatus, listGenerations } from "@/lib/generation.functions";
import type { Tier } from "@/lib/quota";

export type Generation = {
  id: string;
  prompt: string;
  media_type: string;
  resolution: string | null;
  duration: string | null;
  aspect_ratio: string | null;
  media_url: string | null;
  status: string;
  duration_seconds: number;
  error_message: string | null;
  created_at: string;
};

export type Quota = { tier: Tier; limit: number; used: number; remaining: number };

export function useGenerations(enabled: boolean) {
  const fetchQuota = useServerFn(getQuotaStatus);
  const fetchList = useServerFn(listGenerations);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [items, setItems] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [q, l] = await Promise.all([fetchQuota({}), fetchList({})]);
      setQuota(q as Quota);
      setItems(l as Generation[]);
    } finally {
      setLoading(false);
    }
  }, [enabled, fetchQuota, fetchList]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { quota, items, loading, refresh };
}
