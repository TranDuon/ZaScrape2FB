import type { Collection } from "mongodb";
import { COLLECTIONS } from "../config/constants.js";
import { getDb } from "./mongoClient.js";
import type { ListingDoc } from "../models/listing.model.js";
import type { GroupDoc } from "../models/group.model.js";
import type { JobDoc } from "../models/job.model.js";
import type { PostHistoryDoc } from "../models/postHistory.model.js";
import type { AppStateDoc } from "../models/appState.model.js";
import type { DailyMetricsDoc } from "../models/dailyMetrics.model.js";

export const listings = (): Collection<ListingDoc> => getDb().collection<ListingDoc>(COLLECTIONS.listings);
export const groups = (): Collection<GroupDoc> => getDb().collection<GroupDoc>(COLLECTIONS.groups);
export const postJobs = (): Collection<JobDoc> => getDb().collection<JobDoc>(COLLECTIONS.postJobs);
export const postHistory = (): Collection<PostHistoryDoc> =>
    getDb().collection<PostHistoryDoc>(COLLECTIONS.postHistory);
export const appState = (): Collection<AppStateDoc> => getDb().collection<AppStateDoc>(COLLECTIONS.appState);
export const dailyMetrics = (): Collection<DailyMetricsDoc> =>
    getDb().collection<DailyMetricsDoc>(COLLECTIONS.dailyMetrics);
