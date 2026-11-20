/**
 * Channel API boundary. No provider API is enabled until credentials, partner
 * approval, and the exact reservation workflow have been verified.
 *
 * iCal feeds are NOT authoritative for instant booking.
 */
export type Channel = "airbnb" | "vrbo";
export type ReservationDecision = "approved" | "declined" | "pending";

export interface BookingRequest {
  channel: Channel;
  externalRequestId: string;
  spaceId: string;
  checkIn: string;  // YYYY-MM-DD inclusive
  checkOut: string; // YYYY-MM-DD exclusive
}

export interface ApprovalResult {
  decision: ReservationDecision;
  externalReservationId?: string;
  reason?: string;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  /** True only after the partner API has been approved and verified. */
  readonly supportsProgrammaticApproval: boolean;
  /** Fetch authoritative request state, not a cached iCal feed. */
  getPendingRequest(externalRequestId: string): Promise<BookingRequest | null>;
  /** Confirm with the provider, returning the provider's actual outcome. */
  approve(externalRequestId: string): Promise<ApprovalResult>;
  decline(externalRequestId: string): Promise<ApprovalResult>;
}

/** Fail closed rather than silently claiming that a calendar sync is an approval. */
export async function approveThroughChannel(
  adapter: ChannelAdapter,
  request: BookingRequest,
): Promise<ApprovalResult> {
  if (adapter.channel !== request.channel) {
    return { decision: "pending", reason: "Channel mismatch" };
  }
  if (!adapter.supportsProgrammaticApproval) {
    return { decision: "pending", reason: "Provider approval API unavailable; do not auto-confirm" };
  }
  const current = await adapter.getPendingRequest(request.externalRequestId);
  if (!current || current.spaceId !== request.spaceId ||
      current.checkIn !== request.checkIn || current.checkOut !== request.checkOut) {
    return { decision: "pending", reason: "Request could not be verified with provider" };
  }
  try {
    const result = await adapter.approve(request.externalRequestId);
    if (result.decision === "approved" && !result.externalReservationId) {
      return { decision: "pending", reason: "Provider did not return a confirmed reservation ID" };
    }
    return result;
  } catch {
    return { decision: "pending", reason: "Provider approval failed; reconcile before retry" };
  }
}
