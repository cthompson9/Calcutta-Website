import type { AuctionSnapshot, Bidder } from "@workspace/api-client-react";

export function bidderConsortiums(
  bidders: Bidder[] | undefined,
): Map<number, string> {
  return new Map(
    (bidders ?? [])
      .filter((bidder): bidder is Bidder & { consortium: string } => Boolean(bidder.consortium))
      .map((bidder) => [bidder.id, bidder.consortium]),
  );
}

export function bidderConsortiumsByName(
  bidders: Bidder[] | undefined,
): Map<string, string> {
  return new Map(
    (bidders ?? [])
      .filter((bidder): bidder is Bidder & { consortium: string } => Boolean(bidder.consortium))
      .map((bidder) => [bidder.name, bidder.consortium]),
  );
}

export function auctionConsortiumsByBidderId(
  auction: AuctionSnapshot | null | undefined,
  bidders: Bidder[] | undefined,
): Map<number, string> {
  if (!auction) return bidderConsortiums(bidders);
  return new Map(auction.consortia.flatMap((consortium) =>
    consortium.owners.map((owner) => [owner.bidderId, consortium.displayName] as const)));
}

export function auctionConsortiumsByBidderName(
  auction: AuctionSnapshot | null | undefined,
  bidders: Bidder[] | undefined,
): Map<string, string> {
  if (!auction) return bidderConsortiumsByName(bidders);
  return new Map(auction.consortia.flatMap((consortium) =>
    consortium.owners.map((owner) => [owner.bidderName, consortium.displayName] as const)));
}

export function ownerLabel(
  bidderName: string,
  consortiumByName: Map<string, string>,
): string {
  return consortiumByName.get(bidderName) ?? bidderName;
}

export function ownerLabelById(
  bidderId: number,
  bidderName: string,
  consortiumById: Map<number, string>,
): string {
  return consortiumById.get(bidderId) ?? bidderName;
}

export function combinedOwnerLabel(
  ownerNames: string,
  consortiumByName: Map<string, string>,
): string {
  const labels = ownerNames
    .split(" / ")
    .map((name) => ownerLabel(name, consortiumByName));
  return [...new Set(labels)].join(" / ");
}