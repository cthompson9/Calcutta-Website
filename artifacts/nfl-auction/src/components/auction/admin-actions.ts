import type { AuctionSnapshot } from "@workspace/api-client-react";

async function adminFetch(url: string, method: string, adminKey: string, body?: any) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  
  if (!res.ok) {
    let err = "Action failed";
    try {
      const data = await res.json();
      err = data.error || err;
    } catch {}
    throw new Error(err);
  }
  
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

export async function createAuction(calcuttaId: number, adminKey: string): Promise<AuctionSnapshot> {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions`, "POST", adminKey);
}

export async function startAuctionSession(calcuttaId: number, auctionId: number, expectedRevision: number, adminKey: string): Promise<AuctionSnapshot> {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/start`, "POST", adminKey, { expectedRevision });
}

export async function resetAuctionRun(calcuttaId: number, auctionId: number, expectedRevision: number, confirmation: string, adminKey: string): Promise<AuctionSnapshot> {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/reset`, "POST", adminKey, { expectedRevision, confirmation });
}

export async function nominateNext(calcuttaId: number, auctionId: number, expectedRevision: number, adminKey: string): Promise<AuctionSnapshot> {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/nominate-next`, "POST", adminKey, {
    expectedRevision,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function recordSale(calcuttaId: number, auctionId: number, lotId: number, price: number, allocations: { consortiumId: number, share: number }[], expectedRevision: number, adminKey: string): Promise<AuctionSnapshot> {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/lots/${lotId}/sale`, "POST", adminKey, {
    price,
    allocations,
    expectedRevision,
  });
}

export async function completeAuctionSession(calcuttaId: number, auctionId: number, adminKey: string, expectedRevision: number): Promise<AuctionSnapshot> {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/complete`, "POST", adminKey, { expectedRevision });
}

export type ConsortiumOwnerInput = { bidderId: number; share: number } | { newBidderName: string; share: number };

export async function addConsortium(calcuttaId: number, auctionId: number, displayName: string, owners: ConsortiumOwnerInput[], adminKey: string, expectedRevision: number) {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/consortia`, "POST", adminKey, {
    displayName,
    owners,
    expectedRevision,
  });
}


export async function editConsortium(calcuttaId: number, auctionId: number, consortiumId: number, data: { displayName?: string; aliases?: string[]; owners?: ConsortiumOwnerInput[]; active?: boolean }, adminKey: string, expectedRevision: number) {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/consortia/${consortiumId}`, "PATCH", adminKey, {
    ...data,
    expectedRevision,
  });
}

export async function correctConsortium(calcuttaId: number, auctionId: number, consortiumId: number, displayName: string, owners: ConsortiumOwnerInput[], reason: string, adminKey: string, expectedRevision: number): Promise<AuctionSnapshot> {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/consortia/${consortiumId}/correction`, "POST", adminKey, {
    displayName, owners, reason, expectedRevision, idempotencyKey: crypto.randomUUID(),
  });
}

export async function addLotBulk(calcuttaId: number, auctionId: number, lots: any[], adminKey: string, expectedRevision: number) {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/lots/bulk`, "POST", adminKey, {
    lots,
    expectedRevision,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function editLot(calcuttaId: number, auctionId: number, lotId: number, data: any, adminKey: string, expectedRevision: number) {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/lots/${lotId}`, "PATCH", adminKey, {
    ...data,
    expectedRevision,
  });
}

export async function deleteLot(calcuttaId: number, auctionId: number, lotId: number, adminKey: string, expectedRevision: number) {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/lots/${lotId}`, "DELETE", adminKey, { expectedRevision });
}

export async function correctCurrentBid(calcuttaId: number, auctionId: number, lotId: number, price: number, adminKey: string, expectedRevision: number) {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/current-bid`, "PATCH", adminKey, {
    cents: Math.round(price * 100),
    expectedRevision,
  });
}

export async function correctSale(calcuttaId: number, auctionId: number, lotId: number, price: number, allocations: { consortiumId: number, share: number }[], reason: string, adminKey: string, expectedRevision: number) {
  return adminFetch(`/api/calcuttas/${calcuttaId}/auctions/${auctionId}/lots/${lotId}/sale`, "PATCH", adminKey, {
    totalCents: Math.round(price * 100),
    allocations,
    reason,
    expectedRevision,
    idempotencyKey: crypto.randomUUID(),
  });
}
