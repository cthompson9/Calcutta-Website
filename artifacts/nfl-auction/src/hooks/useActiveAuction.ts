import { useQuery } from "@tanstack/react-query";
import type { AuctionSnapshot } from "@workspace/api-client-react";

export function useActiveAuction(calcuttaId: number | undefined) {
  return useQuery({
    queryKey: ["active-auction", calcuttaId],
    queryFn: async ({ signal }) => {
      if (!calcuttaId) return null;
      try {
        const res = await fetch(`/api/calcuttas/${calcuttaId}/auctions`, { signal });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("Failed to fetch active auction");
        const data = await res.json();
        return data as AuctionSnapshot;
      } catch (err) {
        throw err;
      }
    },
    enabled: !!calcuttaId,
    refetchInterval: 3000,
  });
}
