import type { ChannelReport, ChannelsOptions } from "./types";

export type Reporter = (report: ChannelReport) => void;

export function reporter(onReport: ChannelsOptions["onReport"]): Reporter {
  return (report) => {
    try {
      onReport?.(report);
    } catch {
      return;
    }
  };
}
