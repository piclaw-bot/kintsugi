import { Type, type Static } from "typebox";

/** Wire schema stays independent of the presentation/barrel to avoid Cable initialization cycles. */
export const liveRegionDigestsSchema = Type.Record(Type.String(), Type.String());
export type LiveRegionDigests = Readonly<Static<typeof liveRegionDigestsSchema>>;
