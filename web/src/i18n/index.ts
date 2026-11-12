import ar from "./ar";
import hi from "./hi";

/** Catalogs keyed by language code. English needs none: its text is the key. */
export const CATALOGS: Record<string, Record<string, string>> = { hi, ar };
