import type { Bidder } from "@workspace/api-client-react";

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